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
import java.util.regex.Pattern;

/**
 * Two-way sync of one phone folder with one PC folder. Files only; nothing is ever deleted on either side: a file
 * found on one side only is copied to the other (so a file deleted on one side comes back from the other). A file on
 * both sides that differs:
 *  - changed on one side only since the last sync: that side's version is copied over;
 *  - no record yet (first sync), or changed on both sides: nothing says which may replace the other, so both versions
 *    are kept, on both sides (see keepBoth). The newer one keeps the name; the other is kept as "name (from <PC
 *    name>).ext" when it is the PC's, or "name (from <phone name>).ext" when it is the phone's. The same content under
 *    other times (put on both sides by hand, or a record lost with the app's data) is only matched.
 *    (The PC itself names a file "name (<phone name>).ext" when it refuses to replace a newer one: see keptBoth.)
 * What both sides showed after the last sync is kept per pair in a JSON file (sizes and times as each side reports
 * them, so storage that can't set a file's time doesn't look like a change). Hidden files, ".flickpart" files and files
 * over 4 GB are skipped. A file a download from the PC is arriving as (Download/Flick may be synced) is left for the
 * next run. No Android classes, so it runs on any JVM.
 */
final class SyncEngine {
    static final long MAX_SIZE = 4L * 1024 * 1024 * 1024;
    static final long TOL = 2000;                    // ms: FAT and exFAT keep times to 2 s
    static final int MAX_FILES = 20000;
    static final int MAX_DEPTH = 32;
    static final String PART = ".flickpart";
    // the sync's own part files: a name of their own, so a download arriving as the same name (Files.partOf) never
    // shares one with a sync run (the run wrote over it, and a file made of half of each went to the PC)
    static final String SYNC_PART = ".flicksync";
    static final long STALE_PART = 24L * 60 * 60 * 1000;
    // Names in a folder are claimed and put in place under this one lock, by downloads from the PC (Files.reserve,
    // Incoming.finish, moveIn) and by sync runs: a file is never put where another writer is putting one
    static final Object NAMES = new Object();
    // the files downloads from the PC are arriving as now (Files.reserve adds, Incoming.finish/cancel take away; guarded
    // by NAMES). Kept here, not read from the part files: a ".flickpart" next to a synced file may be one 2.0.0's sync
    // or a killed download left, and taken as a claim it kept that file away from the phone for good
    private static final Set<String> CLAIMED = new HashSet<String>();

    /** A download from the PC is arriving as dest from now on (call under NAMES). */
    static void claim(File dest) { CLAIMED.add(key(dest)); }

    /** ...and isn't any more: complete, failed or canceled (call under NAMES). */
    static void unclaim(File dest) { CLAIMED.remove(key(dest)); }

    // (one file under two paths, /sdcard and /storage/emulated/0, is one claim)
    private static String key(File f) {
        try { return f.getCanonicalPath(); } catch (IOException e) { return f.getAbsolutePath(); }
    }

    /** A file a file of the PC's is never put at for now: a download arriving there has claimed its name (CLAIMED). */
    static final class Busy extends IOException {
        private static final long serialVersionUID = 1L;
        Busy() { super("a file of that name is arriving"); }
    }

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

    /** A Remote that tells whether the PC answered the last put with "same": it had that file already, nothing stored. */
    interface SaysSame {
        boolean saidSame();
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

    static final int UPLOAD = 1, DOWNLOAD = 2, KEEP_BOTH = 3, RECORD = 4, CLASH = 5;

    static final class Action {
        final int op;
        final String rel;                // the phone's name (its record's)
        final String remoteRel;          // the PC's: rel, or rel in other capitals (one file on Windows and macOS)
        final Entry local, remote;
        Action(int op, String rel, Entry local, Entry remote) { this(op, rel, rel, local, remote); }
        Action(int op, String rel, String remoteRel, Entry local, Entry remote) {
            this.op = op; this.rel = rel; this.remoteRel = remoteRel; this.local = local; this.remote = remote;
        }
        @Override public String toString() {
            return (op == UPLOAD ? "up " : op == DOWNLOAD ? "down " : op == KEEP_BOTH ? "both " : op == CLASH ? "clash " : "same ") + rel
                    + (remoteRel.equals(rel) ? "" : " ~ " + remoteRel);
        }
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
        return plan(local, remote, state, remote.size() < MAX_FILES);
    }

