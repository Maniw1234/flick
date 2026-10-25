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
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Cached thumbnails for any file in shared storage (photos, videos, PDFs, text, audio art, APK icons). */
final class Thumbs {
    private Thumbs() {}

    static final int MAX = 512;
    private static final ConcurrentHashMap<String, Object> LOCKS = new ConcurrentHashMap<String, Object>();

    static WebResourceResponse respond(Context c, Uri u) {
        try {
            String path = u.getQueryParameter("p");
            long v = parse(u.getQueryParameter("v"));
            long mid = parse(u.getQueryParameter("m"));
            int mt = (int) parse(u.getQueryParameter("t"));
            File out = get(c, path, v, mid, mt);
            if (out == null) return empty(404);
            WebResourceResponse r = new WebResourceResponse("image/jpeg", null, new FileInputStream(out));
            Map<String, String> h = new HashMap<String, String>();
            h.put("Cache-Control", "max-age=31536000");
            h.put("Access-Control-Allow-Origin", "*");
            r.setResponseHeaders(h);
            return r;
        } catch (Throwable e) { return empty(404); }
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

    static File get(Context c, String path, long v, long mid, int mt) {
        if (path == null || path.length() == 0) return null;
        File src = new File(path);
        if (!Files.allowed(src) || !src.isFile()) return null;
        String key = sha1(path + "|" + (v == 0 ? src.lastModified() : v) + "|" + MAX);
        File dir = new File(c.getCacheDir(), "thumbs2");
        dir.mkdirs();
        File out = new File(dir, key + ".jpg");
        File none = new File(dir, key + ".none");
        if (out.exists()) return out;
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
