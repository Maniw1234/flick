package com.flick.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The buttons on Flick's notifications: Stop (ringing) and Turn off (the background link). Not exported. */
public class ActionReceiver extends BroadcastReceiver {
    static final String RING_STOP = "com.flick.app.RING_STOP";
    static final String BG_OFF = "com.flick.app.BG_OFF";

    @Override
    public void onReceive(Context c, Intent i) {
        try {
            String a = i == null ? null : i.getAction();
            if (RING_STOP.equals(a)) Ringer.stop(c, "user");
            else if (BG_OFF.equals(a)) { LinkService.stop(c); Page.featuresChanged(); }
        } catch (Throwable e) { Bg.warn("action", e); }
    }
}
