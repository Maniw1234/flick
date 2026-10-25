package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Two-way sync of one phone folder with one PC folder. Files only; nothing is ever deleted on either side: a file
 * found on one side only is copied to the other (so a file deleted on one side comes back from the other). A file on
 * both sides that differs:
 *  - changed on one side only since the last sync: that side's version is copied over;
 *  - no record yet (first sync): the newer modification time wins;
 *  - changed on both sides: both versions are kept, on both sides. The newer one keeps the name; the older one is kept
 *    as "name (<PC name>).ext" when it is the PC's (the phone downloads it under that name and sends it back), or as
 *    "name (<phone name>).ext" when it is the phone's (the PC names it so when it refuses to replace a newer file;
 *    the phone renames its copy to match and downloads the PC's version under the plain name).
 * What both sides showed after the last sync is kept per pair in a JSON file (sizes and times as each side reports
 * them, so storage that can't set a file's time doesn't look like a change). Hidden files, ".flickpart" files and files
 * over 4 GB are skipped. No Android classes, so it runs on any JVM.
 */
final class SyncEngine {
    static final long MAX_SIZE = 4L * 1024 * 1024 * 1024;
    static final long TOL = 2000;                    // ms: FAT and exFAT keep times to 2 s
    static final int MAX_FILES = 20000;
    static final int MAX_DEPTH = 32;
    static final String PART = ".flickpart";

    static final class Entry {
        final long size, mtime;
        Entry(long size, long mtime) { this.size = size; this.mtime = mtime; }
        boolean same(Entry o) { return o != null && size == o.size && mtime == o.mtime; }
        @Override public String toString() { return size + "@" + mtime; }
    }

    /** The PC's side of one pair. */
    interface Remote {
        /** Every file in the PC folder: "/"-separated relative path -> size and mtime (ms). */
        Map<String, Entry> list() throws IOException;
        /** Writes the PC's file rel into dest (a new file). Returns its mtime on the PC, or -1 if not said. */
        long get(String rel, File dest) throws IOException;
        /**
         * Sends src as rel with this mtime. Returns where the PC stored it: rel, or another name when it kept both
         * because its own file isn't older than mtime.
         */
        String put(String rel, File src, long mtime) throws IOException;
    }

    /** A failure that ends the whole run (the PC went away, the run was stopped), not just one file. */
    static final class Fatal extends IOException {
        private static final long serialVersionUID = 1L;
        Fatal(String m, Throwable cause) { super(m, cause); }
    }

    interface Listener {
        void progress(int done, int total);
        /** A file is now on the phone (new, replaced or renamed): for the media index. gone: its old path, or null. */
        void received(String rel, File f, File gone);
        /** A phone file is now on the PC, as storedRel. */
        void sent(String rel, File f, String storedRel);
    }

    static final int UPLOAD = 1, DOWNLOAD = 2, KEEP_BOTH = 3, RECORD = 4;

    static final class Action {
        final int op;
        final String rel;
        final Entry local, remote;
        Action(int op, String rel, Entry local, Entry remote) { this.op = op; this.rel = rel; this.local = local; this.remote = remote; }
        @Override public String toString() { return (op == UPLOAD ? "up " : op == DOWNLOAD ? "down " : op == KEEP_BOTH ? "both " : "same ") + rel; }
    }

    static final class Result {
        int files;          // files both sides have, as far as the last run knows
        int moved;          // files copied (either way) this run
        int failed;         // files that couldn't be copied this run
        String why;         // the first of those failures
    }

    // ------------------------------------------------------------ deciding
    /** What to do for each file, given both listings and what both sides showed after the last sync. */
    static List<Action> plan(Map<String, Entry> local, Map<String, Entry> remote, Map<String, long[]> state) {
        TreeSet<String> all = new TreeSet<String>(local.keySet());
        all.addAll(remote.keySet());
        List<Action> out = new ArrayList<Action>();
        for (String rel : all) {
            if (skip(rel)) continue;
            Entry l = local.get(rel), r = remote.get(rel);
            if ((l != null && l.size > MAX_SIZE) || (r != null && r.size > MAX_SIZE)) continue;
            long[] s = state.get(rel);
            int op;
            if (r == null) op = UPLOAD;
            else if (l == null) op = DOWNLOAD;
            else if (same(l, r)) op = RECORD;
            else if (s == null || s.length < 4) {
                // never synced: the newer one wins (too close to tell: keep both)
                if (l.mtime > r.mtime + TOL) op = UPLOAD;
                else if (r.mtime > l.mtime + TOL) op = DOWNLOAD;
                else op = KEEP_BOTH;
            } else {
                boolean lc = l.size != s[0] || l.mtime != s[1];
                boolean rc = r.size != s[2] || r.mtime != s[3];
                if (!lc && !rc) op = RECORD;          // unchanged since the last sync (a time that couldn't be set)
                else if (!rc) op = UPLOAD;
                else if (!lc) op = DOWNLOAD;
                else op = KEEP_BOTH;
            }
            out.add(new Action(op, rel, l, r));
        }
        return out;
    }

    static boolean same(Entry a, Entry b) { return a.size == b.size && Math.abs(a.mtime - b.mtime) <= TOL; }

    /** Paths never synced: hidden files and folders, files still arriving, and anything that isn't a plain relative path. */
    static boolean skip(String rel) {
        if (rel == null || rel.length() == 0 || rel.length() > 4096) return true;
        if (rel.indexOf('\\') >= 0 || rel.indexOf('\0') >= 0 || rel.startsWith("/")) return true;
        if (rel.toLowerCase(Locale.US).endsWith(PART)) return true;
        for (String seg : rel.split("/", -1)) {
            if (seg.length() == 0 || seg.startsWith(".")) return true;    // also "." and ".."
        }
        return false;
    }

    // ------------------------------------------------------------ the phone's side
    /** Every file under root (hidden ones and part files left out), by "/"-separated path. */
    static Map<String, Entry> listLocal(File root) throws IOException {
        if (!root.isDirectory()) throw new Fatal("folder missing", null);
        String canon = root.getCanonicalPath();
        Map<String, Entry> out = new HashMap<String, Entry>();
        if (root.listFiles() == null) throw new Fatal("can't read the folder", null);
        walk(root, "", canon, 0, out);
        return out;
    }

    private static void walk(File dir, String prefix, String rootCanon, int depth, Map<String, Entry> out) throws IOException {
        if (depth > MAX_DEPTH || out.size() >= MAX_FILES) return;
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (out.size() >= MAX_FILES) return;
            String n = k.getName();
            if (n.startsWith(".") || n.toLowerCase(Locale.US).endsWith(PART)) continue;
            String rel = prefix + n;
            if (k.isDirectory()) {
                // a link that leads out of the folder isn't followed
                if (!k.getCanonicalPath().startsWith(rootCanon + "/")) continue;
                walk(k, rel + "/", rootCanon, depth + 1, out);
            } else if (k.isFile()) {
                long size = k.length();
                if (size > MAX_SIZE) continue;
                out.put(rel, new Entry(size, k.lastModified()));
            }
        }
    }

    /** root/rel, refusing anything that would land outside root. */
    static File file(File root, String rel) throws IOException {
        if (skip(rel)) throw new IOException("bad path");
        File f = new File(root, rel);
        String c = f.getCanonicalPath(), r = root.getCanonicalPath();
        if (!c.startsWith(r + "/")) throw new IOException("outside the folder");
        return f;
    }

    private static Entry stat(File f) { return new Entry(f.length(), f.lastModified()); }

    // ------------------------------------------------------------ running
    private final File root;
    private final Remote remote;
    private final File stateFile;
    private final String pcLabel;
    private final Listener listener;
    private final AtomicBoolean stop;
    private Map<String, Entry> localList, remoteList;
    private Map<String, long[]> state;
    private final Set<String> touched = new HashSet<String>();

    /** pcName: the PC's name, for "name (<PC name>).ext". */
    SyncEngine(File root, Remote remote, File stateFile, String pcName, Listener listener, AtomicBoolean stop) {
        this.root = root;
        this.remote = remote;
        this.stateFile = stateFile;
        this.pcLabel = label(pcName);
        this.listener = listener;
        this.stop = stop;
    }

    Result run() throws IOException {
        localList = listLocal(root);
        remoteList = remote.list();
        state = loadState(stateFile);
        List<Action> acts = plan(localList, remoteList, state);
        int total = 0;
        for (Action a : acts) if (a.op != RECORD) total++;
        Result res = new Result();
        int done = 0;
        long saved = System.nanoTime();
        listener.progress(0, total);
        try {
            for (Action a : acts) {
                if (stop != null && stop.get()) throw new Fatal("stopped", null);
                if (a.op == RECORD) { record(a.rel, a.local, a.remote); continue; }
                try {
                    if (a.op == UPLOAD) upload(a.rel, a.local, a.remote);
                    else if (a.op == DOWNLOAD) download(a.rel, a.local, a.remote);
                    else keepBoth(a.rel, a.local, a.remote);
                    res.moved++;
                } catch (Fatal f) {
                    throw f;
                } catch (IOException e) {
                    res.failed++;
                    if (res.why == null) res.why = a.rel + ": " + e.getMessage();
                }
                listener.progress(++done, total);
                if (System.nanoTime() - saved > 5000000000L) { saveState(stateFile, state); saved = System.nanoTime(); }
            }
        } finally {
            // records of files gone from both sides are dropped; everything else is kept for the next run
            Iterator<String> it = state.keySet().iterator();
            while (it.hasNext()) {
                String k = it.next();
                if (!localList.containsKey(k) && !remoteList.containsKey(k) && !touched.contains(k)) it.remove();
            }
            saveState(stateFile, state);
        }
        res.files = state.size();
        return res;
    }

    private void record(String rel, Entry l, Entry r) {
        state.put(rel, new long[]{l.size, l.mtime, r.size, r.mtime});
        touched.add(rel);
    }

    /** The phone's rel to the PC (replacing the PC's, unless the PC keeps its own because it's newer). */
    private void upload(String rel, Entry l, Entry r) throws IOException {
        File f = file(root, rel);
        if (!f.isFile()) throw new IOException("gone");
        Entry now = stat(f);
        String stored = put(rel, f, now.mtime);
        if (stored.equals(rel)) record(rel, now, new Entry(now.size, now.mtime));
        else keptBoth(rel, now, stored);
    }

    /** The PC's rel to the phone (replacing the phone's l, if it's still what the listing showed). */
    private void download(String rel, Entry l, Entry r) throws IOException {
        Entry got = fetch(rel, rel, l, r);
        File f = file(root, rel);
        record(rel, stat(f), got);
    }

    private void keepBoth(String rel, Entry l, Entry r) throws IOException {
        File f = file(root, rel);
        if (!f.isFile()) throw new IOException("gone");
        Entry now = stat(f);
        if (now.mtime > r.mtime) {
            // the phone's version is newer: it keeps the name on both sides; the PC's comes down as "name (<PC>).ext"
            // first (so it's safe before the PC replaces it), then goes back up under that name
            String alt = freeName(rel, pcLabel);
            fetch(rel, alt, null, r);
            File altF = file(root, alt);
            Entry altL = stat(altF);
            String stored = put(rel, f, now.mtime);
            if (stored.equals(rel)) record(rel, now, new Entry(now.size, now.mtime));
            else keptBoth(rel, now, stored);                 // the PC's file changed again meanwhile
            String altStored = put(alt, altF, altL.mtime);
            if (altStored.equals(alt)) record(alt, altL, new Entry(altL.size, altL.mtime));
        } else {
            // the PC's version is newer (or as new): the PC keeps it and stores the phone's as "name (<phone>).ext"
            // (a time just under the PC's makes sure it never replaces it)
            String stored = put(rel, f, Math.min(now.mtime, r.mtime - 1));
            if (stored.equals(rel)) record(rel, now, new Entry(now.size, Math.min(now.mtime, r.mtime - 1)));
            else keptBoth(rel, now, stored);
        }
    }

    /**
     * The PC kept its own file at rel and stored the phone's as stored: the phone's copy takes that name too, and the
     * PC's file comes down under rel. If the phone can't rename it, rel is left unrecorded: the next run sees two
     * versions with no record, the newer (the PC's) wins at rel, and the phone's comes back from the PC as stored.
     */
    private void keptBoth(String rel, Entry l, String stored) throws IOException {
        File f = file(root, rel);
        File to;
        try { to = file(root, stored); } catch (IOException e) { to = null; }
        touched.add(stored);
        if (to == null || to.exists() || !mkdirsFor(to) || !f.renameTo(to)) {
            state.remove(rel);
            return;
        }
        Entry moved = stat(to);
        record(stored, moved, new Entry(l.size, l.mtime));
        listener.received(stored, to, f);
        state.remove(rel);
        Entry got = fetch(rel, rel, null, remoteList.get(rel));
        record(rel, stat(f), got);
    }

    /**
     * The PC's remoteRel into the phone's localRel, through a hidden part file next to it. expect: what the phone's
     * file showed in the listing (null: there must be no file there): if it changed meanwhile, it's left alone.
     * Returns the PC's side as received (size, mtime).
     */
    private Entry fetch(String remoteRel, String localRel, Entry expect, Entry listed) throws IOException {
        File dest = file(root, localRel);
        if (!mkdirsFor(dest)) throw new IOException("can't make the folder");
        File part = new File(dest.getParentFile(), "." + dest.getName() + PART);
        try {
            long mt = remote.get(remoteRel, part);
            if (mt <= 0 && listed != null) mt = listed.mtime;
            long size = part.length();
            boolean untouched = expect == null ? !dest.exists() : dest.isFile() && stat(dest).same(expect);
            if (!untouched) throw new IOException("changed on the phone meanwhile");
            if (!part.renameTo(dest)) throw new IOException("can't write " + dest.getName());
            if (mt > 0) dest.setLastModified(mt);            // some storage can't: the record keeps what the phone shows
            touched.add(localRel);
            listener.received(localRel, dest, null);
            return new Entry(size, mt > 0 ? mt : (listed != null ? listed.mtime : 0));
        } finally {
            if (part.exists()) part.delete();
        }
    }

    private String put(String rel, File f, long mtime) throws IOException {
        String stored = remote.put(rel, f, mtime);
        if (stored == null || stored.length() == 0) stored = rel;
        touched.add(stored);
        listener.sent(rel, f, stored);
        return stored;
    }

    private static boolean mkdirsFor(File f) {
        File d = f.getParentFile();
        return d != null && (d.isDirectory() || d.mkdirs());
    }

    /** "dir/name (label).ext" that neither side has yet ("name (label) (2).ext" and on if needed). */
    String freeName(String rel, String label) {
        int slash = rel.lastIndexOf('/');
        String dir = slash >= 0 ? rel.substring(0, slash + 1) : "";
        String name = rel.substring(slash + 1);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            String cand = dir + base + " (" + label + ")" + (i > 1 ? " (" + i + ")" : "") + ext;
            if (localList.containsKey(cand) || remoteList.containsKey(cand) || touched.contains(cand)) continue;
            try { if (file(root, cand).exists()) continue; } catch (IOException e) { continue; }
            return cand;
        }
        return dir + base + " (" + label + " " + System.currentTimeMillis() + ")" + ext;
    }

    /** A name as it can appear in a file name. */
    static String label(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_").trim();
        while (s.startsWith(".")) s = s.substring(1);
        if (s.length() > 40) s = s.substring(0, 40).trim();
        return s.length() == 0 ? "PC" : s;
    }

    // ------------------------------------------------------------ the record of the last sync
    static Map<String, long[]> loadState(File f) {
        Map<String, long[]> m = new HashMap<String, long[]>();
        if (f == null || !f.isFile()) return m;
        try {
            JSONObject o = new JSONObject(HistoryStore.read(f));
            JSONObject files = o.optJSONObject("f");
            if (files == null) return m;
            Iterator<String> it = files.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONArray a = files.optJSONArray(k);
                if (a == null || a.length() < 4) continue;
                m.put(k, new long[]{a.optLong(0), a.optLong(1), a.optLong(2), a.optLong(3)});
            }
        } catch (Exception e) { /* a damaged record: everything counts as never synced (newer wins) */ }
        return m;
    }

    static void saveState(File f, Map<String, long[]> m) throws IOException {
        if (f == null) return;
        JSONObject files = new JSONObject();
        try {
            for (Map.Entry<String, long[]> e : m.entrySet()) {
                long[] v = e.getValue();
                JSONArray a = new JSONArray();
                for (long x : v) a.put(x);
                files.put(e.getKey(), a);
            }
            JSONObject o = new JSONObject();
            o.put("v", 1);
            o.put("f", files);
            HistoryStore.write(f, o.toString());
        } catch (org.json.JSONException e) { throw new IOException(e.getMessage()); }
    }
}
