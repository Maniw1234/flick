package com.flick.app;

import android.Manifest;
import android.annotation.TargetApi;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.wifi.WifiManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.os.Build;
import android.os.Looper;
import android.os.SystemClock;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Wi-Fi Direct between two phones that reached each other over Bluetooth (they aren't on the same Wi-Fi): Bluetooth is
 * slow for files, so for big ones the phone taking them makes a Wi-Fi network of its own for a moment (a Wi-Fi Direct
 * group, with a name and password made up for it), tells the sending phone how to join it over the encrypted link they
 * already have, and the files go over Wi-Fi, many times faster. Neither user taps anything (Android 10 and newer, with
 * Wi-Fi on; Android 13 and newer: "Nearby devices" allowed; 10 and 11: the location access Bluetooth needed there).
 * The network ends by itself once nothing used it for a minute. Every call that waits is for a worker thread: Android
 * answers on the main thread.
 */
@TargetApi(29)
final class WifiDirect {
    private static final long IDLE_MS = 60000, CHECK_MS = 15000;
    static final String TAIL = "-Flick";                // its network's name ends so ("DIRECT-xy-Flick"): Flick's own
    private static final String ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    private static final SecureRandom RND = new SecureRandom();

    /** Whether a network's addresses are in use by Flick now (connections from there: PeerServer.anyFrom). */
    interface InUse { boolean from(String prefix); }
    static volatile InUse inUse;

    private static Context app;
    private static WifiP2pManager mgr;
    private static WifiP2pManager.Channel ch;
    // the network this phone made (it takes files over it) or joined (it sends over it), and when it was last used
    private static String made, joined;
    private static long usedAt;
    private static int uses;                             // sends over it now
    private static boolean watching;

    private WifiDirect() {}

    /** Where another phone reaches this one over Wi-Fi Direct: an address, after joining network ssid (null: it's in it). */
    static final class Net {
        String ssid, pass, ip, why;
        boolean ok() { return why == null; }
    }

    // ------------------------------------------------------------ can it
    static boolean supported(Context c) {
        if (Build.VERSION.SDK_INT < 29) return false;
        try {
            return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
                && c.getApplicationContext().getSystemService(Context.WIFI_P2P_SERVICE) != null;
        } catch (Throwable e) { return false; }
    }

    /** Allowed: Android 13 and newer, "Nearby devices"; before, location access with location on (Android's rule). */
    static boolean permitted(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= 33) return c.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED;
            if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return false;
            LocationManager lm = (LocationManager) c.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
            return lm == null || lm.isLocationEnabled();
        } catch (Throwable e) { return false; }
    }

    static boolean wifiOn(Context c) {
        try {
            WifiManager w = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            return w != null && w.isWifiEnabled();
        } catch (Throwable e) { return false; }
    }

    static boolean usable(Context c) { return supported(c) && permitted(c) && wifiOn(c); }

    /** Android 13 and newer, and not allowed yet: worth asking (with Bluetooth's "Nearby devices": the same question). */
    static boolean needsAsk(Context c) { return Build.VERSION.SDK_INT >= 33 && supported(c) && !permitted(c); }

    // ------------------------------------------------------------ the phone taking files: its network
    /**
     * Where a phone (in network theirs now: Flick's, or "") reaches this one: on the network both are in already, else
     * on this phone's own (made now: a few seconds). Blocks.
     */
    static Net offer(Context c, String theirs) {
        Net n = new Net();
        if (!supported(c)) { n.why = "unsupported"; return n; }
        if (!permitted(c)) { n.why = "perm"; return n; }
        if (!wifiOn(c)) { n.why = "wifi off"; return n; }
        if (!init(c)) { n.why = "unsupported"; return n; }
        WifiP2pGroup g = group(3000);
        if (g != null) {
            String name = g.getNetworkName(), ip = ipOf(g.getInterface());
            if (name != null && ip != null && name.equals(theirs) && name.endsWith(TAIL)) {
                // both in it already (one made it, the other joined): this phone's address there
                n.ip = ip;
                touch(g.isGroupOwner() ? name : null, g.isGroupOwner() ? null : name);
                return n;
            }
            String pass = g.isGroupOwner() ? g.getPassphrase() : null;
            if (g.isGroupOwner() && name != null && name.endsWith(TAIL) && ip != null && pass != null && pass.length() >= 8) {
                // this phone's own from a moment ago: the other one joins it
                n.ssid = name; n.pass = pass; n.ip = ip;
                touch(name, null);
                return n;
            }
            n.why = "busy";                              // in another one (another app's, or another phone's)
            return n;
        }
        final String ssid = "DIRECT-" + pick(2) + TAIL, pass = pick(16);
        final WifiP2pConfig cfg = new WifiP2pConfig.Builder().setNetworkName(ssid).setPassphrase(pass)
            .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_AUTO).enablePersistentMode(false).build();
        int r = act(new Act() { @Override public void run(WifiP2pManager m, WifiP2pManager.Channel k, WifiP2pManager.ActionListener l) { m.createGroup(k, cfg, l); } }, 6000);
        if (r != 0) { Bg.log("direct: couldn't make a network (" + r + ")"); n.why = r == 1 + WifiP2pManager.BUSY ? "busy" : "failed"; return n; }
        // up once it has its address (a moment after)
        long until = SystemClock.elapsedRealtime() + 8000;
        while (SystemClock.elapsedRealtime() < until) {
            WifiP2pGroup x = group(1500);
            String ip = x != null && x.isGroupOwner() && ssid.equals(x.getNetworkName()) ? ipOf(x.getInterface()) : null;
            if (ip != null) {
                n.ssid = ssid; n.pass = pass; n.ip = ip;
                touch(ssid, null);
                Bg.log("direct: made " + ssid + " at " + ip);
                return n;
            }
            sleep(250);
        }
        remove();
        n.why = "failed";
        return n;
    }

    // ------------------------------------------------------------ the phone sending: joining it
    /** Joins network ssid and waits until this phone has an address next to ip there; false when it can't (in ms). Blocks. */
    static boolean join(Context c, String ssid, String pass, String ip, long ms, AtomicBoolean abort) {
        if (ssid == null || pass == null || ip == null || !ssid.endsWith(TAIL) || pass.length() < 8 || pass.length() > 63) return false;
        if (!usable(c) || !init(c)) return false;
        long until = SystemClock.elapsedRealtime() + ms;
        WifiP2pGroup g = group(3000);
        if (g != null) {
            String name = g.getNetworkName();
            if (!g.isGroupOwner() && ssid.equals(name)) { touch(null, ssid); return near(ip, until, abort); }   // in it already
            // in this phone's own, with nobody in it (it took files a while ago): it ends, to join the other's (a phone
            // is in one at a time)
            String mine = g.isGroupOwner() && name != null && name.endsWith(TAIL) ? ipOf(g.getInterface()) : null;
            if (mine == null || !g.getClientList().isEmpty() || busy(prefix(mine))) return false;
            remove();
            synchronized (WifiDirect.class) { made = null; }
            sleep(600);
        }
        final WifiP2pConfig cfg = new WifiP2pConfig.Builder().setNetworkName(ssid).setPassphrase(pass).build();
        int r = act(new Act() { @Override public void run(WifiP2pManager m, WifiP2pManager.Channel k, WifiP2pManager.ActionListener l) { m.connect(k, cfg, l); } }, 6000);
        if (r != 0) { Bg.log("direct: couldn't join (" + r + ")"); return false; }
        if (near(ip, until, abort)) { touch(null, ssid); Bg.log("direct: joined " + ssid); return true; }
        // not in time (or stopped): left, so this phone isn't kept in it
        act(new Act() { @Override public void run(WifiP2pManager m, WifiP2pManager.Channel k, WifiP2pManager.ActionListener l) { m.cancelConnect(k, l); } }, 2000);
        remove();
        return false;
    }

    // joined once this phone has an address on ip's network (the network gives it one, a moment after joining)
    private static boolean near(String ip, long until, AtomicBoolean abort) {
        while (SystemClock.elapsedRealtime() < until && !(abort != null && abort.get())) {
            WifiP2pInfo info = info(1500);
            if (info != null && info.groupFormed && !info.isGroupOwner && localNear(ip)) return true;
            sleep(300);
        }
        return false;
    }

    /** The Flick network this phone is in now ("" when none): the other phone may be in it too. Blocks a moment. */
    static String current(Context c) {
        if (!usable(c) || !init(c)) return "";
        WifiP2pGroup g = group(2000);
        String name = g == null ? null : g.getNetworkName();
        return name != null && name.endsWith(TAIL) ? name : "";
    }

    /** A send over Wi-Fi Direct starts (on) or ends: the network stays while one goes. */
    static synchronized void use(boolean on) {
        uses = Math.max(0, uses + (on ? 1 : -1));
        usedAt = SystemClock.elapsedRealtime();
    }

    // ------------------------------------------------------------ the network's end
    private static synchronized void touch(String m, String j) {
        if (m != null) { made = m; joined = null; }
        if (j != null) { joined = j; made = null; }
        usedAt = SystemClock.elapsedRealtime();
        if (watching) return;
        watching = true;
        Thread t = new Thread(new Runnable() { @Override public void run() { watch(); } }, "flick-direct");
        t.setDaemon(true);
        t.start();
    }

    // every few seconds: still used (a send, a phone in it, connections from it)? A minute of nothing: it ends
    private static void watch() {
        try {
            int misses = 0;
            while (true) {
                sleep(CHECK_MS);
                WifiP2pGroup[] gi = groupInfo(3000);
                if (gi == null) {
                    // Android didn't answer in time (busy): whether it's still up isn't known, so it's asked again; after a
                    // minute of no answers, with nothing using it, it's ended regardless (never left up for good)
                    boolean give;
                    synchronized (WifiDirect.class) { give = ++misses >= 4 && uses == 0; if (give) { made = null; joined = null; watching = false; } }
                    if (give) { Bg.log("direct: no answer about it: ended"); remove(); return; }
                    continue;
                }
                misses = 0;
                WifiP2pGroup g = gi[0];
                long now = SystemClock.elapsedRealtime();
                boolean end;
                synchronized (WifiDirect.class) {
                    String name = g == null ? null : g.getNetworkName();
                    boolean ours = name != null && (name.equals(made) || name.equals(joined));
                    if (!ours) { made = null; joined = null; watching = false; return; }   // gone, or not Flick's: left alone
                    String ip = ipOf(g.getInterface());
                    boolean used = uses > 0 || (g.isGroupOwner() && !g.getClientList().isEmpty()) || (ip != null && busy(prefix(ip)));
                    if (used) usedAt = now;
                    end = now - usedAt > IDLE_MS;
                    if (end) { made = null; joined = null; watching = false; }
                }
                if (end) { Bg.log("direct: done"); remove(); return; }
            }
        } catch (Throwable e) { synchronized (WifiDirect.class) { watching = false; } }
    }

    private static void remove() {
        act(new Act() { @Override public void run(WifiP2pManager m, WifiP2pManager.Channel k, WifiP2pManager.ActionListener l) { m.removeGroup(k, l); } }, 3000);
    }

    // ------------------------------------------------------------ Android's Wi-Fi Direct
    private static synchronized boolean init(Context c) {
        if (app == null) app = c.getApplicationContext();
        if (mgr == null) mgr = (WifiP2pManager) app.getSystemService(Context.WIFI_P2P_SERVICE);
        if (mgr == null) return false;
        if (ch == null) {
            ch = mgr.initialize(app, Looper.getMainLooper(), new WifiP2pManager.ChannelListener() {
                @Override public void onChannelDisconnected() { synchronized (WifiDirect.class) { ch = null; } }
            });
        }
        return ch != null;
    }

    private interface Act { void run(WifiP2pManager m, WifiP2pManager.Channel k, WifiP2pManager.ActionListener l); }

    // 0: done; else 1 + Android's reason (ERROR 0, P2P_UNSUPPORTED 1, BUSY 2); -1: no answer in ms
    private static int act(Act a, long ms) {
        WifiP2pManager m; WifiP2pManager.Channel k;
        synchronized (WifiDirect.class) { m = mgr; k = ch; }
        if (m == null || k == null) return -1;
        final AtomicInteger r = new AtomicInteger(-1);
        final CountDownLatch done = new CountDownLatch(1);
        try {
            a.run(m, k, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() { r.set(0); done.countDown(); }
                @Override public void onFailure(int why) { r.set(1 + why); done.countDown(); }
            });
            done.await(ms, TimeUnit.MILLISECONDS);
        } catch (Throwable e) { Bg.log("direct: " + e); return -2; }
        return r.get();
    }

    private static WifiP2pGroup group(long ms) { WifiP2pGroup[] g = groupInfo(ms); return g == null ? null : g[0]; }

    // the group this phone is in ({null}: none), or null when Android didn't answer within ms (not known)
    private static WifiP2pGroup[] groupInfo(long ms) {
        WifiP2pManager m; WifiP2pManager.Channel k;
        synchronized (WifiDirect.class) { m = mgr; k = ch; }
        if (m == null || k == null) return null;
        final AtomicReference<WifiP2pGroup> r = new AtomicReference<WifiP2pGroup>();
        final CountDownLatch done = new CountDownLatch(1);
        try {
            m.requestGroupInfo(k, new WifiP2pManager.GroupInfoListener() {
                @Override public void onGroupInfoAvailable(WifiP2pGroup g) { r.set(g); done.countDown(); }
            });
            if (!done.await(ms, TimeUnit.MILLISECONDS)) return null;
        } catch (Throwable e) { return null; }
        return new WifiP2pGroup[]{r.get()};
    }

    private static WifiP2pInfo info(long ms) {
        WifiP2pManager m; WifiP2pManager.Channel k;
        synchronized (WifiDirect.class) { m = mgr; k = ch; }
        if (m == null || k == null) return null;
        final AtomicReference<WifiP2pInfo> r = new AtomicReference<WifiP2pInfo>();
        final CountDownLatch done = new CountDownLatch(1);
        try {
            m.requestConnectionInfo(k, new WifiP2pManager.ConnectionInfoListener() {
                @Override public void onConnectionInfoAvailable(WifiP2pInfo i) { r.set(i); done.countDown(); }
            });
            done.await(ms, TimeUnit.MILLISECONDS);
        } catch (Throwable e) { return null; }
        return r.get();
    }

    // ------------------------------------------------------------ addresses
    /** The IPv4 address of a network interface (the Wi-Fi Direct one, by name), or null. */
    static String ipOf(String iface) {
        if (iface == null || iface.isEmpty()) return null;
        try {
            NetworkInterface ni = NetworkInterface.getByName(iface);
            if (ni == null) return null;
            for (InterfaceAddress ia : ni.getInterfaceAddresses()) if (ia.getAddress() instanceof Inet4Address) return ia.getAddress().getHostAddress();
        } catch (Throwable e) { /* none */ }
        return null;
    }

    // this phone has an address in ip's network (on any interface: the Wi-Fi Direct one, once it's given one)
    private static boolean localNear(String ip) {
        try {
            InetAddress want = InetAddress.getByName(ip);
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof Inet4Address && !a.equals(want) && NetKind.sameSubnet(a, want, Math.max(8, ia.getNetworkPrefixLength()))) return true;
                }
            }
        } catch (Throwable e) { /* no */ }
        return false;
    }

    /** "192.168.49." for 192.168.49.1: the network's addresses (Android gives Wi-Fi Direct networks a /24). */
    static String prefix(String ip) { int k = ip == null ? -1 : ip.lastIndexOf('.'); return k > 0 ? ip.substring(0, k + 1) : "\u0000"; }

    private static boolean busy(String prefix) { InUse u = inUse; try { return u != null && u.from(prefix); } catch (Throwable e) { return false; } }

    private static String pick(int n) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < n; i++) s.append(ABC.charAt(RND.nextInt(ABC.length())));
        return s.toString();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
