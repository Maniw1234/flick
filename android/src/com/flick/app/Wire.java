package com.flick.app;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.Charset;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * One HTTP/1.1 request to a PC: TLS pinned to the PC's certificate, or plain to a port on this phone (the Bluetooth
 * link, which encrypts by itself). Sends use it instead of the local proxy the page goes through: a file's bytes go
 * straight onto the PC's connection in large writes, and any thread can cut a request by closing it. A request that got
 * its whole answer leaves its connection for the next one to the same PC (the PC keeps an idle one 30 s), so a send's
 * few requests (have, part, commit) don't each pay a TCP and a TLS handshake: over Wi-Fi those were most of a photo's
 * time. No Android classes, so it runs on any JVM.
 */
final class Wire {
    static volatile int CONNECT_MS = 5000;
    static volatile boolean KEEP = true;                // keep connections for the next request (tests can turn it off)
    private static final long IDLE_MS = 8000;           // a kept connection is used again only this long (the PC: 30 s)
    private static final int IDLE_MAX = 8;              // kept per PC (a large file's parts use up to 6 at once)
    private static final int FIRST_MS = 4000;           // a kept connection's answer must begin this soon (see call, fetch)
    static final long CHUNKED = -1, NO_BODY = -2;
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final byte[] CRLF = {'\r', '\n'};

    private Wire() {}

    /**
     * Milliseconds on a clock that only moves forward: setting the phone's clock (or network time correcting it) doesn't
     * move it, so a wait measured on it ends when it should. On Android it counts deep sleep too (Sends sets it to
     * SystemClock.elapsedRealtime): a wait that ran out while the phone slept is over when it wakes, as with the wall
     * clock. Until then, and on any JVM, System.nanoTime.
     */
    interface Clock { long ms(); }
    private static volatile Object[] CLOCK;              // {Clock, shift}: shift keeps mono() going on from where it was

    static long mono() {
        Object[] c = CLOCK;
        return c == null ? System.nanoTime() / 1000000L : ((Clock) c[0]).ms() + (Long) c[1];
    }

    /** Measures waits with c from now on (carrying on from the clock before: waits under way stay as long). */
    static synchronized void clock(Clock c) {
        long was = mono();
        CLOCK = new Object[]{c, was - c.ms()};
    }

    /**
     * What lets a transfer's Cancel or Pause cut its request at once, from another thread (Outbox's: Watchdog under the
     * transfer's flag). Each connection the request makes is given to watch(), which returns what to close once the
     * request is done with it; cut(): it was cut (or is to be).
     */
    interface Cutter {
        Closeable watch(Closeable c);
        boolean cut();
    }

    private static void done(Closeable w) { if (w != null) try { w.close(); } catch (IOException e) { /* ignore */ } }

    /**
     * Puts a socket on the network a PC is on before it connects (Sends sets one on Android, see Sends.Nets). Android
     * sends a socket over its default network, which isn't the PC's Wi-Fi when that has no internet (a laptop's hotspot
     * while the laptop is offline) and mobile data is on: the PC's address can't be reached there.
     */
    interface Binder { void bind(Socket s, String host) throws IOException; }
    static volatile Binder BINDER;

    /** Binds s (not connected yet) to the network that reaches host, if it needs that; as it is when that fails. */
    static void bind(Socket s, String host) {
        Binder b = BINDER;
        if (b == null || host == null || host.startsWith("127.")) return;          // (a port on this phone)
        try { b.bind(s, host); } catch (Throwable e) { /* the default network, as before */ }
    }

    /** The same for a UDP socket (other phones' discovery): true if it was put on another network than the default. */
    interface UdpBinder { boolean bind(java.net.DatagramSocket s, String host) throws IOException; }
    static volatile UdpBinder UDP_BINDER;
    static boolean bind(java.net.DatagramSocket s, String host) {
        UdpBinder b = UDP_BINDER;
        if (b == null || host == null || host.startsWith("127.")) return false;
        try { return b.bind(s, host); } catch (Throwable e) { return false; }
    }

