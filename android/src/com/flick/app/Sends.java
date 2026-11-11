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
 * While something moves (or waits for the PC, for a while) a foreground service keeps the app alive, and each send has
 * its notification saying how far it got (Moving); a scheduled job (ResumeJob) brings the app back to carry on if
 * Android stopped it anyway. The PC is found again when its address changed (discovery), and sends waiting for it try
 * again as soon as the network changes. The page hears about every send ("job" events, plus "up"/"up-done" as before).
 */
final class Sends {
    private static Sends one;

    static synchronized Sends get(Context c) {
        if (one == null) {
            one = new Sends(c.getApplicationContext());
            one.box.start();
            // (paused ones and ones waiting for their time, from before Flick last stopped, are listed as moving too;
            // one that ended while Flick was stopped before its History entries were settled has them settled now)
            for (Outbox.Job j : one.box.list()) { one.move(j, j.state()); one.history.changed(j); }
        }
        return one;
    }

    static synchronized Sends peek() { return one; }

    // keep the app alive this long for sends that only wait for the PC; after that the scheduled job carries on
    static final long HOLD_WAITING_MS = 30 * 60000L;

    private final Context app;
    private final SharedPreferences prefs;
    final Outbox box;
    // each send's History entries, once (see SendHistory): the page that started it notes it itself while it's there
    private final SendHistory.Settler history;
    private final Map<String, Long> looked = new HashMap<String, Long>();       // pcId -> when discovery last ran
    private final Map<String, Long> noted = new HashMap<String, Long>();        // tid -> when the page last heard of it
    private final Map<String, String> shown = new HashMap<String, String>();    // tid -> the state the page last heard
    private final java.util.Set<String> listed = new java.util.HashSet<String>(); // tids Moving lists now (under noted)
    private long notifiedAt;
    private volatile boolean held;
    private final Object statusLock = new Object();