    /**
     * The same; remoteAll: the PC listed all its files. A PC lists MAX_FILES at most (pc/sync.js), so a folder with more
     * shows only some: a phone file it didn't list that was synced and hasn't changed since is there still, and isn't
     * sent again (on every run).
     */
    static List<Action> plan(Map<String, Entry> local, Map<String, Entry> remote, Map<String, long[]> state, boolean remoteAll) {
        TreeSet<String> all = new TreeSet<String>(local.keySet());
        all.addAll(remote.keySet());
        // Names that differ only in capitals are one file on Windows and macOS, and in the phone's shared storage: a
        // phone file and a PC file named so are one pair, under the phone's name (the PC's is used there). Taken as two,
        // the phone's went up as a new file and replaced the PC's (another photo, lost), and the PC's never came down.
        // So are a name's two Unicode spellings: a Mac lists "Café" decomposed (e + an accent), the phone writes it
        // composed (é); taken as two, each run sent the phone's up and fetched the Mac's down as a second "Café".
        Map<String, String> localCase = new HashMap<String, String>(), remoteCase = new HashMap<String, String>();
        for (String k : local.keySet()) localCase.put(fold(k), k);
        for (String k : remote.keySet()) remoteCase.put(fold(k), k);
        List<Action> out = new ArrayList<Action>();
        for (String rel : all) {
            if (skip(rel)) continue;
            Entry l = local.get(rel), r = remote.get(rel);
            String rRel = rel;
            if (l == null || r == null) {
                String twin = (l == null ? localCase : remoteCase).get(fold(rel));
                if (twin != null && !twin.equals(rel)) {
                    if (l == null && !remote.containsKey(twin)) {
                        if (rel.equals(remoteCase.get(fold(rel)))) continue;               // (paired with the phone's)
                        // a second spelling of it on the PC (a Linux one's): the phone's pairs with one, and can't hold
                        // this one too (it was left out without a word)
                        out.add(new Action(CLASH, rel, l, r));
                        continue;
                    }
                    if (l != null && !local.containsKey(twin)) { r = remote.get(twin); rRel = twin; }
                    // both spellings on one side (a Linux PC, a phone's own folder): the other side can't hold both
                    else { out.add(new Action(CLASH, rel, l, r)); continue; }
                }
            }
            if ((l != null && l.size > MAX_SIZE) || (r != null && r.size > MAX_SIZE)) continue;
            long[] s = state.get(rel);
            int op;
            if (r == null && !remoteAll && s != null && s.length >= 4 && l.size == s[0] && l.mtime == s[1]) continue;
            if (r == null) op = UPLOAD;
            else if (l == null) op = DOWNLOAD;
            // never synced: neither may replace the other (the newer one did, and the other was lost: two cameras'
            // IMG_0001.jpg, say). Same size and time isn't the same content either (a config file saved on both, a
            // camera's numbering): keepBoth compares the bytes, and only matches them when they're the same. Except a
            // time to the very millisecond, not a whole second: one side's file is the other's copied with its time
            // kept (an earlier sync's, its record lost with the app's data), not fetched whole to be compared (a
            // DCIM folder of 20 GB was fetched whole once more)
            else if (s == null || s.length < 4) op = copied(l, r) ? RECORD : KEEP_BOTH;
            else {
                boolean lc = l.size != s[0] || l.mtime != s[1];
                // (a time the phone sent, stored by the PC to its disk's step: FAT's 2 s, exFAT's 10 ms, a Mac's 1 s,
                // a network share's. Not a change: the files sent were fetched back once, the phone's times rewritten)
                boolean rc = r.size != s[2] || (r.mtime != s[3] && !(s.length > 4 && s[4] == SENT && Math.abs(r.mtime - s[3]) < TOL));
                if (!lc && !rc) op = RECORD;          // unchanged since the last sync (a time that couldn't be set)
                // (one side changed and now matches the other by size and time: not taken as the same file without
                // its bytes, an edit of the same size within 2 s of the last sync, a clock behind, was never sent. The
                // copy compares them: the PC answers "same" when they are, and fetched, the PC's simply replaces it)
                else if (!rc) op = UPLOAD;
                else if (!lc) op = DOWNLOAD;
                else op = KEEP_BOTH;                  // changed on both sides (compared first when of one size)
            }
            out.add(new Action(op, rel, rRel, l, r));
        }
        return out;
    }

