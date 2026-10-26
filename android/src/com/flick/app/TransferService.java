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
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps Flick running while files move, with the screen off or another app in front: a foreground service with a
 * quiet "Moving files with your PC" notification. Transfers turns it on when the first transfer starts and off when
 * the last one ends, so it never runs while nothing moves. When Android won't allow it (Android 12+ refuses to start
 * one while Flick is in the background), transfers simply carry on without it.
 *
 * It is never stopped from outside: stopping a service started with startForegroundService() before it has called
 * startForeground() crashes the app, so the service itself goes once it is up and no transfer wants it.
 */
public class TransferService extends Service {
    private static final int ID = 1;
    private static final String CHANNEL = "transfers";
    private static final long LINGER_MS = 3000;    // back-to-back transfers share one service (and notification)

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // main thread only
    private static final java.util.Set<String> HOLDERS = new java.util.HashSet<String>();   // who wants it: "transfers", "sends"
    private static boolean wanted;                  // some transfer is running
    private static boolean starting;                // asked Android to start it; onStartCommand not seen yet
    private static TransferService running;
    // what the notification says (Sends keeps it current); null: the plain "Moving files with your PC"
    private static String title, text;
    private static int progress = -1;
    private static long shownAt;

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
                    if (Build.VERSION.SDK_INT >= 26) Api26.start(app, i); else app.startService(i);
                    starting = true;
                } catch (Throwable e) {
                    // e.g. ForegroundServiceStartNotAllowedException: Flick is in the background on Android 12+
                }
            }
        });
    }

    /** Any thread: what the notification says (null title: the plain text); progress 0-100, or -1 for none. */
    static void say(Context c, final String t, final String x, final int p) {
        MAIN.post(new Runnable() {
            @Override
            public void run() {
                boolean same = (t == null ? title == null : t.equals(title)) && (x == null ? text == null : x.equals(text)) && p == progress;
                title = t; text = x; progress = p;
                TransferService s = running;
                if (same || s == null) return;
                long now = android.os.SystemClock.elapsedRealtime();
                if (now - shownAt < 700) { MAIN.removeCallbacks(REFRESH); MAIN.postDelayed(REFRESH, 700); return; }
                s.refresh();
            }
        });
    }

    private static final Runnable REFRESH = new Runnable() { @Override public void run() { TransferService s = running; if (s != null) s.refresh(); } };

    private void refresh() {
        shownAt = android.os.SystemClock.elapsedRealtime();
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(ID, notification());
        } catch (Throwable e) { /* the notification only */ }
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
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable e) { /* ignore */ }
        stopSelf();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        starting = false;
        running = this;
        try {
            Notification n = notification();
            if (Build.VERSION.SDK_INT >= 29) Api29.foreground(this, n); else startForeground(ID, n);
        } catch (Throwable e) {
            end();                                   // Android refused: the transfers go on without it
            return START_NOT_STICKY;
        }
        if (!wanted) { MAIN.removeCallbacks(STOP); MAIN.postDelayed(STOP, LINGER_MS); }   // they finished meanwhile
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @SuppressWarnings("deprecation")
    private Notification notification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? Api26.builder(this) : new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (progress >= 0) b.setProgress(100, progress, false);
        return b.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(title != null ? title : "Flick")
                .setContentText(title != null && text != null ? text : "Moving files with your PC")
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setShowWhen(false)
                .setLocalOnly(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build();
    }

    @TargetApi(26)
    static final class Api26 {
        static void start(Context c, Intent i) { c.startForegroundService(i); }

        static Notification.Builder builder(Context c) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Shown while files move between this phone and your PC");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            return new Notification.Builder(c, CHANNEL);
        }
    }

    @TargetApi(29)
    static final class Api29 {
        static void foreground(Service s, Notification n) { s.startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); }
    }
}
