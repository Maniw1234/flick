package com.flick.app;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
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
 * No Android classes in here, so it can be exercised on any JVM.
 */
final class Bundle {
    static final class Entry {
        final String rel;
        final File file;
        final boolean dir;
        final long size;
        final long mtime;
        Entry(String rel, File file, boolean dir) {
            this.rel = rel;
            this.file = file;
            this.dir = dir;
            this.size = dir ? 0 : file.length();
            this.mtime = file.lastModified();
        }
    }

    interface Progress { void onBytes(long sent, long total); }

    final List<Entry> entries = new ArrayList<Entry>();
    final List<String> roots = new ArrayList<String>();
    private final Set<String> rootKeys = new HashSet<String>();
    long bytes = 0;
    int files = 0;
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
        String top = clean(name != null && name.length() > 0 ? name : f.getName());
        // two picks with the same name (e.g. two "Camera" folders) must not merge on the PC
        String unique = top;
        int i = 2;
        while (!rootKeys.add(unique.toLowerCase(Locale.ROOT))) unique = numbered(top, i++, f.isDirectory());
        roots.add(unique);
        if (f.isDirectory()) walk(f, unique, new HashSet<String>(), 0, abort);
        else if (f.isFile()) { entries.add(new Entry(unique, f, false)); bytes += f.length(); files++; }
        else throw new IOException("missing " + top);
    }

    private void walk(File d, String rel, Set<String> seen, int depth, AtomicBoolean abort) throws IOException {
        if (abort != null && abort.get()) throw new IOException("aborted");
        if (depth > 48 || !seen.add(d.getCanonicalPath())) return;      // symlink loops, absurd nesting
        entries.add(new Entry(rel, d, true));
        File[] kids = d.listFiles();
        if (kids == null) return;
        Arrays.sort(kids, new Comparator<File>() {
            @Override public int compare(File a, File b) { return a.getName().compareToIgnoreCase(b.getName()); }
        });
        for (File k : kids) {
            String n = k.getName();
            if (n.startsWith(".")) continue;
            if (k.isDirectory()) walk(k, rel + "/" + clean(n), seen, depth + 1, abort);
            else if (k.isFile()) { entries.add(new Entry(rel + "/" + clean(n), k, false)); bytes += k.length(); files++; }
        }
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

    void write(OutputStream out, AtomicBoolean abort, Progress prog) throws IOException {
        DataOutputStream o = new DataOutputStream(out);
        o.write("FLKB1\n".getBytes("UTF-8"));
        StringBuilder m = new StringBuilder("{\"v\":1,\"files\":").append(manifestFiles >= 0 ? manifestFiles : files)
                .append(",\"bytes\":").append(manifestBytes >= 0 ? manifestBytes : bytes).append(",\"roots\":[");
        for (int i = 0; i < roots.size(); i++) { if (i > 0) m.append(','); m.append(quote(roots.get(i))); }
        block(o, m.append("]}").toString());
        byte[] buf = new byte[256 * 1024];
        long sent = 0;
        for (Entry e : entries) {
            if (abort != null && abort.get()) throw new IOException("aborted");
            if (e.dir) { block(o, "{\"p\":" + quote(e.rel) + ",\"d\":1,\"m\":" + e.mtime + "}"); continue; }
            InputStream in;
            try { in = new FileInputStream(e.file); } catch (IOException x) { continue; }   // unreadable: leave it out
            try {
                block(o, "{\"p\":" + quote(e.rel) + ",\"s\":" + e.size + ",\"m\":" + e.mtime + "}");
                long left = e.size;
                while (left > 0) {
                    if (abort != null && abort.get()) throw new IOException("aborted");
                    int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n < 0) throw new IOException("changed while sending: " + e.rel);
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
