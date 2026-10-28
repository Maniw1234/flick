package com.flick.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The phone's sends (Outbox) as the app sees them: one per process, going on whether or not Flick's page is open.
 * While something moves (or waits for the PC, for a while) a foreground service keeps the app alive with a notification
 * saying how far it got; a scheduled job (ResumeJob) brings the app back to carry on if Android stopped it anyway. The
 * PC is found again when its address changed (discovery), and sends waiting for it try again as soon as the network
 * changes. The page hears about every send ("job" events, plus "up"/"up-done" as before).
 */
final class Sends {
    private static Sends one;

    static synchronized Sends get(Context c) {
        if (one == null) {
            one = new Sends(c.getApplicationContext());
            one.box.start();
        }
        return one;
    }

    static synchronized Sends peek() { return one; }

    // keep the app alive this long for sends that only wait for the PC; after that the scheduled job carries on
    static final long HOLD_WAITING_MS = 30 * 60000L;

    private final Context app;
    private final SharedPreferences prefs;
    final Outbox box;
    private final Map<String, Long> looked = new HashMap<String, Long>();       // pcId -> when discovery last ran
    private final Map<String, Long> noted = new HashMap<String, Long>();        // tid -> when the page last heard of it
    private final Map<String, String> shown = new HashMap<String, String>();    // tid -> the state the page last heard
    private long notifiedAt;
    private volatile boolean held;

    private Sends(Context app) {
        this.app = app;
        this.prefs = app.getSharedPreferences("flick", 0);
        Nets.install(app);
        box = new Outbox(new File(app.getFilesDir(), "outbox"), new Outbox.Env() {
            @Override public File file(Outbox.Item it) throws IOException { return Sends.this.file(it); }
            @Override public Wire.Link link(Outbox.Job j, boolean look) throws IOException { return Sends.this.link(j, look); }
            @Override public String auth(Outbox.Job j) throws IOException { return Sends.this.auth(j); }
            @Override public void changed(Outbox.Job j) { Sends.this.changed(j); }
            @Override public void moving(boolean on) { Transfers.hold(Sends.this.app, on); }
            @Override public void log(String msg) { Bg.log(msg); }
        });
        watchNetwork();
    }

