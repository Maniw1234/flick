package com.flick.app;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.net.URLEncoder;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * How background code (no page, no WebView: the background link, auto-send, the tiles and the widget, phone
 * notifications, folder sync) reaches a paired PC. Who the PC is and how to prove it come from the page's saved pairing
 * (prefs "p:lastPc", "p:lastPcAddr", "p:lastPcName", "p:token:<pcId>", "p:pin:<pcId>"). Every request is plain HTTP to a
 * local TlsProxy port, which carries it to the PC over TLS, pinned to the certificate the page pinned when it paired:
 * a PC without a pin was never verified, and nothing is ever sent to it. When the saved address doesn't answer, a
 * short discovery looks for the PC's id elsewhere. No Android classes (Env brings prefs and discovery), so it runs on
 * any JVM.
 */
final class PcClient {
    interface Env {
        /** A string from SharedPreferences "flick" by its full key ("p:lastPc", "device"), or null. */
        String pref(String key);
        void setPref(String key, String value);
        /** {ip, port} where the PC with this id answers a short discovery now, or null. */
        String[] discover(String pcId, int ms);
        void log(String msg);
    }

    /** Why nothing could be sent: why is one of the constants; code is the HTTP status when the PC answered. */
    static final class Failure extends IOException {
        private static final long serialVersionUID = 1L;
        static final String UNPAIRED = "unpaired";       // no PC, no token, or no pin (never verified): pair in the app
        static final String UNREACHABLE = "unreachable"; // no answer: the PC is off or on another network
        static final String PIN = "pin";                 // another certificate answers there: nothing was sent
        static final String DENIED = "denied";           // the PC doesn't take this phone's token (it forgot the phone)
        static final String OLD = "old";                 // the PC's Flick doesn't know this request yet (protocol < 5)
        static final String REFUSED = "refused";         // the PC answered with an error
        static final String LOCAL = "local";             // the file to send is gone or changed while it was read
        static final String ABORTED = "aborted";         // the caller stopped it
        final String why;
        final int code;
        Failure(String why, String detail, int code) {
            super(why + (detail == null || detail.length() == 0 ? "" : ": " + detail));
            this.why = why;
            this.code = code;
        }
        boolean is(String w) { return why.equals(w); }
    }

    /** Bytes to send: opened once per attempt. */
    interface Source {
        InputStream open() throws IOException;
        long length();
    }

    interface Events { void onEvent(JSONObject e); }

    /** A paired, verified PC: its id, name, the token, the certificate pin, and where it was last seen. */
    static final class Target {
        final String id, name, token, pin, device;
        /** Someone is waiting (a tile, the widget, the page): look for the PC even if a look just found nothing. */
        volatile boolean eager;
        private String ip;
        private int port;

        Target(String id, String name, String token, String pin, String device) {
            this.id = id; this.name = name; this.token = token; this.pin = pin; this.device = device;
        }

        synchronized String addr() { return ip == null ? null : ip + ":" + port; }
        synchronized String ip() { return ip; }
        synchronized int port() { return port; }
        synchronized void at(String ip, int port) { this.ip = ip; this.port = port; }
    }

    /** The open GET /api/events of one events() call; stop() ends it from any thread. */
    static final class Hold {
        private volatile HttpURLConnection c;
        private volatile boolean stopped;
        void stop() {
            stopped = true;
            HttpURLConnection x = c;
            if (x != null) { try { x.disconnect(); } catch (Throwable e) { /* ignore */ } }
        }
        boolean stopped() { return stopped; }
    }

    // time limits (tests shorten them)
    static volatile int CONNECT_MS = 5000;            // to the local proxy port
    static volatile int READ_MS = 15000;              // a JSON answer
    static volatile int SEND_READ_MS = 90000;         // the answer after a file's bytes went through (a PC set to "Ask each
                                                      // time" answers once its user did, or after 60 s)
    static volatile int EVENTS_READ_MS = 65000;       // the PC pings every 20 s: three missed pings and the line is dead
    static volatile int DISCOVER_MS = 3000;
    static volatile long LOOK_GAP_MS = 60000;         // one discovery per PC per minute, unless asked
    static final int MAX_JSON = 1024 * 1024;
    static final int MAX_LINE = 9 * 1024 * 1024;      // an event line: a clipboard image is up to 6 MB of base64

