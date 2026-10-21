package com.flick.app;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * One large file moved as several parts at once, each over its own connection: Wi-Fi carries more data that way than
 * over a single connection. Uploads go to the PC's /api/part (each part is retried on its own); downloads use HTTP
 * byte ranges (a range that breaks resumes where it stopped). No Android classes, so it runs on any JVM.
 */
final class Parallel {
    interface Progress { void onBytes(long done); }

    // Retry budgets per part. Only attempts that moved no bytes count against them, or that ended in a Strike (the PC
    // answered with an error, or the connection stalled): on a weak link connections drop every few MB, and an attempt
    // that got data through is worth repeating. An upload part starts over each time (the PC can't resume one), so its
    // overall cap is small; a download range carries on from the bytes already written.
    static final int UP_FAILS = 3, UP_CAP = 10;
    static final int DOWN_FAILS = 4, DOWN_CAP = 100;

    /** An attempt that counts against the budget even if bytes moved: an error status from the PC, or a stall. */
    static final class Strike extends IOException {
        private static final long serialVersionUID = 1L;
        Strike(String m, Throwable cause) { super(m, cause); }
    }

    private static final ExecutorService POOL = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-part"); t.setDaemon(true); return t; }
    });

    private Parallel() {}

    /** partUrl: ".../api/part?tid=..&device=..&token=..&name=.." (index, offset, parts, total and att are added). */
    static void upload(final File f, String partUrl, final int n, final AtomicBoolean abort, final Progress p) throws Exception {
        final long total = f.length();
        final long size = (total + n - 1) / n;
        final String att = Long.toString(System.nanoTime() & 0xffffffL, 36) + n;
        final String base = partUrl + "&att=" + att + "&parts=" + n + "&total=" + total;
        final AtomicLong sent = new AtomicLong();
        List<Future<?>> parts = new ArrayList<Future<?>>();
        for (int i = 0; i < n; i++) {
            final int index = i;
            final long off = i * size, len = Math.max(0, Math.min(size, total - off));
            parts.add(POOL.submit(new Callable<Void>() {
                @Override
                public Void call() throws Exception {
                    IOException lastErr = null;
                    int fails = 0;
                    for (int attempt = 0; attempt < UP_CAP; attempt++) {
                        if (abort.get()) throw new IOException("aborted");
                        long[] mine = {0};
                        try {
                            sendPart(base + "&index=" + index + "&offset=" + off, f, off, len, abort, sent, mine, p);
                            return null;
                        } catch (IOException e) {
                            sent.addAndGet(-mine[0]);
                            lastErr = e;
                            if (abort.get()) throw e;
                            if ((mine[0] == 0 || e instanceof Strike) && ++fails >= UP_FAILS) throw e;
                            try { Thread.sleep(400L * (fails + 1)); } catch (InterruptedException x) { throw e; }
                        }
                    }
                    throw lastErr != null ? lastErr : new IOException("part failed");
                }
            }));
        }
        finish(parts, abort);
        if (p != null) p.onBytes(total);
    }

    private static void sendPart(String url, File f, long off, long len, AtomicBoolean abort, AtomicLong sent, long[] mine, Progress p) throws IOException {
        HttpURLConnection c = null;
        Watchdog.Guard g = null;
        RandomAccessFile raf = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            g = Watchdog.guard(abort, c);
            c.setConnectTimeout(5000);
            c.setReadTimeout(60000);
            c.setDoOutput(true);
            c.setUseCaches(false);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/octet-stream");
            c.setFixedLengthStreamingMode(len);
            OutputStream out = g.watch(c.getOutputStream());
            raf = new RandomAccessFile(f, "r");
            raf.seek(off);
            byte[] buf = new byte[256 * 1024];
            long left = len;
            while (left > 0) {
                if (abort.get()) throw new IOException("aborted");
                int r = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (r < 0) throw new IOException("file changed");
                out.write(buf, 0, r);
                left -= r;
                mine[0] += r;
                long s = sent.addAndGet(r);
                if (p != null) p.onBytes(s);
            }
            out.flush();
            out.close();
            g.idle();
            int code = c.getResponseCode();
            drain(code == 200 ? c.getInputStream() : c.getErrorStream());
            if (code != 200) throw new Strike("http " + code, null);
        } catch (IOException e) {
            throw g != null && g.ended() != null ? new Strike(g.ended(), e) : e;
        } finally {
            if (g != null) g.close();
            try { if (raf != null) raf.close(); } catch (Throwable e) { /* ignore */ }
            if (c != null) c.disconnect();
        }
    }

    /** Fetches [0, total) of url into part as n byte ranges at once, written in place. */
    static void download(final String url, final File part, final long total, int n, final Progress p) throws Exception {
        RandomAccessFile pre = new RandomAccessFile(part, "rw");
        try { pre.setLength(total); } finally { pre.close(); }
        final long size = (total + n - 1) / n;
        final AtomicLong got = new AtomicLong();
        final AtomicBoolean stop = new AtomicBoolean(false);
        List<Future<?>> fs = new ArrayList<Future<?>>();
        for (int i = 0; i < n; i++) {
            final long off = i * size, len = Math.max(0, Math.min(size, total - off));
            if (len == 0) continue;
            fs.add(POOL.submit(new Callable<Void>() {
                @Override
                public Void call() throws Exception {
                    long done = 0;
                    int fails = 0;
                    IOException lastErr = null;
                    for (int attempt = 0; attempt < DOWN_CAP && done < len; attempt++) {
                        if (stop.get()) throw new IOException("aborted");
                        long before = done;
                        HttpURLConnection c = null;
                        Watchdog.Guard w = null;
                        RandomAccessFile raf = null;
                        try {
                            c = (HttpURLConnection) new URL(url).openConnection();
                            w = Watchdog.guard(stop, c);
                            c.setConnectTimeout(5000);
                            c.setReadTimeout(60000);
                            c.setUseCaches(false);
                            // carries on from the bytes already written
                            c.setRequestProperty("Range", "bytes=" + (off + done) + "-" + (off + len - 1));
                            int code = c.getResponseCode();
                            String cr = c.getHeaderField("Content-Range");
                            if (code != 206 || cr == null || !cr.endsWith("/" + total)) throw new Strike("http " + code, null);
                            InputStream in = w.watch(c.getInputStream());
                            raf = new RandomAccessFile(part, "rw");
                            raf.seek(off + done);
                            byte[] buf = new byte[256 * 1024];
                            int r;
                            try {
                                while (done < len && (r = in.read(buf, 0, (int) Math.min(buf.length, len - done))) > 0) {
                                    if (stop.get()) throw new IOException("aborted");
                                    raf.write(buf, 0, r);
                                    done += r;
                                    long g = got.addAndGet(r);
                                    if (p != null) p.onBytes(g);
                                }
                            } finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
                            if (done < len) throw new IOException("connection closed early");
                        } catch (IOException e) {
                            lastErr = w != null && w.ended() != null ? new Strike(w.ended(), e) : e;
                            if (stop.get()) throw lastErr;
                            if ((done == before || lastErr instanceof Strike) && ++fails >= DOWN_FAILS) break;
                            try { Thread.sleep(300L * (fails + 1)); } catch (InterruptedException x) { throw lastErr; }
                        } finally {
                            if (w != null) w.close();
                            try { if (raf != null) raf.close(); } catch (Throwable e) { /* ignore */ }
                            if (c != null) c.disconnect();
                        }
                    }
                    if (done < len) throw lastErr != null ? lastErr : new IOException("incomplete");
                    return null;
                }
            }));
        }
        finish(fs, stop);
        if (p != null) p.onBytes(total);
    }

    private static void finish(List<Future<?>> fs, AtomicBoolean stop) throws Exception {
        Exception failed = null;
        for (Future<?> f : fs) {
            try { f.get(); }
            catch (ExecutionException e) {
                // one part failed for good: the others stop now (their connections are cut, not left to finish)
                if (failed == null) { failed = e.getCause() instanceof Exception ? (Exception) e.getCause() : e; Watchdog.abort(stop); }
            }
        }
        if (failed != null) throw failed;
    }

    private static void drain(InputStream r) {
        if (r == null) return;
        try { byte[] b = new byte[8192]; while (r.read(b) > 0) { /* discard */ } } catch (Throwable e) { /* ignore */ }
        try { r.close(); } catch (Throwable e) { /* ignore */ }
    }
}