    // ------------------------------------------------------------ from the page
    /** spec: {pc:{id,name,ip,port,via}, items:[{path|id, name, dir}], committed, skipDup, parallel} */
    String start(String tid, String specJson) {
        try {
            JSONObject spec = new JSONObject(specJson);
            JSONObject pc = spec.getJSONObject("pc");
            JSONArray arr = spec.getJSONArray("items");
            List<Outbox.Item> items = new ArrayList<Outbox.Item>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject it = arr.getJSONObject(i);
                String path = it.has("path") ? it.optString("path") : null;
                if (path != null && !Files.allowed(new File(path))) return "not allowed";
                items.add(new Outbox.Item(path, it.has("id") ? it.optString("id") : null, it.optString("name", "file"), it.optBoolean("dir", false)));
            }
            if (items.isEmpty()) return "nothing";
            box.add(tid, pc.optString("id"), pc.optString("name"), pc.optString("ip"), pc.optInt("port", 47860), pc.optString("via", "wifi"),
                    items, spec.optBoolean("committed", false), spec.optBoolean("skipDup", true), spec.optBoolean("parallel", true));
            return "ok";
        } catch (Throwable e) {
            Bg.warn("send start", e);
            return "error";
        }
    }

    String list() { return box.views().toString(); }

    // ------------------------------------------------------------ Env
    private File file(Outbox.Item it) throws IOException {
        if (it.path != null) {
            File f = new File(it.path);
            if (!Files.allowed(f)) throw new IOException("not allowed");
            return f;
        }
        File f = Library.get(app).file(it.id);
        if (f == null) throw new IOException("gone");
        return f;
    }

    private String pref(String k) { try { return prefs.getString("p:" + k, ""); } catch (Throwable e) { return ""; } }

    private Wire.Link link(Outbox.Job j, boolean look) throws IOException {
        if ("bluetooth".equals(j.via())) return new Wire.Link("127.0.0.1", j.port(), null);    // the Bluetooth link's own port
        String pin = pref("pin:" + j.pcId).trim().toLowerCase(Locale.US);
        if (pin.length() == 0) throw new Outbox.Fatal("Connect to " + j.pcName + " again to pair");
        if (look || j.host() == null) relocate(j);
        if (j.host() == null) throw new IOException("where is " + j.pcName);
        return new Wire.Link(j.host(), j.port(), pin);
    }

    /** The PC didn't answer at its address: look for it by its id (at most every 20 s). */
    private void relocate(Outbox.Job j) {
        long now = SystemClock.elapsedRealtime();
        synchronized (looked) {
            Long prev = looked.get(j.pcId);
            if (prev != null && now - prev < 20000) return;
            looked.put(j.pcId, now);
        }
        String[] hit = null;
        try { hit = Bg.discover(app, j.pcId, 3000); } catch (Throwable e) { Bg.warn("discovery", e); }
        if (hit == null) return;
        try {
            int port = Integer.parseInt(hit[1]);
            if (!hit[0].equals(j.host()) || port != j.port()) {
                Bg.log("send " + j.tid + ": " + j.pcName + " is now at " + hit[0] + ":" + port);
                box.relink(j.pcId, hit[0], port, null);
            }
        } catch (Throwable e) { /* ignore */ }
    }

    private String auth(Outbox.Job j) throws IOException {
        String device = Bg.deviceId(app), token = pref("token:" + j.pcId);
        if (device == null || device.length() == 0 || token.length() == 0) throw new Outbox.Fatal("This phone isn't paired with " + j.pcName + " any more: connect again to pair");
        return "device=" + Wire.enc(device) + "&token=" + Wire.enc(token);
    }

    // ------------------------------------------------------------ telling the page and the notification
    private void changed(Outbox.Job j) {
        String state = j.state();
        long now = SystemClock.elapsedRealtime();
        boolean news;
        synchronized (noted) {
            String was = shown.get(j.tid);
            Long at = noted.get(j.tid);
            news = !state.equals(was) || at == null || now - at >= 250;
            if (news) { shown.put(j.tid, state); noted.put(j.tid, now); }
            if (Outbox.isEnd(state)) noted.remove(j.tid);
        }
        if (news) tellPage(j, state);
        status(Outbox.isEnd(state) || !state.equals(Outbox.RUNNING));
    }

    private void tellPage(Outbox.Job j, String state) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "job");
            o.put("job", j.view());
            Page.emit(o);
            if (Outbox.RUNNING.equals(state)) {
                JSONObject u = new JSONObject();
                u.put("t", "up"); u.put("tid", j.tid); u.put("sent", Math.min(j.sent.get(), j.total())); u.put("total", j.total());
                Page.emit(u);
            } else if (Outbox.isEnd(state)) {
                JSONObject d = new JSONObject();
                boolean ok = Outbox.DONE.equals(state) || Outbox.SKIPPED.equals(state);
                d.put("t", "up-done"); d.put("tid", j.tid); d.put("ok", ok); d.put("code", ok ? 200 : 0); d.put("final", true);
                if (Outbox.SKIPPED.equals(state)) d.put("already", true);
                if (j.why() != null) d.put("why", j.why());
                if (Outbox.CANCELED.equals(state)) d.put("canceled", true);
                Page.emit(d);
            }
        } catch (Throwable e) { /* ignore */ }
    }

    /** The service, its notification and the scheduled job follow what's going on. force: say it now (not throttled). */
    private void status(boolean force) {
        long now = SystemClock.elapsedRealtime();
        synchronized (this) {
            if (!force && now - notifiedAt < 1000) return;
            notifiedAt = now;
        }
        int running = 0, waiting = 0, queued = 0;
        long sent = 0, total = 0;
        double rate = 0;
        String pc = null, name = null;
        boolean holdWaiting = false;
        long wall = System.currentTimeMillis();
        for (Outbox.Job j : box.list()) {
            String s = j.state();
            if (Outbox.RUNNING.equals(s)) { running++; sent += Math.min(j.sent.get(), j.total()); total += j.total(); rate += j.rate(); pc = j.pcName; name = j.label; }
            else if (Outbox.QUEUED.equals(s)) { queued++; if (pc == null) pc = j.pcName; }
            else if (Outbox.WAITING.equals(s)) {
                waiting++;
                if (pc == null) pc = j.pcName;
                synchronized (j) { if (j.waitingSince == 0 || wall - j.waitingSince < HOLD_WAITING_MS) holdWaiting = true; }
            }
        }
        boolean hold = running > 0 || queued > 0 || holdWaiting;
        if (hold != held) { held = hold; TransferService.want(app, "sends", hold); }
        if (running > 0) {
            int pct = total > 0 ? (int) Math.min(100, sent * 100 / total) : -1;
            String more = running + queued + waiting > 1 ? (running + queued + waiting) + " sends · " : (name != null ? name + " · " : "");
            TransferService.say(app, "Sending to " + pc, more + (pct >= 0 ? pct + "%" : "") + (rate > 1e5 ? " · " + fmtRate(rate) : ""), pct);
        } else if (queued > 0) {
            TransferService.say(app, "Sending to " + pc, "Starting…", -1);
        } else if (waiting > 0) {
            TransferService.say(app, "Waiting for " + pc, "It carries on when " + pc + " is back", -1);
        } else {
            TransferService.say(app, null, null, -1);
        }
        if (box.active()) ResumeJob.schedule(app, 60000); else ResumeJob.cancel(app);
    }

    static String fmtRate(double r) {
        if (r >= 1e7) return Math.round(r / 1e6) + " MB/s";
        if (r >= 1e6) return String.format(Locale.US, "%.1f MB/s", r / 1e6);
        return Math.max(1, Math.round(r / 1e3)) + " KB/s";
    }

    // ------------------------------------------------------------ the network
    private void watchNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { again(); }
                @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { /* the same network: nothing new */ }
                @Override public void onLost(Network n) { /* sends notice by themselves */ }
            });
        } catch (Throwable e) { Bg.warn("network watch", e); }
    }

    private void again() {
        synchronized (looked) { looked.clear(); }
        PcClient.lookAgain();
        box.poke();
    }

    // ------------------------------------------------------------ the PC's network
    /**
     * Sockets to a PC go over the network it is on (see Wire.Binder): a Wi-Fi or Ethernet network one of whose own
     * subnets holds the PC's address, when that network isn't the default one (a Wi-Fi without internet next to mobile
     * data). Anything else is left to Android, as before. What it found for an address is kept a few seconds.
     */
    static final class Nets implements Wire.Binder {
        private static volatile boolean installed;
        private final ConnectivityManager cm;
        private String lastHost;                    // guarded by this
        private Network lastNet;
        private long lastAt;

        private Nets(ConnectivityManager cm) { this.cm = cm; }

        /** Once per process; any thread. */
        static void install(Context c) {
            if (installed) return;
            try {
                ConnectivityManager cm = (ConnectivityManager) c.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) { Wire.BINDER = new Nets(cm); installed = true; }
            } catch (Throwable e) { /* left to Android */ }
        }

        @Override public void bind(Socket s, String host) throws IOException {
            if (!Wire.isIp(host)) return;
            Network n = network(host);
            if (n != null) n.bindSocket(s);
        }

        /** The network to put a socket to host on, or null for the default one. */
        @SuppressWarnings("deprecation")
        private Network network(String host) throws IOException {
            long now = SystemClock.elapsedRealtime();
            synchronized (this) { if (host.equals(lastHost) && now - lastAt < 3000) return lastNet; }
            byte[] a = InetAddress.getByName(host).getAddress();                // an address: nothing is looked up
            Network def = cm.getActiveNetwork(), found = null;
            search:
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                if (nc == null || !(nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
                LinkProperties lp = cm.getLinkProperties(n);
                if (lp == null) continue;
                for (LinkAddress la : lp.getLinkAddresses()) {
                    if (la.getPrefixLength() < 8 || !Wire.inSubnet(la.getAddress().getAddress(), la.getPrefixLength(), a)) continue;
                    if (!n.equals(def)) found = n;
                    break search;
                }
            }
            synchronized (this) { lastHost = host; lastNet = found; lastAt = now; }
            return found;
        }
    }

    /** The page reached a PC (at this address, over this link): sends waiting for it go there now. */
    void relink(String pcId, String host, int port, String via) {
        if (pcId == null || host == null || port <= 0) return;
        box.relink(pcId, host, port, via);
    }
}
