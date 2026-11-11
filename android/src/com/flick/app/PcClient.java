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
 * local TlsProxy port, which carries it to the PC over TLS, pinned to the certificate the page pinned when it paired
 * (a file's bytes go straight to the PC over Wire, pinned the same way: see send): a PC without a pin was never
 * verified, and nothing is ever sent to it. When the saved address doesn't answer, a
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
    // a synced folder's list: up to 20,000 files (pc/sync.js), about 76 bytes each for a camera's names (15,000 photos
    // are over a megabyte), much more for long paths
    static final int MAX_LIST = 32 * 1024 * 1024;
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
            return TlsProxy.open(ip, port, t.pin).base();
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
        return json(t, "POST", path, query, b, MAX_JSON);
    }

    JSONObject get(Target t, String path, String query) throws Failure { return get(t, path, query, MAX_JSON); }

    /** GET path, whose answer may be up to max bytes (a synced folder's list: MAX_LIST). */
    JSONObject get(Target t, String path, String query, int max) throws Failure { return json(t, "GET", path, query, null, max); }

    private JSONObject json(final Target t, final String method, final String path, final String query, final byte[] body, final int max) throws Failure {
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
                    return answer(c, max);
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

    /**
     * Raw bytes POSTed to path (an upload, a synced file); the PC's JSON answer. Straight to the PC over Wire (pinned
     * TLS, a connection kept for the next one), not through the local proxy: a PC that turns a large file down before
     * it's all in (it forgot this phone, it's full, a synced name it can't take) answers and closes the connection, and
     * that answer is read all the same, where the proxy's connection only showed a cut ("Couldn't reach" the PC).
     */
    JSONObject send(final Target t, final String path, final String query, final Source src, final AtomicBoolean abort) throws Failure {
        return call(t, abort, new Call<JSONObject>() {
            @Override
            public JSONObject run(String base) throws IOException {
                Wire.Link l = new Wire.Link(t.ip(), t.port(), t.pin);
                String target = path + "?" + (query == null || query.length() == 0 ? "" : query + "&") + "device=" + enc(t.device) + "&token=" + enc(t.token);
                for (int attempt = 0; ; attempt++) {
                    long len = src.length();
                    if (len < 0) throw new Failure(Failure.LOCAL, "unknown size", 0);
                    InputStream in;
                    try { in = src.open(); }
                    catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
                    catch (RuntimeException e) { throw new Failure(Failure.LOCAL, String.valueOf(e), 0); }   // (a provider's)
                    Wire.Call c = null;
                    Watchdog.Guard g = null;
                    boolean through = false;
                    try {
                        c = Wire.Call.open(l, "POST", target, len, "application/octet-stream", SEND_READ_MS, null, attempt > 0);
                        g = Watchdog.guard(abort, c);
                        OutputStream out = Wire.pieces(g.watch(c.body()));
                        byte[] buf = new byte[256 * 1024];
                        long sent = 0;
                        while (sent < len) {
                            if (abort != null && abort.get()) throw new IOException("aborted");
                            int n = read(in, buf, (int) Math.min(buf.length, len - sent));
                            out.write(buf, 0, n);
                            sent += n;
                        }
                        g.idle();
                        through = true;
                        // What was written can still be on its way (the system's buffers, and a slow link's, hold
                        // megabytes: minutes of it), and the PC answers once it's all in and saved: its answer is waited
                        // for while the PC says more is arriving (or, a PC that can't say, while it answers at all), where
                        // a wait worked out from the last write gave up on a link still delivering, and the file went
                        // again (a second copy on the PC)
                        awaitAnswer(c, l, "device=" + enc(t.device) + "&token=" + enc(t.token), tidOf(target), abort);
                        return answer(c.answer(MAX_JSON));
                    } catch (Failure f) {
                        throw f;
                    } catch (IOException e) {
                        boolean cut = g != null && g.ended() != null;
                        // the PC answered before it closed the connection: that answer, not a cut
                        if (c != null && !through && !cut && (abort == null || !abort.get())) {
                            Wire.Answer a = c.answerAfterCut(MAX_JSON);
                            if (a != null) return answer(a);
                        }
                        // a kept connection the PC had closed meanwhile: once more over a new one (nothing was answered)
                        if (c != null && c.reused && !c.heard() && !cut && attempt == 0 && (abort == null || !abort.get())) continue;
                        if (cut) throw new IOException(g.ended(), e);
                        throw e;
                    } finally {
                        if (g != null) g.close();
                        quiet(in);
                        if (c != null) c.close();
                    }
                }
            }
        });
    }

    static volatile int WAIT_MS = 5000;               // a PC silent this long after a body is asked how far it got
    static volatile long ALIVE_MS = 10 * 60000L;      // a PC that can't say how far it got is waited for this long

    /**
     * Waits for the PC to begin its answer to c, whose body is all written: as long as the PC says more of it is
     * arriving (/api/status of the transfer tid), or, a PC that can't say (an older one, a request without an id), as
     * long as it answers at all (up to ALIVE_MS: a body that stops coming is closed by the PC itself). Throws when the
     * PC has gone quiet for SEND_READ_MS.
     */
    private static void awaitAnswer(Wire.Call c, Wire.Link l, String auth, String tid, AtomicBoolean abort) throws IOException {
        long end = mono(), since = end;
        String seen = null;
        while (!c.answerWithin(Math.min(WAIT_MS, SEND_READ_MS))) {
            if (abort != null && abort.get()) throw new IOException("aborted");
            String at = arrived(l, auth, tid);
            long now = mono();
            if (at != null && !"alive".equals(at) && !at.equals(seen)) { seen = at; since = now; }
            else if ("alive".equals(at) && now - end < ALIVE_MS) since = now;
            else if (now - since >= SEND_READ_MS) throw new java.net.SocketTimeoutException("no answer");
        }
    }

    /** How much of the upload tid the PC has ("received <n>"), "alive" when it answers but can't say, null when it doesn't. */
    private static String arrived(Wire.Link l, String auth, String tid) {
        try {
            if (tid != null) {
                Wire.Answer st = Wire.get(l, "/api/status?" + auth + "&tid=" + enc(tid), READ_MS);
                JSONObject o = st.json();
                if (st.code == 200 && "upload".equals(o.optString("kind"))) return "received " + o.optLong("received", -1);
            }
            return Wire.get(l, "/api/hello", READ_MS).code == 200 ? "alive" : null;
        } catch (Throwable e) { return null; }
    }

    /** The transfer id in a request's query (tid=…), or null. */
    static String tidOf(String target) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("[?&]tid=([^&]*)").matcher(target == null ? "" : target);
        if (!m.find()) return null;
        try { return java.net.URLDecoder.decode(m.group(1), "UTF-8"); } catch (Exception e) { return null; }
    }

    // ------------------------------------------------------------ a file sent quietly that carries on after a cut
    /**
     * Where a file sent with uploadResumable stands between tries: kept by the caller (auto-send writes it down with
     * the item), so a try after a cut, or after Flick was closed, carries on with the same transfer.
     */
    static final class Resume {
        String tid;            // the transfer: the same on every try
        String att;            // this attempt (a file that changed, or one the PC no longer has, starts another)
        String sig;            // the file when this attempt began ("<size>:<modified>")
        boolean begun;         // bytes of this attempt may be on the PC: how far it got is asked before more go

        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                if (tid != null) o.put("tid", tid);
                if (att != null) o.put("att", att);
                if (sig != null) o.put("sig", sig);
                o.put("begun", begun);
            } catch (Exception e) { /* can't fail */ }
            return o;
        }

        static Resume of(JSONObject o) {
            Resume r = new Resume();
            if (o == null) return r;
            r.tid = o.has("tid") ? o.optString("tid") : null;
            r.att = o.has("att") ? o.optString("att") : null;
            r.sig = o.has("sig") ? o.optString("sig") : null;
            r.begun = o.optBoolean("begun", r.att != null);
            return r;
        }
    }

    /** The PC no longer has this attempt (it restarted, kept it too long, or it arrived damaged): a new one from the start. */
    private static final class Again extends IOException {
        private static final long serialVersionUID = 1L;
        Again(String why) { super(why); }
    }

    static volatile long CAPS_MS = 10 * 60000L;
    private static final ConcurrentHashMap<String, Object[]> CAPS = new ConcurrentHashMap<String, Object[]>();   // pc -> {addr, when, qparts}

    /**
     * The PC takes files sent quietly in parts it keeps when they're cut off (its hello says qparts; an older PC takes
     * them in one request only, sent again from the start after a cut). Asked once in a while.
     */
    boolean quietParts(final Target t, AtomicBoolean abort) throws Failure {
        Object[] k = CAPS.get(t.id);
        if (k != null && String.valueOf(t.addr()).equals(k[0]) && mono() - (Long) k[1] < CAPS_MS) return (Boolean) k[2];
        Wire.Answer a = call(t, abort, new Call<Wire.Answer>() {
            @Override public Wire.Answer run(String base) throws IOException { return Wire.get(new Wire.Link(t.ip(), t.port(), t.pin), "/api/hello", READ_MS); }
        });
        boolean yes = a.code == 200 && a.json().optInt("qparts", 0) >= 1;
        CAPS.put(t.id, new Object[]{String.valueOf(t.addr()), mono(), yes});
        return yes;
    }

    private static final int MAX_AGAIN = 3;           // new attempts in one try (the PC lost it, or it arrived damaged)
    private static final int MAX_CUTS = 6;            // cuts carried on in one try (1, 2, 4, 8, 8, 8 s apart)
    static volatile long CARRY_MS = 30000;            // ...within this long of the last bytes that went
    static final long MARK = 16L << 20;               // the file's checksum so far is kept every this many bytes
    // the file's checksum at a few points it passed, per attempt (this process): carrying on after a cut starts there
    // instead of reading again everything the PC has
    private static final ConcurrentHashMap<String, java.util.TreeMap<Long, java.security.MessageDigest>> MARKS =
            new ConcurrentHashMap<String, java.util.TreeMap<Long, java.security.MessageDigest>>();

    /**
     * A file sent quietly (auto-send: kind photo or screenshot) to a PC that takes it in parts (quietParts): a try that
     * is cut off (the Wi-Fi changed, Flick was closed, Android stopped the job) carries on next time from where the PC
     * stands instead of from the start, and a try whose answer was lost hears that the PC has it, instead of sending it
     * again (a second copy there). r is the caller's (see Resume): keep runs whenever it changed, and must write it
     * down. sig: the file as it is now ("<size>:<modified>"): a file that changed starts over. The PC's answer, as
     * upload()'s.
     */
    JSONObject uploadResumable(final Target t, final Source src, final String name, final String kind, final String sig, final Resume r,
                               final Runnable keep, final AtomicBoolean abort) throws Failure {
        return call(t, abort, new Call<JSONObject>() {
            @Override public JSONObject run(String base) throws IOException { return resumable(t, src, name, kind, sig, r, keep, abort); }
        });
    }

    private JSONObject resumable(Target t, Source src, String name, String kind, String sig, Resume r, Runnable keep, AtomicBoolean abort) throws IOException {
        Wire.Link l = new Wire.Link(t.ip(), t.port(), t.pin);
        String auth = "device=" + enc(t.device) + "&token=" + enc(t.token);
        long len = src.length();
        if (len < 0) throw new Failure(Failure.LOCAL, "unknown size", 0);
        if (r.tid == null || r.att == null || !sig.equals(r.sig)) {
            if (r.tid == null) r.tid = newTid();
            fresh(r, sig);
            keep.run();
        }
        int again = 0, cuts = 0, asks = 0;
        long movedAt = 0;                                  // when bytes last went in this try
        while (true) {
            if (abort != null && abort.get()) throw new IOException("aborted");
            long[] moved = {0};
            try {
                JSONObject done = round(l, auth, src, name, kind, len, r, keep, abort, moved);
                if (done != null) return done;
                if (++asks > 20) throw new Failure(Failure.REFUSED, "no answer to its check", 0);
                try { Thread.sleep(500); } catch (InterruptedException x) { throw new IOException("aborted"); }
            } catch (Again e) {
                if (++again > MAX_AGAIN) throw new Failure(Failure.REFUSED, e.getMessage(), 0);
                env.log("quiet send " + r.tid + " starts over: " + e.getMessage());
                fresh(r, sig);
                keep.run();
            } catch (Failure f) {
                throw f;
            } catch (IOException e) {
                // cut off while bytes were going (the Wi-Fi dropped for a moment, the phone changed networks): carried
                // on from where the PC stands, for half a minute; one that never got going is left to the caller (it
                // tries again later)
                if (moved[0] > 0) movedAt = mono();
                if (movedAt == 0 || mono() - movedAt > CARRY_MS || ++cuts > MAX_CUTS || (abort != null && abort.get())) throw e;
                env.log("quiet send " + r.tid + " cut off (" + e.getMessage() + "): carries on");
                // (nothing got through: the PC may be at another address now, on the network the phone moved to)
                if (moved[0] == 0 && relocate(t, true)) { l = new Wire.Link(t.ip(), t.port(), t.pin); continue; }
                try { Thread.sleep(Math.min(8000L, 500L << cuts)); } catch (InterruptedException x) { throw e; }
            }
        }
    }

    /** A file sent with uploadResumable that won't go after all (deleted, given up): the PC lets go of what it has. */
    void drop(final Target t, final Resume r) {
        if (r == null || r.tid == null || !r.begun) return;
        try {
            call(t, null, new Call<Wire.Answer>() {
                @Override public Wire.Answer run(String base) throws IOException {
                    return Wire.call(new Wire.Link(t.ip(), t.port(), t.pin), "POST", "/api/cancel?device=" + enc(t.device) + "&token=" + enc(t.token) +
                            "&tid=" + enc(r.tid), new byte[0], null, READ_MS);
                }
            });
        } catch (Throwable e) { /* the PC lets it go by itself after a while */ }
    }

    private static void fresh(Resume r, String sig) {
        byte[] b = new byte[5];
        RNG.nextBytes(b);
        StringBuilder s = new StringBuilder("q");
        for (byte x : b) s.append(String.format(Locale.US, "%02x", x & 0xff));
        if (r.tid != null && r.att != null) MARKS.remove(r.tid + ":" + r.att);
        r.att = s.toString();
        r.sig = sig;
        r.begun = false;
    }

    private static String q(Resume r, String auth) { return auth + "&tid=" + enc(r.tid) + "&att=" + enc(r.att); }

    /**
     * One round: how far the PC got (when this attempt sent it anything), the rest of the file, and its check. The PC's
     * answer once the file is in and saved; null when the PC is to be asked again.
     */
    private JSONObject round(Wire.Link l, String auth, Source src, String name, String kind, long len, Resume r, Runnable keep,
                             AtomicBoolean abort, long[] moved) throws IOException {
        long from = 0;
        boolean in = false;
        if (r.begun) {
            Wire.Answer st = Wire.get(l, "/api/status?" + q(r, auth), READ_MS);
            JSONObject o = st.json();
            if (st.code == 200 && Boolean.TRUE.equals(o.opt("done"))) return lost(o);         // in and saved: its answer was lost
            if (st.code == 200 && "parts".equals(o.optString("kind"))) {
                org.json.JSONArray sv = o.optJSONArray("saved"), dn = o.optJSONArray("done");
                if (o.optInt("parts", 0) != 1 || o.optLong("total", -1) != len || sv == null || dn == null) throw new Again("the PC has another file under it");
                from = Math.max(0, Math.min(len, sv.optLong(0, 0)));
                in = dn.optBoolean(0, false);
            } else if (st.code == 200 || st.code == 404) {
                throw new Again("the PC doesn't have it any more");
            } else {
                refusal(st);
            }
        }
        java.security.MessageDigest md = in ? sum(src, len, r, abort) : sendPart(l, auth, src, name, kind, len, from, r, keep, abort, moved);
        if (md == null) return null;                                       // (the PC took the part some other way: asked again)
        return commit(l, auth, r, len, hex(md.digest()), abort);
    }

    /** The answer for a file the PC says it has (the answer to its commit was lost): it's there, under its saved name. */
    private static JSONObject lost(JSONObject status) {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("done", true); o.put("already", true); } catch (Exception e) { /* can't fail */ }
        return o;
    }

    /**
     * Sends the file from byte `from` on as the transfer's one part; returns the whole file's checksum (worked out on the
     * way, from what the PC has already: a point this process kept, or by reading it), or null when the PC is to be
     * asked again.
     */
    private java.security.MessageDigest sendPart(Wire.Link l, String auth, Source src, String name, String kind, long len, long from,
                                                 Resume r, Runnable keep, AtomicBoolean abort, long[] moved) throws IOException {
        String target = "/api/part?" + q(r, auth) + "&quiet=1&kind=" + enc(kind) + "&parts=1&index=0&offset=0&total=" + len + "&resume=1&from=" + from +
                "&verify=1&name=" + enc(name);
        InputStream in;
        try { in = src.open(); }
        catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
        catch (RuntimeException e) { throw new Failure(Failure.LOCAL, String.valueOf(e), 0); }
        Wire.Call c = null;
        Watchdog.Guard g = null;
        boolean through = false;
        try {
            java.security.MessageDigest md = upTo(in, from, r, abort);
            // (written down before any byte goes: a try after Flick was closed asks the PC how far it got)
            if (!r.begun) { r.begun = true; keep.run(); }
            // over a new connection: one the PC closed meanwhile would cost the round
            c = Wire.Call.open(l, "POST", target, len - from, "application/octet-stream", SEND_READ_MS, null, true);
            g = Watchdog.guard(abort, c);
            OutputStream out = Wire.pieces(g.watch(c.body()));
            byte[] buf = new byte[256 * 1024];
            long pos = from, next = (from / MARK + 1) * MARK;
            while (pos < len) {
                if (abort != null && abort.get()) throw new IOException("aborted");
                int n = read(in, buf, (int) Math.min(buf.length, len - pos));
                md.update(buf, 0, n);
                out.write(buf, 0, n);
                pos += n;
                moved[0] += n;
                if (pos >= next || pos == len) { mark(r, pos, md); next = (pos / MARK + 1) * MARK; }
            }
            g.idle();
            through = true;
            // (the PC has all of it already: its answer was lost, or is late)
            if (!awaitPart(c, l, auth, r, abort)) return md;
            Wire.Answer a = c.answer(MAX_JSON);
            if (a.code == 200) return md;
            if (a.code == 409 && ("checking".equals(a.error()) || "behind".equals(a.error()) || "finished".equals(a.error()))) return null;
            refusal(a);
            return null;
        } catch (Failure f) {
            throw f;
        } catch (IOException e) {
            // the PC answered before it closed the connection (out of space, canceled there): that, not a cut
            if (c != null && !through && (g == null || g.ended() == null) && (abort == null || !abort.get())) {
                Wire.Answer a = c.answerAfterCut(MAX_JSON);
                if (a != null && a.code != 200) refusal(a);
            }
            if (g != null && g.ended() != null) throw new IOException(g.ended(), e);
            throw e;
        } finally {
            if (g != null) g.close();
            quiet(in);
            if (c != null) c.close();
        }
    }

    /**
     * The PC's answer to the part: waited for while what it has of it grows (megabytes can still be on their way when
     * the last write returns). True when the answer began; false when the PC has the part whole already.
     */
    private static boolean awaitPart(Wire.Call c, Wire.Link l, String auth, Resume r, AtomicBoolean abort) throws IOException {
        long since = mono();
        String seen = null;
        while (!c.answerWithin(Math.min(WAIT_MS, SEND_READ_MS))) {
            if (abort != null && abort.get()) throw new IOException("aborted");
            String at = null;
            try {
                Wire.Answer st = Wire.get(l, "/api/status?" + q(r, auth), READ_MS);
                JSONObject o = st.json();
                org.json.JSONArray sv = o.optJSONArray("saved"), dn = o.optJSONArray("done");
                if (st.code == 200 && (Boolean.TRUE.equals(o.opt("done")) || (dn != null && dn.optBoolean(0, false)))) return false;
                if (st.code == 200 && sv != null) at = "saved " + sv.optLong(0, -1);
            } catch (IOException e) { /* no answer: counts as silence */ }
            long now = mono();
            if (at != null && !at.equals(seen)) { seen = at; since = now; }
            else if (now - since >= SEND_READ_MS) throw new java.net.SocketTimeoutException("no answer");
        }
        return true;
    }

    /**
     * Every byte is in: the PC checks the file against its checksum, then saves it as it saves any file sent quietly
     * (its user asked first, when it's set to "Ask each time"). Its answer (with the name it was saved under); null
     * when it's to be asked again (a part isn't in after all).
     */
    private static JSONObject commit(Wire.Link l, String auth, Resume r, long len, String sum, AtomicBoolean abort) throws IOException {
        // (reading back what arrived out of order takes a while on a large file)
        int readMs = (int) Math.min(30 * 60000L, SEND_READ_MS + len / (25L << 20) * 1000L);
        Wire.Call c = Wire.Call.open(l, "POST", "/api/part?" + q(r, auth) + "&commit=1&sums=" + sum, 0, null, readMs);
        Watchdog.Guard g = Watchdog.guard(abort, c);
        try {
            Wire.Answer a = c.answer(MAX_JSON);
            if (a.code == 200) return answer(a);
            if (a.code == 409 && "checking".equals(a.error())) throw new Again("the file changed while it went");
            if (a.code == 409) return null;
            refusal(a);
            return null;
        } catch (IOException e) {
            if (g.ended() != null) throw new IOException(g.ended(), e);
            throw e;
        } finally {
            g.close();
            c.close();
        }
    }

    /** What the PC's error answer to a quiet transfer in parts means (always throws). */
    private static void refusal(Wire.Answer a) throws IOException {
        JSONObject o = a.json();
        String err = o.optString("error", "");
        if (a.code == 410) {
            String why = o.optString("why", "");
            // turned down by the PC's user ("Ask each time"), said as a quiet upload says it (Bg.declined)
            if ("declined".equals(why) || "timeout".equals(why)) throw new Failure(Failure.REFUSED, why, 409);
            // canceled there (its user, in Transfers), or let go of (this phone said so: see drop): never sent again
            throw new Failure(Failure.REFUSED, "canceled", 410);
        }
        if (a.code == 403) throw new Failure(Failure.DENIED, err, 403);
        if (a.code == 422 || a.code == 400 || (a.code == 409 && "gone".equals(err))) throw new Again(err.length() > 0 ? err : "http " + a.code);
        throw new Failure(Failure.REFUSED, err.length() > 0 ? err : "http " + a.code, a.code);
    }

    /** The checksum of the file's first `from` bytes, read from in, which is left there: from a point kept, if any. */
    private static java.security.MessageDigest upTo(InputStream in, long from, Resume r, AtomicBoolean abort) throws IOException {
        java.security.MessageDigest md = null;
        long at = 0;
        java.util.TreeMap<Long, java.security.MessageDigest> m = MARKS.get(r.tid + ":" + r.att);
        if (m != null) {
            synchronized (m) {
                java.util.Map.Entry<Long, java.security.MessageDigest> e = m.floorEntry(from);
                if (e != null) { try { md = (java.security.MessageDigest) e.getValue().clone(); at = e.getKey(); } catch (CloneNotSupportedException x) { md = null; } }
            }
        }
        if (md == null) { md = sha256(); at = 0; }
        else skip(in, at);
        byte[] buf = new byte[256 * 1024];
        while (at < from) {
            if (abort != null && abort.get()) throw new IOException("aborted");
            int n = read(in, buf, (int) Math.min(buf.length, from - at));
            md.update(buf, 0, n);
            at += n;
        }
        return md;
    }

    /** The whole file's checksum (the PC has every byte of it already). */
    private static java.security.MessageDigest sum(Source src, long len, Resume r, AtomicBoolean abort) throws IOException {
        InputStream in;
        try { in = src.open(); }
        catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
        catch (RuntimeException e) { throw new Failure(Failure.LOCAL, String.valueOf(e), 0); }
        try { return upTo(in, len, r, abort); } finally { quiet(in); }
    }

    private static void mark(Resume r, long pos, java.security.MessageDigest md) {
        java.security.MessageDigest copy;
        try { copy = (java.security.MessageDigest) md.clone(); } catch (CloneNotSupportedException e) { return; }
        if (MARKS.size() > 16) MARKS.clear();
        String key = r.tid + ":" + r.att;
        java.util.TreeMap<Long, java.security.MessageDigest> m = MARKS.get(key);
        if (m == null) { MARKS.putIfAbsent(key, new java.util.TreeMap<Long, java.security.MessageDigest>()); m = MARKS.get(key); }
        if (m == null) return;
        synchronized (m) {
            m.put(pos, copy);
            while (m.size() > 4) m.pollFirstEntry();
        }
    }

    private static void skip(InputStream in, long n) throws IOException {
        byte[] buf = null;
        while (n > 0) {
            long k;
            try { k = in.skip(n); }
            catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
            catch (RuntimeException e) { throw new Failure(Failure.LOCAL, String.valueOf(e), 0); }
            if (k <= 0) {
                if (buf == null) buf = new byte[64 * 1024];
                k = read(in, buf, (int) Math.min(buf.length, n));
            }
            n -= k;
        }
    }

    /** Up to n bytes of the file to send (at least one): a read that fails, or a file that ended early, is the file's problem. */
    private static int read(InputStream in, byte[] buf, int n) throws Failure {
        int r;
        try { r = in.read(buf, 0, n); }
        catch (IOException e) { throw new Failure(Failure.LOCAL, e.getMessage(), 0); }
        catch (RuntimeException e) { throw new Failure(Failure.LOCAL, String.valueOf(e), 0); }   // (a provider's)
        if (r < 0) throw new Failure(Failure.LOCAL, "file changed", 0);
        return r;
    }

    private static java.security.MessageDigest sha256() throws IOException {
        try { return java.security.MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("no SHA-256"); }
    }

    private static String hex(byte[] d) {
        StringBuilder s = new StringBuilder(d.length * 2);
        for (byte x : d) s.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return s.toString();
    }

    private static long mono() { return System.nanoTime() / 1000000L; }

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
        // straight to the local port: never through a proxy the network may have configured, and only while it's still
        // this app's relay (its key at that port: once it has closed, any app may have the port; see TlsProxy.Gate.own)
        URL u = new URL(base + path + "?" + q);
        TlsProxy.Gate.own(u);
        HttpURLConnection c = (HttpURLConnection) u.openConnection(Proxy.NO_PROXY);
        c.setConnectTimeout(CONNECT_MS);
        c.setReadTimeout(READ_MS);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        return c;
    }

    /** The PC's JSON answer, or the Failure it means. */
    private static JSONObject answer(HttpURLConnection c) throws IOException { return answer(c, MAX_JSON); }

    /** The same, for an answer of up to max bytes. */
    private static JSONObject answer(HttpURLConnection c, int max) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text;
        // more than this phone takes is the PC's answer all the same: the link is fine (no look for the PC elsewhere,
        // no "Couldn't reach" it)
        try { text = in == null ? "" : new String(readAll(in, max), "UTF-8"); }
        catch (TooLong e) { throw new Failure(Failure.REFUSED, "answer too long", code); }
        return answer(code, text);
    }

    /** The same, for an answer read over Wire. */
    private static JSONObject answer(Wire.Answer a) throws Failure { return answer(a.code, a.body); }

    private static JSONObject answer(int code, String text) throws Failure {
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

    /** An answer longer than the reader takes (the link itself is fine). */
    static final class TooLong extends IOException {
        private static final long serialVersionUID = 1L;
        TooLong() { super("answer too long"); }
    }

    static byte[] readAll(InputStream in, int max) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int r;
            while ((r = in.read(buf)) > 0) {
                if (bo.size() + r > max) throw new TooLong();
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
