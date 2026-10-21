package com.flick.app;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

/**
 * Flick 2.0's switches, kept in SharedPreferences "flick" (keys "f:*", apart from the page's "p:*"): everything is off
 * until the user turns it on, except taking the clipboard from the PC. Also the notification channels, one per
 * purpose.
 */
final class Features {
    static final String BG = "f:bg";                   // "1": LinkService holds the background link
    static final String CLIP = "f:clipFromPc";         // "1" (default): the PC's clipboard is applied here
    static final String AUTO = "f:autoSend";           // "off" | "screenshots" | "photos"
    static final String NOTIFY = "f:notify";           // "1": phone notifications go to the PC

    static final String CH_LINK = "link";              // the background link's ongoing notification (low)
    static final String CH_RING = "ring";              // "your PC is looking for this phone" (high)
    static final String CH_LINKS = "links-in";         // a link the PC sent (high)

    private Features() {}

    static boolean bg(Context c) { return "1".equals(get(c, BG, "0")); }
    static boolean clipFromPc(Context c) { return !"0".equals(get(c, CLIP, "1")); }
    static boolean notify(Context c) { return "1".equals(get(c, NOTIFY, "0")); }

    static String autoSend(Context c) {
        String v = get(c, AUTO, "off");
        return "screenshots".equals(v) || "photos".equals(v) ? v : "off";
    }

    private static String get(Context c, String k, String d) {
        try { String v = Bg.prefs(c).getString(k, d); return v == null ? d : v; } catch (Throwable e) { return d; }
    }

    private static void put(Context c, String k, String v) { Bg.prefs(c).edit().putString(k, v).apply(); }

    /** features() for the page. "notify" (the switch itself) is reported along with the spec's fields. */
    static String json(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("bg", bg(c));
            o.put("notifyAccess", notifyAccess(c));
            o.put("notifyPerm", notifyPerm(c));
            o.put("autoSend", autoSend(c));
            o.put("clipFromPc", clipFromPc(c));
            o.put("notify", notify(c));
            o.put("sdk", Build.VERSION.SDK_INT);
        } catch (Throwable e) { /* can't fail */ }
        return o.toString();
    }

    /** setFeature(name, value) from the page. Unknown names and values are ignored. */
    static void set(final MainActivity a, String name, String value) {
        final Context c = a.getApplicationContext();
        String v = value == null ? "" : value.trim();
        if ("bg".equals(name)) {
            boolean on = "1".equals(v) || "true".equals(v);
            put(c, BG, on ? "1" : "0");
            if (on) { Page.askNotifications(a); LinkService.start(c); }
            else LinkService.stop(c);
        } else if ("clipFromPc".equals(name)) {
            put(c, CLIP, "1".equals(v) || "true".equals(v) ? "1" : "0");
        } else if ("autoSend".equals(name)) {
            if (!"off".equals(v) && !"screenshots".equals(v) && !"photos".equals(v)) return;
            String was = autoSend(c);
            put(c, AUTO, v);
            if (!v.equals(was)) AutoSend.modeChanged(c, v);
        } else if ("notify".equals(name)) {
            final boolean on = "1".equals(v) || "true".equals(v);
            put(c, NOTIFY, on ? "1" : "0");
            a.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (on && !notifyAccess(c)) openNotifyAccess(a);
                    else FlickNotifications.wanted(c, on);
                }
            });
        } else {
            return;
        }
        Page.featuresChanged();
    }

    // ------------------------------------------------------------ notification access and permission
    static ComponentName listener(Context c) { return new ComponentName(c, FlickNotifications.class); }

    static boolean notifyAccess(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.isNotificationListenerAccessGranted(listener(c));
        } catch (Throwable e) { return false; }
    }

    /** Flick may show notifications (Android 13+: the permission; before: not turned off in Settings). */
    static boolean notifyPerm(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.areNotificationsEnabled();
        } catch (Throwable e) { return false; }
    }

    /** Android's screen where the user lets Flick read notifications (Flick's own switch when Android has one). */
    static void openNotifyAccess(Activity a) {
        Intent i = null;
        if (Build.VERSION.SDK_INT >= 30) i = Api30.detail(a);
        try {
            if (i != null) { a.startActivity(i); return; }
        } catch (Throwable e) { /* fall back to the list */ }
        try { a.startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); return; } catch (Throwable e) { /* ignore */ }
        try { a.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName()))); } catch (Throwable e) { /* ignore */ }
    }

    @TargetApi(30)
    static final class Api30 {
        static Intent detail(Context c) {
            Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listener(c).flattenToString());
            return i;
        }
    }

    // ------------------------------------------------------------ channels
    /** The notification channels (made once; Android keeps the user's changes to them). */
    static void channels(Context c) {
        if (Build.VERSION.SDK_INT >= 26) Api26.channels(c);
    }

    @TargetApi(26)
    static final class Api26 {
        static void channels(Context c) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel link = new NotificationChannel(CH_LINK, "Connected in the background", NotificationManager.IMPORTANCE_LOW);
            link.setDescription("Shown while Flick stays connected to your PC with the app closed");
            link.setShowBadge(false);
            nm.createNotificationChannel(link);
            NotificationChannel ring = new NotificationChannel(CH_RING, "Find my phone", NotificationManager.IMPORTANCE_HIGH);
            ring.setDescription("When your PC makes this phone ring");
            ring.setSound(null, null);                 // Flick plays the alarm itself
            ring.enableVibration(false);               // and vibrates itself
            ring.setShowBadge(false);
            ring.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ring);
            NotificationChannel links = new NotificationChannel(CH_LINKS, "Links from your PC", NotificationManager.IMPORTANCE_HIGH);
            links.setDescription("A link your PC sent, to open on this phone");
            nm.createNotificationChannel(links);
        }
    }

    /** Small icon for Flick's notifications (from res, there's no R class). */
    static int icon(Context c, String name, int fallback) {
        try {
            int id = c.getResources().getIdentifier(name, "drawable", c.getPackageName());
            return id != 0 ? id : fallback;
        } catch (Throwable e) { return fallback; }
    }

    /** PendingIntent flags: immutable, current extras. */
    static int piFlags() { return android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT; }
}
