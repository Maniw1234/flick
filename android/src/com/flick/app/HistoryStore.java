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
import java.util.Collections;
import java.util.Comparator;
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
        order();
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
        if (n > 0) { order(); trim(); save(); }
        return n;
    }

    /** Removes the entry with this id; true if there was one. */
    synchronized boolean remove(String id) {
        if (id == null) return false;
        List<JSONObject> l = load();
        for (int i = 0; i < l.size(); i++) {
            if (id.equals(l.get(i).optString("id", null))) { l.remove(i); save(); return true; }
        }
        return false;
    }

    synchronized void clear() {
        load().clear();
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

    // newest first by time; entries added later win ties (they were put in front, and the sort keeps order)
    private void order() {
        Collections.sort(load(), new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                long x = a.optLong("time", 0), y = b.optLong("time", 0);
                return x == y ? 0 : (x > y ? -1 : 1);
            }
        });
    }

    private void trim() {
        List<JSONObject> l = load();
        while (l.size() > MAX) l.remove(l.size() - 1);
    }

    private ArrayList<JSONObject> load() {
        if (items != null) return items;
        items = new ArrayList<JSONObject>();
        if (!file.isFile()) return items;
        try {
            JSONArray a = new JSONArray(read(file));
            for (int i = 0; i < a.length() && items.size() < MAX; i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null) items.add(o);
            }
        } catch (Exception e) {
            // a damaged file (power cut while it was written by an older version): start over rather than fail forever
            items.clear();
        }
        return items;
    }

    private void save() {
        JSONArray a = new JSONArray();
        for (JSONObject o : load()) a.put(o);
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

    /** Writes text to f all at once: a new file renamed over the old one, so a crash never leaves half a file. */
    static void write(File f, String text) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("no folder");
        File tmp = new File(dir, f.getName() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(text.getBytes("UTF-8")); } finally { out.close(); }
        if (!tmp.renameTo(f)) {
            if (!f.delete() || !tmp.renameTo(f)) { tmp.delete(); throw new IOException("rename failed"); }
        }
    }
}
