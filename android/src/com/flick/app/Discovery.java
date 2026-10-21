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

    // ---- which kind of link a reply came over: the local interface whose subnet holds the PC's address
    static String linkFor(InetAddress remote) {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof Inet4Address && sameSubnet(a, remote, ia.getNetworkPrefixLength())) return typeOf(ni.getName());
                }
            }
        } catch (Throwable e) { /* unknown */ }
        return "wifi";
    }

    static boolean sameSubnet(InetAddress a, InetAddress b, int prefix) {
        byte[] x = a.getAddress(), y = b.getAddress();
        if (x.length != y.length || prefix <= 0) return false;
        for (int i = 0; i < x.length && prefix > 0; i++, prefix -= 8) {
            int mask = prefix >= 8 ? 0xff : (0xff << (8 - prefix)) & 0xff;
            if ((x[i] & mask) != (y[i] & mask)) return false;
        }
        return true;
    }

    static String typeOf(String iface) {
        String n = iface == null ? "" : iface.toLowerCase(java.util.Locale.ROOT);
        if (n.startsWith("rndis") || n.startsWith("usb") || n.startsWith("ncm")) return "usb";
        if (n.startsWith("ap") || n.startsWith("swlan") || n.startsWith("softap") || n.startsWith("wigig") || n.equals("wlan1")) return "hotspot";
        if (n.startsWith("p2p")) return "direct";
        if (n.startsWith("eth")) return "ethernet";
        if (n.startsWith("bt-pan") || n.startsWith("bnep")) return "bluetooth";
        return "wifi";
    }

    /** Faster links first: a cable beats a direct radio link, which beats Wi-Fi through a router. */
    static int rank(String via) {
        if ("usb".equals(via)) return 5;
        if ("ethernet".equals(via)) return 4;
        if ("hotspot".equals(via) || "direct".equals(via)) return 3;
        if ("wifi".equals(via)) return 2;
        return 1;
    }

    private void handle(DatagramPacket p) {
        try {
            String txt = new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8");
            JSONObject m = new JSONObject(txt);
            if (!"flick!".equals(m.optString("t"))) return;
            String id = m.optString("id", "");
            if (id.length() == 0) return;
            String ip = p.getAddress().getHostAddress();
            JSONObject pc = new JSONObject();
            pc.put("id", id);
            pc.put("name", m.optString("name", "PC"));
            pc.put("ip", ip);
            pc.put("port", m.optInt("port", 47860));
            pc.put("known", m.optBoolean("known", false));
            pc.put("v", m.optInt("v", 1));
            pc.put("tls", m.optInt("tls", 0));      // 1: the PC takes encrypted links (protocol 4)
            pc.put("via", linkFor(p.getAddress()));
            pc.put("seen", SystemClock.elapsedRealtime());
            // one entry per PC and address: the same PC can be reachable over a cable and Wi-Fi at once
            synchronized (found) { found.put(id + "@" + ip, pc); }
        } catch (Throwable e) { /* ignore junk */ }
    }

    /** Each PC once, at its fastest address; every address it was seen at is listed under "links". */
    private String snapshot(long now) {
        Map<String, JSONObject> best = new LinkedHashMap<String, JSONObject>();
        Map<String, JSONArray> links = new LinkedHashMap<String, JSONArray>();
        synchronized (found) {
            Iterator<Map.Entry<String, JSONObject>> it = found.entrySet().iterator();
            while (it.hasNext()) {
                JSONObject pc = it.next().getValue();
                if (now - pc.optLong("seen") > 7000) { it.remove(); continue; }
                String id = pc.optString("id");
                JSONObject cur = best.get(id);
                if (cur == null || rank(pc.optString("via")) > rank(cur.optString("via"))) best.put(id, pc);
                JSONArray l = links.get(id);
                if (l == null) { l = new JSONArray(); links.put(id, l); }
                try { l.put(new JSONObject().put("ip", pc.optString("ip")).put("via", pc.optString("via"))); } catch (Throwable e) { /* ignore */ }
            }
        }
        JSONArray a = new JSONArray();
        for (JSONObject pc : best.values()) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", pc.optString("id"));
                o.put("name", pc.optString("name"));
                o.put("ip", pc.optString("ip"));
                o.put("port", pc.optInt("port"));
                o.put("known", pc.optBoolean("known"));
                o.put("v", pc.optInt("v", 1));
                o.put("tls", pc.optInt("tls", 0));
                o.put("via", pc.optString("via", "wifi"));
                o.put("links", links.get(pc.optString("id")));
                a.put(o);
            } catch (Throwable e) { /* ignore */ }
        }
        return a.toString();
    }
}
