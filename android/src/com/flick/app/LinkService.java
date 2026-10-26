package com.flick.app;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONObject;

/**
 * The background link (setting "Stay connected in the background"): a foreground service of type connectedDevice that
 * holds GET /api/events open to the paired PC while the app is closed, so the PC can reach the phone: its clipboard,
 * links, "find my phone". Reconnects after 1, 2, 5, 10, then every 30 s, and at once when the network changes. Shows a
 * quiet ongoing notification "Flick: connected to <PC>" with Turn off. Runs folder sync every 15 minutes, and sends
 * auto-send's waiting items when the PC comes back. With no paired PC it waits quietly until there is one.
 *
 * Like TransferService it is never stopped from outside before it is up: stop() turns the setting off, and the service
 * itself goes (after startForeground, so Android never sees a foreground service that didn't start).
 */
public class LinkService extends Service {
    static final int NOTE_ID = 21;
    private static final long[] BACKOFF = {1000, 2000, 5000, 10000, 30000};
    private static final long LONG_WAIT = 5 * 60 * 1000L;        // the PC needs an update, a new pairing, or isn't there
    private static final long SYNC_EVERY = 15 * 60 * 1000L;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static LinkService running;                          // main thread only

    private final Object lock = new Object();
    private Thread worker;
    private volatile boolean alive;
    private volatile PcClient.Hold hold;
    private volatile boolean wake;                               // a reason to try again now (network, pairing)
    private volatile String state = "";                          // what the notification says now
    private volatile String pcName = "";
    private volatile long lastSync;
    private ConnectivityManager.NetworkCallback netCb;
    private Network lastNet;
    private SharedPreferences.OnSharedPreferenceChangeListener prefCb;

