package com.flick.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * The page (MainActivity's WebView), as background code sees it: there may be none. Events for it go through the
 * live activity, if any; MainActivity queues them until the page is ready.
 */
final class Page {
    static final int REQ_NOTIFY = 44;

    private static volatile WeakReference<MainActivity> live = new WeakReference<MainActivity>(null);
    private static volatile String features;                  // the features() the page last saw

    private Page() {}

    static void attach(MainActivity a) { live = new WeakReference<MainActivity>(a); }

    static void detach(MainActivity a) { if (live.get() == a) live = new WeakReference<MainActivity>(null); }

    static MainActivity get() { return live.get(); }

    /**
     * The page is open and in front, where the user sees it: not under Lock Flick's cover. (Covered, what would show on
     * the page goes in a notification instead: a device asking to send files would otherwise wait unseen until its
     * question ran out.)
     */
    static boolean inFront() {
        MainActivity a = live.get();
        if (a == null || !a.isOnScreen()) return false;
        AppLock l = a.lock();
        return l == null || !l.isLocked();
    }

    static void emit(String json) {
        MainActivity a = live.get();
        if (a != null) { try { a.emit(json); } catch (Throwable e) { /* the activity is going */ } }
    }

    static void emit(JSONObject o) { emit(o.toString()); }

    static void event(String t, Object... kv) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", t);
            for (int i = 0; i + 1 < kv.length; i += 2) if (kv[i + 1] != null) o.put(String.valueOf(kv[i]), kv[i + 1]);
            emit(o);
        } catch (Throwable e) { /* ignore */ }
    }

    // a burst of history entries (a sync, several auto-sends) is one "history" event
    private static final Runnable HISTORY = new Runnable() { @Override public void run() { event("history"); } };

    static void historyChanged() {
        Bg.mainCancel(HISTORY);
        Bg.mainDelayed(HISTORY, 250);
    }

    /** Something features() reports may have changed: the page is told when it did. */
    static void featuresChanged() {
        MainActivity a = live.get();
        if (a == null) return;
        String now = Features.json(a);
        if (now.equals(features)) return;
        features = now;
        event("features");
    }

    /** What features() just answered the page. */
    static void featuresSeen(String json) { features = json; }

    // ------------------------------------------------------------ from MainActivity
    /**
     * Flick came to the front: access granted in Settings meanwhile shows now; a background link Android stopped (or
     * wouldn't start) comes back; auto-send's trigger is armed (after a force stop, say).
     */
    static void onResume(MainActivity a) {
        try { if (Features.bg(a) && !LinkService.isRunning()) LinkService.start(a); } catch (Throwable e) { /* ignore */ }
        final android.content.Context app = a.getApplicationContext();
        Bg.run("resume checks", new Runnable() {
            @Override
            public void run() {
                featuresChanged();
                AutoSend.ensure(app);
                Feedback.flushLater(app);
            }
        });
    }

    static void onPermissions(MainActivity a, int req) {
        if (req == REQ_NOTIFY) Bg.run("features", new Runnable() { @Override public void run() { featuresChanged(); } });
    }

    /** Android 13+: asks once to show notifications (the background link, ringing, links from the PC). */
    static void askNotifications(final MainActivity a) { askNotifications(a, false); }

    /**
     * again: the user asked for them (Settings' Allow notifications): when Android won't show its question any more,
     * its notification settings for Flick open instead, where they can be turned on (never a tap that does nothing).
     */
    static void askNotifications(final MainActivity a, final boolean again) {
        if (a == null || Build.VERSION.SDK_INT < 33) return;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
                    if (!a.wontAsk("notifyAsked", Manifest.permission.POST_NOTIFICATIONS)) {
                        a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                    } else if (again) {
                        a.settings(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.getPackageName()), REQ_NOTIFY);
                    }
                } catch (Throwable e) { Bg.warn("notification permission", e); }
            }
        });
    }

    /**
     * A single web address shared to Flick: the page offers "Open on <PC>" or "Save to the Flick list" (saveLink)
     * instead of a text file being saved at once. title: the sharing app's subject (a page title), if any.
     */
    static boolean sharedLink(MainActivity a, String text, String title) {
        String url = Links.singleUrl(text);
        if (url == null) return false;
        try {
            JSONObject o = new JSONObject();
            o.put("t", "share-link");
            o.put("url", url);
            if (title != null && title.trim().length() > 0) o.put("title", title.trim().length() > 200 ? title.trim().substring(0, 200) : title.trim());
            a.emit(o.toString());
            return true;
        } catch (Throwable e) { return false; }
    }
}
