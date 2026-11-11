package com.flick.app;

import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The phone end of a Bluetooth link to Flick on the PC (pc/mux.js speaks the same protocol). A local port on this
 * phone (127.0.0.1) stands in for the PC: every connection made to it — the page's WebSocket, uploads, downloads —
 * becomes a stream over the one Bluetooth link, once its request carries the link's key (TlsProxy.Gate: anything else
 * on the phone can reach the port too). No Android classes, so it runs on any JVM.
 *
 * Link: both sides first send "FLKMUX1\n". Frames: type (1 byte), stream id (4 bytes BE), length (4 bytes BE), payload.
 * 1 OPEN, 2 DATA, 3 FIN, 4 RST, 5 PING, 6 PONG.
 *
 * What the PC sends for a stream waits for that stream's own connection here to take it (a thread of its own writes it
 * there): a connection slow to read, or one nothing reads any more, holds up the others only once HELD waits for it, and
 * for STUCK_MS at most; then that one stream ends, and the rest go on (as Tunnel does between phones; the PC holds back
 * the same way for its side, pc/mux.js).
 */
final class BtMux {
    interface Listener { void onClosed(String why); }

    static final byte[] MAGIC = {'F', 'L', 'K', 'M', 'U', 'X', '1', '\n'};
    static final int OPEN = 1, DATA = 2, FIN = 3, RST = 4, PING = 5, PONG = 6;
    static final int CHUNK = 32 * 1024;
    private static final int MAX_FRAME = 64 * 1024;     // (pc/mux.js MAX)
    // what may wait for one stream's connection, counted as the memory it takes (a frame of a few bytes costs more than
    // its bytes: a flood of tiny ones can't fill the phone's memory); one that takes nothing for STUCK_MS while that much
    // waits ends: it's stuck (that stream ends, not the link). Bluetooth moves 0.1-0.3 MB/s: seconds of it.
    private static final int HELD = 512 * 1024, PIECE = 64;
    private static final long STUCK_MS = 15000;
    static volatile long GREET_MS = 15000;              // the PC's greeting comes within this (tests shorten it)

    private static final class Stream {
        final Socket s;
        volatile boolean localDone, remoteDone;
        volatile boolean outDone;                       // all the PC sent for it is in the local connection, and its end
        // (under this) what came for it, waiting for its writer; how much memory that takes; its end came; its writer runs;
        // it ended (nothing more goes in)
        final ArrayDeque<byte[]> got = new ArrayDeque<byte[]>();
        int held;
        boolean fin, writing, gone;
        Stream(Socket s) { this.s = s; }
    }

    private final InputStream in;
    private final OutputStream out;
    private final Closeable link;
    private final Listener listener;
    private final Map<Integer, Stream> streams = new ConcurrentHashMap<Integer, Stream>();
    private ServerSocket server;
    private final String key = TlsProxy.Gate.newKey();
    private int port;                               // the local port, once open
    // the links open now by their local port, and the PC the page signed in to over each (see proven, link)
    private static final Map<Integer, BtMux> LINKS = new ConcurrentHashMap<Integer, BtMux>();
    private volatile String pc;
    private int nextId = 1;
    private volatile boolean closed;
    // (on a clock that only moves forward: the phone's clock set ahead or back can't make the link look silent, or not)
    private volatile long lastRx = mono();
    // Frames leave through one writer thread. Control frames (OPEN, FIN, RST, PING) queue ahead of data and queuing one
    // never waits; data waits for room. So a link that stops draining stalls only the streams sending data: never the
    // pings and the silence check, new streams, or the reader. Guarded by q.
    private final Object q = new Object();
    private final ArrayDeque<byte[]> control = new ArrayDeque<byte[]>(), data = new ArrayDeque<byte[]>();
    private static final int QUEUED = 8;            // data frames waiting at most (8 × 32 KB)
    private final Object pinger = new Object();     // close() wakes the ping loop through it

    BtMux(InputStream in, OutputStream out, Closeable link, Listener l) {
        this.in = in; this.out = out; this.link = link; this.listener = l;
    }

