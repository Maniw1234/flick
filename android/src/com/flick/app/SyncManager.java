package com.flick.app;

import android.content.Context;
import android.media.MediaScannerConnection;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Synced folders on the phone side: the pairs (SyncPairs, in the app's files folder), one sync at a time on a thread
 * of its own (SyncEngine with SyncRemote), events for the page ({"t":"sync","id","state","done","total","why"?}),
 * the media index told about files that arrived, and history entries (a few per run). A sync runs when the page asks
 * (syncNow, after syncAdd), every 15 minutes while the background link runs, and when that link reconnects.
 */
final class SyncManager {
    static final int HISTORY_PER_RUN = 20;
    private static final ExecutorService RUN = Transfers.pool("flick-sync", 1);
    // pairs waiting for their turn -> whether the page asked (then the PC is looked for at once, see Target.eager)
    private static final ConcurrentHashMap<String, Boolean> QUEUED = new ConcurrentHashMap<String, Boolean>();
    // the pair syncing now -> its stop (a folder removed from sync stops its run, the file under way too)
    private static final ConcurrentHashMap<String, AtomicBoolean> RUNNING = new ConcurrentHashMap<String, AtomicBoolean>();
    private static SyncPairs pairs;

    private SyncManager() {}

    static synchronized SyncPairs pairs(Context c) {
        if (pairs == null) pairs = new SyncPairs(new File(dir(c), "pairs.json"));
        return pairs;
    }

    static File dir(Context c) { return new File(c.getApplicationContext().getFilesDir(), "sync"); }

    static File stateFile(Context c, String id) { return new File(dir(c), "state-" + id + ".json"); }

    /** This phone's name as its PCs and phones know it (Peers keeps it): for "name (from <phone>).ext". */
    private static String phoneName(Context c) {
        String n = null;
        try { n = Bg.prefs(c).getString("devName", null); } catch (Throwable e) { /* below */ }
        return n == null || n.trim().length() == 0 ? Bg.deviceName(c) : n.trim();
    }

    static String listJson(Context c) { return pairs(c).list().toString(); }

    /** Why this phone folder can't be synced, or null. */
    static String folderProblem(Context c, String path) {
        if (path == null || path.length() == 0) return "No folder chosen";
        if (!Files.granted(c)) return "Allow Flick to see your files first";
        File d = new File(path);
        if (!Files.allowed(d)) return "Flick can only sync folders in the phone's storage";
        if (!d.isDirectory()) return "That folder isn't there any more";
        if (!d.canWrite()) return "Flick can't write to that folder";
        return null;
    }

    /** syncAdd: pairs the folder with the PC the app uses now (a pair that exists is just synced) and syncs it. */
    static void add(Context ctx, final String path) {
        final Context c = ctx.getApplicationContext();
        Bg.run("sync add", new Runnable() {
            @Override
            public void run() {
                String why = folderProblem(c, path);
                if (why != null) { event("", "error", 0, 0, why); return; }
                File d = new File(path);
                String canon;
                try { canon = d.getCanonicalPath(); } catch (IOException e) { canon = d.getPath(); }
                PcClient.Target t;
                try { t = Bg.client(c).target(); }
                catch (PcClient.Failure f) { event("", "error", 0, 0, Bg.why(f, null)); return; }
                JSONObject p = pairs(c).find(t.id, canon);
                if (p == null) p = pairs(c).create(t.id, t.name, canon, d.getName());
                String id = p.optString("id", "");
                // stopped on the PC, and the user adds it again: paired anew (the PC takes it up in its folder there)
                if (p.has("stopped")) pairs(c).update(id, "pair", "", "stopped", null, "state", "idle", "why", null);
                event(id, "idle", 0, 0, null);                 // the page re-reads syncPairs(): the pair is there
                queue(c, id, true);
            }
        });
    }

    /** syncRemove: forgets the pair here and asks the PC to stop too (both keep their files). */
    static void remove(Context ctx, final String id) {
        final Context c = ctx.getApplicationContext();
        final JSONObject p = pairs(c).get(id);
        if (p == null) return;
        pairs(c).remove(id);
        // (a run under way stops now; its record is deleted as it ends). Under the id asked with and the pair's own: a
        // pair made while the list couldn't be read goes by another id than the list's (SyncPairs.real)
        String own = p.optString("id", id);
        for (String k : own.equals(id) ? new String[]{id} : new String[]{id, own}) {
            AtomicBoolean run = RUNNING.get(k);
            if (run != null) Watchdog.abort(run);
            stateFile(c, k).delete();
        }
        event(id, "idle", 0, 0, null);
        final String pair = p.optString("pair", "");
        if (pair.length() == 0) return;
        Bg.run("sync remove", new Runnable() {
            @Override
            public void run() {
                try {
                    PcClient client = Bg.client(c);
                    client.post(client.target(p.optString("pc", ""), p.optString("pcName", "")), "/api/sync/unpair", "pair=" + PcClient.enc(pair), null);
                } catch (Throwable e) { Bg.log("sync unpair: " + e); }     // the PC keeps a pair nobody uses: harmless
            }
        });
    }

    /** The background link's timer and reconnects: every pair, one after the other. */
    static void syncAll(Context ctx) { syncAll(ctx, false); }

    /** syncNow (asked: the PC is looked for at once) or the timer: every pair, one after the other. */
    static void syncAll(Context ctx, boolean asked) {
        Context c = ctx.getApplicationContext();
        JSONArray a = pairs(c).list();
        for (int i = 0; i < a.length(); i++) {
            JSONObject p = a.optJSONObject(i);
            if (p != null) queue(c, p.optString("id", ""), asked);
        }
    }

    private static void queue(final Context c, final String id, boolean asked) {
        if (id.length() == 0) return;
        Boolean was = QUEUED.putIfAbsent(id, asked);
        if (was != null) {                                               // already waiting its turn
            // (only while it still waits: put back after its run had taken it out, it stayed, and with it there the
            // folder was never queued again. Taken out just now, its run began without the asking: queued once more)
            if (asked && QUEUED.replace(id, Boolean.TRUE) == null) queue(c, id, true);
            return;
        }
        try {
            RUN.execute(new Runnable() {
                @Override
                public void run() {
                    Boolean eager = QUEUED.remove(id);
                    try { runPair(c, id, eager != null && eager); } catch (Throwable e) { Bg.warn("sync", e); }
                }
            });
        } catch (Throwable e) { QUEUED.remove(id); }
    }

    private static void runPair(final Context c, final String id, boolean eager) {
        final SyncPairs store = pairs(c);
        JSONObject p = store.get(id);
        if (p == null) return;
        // added while the list couldn't be read, and it had the folder already: that pair runs (its record is its id's)
        if (!id.equals(p.optString("id", id))) { queue(c, p.optString("id", ""), eager); return; }
        // stopped on the PC: only the user's Sync now asks it again (the PC says so again, or the sync goes on)
        if (p.has("stopped") && !eager) return;
        final String path = p.optString("path", ""), pcId = p.optString("pc", ""), name0 = p.optString("pcName", "");
        final AtomicBoolean stop = new AtomicBoolean(false);
        RUNNING.put(id, stop);
        // (removed between the look above and now: its run doesn't start)
        if (store.get(id) == null) { RUNNING.remove(id, stop); return; }
        store.update(id, "state", "running", "why", null);
        event(id, "running", 0, 0, null);
        final int[] prog = {0, 0};
        final long[] lastEvent = {0};
        final boolean[] held = {false};
        final int[] hist = {0};
        final List<String> scan = new ArrayList<String>();
        String state = "idle", why = null, stopped = null;
        PcClient.Target t = null;
        try {
            String bad = folderProblem(c, path);
            if (bad != null) throw new IOException(bad);
            PcClient client = Bg.client(c);
            final PcClient.Target target = client.target(pcId, name0);
            target.eager = eager;
            t = target;
            String pair = p.optString("pair", "");
            if (pair.length() == 0) pair = makePair(store, client, t, id, p.optString("name", "Phone"));
            SyncEngine.Listener l = new SyncEngine.Listener() {
                @Override
                public void progress(int done, int total) {
                    prog[0] = done;
                    prog[1] = total;
                    // only a run that moves something counts as a transfer (keeps Flick running, shows "Moving files")
                    if (total > 0 && !held[0]) { held[0] = true; Transfers.hold(c, true); }
                    long now = System.nanoTime() / 1000000L;
                    if (done == total || now - lastEvent[0] > 300) { lastEvent[0] = now; event(id, "running", done, total, null); }
                }
                @Override
                public void received(String rel, File f, File gone) {
                    synchronized (scan) { scan.add(f.getPath()); if (gone != null) scan.add(gone.getPath()); }
                    if (gone == null && hist[0]++ < HISTORY_PER_RUN) {
                        Bg.historyAdd(c, "in", f.getName(), f.length(), f.getPath(), Files.kindOf(f.getName(), Files.mimeOf(f.getName())), "sync", true, target);
                    }
                }
                @Override
                public void sent(String rel, File f, String stored) {
                    if (hist[0]++ < HISTORY_PER_RUN) {
                        Bg.historyAdd(c, "out", f.getName(), f.length(), f.getPath(), Files.kindOf(f.getName(), Files.mimeOf(f.getName())), "sync", true, target);
                    }
                }
            };
            SyncEngine.Result r;
            String me = phoneName(c);
            try {
                r = new SyncEngine(new File(path), new SyncRemote(client, t, pair, stop), stateFile(c, id), t.name, me, l, stop).run();
            } catch (IOException e) {
                // the PC doesn't know this pair any more (Flick was reinstalled there, say): made again, once (unless
                // the PC has this folder's sync stopped: then it says so, see SyncRemote.stopped)
                if (!SyncRemote.unknownPair(e) || stop.get()) throw e;
                pair = makePair(store, client, t, id, p.optString("name", "Phone"), true);
                r = new SyncEngine(new File(path), new SyncRemote(client, t, pair, stop), stateFile(c, id), t.name, me, l, stop).run();
            }
            store.update(id, "last", System.currentTimeMillis(), "files", r.files, "pcName", t.name);
            if (r.failed > 0) {
                state = "error";
                why = r.failed + (r.failed == 1 ? " file" : " files") + " couldn't be synced" + (r.why == null ? "" : " (" + r.why + ")");
            }
        } catch (Throwable e) {
            state = "error";
            if (SyncRemote.stopped(e)) {
                // "Stop syncing" in the PC's window: the pair is kept here, stopped, and not made again on its own (its
                // files stay on both sides); the user adds the folder again to sync it again, or removes it
                stopped = "pc";
                why = "Stopped on " + (t != null ? t.name : name0);
                Bg.log("sync " + id + ": stopped on the PC");
            } else {
                Throwable cause = e instanceof SyncEngine.Fatal && e.getCause() != null ? e.getCause() : e;
                // (a list too long for the phone is the phone's limit, not the PC's refusal)
                why = cause instanceof PcClient.Failure && String.valueOf(cause.getMessage()).endsWith("answer too long")
                        ? "The PC's list of files was too long for the phone"
                        : cause instanceof PcClient.Failure ? Bg.why(cause, t != null ? t.name : name0) : String.valueOf(cause.getMessage());
                Bg.log("sync " + id + ": " + e);
            }
        } finally {
            RUNNING.remove(id, stop);
            if (held[0]) Transfers.hold(c, false);
            if (!scan.isEmpty()) {
                try { MediaScannerConnection.scanFile(c, scan.toArray(new String[0]), null, null); } catch (Throwable e) { /* the index catches up later */ }
            }
        }
        // removed from sync while it ran: what it wrote of its record goes too, and the page heard "idle" already
        if (store.get(id) == null) { stateFile(c, id).delete(); return; }
        store.update(id, "state", state, "why", why, "stopped", stopped);
        event(id, state, prog[0], prog[1], why);
    }

    private static String makePair(SyncPairs store, PcClient client, PcClient.Target t, String id, String name) throws IOException {
        return makePair(store, client, t, id, name, false);
    }

    private static String makePair(SyncPairs store, PcClient client, PcClient.Target t, String id, String name, boolean again) throws IOException {
        JSONObject o = SyncRemote.pair(client, t, name, again);
        String pair = o.optString("pair", "");
        store.update(id, "pair", pair, "folder", o.optString("folder", ""));
        return pair;
    }

    private static void event(String id, String state, int done, int total, String why) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "sync");
            o.put("id", id);
            o.put("state", state);
            o.put("done", done);
            o.put("total", total);
            if (why != null) o.put("why", why);
            Page.emit(o);
        } catch (Throwable e) { /* ignore */ }
    }
}
