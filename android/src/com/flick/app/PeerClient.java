package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Sending to other phones (PeerServer is the other side; pc/peerlink.js is the same thing for computers): finding them
 * on the network, pairing once with the 6-digit code (both ways: right after it, this phone gives the other one a
 * token for its own receiver and its certificate, 'peer-back'), signing in, and sending files and folders. Encrypted,
 * and pinned to the certificate seen when pairing. Plain Java (no Android classes): the app's side is the Host.
 */
final class PeerClient {
    interface Host {
        String id();
        String name();
        /** Devices this phone sends to: id -> { name, kind, fp, token, addrs: [ "ip:port" ], added, bk? }. Then saved(). */
        JSONObject links();
        void saved();
        /** Pairing goes both ways: the other device may send here from now on. Returns { token, fp, port }. */
        JSONObject grant(String id, String name, String kind) throws Exception;
        /**
         * It's removed: it may not send here any more. tell: this phone's user removed it (its link here hears so);
         * not when it's undone for another reason, or the other phone removed this one.
         */
        void revoke(String id, boolean tell);
        /** The devices that may send here (a copy): id -> { name, kind, prov? }. Those not in links() are paired one way. */
        JSONObject allowedHere();
        /** Something the list shows changed. */
        void changed();
        /** Signed in, the files go now (what the page shows leaving). */
        void started(String id, String tid, JSONObject info);
        /** It went (tid: which send; files: how many); note: what was left out, in words for the user, or null. */
        void sent(String id, String tid, String to, String name, int files, long bytes, String note);
        /**
         * A send didn't go (tid: which send, null if it never started): why, in words for the user; null when canceled
         * here. canceled: canceled here, or there by its user (why says so: "Canceled on Pixel 7"). word: what History
         * keeps as the reason: "declined" or "timeout" (the other phone's user said no, or didn't answer in time),
         * "unpaired" (it doesn't take files from this phone any more), "quit" (Flick was closed there), else "send".
         */
        void failed(String id, String tid, String to, String why, boolean canceled, String word);
        /** Files are going (on), or stopped going (off): one off for each on. */
        void working(boolean on);
        /** A small picture of a photo or video being sent, for the other phone's card: {thumb: data URL, aspect}, or null. */
        JSONObject thumbFor(File f);
        /** The card of a send flicked to this phone landed on its screen ('landed'): a thud in the hand. */
        void landed(String id, String tid);
        /** The phone this one rang (find my phone) was found: its user stopped the ringing there. */
        void ringFound(String id);
        /** Looking for phones now (on), or not any more: beyond the network too (Bluetooth). */
        void looking(boolean on);
        /** A paired phone that doesn't answer on the network: looked for beyond it (Bluetooth), for ms (0: not any more, it
         *  was reached). False: it can't be. */
        boolean lookFor(String id, long ms);
        /** It could be looked for beyond the network if Flick were on screen here (Android 10 and 11 look only then). */
        boolean farIfShown();
        /** Wi-Fi Direct can be used here now (WifiDirect: allowed, Wi-Fi on). */
        boolean directReady();
        /** The Flick Wi-Fi Direct network this phone is in now, or "". Blocks a moment. */
        String directGroup();
        /** Joins Wi-Fi Direct network ssid, until it has an address next to ip; false when it can't in ms. Blocks. */
        boolean directJoin(String ssid, String pass, String ip, long ms, AtomicBoolean abort);
        /** A send over Wi-Fi Direct starts (on) or ends: its network stays meanwhile. */
        void directUse(boolean on);
        /** A paired phone signed in through the cable or Bluetooth link at this local port: that link is really its. */
        void tunnelVerified(String id, int port);
        /** The link at this local port only said it was that phone's (its certificate isn't): it ends. */
        void tunnelBad(String id, int port);
        /** Nothing could be reached through the link at this local port (one tried in place of a proven one ends). */
        void tunnelFailed(String id, int port);
        /** What of this phone's own connection from local port from the link at local port port has sent on so far
         *  (-1: not a link's). */
        long carried(int port, int from);
        /** This phone's own connection to the link at local port port, from local port from, is on its way (a link
         *  takes nothing else: other apps on the phone can reach its port too). */
        void expect(int port, int from);
        /** This phone's own connection from local port from, through the link at local port port, was stopped here (a
         *  Cancel): the link drops what it still has of it and tells the other side now. */
        default void cut(int port, int from) { }
        /** This phone's Bluetooth key (base64: Peers.bleKey), for its paired phones only. */
        String bleKey();
        void log(String s);
    }

    // Bluetooth is slow for files (well under 1 MB a second): this much or more goes over Wi-Fi Direct when both phones
    // can (setting it up takes a few seconds)
    static long DIRECT_MIN = 3L * 1024 * 1024;

    private static final long SEEN_MS = 12000, SCAN_MS = 3000, IDLE_MS = 60000;
    // Nothing moving either way on an upload this long (the other phone stopped reading, or never answers once all of it
    // went, or the network went) ends it; a frame that can't be written this long ends its link.
    private static final long STALL_MS = 30000, WRITE_MS = 10000;
    // What went into an upload's connection can take long to arrive over a slow network: it holds up to this much on its
    // way, carried at no less than this pace (a slow Wi-Fi). A phone that doesn't say how much came ('recv') is waited for
    // that long once all of it went (as a computer waits: pc/peerlink.js).
    private static final long IN_FLIGHT = 8L * 1024 * 1024, SLOW_RATE = 64 * 1024;
    // the slowest a link that still works moves: what moves on an upload buys time at this pace (see post)
    private static final long MIN_PACE = 8 * 1024;
    // All of it went but the answer to the upload was lost (its connection broke): the other phone says over the link
    // that all of it came ('got') as it does, so nothing within this long means it never all came.
    private static final long GOT_MS = 10000;
    // the other phone allowed a pairing: this long for the user here to say the codes match
    private static final long CONFIRM_MS = 120000;
    private static final int MAX_WS = 1024 * 1024;
    private static final int MAX_TRIES = 16;            // ways tried to reach a phone for one link at most
    private static final int MAX_WS_EARLY = 64 * 1024;  // what the other side may send before it has proven who it is
    private static final int MAX_FOUND = 64;            // nearby phones kept (anyone can answer; paired ones always are)
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    // closes what's taking too long (a handshake trickling in, a write the other side never reads); no thread while
    // nothing is waiting
    static final ScheduledThreadPoolExecutor GUARD = newGuard();

