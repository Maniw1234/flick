package com.flick.app;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * "Show phone notifications on your PC": with notification access granted and the setting on, each notification
 * posted on the phone goes to the PC (POST /api/notify) and its removal withdraws it there. Left out: ongoing ones
 * (music, calls in progress, downloads), group summaries, ones an app marked local-only, progress/system/service
 * ones, Flick's own, and a short list of system packages and keyboards. At most 2 per second per app (NotifyGate).
 * When the PC isn't reachable they are dropped (a notification from an hour ago isn't news).
 */
public class FlickNotifications extends NotificationListenerService {
    private static volatile FlickNotifications live;
    private static final NotifyGate GATE = new NotifyGate();
    private static final Set<String> SKIP = new HashSet<String>(Arrays.asList(
            "android", "com.android.systemui", "com.flick.app", "com.android.providers.downloads",
            "com.android.bluetooth", "com.android.shell", "com.android.phone.overlay",
            "com.google.android.inputmethod.latin", "com.android.inputmethod.latin", "com.samsung.android.honeyboard",
            "com.sec.android.inputmethod", "com.touchtype.swiftkey", "com.google.android.apps.inputmethod.hindi"));
    private static final Set<String> SKIP_CATEGORIES = new HashSet<String>(Arrays.asList(
            Notification.CATEGORY_TRANSPORT, Notification.CATEGORY_PROGRESS, Notification.CATEGORY_SERVICE,
            Notification.CATEGORY_SYSTEM, Notification.CATEGORY_NAVIGATION, Notification.CATEGORY_CALL));
    private static final int MAX = 2045;                         // bytes per field, "…" included: the PC takes up to 2 KB

