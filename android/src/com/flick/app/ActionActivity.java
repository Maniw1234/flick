package com.flick.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * What a tile or the widget starts: an invisible activity that is in front just long enough for Android to let Flick
 * read the clipboard (Android 10+ allows it only to the app with focus) and to keep sending once it's gone (the send
 * counts as a transfer, so Flick keeps running). Then it finishes; a toast says "Sent to <PC>" or why not.
 */
public class ActionActivity extends Activity {
    static final String EXTRA_WHAT = "what";          // "photo" | "clip"
    static final String EXTRA_HOW = "how";            // "tile" | "widget"

    private boolean acted;

    static Intent intent(Context c, String what, String how) {
        return new Intent(c, ActionActivity.class)
                .putExtra(EXTRA_WHAT, what)
                .putExtra(EXTRA_HOW, how)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        overridePendingTransition(0, 0);
        String what = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_WHAT);
        if (!"photo".equals(what) && !"clip".equals(what)) { finish(); return; }
        // focus normally comes within a few frames; if it doesn't, go on anyway (the clipboard then reads empty)
        Bg.mainDelayed(late, 1500);
    }

    private final Runnable late = new Runnable() { @Override public void run() { act(); } };

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) act();
    }

    @Override
    protected void onDestroy() {
        Bg.mainCancel(late);
        super.onDestroy();
    }

    private void act() {
        if (acted || isFinishing()) return;
        acted = true;
        Bg.mainCancel(late);
        final Context app = getApplicationContext();
        Actions.Report toast = new Actions.Report() { @Override public void say(String msg) { Bg.toast(app, msg); } };
        String what = getIntent().getStringExtra(EXTRA_WHAT);
        String how = getIntent().getStringExtra(EXTRA_HOW);
        if (!"widget".equals(how)) how = "tile";
        try {
            if ("clip".equals(what)) {
                // taken now, while this has focus; an image in it is read and converted off the main thread
                final ClipData cd = Clip.grab(this);
                final Actions.Report say = toast;
                Bg.send("send clipboard", new Runnable() {
                    @Override public void run() { Actions.sendClipboard(app, Clip.describe(app, cd, true), say); }
                });
            } else {
                // counted as a transfer while Flick is still in front: it keeps running once this is gone
                Transfers.hold(app, true);
                Actions.sendLatestPhoto(app, how, true, toast);
            }
        } catch (Throwable e) {
            Bg.warn("action", e);
        }
        // after the work above was handed over (and the transfer service asked for) while this is still in front
        Bg.main(new Runnable() {
            @Override
            @SuppressWarnings("deprecation")
            public void run() {
                finish();
                overridePendingTransition(0, 0);
            }
        });
    }
}