    /** Greets the PC, then opens the local port. Returns the port. */
    int start() throws IOException {
        // The PC greets within GREET_MS, or the link goes (as the PC does for its side: pc/mux.js): a computer that took
        // the connection and said nothing held this thread for good, and with it the looking for the PC over Bluetooth.
        final java.util.concurrent.atomic.AtomicBoolean greeted = new java.util.concurrent.atomic.AtomicBoolean();
        Thread watch = new Thread(new Runnable() {
            @Override public void run() {
                try { Thread.sleep(GREET_MS); } catch (InterruptedException e) { return; }
                if (!greeted.get()) close("no greeting");
            }
        }, "flick-bt-greet");
        watch.setDaemon(true);
        watch.start();
        byte[] m = new byte[MAGIC.length];
        try {
            out.write(MAGIC);
            out.flush();
            readFully(in, m, MAGIC.length);
        } finally {
            greeted.set(true);
            watch.interrupt();
        }
        if (!Arrays.equals(m, MAGIC)) throw new IOException("not Flick");
        synchronized (this) {
            if (closed) throw new IOException("closed");   // close() came during the greeting: no port left open
            server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            TlsProxy.Gate.mark(port, key);
            LINKS.put(port, this);
        }
        thread("flick-bt-tx", new Runnable() { @Override public void run() { writeLoop(); } });
        thread("flick-bt-rx", new Runnable() { @Override public void run() { readLoop(); } });
        thread("flick-bt-accept", new Runnable() { @Override public void run() { acceptLoop(); } });
        thread("flick-bt-ping", new Runnable() { @Override public void run() { pingLoop(); } });
        return server.getLocalPort();
    }

    boolean isClosed() { return closed; }

    /** The page signed in to the PC pcId over the link at this local port (that PC proved itself there). */
    static void proven(int port, String pcId) {
        BtMux m = LINKS.get(port);
        if (m != null && !m.closed && pcId != null && pcId.length() > 0) m.pc = pcId;
    }

    /**
     * The way to the PC pcId over a Bluetooth link open now that the page signed in to it over, or null when there's
     * none. A send that goes on without the page (Sends) goes only there, never to the port it was started with: once
     * that link closed, the port can be any app's (see TlsProxy.Gate), also after Flick was restarted.
     */
    static Wire.Link link(String pcId) {
        if (pcId == null) return null;
        for (BtMux m : LINKS.values()) {
            if (!m.closed && pcId.equals(m.pc)) return new Wire.Link("127.0.0.1", m.port, null, "/k/" + m.key);
        }
        return null;
    }

    private static long mono() { return System.nanoTime() / 1000000L; }

    private static void thread(String name, Runnable r) { Thread t = new Thread(r, name); t.setDaemon(true); t.start(); }

    private static void readFully(InputStream in, byte[] b, int n) throws IOException {
        int off = 0;
        while (off < n) { int r = in.read(b, off, n - off); if (r < 0) throw new EOFException(); off += r; }
    }

    /** Queues a frame for the writer. Only DATA can wait (for room); the rest never blocks. */
    private void send(int type, int id, byte[] b, int off, int len) throws IOException {
        byte[] f = new byte[9 + len];
        f[0] = (byte) type;
        f[1] = (byte) (id >>> 24); f[2] = (byte) (id >>> 16); f[3] = (byte) (id >>> 8); f[4] = (byte) id;
        f[5] = (byte) (len >>> 24); f[6] = (byte) (len >>> 16); f[7] = (byte) (len >>> 8); f[8] = (byte) len;
        if (len > 0) System.arraycopy(b, off, f, 9, len);
        synchronized (q) {
            if (type == DATA) {
                // (a stream ended meanwhile stops waiting: see drop)
                while (!closed && data.size() >= QUEUED && streams.containsKey(id)) {
                    try { q.wait(); } catch (InterruptedException e) { throw new InterruptedIOException(); }
                }
            }
            if (closed) throw new IOException("link closed");
            if (type == DATA && !streams.containsKey(id)) return;  // (reset meanwhile, either way: moot)
            if (type == DATA) data.add(f);
            else if (type == FIN && queued(id)) data.add(f);  // a stream's FIN never overtakes its own data
            else {
                if (type == RST) unqueue(id);                  // its waiting data and FIN are moot now
                control.add(f);
            }
            q.notifyAll();
        }
    }