    /** Whether address a is in the subnet net/prefix (both the same family, as raw bytes). */
    static boolean inSubnet(byte[] net, int prefix, byte[] a) {
        if (net == null || a == null || net.length != a.length || prefix < 0 || prefix > net.length * 8) return false;
        int whole = prefix / 8, rest = prefix % 8;
        for (int i = 0; i < whole; i++) if (net[i] != a[i]) return false;
        if (rest == 0) return true;
        int mask = (0xff << (8 - rest)) & 0xff;
        return (net[whole] & mask) == (a[whole] & mask);
    }

    /**
     * How to reach a PC: host:port, and the fingerprint its certificate must show (null: plain, to one of this app's
     * relays on this phone, the Bluetooth link's).
     */
    static final class Link {
        final String host;
        final int port;
        final String pin;
        // (plain) the relay it goes through: its key as requests carry it ("/k/<key>", see TlsProxy.Gate; "" for none)
        final String relay;
        private SSLSocketFactory factory;

        /** A plain link (pin null) goes through the relay open at that port now. */
        Link(String host, int port, String pin) { this(host, port, pin, null); }

        /** relay: for a plain link, the key of the relay it goes through (null: the one open at that port now). */
        Link(String host, int port, String pin, String relay) {
            this.host = host;
            this.port = port;
            this.pin = pin == null || pin.length() == 0 ? null : pin.toLowerCase(Locale.US);
            this.relay = this.pin != null ? null : relay != null ? relay : TlsProxy.Gate.prefix(port);
        }

        private synchronized SSLSocketFactory factory() throws IOException {
            if (factory == null) factory = TlsProxy.pinned(pin);
            return factory;
        }

        // (plain) its relay is open at its port now: once that relay closed, the port can be any app's (any app may listen
        // on a port of this phone), which would get what the request carries, the PC's sign-in token and the file
        private boolean relayHere() { return relay.length() > 0 && relay.equals(TlsProxy.Gate.prefix(port)); }

        /** {the socket to talk over, the TCP socket under it} (the same one when plain). */
        Socket[] dial() throws IOException { return dial(null); }

        /** stop: (may be null) the transfer's Cutter: its Cancel ends the connecting at once (a vanished PC takes CONNECT_MS). */
        Socket[] dial(Cutter stop) throws IOException {
            // nothing goes over the network unencrypted: plain only to a port on this phone, and only to its relay
            if (pin == null && !"127.0.0.1".equals(host)) throw new IOException("not encrypted");
            if (pin == null && !relayHere()) throw new IOException("link gone");
            Socket raw = new Socket();
            Closeable g = stop != null ? stop.watch(raw) : null;
            try {
                raw.setTcpNoDelay(true);
                bind(raw, host);
                raw.connect(new InetSocketAddress(host, port), CONNECT_MS);
                if (pin == null) {
                    // (still open now it's connected: one closing meanwhile gives up its key first, then its port)
                    if (!relayHere()) throw new IOException("link gone");
                    return new Socket[]{raw, raw};
                }
                raw.setSoTimeout(10000);                                    // for the handshake
                SSLSocket s = (SSLSocket) factory().createSocket(raw, host, port, true);
                s.setUseClientMode(true);
                s.startHandshake();                                         // the pin is checked here
                s.setSoTimeout(0);
                return new Socket[]{s, raw};
            } catch (IOException e) {
                try { raw.close(); } catch (IOException x) { /* ignore */ }
                throw e;
            } finally {
                done(g);
            }
        }

        boolean same(Link o) {
            return o != null && o.host.equals(host) && o.port == port && (pin == null ? o.pin == null && relay.equals(o.relay) : pin.equals(o.pin));
        }

        // (a kept connection is used again only for the same relay: never another one that took the port later)
        String key() { return host + ":" + port + ":" + pin + (relay != null ? relay : ""); }

        @Override public String toString() { return host + ":" + port; }
    }

    /** An open connection to a PC: the socket to talk over, the TCP socket under it, and their buffered streams. */
    private static final class Conn {
        final Socket s, tcp;
        final OutputStream raw;
        final InputStream in;
        final String key;
        long since;                                     // when it finished its last request (kept idle since; mono())

        Conn(Socket[] ss, String key) throws IOException {
            this.s = ss[0];
            this.tcp = ss[1];
            this.key = key;
            try {
                this.raw = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
                this.in = new BufferedInputStream(s.getInputStream(), 16 * 1024);
            } catch (IOException e) { close(); throw e; }
        }

        void close() { try { tcp.close(); } catch (IOException e) { /* ignore */ } }
    }

