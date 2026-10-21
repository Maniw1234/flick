package com.flick.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** Finds Flick PCs on the local network: UDP broadcast query, unicast replies. */
final class Discovery implements Runnable {
    interface Listener { void onPcs(String json); }

    static final int PORT = 47870;

    private final Context ctx;
    private final Listener listener;
    private final String deviceId, deviceName;
    private volatile boolean active;
    private Thread thread;
    private final Map<String, JSONObject> found = new LinkedHashMap<String, JSONObject>();

    Discovery(Context ctx, String deviceId, String deviceName, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.listener = l;
    }

    synchronized void setActive(boolean on) {
        active = on;
        if (on && (thread == null || !thread.isAlive())) {
            thread = new Thread(this, "flick-discovery");
            thread.setDaemon(true);
            thread.start();
        }
    }

    @Override
    public void run() {
        while (active) {
            DatagramSocket s = null;
            WifiManager.MulticastLock lock = null;
            try {
                WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    lock = wm.createMulticastLock("flick-discovery");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
                s = new DatagramSocket();
                s.setBroadcast(true);
                s.setSoTimeout(200);
                byte[] buf = new byte[4096];
                long nextSend = 0, lastEmit = 0;
                String lastJson = "";
                while (active) {
                    long now = SystemClock.elapsedRealtime();
                    if (now >= nextSend) {
                        sendQueries(s);
                        nextSend = now + (found.isEmpty() ? 700 : 1500);
                    }
                    try {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        s.receive(p);
                        handle(p);
                    } catch (SocketTimeoutException e) { /* tick */ }
                    String json = snapshot(SystemClock.elapsedRealtime());
                    if (!json.equals(lastJson) || now - lastEmit > 2000) {
                        lastJson = json;
                        lastEmit = now;
                        listener.onPcs(json);
                    }
                }
            } catch (Throwable e) {
                try { Thread.sleep(1500); } catch (InterruptedException x) { /* ignore */ }
            } finally {
                if (s != null) s.close();
                try { if (lock != null && lock.isHeld()) lock.release(); } catch (Throwable e) { /* ignore */ }
            }
        }
        synchronized (this) { thread = null; }
    }

    private void sendQueries(DatagramSocket s) {
        byte[] b;
        try {
            JSONObject q = new JSONObject();
            q.put("t", "flick?");
            q.put("v", 1);
            q.put("id", deviceId);
            q.put("name", deviceName);
            b = q.toString().getBytes("UTF-8");
        } catch (Throwable e) { return; }
        Set<InetAddress> targets = new LinkedHashSet<InetAddress>();
        try { targets.add(InetAddress.getByName("255.255.255.255")); } catch (Throwable e) { /* ignore */ }
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress bc = ia.getBroadcast();
                    if (bc != null && ia.getAddress() instanceof Inet4Address) targets.add(bc);
                }
            }
        } catch (Throwable e) { /* ignore */ }
        for (InetAddress t : targets) {
            try { s.send(new DatagramPacket(b, b.length, t, PORT)); } catch (Throwable e) { /* ignore */ }
        }
    }

    private void handle(DatagramPacket p) {
        try {
            String txt = new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8");
            JSONObject m = new JSONObject(txt);
            if (!"flick!".equals(m.optString("t"))) return;
            String id = m.optString("id", "");
            if (id.length() == 0) return;
            JSONObject pc = new JSONObject();
            pc.put("id", id);
            pc.put("name", m.optString("name", "PC"));
            pc.put("ip", p.getAddress().getHostAddress());
            pc.put("port", m.optInt("port", 47860));
            pc.put("known", m.optBoolean("known", false));
            pc.put("seen", SystemClock.elapsedRealtime());
            synchronized (found) { found.put(id, pc); }
        } catch (Throwable e) { /* ignore junk */ }
    }

    private String snapshot(long now) {
        JSONArray a = new JSONArray();
        synchronized (found) {
            Iterator<Map.Entry<String, JSONObject>> it = found.entrySet().iterator();
            while (it.hasNext()) {
                JSONObject pc = it.next().getValue();
                if (now - pc.optLong("seen") > 7000) { it.remove(); continue; }
                try {
                    JSONObject o = new JSONObject();
                    o.put("id", pc.optString("id"));
                    o.put("name", pc.optString("name"));
                    o.put("ip", pc.optString("ip"));
                    o.put("port", pc.optInt("port"));
                    o.put("known", pc.optBoolean("known"));
                    a.put(o);
                } catch (Throwable e) { /* ignore */ }
            }
        }
        return a.toString();
    }
}