    private static int idOf(byte[] f) { return ((f[1] & 0xff) << 24) | ((f[2] & 0xff) << 16) | ((f[3] & 0xff) << 8) | (f[4] & 0xff); }

    private boolean queued(int id) {
        for (byte[] f : data) if (idOf(f) == id) return true;
        return false;
    }

    private void unqueue(int id) {
        for (Iterator<byte[]> it = data.iterator(); it.hasNext(); ) if (idOf(it.next()) == id) it.remove();
    }

    // queue → link
    private void writeLoop() {
        try {
            while (true) {
                byte[] f;
                synchronized (q) {
                    if (closed) return;
                    f = control.poll();
                    if (f == null) f = data.poll();
                    if (f != null) q.notifyAll();               // room for data
                }
                if (f != null) { out.write(f); continue; }
                out.flush();                                     // the queue ran dry: push out what was written
                synchronized (q) { while (!closed && control.isEmpty() && data.isEmpty()) q.wait(); }
            }
        } catch (InterruptedException e) {
            close("link: interrupted");
        } catch (IOException e) {
            close("link: " + e.getMessage());
        }
    }

    private void acceptLoop() {
        try {
            while (!closed) {
                final Socket s = server.accept();
                thread("flick-bt-up", new Runnable() { @Override public void run() { open(s); } });
            }
        } catch (IOException e) {
            close("accept: " + e.getMessage());
        }
    }

    // a connection to the local port: a stream to the PC once its first request carries this link's key; one without
    // it (another app, a web page on the phone) ends here, and the PC never hears of it
    private void open(Socket s) {
        final InputStream li;
        try {
            s.setTcpNoDelay(true);
            li = TlsProxy.Gate.first(s, key);
        } catch (IOException e) {
            try { s.close(); } catch (IOException x) { /* ignore */ }
            return;
        }
        final int id;
        synchronized (this) { id = nextId; nextId += 2; }
        final Stream st = new Stream(s);
        streams.put(id, st);
        try { send(OPEN, id, null, 0, 0); } catch (IOException e) { drop(id, st); return; }
        pump(id, st, li);
    }

    // local connection → link (li: its requests, the key taken out)
    private void pump(int id, Stream st, InputStream li) {
        byte[] buf = new byte[CHUNK];
        try {
            int n;
            while ((n = li.read(buf)) > 0) send(DATA, id, buf, 0, n);
            st.localDone = true;
            send(FIN, id, null, 0, 0);
            if (st.outDone) drop(id, st);
        } catch (IOException e) {
            if (streams.get(id) == st) { try { send(RST, id, null, 0, 0); } catch (IOException x) { /* link gone */ } }
            drop(id, st);
        }
    }

    // link → local connections
    private void readLoop() {
        byte[] h = new byte[9];
        byte[] buf = new byte[MAX_FRAME];
        try {
            while (!closed) {
                readFully(in, h, 9);
                lastRx = mono();
                int type = h[0] & 0xff;
                int id = ((h[1] & 0xff) << 24) | ((h[2] & 0xff) << 16) | ((h[3] & 0xff) << 8) | (h[4] & 0xff);
                int len = ((h[5] & 0xff) << 24) | ((h[6] & 0xff) << 16) | ((h[7] & 0xff) << 8) | (h[8] & 0xff);
                if (len < 0 || len > buf.length) throw new IOException("bad frame");
                Stream st = streams.get(id);
                if (type == DATA && st != null && !st.remoteDone) {
                    // (into an array of its own, just its size: it waits there for its connection to take it)
                    byte[] p = new byte[len];
                    readFully(in, p, len);
                    if (len > 0 && !toLocal(id, st, p)) { send(RST, id, null, 0, 0); drop(id, st); }
                    continue;
                }
                readFully(in, buf, len);
                if (type == FIN && st != null) {
                    st.remoteDone = true;
                    toLocal(id, st, null);                      // (its end, once what came before it is in)
                } else if (type == RST && st != null) {
                    // what this side still had for it waiting is moot too (it would hold up the link for nothing): it
                    // ends here first, then what waits of it goes (the other way round, its pump, still reading what the
                    // connection holds, queued more of it in between: up to 256 KB the PC didn't want, ahead of the rest)
                    drop(id, st);
                    synchronized (q) { unqueue(id); q.notifyAll(); }
                }
            }
        } catch (IOException e) {
            close("link: " + e.getMessage());
        }
    }

