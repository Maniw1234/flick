package com.flick.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbAccessory;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeoutException;

/**
 * Two phones on one USB cable (USB-C to USB-C, or with an adapter). Whichever one the cable makes the host switches
 * the other into "accessory" mode (Android Open Accessory: three requests over the cable), and from then on both talk
 * over the cable's bulk pipes: a Tunnel, so they pair and send to each other as over Wi-Fi, without any network.
 * Android asks once on each phone the first time ("Allow Flick to access…", "Open Flick…"; with "always" ticked, not
 * again). One cable at a time, and one try at linking over it at a time. A link that ends while the cable stays in
 * (Flick on the other phone closed and opened again) is made again by itself, a few times. It runs while Flick's screen
 * is up and while Flick stays connected in the background (LinkService).
 */
final class UsbPeer {
    static final String ACTION_PERM = "com.flick.app.USB_PERMISSION";
    static final int GOOGLE = 0x18D1, AOA = 0x2D00, AOA_ADB = 0x2D01;
    // what this phone says it is when it switches the other over (res/xml/accessory_filter.xml matches the first two)
    static final String MANUFACTURER = "Flick", MODEL = "Flick";
    private static final int CHUNK = 16384, PACKET = 512;
    // phone makers' USB vendor ids: a device from one of them may be a phone (the cable's other end, asked to switch)
    private static final int[] PHONES = {0x18D1, 0x04E8, 0x2717, 0x2A70, 0x22B8, 0x1004, 0x12D1, 0x0FCE, 0x22D9, 0x2D95,
        0x2E04, 0x0B05, 0x0BB4, 0x19D2, 0x17EF, 0x1949, 0x2A45, 0x1EBF, 0x29A9, 0x05C6, 0x0E8D, 0x1BBB};

    private static Context app;
    private static boolean started;
    private static final Set<String> asked = new HashSet<String>();   // devices asked about (by name), per plug-in
    private static volatile Tunnel tunnel;                            // the one over the cable now
    private static volatile String linkedDevice;                      // this phone as the host: the device it's over
    private static volatile boolean unplugged;                        // the cable came out (no linking again)
    private static int tries;                                         // links made again since the last plug-in
    private static boolean opening;                                   // a link over the cable being made now (under UsbPeer.class)
    // a write the other phone doesn't take for this long (its Flick stuck): the link ends (a phone busy for a few seconds
    // isn't a cable pulled: its side of the link holds a slow connection's data back for at most 15 s, see Tunnel)
    private static final int STUCK_MS = 30000;

    private UsbPeer() {}

