package com.flick.app;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Keeps Flick running while files move, with the screen off or another app in front: a foreground service. Its
 * notification shows a transfer, Bluetooth style ("Sending IMG_2041.jpg" / "To Alex's PC · 45% · 12 MB of 26 MB", a
 * progress bar, Cancel), and each other transfer under way has one of its own (Moving says what moves). Transfers (and
 * Sends) turn it on when the first transfer starts and off when the last one ends, so it never runs while nothing moves.
 * When Android won't allow it (Android 12+ refuses to start one while Flick is in the background), transfers simply carry
 * on without it, each with its own notification. One that ends while Flick isn't on screen leaves a short note
 * ("Received IMG_2041.jpg" / "From Pixel 7"; what ends from one device in a row is one note) that opens Flick.
 *
 * It is never stopped from outside: stopping a service started with startForegroundService() before it has called
 * startForeground() crashes the app, so the service itself goes once it is up and no transfer wants it.
 */
public class TransferService extends Service {
    private static final int ID = 1;
    private static final String CHANNEL = "transfers";
    private static final long LINGER_MS = 3000;    // back-to-back transfers share one service (and notification)
    // a transfer's own notification (while the service's shows another), and the notes of what finished
    private static final int OWN = 2000, OWNS = 200, DONE = 2300, DONES = 20;
    private static final int MAX_OWN = 5;          // more at once wait for a place (Settings lists them all)
    private static final long BATCH_MS = 20000;    // what ends this soon after the last from the same device joins its note

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // main thread only
    private static final Set<String> HOLDERS = new HashSet<String>();   // who wants it: "transfers", "sends"
    private static boolean wanted;                  // some transfer is running
    private static boolean starting;                // asked Android to start it; onStartCommand not seen yet
    private static TransferService running;
    private static final Map<String, Integer> own = new HashMap<String, Integer>();   // transfer -> its own notification
    private static int nextOwn, nextDone;
    private static String fgKey;                    // the transfer the service's notification shows (null: none)
    private static Done fgDone;                     // or how the last one ended (nothing else moving)
    private static boolean fgDoneLeft;              // ...left showing when the service went (put aside when it's back)
    private static final Map<String, Done> dones = new HashMap<String, Done>();     // notes lately, by device and outcome
    private static boolean asked;                   // asked to show notifications (Android 13+), this process
    // Android drops an app's notification updates past about five a second: what's posted here goes out at most five in
    // any second, all told. How far a transfer got goes at a steady pace (one every third of a second at most); what
    // changed (one ended, the service's notification moves to another) may go three at once. What can't go yet waits its
    // turn, changes first, a newer one for the same notification taking its place meanwhile: what a run of transfers
    // ending says isn't lost.
    private static final long EVERY_MS = 334, BURST = 3;
    private static final Map<Integer, Waiting> queued = new LinkedHashMap<Integer, Waiting>();   // id -> what's next
    private static long due, flushAt;               // when the next post is due at the steady pace; the flush asked for (0: none)
    private static Context poster;                  // (the app's: what the flush posts with)

    private static final class Waiting {
        Notification n;
        boolean change;                             // not only how far it got (see post)
        Waiting(Notification n, boolean change) { this.n = n; this.change = change; }
    }

    /** A note of what finished: one transfer, or several in a row from (or to) one device. */
    private static final class Done {
        int id = -1;                                // its notification (ID while it is the service's)
        int count, files;
        long at;
        Moving.Item last;
        boolean keep;                               // stays after the service goes (Flick wasn't on screen)
    }

    /** Any thread: transfers are running (on) or all finished (off). Never throws. */
    static void want(Context c, final boolean on) { want(c, "transfers", on); }

    /** Any thread: who (one of several users of the service) needs it now (on) or not any more (off). */
    static void want(Context c, final String who, final boolean on) {
        final Context app = c.getApplicationContext();
        MAIN.post(new Runnable() {
            @Override
            public void run() {
                if (on) HOLDERS.add(who); else HOLDERS.remove(who);
                wanted = !HOLDERS.isEmpty();
                MAIN.removeCallbacks(STOP);
                if (!wanted) {
                    if (running != null) MAIN.postDelayed(STOP, LINGER_MS);
                    return;
                }
                if (running != null || starting) return;
                try {
                    Intent i = new Intent(app, TransferService.class);
                    Api26.start(app, i);
                    starting = true;
                } catch (Throwable e) {
                    // e.g. ForegroundServiceStartNotAllowedException: Flick is in the background on Android 12+
                }
            }
        });
    }