    // where PCs other than the last one used were last found (the last one's address is in prefs, shared with the page)
    private static final ConcurrentHashMap<String, String> SEEN = new ConcurrentHashMap<String, String>();
    private static final ConcurrentHashMap<String, Long> LOOKED = new ConcurrentHashMap<String, Long>();
    private static final SecureRandom RNG = new SecureRandom();

    private final Env env;

    PcClient(Env env) { this.env = env; }

    /** The next look-around for a PC (after a network change, say) doesn't wait for the per-minute limit. */
    static void lookAgain() { LOOKED.clear(); }

    // ------------------------------------------------------------ who
    /** The PC the app used last, if this phone paired with it and pinned its certificate. */
    Target target() throws Failure { return target(null, null); }

    /** The PC pcId (null: the one the app used last), if this phone paired with it and pinned its certificate. */
    Target target(String pcId, String nameHint) throws Failure {
        String last = str(env.pref("p:lastPc"));
        String id = pcId == null || pcId.length() == 0 ? last : pcId;
        String device = str(env.pref("device"));
        if (id.length() == 0 || device.length() == 0) throw new Failure(Failure.UNPAIRED, "no PC", 0);
        String token = str(env.pref("p:token:" + id));
        String pin = str(env.pref("p:pin:" + id)).trim().toLowerCase(Locale.US);
        if (token.length() == 0) throw new Failure(Failure.UNPAIRED, "no token", 0);
        if (pin.length() == 0) throw new Failure(Failure.UNPAIRED, "not verified", 0);
        String name = id.equals(last) ? str(env.pref("p:lastPcName")) : "";
        if (name.length() == 0) name = nameHint != null && nameHint.length() > 0 ? nameHint : "your PC";
        Target t = new Target(id, name, token, pin, device);
        String addr = id.equals(last) ? str(env.pref("p:lastPcAddr")) : "";
        if (addr.length() == 0) addr = str(SEEN.get(id));
        int colon = addr.lastIndexOf(':');
        if (colon > 0) {
            try { t.at(addr.substring(0, colon), Integer.parseInt(addr.substring(colon + 1))); } catch (NumberFormatException e) { /* unknown */ }
        }
        return t;
    }

    // ------------------------------------------------------------ the link
    /** The local end ("http://127.0.0.1:<port>") of an encrypted link to t's PC, pinned; opened if needed. */
    String base(Target t) throws Failure {
        String ip = t.ip();
        int port = t.port();
        Failure first = null;
        if (ip != null) {
            try { return open(t, ip, port); } catch (Failure f) { first = f; }
        }
        if (relocate(t, ip == null || t.eager)) return open(t, t.ip(), t.port());
        throw first != null ? first : new Failure(Failure.UNREACHABLE, "not found", 0);
    }

    private static String open(Target t, String ip, int port) throws Failure {
        try {
            return "http://127.0.0.1:" + TlsProxy.open(ip, port, t.pin).localPort();
        } catch (TlsProxy.PinMismatch e) {
            throw new Failure(Failure.PIN, "certificate changed", 0);
        } catch (IOException e) {
            throw new Failure(Failure.UNREACHABLE, e.getMessage(), 0);
        } catch (RuntimeException e) {
            throw new Failure(Failure.UNREACHABLE, String.valueOf(e), 0);
        }
    }

    /** Looks for t's PC by its id; true when it answers at another address than t's (t now points there). */
    boolean relocate(Target t, boolean force) {
        long now = System.nanoTime() / 1000000L;
        Long prev = LOOKED.get(t.id);
        if (!force && prev != null && now - prev < LOOK_GAP_MS) return false;
        LOOKED.put(t.id, now);
        String[] hit = null;
        try { hit = env.discover(t.id, DISCOVER_MS); } catch (Throwable e) { env.log("discovery failed: " + e); }
        if (hit == null || hit.length < 2 || hit[0] == null || hit[0].length() == 0) return false;
        int port;
        try { port = Integer.parseInt(hit[1]); } catch (Throwable e) { return false; }
        synchronized (t) {
            if (hit[0].equals(t.ip()) && port == t.port()) return false;
            t.at(hit[0], port);
        }
        return true;
    }

    /** t answered at its address: remembered (for the last PC, in the pref the page reads at start too). */
    private void remember(Target t) {
        String addr = t.addr();
        if (addr == null) return;
        SEEN.put(t.id, addr);
        try {
            if (t.id.equals(str(env.pref("p:lastPc"))) && !addr.equals(str(env.pref("p:lastPcAddr")))) {
                env.setPref("p:lastPcAddr", addr);
                env.log("PC " + t.name + " is now at " + addr);
            }
        } catch (Throwable e) { /* prefs only */ }
    }

