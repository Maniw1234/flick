package com.flick.app;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A link to another phone over something that isn't a network: a USB cable between the two, or Bluetooth. One byte
 * stream each way carries any number of connections, in both directions. Each side listens on a local port
 * (127.0.0.1) that stands in for the other phone: a connection made to it (PeerClient's link to the other phone, an
 * upload; only those PeerClient said are coming, see expect) becomes a stream, which the other side connects to its
 * own receiver (PeerServer). So pairing, sending and everything else between two phones works over it unchanged,
 * encrypted end to end as over Wi-Fi. The first frame each way says who that side is (HELLO: its id, name, kind; over
 * Bluetooth with Flick not on screen there, said so that only its paired phones can tell: see Peers), so the other
 * phone shows up as one nearby, "over a USB cable" or "over Bluetooth". No Android classes: the tests run it on any JVM
 * (BtMux is the same idea, one way, to a PC).
 *
 * Link: both sides first send "FLKTUN1\n", and each again every second, with its HELLO after it once sent, until the
 * other side says who it is: a reader left over from a link before, on a cable, can take the first one, and what comes
 * before a greeting is skipped. A greeting that comes again later is skipped.
 * Frames: type (1 byte), stream id (4 bytes BE), length (4 bytes BE), payload. 1 OPEN, 2 DATA, 3 FIN, 4 RST, 5 PING,
 * 6 PONG, 7 HELLO, 8 ACK. The side that started the link numbers its streams 1, 3, 5...; the other 2, 4, 6...
 * A side's HELLO says how far its DATA runs ahead of what the other side has read (w, in bytes); the other side then says
 * how much DATA it has read (ACK: 8 bytes BE, every quarter of that), and no more than that goes ahead (over Bluetooth,
 * up to twice that while the link's round trips need it: see paced). So what waits in the link's own buffers (a
 * Bluetooth socket's, a cable's) is a moment's worth: a stream reset (a Cancel), a ping or a small message gets through
 * at once, not after seconds of a big file still on its way. (A side whose HELLO doesn't say w, from before this, never
 * hears an ACK and sends as it always did.)
 *
 * Anything at the other end may be hostile (Bluetooth: anyone in range): it must greet within seconds and say who it is
 * soon after, can't make this side queue more than a few hundred replies it doesn't read, and streams it leaves half
 * open end; it opens streams only once it said who it is, and a few at a time until a paired phone has signed in
 * through the link (verified). Its connections reach this phone's receiver from a loopback address of the link's own
 * (127.0.0.x): the receiver's limit for one address counts each link apart, and all the links together have one such
 * share (PeerServer.admit).
 */
final class Tunnel {
    interface Host {
        /** The other side said who it is ({id, name, kind}): it can be reached at 127.0.0.1:port() now. Or it said so
         *  that only its paired phones can tell ({p: 1, n, t}: Flick isn't on screen there): the host makes out which
         *  phone it is (known), or the link ends. */
        void hello(Tunnel t, JSONObject who);
        /** Where a stream the other side opens goes here: this phone's receiver's port (0: none, it's refused). */
        int localPort();
        /** The link ended (why: for the log). */
        void closed(Tunnel t, String why);
    }

    static final byte[] MAGIC = {'F', 'L', 'K', 'T', 'U', 'N', '1', '\n'};
    static final int OPEN = 1, DATA = 2, FIN = 3, RST = 4, PING = 5, PONG = 6, HELLO = 7, ACK = 8;
    // The most one DATA frame of this side's carries: a cable's, and Bluetooth's (smaller: what's on its way already
    // can't be overtaken, so a reset, a ping or an ACK waits behind less of a file there)
    static final int CHUNK = 32 * 1024, CHUNK_RADIO = 16 * 1024;
    // How far this side's DATA may run ahead of what the other side has read (said in its HELLO as w): a few times what
    // the link carries while an ACK comes back (Bluetooth: well under 1 MB/s; a cable: tens of MB/s, its turn around
    // a millisecond or two), and little more, as a reset waits behind all of it. Bluetooth's: 64 KB (a Cancel at
    // 100 KB/s ends on the other phone 0.7 s later; it was 1.5 s with 128 KB), more on a link whose ACKs are slow to
    // come back, up to 128 KB (see paced: 64 KB holds a link of 300 KB/s back by a tenth when its round trip is 200 ms)
    static final int WINDOW_CABLE = 1024 * 1024, WINDOW_RADIO = 64 * 1024, WINDOW_RADIO_MOST = 128 * 1024;
    // what the other side may say it runs ahead (outside this, it acknowledges nothing: it's sent as it was)
    private static final int MIN_WINDOW = 16 * 1024, MAX_WINDOW = 16 * 1024 * 1024;
    private static final int MAX_FRAME = 64 * 1024, MAX_STREAMS = 64;
    // streams the other side may have open before a paired phone signed in through the link (pairing takes one, a send
    // two: its link and its upload)
    private static final int MAX_UNPROVEN = 4;
    private static final int MAX_CONTROL = 512;         // replies waiting for a link that doesn't read: past that, it ends
    private static final long GREET_MS = 10000, HELLO_MS = 15000, HALF_MS = 60000;
    private static final java.util.concurrent.atomic.AtomicInteger LINKS = new java.util.concurrent.atomic.AtomicInteger();
    private static final InetAddress LOOPBACK = loopback();
    private static InetAddress loopback() {
        try { return InetAddress.getByAddress(new byte[]{127, 0, 0, 1}); } catch (IOException e) { return null; }
    }

    private static final class Stream {
        final int id;
        final Socket s;
        volatile boolean localDone, remoteDone;
        volatile boolean outDone;                       // all the other side sent for it is in the local connection, and its end
        volatile long localDoneAt;
        volatile long carried;                          // what of it this side sent on over the link (the writer's)
        // What the other side sent for it, waiting for the local connection to take it: a thread of its own writes it
        // there, so a connection slow to read holds up nothing else until HELD waits for it (then the link waits for it
        // too, for STUCK_MS at most: see toLocal) (under this)
        final ArrayDeque<Piece> got = new ArrayDeque<Piece>();
        int held;
        boolean fin, writing, gone;
        Stream(int id, Socket s) { this.id = id; this.s = s; }
    }
    // what came in one DATA frame: its n bytes, at the start of b
    private static final class Piece { final byte[] b; final int n; Piece(byte[] b, int n) { this.b = b; this.n = n; } }
    // Arrays for DATA frames, used again rather than new ones for every 32 KB each way (a gigabyte over a cable made
    // two new arrays of all of it): this side's frames (head and CHUNK bytes), and what the other side's bring until the
    // local connection took it (under themselves)
    private static final int FRAME = 9 + CHUNK, SPARE = 8;
    private final ArrayDeque<byte[]> spareOut = new ArrayDeque<byte[]>(), spareIn = new ArrayDeque<byte[]>();
    // what may wait for one stream's local connection, counted as the memory it takes (a frame of a byte took a whole
    // array: a flood of them, from anyone in Bluetooth range, filled the phone's memory long before this); one that
    // takes nothing for STUCK_MS while that's full ends (it's stuck: the stream ends, not the link)
    private static final int HELD = 256 * 1024, PIECE = 64;
    private static final long STUCK_MS = 15000;

    final String via;                                   // "usb" | "bluetooth"
    private final InputStream in;
    private final OutputStream out;
    private final Closeable link;
    private final Host host;
    private final boolean first;                        // this side started the link (odd stream ids)
    private final Map<Integer, Stream> streams = new ConcurrentHashMap<Integer, Stream>();
    // the ports this phone's own connections to the local port come from, as PeerClient said (-> until when)
    private final Map<Integer, Long> expected = new ConcurrentHashMap<Integer, Long>();
    private ServerSocket server;
    private int nextId;
    private volatile boolean closed;
    // (times on a clock that only moves forward: the phone's clock set back or ahead can't make a link silent or idle)
    private volatile long lastRx = PeerServer.mono();
    // last time a connection went through it: a Bluetooth link nothing used for a while ends (idleMs; 0: a cable, never)
    private volatile long lastUse = PeerServer.mono();
    private volatile long idleMs;
    // how long the other side has to greet, and to say who it is (an incoming Bluetooth link: much less, see hurry)
    private volatile long greetMs = GREET_MS, helloMs = HELLO_MS;
    private volatile JSONObject peer;                   // who the other side said it is
    private volatile boolean greeted;                   // its "FLKTUN1" came
    private volatile byte[] hello;                      // who this side said it is (HELLO's payload), once it did
    private final long started = PeerServer.mono();
    // the loopback address this link's connections to this phone's receiver come from (127.0.0.2 to .251)
    private final String from = "127.0.0." + (2 + (LINKS.getAndIncrement() & 0x7fffffff) % 250);
    volatile boolean verified;                          // a paired phone signed in through it (Peers: who it said it is is true)
    volatile String heard;                              // the advertisement (its hash) a Bluetooth link was made to, or null
    // Frames leave through one writer thread. Control frames (every kind but DATA) queue ahead of data and
    // queuing one never waits; data waits for room. So a link that stops draining stalls only the streams sending data:
    // never the pings, new streams or the reader. Guarded by q.
    private final Object q = new Object();
    private final ArrayDeque<byte[]> control = new ArrayDeque<byte[]>(), data = new ArrayDeque<byte[]>();
    private static final int QUEUED = 8;                // data frames waiting at most (8 × 32 KB; over Bluetooth 8 × 16 KB)
    // DATA going ahead of what the other side has read (see ACK): this side's limit, and the other side's (0: it said
    // none, it acknowledges nothing: nothing is held back for it, and it isn't told what was read either)
    private final int window;
    private final int chunk;                            // the most one DATA frame of this side's carries (CHUNK, CHUNK_RADIO)
    private volatile int theirs;
    private long sentData, acked;                       // (under q) DATA bytes written to the link; of them, read there
    // (under q) how far it runs ahead now: window, or over Bluetooth more when its round trips ask for it (see paced);
    // there, where the last DATA frames end and when each went, the shortest round trip seen, where the rate was taken
    private int ahead;
    private final boolean paces;
    private final long[] wentEnd = new long[32], wentAt = new long[32];
    private int wentFirst, wentN;
    private long trip = Long.MAX_VALUE, rateAt, rateFrom;
    private boolean dry;                                // (under q) this side ran out of DATA to send since the rate was taken
    private byte[] ackWaiting;                          // (under q) the ACK waiting to go: a newer count goes into it
    private long readData, ackedRead;                   // (the reader's) DATA bytes read from the link; said read so far
    private final Object pinger = new Object();         // close() wakes the ping loop through it
    private static volatile long silentMs = 35000;      // (tests: shorter)

    /** first: this side started the link (the USB host, the Bluetooth caller). link: closed when the tunnel ends. */
    Tunnel(InputStream in, OutputStream out, Closeable link, String via, boolean first, Host host) {
        this.in = in; this.out = out; this.link = link; this.via = via; this.first = first; this.host = host;
        this.nextId = first ? 1 : 2;
        this.window = "usb".equals(via) ? WINDOW_CABLE : WINDOW_RADIO;
        this.chunk = "usb".equals(via) ? CHUNK : CHUNK_RADIO;
        this.paces = !"usb".equals(via);
        this.ahead = window;
    }

    /** Greets the other side and says who this phone is (me: {id, name, kind}); then opens the local port. */
    int start(JSONObject me) throws IOException {
        // a link that doesn't greet in time ends (closing it ends a read waiting for it)
        thread("flick-tun-greet", new Runnable() { @Override public void run() { greetWatch(); } });
        synchronized (out) { out.write(MAGIC); out.flush(); }
        // its greeting, after whatever came before it (at most a little: a link before's last bytes)
        int seen = 0, skipped = 0;
        while (seen < MAGIC.length) {
            int c = in.read();
            if (c < 0) throw new EOFException();
            if (c == (MAGIC[seen] & 0xff)) seen++;
            else { skipped += seen + 1; seen = c == (MAGIC[0] & 0xff) ? 1 : 0; if (skipped > MAX_FRAME) throw new IOException("not Flick"); }
        }
        greeted = true;
        synchronized (this) {
            if (closed) throw new IOException("closed");
            server = new ServerSocket();
            // (connections here take in little more than the link can carry: what this phone's Flick has written into
            // one is soon on its way, so it can tell how far a send over a slow link really is: see carried)
            server.setReceiveBufferSize(32 * 1024);
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16);
        }
        thread("flick-tun-tx", new Runnable() { @Override public void run() { writeLoop(); } });
        thread("flick-tun-rx", new Runnable() { @Override public void run() { readLoop(); } });
        thread("flick-tun-accept", new Runnable() { @Override public void run() { acceptLoop(); } });
        thread("flick-tun-ping", new Runnable() { @Override public void run() { pingLoop(); } });
        // (and how far its DATA runs ahead of what's read there: see ACK)
        try { me.put("w", window); } catch (Exception e) { throw new IOException("bad hello"); }
        byte[] h = me.toString().getBytes("UTF-8");
        h = Arrays.copyOf(h, Math.min(h.length, 4096));
        hello = h;
        send(HELLO, 0, h, 0, h.length);
        return server.getLocalPort();
    }

    /** The local port that stands in for the other phone. */
    int port() { ServerSocket s = server; return s == null ? 0 : s.getLocalPort(); }
    JSONObject peer() { return peer; }
    boolean isClosed() { return closed; }
    static void setSilentMs(long ms) { silentMs = ms; }
    /** A link nothing went through for ms ends by itself (Bluetooth: it costs battery to keep). 0: never. */
    void idleAfter(long ms) { idleMs = ms; }
    /** The other side greets within greet ms and says who it is within hello ms, or the link ends (before start). */
    void hurry(long greet, long hello) { greetMs = greet; helloMs = hello; }

    private static void thread(String name, Runnable r) { Thread t = new Thread(r, name); t.setDaemon(true); t.start(); }

    // until the other side greets: this side's greeting again every second (either side: a reader left over on a cable
    // can have taken it), and the end of the link if none comes in time; then until it says who it is: this side's
    // greeting still again every second, and who this side is after it (the other side may hear this side greet only
    // now, having been heard greeting already: what came before is skipped there)
    private void greetWatch() {
        try {
            long said = PeerServer.mono();
            while (!closed && !greeted) {
                Thread.sleep(250);
                if (closed || greeted) break;
                long now = PeerServer.mono();
                if (now - started > greetMs) { close("no greeting"); return; }
                if (now - said >= 1000) {
                    said = now;
                    try { synchronized (out) { out.write(MAGIC); out.flush(); } } catch (IOException e) { close("greeting: " + e.getMessage()); return; }
                }
            }
            while (!closed && peer == null) {
                Thread.sleep(250);
                if (closed || peer != null) break;
                long now = PeerServer.mono();
                if (now - started > helloMs) { close("no hello"); return; }
                byte[] h = hello;
                if (h != null && now - said >= 1000) {
                    said = now;
                    try { again(h); } catch (IOException e) { return; }        // (it ended)
                }
            }
        } catch (InterruptedException e) { /* done */ }
    }

    // this side's greeting and who it is, again, after what's waiting to go (the writer sends them in turn)
    private void again(byte[] h) throws IOException {
        synchronized (q) { if (closed) throw new IOException("link closed"); control.add(MAGIC); }
        send(HELLO, 0, h, 0, h.length);
    }

    private static void readFully(InputStream in, byte[] b, int n) throws IOException { readFully(in, b, 0, n); }
    private static void readFully(InputStream in, byte[] b, int off, int n) throws IOException {
        int end = off + n;
        while (off < end) { int r = in.read(b, off, end - off); if (r < 0) throw new EOFException(); off += r; }
    }
    private static boolean magicAt(byte[] h) {
        for (int i = 0; i < MAGIC.length; i++) if (h[i] != MAGIC[i]) return false;
        return true;
    }

    /** Queues a frame that isn't DATA (that goes through data(), which waits for room) for the writer: never blocks. */
    private void send(int type, int id, byte[] b, int off, int len) throws IOException {
        byte[] f = new byte[9 + len];
        f[0] = (byte) type;
        f[1] = (byte) (id >>> 24); f[2] = (byte) (id >>> 16); f[3] = (byte) (id >>> 8); f[4] = (byte) id;
        f[5] = (byte) (len >>> 24); f[6] = (byte) (len >>> 16); f[7] = (byte) (len >>> 8); f[8] = (byte) len;
        if (len > 0) System.arraycopy(b, off, f, 9, len);
        synchronized (q) {
            if (closed) throw new IOException("link closed");
            if (type == FIN && queued(id)) data.add(f);       // a stream's FIN never overtakes its own data
            else {
                if (type == PONG && pongWaiting()) return;     // (one answer to pings waiting is enough)
                if (control.size() >= MAX_CONTROL) flooded = true;
                else {
                    if (type == RST) unqueue(id);              // its waiting data and FIN are moot now
                    control.add(f);
                }
            }
            q.notifyAll();
        }
        // the other side asks and asks and doesn't read the answers: the link ends (outside q: close takes it)
        if (flooded) close("flooded");
    }
    private volatile boolean flooded;

    private boolean pongWaiting() {
        for (byte[] f : control) if (f[0] == PONG) return true;
        return false;
    }

    /** Queues a DATA frame of n bytes for stream id, already in f from 9 on (an array from spareOut), once there's room. */
    private void data(int id, byte[] f, int n) throws IOException {
        f[0] = (byte) DATA;
        f[1] = (byte) (id >>> 24); f[2] = (byte) (id >>> 16); f[3] = (byte) (id >>> 8); f[4] = (byte) id;
        f[5] = (byte) (n >>> 24); f[6] = (byte) (n >>> 16); f[7] = (byte) (n >>> 8); f[8] = (byte) n;
        synchronized (q) {
            // (a stream ended meanwhile stops waiting: see cut)
            while (!closed && data.size() >= QUEUED && streams.containsKey(id)) {
                try { q.wait(); } catch (InterruptedException e) { throw new InterruptedIOException(); }
            }
            if (closed) throw new IOException("link closed");
            if (!streams.containsKey(id)) { give(spareOut, f, FRAME); return; }  // (reset meanwhile, either way: moot)
            data.add(f);
            q.notifyAll();
        }
    }

    /**
     * This phone's own connection from local port p was stopped here (a Cancel): what the link still has of it goes now,
     * and the other side hears it's over ahead of what waits to go. (Its stream would end only once its turn to send
     * came again: until then what waited of it went on, and the other phone heard of the Cancel after it.)
     */
    void cut(int p) {
        for (Map.Entry<Integer, Stream> e : streams.entrySet()) {
            Stream st = e.getValue();
            if ((e.getKey() & 1) == (first ? 1 : 0) && st.s.getPort() == p) {
                // (it ends here first, then what waits of it goes: its pump, still reading what the connection holds,
                // could queue more of it in between, which then went after the reset for nothing and ahead of the rest,
                // the Cancel's own word to the other phone too, which then said "not received")
                drop(e.getKey(), st);
                try { send(RST, e.getKey(), null, 0, 0); } catch (IOException x) { /* link gone */ }
                synchronized (q) { q.notifyAll(); }
                return;
            }
        }
    }

    private static byte[] take(ArrayDeque<byte[]> spare, int size) {
        synchronized (spare) { byte[] b = spare.poll(); if (b != null) return b; }
        return new byte[size];
    }
    private static void give(ArrayDeque<byte[]> spare, byte[] b, int size) {
        if (b == null || b.length != size) return;
        synchronized (spare) { if (spare.size() < SPARE) spare.add(b); }
    }

    private static int idOf(byte[] f) { return ((f[1] & 0xff) << 24) | ((f[2] & 0xff) << 16) | ((f[3] & 0xff) << 8) | (f[4] & 0xff); }
    private static int lenOf(byte[] f) { return ((f[5] & 0xff) << 24) | ((f[6] & 0xff) << 16) | ((f[7] & 0xff) << 8) | (f[8] & 0xff); }

    private boolean queued(int id) {
        for (byte[] f : data) if (idOf(f) == id) return true;
        return false;
    }

    private void unqueue(int id) {
        for (Iterator<byte[]> it = data.iterator(); it.hasNext(); ) {
            byte[] f = it.next();
            if (idOf(f) == id) { it.remove(); if (f[0] == DATA) give(spareOut, f, FRAME); }
        }
    }

    // (under q) the next of data can go now: DATA only while what went ahead of what the other side has read is less than
    // how far this side runs ahead (when the other side acknowledges); its FIN, once its DATA went, at once
    private boolean next() {
        byte[] f = data.peek();
        return f != null && (f[0] != DATA || theirs == 0 || sentData - acked < ahead);
    }

    // The other side read DATA up to n (ACK): more can go
    private void acked(long n) {
        synchronized (q) {
            // (never past what went: a count from anywhere else opens nothing)
            if (n > acked) { acked = Math.min(n, sentData); if (paces) paced(); q.notifyAll(); }
        }
    }

    // (under q, Bluetooth) A DATA frame ending at end goes now
    private void went(long end) {
        if (wentN == wentEnd.length) { wentFirst = (wentFirst + 1) % wentEnd.length; wentN--; }   // (the oldest: untimed)
        int i = (wentFirst + wentN) % wentEnd.length;
        wentEnd[i] = end; wentAt[i] = PeerServer.mono(); wentN++;
    }

    // (under q, Bluetooth) An ACK came. The time it took for the newest frame it covers is a round trip of the link and
    // what waited ahead of that frame, so the shortest seen is the link's own; and every round trip or so (100 ms at
    // least) of sending without a pause, what the ACKs say came is the link's rate (or less: while this side holds back,
    // rate times round trip is what it let go, and half as much again lets more go, until the link is full). This side
    // runs ahead of what the other side read 1.5 times what the link carries in a round trip: at least window, at most
    // WINDOW_RADIO_MOST.
    private void paced() {
        long now = PeerServer.mono(), at = -1;
        while (wentN > 0 && wentEnd[wentFirst] <= acked) { at = wentAt[wentFirst]; wentFirst = (wentFirst + 1) % wentEnd.length; wentN--; }
        if (at > 0) trip = Math.min(trip, Math.max(1, now - at));
        if (trip == Long.MAX_VALUE) return;
        // (a stretch in which this side ran out of things to send says nothing of the link: one starts here. A long
        // wait for ACKs while DATA waits is the link being slow, and counts: going by the gap between ACKs, a link that
        // slowed below 16 KB per two round trips looked paused at every ACK and kept the window it had)
        if (rateAt == 0 || dry || data.isEmpty()) { rateAt = now; rateFrom = acked; dry = false; return; }
        if (now - rateAt < Math.max(100, trip)) return;
        long rate = (acked - rateFrom) * 1000 / (now - rateAt);           // bytes a second
        ahead = (int) Math.max(window, Math.min(WINDOW_RADIO_MOST, rate * trip * 3 / 2000));
        rateAt = now; rateFrom = acked;
    }

    // DATA of len bytes was read from the link: the other side hears how much, every quarter of its window (when it
    // said one), in one ACK at most waiting to go (a newer count goes into that one)
    private void read(int len) {
        readData += len;
        int w = theirs;
        if (w == 0 || readData - ackedRead < w / 4) return;
        ackedRead = readData;
        synchronized (q) {
            if (closed) return;
            if (ackWaiting == null) {
                ackWaiting = new byte[9 + 8];
                ackWaiting[0] = (byte) ACK; ackWaiting[8] = 8;
                control.add(ackWaiting);
                q.notifyAll();
            }
            for (int i = 0; i < 8; i++) ackWaiting[9 + i] = (byte) (readData >>> (56 - 8 * i));
        }
    }

    // queue → link
    private void writeLoop() {
        try {
            while (true) {
                byte[] f;
                synchronized (q) {
                    if (closed) return;
                    f = control.poll();
                    if (f != null && f == ackWaiting) ackWaiting = null;     // (it goes as it says now)
                    if (f == null && next()) {
                        f = data.poll();
                        if (f[0] == DATA) { sentData += lenOf(f); if (paces && theirs != 0) went(sentData); }
                    }
                    if (f != null) q.notifyAll();               // room for data
                }
                if (f != null) {
                    // (a frame's head says how long it is: an array used again can be longer; the greeting has no head)
                    boolean frame = f != MAGIC;
                    int n = frame ? 9 + lenOf(f) : f.length;
                    synchronized (out) { out.write(f, 0, n); }
                    if (frame && f[0] == DATA) {
                        Stream st = streams.get(idOf(f));
                        if (st != null) st.carried += n - 9;
                        give(spareOut, f, FRAME);
                    }
                    continue;
                }
                synchronized (out) { out.flush(); }              // the queue ran dry: push out what was written
                synchronized (q) {
                    if (data.isEmpty()) dry = true;
                    while (!closed && control.isEmpty() && !next()) q.wait();
                }
            }
        } catch (InterruptedException e) {
            close("link: interrupted");
        } catch (IOException e) {
            close("link: " + e.getMessage());
        }
    }

    // a connection made here to the local port: a stream to the other phone's receiver
    private void acceptLoop() {
        try {
            while (!closed) {
                final Socket s = server.accept();
                // (this phone's own Flick only: any app on the phone can reach the port, and mustn't get through to the
                // other phone as this one. PeerClient's connection comes from 127.0.0.1 and the port it said, which no
                // other app can take while it's Flick's; the same port number on another of the phone's loopback
                // addresses, 127.0.0.2 say, is someone else)
                Long until = LOOPBACK.equals(s.getInetAddress()) ? expected.remove(s.getPort()) : null;
                // (a connection that can't be closed or set up is its own trouble: the link goes on)
                if (until == null || until < PeerServer.mono() || streams.size() >= MAX_STREAMS) { try { s.close(); } catch (IOException x) { /* ignore */ } continue; }
                try { s.setTcpNoDelay(true); } catch (IOException x) { try { s.close(); } catch (IOException y) { /* ignore */ } continue; }
                final int id;
                synchronized (this) { id = nextId; nextId += 2; }
                final Stream st = new Stream(id, s);
                streams.put(id, st);
                lastUse = PeerServer.mono();
                send(OPEN, id, null, 0, 0);
                thread("flick-tun-up", new Runnable() { @Override public void run() { pump(id, st); } });
            }
        } catch (IOException e) {
            close("accept: " + e.getMessage());
        }
    }

    // local connection → link
    private void pump(int id, Stream st) {
        try {
            InputStream li = st.s.getInputStream();
            while (true) {
                // (read straight into the frame that carries it)
                byte[] f = take(spareOut, FRAME);
                int n = li.read(f, 9, chunk);
                if (n <= 0) { give(spareOut, f, FRAME); break; }
                data(id, f, n);
            }
            st.localDoneAt = PeerServer.mono();
            st.localDone = true;
            send(FIN, id, null, 0, 0);
            if (st.outDone) drop(id, st);
        } catch (IOException e) {
            // (this stream only: a newer one under the same number isn't reset for it)
            if (streams.get(id) == st) { try { send(RST, id, null, 0, 0); } catch (IOException x) { /* link gone */ } }
            drop(id, st);
        }
    }

    // the other side opened a stream: to this phone's receiver
    private void opened(int id) throws IOException {
        // (its own numbering only: the other side's parity, and a number not in use; and only once it said who it is,
        // and a few at a time until a paired phone has signed in through it: anyone in Bluetooth range can link, and
        // its connections mustn't take the places the phones on the network need)
        boolean theirs = (id & 1) == (first ? 0 : 1);
        int port = host.localPort();
        if (!theirs || id <= 0 || streams.containsKey(id) || streams.size() >= MAX_STREAMS || port <= 0 || peer == null
            || (!verified && opens() >= MAX_UNPROVEN)) { send(RST, id, null, 0, 0); return; }
        Socket s = new Socket();
        try {
            try { s.bind(new InetSocketAddress(InetAddress.getByName(from), 0)); } catch (IOException e) { /* 127.0.0.1, as it comes */ }
            s.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 2000);
            s.setTcpNoDelay(true);
        } catch (IOException e) {
            try { s.close(); } catch (IOException x) { /* ignore */ }
            send(RST, id, null, 0, 0);
            return;
        }
        final Stream st = new Stream(id, s);
        streams.put(id, st);
        lastUse = PeerServer.mono();
        final int sid = id;
        thread("flick-tun-down", new Runnable() { @Override public void run() { pump(sid, st); } });
    }

    // link → local connections
    private void readLoop() {
        byte[] h = new byte[9];
        byte[] buf = new byte[MAX_FRAME];
        try {
            while (!closed) {
                readFully(in, h, 9);
                // the other side's greeting again (it said it until it heard this side's): skipped
                while (h[0] == MAGIC[0] && magicAt(h)) { System.arraycopy(h, 8, h, 0, 1); readFully(in, h, 1, 8); }
                lastRx = PeerServer.mono();
                int type = h[0] & 0xff;
                int id = ((h[1] & 0xff) << 24) | ((h[2] & 0xff) << 16) | ((h[3] & 0xff) << 8) | (h[4] & 0xff);
                int len = ((h[5] & 0xff) << 24) | ((h[6] & 0xff) << 16) | ((h[7] & 0xff) << 8) | (h[8] & 0xff);
                if (len < 0 || len > buf.length) throw new IOException("bad frame");
                Stream st = streams.get(id);
                if (type == DATA && st != null && !st.remoteDone) {
                    // (straight into an array of its own: it waits there for the local connection to take it; one used
                    // again for a big frame, one just its size for a small one)
                    byte[] p = len >= CHUNK / 2 && len <= CHUNK ? take(spareIn, CHUNK) : new byte[len];
                    readFully(in, p, len);
                    read(len);
                    if (!toLocal(st, p, len)) { give(spareIn, p, CHUNK); send(RST, id, null, 0, 0); drop(id, st); }
                    continue;
                }
                readFully(in, buf, len);
                // (DATA for a stream gone here counts as read all the same: the other side sent it over the link)
                if (type == DATA) read(len);
                else if (type == ACK && len >= 8) {
                    long n = 0;
                    for (int i = 0; i < 8; i++) n = (n << 8) | (buf[i] & 0xff);
                    acked(n);
                } else if (type == FIN && st != null) {
                    st.remoteDone = true;
                    toLocal(st, null, 0);                       // (its end, once what came before it is in)
                } else if (type == RST && st != null) {
                    // what this side still had for it waiting is moot too (it would hold up the link for nothing): it
                    // ends here first, so its pump queues no more of it meanwhile (see cut)
                    drop(id, st);
                    synchronized (q) { unqueue(id); q.notifyAll(); }
                } else if (type == OPEN) {
                    opened(id);
                } else if (type == PING) {
                    send(PONG, 0, buf, 0, Math.min(len, 8));
                } else if (type == HELLO && peer == null && len > 0) {
                    JSONObject who;
                    try { who = PeerServer.parse(new String(buf, 0, len, "UTF-8")); } catch (Exception e) { throw new IOException("bad hello"); }
                    // how far its DATA runs ahead of what's read here: it hears how much is (ACK), and this side's own
                    // goes no further ahead than its window (one that says none, or one that can't be, from before this:
                    // as it always was)
                    Object wo = who.opt("w");
                    int tw = wo instanceof Number ? ((Number) wo).intValue() : 0;
                    if (tw >= MIN_WINDOW && tw <= MAX_WINDOW) theirs = tw;
                    if (who.optInt("p") == 1) {
                        // who it is, said so that only its paired phones can tell (p: it isn't on screen there): the host
                        // makes it out (known), or the link ends
                        JSONObject w = new JSONObject();
                        try { w.put("p", 1).put("n", PeerServer.str(who, "n")).put("t", PeerServer.str(who, "t")).put("kind", "phone"); }
                        catch (Exception e) { throw new IOException("bad hello"); }
                        host.hello(this, w);
                        if (peer == null) throw new IOException("unknown");
                        continue;
                    }
                    String id2 = PeerServer.clean(PeerServer.str(who, "id"), 64);
                    if (id2.isEmpty()) throw new IOException("bad hello");
                    JSONObject w = new JSONObject();
                    try {
                        w.put("id", id2);
                        w.put("name", PeerServer.cleanName(who.opt("name")));
                        w.put("kind", "pc".equals(PeerServer.str(who, "kind")) ? "pc" : "phone");
                        w.put("ready", who.optBoolean("ready", false));
                    } catch (Exception e) { throw new IOException("bad hello"); }
                    peer = w;
                    host.hello(this, w);
                }
            }
        } catch (IOException e) {
            close("link: " + e.getMessage());
        }
    }

    // a ping every 10 s; a link silent for longer than silentMs (the other phone gone, the cable out) ends
    private void pingLoop() {
        while (!closed) {
            try { synchronized (pinger) { if (!closed) pinger.wait(Math.min(10000, silentMs / 3)); } } catch (InterruptedException e) { return; }
            if (closed) return;
            if (PeerServer.mono() - lastRx > silentMs) { close("silent"); return; }
            if (idleMs > 0 && streams.isEmpty() && PeerServer.mono() - lastUse > idleMs) { close("idle"); return; }
            // a stream done here whose other end never finishes it: ended (it would hold a place for good)
            long now = PeerServer.mono();
            for (Map.Entry<Integer, Stream> e : streams.entrySet()) {
                Stream st = e.getValue();
                if (st.localDone && !st.remoteDone && now - st.localDoneAt > HALF_MS) {
                    try { send(RST, e.getKey(), null, 0, 0); } catch (IOException x) { /* link gone */ }
                    drop(e.getKey(), st);
                }
            }
            try { send(PING, 0, new byte[8], 0, 8); } catch (IOException e) { close("ping: " + e.getMessage()); return; }
        }
    }

    /** This phone's own connection to the local port, from local port p, is on its way (PeerClient): it's let through. */
    void expect(int p) {
        long now = PeerServer.mono();
        for (Iterator<Map.Entry<Integer, Long>> it = expected.entrySet().iterator(); it.hasNext(); ) if (it.next().getValue() < now) it.remove();
        expected.put(p, now + 10000);
    }

    // the streams the other side opened that are open now
    private int opens() {
        int n = 0;
        for (Integer k : streams.keySet()) if ((k & 1) == (first ? 0 : 1)) n++;
        return n;
    }

    /** What of this phone's own connection from local port p it has sent on over the link so far (-1: none such now). */
    long carried(int p) {
        for (Map.Entry<Integer, Stream> e : streams.entrySet()) {
            if ((e.getKey() & 1) == (first ? 1 : 0) && e.getValue().s.getPort() == p) return e.getValue().carried;
        }
        return -1;
    }

    /** This phone's own connections go through it now (streams this side opened). */
    boolean usedHere() { return streams.size() > opens(); }

    /** Anything goes through it now, either way. */
    boolean busy() { return !streams.isEmpty(); }

    /** Who the other side is, made out by the host from a private HELLO ({id, name, kind, ready}): it's that phone now. */
    void known(JSONObject w) { if (peer == null && !closed) peer = w; }

    /** The loopback address its connections to this phone's receiver come from (PeerServer sees them from there). */
    String from() { return from; }

    /** When it was made (PeerServer.mono). */
    long born() { return started; }

    // what came for st (its n bytes in b; null: its end) goes to its writer; false when the local connection has taken
    // nothing for STUCK_MS while as much as may wait for it waits (lastRx moves meanwhile: this side waiting isn't the
    // link going quiet). b is the writer's from here on, unless false
    private boolean toLocal(final Stream st, byte[] b, int n) throws IOException {
        synchronized (st) {
            if (st.gone) { give(spareIn, b, CHUNK); return true; }
            if (b != null) {
                long until = PeerServer.mono() + STUCK_MS;
                while (!st.gone && !closed && st.held >= HELD) {
                    long left = until - PeerServer.mono();
                    if (left <= 0) return false;
                    try { st.wait(Math.min(left, 1000)); } catch (InterruptedException e) { throw new InterruptedIOException(); }
                    lastRx = PeerServer.mono();
                }
                if (st.gone || closed) { give(spareIn, b, CHUNK); return true; }
                st.got.add(new Piece(b, n));
                st.held += b.length + PIECE;
            } else st.fin = true;
            st.notifyAll();
            if (!st.writing) { st.writing = true; thread("flick-tun-out", new Runnable() { @Override public void run() { toLocal(st); } }); }
        }
        return true;
    }

    // st's writer: what came for it into its local connection, in order, then its end; the stream ends once both ways
    // are done (a local connection that can't take it: the stream ends, and the other side hears so)
    private void toLocal(Stream st) {
        try {
            OutputStream o = st.s.getOutputStream();
            while (true) {
                Piece b;
                synchronized (st) {
                    while (!st.gone && st.got.isEmpty() && !st.fin) st.wait();
                    if (st.gone) return;
                    b = st.got.poll();
                    if (b != null) { st.held -= b.b.length + PIECE; st.notifyAll(); }
                }
                if (b != null) { o.write(b.b, 0, b.n); give(spareIn, b.b, CHUNK); continue; }
                try { st.s.shutdownOutput(); } catch (IOException e) { /* ignore */ }
                st.outDone = true;
                if (st.localDone) drop(st.id, st);
                return;
            }
        } catch (InterruptedException e) {
            drop(st.id, st);
        } catch (IOException e) {
            if (streams.get(st.id) == st) { try { send(RST, st.id, null, 0, 0); } catch (IOException x) { /* link gone */ } }
            drop(st.id, st);
        }
    }

    // (this stream only: a newer one under the same number stays)
    private void drop(int id, Stream st) {
        if (st == null) return;
        // (in use until now: a link that carried one send for longer than idleMs isn't idle the moment it ends)
        if (streams.remove(id, st)) lastUse = PeerServer.mono();
        synchronized (st) { st.gone = true; st.got.clear(); st.held = 0; st.notifyAll(); }
        try { st.s.close(); } catch (IOException e) { /* ignore */ }
    }

    void close(String why) {
        synchronized (this) { if (closed) return; closed = true; }
        synchronized (q) { control.clear(); data.clear(); q.notifyAll(); }   // the writer and waiting senders see it
        synchronized (pinger) { pinger.notifyAll(); }                       // and the ping loop, now
        try { if (server != null) server.close(); } catch (IOException e) { /* ignore */ }
        try { link.close(); } catch (IOException e) { /* ignore */ }
        for (Stream st : streams.values()) {
            synchronized (st) { st.gone = true; st.got.clear(); st.held = 0; st.notifyAll(); }
            try { st.s.close(); } catch (IOException e) { /* ignore */ }
        }
        streams.clear();
        if (host != null) { try { host.closed(this, why); } catch (Throwable e) { /* ignore */ } }
    }
}
