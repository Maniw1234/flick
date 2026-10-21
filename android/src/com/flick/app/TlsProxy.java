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
 * TLS, and only to a PC whose certificate has the fingerprint this phone pinned when it paired. No Android classes,
 * so it runs (and is tested) on any JVM.
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
    private final SSLSocketFactory factory;
    private final ServerSocket server;
    private final Set<Socket> live = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private volatile boolean closed;

    private TlsProxy(String host, int port, String fp, SSLSocketFactory factory, ServerSocket server) {
        this.host = host; this.port = port; this.fp = fp; this.factory = factory; this.server = server;
    }

    int localPort() { return server.getLocalPort(); }

    /**
     * A local port that leads to host:port over TLS. pin: the fingerprint this phone pinned for that PC, or null on
     * first contact (pairing, or a PC paired before 1.9): then the certificate seen now is used for every connection,
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
        final TlsProxy p = new TlsProxy(host, port, probe.seen, factory(new Pin(probe.seen)), ss);
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
        SSLSocket remote;
        try {
            local.setTcpNoDelay(true);
            remote = connect(factory, host, port);
        } catch (IOException e) {
            quiet(local);
            return;
        }
        live.add(local);
        live.add(remote);
        if (closed) { quiet(local); quiet(remote); return; }
        final Socket a = local, b = remote;
        POOL.execute(new Runnable() { @Override public void run() { pump(a, b); } });
        pump(b, a);
    }

    private void pump(Socket from, Socket to) {
        byte[] buf = new byte[64 * 1024];
        try {
            InputStream in = from.getInputStream();
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

    private static SSLSocket connect(SSLSocketFactory f, String host, int port) throws IOException {
        Socket raw = new Socket();
        try {
            raw.setTcpNoDelay(true);
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