    private static final Map<String, ArrayDeque<Conn>> IDLE = new HashMap<String, ArrayDeque<Conn>>();

    /** A kept connection to this PC that's fresh enough, or null. */
    private static Conn take(Link l) {
        String key = l.key();
        long now = mono();
        synchronized (IDLE) {
            ArrayDeque<Conn> q = IDLE.get(key);
            while (q != null && !q.isEmpty()) {
                Conn k = q.pollLast();                  // the last one used: the least likely to have been closed
                if (now - k.since < IDLE_MS && !k.tcp.isClosed()) return k;
                k.close();
            }
        }
        return null;
    }

    private static void keep(Conn k) {
        synchronized (IDLE) {
            // kept ones past their use are closed here: those to an address nothing asks for any more (the PC's
            // address changed) were never taken again, so they stayed for good, each with its socket and buffers
            long now = mono();
            for (java.util.Iterator<ArrayDeque<Conn>> it = IDLE.values().iterator(); it.hasNext(); ) {
                ArrayDeque<Conn> old = it.next();
                while (!old.isEmpty() && now - old.peekFirst().since >= IDLE_MS) old.pollFirst().close();
                if (old.isEmpty()) it.remove();
            }
            ArrayDeque<Conn> q = IDLE.get(k.key);
            if (q == null) IDLE.put(k.key, q = new ArrayDeque<Conn>());
            k.since = mono();
            q.addLast(k);
            while (q.size() > IDLE_MAX) q.pollFirst().close();
        }
    }

    /** Closes every kept connection (the PC changed, say). */
    static void forget() {
        synchronized (IDLE) {
            for (ArrayDeque<Conn> q : IDLE.values()) for (Conn k : q) k.close();
            IDLE.clear();
        }
    }

    /** The PC's answer: its status and body (JSON for everything a send asks). */
    static final class Answer {
        final int code;
        final String body;
        Answer(int code, String body) { this.code = code; this.body = body; }
        JSONObject json() {
            try { return new JSONObject(body); } catch (Throwable e) { return new JSONObject(); }
        }
        String error() { return json().optString("error", ""); }
    }

    /**
     * A request on its way. open() sends the request line and headers; body() takes the body (exactly length bytes, or
     * any number when length is CHUNKED); answer() finishes it and reads the PC's reply. close() ends it at once, from
     * any thread (a write blocked on a vanished PC included).
     */
    static final class Call implements Closeable {
        private final Conn k;
        private final OutputStream raw;
        private final InputStream in;
        private final long length;
        final boolean reused;                           // over a kept connection
        private long written;
        private OutputStream body;
        private volatile boolean heard;                 // the PC's answer began
        private boolean answered, keepIt, released;     // all of the answer read; the PC keeps the connection open; done
        private int readMs;                             // how long the PC may take to answer
        private int firstMs;                            // (> 0) how long a kept connection may stay silent before the answer

        private Call(Conn k, boolean reused, long length, int readMs) {
            this.k = k;
            this.reused = reused;
            this.length = length;
            this.readMs = readMs;
            this.raw = k.raw;
            this.in = k.in;
        }

        /** readMs: how long the PC may take to answer once the body is through. */
        static Call open(Link l, String method, String target, long length, String type, int readMs) throws IOException {
            return open(l, method, target, length, type, readMs, null, false);
        }

        /** headers: more request headers, as "Name: value" lines each ending in \r\n (e.g. a Range), or null. */
        static Call open(Link l, String method, String target, long length, String type, int readMs, String headers) throws IOException {
            return open(l, method, target, length, type, readMs, headers, false);
        }

        /** fresh: over a new connection (not a kept one). */
        static Call open(Link l, String method, String target, long length, String type, int readMs, String headers, boolean fresh) throws IOException {
            return open(l, method, target, length, type, readMs, headers, fresh, null);
        }