    private Sends(Context app) {
        this.app = app;
        this.prefs = app.getSharedPreferences("flick", 0);
        Nets.install(app);
        // waits (a send's next try, kept connections) count the time the phone sleeps, and not a change of its clock
        Wire.clock(new Wire.Clock() { @Override public long ms() { return SystemClock.elapsedRealtime(); } });
        box = new Outbox(new File(app.getFilesDir(), "outbox"), new Outbox.Env() {
            @Override public File file(Outbox.Item it) throws IOException { return Sends.this.file(it); }
            @Override public Wire.Link link(Outbox.Job j, boolean look) throws IOException { return Sends.this.link(j, look); }
            @Override public String auth(Outbox.Job j) throws IOException { return Sends.this.auth(j); }
            @Override public void changed(Outbox.Job j) { Sends.this.changed(j); }
            @Override public void moving(boolean on) { Transfers.hold(Sends.this.app, on); }
            @Override public void log(String msg) { Bg.log(msg); }
        });
        // (items of Flick's own list a send not over yet still reads stay on the list until it's over)
        Library.held = new Library.Held() { @Override public java.util.Set<String> ids() { return box.heldIds(); } };
        history = new SendHistory.Settler(Bg.history(app), box, new SendHistory.Look() {
            @Override public File file(Outbox.Item it) { try { return Sends.this.file(it); } catch (Throwable e) { return null; } }
            @Override public String kind(String name) { return Files.kindOf(name, Files.mimeOf(name)); }
        }, new SendHistory.Settler.Pages() {
            @Override public Object now() { return Page.get(); }
            @Override public void changed() { Page.historyChanged(); }
            @Override public void warn(Throwable e) { Bg.warn("send history", e); }
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
            history.started(tid);
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
        if ("bluetooth".equals(j.via())) {
            // the Bluetooth link to that PC open now, that the page signed in over; never the port the send kept: once its
            // link closed, that port can be any app's (also after Flick restarted). None: it waits for one, as for a PC
            // out of reach
            Wire.Link l = BtMux.link(j.pcId);
            if (l == null) throw new IOException("no Bluetooth link to " + j.pcName);
            return l;
        }
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
            // (a send no longer in the list, forgotten or made room for: nothing more is said of it)
            if (Outbox.isEnd(state) && shown.size() > 200) {
                java.util.Set<String> here = new java.util.HashSet<String>();
                for (Outbox.Job x : box.list()) here.add(x.tid);
                shown.keySet().retainAll(here);
            }
        }
        move(j, state);
        if (news) tellPage(j, state);
        if (Outbox.isEnd(state)) history.changed(j);
        status(Outbox.isEnd(state) || !state.equals(Outbox.RUNNING));
    }

    /**
     * Each send is one transfer in Moving (its notification, Settings › Transfers): from when it's added (or tried again)
     * until it ends. Waiting for the PC and paused are said there; Cancel cancels it as the page's does.
     */
    private void move(final Outbox.Job j, String state) {
        final String key = "pc-out:" + j.tid;
        boolean end = Outbox.isEnd(state), fresh;
        synchronized (noted) {
            if (end) { if (!listed.remove(j.tid)) return; fresh = false; }
            else fresh = listed.add(j.tid);
        }
        if (end) {
            boolean ok = Outbox.DONE.equals(state) || Outbox.SKIPPED.equals(state);
            String why = j.why();
            // (canceled here, or on the PC: a cancel either way; one on the PC has words, "Canceled on <PC>", for its note)
            boolean canceled = Outbox.CANCELED.equals(state);
            Moving.end(key, ok, ok ? null : canceled ? "canceled" : why, ok || !canceled ? null : why);
            return;
        }
        long total = j.total();
        if (fresh) {
            List<String> names = new ArrayList<String>();
            int files = 0;
            for (Outbox.Item it : j.items) { names.add(it.name); if (!it.dir) files++; }
            Moving.start(app, key, "out", j.pcId, j.pcName, "pc", Moving.what(names, j.items.size(), files), Math.max(1, files), total > 0 ? total : -1);
            Moving.onCancel(key, new Runnable() { @Override public void run() { box.cancel(j.tid); } });
        }
        // (queued: about to go, or behind the ones going: "running" with nothing moved yet)
        Moving.state(key, Outbox.WAITING.equals(state) ? "waiting" : Outbox.PAUSED.equals(state) ? "paused" : "running");
        Moving.update(key, Math.min(j.sent.get(), Math.max(0, total)), total > 0 ? total : -1);
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

    /** The service and the scheduled job follow what's going on (each send's notification is Moving's). force: now. */
    private void status(boolean force) {
        long now = SystemClock.elapsedRealtime();
        synchronized (this) {
            if (!force && now - notifiedAt < 1000) return;
            notifiedAt = now;
        }
        // one thread at a time, looking and telling: a look from before a send ended, told after the look that saw it
        // end (the page pausing it just then), kept the service up with nothing left to send
        synchronized (statusLock) {
            boolean hold = false;
            for (Outbox.Job j : box.list()) {
                String s = j.state();
                if (Outbox.RUNNING.equals(s) || Outbox.QUEUED.equals(s)) hold = true;
                else if (Outbox.WAITING.equals(s) && j.waited() < HOLD_WAITING_MS) hold = true;   // (not the wall clock: see Outbox.mono)
            }
            if (hold != held) { held = hold; TransferService.want(app, "sends", hold); }
            if (box.active()) ResumeJob.schedule(app, 60000); else ResumeJob.cancel(app);
        }
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
    static final class Nets implements Wire.Binder, Wire.UdpBinder {
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
                if (cm != null) { Nets n = new Nets(cm); Wire.BINDER = n; Wire.UDP_BINDER = n; installed = true; }
            } catch (Throwable e) { /* left to Android */ }
        }

        @Override public void bind(Socket s, String host) throws IOException {
            if (!Wire.isIp(host)) return;
            Network n = network(host);
            if (n != null) n.bindSocket(s);
        }

        // (another phone on a Wi-Fi without internet, mobile data on: its discovery goes over that Wi-Fi)
        @Override public boolean bind(java.net.DatagramSocket s, String host) throws IOException {
            if (!Wire.isIp(host)) return false;
            Network n = network(host);
            if (n == null) return false;
            n.bindSocket(s);
            return true;
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

    /** The page reached a PC (at this address, over this link) and it proved itself there: sends waiting for it go there now. */
    void relink(String pcId, String host, int port, String via) {
        if (pcId == null || host == null || port <= 0) return;
        if ("bluetooth".equals(via)) BtMux.proven(port, pcId);         // (sends over Bluetooth go over this link: see link)
        box.relink(pcId, host, port, via);
    }
}
