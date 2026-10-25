package com.flick.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;

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

    /** The page is open and in front. */
    static boolean inFront() {
        MainActivity a = live.get();
        return a != null && a.isOnScreen();
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
            }
        });
    }

    static void onPermissions(MainActivity a, int req) {
        if (req == REQ_NOTIFY) Bg.run("features", new Runnable() { @Override public void run() { featuresChanged(); } });
    }

    /** Android 13+: asks once to show notifications (the background link, ringing, links from the PC). */
    static void askNotifications(final MainActivity a) {
        if (a == null || Build.VERSION.SDK_INT < 33) return;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
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
