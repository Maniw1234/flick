package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * The phone's transfer history: one JSON file in the app's files folder, newest first, at most MAX entries. Each entry
 * is {"id","dir":"in"|"out","name","size","time","pc","pcName","path"?,"libId"?,"kind"?,"how","ok"}; the page adds the
 * transfers it runs, background code (auto-send, tile, widget, sync) adds its own. No Android classes, so it runs on
 * any JVM.
 */
final class HistoryStore {
    static final int MAX = 300;
    static final int MAX_ENTRY = 8 * 1024;           // characters of one entry's JSON: anything bigger isn't a transfer

    private final File file;
    private ArrayList<JSONObject> items;             // newest first; loaded on first use
    private boolean unread;                          // the file is there but couldn't be read (see load)
    private boolean cleared;                         // cleared while unread: the file's entries go when it's read
    private final HashSet<String> gone = new HashSet<String>();     // ids removed while unread (the same)

    HistoryStore(File file) { this.file = file; }

    /** The whole history as a JSON array, newest first. */
    synchronized String json() {
        JSONArray a = new JSONArray();
        for (JSONObject o : load()) a.put(o);
        return a.toString();
    }

    synchronized int size() { return load().size(); }

    /** Adds one entry (id and time filled in when missing). Returns the entry as stored, or null if it isn't one. */
    synchronized JSONObject add(JSONObject e) {
        JSONObject o = clean(e);
        if (o == null) return null;
        load().add(0, o);
        trim();
        save();
        return o;
    }

    /** Adds what the page sends: one entry or a JSON array of them. Returns how many were added. */
    synchronized int addJson(String json) {
        if (json == null) return 0;
        String s = json.trim();
        List<JSONObject> in = new ArrayList<JSONObject>();
        try {
            if (s.startsWith("[")) {
                JSONArray a = new JSONArray(s);
                for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o != null) in.add(o); }
            } else if (s.startsWith("{")) {
                in.add(new JSONObject(s));
            }
        } catch (Exception e) { return 0; }
        int n = 0;
        for (JSONObject e : in) {
            JSONObject o = clean(e);
            if (o == null) continue;
            load().add(0, o);
            n++;
        }
        if (n > 0) { trim(); save(); }
        return n;
    }

    /** Removes the entry with this id; true if there was one. */
    synchronized boolean remove(String id) {
        if (id == null) return false;
        List<JSONObject> l = load();
        if (unread) gone.add(id);
        for (int i = 0; i < l.size(); i++) {
            if (id.equals(l.get(i).optString("id", null))) { l.remove(i); save(); return true; }
        }
        return false;
    }

    synchronized void clear() {
        load().clear();
        if (unread) { cleared = true; gone.clear(); }
        save();
    }

    // ------------------------------------------------------------
    private static JSONObject clean(JSONObject e) {
        if (e == null) return null;
        try {
            JSONObject o = new JSONObject(e.toString());
            String id = o.optString("id", "");
            if (id.length() == 0 || id.length() > 80) o.put("id", UUID.randomUUID().toString().replace("-", "").substring(0, 16));
            if (o.optLong("time", 0) <= 0) o.put("time", System.currentTimeMillis());
            String dir = o.optString("dir", "").toLowerCase(Locale.US);
            o.put("dir", "in".equals(dir) ? "in" : "out");
            if (!o.has("ok")) o.put("ok", true);
            if (o.toString().length() > MAX_ENTRY) return null;
            return o;
        } catch (Exception x) {
            return null;
        }
    }

    // Newest first is the order entries were added in, not their times: the phone's clock can be wrong (reset at a
    // restart before the network sets it, set by hand), and sorted by time a transfer made then went to the bottom, or
    // straight out of a full History; one stamped while the clock ran ahead stayed first for good.
    private void trim() {
        List<JSONObject> l = load();
        while (l.size() > MAX) l.remove(l.size() - 1);
    }

    // A file that couldn't be read (too many files open, a disk error) isn't a damaged one: taken as empty, the next
    // entry was saved alone over the whole history. It's read again on the next use and isn't written over until it has
    // been (entries added meanwhile go on top of it then). A Clear or a removed entry meanwhile isn't undone by it: the
    // file's entries (or those ids) go then, and the file is written.
    private ArrayList<JSONObject> load() {
        if (items != null && !unread) return items;
        if (items == null) items = new ArrayList<JSONObject>();
        if (!file.isFile()) { unread = false; return items; }
        String text;
        try { text = read(file); } catch (IOException e) { unread = true; return items; }
        ArrayList<JSONObject> got = new ArrayList<JSONObject>(items);
        try {
            JSONArray a = new JSONArray(text);
            for (int i = 0; i < a.length() && got.size() < MAX && !cleared; i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null && !gone.contains(o.optString("id", ""))) got.add(o);
            }
        } catch (Exception e) {
            // a damaged file (a power cut while it was being written, say): start over rather than fail forever
            got = new ArrayList<JSONObject>(items);
        }
        boolean changed = !items.isEmpty() || cleared || !gone.isEmpty();
        items = got;
        unread = false;
        cleared = false;
        gone.clear();
        if (changed) save();                             // (what was added, cleared or removed meanwhile)
        return items;
    }

    private void save() {
        List<JSONObject> l = load();
        if (unread) return;                              // (kept in memory: see load)
        JSONArray a = new JSONArray();
        for (JSONObject o : l) a.put(o);
        try { write(file, a.toString()); } catch (IOException e) { /* the history stays in memory */ }
    }

    static String read(File f) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        } finally { in.close(); }
    }

    /**
     * Writes text to f all at once: a new file, on the disk before it's renamed over the old one, so a crash or a power
     * cut leaves the old file or the new one, never half a file or an empty one (file systems may put the rename on
     * the disk before the data). History, pairings, sync records, auto-send's memory and the clipboard history use it.
     */
    static void write(File f, String text) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("no folder");
        File tmp = new File(dir, f.getName() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(text.getBytes("UTF-8"));
            out.getFD().sync();
        } finally { out.close(); }
        if (!tmp.renameTo(f)) {
            if (!f.delete() || !tmp.renameTo(f)) { tmp.delete(); throw new IOException("rename failed"); }
        }
    }
}