    private static final Runnable STOP = new Runnable() {
        @Override
        public void run() {
            TransferService s = running;
            if (!wanted && s != null) s.end();
        }
    };

    private void end() {
        if (running == this) running = null;
        String k = fgKey;
        Done d = fgDone;
        fgKey = null;
        boolean keep = d != null && d.keep;
        // a note of what ended stays (as a plain notification now: it can be swiped away)
        try { stopForeground(keep ? STOP_FOREGROUND_DETACH : STOP_FOREGROUND_REMOVE); } catch (Throwable e) { /* ignore */ }
        if (!keep) queued.remove(ID);               // (gone with the service: nothing waiting brings it back)
        if (keep) { fgDoneLeft = true; post(this, ID, finished(this, d)); } else fgDone = null;
        stopSelf();
        // a transfer that outlived what held the service keeps a notification of its own
        Moving.Item it = k == null ? null : Moving.get(k);
        if (it != null) show(getApplicationContext(), it);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        starting = false;
        running = this;
        Moving.Item it = null;
        Done d = null;
        try {
            // (a note left showing from last time goes to a notification of its own: this one is the service's again)
            if (fgDoneLeft) { fgDoneLeft = false; Done l = fgDone; fgDone = null; if (l != null && active(this, ID)) aside(this, l); }
            it = first(null);
            // (nothing under way: a note of one that was over before the service came up takes its place)
            d = it == null ? latest() : null;
            Notification n = it != null ? build(this, it, false) : d != null ? finished(this, d) : plain(this);
            if (Build.VERSION.SDK_INT >= 29) Api29.foreground(this, n); else startForeground(ID, n);
            // (a post like any other; what was waiting for its place is out of date)
            due = Math.max(due, SystemClock.elapsedRealtime()) + EVERY_MS;
            queued.remove(ID);
        } catch (Throwable e) {
            end();                                   // Android refused: the transfers go on without it
            return START_NOT_STICKY;
        }
        if (it != null) { fgKey = it.key; Integer o = own.remove(it.key); if (o != null) cancel(this, o); }
        if (d != null) { cancel(this, d.id); d.id = ID; fgDone = d; }
        if (!wanted) { MAIN.removeCallbacks(STOP); MAIN.postDelayed(STOP, LINGER_MS); }   // they finished meanwhile
        return START_NOT_STICKY;
    }

    /**
     * Android 15 and newer allow a data-sync service about 6 hours a day: then it has to stop, or the app is closed.
     * The transfers go on without it (as when Android refuses to start it), with a notification of their own.
     * (The one with the type is Android 15's, the other Android 14's. No @Override: Flick is built against Android 16's
     * classes, which have both, and still compiles against older ones, set with AJ in build_apk.sh, which don't.)
     */
    public void onTimeout(int startId, int fgsType) { onTimeout(startId); }