    // ------------------------------------------------------------ from outside (any thread)
    /** Starts the service if the setting is on (from the page, at boot, after an update). Never throws. */
    static void start(Context c) {
        final Context app = c.getApplicationContext();
        if (!Features.bg(app)) return;
        try {
            Intent i = new Intent(app, LinkService.class);
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i); else app.startService(i);
        } catch (Throwable e) {
            // e.g. ForegroundServiceStartNotAllowedException: Android 12+ won't start one from the background
            Bg.warn("background link", e);
        }
    }

    /** The service is up (main thread). */
    static boolean isRunning() { return running != null; }

    /** Turns the setting off; a running service ends itself. */
    static void stop(Context c) {
        final Context app = c.getApplicationContext();
        Bg.prefs(app).edit().putString(Features.BG, "0").apply();
        MAIN.post(new Runnable() { @Override public void run() { if (running != null) running.shutdown(); } });
    }

    // ------------------------------------------------------------ service
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = this;
        try {
            // started again while running (Flick opened, say): the notification keeps saying what it said
            Notification n;
            try { n = notification(state.length() > 0 ? state : "Flick: connecting to your PC…"); }
            catch (Throwable e) { n = plain(); }
            if (Build.VERSION.SDK_INT >= 29) Api29.foreground(this, n); else startForeground(NOTE_ID, n);
        } catch (Throwable e) {
            Bg.warn("background link refused", e);              // Android didn't allow it now: nothing runs
            running = null;
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!Features.bg(this)) { shutdown(); return START_NOT_STICKY; }
        begin();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        end();
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void shutdown() {
        end();
        if (running == this) running = null;
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable e) { /* ignore */ }
        stopSelf();
    }

    private void begin() {
        synchronized (lock) {
            if (alive && worker != null && worker.isAlive()) return;
            alive = true;
            worker = new Thread(new Runnable() {
                @Override
                public void run() { try { loop(); } catch (Throwable e) { Bg.warn("background link", e); } }
            }, "flick-link");
            worker.setDaemon(true);
            worker.start();
        }
        watchNetwork();
        watchPairing();
    }

    private void end() {
        synchronized (lock) {
            alive = false;
            lock.notifyAll();
        }
        MAIN.removeCallbacks(syncTick);
        PcClient.Hold h = hold;
        if (h != null) h.stop();
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && netCb != null) cm.unregisterNetworkCallback(netCb);
        } catch (Throwable e) { /* ignore */ }
        netCb = null;
        try { if (prefCb != null) Bg.prefs(this).unregisterOnSharedPreferenceChangeListener(prefCb); } catch (Throwable e) { /* ignore */ }
        prefCb = null;
    }

    // ------------------------------------------------------------ the link
    private void loop() {
        int fails = 0;
        while (alive) {
            long wait;
            try {
                if (!Features.bg(this)) { MAIN.post(new Runnable() { @Override public void run() { shutdown(); } }); return; }
                PcClient client = Bg.client(this);
                final PcClient.Target t = client.target();
                pcName = t.name;
                if (fails == 0) show("Flick: connecting to " + t.name + "…");
                hold = new PcClient.Hold();
                if (!alive) break;                               // ended meanwhile: end() stopped this hold or will see it
                final boolean[] opened = {false};
                client.events(t, new PcClient.Events() {
                    @Override
                    public void onEvent(JSONObject e) {
                        if (!opened[0]) { opened[0] = true; connected(t, e); }
                        handle(t, e);
                    }
                }, hold);
                // the PC ended the stream (it's closing, or another stream from this phone replaced this one)
                wait = BACKOFF[0];
                fails = 0;
            } catch (PcClient.Failure f) {
                if (!alive || f.is(PcClient.Failure.ABORTED)) { if (!alive) break; wait = 0; }
                else if (f.is(PcClient.Failure.UNREACHABLE)) {
                    wait = BACKOFF[Math.min(fails, BACKOFF.length - 1)];
                    fails++;
                    show("Flick: looking for " + (pcName.length() > 0 ? pcName : "your PC") + "…");
                } else {
                    // no pairing yet, a new key, a PC that forgot this phone or needs an update: wait (or for pairing)
                    wait = LONG_WAIT;
                    fails = BACKOFF.length;
                    show(f.is(PcClient.Failure.UNPAIRED) ? "Flick: waiting for you to connect a PC"
                            : f.is(PcClient.Failure.OLD) ? "Flick: update Flick on " + pcName + " to stay connected"
                            : "Flick: pair with " + (pcName.length() > 0 ? pcName : "your PC") + " again in the app");
                }
            } catch (Throwable e) {
                Bg.warn("background link", e);
                wait = BACKOFF[BACKOFF.length - 1];
            } finally {
                hold = null;
            }
            pause(wait);
        }
    }

    /** Waits ms, or less when something worth another try happens (network change, pairing, stop). */
    private void pause(long ms) {
        if (ms <= 0) return;
        synchronized (lock) {
            long end = System.currentTimeMillis() + ms;
            while (alive && !wake) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                try { lock.wait(left); } catch (InterruptedException e) { return; }
            }
            wake = false;
        }
    }

    /** Try again now (and drop a link that may lead nowhere after a network change). */
    private void poke(boolean dropLink) {
        PcClient.lookAgain();
        synchronized (lock) { wake = true; lock.notifyAll(); }
        PcClient.Hold h = hold;
        if (dropLink && h != null) h.stop();
    }

    private void connected(PcClient.Target t, JSONObject hello) {
        JSONObject pc = hello.optJSONObject("pc");
        if (pc != null && pc.optString("name", "").length() > 0) pcName = pc.optString("name", "");
        else pcName = t.name;
        show("Flick: connected to " + pcName);
        // the PC is back: what auto-send couldn't send goes now; synced folders catch up if it's been a while
        try {
            AutoSend.kick(this);
            if (System.currentTimeMillis() - lastSync > SYNC_EVERY) { lastSync = System.currentTimeMillis(); SyncManager.syncAll(this); }
            Feedback.flushLater(this);                           // feedback that waited for a connection
        } catch (Throwable e) { Bg.warn("background link", e); }
        MAIN.removeCallbacks(syncTick);
        MAIN.postDelayed(syncTick, SYNC_EVERY);
    }

    private final Runnable syncTick = new Runnable() {
        @Override
        public void run() {
            if (!alive) return;
            lastSync = System.currentTimeMillis();
            try { SyncManager.syncAll(LinkService.this); } catch (Throwable e) { Bg.warn("sync timer", e); }
            MAIN.postDelayed(this, SYNC_EVERY);
        }
    };

    /** One event from the PC. */
    private void handle(PcClient.Target t, JSONObject e) {
        String type = e.optString("t", "");
        PowerManager.WakeLock wl = null;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) { wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flick:event"); wl.acquire(10000); }
        } catch (Throwable x) { wl = null; }
        try {
            if ("clip".equals(type)) FromPc.clip(this, e, pcName);
            else if ("link".equals(type)) FromPc.link(this, e.optString("url", ""), pcName);
            else if ("ring".equals(type)) Ringer.start(this, e.optInt("sec", 30));
            else if ("ring-stop".equals(type)) Ringer.stop(this, "pc");
            else if ("browse".equals(type)) Browse.handle(this, e, t.id);
            else if ("asking".equals(type)) Bg.toast(this, "Waiting for " + pcName + " to accept");   // a PC set to "Ask each time"
        } catch (Throwable x) {
            Bg.warn("event " + type, x);
        } finally {
            try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable x) { /* ignore */ }
        }
    }

    // ------------------------------------------------------------ what wakes it
    private void watchNetwork() {
        if (netCb != null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network n) {
                    boolean changed;
                    synchronized (lock) { changed = lastNet != null && !n.equals(lastNet); lastNet = n; }
                    // a new network: the open link (if any) belongs to the old one
                    poke(changed);
                }
                @Override
                public void onLost(Network n) { poke(false); }
            };
            cm.registerDefaultNetworkCallback(netCb);
        } catch (Throwable e) { Bg.warn("network watch", e); netCb = null; }
    }

    private void watchPairing() {
        if (prefCb != null) return;
        prefCb = new SharedPreferences.OnSharedPreferenceChangeListener() {
            @Override
            public void onSharedPreferenceChanged(SharedPreferences p, String key) {
                if (key == null) return;
                if (key.equals(Features.BG) && !Features.bg(LinkService.this)) { shutdown(); return; }
                // paired, re-paired, or switched to another PC: try now (on another PC, drop the old link)
                if (key.startsWith("p:token:") || key.startsWith("p:pin:")) poke(false);
                else if (key.equals("p:lastPc")) poke(true);
            }
        };
        try { Bg.prefs(this).registerOnSharedPreferenceChangeListener(prefCb); } catch (Throwable e) { prefCb = null; }
    }

    // ------------------------------------------------------------ notification
    private void show(String text) {
        if (text.equals(state)) return;
        state = text;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && alive) nm.notify(NOTE_ID, notification(text));
        } catch (Throwable e) { /* ignore */ }
    }

    @SuppressWarnings("deprecation")
    private Notification notification(String title) {
        Features.channels(this);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, Features.CH_LINK) : new Notification.Builder(this).setPriority(Notification.PRIORITY_MIN);
        PendingIntent open = PendingIntent.getActivity(this, 21, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), Features.piFlags());
        PendingIntent off = PendingIntent.getBroadcast(this, 22, new Intent(this, ActionReceiver.class).setAction(ActionReceiver.BG_OFF), Features.piFlags());
        int icon = Features.icon(this, "ic_stat_flick", android.R.drawable.stat_sys_data_bluetooth);
        return b.setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText("Your PC can send links, its clipboard, or ring this phone")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setLocalOnly(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(this, icon), "Turn off", off).build())
                .build();
    }

    // the simplest notification there is, if building the real one failed (a foreground service must show one)
    @SuppressWarnings("deprecation")
    private Notification plain() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, Features.CH_LINK) : new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentTitle("Flick").setOngoing(true).build();
    }

    @TargetApi(29)
    static final class Api29 {
        static void foreground(Service s, Notification n) { s.startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE); }
    }
}
