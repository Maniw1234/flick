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
    // addresses paired PCs were seen at before (the page remembers them): asked directly too, for networks that don't
    // pass broadcasts (or where the PC is in another subnet, as on many office networks)
    private volatile String[] known = new String[0];
    private final String anon = "q" + Long.toHexString(new java.security.SecureRandom().nextLong());
    // the user is holding Connect: asked every 300 ms, so the device they mean shows up within a moment
    private volatile boolean fast;
    // PCs (each at each address) listed at most: anyone on the network can answer, as any number of made-up PCs, and the
    // list is looked at again with each answer; one more is left out, unless it answers from an address a paired PC had
    private static final int MAX_FOUND = 64;

    /** ips: where paired PCs were seen before. */
    void setKnown(String[] ips) { known = ips == null ? new String[0] : ips; }

    /** Asks every 300 ms while on (the user is holding Connect), else at the usual pace. */
    void setFast(boolean on) { fast = on; }

    // a USB cable was just plugged in (or tethering turned on): asked fast for a few seconds, so a PC over it shows up
    // within a second
    private volatile long boostUntil;
    void boost(long ms) { boostUntil = SystemClock.elapsedRealtime() + ms; }

    Discovery(Context ctx, String deviceId, String deviceName, Listener l) {
        this.ctx = ctx.getApplicationContext();
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.listener = l;
    }

    synchronized void setActive(boolean on) {
        active = on;
        // (the thread there goes on, or is gone: it decides to end under this lock, see run)
        if (on && thread == null) {
            thread = new Thread(this, "flick-discovery");
            thread.setDaemon(true);
            thread.start();
        }
    }

    @Override
    public void run() {
        while (true) {
            // Decided under the lock, so turned off and on again quickly the search goes on: this thread either sees it on
            // again here, or is gone from thread before setActive looks (it started another). Deciding outside it, the
            // search could stop for good with it on (its thread ending just as it was turned on again).
            synchronized (this) { if (!active) { thread = null; return; } }
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
                long lastSend = -1000000, lastEmit = 0, lastLook = 0;
                String lastJson = "";
                while (active) {
                    long now = SystemClock.elapsedRealtime();
                    // (the pace is looked at each time: holding Connect speeds up the very next question)
                    if (now - lastSend >= (fast || now < boostUntil ? 300 : found.isEmpty() ? 700 : 1500)) {
                        sendQueries(s);
                        lastSend = now;
                    }
                    boolean changed = false;
                    try {
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        s.receive(p);
                        changed = handle(p);
                    } catch (SocketTimeoutException e) { /* tick */ }
                    // the list as the page gets it: at once after an answer that changed it, else every 250 ms (PCs gone
                    // quiet drop off), not after every answer (a device on the network can send thousands a second)
                    long t = SystemClock.elapsedRealtime();
                    if (!changed && t - lastLook < 250) continue;
                    lastLook = t;
                    String json = snapshot(t);
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
        // mDNS: a plain DNS question for _flick._tcp, answered straight back
        try { byte[] q = Mdns.query(); s.send(new DatagramPacket(q, q.length, InetAddress.getByName(Mdns.GROUP), Mdns.PORT)); } catch (Throwable e) { /* no multicast here */ }
        // the addresses paired PCs had: asked without saying who this phone is (it may be another network)
        String[] ips = known;
        if (ips.length > 0) {
            byte[] a;
            try { a = ("{\"t\":\"flick?\",\"v\":1,\"id\":\"" + anon + "\"}").getBytes("UTF-8"); } catch (Throwable e) { return; }
            for (String ip : ips) {
                try { s.send(new DatagramPacket(a, a.length, InetAddress.getByName(ip), PORT)); } catch (Throwable e) { /* ignore */ }
            }
        }
    }

    // ---- which kind of link a reply came over (NetKind: PeerClient asks the same about other phones)
    static String linkFor(InetAddress remote) { return NetKind.linkFor(remote); }
    static int rank(String via) { return NetKind.rank(via); }

    // an answer: whether it changed the list the page gets
    private boolean handle(DatagramPacket p) {
        // (one from this phone itself is another app's: a PC is never this phone, and an app answering in a paired PC's
        // name first would be listed as that PC)
        if (p.getAddress() == null || p.getAddress().isLoopbackAddress()) return false;
        if (p.getLength() > 12 && p.getData()[p.getOffset()] != '{') return mdns(p);
        try {
            String txt = new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8");
            JSONObject m = new JSONObject(txt);
            if (!"flick!".equals(m.optString("t"))) return false;
            // (anyone can answer: an id a Flick PC has, and a port one can listen on, or it isn't one)
            String id = m.optString("id", "");
            int port = m.optInt("port", 47860);
            if (!pcId(id) || port <= 0 || port > 65535) return false;
            String ip = p.getAddress().getHostAddress();
            JSONObject pc = new JSONObject();
            pc.put("id", id);
            // (text only, without the characters that would turn the words around it backwards)
            String nm = PeerServer.cleanName(m.opt("name"));
            pc.put("name", nm.isEmpty() ? "PC" : nm);
            pc.put("ip", ip);
            pc.put("port", port);
            pc.put("known", m.optBoolean("known", false));
            pc.put("v", m.optInt("v", 1));
            pc.put("tls", m.optInt("tls", 0));      // 1: the PC takes encrypted links (protocol 4)
            // its window is open on screen: when several PCs answer, it's the one the user means (holding Connect here)
            pc.put("ready", m.optInt("ready", 0) == 1);
            pc.put("via", linkFor(p.getAddress()));
            pc.put("seen", SystemClock.elapsedRealtime());
            // one entry per PC and address: the same PC can be reachable over a cable and Wi-Fi at once
            return keep(id + "@" + ip, pc, ip);
        } catch (Throwable e) { return false; /* junk */ }
    }

    /** An id a Flick PC has (made up once: letters, digits, - and _), as phones check each other's. */
    static boolean pcId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{1,64}"); }

    private static boolean among(String[] ips, String ip) {
        for (String k : ips) if (k.equals(ip)) return true;
        return false;
    }

    // listed (see MAX_FOUND): whether that changed what the page is shown of it (not only when it was last seen)
    private boolean keep(String key, JSONObject pc, String ip) {
        boolean paired = among(known, ip);
        synchronized (found) {
            JSONObject was = found.get(key);
            if (was == null && found.size() >= MAX_FOUND && !paired) return false;
            found.put(key, pc);
            return was == null || !looks(was).equals(looks(pc));
        }
    }
    private static String looks(JSONObject pc) {
        return pc.optString("name") + "|" + pc.optInt("port") + "|" + pc.optBoolean("known") + "|" + pc.optInt("v") + "|" + pc.optInt("tls") + "|" + pc.optBoolean("ready") + "|" + pc.optString("via");
    }

    /** An mDNS answer: the PCs it describes, like discovery replies (whether it changed the list). */
    private boolean mdns(DatagramPacket p) {
        String from = p.getAddress().getHostAddress();
        boolean changed = false;
        for (Mdns.Pc m : Mdns.parse(p.getData(), p.getOffset(), p.getLength(), from)) {
            if (!pcId(m.id) || m.port <= 0 || m.port > 65535) continue;
            try {
                JSONObject pc = new JSONObject();
                pc.put("id", m.id);
                String nm = PeerServer.cleanName(m.name);
                pc.put("name", nm.isEmpty() ? "PC" : nm);
                pc.put("ip", m.ip);
                pc.put("port", m.port);
                pc.put("known", false);
                pc.put("v", m.v);
                pc.put("tls", m.tls);
                pc.put("via", linkFor(p.getAddress()));
                pc.put("seen", SystemClock.elapsedRealtime());
                changed |= keep(m.id + "@" + m.ip, pc, m.ip);
            } catch (Throwable e) { /* ignore */ }
        }
        return changed;
    }

    /**
     * Each PC once, at its fastest address; every address it was seen at is listed under "links". Among addresses as
     * fast, one a paired PC was seen at before (known) comes first: anyone on the network can answer in a PC's name, and
     * sooner than the PC, and the first answer would be the one the page goes to.
     */
    private String snapshot(long now) {
        Map<String, JSONObject> best = new LinkedHashMap<String, JSONObject>();
        Map<String, JSONArray> links = new LinkedHashMap<String, JSONArray>();
        String[] ips = known;
        synchronized (found) {
            Iterator<Map.Entry<String, JSONObject>> it = found.entrySet().iterator();
            while (it.hasNext()) {
                JSONObject pc = it.next().getValue();
                if (now - pc.optLong("seen") > 7000) { it.remove(); continue; }
                String id = pc.optString("id");
                JSONObject cur = best.get(id);
                int r = cur == null ? 0 : rank(pc.optString("via")) - rank(cur.optString("via"));
                if (cur == null || r > 0 || (r == 0 && among(ips, pc.optString("ip")) && !among(ips, cur.optString("ip")))) best.put(id, pc);
                JSONArray l = links.get(id);
                if (l == null) { l = new JSONArray(); links.put(id, l); }
                try { l.put(new JSONObject().put("ip", pc.optString("ip")).put("port", pc.optInt("port")).put("via", pc.optString("via"))); } catch (Throwable e) { /* ignore */ }
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
                if (pc.optBoolean("ready")) o.put("ready", true);
                o.put("links", links.get(pc.optString("id")));
                a.put(o);
            } catch (Throwable e) { /* ignore */ }
        }
        return a.toString();
    }
}