        /** stop: (may be null) the transfer's Cutter: its Cancel ends a connecting to a PC that doesn't answer. */
        static Call open(Link l, String method, String target, long length, String type, int readMs, String headers, boolean fresh, Cutter stop) throws IOException {
            // a port on this phone is a relay (the Bluetooth link's): every request to it carries its key (TlsProxy.Gate),
            // the key of the relay the link goes through (dial goes nowhere else; nor does a kept connection to it, once
            // it closed)
            if (l.pin == null) {
                if (!l.relayHere()) throw new IOException("link gone");
                target = l.relay + TlsProxy.Gate.strip(target);
            }
            StringBuilder h = new StringBuilder(target.length() + 160);
            h.append(method).append(' ').append(target).append(" HTTP/1.1\r\n");
            // the PC takes requests addressed to an IP (a web page can't make those through DNS tricks)
            String host = !isIp(l.host) ? "127.0.0.1" : l.host.indexOf(':') >= 0 ? "[" + l.host + "]" : l.host;
            h.append("Host: ").append(host).append(':').append(l.port).append("\r\n");
            if (!KEEP) h.append("Connection: close\r\n");
            if (length >= 0) h.append("Content-Length: ").append(length).append("\r\n");
            else if (length == CHUNKED) h.append("Transfer-Encoding: chunked\r\n");
            if (type != null) h.append("Content-Type: ").append(type).append("\r\n");
            if (headers != null) h.append(headers);
            h.append("\r\n");
            byte[] head = h.toString().getBytes(UTF8);
            Conn k = KEEP && !fresh ? take(l) : null;
            if (k != null) {
                try { return start(k, true, length, readMs, head); }
                catch (IOException e) { /* the PC had closed it: a new one */ }
            }
            return start(new Conn(l.dial(stop), l.key()), false, length, readMs, head);
        }

        private static Call start(Conn k, boolean reused, long length, int readMs, byte[] head) throws IOException {
            try {
                k.s.setSoTimeout(readMs);
                Call c = new Call(k, reused, length, readMs);
                c.raw.write(head);
                if (length <= 0) c.raw.flush();
                return c;
            } catch (IOException e) {
                k.close();
                throw e;
            }
        }

        OutputStream body() {
            if (body == null) {
                body = new OutputStream() {
                    @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }
                    @Override
                    public void write(byte[] b, int off, int len) throws IOException {
                        if (len <= 0) return;
                        if (length >= 0) {
                            if (written + len > length) throw new IOException("body too long");
                            raw.write(b, off, len);
                        } else if (length == CHUNKED) {
                            raw.write((Integer.toHexString(len) + "\r\n").getBytes(UTF8));
                            raw.write(b, off, len);
                            raw.write(CRLF);
                        } else {
                            throw new IOException("no body");
                        }
                        written += len;
                    }
                    @Override public void flush() throws IOException { raw.flush(); }
                    @Override public void close() { /* answer() ends the body */ }
                };
            }
            return body;
        }

        long written() { return written; }

        /** The PC's answer began (over a kept connection: the PC hadn't closed it). */
        boolean heard() { return heard; }

        /** Ends the body and reads the PC's answer (at most max bytes of it are kept). */
        Answer answer(int max) throws IOException {
            endBody();
            return read(max, true);
        }

        private boolean ended;

        /** The body is all written (a chunked one's end too) and on its way. */
        void endBody() throws IOException {
            if (ended) return;
            if (length >= 0 && written != length) throw new IOException("body short");
            if (length == CHUNKED) raw.write("0\r\n\r\n".getBytes(UTF8));
            raw.flush();
            ended = true;
        }

        /**
         * Ends the body and waits up to ms for the PC's answer to begin: true once it has (nothing of it is read yet:
         * answer() reads it), false when it hasn't by then. What was written can still be on its way when the last write
         * returns (the system's buffers: megabytes over a slow link), and the PC answers only once it's all in: a caller
         * that knows how far the PC got waits as long as that keeps growing, instead of a fixed time from the last write.
         */
        boolean answerWithin(int ms) throws IOException {
            endBody();
            k.s.setSoTimeout(Math.max(1, ms));
            try {
                in.mark(1);
                if (in.read() < 0) throw new IOException("no answer");
                in.reset();
                return true;
            } catch (java.net.SocketTimeoutException e) {
                return false;
            } finally {
                try { k.s.setSoTimeout(readMs); } catch (IOException e) { /* closed: the next read says so */ }
            }
        }

        /**
         * The body couldn't be written (the connection broke): the PC may have answered before it closed it (no space
         * on it, a send it canceled), and that answer says more than "cut off". Null when there's none to read.
         */
        Answer answerAfterCut(int max) {
            try {
                k.s.setSoTimeout(1500);
                return read(max, false);
            } catch (Throwable e) { return null; }
        }

