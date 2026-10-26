package com.flick.app;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.ExecutorService;

/**
 * Settings > Send feedback: Bug or Idea, the message, an optional email address and, when the user leaves them ticked,
 * the device info and the last crash report the page showed. Posted to the Google Form (FeedbackForm) from here, not
 * from the WebView. Without a connection the message waits in files/feedback-outbox.json, with exactly the text the
 * user saw, and goes when Flick next opens or the background link reaches the PC; a notification says when it went.
 */
final class Feedback {
    static final String CH = "feedback";
    private static final int NOTE_ID = 61;
    private static final Object FLUSH = new Object();
    private static volatile boolean flushing;
    // its own thread: a post on a slow network takes up to half a minute, and nothing else should wait behind it
    private static final ExecutorService ONE = Transfers.pool("flick-feedback", 1);

    private Feedback() {}

    static File outbox(Context c) { return new File(c.getApplicationContext().getFilesDir(), "feedback-outbox.json"); }

    /** The device info shown under "Include device info": exactly what goes in that field. */
    static String deviceInfo(Context c) {
        String model = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER) + " " + (Build.MODEL == null ? "" : Build.MODEL);
        if (Build.MODEL != null && Build.MANUFACTURER != null && Build.MODEL.toLowerCase(Locale.US).startsWith(Build.MANUFACTURER.toLowerCase(Locale.US))) model = Build.MODEL;
        return "Flick " + Updater.installedName(c) + " (" + Updater.installedCode(c) + ") · Android " + Build.VERSION.RELEASE
                + " (SDK " + Build.VERSION.SDK_INT + ") · " + model.trim();
    }

    /** For the page: {ready, device, crash ("" when there is none), crashAt, waiting}. */
    static JSONObject info(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", FeedbackForm.ready());
            o.put("device", deviceInfo(c));
            String crash = CrashReport.last(c);
            o.put("crash", crash == null ? "" : crash);
            o.put("crashAt", crash == null ? 0 : CrashReport.lastAt(c));
            o.put("waiting", FeedbackForm.waiting(outbox(c)).length());
        } catch (Throwable e) { /* can't fail */ }
        return o;
    }

    /**
     * The page's form: {type: bug|idea, message, email, device: bool, crash: bool}. Answers with an event
     * {t:"feedback", ok} / {ok:false, queued:true} (kept for later) / {ok:false, why: empty|email|setup|refused}.
     */
    static void send(Context ctx, final String json) {
        final Context c = ctx.getApplicationContext();
        run(new Runnable() {
            @Override
            public void run() {
                String why;
                try {
                    JSONObject m = new JSONObject(json);
                    String message = m.optString("message", "").trim();
                    String email = m.optString("email", "").trim();
                    if (!FeedbackForm.ready()) why = "setup";
                    else if (message.length() == 0) why = "empty";
                    else if (email.length() > 0 && !FeedbackForm.emailOk(email)) why = "email";
                    else {
                        // the device info and the crash report exactly as the page showed them (made by the same code now)
                        String crash = m.optBoolean("crash", false) ? CrashReport.last(c) : null;
                        StringBuilder dev = new StringBuilder();
                        if (m.optBoolean("device", false)) dev.append(deviceInfo(c));
                        if (crash != null) dev.append(dev.length() > 0 ? "\n\n" : "").append("Last crash report:\n").append(crash);
                        JSONObject item = new JSONObject();
                        item.put("id", newId());
                        item.put("at", System.currentTimeMillis());
                        item.put("body", FeedbackForm.body("idea".equals(m.optString("type")) ? "idea" : "bug", message, email, dev.toString()));
                        item.put("crash", crash != null);
                        String r = FeedbackForm.post(item.getString("body"));
                        if (FeedbackForm.OK.equals(r)) {
                            if (crash != null) CrashReport.forgetLast(c);
                            event(true, false, null);
                            flush(c);                           // anything older that waited goes now too
                            return;
                        }
                        if (FeedbackForm.OFFLINE.equals(r)) {
                            FeedbackForm.keep(outbox(c), item);
                            event(false, true, null);
                            return;
                        }
                        why = "refused";
                    }
                } catch (Throwable e) {
                    Bg.warn("feedback", e);
                    why = "error";
                }
                event(false, false, why);
            }
        });
    }

    /** Messages that waited for a connection: sent now if they can be (any thread; never two at once). */
    static void flush(Context ctx) {
        final Context c = ctx.getApplicationContext();
        synchronized (FLUSH) { if (flushing) return; flushing = true; }
        try {
            if (!FeedbackForm.ready()) return;
            JSONArray a = FeedbackForm.waiting(outbox(c));
            int sent = 0;
            for (int i = 0; i < a.length(); i++) {
                JSONObject item = a.optJSONObject(i);
                if (item == null) continue;
                String r = FeedbackForm.post(item.optString("body", ""));
                if (FeedbackForm.OFFLINE.equals(r)) break;          // still offline: the rest wait too
                FeedbackForm.drop(outbox(c), item.optString("id", ""));
                if (FeedbackForm.OK.equals(r)) {
                    sent++;
                    if (item.optBoolean("crash", false)) CrashReport.forgetLast(c);
                }
            }
            if (sent > 0) {
                Page.event("feedback", "ok", true, "later", true);
                notifySent(c, sent);
            }
        } catch (Throwable e) {
            Bg.warn("feedback", e);
        } finally {
            synchronized (FLUSH) { flushing = false; }
        }
    }

    /** flush() off the calling thread, when something waits. */
    static void flushLater(Context ctx) {
        final Context c = ctx.getApplicationContext();
        if (!outbox(c).isFile()) return;
        run(new Runnable() { @Override public void run() { flush(c); } });
    }

    private static void run(final Runnable r) {
        try {
            ONE.execute(new Runnable() { @Override public void run() { try { r.run(); } catch (Throwable e) { Bg.warn("feedback", e); } } });
        } catch (Throwable e) { Bg.warn("feedback", e); }
    }

    private static void event(boolean ok, boolean queued, String why) {
        Page.event("feedback", "ok", ok, "queued", queued ? Boolean.TRUE : null, "why", why);
    }

    // "Your feedback was sent": the user may not be in Flick when a message that waited goes
    @SuppressWarnings("deprecation")
    private static void notifySent(Context c, int n) {
        try {
            if (Build.VERSION.SDK_INT >= 26) Api26.channel(c);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            PendingIntent open = PendingIntent.getActivity(c, NOTE_ID, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), Features.piFlags());
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
            b.setSmallIcon(Features.icon(c, "ic_stat_flick", android.R.drawable.stat_sys_upload_done))
                    .setContentTitle(n == 1 ? "Your feedback was sent" : "Your feedback was sent (" + n + " messages)")
                    .setContentText("Thanks for helping make Flick better")
                    .setAutoCancel(true)
                    .setContentIntent(open);
            nm.notify(NOTE_ID, b.build());
        } catch (Throwable e) { Bg.warn("feedback notification", e); }
    }

    @TargetApi(26)
    static final class Api26 {
        static void channel(Context c) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(CH, "Feedback", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("When feedback that waited for a connection has been sent");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private static String newId() {
        byte[] b = new byte[6];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.US, "%02x", x & 0xff));
        return s.toString();
    }
}
