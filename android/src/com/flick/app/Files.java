package com.flick.app;

import android.Manifest;
import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Read-only view of the phone's shared storage, like a file manager. */
final class Files {
    private Files() {}

    static final String[] DOC_MIMES = {
            "application/pdf", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
            "application/rtf", "application/epub+zip", "text/plain", "text/csv", "text/markdown", "text/x-markdown",
            "text/html", "application/json", "application/xml", "text/xml",
    };

    // ------------------------------------------------------------ permission
    static boolean granted(Context c) {
        if (Build.VERSION.SDK_INT >= 30) return Api30.isManager();
        return c.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @TargetApi(30)
    static final class Api30 {
        static boolean isManager() { try { return Environment.isExternalStorageManager(); } catch (Throwable e) { return false; } }
    }

    static File root() { return Environment.getExternalStorageDirectory(); }

    /** Only paths inside shared storage are ever exposed. */
    static boolean allowed(File f) {
        try {
            String p = f.getCanonicalPath();
            String r = root().getCanonicalPath();
            return p.equals(r) || p.startsWith(r + "/") || p.startsWith("/storage/");
        } catch (Throwable e) { return false; }
    }

    // ------------------------------------------------------------ JSON helpers
    static String extOf(String n) { return Library.extOf(n); }

    static String mimeOf(String name) {
        String e = extOf(name);
        String m = e.length() > 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(e) : null;
        if (m == null) {
            if ("md".equals(e) || "markdown".equals(e)) m = "text/markdown";
            else if ("apk".equals(e)) m = "application/vnd.android.package-archive";
            else if ("heic".equals(e) || "heif".equals(e)) m = "image/heic";
            else m = "application/octet-stream";
        }
        return m;
    }

    static String kindOf(String name, String mime) {
        String e = extOf(name);
        if ("apk".equals(e)) return "apk";
        return Library.kindOf(mime, e);
    }

    static JSONObject fileJson(File f, long[] media) { return fileJson(f, media, f.lastModified()); }

    /** mtime: f.lastModified(), when the caller already has it (each call is a trip to the file system). */
    static JSONObject fileJson(File f, long[] media, long mtime) {
        JSONObject o = new JSONObject();
        try {
            String name = f.getName();
            String mime = mimeOf(name);
            o.put("id", "p:" + f.getPath());
            o.put("path", f.getPath());
            o.put("name", name);
            o.put("size", f.length());
            o.put("mtime", mtime);
            o.put("added", mtime);
            o.put("mime", mime);
            o.put("ext", extOf(name));
            o.put("kind", kindOf(name, mime));
            if (media != null) {
                o.put("mid", media[0]);
                if (media.length > 5 && media[5] > 0) o.put("mt", media[5]);   // MediaStore type (1 image, 3 video), for its thumbnails
                long w = media[1], h = media[2];
                if (media[3] == 90 || media[3] == 270) { long t = w; w = h; h = t; }
                if (w > 0 && h > 0) { o.put("w", w); o.put("h", h); }
                if (media[4] > 0) o.put("dur", media[4]);
            }
        } catch (Throwable e) { /* ignore */ }
        return o;
    }

    static int childCount(File d) {
        String[] k = d.list();
        if (k == null) return 0;
        int n = 0;
        for (String s : k) if (!s.startsWith(".") && !s.endsWith(PART)) n++;   // as listDir shows them
        return n;
    }

    static JSONObject dirJson(File d) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", "d:" + d.getPath());
            o.put("path", d.getPath());
            o.put("name", d.getName());
            o.put("dir", true);
            o.put("count", childCount(d));
            o.put("mtime", d.lastModified());
        } catch (Throwable e) { /* ignore */ }
        return o;
    }

    // ------------------------------------------------------------ folders
    static String listDir(Context c, String path) {
        JSONObject out = new JSONObject();
        try {
            File d = path == null || path.length() == 0 ? root() : new File(path);
            if (!allowed(d) || !d.isDirectory()) { out.put("error", "notfound"); return out.toString(); }
            File[] kids = d.listFiles();
            JSONArray items = new JSONArray();
            if (kids != null) {
                ArrayList<File> dirs = new ArrayList<File>(), files = new ArrayList<File>();
                for (File k : kids) {
                    if (k.getName().startsWith(".") || k.getName().endsWith(PART)) continue;   // hidden, or a download still arriving
                    if (k.isDirectory()) dirs.add(k); else files.add(k);
                }
                Collections.sort(dirs, new Comparator<File>() {
                    @Override public int compare(File a, File b) { return a.getName().compareToIgnoreCase(b.getName()); }
                });
                final HashMap<File, Long> mt = new HashMap<File, Long>();
                for (File f : files) mt.put(f, f.lastModified());
                Collections.sort(files, new Comparator<File>() {
                    @Override public int compare(File a, File b) { long x = mt.get(a), y = mt.get(b); return x == y ? 0 : (x > y ? -1 : 1); }
                });
                Map<String, long[]> media = files.isEmpty() ? new HashMap<String, long[]>() : mediaInDir(c, d);
                for (File k : dirs) items.put(dirJson(k));
                for (File f : files) items.put(fileJson(f, media.get(f.getPath()), mt.get(f)));
            }
            boolean isRoot = d.getCanonicalPath().equals(root().getCanonicalPath());
            out.put("path", d.getPath());
            out.put("name", isRoot ? "Phone storage" : d.getName());
            out.put("parent", isRoot || d.getParentFile() == null || !allowed(d.getParentFile()) ? JSONObject.NULL : d.getParent());
            out.put("items", items);
            out.put("total", items.length());
        } catch (Throwable e) {
            try { out.put("error", String.valueOf(e.getMessage())); } catch (Throwable x) { /* ignore */ }
        }
        return out.toString();
    }

    /** MediaStore info (id, w, h, orientation, duration) for media files directly inside a folder. */
    static Map<String, long[]> mediaInDir(Context c, File d) {
        HashMap<String, long[]> m = new HashMap<String, long[]>();
        String prefix = d.getPath() + "/";
        String sel = "_data LIKE ?";
        String[] args = {escapeLike(prefix) + "%"};
        readMedia(c, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, false, sel, args, prefix, m);
        readMedia(c, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, false, true, sel, args, prefix, m);
        return m;
    }

    private static String escapeLike(String s) { return s.replace("%", "\\%").replace("_", "\\_"); }

    private static void readMedia(Context c, Uri uri, boolean image, boolean video, String sel, String[] args, String prefix, Map<String, long[]> out) {
        ArrayList<String> proj = new ArrayList<String>(Arrays.asList("_id", "_data", "width", "height"));
        if (image || Build.VERSION.SDK_INT >= 29) proj.add("orientation");
        if (video) proj.add("duration");
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(uri, proj.toArray(new String[0]), sel + " ESCAPE '\\'", args, null);
            if (cur == null) return;
            int iId = cur.getColumnIndex("_id"), iData = cur.getColumnIndex("_data"), iW = cur.getColumnIndex("width"), iH = cur.getColumnIndex("height");
            int iO = cur.getColumnIndex("orientation"), iD = cur.getColumnIndex("duration");
            while (cur.moveToNext()) {
                String p = cur.getString(iData);
                if (p == null || !p.startsWith(prefix) || p.indexOf('/', prefix.length()) >= 0) continue;
                out.put(p, new long[]{cur.getLong(iId), cur.getLong(iW), cur.getLong(iH), iO >= 0 ? cur.getLong(iO) : 0, iD >= 0 ? cur.getLong(iD) : 0, image ? 1 : 3});
            }
        } catch (Throwable e) { /* ignore */ } finally { if (cur != null) cur.close(); }
    }

    // ------------------------------------------------------------ categories (MediaStore)
    static String query(Context c, String cat, int offset, int limit) { return query(c, cat, offset, limit, null, null); }

    /**
     * A page of a category. sort: "date-desc" (newest first, the default), "date-asc", "name-asc", "name-desc",
     * "size-asc", "size-desc", "type-asc" or "type-desc"; q: only files whose name contains each of its words.
     */
    static String query(Context c, String cat, int offset, int limit, String sort, String q) {
        JSONObject out = new JSONObject();
        Cursor cur = null;
        try {
            Uri uri;
            String sel;
            String[] args = null;
            boolean image = false, video = false, audio = false, files = false;
            if ("photos".equals(cat)) { uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI; image = true; sel = "_size > 0"; }
            else if ("videos".equals(cat)) { uri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI; video = true; sel = "_size > 0"; }
            else if ("audio".equals(cat)) { uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI; audio = true; sel = "_size > 0"; }
            else {
                uri = MediaStore.Files.getContentUri("external");
                files = true;
                StringBuilder in = new StringBuilder();
                for (int i = 0; i < DOC_MIMES.length; i++) in.append(i == 0 ? "?" : ",?");
                if ("docs".equals(cat)) {
                    sel = "(mime_type IN (" + in + ") OR _data LIKE '%.md' OR _data LIKE '%.txt' OR _data LIKE '%.pdf') AND _size > 0";
                    args = DOC_MIMES;
                } else if ("apks".equals(cat)) {
                    sel = "_data LIKE '%.apk' AND _size > 0";
                } else { // recent
                    sel = "(media_type IN (1,2,3) OR mime_type IN (" + in + ") OR _data LIKE '%.apk') AND _size > 0 AND _data NOT LIKE '%/Android/data/%' AND _data NOT LIKE '%/Android/obb/%'";
                    args = DOC_MIMES;
                }
            }
            sel = sel + " AND _data NOT LIKE '%/.%'";
            ArrayList<String> sargs = new ArrayList<String>();
            if (args != null) sargs.addAll(Arrays.asList(args));
            if (q != null) {
                int words = 0;
                for (String w : q.trim().split("\\s+")) {
                    if (w.length() == 0 || words++ >= 6) continue;
                    sel = sel + " AND _display_name LIKE ? ESCAPE '\\'";
                    sargs.add("%" + escapeLike(w) + "%");
                }
            }
            if (!sargs.isEmpty()) args = sargs.toArray(new String[0]);
            ArrayList<String> proj = new ArrayList<String>(Arrays.asList("_id", "_data", "_display_name", "_size", "date_modified", "mime_type"));
            if (image || video || files) { proj.add("width"); proj.add("height"); }
            if (image || Build.VERSION.SDK_INT >= 29) proj.add("orientation");
            if (video || audio || Build.VERSION.SDK_INT >= 29) proj.add("duration");
            if (files) proj.add("media_type");
            String[] cols = proj.toArray(new String[0]);
            try { cur = c.getContentResolver().query(uri, cols, sel, args, orderBy(sort, true)); }
            catch (IllegalArgumentException e) { cur = c.getContentResolver().query(uri, cols, sel, args, orderBy(sort, false)); }   // (a provider that refuses COLLATE)
            JSONArray items = new JSONArray();
            int total = 0;
            if (cur != null) {
                total = cur.getCount();
                int iId = cur.getColumnIndex("_id"), iData = cur.getColumnIndex("_data"), iName = cur.getColumnIndex("_display_name");
                int iSize = cur.getColumnIndex("_size"), iDate = cur.getColumnIndex("date_modified"), iMime = cur.getColumnIndex("mime_type");
                int iW = cur.getColumnIndex("width"), iH = cur.getColumnIndex("height"), iO = cur.getColumnIndex("orientation");
                int iDur = cur.getColumnIndex("duration"), iMt = cur.getColumnIndex("media_type");
                if (offset > 0 && !cur.moveToPosition(offset - 1)) { /* past the end */ }
                int n = 0;
                while (n < limit && cur.moveToNext()) {
                    String p = cur.getString(iData);
                    if (p == null) continue;
                    String name = iName >= 0 && cur.getString(iName) != null ? cur.getString(iName) : new File(p).getName();
                    String mime = iMime >= 0 && cur.getString(iMime) != null ? cur.getString(iMime) : mimeOf(name);
                    JSONObject o = new JSONObject();
                    o.put("id", "p:" + p);
                    o.put("path", p);
                    o.put("name", name);
                    o.put("size", cur.getLong(iSize));
                    long mt = cur.getLong(iDate) * 1000L;
                    o.put("mtime", mt);
                    o.put("added", mt);
                    o.put("mime", mime);
                    o.put("ext", extOf(name));
                    o.put("kind", kindOf(name, mime));
                    long mid = cur.getLong(iId);
                    int mtype = image ? 1 : video ? 3 : audio ? 2 : (iMt >= 0 ? cur.getInt(iMt) : 0);
                    if (mtype == 1 || mtype == 2 || mtype == 3) { o.put("mid", mid); o.put("mt", mtype); }
                    if (iW >= 0 && iH >= 0) {
                        long w = cur.getLong(iW), h = cur.getLong(iH);
                        long or = iO >= 0 ? cur.getLong(iO) : 0;
                        if (or == 90 || or == 270) { long t = w; w = h; h = t; }
                        if (w > 0 && h > 0) { o.put("w", w); o.put("h", h); }
                    }
                    if (iDur >= 0) { long d = cur.getLong(iDur); if (d > 0) o.put("dur", d); }
                    items.put(o);
                    n++;
                }
            }
            out.put("items", items);
            out.put("total", total);
            out.put("more", offset + items.length() < total);
        } catch (Throwable e) {
            try { out.put("error", String.valueOf(e.getMessage())); out.put("items", new JSONArray()); } catch (Throwable x) { /* ignore */ }
        } finally { if (cur != null) cur.close(); }
        return out.toString();
    }

    /** The ORDER BY for a query() sort (only these fixed clauses; nocase: names A to Z whatever their case). */
    static String orderBy(String sort, boolean nocase) {
        String s = sort == null ? "" : sort;
        boolean asc = s.endsWith("-asc");
        String name = "_display_name" + (nocase ? " COLLATE NOCASE" : "");
        if (s.startsWith("name-")) return name + (asc ? " ASC" : " DESC");
        if (s.startsWith("size-")) return "_size" + (asc ? " ASC" : " DESC") + ", " + name + " ASC";
        if (s.startsWith("type-")) return "mime_type" + (asc ? " ASC" : " DESC") + ", " + name + " ASC";
        return "date_modified" + (s.startsWith("date-") && asc ? " ASC" : " DESC");
    }

    /** Where files received from the PC are written when Flick can see shared storage. */
    static File inbox() {
        File d = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Flick");
        d.mkdirs();
        return d;
    }

    // ------------------------------------------------------------ files arriving from the PC
    // Two files with the same name can arrive at once (two folders on the PC that each hold IMG_0001.jpg). A name is
    // chosen and claimed in one step, under one lock for the whole app: claimed means its part file exists, which the
    // next download sees. The part file is hidden (".IMG_0001.jpg.flickpart") until the file is complete; then it is
    // renamed, under the same lock and never over an existing file.
    static final String PART = ".flickpart";
    private static final Object NAMES = new Object();

    /** A file being received: written to part, then finish() gives it its name. */
    static final class Incoming {
        private final File dir;
        private final String name;           // the (sanitized) name asked for
        private final File dest;
        final File part;

        private Incoming(File dir, String name, File dest, File part) { this.dir = dir; this.name = name; this.dest = dest; this.part = part; }

        /** Renames the complete part file; if its name got taken meanwhile, to the next free one. Returns the file. */
        File finish() throws IOException {
            synchronized (NAMES) {
                File to = dest.exists() ? free(dir, name, 2) : dest;
                if (to == null || !part.renameTo(to)) { part.delete(); throw new IOException("rename failed"); }
                return to;
            }
        }

        void cancel() { part.delete(); }
    }

    /** The hidden file a download is written to before it is complete. */
    static File partOf(File f) { return new File(f.getParentFile(), "." + f.getName() + PART); }

    /** Claims a name in dir that neither exists nor is being downloaded to, by creating its part file. */
    static Incoming reserve(File dir, String name) throws IOException {
        String safe = Library.sanitize(name);
        synchronized (NAMES) {
            for (int i = 1; i < 10000; i++) {
                File f = new File(dir, numbered(safe, i)), p = partOf(f);
                if (!f.exists() && p.createNewFile()) return new Incoming(dir, safe, f, p);
            }
            File f = new File(dir, System.currentTimeMillis() + "_" + safe), p = partOf(f);
            if (!p.createNewFile()) throw new IOException("no free name");
            return new Incoming(dir, safe, f, p);
        }
    }

    /** The first of "name.ext", "name (2).ext", "name (3).ext"… from number `from` on that is free (null: none). */
    private static File free(File dir, String safe, int from) {
        for (int i = Math.max(1, from); i < 10000; i++) {
            File f = new File(dir, numbered(safe, i));
            if (!f.exists() && !partOf(f).exists()) return f;
        }
        return null;
    }

    /** "name.ext" (i = 1), "name (2).ext", "name (3).ext"… */
    static String numbered(String safe, int i) {
        if (i <= 1) return safe;
        int e = extOf(safe).length();
        return e > 0 ? safe.substring(0, safe.length() - e - 1) + " (" + i + ")" + safe.substring(safe.length() - e - 1)
                : safe + " (" + i + ")";
    }

    /** Part files that a killed app or a crash left in Download/Flick (a day old: nothing still writes them). */
    static void sweepParts() {
        File[] fs = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Flick").listFiles();
        if (fs == null) return;
        long old = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        for (File f : fs) if (f.getName().endsWith(PART) && f.isFile() && f.lastModified() < old) f.delete();
    }

    static String lower(String s) { return s == null ? "" : s.toLowerCase(Locale.US); }
}
