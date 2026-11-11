package com.flick.app;

import android.Manifest;
import android.annotation.TargetApi;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.SystemClock;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Bluetooth between two phones (Android 10 and newer): they find each other over Bluetooth Low Energy wherever they
 * are, no shared Wi-Fi needed, and talk over a Bluetooth channel (L2CAP): a Tunnel, so they pair and send to each other
 * as over Wi-Fi (more slowly). A phone taking files says it's there in a few bytes (a hash, the channel to reach it on,
 * whether its user is looking for devices or has the Connect screen open); a phone looking for others (its Connect
 * screen, Other phones, a send to a paired phone that isn't on the network) listens, and links to the ones it hears. Of
 * two phones looking at once, the one with the lower hash makes the link (so there's one, not two).
 * The hash is made with the phone's own Bluetooth key (Peers.bleKey: only its paired phones get it) and the quarter
 * hour, and the channel changes with it: nobody else can tell one quarter hour's adverts from another's, or work them
 * out (not even from its Flick id), also while it sleeps (an alarm wakes it for that). A phone looking for a paired one
 * works out what that one says now, or said any time in the last day (one asleep from before this can still be saying
 * an old one). Bluetooth turned on or off is followed as it happens.
 */
@TargetApi(29)
final class BleLink {
    static final int COMPANY = 0xFFFF;                  // (Bluetooth's id for private use: no company)
    private static final byte V = 2;                    // (2: the hash is keyed; nothing released says 1)
    private static final int F_LOOKING = 1, F_READY = 2;
    private static final long RETRY_MS = 10000, EPOCH_MS = 15 * 60 * 1000;
    private static final int DAY = 24 * 4;              // quarter hours: how old a hash heard can be and still count
    private static final int MAX_LINKING = 3;           // links being made at once to phones heard (anyone can advertise)
    private static final String TURN = "com.flick.app.BLE_TURN";   // the alarm for the next quarter hour

    private static Context app;
    private static BluetoothServerSocket server;
    private static int psm;
    private static long listenAt = -1;                  // the quarter hour the channel was opened in (a new one each)
    private static AdvertiseCallback advCb;
    private static ScanCallback scanCb;
    private static int advFlags = -1, advMode = -1, advPsm = -1;
    private static long advEpoch = -1;
    private static boolean looking, ready, watching;
    private static boolean shown;                       // Flick is on screen (Peers.visible)
    // Android starts at most five scans in 30 s for an app (a sixth hears nothing, and nothing says so): when the last
    // ones started; a scan no longer wanted stops a few seconds later (looked for again meanwhile: it goes on)
    private static final ArrayDeque<Long> starts = new ArrayDeque<Long>();
    private static long stopAt;
    private static final long STOP_LAG = 4000;
    private static final Map<String, Long> wanted = new HashMap<String, Long>();   // paired phones looked for (id -> until)
    private static final Map<String, Long> tried = new HashMap<String, Long>();   // address -> when a link to it was tried
    private static final List<String> busy = Collections.synchronizedList(new ArrayList<String>());   // linking now
    // what scans hear is looked at off the main thread (Android says it there), one at a time; a backlog is dropped
    // (what's in range is heard again in a moment)
    private static final ThreadPoolExecutor HEARD = hearer();
    // the paired phones' adverts (hash hex -> id), for each one whose key is known here, from a day back to the quarter
    // hour ahead, and this phone's own: worked out again each quarter hour and when a key comes, as a scan hears many
    // advertisements a second (under HASHES)
    private static final Map<String, String> HASHES = new HashMap<String, String>();
    private static final Set<String> MINE = new HashSet<String>();
    private static long hashesAt = -1;
    private static int hashesGen = -1;

    private BleLink() {}

    /** Android 10 or newer, with Bluetooth Low Energy that can advertise. */
    static boolean supported(Context c) {
        if (Build.VERSION.SDK_INT < 29) return false;
        try {
            if (!c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
            BluetoothAdapter a = adapter(c);
            return a != null && a.isMultipleAdvertisementSupported();
        } catch (Throwable e) { return false; }
    }

    /** Allowed to look for and reach nearby devices (Android 12: "Nearby devices"; 10 and 11: location, for scanning). */
    static boolean permitted(Context c) {
        if (Build.VERSION.SDK_INT >= 31) {
            return c.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                && c.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                && c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Asks for what's missing (one Android question; Android 13 and newer: Wi-Fi Direct's too, the same "Nearby devices"). */
    static void ask(Activity a, int req) {
        if (Build.VERSION.SDK_INT >= 33) a.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.NEARBY_WIFI_DEVICES}, req);
        else if (Build.VERSION.SDK_INT >= 31) a.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT}, req);
        else if (Build.VERSION.SDK_INT >= 29) a.requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, req);
    }

    /** Bluetooth is on. */
    static boolean on(Context c) { BluetoothAdapter a = adapter(c); return a != null && a.isEnabled(); }

    private static BluetoothAdapter adapter(Context c) {
        BluetoothManager m = (BluetoothManager) c.getApplicationContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    /** Location is on, or not needed for looking (Android 12 and newer). Android 10 and 11 hear nothing with it off. */
    static boolean location(Context c) {
        if (Build.VERSION.SDK_INT >= 31) return true;
        try {
            LocationManager lm = (LocationManager) c.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
            return lm == null || lm.isLocationEnabled();
        } catch (Throwable e) { return true; }
    }

    // Can look for others now: Android 10 and 11 hear nothing with Location off, nor with Flick out of sight (looking in
    // the background there needs location access "all the time", which Flick doesn't ask for)
    private static boolean canScan(Context c) { return Build.VERSION.SDK_INT >= 31 || (shown && location(c)); }

    /** Bluetooth would look for a phone here if Flick were on screen (Android 10 and 11 look only then). */
    static boolean scansIfShown(Context c) {
        return Build.VERSION.SDK_INT < 31 && !shown && supported(c) && permitted(c) && on(c) && location(c);
    }

    /** {supported, permitted, on, location (false: Android 10 and 11 with Location off: nothing is found), up}: for the page. */
    static org.json.JSONObject state(Context c) {
        org.json.JSONObject o = new org.json.JSONObject();
        try { o.put("supported", supported(c)); o.put("permitted", supported(c) && permitted(c)); o.put("on", on(c)); o.put("location", location(c)); o.put("up", server != null); } catch (Exception e) { /* empty */ }
        return o;
    }

    /** Flick is on screen (or not any more): what it says, and on Android 10 and 11 whether it can look, follows. */
    static synchronized void shown(boolean on) {
        if (shown == on) return;
        shown = on;
        if (app == null) return;
        advertise();
        applyScan();
    }

    // ------------------------------------------------------------ taking links (while this phone takes files)
    /** This phone takes files now (or not any more): it can be reached over Bluetooth while it does. Any thread. */
    static synchronized void serve(Context c, boolean on) {
        if (app == null) app = c.getApplicationContext();
        watch();
        if (!on) { stopServing(); return; }
        if (server != null || !supported(app) || !permitted(app) || !on(app)) return;
        try {
            final BluetoothServerSocket ss = adapter(app).listenUsingInsecureL2capChannel();
            server = ss;
            psm = ss.getPsm();
            listenAt = epoch();
            Thread t = new Thread(new Runnable() { @Override public void run() { acceptLoop(ss); } }, "flick-ble-accept");
            t.setDaemon(true);
            t.start();
            advertise();
            Bg.log("ble: taking links on channel " + psm);
        } catch (Throwable e) { Bg.warn("ble", e); server = null; }
    }

    private static synchronized void stopServing() {
        try { if (server != null) server.close(); } catch (Throwable e) { /* ignore */ }
        server = null;
        stopAdvertising();
    }

    // the quarter hour's channel: a new one, which the advertisement says from now on (links made over the one before stay
    // up; it can't be opened: the one before goes on)
    private static void relisten(long ep) {
        listenAt = ep;
        BluetoothServerSocket old = server;
        if (old == null) return;
        try {
            final BluetoothServerSocket ss = adapter(app).listenUsingInsecureL2capChannel();
            server = ss;
            psm = ss.getPsm();
            Thread t = new Thread(new Runnable() { @Override public void run() { acceptLoop(ss); } }, "flick-ble-accept");
            t.setDaemon(true);
            t.start();
            try { old.close(); } catch (Throwable e) { /* gone */ }
        } catch (Throwable e) { Bg.warn("ble", e); }
    }

    // Bluetooth turned on: reachable and looking again as wanted; turned off: what ran on it is gone (made again when on)
    private static void watch() {
        if (watching || app == null) return;
        watching = true;
        try {
            android.content.IntentFilter f = new android.content.IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
            android.content.BroadcastReceiver r = new android.content.BroadcastReceiver() {
                @Override public void onReceive(Context c, android.content.Intent i) {
                    int st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1);
                    if (st == BluetoothAdapter.STATE_ON) {
                        try { Peers.get(app).bluetoothChanged(); } catch (Throwable e) { /* not taking files */ }
                        synchronized (BleLink.class) { advertise(); applyScan(); }
                    } else if (st == BluetoothAdapter.STATE_TURNING_OFF || st == BluetoothAdapter.STATE_OFF) {
                        synchronized (BleLink.class) { stopServing(); advCb = null; advFlags = -1; scanCb = null; stopAt = 0; }
                    }
                    Page.event("ble-perm");                     // (the Connect screen says what's what now)
                }
            };
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, f, Context.RECEIVER_EXPORTED); else app.registerReceiver(r, f);
            // the quarter hour's alarm, and the screen coming on: what it says is said anew if it's out of date (the timer
            // for it waits while the phone sleeps)
            // (and Location turned on or off: Android 10 and 11 look only with it on)
            android.content.IntentFilter g = new android.content.IntentFilter(TURN);
            g.addAction(android.content.Intent.ACTION_SCREEN_ON);
            g.addAction(LocationManager.MODE_CHANGED_ACTION);
            android.content.BroadcastReceiver t = new android.content.BroadcastReceiver() {
                @Override public void onReceive(Context c, android.content.Intent i) {
                    if (LocationManager.MODE_CHANGED_ACTION.equals(i.getAction())) {
                        synchronized (BleLink.class) { applyScan(); }
                        Page.event("ble-perm");
                        return;
                    }
                    synchronized (BleLink.class) { if (advCb != null) advertise(); }
                }
            };
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(t, g, Context.RECEIVER_NOT_EXPORTED); else app.registerReceiver(t, g);
        } catch (Throwable e) { Bg.warn("ble watch", e); }
    }

    private static void acceptLoop(BluetoothServerSocket ss) {
        while (true) {
            final BluetoothSocket s;
            try { s = ss.accept(); } catch (Throwable e) { synchronized (BleLink.class) { if (server == ss) { server = null; stopAdvertising(); } } return; }
            // (anyone in range can connect: a few still to say who they are at a time, one from each device, each in
            // seconds; one more makes the oldest end: see Peers.tunnel)
            String a = null;
            try { a = s.getRemoteDevice().getAddress(); } catch (Throwable e) { /* not known */ }
            final String from = a;
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    try { Peers.get(app).tunnel(s.getInputStream(), s.getOutputStream(), s, "bluetooth", false, from); }
                    catch (Throwable e) { try { s.close(); } catch (Throwable x) { /* ignore */ } }
                }
            }, "flick-ble-in");
            t.setDaemon(true);
            t.start();
        }
    }

    // ------------------------------------------------------------ saying it's here
    private static synchronized void advertise() {
        int flags = (looking ? F_LOOKING : 0) | (ready ? F_READY : 0);
        if (server == null) return;
        long ep = epoch();
        // a new channel with each quarter hour's hash (one that stayed would follow the phone about as well as a hash)
        if (ep != listenAt) relisten(ep);
        // (often while someone may be looking; less with Flick open; least in the background, all day)
        int mode = looking || ready ? AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY : shown ? AdvertiseSettings.ADVERTISE_MODE_BALANCED : AdvertiseSettings.ADVERTISE_MODE_LOW_POWER;
        if (advCb != null && flags == advFlags && ep == advEpoch && mode == advMode && psm == advPsm) return;
        stopAdvertising();
        try {
            BluetoothLeAdvertiser adv = adapter(app).getBluetoothLeAdvertiser();
            if (adv == null) return;
            byte[] h = hash(Peers.get(app).bleKey(), ep);
            byte[] p = {'F', 'L', V, (byte) flags, h[0], h[1], h[2], h[3], h[4], h[5], (byte) psm, (byte) (psm >> 8)};
            AdvertiseSettings set = new AdvertiseSettings.Builder()
                .setAdvertiseMode(mode)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).setConnectable(true).setTimeout(0).build();
            AdvertiseData data = new AdvertiseData.Builder().addManufacturerData(COMPANY, p).setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build();
            advCb = new AdvertiseCallback() {
                @Override public void onStartFailure(int code) {
                    Bg.log("ble: advertising failed " + code);
                    if (code == ADVERTISE_FAILED_ALREADY_STARTED) return;
                    // (tried again in a while: until then this phone can't be found over Bluetooth)
                    final AdvertiseCallback me = this;
                    synchronized (BleLink.class) { if (advCb == me) { advCb = null; advFlags = -1; } }
                    Bg.mainDelayed(new Runnable() { @Override public void run() { synchronized (BleLink.class) { if (advCb == null) advertise(); } } }, 10000);
                }
            };
            advFlags = flags;
            advMode = mode;
            advEpoch = ep;
            advPsm = psm;
            adv.startAdvertising(set, data, advCb);
            // (what it says changes with the time: said anew then; while the phone sleeps the timer waits, so an alarm
            // wakes it for that, a minute or so late at worst)
            long next = (ep + 1) * EPOCH_MS + 500;
            Bg.mainDelayed(new Runnable() { @Override public void run() { synchronized (BleLink.class) { if (advCb != null) advertise(); } } }, Math.max(1000, next - System.currentTimeMillis()));
            try {
                android.app.AlarmManager am = (android.app.AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
                if (am != null) am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, next, turn());
            } catch (Throwable e) { Bg.warn("ble alarm", e); }
        } catch (Throwable e) { Bg.warn("ble advertise", e); advCb = null; }
    }

    private static android.app.PendingIntent turn() {
        return android.app.PendingIntent.getBroadcast(app, 9, new android.content.Intent(TURN).setPackage(app.getPackageName()),
            android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static synchronized void stopAdvertising() {
        if (advCb == null) return;
        try { BluetoothLeAdvertiser adv = adapter(app).getBluetoothLeAdvertiser(); if (adv != null) adv.stopAdvertising(advCb); } catch (Throwable e) { /* ignore */ }
        try { android.app.AlarmManager am = (android.app.AlarmManager) app.getSystemService(Context.ALARM_SERVICE); if (am != null) am.cancel(turn()); } catch (Throwable e) { /* ignore */ }
        advCb = null;
        advFlags = -1;
        advEpoch = -1;
        advPsm = -1;
    }

    /** The Connect screen is showing (or not): the advertisement says so, so a phone holding Connect nearby picks this one. */
    static synchronized void ready(boolean on) { if (ready == on) return; ready = on; advertise(); }

    // ------------------------------------------------------------ looking for others
    /** Looking for other phones (the Connect screen, Other phones, holding Connect): links to the ones heard. */
    static synchronized void look(Context c, boolean on) {
        if (app == null) app = c.getApplicationContext();
        watch();
        if (looking == on) return;
        looking = on;
        advertise();
        applyScan();
    }

    /** A paired phone that isn't on the network: listened for, for ms (a link to it is made if it's heard; 0: not any
     *  more, it was reached another way). False: no Bluetooth here to listen with (not this Android, not allowed, or off). */
    static synchronized boolean lookFor(Context c, String peerId, long ms) {
        if (app == null) app = c.getApplicationContext();
        if (ms <= 0) { if (wanted.remove(peerId) != null) applyScan(); return false; }
        watch();
        // (Android 10 and 11 with Location off, or Flick out of sight there: nothing would be heard, so it isn't waited for)
        if (!supported(app) || !permitted(app) || !on(app) || !canScan(app)) return false;
        wanted.put(peerId, SystemClock.elapsedRealtime() + ms);      // (several at once: each its own)
        applyScan();
        Bg.mainDelayed(new Runnable() { @Override public void run() { synchronized (BleLink.class) { applyScan(); } } }, ms + 100);
        return scanCb != null;
    }

    // the paired phones still looked for (the ones whose time ran out go)
    private static boolean wantsNow() {
        long now = SystemClock.elapsedRealtime();
        for (Iterator<Map.Entry<String, Long>> it = wanted.entrySet().iterator(); it.hasNext(); ) if (it.next().getValue() <= now) it.remove();
        return !wanted.isEmpty();
    }

    private static void applyScan() {
        boolean on = (looking || wantsNow()) && app != null && supported(app) && permitted(app) && on(app) && canScan(app);
        if (on) stopAt = 0;
        if (on && scanCb == null) {
            // (a sixth scan within 30 s would hear nothing: it starts once it can)
            long now = SystemClock.elapsedRealtime();
            while (!starts.isEmpty() && now - starts.peekFirst() >= 30000) starts.pollFirst();
            if (starts.size() >= 5) { scanLater(starts.peekFirst() + 30000 - now + 100); return; }
            try {
                BluetoothLeScanner sc = adapter(app).getBluetoothLeScanner();
                if (sc == null) return;
                ScanFilter f = new ScanFilter.Builder().setManufacturerData(COMPANY, new byte[]{'F', 'L'}, new byte[]{(byte) 0xff, (byte) 0xff}).build();
                ScanSettings set = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
                scanCb = new ScanCallback() {
                    @Override public void onScanResult(int type, ScanResult r) { hear(r); }
                    @Override public void onBatchScanResults(List<ScanResult> rs) { for (ScanResult r : rs) hear(r); }
                    @Override public void onScanFailed(int code) {
                        Bg.log("ble: scan failed " + code);
                        final ScanCallback me = this;
                        synchronized (BleLink.class) { if (scanCb == me) scanCb = null; }
                        scanLater(30000);                       // (tried again: Android may only have been busy)
                    }
                };
                List<ScanFilter> fs = new ArrayList<ScanFilter>();
                fs.add(f);
                starts.addLast(now);
                sc.startScan(fs, set, scanCb);
            } catch (Throwable e) { Bg.warn("ble scan", e); scanCb = null; }
        } else if (!on && scanCb != null) {
            // stopped a few seconds later: wanted again meanwhile (the Connect screen paused and back), the same scan goes
            // on rather than a new one start (which would count against the five)
            long now = SystemClock.elapsedRealtime();
            if (stopAt == 0) { stopAt = now + STOP_LAG; scanLater(STOP_LAG + 50); return; }
            if (now < stopAt) return;
            stopAt = 0;
            try { BluetoothLeScanner sc = adapter(app).getBluetoothLeScanner(); if (sc != null) sc.stopScan(scanCb); } catch (Throwable e) { /* ignore */ }
            scanCb = null;
        }
    }

    private static void scanLater(long ms) {
        Bg.mainDelayed(new Runnable() { @Override public void run() { synchronized (BleLink.class) { applyScan(); } } }, Math.max(100, ms));
    }

    /** What an advertisement says: {flags, psm}, or null when it isn't Flick's. */
    static int[] parse(byte[] p) {
        if (p == null || p.length < 12 || p[0] != 'F' || p[1] != 'L' || p[2] != V) return null;
        int psm = (p[10] & 0xff) | ((p[11] & 0xff) << 8);
        if (psm <= 0) return null;
        return new int[]{p[3] & 0xff, psm};
    }

    private static ThreadPoolExecutor hearer() {
        ThreadPoolExecutor p = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>(64), new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-ble-heard"); t.setDaemon(true); return t; }
        }, new ThreadPoolExecutor.DiscardPolicy());
        p.allowCoreThreadTimeOut(true);
        return p;
    }

    private static void hear(final ScanResult r) {
        try { HEARD.execute(new Runnable() { @Override public void run() { heard(r); } }); } catch (Throwable e) { /* heard again soon */ }
    }

    private static void heard(ScanResult r) {
        try {
            ScanRecord rec = r.getScanRecord();
            byte[] p = rec == null ? null : rec.getManufacturerSpecificData(COMPANY);
            int[] a = parse(p);
            if (a == null) return;
            final String theirs = hex(java.util.Arrays.copyOfRange(p, 4, 10));
            if (mine(theirs)) return;                           // (this phone's own)
            String pid = idOf(theirs);                          // a paired phone's (its key is known here), or null
            final BluetoothDevice d = r.getDevice();
            final String addr = d.getAddress();
            boolean want, forPaired;
            synchronized (BleLink.class) {
                forPaired = pid != null && wantsNow() && wanted.containsKey(pid);
                // Looking: link to it unless it's looking too and its hash is lower (then it links to this phone); a paired
                // phone looked for: always. Not one tried a moment ago, nor one being linked to now, nor while a few are.
                want = forPaired || (looking && ((a[0] & F_LOOKING) == 0 || hex(hash(Peers.get(app).bleKey(), epoch())).compareTo(theirs) < 0));
                Long at = tried.get(addr);
                if (at != null && SystemClock.elapsedRealtime() - at < RETRY_MS) want = false;
                if (busy.contains(addr) || busy.size() >= MAX_LINKING) want = false;
            }
            // nor one this phone reaches already (on the network, or over a link: a paired one's proven to be its)
            if (!want || Peers.get(app).linkedOver(theirs, forPaired)) return;
            synchronized (BleLink.class) {
                if (busy.contains(addr) || busy.size() >= MAX_LINKING) return;
                long now = SystemClock.elapsedRealtime();
                // (addresses tried long enough ago are forgotten: advertisers make up new ones all the time)
                for (Iterator<Long> it = tried.values().iterator(); it.hasNext(); ) if (now - it.next() >= RETRY_MS) it.remove();
                tried.put(addr, now);
                busy.add(addr);
            }
            final int channel = a[1];
            Thread t = new Thread(new Runnable() {
                @Override public void run() {
                    BluetoothSocket s = null;
                    try {
                        s = d.createInsecureL2capChannel(channel);
                        s.connect();
                        // (the hash heard stays with the link: one to a phone not paired here is known by it)
                        Peers.get(app).tunnel(s.getInputStream(), s.getOutputStream(), s, "bluetooth", true, null, theirs);
                    } catch (Throwable e) {
                        Bg.log("ble: couldn't link to " + addr + ": " + e.getMessage());
                        try { if (s != null) s.close(); } catch (Throwable x) { /* ignore */ }
                    } finally { busy.remove(addr); }
                }
            }, "flick-ble-out");
            t.setDaemon(true);
            t.start();
        } catch (Throwable e) { Bg.warn("ble", e); }
    }

    /**
     * What an advertisement says in quarter hour epoch: the first 6 bytes of HMAC-SHA256(key, "flick-ble|" + epoch), key
     * being the phone's Bluetooth key. Without the key nobody can tell one quarter hour's from another's, or work one out.
     */
    static byte[] hash(byte[] key, long epoch) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return java.util.Arrays.copyOf(m.doFinal(("flick-ble|" + epoch).getBytes("UTF-8")), 6);
        } catch (Exception e) { return new byte[6]; }
    }
    static long epoch() { return System.currentTimeMillis() / EPOCH_MS; }

    /**
     * The paired phone (its key known here) whose advertisement this is (hash hex): of now, the quarter hour ahead (two
     * phones' clocks differ a little), or any time in the last day (a phone asleep from before this goes on saying the
     * one it said when it fell asleep). Null: not a paired phone's (or not one whose key this phone has yet).
     */
    static String idOf(String hashHex) {
        if (hashHex == null || app == null) return null;
        synchronized (HASHES) { hashes(); return HASHES.get(hashHex); }
    }

    // this phone's own advertisement (of any quarter hour in the same window)
    private static boolean mine(String hashHex) {
        synchronized (HASHES) { hashes(); return MINE.contains(hashHex); }
    }

    // (under HASHES) worked out again once a quarter hour, and when a paired phone's key comes or goes (Peers.keysGen)
    private static void hashes() {
        Peers p = Peers.get(app);
        long e = epoch();
        int g = p.keysGen();
        if (e == hashesAt && g == hashesGen) return;
        HASHES.clear();
        MINE.clear();
        byte[] me = p.bleKey();
        Map<String, List<byte[]>> keys = p.bleKeys();
        for (long k = e - DAY; k <= e + 1; k++) {
            MINE.add(hex(hash(me, k)));
            for (Map.Entry<String, List<byte[]>> x : keys.entrySet()) for (byte[] key : x.getValue()) HASHES.put(hex(hash(key, k)), x.getKey());
        }
        hashesAt = e;
        hashesGen = g;
    }

    static String hex(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) { c[2 * i] = Character.forDigit((b[i] >> 4) & 0xf, 16); c[2 * i + 1] = Character.forDigit(b[i] & 0xf, 16); }
        return new String(c);
    }
}
