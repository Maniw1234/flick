package com.flick.app;

import android.annotation.TargetApi;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
import java.util.Locale;
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
    private static final ThreadPoolExecutor MAKERS = new ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, new Newest(),
            new ThreadFactory() {
                @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-thumb"); t.setDaemon(true); return t; }
            });
    static { MAKERS.allowCoreThreadTimeOut(true); }

    static WebResourceResponse respond(Context c, Uri u) {
        try {
            // s=<longest side, device pixels>: the photo itself at the size the screen shows it (see preview)
            if (u.getQueryParameter("s") != null) return preview(c, u);
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
        private final java.util.concurrent.Callable<File> make;
        private File out;
        private boolean done, gone;                  // guarded by this

        Job(final Context c, final String path, final long v, final long mid, final int mt) {
            this(new java.util.concurrent.Callable<File>() {
                @Override public File call() { return get(c, path, v, mid, mt); }
            });
        }

        Job(java.util.concurrent.Callable<File> make) { this.make = make; }

        @Override
        public void run() {
            synchronized (this) { if (gone) return; }
            File f = null;
            try { f = make.call(); } catch (Throwable e) { f = null; }
            synchronized (this) { out = f; done = true; notifyAll(); }
        }

        InputStream stream() {
            return new InputStream() {
                private InputStream in;
                private boolean opened;

                // waits for the thumbnail (at most 10 s, then there is none: the reader's thread is the WebView's)
                private InputStream in() throws IOException {
                    if (opened) return in;
                    opened = true;
                    File f;
                    synchronized (Job.this) {
                        long end = SystemClock.uptimeMillis() + 10000;
                        try {
                            for (long left = 10000; !done && !gone && left > 0; left = end - SystemClock.uptimeMillis()) {
                                Job.this.wait(left);
                            }
                        } catch (InterruptedException e) { throw new InterruptedIOException(); }
                        f = done ? out : null;
                    }
                    if (f != null) in = new FileInputStream(f);
                    return in;
                }

                @Override public int read() throws IOException { InputStream i = in(); return i == null ? -1 : i.read(); }
                @Override
                public int read(byte[] b, int off, int len) throws IOException {
                    InputStream i = in();
                    return i == null ? -1 : i.read(b, off, len);
                }
                @Override
                public void close() throws IOException {
                    synchronized (Job.this) { gone = true; Job.this.notifyAll(); }
                    if (in != null) in.close();
                }
            };
        }

        /** Waits up to ms for it: the file, or null (it can't be made, or isn't yet). */
        File await(long ms) throws InterruptedException {
            synchronized (this) {
                long end = SystemClock.uptimeMillis() + ms;
                for (long left = ms; !done && left > 0; left = end - SystemClock.uptimeMillis()) wait(left);
                return done ? out : null;
            }
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
    private static File cached(File dir, String key) { return touched(new File(dir, key + ".jpg")); }

    /** out if it's there (one shown again after a day counts as recently used, see trim), or null. */
    private static File touched(File out) {
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
                // Some thumbnails are made inside Flick's own process (a PDF's page by Android's PDF renderer, a photo
                // MediaStore doesn't know), and a damaged file can crash that: Flick closed before "can't be made" was
                // written, and closed again every time the file's folder showed. A mark stands while one is made; a
                // file that took Flick down twice isn't tried again.
                File trying = new File(dir, key + ".try");
                if (trying.length() >= 2) { new FileOutputStream(none).close(); trying.delete(); return null; }
                FileOutputStream mark = new FileOutputStream(trying, true);
                try { mark.write(1); } finally { mark.close(); }
                Bitmap b;
                try { b = make(c, src, mid, mt); } finally { trying.delete(); }
                if (b == null) { try { new FileOutputStream(none).close(); } catch (Throwable e) { /* ignore */ } return null; }
                File tmp = new File(dir, key + ".tmp" + Thread.currentThread().getId());
                FileOutputStream fo = new FileOutputStream(tmp);
                try { b.compress(Bitmap.CompressFormat.JPEG, 82, fo); } finally { fo.close(); }
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

    // ------------------------------------------------------------ previews: a photo at the size the screen shows it
    // The preview showed photos whole, and a phone's 12 MP photo is 48 MB once decoded: a few of them took the page past
    // half a gigabyte (a phone with little memory closes it), and each was slow to open. s=<longest side in device
    // pixels> (with p=<path>, as for a thumbnail, or id=<an item of Flick's list>) is the photo scaled to fit that
    // (never larger than it is; turned as its EXIF says), decoded at about that size, made on the makers above and kept
    // in previews/ (by the file, its date and s). One no larger than that already, in a kind the page shows, is the
    // file itself. Still images only: anything else is 404, and the page shows the file itself.
    static final int PREVIEW_MIN = 256, PREVIEW_MAX = 4096;
    static final long PREVIEW_BYTES = 160L * 1024 * 1024;     // previews kept (the least recently shown go first)
    static final int PREVIEW_FILES = 600;
    static final long PREVIEW_WAIT_MS = 15000;
    // kinds the page shows as they are (a HEIC photo, say, is turned into a JPEG however small it is)
    private static final java.util.Set<String> SHOWN = new java.util.HashSet<String>(java.util.Arrays.asList("image/jpeg", "image/png", "image/webp", "image/bmp"));

    static File previewDir(Context c) { return new File(c.getCacheDir(), "previews"); }

    static WebResourceResponse preview(Context c, Uri u) {
        try {
            final int s = (int) Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, parse(u.getQueryParameter("s"))));
            final File src = previewSource(c, u);
            final String type = src == null ? null : still(src);
            if (type == null) return empty(404);
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(src.getPath(), o);
            if (o.outWidth <= 0 || o.outHeight <= 0) return empty(404);
            if (Math.max(o.outWidth, o.outHeight) <= s && SHOWN.contains(type)) return image(type, new FileInputStream(src));
            final File dir = previewDir(c);
            // (a PNG or a WebP may be see-through: it stays a PNG; anything else becomes a JPEG)
            final boolean png = "image/png".equals(type) || "image/webp".equals(type);
            final String key = sha1(src.getPath() + "|" + src.lastModified() / 1000 + "|preview " + s);
            File out = touched(new File(dir, key + (png ? ".png" : ".jpg")));
            if (out == null) {
                if (new File(dir, key + ".none").exists()) return empty(404);
                Job j = new Job(new java.util.concurrent.Callable<File>() {
                    @Override public File call() { return makePreview(src, dir, key, s, png); }
                });
                MAKERS.execute(j);
                // (waited for here, so one that can't be made is a 404 the page falls back on; a late one is kept for next
                // time)
                out = j.await(PREVIEW_WAIT_MS);
                if (out == null) return empty(404);
            }
            return image(png ? "image/png" : "image/jpeg", new FileInputStream(out));
        } catch (Throwable e) { return empty(404); }
    }

    /** The file a preview is asked for: p=<path> in shared storage, or id=<an item of Flick's list>; null if neither. */
    private static File previewSource(Context c, Uri u) {
        String p = u.getQueryParameter("p"), id = u.getQueryParameter("id");
        File f = null;
        if (p != null && p.length() > 0) { File x = new File(p); if (Files.allowed(x)) f = x; }
        else if (id != null && id.length() > 0) f = Library.get(c).file(id);
        return f != null && f.isFile() ? f : null;
    }

    /** The type of a still image (what a preview is made of), or null: not an image, a GIF, an animated WebP, an SVG. */
    static String still(File f) {
        String name = f.getName(), mime = Files.mimeOf(name);
        if (!"image".equals(Files.kindOf(name, mime))) return null;
        String m = mime.toLowerCase(Locale.US);
        if (m.equals("image/gif") || m.startsWith("image/svg")) return null;      // (it moves, or isn't pixels)
        if (m.equals("image/webp") && animatedWebp(f)) return null;
        return m.equals("image/heif") ? "image/heic" : m;
    }

    /** A WebP that moves (its VP8X header says so). */
    static boolean animatedWebp(File f) {
        byte[] h = new byte[21];
        try {
            InputStream in = new FileInputStream(f);
            try {
                int n = 0, r;
                while (n < h.length && (r = in.read(h, n, h.length - n)) > 0) n += r;
                if (n < h.length) return false;
            } finally { in.close(); }
        } catch (IOException e) { return false; }
        return h[12] == 'V' && h[13] == 'P' && h[14] == '8' && h[15] == 'X' && (h[20] & 0x02) != 0;
    }

    private static WebResourceResponse image(String type, InputStream in) {
        WebResourceResponse r = new WebResourceResponse(type, null, in);
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "max-age=31536000");
        h.put("Access-Control-Allow-Origin", "*");
        r.setResponseHeaders(h);
        return r;
    }

    /** The preview of src at s in dir (made now, or by another request meanwhile), or null when it can't be made. */
    static File makePreview(File src, File dir, String key, int s, boolean png) {
        dir.mkdirs();
        File out = new File(dir, key + (png ? ".png" : ".jpg")), none = new File(dir, key + ".none");
        Object lock = new Object();
        Object prev = LOCKS.putIfAbsent(key, lock);
        if (prev != null) lock = prev;
        synchronized (lock) {
            try {
                if (out.exists()) return out;
                if (none.exists()) return null;
                // (a damaged photo that took Flick down twice while its preview was made isn't tried again: see get)
                File trying = new File(dir, key + ".try");
                if (trying.length() >= 2) { new FileOutputStream(none).close(); trying.delete(); return null; }
                FileOutputStream mark = new FileOutputStream(trying, true);
                try { mark.write(1); } finally { mark.close(); }
                Bitmap b;
                try { b = fit(src, s); } finally { trying.delete(); }
                if (b == null) { try { new FileOutputStream(none).close(); } catch (Throwable e) { /* ignore */ } return null; }
                File tmp = new File(dir, key + ".tmp" + Thread.currentThread().getId());
                FileOutputStream fo = new FileOutputStream(tmp);
                try { b.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 85, fo); } finally { fo.close(); b.recycle(); }
                if (!tmp.renameTo(out)) tmp.delete();
                else made(dir, out.length());
                return out.exists() ? out : null;
            } catch (Throwable e) {
                return null;
            } finally {
                LOCKS.remove(key, lock);
            }
        }
    }

    /**
     * f decoded to fit s on its longest side (never larger than it is), turned as its EXIF says, at about that size in
     * memory; null when it can't be decoded.
     */
    static Bitmap fit(File f, int s) {
        if (Build.VERSION.SDK_INT >= 28) {
            Bitmap b = Library.Api28.decode(f, s);
            if (b != null) return b;
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        int longest = Math.max(o.outWidth, o.outHeight);
        if (longest <= 0) return null;
        // the largest step down that still leaves 3/4 of s at least: a 50 MP photo for a 2048 px screen is decoded at
        // 2040 px (12 MB), not 4080 px (50 MB)
        int k = 1;
        while (longest / (k * 2) >= s * 3 / 4) k *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = k;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), o2);
        if (b == null) return null;
        return Library.scaleTo(Library.oriented(b, f), s);
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
                    trim(previewDir(c), PREVIEW_BYTES, PREVIEW_FILES);
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
    static void trim(Context c) { trim(dir(c), CAP_BYTES, CAP_FILES); }

    // Previews made since their folder was last trimmed: it's trimmed again (on a low-priority thread) after a quarter
    // of its cap, so many photos looked through in one go don't take more and more room until Flick next starts
    private static final java.util.concurrent.atomic.AtomicLong madeBytes = new java.util.concurrent.atomic.AtomicLong();
    private static final java.util.concurrent.atomic.AtomicInteger madeFiles = new java.util.concurrent.atomic.AtomicInteger();
    private static final java.util.concurrent.atomic.AtomicBoolean trimming = new java.util.concurrent.atomic.AtomicBoolean();

    private static void made(final File dir, long bytes) {
        int n = madeFiles.incrementAndGet();
        if (madeBytes.addAndGet(bytes) < PREVIEW_BYTES / 4 && n < PREVIEW_FILES / 4) return;
        if (!trimming.compareAndSet(false, true)) return;
        madeBytes.set(0);
        madeFiles.set(0);
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
                    trim(dir, PREVIEW_BYTES, PREVIEW_FILES, true);
                } catch (Throwable e) { Bg.warn("preview cache", e); }
                finally { trimming.set(false); }
            }
        }, "flick-previews-trim");
        t.setDaemon(true);
        t.start();
    }

    /** trim() for a cache folder, kept under capBytes and capFiles. */
    static void trim(File dir, long capBytes, int capFiles) { trim(dir, capBytes, capFiles, false); }

    /** The same; force: whenever it was last done. */
    static void trim(File dir, long capBytes, int capFiles, boolean force) {
        File mark = new File(dir, "trimmed");
        long now = System.currentTimeMillis();
        if (!force && Math.abs(now - mark.lastModified()) < 12 * HOUR) return;
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
        if (bytes > capBytes || files > capFiles) {
            Collections.sort(kept, new Comparator<File>() {
                @Override
                public int compare(File a, File b) { long x = used.get(a), y = used.get(b); return x < y ? -1 : x > y ? 1 : 0; }
            });
            for (File f : kept) {
                if (bytes <= capBytes * 3 / 4 && files <= capFiles * 3 / 4) break;
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