    public void onTimeout(int startId) {
        try { end(); } catch (Throwable e) { try { stopSelf(); } catch (Throwable x) { /* ignore */ } }
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------ the transfers' notifications (main thread)
    /** A transfer's notification is due (Moving paces these): in the service's, or one of its own. */
    static void show(Context app, Moving.Item it) {
        // (it ended since this was paced: its end came here first, or is on its way, and nothing may bring it back)
        if (Moving.get(it.key) == null) return;
        TransferService s = running;
        // paused: nothing moves, no notification; waiting: only while the service keeps Flick going for it
        if ("paused".equals(it.state) || ("waiting".equals(it.state) && s == null)) { hide(app, it.key); return; }
        if (s != null && (fgKey == null || fgKey.equals(it.key))) { s.mirror(it, false); return; }
        Integer id = own.get(it.key);
        boolean fresh = id == null;
        if (fresh) {
            // files only announced (none came yet), or more than a few at once: no notification of their own yet (a
            // paired device announcing sends that never come doesn't fill the shade)
            if (("in".equals(it.dir) && it.done <= 0) || own.size() >= MAX_OWN) return;
            // the next one no transfer has now (one going for longer than hundreds of others keeps its own)
            do { id = OWN + nextOwn; nextOwn = (nextOwn + 1) % OWNS; } while (own.containsValue(id));
            own.put(it.key, id);
        }
        post(app, id, build(app, it, true), fresh);       // (one showing up goes before how far others got)
    }

    /** A transfer ended: its notification goes; with Flick not on screen a note says how it went. */
    static void ended(Context app, Moving.Item it, boolean front) {
        Integer id = own.remove(it.key);
        if (id != null) cancel(app, id);
        if (front && it.ok) askLater(app);
        // (canceled here: nothing to tell; canceled on the other device: the user didn't, so it says so)
        boolean keep = !front && (!"canceled".equals(it.why) || it.there != null);
        Done d = keep ? note(app, it) : null;
        TransferService s = running;
        if (s != null && it.key.equals(fgKey)) fgKey = null;
        if (s != null && fgKey == null && (d != null || fgDone == null || !fgDone.keep)) {
            Moving.Item next = first(it.key);
            if (next != null) s.mirror(next, true);
            else {
                // nothing else moves: the service's notification says how it went until the service goes (and a note
                // that's kept stays after that)
                if (d == null) { d = new Done(); d.count = 1; d.files = Math.max(1, it.files); d.last = it; }
                if (fgDone != null && fgDone != d && fgDone.keep) aside(s, fgDone);
                if (d.id >= DONE) cancel(app, d.id);                    // (the note of its row moves here)
                fgDone = d;
                d.id = ID;
                post(s, ID, finished(s, d));
                return;
            }
        }
        if (d == null) return;
        if (d == fgDone && d.id == ID) { post(app, ID, finished(app, d)); return; }   // (the service's, or left there)
        if (d.id < DONE) d.id = DONE + (nextDone++ % DONES);
        post(app, d.id, finished(app, d));
    }

    // the service's notification shows this transfer (what it showed before gets a notification of its own, if it stays);
    // change: the one it showed ended or went (else it's how far one got, or that one going now)
    private void mirror(Moving.Item it, boolean change) {
        if (fgDone != null) { if (fgDone.keep) aside(this, fgDone); fgDone = null; }
        fgKey = it.key;
        Integer o = own.remove(it.key);
        if (o != null) cancel(this, o);
        post(this, ID, build(this, it, false), change);
    }

    private static void hide(Context app, String key) {
        Integer id = own.remove(key);
        if (id != null) cancel(app, id);
        TransferService s = running;
        if (s == null || !key.equals(fgKey)) return;
        fgKey = null;
        Moving.Item next = first(key);
        if (next != null) s.mirror(next, true); else post(s, ID, plain(s));
    }

    // the first transfer under way that shows (not skip), or null
    private static Moving.Item first(String skip) {
        boolean up = running != null;
        for (Moving.Item it : Moving.live()) {
            if (it.key.equals(skip) || "paused".equals(it.state) || ("waiting".equals(it.state) && !up)) continue;
            return it;
        }
        return null;
    }

    // the note it joins: the one of its row (same device, same way, same outcome, the last of them moments ago and
    // still showing), or a new one
    private static Done note(Context c, Moving.Item it) {
        String g = it.dir + "\n" + it.device + "\n" + it.ok + "\n" + "canceled".equals(it.why);   // (stopped isn't failed)
        long t = SystemClock.elapsedRealtime();
        Done d = dones.get(g);
        if (d == null || t - d.at > BATCH_MS || !((d == fgDone && running != null) || active(c, d.id))) {
            for (Iterator<Done> i = dones.values().iterator(); i.hasNext(); ) if (t - i.next().at > BATCH_MS) i.remove();
            d = new Done();
            d.keep = true;
            dones.put(g, d);
        }
        d.count++;
        d.files += Math.max(1, it.files);
        d.at = t;
        d.last = it;
        return d;
    }

    // the newest note that's kept, from moments ago and still showing, or null
    private static Done latest() {
        long t = SystemClock.elapsedRealtime();
        Done best = null;
        for (Done d : dones.values()) if (d.keep && d.id >= DONE && t - d.at < LINGER_MS && (best == null || d.at > best.at)) best = d;
        return best != null && running != null && active(running, best.id) ? best : null;
    }

    // a note the service's notification showed gets one of its own
    private static void aside(Context c, Done d) {
        if (d == fgDone) fgDone = null;
        d.id = DONE + (nextDone++ % DONES);
        post(c, d.id, finished(c, d));
    }

    // ------------------------------------------------------------ what they say
    // a transfer under way: "Sending IMG_2041.jpg" / "To Alex's PC · 45% · 12 MB of 26 MB", its bar, Cancel (own: its
    // own notification, not the service's)
    static Notification build(Context c, Moving.Item it, boolean own) {
        boolean in = "in".equals(it.dir), waiting = "waiting".equals(it.state);
        // (nothing moved yet: starting, the bar sliding, rather than "0 bytes of 26 MB")
        int pct = it.done > 0 ? it.pct() : -1;
        String dev = iso(who(it)), text;
        if (waiting) text = "Waiting for " + dev + ("pc".equals(it.kind) && !in ? " · it carries on when it’s back" : "");
        else {
            text = (in ? "From " : "To ") + dev;
            if (pct >= 0) text += " · " + pct + "% · " + size(Math.min(it.done, it.total)) + " of " + size(it.total);
            else text += it.done > 0 ? " · " + size(it.done) : " · Starting…";
        }
        Notification.Builder b = builder(c)
                .setSmallIcon(in ? android.R.drawable.stat_sys_download : android.R.drawable.stat_sys_upload)
                .setContentTitle((in ? "Receiving " : "Sending ") + iso(it.name))
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setShowWhen(false)
                .setLocalOnly(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setContentIntent(open(c));
        if (it.current != null && !it.current.equals(it.name)) b.setSubText(it.current);      // (the file of a batch going now)
        if (pct >= 0) b.setProgress(100, pct, false);
        else if (!waiting) b.setProgress(0, 0, true);                   // until its size is known
        if (it.cancelable) b.addAction(new Notification.Action.Builder(Icon.createWithResource("android", android.R.drawable.ic_menu_close_clear_cancel), "Cancel", cancelIntent(c, it.key)).build());
        if (own) Api26.timeout(b, 10 * 60000L);   // (one a stopped Flick left behind goes by itself)
        if (Build.VERSION.SDK_INT >= 31) Api31.now(b);
        return b.build();
    }

    // how it went: "Received IMG_2041.jpg" / "From Pixel 7" ("Received 12 files" for several in a row)
    private static Notification finished(Context c, Done d) {
        Moving.Item it = d.last;
        boolean in = "in".equals(it.dir), canceled = "canceled".equals(it.why);
        String what = d.count > 1 ? String.format(Locale.US, "%,d files", d.files) : iso(it.name);
        String title = (it.ok ? (in ? "Received " : "Sent ") : canceled ? (in ? "Stopped receiving " : "Stopped sending ") : in ? "Couldn’t receive " : "Couldn’t send ") + what;
        // (one canceled on the other device says so: "Canceled on Pixel 7", which names it too)
        String text = canceled && it.there != null && d.count == 1 ? it.there : (in ? "From " : "To ") + iso(who(it));
        Notification.Builder b = builder(c)
                .setSmallIcon(!it.ok && !canceled ? android.R.drawable.stat_notify_error : in ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_upload_done)
                .setContentTitle(title)
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setShowWhen(true)
                .setWhen(it.ended > 0 ? it.ended : System.currentTimeMillis())
                .setLocalOnly(true)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .setContentIntent(open(c));
        // (why it didn't go, when there are words for it: shown when the note is opened out)
        if (!it.ok && !canceled && it.why != null && d.count == 1) b.setStyle(new Notification.BigTextStyle().bigText(text + "\n" + it.why));
        if (Build.VERSION.SDK_INT >= 31) Api31.now(b);
        return b.build();
    }

    // the service's own words, while it holds Flick for something that isn't a transfer listed (or nothing yet)
    private static Notification plain(Context c) {
        Notification.Builder b = builder(c)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Flick")
                .setContentText("Moving files with your PC")
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setShowWhen(false)
                .setLocalOnly(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setContentIntent(open(c));
        if (Build.VERSION.SDK_INT >= 31) Api31.now(b);
        return b.build();
    }

    private static String who(Moving.Item it) {
        String n = it.deviceName == null ? "" : it.deviceName;
        return n.length() > 0 ? n : "pc".equals(it.kind) ? "your PC" : "the other phone";
    }

    // a name kept apart from the words around it (a Hebrew or Arabic one doesn't reorder them)
    private static String iso(String s) { return "\u2068" + s + "\u2069"; }

    static String size(long n) {
        if (n < 1024) return n + " bytes";
        if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024.0)) + " KB";
        if (n < 1024L * 1024 * 1024) return String.format(Locale.US, n < 10 * 1048576L ? "%.1f MB" : "%.0f MB", n / 1048576.0);
        return String.format(Locale.US, "%.1f GB", n / 1073741824.0);
    }

    private static PendingIntent open(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // (each transfer's own: the key in its address keeps one from replacing another's)
    private static PendingIntent cancelIntent(Context c, String key) {
        Intent i = new Intent(c, ActionReceiver.class).setAction(ActionReceiver.MOVING_CANCEL).setData(Uri.fromParts("flick", key, null)).putExtra("key", key);
        return PendingIntent.getBroadcast(c, 0, i, Features.piFlags());
    }

    // (main thread) a change (see EVERY_MS): at once, or when its turn comes
    private static void post(Context c, int id, Notification n) { post(c, id, n, true); }

    // change: not only how far a transfer got
    private static void post(Context c, int id, Notification n, boolean change) {
        long now = SystemClock.elapsedRealtime();
        poster = c.getApplicationContext();
        Waiting w = queued.get(id);
        if (w != null) { w.n = n; w.change |= change; }                // (its place in line, with the newest words)
        else if (dueAt(now, change) <= now && !waiting(change)) { postNow(c, id, n, now); return; }
        else queued.put(id, new Waiting(n, change));
        flushLater(now);
    }

    private static void postNow(Context c, int id, Notification n, long now) {
        due = Math.max(due, now) + EVERY_MS;
        queued.remove(id);
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, n);
        } catch (Throwable e) { /* the notification only */ }
    }

