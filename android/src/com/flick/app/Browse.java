package com.flick.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.PowerManager;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Browse phone: the paired PC shows this phone's photos, videos, downloads, documents and folders, and copies the files
 * the user picks there. The PC can't open connections to the phone, so it asks over the link the phone keeps open (the
 * page's WebSocket, which hands the request here, or LinkService's background link): {t:"browse", id, op, ...}. This
 * answers by posting to /api/browse and sends copies as quiet uploads (kind=pull), all through PcClient: only to the PC
 * this phone paired with, over its pinned encrypted link. Only while "Let your PC browse this phone" is on (off until
 * the user turns it on), only shared storage, never hidden files or apps' own folders (Android/data, Android/obb), and
 * only reading: nothing here changes or deletes a file. Requests are rate-limited; one copy at a time.
 *
 *   list   {cat: photos|videos|docs|downloads|storage|dir, path?, offset, limit}
 *          -> {id, ok:true, cat, path, name, parent, items:[{name, path, size, mtime, kind, w, h, dur, mid, mt} | {name, path, dir, count}], total, more}
 *   thumbs {items:[{path, mtime, mid, mt}]} -> {id, thumbs:{path: data URL}} in batches, the last with last:true
 *   pull   {job, files:[{i, path, name}]} -> {id, ok:true}; per file {job, i, sent, total} and the upload
 *          (tid pl<job>-<i>), or {job, i, ok:false, why}; then {job, end:true}
 *   stop   {job}
 *   An error: {id, ok:false, error: off | storage | busy | notfound | bad}
 */
final class Browse {
    static final int LIMIT_MAX = 120;
    static final int THUMBS_MAX = 120;
    static final int PULL_MAX = 200;
    static final int THUMB_PX = 200;
    private static final int RATE_N = 40;                // requests in RATE_MS at most (more are dropped, unanswered)
    private static final long RATE_MS = 10000;
    private static final ExecutorService POOL = Transfers.pool("flick-browse", 2);
    private static final ArrayDeque<Long> recent = new ArrayDeque<Long>();
    private static final AtomicInteger thumbGen = new AtomicInteger();
    private static Job job;                              // the copy under way (guarded by Browse.class)

    /** A copy the PC asked for. */
    static final class Job {
        final String id, pcId;
        final AtomicBoolean abort = new AtomicBoolean(false);
        volatile int i = -1;
        volatile long sent, total;
        Job(String id, String pcId) { this.id = id; this.pcId = pcId; }
    }

    private Browse() {}

    /** A request from the PC whose link it came over (pcId). Returns at once: the work runs on Browse's own threads. */
    static void handle(Context ctx, final JSONObject m, final String pcId) {
        final Context c = ctx.getApplicationContext();
        final String op = m.optString("op", ""), id = m.optString("id", "");
        if (!id.matches("[A-Za-z0-9]{1,40}") || pcId == null || pcId.length() == 0) return;
        if ("stop".equals(op)) {
            stop(m.optString("job", ""));
            later(c, new Runnable() { @Override public void run() { answer(c, pcId, ok(id)); } });
            return;
        }
        if (!allow()) { Bg.log("browse: too many requests, one dropped"); return; }
        final String err = !Features.browse(c) ? "off" : !Files.granted(c) ? "storage" : null;
        // the page says the PC is looking (or would like to), while it's in front
        if (err == null && "list".equals(op)) Page.event("browse", "op", op);
        else if ("off".equals(err)) Page.event("browse", "off", true);
        later(c, new Runnable() {
            @Override
            public void run() {
                if (err != null) { answer(c, pcId, error(id, err)); return; }
                try {
                    if ("list".equals(op)) answer(c, pcId, list(c, id, m));
                    else if ("thumbs".equals(op)) thumbs(c, pcId, id, m, thumbGen.incrementAndGet());
                    else if ("pull".equals(op)) pull(c, pcId, id, m);
                    else answer(c, pcId, error(id, "bad"));
                } catch (Throwable e) {
                    Bg.warn("browse " + op, e);
                    answer(c, pcId, error(id, "bad"));
                }
            }
        });
    }

    /** The PC stopped the copy (or the user turned browsing off): it ends at once, mid-file too. */
    static void stop(String jobId) {
        Job j;
        synchronized (Browse.class) { j = job; }
        if (j != null && (jobId == null || j.id.equals(jobId))) Watchdog.abort(j.abort);
    }

    /** Browsing was turned off: nothing more is answered or sent. */
    static void stopAll() {
        thumbGen.incrementAndGet();
        stop(null);
    }

