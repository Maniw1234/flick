package com.flick.app;

import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * A Quick Settings tile that sends something in one tap (TilePhoto, TileClip), where one-tap sends go: the paired PC, or
 * the phone picked on the page (Actions.phoneTarget). The work happens in
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
            if (Build.VERSION.SDK_INT >= 29) Api29.subtitle(t, target());
            t.updateTile();
        } catch (Throwable e) { Bg.warn("tile", e); }
    }

    // where a tap sends it, chosen as Actions chooses it: the phone picked on the page (or, with no PC paired, the only
    // phone paired), else the paired PC
    private String target() {
        try {
            String phone = Actions.phoneTarget(this);
            if (phone != null) return "To " + Peers.get(this).nameOf(phone);
            android.content.SharedPreferences p = Bg.prefs(this);
            String pc = p.getString("p:lastPc", ""), n = p.getString("p:lastPcName", "");
            boolean paired = pc != null && pc.length() > 0 && p.getString("p:token:" + pc, "").length() > 0;
            return !paired || n == null || n.length() == 0 ? "No PC yet" : "To " + n;
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
