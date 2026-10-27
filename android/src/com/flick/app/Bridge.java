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

    /** sums + sig: the SHA256SUMS and SHA256SUMS.sig of the Flick release the update comes from (refused without). */
    @JavascriptInterface
    public void updateDownload(String url, String code, String size, String sha256, String sums, String sig) {
        try { a.updater().download(url, Long.parseLong(code), Long.parseLong(size), sha256, sums, sig); }
        catch (Throwable e) { a.updater().fail("bad request"); }
    }

    /**
     * Asks GitHub for the latest Flick release; answers with a "gh" event carrying GitHub's JSON (the page picks the
     * APK) and, when the release has them, its SHA256SUMS and SHA256SUMS.sig ("sums", "sig").
     */
    @JavascriptInterface
    public void updateCheckGitHub() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSONObject o = new JSONObject();
                try {
                    o.put("t", "gh");
                    try {
                        String body = UpdateFetch.getText(GITHUB_LATEST, 2 * 1024 * 1024);
                        o.put("body", body);
                        String[] signed = UpdateFetch.releaseSums(body, GITHUB_DL);
                        if (signed != null) { o.put("sums", signed[0]); o.put("sig", signed[1]); }
                        o.put("ok", true);
                    } catch (Throwable e) {
                        o.remove("body");
                        o.put("ok", false);
                        o.put("why", String.valueOf(e.getMessage()));
                    }
                } catch (Throwable e) { return; }
                a.emit(o.toString());
            }
        }, "flick-github-check").start();
    }

    static final String GITHUB_LATEST = "https://api.github.com/repos/Maniw1234/flick/releases/latest";
    static final String GITHUB_DL = "https://github.com/Maniw1234/flick/releases/download/";

    // ---------------- the camera, for Air grab ----------------
    @JavascriptInterface public String cameraState() { return a.cameraState(); }
    @JavascriptInterface public void askCamera() { a.runOnUiThread(new Runnable() { @Override public void run() { a.askCamera(); } }); }

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
    /** ips (a JSON array): where paired PCs were seen before; discovery asks there directly too. */
    @JavascriptInterface
    public void discoverKnown(String ips) {
        try {
            JSONArray arr = new JSONArray(ips);
            ArrayList<String> out = new ArrayList<String>();
            for (int i = 0; i < arr.length() && out.size() < 24; i++) {
                String ip = arr.optString(i, "");
                if (ip.matches("\\d{1,3}(\\.\\d{1,3}){3}")) out.add(ip);
            }
            a.discovery().setKnown(out.toArray(new String[0]));
        } catch (Throwable e) { /* ignore */ }
    }

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

    /** queryAsync in another order (sort, see Files.query), only files whose name has the words of q ("" for all). */
    @JavascriptInterface
    public void querySorted(final String req, final String cat, final int offset, final int limit, final String sort, final String q) {
        a.io().execute(new Runnable() {
            @Override
            public void run() {
                String words = q == null ? "" : q.length() > 100 ? q.substring(0, 100) : q;
                a.result(req, Files.query(a, cat, Math.max(0, offset), Math.max(1, Math.min(600, limit)), sort, words));
            }
        });
    }

    /**
     * Where the page can load a whole file from (the preview shows photos and plays videos from it): a file:// URL for a
     * file in shared storage (path) or in the Flick list (id), "" for anything else.
     */
    @JavascriptInterface
    public String mediaUrl(String path, String id) {
        try {
            File f = null;
            if (path != null && path.length() > 0) { File p = new File(path); if (Files.allowed(p)) f = p; }
            else if (id != null && id.length() > 0) f = Library.get(a).file(id);
            return f != null && f.isFile() ? Uri.fromFile(f).toString() : "";
        } catch (Throwable e) { return ""; }
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

    // ---------------- sends that survive Flick closing and carry on (protocol 7 PCs, see Sends/Outbox) ----------------
    /** spec: {pc:{id,name,ip,port,via}, items:[{path|id,name,dir}], committed, skipDup, parallel}; "ok" or why not. */
    @JavascriptInterface public String sendStart(String tid, String spec) { return Sends.get(a).start(tid, spec); }
    @JavascriptInterface public void sendCommit(String tid) { Sends.get(a).box.commit(tid); }
    @JavascriptInterface public void sendPause(String tid) { Sends.get(a).box.pause(tid); }
    @JavascriptInterface public void sendResume(String tid) { Sends.get(a).box.resume(tid); }
    @JavascriptInterface public void sendCancel(String tid) { Sends.get(a).box.cancel(tid); }
    @JavascriptInterface public void sendRetry(String tid) { Sends.get(a).box.retry(tid); }
    @JavascriptInterface public void sendForget(String tid) { Sends.get(a).box.forget(tid); }
    /** The PC turned a send down ("Ask each time": why declined | timeout). */
    @JavascriptInterface public void sendRefused(String tid, String why) { Sends.get(a).box.refused(tid, why); }
    @JavascriptInterface public String sendList() { return Sends.get(a).list(); }
    /** The page reached pcId at host:port over via: sends waiting for it go there. */
    @JavascriptInterface public void sendRelink(String pcId, String host, int port, String via) { Sends.get(a).relink(pcId, host, port, via); }

    /** Settings › Speed test: answers as a "res" event {ok, up, down (bytes/s), wifi:{mhz, mbps}} or {ok:false, why}. */
    @JavascriptInterface
    public void speedTest(final String req, final String pcId, final String host, final int port, final String via) {
        LINKS.execute(new Runnable() {
            @Override public void run() { a.result(req, SpeedTest.run(a.getApplicationContext(), pcId, host, port, via)); }
        });
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

    // ======================================================================== protocol 5: features
    // Each returns at once; long work runs on a background thread and answers with an event.

    /** The clipboard (Android lets Flick read it only while it is in front with focus): see Clip.read. */
    @JavascriptInterface
    public String clipRead() {
        waitForFocus();
        return Clip.read(a, false).toString();
    }

    /** The PC's clipboard ({kind:text,text} / {kind:image,png}) onto the phone's, if "Clipboard from your PC" is on. */
    @JavascriptInterface
    public void clipWrite(final String json) {
        Bg.run("clipWrite", new Runnable() {
            @Override
            public void run() {
                try {
                    if (!Features.clipFromPc(a)) return;
                    JSONObject m = new JSONObject(json);
                    if (Clip.write(a, m, prefs.getString("p:lastPcName", "")) != null) ClipHistory.add(a, "in", m, prefs.getString("p:lastPc", ""), prefs.getString("p:lastPcName", ""));
                } catch (Throwable e) { Bg.warn("clipWrite", e); }
            }
        });
    }

    /** Opens an http(s) address in the browser (anything else is ignored). */
    @JavascriptInterface
    public void openUrl(final String url) {
        if (!Links.ok(url)) return;
        // Android doesn't let an app in the background start the browser: then it's the "Link from <PC>" notification
        if (!Page.inFront()) { FromPc.notifyLink(a, url, prefs.getString("p:lastPcName", "")); return; }
        a.runOnUiThread(new Runnable() { @Override public void run() { FromPc.open(a, url); } });
    }

    @JavascriptInterface
    public void ring(boolean on, int sec) {
        if (on) Ringer.start(a, sec); else Ringer.stop(a, "user");
    }

    /** {"bg","notifyAccess","notifyPerm","autoSend","clipFromPc","notify","sdk"}. */
    @JavascriptInterface
    public String features() {
        String j = Features.json(a);
        Page.featuresSeen(j);
        return j;
    }

    /** Saved at once (features() right after shows it); what it starts (a service, a job, a screen) follows. */
    @JavascriptInterface
    public void setFeature(String name, String value) {
        try { Features.set(a, name, value); } catch (Throwable e) { Bg.warn("setFeature", e); }
    }

    // ---------------- Lock Flick (AppLock) ----------------
    /** {"on", "secure": the phone has a screen lock to unlock Flick with, "sdk"}. */
    @JavascriptInterface
    public String lockState() {
        AppLock l = a.lock();
        return l == null ? "{}" : l.state();
    }

    /** On asks for the phone's lock once first; the answer is a "lock-state" event ({on, why}). */
    @JavascriptInterface
    public void setLock(final boolean on) {
        a.runOnUiThread(new Runnable() { @Override public void run() { if (a.lock() != null) a.lock().set(on); } });
    }

    /** Android's security settings, to set a screen lock up. */
    @JavascriptInterface
    public void lockSetup() {
        a.runOnUiThread(new Runnable() { @Override public void run() { if (a.lock() != null) a.lock().openSettings(); } });
    }

    @JavascriptInterface public String history() { return Bg.history(a).json(); }

    @JavascriptInterface
    public void historyAdd(String json) {
        if (Bg.history(a).addJson(json) > 0) Page.historyChanged();
    }

    /** Removes one entry ("Remove from history"). */
    @JavascriptInterface
    public void historyRemove(String id) {
        if (Bg.history(a).remove(id)) Page.historyChanged();
    }

    @JavascriptInterface
    public void historyClear() {
        Bg.history(a).clear();
        Page.historyChanged();
    }

    @JavascriptInterface public String syncPairs() { return SyncManager.listJson(a); }
    @JavascriptInterface public void syncAdd(String phoneFolderPath) { SyncManager.add(a, phoneFolderPath); }
    @JavascriptInterface public void syncRemove(String id) { SyncManager.remove(a, id); }
    @JavascriptInterface public void syncNow() { SyncManager.syncAll(a, true); }

    /**
     * Browse phone: a request from the PC that came over the page's link (the PC with id pcId). Browse answers that PC
     * itself, over its pinned link, and only while "Let your PC browse this phone" is on.
     */
    @JavascriptInterface
    public void browse(String json, String pcId) {
        try { Browse.handle(a, new JSONObject(json), pcId); } catch (Throwable e) { Bg.warn("browse", e); }
    }

    // ---------------- clipboard history (ClipHistory) ----------------
    @JavascriptInterface public String clipHistory() { return ClipHistory.listJson(a); }

    /** The page sent a clipboard to the PC over its link ({kind, text | png}): kept as "out" (the app keeps "in" itself). */
    @JavascriptInterface
    public void clipHistoryAdd(String dir, String json) {
        if (!"out".equals(dir)) return;
        try { ClipHistory.addLater(a, "out", new JSONObject(json), prefs.getString("p:lastPc", ""), prefs.getString("p:lastPcName", "")); }
        catch (Throwable e) { Bg.warn("clipHistoryAdd", e); }
    }

    /** An entry as the clipboard message the PC takes ({kind, text | png}), for the page's link; "" when it's gone. */
    @JavascriptInterface
    public String clipHistoryGet(String id) {
        JSONObject m = ClipHistory.content(a, id);
        return m == null ? "" : m.toString();
    }

    /** Tap to copy: the entry goes back on this phone's clipboard. */
    @JavascriptInterface public boolean clipHistoryCopy(String id) { return ClipHistory.copy(a, id); }

    /** Send to PC without the page's link (the app reaches the PC itself); the outcome shows as a toast. */
    @JavascriptInterface
    public void clipHistorySend(String id) {
        ClipHistory.send(a, id, new Actions.Report() { @Override public void say(String msg) { a.toast(msg); } });
    }

    @JavascriptInterface public void clipHistoryRemove(String id) { ClipHistory.remove(a, id); }
    @JavascriptInterface public void clipHistoryClear() { ClipHistory.clear(a); }

    // ---------------- Settings > Send feedback (Feedback) ----------------
    /** {ready, device, crash, crashAt, waiting}: what the form shows, so the user sees exactly what would be sent. */
    @JavascriptInterface public String feedbackInfo() { return Feedback.info(a).toString(); }

    /** {type, message, email, device, crash}: posted by the app; answers with a "feedback" event. */
    @JavascriptInterface public void feedbackSend(String json) { Feedback.send(a, json); }

    /**
     * "Save to the Flick list" for a link that was shared to Flick (event share-link): saved as a text item, like other
     * shared text; answers with the usual "added" event.
     */
    @JavascriptInterface
    public void saveLink(final String url, final String title) {
        if (url == null || url.length() == 0) return;
        Bg.run("saveLink", new Runnable() {
            @Override
            public void run() {
                try {
                    String t = title != null && title.trim().length() > 0 ? title.trim() : "Shared link";
                    JSONObject item = Library.get(a).importText(url, t.length() > 60 ? t.substring(0, 60) : t);
                    JSONObject o = new JSONObject();
                    o.put("t", "added");
                    o.put("items", new JSONArray().put(item));
                    a.emit(o.toString());
                } catch (Throwable e) { Bg.warn("saveLink", e); }
            }
        });
    }

    /** What the "Send last photo" tile does; the outcome shows as a page toast. */
    @JavascriptInterface
    public void sendLatestPhoto() {
        Transfers.hold(a, true);
        Actions.sendLatestPhoto(a, "share", true, new Actions.Report() { @Override public void say(String msg) { a.toast(msg); } });
    }

    /** What the "Send clipboard" tile does (the user asked, so a clipboard marked private goes too). */
    @JavascriptInterface
    public void sendClipboard() {
        waitForFocus();
        Actions.sendClipboard(a, Clip.read(a, true), new Actions.Report() { @Override public void say(String msg) { a.toast(msg); } });
    }

    // just back in front, the window may not have focus yet (the clipboard reads empty without it): up to 0.6 s
    private void waitForFocus() {
        for (int i = 0; i < 12 && !a.hasWindowFocus(); i++) {
            try { Thread.sleep(50); } catch (InterruptedException e) { return; }
        }
    }
}
