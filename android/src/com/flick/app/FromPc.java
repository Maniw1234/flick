package com.flick.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONObject;

/** What the PC sends this phone over the background link (spec §4): its clipboard and links. */
final class FromPc {
    private static final int LINK_NOTE_FIRST = 30, LINK_NOTES = 10;   // the last ten links each keep a notification
    private static int nextNote;

    private FromPc() {}

    /** The PC's clipboard: applied here when "Clipboard from your PC" is on. */
    static void clip(Context c, JSONObject e, String pcName) {
        if (!Features.clipFromPc(c)) return;
        String kind = Clip.write(c, e, pcName);
        if (kind == null) return;
        Page.event("clip-in", "kind", kind);
        // Android 13+ shows its own note, and the page shows one when it's in front
        if (Build.VERSION.SDK_INT < 33 && !Page.inFront()) Bg.toast(c, "Copied from " + pcName);
    }

    /** A link: opened at once when Flick is in front, otherwise a notification "Link from <PC>" that opens it. */
    static void link(final Context c, final String url, String pcName) {
        if (!Links.ok(url)) return;
        Page.event("link-in", "url", url);
        if (Page.inFront()) {
            Bg.main(new Runnable() { @Override public void run() { open(c, url); } });
            return;
        }
        notifyLink(c, url, pcName);
    }

    /** Opens an http(s) address in the browser. */
    static boolean open(Context c, String url) {
        if (!Links.ok(url)) return false;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Throwable e) {
            Bg.toast(c, "No app on this phone can open that link");
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    static void notifyLink(Context c, String url, String pcName) {
        try {
            Context app = c.getApplicationContext();
            Features.channels(app);
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            int id;
            synchronized (FromPc.class) { id = LINK_NOTE_FIRST + nextNote; nextNote = (nextNote + 1) % LINK_NOTES; }
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(app, 100 + id, view, Features.piFlags());
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, Features.CH_LINKS) : new Notification.Builder(app).setPriority(Notification.PRIORITY_HIGH);
            b.setSmallIcon(Features.icon(app, "ic_stat_flick", android.R.drawable.stat_notify_more))
                    .setContentTitle("Link from " + (pcName == null || pcName.length() == 0 ? "your PC" : pcName))
                    .setContentText(url)
                    .setStyle(new Notification.BigTextStyle().bigText(url))
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setContentIntent(pi);
            nm.notify(id, b.build());
        } catch (Throwable e) { Bg.warn("link notification", e); }
    }
}