    // when one may go: how far a transfer got, at the steady pace; a change, also on what a moment allows besides
    private static long dueAt(long now, boolean change) { return Math.max(now, change ? due - (BURST - 1) * EVERY_MS : due); }

    // something waits that goes before a post of this kind
    private static boolean waiting(boolean change) {
        if (!change) return !queued.isEmpty();
        for (Waiting w : queued.values()) if (w.change) return true;
        return false;
    }

    // the one to go next: the change waiting longest, else what waits longest
    private static Integer next() {
        for (Map.Entry<Integer, Waiting> e : queued.entrySet()) if (e.getValue().change) return e.getKey();
        return queued.isEmpty() ? null : queued.keySet().iterator().next();
    }

    private static void flushLater(long now) {
        Integer id = next();
        if (id == null) return;
        long at = dueAt(now, queued.get(id).change);
        if (flushAt != 0 && flushAt <= at) return;
        flushAt = at;
        MAIN.removeCallbacks(FLUSH);
        MAIN.postDelayed(FLUSH, Math.max(0, at - now));
    }

    // what's waiting goes, one at a time
    private static final Runnable FLUSH = new Runnable() {
        @Override public void run() {
            flushAt = 0;
            Integer id = next();
            if (id == null || poster == null) return;
            long now = SystemClock.elapsedRealtime();
            Waiting w = queued.get(id);
            if (dueAt(now, w.change) <= now) postNow(poster, id, w.n, now);
            flushLater(now);
        }
    };