    private static ScheduledThreadPoolExecutor newGuard() {
        ScheduledThreadPoolExecutor g = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-peer-watch"); t.setDaemon(true); return t; }
        });
        g.setRemoveOnCancelPolicy(true);
        g.setKeepAliveTime(30, TimeUnit.SECONDS);
        g.allowCoreThreadTimeOut(true);
        return g;
    }

    // one thread doing one thing after another, in order (no thread while there's nothing to do)
    private static ExecutorService serial(final String name) {
        ThreadPoolExecutor p = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>(), new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, name); t.setDaemon(true); return t; }
        });
        p.allowCoreThreadTimeOut(true);
        return p;
    }

    private final Host host;
    private final SSLSocketFactory sf;
    private final SecureRandom rnd = new SecureRandom();
    private final int discoveryPort;
    private final List<Integer> extraPorts = new ArrayList<Integer>();      // tests: devices on this computer
    private final Map<String, Found> found = new HashMap<String, Found>();
    private final Map<String, Busy> busy = new HashMap<String, Busy>();
    private final Map<String, String> errors = new HashMap<String, String>();
    // (under busy) how many times pairing with each was asked for: the list says it, so the page tells what its own
    // request came to from what an earlier one left
    private final Map<String, Integer> attempts = new HashMap<String, Integer>();
    // (under busy) ids whose words in errors say a send was canceled there, by the other device's user: not a failure
    private final Set<String> canceledThere = new HashSet<String>();
    private final Map<String, Link> live = new HashMap<String, Link>();
    // each phone's turn at making a link to it (see link)
    private final Map<String, java.util.concurrent.locks.ReentrantLock> linking = new HashMap<String, java.util.concurrent.locks.ReentrantLock>();
    // (under linking) each phone's last try that didn't reach it: {when, its words, its code}
    private final Map<String, Object[]> linkFailed = new HashMap<String, Object[]>();
    // (under itself) the ids sends that went again have on the other phone -> the send's own (the last few: see 'landed')
    private final Map<String, String> wires = new java.util.LinkedHashMap<String, String>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> e) { return size() > 32; }
    };
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final ExecutorService looks = serial("flick-peer-look");           // Bluetooth's looking, turned on and off
    private volatile boolean scanning;
    // the user is holding Connect: asked every 300 ms (and nearby phones answered within the last few seconds count)
    private volatile boolean fast;
    private int scanGen;                                                    // (a scan thread from before stops)
    private DatagramSocket udp;
    private DatagramSocket udpWifi;   // the same, on the Wi-Fi when that isn't the default network (no internet there)
    private int looking = 0;                                                // sends looking for a device right now

    // ready: its Connect screen is showing (the one meant, when the user holds Connect here with several phones around);
    // via: the kind of link it answered over (a cable or a direct link is the one meant too)
    static final class Found { String id, name, kind, os, ip, altIp, via; int port, altPort; long seen, ipSeen, altSeen; boolean ready; }
    static final class Busy {
        String what, code, tid, name;
        volatile String wire;                // a send's id on the other phone (tid, or another once it went again)
        boolean codeOk, allowed;
        // bodyDone: all of it was written; delivered: the other phone said it has all of it (it's being saved); late: the
        // user stopped it after that (it ends as sent)
        volatile boolean canceled, asking, delivered, bodyDone, late;
        volatile long sent, total;
        int files, items, left;              // items: the ones picked, a folder being one (as the other side asks);
                                             // left: files that couldn't be read and didn't go
        boolean deep;                        // folders too deep to be taken were left out
        JSONObject fx;                       // how it was flicked (look, y, vx): its card arrives there the same way
        volatile Bundle bundle;              // what's sent (its file going now, for the list of what moves)
        Link link;
        final Object lock = new Object();
        JSONObject reply;                    // the other phone's answer about it ('saved', 'failed'), under lock
        ScheduledFuture<?> lateT;
        volatile Socket opening;             // the connection being made (Cancel closes it, wherever it is)
        volatile Socket upload;              // the upload's connection (the plain one under its encryption)
        volatile boolean far;                // it was looked for, or tried, beyond the network too (Bluetooth, Wi-Fi Direct)
        volatile boolean farShut;            // it would have been looked for over Bluetooth with Flick on screen here
        volatile boolean posted;             // its upload started (all of it can be there from then on)
        volatile boolean cancelSent;         // the other phone was told it's canceled
        volatile boolean kept;               // ...and said it was too late: it's being saved
        volatile boolean held;               // waiting to go again: the other phone took too many from this one lately
        volatile boolean removedThere;       // the other phone's user removed this phone meanwhile (it said so): not a Cancel here
        // reports: the other phone says how much of the upload has come ('recv': it was asked to); recv: how much it said
        // last (the list shows that as sent then, and the upload's watch goes by it too)
        volatile boolean reports;
        volatile long recv;
        /** What the list shows went: what the other phone says has come, when it says so; else what went into the connection. */
        long shown() { return reports ? Math.min(recv, total) : sent; }
        final AtomicBoolean abort = new AtomicBoolean();
        void wake() { synchronized (lock) { lock.notifyAll(); } }
    }

    PeerClient(Host host, int discoveryPort) throws Exception {
        this.host = host;
        this.discoveryPort = discoveryPort;
        // the certificate is checked by hand against the one pinned when pairing (or shown as the code, while pairing)
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] c, String a) { }
            @Override public void checkServerTrusted(X509Certificate[] c, String a) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }}, rnd);
        this.sf = ctx.getSocketFactory();
    }

    void addExtraPort(int p) { extraPorts.add(p); }

    // ------------------------------------------------------------ finding devices
    // scanAsked: a page showing the list wants it; fast: the user is holding Connect (it looks then too, every 300 ms)
    private boolean scanAsked;

    synchronized void scan(boolean on) { scanAsked = on; applyScan(); }

    /** The user is holding Connect: phones are looked for every 300 ms until it's off again. */
    synchronized void fast(boolean on) { fast = on; applyScan(); }

    private synchronized void applyScan() {
        final boolean on = scanAsked || fast;
        if (on == scanning) return;
        scanning = on;
        final int gen = ++scanGen;
        // (one at a time, in order, each saying what's wanted by the time it runs: two quick changes can't land the wrong
        // way round, leaving Bluetooth looking at full power with nothing on screen, or not looking while the list is up)
        looks.execute(new Runnable() { @Override public void run() { try { host.looking(scanning); } catch (Throwable e) { host.log("peers: " + e); } } });
        if (on) {
            openUdp();
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    // (turned off and on again: the thread from before stops, rather than both asking)
                    while (scanning && gen == scanGen()) {
                        query();
                        expire();
                        // (in steps, so holding Connect speeds up the very next question)
                        for (long w = 0; w < SCAN_MS && scanning && gen == scanGen() && !(fast && w >= 300); w += 100) {
                            try { Thread.sleep(100); } catch (InterruptedException e) { return; }
                        }
                    }
                }
            }, "flick-peer-scan");
            t.setDaemon(true);
            t.start();
        } else if (looking == 0) closeUdp();
    }

    private synchronized int scanGen() { return scanGen; }

    private synchronized void openUdp() {
        if (udp != null) return;
        try {
            udp = listen(new DatagramSocket(0));
            // A Wi-Fi without internet next to mobile data (one phone on the other's hotspot) isn't the default network:
            // Android sends there only from a socket put on it. One such socket asks there too.
            String b = wifiBroadcast();
            if (b != null) {
                DatagramSocket w = new DatagramSocket(0);
                if (Wire.bind(w, b)) udpWifi = listen(w); else w.close();
            }
        } catch (SocketException e) { host.log("peers: discovery " + e.getMessage()); }
    }
    private DatagramSocket listen(final DatagramSocket u) throws SocketException {
        u.setBroadcast(true);
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                byte[] buf = new byte[2048];
                while (!u.isClosed()) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try { u.receive(p); } catch (IOException e) { return; }
                    reply(p);
                }
            }
        }, "flick-peer-replies");
        t.setDaemon(true);
        t.start();
        return u;
    }
    private synchronized void closeUdp() {
        if (udp != null) { udp.close(); udp = null; }
        if (udpWifi != null) { udpWifi.close(); udpWifi = null; }
    }
    // the first broadcast address of a network interface (the Wi-Fi's, usually): which network to put a socket on
    private static String wifiBroadcast() {
        try {
            for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
                NetworkInterface ni = e.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) if (ia.getBroadcast() != null) return ia.getBroadcast().getHostAddress();
            }
        } catch (Throwable x) { /* none */ }
        return null;
    }

    private void query() {
        DatagramSocket u, w;
        synchronized (this) { u = udp; w = udpWifi; }
        if (u == null) return;
        try {
            // (its id, so this phone's own receiver doesn't answer it; no name: nobody needs it to answer)
            JSONObject q = new JSONObject();
            q.put("t", "flick?"); q.put("id", host.id()); q.put("peer", 1); q.put("kind", "phone");
            byte[] b = q.toString().getBytes("UTF-8");
            Set<String> ips = new LinkedHashSet<String>();
            ips.add("255.255.255.255");
            try {
                for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
                    NetworkInterface ni = e.nextElement();
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InterfaceAddress ia : ni.getInterfaceAddresses()) if (ia.getBroadcast() != null) ips.add(ia.getBroadcast().getHostAddress());
                }
            } catch (Throwable e) { /* the broadcast to everyone still goes */ }
            synchronized (host) {
                JSONObject ls = host.links();
                for (Iterator<String> it = ls.keys(); it.hasNext(); ) {
                    JSONObject l = ls.optJSONObject(it.next());
                    JSONArray a = l == null ? null : l.optJSONArray("addrs");
                    for (int i = 0; a != null && i < a.length(); i++) { String s = a.optString(i); int k = s.lastIndexOf(':'); if (k > 0) ips.add(s.substring(0, k)); }
                }
            }
            List<Integer> ports = new ArrayList<Integer>();
            ports.add(discoveryPort);
            ports.addAll(extraPorts);
            if (!extraPorts.isEmpty()) ips.add("127.0.0.1");
            for (String ip : ips) for (int p : ports) {
                DatagramPacket d = new DatagramPacket(b, b.length, InetAddress.getByName(ip), p);
                try { u.send(d); } catch (IOException e) { /* that network can't */ }
                if (w != null) { try { w.send(d); } catch (IOException e) { /* nor that one */ } }
            }
        } catch (Throwable e) { /* next time */ }
    }

    private void reply(DatagramPacket p) {
        try {
            JSONObject m = PeerServer.parse(new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8"));
            String id = PeerServer.clean(PeerServer.str(m, "id"), 64);
            int port = m.optInt("port");
            if (!"flick!".equals(PeerServer.str(m, "t")) || id.isEmpty() || id.equals(host.id()) || port <= 0 || port >= 65536 || m.optInt("tls") != 1) return;
            if (!"phone".equals(PeerServer.str(m, "kind"))) return;     // a phone sends to phones this way (to a PC as always)
            boolean paired;
            Set<String> saved = new HashSet<String>();         // where it was reached over its own signed-in link
            synchronized (host) {
                JSONObject l = host.links().optJSONObject(id);
                paired = l != null;
                JSONArray a = l == null ? null : l.optJSONArray("addrs");
                for (int i = 0; a != null && i < a.length(); i++) saved.add(a.optString(i));
            }
            Found f = new Found();
            String nm = PeerServer.cleanName(m.opt("name"));
            f.id = id; f.name = nm.isEmpty() ? "Phone" : nm; f.kind = "phone"; f.os = clip(PeerServer.str(m, "os"), 20);
            f.ip = p.getAddress().getHostAddress(); f.port = port; f.seen = f.ipSeen = PeerServer.mono();
            f.ready = m.optInt("ready") == 1;
            f.via = NetKind.linkFor(p.getAddress());
            Boolean news = null;
            boolean alt = false;
            synchronized (found) {
                Found prev = found.get(id);
                // (anyone on the network can answer: the list keeps a sensible number of phones, and the paired ones always)
                if (prev == null && !paired && found.size() >= MAX_FOUND) return;
                // A phone answering on several networks at once keeps the address it answered from first, while it still
                // answers there; one that moved (its old address quiet) is found where it answers now. A paired phone
                // answering where it was reached before (signed in) is taken there over an address that never was.
                // The other address is kept too, to try next.
                boolean verified = saved.contains(f.ip + ":" + f.port) && !saved.contains(prev == null ? "" : prev.ip + ":" + prev.port);
                if (prev != null && !prev.ip.equals(f.ip) && f.seen - prev.ipSeen < SCAN_MS * 2 && !verified) {
                    prev.seen = f.seen; prev.altIp = f.ip; prev.altPort = f.port; prev.altSeen = f.seen;
                    alt = prev.ready != f.ready;
                    prev.ready = f.ready;
                } else {
                    if (prev != null && !prev.ip.equals(f.ip)) { f.altIp = prev.ip; f.altPort = prev.port; f.altSeen = prev.ipSeen; }
                    news = prev == null || !prev.name.equals(f.name) || !prev.ip.equals(f.ip) || prev.ready != f.ready;
                    found.put(id, f);
                }
            }
            // (told outside the lock: the page's state is made under it)
            if (alt) { host.changed(); return; }
            if (news == null) return;
            // back on the network: what said it couldn't be reached is out of date
            if (news) synchronized (busy) { if (unreached.remove(id)) errors.remove(id); }
            // (a paired phone's saved name and addresses change only over its own signed-in link, never from an answer
            // anyone could send: see link())
            if (news) host.changed();
        } catch (Throwable e) { /* not an answer */ }
    }

    // ------------------------------------------------------------ phones over a cable or Bluetooth (Tunnel)
    // id -> where it is (127.0.0.1 and the tunnel's local port) and how: nearby, tried before Wi-Fi (a cable) or after
    // it (Bluetooth: slower)
    private final Map<String, Found> tunnels = new HashMap<String, Found>();

    /** A phone is at the other end of a cable or Bluetooth link (Tunnel): reachable at 127.0.0.1:port. */
    void tunnelUp(String id, String name, String kind, int port, String via, boolean ready) {
        Found f = new Found();
        f.id = id; f.name = PeerServer.cleanName(name).isEmpty() ? "Phone" : PeerServer.cleanName(name); f.kind = "pc".equals(kind) ? "pc" : "phone";
        f.ip = "127.0.0.1"; f.port = port; f.via = via; f.ready = ready;
        f.seen = f.ipSeen = PeerServer.mono();
        synchronized (tunnels) { tunnels.put(id, f); }
        // a link kept from before goes another way: the next one goes over this link when it's the faster one
        Found fd;
        synchronized (found) { fd = found.get(id); }
        // (Bluetooth is the slowest way: a link kept another way stays)
        // (not while a send is under way on that link: its answers come back on it; the next send takes the faster way)
        Busy sb;
        synchronized (busy) { sb = busy.get(id); }
        boolean inUse = sb != null && sb.link != null && sb.link.open;
        if (!inUse && !"bluetooth".equals(via) && (fd == null || NetKind.rank(via) > NetKind.rank(fd.via))) drop(id);
        host.changed();
    }

    /** That link ended (port: the tunnel's, so a newer one isn't dropped by an older one ending). */
    void tunnelDown(String id, int port) {
        boolean gone;
        synchronized (tunnels) { Found f = tunnels.get(id); gone = f != null && f.port == port; if (gone) tunnels.remove(id); }
        if (!gone) return;
        Link k;
        synchronized (live) { k = live.get(id); }
        if (k != null && "127.0.0.1".equals(k.ip) && k.port == port) drop(id);
        host.changed();
    }

    private Found tunnel(String id) { synchronized (tunnels) { return tunnels.get(id); } }

    /** The phones answering on the network now (ids; one that answered a while ago isn't, whether or not it was cleared). */
    java.util.List<String> onNetwork() {
        long now = PeerServer.mono();
        java.util.List<String> ids = new ArrayList<String>();
        synchronized (found) { for (Map.Entry<String, Found> e : found.entrySet()) if (now - e.getValue().seen <= SEEN_MS) ids.add(e.getKey()); }
        return ids;
    }

    // where a phone can be reached now: on the network, else over a cable or Bluetooth
    private Found reachable(String id) {
        Found f;
        synchronized (found) { f = found.get(id); }
        Found t = tunnel(id);
        if (t != null && (f == null || NetKind.rank(t.via) > NetKind.rank(f.via))) return t;
        return f;
    }

    private void expire() {
        boolean gone = false;
        long now = PeerServer.mono();
        synchronized (found) {
            for (Iterator<Map.Entry<String, Found>> it = found.entrySet().iterator(); it.hasNext(); ) if (now - it.next().getValue().seen > SEEN_MS) { it.remove(); gone = true; }
        }
        if (gone) host.changed();
    }

    // ------------------------------------------------------------ what the list shows
    JSONObject state() {
        JSONObject out = new JSONObject();
        try {
            out.put("scanning", scanning);
            List<JSONObject> list = new ArrayList<JSONObject>();
            Set<String> ids = new LinkedHashSet<String>();
            JSONObject ls, here;
            synchronized (host) { ls = new JSONObject(host.links().toString()); }
            here = host.allowedHere();
            for (Iterator<String> it = ls.keys(); it.hasNext(); ) ids.add(it.next());
            // paired one way (it can send here, this phone can't send to it): listed, so it can be removed, or paired from
            // here too
            for (Iterator<String> it = here.keys(); it.hasNext(); ) ids.add(it.next());
            synchronized (found) { ids.addAll(found.keySet()); }
            synchronized (tunnels) { ids.addAll(tunnels.keySet()); }
            for (String id : ids) {
                JSONObject l = ls.optJSONObject(id), a = l == null ? here.optJSONObject(id) : null;
                Found f = reachable(id);
                Busy b;
                String e;
                Integer at;
                boolean there;
                synchronized (busy) { b = busy.get(id); e = errors.get(id); at = attempts.get(id); there = canceledThere.contains(id); }
                JSONObject d = new JSONObject();
                d.put("id", id);
                String nm = l != null ? l.optString("name") : a != null ? a.optString("name") : f != null ? f.name : "";
                d.put("name", nm.isEmpty() ? (f != null ? f.name : "Phone") : nm);
                d.put("kind", "phone");
                d.put("paired", l != null || a != null);
                if (a != null) { d.put("oneWay", true); d.put("waiting", a.has("prov")); }
                d.put("nearby", f != null);
                if (f != null && f.ready) d.put("ready", true);
                if (f != null && f.via != null) d.put("via", f.via);
                if (b != null) {
                    d.put("busy", b.what);
                    if (b.code != null) d.put("code", b.code);
                    d.put("codeOk", b.codeOk); d.put("allowed", b.allowed);
                    if ("sending".equals(b.what)) {
                        JSONObject p = new JSONObject();
                        p.put("sent", b.shown()); p.put("total", b.total); p.put("files", b.files); p.put("items", b.items); p.put("name", b.name == null ? "" : b.name); p.put("asking", b.asking);
                        d.put("progress", p);
                    }
                }
                if (e != null) d.put("error", e);
                if (e != null && there) d.put("errorKind", "canceled");      // (shown as a cancel, not as an error)
                if (at != null) d.put("attempt", at);
                list.add(d);
            }
            Collections.sort(list, new Comparator<JSONObject>() {
                @Override public int compare(JSONObject a, JSONObject b) {
                    int x = Boolean.compare(b.optBoolean("paired"), a.optBoolean("paired"));
                    if (x == 0) x = Boolean.compare(b.optBoolean("nearby"), a.optBoolean("nearby"));
                    return x != 0 ? x : a.optString("name").compareToIgnoreCase(b.optString("name"));
                }
            });
            JSONArray arr = new JSONArray();
            for (JSONObject d : list) arr.put(d);
            out.put("devices", arr);
        } catch (Exception e) { /* empty */ }
        return out;
    }

    private final Set<String> unreached = new HashSet<String>();          // ids whose error is "couldn't reach" (busy)
    private void setBusy(String id, Busy b) { synchronized (busy) { if (b == null) busy.remove(id); else busy.put(id, b); } host.changed(); }
    private void setError(String id, String e) { setError(id, e, false); }
    // reach: it couldn't be reached (the words go once it answers on the network again)
    private void setError(String id, String e, boolean reach) { setError(id, e, reach, false); }
    // there: the words say the other device's user canceled a send (not a failure)
    private void setError(String id, String e, boolean reach, boolean there) {
        synchronized (busy) {
            if (e == null) errors.remove(id); else errors.put(id, e);
            if (e != null && reach) unreached.add(id); else unreached.remove(id);
            if (e != null && there) canceledThere.add(id); else canceledThere.remove(id);
        }
        host.changed();
    }
    private String nameOf(String id) {
        synchronized (host) { JSONObject l = host.links().optJSONObject(id); if (l != null) { String n = l.optString("name"); if (!n.isEmpty()) return n; } }
        synchronized (found) { Found f = found.get(id); if (f != null) return f.name; }
        return "The other phone";
    }

    // ------------------------------------------------------------ pairing
    /** Pairs with a phone found nearby: the code shows here; the user checks it against the other screen. */
    void pair(final String id) { pair(id, false); }

    /**
     * auto: the user held Connect here to reach this phone, and asked it. Over a USB cable (nobody else is at its other
     * end) the pairing completes as soon as the other phone's user allows it there; any other way the user here also
     * says the code here is the one there (confirm): a stranger's phone in range could answer the hold, and allow itself.
     */
    void pair(final String id, final boolean auto) {
        final long t0 = PeerServer.mono();
        // (counted first: a request that ends at once is one too; what an earlier one left goes with it, so words the
        // list shows with this number are this request's)
        synchronized (busy) { Integer n = attempts.get(id); attempts.put(id, n == null ? 1 : n + 1); errors.remove(id); unreached.remove(id); }
        final Found f = reachable(id);
        if (f == null) {
            // gone since it was seen: said as when pairing can't reach it
            String nm = nameOf(id);
            setError(id, "Couldn’t reach " + ("The other phone".equals(nm) ? "the other phone" : nm) + ". Make sure Flick is open on it, and that it’s nearby or on the same Wi-Fi.", true);
            told(t0);
            return;
        }
        final Busy b = new Busy();
        b.what = "pairing";
        b.codeOk = auto && "usb".equals(f.via);
        boolean going;
        synchronized (busy) { going = busy.containsKey(id); if (!going) { busy.put(id, b); errors.remove(id); unreached.remove(id); } }
        if (going) { told(t0); return; }                // (a pairing or a send going with it already: the list says so)
        host.changed();
        work.execute(new Runnable() {
            @Override public void run() {
                Link link = null;
                try {
                    link = Link.open(PeerClient.this, f.ip, f.port, null, null, id, 6000, b);
                    b.link = link;
                    b.opening = null;
                    if (b.canceled) throw new Fail("canceled", "ECANCELED");
                    final Link lk = link;
                    String token = link.pair(new Link.OnCode() {
                        @Override public void code(String c) { b.code = c; host.changed(); }
                    }, 120000, b);
                    b.allowed = true;
                    host.changed();
                    // the other side allowed it; it counts once the user here says the codes match too
                    synchronized (b.lock) {
                        long until = PeerServer.mono() + CONFIRM_MS;
                        while (!b.codeOk && !b.canceled && lk.open && !lk.forgotten && PeerServer.mono() < until) b.lock.wait(500);
                    }
                    if (b.canceled) throw new Fail("canceled", "ECANCELED");
                    if (lk.forgotten) throw new Fail("removed there", "EREMOVED");
                    // (the other phone did answer: it's the user here who didn't say the codes match)
                    if (!b.codeOk) throw new Fail(lk.open ? "not confirmed here" : "the link closed", lk.open ? "ENOTCONFIRMED" : "ECONNRESET");
                    finishPair(id, f, link, token);
                } catch (Throwable e) {
                    String code = e instanceof Fail ? ((Fail) e).code : b.canceled ? "ECANCELED" : "EIO";
                    if (link != null && link.forgotten && !b.canceled) code = "EREMOVED";      // (it's undone there, and here)
                    // The other side allowed it, and the user here said no (or never answered): it's undone on both sides.
                    // Here too: whatever pairing with it this phone had (from it pairing the other way at the same moment)
                    // goes with it, as the other side removes this phone entirely when told.
                    if (link != null && b.allowed && !"ECONNRESET".equals(code) && !"EREMOVED".equals(code)) {
                        try { link.send(new JSONObject().put("t", "peer-forget")); Thread.sleep(150); } catch (Throwable x) { /* ignore */ }
                        host.revoke(id, false);
                        synchronized (host) { if (host.links().has(id)) { host.links().remove(id); host.saved(); } }
                    }
                    if (link != null) link.close();
                    closeRaw(b.opening);
                    synchronized (busy) { if (busy.get(id) == b) busy.remove(id); }
                    // (paired with it before this, and that pairing is still here: whether it still holds there is looked
                    // at, as asking again is what one does when it doesn't)
                    verifyLater(id);
                    String nm = nameOf(id);
                    // (its link went as Flick there said it was closing: said as such)
                    boolean quit = link != null && link.bye && ("ECONNRESET".equals(code) || "ETIMEDOUT".equals(code) || "EIO".equals(code));
                    setError(id, b.canceled || "ECANCELED".equals(code) ? null : "EDENIED".equals(code) ? nm + " didn’t allow it, or is busy with another request."
                        : quit ? "Flick was closed on " + nm + "."
                        : "EREMOVED".equals(code) ? nm + " removed this phone."
                        : "ENOTCONFIRMED".equals(code) ? "Not paired with " + ("The other phone".equals(nm) ? "the other phone" : nm) + ": the code wasn’t confirmed here."
                        : "ETIMEDOUT".equals(code) ? "No answer from " + nm + ". Open Flick there and try again."
                        : "Pairing with " + nm + " didn’t work. Try again.");
                    host.log("peers: pairing with " + id + " failed: " + code);
                } finally { told(t0); }
            }
        });
    }

    // A pairing asked for at t0 is over (or isn't one: see pair()). The page takes what the list says about it only once
    // the request has had a moment to start (600 ms): one over sooner (the phone gone, refused at once) is said again
    // after that, so the page never waits on it.
    private void told(long t0) {
        host.changed();
        long left = 900 - (PeerServer.mono() - t0);
        if (left > 0) GUARD.schedule(new Runnable() { @Override public void run() { host.changed(); } }, left, TimeUnit.MILLISECONDS);
    }

    /** The user's answer: the code here is the same as the other phone's (or not: pairing is undone). */
    void confirm(String id, boolean same) {
        Busy b;
        synchronized (busy) { b = busy.get(id); }
        if (b == null || !"pairing".equals(b.what)) return;
        synchronized (b.lock) {
            if (same) b.codeOk = true; else b.canceled = true;
            b.lock.notifyAll();
        }
        if (!same) {
            closeRaw(b.opening);                               // (still connecting: it stops now)
            if (b.link != null && !b.allowed) b.link.close();
        }
        host.changed();
    }

    private void finishPair(String id, Found f, Link link, String token) throws Exception {
        String nm = PeerServer.cleanName(link.peerName);
        String name = nm.isEmpty() ? f.name : nm;
        synchronized (host) {
            if (link.forgotten) throw new Fail("removed there", "EREMOVED");       // (its Remove came first: see forgot)
            JSONObject l = new JSONObject();
            l.put("name", name); l.put("kind", "phone"); l.put("fp", link.fp); l.put("token", token);
            // (a cable's or Bluetooth's local port is no address to find it at later)
            l.put("addrs", f.ip.startsWith("127.") ? new JSONArray() : new JSONArray().put(f.ip + ":" + f.port)); l.put("added", System.currentTimeMillis());
            host.links().put(id, l);
            host.saved();
            link.made = true;
        }
        // the codes matched here too: the other phone keeps the pairing its user allowed (until now it would drop it if
        // this phone went away)
        link.send(new JSONObject().put("t", "pair-done"));
        // both ways: the other phone gets a token for this phone's own receiver, and its certificate to pin
        try {
            JSONObject g = host.grant(id, name, "phone");
            // (removed there meanwhile: what was just given here goes too, as the rest did)
            if (link.forgotten) { host.revoke(id, false); g = null; }
            if (g != null) link.send(new JSONObject().put("t", "peer-back").put("token", g.optString("token")).put("fp", g.optString("fp")).put("port", g.optInt("port")));
        } catch (Throwable e) { host.log("peers: grant failed " + e.getMessage()); }
        setBusy(id, null);
        keep(id, link);
        host.log("peers: paired with " + name);
    }

    /**
     * The other phone removed this one and said so over this phone's own link to it (its Remove came right after it
     * allowed this phone's request: before this phone could be reached the other way): gone both ways here too, and a
     * pairing being made over that link isn't kept. Only what that link stands for is undone: a link that is still
     * pairing (whoever answers there has proven nothing yet, and the user hasn't said the codes match) ends its own
     * pairing and leaves one made before as it is (pc/peerlink.js _watch does the same).
     */
    void forgot(final String id, Link via) {
        boolean its;                                           // the pairing kept here is this link's
        synchronized (host) {
            via.forgotten = true;
            its = via.proved || via.made;
            if (its && host.links().has(id)) { host.links().remove(id); host.saved(); }
        }
        if (its) host.revoke(id, false);
        Busy cur;
        synchronized (busy) { cur = busy.get(id); }
        // (a pairing waiting on this phone's user: it's over; a send to it ends saying it removed this phone)
        if (cur != null && (its || cur.link == via)) { if (!cur.canceled) cur.removedThere = true; cur.wake(); }
        host.changed();
        if (!its) return;
        host.log("peers: " + id + " removed this phone");
        work.execute(new Runnable() { @Override public void run() { Link k; synchronized (live) { k = live.get(id); } if (k == via) drop(id); } });
    }

    /** The other phone paired with this one and said how to reach it back ('peer-back', PeerServer). */
    void addLink(String id, String name, String kind, String fp, String token, String addr) {
        try {
            synchronized (host) {
                JSONObject prev = host.links().optJSONObject(id);
                JSONObject l = new JSONObject();
                String nm = PeerServer.cleanName(name);
                l.put("name", !nm.isEmpty() ? nm : prev != null && !prev.optString("name").isEmpty() ? prev.optString("name") : "Phone");
                l.put("kind", "phone"); l.put("fp", fp); l.put("token", token);
                JSONArray addrs = new JSONArray();
                // (paired over a cable or Bluetooth: its address there is a local port of this phone's, nothing to keep)
                if (addr != null && !addr.startsWith("127.")) addrs.put(addr);
                JSONArray old = prev == null ? null : prev.optJSONArray("addrs");
                for (int i = 0; old != null && i < old.length() && addrs.length() < 6; i++) if (!old.optString(i).equals(addr)) addrs.put(old.optString(i));
                l.put("addrs", addrs);
                l.put("added", prev != null ? prev.optLong("added") : System.currentTimeMillis());
                host.links().put(id, l);
                host.saved();
            }
        } catch (Exception e) { host.log("peers: link back " + e.getMessage()); }
        host.changed();
    }

    /** A paired phone's new name (it signed in here under it: PeerServer). */
    void rename(String id, String name) {
        String nm = PeerServer.cleanName(name);
        if (nm.isEmpty()) return;
        boolean changed = false;
        try {
            synchronized (host) {
                JSONObject l = host.links().optJSONObject(id);
                if (l != null && !nm.equals(l.optString("name"))) { l.put("name", nm); host.saved(); changed = true; }
            }
        } catch (Exception e) { /* as it was */ }
        if (changed) host.changed();
    }

    /** Removed (here, or by the other phone: tell=false): gone both ways. */
    void forget(final String id, final boolean tell) {
        // at once: it can't send here any more, isn't listed, and what's going to it stops (whatever telling it takes)
        host.revoke(id, tell);
        Busy cur;
        synchronized (busy) { cur = busy.get(id); }
        // (removed by the other phone, tell=false: what's going to it says so, rather than that it was canceled here)
        if (cur != null) { if (!tell && !cur.canceled) cur.removedThere = true; cancel(id); }
        final JSONObject l;
        synchronized (host) {
            JSONObject x = host.links().optJSONObject(id);
            l = x;
            if (x != null) { host.links().remove(id); host.saved(); }
        }
        synchronized (busy) { errors.remove(id); unreached.remove(id); }
        host.changed();
        work.execute(new Runnable() {
            @Override public void run() {
                if (tell && l != null) {
                    try { Link k = link(id, 3000, null, l); k.send(new JSONObject().put("t", "peer-forget")); Thread.sleep(150); }
                    catch (Throwable e) { /* not reachable: it finds out when it next tries */ }
                }
                drop(id);
            }
        });
    }

    // ------------------------------------------------------------ is a pairing still there, both ends?
    // (under busy) the phones being looked at now, and when the last few looks began (a few a minute at most: one can be
    // set off by anyone saying it's a paired phone)
    private final Set<String> verifying = new HashSet<String>();
    private final List<Long> verifies = new ArrayList<Long>();
    private static final int MAX_VERIFIES = 20;
    private static final long BACK_GRACE = 5 * 60000;    // (a pairing made this recently may still be on its way there)

    /**
     * Whether the pairing with a paired phone still holds at its end, looked at over a link of its own, signed in as this
     * phone always does (pinned to its certificate: only that phone's answer counts): after a pairing with it that came
     * to nothing (it was asked again, refused, given up). One end can have lost a pairing without the other hearing (it
     * was removed there while this phone was out of reach), and the pairing left here is of no use: kept, the list says
     * paired and every send fails. What it finds is taken up here (see verify). Nothing when it isn't reachable now.
     */
    void verifyLater(final String id) {
        synchronized (host) { if (!host.links().has(id)) return; }
        synchronized (busy) {
            if (busy.containsKey(id) || verifying.contains(id)) return;
            long now = PeerServer.mono();
            for (Iterator<Long> it = verifies.iterator(); it.hasNext(); ) if (now - it.next() > 60000) it.remove();
            if (verifies.size() >= MAX_VERIFIES) return;
            verifies.add(now);
            verifying.add(id);
        }
        work.execute(new Runnable() {
            @Override public void run() {
                try { verify(id); }
                catch (Throwable e) { host.log("peers: looking at the pairing with " + id + ": " + e.getMessage()); }
                finally { synchronized (busy) { verifying.remove(id); } }
            }
        });
    }

    // the same pairing (as it was when a look at it began): the same token, given at the same time. (Signing in can note
    // that phone's new address or Bluetooth key in it: still the same pairing.)
    private static boolean same(JSONObject was, JSONObject now) {
        return was != null && now != null && was.optString("token").equals(now.optString("token")) && was.optString("fp").equals(now.optString("fp")) && was.optLong("added") == now.optLong("added");
    }

    private void verify(String id) throws Exception {
        JSONObject l, a0 = host.allowedHere().optJSONObject(id);
        synchronized (host) { JSONObject x = host.links().optJSONObject(id); l = x == null ? null : new JSONObject(x.toString()); }
        Found f = reachable(id);
        if (l == null || f == null || l.optString("fp").isEmpty()) return;
        Link k;
        try { k = Link.open(this, f.ip, f.port, l.optString("fp"), l.optString("token"), id, 5000, null); }
        catch (Exception e) { return; }                     // (not reached, or not that phone: nothing is known)
        boolean dead = !k.trusted && !k.challenged, orphan = k.trusted && Boolean.FALSE.equals(k.back);
        k.close();
        if (!dead && !orphan) return;
        String nm = nameOf(id);
        synchronized (busy) { if (busy.containsKey(id)) return; }                      // (being used now: it says)
        if (dead) {
            // That phone (its certificate is the one paired with) asked for no sign-in: it has no pairing with this one
            // any more. The pairing goes here too, as its Remove would have said had it reached this phone.
            synchronized (host) {
                if (!same(l, host.links().optJSONObject(id))) return;     // (paired again meanwhile: as it is now)
                host.links().remove(id);
                host.saved();
            }
            if (same(a0, host.allowedHere().optJSONObject(id))) host.revoke(id, false);
            drop(id);
            setError(id, nm + " doesn’t have this phone paired any more.");
            host.log("peers: " + id + " doesn't have this phone paired any more: unpaired here too");
            return;
        }
        // It knows this phone, but can't send to it any more (its pairing for that went, there): what this phone keeps
        // so that it could is of no use. (Not one still being made: it may not have reached that phone yet.)
        JSONObject a = host.allowedHere().optJSONObject(id);
        long now = System.currentTimeMillis();
        if (!same(a0, a) || a.has("prov") || (a.optLong("back", 0) > 0 && Math.abs(now - a.optLong("back", 0)) < BACK_GRACE)) return;
        host.revoke(id, false);
        host.changed();
        host.log("peers: " + id + " can't send here any more: what it had for that goes");
    }

    // ------------------------------------------------------------ links kept open for a moment
    private void keep(final String id, final Link link) {
        // (through a cable's or Bluetooth's link: that link is that phone's, as its certificate says, or the code did)
        Found tv = tunnel(id);
        if (tv != null && "127.0.0.1".equals(link.ip) && link.port == tv.port) { try { host.tunnelVerified(id, tv.port); } catch (Throwable e) { /* as it is */ } }
        Link cur;
        synchronized (live) { cur = live.get(id); live.put(id, link); }
        if (cur != null && cur != link) cur.close();            // (closed outside the lock: a close can take a moment)
        link.idleAt = PeerServer.mono() + IDLE_MS;
        work.execute(new Runnable() {
            @Override public void run() {
                while (link.open) {
                    try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
                    boolean b;
                    synchronized (busy) { b = busy.containsKey(id); }
                    if (b) link.idleAt = PeerServer.mono() + IDLE_MS;
                    else if (PeerServer.mono() > link.idleAt) { link.close(); break; }
                }
                synchronized (live) { if (live.get(id) == link) live.remove(id); }
            }
        });
    }
    void drop(String id) { Link l; synchronized (live) { l = live.remove(id); } if (l != null) l.close(); }

    // the same, unless a send to it is going over that link (a message that didn't get through isn't the send's end)
    private void dropIdle(String id) {
        Busy sb;
        synchronized (busy) { sb = busy.get(id); }
        synchronized (live) { Link k = live.get(id); if (sb != null && k != null && sb.link == k) return; }
        drop(id);
    }

    /**
     * A signed-in, connected link to a paired phone: kept from a moment ago, or made where it was seen. b: the send it's
     * for (Cancel stops it wherever it is), or null; rec: its pairing (null: as saved now).
     */
    private Link link(String id, int ms, Busy b, JSONObject rec) throws Exception {
        // One at a time to a phone: two looking for it at once (a clipboard sent while a file's send is still finding
        // it) each made a link, the later one closing the earlier (keep, and the other phone on its side), and the send
        // on the earlier one lost its answers. The second waits, then takes the link the first one made.
        java.util.concurrent.locks.ReentrantLock one;
        synchronized (linking) { one = linking.get(id); if (one == null) linking.put(id, one = new java.util.concurrent.locks.ReentrantLock()); }
        // A send waits as long as it takes (its Cancel ends the wait). Anything else (a clipboard, a ring, a Remove's
        // word) waits about as long as its own try would have taken, then says the phone can't be reached; and when the
        // one it waited for just found it can't be, it says the same without looking all over again.
        boolean waited = false;
        long until = PeerServer.mono() + ms + 3000;
        while (!one.tryLock(200, TimeUnit.MILLISECONDS)) {
            waited = true;
            if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
            if (b == null && PeerServer.mono() > until) throw new Fail("not reachable", "EUNREACH");
        }
        try {
            if (waited && b == null) {
                Object[] f;
                synchronized (linking) { f = linkFailed.get(id); }
                if (f != null && PeerServer.mono() - (Long) f[0] < 3000) throw new Fail((String) f[1], (String) f[2]);
            }
            try {
                Link k = linkNow(id, ms, b, rec);
                synchronized (linking) { linkFailed.remove(id); }
                return k;
            } catch (Exception e) {
                String code = e instanceof Fail ? ((Fail) e).code : "EUNREACH";
                // (not what is this caller's own: its Cancel, a pairing the other phone doesn't know, another device there)
                if (!"ECANCELED".equals(code) && !"EAUTH".equals(code) && !"EOTHER".equals(code)) {
                    synchronized (linking) { linkFailed.put(id, new Object[]{PeerServer.mono(), e instanceof Fail && e.getMessage() != null ? e.getMessage() : "not reachable", code}); }
                }
                throw e;
            }
        } finally { one.unlock(); }
    }

    private Link linkNow(String id, int ms, Busy b, JSONObject rec) throws Exception {
        long now = PeerServer.mono();
        Found fd;
        synchronized (found) { fd = found.get(id); }
        if (fd != null && now - fd.seen > SEEN_MS) fd = null;              // (an answer from a while ago: not where it is now)
        String me = host.name();
        Link old = null;
        Busy sb;
        synchronized (busy) { sb = busy.get(id); }
        synchronized (live) {
            Link k = live.get(id);
            // (a send to it is under way on this link: a message goes on the same one; a second link would make the other
            // phone close this one, and the send would no longer hear its answers)
            if (b == null && sb != null && k != null && sb.link == k && k.open && k.connected && !k.bye) { k.idleAt = now + IDLE_MS; return k; }
            // a kept link that answered its last ping, to where the phone still answers (one that hasn't answered may be
            // gone, and one now answering elsewhere has moved: a new link is made, wherever it is); and signed in under
            // this phone's name as it is now (renamed since: the other phone hears the new one as a new link signs in)
            boolean moved = k != null && fd != null && (!fd.ip.equals(k.ip) || fd.port != k.port) && now - fd.ipSeen < SCAN_MS * 2;
            // (not one whose Flick said it's closing: a new one finds out whether it's back)
            if (k != null && k.open && k.connected && !k.bye && !moved && now - k.heard < 25000 && me != null && me.equals(k.helloName)) { k.idleAt = now + IDLE_MS; return k; }
            if (k != null) { live.remove(id); old = k; }
        }
        if (old != null) old.close();
        JSONObject l = rec;
        if (l == null) synchronized (host) { JSONObject x = host.links().optJSONObject(id); l = x == null ? null : new JSONObject(x.toString()); }
        if (l == null) throw new Fail("not paired", "EAUTH");
        List<String> addrs = new ArrayList<String>();
        // over a cable first (the fastest); over Bluetooth only after the network
        Found tn = tunnel(id);
        boolean tunFirst = tn != null && (fd == null || NetKind.rank(tn.via) > NetKind.rank(fd.via));
        if (tunFirst) addrs.add(tn.ip + ":" + tn.port);
        if (fd != null) addrs.add(fd.ip + ":" + fd.port);
        if (fd != null && fd.altIp != null && now - fd.altSeen < SEEN_MS) addrs.add(fd.altIp + ":" + fd.altPort);
        JSONArray a = l.optJSONArray("addrs");
        for (int i = 0; a != null && i < a.length(); i++) { String ad = a.optString(i); if (!ad.startsWith("127.")) addrs.add(ad); }
        if (tn != null && !tunFirst) addrs.add(tn.ip + ":" + tn.port);
        // (each way is tried once, given up or not: a way found meanwhile is tried next, never the same again)
        Set<String> tried = Collections.synchronizedSet(new HashSet<String>());
        int tries = 0;
        Exception last = new Fail("not reachable", "EUNREACH");
        // Not seen on the network lately, and no link to it: it's asked for on the network at once, and looked for beyond
        // it (Bluetooth: it may be on no network this phone is on) while the addresses it had are tried. Where nothing
        // answers, each of those takes seconds: a way to it found meanwhile (a link, an answer on the network) is taken
        // at once, and the address still being tried is given up.
        long asked = now;
        boolean far = false, hunting = fd == null && tn == null, udp = false;
        Busy att = b != null ? b : new Busy();             // (what's being opened, for giving it up)
        if (hunting) {
            synchronized (this) { looking++; openUdp(); }
            udp = true;
            query();
            try { far = host.lookFor(id, 8000); } catch (Throwable e) { /* the network only */ }
            if (b != null && far) b.far = true;
            if (b != null && !far) { try { b.farShut = host.farIfShown(); } catch (Throwable e) { /* as it is */ } }
        }
        try {
            for (int round = 0; round < 2; round++) {
                for (int i = 0; i < addrs.size(); i++) {
                    if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                    String nw = hunting ? fresher(id, asked, tried) : null;
                    if (nw != null && !nw.equals(addrs.get(i))) addrs.add(i, nw);
                    String ad = addrs.get(i);
                    if (!tried.add(ad)) continue;
                    if (++tries > MAX_TRIES) throw last;
                    int k = ad.lastIndexOf(':');
                    if (k <= 0) continue;
                    if (b != null && ad.startsWith("127.")) b.far = true;     // (over a cable or Bluetooth: not the Wi-Fi)
                    Link link = null;
                    GiveUp gu = hunting && !ad.startsWith("127.") ? new GiveUp(id, ad, asked, tried, att) : null;
                    try {
                        link = Link.open(this, ad.substring(0, k), Integer.parseInt(ad.substring(k + 1)), l.optString("fp"), l.optString("token"), id, ms, att);
                        if (!link.trusted) { link.close(); throw new Fail("it doesn’t know this phone any more", "EAUTH"); }
                        link.connect(ms);
                        if (b != null && b.canceled) { link.close(); throw new Fail("canceled", "ECANCELED"); }
                        if (gu != null && gu.end()) { link.close(); gu = null; continue; }    // (given up just now)
                        keep(id, link);
                        remember(id, ad, link.peerName);
                        // (reached on the network after all: no Bluetooth link to it is made for nothing)
                        if (far && !ad.startsWith("127.")) { try { host.lookFor(id, 0); } catch (Throwable x) { /* it stops by itself */ } }
                        return link;
                    } catch (Fail e) {
                        if (link != null) link.close();
                        if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                        if (gu != null && gu.end()) continue;                             // (found a better way: given up)
                        // a cable's or Bluetooth's link that isn't that phone's (another device only said it was): it ends, and
                        // the real one is looked for
                        Found tb = tunnel(id);
                        if ("EPIN".equals(e.code) && tb != null && ad.equals(tb.ip + ":" + tb.port)) { try { host.tunnelBad(id, tb.port); } catch (Throwable x) { /* as it is */ } last = e; continue; }
                        failedOver(id, ad);
                        if ("EAUTH".equals(e.code) || "EOTHER".equals(e.code) || "ECANCELED".equals(e.code)) throw e;
                        last = e;
                    } catch (Exception e) {
                        if (link != null) link.close();
                        if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                        if (gu != null && gu.end()) continue;
                        failedOver(id, ad);
                        last = e;
                    } finally {
                        if (gu != null) gu.end();
                        att.opening = null;
                    }
                }
                if (round == 0) {
                    // not where it was: look for it on the network for a moment, and beyond it (Bluetooth: it may be on
                    // no network this phone is on), then try where it answers from now
                    long since = hunting ? asked : PeerServer.mono();
                    // (beyond the network too: when there's no link to it, or the one there was didn't work)
                    boolean tunTried = tn != null && tried.contains(tn.ip + ":" + tn.port);
                    if (tn == null || tunTried) { try { far = host.lookFor(id, 8000) || far; } catch (Throwable e) { /* the network only */ } }
                    if (b != null && far) b.far = true;
                    if (b != null && !far) { try { b.farShut = host.farIfShown(); } catch (Throwable e) { /* as it is */ } }
                    if (!udp) { synchronized (this) { looking++; openUdp(); } udp = true; }
                    for (int i = 0; i < 4 && !(b != null && b.canceled); i++) { synchronized (found) { Found g = found.get(id); if (g != null && g.seen >= since) break; } if (tunnel(id) != null) break; query(); Thread.sleep(400); }
                    if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                    boolean lan;
                    synchronized (found) {
                        Found g = found.get(id);
                        lan = g != null && g.seen >= since;
                        if (lan) {
                            addrs.add(0, g.ip + ":" + g.port);
                            if (g.altIp != null && g.altSeen >= since) addrs.add(1, g.altIp + ":" + g.altPort);   // (answered from there too)
                        }
                    }
                    if (!lan) {
                        // not on the network: over Bluetooth once it's linked (a few seconds; a link other than one tried), else it
                        // isn't reachable
                        Found t = tunnel(id);
                        for (long w = 0; far && (t == null || tried.contains(t.ip + ":" + t.port)) && w < 8000 && !(b != null && b.canceled); w += 200) { Thread.sleep(200); t = tunnel(id); }
                        if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                        if (t == null || tried.contains(t.ip + ":" + t.port)) break;
                        addrs.add(0, t.ip + ":" + t.port);
                    }
                }
            }
            throw last;
        } finally {
            if (udp) synchronized (this) { looking--; if (looking == 0 && !scanning) closeUdp(); }
        }
    }

    // nothing could be reached at ad: when that's a link's local port, the link is said not to work (one tried in place
    // of another that's proven goes, and that one is the way again: see Peers)
    private void failedOver(String id, String ad) {
        Found t = tunnel(id);
        if (t != null && ad.equals(t.ip + ":" + t.port)) { try { host.tunnelFailed(id, t.port); } catch (Throwable x) { /* as it is */ } }
    }

    // a way to a phone found since asked that wasn't tried yet: a link to it, or where it answers on the network now (of
    // the two, the faster kind: a cable before the network, the network before Bluetooth)
    private String fresher(String id, long asked, Set<String> tried) {
        Found t = tunnel(id), g;
        synchronized (found) { g = found.get(id); }
        String ta = t == null ? null : t.ip + ":" + t.port, ga = g == null || g.seen < asked ? null : g.ip + ":" + g.port;
        if (ta != null && tried.contains(ta)) ta = null;
        if (ga != null && tried.contains(ga)) ga = null;
        if (ta != null && ga != null) return NetKind.rank(t.via) > NetKind.rank(g.via) ? ta : ga;
        return ta != null ? ta : ga;
    }

    // the phone answered on the network from ad since it was looked for (it's there, however slow it is to reach)
    private boolean answered(String id, String ad, long asked) {
        Found g;
        synchronized (found) { g = found.get(id); }
        return g != null && ((g.seen >= asked && ad.equals(g.ip + ":" + g.port)) || (g.altIp != null && g.altSeen >= asked && ad.equals(g.altIp + ":" + g.altPort)));
    }

    // how fast a way to a phone is (NetKind.rank): its link's kind, or the kind of network it answers over (an address
    // it had: a network one)
    private int rankOf(String id, String ad) {
        Found t = tunnel(id), g;
        if (t != null && ad.equals(t.ip + ":" + t.port)) return NetKind.rank(t.via);
        synchronized (found) { g = found.get(id); }
        return NetKind.rank(g != null && g.via != null ? g.via : "wifi");
    }

    /**
     * While a phone is looked for beyond the network: an address being tried is given up as soon as the phone is found a
     * better way, rather than after its seconds: one where nothing has answered since it was looked for (an address it
     * had) for any way found (a link to it, an answer on the network); one it answered from (only slow) for a faster kind
     * only (a cable rather than Wi-Fi, never Bluetooth). It's asked for on the network again every second meanwhile.
     */
    private final class GiveUp implements Runnable {
        private final String id, ad; private final long asked; private final Set<String> tried; private final Busy att;
        private final ScheduledFuture<?> f;
        private boolean on = true, gave;                    // (under this)
        private int ticks;
        GiveUp(String id, String ad, long asked, Set<String> tried, Busy att) {
            this.id = id; this.ad = ad; this.asked = asked; this.tried = tried; this.att = att;
            f = GUARD.scheduleWithFixedDelay(this, 200, 200, TimeUnit.MILLISECONDS);
        }
        @Override public void run() {
            if (++ticks % 5 == 0) query();
            String nw = fresher(id, asked, tried);
            if (nw == null || (answered(id, ad, asked) && rankOf(id, nw) <= rankOf(id, ad))) return;
            Socket s;
            // (what's closed is this attempt's connection: once it's over, the next one's is never touched)
            synchronized (this) { if (!on) return; on = false; gave = true; s = att.opening; }
            closeRaw(s);
        }
        /** The attempt is over: nothing is given up from now on. True when it was given up (what it made is no good). */
        boolean end() { f.cancel(false); synchronized (this) { on = false; return gave; } }
    }

    // a paired phone's Bluetooth key, as it said it signing this phone in (kept with it: links())
    private void keepKey(String id, String bk) {
        if (id == null || id.isEmpty()) return;
        try {
            synchronized (host) {
                JSONObject l = host.links().optJSONObject(id);
                if (l != null && !bk.equals(l.optString("bk"))) { l.put("bk", bk); host.saved(); }
            }
        } catch (Exception e) { /* as it was */ }
    }

    // where a paired phone was reached over its own signed-in link (first in its list), and the name it gives there
    private void remember(String id, String addr, String name) {
        if (addr == null || addr.startsWith("127.")) return;                // (a cable's or Bluetooth's local port)
        try {
            synchronized (host) {
                JSONObject l = host.links().optJSONObject(id);
                if (l == null) return;
                JSONArray old = l.optJSONArray("addrs");
                JSONArray addrs = new JSONArray().put(addr);
                for (int i = 0; old != null && i < old.length() && addrs.length() < 6; i++) if (!addr.equals(old.optString(i))) addrs.put(old.optString(i));
                String c = PeerServer.cleanName(name);
                String nm = c.isEmpty() ? l.optString("name") : c;
                if (old == null || !addr.equals(old.optString(0)) || !nm.equals(l.optString("name"))) { l.put("addrs", addrs); l.put("name", nm); host.saved(); }
            }
        } catch (Exception e) { /* as it was */ }
    }

    // ------------------------------------------------------------ sending
    /**
     * Files and folders to a paired phone; names: what each top-level item is called there (null: its own name).
     * "ok" (on its way), "busy" (something is going to it already) or "unpaired".
     */
    String send(final String id, final List<File> items, final List<String> names) { return send(id, items, names, null); }

    /** The same, flicked: fx { look, y (where it left the screen, 0 top to 1 bottom), vx }: its card arrives so there. */
    String send(final String id, final List<File> items, final List<String> names, final JSONObject fx) {
        boolean has;
        synchronized (host) { has = host.links().has(id); }
        if (!has) return "unpaired";
        final Busy b = new Busy();
        b.what = "sending";
        b.fx = fx;
        synchronized (busy) { if (busy.containsKey(id)) return "busy"; busy.put(id, b); errors.remove(id); unreached.remove(id); }
        host.changed();
        work.execute(new Runnable() { @Override public void run() { doSend(id, items, names, b); } });
        return "ok";
    }

    private void doSend(String id, List<File> items, List<String> names, Busy b) {
        host.working(true);
        try { doSend2(id, items, names, b); } finally { host.working(false); }
    }

    // the other phone's answer, as an error: why it didn't save them (canceled: its user canceled them there; declined:
    // its user said no, "declined", or didn't answer in time, "timeout")
    private static Fail turnedDown(JSONObject r) {
        String why = PeerServer.str(r, "why");
        return Boolean.TRUE.equals(r.opt("canceled")) ? new Fail("canceled there", "ETHERE")
            : "declined".equals(why) || "timeout".equals(why) ? new Fail(why, "EDECLINED")
            : "space".equals(why) ? new Fail("no room", "ENOSPACE")
            : "upload".equals(why) || "stalled".equals(why) ? new Fail("cut off", "ECUT")
            : "busy".equals(why) ? new Fail("too many at once", "EBUSY")
            : "off".equals(why) ? new Fail("it stopped taking files", "EOFF")
            : "removed".equals(why) ? new Fail("removed", "EAUTH")
            : new Fail("not saved", "ESAVE");
    }

    // the other phone's answer about the send ('saved' or 'failed') within ms, or null (none, the link went, or the user
    // stopped it); got: or until it says all of it came ('got')
    private static JSONObject waitReply(Busy b, Link lk, long ms) throws InterruptedException { return waitReply(b, lk, ms, false); }
    private static JSONObject waitReply(Busy b, Link lk, long ms, boolean got) throws InterruptedException {
        long until = PeerServer.mono() + ms;
        synchronized (b.lock) {
            while (b.reply == null && !(got && b.delivered) && lk.open && !b.canceled && !b.late) {
                long left = until - PeerServer.mono();
                if (left <= 0) break;
                b.lock.wait(Math.min(left, 500));
            }
            return b.reply;
        }
    }

    private void doSend2(String id, List<File> items, List<String> names, final Busy b) {
        String nm = nameOf(id);
        Link link = null;
        boolean single = false, viaDirect = false;
        try {
            Bundle bundle = new Bundle();
            bundle.maxFiles = Bundle.MAX_FILES; bundle.maxDirs = Bundle.MAX_DIRS; bundle.skipShrunk = true;
            for (int i = 0; i < items.size() && !b.canceled; i++) {
                try { bundle.add(items.get(i), names != null && i < names.size() ? names.get(i) : null, b.abort); }
                catch (IOException e) { if (!b.canceled) b.left++; }      // (gone since it was picked: left out, and said)
            }
            if (b.canceled) throw new Fail("canceled", "ECANCELED");
            if (bundle.entries.isEmpty()) throw new Fail("nothing to send", "EEMPTY");
            single = bundle.entries.size() == 1 && !bundle.entries.get(0).dir;
            Bundle.Entry first = null;
            for (Bundle.Entry e : bundle.entries) if (!e.dir) { first = e; break; }
            // (several picked: "3 files" when none of them is a folder, as both phones list it)
            int loose = 0;
            for (Bundle.Entry e : bundle.entries) if (!e.dir && e.rel.indexOf('/') < 0) loose++;
            String name = single || bundle.roots.size() == 1 ? bundle.roots.get(0) : bundle.roots.size() + (loose == bundle.roots.size() ? " files" : " items");
            boolean folder = !single && bundle.roots.size() == 1 && bundle.entries.get(0).dir;
            b.tid = "q" + rid(8); b.name = name; b.total = bundle.bytes; b.files = bundle.files; b.items = single ? 1 : bundle.roots.size(); b.deep = bundle.deep;
            b.bundle = bundle;
            host.changed();
            String kind = folder ? "folder" : kindOf(first != null ? first.rel : name);
            JSONObject file = new JSONObject();
            file.put("name", name); file.put("size", bundle.bytes); file.put("kind", kind); file.put("count", single ? 1 : bundle.roots.size());
            if (folder) file.put("folder", true);
            JSONObject pic = null;
            JSONObject r = null;
            boolean counted = false, shown = false;
            boolean direct = true;                          // Wi-Fi Direct may be tried (not once it went in the middle)
            long heldAt = 0;                                // when the other phone first said it took too many from this one lately
            String before = null;                           // the first try's id on the other phone, once it went
            for (int attempt = 0; ; attempt++) {
                link = link(id, 5000, b, null);
                // (the first try is over there: it stops now, not once its connection times out there)
                if (before != null) { try { link.send(new JSONObject().put("t", "cancel").put("tid", before).put("failed", true)); } catch (Throwable x) { /* it ends there by itself */ } before = null; }
                // over Bluetooth, and big: over Wi-Fi Direct instead when both phones can (else as it is; once that went in the
                // middle, over Bluetooth: see below)
                if (direct) link = faster(id, link, b);
                if ("127.0.0.1".equals(link.ip) || link.direct) b.far = true;     // (reached over a cable, Bluetooth or Wi-Fi Direct)
                b.link = link;
                if (link.direct && !viaDirect) { viaDirect = true; host.directUse(true); }
                if (b.canceled) throw new Fail("canceled", "ECANCELED");
                if (attempt == 0) pic = single && ("image".equals(kind) || "video".equals(kind)) ? thumb(first.file) : null;
                if (b.canceled) throw new Fail("canceled", "ECANCELED");
                final Link lk = link;
                // (sent again: under a new id there, as the first one ended there; here it's the same send)
                final String tid = attempt == 0 ? b.tid : "q" + rid(8);
                b.wire = tid;
                if (attempt > 0) synchronized (wires) { wires.put(tid, b.tid); }
                Link.OnReply on = new Link.OnReply() {
                    @Override public void reply(JSONObject m) {
                        String t = PeerServer.str(m, "t");
                        if ("closed".equals(t) || "bye".equals(t)) { b.wake(); return; }
                        if (!tid.equals(PeerServer.str(m, "tid"))) return;
                        if ("asking".equals(t)) { if (!b.asking) { b.asking = true; host.changed(); } return; }
                        // all of it came (said over the link too: the upload's own answer can be lost): 'saved' follows. kept:
                        // its answer to a Cancel that came too late (it's being saved, nobody there is asked any more)
                        if ("got".equals(t)) { if (Boolean.TRUE.equals(m.opt("kept"))) b.kept = true; b.delivered = true; b.wake(); return; }
                        // how much of the upload has come there (it was asked to say): the list shows that, and post goes by it
                        if ("recv".equals(t)) {
                            long n = Math.min(Math.max(0, m.optLong("bytes")), b.total);
                            if (n > b.recv) { b.recv = n; if (b.reports) host.changed(); }
                            return;
                        }
                        synchronized (b.lock) { if (b.reply == null) b.reply = m; b.lock.notifyAll(); }
                    }
                };
                lk.onReply(on);
                try {
                    try {
                        JSONObject msg = new JSONObject().put("t", "send").put("tid", tid).put("w", 150).put("h", 150).put("file", file);
                        if (pic != null) { msg.put("thumb", pic.optString("thumb")); if (pic.optDouble("aspect", 0) > 0) msg.put("aspect", pic.optDouble("aspect", 0)); }
                        // flicked: the animation it left with, and where (its card comes in the same way, at that height there)
                        if (b.fx != null) {
                            String look = PeerServer.str(b.fx, "look");
                            if (PeerServer.LOOKS.contains(look)) msg.put("look", look);
                            double y = b.fx.optDouble("y", -1), vx = b.fx.optDouble("vx", 0);
                            if (y >= 0 && y <= 1) msg.put("y", Math.round(y * 1000) / 1000.0);
                            if (vx == vx && Math.abs(vx) <= 10) msg.put("vx", Math.round(vx * 1000) / 1000.0);
                        }
                        // (one that says how much of an upload has come is asked to: its progress is followed, see post)
                        b.reports = lk.caps.contains("recv");
                        if (b.reports) msg.put("recv", 1);
                        lk.send(msg);
                        if (!shown) { host.started(id, b.tid, file); shown = true; }
                        JSONObject l;
                        synchronized (host) {
                            JSONObject x = host.links().optJSONObject(id);
                            if (x == null) throw new Fail("removed", "ECANCELED");          // (removed meanwhile)
                            l = new JSONObject(x.toString());
                        }
                        String q = "tid=" + enc(tid) + "&device=" + enc(host.id()) + "&token=" + enc(l.optString("token"));
                        try {
                            if (single) post(lk, l.optString("fp"), b, "/api/upload?" + q + "&name=" + enc(name) + "&size=" + first.size, first.size, first.file, null);
                            else post(lk, l.optString("fp"), b, "/api/bundle?" + q + "&bytes=" + bundle.bytes, -1, null, bundle);
                            b.delivered = true;                             // its answer: all of it is there
                        } catch (Fail e) {
                            if (b.canceled) throw new Fail("canceled", "ECANCELED");
                            if ("ESHORT".equals(e.code) || "EREAD".equals(e.code)) throw e;         // (this phone's file, not the other)
                            // Cut off before the end, or refused (no room, removed): the other phone's answer over the link says
                            // why. All of it went and only the answer was lost: it says at once whether all of it came ('got'),
                            // then whether it saved them (waited for below); nothing about it in seconds: it never all came (the
                            // connection broke before it read it all, or even what it was).
                            if (!"ELOST".equals(e.code)) {
                                r = waitReply(b, lk, 1500);
                                if (b.canceled) throw new Fail("canceled", "ECANCELED");
                                if (r == null) throw e;
                                if ("failed".equals(PeerServer.str(r, "t"))) throw turnedDown(r);
                            } else if (!b.delivered) {
                                r = waitReply(b, lk, GOT_MS, true);
                                if (b.canceled) throw new Fail("canceled", "ECANCELED");
                                if (r == null && !b.delivered) throw lk.open ? new Fail("not all of it came", "ECUT") : new Fail("no answer", "EUNCONFIRMED");
                                if (r != null && "failed".equals(PeerServer.str(r, "t"))) throw turnedDown(r);
                            }
                        }
                        b.left += bundle.skipped;
                        b.sent = b.total; b.recv = b.total;
                        counted = true;
                        host.changed();
                        if (r == null) {
                            // uploaded: the other phone puts them in place (and says so); longer for more (thousands of files, or
                            // a big folder copied into its shared storage, take a while)
                            r = waitReply(b, lk, 120000 + bundle.files * 5L + bundle.bytes / 50000);
                            if (b.canceled) throw new Fail("canceled", "ECANCELED");
                            if (r == null) {
                                // All of it is there (its answer said so) and the user stopped waiting, or the link went: it ends
                                // as sent (the link went: not confirmed, and that's said). Otherwise, or while its user was being
                                // asked whether to take them, whether it was saved can't be heard.
                                if (b.late) r = new JSONObject().put("t", "saved").put("late", true);
                                else if (b.delivered && !lk.open && !b.asking) r = new JSONObject().put("t", "saved").put("unconfirmed", true);
                                else throw new Fail("no answer", "EUNCONFIRMED");
                            }
                            if ("failed".equals(PeerServer.str(r, "t"))) throw turnedDown(r);
                        }
                    } catch (Fail e) {
                        // Canceled here once all of it may be there already (its last bytes went, or were on their way): what came
                        // first on the other phone, all of it or the Cancel, is what happened (see settle)
                        if (!"ECANCELED".equals(e.code) || !b.canceled || !(b.delivered || b.bodyDone || (b.posted && b.sent >= b.total))) throw e;
                        r = settle(b, lk, tid);
                        if (r == null) throw e;
                        if (!counted) { b.left += bundle.skipped; b.sent = b.total; b.recv = b.total; }
                    }
                } catch (Exception e) {
                    // Wi-Fi Direct went in the middle (its network gone, or this phone out of its range) before all of it went
                    // out, so none of it can be kept there: it carries on over Bluetooth, from the start, once (the other phone
                    // hears the first try is over)
                    String code = e instanceof Fail ? ((Fail) e).code : "EIO";
                    // Too many sends from this phone in the last minute there (sent one right after another): none of it was
                    // taken, and its count there frees up within a minute (tries it turns away don't count). It waits, as
                    // "waiting", and goes again every few seconds, for a minute and a bit at most.
                    if ("EBUSY".equals(code) && !b.canceled) {
                        long now = PeerServer.mono();
                        if (heldAt == 0) heldAt = now;
                        if (now - heldAt < BUSY_MS) {
                            host.log("peers: " + id + " has had too many sends from this phone lately: again in a moment");
                            // (what the try turned away did counts for nothing: a Cancel meanwhile stops it at once)
                            again(b);
                            r = null; counted = false;
                            b.held = true;
                            host.changed();
                            for (long w = 0; w < BUSY_STEP_MS && !b.canceled; w += 200) Thread.sleep(200);
                            b.held = false;
                            host.changed();
                            if (b.canceled) throw new Fail("canceled", "ECANCELED");
                            continue;
                        }
                    }
                    if (!direct || !lk.direct || b.canceled || b.bodyDone || b.sent >= b.total
                        || !("ECONNRESET".equals(code) || "ETIMEDOUT".equals(code) || "ECUT".equals(code) || "EIO".equals(code))) throw e;
                    host.log("peers: Wi-Fi Direct to " + id + " went after " + b.sent + " of " + b.total + " bytes (" + code + "): on over Bluetooth");
                    drop(id);
                    if (viaDirect) { viaDirect = false; host.directUse(false); }
                    again(b);
                    r = null; counted = false;
                    before = tid;
                    direct = false;
                    continue;
                } finally { lk.offReply(on); }
                break;
            }
            cancelLate(b);
            setBusy(id, null);
            // what went: a file that changed or went away since it was picked is left out, and folders too deep to be
            // taken: each is said
            int went = Math.max(0, bundle.files - bundle.skipped);
            StringBuilder note = new StringBuilder();
            if (b.left > 0) note.append(plural(b.left, "file", "files")).append(" couldn’t be read (changed or gone since picked) and didn’t go.");
            if (bundle.more) note.append(note.length() > 0 ? " " : "").append("Only the first ").append(String.format(Locale.US, "%,d", bundle.files)).append(" files went. Send the rest separately.");
            if (b.deep) note.append(note.length() > 0 ? " " : "").append("Folders more than 62 levels deep were left out.");
            if (r != null && r.optBoolean("unconfirmed", false)) note.append(note.length() > 0 ? " " : "").append("The connection closed before ").append(nm).append(" said it saved them.");
            if (note.length() > 0) setError(id, note.toString());
            host.sent(id, b.tid, nm, name, went, bundle.bytes, note.length() > 0 ? note.toString() : null);
        } catch (Throwable e) {
            cancelLate(b);
            // It doesn't take files from this phone any more ('failed', why removed). When its user removed this phone, it
            // says that right after ('peer-forget': see forgot) and closes the link: once the link is closed (a moment),
            // all it said is in, and the words below say which it was.
            if (link != null && e instanceof Fail && "EAUTH".equals(((Fail) e).code) && "removed".equals(e.getMessage())) {
                long until = PeerServer.mono() + 1000;
                while (link.open && !b.removedThere && PeerServer.mono() < until) { try { Thread.sleep(20); } catch (InterruptedException x) { break; } }
            }
            // (removed by the other phone's user meanwhile: said as such, not as a Cancel here)
            String code = b.removedThere ? "EREMOVED" : b.canceled ? "ECANCELED" : e instanceof Fail ? ((Fail) e).code : "EIO";
            // (Flick there said it was closing: what broke after that broke because of it, not the network; all of it there
            // and being saved, whether it was is said as before)
            if (link != null && link.bye && !b.canceled && (!b.delivered || b.asking)
                && ("ECONNRESET".equals(code) || "ETIMEDOUT".equals(code) || "EIO".equals(code) || "ELOST".equals(code) || "EUNCONFIRMED".equals(code) || "ECUT".equals(code))) code = "EQUITTHERE";
            // (its why says a Cancel here stopped it: the other device says Canceled, not that it failed; one canceled
            // there, or ended there as it removed this phone, is over there already)
            if (link != null && link.open && b.tid != null && !b.cancelSent && !"ECONNRESET".equals(code) && !"ETHERE".equals(code) && !"EREMOVED".equals(code)) {
                try {
                    // (under the id it has there: a send that went again has another one there, see wire)
                    JSONObject c = new JSONObject().put("t", "cancel").put("tid", b.wire != null ? b.wire : b.tid).put("failed", true);
                    if (b.canceled) c.put("why", "canceled");
                    link.send(c);
                } catch (Throwable x) { /* gone */ }
            }
            closeRaw(b.upload);
            closeRaw(b.opening);
            // the network failed, or Flick there closed: the next try makes a new link (this one may be to where the phone was)
            boolean reach = "ECONNRESET".equals(code) || "ETIMEDOUT".equals(code) || "EUNREACH".equals(code) || "EIO".equals(code) || "EOTHER".equals(code);
            if (reach || "EQUITTHERE".equals(code)) drop(id);
            synchronized (busy) { if (busy.get(id) == b) busy.remove(id); }
            boolean still;
            synchronized (host) { still = host.links().has(id); }
            String why = "ECANCELED".equals(code) || !still && !"EREMOVED".equals(code) ? null     // (canceled, or removed here meanwhile: nothing to say)
                : "EREMOVED".equals(code) ? nm + " removed this phone."
                : "ETHERE".equals(code) ? "Canceled on " + nm
                : "EQUITTHERE".equals(code) ? "Flick was closed on " + nm + " before the send finished."
                : "EDECLINED".equals(code) ? nm + " didn’t accept the files."
                : "EAUTH".equals(code) ? nm + " doesn’t know this phone any more. Remove it and pair again."
                : "EPIN".equals(code) ? "Something other than " + nm + " answered at its address. Nothing was sent. If Flick was installed again there, remove it and pair again."
                : "ENOSPACE".equals(code) ? nm + " doesn’t have enough space for them."
                : "ESAVE".equals(code) ? nm + " couldn’t save them."
                : "EBUSY".equals(code) ? nm + " has had too many sends from this phone in the last minute. Try again in a minute."
                : "EOFF".equals(code) ? nm + " stopped taking files from other phones."
                : "EUNCONFIRMED".equals(code) ? "Sent, but " + nm + " didn’t say whether it saved them. Check there before sending again."
                : "ESHORT".equals(code) ? (single ? "The file" : "A file") + " changed while it was being sent. Try again."
                : "EREAD".equals(code) ? (single ? "That file" : "A file") + " can’t be read any more."
                : "EEMPTY".equals(code) ? "Those files can’t be read any more."
                : "EHTTP".equals(code) || "ECUT".equals(code) || "EPROTO".equals(code) ? "Sending to " + nm + " didn’t work. Try again."
                : b.farShut && !b.far ? "Couldn’t reach " + nm + " on this Wi-Fi. Open Flick to reach it over Bluetooth, or make sure it’s on the same Wi-Fi."
                : b.far ? "Couldn’t reach " + nm + ". Make sure Flick is open on it, and that it’s nearby or on the same Wi-Fi."
                : "Couldn’t reach " + nm + ". Make sure Flick is open on it, on the same Wi-Fi.";
            // (Flick closed there: said until it answers on the network again, as when it can't be reached)
            setError(id, why, reach || "EQUITTHERE".equals(code), "ETHERE".equals(code));
            // what History keeps as the reason (as the computer does): its user said no, or didn't answer in time; it doesn't
            // take files from this phone any more; Flick was closed there
            String word = "EDECLINED".equals(code) ? ("timeout".equals(e.getMessage()) ? "timeout" : "declined")
                : "EREMOVED".equals(code) || "EAUTH".equals(code) ? "unpaired" : "EQUITTHERE".equals(code) ? "quit" : "send";
            // (why null: canceled here; the page still hears it's over)
            host.failed(id, b.tid, nm, why, "ECANCELED".equals(code) || "ETHERE".equals(code), word);
            host.log("peers: send to " + id + " failed: " + code + (e.getMessage() != null ? " (" + e.getMessage() + ")" : ""));
        } finally {
            if (viaDirect) host.directUse(false);
        }
    }

    /**
     * A send of b.total bytes over lk: when lk is over Bluetooth, the files are big and both phones can, the other one
     * says where it is over Wi-Fi Direct (making a network of its own for it, a few seconds) and this one joins it: a link
     * there instead, kept for what follows. Anything that doesn't work: lk, as it was (Bluetooth is slower, not worse).
     */
    private Link faster(String id, Link lk, Busy b) {
        Found t = tunnel(id);
        boolean overBt = t != null && "bluetooth".equals(t.via) && "127.0.0.1".equals(lk.ip) && lk.port == t.port;
        if (!overBt || lk.direct || b.total < DIRECT_MIN || !lk.caps.contains("direct") || b.canceled) return lk;
        try {
            if (!host.directReady()) return lk;
            long t0 = PeerServer.mono();
            JSONObject a = lk.ask(new JSONObject().put("t", "direct").put("group", host.directGroup()), 20000, b.abort);
            if (b.canceled || a == null || !a.optBoolean("ok", false)) { host.log("peers: no Wi-Fi Direct (" + (a == null ? "no answer" : PeerServer.str(a, "why")) + ")"); return lk; }
            String ip = PeerServer.str(a, "ip"), ssid = PeerServer.str(a, "ssid"), pass = PeerServer.str(a, "pass");
            Object po = a.opt("port");
            int port = po instanceof Number ? ((Number) po).intValue() : 0;
            if (!ip.matches("\\d{1,3}(\\.\\d{1,3}){3}") || port <= 0 || port >= 65536) return lk;   // (its certificate is checked there as anywhere)
            if (!ssid.isEmpty() && !host.directJoin(ssid, pass, ip, 15000, b.abort)) { host.log("peers: couldn't join its Wi-Fi Direct network"); return lk; }
            if (b.canceled) return lk;
            JSONObject l;
            synchronized (host) { JSONObject x = host.links().optJSONObject(id); l = x == null ? null : new JSONObject(x.toString()); }
            if (l == null) return lk;
            Link d = null;
            try {
                d = Link.open(this, ip, port, l.optString("fp"), l.optString("token"), id, 5000, b);
                if (!d.trusted) { d.close(); return lk; }
                d.connect(5000);
            } catch (Exception e) {
                if (d != null) d.close();
                host.log("peers: Wi-Fi Direct link failed: " + e);
                return lk;
            } finally { b.opening = null; }
            if (b.canceled) { d.close(); return lk; }
            d.direct = true;
            keep(id, d);                                    // (the Bluetooth link goes: what follows goes this way)
            host.log("peers: over Wi-Fi Direct to " + id + " in " + (PeerServer.mono() - t0) + " ms");
            return d;
        } catch (Throwable e) {
            host.log("peers: Wi-Fi Direct: " + e);
            return lk;
        }
    }

    private static void cancelLate(Busy b) { synchronized (b.lock) { if (b.lateT != null) b.lateT.cancel(false); } }

    // a send that starts over another way: nothing of the try before counts
    private static void again(Busy b) {
        synchronized (b.lock) { b.reply = null; }
        b.sent = 0; b.posted = false; b.bodyDone = false; b.delivered = false; b.asking = false; b.kept = false; b.cancelSent = false;
        b.reports = false; b.recv = 0;
        b.upload = null; b.opening = null;
    }

    // a send the other phone turned away (too many from this phone in its last minute) goes again this often, this long
    private static final long BUSY_STEP_MS = 5000, BUSY_MS = 65000;

    // how long a send canceled as the last of it went waits to hear what the other phone made of it (it answers within a
    // moment: one from before this says nothing when the Cancel came in time)
    private static final long SETTLE_MS = 5000;

    /**
     * A send canceled here once all of it may be there already (its last bytes went, or were on their way): whichever
     * came first on the other phone, all of it or the Cancel, is what happened, so both phones say the same. It's told
     * now, and says it had all of it already ('got': it's being saved, too late to stop; 'saved'), or that it stopped
     * it ('failed'; a phone from before this says nothing then). While its user is asked whether to take them (Ask each
     * time), all of it there isn't enough: Accept there came first ('saved', or 'got' kept: being saved), or the
     * question went ('failed'). Returns the answer that it's there (the send ends as sent), or null: it's canceled.
     */
    private JSONObject settle(Busy b, Link lk, String tid) throws Exception {
        if (lk.open && !b.cancelSent) {
            b.cancelSent = true;
            lk.send(new JSONObject().put("t", "cancel").put("tid", tid).put("failed", true).put("why", "canceled"));
        }
        long until = PeerServer.mono() + SETTLE_MS;
        synchronized (b.lock) {
            while (true) {
                JSONObject x = b.reply;
                if (x != null) return "saved".equals(PeerServer.str(x, "t")) ? x : null;
                if (b.kept || (b.delivered && !b.asking)) return new JSONObject().put("t", "saved").put("late", true);
                long left = until - PeerServer.mono();
                if (left <= 0 || !lk.open) return null;
                b.lock.wait(Math.min(left, 200));
            }
        }
    }

    // the picture for the other phone's card: made on the side, and not waited for long (the files go anyway)
    private JSONObject thumb(final File f) {
        java.util.concurrent.Future<JSONObject> job = work.submit(new java.util.concurrent.Callable<JSONObject>() {
            @Override public JSONObject call() { try { return host.thumbFor(f); } catch (Throwable e) { return null; } }
        });
        try {
            JSONObject t = job.get(700, java.util.concurrent.TimeUnit.MILLISECONDS);
            String u = t == null ? "" : t.optString("thumb");
            return u.startsWith("data:image/") && u.length() < 300000 ? t : null;
        } catch (Throwable e) { job.cancel(false); return null; }
    }

    // ------------------------------------------------------------ besides files: a clipboard, a link, find my phone
    interface Done { void done(String why); }

    /**
     * m (its t: "clip", "link", "ring", "ring-stop", "ring-found") to a paired device that takes cap (PeerServer.CAPS),
     * on a thread of its own; done(null) once it took it, else done(why): "unpaired", "old" (its Flick is from before
     * this), "auth" (it doesn't know this phone any more), "unreachable", "no answer", or what it said ("busy", "quiet",
     * "off", "bad"...).
     */
    void message(final String id, final String cap, final JSONObject m, final Done done) {
        work.execute(new Runnable() {
            @Override public void run() {
                String why;
                try {
                    boolean has;
                    synchronized (host) { has = host.links().has(id); }
                    if (!has) why = "unpaired";
                    else {
                        Link lk = link(id, 5000, null, null);
                        if (!lk.caps.contains(cap)) why = "old";
                        else {
                            // (its answer comes once all of it is there: a clipboard picture of a few megabytes takes a while
                            // over a slow link)
                            String png = PeerServer.str(m, "png"), txt = PeerServer.str(m, "text");
                            long size = png.length() + txt.length() * 3L;
                            JSONObject a = lk.ask(m, 12000 + size * 1000 / SLOW_RATE);
                            why = a == null ? (lk.open ? "no answer" : "unreachable") : a.optBoolean("ok", false) ? null : PeerServer.str(a, "why").isEmpty() ? "refused" : PeerServer.str(a, "why");
                        }
                    }
                } catch (Fail e) {
                    why = "EAUTH".equals(e.code) ? "auth" : "unreachable";
                    if (!"EAUTH".equals(e.code)) dropIdle(id);
                } catch (Throwable e) {
                    why = "unreachable";
                    dropIdle(id);
                }
                try { done.done(why); } catch (Throwable e) { host.log("peers: " + e); }
            }
        });
    }

    /** What's being sent to a phone now, to read how far it got (tid, sent, total, files, items, asking), or null. */
    Busy sending(String id) {
        synchronized (busy) { Busy b = busy.get(id); return b != null && "sending".equals(b.what) ? b : null; }
    }

    /** Stops what's being sent to (or the pairing with) a phone. */
    void cancel(final String id) {
        final Busy b;
        synchronized (busy) { b = busy.get(id); }
        if (b != null) cancel(id, b);
    }

    /** Stops that send to a phone (tid), if it's still going: never the one after it. */
    void cancel(String id, String tid) {
        Busy b;
        synchronized (busy) { b = busy.get(id); }
        if (b != null && tid != null && tid.equals(b.tid) && "sending".equals(b.what)) cancel(id, b);
    }

    private void cancel(final String id, final Busy b) {
        if ("pairing".equals(b.what)) { confirm(id, false); return; }
        if (!b.asking) {
            // all of it is there and being saved: too late to stop (the other phone doesn't either). It ends as sent, now.
            if (b.delivered) { b.late = true; b.wake(); return; }
            // all of it went and its answer is on the way: a moment for it (then it's too late to stop, or it stops)
            if (b.bodyDone) {
                synchronized (b.lock) {
                    if (b.lateT != null) return;
                    b.lateT = GUARD.schedule(new Runnable() {
                        @Override public void run() {
                            synchronized (busy) { if (busy.get(id) != b) return; }
                            if (b.delivered) { b.late = true; b.wake(); } else stop(b);
                        }
                    }, 1000, TimeUnit.MILLISECONDS);
                }
                return;
            }
        }
        stop(b);
    }

    private void stop(Busy b) {
        b.canceled = true;
        b.abort.set(true);
        closeRaw(b.opening);                                   // (still connecting: it stops now)
        // (over a cable's or Bluetooth's link: what it holds of the upload goes, and the other phone hears now)
        Socket u = b.upload;
        Link lk = b.link;
        if (u != null && lk != null && "127.0.0.1".equals(lk.ip)) { try { host.cut(lk.port, u.getLocalPort()); } catch (Throwable e) { /* it ends as it notices */ } }
        closeRaw(u);                                           // (the page's call returns at once)
        b.wake();
        host.changed();
    }

    // one request over a new encrypted connection, pinned to the phone's certificate
    private void post(Link lk, String pin, final Busy b, String path, long length, File file, Bundle bundle) throws Exception {
        if (b.canceled) throw new Fail("canceled", "ECANCELED");
        b.bodyDone = false;
        Opened o = tlsOpen(lk.ip, lk.port, pin, 6000, b);
        b.opening = null;
        final Socket s = o.sock, raw = o.raw;
        b.upload = raw;
        // Nothing moving for STALL_MS (the other phone stopped reading, or never answers once all of it went, or the
        // network went): the connection goes, instead of "sending" for ever. What moves (what went into the connection,
        // what the other phone says came, over a cable's or Bluetooth's link what that link sent on) buys time at the
        // slowest pace a link that still works goes (MIN_PACE), STALL_MS ahead at most: a phone that says a byte at a time
        // has come, or takes a byte at a time, can't keep this one sending for ever (as a computer holds a phone to it:
        // pc/peerlink.js).
        final AtomicBoolean stalled = new AtomicBoolean();
        final long t0 = PeerServer.mono();
        // what moved so far (-1: not looked yet), when it's stalled, when it last moved, and (all of it went, and the
        // other phone says how much came) by when the rest must have
        final long[] w = {-1, t0 + STALL_MS, t0, 0};
        final boolean linked = "127.0.0.1".equals(lk.ip);
        final int from = raw.getLocalPort();
        ScheduledFuture<?> wd = GUARD.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() {
                // (what it says came counts once it said it says so: one that didn't is held to the time for a slow link)
                long now = PeerServer.mono(), at = b.sent + (b.reports ? b.recv : 0);
                if (linked) { try { at += Math.max(0, host.carried(lk.port, from)); } catch (Throwable e) { /* as it is */ } }
                if (w[0] < 0) w[0] = at;
                if (at > w[0]) {
                    w[1] = Math.min(now + STALL_MS, Math.max(w[1], now) + (at - w[0]) * 1000 / MIN_PACE);
                    w[0] = at; w[2] = now;
                }
                long due = w[1];
                // (all of it went into the connection: over a slow network much of it can still be on its way, the connection
                // quiet meanwhile. One that doesn't say how much came gets the time that much takes at a slow link's pace (a
                // cable's or Bluetooth's link counts what it carried itself); one that does, while what it says moves, but
                // STALL_MS more than the rest of it takes at the slowest pace at most.)
                if (b.bodyDone && !b.reports && !linked) due = Math.max(due, w[2] + STALL_MS + Math.min(b.sent, IN_FLIGHT) * 1000 / SLOW_RATE);
                if (b.bodyDone && b.reports) {
                    if (w[3] == 0) w[3] = now + STALL_MS + Math.min(Math.max(0, b.sent - b.recv), IN_FLIGHT) * 1000 / MIN_PACE;
                    due = Math.min(due, w[3]);
                }
                if (now >= due) { stalled.set(true); closeRaw(raw); }
            }
        }, 2500, 2500, TimeUnit.MILLISECONDS);
        try {
            if (b.canceled) throw new Fail("canceled", "ECANCELED");          // stopped while it was connecting
            s.setSoTimeout(60000);
            OutputStream sout = s.getOutputStream();
            String head = "POST " + path + " HTTP/1.1\r\nHost: " + lk.ip + ":" + lk.port + "\r\nUser-Agent: Flick-Phone\r\nContent-Type: application/octet-stream\r\n" +
                (length >= 0 ? "Content-Length: " + length + "\r\n" : "Transfer-Encoding: chunked\r\n") + "Connection: close\r\n\r\n";
            b.posted = true;
            sout.write(head.getBytes("ISO-8859-1"));
            OutputStream counted = new FilterOutputStream(sout) {
                long last = 0;
                @Override public void write(byte[] x, int off, int len) throws IOException {
                    // (16 KB at a time, each counted as it goes: a slow network moves a 256 KB write for longer than
                    // the stall watchdog waits, and it would end an upload that's going)
                    while (len > 0) {
                        if (b.canceled) throw new IOException("canceled");
                        int k = Math.min(len, 16384);
                        out.write(x, off, k);
                        b.sent += k; off += k; len -= k;
                        long now = PeerServer.mono();
                        if (now - last > 150) { last = now; host.changed(); }
                    }
                }
                @Override public void write(int x) throws IOException { write(new byte[]{(byte) x}, 0, 1); }
            };
            if (length >= 0) {
                OutputStream out = new BufferedOutputStream(counted, 256 * 1024);
                // (this phone's file that can't be read, or got shorter, is said as such: not as the other phone's fault)
                InputStream in;
                try { in = new FileInputStream(file); } catch (IOException e) { throw new Fail("can't be read", "EREAD"); }
                try {
                    byte[] buf = new byte[256 * 1024];
                    long left = length;
                    while (left > 0) {
                        int n;
                        try { n = in.read(buf, 0, (int) Math.min(buf.length, left)); } catch (IOException e) { throw new Fail("can't be read", "EREAD"); }
                        if (n < 0) throw new Fail("the file got shorter while it was sent", "ESHORT");
                        out.write(buf, 0, n);
                        left -= n;
                    }
                } finally { in.close(); }
                out.flush();
            } else {
                OutputStream ch = new ChunkedOut(counted);
                OutputStream out = new BufferedOutputStream(ch, 256 * 1024);
                try { bundle.write(out, b.abort, null); }
                catch (Bundle.Changed e) { throw new Fail("changed while sent", "ESHORT"); }
                catch (Bundle.Unreadable e) { throw new Fail("can't be read", "EREAD"); }
                out.flush();
                ch.close();
            }
            sout.flush();
            b.bodyDone = true;
            // (the answer comes once all of it got there: over a slow network, minutes after the last of it went. The watch
            // above ends it when nothing moves meanwhile, not a fixed time.)
            s.setSoTimeout(0);
            // the answer: 200 and {"ok":true}, or why not
            InputStream in = s.getInputStream();
            ByteArrayOutputStream hb = new ByteArrayOutputStream();
            int last4 = 0;
            while (last4 != 0x0d0a0d0a) { int x = in.read(); if (x < 0) throw new IOException("cut off"); hb.write(x); last4 = (last4 << 8) | x; if (hb.size() > 16384) throw new Fail("bad answer", "EHTTP"); }
            String st = new String(hb.toByteArray(), "ISO-8859-1");
            int code = st.matches("(?s)HTTP/1\\.[01] [0-9]{3}[ \r].*") ? Integer.parseInt(st.substring(9, 12)) : -1;
            if (code == 200) return;
            if (code == 410 && canceledThere(st, in)) throw new Fail("canceled there", "ETHERE");
            throw new Fail("http " + code, code == 507 ? "ENOSPACE" : code == 403 ? "EAUTH" : code == 410 ? "EDECLINED" : code == 429 ? "EBUSY" : "EHTTP");
        } catch (Fail e) {
            throw e;
        } catch (IOException e) {
            if (b.canceled) throw new Fail("canceled", "ECANCELED");
            // (all of it went into the connection, but the other phone says less came, and nothing more for a while: the
            // network stopped carrying it, not "sent")
            if (stalled.get()) throw new Fail("no answer", b.bodyDone && !(b.reports && b.recv < b.total) ? "EUNCONFIRMED" : "ETIMEDOUT");
            // all of it went, and only the answer to it was lost (the connection broke): whether it was saved comes over
            // the link
            if (b.bodyDone) throw new Fail("lost", "ELOST");
            throw new Fail(String.valueOf(e.getMessage()), "ECONNRESET");
        } finally {
            wd.cancel(false);
            b.upload = null;
            closeRaw(raw);                                      // (all of it has been said: nothing waits on a goodbye)
        }
    }

    // a 410's body (head: what came before it) says its user canceled them there (canceled: true)
    private static boolean canceledThere(String head, InputStream in) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?im)^content-length:\\s*(\\d{1,5})\\s*$").matcher(head);
            int n = m.find() ? Integer.parseInt(m.group(1)) : -1;
            if (n <= 0 || n > 16384) return false;
            return Boolean.TRUE.equals(PeerServer.parse(new String(Link.readN(in, n), "UTF-8")).opt("canceled"));
        } catch (Exception e) { return false; }
    }

    private static final class ChunkedOut extends FilterOutputStream {
        ChunkedOut(OutputStream o) { super(o); }
        @Override public void write(byte[] b, int off, int len) throws IOException {
            if (len <= 0) return;
            out.write((Integer.toHexString(len) + "\r\n").getBytes("ISO-8859-1"));
            out.write(b, off, len);
            out.write("\r\n".getBytes("ISO-8859-1"));
        }
        @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }
        @Override public void close() throws IOException { out.write("0\r\n\r\n".getBytes("ISO-8859-1")); out.flush(); }
    }

    void stop() {
        scan(false);
        closeUdp();
        List<Link> ls;
        synchronized (live) { ls = new ArrayList<Link>(live.values()); live.clear(); }
        for (Link l : ls) l.close();
    }

    // ------------------------------------------------------------ an encrypted, signed-in link (WebSocket)
    static final class Fail extends Exception {
        final String code;
        Fail(String m, String code) { super(m); this.code = code; }
    }

    /** sock: the encrypted connection; raw: the plain one under it (closing that ends it at once, whatever it's doing). */
    static final class Opened { Socket sock, raw; String fp; }

    /** The connection under an encrypted one goes, at once: no goodbye to wait for, nothing left to send first. */
    static void closeRaw(Socket raw) {
        if (raw == null) return;
        try { raw.setSoLinger(true, 0); } catch (Throwable e) { /* closed already */ }
        PeerServer.closeQuietly(raw);
    }

    Opened tlsOpen(String ip, int port, String pin, int ms) throws Exception { return tlsOpen(ip, port, pin, ms, null); }

    /**
     * TLS to ip:port; pin: the certificate the paired phone has (null while pairing: the one seen is reported). The
     * connection and its handshake are done within ms, however slowly the other side answers; b: what Cancel closes.
     */
    Opened tlsOpen(String ip, int port, String pin, int ms, Busy b) throws Exception {
        final Socket raw = new Socket();
        if (b != null) b.opening = raw;
        final AtomicBoolean late = new AtomicBoolean();
        ScheduledFuture<?> g = GUARD.schedule(new Runnable() { @Override public void run() { late.set(true); closeRaw(raw); } }, ms, TimeUnit.MILLISECONDS);
        try {
            if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
            Wire.bind(raw, ip);                     // (a Wi-Fi without internet next to mobile data: over that Wi-Fi)
            // (a cable's or Bluetooth's link here takes only this phone's own connections: it's told which one is coming;
            // and what's written into one is soon on its way over the link, not megabytes in the phone's own buffers: a
            // send over a slow link moves as fast as it really goes)
            if ("127.0.0.1".equals(ip)) {
                raw.setSendBufferSize(32 * 1024);
                raw.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
                try { host.expect(port, raw.getLocalPort()); } catch (Throwable e) { /* not a link's */ }
            }
            raw.connect(new InetSocketAddress(ip, port), ms);
            SSLSocket s = (SSLSocket) sf.createSocket(raw, ip, port, true);
            s.setSoTimeout(ms);
            s.startHandshake();
            Certificate[] cs = s.getSession().getPeerCertificates();
            String fp = cs.length > 0 ? PeerCert.hex(MessageDigest.getInstance("SHA-256").digest(cs[0].getEncoded())) : "";
            if (fp.isEmpty() || (pin != null && !pin.isEmpty() && !pin.equals(fp))) throw new Fail("not the phone paired with", "EPIN");
            Opened o = new Opened();
            o.sock = s; o.raw = raw; o.fp = fp;
            return o;
        } catch (Exception e) {
            // (a handshake that failed or was too slow leaves nothing open)
            closeRaw(raw);
            if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
            if (late.get() && !(e instanceof Fail)) throw new Fail("timed out", "ETIMEDOUT");
            throw e;
        } finally { g.cancel(false); }
    }

    /** What a 'welcome' or 'connected' says the other side takes besides files (PeerServer.CAPS). */
    static java.util.Set<String> capsOf(JSONObject m) {
        JSONArray a = m.optJSONArray("caps");
        java.util.Set<String> c = new HashSet<String>();
        for (int i = 0; a != null && i < a.length() && i < 32; i++) { Object x = a.opt(i); if (x instanceof String && ((String) x).length() <= 20) c.add((String) x); }
        return c;
    }

    static final class Link {
        interface OnCode { void code(String c); }
        interface OnReply { void reply(JSONObject m); }
        final PeerClient pc;
        final String ip; final int port; final String token, expect;
        Socket sock, raw; OutputStream out; String fp;
        volatile boolean open = true, trusted, connected, proved;
        String nonceP, peerId, peerName;
        volatile long idleAt;
        volatile long heard = PeerServer.mono();              // when the other phone last said anything (a pong too)
        volatile String helloName;                            // this phone's name as it signed in
        // what the other side takes besides files ('connected' says: PeerServer.CAPS); none from a Flick before 2.1
        volatile java.util.Set<String> caps = java.util.Collections.emptySet();
        volatile boolean direct;                              // over Wi-Fi Direct (made for a send that was over Bluetooth)
        volatile boolean forgotten;                           // the other phone removed this one over it (see forgot)
        volatile boolean made;                                // the pairing made over it is kept here (finishPair)
        // the other phone asked this one to sign in (it has a pairing for this phone); once signed in, whether it can send
        // to this one (null: it didn't say: see verify)
        volatile boolean challenged;
        volatile Boolean back;
        volatile boolean bye;                                 // Flick on the other phone said it's closing ('bye')
        private final Map<String, JSONObject> acks = new HashMap<String, JSONObject>();   // mid -> its answer (under acks)
        private final List<JSONObject> inbox = new ArrayList<JSONObject>();
        private final List<OnReply> replies = new ArrayList<OnReply>();

        private Link(PeerClient pc, String ip, int port, String token, String expect) { this.pc = pc; this.ip = ip; this.port = port; this.token = token; this.expect = expect; }

        static Link open(PeerClient pc, String ip, int port, String pin, String token, String expect, int ms, Busy b) throws Exception {
            Link l = new Link(pc, ip, port, token, expect);
            Opened o = pc.tlsOpen(ip, port, pin, ms, b);
            l.sock = o.sock; l.raw = o.raw; l.fp = o.fp;
            // the WebSocket's answer within ms too, however slowly it comes
            final Socket raw = o.raw;
            final AtomicBoolean late = new AtomicBoolean();
            ScheduledFuture<?> g = GUARD.schedule(new Runnable() { @Override public void run() { late.set(true); closeRaw(raw); } }, ms, TimeUnit.MILLISECONDS);
            try {
                l.out = l.sock.getOutputStream();
                final InputStream in = l.sock.getInputStream();
                String key = pc.rid(16);
                key = base64(hexBytes(key));
                String want = base64(MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes("ISO-8859-1")));
                l.out.write(("GET /ws HTTP/1.1\r\nHost: " + ip + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                    "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Flick-Phone\r\n\r\n").getBytes("ISO-8859-1"));
                l.out.flush();
                ByteArrayOutputStream hb = new ByteArrayOutputStream();
                int last4 = 0;
                while (last4 != 0x0d0a0d0a) { int x = in.read(); if (x < 0) throw new Fail("closed", "ECONNRESET"); hb.write(x); last4 = (last4 << 8) | x; if (hb.size() > 16384) throw new Fail("bad answer", "EPROTO"); }
                g.cancel(false);
                if (late.get()) throw new Fail("timed out", "ETIMEDOUT");
                String head = new String(hb.toByteArray(), "ISO-8859-1");
                if (!head.startsWith("HTTP/1.1 101") || !head.toLowerCase(Locale.US).contains("sec-websocket-accept: " + want.toLowerCase(Locale.US))) throw new Fail("refused", "EPROTO");
                l.sock.setSoTimeout(0);
                final Link lk = l;
                l.nonceP = pc.rid(16);                      // (before the thread that reads what comes back: it uses it)
                Thread t = new Thread(new Runnable() { @Override public void run() { lk.readLoop(in); } }, "flick-peer-link");
                t.setDaemon(true);
                t.start();
                Thread p = new Thread(new Runnable() {
                    @Override public void run() {
                        while (lk.open) { try { Thread.sleep(15000); } catch (InterruptedException e) { return; } lk.frame(0x9, new byte[0]); }
                    }
                }, "flick-peer-ping");
                p.setDaemon(true);
                p.start();
                JSONObject h = new JSONObject();
                l.helloName = pc.host.name();               // (signed in under this name: see link())
                h.put("t", "hello"); h.put("v", 4); h.put("device", pc.host.id()); h.put("name", l.helloName); h.put("nonce", l.nonceP);
                h.put("peer", 1); h.put("kind", "phone"); h.put("app", 0);
                l.send(h);
                JSONObject w = l.await("welcome", ms);
                l.trusted = w.optBoolean("trusted") && l.proved;
                l.caps = capsOf(w);
                if (l.trusted && w.opt("back") instanceof Boolean) l.back = (Boolean) w.opt("back");
                JSONObject who = w.optJSONObject("pc");
                l.peerId = who == null ? null : PeerServer.str(who, "id");
                l.peerName = who == null ? null : PeerServer.cleanName(who.opt("name"));
                if (expect != null && l.peerId != null && !l.peerId.isEmpty() && !l.peerId.equals(expect)) throw new Fail("a different phone answered", "EOTHER");
                // signed in: the other phone's Bluetooth key, kept with it (what tells its advertisements and its private
                // hello apart: Peers.bleKeys)
                String bk = PeerServer.str(w, "bk");
                if (l.trusted && bk.matches("[A-Za-z0-9+/]{22}==")) pc.keepKey(expect != null ? expect : l.peerId, bk);
                return l;
            } catch (Exception e) {
                g.cancel(false);
                l.close();
                if (b != null && b.canceled) throw new Fail("canceled", "ECANCELED");
                if (late.get() && !(e instanceof Fail)) throw new Fail("timed out", "ETIMEDOUT");
                throw e;
            }
        }

        void connect(int ms) throws Exception {
            if (!trusted) throw new Fail("not paired", "EAUTH");
            send(new JSONObject().put("t", "connect"));
            await("connected", ms);
            connected = true;
        }

        // Pairing: both sides commit to their half of the code (a hash of it) before either says it, and the other side
        // says its own only once its user is shown the request: nobody, nor anyone in the middle (another certificate,
        // another code), can pick numbers that steer the code, or try again and again unseen until two codes match.
        String pair(OnCode onCode, int ms, Busy b) throws Exception {
            String n = pc.rid(16);
            send(new JSONObject().put("t", "connect").put("commit", PeerServer.sha256(n)));
            JSONObject m = await(new String[]{"pairing", "denied"}, 15000);
            if ("denied".equals(PeerServer.str(m, "t"))) throw new Fail("not allowed", "EDENIED");
            String commitS = PeerServer.str(m, "commit");
            if (!commitS.matches("[0-9a-f]{64}")) throw new Fail("it can't show a pairing code", "EPROTO");
            send(new JSONObject().put("t", "pair-reveal").put("nonce", n));
            JSONObject m2 = await(new String[]{"pair-nonce", "denied"}, 15000);
            if ("denied".equals(PeerServer.str(m2, "t"))) throw new Fail("not allowed", "EDENIED");
            String nS = PeerServer.str(m2, "nonce");
            if (!nS.matches("[0-9a-f]{32,64}") || !PeerServer.sha256(nS).equals(commitS)) throw new Fail("it can't show a pairing code", "EPROTO");
            onCode.code(PeerServer.pairCode(fp, n, nS));
            JSONObject r = await(new String[]{"paired", "denied"}, ms);
            if ("denied".equals(PeerServer.str(r, "t"))) throw new Fail("not allowed", "EDENIED");
            String token = PeerServer.str(r, "token");
            if (!token.matches("[0-9a-f]{32}")) throw new Fail("bad answer", "EPROTO");
            trusted = true;
            connected = true;            // a receiver connects a device the moment it's allowed
            return token;
        }

        /** A message that's answered ('ack'): its answer within ms, or null (none came, or the link went). */
        JSONObject ask(JSONObject m, long ms) throws Exception { return ask(m, ms, null); }
        /** The same, given up as soon as stop is set (a Cancel), or null. */
        JSONObject ask(JSONObject m, long ms, AtomicBoolean stop) throws Exception {
            String mid = pc.rid(6);
            m.put("mid", mid);
            synchronized (acks) { acks.put(mid, null); }
            try {
                send(m);
                long until = PeerServer.mono() + ms;
                synchronized (acks) {
                    while (acks.get(mid) == null && open && !(stop != null && stop.get())) {
                        long left = until - PeerServer.mono();
                        if (left <= 0) break;
                        acks.wait(Math.min(left, 500));
                    }
                    return acks.get(mid);
                }
            } finally { synchronized (acks) { acks.remove(mid); } }
        }

        void onReply(OnReply r) { synchronized (replies) { replies.add(r); } }
        void offReply(OnReply r) { synchronized (replies) { replies.remove(r); } }

        JSONObject await(String type, long ms) throws Exception { return await(new String[]{type}, ms); }
        JSONObject await(String[] types, long ms) throws Exception {
            long until = PeerServer.mono() + ms;
            synchronized (inbox) {
                while (true) {
                    for (Iterator<JSONObject> it = inbox.iterator(); it.hasNext(); ) {
                        JSONObject m = it.next();
                        for (String t : types) if (t.equals(PeerServer.str(m, "t"))) { it.remove(); return m; }
                    }
                    long left = until - PeerServer.mono();
                    if (!open) throw new Fail("the link closed", "ECONNRESET");
                    if (left <= 0) throw new Fail("no answer", "ETIMEDOUT");
                    inbox.wait(Math.min(left, 500));
                }
            }
        }

        void send(JSONObject m) { try { byte[] p = m.toString().getBytes("UTF-8"); frame(0x1, p); } catch (Exception e) { close(); } }

        // a client's frames are masked. One that can't be written within WRITE_MS (the other side doesn't read, its
        // buffers full) ends the link, rather than hold whoever writes (a pong, a send's announcement) for ever. A large
        // one (a clipboard picture: megabytes) gets the time a slow link takes to carry it, as its answer does (message):
        // over Bluetooth it never went within WRITE_MS, and the link was closed under it.
        synchronized void frame(int op, byte[] p) {
            if (!open) return;
            final Socket r = raw;
            ScheduledFuture<?> g = GUARD.schedule(new Runnable() { @Override public void run() { closeRaw(r); } }, WRITE_MS + p.length * 1000L / SLOW_RATE, TimeUnit.MILLISECONDS);
            try {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                b.write(0x80 | op);
                int n = p.length;
                if (n < 126) b.write(0x80 | n);
                else if (n < 65536) { b.write(0x80 | 126); b.write(n >> 8); b.write(n & 255); }
                else { b.write(0x80 | 127); for (int i = 7; i >= 0; i--) b.write((int) ((long) n >> (8 * i)) & 255); }
                byte[] mask = new byte[4];
                pc.rnd.nextBytes(mask);
                b.write(mask, 0, 4);
                for (int i = 0; i < n; i++) b.write(p[i] ^ mask[i & 3]);
                out.write(b.toByteArray());
                out.flush();
            } catch (IOException e) { close(); }
            finally { g.cancel(false); }
        }

        private void readLoop(InputStream in) {
            try {
                ByteArrayOutputStream frag = null;
                while (open) {
                    int b0 = in.read(), b1 = in.read();
                    if (b0 < 0 || b1 < 0) break;
                    heard = PeerServer.mono();
                    boolean fin = (b0 & 0x80) != 0;
                    int op = b0 & 0x0f;
                    long len = b1 & 0x7f;
                    if (len == 126) { byte[] x = readN(in, 2); len = ((x[0] & 0xff) << 8) | (x[1] & 0xff); }
                    else if (len == 127) { byte[] x = readN(in, 8); len = 0; for (byte y : x) len = (len << 8) | (y & 0xff); }
                    // (before the other side has proven who it is, or been paired, what it says is small: a frame room is
                    // set aside for at once mustn't be a megabyte from anyone)
                    int max = proved || trusted ? MAX_WS : MAX_WS_EARLY;
                    if (len < 0 || len > max) break;
                    // a control frame (close, ping, pong) is whole and small (RFC 6455 5.5)
                    if (op >= 0x8 && (!fin || len > 125)) break;
                    byte[] mask = (b1 & 0x80) != 0 ? readN(in, 4) : null;
                    byte[] p = readN(in, (int) len);
                    if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
                    if (op == 0x8) break;
                    if (op == 0x9) { frame(0xA, p); continue; }
                    if (op == 0xA) continue;
                    if (op == 0x1 || op == 0x2) { if (!fin) { frag = new ByteArrayOutputStream(); frag.write(p); continue; } }
                    else if (op == 0x0 && frag != null) { frag.write(p); if (frag.size() > max) break; if (!fin) continue; p = frag.toByteArray(); frag = null; }
                    else continue;
                    JSONObject m;
                    try { m = PeerServer.parse(new String(p, "UTF-8")); } catch (Exception e) { continue; }
                    message(m);
                }
            } catch (Throwable e) { /* closed, or something it sent that can't be read: the link ends (never the app) */ }
            close();
        }

        private void message(JSONObject m) {
            String t = PeerServer.str(m, "t");
            if ("auth?".equals(t)) {
                challenged = true;
                // The other phone proves it holds the token this one was given when they paired (an HMAC over both
                // random numbers and the certificate seen here); only then does this phone prove the same.
                try {
                    JSONObject who = m.optJSONObject("pc");
                    String pid = who == null ? "" : PeerServer.str(who, "id");
                    String nS = PeerServer.str(m, "nonce");
                    boolean ok = token != null && !token.isEmpty() && nS.matches("[0-9a-f]{32,64}") && (expect == null || expect.equals(pid)) &&
                        PeerServer.sameHex(PeerServer.hmac(token, "flick-auth-v1|pc|" + nonceP + "|" + nS + "|" + fp + "|" + pc.host.id() + "|" + pid), PeerServer.str(m, "proof"));
                    if (!ok) { send(new JSONObject().put("t", "auth").put("proof", "none")); return; }
                    proved = true;
                    JSONObject a = new JSONObject().put("t", "auth").put("proof", PeerServer.hmac(token, "flick-auth-v1|phone|" + nonceP + "|" + nS + "|" + fp + "|" + pc.host.id() + "|" + pid));
                    // (and this phone's Bluetooth key, to the paired phone that just proved it's that one: it can tell this
                    // one's advertisements and private hello apart then, also if it never sends here itself)
                    String bk = pc.host.bleKey();
                    if (bk != null && !bk.isEmpty()) a.put("bk", bk);
                    send(a);
                } catch (Exception e) { close(); }
                return;
            }
            // (Flick there is closing: what's on its way there ends, saying so, as its link goes in a moment)
            if ("bye".equals(t)) bye = true;
            if ("saved".equals(t) || "failed".equals(t) || "asking".equals(t) || "got".equals(t) || "recv".equals(t) || "bye".equals(t)) {
                List<OnReply> rs;
                synchronized (replies) { rs = new ArrayList<OnReply>(replies); }
                for (OnReply r : rs) r.reply(m);
                return;
            }
            if ("replaced".equals(t)) { close(); return; }
            // the other phone removed this one (the computer says the same, the same way)
            if ("peer-forget".equals(t)) { if (expect != null) pc.forgot(expect, this); return; }
            if ("ack".equals(t)) {
                String mid = PeerServer.str(m, "mid");
                synchronized (acks) { if (acks.containsKey(mid)) { acks.put(mid, m); acks.notifyAll(); } }
                return;
            }
            if ("ring-found".equals(t)) { if (expect != null) pc.host.ringFound(expect); return; }
            if ("connected".equals(t) && m.has("caps")) caps = capsOf(m);
            // the card of something flicked there landed on its screen (whenever that is: during the send or after)
            if ("landed".equals(t)) {
                String tid = PeerServer.str(m, "tid");
                // (a send that went again has another id there: the page knows it by its own, also once it's over)
                String own;
                synchronized (pc.wires) { own = pc.wires.get(tid); }
                if (own != null) tid = own;
                if (expect != null && !tid.isEmpty()) pc.host.landed(expect, tid);
                return;
            }
            synchronized (inbox) { inbox.add(m); if (inbox.size() > 64) inbox.remove(0); inbox.notifyAll(); }
        }

        void close() {
            synchronized (inbox) { if (!open) return; open = false; }
            connected = false;
            // (closing the encryption can wait for a write that's stuck: on a thread of its own, and the connection under
            // it goes regardless a moment later)
            PeerServer.closeSoon(sock);
            final Socket r = raw;
            if (r != null) GUARD.schedule(new Runnable() { @Override public void run() { closeRaw(r); } }, 2, TimeUnit.SECONDS);
            synchronized (inbox) { inbox.notifyAll(); }
            synchronized (acks) { acks.notifyAll(); }
            List<OnReply> rs;
            synchronized (replies) { rs = new ArrayList<OnReply>(replies); }
            for (OnReply r2 : rs) { try { r2.reply(new JSONObject().put("t", "closed")); } catch (Exception e) { /* ignore */ } }
        }

        private static byte[] readN(InputStream in, int n) throws IOException {
            byte[] b = new byte[n];
            int at = 0;
            while (at < n) { int k = in.read(b, at, n - at); if (k < 0) throw new IOException("short"); at += k; }
            return b;
        }
    }

    // ------------------------------------------------------------ small things
    String rid(int n) { byte[] b = new byte[n]; rnd.nextBytes(b); return PeerCert.hex(b); }
    private static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; } }
    private static String clip(String s, int n) { return s == null ? "" : s.length() > n ? s.substring(0, n) : s; }
    private static String plural(int n, String one, String many) { return String.format(Locale.US, "%,d", n) + " " + (n == 1 ? one : many); }
    static String kindOf(String name) {
        String n = name.toLowerCase(Locale.US);
        int dot = n.lastIndexOf('.');
        String e = dot < 0 ? "" : n.substring(dot + 1);
        if (e.matches("jpe?g|png|gif|webp|heic|heif|bmp|avif|tiff?|dng")) return "image";
        if (e.matches("mp4|mov|m4v|webm|mkv|avi|3gp|wmv")) return "video";
        if (e.matches("mp3|m4a|aac|wav|flac|ogg|opus|wma")) return "audio";
        return "doc";
    }
    private static byte[] hexBytes(String h) {
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
    static String base64(byte[] b) {
        final String A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < b.length; i += 3) {
            int n = (b[i] & 0xff) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xff) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xff : 0);
            s.append(A.charAt(n >> 18 & 63)).append(A.charAt(n >> 12 & 63));
            s.append(i + 1 < b.length ? A.charAt(n >> 6 & 63) : '=').append(i + 2 < b.length ? A.charAt(n & 63) : '=');
        }
        return s.toString();
    }
}
