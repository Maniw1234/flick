package com.flick.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.provider.Settings;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * The phone's USB cable, as Flick sees it: plugged into a computer (a data connection to it, not just a charger), and
 * whether USB tethering is on (a network over the cable, which Flick on the computer answers over: the fastest link).
 * Android says so in a sticky broadcast (android.hardware.usb.action.USB_STATE: connected, rndis/ncm); the cable's own
 * network shows up a moment after tethering is turned on, so that's looked for too. The page hears 'usb' {cable,
 * tether} as it changes, and while the cable is new, computers are looked for fast (over the cable within a second).
 * An app can't turn tethering on itself: openTethering() opens the screen where it's one switch.
 */
final class UsbWatch {
    static final String USB_STATE = "android.hardware.usb.action.USB_STATE";
    interface Listener { void changed(boolean cable, boolean tether); }

    private static boolean started;
    private static volatile boolean cable, tether, phone;   // phone: the other end is a phone with Flick (UsbPeer switched this one over)
    private static volatile Listener listener;
    private static Context app;

    private UsbWatch() {}

    /** Starts listening (once, for the whole app). Never throws. */
    static synchronized void start(Context c, Listener l) {
        listener = l;
        if (started) { report(); return; }
        app = c.getApplicationContext();
        try {
            Intent sticky = app.registerReceiver(new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent i) { onState(i); }
            }, new IntentFilter(USB_STATE));
            started = true;
            if (sticky != null) onState(sticky);
        } catch (Throwable e) { Bg.warn("usb", e); }
    }

    /** l's activity is going: it hears nothing more, and isn't kept (the broadcast is still listened to, for the next). */
    static synchronized void forget(Listener l) { if (listener == l) listener = null; }

    /** {cable, tether, phone}. */
    static JSONObject state() {
        JSONObject o = new JSONObject();
        try { o.put("cable", cable); o.put("tether", tether); o.put("phone", phone); } catch (Exception e) { /* empty */ }
        return o;
    }

    private static void onState(Intent i) {
        if (i == null) return;
        boolean c = i.getBooleanExtra("connected", false);
        boolean t = c && (i.getBooleanExtra("rndis", false) || i.getBooleanExtra("ncm", false) || cableNetwork());
        boolean p = c && i.getBooleanExtra("accessory", false);
        set(c, t, p);
        // tethering just turned on: its network comes up a moment later (looked for a few times)
        if (c && !t) {
            for (int k = 1; k <= 6; k++) {
                Bg.mainDelayed(new Runnable() { @Override public void run() { if (cable && !tether && cableNetwork()) set(true, true, phone); } }, k * 1000L);
            }
        }
    }

    private static void set(boolean c, boolean t, boolean p) {
        boolean changed;
        synchronized (UsbWatch.class) { changed = c != cable || t != tether || p != phone; cable = c; tether = t; phone = p; }
        if (changed) report();
    }

    private static void report() {
        Page.event("usb", "cable", cable, "tether", tether, "phone", phone);
        Listener l = listener;
        if (l != null) { try { l.changed(cable, tether); } catch (Throwable e) { Bg.warn("usb", e); } }
    }

    /** A network over the USB cable is up (tethering on): an interface of that kind with an address. */
    static boolean cableNetwork() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                if (!"usb".equals(NetKind.typeOf(ni.getName()))) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) if (ia.getAddress() instanceof Inet4Address) return true;
            }
        } catch (Throwable e) { /* none */ }
        return false;
    }

    /** Opens Android's screen with the USB tethering switch (its own, a maker's, or the network settings). */
    static boolean openTethering(Context c) {
        Intent[] tries = {
            new Intent(Intent.ACTION_MAIN).setClassName("com.android.settings", "com.android.settings.TetherSettings"),
            new Intent(Intent.ACTION_MAIN).setClassName("com.android.settings", "com.android.settings.Settings$TetherSettingsActivity"),
            new Intent(Settings.ACTION_WIRELESS_SETTINGS),
        };
        PackageManager pm = c.getPackageManager();
        for (Intent i : tries) {
            try {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (pm != null && i.resolveActivity(pm) == null) continue;
                c.startActivity(i);
                return true;
            } catch (Throwable e) { /* the next */ }
        }
        return false;
    }
}