    private static void cancel(Context c, int id) {
        queued.remove(id);                          // (and nothing waiting brings it back)
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(id);
        } catch (Throwable e) { /* ignore */ }
    }

    // the notification id is showing (not swiped away), or about to
    private static boolean active(Context c, int id) {
        if (id < 0) return false;
        if (queued.containsKey(id)) return true;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            for (StatusBarNotification n : nm.getActiveNotifications()) if (n.getId() == id) return true;
        } catch (Throwable e) { /* as if not */ }
        return false;
    }

    /**
     * What a Flick that stopped mid-transfer left behind: a transfer's own notifications go, and a note left in the
     * service's place gets a place of its own (the service's is overwritten when it next starts). Once, as Flick starts.
     */
    static void clearLeft(final Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            for (StatusBarNotification n : nm.getActiveNotifications()) {
                int id = n.getId();
                if (id >= OWN && id < OWN + OWNS) nm.cancel(id);
                else if (id == ID && n.getNotification() != null && (n.getNotification().flags & Notification.FLAG_FOREGROUND_SERVICE) == 0) {
                    final Notification left = n.getNotification();
                    MAIN.post(new Runnable() {
                        @Override public void run() {
                            if (running != null || starting) return;    // (the service has the place already)
                            post(c, DONE + (nextDone++ % DONES), left);
                            cancel(c, ID);
                        }
                    });
                }
            }
        } catch (Throwable e) { /* only tidying */ }
    }

    // Android 13+: asks once whether Flick may show notifications, after the first transfer that went while Flick was in
    // front (not as it starts: a card may still be under the user's finger)
    private static void askLater(final Context app) {
        if (asked || Build.VERSION.SDK_INT < 33) return;
        asked = true;
        MAIN.postDelayed(new Runnable() {
            @Override public void run() {
                MainActivity a = Page.get();
                if (a == null || !Page.inFront() || Features.notifyPerm(app)) { asked = Features.notifyPerm(app); return; }
                if ("1".equals(Bg.prefs(app).getString("f:askedNotifyXfer", "0"))) return;
                Bg.prefs(app).edit().putString("f:askedNotifyXfer", "1").apply();
                Page.askNotifications(a);
            }
        }, 1200);
    }

    private static boolean channelMade;

    private static Notification.Builder builder(Context c) { return Api26.builder(c); }

    /** Moving's hook: what moves shows in the notifications (main thread) and on the page (at most every 250 ms). */
    static final class Shown implements Moving.Hook {
        private final Context app;
        private final ScheduledThreadPoolExecutor pace;

        Shown(Context c) {
            app = c.getApplicationContext();
            pace = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
                @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-moving"); t.setDaemon(true); return t; }
            });
            pace.setKeepAliveTime(30, TimeUnit.SECONDS);
            pace.allowCoreThreadTimeOut(true);
            pace.execute(new Runnable() { @Override public void run() { clearLeft(app); } });
        }

        @Override public long clock() { return SystemClock.elapsedRealtime(); }
        @Override public long wall() { return System.currentTimeMillis(); }
        @Override public void later(Runnable r, long ms) { try { pace.schedule(r, ms, TimeUnit.MILLISECONDS); } catch (Throwable e) { /* shutting down */ } }

        @Override
        public void page() {
            if (Page.get() == null) return;
            try {
                JSONObject o = new JSONObject();
                o.put("t", "moving");
                o.put("state", Moving.snapshot());
                Page.emit(o);
            } catch (Throwable e) { /* ignore */ }
        }

        @Override public void note(final Moving.Item it) { MAIN.post(new Runnable() { @Override public void run() { show(app, it); } }); }

        @Override
        public void gone(final Moving.Item it) {
            final boolean front = Page.inFront();
            MAIN.post(new Runnable() { @Override public void run() { ended(app, it, front); } });
        }
    }

    @TargetApi(26)
    static final class Api26 {
        static void start(Context c, Intent i) { c.startForegroundService(i); }

        static Notification.Builder builder(Context c) {
            if (!channelMade) {
                NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    NotificationChannel ch = new NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW);
                    ch.setDescription("Shown while files move between this phone and your other devices");
                    ch.setShowBadge(false);
                    nm.createNotificationChannel(ch);
                    channelMade = true;
                }
            }
            return new Notification.Builder(c, CHANNEL);
        }

        static void timeout(Notification.Builder b, long ms) { b.setTimeoutAfter(ms); }
    }

    @TargetApi(29)
    static final class Api29 {
        static void foreground(Service s, Notification n) { s.startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); }
    }

    @TargetApi(31)
    static final class Api31 {
        // shown at once (Android 12 can hold a service's notification back for 10 seconds)
        static void now(Notification.Builder b) { b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE); }
    }
}
