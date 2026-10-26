package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Locale;

/**
 * Clipboard history, the phone side: the last MAX clipboards that went through Flick (sent to the PC, or put on this
 * phone from it), kept in the app's own files only (files/cliphist/). index.json is the list, newest first: {id, kind
 * (text | link | image), preview, w, h, bytes, dir (in | out), pc, pcName, time, hash}; each item's content is a file of
 * its own (<id>.txt or <id>.png, and <id>.jpg, a small picture for the list), read only to copy or send it again. The
 * same content again moves to the top. No Android classes, so it runs on any JVM (ClipHistory is the Android side).
 */
final class ClipStore {
    static final int MAX = 20;
    static final int PREVIEW = 300;                   // characters of text kept in the list
    static final int TEXT_MAX = 1024 * 1024;          // what a clipboard carries (Clip.MAX_TEXT, the PC's limit)
    static final int PNG_MAX = 6 * 1024 * 1024;
    private static final SecureRandom RNG = new SecureRandom();

    private final File dir, index;
    private ArrayList<JSONObject> items;              // newest first; loaded on first use

    ClipStore(File dir) { this.dir = dir; this.index = new File(dir, "index.json"); }

    /**
     * Something went through Flick: text, or a PNG (with thumb, a small JPEG for the list, or null). dir "in" (from the
     * PC) or "out" (to it). Returns the entry, or null when it isn't a clipboard Flick keeps.
     */
    synchronized JSONObject add(String text, byte[] png, byte[] thumb, String dirIn, String pc, String pcName) {
        byte[] body;
        String kind;
        try {
            if (text != null) {
                if (text.length() == 0) return null;
                body = text.getBytes("UTF-8");
                if (body.length > TEXT_MAX) return null;
                kind = Links.ok(text.trim()) ? "link" : "text";
            } else {
                if (png == null || png.length < 24 || png.length > PNG_MAX || !isPng(png)) return null;
                body = png;
                kind = "image";
            }
            String hash = sha1(body);
            long now = System.currentTimeMillis();
            String d = "in".equals(dirIn) ? "in" : "out";
            ArrayList<JSONObject> l = load();
            for (int i = 0; i < l.size(); i++) {
                JSONObject o = l.get(i);
                if (!hash.equals(o.optString("hash"))) continue;
                o.put("dir", d); o.put("time", now); o.put("pc", str(pc)); o.put("pcName", str(pcName));
                l.remove(i);
                l.add(0, o);
                save();
                return o;
            }
            JSONObject o = new JSONObject();
            String id = newId();
            o.put("id", id);
            o.put("kind", kind);
            o.put("hash", hash);
            o.put("bytes", body.length);
            o.put("dir", d);
            o.put("time", now);
            o.put("pc", str(pc));
            o.put("pcName", str(pcName));
            if ("image".equals(kind)) {
                o.put("w", ((png[16] & 0xffL) << 24) | ((png[17] & 0xff) << 16) | ((png[18] & 0xff) << 8) | (png[19] & 0xff));
                o.put("h", ((png[20] & 0xffL) << 24) | ((png[21] & 0xff) << 16) | ((png[22] & 0xff) << 8) | (png[23] & 0xff));
            } else {
                String t = text.replaceAll("\\s+", " ").trim();
                o.put("preview", t.length() > PREVIEW ? t.substring(0, PREVIEW - 1) + "…" : t);
            }
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            writeBytes(payload(o), body);
            if (thumb != null && thumb.length > 0) { try { writeBytes(new File(dir, id + ".jpg"), thumb); } catch (IOException e) { /* no picture in the list */ } }
            l.add(0, o);
            while (l.size() > MAX) drop(l.remove(l.size() - 1));
            save();
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** The list for the page (no contents): each entry with "thumb" (a data: URL) for pictures that have one. */
    synchronized String listJson() {
        JSONArray a = new JSONArray();
        for (JSONObject o : load()) {
            try {
                JSONObject p = new JSONObject(o.toString());
                p.remove("hash");
                File t = new File(dir, o.optString("id") + ".jpg");
                if ("image".equals(o.optString("kind")) && t.isFile() && t.length() < 256 * 1024) p.put("thumb", "data:image/jpeg;base64," + base64(readBytes(t, 256 * 1024)));
                a.put(p);
            } catch (Exception e) { /* skip it */ }
        }
        return a.toString();
    }

    synchronized JSONObject find(String id) {
        if (id == null) return null;
        for (JSONObject o : load()) if (id.equals(o.optString("id"))) return o;
        return null;
    }

    /** An entry's text (null for a picture, or when it's gone). */
    synchronized String text(String id) {
        JSONObject o = find(id);
        if (o == null || "image".equals(o.optString("kind"))) return null;
        try { return new String(readBytes(payload(o), TEXT_MAX + 1), "UTF-8"); } catch (Exception e) { return null; }
    }

    /** An entry's picture as PNG bytes (null for text, or when it's gone). */
    synchronized byte[] png(String id) {
        JSONObject o = find(id);
        if (o == null || !"image".equals(o.optString("kind"))) return null;
        try { byte[] b = readBytes(payload(o), PNG_MAX + 1); return isPng(b) ? b : null; } catch (Exception e) { return null; }
    }

    synchronized boolean remove(String id) {
        ArrayList<JSONObject> l = load();
        for (int i = 0; i < l.size(); i++) {
            if (id != null && id.equals(l.get(i).optString("id"))) { drop(l.remove(i)); save(); return true; }
        }
        return false;
    }

    /** Everything goes (Clear, or the setting turned off): the files too. */
    synchronized void clear() {
        load().clear();
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) if (f.getName().matches("[0-9a-f]{16}\\.(txt|png|jpg)|index\\.json(\\.tmp)?")) f.delete();
    }

    synchronized int size() { return load().size(); }

    // ------------------------------------------------------------
    private File payload(JSONObject o) { return new File(dir, o.optString("id") + ("image".equals(o.optString("kind")) ? ".png" : ".txt")); }

    private void drop(JSONObject o) {
        payload(o).delete();
        new File(dir, o.optString("id") + ".jpg").delete();
    }

    private ArrayList<JSONObject> load() {
        if (items != null) return items;
        items = new ArrayList<JSONObject>();
        if (!index.isFile()) return items;
        try {
            JSONArray a = new JSONArray(HistoryStore.read(index));
            for (int i = 0; i < a.length() && items.size() < MAX; i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null && o.optString("id").matches("[0-9a-f]{16}") && payload(o).isFile()) items.add(o);
            }
        } catch (Exception e) {
            items.clear();                                // a damaged index: start over
        }
        return items;
    }

