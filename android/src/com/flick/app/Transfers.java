package com.flick.app;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.net.wifi.WifiManager;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

/** Moves bytes between the phone and the PC: straight to the PC, encrypted (Wire), or through one of this phone's relays. */
final class Transfers {
    interface Emitter { void emit(JSONObject o); }

    private final Context ctx;
    private final Library lib;
    private final Emitter em;
    private final ConcurrentHashMap<String, AtomicBoolean> aborts = new ConcurrentHashMap<String, AtomicBoolean>();
    // uploads and downloads queue apart: files arriving from the PC never hold up the phone's own sends
    private final ExecutorService ups = pool("flick-up", 3), downs = pool("flick-down", 3);

    Transfers(Context ctx, Library lib, Emitter em) {
        this.ctx = ctx.getApplicationContext();
        this.lib = lib;
        this.em = em;
        Sends.Nets.install(this.ctx);               // sockets to the PC go over its network (see Wire.Binder)
    }

    /** Up to n threads; idle ones end, so a pool costs nothing between transfers. */
    static ExecutorService pool(final String name, int n) {
        ThreadPoolExecutor p = new ThreadPoolExecutor(n, n, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>(), new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, name); t.setDaemon(true); return t; }
        });
        p.allowCoreThreadTimeOut(true);
        return p;
    }

    /** The activity that owns this is gone: transfers already handed over still finish, no new ones start. */
    void shutdown() {
        ups.shutdown();
        downs.shutdown();
    }

    /** Hands r to p; false when p no longer takes work (its activity was destroyed). */
    private static boolean submit(ExecutorService p, Runnable r) {
        try { p.execute(r); return true; } catch (RejectedExecutionException e) { return false; }
    }

    private void event(String t, String key, String id, Object a, Object b, Object c) {
        // (the same figures for what's moving: the notification, Settings › Transfers)
        if (("up".equals(t) || "down".equals(t)) && a instanceof Long && b instanceof Long) Moving.update(("up".equals(t) ? "pc-out:" : "pc-in:") + id, (Long) a, (Long) b);
        try {
            JSONObject o = new JSONObject();
            o.put("t", t);
            o.put(key, id);
            if (a != null) o.put(t.endsWith("-done") ? "ok" : (t.equals("up") ? "sent" : "got"), a);
            if (b != null) o.put(t.endsWith("-done") ? (t.startsWith("up") ? "code" : "item") : "total", b);
            if (c != null) o.put("why", c);
            em.emit(o);
        } catch (Throwable e) { /* ignore */ }
    }

    void upload(final String tid, final String id, final String url) {
        uploadFile(tid, null, id, url);
    }

    void uploadPath(final String tid, final String path, final String url) {
        uploadFile(tid, path, null, url);
    }

    // ------------------------------------------------------------ speed, and keeping at it
    // Large files go as several parts at once, each over its own connection (Wi-Fi carries more that way), when the
    // PC understands it (the page adds "parallel=N" to the URL). While any transfer runs, Wi-Fi power saving is held
    // off, the CPU is kept awake, and a foreground service (with its notification) keeps Flick running with the screen
    // off or another app in front. One count for the whole app, under one lock: an activity can be recreated while its
    // transfers carry on.
    static final long PARALLEL_MIN = 8L * 1024 * 1024;
    private static final Object BUSY = new Object();
    private static int active;                         // guarded by BUSY, like the locks
    // Wi-Fi kept out of power saving while files move (its sleep between packets slows every round trip and the whole
    // rate): HIGH_PERF does it with the screen off too (up to Android 13), LOW_LATENCY with Flick on screen (Android 10+)
    private static WifiManager.WifiLock wifiLock, wifiFast;
    private static PowerManager.WakeLock wakeLock;

    private void busy(boolean on) {
        synchronized (BUSY) {
            if (on) {
                if (++active != 1) return;
                try {
                    if (wifiLock == null) {
                        WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                        if (wm != null) {
                            @SuppressWarnings("deprecation")
                            int high = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                            wifiLock = wm.createWifiLock(high, "flick-transfer");
                            wifiLock.setReferenceCounted(false);
                            if (Build.VERSION.SDK_INT >= 29) {
                                wifiFast = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "flick-transfer-fast");
                                wifiFast.setReferenceCounted(false);
                            }
                        }
                    }
                    if (wifiLock != null) wifiLock.acquire();
                    if (wifiFast != null) wifiFast.acquire();
                } catch (Throwable e) { /* speed only */ }
                try {
                    if (wakeLock == null) {
                        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                        if (pm != null) { wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flick:transfer"); wakeLock.setReferenceCounted(false); }
                    }
                    if (wakeLock != null) wakeLock.acquire();
                } catch (Throwable e) { /* the transfer still runs while the phone is awake */ }
                TransferService.want(ctx, true);
            } else {
                if (active == 0 || --active != 0) return;
                try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Throwable e) { /* ignore */ }
                try { if (wifiFast != null && wifiFast.isHeld()) wifiFast.release(); } catch (Throwable e) { /* ignore */ }
                try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Throwable e) { /* ignore */ }
                TransferService.want(ctx, false);
            }
        }
    }

    static int parallelOf(String url) {
        Matcher m = Pattern.compile("[?&]parallel=(\\d+)").matcher(url);
        return m.find() ? Math.max(1, Math.min(8, Integer.parseInt(m.group(1)))) : 1;
    }

    static String withoutParallel(String url) { return url.replaceAll("&parallel=\\d+", "").replaceAll("\\?parallel=\\d+&?", "?"); }

    private void uploadFile(final String tid, final String path, final String id, final String url) {
        final AtomicBoolean abort = new AtomicBoolean(false), stopped = new AtomicBoolean(false);
        AtomicBoolean prev = aborts.put(tid, abort);
        if (prev != null) Watchdog.abort(prev);
        boolean queued = submit(ups, new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                int code = 0;
                String why = null;
                HttpURLConnection c = null;
                Watchdog.Guard g = null;
                InputStream in = null;
                busy(true);
                try {
                    File f = path != null ? new File(path) : lib.file(id);
                    if (path != null && !Files.allowed(f)) throw new IOException("not allowed");
                    if (f == null || !f.exists()) throw new IOException("missing file");
                    long total = f.length();
                    // (listed as moving; its Cancel, from the notification or Settings › Transfers, cuts the connections:
                    // with the page rebuilt meanwhile, nothing else could stop it)
                    Moving.start(ctx, "pc-out:" + tid, "out", pref("lastPc"), pref("lastPcName"), "pc", f.getName(), 1, total);
                    cancelable(tid, abort, stopped);
                    int parts = parallelOf(url);
                    if (parts > 1 && total >= PARALLEL_MIN) {
                        final long[] last = {0};
                        final long tot = total;
                        Parallel.upload(f, withoutParallel(url).replace("/api/upload?", "/api/part?"), parts, abort, new Parallel.Progress() {
                            @Override
                            public void onBytes(long done) {
                                long now = SystemClock.uptimeMillis();
                                synchronized (last) { if (now - last[0] > 150 || done == tot) { last[0] = now; event("up", "tid", tid, done, tot, null); } }
                            }
                        });
                        code = 200;
                        ok = true;
                    } else {
                    c = Parallel.open(withoutParallel(url));          // (never through a network's proxy: see Parallel.open)
                    g = Watchdog.guard(abort, c);
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(Parallel.ANSWER_MAX_MS);              // (what's still on its way at the end: see answer)
                    c.setDoOutput(true);
                    c.setUseCaches(false);
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/octet-stream");
                    c.setFixedLengthStreamingMode(total);
                    OutputStream out = Wire.pieces(g.watch(c.getOutputStream()));
                    in = new FileInputStream(f);
                    byte[] buf = new byte[256 * 1024];
                    long sent = 0, last = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (abort.get()) throw new IOException("aborted");
                        out.write(buf, 0, n);
                        sent += n;
                        long now = SystemClock.uptimeMillis();
                        if (now - last > 150) { last = now; event("up", "tid", tid, sent, total, null); }
                    }
                    out.flush();
                    out.close();
                    g.idle();
                    code = Parallel.answer(c, url);
                    ok = code == 200;
                    try { InputStream r = ok ? c.getInputStream() : c.getErrorStream(); if (r != null) Library.readAll(r, 64 * 1024); } catch (Throwable e) { /* ignore */ }
                    }
                } catch (Throwable e) {
                    why = g != null && g.ended() != null ? g.ended() : e.getMessage();
                } finally {
                    if (g != null) g.close();
                    try { if (in != null) in.close(); } catch (Throwable e) { /* ignore */ }
                    if (c != null) c.disconnect();
                    aborts.remove(tid, abort);
                    Moving.end("pc-out:" + tid, ok, !ok && stopped.get() ? "canceled" : null);
                    busy(false);
                }
                upDone(tid, ok, code, why, !ok && stopped.get());
            }
        });
        if (!queued) { aborts.remove(tid, abort); event("up-done", "tid", tid, false, 0, "closed"); }
    }

    /** Several items and/or folders in one streamed request (see Bundle). */
    void uploadBundle(final String tid, final String itemsJson, final String url) {
        final AtomicBoolean abort = new AtomicBoolean(false), stopped = new AtomicBoolean(false);
        AtomicBoolean prev = aborts.put(tid, abort);
        if (prev != null) Watchdog.abort(prev);
        boolean queued = submit(ups, new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                int code = 0;
                String why = null;
                HttpURLConnection c = null;
                Watchdog.Guard g = null;
                busy(true);
                try {
                    JSONArray arr = new JSONArray(itemsJson);
                    Bundle b = new Bundle();
                    java.util.List<String> names = new java.util.ArrayList<String>();
                    int plain = 0;
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject it = arr.getJSONObject(i);
                        String name = it.optString("name", "");
                        File f;
                        if (it.has("path")) {
                            f = new File(it.getString("path"));
                            if (!Files.allowed(f)) throw new IOException("not allowed");
                        } else {
                            f = lib.file(it.optString("id"));
                        }
                        if (f == null || !f.exists()) throw new IOException("missing " + name);
                        b.add(f, name, abort);
                        names.add(name.length() > 0 ? name : f.getName());
                        if (!f.isDirectory()) plain++;
                    }
                    Moving.start(ctx, "pc-out:" + tid, "out", pref("lastPc"), pref("lastPcName"), "pc", Moving.what(names, arr.length(), plain), b.files, b.bytes);
                    cancelable(tid, abort, stopped);
                    int ways = parallelOf(url);
                    if (ways > 1 && b.bytes >= PARALLEL_MIN && b.files >= 2) {
                        // several files: dealt out over a few connections at once, like one large file's parts
                        final long[] last = {0};
                        Parallel.bundle(b.split(ways), withoutParallel(url) + "&files=" + b.files + "&bytes=" + b.bytes, abort, new Bundle.Progress() {
                            @Override
                            public void onBytes(long sent, long total) {
                                long now = SystemClock.uptimeMillis();
                                synchronized (last) { if (now - last[0] > 150 || sent == total) { last[0] = now; event("up", "tid", tid, sent, total, null); } }
                            }
                        });
                        code = 200;
                        ok = true;
                    } else {
                    c = Parallel.open(withoutParallel(url) + "&files=" + b.files + "&bytes=" + b.bytes);
                    g = Watchdog.guard(abort, c);
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(Parallel.ANSWER_MAX_MS);
                    c.setDoOutput(true);
                    c.setUseCaches(false);
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/x-flick-bundle");
                    c.setChunkedStreamingMode(256 * 1024);
                    OutputStream out = new BufferedOutputStream(Wire.pieces(g.watch(c.getOutputStream())), 256 * 1024);
                    final long[] last = {0};
                    b.write(out, abort, new Bundle.Progress() {
                        @Override
                        public void onBytes(long sent, long total) {
                            long now = SystemClock.uptimeMillis();
                            if (now - last[0] > 150) { last[0] = now; event("up", "tid", tid, sent, total, null); }
                        }
                    });
                    out.close();
                    g.idle();
                    code = Parallel.answer(c, url);
                    ok = code == 200;
                    try { InputStream r = ok ? c.getInputStream() : c.getErrorStream(); if (r != null) Library.readAll(r, 64 * 1024); } catch (Throwable e) { /* ignore */ }
                    }
                } catch (Throwable e) {
                    why = g != null && g.ended() != null ? g.ended() : e.getMessage();
                } finally {
                    if (g != null) g.close();
                    if (c != null) c.disconnect();
                    aborts.remove(tid, abort);
                    Moving.end("pc-out:" + tid, ok, !ok && stopped.get() ? "canceled" : null);
                    busy(false);
                }
                upDone(tid, ok, code, why, !ok && stopped.get());
            }
        });
        if (!queued) { aborts.remove(tid, abort); event("up-done", "tid", tid, false, 0, "closed"); }
    }

    // An upload's Cancel in the notification and Settings › Transfers: it stops at once (its connections cut)
    private static void cancelable(String tid, final AtomicBoolean abort, final AtomicBoolean stopped) {
        Moving.onCancel("pc-out:" + tid, new Runnable() { @Override public void run() { stopped.set(true); Watchdog.abort(abort); } });
    }

    // canceled from the transfer list: the page puts its cards back quietly (no retry, no "couldn't send"), as for a send
    // of the app's own
    private void upDone(String tid, boolean ok, int code, String why, boolean canceled) {
        if (!canceled) { event("up-done", "tid", tid, ok, code, why); return; }
        try {
            JSONObject o = new JSONObject();
            o.put("t", "up-done"); o.put("tid", tid); o.put("ok", false); o.put("code", code); o.put("why", "canceled");
            o.put("final", true); o.put("canceled", true);
            em.emit(o);
        } catch (Throwable e) { /* ignore */ }
    }

    // the PC the page is connected to (or was last): its id and name, as the page keeps them
    private String pref(String k) { try { return Bg.prefs(ctx).getString("p:" + k, ""); } catch (Throwable e) { return ""; } }

    /** Stops an upload now: its connections are cut, so even a write the PC stopped reading ends at once. */
    void abort(String tid) {
        AtomicBoolean a = aborts.get(tid);
        if (a != null) Watchdog.abort(a);
    }

    void download(final String fid, final String rawUrl, final String name, final String sizeHint, final String mime) {
        // the PC it comes from, as it's asked for: the page may switch to another PC while it waits its turn or comes,
        // and History named that one
        final String pcId = pref("lastPc"), pcName = pref("lastPcName");
        boolean queued = submit(downs, new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                JSONObject item = null;
                HttpURLConnection c = null;
                Wire.Call wc = null;
                Watchdog.Guard g = null;
                String why = null;
                final String url = withoutParallel(rawUrl);
                long hint = 0;
                try { hint = Long.parseLong(sizeHint); } catch (Throwable e) { /* unknown */ }
                // listed as moving (its notification, Settings › Transfers); its Cancel cuts the connections, and what
                // arrived of it goes
                final String key = "pc-in:" + fid;
                final AtomicBoolean abort = new AtomicBoolean(false), stopped = new AtomicBoolean(false);
                Moving.start(ctx, key, "in", pcId, pcName, "pc", name, 1, hint > 0 ? hint : -1);
                Moving.onCancel(key, new Runnable() { @Override public void run() { stopped.set(true); Watchdog.abort(abort); } });
                busy(true);
                try {
                    int ways = parallelOf(rawUrl);
                    // straight to the PC when the page's URL is an encrypted link's (or Bluetooth's) local port
                    Object[] direct = Wire.direct(url);
                    // a large file in byte ranges, which carry on from where a cut left them: several at once when the page
                    // asks for that, else one (over Bluetooth, or with "parallel" off), where reading the file straight
                    // through failed on any cut
                    if (hint >= PARALLEL_MIN && Files.granted(ctx) && (ways > 1 || direct != null)) {
                        Files.Incoming dest = Files.reserve(Files.inbox(), name);
                        final long[] last = {0};
                        final long tot = hint;
                        try {
                            Parallel.Progress prog = new Parallel.Progress() {
                                @Override
                                public void onBytes(long done) {
                                    long now = SystemClock.uptimeMillis();
                                    synchronized (last) { if (now - last[0] > 120 || done == tot) { last[0] = now; event("down", "fid", fid, done, tot, null); } }
                                }
                            };
                            if (direct != null) Parallel.downloadDirect((Wire.Link) direct[0], (String) direct[1], dest.part, hint, ways > 1 ? Math.max(ways, 4) : 1, prog, abort);
                            else Parallel.download(url, dest.part, hint, ways, prog, abort);
                        }
                        catch (Throwable e) { dest.cancel(); throw e; }
                        File saved = dest.finish();
                        android.media.MediaScannerConnection.scanFile(ctx, new String[]{saved.getPath()}, null, null);
                        item = Files.fileJson(saved, null);
                        ok = true;
                    } else {
                    final long total;
                    InputStream in;
                    if (direct != null) {
                        // straight to the PC (no hop through the page's local proxy), over a connection kept from the
                        // request before when there is one (a new one when that one went silent)
                        int[] code = new int[1];
                        long[] len = new long[1];
                        wc = Wire.Call.fetch((Wire.Link) direct[0], (String) direct[1], null, 60000, code, len, null);
                        g = Watchdog.guard(abort, wc);           // (its Cancel, or one that stalls, ends it)
                        if (code[0] == 409) Parallel.changed(409, wc.body(len[0]));
                        if (code[0] != 200) throw new IOException("http " + code[0]);
                        total = len[0];
                        in = g.watch(wc.body(total));
                    } else {
                        c = Parallel.open(url);
                        g = Watchdog.guard(abort, c);            // (its Cancel, or one that stalls, ends it)
                        c.setConnectTimeout(5000);
                        c.setReadTimeout(60000);
                        c.setUseCaches(false);
                        int code = c.getResponseCode();
                        if (code == 409) Parallel.changed(409, c.getErrorStream());
                        if (code != 200) throw new IOException("http " + code);
                        total = c.getContentLengthLong();
                        in = g.watch(c.getInputStream());
                    }
                    Library.Progress prog = new Library.Progress() {
                        long last = 0;
                        @Override
                        public boolean onBytes(long got) {
                            long now = SystemClock.uptimeMillis();
                            if (now - last > 120) { last = now; event("down", "fid", fid, got, total, null); }
                            return !stopped.get();
                        }
                    };
                    try {
                        if (Files.granted(ctx)) {
                            // Flick can see shared storage: save straight into Download/Flick like a normal download
                            Files.Incoming dest = Files.reserve(Files.inbox(), name);
                            File saved = null;
                            try {
                                // Android's HttpURLConnection hands out at most 8 KB per read: gather 256 KB per write
                                // (closing flushes it, on every path, before the rename)
                                OutputStream out = new BufferedOutputStream(new java.io.FileOutputStream(dest.part), 256 * 1024);
                                try {
                                    byte[] buf = new byte[256 * 1024];
                                    long got = 0;
                                    int n;
                                    // (stopped: as Library.importStream ends; its connection isn't always cut by then)
                                    while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); got += n; if (!prog.onBytes(got)) throw new IOException("aborted"); }
                                } finally { out.close(); }
                                g.idle();
                                saved = dest.finish();
                            } finally { if (saved == null) dest.cancel(); }
                            android.media.MediaScannerConnection.scanFile(ctx, new String[]{saved.getPath()}, null, null);
                            item = Files.fileJson(saved, null);
                        } else {
                            item = lib.importStream(in, name, mime, prog);
                            g.idle();
                            if (Build.VERSION.SDK_INT >= 29) {
                                try {
                                    File f = lib.file(item.optString("id"));
                                    if (f != null) PublicSave.save(ctx, f, item.optString("name"), item.optString("mime"));
                                } catch (Throwable e) { /* the copy inside Flick still exists */ }
                            }
                        }
                    } finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
                    ok = true;
                    }
                } catch (Throwable e) {
                    why = g != null && g.ended() != null ? g.ended() : e.getMessage();
                } finally {
                    if (g != null) g.close();
                    if (c != null) c.disconnect();
                    if (wc != null) wc.close();
                    boolean space = why != null && (why.contains("ENOSPC") || why.contains("No space"));
                    // (changed: saved again on the PC while it came; what arrived is gone and it isn't fetched again)
                    boolean changed = !ok && !stopped.get() && "changed".equals(why);
                    Moving.end(key, ok, ok ? null : stopped.get() ? "canceled" : space ? "Not enough space on this phone"
                            : changed ? name + " changed on the PC. Send it again." : "It didn’t all arrive");
                    busy(false);
                }
                if (ok && item != null) inHistory(item, pcId, pcName);
                // (stopped here: the page says so, rather than that it couldn't receive it)
                event("down-done", "fid", fid, ok, item, !ok && stopped.get() ? "stopped" : why);
            }
        });
        if (!queued) event("down-done", "fid", fid, false, null, "closed");
    }

    // A file from the PC goes into History here, not by the page: when Android ended the page's renderer with Flick in
    // the background (the activity made again), the page never heard of the file, and History missed it
    private void inHistory(JSONObject item, String pc, String pcName) {
        try {
            if (Bg.history(ctx).add(historyEntry(item, pc, pcName)) != null) Page.historyChanged();
        } catch (Throwable e) { Bg.warn("history", e); }
    }

    /** History's entry for a file that arrived from the PC (item: as the page is told of it), as the page wrote it. */
    static JSONObject historyEntry(JSONObject item, String pc, String pcName) throws org.json.JSONException {
        JSONObject e = new JSONObject();
        e.put("dir", "in");
        String n = item.optString("name", "");
        e.put("name", n.length() > 0 ? n : "File");
        e.put("size", Math.max(0, item.optLong("size", 0)));
        e.put("time", System.currentTimeMillis());
        e.put("pc", pc == null ? "" : pc);
        e.put("pcName", pcName == null ? "" : pcName);
        e.put("how", "pc");
        e.put("ok", true);
        String path = item.optString("path", ""), id = item.optString("id", "");
        if (path.length() > 0) e.put("path", path); else if (id.length() > 0) e.put("libId", id);
        String kind = item.optString("kind", "");
        if (kind.length() > 0) e.put("kind", kind);
        return e;
    }

    /** Copy a file into the phone's public Pictures / Movies / Music / Download folders. */
    @TargetApi(29)
    static final class PublicSave {
        static String save(Context ctx, File f, String name, String mime) throws IOException {
            String m = mime == null ? "application/octet-stream" : mime;
            if (m.startsWith("image/")) return copy(ctx, f, name, m, MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_PICTURES + "/Flick", "Pictures");
            if (m.startsWith("video/")) return copy(ctx, f, name, m, MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_MOVIES + "/Flick", "Movies");
            if (m.startsWith("audio/")) return copy(ctx, f, name, m, MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_MUSIC + "/Flick", "Music");
            return copy(ctx, f, name, m, MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), Environment.DIRECTORY_DOWNLOADS + "/Flick", "Downloads");
        }

        /** A file of a folder from another phone, into Download/Flick/<sub> (sub: its folder there, "Trip/day 1"). */
        static String saveIn(Context ctx, File f, String name, String mime, String sub) throws IOException {
            return copy(ctx, f, name, mime == null ? "application/octet-stream" : mime, MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                Environment.DIRECTORY_DOWNLOADS + "/Flick/" + sub, "Downloads");
        }

        private static String copy(Context ctx, File f, String name, String m, Uri coll, String rel, String label) throws IOException {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, m);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri u = cr.insert(coll, v);
            if (u == null) throw new IOException("insert failed");
            boolean ok = false;
            try {
                OutputStream out = cr.openOutputStream(u);
                if (out == null) throw new IOException("can't write");
                try {
                    InputStream in = new FileInputStream(f);
                    try {
                        byte[] buf = new byte[256 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    } finally {
                        in.close();
                    }
                } finally {
                    out.close();
                }
                ok = true;
            } finally {
                // a copy that didn't finish isn't left behind half-written
                if (!ok) { try { cr.delete(u, null, null); } catch (Throwable e) { /* Android clears it later */ } }
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(u, done, null, null);
            return label + "/Flick";
        }
    }

    // ------------------------------------------------------------ sends that don't come from the page
    /**
     * A send from a tile, the widget or folder sync counts as a transfer too: the same count, locks and service as the
     * page's own (so neither stops the other's). Calls come in pairs (on, then off); any thread.
     */
    static void hold(Context c, boolean on) { new Transfers(c, null, null).busy(on); }

    // Other phones looking for this one (Peers) find it while Flick is on screen: many Wi-Fi chips drop the broadcasts
    // they ask with unless an app asks for them. (A paired phone is reached at its address anyway.)
    private static WifiManager.MulticastLock multicast;
    static void multicast(Context c, boolean on) {
        synchronized (BUSY) {
            try {
                if (on) {
                    if (multicast == null) {
                        WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                        if (wm != null) { multicast = wm.createMulticastLock("flick-peers"); multicast.setReferenceCounted(false); }
                    }
                    if (multicast != null && !multicast.isHeld()) multicast.acquire();
                } else if (multicast != null && multicast.isHeld()) multicast.release();
            } catch (Throwable e) { /* found at its address still */ }
        }
    }
}
