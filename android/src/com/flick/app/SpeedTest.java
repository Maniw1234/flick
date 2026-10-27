package com.flick.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Settings › Speed test: how fast bytes go to the PC and back right now, over several connections at once like real
 * sends (the PC's /api/speed counts and drops what it gets, and sends bytes back), plus what the phone's Wi-Fi says
 * about the link (band, link rate), which explains most slow results.
 */
final class SpeedTest {
    static final int STREAMS = 4;
    static final long MS = 3000;

    private SpeedTest() {}

    /** {up, down} in bytes per second over l. Pure Java. */
    static long[] measure(final Wire.Link l, final String auth, int streams, final long ms) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(streams);
        // a PC that vanishes mid-test would leave a write blocked for good (writes have no timeout): cut it a little
        // after the test should have ended
        final java.util.concurrent.ScheduledExecutorService cutter = Executors.newSingleThreadScheduledExecutor();
        try {
            // up: each connection writes for ms, then says how much the PC counted
            final AtomicLong upBytes = new AtomicLong();
            List<Future<?>> fs = new ArrayList<Future<?>>();
            final long t0 = System.nanoTime();
            for (int i = 0; i < streams; i++) {
                fs.add(pool.submit(new Callable<Void>() {
                    @Override
                    public Void call() throws Exception {
                        final Wire.Call c = Wire.Call.open(l, "POST", "/api/speed?" + auth, Wire.CHUNKED, "application/octet-stream", 15000);
                        java.util.concurrent.ScheduledFuture<?> cut = cutter.schedule(new Runnable() {
                            @Override public void run() { c.close(); }
                        }, ms + 8000, java.util.concurrent.TimeUnit.MILLISECONDS);
                        try {
                            OutputStream out = c.body();
                            byte[] buf = new byte[256 * 1024];
                            long end = System.nanoTime() + ms * 1000000L;
                            while (System.nanoTime() < end) out.write(buf);
                            Wire.Answer a = c.answer(4096);
                            if (a.code != 200) throw new java.io.IOException("http " + a.code);
                            upBytes.addAndGet(a.json().optLong("bytes", 0));
                        } finally { cut.cancel(false); c.close(); }
                        return null;
                    }
                }));
            }
            for (Future<?> f : fs) f.get();
            double upSecs = (System.nanoTime() - t0) / 1e9;
            // down: each connection reads for ms
            final AtomicLong downBytes = new AtomicLong();
            fs.clear();
            final long t1 = System.nanoTime();
            for (int i = 0; i < streams; i++) {
                fs.add(pool.submit(new Callable<Void>() {
                    @Override
                    public Void call() throws Exception {
                        Wire.Call c = Wire.Call.open(l, "GET", "/api/speed?" + auth + "&bytes=" + (4L << 30), Wire.NO_BODY, null, 15000);
                        try {
                            int[] code = new int[1];
                            long[] len = new long[1];
                            InputStream in = c.respond(code, len);
                            if (code[0] != 200) throw new java.io.IOException("http " + code[0]);
                            byte[] buf = new byte[256 * 1024];
                            long end = System.nanoTime() + ms * 1000000L;
                            int r;
                            while (System.nanoTime() < end && (r = in.read(buf)) > 0) downBytes.addAndGet(r);
                        } finally { c.close(); }
                        return null;
                    }
                }));
            }
            for (Future<?> f : fs) f.get();
            double downSecs = (System.nanoTime() - t1) / 1e9;
            return new long[]{(long) (upBytes.get() / upSecs), (long) (downBytes.get() / downSecs)};
        } finally {
            pool.shutdownNow();
            cutter.shutdownNow();
        }
    }

    /** The test against the PC pcId at host:port over via, as JSON for the page. */
    static String run(Context c, String pcId, String host, int port, String via) {
        JSONObject r = new JSONObject();
        try {
            SharedPreferences p = c.getSharedPreferences("flick", 0);
            String token = p.getString("p:token:" + pcId, ""), pin = p.getString("p:pin:" + pcId, "");
            String device = Bg.deviceId(c);
            wifi(c, r);
            if (token.length() == 0 || device == null) { r.put("ok", false); r.put("why", "unpaired"); return r.toString(); }
            Wire.Link l = "bluetooth".equals(via) ? new Wire.Link("127.0.0.1", port, null) : new Wire.Link(host, port, pin);
            if (!"bluetooth".equals(via) && pin.length() == 0) { r.put("ok", false); r.put("why", "unpaired"); return r.toString(); }
            Transfers.hold(c, true);                     // Wi-Fi at full speed while it measures
            long[] s;
            try { s = measure(l, "device=" + Wire.enc(device) + "&token=" + Wire.enc(token), STREAMS, MS); }
            finally { Transfers.hold(c, false); }
            r.put("ok", true);
            r.put("up", s[0]);
            r.put("down", s[1]);
            r.put("via", via == null ? "wifi" : via);
        } catch (Throwable e) {
            try { r.put("ok", false); r.put("why", "unreachable"); } catch (Throwable x) { /* ignore */ }
        }
        return r.toString();
    }

    /** What the phone's Wi-Fi link is: its band (MHz) and link rate (Mbit/s). */
    @SuppressWarnings("deprecation")
    static void wifi(Context c, JSONObject r) {
        try {
            WifiManager wm = (WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo w = wm == null ? null : wm.getConnectionInfo();
            if (w == null || w.getNetworkId() == -1 && w.getLinkSpeed() <= 0) return;
            JSONObject o = new JSONObject();
            o.put("mhz", w.getFrequency());
            o.put("mbps", w.getLinkSpeed());
            if (Build.VERSION.SDK_INT >= 29) o.put("tx", Api29.tx(w));
            o.put("band", band(w.getFrequency()));
            r.put("wifi", o);
        } catch (Throwable e) { /* no Wi-Fi info */ }
    }

    static String band(int mhz) {
        if (mhz >= 5925) return "6 GHz";
        if (mhz >= 4900) return "5 GHz";
        if (mhz >= 2400 && mhz < 2500) return "2.4 GHz";
        return mhz > 0 ? String.format(Locale.US, "%d MHz", mhz) : "";
    }

    @android.annotation.TargetApi(29)
    static final class Api29 {
        static int tx(WifiInfo w) { return w.getTxLinkSpeedMbps(); }
    }
}