    private void save() {
        JSONArray a = new JSONArray();
        for (JSONObject o : load()) a.put(o);
        try { HistoryStore.write(index, a.toString()); } catch (IOException e) { /* stays in memory */ }
    }

    private static String newId() {
        byte[] b = new byte[8];
        RNG.nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.US, "%02x", x & 0xff));
        return s.toString();
    }

    static String sha1(byte[] b) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-1").digest(b);
        StringBuilder s = new StringBuilder();
        for (byte x : h) s.append(String.format(Locale.US, "%02x", x & 0xff));
        return s.toString();
    }

    private static String str(String s) { return s == null ? "" : (s.length() > 60 ? s.substring(0, 60) : s); }

    static boolean isPng(byte[] b) {
        return b != null && b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0d && b[5] == 0x0a && b[6] == 0x1a && b[7] == 0x0a;
    }

    static void writeBytes(File f, byte[] b) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(b); out.getFD().sync(); } finally { out.close(); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) { tmp.delete(); throw new IOException("rename failed"); } }
    }

    static byte[] readBytes(File f, int max) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) { b.write(buf, 0, n); if (b.size() > max) throw new IOException("too big"); }
            return b.toByteArray();
        } finally { in.close(); }
    }

    // java.util.Base64: Android 8 and newer (Flick needs Android 9), and any JVM, so this class needs nothing from Android
    static String base64(byte[] b) { return java.util.Base64.getEncoder().encodeToString(b); }
}
