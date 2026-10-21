package com.flick.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;

/** Methods the web UI calls as window.FlickNative.* (run on the JavaBridge thread). */
final class Bridge {
    private final MainActivity a;
    private final SharedPreferences prefs;

    Bridge(MainActivity a) {
        this.a = a;
        this.prefs = a.getSharedPreferences("flick", 0);
    }

    @JavascriptInterface
    public String info() {
        a.pageReady();
        try {
            JSONObject o = new JSONObject();
            o.put("device", a.deviceId());
            o.put("name", a.deviceName());
            o.put("top", a.insetTop);
            o.put("bottom", a.insetBottom);
            o.put("corner", a.cornerRadius);
            o.put("version", Updater.installedName(a));
            o.put("code", Updater.installedCode(a));
            o.put("sdk", Build.VERSION.SDK_INT);
            return o.toString();
        } catch (Throwable e) { return "{}"; }
    }

    // ---------------- wireless updates from the PC ----------------
    @JavascriptInterface
    public String updateState() {
        try {
            Updater u = a.updater();
            JSONObject o = new JSONObject();
            o.put("canInstall", u.canInstall());
            o.put("ready", u.readyCode());
            o.put("readySha", u.readySha());
            o.put("busy", u.busy());
            return o.toString();
        } catch (Throwable e) { return "{}"; }
    }

    @JavascriptInterface
    public void updateDownload(String url, String code, String size, String sha256) {
        try { a.updater().download(url, Long.parseLong(code), Long.parseLong(size), sha256); }
        catch (Throwable e) { a.updater().fail("bad request"); }
    }

