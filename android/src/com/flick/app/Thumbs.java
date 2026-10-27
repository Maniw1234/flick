package com.flick.app;

import android.annotation.TargetApi;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Cached thumbnails for any file in shared storage (photos, videos, PDFs, text, audio art, APK icons). */
final class Thumbs {
    private Thumbs() {}

    static final int MAX = 512;
    private static final ConcurrentHashMap<String, Object> LOCKS = new ConcurrentHashMap<String, Object>();
    private static final long HOUR = 3600 * 1000L, DAY = 24 * HOUR;
    // the cache (thumbs2) is kept under this many bytes and files: the ones least recently shown go first
    static final long CAP_BYTES = 192L * 1024 * 1024;
    static final int CAP_FILES = 20000;

    // Thumbnails the page asks for that aren't made yet are made here, the newest request first: after a fast scroll
    // the cards now on screen come before the ones that flew past. A queue that hands out its newest task first.
    static final class Newest extends LinkedBlockingDeque<Runnable> {
        @Override public boolean offer(Runnable r) { return offerFirst(r); }
    }
    private static final ThreadPoolExecutor MAKERS = new ThreadPoolExecutor(3, 3, 30, TimeUnit.SECONDS, new Newest(), new ThreadFactory() {
        @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-thumb"); t.setDaemon(true); return t; }
    });
    static { MAKERS.allowCoreThreadTimeOut(true); }

    static WebResourceResponse respond(Context c, Uri u) {
        try {
            String path = u.getQueryParameter("p");
            long v = parse(u.getQueryParameter("v"));
            long mid = parse(u.getQueryParameter("m"));
            int mt = (int) parse(u.getQueryParameter("t"));
            if (path == null || path.length() == 0) return empty(404);
            File src = new File(path);
            if (!Files.allowed(src) || !src.isFile()) return empty(404);
            String key = key(path, v == 0 ? src.lastModified() : v);
            File dir = dir(c);
            File out = cached(dir, key);
            InputStream in;
            if (out != null) in = new FileInputStream(out);
            else if (new File(dir, key + ".none").exists()) return empty(404);
            else {
                Job j = new Job(c.getApplicationContext(), path, v, mid, mt);
                MAKERS.execute(j);
                in = j.stream();
            }
            WebResourceResponse r = new WebResourceResponse("image/jpeg", null, in);
            Map<String, String> h = new HashMap<String, String>();
            h.put("Cache-Control", "max-age=31536000");
            h.put("Access-Control-Allow-Origin", "*");
            r.setResponseHeaders(h);
            return r;
        } catch (Throwable e) { return empty(404); }
    }

    /**
     * A thumbnail made for the page's request: the answer's stream gives the JPEG once it is made (nothing when it
     * can't be). A request the page dropped before its turn (the stream closed) isn't made.
     */
    static final class Job implements Runnable {
        private final Context c;
        private final String path;
        private final long v, mid;
        private final int mt;
        private File out;
        private boolean done, gone;                  // guarded by this

        Job(Context c, String path, long v, long mid, int mt) { this.c = c; this.path = path; this.v = v; this.mid = mid; this.mt = mt; }

        @Override
        public void run() {
            synchronized (this) { if (gone) return; }
            File f = null;
            try { f = get(c, path, v, mid, mt); } catch (Throwable e) { f = null; }
            synchronized (this) { out = f; done = true; notifyAll(); }
        }

        InputStream stream() {
            return new InputStream() {
                private InputStream in;
                private boolean opened;

                // waits for the thumbnail (at most 30 s, then there is none)
                private InputStream in() throws IOException {
                    if (opened) return in;
                    opened = true;
                    File f;
                    synchronized (Job.this) {
                        long end = SystemClock.uptimeMillis() + 30000;
                        try {
                            for (long left = 30000; !done && !gone && left > 0; left = end - SystemClock.uptimeMillis()) Job.this.wait(left);
                        } catch (InterruptedException e) { throw new InterruptedIOException(); }
                        f = done ? out : null;
                    }
                    if (f != null) in = new FileInputStream(f);
                    return in;
                }

                @Override public int read() throws IOException { InputStream i = in(); return i == null ? -1 : i.read(); }
                @Override public int read(byte[] b, int off, int len) throws IOException { InputStream i = in(); return i == null ? -1 : i.read(b, off, len); }
                @Override
                public void close() throws IOException {
                    synchronized (Job.this) { gone = true; Job.this.notifyAll(); }
                    if (in != null) in.close();
                }
            };
        }
    }

