package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The PC's side of a synced folder, through PcClient: GET /api/sync/list, GET /api/sync/get, POST /api/sync/put. A
 * failure of the link itself (PC away, not paired, a new certificate) ends the whole run (SyncEngine.Fatal); the PC
 * refusing one file only fails that file. No Android classes, so it runs on any JVM.
 */
final class SyncRemote implements SyncEngine.Remote, SyncEngine.SaysSame {
    private final PcClient client;
    private final PcClient.Target t;
    private final String pair;
    private final AtomicBoolean stop;
    private volatile boolean same;                     // the last put's answer said "same"

    SyncRemote(PcClient client, PcClient.Target t, String pair) { this(client, t, pair, null); }

    /** stop: the run's (Watchdog.abort(stop) cuts the file under way too), or null. */
    SyncRemote(PcClient client, PcClient.Target t, String pair, AtomicBoolean stop) {
        this.client = client;
        this.t = t;
        this.pair = pair;
        this.stop = stop;
    }

    /** POST /api/sync/pair: the PC makes (or finds) "<save folder>/Flick Sync/<name>". Returns {pair, folder}. */
    static JSONObject pair(PcClient client, PcClient.Target t, String name) throws PcClient.Failure {
        return pair(client, t, name, false);
    }

    /**
     * again: the phone makes the pair again on its own (the PC didn't know it): a PC where this folder's sync was
     * stopped answers "stopped" (see stopped) instead of taking it up again, as it does when the user adds the folder.
     */
    static JSONObject pair(PcClient client, PcClient.Target t, String name, boolean again) throws PcClient.Failure {
        JSONObject body = new JSONObject();
        try {
            body.put("name", name);
            if (again) body.put("again", 1);
        } catch (Exception e) { /* can't fail */ }
        JSONObject o = client.post(t, "/api/sync/pair", null, body);
        if (o.optString("pair", "").length() == 0) throw new PcClient.Failure(PcClient.Failure.REFUSED, "no pair id", 200);
        return o;
    }

    /** The PC doesn't know the pair (it was reinstalled, say): it can be made again under the same name. */
    static boolean unknownPair(Throwable e) {
        Throwable f = e instanceof SyncEngine.Fatal && e.getCause() != null ? e.getCause() : e;
        if (!(f instanceof PcClient.Failure)) return false;
        PcClient.Failure x = (PcClient.Failure) f;
        return x.is(PcClient.Failure.REFUSED) && !stopped(x) && (x.code == 400 || x.code == 404 || x.code == 410 || String.valueOf(x.getMessage()).contains("pair"));
    }

    /**
     * The sync was stopped on the PC ("Stop syncing" in its window): not made again (it was, at the next run, and the
     * PC's files flowed on as if never stopped). Older PCs answer "no pair" there, and are paired again as before.
     */
    static boolean stopped(Throwable e) {
        Throwable f = e instanceof SyncEngine.Fatal && e.getCause() != null ? e.getCause() : e;
        if (!(f instanceof PcClient.Failure)) return false;
        PcClient.Failure x = (PcClient.Failure) f;
        return x.is(PcClient.Failure.REFUSED) && x.code == 410 && (PcClient.Failure.REFUSED + ": stopped").equals(x.getMessage());
    }

    @Override
    public Map<String, SyncEngine.Entry> list() throws IOException {
        JSONObject o;
        try { o = client.get(t, "/api/sync/list", "pair=" + PcClient.enc(pair), PcClient.MAX_LIST); }
        catch (PcClient.Failure f) { throw new SyncEngine.Fatal(f.getMessage(), f); }
        JSONArray a = o.optJSONArray("files");
        Map<String, SyncEngine.Entry> m = new HashMap<String, SyncEngine.Entry>();
        if (a == null) return m;
        for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x == null) continue;
            String p = x.optString("p", "");
            long size = x.optLong("size", -1), mtime = x.optLong("mtime", 0);
            if (p.length() == 0 || size < 0) continue;
            m.put(p, new SyncEngine.Entry(size, mtime));
        }
        return m;
    }

    @Override
    public long get(String rel, File dest) throws IOException {
        try { return client.fetch(t, "/api/sync/get", "pair=" + PcClient.enc(pair) + "&p=" + PcClient.enc(rel), dest, stop); }
        catch (PcClient.Failure f) { throw fatal(f) ? new SyncEngine.Fatal(f.getMessage(), f) : f; }
    }

    @Override
    public String put(String rel, File src, long mtime) throws IOException {
        String q = "pair=" + PcClient.enc(pair) + "&p=" + PcClient.enc(rel) + "&mtime=" + mtime + "&size=" + src.length();
        try {
            same = false;
            JSONObject o = client.send(t, "/api/sync/put", q, PcClient.fileSource(src), stop);
            same = o.optBoolean("same", false);
            String stored = o.optString("stored", "");
            return stored.length() == 0 ? rel : stored;
        } catch (PcClient.Failure f) {
            throw fatal(f) ? new SyncEngine.Fatal(f.getMessage(), f) : f;
        }
    }

    // (stopped on the PC meanwhile: the run ends there, rather than each file failing on its own)
    @Override public boolean saidSame() { return same; }

    private static boolean fatal(PcClient.Failure f) { return (!f.is(PcClient.Failure.REFUSED) && !f.is(PcClient.Failure.LOCAL)) || stopped(f); }
}