    private interface Call<T> { T run(String base) throws IOException; }

    /** c over t's link; when nothing comes back, once more wherever a discovery finds the PC now. */
    private <T> T call(Target t, AtomicBoolean abort, Call<T> c) throws Failure {
        for (int attempt = 0; ; attempt++) {
            if (abort != null && abort.get()) throw new Failure(Failure.ABORTED, null, 0);
            String base = base(t);
            try {
                T r = c.run(base);
                remember(t);
                return r;
            } catch (Failure f) {
                if (f.code > 0) remember(t);                 // it answered: the address is right
                throw f;
            } catch (IOException e) {
                if (abort != null && abort.get()) throw new Failure(Failure.ABORTED, null, 0);
                // nothing came back: a link left open to an old address leads nowhere once the PC moved
                if (attempt == 0 && relocate(t, t.eager)) continue;
                throw new Failure(Failure.UNREACHABLE, e.getMessage(), 0);
            } catch (RuntimeException e) {
                throw new Failure(Failure.UNREACHABLE, String.valueOf(e), 0);
            }
        }
    }

    // ------------------------------------------------------------ requests
    /** POST path with a JSON body to the PC the app used last (POST /api/clip, /api/link, /api/notify). */
    JSONObject post(String path, JSONObject body) throws Failure { return post(target(), path, null, body); }

    JSONObject post(Target t, String path, String query, JSONObject body) throws Failure {
        byte[] b = utf8(body == null ? "{}" : body.toString());
        return json(t, "POST", path, query, b);
    }

    JSONObject get(Target t, String path, String query) throws Failure { return json(t, "GET", path, query, null); }

    private JSONObject json(final Target t, final String method, final String path, final String query, final byte[] body) throws Failure {
        return call(t, null, new Call<JSONObject>() {
            @Override
            public JSONObject run(String base) throws IOException {
                HttpURLConnection c = connection(base, t, path, query);
                try {
                    c.setRequestMethod(method);
                    if (body != null) {
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        c.setFixedLengthStreamingMode(body.length);
                        OutputStream o = c.getOutputStream();
                        o.write(body);
                        o.close();
                    }
                    return answer(c);
                } finally {
                    c.disconnect();
                }
            }
        });
    }

    /** A file sent without the fling gesture (auto-send, tile, widget): POST /api/upload?quiet=1&kind=… */
    JSONObject upload(Target t, Source src, String name, String kind, AtomicBoolean abort) throws Failure {
        return upload(t, src, name, kind, abort, newTid());
    }

    /** upload() with the transfer id the PC gave (Browse: pl<job>-<n>, so the PC knows which of its requests it is). */
    JSONObject upload(Target t, Source src, String name, String kind, AtomicBoolean abort, String tid) throws Failure {
        String q = "tid=" + enc(tid) + "&name=" + enc(name) + "&size=" + src.length() + "&quiet=1&kind=" + enc(kind);
        return send(t, "/api/upload", q, src, abort);
    }

    /** upload() to the PC the app used last. */
    JSONObject upload(File f, String name, String kind) throws Failure {
        return upload(target(), fileSource(f), name == null ? f.getName() : name, kind, null);
    }

    /** Raw bytes POSTed to path (an upload, a synced file); the PC's JSON answer. */
    JSONObject send(final Target t, final String path, final String query, final Source src, final AtomicBoolean abort) throws Failure {
        return call(t, abort, new Call<JSONObject>() {
            @Override
            public JSONObject run(String base) throws IOException {
                HttpURLConnection c = null;
                Watchdog.Guard g = null;
                InputStream in = null;
                try {
                    long len = src.length();
                    if (len < 0) throw new Failure(Failure.LOCAL, "unknown size", 0);
                    try { in = src.open(); } catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                    c = connection(base, t, path, query);
                    g = Watchdog.guard(abort, c);
                    c.setRequestMethod("POST");
                    c.setReadTimeout(SEND_READ_MS);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/octet-stream");
                    c.setFixedLengthStreamingMode(len);
                    OutputStream out = g.watch(c.getOutputStream());
                    byte[] buf = new byte[256 * 1024];
                    long sent = 0;
                    while (sent < len) {
                        if (abort != null && abort.get()) throw new IOException("aborted");
                        int n;
                        try { n = in.read(buf, 0, (int) Math.min(buf.length, len - sent)); }
                        catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                        if (n < 0) throw new Failure(Failure.LOCAL, "file changed", 0);
                        out.write(buf, 0, n);
                        sent += n;
                    }
                    out.close();
                    g.idle();
                    return answer(c);
                } catch (Failure f) {
                    throw f;
                } catch (IOException e) {
                    if (g != null && g.ended() != null) throw new IOException(g.ended(), e);
                    throw e;
                } finally {
                    if (g != null) g.close();
                    quiet(in);
                    if (c != null) c.disconnect();
                }
            }
        });
    }