    // one sender, a short queue: when the PC is slow, what doesn't fit is dropped rather than piling up
    private static final ThreadPoolExecutor OUT = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new LinkedBlockingQueue<Runnable>(64), new java.util.concurrent.ThreadFactory() {
                @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-notify"); t.setDaemon(true); return t; }
            }, new ThreadPoolExecutor.DiscardPolicy());
    private static volatile long quietUntil;                     // the PC didn't answer: nothing is tried until then

    private final HashMap<String, String> labels = new HashMap<String, String>();

    static { OUT.allowCoreThreadTimeOut(true); }

    /** The setting changed: the listener runs only while it's on (and access is granted). */
    static void wanted(Context c, boolean on) {
        try {
            if (on) requestRebind(new ComponentName(c, FlickNotifications.class));
            else { FlickNotifications s = live; if (s != null) s.requestUnbind(); }
        } catch (Throwable e) { Bg.warn("notification listener", e); }
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        live = this;
        Page.featuresChanged();
        if (!Features.notify(this)) { try { requestUnbind(); } catch (Throwable e) { /* ignore */ } }
    }

    @Override
    public void onListenerDisconnected() {
        if (live == this) live = null;
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (!Features.notify(this)) return;
            JSONObject n = describe(sbn);
            if (n == null) return;
            send(GATE.posted(sbn.getPackageName(), sbn.getKey(), n, SystemClock.elapsedRealtime()));
            later();
        } catch (Throwable e) { Bg.warn("notification", e); }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        try {
            if (!Features.notify(this)) return;
            JSONObject n = new JSONObject();
            n.put("key", sbn.getKey());
            n.put("pkg", sbn.getPackageName());
            n.put("app", label(sbn));
            n.put("title", "");
            n.put("text", "");
            n.put("time", System.currentTimeMillis());
            n.put("removed", true);
            send(GATE.removed(sbn.getKey(), n));
        } catch (Throwable e) { Bg.warn("notification removed", e); }
    }

    // the newest version of throttled notifications, once their app has room again
    private final Runnable due = new Runnable() {
        @Override
        public void run() {
            try { send(GATE.due(SystemClock.elapsedRealtime())); later(); } catch (Throwable e) { Bg.warn("notification", e); }
        }
    };

    private void later() {
        long next = GATE.next(SystemClock.elapsedRealtime());
        Bg.mainCancel(due);
        if (next >= 0) Bg.mainDelayed(due, Math.max(50, next));
    }

    private void send(List<JSONObject> list) {
        if (list.isEmpty()) return;
        final Context app = getApplicationContext();
        for (final JSONObject n : list) {
            OUT.execute(new Runnable() {
                @Override
                public void run() {
                    if (SystemClock.elapsedRealtime() < quietUntil) return;
                    try {
                        PcClient client = Bg.client(app);
                        client.post(client.target(), "/api/notify", null, n);
                    } catch (PcClient.Failure f) {
                        // away, not paired, or a PC that doesn't take them: don't try again for a while
                        if (!f.is(PcClient.Failure.REFUSED)) quietUntil = SystemClock.elapsedRealtime() + (f.is(PcClient.Failure.UNREACHABLE) ? 30000 : 300000);
                    } catch (Throwable e) { Bg.warn("notify PC", e); }
                }
            });
        }
    }

    /** The notification as /api/notify takes it, or null when it isn't one to show on the PC. */
    private JSONObject describe(StatusBarNotification sbn) throws org.json.JSONException {
        String pkg = sbn.getPackageName();
        if (pkg == null || SKIP.contains(pkg) || pkg.equals(getPackageName()) || pkg.equals(keyboard())) return null;
        Notification n = sbn.getNotification();
        if (n == null || sbn.isOngoing()) return null;
        int skipFlags = Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE | Notification.FLAG_GROUP_SUMMARY | Notification.FLAG_LOCAL_ONLY;
        if ((n.flags & skipFlags) != 0) return null;
        if (n.category != null && SKIP_CATEGORIES.contains(n.category)) return null;
        Bundle x = n.extras;
        if (x == null) return null;
        CharSequence title = x.getCharSequence(Notification.EXTRA_TITLE_BIG);
        if (title == null || title.length() == 0) title = x.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence text = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (text == null || text.length() == 0) text = x.getCharSequence(Notification.EXTRA_TEXT);
        if (text == null || text.length() == 0) {
            CharSequence[] lines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null && lines.length > 0) {
                StringBuilder b = new StringBuilder();
                for (CharSequence l : lines) { if (l == null) continue; if (b.length() > 0) b.append('\n'); b.append(l); }
                text = b;
            }
        }
        String ti = title == null ? "" : title.toString().trim(), te = text == null ? "" : text.toString().trim();
        if (ti.length() == 0 && te.length() == 0) return null;
        JSONObject o = new JSONObject();
        o.put("key", sbn.getKey());
        o.put("pkg", pkg);
        o.put("app", label(sbn));
        o.put("title", cut(ti));
        o.put("text", cut(te));
        o.put("time", sbn.getPostTime() > 0 ? sbn.getPostTime() : System.currentTimeMillis());
        o.put("removed", false);
        return o;
    }

    private String keyboard() {
        try {
            String ime = Settings.Secure.getString(getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
            if (ime == null) return "";
            int slash = ime.indexOf('/');
            return slash > 0 ? ime.substring(0, slash) : ime;
        } catch (Throwable e) { return ""; }
    }

    /** The app's name as the phone shows it ("android.appInfo" in the notification's extras, else the package). */
    @SuppressWarnings("deprecation")
    private String label(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        synchronized (labels) { String l = labels.get(pkg); if (l != null) return l; }
        String name = null;
        PackageManager pm = getPackageManager();
        try {
            Bundle x = sbn.getNotification() == null ? null : sbn.getNotification().extras;
            Object ai = x == null ? null : x.get("android.appInfo");           // Notification.EXTRA_BUILDER_APPLICATION_INFO
            if (ai instanceof ApplicationInfo) name = String.valueOf(((ApplicationInfo) ai).loadLabel(pm));
        } catch (Throwable e) { /* ask the package manager */ }
        if (name == null || name.length() == 0) {
            try { name = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0))); } catch (Throwable e) { name = pkg; }
        }
        name = cut(name);
        synchronized (labels) { if (labels.size() > 200) labels.clear(); labels.put(pkg, name); }
        return name;
    }

    private static String cut(String s) {
        if (s == null) return "";
        String c = Clip.cut(s, MAX);
        return c.length() < s.length() ? c + "…" : c;
    }
}