    static WebResourceResponse empty(int code) {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        try { r.setStatusCodeAndReasonPhrase(code, code == 404 ? "Not Found" : "Error"); } catch (Throwable e) { /* ignore */ }
        return r;
    }

    static long parse(String s) { try { return s == null ? 0 : Long.parseLong(s); } catch (Throwable e) { return 0; } }

    static String base64(Context c, String path, long v, long mid, int mt) {
        try {
            File t = get(c, path, v, mid, mt);
            if (t == null) return "";
            return Base64.encodeToString(Library.readAll(new FileInputStream(t), 4 * 1024 * 1024), Base64.NO_WRAP);
        } catch (Throwable e) { return ""; }
    }

    static File dir(Context c) { return new File(c.getCacheDir(), "thumbs2"); }

    /**
     * The cache's name for the file at path as it was at mtime (ms). In whole seconds: Photos and the other categories
     * know a file's date in seconds (MediaStore), folders in milliseconds, and both share one thumbnail.
     */
    static String key(String path, long mtime) { return sha1(path + "|" + mtime / 1000 + "|" + MAX); }

    /** The cached thumbnail, or null; one shown again after a day counts as recently used (see trim). */
    private static File cached(File dir, String key) {
        File out = new File(dir, key + ".jpg");
        long seen = out.lastModified();              // (0: not there)
        if (seen <= 0) return null;
        long now = System.currentTimeMillis();
        if (now - seen > DAY) out.setLastModified(now);
        return out;
    }

    static File get(Context c, String path, long v, long mid, int mt) {
        if (path == null || path.length() == 0) return null;
        File src = new File(path);
        if (!Files.allowed(src) || !src.isFile()) return null;
        String key = key(path, v == 0 ? src.lastModified() : v);
        File dir = dir(c);
        dir.mkdirs();
        File out = new File(dir, key + ".jpg");
        File none = new File(dir, key + ".none");
        if (cached(dir, key) != null) return out;
        if (none.exists()) return null;
        Object lock = new Object();
        Object prev = LOCKS.putIfAbsent(key, lock);
        if (prev != null) lock = prev;
        synchronized (lock) {
            try {
                if (out.exists()) return out;
                if (none.exists()) return null;
                Bitmap b = make(c, src, mid, mt);
                if (b == null) { try { new FileOutputStream(none).close(); } catch (Throwable e) { /* ignore */ } return null; }
                File tmp = new File(dir, key + ".tmp" + Thread.currentThread().getId());
                FileOutputStream fo = new FileOutputStream(tmp);
                b.compress(Bitmap.CompressFormat.JPEG, 82, fo);
                fo.close();
                b.recycle();
                if (!tmp.renameTo(out)) { tmp.delete(); }
                return out.exists() ? out : null;
            } catch (Throwable e) {
                return null;
            } finally {
                LOCKS.remove(key, lock);
            }
        }
    }

