package com.flick.app;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
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
 * byte ranges (a range that breaks resumes where it stopped). With verify=1 in the part URL (a PC that checks), the
 * file's SHA-256 is worked out while the parts travel and sent once they are all in: the PC checks the assembled file
 * against it, and a file that arrived damaged fails here and is sent again. No Android classes, so it runs on any JVM.
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

    /** partUrl: ".../api/part?tid=..&device=..&token=..&name=..[&verify=1]" (index, offset, parts, total and att are added). */
    static void upload(final File f, String partUrl, final int n, final AtomicBoolean abort, final Progress p) throws Exception {
        final long total = f.length();
        final long size = (total + n - 1) / n;
        final String att = Long.toString(System.nanoTime() & 0xffffffL, 36) + n;
        final String base = partUrl + "&att=" + att + "&parts=" + n + "&total=" + total;
        final AtomicLong sent = new AtomicLong();
        // the whole file's checksum, read alongside the parts (the network is far slower than the phone's storage)
        final Future<String> sum = partUrl.matches(".*[?&]verify=1(&.*)?") ? POOL.submit(new Callable<String>() {
            @Override
            public String call() throws Exception { return sha256(f, total, abort); }
        }) : null;
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
        try {
            finish(parts, abort);
            if (sum != null) commit(base + "&commit=1&sha256=" + get(sum), total, abort);
        } finally {
            if (sum != null) sum.cancel(true);
        }
        if (p != null) p.onBytes(total);
    }

    /** SHA-256 of the first total bytes of f, in hex; stops when the transfer is aborted. */
    static String sha256(File f, long total, AtomicBoolean abort) throws IOException {
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("no SHA-256", e); }
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[1024 * 1024];
            long left = total;
            while (left > 0) {
                if (abort.get() || Thread.currentThread().isInterrupted()) throw new IOException("aborted");
                int r = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (r < 0) throw new IOException("file changed");
                md.update(buf, 0, r);
                left -= r;
            }
        } finally { in.close(); }
        StringBuilder b = new StringBuilder(64);
        for (byte x : md.digest()) b.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return b.toString();
    }

    private static String get(Future<String> f) throws Exception {
        try { return f.get(); }
        catch (ExecutionException e) { throw e.getCause() instanceof Exception ? (Exception) e.getCause() : e; }
    }

    /**
     * Every part is in: tells the PC the whole file's SHA-256. The PC reads the assembled file back before it answers,
     * so the wait grows with the size. 200: the file arrived intact; anything else (422: it didn't) fails the upload.
     */
    private static void commit(String url, long total, AtomicBoolean abort) throws IOException {
        HttpURLConnection c = null;
        Watchdog.Guard g = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            g = Watchdog.guard(abort, c);
            c.setConnectTimeout(5000);
            c.setReadTimeout((int) Math.min(30 * 60000L, 60000L + total / (25L * 1024 * 1024) * 1000L));
            c.setDoOutput(true);
            c.setUseCaches(false);
            c.setRequestMethod("POST");
            c.setFixedLengthStreamingMode(0);
            c.getOutputStream().close();
            g.idle();
            int code = c.getResponseCode();
            drain(code == 200 ? c.getInputStream() : c.getErrorStream());
            if (code != 200) throw new IOException(code == 422 ? "arrived damaged" : "check http " + code);
        } catch (IOException e) {
            throw g != null && g.ended() != null ? new IOException(g.ended(), e) : e;
        } finally {
            if (g != null) g.close();
            if (c != null) c.disconnect();
        }
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
                            int r, fill = 0;
                            try {
                                // reads come in pieces of up to 8 KB on Android: gather 256 KB, then write it in one go
                                while (done + fill < len && (r = in.read(buf, fill, (int) Math.min(buf.length - fill, len - done - fill))) > 0) {
                                    if (stop.get()) throw new IOException("aborted");
                                    fill += r;
                                    if (fill == buf.length || done + fill == len) { done += put(raf, buf, fill, got, p); fill = 0; }
                                }
                            } finally {
                                // what arrived before a break is kept, so the next attempt asks only for the rest
                                try { if (fill > 0) done += put(raf, buf, fill, got, p); }
                                finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
                            }
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

    /**
     * The same over Wire, straight to the PC (no local proxy in between): [0, total) of target on l into part, as n byte
     * ranges at once, each carrying on from what it wrote when it breaks.
     */
    static void downloadDirect(final Wire.Link l, final String target, final File part, final long total, int n, final Progress p) throws Exception {
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
                        Wire.Call c = null;
                        Watchdog.Guard w = null;
                        RandomAccessFile raf = null;
                        try {
                            int[] code = new int[1];
                            long[] clen = new long[1];
                            String[] cr = new String[1];
                            // over a kept connection when there is one (a new one when that one went silent); read to its
                            // end, the range leaves its connection for the next request
                            c = Wire.Call.fetch(l, target, "Range: bytes=" + (off + done) + "-" + (off + len - 1) + "\r\n", 60000, code, clen, cr);
                            w = Watchdog.guard(stop, c);
                            if (code[0] != 206 || cr[0] == null || !cr[0].endsWith("/" + total)) throw new Strike("http " + code[0], null);
                            InputStream in = w.watch(c.body(clen[0]));
                            raf = new RandomAccessFile(part, "rw");
                            raf.seek(off + done);
                            byte[] buf = new byte[512 * 1024];
                            int r, fill = 0;
                            try {
                                while (done + fill < len && (r = in.read(buf, fill, (int) Math.min(buf.length - fill, len - done - fill))) > 0) {
                                    if (stop.get()) throw new IOException("aborted");
                                    fill += r;
                                    if (fill == buf.length || done + fill == len) { done += put(raf, buf, fill, got, p); fill = 0; }
                                }
                            } finally {
                                if (fill > 0) done += put(raf, buf, fill, got, p);
                            }
                            if (done < len) throw new IOException("connection closed early");
                        } catch (IOException e) {
                            lastErr = w != null && w.ended() != null ? new Strike(w.ended(), e) : e;
                            if (stop.get()) throw lastErr;
                            if ((done == before || lastErr instanceof Strike) && ++fails >= DOWN_FAILS) break;
                            try { Thread.sleep(300L * (fails + 1)); } catch (InterruptedException x) { throw lastErr; }
                        } finally {
                            if (w != null) w.close();
                            try { if (raf != null) raf.close(); } catch (Throwable e) { /* ignore */ }
                            if (c != null) c.close();
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

    /** Writes n received bytes in place and reports them. */
    private static int put(RandomAccessFile raf, byte[] buf, int n, AtomicLong got, Progress p) throws IOException {
        raf.write(buf, 0, n);
        long g = got.addAndGet(n);
        if (p != null) p.onBytes(g);
        return n;
    }

    /**
     * A bundle striped over several connections (/api/bundle with streams=n&stream=i): each stream is retried on its own,
     * with the same budget as a part, and a stream sent again rewrites its files on the PC.
     * url: ".../api/bundle?tid=..&device=..&token=..&files=..&bytes=..".
     */
    static void bundle(final List<Bundle> streams, String url, final AtomicBoolean abort, final Bundle.Progress p) throws Exception {
        final int n = streams.size();
        final String att = Long.toString(System.nanoTime() & 0xffffffL, 36) + n;
        final String base = url + "&att=" + att + "&streams=" + n;
        final long total = streams.get(0).manifestBytes >= 0 ? streams.get(0).manifestBytes : streams.get(0).bytes;
        final AtomicLong sent = new AtomicLong();
        List<Future<?>> fs = new ArrayList<Future<?>>();
        for (int i = 0; i < n; i++) {
            final int index = i;
            final Bundle b = streams.get(i);
            fs.add(POOL.submit(new Callable<Void>() {
                @Override
                public Void call() throws Exception {
                    IOException lastErr = null;
                    int fails = 0;
                    for (int attempt = 0; attempt < UP_CAP; attempt++) {
                        if (abort.get()) throw new IOException("aborted");
                        final long[] mine = {0};
                        try {
                            sendStream(base + "&stream=" + index, b, abort, new Bundle.Progress() {
                                @Override public void onBytes(long s, long t) { long d = s - mine[0]; mine[0] = s; long all = sent.addAndGet(d); if (p != null) p.onBytes(all, total); }
                            });
                            return null;
                        } catch (IOException e) {
                            sent.addAndGet(-mine[0]);
                            lastErr = e;
                            if (abort.get()) throw e;
                            if ((mine[0] == 0 || e instanceof Strike) && ++fails >= UP_FAILS) throw e;
                            try { Thread.sleep(400L * (fails + 1)); } catch (InterruptedException x) { throw e; }
                        }
                    }
                    throw lastErr != null ? lastErr : new IOException("stream failed");
                }
            }));
        }
        finish(fs, abort);
        if (p != null) p.onBytes(total, total);
    }

    private static void sendStream(String url, Bundle b, AtomicBoolean abort, Bundle.Progress prog) throws IOException {
        HttpURLConnection c = null;
        Watchdog.Guard g = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            g = Watchdog.guard(abort, c);
            c.setConnectTimeout(5000);
            c.setReadTimeout(120000);
            c.setDoOutput(true);
            c.setUseCaches(false);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/x-flick-bundle");
            c.setChunkedStreamingMode(256 * 1024);
            OutputStream out = new BufferedOutputStream(g.watch(c.getOutputStream()), 256 * 1024);
            b.write(out, abort, prog);
            out.close();
            g.idle();
            int code = c.getResponseCode();
            drain(code == 200 ? c.getInputStream() : c.getErrorStream());
            if (code != 200) throw new Strike("http " + code, null);
        } catch (IOException e) {
            throw g != null && g.ended() != null ? new Strike(g.ended(), e) : e;
        } finally {
            if (g != null) g.close();
            if (c != null) c.disconnect();
        }
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
