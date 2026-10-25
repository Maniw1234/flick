package com.flick.app;

import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * A Quick Settings tile that sends something to the paired PC in one tap (TilePhoto, TileClip). The work happens in
 * ActionActivity: the clipboard can only be read by the app in front. A locked phone is unlocked first.
 */
abstract class FlickTile extends TileService {
    /** "photo" or "clip". */
    abstract String what();

    abstract String label();

    @Override
    public void onStartListening() {
        super.onStartListening();
        try {
            Tile t = getQsTile();
            if (t == null) return;
            t.setLabel(label());
            t.setState(Tile.STATE_INACTIVE);
            if (Build.VERSION.SDK_INT >= 29) Api29.subtitle(t, pcName());
            t.updateTile();
        } catch (Throwable e) { Bg.warn("tile", e); }
    }

    private String pcName() {
        try {
            String n = Bg.prefs(this).getString("p:lastPcName", "");
            return n == null || n.length() == 0 ? "No PC yet" : "To " + n;
        } catch (Throwable e) { return ""; }
    }

    @Override
    public void onClick() {
        super.onClick();
        Runnable go = new Runnable() {
            @Override
            @SuppressWarnings("deprecation")
            public void run() {
                try {
                    Intent i = ActionActivity.intent(FlickTile.this, what(), "tile");
                    if (Build.VERSION.SDK_INT >= 34) Api34.start(FlickTile.this, i, "photo".equals(what()) ? 1 : 2);
                    else startActivityAndCollapse(i);
                } catch (Throwable e) { Bg.warn("tile", e); }
            }
        };
        try {
            if (isLocked()) unlockAndRun(go); else go.run();
        } catch (Throwable e) { Bg.warn("tile", e); }
    }

    @TargetApi(29)
    static final class Api29 {
        static void subtitle(Tile t, String s) { t.setSubtitle(s); }
    }

    @TargetApi(34)
    static final class Api34 {
        static void start(TileService s, Intent i, int code) {
            s.startActivityAndCollapse(PendingIntent.getActivity(s, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
    }
}
