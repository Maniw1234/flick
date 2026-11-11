package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.UUID;

/**
 * The phone's synced folders: one JSON file, a record per pair as syncPairs() shows it
 * ({"id","pc","pcName","path","name","pair","last","state","why"?,"files","folder"?}). "pair" is the PC's id for the
 * pair ("" until the PC made it); "state" is idle / running / error. No Android classes, so it runs on any JVM.
 */
final class SyncPairs {
    private final File file;
    private ArrayList<JSONObject> pairs;
    private boolean unread;                              // the file is there but couldn't be read (see load)
    private final HashSet<String> gone = new HashSet<String>();         // ids removed while unread
    private final HashMap<String, String> same = new HashMap<String, String>();   // made while unread -> the file's pair

    SyncPairs(File file) { this.file = file; }

    synchronized JSONArray list() {
        JSONArray a = new JSONArray();
        for (JSONObject p : load()) a.put(copy(p));
        return a;
    }

    synchronized JSONObject get(String id) {
        id = real(id);
        for (JSONObject p : load()) if (p.optString("id", "").equals(id)) return copy(p);
        return null;
    }

    /** The pair of this phone folder with this PC, if there is one. */
    synchronized JSONObject find(String pc, String path) {
        for (JSONObject p : load()) if (p.optString("pc", "").equals(pc) && p.optString("path", "").equals(path)) return copy(p);
        return null;
    }

    /** A new pair (not made on the PC yet). name: the folder's name, which the PC names its folder after. */
    synchronized JSONObject create(String pc, String pcName, String path, String name) {
        JSONObject p = new JSONObject();
        try {
            p.put("id", UUID.randomUUID().toString().replace("-", "").substring(0, 12));
            p.put("pc", pc);
            p.put("pcName", pcName);
            p.put("path", path);
            p.put("name", freeName(pc, path, name));
            p.put("pair", "");
            p.put("last", 0L);
            p.put("state", "idle");
            p.put("files", 0);
        } catch (Exception e) { /* can't fail */ }
        load().add(p);
        save();
        return copy(p);
    }

    /** Sets fields of the pair id (a null value removes the field). False if there's no such pair (any more). */
    synchronized boolean update(String id, Object... kv) {
        id = real(id);
        for (JSONObject p : load()) {
            if (!p.optString("id", "").equals(id)) continue;
            try {
                for (int i = 0; i + 1 < kv.length; i += 2) {
                    String k = String.valueOf(kv[i]);
                    if (kv[i + 1] == null) p.remove(k); else p.put(k, kv[i + 1]);
                }
            } catch (Exception e) { /* bad value: skipped */ }
            save();
            return true;
        }
        return false;
    }

    synchronized boolean remove(String id) {
        id = real(id);
        ArrayList<JSONObject> l = load();
        if (unread) gone.add(id);
        for (int i = 0; i < l.size(); i++) {
            if (l.get(i).optString("id", "").equals(id)) { l.remove(i); save(); return true; }
        }
        return false;
    }

    synchronized int size() { return load().size(); }

    /** The pair an id stands for: one made while the file couldn't be read is the file's pair of that folder. */
    private String real(String id) {
        load();
        String r = same.get(id);
        return r != null ? r : id;
    }

    /**
     * The name a new pair goes by on the PC. The PC takes one name of this phone's as one folder (asked again, it's
     * "the same folder"), so a second folder of the same name synced with that PC (DCIM's and Pictures' Screenshots)
     * was given the first one's folder there, and the two filled each other up. It gets its parent's name too.
     */
    String freeName(String pc, String path, String name) {
        String n = name == null || name.trim().length() == 0 ? "Phone" : name;
        if (!taken(pc, n)) return n;
        File parent = new File(path).getParentFile();
        String q = parent == null || parent.getName().length() == 0 ? "phone" : parent.getName();
        q = fit(q, 30, 60).trim();
        if (q.length() == 0) q = "phone";
        String alt = withTail(n, " (" + q + ")");
        for (int i = 2; taken(pc, alt); i++) alt = withTail(n, " (" + q + " " + i + ")");
        return alt;
    }

    /**
     * name, cut so that with tail it stays one folder name on the PC: at most 100 characters (the PC cuts there: the tail
     * would go, and the name be the first one's again) and 255 bytes (a long Chinese name is over a disk's limit).
     */
    static String withTail(String name, String tail) {
        String b = fit(name, 100 - tail.length(), 255 - SyncEngine.utf8(tail)).replaceAll("[. ]+$", "");
        return (b.trim().length() == 0 ? "Phone" : b) + tail;
    }