    // ------------------------------------------------------------ listings
    static JSONObject list(Context c, String id, JSONObject m) throws Exception {
        String cat = m.optString("cat", "");
        int offset = Math.max(0, m.optInt("offset", 0));
        int limit = Math.max(1, Math.min(LIMIT_MAX, m.optInt("limit", 60)));
        JSONObject r = new JSONObject();
        r.put("id", id);
        r.put("cat", cat);
        JSONArray items = new JSONArray();
        int total;
        boolean more;
        if ("photos".equals(cat) || "videos".equals(cat) || "docs".equals(cat)) {
            JSONObject q = new JSONObject(Files.query(c, cat, offset, limit));
            if (q.has("error")) return error(id, "bad");
            JSONArray a = q.optJSONArray("items");
            for (int i = 0; a != null && i < a.length(); i++) { JSONObject x = pub(a.optJSONObject(i)); if (x != null) items.put(x); }
            total = q.optInt("total", items.length());
            more = q.optBoolean("more", false);
            r.put("path", "");
            r.put("name", "");
        } else if ("downloads".equals(cat) || "storage".equals(cat) || "dir".equals(cat)) {
            File d = "downloads".equals(cat) ? new File(Files.root(), "Download") : "storage".equals(cat) ? Files.root() : new File(m.optString("path", ""));
            if (!readable(d, true)) return error(id, "notfound");
            JSONObject q = new JSONObject(Files.listDir(c, d.getPath()));
            if (q.has("error")) return error(id, "notfound");
            JSONArray a = q.optJSONArray("items");
            ArrayList<JSONObject> all = new ArrayList<JSONObject>();
            for (int i = 0; a != null && i < a.length(); i++) { JSONObject x = pub(a.optJSONObject(i)); if (x != null) all.add(x); }
            total = all.size();
            for (int i = offset; i < total && i < offset + limit; i++) items.put(all.get(i));
            more = offset + items.length() < total;
            r.put("path", q.optString("path", d.getPath()));
            r.put("name", q.optString("name", d.getName()));
            String parent = q.isNull("parent") ? null : q.optString("parent", null);
            r.put("parent", parent != null && readable(new File(parent), true) ? parent : JSONObject.NULL);
        } else {
            return error(id, "bad");
        }
        r.put("ok", true);
        r.put("items", items);
        r.put("total", total);
        r.put("more", more);
        return r;
    }

    /** What the PC gets of a listed item: its name, path, size, date and kind; nothing hidden or in apps' own folders. */
    private static JSONObject pub(JSONObject x) throws Exception {
        if (x == null) return null;
        String path = x.optString("path", "");
        if (path.length() == 0 || !visible(path)) return null;
        JSONObject o = new JSONObject();
        o.put("name", x.optString("name", new File(path).getName()));
        o.put("path", path);
        o.put("mtime", x.optLong("mtime", 0));
        if (x.optBoolean("dir", false)) { o.put("dir", true); o.put("count", x.optInt("count", 0)); return o; }
        o.put("size", x.optLong("size", 0));
        o.put("kind", x.optString("kind", "doc"));
        for (String k : new String[]{"w", "h", "dur", "mid", "mt"}) if (x.has(k)) o.put(k, x.optLong(k, 0));
        return o;
    }

    /** A path the PC may see: no hidden part, not inside Android/data or Android/obb (apps' own files). */
    static boolean visible(String path) {
        for (String seg : path.split("/")) if (seg.startsWith(".")) return false;
        String l = path.toLowerCase(Locale.US) + "/";
        return !l.contains("/android/data/") && !l.contains("/android/obb/");
    }

    /** f is in shared storage, visible (its real path too, after links), and a folder (dir) or a file Flick can read. */
    static boolean readable(File f, boolean dir) {
        try {
            if (!Files.allowed(f) || !visible(f.getPath()) || !visible(f.getCanonicalPath())) return false;
            return dir ? f.isDirectory() : f.isFile() && f.canRead();
        } catch (Throwable e) { return false; }
    }

    // ------------------------------------------------------------ thumbnails
    private static void thumbs(Context c, String pcId, String id, JSONObject m, int gen) throws Exception {
        JSONArray a = m.optJSONArray("items");
        if (a == null) { answer(c, pcId, error(id, "bad")); return; }
        JSONObject batch = new JSONObject();
        int n = Math.min(a.length(), THUMBS_MAX), inBatch = 0;
        Map<Long, String>[] media = mediaOf(c, a, n);
        for (int i = 0; i < n; i++) {
            if (thumbGen.get() != gen || !Features.browse(c)) return;      // a newer page was asked for, or browsing went off
            JSONObject x = a.optJSONObject(i);
            if (x == null) continue;
            String path = x.optString("path", "");
            if (!readable(new File(path), false)) continue;
            // the MediaStore id comes from the PC: used only when it is that file's (else it could be any photo's,
            // hidden ones too); the file's own date keys the cache, not the PC's
            long mid = x.optLong("mid", 0);
            int mt = x.optInt("mt", 0);
            if (mid > 0 && (mt < 1 || mt > 3 || !path.equals(media[mt].get(mid)))) mid = 0;
            String url = small(c, path, 0, mid, mt);
            if (url == null) continue;
            batch.put(path, url);
            if (++inBatch == 8 && i < n - 1) {
                JSONObject b = new JSONObject();
                b.put("id", id);
                b.put("thumbs", batch);
                if (answer(c, pcId, b) == null) return;                     // the PC no longer wants them
                batch = new JSONObject();
                inBatch = 0;
            }
        }
        JSONObject b = new JSONObject();
        b.put("id", id);
        b.put("thumbs", batch);
        b.put("last", true);
        answer(c, pcId, b);
    }