    /** Asks GitHub for the latest Flick release; answers with a "gh" event carrying GitHub's JSON (the page picks the APK). */
    @JavascriptInterface
    public void updateCheckGitHub() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSONObject o = new JSONObject();
                try {
                    o.put("t", "gh");
                    try {
                        o.put("body", UpdateFetch.getText(GITHUB_LATEST, 2 * 1024 * 1024));
                        o.put("ok", true);
                    } catch (Throwable e) {
                        o.put("ok", false);
                        o.put("why", String.valueOf(e.getMessage()));
                    }
                } catch (Throwable e) { return; }
                a.emit(o.toString());
            }
        }, "flick-github-check").start();
    }

    static final String GITHUB_LATEST = "https://api.github.com/repos/Maniw1234/flick/releases/latest";

    // ---------------- Bluetooth (when there's no network) ----------------
    @JavascriptInterface public void btPermission() { a.runOnUiThread(new Runnable() { @Override public void run() { a.askBluetooth(); } }); }
    @JavascriptInterface public boolean btPermitted() { return BtLink.permitted(a); }
    @JavascriptInterface public void btWant(boolean on) { a.btLink().setWanted(on); }

    @JavascriptInterface
    public void updateInstall() {
        a.runOnUiThread(new Runnable() { @Override public void run() { a.updater().install(a); } });
    }

    @JavascriptInterface public String getPref(String k) { return prefs.getString("p:" + k, ""); }
    @JavascriptInterface public void setPref(String k, String v) { prefs.edit().putString("p:" + k, v == null ? "" : v).apply(); }

    @JavascriptInterface public void discover(boolean on) { a.discovery().setActive(on); }

    // ---------------- phone storage (file manager) ----------------
    @JavascriptInterface
    public String storage() {
        try {
            JSONObject o = new JSONObject();
            o.put("granted", Files.granted(a));
            o.put("root", Files.root().getPath());
            o.put("downloads", new File(Files.root(), "Download").getPath());
            o.put("sdk", Build.VERSION.SDK_INT);
            return o.toString();
        } catch (Throwable e) { return "{}"; }
    }

    @JavascriptInterface
    public void askStorage() {
        a.runOnUiThread(new Runnable() { @Override public void run() { a.askStorage(); } });
    }

    // ---------------- encrypted links to the PC (see TlsProxy) ----------------
    // its own threads: opening a link mustn't wait behind a slow folder listing on io()
    private static final ExecutorService LINKS = Transfers.pool("flick-link", 2);

    /**
     * A local port that leads to the PC over TLS. Answers as an event: {ok, port, fp} or {ok:false, why} with why
     * "pin" (the PC's certificate isn't the pinned one; fp = the one seen), "tls" or "unreachable".
     */
    @JavascriptInterface
    public void tlsOpen(final String req, final String host, final int port, final String pin) {
        LINKS.execute(new Runnable() {
            @Override
            public void run() {
                JSONObject r = new JSONObject();
                try {
                    try {
                        TlsProxy p = TlsProxy.open(host, port, pin);
                        r.put("ok", true);
                        r.put("port", p.localPort());
                        r.put("fp", p.fp);
                    } catch (TlsProxy.PinMismatch e) {
                        r.put("ok", false); r.put("why", "pin"); r.put("fp", e.seen == null ? "" : e.seen);
                    } catch (javax.net.ssl.SSLException e) {
                        r.put("ok", false); r.put("why", "tls");
                    } catch (Throwable e) {
                        r.put("ok", false); r.put("why", "unreachable");
                    }
                } catch (Throwable e) { /* JSON can't fail here */ }
                a.result(req, r.toString());
            }
        });
    }

    @JavascriptInterface public void tlsClose(int port) { TlsProxy.close(port); }

    /**
     * Sign-in proof for the PC pcId: HMAC-SHA256 with the token this phone holds for it, over both random numbers
     * and the link's identity (the certificate fingerprint, or "bluetooth"). role "pc" checks the PC's proof,
     * "phone" makes this phone's. "" when there's no token.
     */
    @JavascriptInterface
    public String authProof(String pcId, String role, String nonceP, String nonceS, String chan) {
        if (!"pc".equals(role) && !"phone".equals(role)) return "";
        String token = prefs.getString("p:token:" + pcId, "");
        if (token == null || token.length() == 0) return "";
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(token.getBytes("UTF-8"), "HmacSHA256"));
            String msg = "flick-auth-v1|" + role + "|" + nonceP + "|" + nonceS + "|" + chan + "|" + a.deviceId() + "|" + pcId;
            return hex(mac.doFinal(msg.getBytes("UTF-8")));
        } catch (Throwable e) { return ""; }
    }

    /** The pairing code both screens show (see the PC's server.js, pairCode). */
    @JavascriptInterface
    public String pairCode(String chan, String nonceP, String nonceS) {
        String h = sha256("flick-pair-v1|" + chan + "|" + nonceP + "|" + nonceS);
        if (h.length() < 8) return "";
        long n = Long.parseLong(h.substring(0, 8), 16) % 1000000L;
        return String.format(java.util.Locale.US, "%06d", n);
    }

    @JavascriptInterface
    public String sha256(String s) {
        try { return hex(java.security.MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8"))); }
        catch (Throwable e) { return ""; }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    @JavascriptInterface
    public void listDirAsync(final String req, final String path) {
        a.io().execute(new Runnable() { @Override public void run() { a.result(req, Files.listDir(a, path)); } });
    }

    @JavascriptInterface
    public void queryAsync(final String req, final String cat, final int offset, final int limit) {
        a.io().execute(new Runnable() { @Override public void run() { a.result(req, Files.query(a, cat, Math.max(0, offset), Math.max(1, Math.min(600, limit)))); } });
    }

    @JavascriptInterface
    public String thumbPath(String path, String mtime, String mid, String mt) {
        return Thumbs.base64(a, path, Thumbs.parse(mtime), Thumbs.parse(mid), (int) Thumbs.parse(mt));
    }

    @JavascriptInterface public void uploadPath(String tid, String path, String url) { a.transfers().uploadPath(tid, path, url); }

    @JavascriptInterface
    public boolean openPath(final String path) {
        final File f = new File(path);
        if (!Files.allowed(f) || !f.isFile()) return false;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(FilesProvider.uriForPath(path), Files.mimeOf(f.getName()));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { a.startActivity(i); }
                catch (ActivityNotFoundException e) { a.toast("No app on this phone can open " + f.getName()); }
                catch (Throwable e) { a.toast("Couldn't open " + f.getName()); }
            }
        });
        return true;
    }

    @JavascriptInterface
    public void sharePath(final String path) {
        final File f = new File(path);
        if (!Files.allowed(f) || !f.isFile()) return;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Uri u = FilesProvider.uriForPath(path);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(Files.mimeOf(f.getName()));
                i.putExtra(Intent.EXTRA_STREAM, u);
                i.setClipData(ClipData.newRawUri(f.getName(), u));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent ch = Intent.createChooser(i, f.getName());
                ch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { a.startActivity(ch); } catch (Throwable e) { a.toast("Couldn't share " + f.getName()); }
            }
        });
    }
    @JavascriptInterface public String library() { return Library.get(a).listJson(); }
    @JavascriptInterface public String thumb(String id) { return Library.get(a).thumbBase64(id); }
    @JavascriptInterface public void remove(String id) { Library.get(a).remove(id); }

    /** Removes several shelf items at once (a JSON array of ids), writing the list once. Returns how many went. */
    @JavascriptInterface
    public int removeMany(String idsJson) {
        try {
            JSONArray arr = new JSONArray(idsJson);
            ArrayList<String> ids = new ArrayList<String>();
            for (int i = 0; i < arr.length(); i++) ids.add(arr.optString(i));
            return Library.get(a).removeAll(ids);
        } catch (Throwable e) { return 0; }
    }

    @JavascriptInterface
    public void pick(final String kind) {
        a.runOnUiThread(new Runnable() { @Override public void run() { a.launchPicker(kind); } });
    }

    @JavascriptInterface public void upload(String tid, String id, String url) { a.transfers().upload(tid, id, url); }
    @JavascriptInterface public void uploadBundle(String tid, String items, String url) { a.transfers().uploadBundle(tid, items, url); }
    @JavascriptInterface public void abort(String tid) { a.transfers().abort(tid); }
    @JavascriptInterface public void download(String fid, String url, String name, String size, String mime) { a.transfers().download(fid, url, name, size, mime); }

    @JavascriptInterface
    public void haptic(final String kind) {
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                int c;
                if ("tick".equals(kind)) c = HapticFeedbackConstants.CLOCK_TICK;
                else if ("lift".equals(kind)) c = HapticFeedbackConstants.LONG_PRESS;
                else if ("confirm".equals(kind)) c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.LONG_PRESS;
                else if ("reject".equals(kind)) c = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                else c = HapticFeedbackConstants.KEYBOARD_TAP;
                if (a.web != null) a.web.performHapticFeedback(c);
            }
        });
    }

    @JavascriptInterface
    public void keepAwake(final boolean on) {
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    @JavascriptInterface
    public boolean open(String id) {
        final JSONObject o = Library.get(a).find(id);
        if (o == null) return false;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Uri u = FilesProvider.uriFor(o.optString("id"), o.optString("name"));
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(u, o.optString("mime", "application/octet-stream"));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { a.startActivity(i); }
                catch (ActivityNotFoundException e) { a.toast("No app on this phone can open " + o.optString("name")); }
                catch (Throwable e) { a.toast("Couldn't open " + o.optString("name")); }
            }
        });
        return true;
    }

    @JavascriptInterface
    public void share(String id) {
        final JSONObject o = Library.get(a).find(id);
        if (o == null) return;
        a.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Uri u = FilesProvider.uriFor(o.optString("id"), o.optString("name"));
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(o.optString("mime", "application/octet-stream"));
                i.putExtra(Intent.EXTRA_STREAM, u);
                i.setClipData(ClipData.newRawUri(o.optString("name"), u));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent ch = Intent.createChooser(i, o.optString("name"));
                ch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { a.startActivity(ch); } catch (Throwable e) { a.toast("Couldn't share " + o.optString("name")); }
            }
        });
    }

    // one copy at a time, off the page's bridge thread (a big video takes a while)
    private static final ExecutorService SAVER = Transfers.pool("flick-save", 1);

    /**
     * Copies a shelf item into the phone's Pictures / Movies / Music / Download folder (…/Flick). Returns at once; the
     * result arrives as an event: {"t":"saved","id":id,"ok":true,"where":"Pictures/Flick"} or
     * {"t":"saved","id":id,"ok":false,"why":"…"} ("unsupported" before Android 10, "missing" when the item is gone).
     */
    @JavascriptInterface
    public void saveCopy(final String id) {
        SAVER.execute(new Runnable() {
            @Override
            public void run() {
                JSONObject ev = new JSONObject();
                try {
                    ev.put("t", "saved");
                    ev.put("id", id);
                    try {
                        if (Build.VERSION.SDK_INT < 29) throw new java.io.IOException("unsupported");
                        JSONObject o = Library.get(a).find(id);
                        if (o == null) throw new java.io.IOException("missing");
                        File f = Library.get(a).fileOf(o);
                        ev.put("where", Transfers.PublicSave.save(a, f, o.optString("name"), o.optString("mime")));
                        ev.put("ok", true);
                    } catch (Throwable e) {
                        ev.put("ok", false);
                        ev.put("why", String.valueOf(e.getMessage()));
                    }
                } catch (Throwable e) { return; }
                a.emit(ev.toString());
            }
        });
    }
}
