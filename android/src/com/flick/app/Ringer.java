package com.flick.app;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;

/**
 * "Find my phone": the alarm sound at full alarm volume, looping, with vibration and a notification with Stop, for
 * sec seconds (at most 60) or until Stop (the notification, or the page's full-screen "tap to stop"). The alarm volume
 * the user had is put back afterwards. Everything runs on one thread of its own.
 */
final class Ringer {
    static final int NOTE_ID = 20;
    static final int MAX_SEC = 60;

    private static Handler h;
    private static Context app;
    private static boolean on;
    private static MediaPlayer player;
    private static ToneGenerator tone;
    private static Vibrator vib;
    private static int savedVolume = -1;
    private static Object focus;                   // AudioFocusRequest (26+)
    private static PowerManager.WakeLock wake;

    private Ringer() {}

    private static synchronized Handler handler(Context c) {
        if (app == null) app = c.getApplicationContext();
        if (h == null) {
            HandlerThread t = new HandlerThread("flick-ring");
            t.start();
            h = new Handler(t.getLooper());
        }
        return h;
    }

    /** Rings for sec seconds (0: 30 s); ringing already: rings on for sec seconds from now. Any thread. */
    // after the user stops the ringing here, the PC can't start it again for a couple of minutes (they found the phone)
    private static final long QUIET_MS = 2 * 60 * 1000L;
    private static volatile long quietUntil;

    static void start(Context c, final int sec) {
        if (System.currentTimeMillis() < quietUntil) return;
        final Handler hh = handler(c);
        hh.post(new Runnable() {
            @Override
            public void run() {
                try { doStart(sec); }
                catch (Throwable e) { Bg.warn("ring", e); try { doStop("error"); } catch (Throwable x) { /* ignore */ } }
            }
        });
    }

    /** Stops ringing (nothing if it isn't). by: "user" (Stop, or the page's tap) or "pc" (ring-stop). Any thread. */
    static void stop(Context c, final String by) {
        handler(c).post(new Runnable() { @Override public void run() { try { doStop(by); } catch (Throwable e) { Bg.warn("ring stop", e); } } });
    }

    static synchronized boolean ringing() { return on; }

    // the time is up
    private static final Runnable STOP = new Runnable() { @Override public void run() { try { doStop("timeout"); } catch (Throwable e) { Bg.warn("ring stop", e); } } };

    private static void doStart(int sec) {
        int s = sec <= 0 ? 30 : Math.min(MAX_SEC, sec);
        h.removeCallbacks(STOP);
        h.postDelayed(STOP, s * 1000L);
        synchronized (Ringer.class) { if (on) return; on = true; }
        try {
            PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
            if (pm != null) { wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flick:ring"); wake.setReferenceCounted(false); wake.acquire((MAX_SEC + 10) * 1000L); }
        } catch (Throwable e) { /* rings while awake */ }
        AudioAttributes aa = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            try {
                savedVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            } catch (Throwable e) { savedVolume = -1; }
            try { if (Build.VERSION.SDK_INT >= 26) focus = Api26.focus(am, aa); } catch (Throwable e) { /* plays anyway */ }
        }
        player = play(aa);
        if (player == null) beep();
        vibrate(aa);
        notifyRinging();
        Page.event("ring", "on", true);
    }

