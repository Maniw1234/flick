package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;

/**
 * Taking files from other phones: this phone answers like a PC does to a phone (the PC side is pc/server.js, and its
 * "peer" parts in particular). Another phone with Flick finds it (discovery, on the same network), pairs once with the
 * 6-digit code (the user allows it here, and says the code matches there), signs in the way a phone signs in to a PC
 * (each side proves it holds the token from pairing without saying it; uploads carry it, encrypted), and sends: a file
 * (/api/upload) or many files and folders as one bundle (/api/bundle, the format of pc/bundle.js). Encrypted only (TLS
 * with this phone's own certificate, PeerCert, which the other phone pins when it pairs).
 *
 * Plain Java (no Android classes): the app's side (where files go, what the user sees) is the Host.
 */
final class PeerServer {
    static final int PROTO = 8;
    /** The animations a flicked card can arrive with (phone/app.js LOOKS, pc/overlay/looks). */
    static final java.util.List<String> LOOKS = java.util.Arrays.asList("meteor", "volt", "warp", "glitch");
    /**
     * What this phone takes over a link besides files, said in 'connected' (a device sends only what's listed: one from
     * before says nothing, and the sender says to update Flick there): look (a send's animation), clip (a clipboard),
     * link (a web address to open), ring (find this phone), ask (it may ask its user before taking files: 'asking'),
     * direct (it can open a Wi-Fi Direct network for a send that came over Bluetooth or a cable),
     * recv (it says how much of an upload has come while it comes, to a sender that asks: see recv()).
     */
    static final java.util.List<String> CAPS = java.util.Arrays.asList("look", "clip", "link", "ring", "ask", "direct", "recv");
    private static final int MAX_HEADER = 16 * 1024;
    // a signed-in device's messages: a clipboard picture is the biggest (4.4 MB of PNG, about 6 MB as text)
    private static final int MAX_WS = 7 * 1024 * 1024;
    private static final int MAX_WS_EARLY = 16 * 1024;
    private static final int MAX_CONNS = 48;
    private static final int MAX_PER_ADDR = 16;         // one device needs a few at once (its link, an upload)
    // the connections nobody signed in on, from addresses no paired device is at, all together: the other places stay
    // for the user's own devices (a stranger with several addresses, or many links, can't take them all)
    private static final int MAX_STRANGERS = 24;
    // a stranger with this many of those here, pushed out of late, makes way from its own for its next (see makeRoom)
    private static final int OWN_ROOM = 4;
    // a connection whose encryption isn't done after this long (a slow phone's takes well under it) says nothing
    private static final long QUIET_MS = 3000;
    // a holder's connections that made way for others count against it for this long (see makeRoom)
    private static final long MADE_WAY_MS = 30000;
    // an address a paired device signed in from (a request with its token, a signed-in link) is its for this long after
    // that connection ends: its next ones aren't a stranger's (as on a computer: pc/server.js TRUSTED_ADDR_MS)
    private static final long TRUSTED_ADDR_MS = 120000;
    private static final int MAX_ENTRIES = 200000;
    private static final int MAX_DEPTH = 64;
    // how long a link may take: to start (encryption and its first request), to say hello and sign in, to start
    // pairing once signed in as nobody, to reveal its half of the code, and the user's answer (the other phone waits 120 s)
    private static final long HEAD_MS = 10000, HELLO_MS = 10000, ASK_MS = 25000, REVEAL_MS = 15000, ANSWER_MS = 130000;
    // A PC allowed here gives its user 2 minutes from the Allow to say the codes match there (peerlink.js _confirmed),
    // then gives this phone its pairing ('home'): its link stays that long after the Allow, and a moment more
    private static final long HOME_MS = 125000;
    // a request that hasn't revealed its half of the code after this long gives its place to a newer one
    private static final long REPLACE_MS = 5000;
    // A pairing allowed here waits this long for the other side's user to confirm the code there ('pair-done'); how
    // long after it the other side may say how to reach it back ('peer-back'); and how recent a pairing this phone made
    // the other way must be for a request allowed here to keep its token (both ways at once: one token a way)
    private static final long PROV_MS = 150000, BACK_MS = 5 * 60000, KEEP_MS = 10 * 60000;
    // what one device may announce in a minute (it sends one thing at a time: more is a flood, not a send), and how many
    // requests from one address may hear this side's commitment to its half of a pairing code in a minute
    private static final int MAX_CARDS = 120, MAX_PEEKS = 6;

    /** The app: who this phone is, the devices it paired with, and where received files go. */
    interface Host {
        String id();
        String name();
        /** The devices allowed to send here: id -> { name, kind, token, added }. The server changes it; then saved(). */
        JSONObject allowed();
        void saved();
        /** Another device paired and said how to reach it back ('peer-back'): this phone can send to it now too. */
        void linkBack(String id, String name, String kind, String fp, String token, String addr);
        /** It removed this phone: gone both ways. */
        void unlinked(String id);
        /** again: it's paired with this phone already (allowing it replaces that pairing). */
        void pairRequest(String device, String name, String kind, String code, boolean again);
        void pairCancel(String device);
        /** A paired device signed in under a new name: it's called that here from now on. */
        void renamed(String id, String name);
        /** A paired device signed in (or was just paired) from this address: a cable's or Bluetooth's link it came over
         *  (Tunnel: each link's own 127.0.0.x) is really its. */
        void signedIn(String id, String address);
        /** This phone's Bluetooth key (base64: Peers.bleKey), for its paired phones only. */
        String bleKey();
        /** A cable's link, or one a paired phone has signed in through, at this address (Tunnel: each link's own
         *  127.0.0.x): what comes over it isn't held to the share all the other links have together. */
        boolean trustedLink(String address);
        /** Flick's Connect screen is showing here: discovery says so (the device a user holding Connect elsewhere means). */
        boolean ready();
        /** This phone's id to a PC (its PCs know it by this one: pairing with a PC asking here uses it). */
        String homeId();
        /** This phone is paired with that PC (by its id) already. */
        boolean pcPaired(String pcId);
        /**
         * A device asking where this phone is (discovery) hears it: anyone while Flick is on screen or looking for phones,
         * else a paired one.
         */
        boolean answers(String device);
        /**
         * A PC whose request to connect the user allowed here gave this phone its pairing: the token to sign in there with,
         * its certificate's SHA-256 (pinned), its port, and the addresses it has (ip: the one it asked from).
         */
        void homePaired(String pcId, String name, String token, String fp, int port, JSONArray addrs, String ip);
        /**
         * A PC's request the user allowed here ended without that pairing (its user said the codes differ there, or didn't
         * answer, or the link went): nothing more comes of it.
         */
        void homeEnded(String pcId, String name);
        /** An empty folder where tid's files are put together, on the drive they'll stay on. */
        File stage(String tid) throws IOException;
        /** Room for this many bytes. */
        boolean room(long bytes);
        /** Files are coming ('send'): what they are, from whom. */
        void incoming(String tid, String device, String from, JSONObject file);
        void progress(String tid, long got, long total);
        /** Everything is in stage (its top-level items: tops): put in place; returns what the list shows, or throws. */
        JSONArray place(String tid, String device, File stage, List<String> tops) throws IOException;
        /**
         * Its sender canceled tid once all of it was here: while this phone's user is still being asked whether to take
         * it (Ask each time), the question goes, as if they had said no (place then throws Declined "canceled"). False
         * when nobody is being asked about it (it's being saved: too late to stop), as for a host that never asks.
         */
        default boolean withdraw(String tid) { return false; }
        /** Whether this phone can send to that device (it holds a pairing for that): said to it once it signed in here,
         *  so it knows whether what it keeps for this phone is used. Null: not said. */
        default Boolean sendsTo(String device) { return null; }
        /**
         * A device this phone is paired with asked to pair again without being able to sign in (it may have lost its
         * pairing, or not be that device at all), and that ended without the user's Allow: whether the pairing with it
         * still holds is looked at (PeerClient.verifyLater).
         */
        default void doubt(String device) { }
        void failed(String tid, String why);
        /** Files are arriving (on), or stopped arriving (off): one off for each on. */
        void working(boolean on);
        /**
         * A paired device sent its clipboard ({kind:"text", text} | {kind:"image", png: base64 PNG}): onto this phone's.
         * null when it is, else why not ("off", "bad", "too big").
         */
        String clip(String device, String from, JSONObject m);
        /** A web address it sent, to open here (never opened by itself: the user taps it). null, or why not. */
        String link(String device, String from, String url);
        /** It's looking for this phone: it rings for sec seconds. null, or why not ("quiet": just found, "off"). */
        String ring(String device, String from, int sec);
        /** It found the phone (or gave up): the ringing it started stops. */
        void ringStop(String device);
        /** This phone rang it, and its user found it ('ring-found'). */
        void ringFound(String device);
        /**
         * It reached this phone over Bluetooth and has big files for it: where it reaches this phone over Wi-Fi Direct
         * (its network now: group, Flick's or ""), answered later on another thread: {ip, and ssid and pass of the network
         * to join first unless it's in it}, or why not ("busy", "perm", "wifi off", "unsupported", "failed").
         */
        void direct(String device, String group, Reply r);
        void log(String s);
    }

    /** An answer given later, from another thread (why null: done, with more). */
    interface Reply { void reply(String why, JSONObject more); }

    private final Host host;
    private final SSLContext tls;
    private final String fp;
    private final SecureRandom rnd = new SecureRandom();
    private volatile boolean running;
    private ServerSocket server;
    private DatagramSocket udp;
    int port = 0;
    private int discoveryPort = 47870;
    private final AtomicInteger conns = new AtomicInteger();
    // (a few more threads than places: one whose connection just made way for a newcomer ends a moment later)
    private final ExecutorService pool = new ThreadPoolExecutor(0, MAX_CONNS + 16, 30, TimeUnit.SECONDS, new SynchronousQueue<Runnable>());
    // the devices signed in right now (one link each), pairing requests waiting for the user, and refusals
    private final Map<String, Session> live = new HashMap<String, Session>();
    private final Map<String, Session> pending = new HashMap<String, Session>();
    private final Map<String, Long> cool = new HashMap<String, Long>();
    private final List<Long> pairTimes = new ArrayList<Long>();
    private final Map<String, List<Long>> peeks = new HashMap<String, List<Long>>();   // address -> its recent requests (see 'connect')
    private final Map<String, List<Long>> cards = new HashMap<String, List<Long>>();   // device -> when it announced lately
    private final Map<String, List<Long>> asks = new HashMap<String, List<Long>>();    // device|what -> its clipboards, links, rings lately
    private final Map<String, String> owner = bounded(512);                     // tid -> the device sending it
    private final Map<String, Told> recvTo = bounded(500);                     // tid -> its sender, that asked how much came
    private final Map<String, String> stopped = bounded(256);                   // tids canceled (nothing more comes in)
    private final Map<String, String> dropped = bounded(256);                   // ...of them, those this phone's user canceled
    private final Map<String, String> quits = bounded(256);                     // ...those whose sender's Flick was closed
    private final Set<String> placing = new HashSet<String>();                  // tids all here, being put in place
    private final Map<String, Socket> uploads = new HashMap<String, Socket>();  // tid -> its upload's connection
    // tid -> the file of its bundle being written now (for the list of what moves: "the file coming now")
    private final Map<String, String> writing = new java.util.concurrent.ConcurrentHashMap<String, String>();
    private final Map<String, Integer> perAddr = new HashMap<String, Integer>(); // address -> its connections now
    private int linked;                                                          // of them over links (under perAddr)
    // (under perAddr) the connections here now, oldest first; how many of them are strangers'; the addresses with a
    // connection a paired device signed in on (how many), and when such a connection last ended there
    private final Set<Conn> open = new LinkedHashSet<Conn>();
    private int strangers;
    private final Map<String, Integer> keptAt = new HashMap<String, Integer>();
    private final Map<String, Long> trustAt = new HashMap<String, Long>();
    // (under perAddr) holder (see holder) -> how many of its connections made way of late, and when last (see makeRoom)
    private final Map<String, long[]> madeWay = new HashMap<String, long[]>();

    /** A connection here, from address addr. */
    private static final class Conn {
        final Socket sock;
        final String addr;
        final boolean shared;                              // one of the links' share (see admit)
        boolean stranger, gone;                            // (under perAddr)
        volatile boolean secure;                           // its encryption is done (one that never says a word: not)
        final long at = mono();                            // when it came
        volatile boolean kept;                             // a paired device signed in on it
        volatile Session s;                                // its link, once it's one
        Conn(Socket sock, String addr, boolean shared, boolean stranger) { this.sock = sock; this.addr = addr; this.shared = shared; this.stranger = stranger; }
    }
    // closes a connection that hasn't got as far as its first request in time (however slowly it trickles in); one
    // for the app, and no thread while nothing is waiting
    private static final ScheduledThreadPoolExecutor guard = newGuard();

    // A sender that asked to hear how much of its upload has come ('send' with recv: 1): which device, whether it's a
    // phone, and when it was last told and how much (see recv)
    private static final class Told {
        final String device; final boolean phone;
        long at = -1000000, n;
        Told(String device, boolean phone) { this.device = device; this.phone = phone; }
    }