    // ------------------------------------------------------------ keeping the cache small
    /** trim() a little after Flick starts, on a low-priority thread. */
    static void trimSoon(final Context ctx) {
        final Context c = ctx.getApplicationContext();
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
                    Thread.sleep(20000);
                    trim(c);
                } catch (Throwable e) { Bg.warn("thumbnail cache", e); }
            }
        }, "flick-thumbs-trim");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Keeps the cache under CAP_BYTES and CAP_FILES, dropping the thumbnails least recently shown first (down to 3/4,
     * so it isn't at it again soon); also what a crash left half-written, and "can't be made" marks after a month (the
     * file may have become readable). Runs at most every 12 hours.
     */
    static void trim(Context c) {
        File dir = dir(c);
        File mark = new File(dir, "trimmed");
        long now = System.currentTimeMillis();
        if (Math.abs(now - mark.lastModified()) < 12 * HOUR) return;
        File[] fs = dir.listFiles();
        if (fs == null) return;
        final HashMap<File, Long> used = new HashMap<File, Long>();
        ArrayList<File> kept = new ArrayList<File>();
        long bytes = 0;
        for (File f : fs) {
            String n = f.getName();
            if (n.equals(mark.getName())) continue;
            long m = f.lastModified();
            if (n.contains(".tmp")) { if (now - m > HOUR) f.delete(); continue; }
            if (n.endsWith(".none") && now - m > 30 * DAY) { f.delete(); continue; }
            used.put(f, m);
            kept.add(f);
            bytes += f.length();
        }
        int files = kept.size();
        if (bytes > CAP_BYTES || files > CAP_FILES) {
            Collections.sort(kept, new Comparator<File>() {
                @Override public int compare(File a, File b) { long x = used.get(a), y = used.get(b); return x < y ? -1 : x > y ? 1 : 0; }
            });
            for (File f : kept) {
                if (bytes <= CAP_BYTES * 3 / 4 && files <= CAP_FILES * 3 / 4) break;
                long len = f.length();
                if (f.delete()) { bytes -= len; files--; }
            }
        }
        try { if (!mark.setLastModified(now)) new FileOutputStream(mark).close(); } catch (Throwable e) { /* next time */ }
    }

    static Bitmap make(Context c, File f, long mid, int mt) {
        String name = f.getName();
        String mime = Files.mimeOf(name);
        String kind = Files.kindOf(name, mime);
        if (Build.VERSION.SDK_INT >= 29 && mid > 0 && (mt == 1 || mt == 2 || mt == 3)) {
            Bitmap b = Api29.load(c, mid, mt);
            if (b != null) return b;
        }
        if ("image".equals(kind)) return Library.decodeImage(f, MAX);
        if ("video".equals(kind)) return Library.videoFrame(f, MAX);
        if ("pdf".equals(kind)) return Library.pdfPage(f, 420);
        if ("text".equals(kind)) return f.length() < 8 * 1024 * 1024 ? Library.textPage(f, name) : null;
        if ("audio".equals(kind)) return Library.albumArt(f, MAX);
        if ("apk".equals(kind)) return apkIcon(c, f);
        return null;
    }

    @TargetApi(29)
    static final class Api29 {
        static Bitmap load(Context c, long id, int mt) {
            Uri base = mt == 1 ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : mt == 3 ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            try { return c.getContentResolver().loadThumbnail(ContentUris.withAppendedId(base, id), new Size(MAX, MAX), null); }
            catch (Throwable e) { return null; }
        }
    }

    static Bitmap apkIcon(Context c, File f) {
        try {
            PackageManager pm = c.getPackageManager();
            PackageInfo pi = pm.getPackageArchiveInfo(f.getPath(), 0);
            if (pi == null || pi.applicationInfo == null) return null;
            pi.applicationInfo.sourceDir = f.getPath();
            pi.applicationInfo.publicSourceDir = f.getPath();
            Drawable d = pi.applicationInfo.loadIcon(pm);
            if (d == null) return null;
            Bitmap b = Bitmap.createBitmap(384, 384, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(b);
            cv.drawColor(Color.rgb(30, 30, 34));
            d.setBounds(72, 72, 312, 312);
            d.draw(cv);
            return b;
        } catch (Throwable e) { return null; }
    }

    static String sha1(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] h = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : h) sb.append(Integer.toHexString((x & 0xff) | 0x100).substring(1));
            return sb.toString();
        } catch (Throwable e) { return String.valueOf(s.hashCode()); }
    }
}