    /** The longest start of s, in whole characters (never half of an emoji), of at most units chars and bytes UTF-8 bytes. */
    static String fit(String s, int units, int bytes) {
        int i = 0, b = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i), n = Character.charCount(cp);
            int cb = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            if (i + n > units || b + cb > bytes) break;
            i += n; b += cb;
        }
        return s.substring(0, i);
    }

    /** A pair with this PC goes by a name the PC can't tell from this one. */
    private boolean taken(String pc, String name) {
        String k = asOnPc(name);
        for (JSONObject p : load()) if (p.optString("pc", "").equals(pc) && asOnPc(p.optString("name", "")).equals(k)) return true;
        return false;
    }

    /** A name as the PC makes a folder name of it (pc/sync.js cleanName), in lower case: Windows ignores case. */
    static String asOnPc(String n) {
        String s = (n == null ? "" : n).replaceAll("[<>:\"/\\\\|?*\\u0000-\\u001f\\u007f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "_")
                .replaceAll("[. ]+$", "").trim();
        if (s.length() > 100) s = s.substring(0, 100).replaceAll("[. ]+$", "");
        return s.toLowerCase(Locale.ROOT);
    }

    /**
     * The list, read from the file on first use. A file that couldn't be read (too many files open, a disk error) isn't
     * a damaged one: taken as empty, the next change saved only itself over every synced folder. The list is read again
     * on the next use, and the file isn't written over until it has been (pairs made meanwhile are kept, after it). A
     * folder added meanwhile that the file has with that PC already (the page showed none: the user added it again) is
     * the file's pair: one made anew got a name of its own (see split), a second folder on the PC, and both synced. Its
     * id goes on standing for the file's pair (see real), whose sync record is under its own id.
     */
    private ArrayList<JSONObject> load() {
        if (pairs != null && !unread) return pairs;
        if (pairs == null) pairs = new ArrayList<JSONObject>();
        if (!file.isFile()) { unread = false; return pairs; }
        String text;
        try { text = HistoryStore.read(file); } catch (IOException e) { unread = true; return pairs; }
        ArrayList<JSONObject> got = new ArrayList<JSONObject>();
        try {
            JSONArray a = new JSONArray(text);
            for (int i = 0; i < a.length(); i++) {
                JSONObject p = a.optJSONObject(i);
                if (p == null || p.optString("id", "").length() == 0 || gone.contains(p.optString("id", ""))) continue;
                // nothing runs yet when the list is first read: a "running" left by a killed app is over
                if ("running".equals(p.optString("state", ""))) p.put("state", "idle");
                got.add(p);
            }
        } catch (Exception e) { got.clear(); /* damaged: no pairs (the PC keeps its folders) */ }
        boolean added = !pairs.isEmpty() || !gone.isEmpty();       // (pairs made or removed meanwhile)
        int read = got.size();
        for (JSONObject p : pairs) {
            JSONObject q = null;
            for (int i = 0; i < read && q == null; i++) {
                JSONObject o = got.get(i);
                if (o.optString("pc", "").equals(p.optString("pc", "")) && o.optString("path", "").equals(p.optString("path", ""))) q = o;
            }
            if (q == null) { got.add(p); continue; }
            same.put(p.optString("id", ""), q.optString("id", ""));
            // (paired on the PC meanwhile and the file's isn't: the PC's pair is kept)
            try {
                if (q.optString("pair", "").length() == 0 && p.optString("pair", "").length() > 0) {
                    q.put("pair", p.optString("pair", ""));
                    q.put("name", p.optString("name", ""));
                    if (p.has("folder")) q.put("folder", p.optString("folder", ""));
                }
            } catch (Exception e) { /* can't fail */ }
        }
        pairs = got;
        unread = false;
        gone.clear();
        if (split() || added) save();
        return pairs;
    }

    /**
     * 2.0.0 named a pair after its folder alone, and the PC gives a phone's folder name one pair: two phone folders of
     * one name synced with one PC (DCIM's and Pictures' Screenshots) got one pair there, and each run copied one
     * folder's files into the other. The first keeps it; the other gets a name of its own (see freeName) and is paired
     * anew at its next run, with a folder of its own on the PC. (Files already copied across stay where they are.)
     */
    private boolean split() {
        boolean changed = false;
        for (int i = 1; i < pairs.size(); i++) {
            JSONObject p = pairs.get(i);
            String pc = p.optString("pc", ""), pair = p.optString("pair", ""), k = asOnPc(p.optString("name", ""));
            for (int j = 0; j < i; j++) {
                JSONObject q = pairs.get(j);
                if (!q.optString("pc", "").equals(pc)) continue;
                if ((pair.length() == 0 || !pair.equals(q.optString("pair", ""))) && !asOnPc(q.optString("name", "")).equals(k)) continue;
                try {
                    p.put("name", freeName(pc, p.optString("path", ""), p.optString("name", "")));
                    p.put("pair", "");
                    p.remove("folder");
                } catch (Exception e) { /* can't fail */ }
                changed = true;
                break;
            }
        }
        return changed;
    }

    private void save() {
        ArrayList<JSONObject> l = load();
        if (unread) return;                              // (kept in memory: the file's list isn't known, see load)
        JSONArray a = new JSONArray();
        for (JSONObject p : l) a.put(p);
        try { HistoryStore.write(file, a.toString()); } catch (IOException e) { /* kept in memory */ }
    }

    private static JSONObject copy(JSONObject p) {
        try { return new JSONObject(p.toString()); } catch (Exception e) { return new JSONObject(); }
    }
}