    /** MediaStore's paths of the ids the PC listed (one lookup per type), by type (1 image, 2 audio, 3 video) and id. */
    @SuppressWarnings("unchecked")
    private static Map<Long, String>[] mediaOf(Context c, JSONArray a, int n) {
        Map<Long, String>[] out = new Map[4];
        for (int mt = 1; mt <= 3; mt++) {
            HashSet<Long> ids = new HashSet<Long>();
            for (int i = 0; i < n; i++) {
                JSONObject x = a.optJSONObject(i);
                if (x != null && x.optInt("mt", 0) == mt && x.optLong("mid", 0) > 0) ids.add(x.optLong("mid", 0));
            }
            out[mt] = Files.mediaPaths(c, mt, ids);
        }
        return out;
    }

    /** A small JPEG (THUMB_PX at most) of the file's cached thumbnail, as a data: URL, or null. */
    static String small(Context c, String path, long mtime, long mid, int mt) {
        File t = Thumbs.get(c, path, mtime, mid, mt);
        if (t == null) return null;
        Bitmap b = null;
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(t.getPath(), o);
            if (o.outWidth <= 0 || o.outHeight <= 0) return null;
            int s = 1;
            while (Math.min(o.outWidth, o.outHeight) / (s * 2) >= THUMB_PX) s *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = s;
            b = Library.scaleTo(BitmapFactory.decodeFile(t.getPath(), o2), THUMB_PX);
            if (b == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 72, out);
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable e) {
            return null;
        } finally { if (b != null) b.recycle(); }
    }

    // ------------------------------------------------------------ copies
    private static void pull(final Context c, final String pcId, String id, JSONObject m) {
        final String jid = m.optString("job", "");
        final JSONArray files = m.optJSONArray("files");
        if (!jid.matches("[0-9a-f]{12}") || files == null || files.length() == 0) { answer(c, pcId, error(id, "bad")); return; }
        final Job j;
        synchronized (Browse.class) {
            if (job != null) { answer(c, pcId, error(id, "busy")); return; }
            job = j = new Job(jid, pcId);
        }
        answer(c, pcId, ok(id));
        Page.event("browse", "op", "pull", "n", Math.min(files.length(), PULL_MAX));
        Thread t = new Thread(new Runnable() { @Override public void run() { copy(c, j, files); } }, "flick-browse-copy");
        t.setDaemon(true);
        t.start();
    }

    private static void copy(final Context c, final Job j, JSONArray files) {
        Transfers.hold(c, true);                             // Flick keeps running (and the Wi-Fi awake) while it sends
        final AtomicBoolean over = new AtomicBoolean(false);
        // how far the file under way is, about once a second, on its own thread so the upload never waits for it
        Thread ticker = new Thread(new Runnable() {
            @Override
            public void run() {
                long last = -1;
                while (!over.get()) {
                    try { Thread.sleep(900); } catch (InterruptedException e) { return; }
                    int i = j.i;
                    long sent = j.sent;
                    if (i < 0 || sent == last || over.get()) continue;
                    last = sent;
                    JSONObject a = news(c, j, i, sent, j.total);
                    if (a != null && a.optBoolean("stopped", false)) Watchdog.abort(j.abort);
                }
            }
        }, "flick-browse-progress");
        ticker.setDaemon(true);
        ticker.start();
        PcClient.Target t = null;
        try {
            PcClient client = Bg.client(c);
            t = client.target(j.pcId, null);
            t.eager = true;
            for (int k = 0; k < files.length() && k < PULL_MAX; k++) {
                if (j.abort.get() || !Features.browse(c)) break;
                JSONObject x = files.optJSONObject(k);
                if (x == null) continue;
                int i = x.optInt("i", k);
                File f = new File(x.optString("path", ""));
                if (!readable(f, false)) { fileFailed(c, j, i, "missing"); continue; }
                String name = plainName(x.optString("name", ""), f.getName());
                long size = f.length();
                j.sent = 0; j.total = size; j.i = i;
                JSONObject a = news(c, j, i, 0, size);
                if (a != null && a.optBoolean("stopped", false)) break;
                try {
                    client.upload(t, counting(f, j), name, "pull", j.abort, "pl" + j.id + "-" + i);
                    Bg.historyAdd(c, "out", name, size, f.getPath(), Files.kindOf(name, Files.mimeOf(name)), "browse", true, t);
                } catch (PcClient.Failure e) {
                    if (e.is(PcClient.Failure.ABORTED) || stopped(e)) break;
                    if (!e.is(PcClient.Failure.REFUSED) && !e.is(PcClient.Failure.LOCAL)) break;      // the PC is gone: no point going on
                    fileFailed(c, j, i, e.is(PcClient.Failure.LOCAL) ? "read" : "refused");
                }
            }
        } catch (Throwable e) {
            Bg.warn("browse copy", e);
        } finally {
            over.set(true);
            ticker.interrupt();
            j.i = -1;
            try {
                JSONObject end = new JSONObject();
                end.put("job", j.id);
                end.put("end", true);
                answer(c, j.pcId, end);
            } catch (Throwable e) { /* ignore */ }
            synchronized (Browse.class) { if (job == j) job = null; }
            Transfers.hold(c, false);
        }
    }

    private static boolean stopped(PcClient.Failure e) {
        return e.is(PcClient.Failure.REFUSED) && String.valueOf(e.getMessage()).endsWith(": stopped");
    }

    private static JSONObject news(Context c, Job j, int i, long sent, long total) {
        try {
            JSONObject o = new JSONObject();
            o.put("job", j.id); o.put("i", i); o.put("sent", sent); o.put("total", total);
            return answer(c, j.pcId, o);
        } catch (Throwable e) { return null; }
    }

    private static void fileFailed(Context c, Job j, int i, String why) {
        try {
            JSONObject o = new JSONObject();
            o.put("job", j.id); o.put("i", i); o.put("ok", false); o.put("why", why);
            answer(c, j.pcId, o);
        } catch (Throwable e) { /* ignore */ }
    }

    /** The name the PC listed, if it's a plain file name; otherwise the file's own. */
    static String plainName(String want, String own) {
        if (want == null || want.length() == 0 || want.length() > 255 || want.indexOf('/') >= 0 || want.indexOf('\\') >= 0 || want.startsWith(".")) return own;
        for (int i = 0; i < want.length(); i++) if (want.charAt(i) < 0x20) return own;
        return want;
    }

    // the file, counting what has been read of it (the progress the ticker reports)
    private static PcClient.Source counting(final File f, final Job j) {
        return new PcClient.Source() {
            @Override
            public InputStream open() throws IOException {
                j.sent = 0;
                return new FilterInputStream(new FileInputStream(f)) {
                    @Override public int read() throws IOException { int b = super.read(); if (b >= 0) j.sent++; return b; }
                    @Override public int read(byte[] b, int off, int len) throws IOException { int n = super.read(b, off, len); if (n > 0) j.sent += n; return n; }
                };
            }
            @Override public long length() { return f.length(); }
        };
    }

    // ------------------------------------------------------------ plumbing
    private static synchronized boolean allow() {
        long now = System.nanoTime() / 1000000L;
        while (!recent.isEmpty() && now - recent.peekFirst() > RATE_MS) recent.pollFirst();
        if (recent.size() >= RATE_N) return false;
        recent.addLast(now);
        return true;
    }

    /** Runs r on Browse's threads, the CPU kept awake for it (the phone may be asleep in a pocket). */
    private static void later(final Context c, final Runnable r) {
        try {
            POOL.execute(new Runnable() {
                @Override
                public void run() {
                    PowerManager.WakeLock wl = null;
                    try {
                        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
                        if (pm != null) { wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flick:browse"); wl.acquire(60000); }
                    } catch (Throwable e) { wl = null; }
                    try { r.run(); } catch (Throwable e) { Bg.warn("browse", e); }
                    finally { try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable e) { /* ignore */ } }
                }
            });
        } catch (Throwable e) { Bg.warn("browse", e); }
    }

    /** Posts an answer to the PC (PcClient: the paired PC, its pinned link); its reply, or null when it didn't take it. */
    private static JSONObject answer(Context c, String pcId, JSONObject body) {
        if (body == null) return null;
        try {
            PcClient client = Bg.client(c);
            return client.post(client.target(pcId, null), "/api/browse", null, body);
        } catch (Throwable e) {
            Bg.log("browse answer not taken: " + e.getMessage());
            return null;
        }
    }

    private static JSONObject ok(String id) {
        JSONObject o = new JSONObject();
        try { o.put("id", id); o.put("ok", true); } catch (Throwable e) { /* can't fail */ }
        return o;
    }

    static JSONObject error(String id, String why) {
        JSONObject o = new JSONObject();
        try { o.put("id", id); o.put("ok", false); o.put("error", why); } catch (Throwable e) { /* can't fail */ }
        return o;
    }
}