        /** bodyDone: the request went out whole (else the connection can't take another one). */
        private Answer read(int max, boolean bodyDone) throws IOException {
            while (true) {
                if (firstMs > 0 && !heard) k.s.setSoTimeout(firstMs);
                String status = line(in);
                if (status == null) throw new IOException("no answer");
                if (firstMs > 0 && !heard) k.s.setSoTimeout(readMs);
                heard = true;
                int code = statusCode(status);
                long clen = -1;
                boolean chunked = false, close = false;
                String h;
                while ((h = line(in)) != null && h.length() > 0) {
                    int colon = h.indexOf(':');
                    if (colon <= 0) continue;
                    String name = h.substring(0, colon).trim().toLowerCase(Locale.US), value = h.substring(colon + 1).trim();
                    if (name.equals("content-length")) { try { clen = Long.parseLong(value); } catch (NumberFormatException e) { throw new IOException("bad answer"); } }
                    else if (name.equals("transfer-encoding") && value.toLowerCase(Locale.US).contains("chunked")) chunked = true;
                    else if (name.equals("connection") && value.toLowerCase(Locale.US).contains("close")) close = true;
                }
                if (h == null) throw new IOException("answer cut off");
                if (code == 100) continue;                       // "go on": the real answer follows
                Answer a = new Answer(code, new String(readBody(in, clen, chunked, max), UTF8));
                // read to its end: the connection can take the next request, unless the PC closes it
                synchronized (this) { answered = clen >= 0 || chunked; keepIt = bodyDone && !close; }
                return a;
            }
        }

        /** For a GET: reads the status and headers; the body follows on the returned stream (Content-Length long). */
        InputStream respond(int[] code, long[] len) throws IOException { return respond(code, len, null); }

        /** The same; range[0] gets the Content-Range header, if there is one. */
        InputStream respond(int[] code, long[] len, String[] range) throws IOException {
            raw.flush();
            // a kept connection the PC (or the phone's network) dropped meanwhile stays silent: a few seconds only (fetch()
            // then asks again over a new one); the PC answers a GET at once
            boolean quick = reused && !heard;
            if (quick) k.s.setSoTimeout(Math.min(readMs, FIRST_MS));
            String status = line(in);
            if (status == null) throw new IOException("no answer");
            if (quick) k.s.setSoTimeout(readMs);
            heard = true;
            code[0] = statusCode(status);
            len[0] = -1;
            String h;
            while ((h = line(in)) != null && h.length() > 0) {
                int colon = h.indexOf(':');
                if (colon <= 0) continue;
                String name = h.substring(0, colon).trim();
                if (name.equalsIgnoreCase("content-length")) {
                    try { len[0] = Long.parseLong(h.substring(colon + 1).trim()); } catch (NumberFormatException e) { /* unknown */ }
                } else if (range != null && name.equalsIgnoreCase("content-range")) range[0] = h.substring(colon + 1).trim();
                else if (name.equalsIgnoreCase("connection") && h.substring(colon + 1).toLowerCase(Locale.US).contains("close")) closeAfter = true;
            }
            if (h == null) throw new IOException("answer cut off");
            return in;
        }

        private boolean closeAfter;                     // the PC said it closes the connection after this answer

        /**
         * The body of an answer respond() began: exactly len bytes (len >= 0), after which it ends. Read to its end, the
         * connection can take the next request; closing this stream leaves the connection to close().
         */
        InputStream body(final long len) {
            final InputStream src = in;
            return new InputStream() {
                long left = len;
                private void end() { if (left == 0) synchronized (Call.this) { answered = true; keepIt = !closeAfter && Math.max(0, length) == written; } }
                @Override public int read() throws IOException {
                    if (len >= 0 && left <= 0) { end(); return -1; }
                    int r = src.read();
                    if (r >= 0 && len >= 0) { left--; end(); }
                    return r;
                }
                @Override public int read(byte[] b, int off, int n) throws IOException {
                    if (n == 0) return 0;
                    if (len >= 0 && left <= 0) { end(); return -1; }
                    int r = src.read(b, off, len >= 0 ? (int) Math.min(n, left) : n);
                    if (r > 0 && len >= 0) { left -= r; end(); }
                    if (r < 0 && len >= 0 && left > 0) throw new IOException("answer cut off");
                    return r;
                }
                @Override public int available() throws IOException { return len >= 0 ? (int) Math.min(src.available(), left) : src.available(); }
                @Override public void close() { /* the connection is close()'s */ }
            };
        }

