package com.flick.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The buttons on Flick's notifications: Stop (ringing), Turn off (the background link), Accept and Decline (files from
 *  a device set to "Ask each time"), Cancel (a transfer). Not exported. */
public class ActionReceiver extends BroadcastReceiver {
    static final String RING_STOP = "com.flick.app.RING_STOP";
    static final String BG_OFF = "com.flick.app.BG_OFF";
    static final String ACCEPT = "com.flick.app.ACCEPT", DECLINE = "com.flick.app.DECLINE";
    static final String MOVING_CANCEL = "com.flick.app.MOVING_CANCEL";   // extra "key": the transfer (Moving)

    @Override
    public void onReceive(Context c, Intent i) {
        try {
            String a = i == null ? null : i.getAction();
            if (RING_STOP.equals(a)) Ringer.stop(c, "user");
            else if (BG_OFF.equals(a)) { LinkService.stop(c); Page.featuresChanged(); }
            else if (ACCEPT.equals(a) || DECLINE.equals(a)) Peers.get(c).decide(i.getStringExtra("tid"), ACCEPT.equals(a), "declined");
            else if (MOVING_CANCEL.equals(a)) Moving.cancelSoon(i.getStringExtra("key"));
        } catch (Throwable e) { Bg.warn("action", e); }
    }
}
