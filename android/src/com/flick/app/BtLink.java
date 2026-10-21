package com.flick.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Bluetooth link to Flick on a paired PC, for when there is no network between them. Tries the paired computers for
 * Flick's service; once one answers, everything runs over it through BtMux (a local port stands in for the PC).
 * States reported: off, unsupported, denied (permission), radio-off, searching, on.
 */
final class BtLink implements Runnable {
    interface Listener { void onBt(String state, JSONObject pc); }

    static final UUID SERVICE = UUID.fromString("7d5b9a64-3c1e-4f0a-9b8e-6c2a1f4e8d10");

    private final Context ctx;
    private final Listener listener;
    private volatile boolean wanted;
    private Thread thread;
    private volatile BtMux mux;
    volatile String state = "off";

    BtLink(Context c, Listener l) { this.ctx = c.getApplicationContext(); this.listener = l; }

    static boolean permitted(Context c) {
        return Build.VERSION.SDK_INT < 31 || c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    synchronized void setWanted(boolean on) {
        wanted = on;
        if (on && (thread == null || !thread.isAlive())) {
            thread = new Thread(this, "flick-bt");
            thread.setDaemon(true);
            thread.start();
        }
        if (!on) {
            BtMux m = mux;
            if (m != null) m.close("not needed");
            report("off", null);
        }
    }

    private void report(String s, JSONObject pc) {
        state = s;
        try { listener.onBt(s, pc); } catch (Throwable e) { /* ignore */ }
    }

    private static void nap(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { /* ignore */ } }

    private BluetoothAdapter adapter() {
        try {
            BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            return bm != null ? bm.getAdapter() : null;
        } catch (Throwable e) { return null; }
    }

    /** Paired devices that may be a PC: computers first, then anything without a clear class. */
    @SuppressLint("MissingPermission")
    private static List<BluetoothDevice> candidates(BluetoothAdapter ad) {
        List<BluetoothDevice> pcs = new ArrayList<BluetoothDevice>(), other = new ArrayList<BluetoothDevice>();
        Set<BluetoothDevice> bonded = ad.getBondedDevices();
        if (bonded == null) return pcs;
        for (BluetoothDevice d : bonded) {
            BluetoothClass c = d.getBluetoothClass();
            int major = c == null ? BluetoothClass.Device.Major.UNCATEGORIZED : c.getMajorDeviceClass();
            if (major == BluetoothClass.Device.Major.COMPUTER) pcs.add(d);
            else if (major == BluetoothClass.Device.Major.UNCATEGORIZED || major == BluetoothClass.Device.Major.MISC) other.add(d);
        }
        pcs.addAll(other);
        return pcs;
    }

    @Override
    @SuppressLint("MissingPermission")
    public void run() {
        while (wanted) {
            try {
                BluetoothAdapter ad = adapter();
                if (ad == null) { report("unsupported", null); nap(30000); continue; }
                if (!permitted(ctx)) { report("denied", null); nap(4000); continue; }
                if (!ad.isEnabled()) { report("radio-off", null); nap(4000); continue; }
                report("searching", null);
                boolean linked = false;
                for (BluetoothDevice d : candidates(ad)) {
                    if (!wanted) break;
                    BluetoothSocket s = null;
                    try {
                        try { ad.cancelDiscovery(); } catch (Throwable e) { /* needs another permission on new Android; harmless */ }
                        s = d.createRfcommSocketToServiceRecord(SERVICE);
                        s.connect();
                    } catch (Throwable e) {
                        try { if (s != null) s.close(); } catch (Throwable x) { /* ignore */ }
                        continue;
                    }
                    final Object lock = new Object();
                    BtMux m = new BtMux(s.getInputStream(), s.getOutputStream(), s, new BtMux.Listener() {
                        @Override public void onClosed(String why) { synchronized (lock) { lock.notifyAll(); } }
                    });
                    int port;
                    try { port = m.start(); } catch (Throwable e) { m.close("start"); continue; }
                    JSONObject pc = hello(port, d);
                    if (pc == null) { m.close("hello"); continue; }
                    mux = m;
                    linked = true;
                    report("on", pc);
                    synchronized (lock) { while (!m.isClosed() && wanted) lock.wait(5000); }
                    mux = null;
                    if (wanted) report("searching", null);
                    break;
                }
                if (!linked && wanted) nap(8000);
            } catch (Throwable e) {
                nap(5000);
            }
        }
    }

    /** Asks Flick on the other end who it is (through the new link). */
    @SuppressLint("MissingPermission")
    private static JSONObject hello(int port, BluetoothDevice d) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/hello").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(12000);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0 && b.size() < 64 * 1024) b.write(buf, 0, n);
            in.close();
            JSONObject j = new JSONObject(b.toString("UTF-8"));
            if (!"flick".equals(j.optString("app"))) return null;
            JSONObject pc = new JSONObject();
            pc.put("id", j.optString("id"));
            pc.put("name", j.optString("name", "PC"));
            pc.put("ip", "127.0.0.1");
            pc.put("port", port);
            pc.put("v", j.optInt("v", 1));
            pc.put("via", "bluetooth");
            try { pc.put("bt", d.getName()); } catch (Throwable e) { /* ignore */ }
            return pc;
        } catch (Throwable e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
