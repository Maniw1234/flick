package com.flick.app;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Encrypted links to a PC. The page and the transfer code keep talking plain HTTP and WebSocket, but to a port on
 * 127.0.0.1 (nothing outside the phone can reach it); every connection made to that port is carried to the PC over
 * TLS, and only to a PC whose certificate has the fingerprint this phone pinned when it paired. Any app on the phone, or
 * a web page in its browser, can connect to that port too: only requests that carry the link's key (base(), see Gate)
 * go on to the PC. No Android classes, so it runs (and is tested) on any JVM.
 */
final class TlsProxy {
    /** The PC's certificate isn't the pinned one: someone else is answering at that address, or the PC was reset. */
    static final class PinMismatch extends IOException {
        private static final long serialVersionUID = 1L;
        final String seen;
        PinMismatch(String seen) { super("certificate changed"); this.seen = seen; }
    }

    private static final ConcurrentHashMap<Integer, TlsProxy> OPEN = new ConcurrentHashMap<Integer, TlsProxy>();
    private static final ExecutorService POOL = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-tls"); t.setDaemon(true); return t; }
    });

    final String host;
    final int port;
    final String fp;                    // SHA-256 of the PC's certificate (lowercase hex): every connection must show it
    private final Pin pin;
    private final SSLSocketFactory factory;
    private final ServerSocket server;
    private final String key = Gate.newKey();
    private final Set<Socket> live = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private volatile boolean closed;

    private TlsProxy(String host, int port, String fp, Pin pin, ServerSocket server) throws IOException {
        this.host = host; this.port = port; this.fp = fp; this.pin = pin; this.factory = factory(pin); this.server = server;
    }

    int localPort() { return server.getLocalPort(); }

    /** Where requests to the PC go: "http://127.0.0.1:<port>/k/<key>", then the request's own path. */
    String base() { return "http://127.0.0.1:" + localPort() + prefix(); }

    /** What this relay's requests start their path with: "/k/<key>" (see Gate). */
    String prefix() { return "/k/" + key; }

    /**
     * A local port that leads to host:port over TLS. pin: the fingerprint this phone pinned for that PC, or null on
     * first contact (pairing, or a PC paired without a pin): then the certificate seen now is used for every connection,
     * and the page pins it once the PC has proven who it is. Checks the PC once before returning.
     */
    static TlsProxy open(String host, int port, String pin) throws IOException {
        String want = pin == null || pin.length() == 0 ? null : pin.toLowerCase(java.util.Locale.US);
        for (TlsProxy p : OPEN.values()) {
            if (!p.closed && p.host.equals(host) && p.port == port && (want == null || want.equals(p.fp))) return p;
        }
        // first look: who answers there
        Pin probe = new Pin(want);
        SSLSocket s = null;
        try {
            s = connect(factory(probe), host, port);
        } catch (IOException e) {
            if (probe.mismatch) throw new PinMismatch(probe.seen);
            throw e;
        } finally {
            try { if (s != null) s.close(); } catch (IOException e) { /* ignore */ }
        }
        if (probe.seen == null) throw new IOException("no certificate");
        ServerSocket ss = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        final TlsProxy p;
        try { p = new TlsProxy(host, port, probe.seen, new Pin(probe.seen), ss); }
        catch (IOException e) { try { ss.close(); } catch (IOException x) { /* ignore */ } throw e; }
        Gate.mark(p.localPort(), p.key);
        OPEN.put(p.localPort(), p);
        Thread t = new Thread(new Runnable() { @Override public void run() { p.acceptLoop(); } }, "flick-tls-accept");
        t.setDaemon(true);
        t.start();
        return p;
    }

    static TlsProxy get(int localPort) { return OPEN.get(localPort); }

    static void close(int localPort) {
        TlsProxy p = OPEN.remove(localPort);
        if (p != null) p.close();
    }

    static void closeAll() {
        for (Integer k : OPEN.keySet()) close(k);
    }

    void close() {
        closed = true;
        OPEN.remove(localPort(), this);
        Gate.unmark(localPort(), key);
        try { server.close(); } catch (IOException e) { /* ignore */ }
        for (Socket x : live) quiet(x);
        live.clear();
    }

    private void acceptLoop() {
        while (!closed) {
            final Socket local;
            try { local = server.accept(); } catch (IOException e) { if (closed) return; continue; }
            POOL.execute(new Runnable() { @Override public void run() { carry(local); } });
        }
    }

    /** One local connection, carried to the PC over its own TLS connection until either side closes. */
    private void carry(Socket local) {
        final Gate requests;
        live.add(local);
        try {
            local.setTcpNoDelay(true);
            // its first request comes before anything goes to the PC: one without this link's key ends here
            requests = Gate.first(local, key);
        } catch (IOException e) {
            live.remove(local);
            quiet(local);
            return;
        }
        SSLSocket remote;
        try {
            remote = connect(factory, host, port);
        } catch (IOException e) {
            live.remove(local);
            quiet(local);
            // another certificate answers there now (the PC was reinstalled, or it isn't the PC): this link is done,
            // so the page's next attempt checks again and can say why instead of failing silently forever
            if (pin.mismatch) close();
            return;
        }
        live.add(remote);
        if (closed) { quiet(local); quiet(remote); return; }
        final Socket a = local, b = remote;
        POOL.execute(new Runnable() { @Override public void run() { pump(requests, a, b); } });
        pump(null, b, a);
    }

    // from -> to; in: what to read from's bytes through (null: as they are)
    private void pump(InputStream in, Socket from, Socket to) {
        byte[] buf = new byte[64 * 1024];
        try {
            if (in == null) in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); out.flush(); }
        } catch (IOException e) {
            // closed on one side
        } finally {
            // HTTP and WebSocket don't half-close here: one side done means the connection is done
            quiet(from); quiet(to);
            live.remove(from); live.remove(to);
        }
    }

    /** Connections pinned to the certificate with fingerprint fp (lowercase hex), for code that talks TLS itself (Wire). */
    static SSLSocketFactory pinned(String fp) throws IOException {
        if (fp == null || fp.length() == 0) throw new IOException("no pin");
        return factory(new Pin(fp.toLowerCase(java.util.Locale.US)));
    }

    /** A TLS connection to host:port through f, handshake done. */
    static SSLSocket dial(SSLSocketFactory f, String host, int port) throws IOException { return connect(f, host, port); }

    private static SSLSocket connect(SSLSocketFactory f, String host, int port) throws IOException {
        Socket raw = new Socket();
        try {
            raw.setTcpNoDelay(true);
            Wire.bind(raw, host);                                       // on the PC's network (see Wire.Binder)
            raw.connect(new InetSocketAddress(host, port), 5000);
            raw.setSoTimeout(10000);                                    // for the handshake
            SSLSocket s = (SSLSocket) f.createSocket(raw, host, port, true);
            s.setUseClientMode(true);
            s.startHandshake();
            s.setSoTimeout(0);
            return s;
        } catch (IOException e) {
            quiet(raw);
            throw e;
        }
    }

    private static SSLSocketFactory factory(Pin tm) throws IOException {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{tm}, null);
            return ctx.getSocketFactory();
        } catch (Exception e) {
            throw new IOException("tls: " + e.getMessage());
        }
    }

    private static void quiet(Socket s) { try { if (s != null) s.close(); } catch (IOException e) { /* ignore */ } }

    /**
     * A local connection's requests on their way to the PC (this relay's and BtMux's). Each request's path must start
     * with the relay's key ("/k/<key>/api/hello": a random number made when the relay opens, given only to Flick's page
     * and code), and the key comes out on the way, so the PC gets the requests it always did (a PC on 2.0.0 too). Another
     * app on the phone, or a web page in its browser, can connect to the relay's port (any app can reach 127.0.0.1) but
     * doesn't know the key: its request ends the connection unanswered, and nothing of it reaches the PC. Requests follow
     * one another on a connection (keep-alive): a body goes on by its Content-Length or its chunks; after an upgrade (a
     * WebSocket), everything as it comes.
     */
    static final class Gate extends InputStream {
        static final int HEAD_MS = 10000;                   // a connection's first request must be in by then
        private static final int HEAD_MAX = 32 * 1024;      // a request's line and headers (the PC takes 16 KB)
        private static final int HEAD = 0, BODY = 1, SIZE = 2, TRAILER = 3, RAW = 4;
        private static final java.security.SecureRandom RNG = new java.security.SecureRandom();
        // each open relay's key by its local port, for code that has only the port (Wire, Bridge, BtLink)
        private static final ConcurrentHashMap<Integer, String> KEYS = new ConcurrentHashMap<Integer, String>();

        static String newKey() {
            byte[] b = new byte[16];
            RNG.nextBytes(b);
            StringBuilder s = new StringBuilder(32);
            for (byte x : b) { s.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16)); }
            return s.toString();
        }

        static void mark(int port, String key) { KEYS.put(port, key); }
        static void unmark(int port, String key) { KEYS.remove(port, key); }

        /** What a request to the relay at this local port starts its path with: "/k/<key>" ("" when none is open there). */
        static String prefix(int port) {
            String k = KEYS.get(port);
            return k == null ? "" : "/k/" + k;
        }

        /** The relay's key target (a path and its query) starts with, as prefix() gives it ("/k/<key>"), or "" for none. */
        static String named(String target) {
            if (target == null || target.length() < 35 || !target.startsWith("/k/")) return "";
            for (int i = 3; i < 35; i++) {
                char c = target.charAt(i);
                if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return "";
            }
            if (target.length() > 35 && target.charAt(35) != '/' && target.charAt(35) != '?') return "";
            return target.substring(0, 35);
        }

        /**
         * A plain request to url (http, never through a proxy) goes only to one of this app's relays on this phone, and
         * only while the relay its path names (its key) is open at that port. Once a relay has closed, its port can be
         * any app's (any app may listen on a port of this phone), and the request would hand that app what it carries:
         * the PC's sign-in token, a file. Nothing goes over the network unencrypted either. Throws otherwise.
         */
        static void own(java.net.URL url) throws IOException {
            if (!"127.0.0.1".equals(url.getHost())) throw new IOException("not encrypted");
            String k = prefix(url.getPort());
            if (k.length() == 0 || !k.equals(named(url.getFile()))) throw new IOException("link gone");
        }

        /** target (a path and its query) without the relay's key it may start with. */
        static String strip(String target) {
            if (target == null || target.length() < 35 || !target.startsWith("/k/")) return target;
            for (int i = 3; i < 35; i++) {
                char c = target.charAt(i);
                if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return target;
            }
            String rest = target.substring(35);
            if (rest.length() == 0 || rest.charAt(0) == '?') return "/" + rest;
            return rest.charAt(0) == '/' ? rest : target;
        }

        /** s's first request, checked (all of it within HEAD_MS): what to read s through from now on. */
        static Gate first(Socket s, String key) throws IOException {
            Gate g = new Gate(s.getInputStream(), key);
            g.timer = s;
            g.deadline = System.nanoTime() + HEAD_MS * 1000000L;
            s.setSoTimeout(HEAD_MS);
            if (!g.head()) throw new java.io.EOFException("no request");
            g.timer = null;
            s.setSoTimeout(0);
            return g;
        }

        private final InputStream in;
        private final byte[] want;                          // "/k/<key>"
        private final byte[] buf = new byte[HEAD_MAX];      // read from in, not passed on yet: buf[pos, lim)
        private int pos, lim;
        private byte[] out;                                 // a head (or a chunk's size line) going on: out[at, out.length)
        private int at;
        private int mode = HEAD, after;                     // after: what follows the BODY passed on now
        private long left;                                  // BODY: bytes of it still to come
        private Socket timer;                               // (the first request: it comes whole by deadline, however slowly)
        private long deadline;

        Gate(InputStream in, String key) throws IOException {
            this.in = in;
            this.want = ("/k/" + key).getBytes("US-ASCII");
        }

        // As much as is here, up to len: a request's head with what came with it of its body goes on in one piece (one
        // write, one TLS record), as it came. Waits only when nothing is here yet.
        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len <= 0) return 0;
            int n = 0;
            while (n < len) {
                if (out != null) {
                    int k = Math.min(len - n, out.length - at);
                    System.arraycopy(out, at, b, off + n, k);
                    at += k;
                    n += k;
                    if (at == out.length) out = null;
                    continue;
                }
                if (mode == BODY && left == 0) { mode = after; continue; }
                if (mode == RAW || mode == BODY) {
                    int room = mode == RAW ? len - n : (int) Math.min(len - n, left), k;
                    if (pos < lim) { k = Math.min(room, lim - pos); System.arraycopy(buf, pos, b, off + n, k); pos += k; }
                    else if (n > 0) break;
                    else if ((k = in.read(b, off, room)) < 0) return -1;     // (cut off in the middle: the connection is done)
                    if (mode == BODY) left -= k;
                    n += k;
                    continue;
                }
                if (n > 0) break;                          // (the next head or chunk line: next time, as it may wait)
                boolean more = mode == SIZE ? size() : mode == TRAILER ? trailer() : head();
                if (!more) return -1;
            }
            return n;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n;
            while ((n = read(one, 0, 1)) == 0) { /* (never 0 for 1) */ }
            return n < 0 ? -1 : one[0] & 0xff;
        }

        // more of in after what buf holds (moved to its start): false at the end of the stream
        private boolean fill() throws IOException {
            if (pos > 0) { System.arraycopy(buf, pos, buf, 0, lim - pos); lim -= pos; pos = 0; }
            if (lim == buf.length) throw new IOException("request too long");
            if (timer != null) {
                long ms = (deadline - System.nanoTime()) / 1000000L;
                if (ms <= 0) throw new java.net.SocketTimeoutException("request too slow");
                timer.setSoTimeout((int) ms);
            }
            int n = in.read(buf, lim, buf.length - lim);
            if (n < 0) return false;
            lim += n;
            return true;
        }

        // where the headers that start at pos end (after their empty line), reading more as needed; -1: the stream ended
        private int headersEnd() throws IOException {
            int seen = 0;
            while (true) {
                if (lim - pos >= 2 && buf[pos] == '\r' && buf[pos + 1] == '\n') return pos + 2;     // none at all
                for (int i = pos + Math.max(0, seen - 3); i + 3 < lim; i++) {
                    if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') return i + 4;
                }
                seen = lim - pos;
                if (!fill()) return -1;
            }
        }

        // the next request: its line and headers into out without the key, and how its body comes (false: no more)
        private boolean head() throws IOException {
            while (true) {                                  // (empty lines before a request are skipped, as the PC does)
                while (pos < lim && (buf[pos] == '\r' || buf[pos] == '\n')) pos++;
                if (pos < lim) break;
                if (!fill()) return false;
            }
            int end = headersEnd();
            if (end < 0) throw new java.io.EOFException("request cut off");
            // (its lines end in CR LF, and nothing else in it does: each line here is the line the PC reads)
            for (int i = pos; i < end; i++) {
                if (buf[i] == '\n' && buf[i - 1] != '\r') throw refused();
                if (buf[i] == '\r' && buf[i + 1] != '\n') throw refused();
            }
            int eol = pos;
            while (buf[eol] != '\r') eol++;
            // "<method> <path> HTTP/1.x", the path starting with the key
            int sp1 = indexOf(' ', pos, eol), sp2 = sp1 < 0 ? -1 : indexOf(' ', sp1 + 1, eol);
            if (sp1 <= pos || sp2 < 0 || indexOf(' ', sp2 + 1, eol) >= 0 || !ascii(sp2 + 1, eol).startsWith("HTTP/1.")) throw refused();
            int t = sp1 + 1, k = t + want.length;
            if (k > sp2) throw refused();
            int diff = 0;
            for (int i = 0; i < want.length; i++) diff |= buf[t + i] ^ want[i];      // (as long whatever differs)
            if (diff != 0 || (k < sp2 && buf[k] != '/' && buf[k] != '?')) throw refused();
            boolean slash = k == sp2 || buf[k] == '?';
            // how its body comes
            long length = -1;
            boolean chunked = false, upgrade = false, connUpgrade = false;
            for (int l = eol + 2; l < end - 2; ) {
                int e = l;
                while (buf[e] != '\r') e++;
                int colon = indexOf(':', l, e);
                if (colon <= l || buf[l] == ' ' || buf[l] == '\t') throw refused();
                String name = ascii(l, colon).trim().toLowerCase(java.util.Locale.US), value = ascii(colon + 1, e).trim();
                if (name.equals("content-length")) {
                    if (value.length() == 0 || value.length() > 18) throw refused();
                    for (int i = 0; i < value.length(); i++) if (value.charAt(i) < '0' || value.charAt(i) > '9') throw refused();
                    long n = Long.parseLong(value);
                    if (length >= 0 && n != length) throw refused();
                    length = n;
                } else if (name.equals("transfer-encoding")) {
                    String last = value.substring(value.lastIndexOf(',') + 1).trim();
                    if (!last.equalsIgnoreCase("chunked")) throw refused();
                    chunked = true;
                } else if (name.equals("upgrade")) {
                    upgrade = value.length() > 0;
                } else if (name.equals("connection")) {
                    connUpgrade |= value.toLowerCase(java.util.Locale.US).contains("upgrade");
                }
                l = e + 2;
            }
            if (chunked && length >= 0) throw refused();
            // on its way: the head as it came, the key taken out of the path
            byte[] h = new byte[end - pos - want.length + (slash ? 1 : 0)];
            int n = t - pos;
            System.arraycopy(buf, pos, h, 0, n);
            if (slash) h[n++] = '/';
            System.arraycopy(buf, k, h, n, end - k);
            out = h;
            at = 0;
            pos = end;
            if (upgrade && connUpgrade) mode = RAW;
            else if (chunked) mode = SIZE;
            else if (length > 0) { mode = BODY; left = length; after = HEAD; }
            else mode = HEAD;
            return true;
        }

        // a chunk's size line, as it is; then its bytes and the line end after them, or after the last, the trailer
        private boolean size() throws IOException {
            int e = pos;
            while (true) {
                while (e < lim && buf[e] != '\n') e++;
                if (e < lim) break;
                e -= pos;
                if (!fill()) throw new java.io.EOFException("chunk cut off");
                e += pos;
            }
            long n = 0;
            int digits = 0;
            for (int i = pos; i < e; i++) {
                int d = Character.digit(buf[i], 16);
                if (d < 0) break;
                if (++digits > 15) throw refused();
                n = n * 16 + d;
            }
            if (digits == 0) throw refused();
            out = java.util.Arrays.copyOfRange(buf, pos, e + 1);
            at = 0;
            pos = e + 1;
            if (n == 0) mode = TRAILER;
            else { mode = BODY; left = n + 2; after = SIZE; }
            return true;
        }

        // after the last chunk: its trailer fields, if any, and the empty line; the next request follows
        private boolean trailer() throws IOException {
            int end = headersEnd();
            if (end < 0) throw new java.io.EOFException("chunks cut off");
            out = java.util.Arrays.copyOfRange(buf, pos, end);
            at = 0;
            pos = end;
            mode = HEAD;
            return true;
        }

        private int indexOf(char c, int from, int to) {
            for (int i = from; i < to; i++) if (buf[i] == c) return i;
            return -1;
        }

        private String ascii(int from, int to) {
            try { return new String(buf, from, to - from, "ISO-8859-1"); } catch (java.io.UnsupportedEncodingException e) { return ""; }
        }

        private static IOException refused() { return new IOException("refused"); }

        @Override public int available() throws IOException { return out != null ? out.length - at : 0; }
        @Override public void close() throws IOException { in.close(); }
    }

    /** Accepts exactly one certificate (by fingerprint); with no fingerprint yet, records the one it sees. */
    static final class Pin implements X509TrustManager {
        final String expect;
        volatile String seen;
        volatile boolean mismatch;

        Pin(String expect) { this.expect = expect; }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
            String fp = sha256(chain[0].getEncoded());
            seen = fp;
            if (expect != null && !expect.equals(fp)) { mismatch = true; throw new CertificateException("certificate changed"); }
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    static String sha256(byte[] b) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
            StringBuilder s = new StringBuilder(64);
            for (byte x : d) s.append(String.format("%02x", x));
            return s.toString();
        } catch (Exception e) { return ""; }
    }
}