    /**
     * GET path into dest (written from scratch on each attempt). Returns the PC's X-Flick-Mtime, or -1. The length
     * must match Content-Length.
     */
    long fetch(final Target t, final String path, final String query, final File dest, final AtomicBoolean abort) throws Failure {
        return call(t, abort, new Call<Long>() {
            @Override
            public Long run(String base) throws IOException {
                HttpURLConnection c = connection(base, t, path, query);
                Watchdog.Guard g = Watchdog.guard(abort, c);
                OutputStream out = null;
                try {
                    int code = c.getResponseCode();
                    if (code != 200) answer(c);                       // throws the PC's error
                    long total = c.getContentLengthLong();
                    long mtime = headerLong(c, "X-Flick-Mtime");
                    // never more than the phone has room for (less a reserve), whatever the PC sends or claims
                    File dir = dest.getAbsoluteFile().getParentFile();
                    long usable = dir == null ? 0 : dir.getUsableSpace();
                    long room = usable > 0 ? usable - 256L * 1024 * 1024 : Long.MAX_VALUE;    // 0: can't tell
                    if (total > room) throw new Failure(Failure.LOCAL, "not enough space on the phone", 0);
                    InputStream in = new BufferedInputStream(g.watch(c.getInputStream()), 64 * 1024);
                    try {
                        try { out = new FileOutputStream(dest); } catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                        byte[] buf = new byte[256 * 1024];
                        long got = 0;
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            if (abort != null && abort.get()) throw new IOException("aborted");
                            try { out.write(buf, 0, n); } catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                            got += n;
                            if (got > room || (total >= 0 && got > total)) throw new Failure(Failure.LOCAL, got > room ? "not enough space on the phone" : "more than the PC said", 0);
                        }
                        g.idle();
                        if (total >= 0 && got != total) throw new IOException("short: " + got + " of " + total);
                        try { out.close(); out = null; } catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                    } finally { quiet(in); }
                    return mtime;
                } catch (Failure f) {
                    throw f;
                } catch (IOException e) {
                    if (g.ended() != null) throw new IOException(g.ended(), e);
                    throw e;
                } finally {
                    g.close();
                    quiet(out);
                    c.disconnect();
                }
            }
        });
    }

    /**
     * Holds GET /api/events open, handing each line to l, until the PC ends it, the link breaks or hold.stop(). The
     * first line must be the PC's hello (protocol 5+). A {t:'token'} line updates the saved token. Returns normally only
     * when the PC ended the stream; a link that broke is a Failure (UNREACHABLE).
     */
    void events(Target t, Events l, Hold hold) throws Failure {
        for (int attempt = 0; ; attempt++) {
            if (hold.stopped()) throw new Failure(Failure.ABORTED, null, 0);
            String base = base(t);
            HttpURLConnection c = null;
            boolean opened = false;
            try {
                c = connection(base, t, "/api/events", null);
                c.setReadTimeout(EVENTS_READ_MS);
                hold.c = c;
                if (hold.stopped()) throw new IOException("aborted");
                int code = c.getResponseCode();
                if (code != 200) answer(c);
                InputStream in = new BufferedInputStream(c.getInputStream(), 64 * 1024);
                String line;
                while ((line = readLine(in, MAX_LINE)) != null) {
                    line = line.trim();
                    if (line.length() == 0) continue;
                    JSONObject e;
                    try { e = new JSONObject(line); } catch (Exception x) { env.log("events: bad line"); continue; }
                    String type = e.optString("t", "");
                    if (!opened) {
                        if (!"hello".equals(type) || e.optInt("v", 0) < 5) throw new Failure(Failure.OLD, "no hello", 200);
                        opened = true;
                        remember(t);
                    }
                    if ("token".equals(type)) {
                        String tok = e.optString("token", "");
                        if (tok.length() > 0 && !tok.equals(t.token)) env.setPref("p:token:" + t.id, tok);
                    }
                    try { l.onEvent(e); } catch (Throwable x) { env.log("events: handler failed " + x); }
                }
                return;                                              // the PC ended it
            } catch (Failure f) {
                if (f.code > 0) remember(t);
                throw f;
            } catch (IOException e) {
                if (hold.stopped()) throw new Failure(Failure.ABORTED, null, 0);
                if (!opened && attempt == 0 && relocate(t, t.eager)) continue;
                throw new Failure(Failure.UNREACHABLE, e.getMessage(), 0);
            } catch (RuntimeException e) {
                throw new Failure(Failure.UNREACHABLE, String.valueOf(e), 0);
            } finally {
                hold.c = null;
                if (c != null) c.disconnect();
            }
        }
    }

    // ------------------------------------------------------------ plumbing
    private static HttpURLConnection connection(String base, Target t, String path, String query) throws IOException {
        String q = (query == null || query.length() == 0 ? "" : query + "&") + "device=" + enc(t.device) + "&token=" + enc(t.token);
        // straight to the local port: never through a proxy the network may have configured
        HttpURLConnection c = (HttpURLConnection) new URL(base + path + "?" + q).openConnection(Proxy.NO_PROXY);
        c.setConnectTimeout(CONNECT_MS);
        c.setReadTimeout(READ_MS);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        return c;
    }

    /** The PC's JSON answer, or the Failure it means. */
    private static JSONObject answer(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = in == null ? "" : new String(readAll(in, MAX_JSON), "UTF-8");
        JSONObject o = null;
        try { o = new JSONObject(text); } catch (Exception e) { /* not JSON */ }
        if (code == 200 && o != null && o.optBoolean("ok", true)) return o;
        String err = o == null ? "" : o.optString("error", "");
        if (code == 403) throw new Failure(Failure.DENIED, err, code);
        if (code == 404 && err.length() == 0) throw new Failure(Failure.OLD, null, code);
        if (code == 200 && o == null) throw new Failure(Failure.REFUSED, "bad answer", code);
        throw new Failure(Failure.REFUSED, err.length() > 0 ? err : "http " + code, code);
    }

    static Source fileSource(final File f) {
        return new Source() {
            @Override public InputStream open() throws IOException { return new FileInputStream(f); }
            @Override public long length() { return f.length(); }
        };
    }

    static Source bytesSource(final byte[] b) {
        return new Source() {
            @Override public InputStream open() { return new java.io.ByteArrayInputStream(b); }
            @Override public long length() { return b.length; }
        };
    }

    /** One line of UTF-8 (without its line end), or null at the end of the stream. */
    static String readLine(InputStream in, int max) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(256);
        int ch;
        while ((ch = in.read()) >= 0) {
            if (ch == '\n') return b.toString("UTF-8");
            if (b.size() >= max) throw new IOException("line too long");
            b.write(ch);
        }
        return b.size() > 0 ? b.toString("UTF-8") : null;
    }

    static byte[] readAll(InputStream in, int max) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int r;
            while ((r = in.read(buf)) > 0) {
                if (bo.size() + r > max) throw new IOException("answer too long");
                bo.write(buf, 0, r);
            }
            return bo.toByteArray();
        } finally { quiet(in); }
    }

    private static long headerLong(HttpURLConnection c, String name) {
        try { String v = c.getHeaderField(name); return v == null ? -1 : Long.parseLong(v.trim()); } catch (Throwable e) { return -1; }
    }

    static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); } catch (Exception e) { return ""; }
    }

    static byte[] utf8(String s) {
        try { return s.getBytes("UTF-8"); } catch (Exception e) { return new byte[0]; }
    }

    static String newTid() {
        byte[] b = new byte[6];
        RNG.nextBytes(b);
        StringBuilder s = new StringBuilder("bg");
        for (byte x : b) s.append(String.format(Locale.US, "%02x", x & 0xff));
        return s.toString();
    }

    private static String str(String s) { return s == null ? "" : s; }

    static void quiet(java.io.Closeable c) { try { if (c != null) c.close(); } catch (Throwable e) { /* ignore */ } }
}
