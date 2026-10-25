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
 * becomes a stream over the one Bluetooth link. No Android classes, so it runs on any JVM.
 *
 * Link: both sides first send "FLKMUX1\n". Frames: type (1 byte), stream id (4 bytes BE), length (4 bytes BE), payload.
 * 1 OPEN, 2 DATA, 3 FIN, 4 RST, 5 PING, 6 PONG.
 */
final class BtMux {
    interface Listener { void onClosed(String why); }

    static final byte[] MAGIC = {'F', 'L', 'K', 'M', 'U', 'X', '1', '\n'};
    static final int OPEN = 1, DATA = 2, FIN = 3, RST = 4, PING = 5, PONG = 6;
    static final int CHUNK = 32 * 1024;

    private static final class Stream {
        final Socket s;
        volatile boolean localDone, remoteDone;
        Stream(Socket s) { this.s = s; }
    }

    private final InputStream in;
    private final OutputStream out;
    private final Closeable link;
    private final Listener listener;
    private final Map<Integer, Stream> streams = new ConcurrentHashMap<Integer, Stream>();
    private ServerSocket server;
    private int nextId = 1;
    private volatile boolean closed;
    private volatile long lastRx = System.currentTimeMillis();
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
        out.write(MAGIC);
        out.flush();
        byte[] m = new byte[MAGIC.length];
        readFully(in, m, MAGIC.length);
        if (!Arrays.equals(m, MAGIC)) throw new IOException("not Flick");
        synchronized (this) {
            if (closed) throw new IOException("closed");   // close() came during the greeting: no port left open
            server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        }
        thread("flick-bt-tx", new Runnable() { @Override public void run() { writeLoop(); } });
        thread("flick-bt-rx", new Runnable() { @Override public void run() { readLoop(); } });
        thread("flick-bt-accept", new Runnable() { @Override public void run() { acceptLoop(); } });
        thread("flick-bt-ping", new Runnable() { @Override public void run() { pingLoop(); } });
        return server.getLocalPort();
    }

    boolean isClosed() { return closed; }

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
                while (!closed && data.size() >= QUEUED) {
                    try { q.wait(); } catch (InterruptedException e) { throw new InterruptedIOException(); }
                }
            }
            if (closed) throw new IOException("link closed");
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
                s.setTcpNoDelay(true);
                final int id;
                synchronized (this) { id = nextId; nextId += 2; }
                final Stream st = new Stream(s);
                streams.put(id, st);
                send(OPEN, id, null, 0, 0);
                thread("flick-bt-up", new Runnable() { @Override public void run() { pump(id, st); } });
            }
        } catch (IOException e) {
            close("accept: " + e.getMessage());
        }
    }

    // local connection → link
    private void pump(int id, Stream st) {
        byte[] buf = new byte[CHUNK];
        try {
            InputStream li = st.s.getInputStream();
            int n;
            while ((n = li.read(buf)) > 0) send(DATA, id, buf, 0, n);
            st.localDone = true;
            send(FIN, id, null, 0, 0);
            if (st.remoteDone) drop(id, st);
        } catch (IOException e) {
            if (streams.containsKey(id)) { try { send(RST, id, null, 0, 0); } catch (IOException x) { /* link gone */ } }
            drop(id, st);
        }
    }

    // link → local connections
    private void readLoop() {
        byte[] h = new byte[9];
        byte[] buf = new byte[64 * 1024];
        try {
            while (!closed) {
                readFully(in, h, 9);
                lastRx = System.currentTimeMillis();
                int type = h[0] & 0xff;
                int id = ((h[1] & 0xff) << 24) | ((h[2] & 0xff) << 16) | ((h[3] & 0xff) << 8) | (h[4] & 0xff);
                int len = ((h[5] & 0xff) << 24) | ((h[6] & 0xff) << 16) | ((h[7] & 0xff) << 8) | (h[8] & 0xff);
                if (len < 0 || len > buf.length) throw new IOException("bad frame");
                readFully(in, buf, len);
                Stream st = streams.get(id);
                if (type == DATA && st != null && !st.remoteDone) {
                    try { st.s.getOutputStream().write(buf, 0, len); }
                    catch (IOException e) { send(RST, id, null, 0, 0); drop(id, st); }
                } else if (type == FIN && st != null) {
                    st.remoteDone = true;
                    try { st.s.shutdownOutput(); } catch (IOException e) { /* ignore */ }
                    if (st.localDone) drop(id, st);
                } else if (type == RST && st != null) {
                    drop(id, st);
                }
            }
        } catch (IOException e) {
            close("link: " + e.getMessage());
        }
    }

    private void pingLoop() {
        while (!closed) {
            try { synchronized (pinger) { if (!closed) pinger.wait(10000); } } catch (InterruptedException e) { return; }
            if (closed) return;
            if (System.currentTimeMillis() - lastRx > 35000) { close("silent"); return; }
            try { send(PING, 0, new byte[8], 0, 8); } catch (IOException e) { close("ping: " + e.getMessage()); return; }
        }
    }

    private void drop(int id, Stream st) {
        if (streams.remove(id) != null || st != null) { try { st.s.close(); } catch (IOException e) { /* ignore */ } }
    }

    void close(String why) {
        synchronized (this) { if (closed) return; closed = true; }
        synchronized (q) { control.clear(); data.clear(); q.notifyAll(); }   // the writer and waiting senders see it
        synchronized (pinger) { pinger.notifyAll(); }                       // and the ping loop, now
        try { if (server != null) server.close(); } catch (IOException e) { /* ignore */ }
        try { link.close(); } catch (IOException e) { /* ignore */ }
        for (Stream st : streams.values()) { try { st.s.close(); } catch (IOException e) { /* ignore */ } }
        streams.clear();
        if (listener != null) listener.onClosed(why);
    }
}
