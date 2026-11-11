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
import java.util.HashSet;
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
    private boolean unread;                           // the index is there but couldn't be read (see load)

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
                String blank = blank(text);
                o.put("preview", blank != null ? blank : t.length() > PREVIEW ? cut(t, PREVIEW - 1) + "…" : t);
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

    /**
     * "Blank text (N characters)" for text with nothing to see in it (spaces, tabs, a zero-width or no-break space, a
     * control character: an empty table cell, say), so its row in the list says something; null for any other text.
     */
    static String blank(String text) {
        int n = 0;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            n++;
            int ty = Character.getType(cp);
            boolean unseen = Character.isWhitespace(cp) || Character.isSpaceChar(cp) || ty == Character.CONTROL || ty == Character.FORMAT
                    || cp == 0x034F || cp == 0x115F || cp == 0x1160 || cp == 0x2800 || cp == 0x3164 || cp == 0xFFA0;
            if (!unseen) return null;
        }
        return "Blank text (" + n + (n == 1 ? " character)" : " characters)");
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

    // An index that couldn't be read (too many files open, a disk error) isn't a damaged one: taken as empty, the next
    // clip was saved alone over the whole list. It's read again on the next use and isn't written over until it has
    // been (clips added meanwhile go on top of it then).
    private ArrayList<JSONObject> load() {
        if (items != null && !unread) return items;
        if (items == null) items = new ArrayList<JSONObject>();
        if (!index.isFile()) { unread = false; return items; }
        String text;
        try { text = HistoryStore.read(index); } catch (IOException e) { unread = true; return items; }
        ArrayList<JSONObject> got = new ArrayList<JSONObject>(items);
        HashSet<String> have = new HashSet<String>();
        HashSet<String> ids = new HashSet<String>();    // the ids listed (a file of one of them is never dropped)
        for (JSONObject o : items) { have.add(o.optString("hash")); ids.add(o.optString("id")); }
        try {
            JSONArray a = new JSONArray(text);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null || !o.optString("id").matches("[0-9a-f]{16}")) continue;
                if (got.size() < MAX && payload(o).isFile() && !have.contains(o.optString("hash"))) { got.add(o); ids.add(o.optString("id")); }
                // one of the index's that the clips added meanwhile left no room for (or that was copied again meanwhile):
                // off the list, so its files go too (they stayed on disk until the history was cleared)
                else if (!items.isEmpty() && !ids.contains(o.optString("id"))) drop(o);
            }
        } catch (Exception e) {
            got = new ArrayList<JSONObject>(items);       // a damaged index: start over
        }
        boolean added = !items.isEmpty();
        items = got;
        unread = false;
        if (added) save();                               // (what was added meanwhile)
        return items;
    }

    private void save() {
        ArrayList<JSONObject> l = load();
        if (unread) return;                               // (stays in memory: see load)
        JSONArray a = new JSONArray();
        for (JSONObject o : l) a.put(o);
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

    /**
     * t cut to at most n chars, at the end of a whole character as it's seen: an emoji is two chars or more (a family or a
     * flag several), an accented letter can be two. Cut inside one, the list showed a broken character (read back from
     * index.json, a "?").
     */
    static String cut(String t, int n) {
        if (t.length() <= n) return t;
        java.text.BreakIterator b = java.text.BreakIterator.getCharacterInstance(Locale.ROOT);
        b.setText(t.substring(0, Math.min(t.length(), n + 64)));     // (what's around the cut is enough: a text can be 1 MB)
        int end = b.isBoundary(n) ? n : b.preceding(n);
        // (one "character" longer than all of it, accents piled on one letter: cut there, but never inside an emoji's pair)
        if (end <= 0) end = Character.isHighSurrogate(t.charAt(n - 1)) ? n - 1 : n;
        return t.substring(0, end);
    }

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