    /** rel as one file on Windows, macOS and the phone's storage: composed (NFC) and in lower case. */
    static String fold(String rel) {
        String n = java.text.Normalizer.isNormalized(rel, java.text.Normalizer.Form.NFC) ? rel : java.text.Normalizer.normalize(rel, java.text.Normalizer.Form.NFC);
        return n.toLowerCase(Locale.ROOT);
    }

    static boolean same(Entry a, Entry b) { return a.size == b.size && Math.abs(a.mtime - b.mtime) <= TOL; }

    /** Never synced, and one side's file is the other's copied with its time kept: same size, same time to the ms. */
    static boolean copied(Entry a, Entry b) { return a.size == b.size && a.mtime == b.mtime && a.mtime % 1000 != 0; }

    // a record's PC side is the time the phone sent with the file, not one the PC listed (see plan)
    static final long SENT = 1;

    /** Why one file didn't sync, in plain words: the PC's answers ("refused: no space") said as the user would. */
    static String words(IOException e) {
        if (!(e instanceof PcClient.Failure)) return String.valueOf(e.getMessage());
        PcClient.Failure f = (PcClient.Failure) e;
        String m = String.valueOf(f.getMessage());
        if (f.is(PcClient.Failure.DENIED)) return "the PC doesn't know this phone any more";
        if (f.is(PcClient.Failure.LOCAL)) return "it couldn't be read";
        if (f.code == 507 || m.endsWith("no space")) return "the PC is out of space";
        if (m.endsWith("busy")) return "another program on the PC has it open";
        if (m.endsWith("conflict")) return "a folder on the PC has that name";
        if (m.endsWith("bad path") || m.endsWith("bad name")) return "the PC can't take its name";
        if (m.endsWith("missing")) return "it isn't on the PC any more";
        if (m.endsWith("answer too long")) return "the PC's answer was too long for the phone";
        return "the PC couldn't take it";
    }

    // What the PC's listing leaves out (pc/sync.js SKIP_NAME, SKIP_EXT; files and folders): Windows' own files, and files
    // other programs are still writing. Sent, they'd never be listed back, and would go again on every run.
    private static final Pattern PC_SKIP = Pattern.compile("desktop\\.ini|thumbs\\.db|ehthumbs(_vista)?\\.db|\\$recycle\\.bin|system volume information|~\\$.*"
            + "|.*\\.(tmp|temp|flickpart|part|partial|crdownload|download)", Pattern.CASE_INSENSITIVE);
    // What the PC can't store (pc/sync.js relParts: Windows' rules, on every PC): such a file fails on its own, said,
    // without being sent (the PC refused it before the bytes were in, and the run ended as if it were out of reach)
    private static final Pattern PC_BAD = Pattern.compile("[<>:\"|?*\\\\]");
    private static final Pattern PC_HIDDEN = Pattern.compile("[\\u0000-\\u001f\\u007f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]");
    private static final Pattern PC_RESERVED = Pattern.compile("(con|prn|aux|nul|com[0-9\\u00b9\\u00b2\\u00b3]|lpt[0-9\\u00b9\\u00b2\\u00b3]|conin\\$|conout\\$)( *\\..*)?",
            Pattern.CASE_INSENSITIVE);
    static final int MAX_REL = 1024;