        Socket socket() { return k.s; }

        /**
         * A GET whose status and headers have been read (respond()), over a kept connection when there is one. A kept
         * one that stays silent (the PC went away meanwhile, or the phone's network changed under it) is given up after
         * a few seconds and the request goes once more over a new connection, instead of failing after the full read
         * time. The body follows with body(len[0]); close() at the end.
         */
        static Call fetch(Link l, String target, String headers, int readMs, int[] code, long[] len, String[] range) throws IOException {
            for (int attempt = 0; ; attempt++) {
                Call c = open(l, "GET", target, NO_BODY, null, readMs, headers, attempt > 0);
                try {
                    c.respond(code, len, range);
                    return c;
                } catch (IOException e) {
                    c.close();
                    if (c.reused && !c.heard && attempt == 0) continue;
                    throw e;
                }
            }
        }

        /**
         * Ends it at once, from any thread: the TCP connection under it is closed, which also ends a write that is
         * stuck on a PC that vanished (closing the TLS layer itself would wait for that write to finish first).
         */
        @Override
        public void close() {
            boolean reuse;
            synchronized (this) {
                if (released) return;
                released = true;
                reuse = KEEP && answered && keepIt;
            }
            // a finished request leaves its connection for the next one; anything else (a cut, a request that never got
            // its whole answer, a download read by its caller) closes it
            if (reuse) keep(k); else k.close();
        }
    }

    static final int PIECE = 64 * 1024;

    /**
     * o, written to in pieces of at most 64 KB. A stall watchdog (Watchdog.Guard.watch) counts a write as progress once
     * it returns, and over a slow link one large write is taken in only as the system's buffers drain: 512 KB at 15
     * KB/s is 34 s, longer than the stall limit, for a link that's moving.
     */
    static OutputStream pieces(OutputStream o) {
        return new java.io.FilterOutputStream(o) {
            @Override public void write(byte[] b, int off, int len) throws IOException {
                while (len > 0) { int n = Math.min(len, PIECE); out.write(b, off, n); off += n; len -= n; }
            }
        };
    }

    /** A request with a small body (or none), answered in full. */
    static Answer call(Link l, String method, String target, byte[] body, String type, int readMs) throws IOException {
        return call(l, method, target, body, type, readMs, null);
    }

    /**
     * The same for a transfer: stop (may be null) is its Cutter, and its Cancel or Pause ends the request at once,
     * however long the PC would take to answer.
     */
    static Answer call(Link l, String method, String target, byte[] body, String type, int readMs, Cutter stop) throws IOException {
        for (int attempt = 0; ; attempt++) {
            if (stop != null && stop.cut()) throw new IOException("stopped");
            Call c = Call.open(l, method, target, body == null ? NO_BODY : body.length, type, readMs, null, attempt > 0, stop);
            Closeable g = stop != null ? stop.watch(c) : null;
            // a kept connection to a PC that vanished meanwhile would stay silent until the read timeout: given a few
            // seconds only, then the request goes once more over a new one (which fails at once if the PC is gone)
            if (c.reused) c.firstMs = Math.min(readMs, FIRST_MS);
            try {
                if (body != null && body.length > 0) c.body().write(body);
                return c.answer(1024 * 1024);
            } catch (IOException e) {
                if (stop != null && stop.cut()) throw new IOException("stopped");
                // a kept connection the PC had closed meanwhile: once more over a new one (nothing was answered)
                if (c.reused && !c.heard && attempt == 0) continue;
                throw e;
            } finally {
                done(g);
                c.close();
            }
        }
    }

    static Answer get(Link l, String target, int readMs) throws IOException { return call(l, "GET", target, null, null, readMs); }

    /** A GET for a transfer: its Cancel ends it at once (see call). */
    static Answer get(Link l, String target, int readMs, Cutter stop) throws IOException { return call(l, "GET", target, null, null, readMs, stop); }

    static Answer postJson(Link l, String target, String json, int readMs) throws IOException {
        return postJson(l, target, json, readMs, null);
    }

    static Answer postJson(Link l, String target, String json, int readMs, Cutter stop) throws IOException {
        return call(l, "POST", target, json.getBytes(UTF8), "application/json; charset=utf-8", readMs, stop);
    }

    // ------------------------------------------------------------ reading
    private static int statusCode(String status) throws IOException {
        // "HTTP/1.1 200 OK"
        int sp = status.indexOf(' ');
        if (!status.startsWith("HTTP/") || sp < 0 || status.length() < sp + 4) throw new IOException("bad answer");
        try { return Integer.parseInt(status.substring(sp + 1, sp + 4)); } catch (NumberFormatException e) { throw new IOException("bad answer"); }
    }

    /** One header line without its line end; null at the end of the stream. */
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(64);
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (b.size() > 16 * 1024) throw new IOException("header too long");
            b.write(c);
        }
        if (c < 0 && b.size() == 0) return null;
        String s = new String(b.toByteArray(), UTF8);
        return s.endsWith("\r") ? s.substring(0, s.length() - 1) : s;
    }

    private static byte[] readBody(InputStream in, long clen, boolean chunked, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(clen > 0 && clen < max ? (int) clen : 256);
        byte[] buf = new byte[8192];
        if (chunked) {
            while (true) {
                String sz = line(in);
                if (sz == null) throw new IOException("answer cut off");
                int semi = sz.indexOf(';');
                long n;
                try { n = Long.parseLong((semi >= 0 ? sz.substring(0, semi) : sz).trim(), 16); } catch (NumberFormatException e) { throw new IOException("bad chunk"); }
                if (n == 0) {
                    String t;
                    while ((t = line(in)) != null && t.length() > 0) { /* trailers */ }
                    break;
                }
                copy(in, out, n, max, buf);
                if (line(in) == null) throw new IOException("answer cut off");
            }
        } else if (clen >= 0) {
            copy(in, out, clen, max, buf);
        } else {
            int r;
            while ((r = in.read(buf)) > 0) if (out.size() < max) out.write(buf, 0, Math.min(r, max - out.size()));
        }
        return out.toByteArray();
    }

    private static void copy(InputStream in, ByteArrayOutputStream out, long n, int max, byte[] buf) throws IOException {
        while (n > 0) {
            int r = in.read(buf, 0, (int) Math.min(buf.length, n));
            if (r < 0) throw new IOException("answer cut off");
            if (out.size() < max) out.write(buf, 0, Math.min(r, max - out.size()));
            n -= r;
        }
    }

    /**
     * A URL the page made for a local port (http://127.0.0.1:<port>/k/<key>/...): the PC behind it, reached directly.
     * An encrypted link's port (TlsProxy) becomes the PC's own address with the same pin; any other local port (the
     * Bluetooth link) stays as it is. Either only while the relay the URL names (its key) is open there: one that closed
     * may have left its port to another app, or to another relay of this app's, to another PC (the link then goes
     * nowhere: see Link.dial). {link, target (path and query, without the relay's key: open() puts it back where it's
     * needed)}, or null for anything else.
     */
    static Object[] direct(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            if (!"http".equals(u.getProtocol()) || !"127.0.0.1".equals(u.getHost()) || u.getPort() <= 0) return null;
            String target = TlsProxy.Gate.strip(u.getFile()), named = TlsProxy.Gate.named(u.getFile());
            TlsProxy p = TlsProxy.get(u.getPort());
            Link l = p != null && named.length() > 0 && named.equals(p.prefix()) ? new Link(p.host, p.port, p.fp) : new Link("127.0.0.1", u.getPort(), null, named);
            return new Object[]{l, target};
        } catch (Exception e) { return null; }
    }

    static boolean isIp(String h) {
        if (h == null) return false;
        if (h.indexOf(':') >= 0) return true;                       // IPv6
        String[] p = h.split("\\.");
        if (p.length != 4) return false;
        for (String x : p) {
            if (x.length() == 0 || x.length() > 3) return false;
            for (int i = 0; i < x.length(); i++) if (x.charAt(i) < '0' || x.charAt(i) > '9') return false;
        }
        return true;
    }

    static String enc(String s) {
        try { return java.net.URLEncoder.encode(s == null ? "" : s, "UTF-8").replace("+", "%20"); }
        catch (java.io.UnsupportedEncodingException e) { return ""; }
    }
}