    private static void doStop(String by) {
        if ("user".equals(by)) quietUntil = System.currentTimeMillis() + QUIET_MS;
        if (h != null) h.removeCallbacks(STOP);
        if (h != null) h.removeCallbacks(BEEP);
        synchronized (Ringer.class) { if (!on) return; on = false; }
        try { if (player != null) { player.stop(); player.release(); } } catch (Throwable e) { /* ignore */ }
        player = null;
        try { if (tone != null) tone.release(); } catch (Throwable e) { /* ignore */ }
        tone = null;
        try { if (vib != null) vib.cancel(); } catch (Throwable e) { /* ignore */ }
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            try { if (savedVolume >= 0) am.setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0); } catch (Throwable e) { /* ignore */ }
            try { if (focus != null && Build.VERSION.SDK_INT >= 26) Api26.abandon(am, focus); } catch (Throwable e) { /* ignore */ }
        }
        savedVolume = -1;
        focus = null;
        try {
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTE_ID);
        } catch (Throwable e) { /* ignore */ }
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Throwable e) { /* ignore */ }
        Page.event("ring", "on", false, "by", by);
    }

    /** The default alarm sound, else the ringtone, else the notification sound (Android plays those for any app). */
    private static MediaPlayer play(AudioAttributes aa) {
        Uri[] sounds = {Settings.System.DEFAULT_ALARM_ALERT_URI, Settings.System.DEFAULT_RINGTONE_URI, Settings.System.DEFAULT_NOTIFICATION_URI};
        for (Uri u : sounds) {
            if (u == null) continue;
            MediaPlayer mp = new MediaPlayer();
            try {
                mp.setAudioAttributes(aa);
                mp.setDataSource(app, u);
                mp.setLooping(true);
                mp.prepare();
                mp.start();
                return mp;
            } catch (Throwable e) {
                try { mp.release(); } catch (Throwable x) { /* ignore */ }
            }
        }
        return null;
    }

    // no sound set at all ("None" everywhere): beeps on the alarm stream
    private static final Runnable BEEP = new Runnable() {
        @Override
        public void run() {
            try { if (tone != null) tone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 800); } catch (Throwable e) { /* ignore */ }
            if (on && h != null) h.postDelayed(this, 1200);
        }
    };

    private static void beep() {
        try { tone = new ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME); h.post(BEEP); } catch (Throwable e) { tone = null; }
    }

    @SuppressWarnings("deprecation")
    private static void vibrate(AudioAttributes aa) {
        try {
            if (Build.VERSION.SDK_INT >= 31) vib = Api31.vibrator(app);
            else vib = (Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
            if (vib == null || !vib.hasVibrator()) return;
            long[] pattern = {0, 700, 500};
            if (Build.VERSION.SDK_INT >= 26) vib.vibrate(VibrationEffect.createWaveform(pattern, 0), aa);
            else vib.vibrate(pattern, 0, aa);
        } catch (Throwable e) { /* sound only */ }
    }

    @SuppressWarnings("deprecation")
    private static void notifyRinging() {
        try {
            Features.channels(app);
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            PendingIntent stop = PendingIntent.getBroadcast(app, 11, new Intent(app, ActionReceiver.class).setAction(ActionReceiver.RING_STOP), Features.piFlags());
            PendingIntent open = PendingIntent.getActivity(app, 12, new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), Features.piFlags());
            int icon = Features.icon(app, "ic_stat_flick", android.R.drawable.ic_lock_idle_alarm);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, Features.CH_RING) : new Notification.Builder(app).setPriority(Notification.PRIORITY_MAX);
            b.setSmallIcon(icon)
                    .setContentTitle("Flick: your PC is looking for this phone")
                    .setContentText("Tap Stop when you've found it")
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setShowWhen(false)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setContentIntent(open)
                    .setDeleteIntent(stop)
                    .addAction(new Notification.Action.Builder(Icon.createWithResource(app, icon), "Stop", stop).build());
            nm.notify(NOTE_ID, b.build());
        } catch (Throwable e) { Bg.warn("ring notification", e); }
    }

    @TargetApi(26)
    static final class Api26 {
        static Object focus(AudioManager am, AudioAttributes aa) {
            AudioFocusRequest r = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(aa).build();
            am.requestAudioFocus(r);
            return r;
        }
        static void abandon(AudioManager am, Object r) { am.abandonAudioFocusRequest((AudioFocusRequest) r); }
    }

    @TargetApi(31)
    static final class Api31 {
        static Vibrator vibrator(Context c) {
            VibratorManager vm = (VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return vm == null ? null : vm.getDefaultVibrator();
        }
    }
}
