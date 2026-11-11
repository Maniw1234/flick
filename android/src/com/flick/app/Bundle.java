package com.flick.app;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Many files and folders sent to the PC in one streamed request (the PC side is pc/bundle.js):
 * "FLKB1\n", [u32 len][manifest JSON], then per entry [u32 len][entry JSON] (+ the file's bytes), and [u32 0] at the end.
 * Each entry carries its number in this bundle ("i"), so a send that was cut off can carry on from any entry (and from
 * inside a file) even when a file that couldn't be read was left out. No Android classes in here, so it can be
 * exercised on any JVM.
 */
final class Bundle {
    static final class Entry {
        final String rel;
        final File file;
        final boolean dir;
        final long size;
        final long mtime;
        Entry(String rel, File file, boolean dir, BasicFileAttributes at) {
            this.rel = rel;
            this.file = file;
            this.dir = dir;
            this.size = dir ? 0 : at.size();
            this.mtime = at.lastModifiedTime().toMillis();
        }
    }

    /**
     * A file's type, size and date in one look (File's isDirectory, isFile, length and lastModified are one each: five
     * per file with the size counted twice), or null when it can't be looked at. A folder of thousands of files was
     * mostly these looks.
     */
    private static BasicFileAttributes look(File f) {
        try { return Files.readAttributes(f.toPath(), BasicFileAttributes.class); } catch (Throwable e) { return null; }
    }

    interface Progress { void onBytes(long sent, long total); }

    static final int MANIFEST_MAX = 192 * 1024;

    // A receiver takes paths 64 folders deep (pc/bundle.js, PeerServer): a picked folder's subfolders are taken this deep
    // (their files are 64 deep), and deeper ones are left out (deep).
    static final int MAX_DEPTH = 62;
    // In one send to another device (as pc/peerlink.js; a receiver takes 200,000 entries): past these the rest is left
    // out (more), and said. Set by the sender that says so (maxFiles, maxDirs); none otherwise.
    static final int MAX_FILES = 100000, MAX_DIRS = 50000;
    int maxFiles = Integer.MAX_VALUE, maxDirs = Integer.MAX_VALUE;

    final List<Entry> entries = new ArrayList<Entry>();
    final List<String> roots = new ArrayList<String>();
    volatile String now;                     // the file being written (its path in here): "the file going now"
    private final Set<String> rootKeys = new HashSet<String>();
    long bytes = 0;
    int files = 0;
    boolean deep;                   // folders too deep to be taken were left out
    boolean more;                   // past MAX_FILES (or MAX_DIRS): what's after was left out
    // a file that got shorter since it was picked is left out (counted in skipped), not the whole send: set by the
    // sender that says so (one still being written, a log growing, goes as it was when picked either way)
    boolean skipShrunk;
    private int dirs = 0;
    volatile int skipped;           // files the last write() left out: they couldn't be read any more
    // which ones (their paths in here), kept by a sender whose send carries on over several write()s (Outbox: a write
    // carrying on doesn't go back to those before it); one that goes after all is taken out again
    Set<String> leftOut;

    /** A file that got shorter while it was being sent (what was said it holds didn't all go). */
    static final class Changed extends IOException {
        private static final long serialVersionUID = 1L;
        Changed(String m) { super(m); }
    }
    /** A file that couldn't be read while it was being sent. */
    static final class Unreadable extends IOException {
        private static final long serialVersionUID = 1L;
        Unreadable(String m) { super(m); }
    }
    long manifestBytes = -1;        // a stream of a striped bundle announces the whole bundle's totals
    int manifestFiles = -1;

    /**
     * The same bundle as k streams that can travel at once (each an ordinary bundle body): files are dealt out
     * largest first to the stream with the fewest bytes so far, folders go with the first stream.
     */
    List<Bundle> split(int k) {
        k = Math.max(1, Math.min(k, Math.max(1, files)));
        List<Bundle> out = new ArrayList<Bundle>();
        for (int i = 0; i < k; i++) {
            Bundle b = new Bundle();
            b.roots.addAll(roots);
            b.manifestBytes = bytes;
            b.manifestFiles = files;
            out.add(b);
        }
        List<Entry> fs = new ArrayList<Entry>();
        for (Entry e : entries) { if (e.dir) out.get(0).entries.add(e); else fs.add(e); }
        Collections.sort(fs, new Comparator<Entry>() {
            @Override public int compare(Entry a, Entry b) { return a.size == b.size ? 0 : (a.size > b.size ? -1 : 1); }
        });
        for (Entry e : fs) {
            Bundle least = out.get(0);
            for (Bundle b : out) if (b.bytes < least.bytes) least = b;
            least.entries.add(e);
            least.bytes += e.size;
            least.files++;
        }
        return out;
    }

    /** A top-level file or folder; folders go in whole, skipping hidden names the way the file browser does. */
    void add(File f, String name, AtomicBoolean abort) throws IOException {
        if (more || files >= maxFiles) { more = true; return; }           // (past what one send takes: said)
        String top = clean(name != null && name.length() > 0 ? name : f.getName());
        BasicFileAttributes at = look(f);
        boolean dir = at != null && at.isDirectory();
        // gone since it was picked: not named in what's sent (another item would go under its name)
        if (!dir && (at == null || !at.isRegularFile())) throw new IOException("missing " + top);
        // two picks with the same name (e.g. two "Camera" folders) must not merge on the PC
        String unique = top;
        int i = 2;
        while (!rootKeys.add(unique.toLowerCase(Locale.ROOT))) unique = numbered(top, i++, dir);
        roots.add(unique);
        if (dir) walk(f, at, unique, new HashSet<String>(), 0, abort);
        else file(new Entry(unique, f, false, at));
    }

    private void file(Entry e) {
        if (files >= maxFiles) { more = true; return; }
        entries.add(e); bytes += e.size; files++;
    }

    private void walk(File d, BasicFileAttributes at, String rel, Set<String> seen, int depth, AtomicBoolean abort) throws IOException {
        if (abort != null && abort.get()) throw new IOException("aborted");
        if (depth > MAX_DEPTH) { deep = true; return; }                   // (said: see deep)
        if (more) return;
        if (dirs >= maxDirs) { more = true; return; }
        if (!seen.add(d.getCanonicalPath())) return;                      // symlink loops
        entries.add(new Entry(rel, d, true, at));
        dirs++;
        File[] kids = d.listFiles();
        if (kids == null) return;
        Arrays.sort(kids, new Comparator<File>() {
            @Override public int compare(File a, File b) { return a.getName().compareToIgnoreCase(b.getName()); }
        });
        for (File k : kids) {
            if (more) return;
            String n = k.getName();
            if (n.startsWith(".")) continue;
            BasicFileAttributes ka = look(k);
            if (ka == null) continue;
            if (ka.isDirectory()) walk(k, ka, rel + "/" + clean(n), seen, depth + 1, abort);
            else if (ka.isRegularFile()) file(new Entry(rel + "/" + clean(n), k, false, ka));
        }
    }

    private void left(Entry e) {
        skipped++;
        Set<String> lo = leftOut;
        if (lo != null) lo.add(e.rel);
    }

    static String clean(String n) {
        String s = n.replace('/', '_').replace('\\', '_');
        return s.length() == 0 ? "_" : s;
    }

    private static String numbered(String name, int i, boolean dir) {
        int dot = dir ? -1 : name.lastIndexOf('.');
        if (dot <= 0) return name + " (" + i + ")";
        return name.substring(0, dot) + " (" + i + ")" + name.substring(dot);
    }

    void write(OutputStream out, AtomicBoolean abort, Progress prog) throws IOException { write(out, abort, prog, 0, 0); }

    /** The file to carry on with (entry skip, from byte from) can't be read any more: send that entry again from 0. */
    static final class ResumeLost extends IOException {
        private static final long serialVersionUID = 1L;
        ResumeLost(String m) { super(m); }
    }

    /**
     * The bundle from entry number skip on; the first from bytes of that entry (a file) are on the PC already, so only
     * the rest of it goes. prog counts the bytes written by this call.
     */
    void write(OutputStream out, AtomicBoolean abort, Progress prog, int skip, long from) throws IOException {
        DataOutputStream o = new DataOutputStream(out);
        o.write("FLKB1\n".getBytes("UTF-8"));
        StringBuilder m = new StringBuilder("{\"v\":1,\"files\":").append(manifestFiles >= 0 ? manifestFiles : files)
                .append(",\"bytes\":").append(manifestBytes >= 0 ? manifestBytes : bytes).append(",\"roots\":[");
        // the picked items' names, as many as keep the manifest well under 256 KB (a PC up to 1.1.0 refuses a larger
        // one, and with it the whole send: thousands of photos picked one by one). They only order the items there.
        int size = m.length();
        for (int i = 0; i < roots.size(); i++) {
            String q = quote(roots.get(i));
            int n = q.getBytes("UTF-8").length + 1;
            if (size + n > MANIFEST_MAX) break;
            if (i > 0) m.append(',');
            m.append(q);
            size += n;
        }
        block(o, m.append("]}").toString());
        byte[] buf = new byte[256 * 1024];
        long sent = 0;
        skipped = 0;
        for (int i = Math.max(0, skip); i < entries.size(); i++) {
            Entry e = entries.get(i);
            if (abort != null && abort.get()) throw new IOException("aborted");
            if (e.dir) { block(o, "{\"p\":" + quote(e.rel) + ",\"d\":1,\"m\":" + e.mtime + ",\"i\":" + i + "}"); continue; }
            long at = i == skip && from > 0 ? from : 0;
            InputStream in;
            try {
                in = new FileInputStream(e.file);
                if (at > 0) skipFully(in, at);
            } catch (IOException x) {
                if (at > 0) throw new ResumeLost(e.rel);
                left(e);
                continue;                                                                 // unreadable: left out (counted)
            }
            try {
                if (skipShrunk && at == 0 && e.file.length() < e.size) { left(e); continue; }   // (in is closed below)
                Set<String> lo = leftOut;
                if (lo != null) lo.remove(e.rel);
                block(o, "{\"p\":" + quote(e.rel) + ",\"s\":" + e.size + ",\"m\":" + e.mtime + ",\"i\":" + i + "}");
                now = e.rel;
                long left = e.size - at;
                while (left > 0) {
                    if (abort != null && abort.get()) throw new IOException("aborted");
                    int n;
                    try { n = in.read(buf, 0, (int) Math.min(buf.length, left)); } catch (IOException x) { throw new Unreadable("can't be read: " + e.rel); }
                    if (n < 0) throw new Changed("changed while sending: " + e.rel);
                    o.write(buf, 0, n);
                    left -= n;
                    sent += n;
                    if (prog != null) prog.onBytes(sent, bytes);
                }
            } finally {
                in.close();
            }
        }
        o.writeInt(0);
        o.flush();
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long k = in.skip(n);
            if (k <= 0) { if (in.read() < 0) throw new IOException("file changed"); k = 1; }
            n -= k;
        }
    }

    /** Bytes of entries [0, n) of this bundle (what the PC has when a stream stopped before entry n). */
    long bytesBefore(int n) {
        long b = 0;
        for (int i = 0; i < n && i < entries.size(); i++) b += entries.get(i).size;
        return b;
    }

    /** What this bundle carries (names, sizes, times): another one means the files changed and it starts over. */
    String signature() {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            for (Entry e : entries) md.update((e.rel + "|" + (e.dir ? "d" : e.size + "|" + e.mtime) + "\n").getBytes("UTF-8"));
            StringBuilder b = new StringBuilder(64);
            for (byte x : md.digest()) b.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
            return b.substring(0, 32);
        } catch (Exception e) { return ""; }
    }

    private static void block(DataOutputStream o, String json) throws IOException {
        byte[] b = json.getBytes("UTF-8");
        o.writeInt(b.length);
        o.write(b);
    }

    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 8).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
