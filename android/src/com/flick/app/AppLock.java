package com.flick.app;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * "Lock Flick" (Settings › Privacy). When Flick opens, and when it comes back after more than 30 seconds in the
 * background, a cover hides the page until the user unlocks it with the phone's own lock: fingerprint, face, or the
 * PIN, pattern or password (BiometricPrompt; Android 9 and 10 fall back to Android's PIN screen where their
 * BiometricPrompt can't ask for it). Only the page is covered: transfers, the background link, auto-send, folder sync,
 * notification forwarding and Find my phone keep running, and the Quick Settings tiles and the widget keep working
 * (they send the last photo or the clipboard and show no files). Recents shows no picture of Flick while it's on.
 * A phone without a screen lock has nothing to unlock with: Flick then doesn't lock (Settings says so instead).
 */
final class AppLock {
    static final String KEY = "f:lock";                 // "1": on (SharedPreferences "flick", next to the features)
    static final int REQ_UNLOCK = 45;
    private static final long AWAY_MS = 30000;
    private static final int ERROR_NEGATIVE_BUTTON = 13;      // BiometricConstants (not public in the SDK): "Use PIN"

    private final MainActivity a;
    private View cover;
    private boolean locked, asking, enabling, quiet, switching;
    private long awayAt;
    private CancellationSignal cancel;

    AppLock(MainActivity a) { this.a = a; }

    static boolean on(Context c) {
        try { return "1".equals(Bg.prefs(c).getString(KEY, "0")); } catch (Throwable e) { return false; }
    }

    /** The phone has a screen lock (PIN, pattern, password), which a fingerprint or face may stand in for. */
    static boolean secure(Context c) {
        try {
            KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            return km != null && km.isDeviceSecure();
        } catch (Throwable e) { return false; }
    }

    boolean isLocked() { return locked; }

    // ------------------------------------------------------------ MainActivity's lifecycle
    void onCreate() {
        recents();
        if (on(a) && secure(a)) lock();
    }

    void onStart() {
        if (awayAt > 0 && !locked && on(a) && SystemClock.elapsedRealtime() - awayAt > AWAY_MS && secure(a)) lock();
        awayAt = 0;
        // back in front: ask again (a PIN screen cancelled just now answers after this, in onResult, and isn't asked again)
        if (!asking) quiet = false;
    }

    void onResume() {
        if (Build.VERSION.SDK_INT < 33) a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (locked && !asking && !quiet) ask();
    }

    void onPause() {
        // Android 9 to 12 take the Recents picture as Flick leaves: with the lock on it shows nothing (13+: recents())
        if (Build.VERSION.SDK_INT < 33 && on(a)) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    void onStop() {
        if (asking) return;                             // Android's PIN screen in front isn't leaving Flick
        awayAt = SystemClock.elapsedRealtime();
        quiet = false;
    }

    void onDestroy() {
        if (cancel != null) { try { cancel.cancel(); } catch (Throwable e) { /* ignore */ } cancel = null; }
    }

    /** Back while locked leaves Flick as it is (nothing behind the cover is reachable). */
    boolean onBack() {
        if (!locked) return false;
        a.moveTaskToBack(true);
        return true;
    }

    boolean onResult(int req, int res) {
        if (req != REQ_UNLOCK) return false;
        asking = false;
        done(res == Activity.RESULT_OK);
        return true;
    }

    // ------------------------------------------------------------ the page's switch (Bridge.lockState / setLock)
    String state() {
        JSONObject o = new JSONObject();
        try {
            o.put("on", on(a));
            o.put("secure", secure(a));
            o.put("sdk", Build.VERSION.SDK_INT);
        } catch (Throwable e) { /* can't fail */ }
        return o.toString();
    }

    /** On: asks once first ("Confirm it's you"), so a lock nobody can open is never turned on. Answers "lock-state". */
    void set(boolean want) {
        if (!want) { save(false); return; }
        if (!secure(a)) { report(false, "nosecure"); return; }
        if (on(a)) { report(true, null); return; }
        enabling = true;
        ask();
    }

    /** Android's settings, to set a screen lock up. */
    void openSettings() {
        try { a.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS)); }
        catch (Throwable e) {
            try { a.startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (Throwable x) { a.toast("Set a screen lock in Android's settings"); }
        }
    }

    private void save(boolean v) {
        Bg.prefs(a).edit().putString(KEY, v ? "1" : "0").apply();
        recents();
        report(v, null);
    }

    private void report(boolean v, String why) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "lock-state");
            o.put("on", v);
            if (why != null) o.put("why", why);
            a.emit(o.toString());
        } catch (Throwable e) { /* ignore */ }
    }

    private void recents() {
        if (Build.VERSION.SDK_INT >= 33) { try { Api33.recents(a, !on(a)); } catch (Throwable e) { Bg.warn("lock", e); } }
    }

    // ------------------------------------------------------------ locked / unlocked
    private void lock() {
        locked = true;
        quiet = false;
        showCover();
        a.emitEvent("locked");
    }

    private void unlock() {
        locked = false;
        hideCover();
        a.emitEvent("unlocked");
    }

    private void done(boolean ok) {
        if (enabling) {
            enabling = false;
            if (ok) save(true); else report(false, "cancelled");
            return;
        }
        if (!locked) return;
        if (ok) unlock();
        else quiet = true;                              // cancelled: asked again from the cover's Unlock, or next time
    }

    // the phone's lock, the best way this Android can ask for it
    private void ask() {
        if (asking) return;
        if (!secure(a)) {                               // the screen lock was removed meanwhile: never shut anyone out
            if (enabling) { enabling = false; report(false, "nosecure"); } else if (locked) unlock();
            return;
        }
        String title = enabling ? "Confirm it's you" : "Unlock Flick";
        asking = true;
        try {
            if (Build.VERSION.SDK_INT >= 30) Api30.prompt(this, title);
            else if (Build.VERSION.SDK_INT == 29 && Api29.biometric(a)) Api29.prompt(this, title);
            else if (Build.VERSION.SDK_INT == 28 && Api28.biometric(a)) Api28.prompt(this, title);
            else credential(title);
        } catch (Throwable e) {
            Bg.warn("lock", e);
            asking = false;
            credential(title);
        }
    }

    /** Android's own PIN, pattern or password screen (where BiometricPrompt can't offer it: Android 9 and 10). */
    @SuppressWarnings("deprecation")
    void credential(String title) {
        switching = false;
        try {
            KeyguardManager km = (KeyguardManager) a.getSystemService(Context.KEYGUARD_SERVICE);
            Intent i = km == null ? null : km.createConfirmDeviceCredentialIntent(title, null);
            if (i == null) throw new IllegalStateException("no screen lock");
            asking = true;
            a.startActivityForResult(i, REQ_UNLOCK);
        } catch (Throwable e) {
            // Android can't ask at all: Flick opens rather than staying shut for good
            Bg.warn("lock", e);
            asking = false;
            if (enabling) { enabling = false; report(false, "error"); }
            else if (locked) { unlock(); a.toast("Flick couldn't ask for your screen lock"); }
        }
    }

    private final class Callback extends BiometricPrompt.AuthenticationCallback {
        private final String title;

        Callback(String title) { this.title = title; }

        @Override
        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
            asking = false;
            cancel = null;
            done(true);
        }

        @Override
        public void onAuthenticationError(int code, CharSequence msg) {
            if (switching) return;                      // "Use PIN" (Android 9): its screen is on its way
            asking = false;
            cancel = null;
            // no fingerprint or face to use (none set up, none on this phone, too many tries): the PIN instead
            if (code == BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS || code == BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT
                    || code == BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE || code == BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT
                    || code == BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT || code == ERROR_NEGATIVE_BUTTON) {
                credential(title);
                return;
            }
            done(false);
        }
    }

    // Android 11+: fingerprint, face, or the PIN, pattern or password, all in one prompt
    @TargetApi(30)
    static final class Api30 {
        static void prompt(AppLock l, String title) {
            BiometricPrompt p = new BiometricPrompt.Builder(l.a).setTitle(title).setConfirmationRequired(false)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK
                            | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();
            l.cancel = new CancellationSignal();
            p.authenticate(l.cancel, l.a.getMainExecutor(), l.new Callback(title));
        }
    }

    // Android 10: the prompt can fall back to the PIN itself, but only when a fingerprint or face is set up
    @TargetApi(29)
    static final class Api29 {
        @SuppressWarnings("deprecation")
        static boolean biometric(Context c) {
            try {
                BiometricManager m = c.getSystemService(BiometricManager.class);
                return m != null && m.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
            } catch (Throwable e) { return false; }
        }

        @SuppressWarnings("deprecation")
        static void prompt(AppLock l, String title) {
            BiometricPrompt p = new BiometricPrompt.Builder(l.a).setTitle(title).setConfirmationRequired(false).setDeviceCredentialAllowed(true).build();
            l.cancel = new CancellationSignal();
            p.authenticate(l.cancel, l.a.getMainExecutor(), l.new Callback(title));
        }
    }

    // Android 9: a fingerprint only, with "Use PIN" to Android's PIN screen
    @TargetApi(28)
    static final class Api28 {
        @SuppressWarnings("deprecation")
        static boolean biometric(Context c) {
            try {
                android.hardware.fingerprint.FingerprintManager f = (android.hardware.fingerprint.FingerprintManager) c.getSystemService(Context.FINGERPRINT_SERVICE);
                return f != null && f.isHardwareDetected() && f.hasEnrolledFingerprints();
            } catch (Throwable e) { return false; }
        }

        static void prompt(final AppLock l, final String title) {
            BiometricPrompt p = new BiometricPrompt.Builder(l.a).setTitle(title)
                    .setNegativeButton("Use PIN", l.a.getMainExecutor(), new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int which) {
                            l.switching = true;
                            l.asking = false;
                            l.cancel = null;
                            l.a.ui.postDelayed(new Runnable() { @Override public void run() { l.credential(title); } }, 150);
                        }
                    })
                    .build();
            l.cancel = new CancellationSignal();
            p.authenticate(l.cancel, l.a.getMainExecutor(), l.new Callback(title));
        }
    }

    @TargetApi(33)
    static final class Api33 {
        static void recents(Activity a, boolean show) { a.setRecentsScreenshotEnabled(show); }
    }

    // ------------------------------------------------------------ the cover: nothing of the page shows or can be reached
    private void showCover() {
        if (cover == null) cover = build();
        if (cover.getParent() == null) a.addContentView(cover, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cover.setVisibility(View.VISIBLE);
        cover.bringToFront();
        cover.requestFocus();
        if (a.web != null) {
            a.web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            a.web.clearFocus();
        }
    }

    private void hideCover() {
        if (cover != null) cover.setVisibility(View.GONE);
        if (a.web != null) {
            a.web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            a.web.requestFocus();
        }
    }

    private View build() {
        float dp = a.getResources().getDisplayMetrics().density;
        LinearLayout l = new LinearLayout(a);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setBackgroundColor(Color.BLACK);
        l.setClickable(true);                           // touches stop here
        l.setFocusable(true);
        ImageView icon = new ImageView(a);
        icon.setImageResource(a.getApplicationInfo().icon);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        l.addView(icon, new LinearLayout.LayoutParams(Math.round(76 * dp), Math.round(76 * dp)));
        TextView t = new TextView(a);
        t.setText("Flick is locked");
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.topMargin = Math.round(22 * dp);
        l.addView(t, tp);
        TextView b = new TextView(a);
        b.setText("Unlock");
        b.setTextColor(Color.BLACK);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.WHITE);
        pill.setCornerRadius(24 * dp);
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33000000), pill, null));
        b.setPadding(Math.round(36 * dp), 0, Math.round(36 * dp), 0);
        b.setClickable(true);
        b.setFocusable(true);
        b.setContentDescription("Unlock Flick");
        b.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                quiet = false;
                ask();
            }
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Math.round(48 * dp));
        bp.topMargin = Math.round(30 * dp);
        l.addView(b, bp);
        return l;
    }
}