    /** Paths never synced: hidden files and folders, files still arriving, and anything that isn't a plain relative path. */
    static boolean skip(String rel) {
        if (rel == null || rel.length() == 0 || rel.length() > 4096) return true;
        if (rel.indexOf('\\') >= 0 || rel.indexOf('\0') >= 0 || rel.startsWith("/")) return true;
        if (rel.toLowerCase(Locale.US).endsWith(PART)) return true;
        for (String seg : rel.split("/", -1)) {
            if (seg.length() == 0 || seg.startsWith(".")) return true;    // also "." and ".."
            if (PC_SKIP.matcher(seg).matches()) return true;
        }
        return false;
    }

    /** Why the PC can't store a file at rel (words for the user), or null when it can. */
    static String unfit(String rel) {
        if (rel.length() > MAX_REL) return "its name is too long for the PC";
        for (String seg : rel.split("/", -1)) {
            if (seg.length() > 255) return "its name is too long for the PC";
            if (PC_HIDDEN.matcher(seg).find()) return "its name has an invisible character the PC doesn't take";
            if (PC_BAD.matcher(seg).find()) return "Windows doesn't take : * ? \" < > | in names";
            if (seg.endsWith(".") || seg.endsWith(" ")) return "Windows doesn't take a name ending in a dot or a space";
            if (PC_RESERVED.matcher(seg).matches()) return "Windows keeps the name \"" + seg + "\" for itself";
        }
        return null;
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
            // (a part file of a run cut off by a kill, of 2.0.0's sync (".flickpart") or of a killed download: nothing
            // writes it a day on, and no download is arriving as its file now)
            if (n.startsWith(".") && k.isFile() && System.currentTimeMillis() - k.lastModified() > STALE_PART) {
                if (n.endsWith(SYNC_PART)) k.delete();
                else if (n.endsWith(PART) && n.length() > 1 + PART.length()) {
                    File of = new File(dir, n.substring(1, n.length() - PART.length()));
                    synchronized (NAMES) { if (!claimed(of)) k.delete(); }
                }
            }
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

    /** root/rel is on the phone (a file the listing may have left out). */
    private boolean here(String rel) {
        try { return file(root, rel).exists(); } catch (IOException e) { return false; }
    }

    // ------------------------------------------------------------ running
    private final File root;
    private final Remote remote;
    private final File stateFile;
    private final String pcLabel, phoneLabel;
    private final Listener listener;
    private final AtomicBoolean stop;
    private Map<String, Entry> localList, remoteList;
    private Map<String, long[]> state;
    private final Set<String> touched = new HashSet<String>();
    private Set<String> taken;                         // names in use, as fold() has them, once one is looked for (see free)

    SyncEngine(File root, Remote remote, File stateFile, String pcName, Listener listener, AtomicBoolean stop) {
        this(root, remote, stateFile, pcName, null, listener, stop);
    }

    /** pcName, phoneName: the two devices' names, for "name (from <PC name>).ext" and "name (from <phone name>).ext". */
    SyncEngine(File root, Remote remote, File stateFile, String pcName, String phoneName, Listener listener, AtomicBoolean stop) {
        this.root = root;
        this.remote = remote;
        this.stateFile = stateFile;
        this.pcLabel = label(pcName);
        this.phoneLabel = label(phoneName);
        this.listener = listener;
        this.stop = stop;
    }

    Result run() throws IOException {
        localList = listLocal(root);
        remoteList = remote.list();
        state = loadState(stateFile);
        List<Action> acts = plan(localList, remoteList, state);
        // the phone's listing stopped at MAX_FILES too: a file it didn't list may be here all the same
        boolean localAll = localList.size() < MAX_FILES;
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
                // (never fetched to be thrown away, and not a failure: the phone has it)
                if (a.op == DOWNLOAD && a.local == null && !localAll && here(a.rel)) { listener.progress(++done, total); continue; }
                try {
                    boolean moved = true;
                    if (a.op == CLASH) throw new IOException("another file there has this name in other capitals or another Unicode spelling (Windows, Macs and phones take them as one)");
                    if (a.op == UPLOAD) upload(a.rel, a.remoteRel, a.local, a.remote);
                    else if (a.op == DOWNLOAD) download(a.rel, a.remoteRel, a.local, a.remote);
                    else moved = keepBoth(a.rel, a.remoteRel, a.local, a.remote);
                    if (moved) res.moved++;
                } catch (Fatal f) {
                    throw f;
                } catch (Busy b) {
                    // not a failure: the next run sees the file that arrived, and syncs it as usual
                } catch (IOException e) {
                    res.failed++;
                    if (res.why == null) res.why = a.rel + ": " + words(e);
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
        touch(rel);
    }

    /** rel (l on the phone), sent as sent and stored by the PC under its name: its time there is sent's, to its disk's step. */
    private void recordSent(String rel, Entry l, Entry sent) {
        state.put(rel, new long[]{l.size, l.mtime, sent.size, sent.mtime, SENT});
        touch(rel);
    }

    /**
     * The phone's rel to the PC as rRel (its name there: rel, or rel in other capitals), replacing the PC's, unless the
     * PC keeps its own because it's newer.
     */
    private void upload(String rel, String rRel, Entry l, Entry r) throws IOException {
        String no = unfit(rRel);
        if (no != null) throw new IOException(no);
        File f = file(root, rel);
        if (!f.isFile()) throw new IOException("gone");
        Entry now = stat(f);
        String stored = put(rRel, f, now.mtime);
        if (!stored.equals(rRel)) { keptBoth(rel, rRel, now, stored); return; }
        // The PC has this file already (it said "same"): it's recorded as the PC has it. A PC before 2.1 says so without
        // a word, and without comparing the bytes, when its file is up to 2 s newer and of the same size (it would have
        // kept both otherwise): an edit of the same size made within 2 s, a phone's clock behind, was taken as synced,
        // and recorded so, the next run fetched the PC's old version over it. Then the two are compared as any two.
        boolean older = r != null && r.size == now.size && r.mtime > now.mtime && r.mtime - now.mtime <= TOL;
        if (saidSame && r != null && r.size == now.size) record(rel, now, r);
        else if (saidSame) recordSent(rel, now, now);
        else if (older) keepBoth(rel, rRel, now, r);
        else recordSent(rel, now, now);
    }

    /** The PC's rRel to the phone's rel (replacing the phone's l, if it's still what the listing showed). */
    private void download(String rel, String rRel, Entry l, Entry r) throws IOException {
        Entry got = fetch(rRel, rel, l, r);
        File f = file(root, rel);
        record(rel, stat(f), got);
    }

    /**
     * rel is on both sides, different, and nothing says which may replace the other (never synced, or changed on both
     * sides since): both are kept, on both sides. Files of the same size are compared first (the PC's is fetched for
     * it, and used below if they differ): the same content under other times is only matched. Otherwise the newer one
     * keeps the name and the other goes on both sides as "name (from <its device>).ext". Neither side's version is
     * replaced before it's kept elsewhere. Returns false when they were the same (nothing moved).
     */
    private boolean keepBoth(String rel, String rRel, Entry l, Entry r) throws IOException {
        File f = file(root, rel);
        if (!f.isFile()) throw new IOException("gone");
        Entry now = stat(f);
        File theirs = partFor(f);
        try {
            Entry pcs = r;
            if (now.size == r.size) {
                long mt = remote.get(rRel, theirs);
                pcs = new Entry(theirs.length(), mt > 0 ? mt : r.mtime);
                if (pcs.size == now.size && sameBytes(f, theirs) && stat(f).same(now)) { record(rel, now, pcs); return false; }
            }
            if (now.mtime > pcs.mtime) {
                // the phone's is newer: it keeps the name. The PC's comes down as "name (from <PC>).ext" (fetched already,
                // or now), and goes back up under that name before the phone's replaces it at rel on the PC
                String alt = keptName(rel, pcLabel);
                File altF = file(root, alt);
                if (theirs.isFile()) place(theirs, alt, pcs);
                else fetch(rRel, alt, null, r);
                Entry altL = stat(altF);
                // (the PC's at rel is kept now: if the rest is cut short, even by Android stopping Flick, the next run
                // sends the phone's to rel, and makes no second copy of the PC's)
                state.put(rel, new long[]{-1, -1, pcs.size, pcs.mtime});
                touch(rel);
                try { saveState(stateFile, state); } catch (IOException e) { /* saved at the end of the run */ }
                String altStored = put(alt, altF, altL.mtime);
                if (altStored.equals(alt)) recordSent(alt, altL, altL);
                else keptBoth(alt, alt, altL, altStored);
                Entry cur = stat(f);
                String stored = put(rRel, f, cur.mtime);
                if (stored.equals(rRel)) recordSent(rel, cur, cur);
                else keptBoth(rel, rRel, cur, stored);           // the PC's file changed again meanwhile
            } else {
                // the PC's is newer (or as new): it keeps the name. The phone's takes "name (from <phone>).ext" here and
                // goes up under it, and the PC's comes down to rel
                String alt = keptName(rel, phoneLabel);
                File altF = file(root, alt);
                if (!mkdirsFor(altF)) throw new IOException("can't rename " + f.getName());
                synchronized (NAMES) {
                    if (altF.exists() || claimed(altF) || !f.renameTo(altF)) throw new IOException("can't rename " + f.getName());
                }
                touch(alt);
                listener.received(alt, altF, f);
                Entry altL = stat(altF);
                String altStored = put(alt, altF, altL.mtime);
                if (altStored.equals(alt)) recordSent(alt, altL, altL);
                else keptBoth(alt, alt, altL, altStored);
                // (under the PC's name: the phone's of other capitals is gone from there now)
                if (!rRel.equals(rel)) state.remove(rel);
                Entry got = theirs.isFile() ? place(theirs, rRel, pcs) : fetch(rRel, rRel, null, r);
                record(rRel, stat(file(root, rRel)), got);
            }
            return true;
        } finally {
            if (theirs.exists()) theirs.delete();
        }
    }

    /** A file of the PC's fetched already (part, as got) put in place at localRel, where there must be nothing yet. */
    private Entry place(File part, String localRel, Entry got) throws IOException {
        File dest = file(root, localRel);
        if (!mkdirsFor(dest)) throw new IOException("can't write " + dest.getName());
        synchronized (NAMES) {
            if (claimed(dest)) throw new Busy();
            if (dest.exists()) throw new IOException("changed on the phone meanwhile");
            if (!part.renameTo(dest)) throw new IOException("can't write " + dest.getName());
        }
        if (got.mtime > 0) dest.setLastModified(got.mtime);
        touch(localRel);
        listener.received(localRel, dest, null);
        return got;
    }

    /** a and b hold the same bytes. */
    static boolean sameBytes(File a, File b) throws IOException {
        if (a.length() != b.length()) return false;
        java.io.InputStream x = new java.io.FileInputStream(a), y = null;
        try {
            y = new java.io.FileInputStream(b);
            byte[] p = new byte[64 * 1024], q = new byte[64 * 1024];
            for (;;) {
                int n = readFully(x, p), m = readFully(y, q);
                if (n != m) return false;
                if (n <= 0) return true;
                for (int i = 0; i < n; i++) if (p[i] != q[i]) return false;
            }
        } finally {
            x.close();
            if (y != null) y.close();
        }
    }

    private static int readFully(java.io.InputStream in, byte[] b) throws IOException {
        int n = 0, r;
        while (n < b.length && (r = in.read(b, n, b.length - n)) > 0) n += r;
        return n;
    }

    /**
     * The PC kept its own file at rRel (rel, or rel in other capitals) and stored the phone's as stored: the phone's copy
     * takes that name too, and the PC's file comes down under rRel. If the phone can't rename it, rel is left
     * unrecorded: the next run sees two versions with no record and keeps both (see keepBoth).
     */
    private void keptBoth(String rel, String rRel, Entry l, String stored) throws IOException {
        File f = file(root, rel);
        File to;
        try { to = file(root, stored); } catch (IOException e) { to = null; }
        touch(stored);
        boolean renamed = false;
        if (to != null && mkdirsFor(to)) synchronized (NAMES) { renamed = !to.exists() && !claimed(to) && f.renameTo(to); }
        if (!renamed) {
            state.remove(rel);
            return;
        }
        Entry moved = stat(to);
        recordSent(stored, moved, l);
        listener.received(stored, to, f);
        state.remove(rel);
        // (the PC's comes down under its own name: rel, or rel in other capitals)
        Entry got = fetch(rRel, rRel, null, remoteList.get(rRel));
        record(rRel, stat(file(root, rRel)), got);
    }

    /**
     * The PC's remoteRel into the phone's localRel, through a hidden part file next to it. expect: what the phone's
     * file showed in the listing (null: there must be no file there): if it changed meanwhile, it's left alone.
     * Returns the PC's side as received (size, mtime).
     */
    private Entry fetch(String remoteRel, String localRel, Entry expect, Entry listed) throws IOException {
        // a name the PC's disk takes and the phone's can't is said, rather than the file fetched whole on every run to
        // be thrown away
        String no = unfitHere(localRel);
        if (no != null) throw new IOException(no);
        File dest = file(root, localRel);
        // (one there already that should be absent is left alone before the PC's is fetched, not after)
        if (expect == null && dest.exists()) throw new IOException(dest.isDirectory() ? "a folder has that name on the phone" : "changed on the phone meanwhile");
        if (!mkdirsFor(dest)) throw new IOException("can't make the folder");
        // a download from the PC is arriving as this name: not fetched to be thrown away
        if (claimed(dest)) throw new Busy();
        File part = partFor(dest);
        try {
            long mt = remote.get(remoteRel, part);
            if (mt <= 0 && listed != null) mt = listed.mtime;
            long size = part.length();
            synchronized (NAMES) {
                if (claimed(dest)) throw new Busy();             // (one that started meanwhile)
                boolean untouched = expect == null ? !dest.exists() : dest.isFile() && stat(dest).same(expect);
                if (!untouched) throw new IOException("changed on the phone meanwhile");
                if (!part.renameTo(dest)) throw new IOException("can't write " + dest.getName());
            }
            if (mt > 0) dest.setLastModified(mt);            // some storage can't: the record keeps what the phone shows
            touch(localRel);
            listener.received(localRel, dest, null);
            return new Entry(size, mt > 0 ? mt : (listed != null ? listed.mtime : 0));
        } finally {
            if (part.exists()) part.delete();
        }
    }

    private boolean saidSame;                          // the PC's answer to the last put was "same" (see upload)

    private String put(String rel, File f, long mtime) throws IOException {
        String stored = remote.put(rel, f, mtime);
        saidSame = remote instanceof SaysSame && ((SaysSame) remote).saidSame();
        if (stored == null || stored.length() == 0) stored = rel;
        touch(stored);
        listener.sent(rel, f, stored);
        return stored;
    }

    private static boolean mkdirsFor(File f) {
        File d = f.getParentFile();
        return d != null && (d.isDirectory() || d.mkdirs());
    }

    /**
     * "dir/name (from <label>).ext" that neither side has yet ("name (from <label>) (2).ext" and on); "name (2).ext" and
     * on when there's no label, or it makes a name the PC can't take (too long, say). Names that differ only in case
     * count as taken: they're one file on Windows (and in the phone's shared storage).
     */
    String keptName(String rel, String label) throws IOException {
        int slash = rel.lastIndexOf('/');
        String dir = slash >= 0 ? rel.substring(0, slash + 1) : "";
        String name = rel.substring(slash + 1);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        if (label.length() > 0) {
            for (int i = 1; i < 1000; i++) {
                String seg = base + " (from " + label + ")" + (i > 1 ? " (" + i + ")" : "") + ext;
                if (!fits(seg) || unfit(dir + seg) != null) break;
                if (free(dir + seg)) return dir + seg;
            }
        }
        for (int i = 2; i < 100000; i++) {
            String tail = " (" + i + ")", b = base;
            // (a name at the limit makes room for the number)
            while (b.length() > 1 && !fits(b + tail + ext)) b = b.substring(0, b.length() - (b.length() > 2 && Character.isLowSurrogate(b.charAt(b.length() - 1)) ? 2 : 1));
            String seg = b + tail + ext;
            if (fits(seg) && unfit(dir + seg) == null && free(dir + seg)) return dir + seg;
        }
        throw new IOException("no free name for the other version");
    }

    /** A name both sides' file systems take: 255 characters (Windows) and 255 bytes (the phone's). */
    private static boolean fits(String name) { return name.length() <= 255 && utf8(name) <= 255; }

    /**
     * Why the phone can't store a file of the PC's at rel, or null when it can: its file systems take 255 bytes per
     * name, where Windows takes 255 characters (90 Chinese ones are 270 bytes).
     */
    static String unfitHere(String rel) {
        for (String seg : rel.split("/", -1)) if (utf8(seg) > 255) return "its name is too long for this phone";
        return null;
    }

    static int utf8(String s) {
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

    /**
     * The hidden file a file of the PC's arrives in, next to dest. A name near the limit (255 bytes) has no room for the
     * dot and ".flicksync" around it: it's cut, and a number made from it keeps it apart from others.
     */
    static File partFor(File dest) {
        String n = dest.getName();
        if (utf8(n) + 1 + SYNC_PART.length() > 255) {
            String c = n;
            while (c.length() > 1 && utf8(c) > 200) c = c.substring(0, c.length() - (c.length() > 2 && Character.isLowSurrogate(c.charAt(c.length() - 1)) ? 2 : 1));
            n = c + "-" + Integer.toHexString(n.hashCode());
        }
        return new File(dest.getParentFile(), "." + n + SYNC_PART);
    }

    /** A download from the PC is arriving as dest now (Files.reserve claimed its name). */
    static boolean claimed(File dest) { synchronized (NAMES) { return CLAIMED.contains(key(dest)); } }

    private boolean free(String cand) {
        if (taken == null) {
            taken = new HashSet<String>();
            for (String k : localList.keySet()) taken.add(fold(k));
            for (String k : remoteList.keySet()) taken.add(fold(k));
            for (String k : touched) taken.add(fold(k));
        }
        if (taken.contains(fold(cand))) return false;
        try { File f = file(root, cand); return !f.exists() && !claimed(f); } catch (IOException e) { return false; }
    }

    /** rel was written or recorded this run (its record is kept; its name is taken). */
    private void touch(String rel) {
        touched.add(rel);
        if (taken != null) taken.add(fold(rel));
    }

    // what a device's name can't hold to be part of a file name (the rules above: unfit)
    private static final Pattern LABEL_BAD = Pattern.compile("[<>:\"|?*\\\\/\\u0000-\\u001f\\u007f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]");

    /** A device's name as it can be part of a file name, or "" when none of it can. */
    static String label(String name) {
        String s = name == null ? "" : LABEL_BAD.matcher(name).replaceAll("_").trim();
        while (s.startsWith(".")) s = s.substring(1).trim();
        if (s.length() > 40) s = s.substring(0, Character.isHighSurrogate(s.charAt(39)) ? 39 : 40).trim();
        while (s.endsWith(".")) s = s.substring(0, s.length() - 1).trim();
        return s;
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
                m.put(k, a.length() > 4 ? new long[]{a.optLong(0), a.optLong(1), a.optLong(2), a.optLong(3), a.optLong(4)}
                        : new long[]{a.optLong(0), a.optLong(1), a.optLong(2), a.optLong(3)});
            }
        } catch (Exception e) { /* a damaged record: everything counts as never synced (both kept: see plan) */ }
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