    /** Flick's screen is up, or it stays connected in the background: cables plugged in now or later are looked at.
     *  Never throws. */
    static synchronized void start(Context c) {
        if (started) { scanSoon(); return; }
        app = c.getApplicationContext();
        try {
            IntentFilter f = new IntentFilter();
            f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
            f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
            f.addAction(UsbManager.ACTION_USB_ACCESSORY_DETACHED);
            f.addAction(ACTION_PERM);
            BroadcastReceiver r = new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent i) { onBroadcast(i); }
            };
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED); else app.registerReceiver(r, f);
            started = true;
        } catch (Throwable e) { Bg.warn("usb peer", e); return; }
        scanSoon();
    }

    /** The phone on the other end, if one is linked over the cable now. */
    static boolean linked() { Tunnel t = tunnel; return t != null && !t.isClosed(); }

    private static void scanSoon() {
        Thread th = new Thread(new Runnable() { @Override public void run() { scan(); } }, "flick-usb-scan");
        th.setDaemon(true);
        th.start();
    }

    // what's on the cable now: an accessory (this phone was switched over), else devices (this phone is the host)
    private static void scan() {
        try {
            UsbManager um = (UsbManager) app.getSystemService(Context.USB_SERVICE);
            if (um == null) return;
            UsbAccessory[] accs = um.getAccessoryList();
            if (accs != null) for (UsbAccessory a : accs) if (ours(a)) { openAccessory(a); return; }
            for (UsbDevice d : um.getDeviceList().values()) consider(d);
        } catch (Throwable e) { Bg.warn("usb peer", e); }
    }

    private static void onBroadcast(Intent i) {
        String a = i.getAction();
        final UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        final UsbAccessory acc = i.getParcelableExtra(UsbManager.EXTRA_ACCESSORY);
        if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(a) || UsbManager.ACTION_USB_ACCESSORY_DETACHED.equals(a)) {
            // (another USB device coming out, a flash drive on the same hub: the link stays)
            if (d != null) { synchronized (asked) { asked.remove(d.getDeviceName()); } }
            boolean mine = UsbManager.ACTION_USB_ACCESSORY_DETACHED.equals(a) ? acc == null || ours(acc)
                : d == null || linkedDevice == null || linkedDevice.equals(d.getDeviceName());
            if (!mine) return;
            synchronized (asked) { asked.clear(); }
            unplugged = true;
            Tunnel t = tunnel;
            if (t != null) t.close("unplugged");
            return;
        }
        // Plugged in, or an answer to "Allow Flick to access…": what's on the cable now is looked at, as Android lists it
        // (never what the intent names: any app can send one, and Flick would ask about a device that isn't there)
        unplugged = false;
        synchronized (UsbPeer.class) { tries = 0; }
        scanSoon();
    }

    /** Flick was opened for the cable (the activity's USB_ACCESSORY_ATTACHED or USB_DEVICE_ATTACHED intent). */
    static void fromIntent(Context c, Intent i) {
        start(c);
        onBroadcast(i);
    }

    private static boolean ours(UsbAccessory a) { return a != null && MANUFACTURER.equals(a.getManufacturer()) && MODEL.equals(a.getModel()); }

    private static boolean aoa(UsbDevice d) { return d.getVendorId() == GOOGLE && (d.getProductId() == AOA || d.getProductId() == AOA_ADB); }

    // A device that may be a phone: one showing what phones show (MTP or PTP, ADB), or one from a phone maker that shows
    // nothing a phone doesn't (a phone charging only shows nothing at all). A maker's hubs, docks, drives, keyboards and
    // headsets aren't asked about ("Allow Flick to access…" for those would only puzzle).
    private static boolean mayBePhone(UsbDevice d) {
        if (d.getDeviceClass() == UsbConstants.USB_CLASS_HUB) return false;
        int n = d.getInterfaceCount(), other = 0;
        for (int k = 0; k < n; k++) {
            UsbInterface f = d.getInterface(k);
            int c = f.getInterfaceClass();
            if (c == UsbConstants.USB_CLASS_STILL_IMAGE) return true;
            if (c == 0xFF && f.getInterfaceSubclass() == 0x42 && f.getInterfaceProtocol() == 1) return true;
            if (c == UsbConstants.USB_CLASS_MASS_STORAGE || c == UsbConstants.USB_CLASS_HID || c == UsbConstants.USB_CLASS_AUDIO
                || c == UsbConstants.USB_CLASS_VIDEO || c == UsbConstants.USB_CLASS_PRINTER || c == UsbConstants.USB_CLASS_HUB
                || c == UsbConstants.USB_CLASS_CSCID || c == 0x11) other++;            // (0x11: a dock's "billboard")
        }
        if (n > 0 && other == n) return false;
        for (int v : PHONES) if (d.getVendorId() == v) return true;
        return false;
    }

    private static PendingIntent permIntent() {
        Intent i = new Intent(ACTION_PERM).setPackage(app.getPackageName());
        // (mutable: Android adds the device and the answer to it)
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        return PendingIntent.getBroadcast(app, 7, i, flags);
    }

    // this phone is the host: the other phone, switched over already (an accessory now), or asked to switch
    private static void consider(UsbDevice d) throws IOException {
        if (linked()) return;
        boolean acc = aoa(d);
        if (!acc && !mayBePhone(d)) return;
        UsbManager um = (UsbManager) app.getSystemService(Context.USB_SERVICE);
        if (um == null) return;
        if (!um.hasPermission(d)) {
            boolean ask;
            synchronized (asked) { ask = asked.add(d.getDeviceName()); }
            if (ask) um.requestPermission(d, permIntent());
            return;
        }
        // (one try at a time: tries at once take the cable from each other, and one can read the other phone's greeting
        // that the one left needs)
        if (!begin()) return;
        try { if (acc) openDevice(um, d); else switchOver(um, d); }
        finally { done(); }
    }

    private static boolean begin() { synchronized (UsbPeer.class) { if (opening || linked()) return false; opening = true; return true; } }
    private static void done() { synchronized (UsbPeer.class) { opening = false; } }

    // Android Open Accessory: is it an Android phone that takes accessories (51)? Then who this side is (52) and start (53).
    private static void switchOver(UsbManager um, UsbDevice d) throws IOException {
        UsbDeviceConnection c = um.openDevice(d);
        if (c == null) return;
        try {
            byte[] v = new byte[2];
            int n = c.controlTransfer(UsbConstants.USB_DIR_IN | UsbConstants.USB_TYPE_VENDOR, 51, 0, 0, v, 2, 1000);
            int proto = n == 2 ? (v[0] & 0xff) | ((v[1] & 0xff) << 8) : 0;
            if (proto < 1) return;                               // not a phone that takes accessories
            String[] ids = {MANUFACTURER, MODEL, "Flick on another phone", "1", "https://github.com/Maniw1234/flick", "flick"};
            for (int k = 0; k < ids.length; k++) {
                byte[] b = (ids[k] + "\0").getBytes("UTF-8");
                if (c.controlTransfer(UsbConstants.USB_DIR_OUT | UsbConstants.USB_TYPE_VENDOR, 52, 0, k, b, b.length, 1000) < 0) return;
            }
            c.controlTransfer(UsbConstants.USB_DIR_OUT | UsbConstants.USB_TYPE_VENDOR, 53, 0, 0, null, 0, 1000);
            Bg.log("usb: asked the phone on the cable to switch over");
            // it comes back as an accessory in a moment (USB_DEVICE_ATTACHED): opened then
        } finally { c.close(); }
    }

    // the other phone as an accessory: its bulk pipes carry the tunnel
    private static void openDevice(UsbManager um, UsbDevice d) throws IOException {
        final UsbDeviceConnection c = um.openDevice(d);
        if (c == null) return;
        final UsbInterface intf = d.getInterface(0);
        if (!c.claimInterface(intf, true)) { c.close(); return; }
        UsbEndpoint in = null, out = null;
        for (int k = 0; k < intf.getEndpointCount(); k++) {
            UsbEndpoint e = intf.getEndpoint(k);
            if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
            if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e; else out = e;
        }
        if (in == null || out == null) { c.releaseInterface(intf); c.close(); return; }
        final java.util.concurrent.atomic.AtomicBoolean shut = new java.util.concurrent.atomic.AtomicBoolean();
        Closeable link = new Closeable() { @Override public void close() { shut.set(true); try { c.releaseInterface(intf); } catch (Throwable e) { /* gone */ } c.close(); } };
        linkedDevice = d.getDeviceName();
        try { follow(Peers.get(app).tunnel(new HostIn(c, in, shut), new HostOut(c, out), link, "usb", true)); }
        catch (IOException e) { link.close(); throw e; }
        catch (RuntimeException e) { link.close(); throw e; }
    }

    // The link over the cable now; once it ends with the cable still in (Flick on the other phone closed and opened
    // again), it's made again: tried every few seconds for a minute and a half (the other phone's Flick can take that
    // long to come back, and its end of the cable can be busy for a moment). A few times per plug-in.
    private static void follow(final Tunnel t) {
        tunnel = t;
        Thread w = new Thread(new Runnable() {
            @Override public void run() {
                try { while (!t.isClosed()) Thread.sleep(1000); } catch (InterruptedException e) { return; }
                int n;
                synchronized (UsbPeer.class) { if (tunnel != t) return; tunnel = null; n = ++tries; }
                if (n > 5) return;
                long until = android.os.SystemClock.uptimeMillis() + 90000;
                try {
                    Thread.sleep(2000);
                    while (!unplugged && !linked() && android.os.SystemClock.uptimeMillis() < until) {
                        Bg.log("usb: linking again");
                        scan();
                        Thread.sleep(3000);
                    }
                } catch (InterruptedException e) { /* done */ }
            }
        }, "flick-usb-follow");
        w.setDaemon(true);
        w.start();
    }

    // this phone was switched over: the accessory's file carries the tunnel
    private static void openAccessory(UsbAccessory a) throws IOException {
        if (linked()) return;
        UsbManager um = (UsbManager) app.getSystemService(Context.USB_SERVICE);
        if (um == null) return;
        if (!um.hasPermission(a)) {
            boolean ask;
            synchronized (asked) { ask = asked.add("accessory"); }
            if (ask) um.requestPermission(a, permIntent());
            return;
        }
        if (!begin()) return;
        try {
            final ParcelFileDescriptor pfd = um.openAccessory(a);
            if (pfd == null) return;
            // (the accessory is read 16 KB at a time: a smaller read can lose what a full USB packet brought)
            InputStream in = new BufferedInputStream(new FileInputStream(pfd.getFileDescriptor()), CHUNK);
            OutputStream out = new Packets(new FileOutputStream(pfd.getFileDescriptor()));
            linkedDevice = null;
            try { follow(Peers.get(app).tunnel(in, out, pfd, "usb", false)); }
            catch (IOException e) { pfd.close(); throw e; }
        } finally { done(); }
    }

    /**
     * The host's end of the pipe in: one read of 16 KB always waiting (a UsbRequest), looked at every second (so a closed
     * link's reader ends). A second with nothing loses nothing: the read stays queued (a read that timed out instead
     * would lose what part of it came).
     */
    static final class HostIn extends InputStream {
        private final UsbDeviceConnection c;
        private final java.util.concurrent.atomic.AtomicBoolean shut;
        private final UsbRequest rq = new UsbRequest();
        // (direct: a buffer that isn't would be copied into a new direct one for every read)
        private final ByteBuffer bb = ByteBuffer.allocateDirect(CHUNK);
        private final byte[] buf = new byte[CHUNK];
        private boolean queued;
        private int pos, len, errs;
        HostIn(UsbDeviceConnection c, UsbEndpoint ep, java.util.concurrent.atomic.AtomicBoolean shut) throws IOException {
            this.c = c; this.shut = shut;
            if (!rq.initialize(c, ep)) throw new IOException("usb: can't read");
        }
        private boolean fill() throws IOException {
            if (pos < len) return true;
            while (true) {
                if (shut.get()) { end(); throw new IOException("usb: closed"); }
                if (!queued) {
                    bb.clear();
                    if (!rq.queue(bb)) { if (++errs > 3) { end(); throw new IOException("usb: unplugged"); } pause(); continue; }
                    queued = true;
                }
                UsbRequest r;
                try { r = c.requestWait(1000); }
                catch (TimeoutException e) { errs = 0; continue; }          // a quiet second: not an error
                catch (RuntimeException e) { r = null; }
                if (r == null) {
                    // an error: the cable's gone (a few in a row), or a moment's trouble (the read is made again)
                    queued = false;
                    try { rq.cancel(); } catch (Throwable x) { /* gone */ }
                    if (++errs > 3) { end(); throw new IOException("usb: unplugged"); }
                    pause();
                    continue;
                }
                if (r != rq) continue;                                    // (none other is queued on it)
                queued = false;
                errs = 0;
                pos = 0; len = bb.position();
                if (len > 0) { bb.flip(); bb.get(buf, 0, len); }
                return len > 0;
            }
        }
        private void end() { try { rq.cancel(); } catch (Throwable e) { /* gone */ } try { rq.close(); } catch (Throwable e) { /* gone */ } }
        private static void pause() { try { Thread.sleep(50); } catch (InterruptedException e) { /* on */ } }
        @Override public int read() throws IOException { while (!fill()) { /* an empty packet */ } return buf[pos++] & 0xff; }
        @Override public int read(byte[] b, int off, int n) throws IOException {
            if (n == 0) return 0;
            while (!fill()) { /* an empty packet */ }
            int k = Math.min(n, len - pos);
            System.arraycopy(buf, pos, b, off, k);
            pos += k;
            return k;
        }
    }

    /**
     * The host's end of the pipe out: 16 KB at a time, each write ending on a short packet (see Packets). The other phone
     * busy for a while (its side of the link holding back for a slow connection) isn't the cable pulled: a write it
     * doesn't take for STUCK_MS ends the link as stuck; one that fails at once is the cable gone.
     */
    static final class HostOut extends OutputStream {
        private final UsbDeviceConnection c; private final UsbEndpoint ep;
        HostOut(UsbDeviceConnection c, UsbEndpoint ep) { this.c = c; this.ep = ep; }
        @Override public void write(int b) throws IOException { write(new byte[]{(byte) b}, 0, 1); }
        @Override public void write(byte[] b, int off, int n) throws IOException {
            for (int[] p : Packets.pieces(n, ep.getMaxPacketSize() > 0 ? ep.getMaxPacketSize() : PACKET)) {
                int done = 0;
                while (done < p[1]) {
                    long t0 = android.os.SystemClock.uptimeMillis();
                    int k = c.bulkTransfer(ep, b, off + p[0] + done, p[1] - done, STUCK_MS);
                    if (k < 0) throw new IOException(android.os.SystemClock.uptimeMillis() - t0 >= STUCK_MS - 1000 ? "usb: stuck" : "usb: unplugged");
                    done += k;
                }
            }
        }
    }

    /**
     * Writes that end on a short USB packet: the other side reads a transfer until it's full or a packet comes in
     * shorter than the pipe's packet size, so a write whose last piece is a whole number of packets would sit there
     * until more came. Such a piece goes as two (all but its last byte, then that byte).
     */
    static final class Packets extends OutputStream {
        private final OutputStream out;
        Packets(OutputStream out) { this.out = out; }
        @Override public void write(int b) throws IOException { out.write(b); }
        @Override public void write(byte[] b, int off, int n) throws IOException { for (int[] p : pieces(n, PACKET)) out.write(b, off + p[0], p[1]); }
        @Override public void flush() throws IOException { out.flush(); }
        @Override public void close() throws IOException { out.close(); }
        /** [offset, length] pieces of at most 16 KB, none but a full 16 KB one a whole number of packets long. */
        static java.util.List<int[]> pieces(int n, int packet) {
            java.util.List<int[]> out = new java.util.ArrayList<int[]>();
            int at = 0;
            while (at < n) {
                int k = Math.min(CHUNK, n - at);
                if (k < CHUNK && k % packet == 0) {
                    if (k > 1) out.add(new int[]{at, k - 1});
                    out.add(new int[]{at + k - 1, 1});
                } else out.add(new int[]{at, k});
                at += k;
            }
            return out;
        }
    }
}
