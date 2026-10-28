package com.flick.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Shared pieces of Flick's background features (no page needed): the client that reaches the paired PC, the history,
 * a thread pool, toasts, and the words for why something couldn't be sent.
 */
final class Bg {
    static final String TAG = "Flick";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // small jobs (a clipboard from the PC, a link, the checks when Flick comes to the front): never on the main thread,
    // never waiting behind a sync or a send
    static final ExecutorService POOL = Transfers.pool("flick-bg", 2);
    // sends to the PC (the newest photo, a clipboard, auto-send): a slow one never holds up the small jobs
    static final ExecutorService SENDS = Transfers.pool("flick-bg-send", 2);

    private static PcClient client;
    private static HistoryStore history;

    private Bg() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("flick", 0); }

    static synchronized PcClient client(Context c) {
        if (client == null) {
            final Context app = c.getApplicationContext();
            final SharedPreferences p = prefs(app);
            client = new PcClient(new PcClient.Env() {
                @Override public String pref(String key) { try { return p.getString(key, null); } catch (Throwable e) { return null; } }
                @Override public void setPref(String key, String value) { p.edit().putString(key, value).apply(); }
                @Override public String[] discover(String pcId, int ms) { return Bg.discover(app, pcId, ms); }
                @Override public void log(String msg) { Log.i(TAG, msg); }
            });
        }
        return client;
    }

    static synchronized HistoryStore history(Context c) {
        if (history == null) history = new HistoryStore(new File(c.getApplicationContext().getFilesDir(), "history.json"));
        return history;
    }

    /** A transfer Flick made by itself (auto-send, tile, widget, sync) goes into the history; the page is told. */
    static void historyAdd(Context c, String dir, String name, long size, String path, String kind, String how, boolean ok, PcClient.Target t) {
        historyAdd(c, dir, name, size, path, kind, how, ok, t, null);
    }

    /** historyAdd() with why it didn't go: "declined" or "timeout" (see declined()), or null. */
    static void historyAdd(Context c, String dir, String name, long size, String path, String kind, String how, boolean ok, PcClient.Target t, String why) {
        try {
            JSONObject e = new JSONObject();
            e.put("dir", dir);
            e.put("name", name);
            e.put("size", size);
            e.put("time", System.currentTimeMillis());
            if (t != null) { e.put("pc", t.id); e.put("pcName", t.name); }
            if (path != null && path.length() > 0) e.put("path", path);
            if (kind != null && kind.length() > 0) e.put("kind", kind);
            e.put("how", how);
            e.put("ok", ok);
            if (why != null) e.put("why", why);
            history(c).add(e);
            Page.historyChanged();
        } catch (Throwable x) { Log.w(TAG, "history: " + x); }
    }

    static String deviceId(Context c) {
        try { return prefs(c).getString("device", null); } catch (Throwable e) { return null; }
    }

    static String deviceName(Context c) {
        String n = null;
        try { n = Settings.Global.getString(c.getContentResolver(), Settings.Global.DEVICE_NAME); } catch (Throwable e) { /* ignore */ }
        if (n == null || n.trim().length() == 0) n = Build.MODEL == null ? "Android" : Build.MODEL;
        return n.trim();
    }

    /** A short discovery (Discovery.java) for the PC with this id: {ip, port} of its fastest address, or null. */
    static String[] discover(Context c, final String pcId, int ms) {
        String dev = deviceId(c);
        if (dev == null || pcId == null) return null;
        final String[] hit = new String[2];
        final CountDownLatch found = new CountDownLatch(1);
        // Runs in the background on whatever network the phone joins: it asks for the PC without saying who this phone
        // is (a fresh random id each time, no name), so nobody on a café's Wi-Fi can follow it around
        byte[] r = new byte[8];
        new java.security.SecureRandom().nextBytes(r);
        StringBuilder anon = new StringBuilder("q");
        for (byte x : r) anon.append(String.format("%02x", x));
        Discovery d = new Discovery(c, anon.toString(), "", new Discovery.Listener() {
            @Override
            public void onPcs(String json) {
                try {
                    JSONArray a = new JSONArray(json);
                    for (int i = 0; i < a.length(); i++) {
                        JSONObject pc = a.getJSONObject(i);
                        if (!pcId.equals(pc.optString("id")) || pc.optInt("tls", 0) != 1) continue;
                        synchronized (hit) { hit[0] = pc.optString("ip"); hit[1] = String.valueOf(pc.optInt("port", 47860)); }
                        found.countDown();
                    }
                } catch (Throwable e) { /* ignore */ }
            }
        });
        try {
            d.setActive(true);
            found.await(ms, TimeUnit.MILLISECONDS);
        } catch (Throwable e) { /* nothing found */ }
        finally { d.setActive(false); }
        synchronized (hit) { return hit[0] == null || hit[0].length() == 0 ? null : new String[]{hit[0], hit[1]}; }
    }

    /** A content:// item as something PcClient can send (reopened for each attempt). */
    static PcClient.Source uriSource(Context c, final Uri u, final long size) {
        final ContentResolver cr = c.getApplicationContext().getContentResolver();
        return new PcClient.Source() {
            @Override
            public InputStream open() throws IOException {
                InputStream in = cr.openInputStream(u);
                if (in == null) throw new IOException("gone");
                return in;
            }
            @Override public long length() { return size; }
        };
    }

    static void main(Runnable r) { MAIN.post(r); }
    static void mainDelayed(Runnable r, long ms) { MAIN.postDelayed(r, ms); }
    static void mainCancel(Runnable r) { MAIN.removeCallbacks(r); }

    static void toast(final Context c, final String msg) {
        final Context app = c.getApplicationContext();
        MAIN.post(new Runnable() {
            @Override public void run() { try { Toast.makeText(app, msg, Toast.LENGTH_SHORT).show(); } catch (Throwable e) { /* ignore */ } }
        });
    }

    /** Runs r off the main thread; whatever it throws is logged, never a crash. False if it couldn't be started. */
    static boolean run(String what, Runnable r) { return runOn(POOL, what, r); }

    /** run() for a send to the PC (it can take minutes): on its own threads. */
    static boolean send(String what, Runnable r) { return runOn(SENDS, what, r); }

    private static boolean runOn(ExecutorService pool, final String what, final Runnable r) {
        try {
            pool.execute(new Runnable() {
                @Override public void run() { try { r.run(); } catch (Throwable e) { Log.w(TAG, what + ": " + e, e); } }
            });
            return true;
        } catch (Throwable e) {
            Log.w(TAG, what + ": " + e);
            return false;
        }
    }

    /** Words for why something couldn't go to the PC. */
    static String why(Throwable e, String pcName) {
        String pc = pcName == null || pcName.length() == 0 ? "your PC" : pcName;
        if (e instanceof PcClient.Failure) {
            PcClient.Failure f = (PcClient.Failure) e;
            if (f.is(PcClient.Failure.UNPAIRED)) return "Connect Flick to your PC first";
            if (f.is(PcClient.Failure.UNREACHABLE)) return "Couldn't reach " + pc;
            if (f.is(PcClient.Failure.PIN)) return pc + " has a new security key: pair again in Flick";
            if (f.is(PcClient.Failure.DENIED)) return pc + " doesn't know this phone any more: pair again in Flick";
            if (f.is(PcClient.Failure.OLD)) return "Update Flick on " + pc + " first";
            if (f.is(PcClient.Failure.LOCAL)) return "Couldn't read the file";
            if (f.is(PcClient.Failure.ABORTED)) return "Stopped";
            String no = declined(e);
            if ("declined".equals(no)) return pc + " declined it";
            if ("timeout".equals(no)) return "Not accepted on " + pc + " in time";
            return pc + " couldn't take it";
        }
        return "Couldn't send it to " + pc;
    }

    /**
     * "declined" when the PC's user said no to a file (the PC is set to "Ask each time" for this phone), "timeout" when
     * nobody answered there within a minute; null for any other outcome. Sending it again would only ask again.
     */
    static String declined(Throwable e) {
        if (!(e instanceof PcClient.Failure)) return null;
        PcClient.Failure f = (PcClient.Failure) e;
        if (!f.is(PcClient.Failure.REFUSED) || f.code != 409) return null;
        String m = String.valueOf(f.getMessage());
        return m.endsWith(": declined") ? "declined" : m.endsWith(": timeout") ? "timeout" : null;
    }

    static void log(String msg) { Log.i(TAG, msg); }
    static void warn(String msg, Throwable e) { Log.w(TAG, msg + ": " + e); }
}