    private static <V> Map<String, V> bounded(final int max) {
        return new LinkedHashMap<String, V>() {
            @Override protected boolean removeEldestEntry(Map.Entry<String, V> e) { return size() > max; }
        };
    }
    private static ScheduledThreadPoolExecutor newGuard() {
        ScheduledThreadPoolExecutor g = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-peer-guard"); t.setDaemon(true); return t; }
        });
        g.setRemoveOnCancelPolicy(true);
        g.setKeepAliveTime(30, TimeUnit.SECONDS);
        g.allowCoreThreadTimeOut(true);
        return g;
    }

    PeerServer(Host host, PeerCert cert) throws Exception {
        this.host = host;
        this.tls = cert.serverContext();
        this.fp = cert.fp;
    }

    String fingerprint() { return fp; }

    // ------------------------------------------------------------ lifecycle
    /** Listens on the first free port from basePort; answers discovery on discoveryPort (0: not at all). */
    synchronized void start(int basePort, int discoveryPort) throws IOException {
        if (running) return;
        IOException last = null;
        for (int p = basePort; p < basePort + 6 && server == null; p++) {
            try {
                SSLServerSocket s = (SSLServerSocket) tls.getServerSocketFactory().createServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(p), 50);
                server = s;
                port = p;
            } catch (IOException e) { last = e; }
        }
        if (server == null) throw last != null ? last : new IOException("no free port");
        running = true;
        this.discoveryPort = discoveryPort;
        sweepProvisional();
        Thread t = new Thread(new Runnable() { @Override public void run() { acceptLoop(); } }, "flick-peer-accept");
        t.setDaemon(true);
        t.start();
        if (discoveryPort > 0) startDiscovery();
        host.log("peers: taking files on port " + port);
    }

    /**
     * Flick is closing here (not just taking no more files): every device linked here, sending or asking to pair, hears so
     * first ({t: 'bye', why: 'quit'}), and says that Flick was closed here, rather than that it couldn't reach this phone
     * (as a computer says it: pc/server.js). Waits a moment at most for them to take it (stop then closes their links).
     */
    void bye() {
        List<Session> all = new ArrayList<Session>();
        synchronized (live) { all.addAll(live.values()); for (Session s : pending.values()) if (!all.contains(s)) all.add(s); }
        List<Thread> ts = new ArrayList<Thread>();
        for (final Session s : all) {
            if (!s.open || !s.peer) continue;
            Thread t = new Thread(new Runnable() { @Override public void run() { try { s.send(new JSONObject().put("t", "bye").put("why", "quit")); } catch (Exception e) { /* gone */ } } }, "flick-peer-bye");
            t.setDaemon(true);
            t.start();
            ts.add(t);
        }
        long until = mono() + 500;
        for (Thread t : ts) { long left = until - mono(); if (left <= 0) break; try { t.join(left); } catch (InterruptedException e) { break; } }
    }

    synchronized void stop() {
        // Files coming in now stop. A phone sending them from this version on (it asked how much came) hears why first,
        // that this phone no longer takes files from other phones ("off"), not only that its connection broke. One from
        // before, and a computer, would take that word for "not saved": they're left to say they couldn't reach it.
        List<String> off = new ArrayList<String>();
        synchronized (uploads) { off.addAll(uploads.keySet()); }
        for (String tid : off) {
            Told r;
            synchronized (recvTo) { r = recvTo.get(tid); }
            if (r != null && r.phone) push(r.device, failed(tid, "off"));
        }
        running = false;
        try { if (server != null) server.close(); } catch (IOException e) { /* ignore */ }
        server = null;
        if (udp != null) udp.close();
        udp = null;
        synchronized (live) {
            for (Session s : live.values()) s.close();
            live.clear();
            for (Session s : pending.values()) s.close();
            pending.clear();
        }
        synchronized (uploads) { for (Socket s : uploads.values()) closeQuietly(s); uploads.clear(); }
    }

    boolean running() { return running; }

    /** Files are arriving (or being put in place) right now. */
    boolean busy() {
        synchronized (uploads) { if (!uploads.isEmpty()) return true; }
        synchronized (owner) { return !placing.isEmpty(); }
    }

    private void acceptLoop() {
        ServerSocket s = server;
        while (running && s != null && !s.isClosed()) {
            final Socket c;
            try { c = s.accept(); } catch (IOException e) { if (!running) return; continue; }
            final String a = c.getInetAddress() == null ? "" : c.getInetAddress().getHostAddress();
            // one address can't take every place (the others' phones still get in), nor can strangers all together
            final Conn k = admit(c, a);
            if (k == null) { closeQuietly(c); continue; }
            try {
                pool.execute(new Runnable() {
                    @Override public void run() {
                        try { serve(k); } finally { gone(k); closeQuietly(c); }
                    }
                });
            } catch (Throwable e) { gone(k); closeQuietly(c); }
        }
    }

    // a place for a connection c from address a (null: none)
    private Conn admit(Socket c, String a) {
        // (and the links not proven yet together: anyone in Bluetooth range can open links, each with an address of its
        // own, and they mustn't take the places the phones on the network need; a cable's link, and one a paired phone
        // signed in through, are as good as the network, and aren't a stranger's)
        boolean ln = overLink(a), proven = false;
        if (ln) { try { proven = host.trustedLink(a); } catch (Throwable e) { /* as one not proven */ } }
        boolean shared = ln && !proven;
        synchronized (perAddr) {
            boolean stranger = !proven && !addrTrusted(a);
            String h = !stranger ? null : shared ? "" : a;
            // an address (or the links) with every place it may have: one of its connections nobody signed in on makes
            // way, so one that keeps connecting from a device's address (behind the same router, say) can't keep the
            // device out
            Integer n = perAddr.get(a);
            if (n != null && n >= MAX_PER_ADDR && !makeRoom(h, a, false)) return null;
            if (shared && linked >= MAX_PER_ADDR && !(stranger && makeRoom(h, null, true))) return null;
            // every stranger's place taken, or every place: a stranger's connection makes way (see makeRoom), so a
            // device nobody paired with can't keep the user's own devices (or a new one) out
            if (stranger && strangers >= MAX_STRANGERS && !makeRoom(h, null, false)) return null;
            if (conns.get() >= MAX_CONNS && !makeRoom(h, null, false)) return null;
            Conn k = new Conn(c, a, shared, stranger);
            open.add(k);
            conns.incrementAndGet();
            n = perAddr.get(a);
            perAddr.put(a, n == null ? 1 : n + 1);
            if (shared) linked++;
            if (stranger) strangers++;
            return k;
        }
    }

    // (under perAddr) A paired device is signed in from address a now, or was a moment ago
    private boolean addrTrusted(String a) {
        if (keptAt.containsKey(a)) return true;
        Long at = trustAt.get(a);
        return at != null && mono() - at < TRUSTED_ADDR_MS;
    }

    // (under perAddr) A stranger's connection makes way for a new one from holder from (null: not a stranger's): one
    // nobody signed in on, not from an address a paired device is at, not a pairing request its user here is being asked
    // about. (A stranger's connection gets one request, and a link its deadlines: none is held for long anyway.) A
    // holder (an address, or the links not proven yet together) that keeps opening connections, more than there are
    // places, pushes out its own: one with several here whose connections have had to make way of late makes way from
    // those. Otherwise one that still hasn't finished its encryption goes first (quiet), then one whose holder's have
    // had to make way the most of late, the oldest there: a flood of bare connections can't push out the one or two of
    // a new phone that is pairing or signing in, nor a device's few opened at once. Only from the links, if links; only
    // from address only, if given, and there any connection nobody signed in on (one from before a paired device signed
    // in there too). Its thread ends as its socket closes.
    private boolean makeRoom(String from, String only, boolean links) {
        long now = mono();
        int mine = 0;
        if (from != null) for (Conn k : open) if (movable(k, false) && from.equals(holder(k))) mine++;
        boolean own = mine >= OWN_ROOM && made(from, now) > 0;
        Conn best = null;
        int bestN = 0;
        boolean bestQ = false;
        for (Conn k : open) {                              // oldest first
            if (only != null ? !only.equals(k.addr) || !movable(k, true) : !movable(k, false) || (links && !k.shared) || (own && !from.equals(holder(k)))) continue;
            int n = made(holder(k), now);
            boolean q = quiet(k, now);
            if (best == null || (q && !bestQ) || (q == bestQ && n > bestN)) { best = k; bestN = n; bestQ = q; }
        }
        if (best == null) return false;
        String h = holder(best);
        if (madeWay.size() >= 256 && !madeWay.containsKey(h)) {
            for (Iterator<long[]> i = madeWay.values().iterator(); i.hasNext(); ) if (now - i.next()[1] >= MADE_WAY_MS) i.remove();
        }
        if (madeWay.size() < 256 || madeWay.containsKey(h)) madeWay.put(h, new long[]{bestN + 1, now});
        gone(best);
        closeSoon(best.sock);
        return true;
    }

    // (under perAddr) how many of holder h's connections made way of late
    private int made(String h, long now) {
        long[] m = madeWay.get(h);
        return m != null && now - m[1] < MADE_WAY_MS ? (int) m[0] : 0;
    }

    private boolean movable(Conn k, boolean any) {
        if (k.kept || k.gone || (!any && (!k.stranger || addrTrusted(k.addr)))) return false;
        Session s = k.s;
        return s == null || s.pairCode == null || s.gone;
    }

    private static boolean quiet(Conn k, long now) { return !k.secure && now - k.at >= QUIET_MS; }

    // whose a stranger's connection is: its address, or the links not proven yet together (anyone in Bluetooth range
    // can open many, each with an address of its own)
    private static String holder(Conn k) { return k.shared ? "" : k.addr; }

    // a paired device signed in on connection k (a request with its token, a signed-in link): it stays as long as it's
    // used, never makes way for another, and its address isn't a stranger's
    private void keep(Conn k) {
        if (k == null || k.kept) return;
        synchronized (perAddr) {
            if (k.kept || k.gone) return;
            k.kept = true;
            if (k.stranger) { k.stranger = false; strangers--; }
            Integer n = keptAt.get(k.addr);
            keptAt.put(k.addr, n == null ? 1 : n + 1);
        }
    }

    // connection k has ended (or made way): its place is free
    private void gone(Conn k) {
        synchronized (perAddr) {
            if (k.gone) return;
            k.gone = true;
            open.remove(k);
            conns.decrementAndGet();
            Integer n = perAddr.get(k.addr);
            if (n == null || n <= 1) perAddr.remove(k.addr); else perAddr.put(k.addr, n - 1);
            if (k.shared && linked > 0) linked--;
            if (k.stranger && strangers > 0) strangers--;
            if (k.kept) {
                Integer j = keptAt.get(k.addr);
                if (j == null || j <= 1) keptAt.remove(k.addr); else keptAt.put(k.addr, j - 1);
                long now = mono();
                if (trustAt.size() >= 256 && !trustAt.containsKey(k.addr)) {
                    for (Iterator<Long> i = trustAt.values().iterator(); i.hasNext(); ) if (now - i.next() >= TRUSTED_ADDR_MS) i.remove();
                }
                trustAt.put(k.addr, now);
            }
        }
    }

    /** A connection over a cable's or Bluetooth's link (Tunnel: each link's own loopback address, never 127.0.0.1). */
    static boolean overLink(String a) { return a != null && a.startsWith("127.") && !"127.0.0.1".equals(a); }

    // ------------------------------------------------------------ discovery: other phones looking for this one
    private void startDiscovery() {
        try {
            DatagramSocket u = new DatagramSocket(null);
            u.setReuseAddress(true);
            u.bind(new InetSocketAddress(discoveryPort));
            udp = u;
        } catch (IOException e) { host.log("peers: discovery off: " + e.getMessage()); return; }
        Thread t = new Thread(new Runnable() { @Override public void run() { discoveryLoop(); } }, "flick-peer-discovery");
        t.setDaemon(true);
        t.start();
    }

    private void discoveryLoop() {
        DatagramSocket u = udp;
        byte[] buf = new byte[2048];
        while (running && u != null && !u.isClosed()) {
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try { u.receive(p); } catch (IOException e) { if (!running) return; continue; }
            try {
                JSONObject m = parse(new String(p.getData(), p.getOffset(), p.getLength(), "UTF-8"));
                // Only another device looking for phones that take files, or a PC whose user is holding Connect to reach
                // any device (any): a phone app looking for its PC (or an older one) never sees this phone, so it can't
                // take it for a PC.
                boolean any = m.optInt("any") == 1 && "pc".equals(m.optString("kind"));
                if (!"flick?".equals(m.optString("t")) || !m.optBoolean("peer", m.optInt("peer") == 1) || !("phone".equals(m.optString("kind")) || any)) continue;
                String qid = m.optString("id");
                if (qid.equals(host.id())) continue;
                // With Flick not on screen (closed and taking files in the background, or behind another app) only a device
                // paired with this phone hears it: nobody pairs then, and anyone else, on any network it's on, would learn
                // its name and id
                if (!host.answers(qid)) continue;
                JSONObject r = new JSONObject();
                r.put("t", "flick!"); r.put("v", PROTO); r.put("id", host.id()); r.put("name", host.name()); r.put("port", port);
                r.put("os", "android"); r.put("kind", "phone"); r.put("tls", 1);
                if (host.ready()) r.put("ready", 1);
                // (to a PC whose user holds Connect: who this phone is to its PCs, so one it's paired with already isn't
                // asked again)
                if (any) r.put("home", host.homeId());
                byte[] b = r.toString().getBytes("UTF-8");
                DatagramPacket a = new DatagramPacket(b, b.length, p.getAddress(), p.getPort());
                // (asked over a Wi-Fi that isn't this phone's default network, mobile data on: answered over that Wi-Fi)
                DatagramSocket via = null;
                try { DatagramSocket d = new DatagramSocket(); if (Wire.bind(d, p.getAddress().getHostAddress())) via = d; else d.close(); } catch (IOException e) { /* the usual way */ }
                if (via != null) { try { via.send(a); } finally { via.close(); } } else u.send(a);
            } catch (Throwable e) { /* not a question */ }
        }
    }

    // ------------------------------------------------------------ HTTP over the encrypted link
    private static final class Req {
        String method, path;
        final Map<String, String> q = new HashMap<String, String>();
        final Map<String, String> h = new HashMap<String, String>();
        String address;
        long length = -1;
        boolean chunked;
        Conn conn;                                         // the connection it came on
    }

    private void serve(final Conn k) {
        final Socket c = k.sock;
        // (off the guard's one thread: closing an encrypted socket can wait on the other side, and every other deadline
        // would wait behind it)
        Runnable shut = new Runnable() { @Override public void run() { closeSoon(c); } };
        ScheduledFuture<?> g = null;
        try {
            // the encryption and the request's head come in time, or the connection goes (a trickle doesn't hold it)
            g = guard.schedule(shut, HEAD_MS, TimeUnit.MILLISECONDS);
            c.setSoTimeout((int) HEAD_MS);
            SSLSocket ss = (SSLSocket) c;
            ss.startHandshake();
            k.secure = true;
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();
            while (running) {
                if (g == null) g = guard.schedule(shut, 20000, TimeUnit.MILLISECONDS);    // the next request on this link
                Req r = readHead(in);
                g.cancel(false);
                g = null;
                if (r == null) return;
                c.setSoTimeout(20000);
                r.address = c.getInetAddress() == null ? "" : c.getInetAddress().getHostAddress();
                r.conn = k;
                if ("GET".equals(r.method) && "/ws".equals(r.path)) { websocket(c, in, out, r); return; }
                boolean keep = route(c, in, out, r);
                // a connection nobody signed in on gets one request: asking again and again (a path that isn't here),
                // a stranger would hold its place for good. A paired device's goes on to the next as before.
                if (!keep || !k.kept) return;
            }
        } catch (Throwable e) {
            /* the connection ends */
        } finally {
            if (g != null) g.cancel(false);
        }
    }

    private static Req readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int last4 = 0;                                     // the last four bytes read, to find the blank line
        while (last4 != 0x0d0a0d0a) {
            int x = in.read();
            if (x < 0) { if (b.size() == 0) return null; throw new IOException("cut"); }
            b.write(x);
            if (b.size() > MAX_HEADER) throw new IOException("header too long");
            last4 = (last4 << 8) | (x & 0xff);
        }
        String[] lines = new String(b.toByteArray(), "ISO-8859-1").split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 3) throw new IOException("bad request");
        Req r = new Req();
        r.method = first[0];
        String target = first[1];
        int qi = target.indexOf('?');
        r.path = qi < 0 ? target : target.substring(0, qi);
        if (qi >= 0) {
            for (String kv : target.substring(qi + 1).split("&")) {
                if (kv.isEmpty()) continue;
                int e = kv.indexOf('=');
                String k = e < 0 ? kv : kv.substring(0, e), v = e < 0 ? "" : kv.substring(e + 1);
                try { r.q.put(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8")); } catch (IllegalArgumentException x) { /* skip */ }
            }
        }
        for (int i = 1; i < lines.length; i++) {
            int k = lines[i].indexOf(':');
            if (k > 0) r.h.put(lines[i].substring(0, k).trim().toLowerCase(Locale.US), lines[i].substring(k + 1).trim());
        }
        String cl = r.h.get("content-length");
        if (cl != null) { try { r.length = Long.parseLong(cl); } catch (NumberFormatException e) { throw new IOException("bad length"); } }
        r.chunked = r.h.containsKey("transfer-encoding") && r.h.get("transfer-encoding").toLowerCase(Locale.US).contains("chunked");
        // a length below zero, or a length and chunks both: which one counts is unclear, so neither does
        if ((cl != null && r.length < 0) || (cl != null && r.chunked)) throw new IOException("bad length");
        return r;
    }

    private static void answer(OutputStream out, int code, JSONObject body, boolean close) throws IOException {
        byte[] b = body.toString().getBytes("UTF-8");
        String status = code == 200 ? "OK" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 507 ? "Insufficient Storage" : code == 400 ? "Bad Request" : code == 410 ? "Gone"
            : code == 409 ? "Conflict" : code == 411 ? "Length Required" : code == 429 ? "Too Many Requests" : "Error";
        String head = "HTTP/1.1 " + code + " " + status + "\r\nContent-Type: application/json\r\nContent-Length: " + b.length + "\r\n" +
            (close ? "Connection: close\r\n" : "") + "\r\n";
        out.write(head.getBytes("ISO-8859-1"));
        out.write(b);
        out.flush();
    }
    private static JSONObject ok() { try { return new JSONObject().put("ok", true); } catch (Exception e) { return new JSONObject(); } }
    private static JSONObject err(String why) { try { return new JSONObject().put("ok", false).put("error", why); } catch (Exception e) { return new JSONObject(); } }

    /** Returns whether the connection can take another request. */
    private boolean route(Socket c, InputStream in, OutputStream out, Req r) throws Exception {
        // who this phone is, to anyone asking (no pairing needed): only while its discovery answers anyone (Flick on screen,
        // or looking for phones); else nothing, as for a path that isn't here (its name and id would follow it about)
        if ("GET".equals(r.method) && "/api/hello".equals(r.path)) {
            boolean say = answersAnyone();
            JSONObject o = new JSONObject();
            if (say) { o.put("app", "flick"); o.put("v", PROTO); o.put("id", host.id()); o.put("name", host.name()); o.put("port", port); o.put("tls", 1); o.put("kind", "phone"); }
            // (and the connection ends: asked again and again, it would hold a place here for good)
            answer(out, say ? 200 : 404, say ? o : err("not here"), true);
            return false;
        }
        boolean up = "POST".equals(r.method) && ("/api/upload".equals(r.path) || "/api/bundle".equals(r.path));
        if (!up) {
            // anything else: not here (a request with a body isn't read: its link closes; and one nobody signed in on
            // closes too, see serve)
            boolean stay = !r.chunked && r.length <= 0 && r.conn != null && r.conn.kept;
            answer(out, 404, err("not here"), !stay);
            return stay;
        }
        String device = r.q.get("device");
        if (!trusted(device, r.q.get("token"))) { answer(out, 403, err("not paired"), true); return false; }
        keep(r.conn);
        boolean single = "/api/upload".equals(r.path);
        // A file comes with its length, a bundle says how much it holds ("bytes"): the room for it is checked for that
        // much, and nothing past it is taken.
        if (single ? r.length < 0 : !r.chunked && r.length < 0) { answer(out, 411, err("length required"), true); return false; }
        String tid = clean(r.q.get("tid"), 40);
        if (tid.isEmpty()) tid = rid(6);
        long total = single ? r.length : parseLong(r.q.get("bytes"));
        // A transfer is its sender's (another device can't send into it), comes in once at a time, and not after it was
        // canceled. One it didn't announce first ('send') counts toward what it may announce in a minute: each makes a
        // card here too.
        String took;
        boolean announced;
        synchronized (owner) {
            String who = owner.get(tid);
            announced = device.equals(who);
            took = who != null && !who.equals(device) ? "not yours" : stopped.containsKey(tid) ? "canceled" : null;
        }
        if (took == null && !announced && !card(device)) took = "busy";
        if (took == null) synchronized (owner) {
            String who = owner.get(tid);
            // (and not canceled meanwhile: its sender's Cancel can come between the two looks)
            if (who != null && !who.equals(device)) took = "not yours"; else if (stopped.containsKey(tid)) took = "canceled"; else owner.put(tid, device);
        }
        if (took == null) synchronized (uploads) { if (uploads.containsKey(tid)) took = "already coming"; else uploads.put(tid, c); }
        if (took != null) {
            if ("busy".equals(took)) push(device, failed(tid, "busy"));
            JSONObject e = err(took);
            // (its user here canceled it: the sender says so, not that it wasn't accepted)
            boolean here;
            synchronized (owner) { here = dropped.containsKey(tid); }
            if ("canceled".equals(took) && here) e.put("canceled", true);
            answer(out, "canceled".equals(took) ? 410 : "busy".equals(took) ? 429 : 409, e, true);
            return false;
        }
        if (!host.room(total)) {
            synchronized (uploads) { if (uploads.get(tid) == c) uploads.remove(tid); }
            synchronized (owner) { owner.remove(tid); }
            host.failed(tid, "no space");
            // (the other device is still writing when this answer comes, and would only see the connection end: it's
            // told why over its link too)
            push(device, failed(tid, "space"));
            answer(out, 507, err("no space"), true);
            return false;
        }
        File stage = null;
        boolean answered = false;
        host.working(true);
        try {
            stage = host.stage(tid);
            InputStream body = r.chunked ? new Chunked(in) : new Limited(in, r.length);
            List<String> tops = new ArrayList<String>();
            if (single) {
                String name = safeSegment(r.q.containsKey("name") ? r.q.get("name") : "file");
                long got = copy(body, new File(stage, name), total, tid);
                if (got < total) throw new IOException("short");
                tops.add(name);
            } else {
                readBundle(body, stage, tops, total, tid);
            }
            // Everything is here: the sender hears so now (putting it in place can take a while: a big folder copied into
            // shared storage), and from here on it can't be stopped (a cancel now would only lose what's being saved);
            // 'saved' (or 'failed') follows over its link. (Stopped just before, by either side: it isn't kept.)
            synchronized (owner) { if (stopped.containsKey(tid)) throw new IOException("stopped"); placing.add(tid); }
            try { answer(out, 200, ok().put("tid", tid), false); } catch (IOException e) { /* its link hears the rest */ }
            answered = true;
            // (and over its link: that answer is lost when the connection breaks right then, and the sender then knows
            // within seconds whether all of it came)
            push(device, new JSONObject().put("t", "got").put("tid", tid));
            JSONArray items = host.place(tid, device, stage, tops);
            stage = null;                                   // in place now (the host took it)
            JSONObject saved = new JSONObject();
            saved.put("t", "saved"); saved.put("tid", tid);
            saved.put("name", tops.size() == 1 ? tops.get(0) : tops.size() + " items");
            saved.put("where", "Downloads"); saved.put("items", items == null ? 0 : items.length());
            push(device, saved);
            return true;
        } catch (Throwable e) {
            if (e instanceof Declined) {
                // its user here said no (or didn't answer): what came goes, and the sender hears why
                String why = ((Declined) e).why;
                if (stage != null) { deleteTree(stage); stage = null; }
                host.failed(tid, why);
                push(device, failed(tid, why));
                return answered;
            }
            host.log("peers: receiving failed: " + e);
            boolean space = e instanceof IOException && isSpace((IOException) e), quit;
            synchronized (owner) { quit = stopped.containsKey(tid); }
            // (its sender's Cancel closes the upload and then says so over its link, which can come a moment later:
            // stopped there, not "not received")
            for (int i = 0; i < 10 && !quit && !space && !answered; i++) {
                try { Thread.sleep(50); } catch (InterruptedException x) { break; }
                synchronized (owner) { quit = stopped.containsKey(tid); }
            }
            // what arrived of it goes before anyone hears it failed (thousands of files take a moment)
            if (stage != null) { deleteTree(stage); stage = null; }
            boolean closed;
            synchronized (owner) { closed = quits.containsKey(tid); }
            host.failed(tid, quit ? (closed ? "quit" : "canceled") : space ? "no space" : "not received");
            // The sender hears why over its link (unless it stopped it itself): once it was told all of it is here (it
            // waits for 'saved'), and before (it may still be writing, and would only see the connection end). The
            // answer says nothing about this phone's folders.
            if (!quit) push(device, failed(tid, space ? "space" : answered ? "save" : "upload"));
            if (answered) return true;
            try { answer(out, space ? 507 : 400, err(space ? "no space" : "not received"), true); } catch (Throwable x) { /* gone */ }
            return false;
        } finally {
            synchronized (uploads) { if (uploads.get(tid) == c) uploads.remove(tid); }
            synchronized (owner) { owner.remove(tid); placing.remove(tid); }
            writing.remove(tid);
            synchronized (recvTo) { recvTo.remove(tid); }
            if (stage != null) deleteTree(stage);
            host.working(false);
        }
    }

    private static boolean isSpace(IOException e) { String m = String.valueOf(e.getMessage()); return m.contains("ENOSPC") || m.contains("No space"); }

    // how far tid's files have come: for the user here (Host.progress), and its sender if it asked (recv)
    private void progress(String tid, long got, long total) {
        host.progress(tid, got, total);
        recv(tid, got);
    }

    /**
     * How much of tid's upload has come, said to its sender over its link while it comes, when it asked ('send' with
     * recv: 1): over a slow link its network holds megabytes on their way, and it goes by this, not by what it put into
     * its connection, for its progress and for how long it waits (PeerClient.post). Four times a second, and for each
     * megabyte that comes (as often as progress is noted), so its progress keeps up on a fast link too (as a computer
     * says it: pc/server.js).
     */
    private void recv(String tid, long got) {
        String device;
        synchronized (recvTo) {
            Told r = recvTo.get(tid);
            if (r == null) return;
            long now = mono();
            if (now - r.at < 250 && got - r.n < 1024 * 1024) return;
            r.at = now; r.n = got;
            device = r.device;
        }
        try { push(device, new JSONObject().put("t", "recv").put("tid", tid).put("bytes", got)); } catch (Exception e) { /* it goes by its own count */ }
    }

    private boolean answersAnyone() { try { return host.answers(""); } catch (Throwable e) { return false; } }

    private long copy(InputStream in, File f, long total, String tid) throws IOException {
        OutputStream o = new BufferedOutputStream(new FileOutputStream(f), 256 * 1024);
        long got = 0, last = 0;
        try {
            byte[] buf = new byte[128 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                o.write(buf, 0, n);
                got += n;
                long now = mono();
                if (now - last > 120) { last = now; progress(tid, got, total); }
            }
        } finally { o.close(); }
        host.progress(tid, got, total);
        return got;
    }

    // a Flick bundle (pc/bundle.js, Bundle.java): every path rebuilt segment by segment, so nothing lands outside stage
    private void readBundle(InputStream in, File stage, List<String> tops, long total, String tid) throws IOException {
        byte[] magic = readN(in, 6);
        if (!"FLKB1\n".equals(new String(magic, "ISO-8859-1"))) throw new IOException("bad bundle");
        // the manifest: not needed here (the totals are known from the request), so not even read as JSON
        int ml = readU32(in);
        if (ml < 0 || ml > 8 * 1024 * 1024) throw new IOException("bad bundle");
        skipN(in, ml);
        Set<String> topSet = new HashSet<String>();
        // Names are case-insensitive on a phone's shared storage: what's staged, lower-cased, so no two files share a name,
        // folders that differ only in case are one, and a folder never takes a file's name, nor a file a folder's
        // ("Notes" then "notes/": the folder couldn't be made there, and every file after it would fail)
        Set<String> taken = new HashSet<String>();                      // files staged
        Map<String, String> dirAs = new HashMap<String, String>();      // a folder asked for (lower-cased) -> as staged
        Set<String> dirKeys = new HashSet<String>();                    // folders staged (lower-cased)
        long got = 0, last = 0;
        int count = 0;
        // one buffer for all its files (one each made a bundle of a thousand small files cost hundreds of megabytes to
        // clear away), filled before each write: a file still goes to storage in a few large writes
        byte[] buf = new byte[128 * 1024];
        while (true) {
            int len = readU32(in);
            if (len == 0) break;
            if (len < 0 || len > 256 * 1024) throw new IOException("bad entry");
            JSONObject e;
            try { e = parse(new String(readN(in, len), "UTF-8")); } catch (Exception x) { throw new IOException("bad entry"); }
            if (++count > MAX_ENTRIES) throw new IOException("too many entries");
            String[] segs = str(e, "p").split("[\\\\/]+");
            List<String> safe = new ArrayList<String>();
            for (String s : segs) if (!s.isEmpty() && safe.add(s) && safe.size() > MAX_DEPTH) throw new IOException("bad path");
            if (safe.isEmpty()) throw new IOException("bad path");
            for (int i = 0; i < safe.size(); i++) safe.set(i, safeSegment(safe.get(i)));
            boolean dir = e.optInt("d") == 1;
            List<String> at = dirSegs(dir ? safe : safe.subList(0, safe.size() - 1), dirAs, dirKeys, taken);
            File parent = stage;
            for (String s : at) parent = new File(parent, s);
            if (dir) {
                parent.mkdirs();
                if (topSet.add(at.get(0))) tops.add(at.get(0));
                continue;
            }
            long size = e.optLong("s", -1);
            if (size < 0) throw new IOException("bad entry");
            // (nothing past what it said it holds: the room for it was checked for that much)
            if (size > total - got) throw new IOException("more than it said");
            // two names that become the same one here ("a:b" and "a_b", "IMG.jpg" and "img.JPG"): the second file gets
            // " (2)", not the first's place. Each file is made new, never opened over another: a name this phone's
            // storage takes as one already here (a letter's case, an accent written another way) gets the next number.
            String leaf = safe.get(safe.size() - 1), pre = join(at), name = leaf;
            int k = 1;
            while ((taken.contains(key(pre + name)) || dirKeys.contains(key(pre + name))) && k < 10000) name = numbered(leaf, ++k);
            parent.mkdirs();
            File f = new File(parent, name);
            writing.put(tid, leaf);
            while (!f.createNewFile()) {
                if (++k >= 10000) throw new IOException("bad entry");
                name = numbered(leaf, k);
                f = new File(parent, name);
            }
            taken.add(key(pre + name));
            at.add(name);
            if (topSet.add(at.get(0))) tops.add(at.get(0));
            OutputStream o = new FileOutputStream(f);
            try {
                long left = size;
                while (left > 0) {
                    int want = (int) Math.min(buf.length, left), n = 0;
                    while (n < want) {
                        int r = in.read(buf, n, want - n);
                        if (r < 0) throw new IOException("short");
                        n += r; got += r;
                        // (what came, as it comes: a slow link's progress moves on before the buffer is full)
                        long now = mono();
                        if (now - last > 120) { last = now; progress(tid, got, total); }
                    }
                    o.write(buf, 0, n);
                    left -= n;
                }
            } finally { o.close(); }
            long m = e.optLong("m", 0);
            if (m > 0) f.setLastModified(m);
        }
        host.progress(tid, got, total);
    }

    private static void skipN(InputStream in, int n) throws IOException {
        byte[] b = new byte[Math.min(n, 64 * 1024)];
        while (n > 0) { int k = in.read(b, 0, Math.min(b.length, n)); if (k < 0) throw new IOException("short"); n -= k; }
    }
    // the staged folders for these asked-for ones: one folder for names that differ only in case, and a numbered one
    // ("Notes (2)") where a file was staged under that name before (pc/bundle.js _dirSegs)
    private static List<String> dirSegs(List<String> segs, Map<String, String> dirAs, Set<String> dirKeys, Set<String> taken) {
        String staged = "", want = "";
        for (String seg : segs) {
            want = want + "/" + key(seg);
            String got = dirAs.get(want);
            if (got == null) {
                String name = seg;
                for (int n = 2; taken.contains(key(staged + "/" + name)) && n < 10000; n++) name = seg + " (" + n + ")";
                got = staged + "/" + name;
                dirAs.put(want, got);
                dirKeys.add(key(got));
            }
            staged = got;
        }
        List<String> out = new ArrayList<String>();
        for (String x : staged.split("/")) if (!x.isEmpty()) out.add(x);
        return out;
    }
    private static String join(List<String> segs) { StringBuilder b = new StringBuilder(); for (String x : segs) b.append('/').append(x); return b.append('/').toString(); }
    // a name as the phone's shared storage compares them: letters in any case, accents however they're written
    private static String key(String s) { return Normalizer.normalize(s, Normalizer.Form.NFC).toLowerCase(Locale.ROOT); }
    /** "photo.jpg", 2 -> "photo (2).jpg" */
    static String numbered(String name, int n) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")";
    }

    /**
     * JSON from the network. The parser recurses into every bracket, and reads more than JSON (comments, 'single quotes',
     * bare words), so brackets can hide from a scan that only knows "strings": a message of thousands of them would
     * overflow the thread's stack. So it's given only plain JSON, as every Flick device writes it, nested no deeper than
     * anything Flick sends; and an overflow all the same is a message that can't be read, never an Error.
     */
    static JSONObject parse(String s) throws Exception {
        if (tooDeep(s, 32)) throw new IOException("not a message");
        try { return new JSONObject(s); } catch (StackOverflowError e) { throw new IOException("nested too deep"); }
    }

    /** Whether s is anything but plain JSON (RFC 8259: no comments, single quotes or bare words) nested at most max deep. */
    static boolean tooDeep(String s, int max) {
        int depth = 0, n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            switch (c) {
                case ' ': case '\t': case '\n': case '\r': case ',': case ':': break;
                case '{': case '[': if (++depth > max) return true; break;
                case '}': case ']': if (--depth < 0) return true; break;
                case '"':
                    for (i++; ; i++) {
                        if (i >= n) return true;
                        char x = s.charAt(i);
                        if (x == '"') break;
                        if (x != '\\') continue;
                        if (++i >= n) return true;
                        char e = s.charAt(i);
                        if (e == 'u') {
                            if (i + 4 >= n) return true;
                            for (int k = 1; k <= 4; k++) if (!hex(s.charAt(i + k))) return true;
                            i += 4;
                        } else if ("\"\\/bfnrt".indexOf(e) < 0) return true;
                    }
                    break;
                case 't': if (!s.startsWith("true", i)) return true; i += 3; break;
                case 'f': if (!s.startsWith("false", i)) return true; i += 4; break;
                case 'n': if (!s.startsWith("null", i)) return true; i += 3; break;
                default:
                    if ((c < '0' || c > '9') && c != '-' && c != '+' && c != '.' && c != 'e' && c != 'E') return true;
            }
        }
        return depth != 0;
    }
    private static boolean hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

    /** A text value (a JSON null, number or object isn't one: Android's optString would make "null" of a null). */
    static String str(JSONObject m, String key) {
        Object v = m == null ? null : m.opt(key);
        return v instanceof String ? (String) v : "";
    }
    private static int readU32(InputStream in) throws IOException {
        byte[] b = readN(in, 4);
        long v = ((b[0] & 0xffL) << 24) | ((b[1] & 0xffL) << 16) | ((b[2] & 0xffL) << 8) | (b[3] & 0xffL);
        return v > Integer.MAX_VALUE ? -1 : (int) v;
    }
    // n bytes, held as they come: a frame says how long it is before any of it comes, and nothing is set aside for a
    // length that never arrives (a big one is read 64 KB at a time)
    private static byte[] readGrow(InputStream in, int n) throws IOException {
        if (n <= 65536) return readN(in, n);
        ByteArrayOutputStream b = new ByteArrayOutputStream(65536);
        byte[] buf = new byte[65536];
        int left = n;
        while (left > 0) { int k = in.read(buf, 0, Math.min(buf.length, left)); if (k < 0) throw new IOException("short"); b.write(buf, 0, k); left -= k; }
        return b.toByteArray();
    }
    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int at = 0;
        while (at < n) { int k = in.read(b, at, n - at); if (k < 0) throw new IOException("short"); at += k; }
        return b;
    }

    /**
     * A name that can be a file's on any phone (and any computer it goes to next): no separators, nothing hidden or
     * special, at most 150 characters and 230 bytes (a phone's names are at most 255 bytes: 100 Chinese characters are
     * 300), shortened by whole characters with its extension kept (pc/bundle.js safeSegment). Any name costs the same
     * little time: it's cut to 1,000 characters before anything else.
     */
    static String safeSegment(String n) {
        String s = String.valueOf(n);
        if (s.length() > 1000) s = s.substring(0, Character.isHighSurrogate(s.charAt(999)) ? 999 : 1000);
        s = stripEnd(s.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "_").trim());
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "_";
        if (s.startsWith(".")) s = "_" + s.substring(1);
        if (s.length() > 150 || utf8(s) > 230) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 ? s.substring(dot) : "";
            if (ext.codePointCount(0, ext.length()) > 20) ext = ext.substring(0, ext.offsetByCodePoints(0, 20));
            int chars = ext.length(), bytes = utf8(ext);
            StringBuilder keep = new StringBuilder();
            String base = dot > 0 ? s.substring(0, dot) : s;
            for (int i = 0; i < base.length(); ) {
                int cp = base.codePointAt(i), w = Character.charCount(cp), b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
                if (chars + w > 150 || bytes + b > 230) break;
                keep.appendCodePoint(cp); chars += w; bytes += b; i += w;
            }
            s = stripEnd(keep.toString() + ext);
            if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "_";
        }
        return s;
    }
    // without the dots and white space at its end (Windows can't keep them there)
    private static String stripEnd(String s) {
        int i = s.length();
        while (i > 0) {
            char c = s.charAt(i - 1);
            if (c == '.' || Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\ufeff') i--; else break;
        }
        return i == s.length() ? s : s.substring(0, i);
    }
    private static int utf8(String s) {
        int b = 0;
        for (int i = 0; i < s.length(); ) { int cp = s.codePointAt(i); b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; i += Character.charCount(cp); }
        return b;
    }

    // ------------------------------------------------------------ the request body: by length, or chunked
    private static final class Limited extends InputStream {
        private final InputStream in; private long left;
        Limited(InputStream in, long n) { this.in = in; this.left = n; }
        @Override public int read() throws IOException { byte[] b = new byte[1]; int n = read(b, 0, 1); return n <= 0 ? -1 : b[0] & 0xff; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }
    private static final class Chunked extends InputStream {
        private final InputStream in; private long left = 0; private boolean done;
        Chunked(InputStream in) { this.in = in; }
        private String line() throws IOException {
            StringBuilder s = new StringBuilder();
            int x;
            while ((x = in.read()) >= 0) { if (x == '\n') break; if (x != '\r') s.append((char) x); if (s.length() > 64) throw new IOException("bad chunk"); }
            if (x < 0) throw new IOException("short");
            return s.toString();
        }
        @Override public int read() throws IOException { byte[] b = new byte[1]; int n = read(b, 0, 1); return n <= 0 ? -1 : b[0] & 0xff; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (done) return -1;
            if (left == 0) {
                String l = line();
                if (l.isEmpty()) l = line();                 // the CRLF after the previous chunk
                int semi = l.indexOf(';');
                try { left = Long.parseLong((semi < 0 ? l : l.substring(0, semi)).trim(), 16); } catch (NumberFormatException e) { throw new IOException("bad chunk"); }
                if (left == 0) { line(); done = true; return -1; }
            }
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n < 0) throw new IOException("short");
            left -= n;
            return n;
        }
    }

    // ------------------------------------------------------------ the WebSocket: signing in, pairing, what's coming
    final class Session {
        final Socket sock;
        final OutputStream out;
        final String address;
        String device = "", name = "Phone", kind = "phone";
        String nonceP, nonceS, pairCommit, pairNonceS, pairCode;
        boolean helloed, peer, authWait, named, pairAsked;
        // (also set by other threads: the user's Allow or Remove, a write that timed out)
        volatile boolean trusted, connected, open = true;
        boolean doubt;                                     // it said it's a paired device, and couldn't sign in as it
        // home: a PC asking to become this phone's PC (its user held Connect there); homeDone: it gave this phone its pairing
        boolean home;
        volatile boolean homeDone;
        volatile boolean gone;                             // removed here: nothing it says counts any more
        final long opened = mono();
        long pairAt;                                       // when it asked to pair, then when it revealed its half
        volatile long approved;                            // when the user here allowed its request (this link's)
        String granted;                                    // the token it was given then
        String signedWith;                                 // the pairing's token it signed in with
        ScheduledFuture<?> provT;                          // drops that pairing if its user never confirms the code
        ScheduledFuture<?> homeT;                          // a PC allowed here: its link goes when its time is up
        Session(Socket s, OutputStream o, String a) { sock = s; out = o; address = a; }
        void send(JSONObject m) {
            if (!open) return;
            try { write(0x1, m.toString().getBytes("UTF-8")); } catch (Exception e) { close(); }
        }
        /** A frame to it. One that can't go out within 10 s (the other side doesn't read, its buffers full) closes the
         *  link rather than hold whoever is writing (a pong, the user's answer to a pairing request) for ever. */
        void write(int op, byte[] p) throws IOException {
            synchronized (out) {
                ScheduledFuture<?> g = guard.schedule(new Runnable() { @Override public void run() { open = false; closeSoon(sock); } }, 10, TimeUnit.SECONDS);
                try { out.write(frameHead(op, p.length)); out.write(p); out.flush(); } finally { g.cancel(false); }
            }
        }
        void close() { open = false; closeQuietly(sock); }
    }

    /** Closes s on a thread of its own (closing an encrypted socket can itself wait on the other side). */
    static void closeSoon(final Socket s) {
        Thread t = new Thread(new Runnable() { @Override public void run() { closeQuietly(s); } }, "flick-peer-close");
        t.setDaemon(true);
        t.start();
    }

    private static byte[] frameHead(int op, int n) {
        if (n < 126) return new byte[]{(byte) (0x80 | op), (byte) n};
        if (n < 65536) return new byte[]{(byte) (0x80 | op), 126, (byte) (n >> 8), (byte) n};
        byte[] b = new byte[10];
        b[0] = (byte) (0x80 | op); b[1] = 127;
        long v = n;
        for (int i = 9; i >= 2; i--) { b[i] = (byte) v; v >>= 8; }
        return b;
    }

    private void websocket(Socket c, InputStream in, OutputStream out, Req r) throws Exception {
        String key = r.h.get("sec-websocket-key");
        if (key == null || !"websocket".equalsIgnoreCase(r.h.get("upgrade"))) { answer(out, 400, err("not a websocket"), true); return; }
        String acc = android64(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("ISO-8859-1")));
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n").getBytes("ISO-8859-1"));
        out.flush();
        final Session s = new Session(c, out, r.address);
        if (r.conn != null) r.conn.s = s;
        c.setSoTimeout((int) HELLO_MS);     // until it has said hello and signed in; then 35 s (the other side pings every 15 s)
        // (and, until it's trusted, no read goes on past the time it's due: see DueIn)
        final DueIn din = new DueIn(c, in, s, (int) HELLO_MS);
        in = din;
        boolean settled = false;
        try {
            ByteArrayOutputStream frag = null;
            while (running && s.open) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = in.read();
                if (b1 < 0) break;
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0f;
                if ((b0 & 0x70) != 0 || (b1 & 0x80) == 0) break;          // reserved bits, or a client frame unmasked
                long len = b1 & 0x7f;
                if (len == 126) { byte[] x = readN(in, 2); len = ((x[0] & 0xff) << 8) | (x[1] & 0xff); }
                else if (len == 127) { byte[] x = readN(in, 8); len = 0; for (byte y : x) len = (len << 8) | (y & 0xff); }
                // (before a device has signed in, what it says is small: hello, its sign-in, a pairing request)
                int max = s.trusted ? MAX_WS : MAX_WS_EARLY;
                if (len < 0 || len > max) break;
                // a control frame (close, ping, pong) is whole and small (RFC 6455 5.5)
                if (op >= 0x8 && (!fin || len > 125)) break;
                byte[] mask = readN(in, 4);
                byte[] p = readGrow(in, (int) len);
                for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
                // every frame (pings too): a link that is late signing in, or pairing, goes
                if (overdue(s, mono())) break;
                if (op == 0x8) break;
                if (op == 0x9) { s.write(0xA, p); continue; }
                if (op == 0xA) continue;
                if (op == 0x1 || op == 0x2) {
                    if (!fin) { frag = new ByteArrayOutputStream(); frag.write(p); continue; }
                } else if (op == 0x0 && frag != null) {
                    frag.write(p);
                    if (frag.size() > max) break;
                    if (!fin) continue;
                    p = frag.toByteArray(); frag = null;
                } else break;
                JSONObject m;
                try { m = parse(new String(p, "UTF-8")); } catch (Exception e) { continue; }
                onMessage(s, m);
                if (s.trusted) keep(r.conn);
                if (!settled && s.open && s.helloed && !s.authWait) { settled = true; din.base = 35000; }
            }
        } catch (SocketTimeoutException e) {
            /* silent for too long */
        } finally {
            s.close();
            onClosed(s);
        }
    }

    /** A link that hasn't done its part in time: signing in, asking to pair (signed in as nobody), revealing its half of
     *  the code, or the user's answer. A paired device's link stays. */
    private static boolean overdue(Session s, long now) {
        long d = due(s);
        return d != 0 && now > d;
    }

    /** When a link that hasn't done its part becomes overdue (see overdue()); 0: never (a paired device's link). */
    private static long due(Session s) {
        if (s.trusted) return 0;
        if (!s.helloed || s.authWait) return s.opened + HELLO_MS;
        if (s.pairCommit == null) return s.opened + ASK_MS;
        if (s.pairCode == null) return s.pairAt + REVEAL_MS;
        if (s.home && s.approved > 0) return homeDue(s);
        return s.pairAt + ANSWER_MS;
    }

    /**
     * A link's input, read so that until the link is trusted no read goes on past the time it's due (overdue() was
     * looked at only between frames: a stranger sending its first frame a byte every few seconds held its place here,
     * and a thread, for hours, and a few such held all of them). A read that waited until then while that time moved on
     * (the user here allowed it meanwhile) is tried again. The socket's own timeout (base) still applies to each read.
     */
    private static final class DueIn extends java.io.FilterInputStream {
        private final Socket sock;
        private final Session s;
        volatile int base;
        private int cur = -1;
        private long armedDue;
        private boolean byDue;
        DueIn(Socket sock, InputStream in, Session s, int base) { super(in); this.sock = sock; this.s = s; this.base = base; }
        private void arm() throws IOException {
            long d = due(s);
            armedDue = d;
            int t = base;
            byDue = false;
            if (d != 0) {
                long left = d - mono();
                if (left <= 0) throw new SocketTimeoutException("overdue");
                if (left < t) { t = (int) Math.max(1, left); byDue = true; }
            }
            if (t != cur) { sock.setSoTimeout(t); cur = t; }    // (a trusted link's reads change nothing here)
        }
        private boolean again() { if (!byDue) return false; long d = due(s); return d == 0 || d > armedDue; }
        @Override public int read() throws IOException {
            for (;;) { arm(); try { return in.read(); } catch (SocketTimeoutException e) { if (!again()) throw e; } }
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            for (;;) { arm(); try { return in.read(b, off, len); } catch (SocketTimeoutException e) { if (!again()) throw e; } }
        }
    }

    /**
     * When a PC allowed here must have given this phone its pairing: the time its request had, or 2 minutes after the
     * Allow if that's later (its user, asked only once the Allow came, gets the whole of them however late it came).
     */
    private static long homeDue(Session s) { return Math.max(s.pairAt + ANSWER_MS, s.approved + HOME_MS); }

    private void onClosed(Session s) {
        boolean wasPending = false;
        synchronized (live) {
            if (live.get(s.device) == s) live.remove(s.device);
            if (pending.get(s.device) == s) { pending.remove(s.device); wasPending = true; }
        }
        if (wasPending) host.pairCancel(s.device);
        // (it asked again as a paired device that couldn't sign in, and went without the user's answer)
        if (wasPending && s.doubt) host.doubt(s.device);
        // a pairing allowed on this link whose other side never confirmed the code goes with it
        if (s.approved > 0) dropProvisional(s);
        // a PC allowed here that never gave this phone its pairing ('home'): the page stops waiting for it
        if (s.homeT != null) s.homeT.cancel(false);
        if (s.home && s.approved > 0 && !s.homeDone) host.homeEnded(s.device, s.name);
    }

    /** The pairing allowed on s, if its other side still hasn't confirmed the code: gone, so nothing here says it can
     *  send files here when it can't. */
    private void dropProvisional(Session s) {
        if (s.provT != null) s.provT.cancel(false);
        boolean drop;
        synchronized (host) {
            JSONObject a = host.allowed();
            JSONObject d = a == null ? null : a.optJSONObject(s.device);
            drop = d != null && d.has("prov") && s.granted != null && s.granted.equals(d.optString("token"));
        }
        if (drop) {
            host.log("peers: " + s.name + " didn't confirm the pairing");
            forget(s.device);
            // (it asked again as a paired device that couldn't sign in: what this phone keeps to send to it may be of no
            // use there now either)
            if (s.doubt) host.doubt(s.device);
        }
    }

    /**
     * A pairing allowed here whose other side hadn't confirmed the code when Flick was stopped (or its receiver was):
     * the link it was allowed on is gone, so nothing confirms it any more, and it goes as it does when that link closes
     * (dropProvisional), instead of staying for good as a device that may send here. No link is open yet when this runs.
     */
    private void sweepProvisional() {
        try {
            synchronized (host) {
                JSONObject a = host.allowed();
                if (a == null) return;
                List<String> old = new ArrayList<String>();
                for (Iterator<String> it = a.keys(); it.hasNext(); ) {
                    String k = it.next();
                    JSONObject d = a.optJSONObject(k);
                    if (d != null && d.has("prov")) old.add(k);
                }
                for (String k : old) a.remove(k);
                if (!old.isEmpty()) { host.log("peers: " + old.size() + " unconfirmed pairing(s) dropped"); host.saved(); }
            }
        } catch (Throwable e) { /* as they were */ }
    }

    /** Whether device's pairing here is (still) the one given token. */
    private boolean holds(String device, String token) {
        synchronized (host) {
            JSONObject a = host.allowed();
            JSONObject d = a == null ? null : a.optJSONObject(device);
            return d != null && token != null && token.equals(d.optString("token"));
        }
    }

    /** The pairing allowed on s is confirmed on the other side too: it stays. */
    private void confirmed(Session s) {
        if (s.provT != null) s.provT.cancel(false);
        synchronized (host) {
            JSONObject a = host.allowed();
            JSONObject d = a == null ? null : a.optJSONObject(s.device);
            if (d != null && d.has("prov") && s.granted != null && s.granted.equals(d.optString("token"))) { d.remove("prov"); host.saved(); }
        }
    }

    private JSONObject allowedRecord(String device) {
        if (device == null || device.isEmpty()) return null;
        synchronized (host) {
            JSONObject a = host.allowed();
            return a == null ? null : a.optJSONObject(device);
        }
    }

    private boolean trusted(String device, String token) {
        JSONObject d = allowedRecord(device);
        if (d == null || token == null || token.isEmpty()) return false;
        return MessageDigest.isEqual(token.getBytes(), d.optString("token").getBytes()) && d.optString("token").length() > 0;
    }

    private String proof(String token, String role, Session s) throws Exception {
        return hmac(token, "flick-auth-v1|" + role + "|" + s.nonceP + "|" + s.nonceS + "|" + fp + "|" + s.device + "|" + host.id());
    }

    private void onMessage(Session s, JSONObject m) throws Exception {
        if (s.gone) return;
        String t = str(m, "t");
        if ("ping".equals(t)) {
            JSONObject p = new JSONObject().put("t", "pong");
            if (m.opt("ts") instanceof Number) p.put("ts", m.opt("ts"));
            s.send(p);
            return;
        }
        if ("hello".equals(t)) {
            if (s.helloed) return;
            s.helloed = true;
            s.device = clean(str(m, "device"), 64);
            s.kind = "pc".equals(str(m, "kind")) ? "pc" : "phone";
            String nm = cleanName(m.opt("name"));
            s.named = nm.length() > 0;
            s.name = s.named ? nm : "pc".equals(s.kind) ? "Computer" : "Phone";
            s.peer = m.optInt("peer") == 1 || m.optBoolean("peer", false);
            String n = str(m, "nonce");
            // only another device sending here, signing in (protocol 4): nothing else talks to a phone
            if (!s.peer || m.optInt("v") < 4 || !n.matches("[0-9a-f]{32,64}") || s.device.isEmpty()) { s.close(); return; }
            s.nonceP = n;
            s.nonceS = rid(16);
            JSONObject d = allowedRecord(s.device);
            if (d != null) {
                s.authWait = true;
                JSONObject a = new JSONObject();
                a.put("t", "auth?"); a.put("v", PROTO); a.put("nonce", s.nonceS); a.put("proof", proof(d.optString("token"), "pc", s));
                a.put("pc", new JSONObject().put("id", host.id()).put("name", host.name()));
                s.send(a);
                return;
            }
            welcome(s, false, null);
            return;
        }
        if (!s.helloed) return;
        if ("auth".equals(t)) {
            if (!s.authWait) return;
            s.authWait = false;
            JSONObject d = allowedRecord(s.device);
            if (d == null || !sameHex(proof(d.optString("token"), "phone", s), str(m, "proof"))) { host.log("peers: sign-in failed for " + s.name); s.doubt = true; welcome(s, false, "auth"); return; }
            s.signedWith = d.optString("token");
            welcome(s, true, null);
            if (overLink(s.address)) host.signedIn(s.device, s.address);
            // signed in under a new name (it was renamed there): it's called that here from now on; and the Bluetooth key it
            // said (a paired phone's: what tells its advertisements and its private hello apart, Peers.bleKeys)
            boolean renamed = false;
            String bk = "phone".equals(s.kind) ? str(m, "bk") : "";
            synchronized (host) {
                JSONObject a = host.allowed();
                JSONObject x = a == null ? null : a.optJSONObject(s.device);
                if (s.named && x != null && !s.name.equals(x.optString("name"))) { x.put("name", s.name); host.saved(); renamed = true; }
                if (x != null && bk.matches("[A-Za-z0-9+/]{22}==") && !bk.equals(x.optString("bk"))) { x.put("bk", bk); host.saved(); }
            }
            if (renamed) host.renamed(s.device, s.name);
            return;
        }
        if ("connect".equals(t)) {
            if (s.trusted) {
                // Removed here since it signed in (forget closes only its connected link: this one hadn't connected
                // yet), or paired anew since: this link's sign-in is that of a pairing that is no more
                JSONObject d = allowedRecord(s.device);
                String tok = s.signedWith != null ? s.signedWith : s.granted;
                if (d == null || (tok != null && !tok.equals(d.optString("token")))) { s.trusted = false; s.gone = true; s.close(); return; }
                joined(s);
                return;
            }
            if (s.authWait || s.pairAsked) return;                     // one request to pair per link
            // A PC asks here only to become this phone's PC (its user held Connect there and picked this phone): never
            // to be one more device that sends files here (a phone sends to its PCs, and they to it, over its own link)
            if ("pc".equals(s.kind)) {
                if (m.optInt("home") != 1) { s.pairAsked = true; s.send(new JSONObject().put("t", "denied")); return; }
                // A PC this phone is paired with already never asks (its own phones aren't offered to it): one that does is
                // another device giving its id (it's in that PC's answers to anyone), or one that removed this phone. The
                // pairing stays, the user here isn't asked, and the PC hears why ("paired": this phone has one with it)
                if (host.pcPaired(s.device)) {
                    s.pairAsked = true;
                    s.send(new JSONObject().put("t", "denied").put("why", "paired"));
                    host.log("peers: " + s.name + " asked to pair, and is paired with this phone already: refused");
                    return;
                }
                s.home = true;
            }
            s.pairAsked = true;
            // Each request asks the user, so a stranger mustn't be able to spam them: one at a time, a pause for an
            // address just turned down, and a cap per minute (on what the user is asked: see pair-reveal). Nor can one
            // hold the place: a request that doesn't reveal its half of the code soon makes way for a newer one, and
            // the user's answer isn't waited for longer than the other phone waits.
            long now = mono();
            String commit = str(m, "commit");
            if (!commit.matches("[0-9a-f]{64}")) return;
            List<Session> gone = new ArrayList<Session>();
            boolean busy = false;
            synchronized (live) {
                Long until = cool.get(s.address);
                if (until != null && until > now) busy = true;
                else {
                    for (Iterator<Map.Entry<String, Session>> it = pending.entrySet().iterator(); it.hasNext(); ) {
                        Session x = it.next().getValue();
                        if (x == s) continue;
                        boolean stale = !x.open || (x.pairCode == null ? now - x.pairAt > REPLACE_MS : now - x.pairAt > ANSWER_MS);
                        if (stale) { it.remove(); gone.add(x); } else busy = true;
                    }
                    prune(pairTimes, now);
                    if (pairTimes.size() >= 6) busy = true;
                    // Each request that hears this side's commitment counts for its address, shown to the user or not: one
                    // that goes away unrevealed can't ask again and again unseen (another address isn't held up by it)
                    List<Long> pk = peeks.get(s.address);
                    if (pk == null) pk = new ArrayList<Long>();
                    prune(pk, now);
                    if (pk.size() >= MAX_PEEKS) busy = true;
                    if (!busy) {
                        pk.add(now);
                        peeks.put(s.address, pk);
                        if (peeks.size() > 500) {
                            for (Iterator<List<Long>> it = peeks.values().iterator(); it.hasNext(); ) { List<Long> l = it.next(); if (l.isEmpty() || now - l.get(l.size() - 1) > 60000) it.remove(); }
                        }
                        s.pairCommit = commit;
                        s.pairNonceS = rid(16);
                        s.pairAt = now;
                        pending.put(s.device, s);
                    }
                }
            }
            for (final Session x : gone) {
                // (told and closed on the side: one that doesn't read mustn't hold up this request)
                if (x.open) {
                    Thread th = new Thread(new Runnable() {
                        @Override public void run() { try { x.send(new JSONObject().put("t", "denied")); } catch (Exception e) { /* gone */ } x.close(); }
                    }, "flick-peer-close");
                    th.setDaemon(true);
                    th.start();
                }
                if (x.pairCode != null) host.pairCancel(x.device);
            }
            if (busy) { s.send(new JSONObject().put("t", "denied")); return; }
            // The other side has committed to its half of the code (a hash of it); this side commits to its own; then the
            // other reveals its half, the request is shown here, and only then is this side's half said. So neither side
            // (nor anyone in the middle) can pick numbers that steer the code, or try again and again unseen until two
            // codes match.
            s.send(new JSONObject().put("t", "pairing").put("commit", sha256(s.pairNonceS)));
            return;
        }
        if ("pair-reveal".equals(t)) {
            String n = str(m, "nonce");
            boolean ask = false, no = false;
            synchronized (live) {
                if (s.pairCommit == null || s.pairCode != null || pending.get(s.device) != s) return;
                long now = mono();
                prune(pairTimes, now);
                if (!n.matches("[0-9a-f]{32,64}") || !sha256(n).equals(s.pairCommit) || pairTimes.size() >= 6) {
                    pending.remove(s.device);
                    no = true;
                } else {
                    pairTimes.add(now);                     // a request shown to the user (the cap per minute)
                    s.pairCode = pairCode(fp, n, s.pairNonceS);
                    s.pairAt = now;
                    ask = true;
                }
            }
            if (no) s.send(new JSONObject().put("t", "denied"));
            if (ask) {
                JSONObject was = allowedRecord(s.device);
                host.pairRequest(s.device, s.name, s.kind, s.pairCode, was != null && !was.has("prov"));
                // (on the user's screen now: this side's half, for the same code to show there)
                s.send(new JSONObject().put("t", "pair-nonce").put("nonce", s.pairNonceS));
            }
            return;
        }
        if ("home".equals(t)) {
            // The PC this phone's user just allowed gives this phone its pairing: the token to sign in there with, its
            // certificate (pinned from now on: the code both screens showed vouches for it) and where it is. Only on the
            // link allowed here, right after, and once.
            if (!s.home || s.homeDone || s.approved <= 0 || mono() - s.approved > BACK_MS) return;
            String token = str(m, "token"), pfp = str(m, "fp").toLowerCase(Locale.US);
            Object po = m.opt("port");
            int p = po instanceof Number && ((Number) po).doubleValue() == ((Number) po).intValue() ? ((Number) po).intValue() : 0;
            if (!token.matches("[0-9a-f]{32}") || !pfp.matches("[0-9a-f]{64}") || p <= 0 || p >= 65536) return;
            JSONArray in = m.optJSONArray("addrs"), addrs = new JSONArray();
            for (int i = 0; in != null && i < in.length() && addrs.length() < 8; i++) {
                Object a = in.opt(i);
                if (a instanceof String && ((String) a).matches("\\d{1,3}(\\.\\d{1,3}){3}")) addrs.put(a);
            }
            s.homeDone = true;
            if (s.homeT != null) s.homeT.cancel(false);
            host.homePaired(s.device, s.name, token, pfp, p, addrs, s.address);
            s.send(new JSONObject().put("t", "home-ok"));
            return;
        }
        // past this: a device signed in and connected
        if (!s.trusted || !s.connected) return;
        synchronized (live) { if (live.get(s.device) != s) return; }
        if ("send".equals(t)) {
            String tid = clean(str(m, "tid"), 40);
            if (tid.isEmpty()) return;
            boolean mine;
            synchronized (owner) {
                String who = owner.get(tid);
                if ((who != null && !who.equals(s.device)) || stopped.containsKey(tid)) return;     // another device's
                mine = s.device.equals(who);
            }
            // a device sends one thing at a time: a flood of cards (more than two a second, for a minute) is not a send.
            // Kept for the device, not the link (linking again doesn't start it over). (Its upload came first: it was
            // counted then.)
            if (!mine && !card(s.device)) { s.send(failed(tid, "busy")); return; }
            synchronized (owner) {
                String who = owner.get(tid);
                if ((who != null && !who.equals(s.device)) || stopped.containsKey(tid)) return;
                owner.put(tid, s.device);
            }
            JSONObject f = m.optJSONObject("file");
            f = f == null ? new JSONObject() : new JSONObject(f.toString());
            // what the card shows: text, a size, a count (never a JSON null read as "null"); its name without control or
            // direction characters, wherever it's shown ("report<U+202E>fdp.apk" would read "reportkpa.pdf")
            JSONObject card = new JSONObject();
            String nm = cleanText(str(f, "name"), 1000);
            card.put("name", nm.isEmpty() ? "Files" : nm);
            card.put("size", Math.max(0, f.optLong("size", 0)));
            card.put("kind", str(f, "kind").matches("image|video|audio|doc|folder|pdf") ? str(f, "kind") : "doc");
            card.put("count", Math.max(1, Math.min(10000000, f.optInt("count", 1))));
            if (f.optBoolean("folder", false)) card.put("folder", true);
            // its picture, for the card here: a small inline image only (never an address to fetch)
            String th = str(m, "thumb");
            // (and a small one: a few hundred kilobytes can describe a picture the page couldn't hold in memory)
            if (th.length() < 300000 && th.matches("data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+") && smallPicture(th, 2048)) {
                card.put("thumb", th);
                double asp = m.optDouble("aspect", 0);
                if (asp > 0.2 && asp < 5) card.put("aspect", asp);
            }
            // flicked there: the animation it left with and where (its card comes in the same way, at that height)
            String look = str(m, "look");
            if (LOOKS.contains(look)) card.put("look", look);
            Object yo = m.opt("y"), vo = m.opt("vx");
            if (yo instanceof Number && ((Number) yo).doubleValue() >= 0 && ((Number) yo).doubleValue() <= 1) card.put("y", ((Number) yo).doubleValue());
            if (vo instanceof Number && Math.abs(((Number) vo).doubleValue()) <= 10) card.put("vx", ((Number) vo).doubleValue());
            // (it wants to hear how much of it has come while it comes: recv)
            Object rv = m.opt("recv");
            if ((rv instanceof Number && ((Number) rv).intValue() == 1) || Boolean.TRUE.equals(rv)) synchronized (recvTo) { recvTo.put(tid, new Told(s.device, !"pc".equals(s.kind))); }
            host.incoming(tid, s.device, s.name, card);
        } else if ("cancel".equals(t)) {
            // only its sender stops a transfer; and once stopped, it doesn't start again. All of it here already: too late
            // to stop (it's being saved), unless this phone's user is still being asked whether to take it (Ask each
            // time): the question goes then, and the sender hears it was stopped (route, as for a Decline)
            // (and it's always answered: a sender whose Cancel came as the last of it arrived waits to hear which came first)
            String tid = clean(str(m, "tid"), 40);
            // (why "quit": Flick was closed there in the middle of it, said as it closed; one from before says nothing)
            boolean closed = "quit".equals(str(m, "why"));
            boolean none, all;
            synchronized (owner) {
                String who = owner.get(tid);
                if (tid.isEmpty() || (who != null && !who.equals(s.device))) return;
                none = who == null;
                all = !none && placing.contains(tid);
                if (!none && !all) { owner.remove(tid); stopped.put(tid, s.device); if (closed) quits.put(tid, s.device); }
            }
            // (nothing of it here now: it never came, or it's over; one saved said so before this, over this link)
            if (none) { s.send(failed(tid, "canceled")); return; }
            if (all) {
                // (kept: it's being saved, nobody here is asked about it any more)
                if (!host.withdraw(tid)) s.send(new JSONObject().put("t", "got").put("tid", tid).put("kept", true));
                return;
            }
            Socket u;
            synchronized (uploads) { u = uploads.remove(tid); }
            // (its upload, cut now, says it's over once what came of it is gone: see route)
            if (u != null) closeQuietly(u); else host.failed(tid, closed ? "quit" : "canceled");
            s.send(failed(tid, "canceled"));
        } else if ("clip".equals(t) || "link".equals(t) || "ring".equals(t) || "ring-stop".equals(t) || "ring-found".equals(t)) {
            // Its clipboard, a link, or "find my phone" (each only when it asked, its user's tap there; and a few a minute at
            // most: more is a flood). The answer ('ack', with its mid) says whether it was taken, so its user hears so.
            String mid = clean(str(m, "mid"), 24);
            String why;
            if (!"ring-stop".equals(t) && !"ring-found".equals(t) && !often(s.device, t)) why = "busy";
            else if ("clip".equals(t)) why = host.clip(s.device, s.name, m);
            else if ("link".equals(t)) why = host.link(s.device, s.name, str(m, "url"));
            else if ("ring".equals(t)) {
                Object so = m.opt("sec");
                int sec = so instanceof Number ? (int) Math.max(5, Math.min(60, ((Number) so).doubleValue())) : 30;
                why = host.ring(s.device, s.name, sec);
            } else if ("ring-found".equals(t)) { host.ringFound(s.device); why = null; }
            else { host.ringStop(s.device); why = null; }
            if (!mid.isEmpty()) s.send(new JSONObject().put("t", "ack").put("mid", mid).put("ok", why == null).put("why", why == null ? "" : why));
        } else if ("direct".equals(t)) {
            // It reached this phone over Bluetooth (they aren't on the same Wi-Fi) and has big files for it: this phone
            // makes a Wi-Fi network of its own for a moment (Wi-Fi Direct) and says how to join it, only over this
            // signed-in, encrypted link; or where it is in the one both are in already. A few a minute at most.
            final String mid = clean(str(m, "mid"), 24);
            if (mid.isEmpty()) return;
            final Session ss = s;
            if (!often(s.device, t)) { s.send(new JSONObject().put("t", "ack").put("mid", mid).put("ok", false).put("why", "busy")); return; }
            // (only over a link that isn't the network: over Wi-Fi there's nothing faster to make)
            if (!overLink(s.address)) { s.send(new JSONObject().put("t", "ack").put("mid", mid).put("ok", false).put("why", "unsupported")); return; }
            host.direct(s.device, clean(str(m, "group"), 32), new Reply() {
                @Override public void reply(String why, JSONObject more) {
                    try {
                        JSONObject a = new JSONObject().put("t", "ack").put("mid", mid).put("ok", why == null).put("why", why == null ? "" : why);
                        if (why == null && more != null) {
                            for (String k : new String[]{"ip", "ssid", "pass"}) if (more.has(k)) a.put(k, more.optString(k));
                            a.put("port", port);                  // (the same on every network: it listens on all of them)
                        }
                        if (ss.open && !ss.gone) ss.send(a);
                    } catch (Throwable e) { /* gone */ }
                }
            });
        } else if ("pair-done".equals(t)) {
            // its user saw the same code: the pairing allowed here stays (and a link it came over is its)
            if (s.approved > 0) { confirmed(s); if (overLink(s.address)) host.signedIn(s.device, s.address); }
        } else if ("peer-back".equals(t)) {
            // How to reach this device in return (pairing goes both ways at once): its receiver's certificate and a
            // token for this phone, over this signed-in, encrypted link, from a device the user just allowed with the
            // code: only on the link allowed here, right after (never later, from a device that has just signed in).
            if (s.approved <= 0 || mono() - s.approved > BACK_MS) return;
            String token = str(m, "token"), pfp = str(m, "fp").toLowerCase(Locale.US);
            Object po = m.opt("port");
            int p = po instanceof Number && ((Number) po).doubleValue() == ((Number) po).intValue() ? ((Number) po).intValue() : 0;
            if (!token.matches("[0-9a-f]{32}") || !pfp.matches("[0-9a-f]{64}") || p <= 0 || p >= 65536) return;
            confirmed(s);
            host.linkBack(s.device, s.name, s.kind, pfp, token, s.address + ":" + p);
        } else if ("peer-forget".equals(t)) {
            // it removed this phone: this phone removes it too (both ways)
            forget(s.device, false);
            host.unlinked(s.device);
        }
    }

    private void welcome(Session s, boolean trusted, String why) throws Exception {
        s.trusted = trusted;
        JSONObject w = new JSONObject();
        w.put("t", "welcome"); w.put("v", PROTO); w.put("pc", new JSONObject().put("id", host.id()).put("name", host.name()));
        w.put("trusted", trusted); w.put("kind", "phone"); w.put("caps", capsJson());
        if (why != null) w.put("why", why);
        // a paired phone signed in (over its pinned link): this phone's Bluetooth key, so it can tell this one's
        // advertisements and private hello apart (nothing else gets it); and whether this phone can send to it (what it
        // keeps so this phone can is used, or left over from a pairing this one lost: see PeerClient.verify)
        if (trusted && "phone".equals(s.kind)) {
            String bk = host.bleKey(); if (bk != null && !bk.isEmpty()) w.put("bk", bk);
            Boolean back = host.sendsTo(s.device);
            if (back != null) w.put("back", back.booleanValue());
        }
        s.send(w);
    }

    private void joined(Session s) throws Exception {
        Session prev;
        synchronized (live) { prev = live.get(s.device); live.put(s.device, s); }
        if (prev != null && prev != s) { prev.open = false; closeSoon(prev.sock); }     // (closed outside the lock: a close can wait)
        s.connected = true;
        s.send(new JSONObject().put("t", "connected").put("pc", new JSONObject().put("id", host.id()).put("name", host.name()).put("port", port)).put("caps", capsJson()));
    }

    /** The user allowed a device that asked to pair (its code matched): it gets a token, and is connected. */
    void approve(String device) {
        final Session s;
        synchronized (live) { s = pending.get(device); if (s == null || s.pairCode == null) return; pending.remove(device); }
        if (s.home) {
            // A PC asking to be this phone's PC: nothing here lets it send files here. It hears it was allowed (and who
            // this phone is to its PCs), and gives this phone its own pairing in return ('home'): this phone then
            // connects to it as a phone connects to its PC.
            s.approved = mono();
            // Its 'home' comes once its user says the codes match there too. Not by the time it's due (homeDue: the time
            // this link has, which otherwise ends only with its next frame): the link goes, and the page hears it's over
            // (onClosed).
            long left = Math.max(0, homeDue(s) - mono());
            s.homeT = guard.schedule(new Runnable() {
                @Override public void run() { if (!s.homeDone) { s.open = false; closeSoon(s.sock); } }
            }, left, TimeUnit.MILLISECONDS);
            try { s.send(new JSONObject().put("t", "paired").put("home", 1).put("device", host.homeId()).put("name", host.name())); }
            catch (Exception e) { host.log("peers: approve failed " + e.getMessage()); }
            host.pairCancel(device);
            return;
        }
        String token = rid(16);
        boolean keep = false;
        long now = System.currentTimeMillis();
        try {
            synchronized (host) {
                // A device this phone paired with the other way a moment ago (it was given a token for here then: grant(),
                // 'back') keeps that token: pairing from both ends at once leaves each direction with one token, not two
                // that don't match. Any other pairing gets a new one: whoever is allowed now never inherits a token an
                // earlier pairing under this id was given.
                JSONObject was = host.allowed() == null ? null : host.allowed().optJSONObject(device);
                String t = was == null ? "" : was.optString("token");
                long back = was == null ? 0 : was.optLong("back", 0);
                keep = t.matches("[0-9a-f]{32}") && back > 0 && now - back < KEEP_MS && now >= back;
                if (keep) token = t;
                JSONObject rec = new JSONObject();
                rec.put("name", s.name); rec.put("kind", s.kind); rec.put("token", token);
                rec.put("added", keep && was.optLong("added") > 0 ? was.optLong("added") : now);
                // its user still checks the code there too: until it says so ('pair-done'), the pairing is only on the
                // way, and goes if it leaves first
                if (keep) rec.put("back", back); else rec.put("prov", now);
                // (paired again: its files are still asked about each time, if they were)
                if (was != null && was.optBoolean("ask", false)) rec.put("ask", true);
                host.allowed().put(device, rec);
                host.saved();
            }
            s.approved = mono();
            s.granted = token;
            // (its link closed as it was allowed: what was just kept for it goes now, not minutes later, and it isn't
            // taken for one connected)
            if (!s.open || s.sock.isClosed()) { dropProvisional(s); host.pairCancel(device); return; }
            if (!keep) s.provT = guard.schedule(new Runnable() { @Override public void run() { dropProvisional(s); } }, PROV_MS, TimeUnit.MILLISECONDS);
            // connected here before it hears it's paired: what it says right after (how to reach it back) is taken
            s.trusted = true;
            Session prev;
            synchronized (live) { prev = live.get(device); live.put(device, s); }
            if (prev != null && prev != s) { prev.open = false; closeSoon(prev.sock); }
            // (its link closed between the check above and its listing: onClosed found nothing to take off the list)
            if (!s.open) {
                synchronized (live) { if (live.get(device) == s) live.remove(device); }
                dropProvisional(s);
                host.pairCancel(device);
                return;
            }
            // Removed here as it was being allowed (the user's Remove right after Allow): that came after the pairing was
            // kept above but before this link was listed, so forget() found no link to end and tell. It's done here: the
            // asker hears it was removed, as it would have a moment later, and nothing it says counts any more (its
            // 'peer-back' would have this phone list it as paired, with nothing here letting it send).
            if (!holds(device, token)) {
                boolean mine;
                synchronized (live) { mine = live.get(device) == s; if (mine) live.remove(device); }
                if (s.provT != null) s.provT.cancel(false);
                if (mine) {
                    s.gone = true; s.trusted = false; s.connected = false;
                    try { s.send(new JSONObject().put("t", "peer-forget")); } catch (Exception e) { /* gone */ }
                    s.close();
                }
                host.pairCancel(device);
                host.log("peers: " + s.name + " was removed as it was allowed");
                return;
            }
            s.connected = true;
            host.pairCancel(device);
            s.send(new JSONObject().put("t", "paired").put("token", token).put("fp", fp));
            s.send(new JSONObject().put("t", "connected").put("pc", new JSONObject().put("id", host.id()).put("name", host.name()).put("port", port)).put("caps", capsJson()));
        } catch (Exception e) { host.log("peers: approve failed " + e.getMessage()); }
        host.pairCancel(device);
    }

    /** The user said no: the device is told, and its address waits a moment before it can ask again. */
    void deny(String device) {
        Session s;
        synchronized (live) {
            s = pending.remove(device);
            if (s != null) {
                long now = mono();
                for (Iterator<Map.Entry<String, Long>> it = cool.entrySet().iterator(); it.hasNext(); ) if (it.next().getValue() < now) it.remove();
                cool.put(s.address, now + 20000);
            }
        }
        if (s != null) { try { s.send(new JSONObject().put("t", "denied")); } catch (Exception e) { /* ignore */ } }
        host.pairCancel(device);
        // (it asked again as a paired device that couldn't sign in, and the user here said no)
        if (s != null && s.doubt) host.doubt(device);
    }

    /** A device this phone no longer takes files from: its pairing goes, and its link closes. */
    void forget(String device) { forget(device, false); }

    /**
     * The same; tell: this phone's user removed it, and it hears so over its link here. Only then: a pairing undone
     * for another reason, or a device that removed this phone itself, isn't told (a word that came late could undo a
     * pairing made again since).
     */
    void forget(String device, final boolean tell) {
        synchronized (host) {
            JSONObject a = host.allowed();
            if (a != null && a.has(device)) { a.remove(device); host.saved(); }
        }
        final Session s;
        synchronized (live) { s = live.remove(device); }
        // what it's sending right now stops too (nothing more of it is taken, nor kept)
        final List<String> its = new ArrayList<String>();
        synchronized (owner) { for (Map.Entry<String, String> e : owner.entrySet()) if (device.equals(e.getValue()) && !placing.contains(e.getKey())) its.add(e.getKey()); }
        List<Socket> cut = new ArrayList<Socket>();
        synchronized (uploads) { for (String t : its) { Socket u = uploads.remove(t); if (u != null) cut.add(u); } }
        if (s != null) {
            // Nothing it says counts any more. What it was sending is told it didn't go before its link closes (it
            // doesn't take a closed link for "sent"): on a thread of its own, as whoever asked doesn't wait for the
            // other side.
            s.gone = true; s.trusted = false; s.connected = false;
            Thread th = new Thread(new Runnable() {
                @Override public void run() {
                    for (String t : its) s.send(failed(t, "removed"));
                    // and that it's removed here, over its own link (one paired a moment ago has no other way to hear it:
                    // this phone can't reach it yet)
                    if (tell) { try { s.send(new JSONObject().put("t", "peer-forget")); } catch (Exception e) { /* gone */ } }
                    s.close();
                }
            }, "flick-peer-close");
            th.setDaemon(true);
            th.start();
        }
        for (Socket u : cut) closeSoon(u);
    }

    private static JSONArray capsJson() { JSONArray a = new JSONArray(); for (String c : CAPS) a.put(c); return a; }

    /**
     * This phone's user stopped files coming in (their Cancel): nothing more of them is taken or kept, and the sender
     * hears they were canceled here (canceled: true; with why "declined" for senders from before that, which say they
     * weren't accepted), as does an upload of them that comes after (its 410). Too late once all of it is here (it's
     * being saved). False when there's nothing of it to stop.
     */
    boolean drop(String tid) {
        String device;
        synchronized (owner) {
            device = owner.get(tid);
            if (device == null || placing.contains(tid)) return false;
            owner.remove(tid);
            stopped.put(tid, device);
            dropped.put(tid, device);
        }
        // (said before its upload is cut: the sender knows why at once, not only that the connection broke)
        JSONObject m = failed(tid, "declined");
        try { m.put("canceled", true); } catch (Exception e) { /* as a decline */ }
        push(device, m);
        Socket u;
        synchronized (uploads) { u = uploads.remove(tid); }
        if (u != null) closeQuietly(u);
        host.failed(tid, "stopped");
        return true;
    }

    /** The file of tid's bundle coming in now (its name as sent), or null. */
    String receiving(String tid) { return tid == null ? null : writing.get(tid); }

    /** Whether a paired device at an address starting so ("192.168.49.") is signed in here now, or sending files (a
     *  Wi-Fi Direct network in use: a connection that never signed in doesn't keep it up). */
    boolean anyFrom(String prefix) {
        synchronized (live) { for (Session s : live.values()) if (s.open && s.address != null && s.address.startsWith(prefix)) return true; }
        synchronized (uploads) {
            for (Socket u : uploads.values()) { InetAddress a = u.getInetAddress(); if (a != null && a.getHostAddress().startsWith(prefix)) return true; }
        }
        return false;
    }

    /** Something for a device about its files ('saved'), over its link if it's there. */
    void push(String device, JSONObject m) { tell(device, m); }

    /** The same: whether its link was there to take it. */
    boolean tell(String device, JSONObject m) {
        Session s;
        synchronized (live) { s = live.get(device); }
        if (s == null || !s.open) return false;
        s.send(m);
        return true;
    }

    /** The devices connected right now. */
    List<String> connected() {
        synchronized (live) { return new ArrayList<String>(live.keySet()); }
    }

    /** Whether a data: URL is a picture (PNG, JPEG, WebP) of at most max pixels a side, as its first bytes say (pc/imgsize.js). */
    static boolean smallPicture(String url, int max) {
        int i = url.indexOf(";base64,");
        if (i < 0) return false;
        int[] d;
        try {
            String b64 = url.substring(i + 8);
            d = imageSize(base64(b64.length() > 65536 ? b64.substring(0, 65536) : b64));
            if (d == null && b64.length() > 65536) d = imageSize(base64(b64));
        } catch (Exception e) { return false; }
        return d != null && d[0] > 0 && d[1] > 0 && d[0] <= max && d[1] <= max;
    }
    /** A picture's [width, height] from its first bytes (PNG, JPEG, WebP), or null. */
    static int[] imageSize(byte[] b) {
        int n = b.length;
        if (n >= 24 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return new int[]{(int) Math.min(Integer.MAX_VALUE, be(b, 16, 4)), (int) Math.min(Integer.MAX_VALUE, be(b, 20, 4))};
        if (n >= 4 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) {
            int i = 2;
            while (i + 9 < n) {
                if ((b[i] & 0xff) != 0xff) return null;
                int mk = b[i + 1] & 0xff;
                if (mk == 0xff) { i++; continue; }                                                   // (fill)
                if (mk == 0xd8 || mk == 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }     // (no length)
                int len = (int) be(b, i + 2, 2);
                if (len < 2) return null;
                // a frame's header: its height and width (SOF0-15, but DHT C4, JPG C8 and DAC CC)
                if (mk >= 0xc0 && mk <= 0xcf && mk != 0xc4 && mk != 0xc8 && mk != 0xcc) return new int[]{(int) be(b, i + 7, 2), (int) be(b, i + 5, 2)};
                i += 2 + len;
            }
            return null;
        }
        if (n >= 30 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P' && b[12] == 'V' && b[13] == 'P' && b[14] == '8') {
            if (b[15] == 'X') return new int[]{1 + (int) le(b, 24, 3), 1 + (int) le(b, 27, 3)};
            if (b[15] == ' ') return new int[]{(int) le(b, 26, 2) & 0x3fff, (int) le(b, 28, 2) & 0x3fff};
            if (b[15] == 'L') { long v = le(b, 21, 4); return new int[]{1 + (int) (v & 0x3fff), 1 + (int) ((v >> 14) & 0x3fff)}; }
        }
        return null;
    }
    private static long be(byte[] b, int at, int n) { long v = 0; for (int k = 0; k < n; k++) v = (v << 8) | (b[at + k] & 0xff); return v; }
    private static long le(byte[] b, int at, int n) { long v = 0; for (int k = n - 1; k >= 0; k--) v = (v << 8) | (b[at + k] & 0xff); return v; }
    // Base64 (standard, padded or not) without android.util: this class runs on any JVM
    private static byte[] base64(String s) {
        int n = s.length();
        while (n > 0 && s.charAt(n - 1) == '=') n--;
        n -= n % 4 == 1 ? 1 : 0;
        byte[] out = new byte[n * 3 / 4];
        int bits = 0, have = 0, o = 0;
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1;
            if (v < 0) throw new IllegalArgumentException("not base64");
            bits = (bits << 6) | v; have += 6;
            if (have >= 8) { have -= 8; if (o < out.length) out[o++] = (byte) (bits >> have); }
        }
        return o == out.length ? out : java.util.Arrays.copyOf(out, o);
    }

    /** One more card from device, if it hasn't made MAX_CARDS in the last minute (kept for the device, not its link). */
    private boolean card(String device) {
        long now = mono();
        synchronized (cards) {
            List<Long> l = cards.get(device);
            if (l == null) { l = new ArrayList<Long>(); cards.put(device, l); }
            prune(l, now);
            if (l.size() >= MAX_CARDS) return false;
            l.add(now);
            if (cards.size() > 200) {
                for (Iterator<List<Long>> it = cards.values().iterator(); it.hasNext(); ) { List<Long> x = it.next(); if (x.isEmpty() || now - x.get(x.size() - 1) > 60000) it.remove(); }
            }
            return true;
        }
    }
    // clipboards and links: 20 a minute from one device; rings: 4 (each rings for half a minute)
    private boolean often(String device, String what) {
        long now = mono();
        int max = "ring".equals(what) ? 4 : 20;
        synchronized (asks) {
            String k = device + "|" + what;
            List<Long> l = asks.get(k);
            if (l == null) { l = new ArrayList<Long>(); asks.put(k, l); }
            prune(l, now);
            if (l.size() >= max) return false;
            l.add(now);
            if (asks.size() > 300) {
                for (Iterator<List<Long>> it = asks.values().iterator(); it.hasNext(); ) { List<Long> x = it.next(); if (x.isEmpty() || now - x.get(x.size() - 1) > 60000) it.remove(); }
            }
            return true;
        }
    }
    // times from more than a minute ago (or ahead of the clock, which was set back) go
    private static void prune(List<Long> l, long now) {
        for (Iterator<Long> it = l.iterator(); it.hasNext(); ) { long x = it.next(); if (now - x > 60000 || x > now + 1000) it.remove(); }
    }
    /** Thrown by Host.place: the user here turned the files down (why: "declined", "timeout"). */
    static final class Declined extends IOException {
        final String why;
        Declined(String why) { super(why); this.why = why; }
    }

    /**
     * The user here turned a transfer down ("Ask each time") while it's still coming: it stops now, and its sender hears
     * why. (All of it in already: Host.place, waiting for the answer, says so instead.)
     */
    void refuse(String tid, String why) {
        String dev;
        synchronized (owner) {
            dev = owner.get(tid);
            if (dev == null || placing.contains(tid)) return;
            owner.remove(tid);
            stopped.put(tid, dev);
        }
        push(dev, failed(tid, why));
        Socket u;
        synchronized (uploads) { u = uploads.remove(tid); }
        if (u != null) closeQuietly(u);
        host.failed(tid, why);
    }

    static JSONObject failed(String tid, String why) {
        try { return new JSONObject().put("t", "failed").put("tid", tid).put("why", why); } catch (Exception e) { return new JSONObject(); }
    }
    /**
     * A device's name as this phone shows and keeps it: text only, without control or direction characters (a name could
     * otherwise turn the words around it backwards), at most 60 characters; "" for anything else (pc/peerlink.js cleanName).
     */
    static String cleanName(Object x) {
        if (!(x instanceof String)) return "";
        String s = (String) x;
        if (s.length() > 200) s = s.substring(0, 200);
        s = s.replaceAll(CONTROLS, "").trim();
        if (s.length() > 60) s = s.substring(0, Character.isHighSurrogate(s.charAt(59)) ? 59 : 60).trim();
        return s;
    }
    private static final String CONTROLS = "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]";

    /** Longer text from another device (what a send is called) the same way: at most max characters. */
    static String cleanText(String s, int max) {
        if (s == null) return "";
        if (s.length() > max + 1000) s = s.substring(0, Character.isHighSurrogate(s.charAt(max + 999)) ? max + 999 : max + 1000);
        s = s.replaceAll(CONTROLS, "").trim();
        if (s.length() > max) s = s.substring(0, Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max).trim();
        return s;
    }

    // ------------------------------------------------------------ small things
    private static final long T0 = System.nanoTime();
    /** Milliseconds on a clock that only moves forward (setting the phone's clock doesn't move it), from 1. */
    static long mono() { return (System.nanoTime() - T0) / 1000000L + 1; }
    private String rid(int n) { byte[] b = new byte[n]; rnd.nextBytes(b); return PeerCert.hex(b); }
    static String clean(String s, int max) {
        String t = s == null ? "" : s.replaceAll("[^a-zA-Z0-9_-]", "");
        return t.length() > max ? t.substring(0, max) : t;
    }
    private static long parseLong(String s) { try { return s == null ? 0 : Long.parseLong(s); } catch (NumberFormatException e) { return 0; } }
    static String sha256(String s) {
        try { return PeerCert.hex(MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8"))); } catch (Exception e) { return ""; }
    }
    static String hmac(String key, String msg) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes("UTF-8"), "HmacSHA256"));
        return PeerCert.hex(mac.doFinal(msg.getBytes("UTF-8")));
    }
    static boolean sameHex(String a, String b) {
        if (a == null || b == null || !a.matches("[0-9a-f]{64}") || !b.matches("[0-9a-f]{64}")) return false;
        return MessageDigest.isEqual(a.getBytes(), b.getBytes());
    }
    /** The code both screens show (pc/server.js pairCode). */
    static String pairCode(String chan, String nonceP, String nonceS) {
        String h = sha256("flick-pair-v1|" + chan + "|" + nonceP + "|" + nonceS);
        long n = Long.parseLong(h.substring(0, 8), 16) % 1000000L;
        return String.format(Locale.US, "%06d", n);
    }
    static void closeQuietly(Socket s) { try { if (s != null) s.close(); } catch (IOException e) { /* ignore */ } }
    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
    // Base64 without android.util (this class runs on any JVM)
    private static String android64(byte[] b) {
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
