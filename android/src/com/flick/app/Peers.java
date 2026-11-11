package com.flick.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;

/**
 * Phone to phone: the app's side of PeerServer (taking files from other phones) and PeerClient (sending to them). Who
 * this phone is to them, the phones it paired with (files/peers: allowed.json, links.json), where files that arrive go
 * (Download/Flick when Flick can see shared storage; else the Flick list, with a copy in the phone's public folders),
 * and what the page is told. One for the whole app. It takes files while Flick is open, or while it stays connected in
 * the background (LinkService), and "Let other phones send to this phone" is on (it is unless turned off).
 */
final class Peers {
    static final String RECEIVE = "f:peerReceive";             // "0": other phones can't find this one or send to it
    static final int PORT = 47860, DISCOVERY = 47870;
    private static final long NO_SHOW_MS = 60000;              // a send announced that never started is given up

    private static Peers inst;

    static synchronized Peers get(Context c) {
        if (inst == null) inst = new Peers(c.getApplicationContext());
        return inst;
    }

    private final Context ctx;
    private final File dir;
    private final JSONObject allowed, links;                   // guarded by serverSide / clientSide (PeerServer, PeerClient)
    private final Kept allowedFile, linksFile;                 // their files (guarded the same)
    private final ServerSide serverSide = new ServerSide();
    private final ClientSide clientSide = new ClientSide();
    // starting and stopping the receiver (its certificate is made the first time: never on the page's threads)
    private static final ExecutorService LIFE = Transfers.pool("flick-peers", 1);
    private volatile PeerServer server;                        // taking files now
    private PeerClient client;                                 // made when first needed (this)
    private int pages;                                         // Flick's screens open (this)
    private boolean bg;                                        // the background link is running (LinkService) (this)
    private volatile String myId, devName;
    private volatile JSONObject ask;                           // a phone asking to pair, waiting for the user's answer
    // Each change to the question is numbered (in the question, its events and the state): the page goes by the newest,
    // so a state made off the main thread before a change can't close a question on screen or bring back one answered.
    private int askSeq;
    private final Object askLock = new Object();
    private final Map<String, In> ins = new HashMap<String, In>();   // files arriving: tid -> what the page was told
    // transfers just finished (their 'send' handled late, after the files arrived, adds no card that would never end),
    // and whether each arrived
    private final Map<String, Boolean> over = new java.util.LinkedHashMap<String, Boolean>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > 200; }
    };
    // which phone sent each transfer lately (tid -> its id): its card landing here is told to it ('landed'), also
    // when the files were all in before the card had landed
    private final Map<String, String> fromOf = new java.util.LinkedHashMap<String, String>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> e) { return size() > 100; }
    };
    private boolean pushing;                                   // a state event is on its way (this)
    private volatile boolean shown;                            // Flick is on screen
    private volatile boolean looking;                          // looking for phones (Connect, Other phones: PeerClient)
    private byte[] bleKey;                                     // this phone's Bluetooth key, once read or made (bleLock)
    private final Object bleLock = new Object();
    private final java.util.concurrent.atomic.AtomicInteger keysGen = new java.util.concurrent.atomic.AtomicInteger();
    private static final SecureRandom RND = new SecureRandom();
    // Flick's Connect screen is showing (the page says): discovery answers say so, so a device whose user holds Connect
    // nearby picks this phone when several are around
    private volatile boolean ready;
    private String nameCache;
    private long nameAt;
    // what's being sent to each phone, for History once it's there (sends to a phone go one at a time: the first is the
    // one going). Kept here, not in the page: a send can end after the page reloaded, or with no page at all.
    private final Map<String, List<List<JSONObject>>> outHist = new HashMap<String, List<List<JSONObject>>>();
    // what's being sent to other devices as Moving lists it: tid -> {the device, its key} (a send to a device can start
    // as the one before it is told sent: each ends its own)
    private final Map<String, String[]> outKeys = new HashMap<String, String[]>();

    // made: by stage() (its files came before its announcement: a card that says only "Files")
    // listed: in Transfers (its row started, or it ended before it was: see moving)
    private static final class In { String fid, name, from, device; boolean begun, made, listed; }

    private Peers(Context c) {
        ctx = c;
        dir = new File(c.getFilesDir(), "peers");
        dir.mkdirs();
        allowedFile = new Kept(new File(dir, "allowed.json"));
        linksFile = new Kept(new File(dir, "links.json"));
        allowed = allowedFile.map;
        links = linksFile.map;
        // what a send from another phone that was cut off (the app killed) left in Flick's own folder, and in
        // Download/Flick: nothing can continue it (before this process takes any: the server starts after, on LIFE)
        final File in = new File(c.getFilesDir(), "peer-in");
        LIFE.execute(new Runnable() { @Override public void run() {
            PeerServer.deleteTree(in);
            try { if (Files.granted(ctx)) Files.sweepPeerParts(); } catch (Throwable e) { /* (a day later: sweepParts) */ }
        } });
    }

    // ------------------------------------------------------------ lifecycle (MainActivity)
    /** Flick's screen is there: files can come in while it is. */
    void opened(MainActivity a) {
        myId = "ph-" + a.deviceId();
        devName = a.deviceName();
        // (the same name when Flick isn't open: what the other phones show for this one)
        try { if (!devName.equals(Bg.prefs(ctx).getString("devName", ""))) Bg.prefs(ctx).edit().putString("devName", devName).apply(); } catch (Throwable e) { /* the phone's own */ }
        synchronized (this) { pages++; nameCache = null; }
        // (pairings whose file couldn't be read when Flick started: read now, see Kept)
        boolean back;
        synchronized (serverSide) { back = allowedFile.again(); }
        synchronized (clientSide) { back |= linksFile.again(); }
        if (back) keysGen.incrementAndGet();
        apply();
    }

    /** Flick stays connected in the background (LinkService is up), or not any more: files can come in while it does. */
    void background(boolean on) {
        synchronized (this) { if (bg == on) return; bg = on; }
        apply();
    }

    /** Flick's screen is gone. The receiver stops a moment later (unless it's back by then). */
    void closed() {
        synchronized (this) { pages = Math.max(0, pages - 1); }
        Bg.mainDelayed(new Runnable() { @Override public void run() { apply(); } }, 3000);
    }

    boolean receiveOn() { return !"0".equals(Bg.prefs(ctx).getString(RECEIVE, "1")); }

    /** The page's Connect screen is showing (or not any more). */
    void setReady(boolean on) { ready = on; try { BleLink.ready(on); } catch (Throwable e) { /* no Bluetooth */ } }

    /** Bluetooth's permission was just given (or Bluetooth turned on): this phone can be reached over it now. */
    void bluetoothChanged() { if (server != null) { try { BleLink.serve(ctx, true); } catch (Throwable e) { Bg.warn("ble", e); } } }

    /**
     * A phone (by its Bluetooth hash, BleLink.hash) this phone reaches already: answering on the network now, or over a
     * link. proven (a paired phone looked for): only a link proven to be that phone's counts (a paired phone signed in
     * through it), not one that only says it is: the real one is still linked to when it's heard.
     */
    boolean linkedOver(String hashHex, boolean proven) {
        String pid = BleLink.idOf(hashHex);             // a paired phone's (its key known here), or null
        synchronized (tuns) {
            for (Map.Entry<String, Tunnel> e : tuns.entrySet()) {
                Tunnel t = e.getValue();
                if (t.isClosed() || (proven && !t.verified)) continue;
                // (one not paired here: only the advertisement a link was made to tells it's that one)
                if (pid != null ? pid.equals(e.getKey()) : hashHex.equals(t.heard)) return true;
            }
        }
        if (pid == null) return false;
        PeerClient c;
        synchronized (this) { c = client; }
        return c != null && c.onNetwork().contains(pid);
    }

    /** A paired phone signed in through the link at this local port: the link is that phone's (Tunnel.verified). */
    void tunnelVerified(String id, int port) {
        Tunnel t;
        synchronized (tuns) {
            t = tuns.get(id);
            if (t == null || t.port() != port) t = newer.get(id);
            if (t == null || t.port() != port) return;
        }
        proven(id, t);
    }

    /** A paired device signed in to this phone's receiver from this address (PeerServer): a link it came over is its. */
    void signedIn(String id, String address) {
        Tunnel t;
        synchronized (tuns) {
            t = tuns.get(id);
            if (t == null || !t.from().equals(address)) t = newer.get(id);
            if (t == null || !t.from().equals(address)) return;
        }
        proven(id, t);
    }

    // a link proven to be that phone's: one waiting to take another's place (a cable) takes it now
    private void proven(String id, Tunnel t) {
        Tunnel out = null;
        synchronized (tuns) {
            t.verified = true;
            if (newer.get(id) == t && !t.isClosed()) { newer.remove(id); out = tuns.put(id, t); }
        }
        if (out != null && out != t) { shown(id, t); out.close("replaced"); Bg.log("peers: " + nameOf(id) + " over " + t.via + " now"); }
    }

    // ------------------------------------------------------------ Bluetooth's key (BleLink, private hellos)
    /**
     * This phone's Bluetooth key: its advertisements are made with it (BleLink.hash), and its hello when Flick isn't on
     * screen (private). Only its paired phones get it, over their signed-in, pinned link (PeerServer's welcome, and this
     * phone signing in there). Made once; never logged.
     */
    byte[] bleKey() {
        synchronized (bleLock) {
            if (bleKey != null) return bleKey;
            android.content.SharedPreferences sp = Bg.prefs(ctx);
            byte[] k = key(sp.getString("bleKey", ""));
            if (k == null) { k = new byte[16]; RND.nextBytes(k); sp.edit().putString("bleKey", b64(k)).apply(); }
            return bleKey = k;
        }
    }

    /** The paired phones' Bluetooth keys known here: id -> its key (as its receiver said it, or as it said signing in here). */
    Map<String, List<byte[]>> bleKeys() {
        Map<String, List<byte[]>> m = new HashMap<String, List<byte[]>>();
        synchronized (clientSide) { keysIn(links, m); }
        synchronized (serverSide) { keysIn(allowed, m); }
        return m;
    }

    /** How many times what bleKeys() says may have changed (a key came, a pairing went). */
    int keysGen() { return keysGen.get(); }

    private static void keysIn(JSONObject o, Map<String, List<byte[]>> m) {
        for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
            String id = it.next();
            JSONObject r = o.optJSONObject(id);
            byte[] k = r == null ? null : key(r.optString("bk"));
            if (k == null) continue;
            List<byte[]> l = m.get(id);
            if (l == null) m.put(id, l = new ArrayList<byte[]>());
            boolean have = false;
            for (byte[] x : l) if (Arrays.equals(x, k)) have = true;
            if (!have) l.add(k);
        }
    }

    // a Bluetooth key as said ("bk": 16 bytes, base64), or null
    static byte[] key(String s) {
        if (s == null || s.length() != 24) return null;
        try { byte[] k = java.util.Base64.getDecoder().decode(s); return k.length == 16 ? k : null; } catch (IllegalArgumentException e) { return null; }
    }

    private static String b64(byte[] b) { return java.util.Base64.getEncoder().encodeToString(b); }

    private static byte[] mac(byte[] key, String s) throws Exception {
        javax.crypto.Mac m = javax.crypto.Mac.getInstance("HmacSHA256");
        m.init(new javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"));
        return m.doFinal(s.getBytes("UTF-8"));
    }

    // who this phone is, said so that only its paired phones can tell: a random n, and what this phone's key makes of it
    private JSONObject privately() throws Exception {
        byte[] n = new byte[16];
        RND.nextBytes(n);
        String ns = b64(n);
        return new JSONObject().put("kind", "phone").put("p", 1).put("n", ns).put("t", b64(Arrays.copyOf(mac(bleKey(), "flick-hello|" + ns), 16)));
    }

    // a private hello made out: the paired phone whose key makes t of n, as it's known here ({id, name, kind, ready}), or null
    private JSONObject resolve(String n, String t) {
        byte[] tb = key(t);                                    // (16 bytes too)
        if (tb == null || n.isEmpty() || n.length() > 64) return null;
        try {
            for (Map.Entry<String, List<byte[]>> e : bleKeys().entrySet()) {
                for (byte[] k : e.getValue()) {
                    if (java.security.MessageDigest.isEqual(Arrays.copyOf(mac(k, "flick-hello|" + n), 16), tb)) {
                        return new JSONObject().put("id", e.getKey()).put("name", nameOf(e.getKey())).put("kind", "phone").put("ready", false);
                    }
                }
            }
        } catch (Exception e) { /* none */ }
        return null;
    }

    /** "Let other phones send to this phone". */
    void setReceive(boolean on) {
        Bg.prefs(ctx).edit().putString(RECEIVE, on ? "1" : "0").apply();
        Transfers.multicast(ctx, shown && on);
        apply();
    }

    /** Flick is on screen (onStart), or not any more (onStop): while it is, other phones' broadcasts reach it. */
    void visible(boolean on) {
        shown = on;
        Transfers.multicast(ctx, on && receiveOn());
        try { BleLink.shown(on); } catch (Throwable e) { /* no Bluetooth */ }
        if (on) return;
        // a question asked while Flick was in front (on the page only) asks in a notification now, or it would run out
        // unseen
        final List<Q> open = new ArrayList<Q>();
        synchronized (qs) { for (Q q : qs.values()) if (q.yes == null && q.note == 0) open.add(q); }
        if (!open.isEmpty()) Bg.run("peers: ask", new Runnable() { @Override public void run() { for (Q q : open) notifyAsk(q); } });
    }

    private void apply() {
        try {
            LIFE.execute(new Runnable() {
                @Override public void run() {
                    boolean want, open;
                    synchronized (Peers.this) { open = pages > 0; want = (open || bg) && receiveOn() && (myId != null || Bg.deviceId(ctx) != null); }
                    if (want && server == null) {
                        try {
                            PeerServer s = new PeerServer(serverSide, PeerCert.ensure(new File(dir, "cert"), "Flick " + myId));
                            s.start(PORT, DISCOVERY);
                            server = s;
                            try { BleLink.serve(ctx, true); } catch (Throwable e) { Bg.warn("ble", e); }   // reachable over Bluetooth too
                            // (a Wi-Fi Direct network stays while a phone in it is connected here)
                            WifiDirect.inUse = new WifiDirect.InUse() {
                                @Override public boolean from(String prefix) { PeerServer x = server; return x != null && x.anyFrom(prefix); }
                            };
                        } catch (Throwable e) { Bg.warn("peers: can't take files", e); }
                        changed();
                    }
                    // ready before the page first asks (its encryption takes a moment to set up)
                    if (open) { try { client(); } catch (Throwable e) { Bg.warn("peers", e); } }
                    else synchronized (Peers.this) { if (client != null) { client.scan(false); client.fast(false); } }   // (no page to show them)
                    // Flick's screen gone while files are arriving: they finish first (the switch turned off stops at once)
                    if (!want && server != null && !open && receiveOn() && server.busy()) {
                        Bg.mainDelayed(new Runnable() { @Override public void run() { apply(); } }, 2000);
                        return;
                    }
                    if (!want && server != null) {
                        // (stopped first: once the page hears it doesn't take files, its port is free)
                        PeerServer s = server;
                        // Flick closed here (taking files still on, but nothing to take them for): the phones linked here hear
                        // so first (they say Flick was closed here, not that this phone can't be reached)
                        if (receiveOn()) s.bye();
                        s.stop();
                        server = null;
                        try { BleLink.serve(ctx, false); } catch (Throwable e) { /* ignore */ }
                        String d = null;
                        int seq = 0;
                        synchronized (askLock) { if (ask != null) { d = ask.optString("device"); ask = null; seq = ++askSeq; } }
                        if (d != null) Page.event("peer-ask-end", "device", d, "seq", seq);
                        changed();
                    }
                }
            });
        } catch (Throwable e) { Bg.warn("peers", e); }
    }

    // ------------------------------------------------------------ who this phone is to the others
    String id() { String i = myId; return i != null ? i : "ph-" + Bg.deviceId(ctx); }

    private String devName() {
        String d = devName;
        if (d == null) { try { d = Bg.prefs(ctx).getString("devName", ""); } catch (Throwable e) { d = ""; } }
        return d == null || d.length() == 0 ? Bg.deviceName(ctx) : d;
    }

    /** The name the page shows for this phone (Settings › phone name), or the phone's own. */
    String name() {
        long now = PeerServer.mono();
        synchronized (this) { if (nameCache != null && now - nameAt < 3000) return nameCache; }
        String n = "";
        try { n = new JSONObject(Bg.prefs(ctx).getString("p:settings", "{}")).optString("phoneName", "").trim(); } catch (Throwable e) { /* none set */ }
        if (n.length() == 0) n = devName();
        if (n.length() > 40) n = n.substring(0, 40);
        synchronized (this) { nameCache = n; nameAt = now; }
        return n;
    }

    // ------------------------------------------------------------ for the page (Bridge)
    synchronized PeerClient client() {
        if (client == null) {
            try { client = new PeerClient(clientSide, DISCOVERY); }
            catch (Exception e) { throw new IllegalStateException(e); }
        }
        return client;
    }

    /** The other phones (PeerClient.state()), and on: this one takes files; ask: a phone asking to pair. */
    JSONObject state() {
        PeerClient c;
        synchronized (this) { c = client; }
        JSONObject s = c != null ? c.state() : pairedOnly();
        try {
            // files from each: saved as they come, or after Accept here ("Ask each time"); and what's waiting for it
            JSONArray ds = s.optJSONArray("devices");
            for (int i = 0; ds != null && i < ds.length(); i++) { JSONObject d = ds.optJSONObject(i); if (d != null && asks(d.optString("id"))) d.put("ask", true); }
            JSONArray qa = new JSONArray();
            synchronized (qs) { for (Q q : qs.values()) if (q.yes == null) qa.put(q.json()); }
            s.put("accepts", qa);
            s.put("on", receiveOn());
            s.put("receiving", server != null);
            s.put("me", name());
            synchronized (askLock) {
                JSONObject a = ask;
                if (a != null) s.put("ask", a);
                s.put("askSeq", askSeq);
            }
        } catch (Throwable e) { /* can't fail */ }
        return s;
    }

    /** Before the client is there: the paired phones as they were last seen (none nearby yet). */
    private JSONObject pairedOnly() {
        JSONObject s = new JSONObject();
        try {
            JSONArray a = new JSONArray();
            synchronized (clientSide) {
                for (java.util.Iterator<String> it = links.keys(); it.hasNext(); ) {
                    String id = it.next();
                    JSONObject l = links.optJSONObject(id);
                    JSONObject d = new JSONObject();
                    d.put("id", id); d.put("name", l == null ? "Phone" : l.optString("name", "Phone")); d.put("kind", "phone");
                    d.put("paired", true); d.put("nearby", false);
                    a.put(d);
                }
            }
            s.put("scanning", false);
            s.put("devices", a);
        } catch (Throwable e) { /* empty */ }
        return s;
    }

    /** The page's answer to a phone asking to pair (on a thread of its own: telling the other phone is network work,
     *  and the page's call returns at once whatever that phone does). */
    void answer(final String device, final boolean allow) {
        final PeerServer s = server;
        if (s == null) return;
        Thread t = new Thread(new Runnable() {
            @Override public void run() { try { if (allow) s.approve(device); else s.deny(device); } catch (Throwable e) { Bg.warn("peers: answer", e); } }
        }, "flick-peer-answer");
        t.setDaemon(true);
        t.start();
    }

    /**
     * items (JSON): [{path} | {id}]: files and folders in shared storage, or Flick-list items. "ok", "busy",
     * "unpaired" or "none" (nothing there to send).
     */
    String send(String id, String itemsJson) { return send(id, itemsJson, null); }

    /** The same, flicked off the screen (fx: { look, y, vx }): its card arrives on the other phone the same way. */
    String send(String id, String itemsJson, String fxJson) {
        JSONObject fx = null;
        try { if (fxJson != null && fxJson.length() > 0 && fxJson.length() < 2000) fx = new JSONObject(fxJson); } catch (Throwable e) { /* sent plainly */ }
        List<File> files = new ArrayList<File>();
        List<String> names = new ArrayList<String>();
        List<JSONObject> hist = new ArrayList<JSONObject>();      // each item as History will show it
        try {
            JSONArray a = new JSONArray(itemsJson);
            Library lib = Library.get(ctx);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                String p = o.optString("path", "");
                if (p.length() > 0) {
                    File f = new File(p);
                    if (Files.allowed(f) && f.exists()) {
                        files.add(f); names.add(null);
                        boolean dir = f.isDirectory();
                        if (hist.size() < 300) hist.add(histEntry("out", f.getName(), dir ? 0 : f.length(), f.getPath(), null, dir ? "folder" : PeerClient.kindOf(f.getName())));
                    }
                    continue;
                }
                JSONObject it = lib.find(o.optString("id", ""));
                if (it == null) continue;
                File f = lib.fileOf(it);
                if (f.isFile()) {
                    String nm = it.optString("name", f.getName());
                    files.add(f); names.add(nm);
                    if (hist.size() < 300) hist.add(histEntry("out", nm, f.length(), null, it.optString("id", ""), PeerClient.kindOf(nm)));
                }
            }
        } catch (Throwable e) { Bg.warn("peers: send", e); }
        if (files.isEmpty()) return "none";
        synchronized (outHist) {
            List<List<JSONObject>> q = outHist.get(id);
            if (q == null) { q = new ArrayList<List<JSONObject>>(); outHist.put(id, q); }
            q.add(hist);
        }
        String r = client().send(id, files, names, fx);
        if (!"ok".equals(r)) {
            synchronized (outHist) {
                List<List<JSONObject>> q = outHist.get(id);
                for (int i = q == null ? -1 : q.size() - 1; i >= 0; i--) if (q.get(i) == hist) { q.remove(i); break; }
                if (q != null && q.isEmpty()) outHist.remove(id);
            }
        }
        return r;
    }

    // ------------------------------------------------------------ besides files: a clipboard, a link, find my phone
    /**
     * what: "clip" (payload: {kind:"text", text} | {kind:"image", png}), "link" (payload: the address), "ring" (payload
     * "on" | "off"), to a paired phone. The answer: the page's event 'peer-msg' {req, id, what, ok, why} (req: the
     * page's id for it), and done (the app's own: a tile), either or both.
     */
    void message(final String id, final String what, String payload, final String req, final PeerClient.Done done) {
        JSONObject m = new JSONObject();
        String cap = what;
        try {
            if ("clip".equals(what)) {
                JSONObject c = new JSONObject(payload);
                String k = c.optString("kind");
                m.put("t", "clip").put("kind", k);
                if ("text".equals(k)) m.put("text", c.optString("text", "")); else m.put("png", c.optString("png", ""));
                // an app marked it private (a password): the other phone keeps no history of it, nor shows it
                if (c.optBoolean("private", false)) m.put("private", true);
            } else if ("link".equals(what)) {
                if (!Links.ok(payload)) throw new IllegalArgumentException("not a link");
                m.put("t", "link").put("url", payload);
            } else if ("ring".equals(what)) {
                m.put("t", "on".equals(payload) ? "ring" : "ring-stop");
                if ("on".equals(payload)) m.put("sec", 30);
            } else throw new IllegalArgumentException(what);
        } catch (Throwable e) {
            answer(id, what, req, "bad", done);
            return;
        }
        try {
            client().message(id, cap, m, new PeerClient.Done() {
                @Override public void done(String why) { answer(id, what, req, why, done); }
            });
        } catch (Throwable e) { answer(id, what, req, "unreachable", done); }
    }

    private void answer(String id, String what, String req, String why, PeerClient.Done done) {
        if (req != null && req.length() > 0) Page.event("peer-msg", "req", req, "id", id, "what", what, "ok", why == null, "why", why == null ? "" : why);
        if (done != null) { try { done.done(why); } catch (Throwable e) { Bg.warn("peers", e); } }
    }

    /** A phone this one can send to. */
    boolean paired(String id) { synchronized (clientSide) { return id != null && links.has(id); } }

    /** How many phones this one can send to. */
    int pairedCount() { synchronized (clientSide) { return links.length(); } }

    /** The one phone this one can send to, if there's exactly one; else null. */
    String onlyPaired() {
        synchronized (clientSide) {
            if (links.length() != 1) return null;
            return links.keys().next();
        }
    }

    /** A paired phone's name as this one keeps it. */
    String nameOf(String id) {
        synchronized (clientSide) {
            JSONObject l = links.optJSONObject(id);
            if (l != null) return l.optString("name", "Phone");
        }
        synchronized (serverSide) {
            JSONObject a = allowed.optJSONObject(id);
            return a == null ? "Phone" : a.optString("name", "Phone");
        }
    }

    /** The phone that rang this one (find my phone) hears it was found: over its link here if it's still there, else
     *  over this phone's own to it. */
    void ringStopped(final String device) {
        PeerServer s = server;
        try {
            if (s != null && s.tell(device, new JSONObject().put("t", "ring-found"))) return;
            boolean back;
            synchronized (clientSide) { back = links.has(device); }
            if (back) client().message(device, "ring", new JSONObject().put("t", "ring-found"), new PeerClient.Done() { @Override public void done(String why) { /* told, or it gave up by itself */ } });
        } catch (Throwable e) { Bg.warn("peers: found", e); }
    }

    // ------------------------------------------------------------ over a USB cable or Bluetooth (Tunnel)
    // other phone's id -> its link (one at a time each: a newer one replaces it, unless that one is proven or in use)
    private final Map<String, Tunnel> tuns = new HashMap<String, Tunnel>();
    // a faster link (a cable) to a phone whose link here is proven or in use: tried, and it takes that one's place once
    // it's proven too (anything can switch a phone over as a USB accessory and say it's a phone with Flick) (under tuns)
    private final Map<String, Tunnel> newer = new HashMap<String, Tunnel>();
    // links not proven yet at most (Bluetooth: anyone in range can link, saying it's any phone, a paired one too): room is
    // made for a new one, never refused (a cable, and one a paired phone signed in through: never counted, never ended
    // for room). With their few streams each (Tunnel.MAX_UNPROVEN), well within the links' share of the receiver's
    // places (PeerServer.admit), which the others aren't held to.
    private static final int MAX_STRANGERS = 3;

    /**
     * A link to another phone that isn't the network (a USB cable between the two, Bluetooth): in and out are its byte
     * streams, link is closed when it ends, first says this side started it. Returns at once, before the two sides
     * said who they are: the other phone shows up as nearby once they have (and the page hears 'tunnel').
     */
    Tunnel tunnel(java.io.InputStream in, java.io.OutputStream out, java.io.Closeable link, final String via, boolean first) throws IOException {
        return tunnel(in, out, link, via, first, null);
    }

    /** The same, from the device at address from (Bluetooth's; null: not known). */
    Tunnel tunnel(java.io.InputStream in, java.io.OutputStream out, java.io.Closeable link, final String via, boolean first, String from) throws IOException {
        return tunnel(in, out, link, via, first, from, null);
    }

    /** The same, made to the advertisement heard (its hash, BleLink: a phone not paired here is known by it; or null). */
    Tunnel tunnel(java.io.InputStream in, java.io.OutputStream out, java.io.Closeable link, final String via, boolean first, String from, String heard) throws IOException {
        final Tunnel t = new Tunnel(in, out, link, via, first, new Tunnel.Host() {
            @Override public void hello(Tunnel tn, JSONObject who) {
                said(tn);
                if (who.optInt("p") == 1) {
                    // said so that only its paired phones can tell: which of this phone's it is (none: the link ends)
                    JSONObject w = resolve(who.optString("n"), who.optString("t"));
                    if (w == null) { tn.close("unknown"); return; }
                    tn.known(w);
                    who = w;
                } else if (!shown && !looking && !"usb".equals(via) && !known(who.optString("id"))) {
                    // Flick isn't on screen here: a phone this one isn't paired with gets nothing, and its link ends
                    tn.close("not paired");
                    return;
                }
                String id = who.optString("id");
                Tunnel old, room = null;
                boolean refused = false, tried = false;
                synchronized (tuns) {
                    if (tn.isClosed()) return;                       // (ended meanwhile: it isn't listed)
                    old = tuns.get(id);
                    if (old == tn || (old != null && old.isClosed())) old = null;
                    if (old != null && (old.verified || old.usedHere() || NetKind.rank(old.via) > NetKind.rank(tn.via))) {
                        // A link proven to be that phone's (it signed in through it, here or there), in use here, or a
                        // cable (nobody fakes a cable from across the room) stays: another one only saying it's that phone
                        // doesn't take its place. A faster one (a cable rather than Bluetooth) is tried meanwhile, and
                        // takes its place once it's proven too.
                        if (NetKind.rank(tn.via) > NetKind.rank(old.via)) { room = newer.put(id, tn); tried = true; }
                        else refused = true;
                    } else {
                        if (old == null && !"usb".equals(tn.via)) room = strangerRoom();
                        tuns.put(id, tn);
                    }
                }
                if (refused) { tn.close("refused"); return; }
                if (room != null && room != tn) {
                    room.close(tried ? "replaced" : "too many");
                    if (!tried) left(room);                          // (out of the list already: see strangerRoom)
                }
                if (old != null && !tried) old.close("replaced");
                linkUp(id, tn, !tried);                           // (one tried: the page hears of it once it's proven)
                Bg.log("peers: " + who.optString("name") + " over " + via + (tried ? " (tried: the link there is kept until this one is proven)" : ""));
            }
            @Override public int localPort() { PeerServer s = server; return s != null && s.running() ? s.port : 0; }
            @Override public void closed(Tunnel tn, String why) {
                said(tn);
                JSONObject who = tn.peer();
                String id = who == null ? null : who.optString("id");
                if (id == null) return;
                Tunnel back = null, next = null;
                synchronized (tuns) {
                    if (newer.get(id) == tn) {
                        // the one tried instead (not proven): the one kept is the way to it again
                        newer.remove(id);
                        back = tuns.get(id);
                        if (back != null && back.isClosed()) back = null;
                    } else if (tuns.get(id) == tn) {
                        tuns.remove(id);
                        // one tried meanwhile takes its place (there's no proven one any more)
                        next = newer.remove(id);
                        if (next != null && !next.isClosed()) tuns.put(id, next); else next = null;
                    } else return;
                }
                try { client().tunnelDown(id, tn.port()); } catch (Throwable e) { /* ignore */ }
                if (back == null) Page.event("tunnel", "id", id, "name", who.optString("name"), "via", tn.via, "on", false);
                if (back != null) linkUp(id, back, false);
                if (next != null) shown(id, next);
                Bg.log("peers: " + tn.via + " link ended (" + why + ")");
            }
        });
        t.heard = heard;
        // Who this phone is: said to anyone while Flick is on screen here, looking, or on a cable (Connect needs it);
        // otherwise so that only its paired phones can tell (anything else in range learns nothing from it)
        JSONObject me;
        try { me = shown || looking || "usb".equals(via) ? new JSONObject().put("id", id()).put("name", name()).put("kind", "phone").put("ready", ready && shown) : privately(); }
        catch (Exception e) { throw new IOException(e); }
        if ("bluetooth".equals(via)) t.idleAfter(120000);         // (made again when wanted: a scan finds it in seconds)
        // Links from others that are still to say who they are (anyone in Bluetooth range can open any number): a few at
        // a time, one from each device; one more makes the oldest end, rather than wait behind links that never greet. A
        // phone greets and says who it is at once. (A link this phone made, and a cable: never held back.)
        if (!first && !"usb".equals(via)) {
            if ("bluetooth".equals(via)) t.hurry(2500, 5000);
            List<Tunnel> gone = new ArrayList<Tunnel>();
            synchronized (unsaid) {
                for (java.util.Iterator<Object[]> it = unsaid.iterator(); it.hasNext(); ) { Object[] x = it.next(); if (from != null && from.equals(x[1])) { gone.add((Tunnel) x[0]); it.remove(); } }
                while (unsaid.size() >= MAX_UNSAID) gone.add((Tunnel) unsaid.remove(0)[0]);
                unsaid.add(new Object[]{t, from});
            }
            for (Tunnel x : gone) x.close("too many waiting");
        }
        try { t.start(me); }
        catch (IOException e) { t.close("greeting: " + e.getMessage()); throw e; }
        return t;
    }

    // links from others still to say who they are, oldest first: {Tunnel, the address it came from} (under itself)
    private final List<Object[]> unsaid = new ArrayList<Object[]>();
    private static final int MAX_UNSAID = 8;            // (several phones linking in at the same moment all fit)

    // a link said who it is (or ended): it's no longer waiting
    private void said(Tunnel t) {
        synchronized (unsaid) { for (java.util.Iterator<Object[]> it = unsaid.iterator(); it.hasNext(); ) if (it.next()[0] == t) { it.remove(); return; } }
    }

    // the phone at the other end of link t can be reached over it (PeerClient), and the page hears it's there (page)
    private void linkUp(String id, Tunnel t, boolean page) {
        JSONObject who = t.peer();
        if (who == null) return;
        try { client().tunnelUp(id, who.optString("name"), who.optString("kind"), t.port(), t.via, who.optBoolean("ready")); } catch (Throwable e) { Bg.warn("peers: tunnel", e); }
        if (page) shown(id, t);
    }

    private void shown(String id, Tunnel t) {
        JSONObject who = t.peer();
        if (who != null) Page.event("tunnel", "id", id, "name", who.optString("name"), "via", t.via, "on", true, "paired", paired(id));
    }

    // paired with this phone, either way
    private boolean known(String id) {
        if (paired(id)) return true;
        synchronized (serverSide) { return allowed.has(id); }
    }

    // (under tuns) the link that makes way for a new one not proven yet, when there are as many of those as there may be:
    // one with nothing going through it before one in use, one saying it's a phone not paired here before one saying
    // it's a paired one (whose own link is proven in a moment: it signs in through it), and of those the oldest; null:
    // there's room. It's out of the list at once (so links coming at the same moment don't all count it), and ends a
    // moment later.
    private Tunnel strangerRoom() {
        Tunnel out = null;
        int n = 0, first = -1;
        for (Map.Entry<String, Tunnel> e : tuns.entrySet()) {
            Tunnel x = e.getValue();
            if (x.isClosed() || "usb".equals(x.via) || x.verified) continue;
            n++;
            int which = (x.busy() ? 0 : 2) + (known(e.getKey()) ? 0 : 1);
            if (which > first || (which == first && x.born() < out.born())) { out = x; first = which; }
        }
        if (n < MAX_STRANGERS) return null;
        tuns.values().remove(out);
        return out;
    }

    // a cable's link, or one a paired phone signed in through, comes from this address (PeerServer: what comes over it
    // isn't held to the share of the links not proven)
    private boolean trustedLink(String address) {
        synchronized (tuns) {
            for (Tunnel t : tuns.values()) if (t.from().equals(address)) return "usb".equals(t.via) || t.verified;
            for (Tunnel t : newer.values()) if (t.from().equals(address)) return "usb".equals(t.via) || t.verified;
        }
        return false;
    }

    // a link that was in the list ended (taken out of it already): the phone at its end isn't reachable over it
    private void left(Tunnel t) {
        JSONObject who = t.peer();
        String id = who == null ? null : who.optString("id");
        if (id == null) return;
        try { client().tunnelDown(id, t.port()); } catch (Throwable e) { /* ignore */ }
        Page.event("tunnel", "id", id, "name", who.optString("name"), "via", t.via, "on", false);
    }

    // ------------------------------------------------------------ "Ask each time": files from a device wait for Accept
    static final long ACCEPT_MS = 60000;
    private static final class Q {
        String tid, device, from, name, kind;
        long size; int count; boolean folder;
        JSONObject file; In in;                                   // its announcement, for the card once it's accepted
        volatile Boolean yes; volatile String why;
        volatile int note;                                        // its notification (0: none)
        JSONObject json() {
            JSONObject o = new JSONObject();
            try { o.put("tid", tid); o.put("from", from); o.put("fromId", device); o.put("name", name); o.put("size", size); o.put("count", count); o.put("kind", kind); o.put("folder", folder); }
            catch (Exception e) { /* as far as it got */ }
            return o;
        }
    }
    private final Map<String, Q> qs = new java.util.LinkedHashMap<String, Q>();   // tid -> its question (under qs)
    private static final int ASK_NOTE = 4000, ASK_NOTES = 1024;
    private int nextNote;                                         // (under qs)

    /** Files from this device wait for Accept here ("Ask each time", kept with its pairing). */
    boolean asks(String device) {
        if (device == null || device.isEmpty()) return false;
        synchronized (serverSide) { JSONObject a = allowed.optJSONObject(device); return a != null && a.optBoolean("ask", false); }
    }

    /** "Ask each time" (on) or "Always accept" for files from a paired device. */
    void setAsk(String device, boolean on) {
        synchronized (serverSide) {
            JSONObject a = allowed.optJSONObject(device);
            if (a == null) return;
            try { if (on) a.put("ask", true); else a.remove("ask"); } catch (Exception e) { return; }
            serverSide.saved();
        }
    }

    // asked: the sender hears to wait ('asking'), a notification when Flick isn't in front, the page shows the question
    // (the notification first: whatever hears of the question from the page finds it there already)
    private void question(final Q q) {
        synchronized (qs) { qs.put(q.tid, q); }
        PeerServer s = server;
        try { if (s != null) s.push(q.device, new JSONObject().put("t", "asking").put("tid", q.tid)); } catch (Exception e) { /* it waits anyway */ }
        if (!Page.inFront()) notifyAsk(q);
        JSONObject e = q.json();
        try { e.put("t", "peer-accept"); Page.emit(e); } catch (Exception x) { /* the state has it */ }
        changed();
        Bg.mainDelayed(new Runnable() { @Override public void run() { decide(q.tid, false, "timeout"); } }, ACCEPT_MS);
    }

    /** The user's answer (the page, the notification's buttons), or no answer in time ("timeout"). */
    void decide(String tid, boolean yes, String why) { settle(tid, yes, why); }

    // the same; false when there was no question about tid waiting for an answer (answered already, or none)
    private boolean settle(String tid, boolean yes, String why) {
        Q q;
        synchronized (qs) {
            q = tid == null ? null : qs.get(tid);
            if (q == null || q.yes != null) return false;
            q.why = yes ? null : why == null || why.isEmpty() ? "declined" : why;
            q.yes = yes;
            qs.notifyAll();
        }
        noteGone(q);
        Page.event("peer-accept-end", "tid", tid, "yes", yes);
        changed();
        if (yes) {
            // its card now (it was held back while the question was up), and the transfer in the notification and Settings;
            // and like any send announced, given up if its files never start coming
            if (q.in != null && q.file != null) { announce(q.in, q.file); moving(tid, q.in, q.file); noShow(tid); }
        } else {
            // (still coming: it stops now, and its sender is told; over the network, so never on the main thread: the
            // notification's Decline and the question's time running out come from there)
            final PeerServer s = server;
            final String t = tid, w = q.why;
            // (its transfer's end takes the question off the list: one whose end is never heard of, its sender gone
            // without a word, would stay there for good with its announcement)
            final Q done = q;
            Bg.mainDelayed(new Runnable() { @Override public void run() { synchronized (qs) { if (qs.get(t) == done) qs.remove(t); } } }, 10 * 60000L);
            if (s != null) {
                Thread th = new Thread(new Runnable() { @Override public void run() { try { s.refuse(t, w); } catch (Throwable e) { Bg.warn("peers: refuse", e); } } }, "flick-refuse");
                th.setDaemon(true);
                th.start();
            }
        }
        return true;
    }

    // a question that's over (answered, or its transfer ended): gone from the list and the notification shade
    private void dropQuestion(String tid) {
        Q q;
        synchronized (qs) { q = qs.remove(tid); if (q != null && q.yes == null) { q.yes = false; q.why = "canceled"; } qs.notifyAll(); }
        if (q == null) return;
        noteGone(q);
        Page.event("peer-accept-end", "tid", tid, "yes", false);
        changed();
    }

    // "2.1 MB", as the page writes sizes (app.js fmtSize)
    static String human(long n) {
        if (n < 1024) return n + " bytes";
        if (n < 1024L * 1024) return Math.max(1, Math.round(n / 1024.0)) + " KB";
        if (n < 1024L * 1024 * 1024) return String.format(java.util.Locale.US, n < 10L * 1048576 ? "%.1f MB" : "%.0f MB", n / 1048576.0);
        return String.format(java.util.Locale.US, "%.1f GB", n / 1073741824.0);
    }

    private void noteGone(Q q) {
        if (q.note == 0) return;
        try { NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE); if (nm != null) nm.cancel(q.note); } catch (Throwable e) { /* ignore */ }
    }

    @SuppressWarnings("deprecation")
    private void notifyAsk(Q q) {
        try {
            Features.channels(ctx);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            // one no other question showing has (each its own Accept and Decline); answered meanwhile: none
            int id = 0;
            synchronized (qs) {
                if (q.yes != null || q.note != 0) return;
                for (int k = 0; k < ASK_NOTES && id == 0; k++) {
                    int c = ASK_NOTE + nextNote;
                    nextNote = (nextNote + 1) % ASK_NOTES;
                    boolean used = false;
                    for (Q o : qs.values()) used |= o.note == c;
                    if (!used) id = c;
                }
                if (id == 0) return;                              // (over a thousand at once: the page lists them)
                q.note = id;
            }
            Intent yes = new Intent(ctx, ActionReceiver.class).setAction(ActionReceiver.ACCEPT).putExtra("tid", q.tid);
            Intent no = new Intent(ctx, ActionReceiver.class).setAction(ActionReceiver.DECLINE).putExtra("tid", q.tid);
            PendingIntent py = PendingIntent.getBroadcast(ctx, id * 2, yes, Features.piFlags());
            PendingIntent pn = PendingIntent.getBroadcast(ctx, id * 2 + 1, no, Features.piFlags());
            PendingIntent open = PendingIntent.getActivity(ctx, id, new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), Features.piFlags());
            String what = q.folder ? "the folder " + q.name : q.count > 1 ? q.count + " items" : q.name;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, Features.CH_ASK) : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH);
            b.setSmallIcon(Features.icon(ctx, "ic_stat_flick", android.R.drawable.stat_sys_download))
                .setContentTitle(q.from + " wants to send you " + what)
                .setContentText(q.size > 0 ? human(q.size) + ". Accept to save it." : "Accept to save it.")
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Decline", pn).build())
                .addAction(new Notification.Action.Builder(null, "Accept", py).build());
            if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(ACCEPT_MS);
            nm.notify(id, b.build());
            // (answered while it was being shown: it goes again)
            boolean over;
            synchronized (qs) { over = q.yes != null; }
            if (over) nm.cancel(id);
        } catch (Throwable e) { Bg.warn("peers: ask", e); }
    }

    // ------------------------------------------------------------ History (what the page shows under History)
    private static JSONObject histEntry(String dir, String name, long size, String path, String libId, String kind) {
        JSONObject e = new JSONObject();
        try {
            e.put("dir", dir); e.put("name", name == null || name.isEmpty() ? "File" : name); e.put("size", Math.max(0, size));
            if (path != null && path.length() > 0) e.put("path", path); else if (libId != null && libId.length() > 0) e.put("libId", libId);
            if (kind != null && kind.length() > 0) e.put("kind", kind);
            e.put("how", "phone");
        } catch (Exception x) { /* as far as it got */ }
        return e;
    }

    /** The card of files from another phone landed on this screen (fid: the page's id for it): that phone is told. */
    void landed(String fid) {
        if (fid == null || !fid.startsWith("p-")) return;
        String tid = fid.substring(2), device;
        synchronized (ins) { device = fromOf.get(tid); }
        PeerServer s = server;
        if (device == null || device.isEmpty() || s == null) return;
        try { s.push(device, new JSONObject().put("t", "landed").put("tid", tid)); } catch (Throwable e) { /* only a thud */ }
    }

    /** The entries of a transfer with another phone go into History: who, when, whether it went. */
    private void history(List<JSONObject> entries, String device, String who, boolean ok, String why) {
        if (entries == null || entries.isEmpty()) return;
        try {
            long now = System.currentTimeMillis();
            JSONArray all = new JSONArray();
            for (JSONObject e : entries) {
                e.put("time", now); e.put("pc", device == null ? "" : device); e.put("pcName", who == null || who.isEmpty() ? "another phone" : who);
                e.put("ok", ok);
                if (why != null) e.put("why", why);
                all.put(e);
            }
            Bg.history(ctx).addJson(all.toString());          // (one write for all of them)
            Page.historyChanged();
        } catch (Throwable x) { Bg.warn("peers: history", x); }
    }

    private List<JSONObject> takeHist(String id) {
        synchronized (outHist) {
            List<List<JSONObject>> q = outHist.get(id);
            List<JSONObject> h = q == null || q.isEmpty() ? null : q.remove(0);
            if (q != null && q.isEmpty()) outHist.remove(id);
            return h;
        }
    }

    /** Something the page shows changed: it's told (at most every 120 ms; the state is made off its thread). */
    void changed() {
        synchronized (this) { if (pushing) return; pushing = true; }
        Bg.mainDelayed(new Runnable() {
            @Override public void run() {
                Bg.run("peers", new Runnable() {
                    @Override public void run() {
                        synchronized (Peers.this) { pushing = false; }
                        if (Page.get() == null) return;
                        try { JSONObject o = new JSONObject(); o.put("t", "peers"); o.put("state", state()); Page.emit(o); }
                        catch (Throwable e) { /* ignore */ }
                    }
                });
            }
        }, 120);
    }

    // ------------------------------------------------------------ files from other phones (PeerServer)
    private static String fid(String tid) { return "p-" + tid; }

    private final class ServerSide implements PeerServer.Host {
        @Override public String id() { return Peers.this.id(); }
        @Override public String name() { return Peers.this.name(); }
        @Override public JSONObject allowed() { return allowed; }
        // (the list shows the phones paired one way too: it changes with this)
        @Override public void saved() { allowedFile.save(); keysGen.incrementAndGet(); changed(); }
        @Override public String bleKey() { return b64(Peers.this.bleKey()); }
        @Override public boolean trustedLink(String address) { return Peers.this.trustedLink(address); }
        @Override public void linkBack(String id, String name, String kind, String fp, String token, String addr) { client().addLink(id, name, kind, fp, token, addr); }
        @Override public void unlinked(String id) { client().forget(id, false); }
        @Override public void renamed(String id, String name) { client().rename(id, name); }
        @Override public void signedIn(String id, String address) { Peers.this.signedIn(id, address); }
        @Override public boolean ready() { return ready && shown; }
        @Override public String homeId() {
            String i = Bg.deviceId(ctx), me = myId;
            return i != null ? i : me != null && me.startsWith("ph-") ? me.substring(3) : "";
        }

        @Override
        public boolean answers(String device) {
            // Flick on screen here, or looking for phones (Connect needs it): anyone. Closed, or only in the background
            // (its screen still there behind another app's): as over Bluetooth, only a device paired with this phone
            if (shown || looking) return true;
            if (device == null || device.isEmpty()) return false;
            synchronized (serverSide) { if (allowed.has(device)) return true; }
            synchronized (clientSide) { return links.has(device); }
        }

        @Override
        public boolean pcPaired(String pcId) {
            try { return pcId != null && !pcId.isEmpty() && Bg.prefs(ctx).getString("p:token:" + pcId, "").length() > 0; } catch (Throwable e) { return false; }
        }

        @Override
        public void homePaired(String pcId, String name, String token, String fp, int port, JSONArray addrs, String ip) {
            // This phone's pairing with that PC, kept where the page keeps the pairings it makes itself (app.js:
            // token:<id>, pin:<id>, knownPcs), so it is the same as one made by holding Connect here; the page then
            // connects to it (pc-paired). The PC is the one in use from now on. (One paired with it meanwhile stays.)
            if (pcPaired(pcId)) { Bg.log("peers: already paired with " + name + ": its pairing stays"); return; }
            try {
                android.content.SharedPreferences sp = Bg.prefs(ctx);
                JSONObject known;
                try { known = new JSONObject(sp.getString("p:knownPcs", "{}")); } catch (Throwable e) { known = new JSONObject(); }
                JSONObject e = known.optJSONObject(pcId);
                if (e == null) e = new JSONObject();
                JSONArray ips = new JSONArray();
                if (ip != null && ip.matches("\\d{1,3}(\\.\\d{1,3}){3}")) ips.put(ip);
                for (int i = 0; i < addrs.length() && ips.length() < 8; i++) { String a = addrs.optString(i); boolean dup = false; for (int k = 0; k < ips.length(); k++) dup |= a.equals(ips.optString(k)); if (!dup) ips.put(a); }
                e.put("name", name); e.put("last", System.currentTimeMillis()); e.put("addrs", ips);
                known.put(pcId, e);
                sp.edit().putString("p:token:" + pcId, token).putString("p:pin:" + pcId, fp).putString("p:knownPcs", known.toString())
                    .putString("p:lastPc", pcId).putString("p:lastPcName", name).putString("p:lastPcTls", "1")
                    .putString("p:lastPcAddr", (ips.length() > 0 ? ips.optString(0) : ip) + ":" + port).apply();
                JSONObject pc = new JSONObject();
                pc.put("id", pcId); pc.put("name", name); pc.put("ip", ips.length() > 0 ? ips.optString(0) : ip); pc.put("port", port); pc.put("tls", 1); pc.put("v", 8);
                pc.put("addrs", ips);
                JSONObject ev = new JSONObject();
                ev.put("t", "pc-paired"); ev.put("pc", pc);
                Page.emit(ev);
            } catch (Throwable x) { Bg.warn("peers: pc pairing", x); }
        }

        @Override
        public void homeEnded(String pcId, String name) {
            // (the page, waiting for pc-paired since its user allowed it, says it isn't paired)
            Bg.log("peers: " + name + " didn't finish pairing");
            Page.event("pc-pair-end", "device", pcId, "name", name);
        }

        @Override
        public void pairRequest(String device, String name, String kind, String code, boolean again) {
            int seq;
            try {
                synchronized (askLock) {
                    JSONObject a = new JSONObject();
                    seq = ++askSeq;
                    a.put("device", device); a.put("name", name); a.put("code", code); a.put("seq", seq); a.put("again", again);
                    a.put("kind", "pc".equals(kind) ? "pc" : "phone");
                    ask = a;
                }
            } catch (Throwable e) { return; }
            Page.event("peer-ask", "device", device, "name", name, "code", code, "seq", seq, "again", again, "kind", "pc".equals(kind) ? "pc" : "phone");
            changed();
        }

        @Override
        public void pairCancel(String device) {
            int seq;
            synchronized (askLock) {
                JSONObject a = ask;
                if (a == null || !device.equals(a.optString("device"))) return;
                ask = null;
                seq = ++askSeq;
            }
            Page.event("peer-ask-end", "device", device, "seq", seq);
            changed();
        }

        @Override
        public File stage(String tid) throws IOException {
            // next to where the files will stay, so putting them there is a rename
            File d = Files.granted(ctx) ? Files.peerStage(tid) : new File(ctx.getFilesDir(), "peer-in/" + tid);
            PeerServer.deleteTree(d);
            if (!d.mkdirs()) throw new IOException("can't make a folder for the files");
            In in;
            boolean told = true;
            synchronized (ins) {
                in = ins.get(tid);
                // (its announcement can come a moment after its files start, over the other connection: it's waited
                // for briefly, so the card says what they are and from whom)
                long until = PeerServer.mono() + 1500;
                while (in == null && !over.containsKey(tid)) {
                    long left = until - PeerServer.mono();
                    if (left <= 0) break;
                    try { ins.wait(left); } catch (InterruptedException e) { break; }
                    in = ins.get(tid);
                }
                // (stopped meanwhile, by its sender's Cancel: no card for it)
                if (in == null && over.containsKey(tid)) { PeerServer.deleteTree(d); throw new IOException("stopped"); }
                if (in == null) { in = new In(); in.fid = fid(tid); in.name = "Files"; in.from = ""; in.device = ""; in.made = true; ins.put(tid, in); told = false; }
                in.begun = true;
            }
            if (!told) { announce(in, new JSONObject()); moving(tid, in, new JSONObject()); }
            return d;
        }

        @Override
        public boolean room(long bytes) {
            try {
                boolean shared = Files.granted(ctx);
                long slack = 64L * 1024 * 1024;
                // (a claimed size this big has no room anywhere: and the sum below would go past what a long holds)
                if (bytes > (Long.MAX_VALUE - slack) / 2) return false;
                // without access to shared storage a file is kept twice for a moment: in Flick, and its public copy
                long need = Math.max(0, bytes) * (!shared && Build.VERSION.SDK_INT >= 29 ? 2 : 1) + slack;
                return (shared ? Files.inbox() : ctx.getFilesDir()).getUsableSpace() >= need;
            } catch (Throwable e) { return true; }
        }

        @Override
        public void incoming(final String tid, String device, String from, JSONObject file) {
            In in = new In();
            in.fid = fid(tid);
            in.name = file.optString("name", "Files");
            in.from = from;
            in.device = device;
            In late = null;
            synchronized (ins) {
                In x = ins.get(tid);
                fromOf.put(tid, device);
                // its files came first (a card that says only "Files" is up): what they are and whom from, for when
                // they're in and for History
                if (x != null && x.made && x.device.isEmpty()) { x.name = in.name; x.from = from; x.device = device; late = x; }
                else if (x != null || over.containsKey(tid)) return;
                else { ins.put(tid, in); ins.notifyAll(); }
            }
            if (late != null) { moving(tid, late, file); return; }
            if (asks(device)) {
                // "Ask each time": the question first; its card once it's accepted (the files keep coming meanwhile)
                Q q = new Q();
                q.tid = tid; q.device = device; q.from = from; q.name = in.name; q.size = file.optLong("size", 0);
                q.count = Math.max(1, file.optInt("count", 1)); q.kind = file.optString("kind", "doc"); q.folder = file.optBoolean("folder", false);
                q.file = file; q.in = in;
                question(q);
                return;
            }
            announce(in, file);
            moving(tid, in, file);
            noShow(tid);
        }

        @Override
        public void progress(String tid, long got, long total) {
            Page.event("down", "fid", fid(tid), "got", got, "total", total);
            Moving.update("ph-in:" + tid, got, total);
            PeerServer s = server;
            String now = s == null ? null : s.receiving(tid);
            if (now != null) Moving.current("ph-in:" + tid, now);
        }

        @Override
        public JSONArray place(String tid, String device, File stage, List<String> tops) throws IOException {
            // "Ask each time": nothing is put in place before the user accepts (its announcement never came: asked now)
            Q q;
            synchronized (qs) { q = qs.get(tid); }
            if (q == null && asks(device)) {
                q = new Q();
                q.tid = tid; q.device = device; q.from = nameOf(device); q.name = tops.size() == 1 ? PeerServer.cleanText(tops.get(0), 1000) : tops.size() + " items";
                q.count = Math.max(1, tops.size()); q.kind = "doc";
                question(q);
            }
            if (q != null) {
                // (not the wall clock: one set back while the question is up would hold the sender that much longer)
                long until = PeerServer.mono() + ACCEPT_MS + 2000;
                synchronized (qs) {
                    while (q.yes == null) {
                        long left = until - PeerServer.mono();
                        if (left <= 0) break;
                        try { qs.wait(Math.min(left, 1000)); } catch (InterruptedException e) { break; }
                    }
                }
                if (q.yes == null) decide(tid, false, "timeout");
                synchronized (qs) { qs.remove(tid); }
                if (!Boolean.TRUE.equals(q.yes)) throw new PeerServer.Declined(q.why == null ? "declined" : q.why);
            }
            JSONArray items = new JSONArray();
            String where = null;
            File inbox = Files.granted(ctx) ? Files.inbox() : null;
            if (inbox != null && stage.getParentFile() != null && stage.getParentFile().equals(inbox)) {
                // Download/Flick, like files from the PC; a folder stays a folder
                List<String> scan = new ArrayList<String>();
                for (String t : tops) {
                    File src = new File(stage, t);
                    if (!src.exists()) continue;
                    File to = Files.moveIn(src, inbox, t);
                    if (to.isDirectory()) { items.put(Files.dirJson(to)); filesIn(to, scan, 20000); }
                    else { items.put(Files.fileJson(to, null)); scan.add(to.getPath()); }
                }
                where = "Download/Flick";
                if (!scan.isEmpty()) {
                    try { MediaScannerConnection.scanFile(ctx, scan.toArray(new String[0]), null, null); } catch (Throwable e) { /* the gallery finds them later */ }
                }
            } else {
                // Flick can't see shared storage: onto the Flick list, with a copy in the phone's public folders (Android
                // 10 and newer); a folder's files go to Download/Flick/<folder> as they were (on Android 9, onto the list)
                Library lib = Library.get(ctx);
                for (String t : tops) {
                    File src = new File(stage, t);
                    if (src.isDirectory()) {
                        if (Build.VERSION.SDK_INT >= 29) { saveFolder(src, t); where = "Download/Flick/" + t; }
                        else {
                            List<String> fs = new ArrayList<String>();
                            filesIn(src, fs, 200000);              // (all of them: as many as a send can hold)
                            for (String p : fs) { File f = new File(p); items.put(lib.importFile(f, f.getName(), Files.mimeOf(f.getName()))); }
                        }
                    } else if (src.isFile()) {
                        JSONObject it = lib.importFile(src, t, Files.mimeOf(t));
                        items.put(it);
                        if (Build.VERSION.SDK_INT >= 29) {
                            try {
                                File f = lib.file(it.optString("id"));
                                if (f != null) where = Transfers.PublicSave.save(ctx, f, it.optString("name"), it.optString("mime"));
                            } catch (Throwable e) { /* it's in the Flick list still */ }
                        }
                    }
                }
            }
            PeerServer.deleteTree(stage);                   // (empty by now, or what couldn't be used)
            finish(tid, true, items, where, null);
            return items;
        }

        @Override public void failed(String tid, String why) { dropQuestion(tid); finish(tid, false, null, null, why); }
        // its sender canceled it while the user here is still asked: the question goes (its Accept would keep what the
        // sender says it stopped)
        @Override public boolean withdraw(String tid) { return settle(tid, false, "canceled"); }
        @Override public Boolean sendsTo(String device) { synchronized (clientSide) { return links.has(device); } }
        @Override public void doubt(String device) { try { client().verifyLater(device); } catch (Throwable e) { Bg.warn("peers", e); } }
        @Override public void working(boolean on) { Transfers.hold(ctx, on); }
        @Override public void log(String s) { Bg.log(s); }

        @Override
        public String clip(String device, String from, JSONObject m) {
            // what it sent, as a clipboard from the PC is taken (Clip.write: marked as from Flick, so it isn't sent back)
            try {
                String k = PeerServer.str(m, "kind");
                JSONObject c = new JSONObject().put("kind", k);
                if ("text".equals(k)) {
                    String text = PeerServer.str(m, "text");
                    if (text.isEmpty()) return "empty";
                    if (text.length() > Clip.MAX_TEXT) return "too big";
                    c.put("text", text);
                } else if ("image".equals(k)) {
                    String png = PeerServer.str(m, "png");
                    if (png.isEmpty()) return "empty";
                    if (png.length() > (Clip.MAX_PNG / 3 + 1) * 4 + 16) return "too big";
                    c.put("png", png);
                } else return "bad";
                // marked private where it was copied (a password): on the clipboard here as private too, and kept nowhere
                boolean priv = Boolean.TRUE.equals(m.opt("private"));
                if (priv) c.put("private", true);
                String kind = Clip.write(ctx, c, from);
                if (kind == null) return "bad";
                if (!priv) ClipHistory.add(ctx, "in", c, device, from);
                Page.event("peer-clip", "kind", kind, "from", from, "fromId", device);
                // (Android 13 and newer shows its own note; the page shows one when it's in front)
                if (Build.VERSION.SDK_INT < 33 && !Page.inFront()) Bg.toast(ctx, "Copied from " + from);
                return null;
            } catch (Throwable e) { Bg.warn("peers: clipboard", e); return "bad"; }
        }

        @Override
        public String link(String device, String from, String url) {
            if (!Links.ok(url)) return "bad";
            // never opened by itself (it's from another person's phone, maybe): the page asks while Flick is in front,
            // else a notification opens it when tapped
            if (Page.inFront()) Page.event("peer-link", "url", url, "from", from, "fromId", device);
            else FromPc.notifyLink(ctx, url, from);
            return null;
        }

        @Override
        public String ring(String device, String from, int sec) {
            return Ringer.start(ctx, sec, device, from) ? null : "quiet";
        }

        @Override public void ringStop(String device) { Ringer.stopFor(ctx, device); }
        @Override public void ringFound(String device) { clientSide.ringFound(device); }

        @Override
        public void direct(final String device, final String group, final PeerServer.Reply r) {
            // (a few seconds to make the network: on a thread of its own)
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    WifiDirect.Net n;
                    try { n = WifiDirect.offer(ctx, group); } catch (Throwable e) { n = new WifiDirect.Net(); n.why = "failed"; }
                    JSONObject more = new JSONObject();
                    try {
                        if (n.ok()) {
                            more.put("ip", n.ip);
                            if (n.ssid != null) { more.put("ssid", n.ssid); more.put("pass", n.pass); }
                        }
                    } catch (Exception e) { /* empty */ }
                    Bg.log("peers: Wi-Fi Direct for " + device + ": " + (n.ok() ? (n.ssid != null ? "made " + n.ssid : "in it already") : n.why));
                    r.reply(n.why, more);
                }
            }, "flick-direct-offer");
            t.setDaemon(true);
            t.start();
        }
    }

    // announced, but the files never start coming (the other phone lost its connection): not waited for forever
    private void noShow(final String tid) {
        Bg.mainDelayed(new Runnable() {
            @Override public void run() {
                boolean stale;
                synchronized (ins) { In x = ins.get(tid); stale = x != null && !x.begun; }
                if (!stale) return;
                synchronized (qs) { qs.remove(tid); }      // (its question, accepted, goes with it)
                finish(tid, false, null, null, "not sent");
            }
        }, NO_SHOW_MS);
    }

    /**
     * Files coming in are listed as moving (their notification, Settings › Transfers), from whom; Cancel stops them
     * (PeerServer.drop: the sender hears they were canceled here).
     */
    private void moving(final String tid, In in, JSONObject file) {
        String key = "ph-in:" + tid, kind;
        synchronized (serverSide) { JSONObject a = allowed.optJSONObject(in.device); kind = a == null ? "phone" : a.optString("kind", "phone"); }
        int count = Math.max(1, file.optInt("count", 1));
        long size = file.optLong("size", -1);
        // (only while it's still coming: one that ended meanwhile, on another thread, would stay listed for good. One
        // that arrived before it was listed, all at once (a small file, its announcement handled a moment after), is
        // listed as arrived all the same, as every other one is)
        synchronized (ins) {
            if (ins.get(tid) != in) {
                if (in.listed || !Boolean.TRUE.equals(over.get(tid))) return;
                in.listed = true;
            } else {
                in.listed = true;
                Moving.start(ctx, key, "in", in.device, in.from, kind, in.name, count, size > 0 ? size : -1);
                Moving.onCancel(key, new Runnable() {
                    @Override public void run() { PeerServer s = server; if (s != null) s.drop(tid); }
                });
                return;
            }
        }
        Moving.start(ctx, key, "in", in.device, in.from, kind, in.name, count, size > 0 ? size : -1);
        Moving.end(key, true, null);
    }

    /** The page shows a card for what's coming (app.js: incoming), filled in by 'down' and 'down-done'. */
    private static void announce(In in, JSONObject file) {
        try {
            JSONObject e = new JSONObject();
            e.put("t", "peer-in");
            e.put("fid", in.fid);
            e.put("name", in.name);
            e.put("size", file.optLong("size", 0));
            e.put("kind", file.optString("kind", "doc"));
            e.put("count", file.optInt("count", 1));
            e.put("folder", file.optBoolean("folder", false));
            String th = file.optString("thumb", "");
            if (th.length() > 0) { e.put("thumb", th); if (file.optDouble("aspect", 0) > 0) e.put("aspect", file.optDouble("aspect", 0)); }
            // flicked there: it arrives the way it left (PeerServer checked these)
            if (file.has("look")) e.put("look", file.optString("look"));
            if (file.has("y")) e.put("y", file.optDouble("y", 0));
            if (file.has("vx")) e.put("vx", file.optDouble("vx", 0));
            e.put("from", in.from);
            e.put("fromId", in.device);
            Page.emit(e);
        } catch (Throwable e) { /* ignore */ }
    }

    /** What arrived (items: what the list shows; where: the folder they went to), or why not. Said once. */
    private void finish(String tid, boolean ok, JSONArray items, String where, String why) {
        In in;
        synchronized (ins) { in = ins.remove(tid); over.put(tid, ok); ins.notifyAll(); }    // (stage() may wait on it)
        if (in == null) return;
        // (in words: why it isn't here; stopped here, canceled)
        String from = in.from == null || in.from.isEmpty() ? "The other device" : in.from;
        Moving.end("ph-in:" + tid, ok, ok ? null : "stopped".equals(why) ? "canceled" : "canceled".equals(why) ? from + " stopped sending it"
            : "quit".equals(why) ? "Flick was closed on " + from + " while it was sending"
            : "no space".equals(why) ? "Not enough space on this phone" : "not sent".equals(why) ? "It never started" : "It didn’t all arrive");
        if (ok) {
            // into History: what arrived (a folder saved straight to Download/Flick/<folder> has no item in Flick's
            // list: it's there by its name)
            List<JSONObject> h = new ArrayList<JSONObject>();
            for (int i = 0; items != null && i < items.length() && h.size() < 300; i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                boolean dir = it.optBoolean("dir", false);
                String path = it.optString("path", "");
                h.add(histEntry("in", it.optString("name", "File"), it.optLong("size", 0), path, path.isEmpty() ? it.optString("id", "") : null,
                    dir ? "folder" : it.optString("kind", "")));
            }
            if (h.isEmpty() && where != null) h.add(histEntry("in", in.name, 0, null, null, where.endsWith("/" + in.name) ? "folder" : ""));
            history(h, in.device, in.from, true, null);
        }
        try {
            JSONObject e = new JSONObject();
            e.put("t", "down-done");
            e.put("fid", in.fid);
            e.put("ok", ok);
            e.put("peer", true);
            e.put("name", in.name);
            e.put("from", in.from);
            e.put("fromId", in.device);
            if (items != null) e.put("items", items);
            if (where != null) e.put("where", where);
            // (Flick closed there in the middle of it: the page says it stopped sending it, as for a Cancel there; closed
            // says more)
            if (why != null) e.put("why", "quit".equals(why) ? "canceled" : why);
            if ("quit".equals(why)) e.put("closed", true);
            Page.emit(e);
        } catch (Throwable e) { /* ignore */ }
    }

    /** The files in a folder and its subfolders (paths), at most max; hidden ones left out, as the file browser does. */
    private static void filesIn(File d, List<String> out, int max) {
        File[] kids = d.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (out.size() >= max) return;
            if (k.getName().startsWith(".")) continue;
            if (k.isDirectory()) filesIn(k, out, max); else out.add(k.getPath());
        }
    }

    /** A folder copied into Download/Flick/<name>/… through MediaStore (empty folders can't be made that way). */
    private void saveFolder(File src, String name) throws IOException {
        File[] kids = src.listFiles();
        if (kids == null) return;
        Arrays.sort(kids, new Comparator<File>() { @Override public int compare(File a, File b) { return a.getName().compareToIgnoreCase(b.getName()); } });
        for (File k : kids) {
            if (k.getName().startsWith(".")) continue;
            if (k.isDirectory()) saveFolder(k, name + "/" + k.getName());
            else Transfers.PublicSave.saveIn(ctx, k, k.getName(), Files.mimeOf(k.getName()), name);
        }
    }

    // ------------------------------------------------------------ sending to other phones (PeerClient)
    private final class ClientSide implements PeerClient.Host {
        @Override public String id() { return Peers.this.id(); }
        @Override public String name() { return Peers.this.name(); }
        @Override public JSONObject links() { return links; }
        @Override public void saved() { linksFile.save(); keysGen.incrementAndGet(); }
        @Override public String bleKey() { return b64(Peers.this.bleKey()); }

        @Override
        public JSONObject grant(String id, String name, String kind) throws Exception {
            PeerServer s = server;
            if (s == null || !s.running()) return null;     // this phone doesn't take files: paired one way only
            byte[] b = new byte[16];
            new SecureRandom().nextBytes(b);
            String token = PeerCert.hex(b);
            long now = System.currentTimeMillis();
            synchronized (serverSide) {
                // (one it was given a token for here a moment ago, from pairing the other way at the same time, keeps it:
                // one token a way. A pairing from before doesn't pass its token on.)
                JSONObject was = allowed.optJSONObject(id);
                String t = was == null ? "" : was.optString("token");
                long at = was == null ? 0 : Math.max(was.optLong("added", 0), was.optLong("back", 0));
                if (t.matches("[0-9a-f]{32}") && now >= at && now - at < 10 * 60000) token = t;
                // back: given now, as this phone's user confirmed the code with it (its own request allowed here in a
                // moment keeps this token: PeerServer.approve). One that was waiting for that confirmation has it now.
                JSONObject rec = new JSONObject();
                rec.put("name", name); rec.put("kind", kind); rec.put("token", token); rec.put("added", token.equals(t) && was.optLong("added", 0) > 0 ? was.optLong("added") : now);
                rec.put("back", now);
                // (paired again: its files are still asked about each time, if they were)
                if (was != null && was.optBoolean("ask", false)) rec.put("ask", true);
                allowed.put(id, rec);
                serverSide.saved();
            }
            return new JSONObject().put("token", token).put("fp", s.fingerprint()).put("port", s.port);
        }

        /** The phones that may send here (PeerServer's list): the ones this phone can't send to are paired one way. */
        @Override
        public JSONObject allowedHere() {
            synchronized (serverSide) {
                try { return new JSONObject(allowed.toString()); } catch (Exception e) { return new JSONObject(); }
            }
        }

        @Override
        public void revoke(String id, boolean tell) {
            // (while a pairing file couldn't be read: a device only the file has isn't brought back when it reads)
            synchronized (serverSide) { allowedFile.gone(id); }
            synchronized (clientSide) { linksFile.gone(id); }
            PeerServer s = server;
            if (s != null) { s.forget(id, tell); return; }
            synchronized (serverSide) { if (allowed.has(id)) { allowed.remove(id); serverSide.saved(); } }
        }

        @Override public void changed() { Peers.this.changed(); moved(); }
        // (the page follows it in the state; the notification and Settings › Transfers in Moving)
        @Override public void started(final String id, final String tid, JSONObject info) {
            String key = "ph-out:" + id + ":" + tid, nm = "", kind = "phone";
            synchronized (clientSide) { JSONObject l = links.optJSONObject(id); if (l != null) { nm = l.optString("name", ""); kind = l.optString("kind", "phone"); } }
            PeerClient.Busy b = client().sending(id);
            Moving.start(ctx, key, "out", id, nm, kind, info.optString("name", "Files"), b == null ? 1 : b.files, info.optLong("size", -1));
            Moving.onCancel(key, new Runnable() { @Override public void run() { client().cancel(id, tid); } });
            synchronized (outKeys) { outKeys.put(tid, new String[]{id, key}); }
        }
        // (note: what didn't go with it, said, or null)
        @Override public void sent(String id, String tid, String to, String name, int files, long bytes, String note) {
            String[] key;
            synchronized (outKeys) { key = tid == null ? null : outKeys.remove(tid); }
            if (key != null) Moving.end(key[1], true, null);
            history(takeHist(id), id, to, true, null);
            Page.event("peer-sent", "id", id, "to", to, "name", name, "files", files, "bytes", bytes, "note", note);
        }
        // (why null: stopped here, nothing to say; the page still hears that it's over. canceled with a why: canceled on
        // the other device, said so, as a cancel: not in History as a send that failed. word: why, as History keeps it:
        // a send the other phone's user declined reads so there too, as in Transfers)
        @Override public void failed(String id, String tid, String to, String why, boolean canceled, String word) {
            String[] key;
            synchronized (outKeys) { key = tid == null ? null : outKeys.remove(tid); }
            if (key != null) Moving.end(key[1], false, canceled || why == null ? "canceled" : why, canceled ? why : null);
            List<JSONObject> h = takeHist(id);
            if (why != null && !canceled) history(h, id, to, false, word == null || word.isEmpty() ? "send" : word);
            Page.event("peer-failed", "id", id, "to", to, "why", why == null ? "" : why, "canceled", why == null, "there", canceled && why != null);
        }
        @Override public void working(boolean on) { Transfers.hold(ctx, on); }
        @Override public void log(String s) { Bg.log(s); }
        @Override public void landed(String id, String tid) { Page.event("peer-landed", "id", id, "tid", tid); }
        @Override public void ringFound(String id) { Page.event("peer-ring-found", "id", id, "name", nameOf(id)); }
        @Override public void looking(boolean on) { looking = on; try { BleLink.look(ctx, on); } catch (Throwable e) { /* no Bluetooth */ } }
        @Override public boolean lookFor(String id, long ms) { try { return BleLink.lookFor(ctx, id, ms); } catch (Throwable e) { return false; } }
        @Override public boolean farIfShown() { try { return BleLink.scansIfShown(ctx); } catch (Throwable e) { return false; } }
        @Override public boolean directReady() { try { return WifiDirect.usable(ctx); } catch (Throwable e) { return false; } }
        @Override public String directGroup() { try { return WifiDirect.current(ctx); } catch (Throwable e) { return ""; } }
        @Override public boolean directJoin(String ssid, String pass, String ip, long ms, java.util.concurrent.atomic.AtomicBoolean abort) {
            try { return WifiDirect.join(ctx, ssid, pass, ip, ms, abort); } catch (Throwable e) { Bg.warn("direct", e); return false; }
        }
        @Override public void directUse(boolean on) { WifiDirect.use(on); }
        @Override public void tunnelVerified(String id, int port) { Peers.this.tunnelVerified(id, port); }
        @Override public void expect(int port, int from) {
            synchronized (tuns) {
                for (Tunnel t : tuns.values()) if (t.port() == port) { t.expect(from); return; }
                for (Tunnel t : newer.values()) if (t.port() == port) { t.expect(from); return; }
            }
        }
        @Override public void cut(int port, int from) {
            Tunnel t = null;
            synchronized (tuns) {
                for (Tunnel x : tuns.values()) if (x.port() == port) t = x;
                if (t == null) for (Tunnel x : newer.values()) if (x.port() == port) t = x;
            }
            if (t != null) t.cut(from);
        }
        @Override public long carried(int port, int from) {
            Tunnel t = null;
            synchronized (tuns) {
                for (Tunnel x : tuns.values()) if (x.port() == port) t = x;
                if (t == null) for (Tunnel x : newer.values()) if (x.port() == port) t = x;
            }
            return t == null ? -1 : t.carried(from);
        }
        @Override public void tunnelFailed(String id, int port) {
            Tunnel t;
            synchronized (tuns) { t = newer.get(id); if (t == null || t.port() != port || t.verified) return; }
            Bg.log("peers: the " + t.via + " link said to be " + nameOf(id) + "'s didn't work: the one before is kept");
            t.close("didn't work");
        }
        @Override public void tunnelBad(String id, int port) {
            Tunnel t;
            synchronized (tuns) {
                t = tuns.get(id);
                if (t == null || t.port() != port) t = newer.get(id);
                if (t == null || t.port() != port || t.verified) return;
            }
            Bg.log("peers: a link said it was " + nameOf(id) + "'s and isn't: ended");
            t.close("not that phone");
        }

        @Override
        public JSONObject thumbFor(File f) {
            try {
                // the Flick list's own picture of it, or the one the file browser shows
                File p = f.getParentFile(), lib = new File(ctx.getFilesDir(), "lib");
                String b64 = p != null && lib.equals(p.getParentFile()) ? Library.get(ctx).thumbBase64(p.getName()) : Thumbs.base64(ctx, f.getPath(), 0, 0, 0);
                if (b64 == null || b64.length() == 0) return null;
                JSONObject r = new JSONObject().put("thumb", "data:image/jpeg;base64," + b64);
                byte[] raw = Base64.decode(b64, Base64.NO_WRAP);
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                if (o.outWidth > 0 && o.outHeight > 0) r.put("aspect", (double) o.outWidth / o.outHeight);
                return r;
            } catch (Throwable e) { return null; }
        }
    }

    // How far each send to another device got, for Moving (it asks this phone's client: PeerClient counts the bytes).
    // Called on every change the page hears of: nothing to do while nothing is going out.
    private void moved() {
        List<String[]> l;
        synchronized (outKeys) {
            if (outKeys.isEmpty()) return;
            l = new ArrayList<String[]>();
            for (Map.Entry<String, String[]> e : outKeys.entrySet()) l.add(new String[]{e.getValue()[0], e.getValue()[1], e.getKey()});
        }
        PeerClient c;
        synchronized (this) { c = client; }
        if (c == null) return;
        for (String[] e : l) {
            PeerClient.Busy b = c.sending(e[0]);
            if (b == null || !e[2].equals(b.tid)) continue;
            // (the other side's user is asked whether to take them: waiting for it)
            // (or it waits to go again: the other phone took too many from this one lately)
            Moving.state(e[1], (b.asking && !b.delivered) || b.held ? "waiting" : "running");
            Moving.update(e[1], b.shown(), b.total);
            Bundle bb = b.bundle;
            String now = bb == null ? null : bb.now;
            if (now != null) Moving.current(e[1], now.substring(now.lastIndexOf('/') + 1));
        }
    }

    // ------------------------------------------------------------ small things
    /**
     * One of the two pairing files and what it holds (map: the object PeerServer and PeerClient work on, under their
     * host's lock, as every call here is). A file that is there but couldn't be read (the phone out of memory or of
     * file handles as Flick starts) isn't "no pairings": map then holds only what is paired from then on, nothing is
     * written over the file, and it's read again at the next change (and when Flick's screen opens); what it holds
     * joins map then, except the devices paired or removed meanwhile (those are as they are in map).
     */
    private static final class Kept {
        final File file;
        final JSONObject map = new JSONObject();
        private boolean unread;
        private boolean said;                             // that it can't be read is in the log (once, not at every change)
        // in map at some point while unread, or removed then (also one only the file has: see gone)
        private final java.util.HashSet<String> touched = new java.util.HashSet<String>();

        Kept(File file) { this.file = file; read(); }

        private void read() {
            if (!file.isFile()) { unread = false; touched.clear(); return; }
            String text;
            try { text = HistoryStore.read(file); }
            catch (Throwable e) {
                unread = true;
                if (!said) { said = true; Bg.warn("peers: " + file.getName() + " (kept as it is until it reads)", e); }
                return;
            }
            unread = false;
            said = false;
            try {
                JSONObject o = new JSONObject(text);
                for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                    String k = it.next();
                    if (!map.has(k) && !touched.contains(k)) map.put(k, o.get(k));
                }
            } catch (Throwable e) { Bg.warn("peers: " + file.getName(), e); /* damaged: no pairings in it */ }
            touched.clear();
        }

        /**
         * Reads the file again if it couldn't be read: true when it now could (what was paired or removed meanwhile is
         * written then).
         */
        boolean again() {
            if (!unread) return false;
            boolean changed = !touched.isEmpty() || map.length() > 0;
            for (java.util.Iterator<String> it = map.keys(); it.hasNext(); ) touched.add(it.next());
            read();
            if (unread) return false;
            if (changed) write();
            return true;
        }

        /** id is removed: one that only the unread file has stays removed when the file reads. */
        void gone(String id) { if (unread && id != null) touched.add(id); }

        void save() {
            // (written if it reads now; else kept in memory: what the file holds isn't known)
            if (unread) { again(); return; }
            write();
        }

        private void write() {
            try { HistoryStore.write(file, map.toString()); } catch (Throwable e) { Bg.warn("peers: save " + file.getName(), e); }
        }
    }
}