    // What came for st (b; null: its end) goes to its writer. False when its connection has taken nothing for STUCK_MS
    // while as much as may wait for it waits (the link waits meanwhile; lastRx moves: this side waiting isn't the link
    // going quiet).
    private boolean toLocal(final int id, final Stream st, byte[] b) throws IOException {
        synchronized (st) {
            if (st.gone) return true;
            if (b != null) {
                long until = mono() + STUCK_MS;
                while (!st.gone && !closed && st.held >= HELD) {
                    long left = until - mono();
                    if (left <= 0) return false;
                    try { st.wait(Math.min(left, 1000)); } catch (InterruptedException e) { throw new InterruptedIOException(); }
                    lastRx = mono();
                }
                if (st.gone || closed) return true;
                st.got.add(b);
                st.held += b.length + PIECE;
            } else st.fin = true;
            st.notifyAll();
            if (!st.writing) { st.writing = true; thread("flick-bt-out", new Runnable() { @Override public void run() { toLocal(id, st); } }); }
        }
        return true;
    }

    // st's writer: what came for it into its local connection, in order, then its end; the stream ends once both ways are
    // done (a local connection that can't take it: the stream ends, and the PC hears so)
    private void toLocal(int id, Stream st) {
        try {
            OutputStream o = st.s.getOutputStream();
            while (true) {
                byte[] b;
                synchronized (st) {
                    while (!st.gone && st.got.isEmpty() && !st.fin) st.wait();
                    if (st.gone) return;
                    b = st.got.poll();
                    if (b != null) { st.held -= b.length + PIECE; st.notifyAll(); }
                }
                if (b != null) { o.write(b); continue; }
                try { st.s.shutdownOutput(); } catch (IOException e) { /* ignore */ }
                st.outDone = true;
                if (st.localDone) drop(id, st);
                return;
            }
        } catch (InterruptedException e) {
            drop(id, st);
        } catch (IOException e) {
            if (streams.get(id) == st) { try { send(RST, id, null, 0, 0); } catch (IOException x) { /* link gone */ } }
            drop(id, st);
        }
    }

    private void pingLoop() {
        while (!closed) {
            try { synchronized (pinger) { if (!closed) pinger.wait(10000); } } catch (InterruptedException e) { return; }
            if (closed) return;
            if (mono() - lastRx > 35000) { close("silent"); return; }
            try { send(PING, 0, new byte[8], 0, 8); } catch (IOException e) { close("ping: " + e.getMessage()); return; }
        }
    }

    // (this stream only: one under another number stays)
    private void drop(int id, Stream st) {
        if (st == null) return;
        streams.remove(id, st);
        synchronized (st) { st.gone = true; st.got.clear(); st.held = 0; st.notifyAll(); }
        synchronized (q) { q.notifyAll(); }
        try { st.s.close(); } catch (IOException e) { /* ignore */ }
    }

    void close(String why) {
        synchronized (this) { if (closed) return; closed = true; }
        synchronized (q) { control.clear(); data.clear(); q.notifyAll(); }   // the writer and waiting senders see it
        synchronized (pinger) { pinger.notifyAll(); }                       // and the ping loop, now
        if (port > 0) { LINKS.remove(port, this); TlsProxy.Gate.unmark(port, key); }      // (before the port goes)
        try { if (server != null) server.close(); } catch (IOException e) { /* ignore */ }
        try { link.close(); } catch (IOException e) { /* ignore */ }
        for (Stream st : streams.values()) {
            synchronized (st) { st.gone = true; st.got.clear(); st.held = 0; st.notifyAll(); }
            try { st.s.close(); } catch (IOException e) { /* ignore */ }
        }
        streams.clear();
        if (listener != null) listener.onClosed(why);
    }
}
