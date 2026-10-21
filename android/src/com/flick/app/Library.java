package com.flick.app;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfRenderer;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Size;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** The phone-side shelf of files: stored privately, with thumbnails. */
public final class Library {
    public interface Progress { boolean onBytes(long total); }

    private static Library inst;
    public static synchronized Library get(Context c) {
        if (inst == null) inst = new Library(c.getApplicationContext());
        return inst;
    }

    private final Context ctx;
    private final File root, thumbs, index;
    private final ArrayList<JSONObject> items = new ArrayList<JSONObject>();
    private static final SecureRandom RNG = new SecureRandom();

    private Library(Context c) {
        ctx = c;
        root = new File(c.getFilesDir(), "lib");
        thumbs = new File(c.getFilesDir(), "thumbs");
        index = new File(c.getFilesDir(), "lib.json");
        root.mkdirs();
        thumbs.mkdirs();
        load();
    }

    // ------------------------------------------------------------ persistence
    private synchronized void load() {
        try {
            if (!index.exists()) return;
            String s = new String(readAll(new FileInputStream(index), 8 * 1024 * 1024), "UTF-8");
            JSONArray a = new JSONArray(s);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                if (fileOf(o).exists()) items.add(o);
            }
        } catch (Throwable e) { /* start empty */ }
    }

    private synchronized void save() {
        try {
            JSONArray a = new JSONArray();
            for (JSONObject o : items) a.put(o);
            File tmp = new File(index.getPath() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(a.toString().getBytes("UTF-8"));
            out.getFD().sync();
            out.close();
            if (!tmp.renameTo(index)) { index.delete(); tmp.renameTo(index); }
        } catch (Throwable e) { /* ignore */ }
    }

    // ------------------------------------------------------------ queries
    public synchronized String listJson() {
        JSONArray a = new JSONArray();
        for (JSONObject o : items) a.put(publicJson(o));
        return a.toString();
    }

    public JSONObject publicJson(JSONObject o) {
        try {
            JSONObject p = new JSONObject(o.toString());
            if (o.optBoolean("hasThumb")) p.put("thumb", "https://flick.local/thumb/" + o.optString("id") + "?v=" + o.optLong("added"));
            else p.put("thumb", JSONObject.NULL);
            p.remove("hasThumb");
            return p;
        } catch (Throwable e) { return o; }
    }

    public synchronized JSONObject find(String id) {
        if (id == null) return null;
        for (JSONObject o : items) if (id.equals(o.optString("id"))) return o;
        return null;
    }

    public File fileOf(JSONObject o) {
        return new File(new File(root, o.optString("id")), o.optString("name"));
    }

    public synchronized File file(String id) {
        JSONObject o = find(id);
        return o == null ? null : fileOf(o);
    }

    public boolean remove(String id) {
        return removeAll(Collections.singletonList(id)) > 0;
    }

    /** Several items at once, with one rewrite of lib.json for all of them. Returns how many were removed. */
    public int removeAll(Collection<String> ids) {
        ArrayList<String> gone = new ArrayList<String>();
        synchronized (this) {
            for (String id : ids) {
                JSONObject o = find(id);
                if (o == null) continue;
                items.remove(o);
                gone.add(o.optString("id"));
            }
            if (gone.isEmpty()) return 0;
            save();
        }
        for (String id : gone) {
            deleteTree(new File(root, id));
            new File(thumbs, id + ".jpg").delete();
        }
        return gone.size();
    }

    /** Import folders a killed app left half-written: still marked as importing a day later, and not on the shelf. */
    void sweep() {
        File[] dirs = root.listFiles();
        if (dirs == null) return;
        long old = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        for (File d : dirs) {
            File mark = new File(d, IMPORTING);
            if (!mark.isFile() || mark.lastModified() >= old) continue;
            if (find(d.getName()) != null) { mark.delete(); continue; }   // it did make it onto the shelf
            deleteTree(d);
            new File(thumbs, d.getName() + ".jpg").delete();
        }
    }

    public String thumbBase64(String id) {
        File t = new File(thumbs, id + ".jpg");
        if (!t.exists()) return "";
        try { return Base64.encodeToString(readAll(new FileInputStream(t), 4 * 1024 * 1024), Base64.NO_WRAP); }
        catch (Throwable e) { return ""; }
    }

    public WebResourceResponse intercept(String url) {
        try {
            if (url == null || !url.startsWith("https://flick.local/")) return null;
            Uri u = Uri.parse(url);
            java.util.List<String> seg = u.getPathSegments();
            if (seg.size() == 2 && "thumb".equals(seg.get(0))) {
                File t = new File(thumbs, seg.get(1) + ".jpg");
                if (!t.exists()) return notFound();
                WebResourceResponse r = new WebResourceResponse("image/jpeg", null, new FileInputStream(t));
                Map<String, String> h = new HashMap<String, String>();
                h.put("Cache-Control", "max-age=31536000");
                h.put("Access-Control-Allow-Origin", "*");
                r.setResponseHeaders(h);
                return r;
            }
            return notFound();
        } catch (Throwable e) { return notFound(); }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
        try { r.setStatusCodeAndReasonPhrase(404, "Not Found"); } catch (Throwable e) { /* ignore */ }
        return r;
    }

    // ------------------------------------------------------------ importing
    public JSONObject importUri(Uri uri) throws IOException {
        ContentResolver cr = ctx.getContentResolver();
        String name = null;
        Cursor c = null;
        try {
            c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
        } catch (Throwable e) { /* ignore */ } finally { if (c != null) c.close(); }
        if (name == null || name.length() == 0) name = uri.getLastPathSegment();
        String mime = null;
        try { mime = cr.getType(uri); } catch (Throwable e) { /* ignore */ }
        name = ensureExt(sanitize(name == null ? "file" : name), mime);
        InputStream in = cr.openInputStream(uri);
        if (in == null) throw new IOException("Cannot open");
        try { return importStream(in, name, mime, null); } finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
    }

    public JSONObject importText(String text, String title) throws IOException {
        String name = sanitize(title == null || title.length() == 0 ? "Note.txt" : title);
        if (!name.contains(".")) name = name + ".txt";
        return importStream(new java.io.ByteArrayInputStream(text.getBytes("UTF-8")), name, "text/plain", null);
    }

    /** In lib/<id>/ while the file is still arriving (sanitized names never start with a dot, so it can't clash). */
    static final String IMPORTING = ".importing";

    public JSONObject importStream(InputStream in, String name, String mime, Progress p) throws IOException {
        String id = newId();
        File dir = new File(root, id);
        dir.mkdirs();
        File mark = new File(dir, IMPORTING);
        try { mark.createNewFile(); } catch (IOException e) { /* only the clean-up after a crash needs it */ }
        String safe = sanitize(name);
        File f = new File(dir, safe);
        long n;
        OutputStream out = new FileOutputStream(f);
        try {
            byte[] buf = new byte[128 * 1024];
            n = 0;
            int r;
            while ((r = in.read(buf)) > 0) {
                out.write(buf, 0, r);
                n += r;
                if (p != null && !p.onBytes(n)) throw new IOException("aborted");
            }
        } catch (IOException e) {
            out.close();
            deleteTree(dir);
            throw e;
        }
        out.close();
        String ext = extOf(safe);
        if (mime == null || mime.length() == 0 || "application/octet-stream".equals(mime)) {
            String g = ext.length() > 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) : null;
            mime = g != null ? g : (mime == null || mime.length() == 0 ? "application/octet-stream" : mime);
        }
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("name", safe);
            o.put("size", n);
            o.put("mime", mime);
            o.put("ext", ext);
            o.put("kind", kindOf(mime, ext));
            o.put("added", System.currentTimeMillis());
        } catch (Throwable e) { /* ignore */ }
        makeThumb(o, f);
        synchronized (this) {
            items.add(0, o);
            save();
        }
        mark.delete();
        return publicJson(o);
    }

    // ------------------------------------------------------------ helpers
    static String newId() {
        byte[] b = new byte[8];
        RNG.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    static String sanitize(String n) {
        if (n == null) n = "file";
        n = n.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() == 0) n = "file";
        // At most 150 characters and 237 bytes (file systems allow 255 bytes per name; this leaves room for " (2)" and
        // the part file's name). The extension stays; a "dot" far from the end (a long title like "Notes v2.0 - …")
        // is not one.
        if (n.length() > 150 || utf8(n) > 237) {
            int dot = n.lastIndexOf('.');
            String e = dot > 0 && dot < n.length() - 1 && n.length() - dot <= 17 ? n.substring(dot) : "";
            String base = cut(n.substring(0, n.length() - e.length()), 150 - e.length());
            while (base.length() > 1 && utf8(base) + utf8(e) > 237) base = cut(base, base.length() - 1);
            n = base + e;
        }
        return n;
    }

    /** s shortened to max chars, never between the two halves of a surrogate pair (an emoji). */
    private static String cut(String s, int max) {
        if (s.length() <= max) return s;
        int end = Math.max(0, max);
        if (end > 0 && Character.isHighSurrogate(s.charAt(end - 1))) end--;
        return s.substring(0, end);
    }

    private static int utf8(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }

    static String ensureExt(String name, String mime) {
        if (extOf(name).length() > 0 || mime == null) return name;
        String e = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        return e == null ? name : name + "." + e;
    }

    static String extOf(String n) {
        int i = n == null ? -1 : n.lastIndexOf('.');
        if (i <= 0 || i == n.length() - 1) return "";
        return n.substring(i + 1).toLowerCase(Locale.US);
    }

    static String kindOf(String mime, String ext) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.US);
        if (m.startsWith("image/")) return "image";
        if (m.startsWith("video/")) return "video";
        if (m.startsWith("audio/")) return "audio";
        if (m.equals("application/pdf") || "pdf".equals(ext)) return "pdf";
        if (m.startsWith("text/") || m.equals("application/json") || m.equals("application/xml")) return "text";
        String[] textExt = {"txt", "md", "markdown", "csv", "json", "log", "xml", "yml", "yaml", "ini", "srt"};
        for (String t : textExt) if (t.equals(ext)) return "text";
        String[] imgExt = {"jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"};
        for (String t : imgExt) if (t.equals(ext)) return "image";
        String[] vidExt = {"mp4", "mov", "m4v", "webm", "mkv", "3gp"};
        for (String t : vidExt) if (t.equals(ext)) return "video";
        return "doc";
    }

    static byte[] readAll(InputStream in, int max) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[32 * 1024];
            int r, total = 0;
            while ((r = in.read(buf)) > 0) {
                bo.write(buf, 0, r);
                total += r;
                if (total > max) break;
            }
            return bo.toByteArray();
        } finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // ------------------------------------------------------------ thumbnails
    private void makeThumb(JSONObject o, File f) {
        Bitmap b = null;
        try {
            String kind = o.optString("kind");
            if ("image".equals(kind)) b = decodeImage(f, 720);
            else if ("video".equals(kind)) b = videoFrame(f, 720);
            else if ("pdf".equals(kind)) b = pdfPage(f, 520);
            else if ("text".equals(kind)) b = textPage(f, o.optString("name"));
            else if ("audio".equals(kind)) b = albumArt(f, 600);
            if (b != null) {
                File t = new File(thumbs, o.getString("id") + ".jpg");
                FileOutputStream out = new FileOutputStream(t);
                b.compress(Bitmap.CompressFormat.JPEG, 84, out);
                out.close();
                o.put("w", b.getWidth());
                o.put("h", b.getHeight());
                o.put("hasThumb", true);
            }
        } catch (Throwable e) { /* no thumbnail */ }
        finally { if (b != null) b.recycle(); }
    }

    static Bitmap scaleTo(Bitmap b, int max) {
        if (b == null) return null;
        int w = b.getWidth(), h = b.getHeight();
        float r = Math.min(1f, (float) max / Math.max(w, h));
        if (r >= 0.999f) return b;
        Bitmap s = Bitmap.createScaledBitmap(b, Math.max(1, Math.round(w * r)), Math.max(1, Math.round(h * r)), true);
        if (s != b) b.recycle();
        return s;
    }

    static Bitmap decodeImage(File f, int max) {
        if (Build.VERSION.SDK_INT >= 28) {
            Bitmap b = Api28.decode(f, max);
            if (b != null) return b;
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int s = 1;
        while (o.outWidth / (s * 2) >= max && o.outHeight / (s * 2) >= max) s *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = s;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), o2);
        if (b == null) return null;
        try {
            ExifInterface ex = new ExifInterface(f.getPath());
            int or = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            int deg = or == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : or == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : or == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
            if (deg != 0) {
                Matrix m = new Matrix();
                m.postRotate(deg);
                Bitmap r = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
                if (r != b) b.recycle();
                b = r;
            }
        } catch (Throwable e) { /* ignore orientation */ }
        return scaleTo(b, max);
    }

    @TargetApi(28)
    static final class Api28 {
        static Bitmap decode(File f, final int max) {
            try {
                ImageDecoder.Source src = ImageDecoder.createSource(f);
                return ImageDecoder.decodeBitmap(src, new ImageDecoder.OnHeaderDecodedListener() {
                    @Override
                    public void onHeaderDecoded(ImageDecoder d, ImageDecoder.ImageInfo info, ImageDecoder.Source s) {
                        Size sz = info.getSize();
                        float r = Math.min(1f, (float) max / Math.max(sz.getWidth(), sz.getHeight()));
                        d.setTargetSize(Math.max(1, Math.round(sz.getWidth() * r)), Math.max(1, Math.round(sz.getHeight() * r)));
                        d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                    }
                });
            } catch (Throwable e) { return null; }
        }
    }

    static Bitmap videoFrame(File f, int max) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getPath());
            Bitmap b;
            if (Build.VERSION.SDK_INT >= 27) {
                // a thumbnail-sized frame, not a full-resolution one (a 4K frame alone is 33 MB)
                b = Api27.frame(r, 400000, max);
                if (b == null) b = Api27.frame(r, -1, max);
            } else {
                b = r.getFrameAtTime(400000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                if (b == null) b = r.getFrameAtTime();
            }
            return scaleTo(b, max);
        } catch (Throwable e) { return null; }
        finally { try { r.release(); } catch (Throwable e) { /* ignore */ } }
    }

    @TargetApi(27)
    static final class Api27 {
        static Bitmap frame(MediaMetadataRetriever r, long us, int max) {
            int w = 0, h = 0;
            try {
                w = Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                h = Integer.parseInt(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            } catch (Throwable e) { /* unknown size: let it scale */ }
            if (w > 0 && h > 0 && Math.max(w, h) <= max) return r.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);   // small already
            return r.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, max, max);
        }
    }

    static Bitmap albumArt(File f, int max) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getPath());
            byte[] pic = r.getEmbeddedPicture();
            if (pic == null) return null;
            return scaleTo(BitmapFactory.decodeByteArray(pic, 0, pic.length), max);
        } catch (Throwable e) { return null; }
        finally { try { r.release(); } catch (Throwable e) { /* ignore */ } }
    }

    static Bitmap pdfPage(File f, int width) {
        ParcelFileDescriptor pfd = null;
        PdfRenderer pr = null;
        PdfRenderer.Page page = null;
        try {
            pfd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
            pr = new PdfRenderer(pfd);
            if (pr.getPageCount() < 1) return null;
            page = pr.openPage(0);
            int w = width;
            int h = Math.max(1, Math.round(w * (float) page.getHeight() / Math.max(1, page.getWidth())));
            if (h > width * 2) h = width * 2;
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            b.eraseColor(Color.WHITE);
            page.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            return b;
        } catch (Throwable e) { return null; }
        finally {
            try { if (page != null) page.close(); } catch (Throwable e) { /* ignore */ }
            try { if (pr != null) pr.close(); } catch (Throwable e) { /* ignore */ }
            try { if (pfd != null) pfd.close(); } catch (Throwable e) { /* ignore */ }
        }
    }

    static Bitmap textPage(File f, String name) {
        try {
            byte[] data = readAll(new FileInputStream(f), 3000);
            String text = new String(data, Charset.forName("UTF-8")).replace("\r", "");
            int W = 480, H = 640, pad = 34;
            Bitmap b = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
            b.eraseColor(Color.WHITE);
            Canvas c = new Canvas(b);
            Paint title = new Paint(Paint.ANTI_ALIAS_FLAG);
            title.setColor(Color.rgb(24, 24, 28));
            title.setTextSize(25);
            title.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            Paint body = new Paint(Paint.ANTI_ALIAS_FLAG);
            body.setColor(Color.rgb(78, 78, 88));
            body.setTextSize(16.5f);
            String t = name == null ? "" : name;
            int dot = t.lastIndexOf('.');
            if (dot > 0) t = t.substring(0, dot);
            float y = pad + 26;
            c.drawText(ellipsize(t, title, W - pad * 2), pad, y, title);
            y += 22;
            String[] lines = text.split("\n");
            for (String raw : lines) {
                String line = raw.replace("\t", "    ");
                if (line.startsWith("#")) line = line.replaceFirst("^#+\\s*", "");
                while (true) {
                    y += 25;
                    if (y > H - pad) return b;
                    if (line.length() == 0) break;
                    int n = body.breakText(line, true, W - pad * 2, null);
                    if (n <= 0) n = 1;
                    c.drawText(line.substring(0, n), pad, y, body);
                    line = line.substring(n);
                    if (line.length() == 0) break;
                }
            }
            return b;
        } catch (Throwable e) { return null; }
    }

    static String ellipsize(String s, Paint p, float w) {
        if (p.measureText(s) <= w) return s;
        while (s.length() > 1 && p.measureText(s + "…") > w) s = s.substring(0, s.length() - 1);
        return s + "…";
    }
}
