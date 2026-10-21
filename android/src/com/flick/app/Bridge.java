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

import org.json.JSONObject;

import java.io.File;

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

    @JavascriptInterface
    public void pick(final String kind) {
        a.runOnUiThread(new Runnable() { @Override public void run() { a.launchPicker(kind); } });
    }

    @JavascriptInterface public void upload(String tid, String id, String url) { a.transfers().upload(tid, id, url); }
    @JavascriptInterface public void uploadBundle(String tid, String items, String url) { a.transfers().uploadBundle(tid, items, url); }
    @JavascriptInterface public void abort(String tid) { a.transfers().abort(tid); }
    @JavascriptInterface public void download(String fid, String url, String name, String size, String mime) { a.transfers().download(fid, url, name, mime); }

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

    @JavascriptInterface
    public String saveCopy(String id) {
        if (Build.VERSION.SDK_INT < 29) return "";
        JSONObject o = Library.get(a).find(id);
        if (o == null) return "";
        File f = Library.get(a).fileOf(o);
        try { return Transfers.PublicSave.save(a, f, o.optString("name"), o.optString("mime")); } catch (Throwable e) { return ""; }
    }
}
