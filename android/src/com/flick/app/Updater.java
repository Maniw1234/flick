package com.flick.app;

import android.annotation.TargetApi;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wireless self-update. The PC offers a newer Flick APK; this downloads it, checks it really is Flick, newer, and
 * signed with the key the installed app is signed with now, then hands it to Android's own installer, which asks the
 * user to confirm ("Do you want to update this app?") and ends with an "Open" button.
 *
 * One instance per process (the files are shared), attached to whichever activity is current.
 */
final class Updater {
    private static final Pattern NAME = Pattern.compile("flick-(\\d{1,12})-([0-9a-f]{16})\\.apk");
    private static Updater instance;

    static synchronized Updater get(MainActivity a) {
        if (instance == null) instance = new Updater(a.getApplicationContext());
        instance.act = a;
        return instance;
    }

    static synchronized Updater peek() { return instance; }

    private final Context app;
    private volatile MainActivity act;
    private volatile boolean busy = false;
    private volatile File ready = null;      // checked APK waiting to be installed
    private volatile long readyCode = 0;
    private volatile String readySha = "";
    // UI thread only
    private boolean pendingInstall = false;  // asked to install while Flick wasn't on screen
    private boolean pendingPerm = false;     // sent the user to "Install unknown apps"
    private boolean launched = false;        // the installer is (or was) on screen

    private Updater(Context app) { this.app = app; }

    void detach(MainActivity a) { if (act == a) act = null; }

    static File dir(Context c) { return new File(c.getCacheDir(), "updates"); }

    static boolean validName(String n) { return NAME.matcher(n).matches(); }

    /** Everything in the update folder (before a new download). */
    static void cleanup(Context c) {
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) f.delete();
    }

    /** Updates that are installed by now (or older), and downloads that never finished. Safe to run any time. */
    static void cleanupInstalled(Context c) {
        File[] fs = dir(c).listFiles();
        if (fs == null) return;
        long have = installedCode(c);
        for (File f : fs) {
            Matcher m = NAME.matcher(f.getName());
            boolean stale = m.matches() ? Long.parseLong(m.group(1)) <= have : System.currentTimeMillis() - f.lastModified() > 10 * 60 * 1000;
            if (stale) f.delete();
        }
    }

    @SuppressWarnings("deprecation")
    static long versionCode(PackageInfo pi) { return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode; }

    static PackageInfo self(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0); } catch (Throwable e) { return null; }
    }

    static long installedCode(Context c) { PackageInfo pi = self(c); return pi == null ? 0 : versionCode(pi); }

    static String installedName(Context c) { PackageInfo pi = self(c); return pi == null || pi.versionName == null ? "" : pi.versionName; }

    boolean canInstall() { return Build.VERSION.SDK_INT < 26 || Api26.canInstall(app); }

    boolean busy() { return busy; }

    /** Version code of a checked download that is ready to install (also finds one from before the app restarted). */
    synchronized long readyCode() {
        if (ready != null && ready.isFile()) return readyCode;
        ready = null;
        if (busy) return 0;
        File[] fs = dir(app).listFiles();
        if (fs != null) for (File f : fs) {
            Matcher m = NAME.matcher(f.getName());
            if (!m.matches()) continue;
            long code = Long.parseLong(m.group(1));
            if (code > installedCode(app) && verify(f, code) == null) { ready = f; readyCode = code; readySha = m.group(2); return code; }
        }
        return 0;
    }

    String readySha() { return ready != null ? readySha : ""; }

    private void emit(String t, Object... kv) {
        MainActivity m = act;
        if (m == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("t", t);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
            m.emit(o.toString());
        } catch (Throwable e) { /* ignore */ }
    }

    void fail(String why) { emit("upd-done", "ok", false, "why", why); }

    // ---------------------------------------------------------------- download + check
    void download(final String url, final long code, final long size, final String sha256) {
        synchronized (this) {
            if (busy) return;                    // a download is already running; its events reach the current page
            busy = true;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                File dest = null;
                try {
                    if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) throw new IOException("checksum");
                    File d = dir(app);
                    if (!d.isDirectory() && !d.mkdirs()) throw new IOException("no space");
                    synchronized (Updater.this) { ready = null; }
                    cleanup(app);                                 // one update at a time
                    String sha16 = sha256.substring(0, 16).toLowerCase();
                    dest = new File(d, "flick-" + code + "-" + sha16 + ".apk");
                    final long[] last = {0};
                    UpdateFetch.fetch(url, dest, size, sha256, null, new UpdateFetch.Progress() {
                        @Override
                        public void onBytes(long got, long total) {
                            long now = SystemClock.uptimeMillis();
                            if (now - last[0] > 100 || got == total) { last[0] = now; emit("upd", "got", got, "total", total); }
                        }
                    });
                    String why = verify(dest, code);
                    if (why != null) throw new IOException(why);
                    synchronized (Updater.this) { ready = dest; readyCode = code; readySha = sha16; }
                    emit("upd-done", "ok", true, "code", code);
                } catch (Throwable e) {
                    if (dest != null) dest.delete();
                    emit("upd-done", "ok", false, "why", String.valueOf(e.getMessage()));
                } finally {
                    busy = false;
                }
            }
        }, "flick-update").start();
    }

    /** null when the file is a newer Flick signed by the same developer; otherwise why not. */
    @SuppressWarnings("deprecation")
    private String verify(File f, long expectCode) {
        PackageManager pm = app.getPackageManager();
        int flags = PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= 28) flags |= PackageManager.GET_SIGNING_CERTIFICATES;
        PackageInfo arc = pm.getPackageArchiveInfo(f.getPath(), flags);
        if (arc == null) return "not an app";
        if (!app.getPackageName().equals(arc.packageName)) return "not Flick";
        long v = versionCode(arc);
        if (v != expectCode) return "unexpected version";
        PackageInfo me;
        // what can't be checked is refused (with a reason), never waved through
        try { me = pm.getPackageInfo(app.getPackageName(), flags); } catch (Throwable e) { return "can't read this app's signature"; }
        if (v <= versionCode(me)) return "not newer";
        // Android refuses an update from another developer anyway; checking first gives a clear message instead
        if (Build.VERSION.SDK_INT >= 28) return Api28.sameDeveloper(me, arc);
        Set<String> mine = certs(me.signatures), theirs = certs(arc.signatures);
        if (mine.isEmpty() || theirs.isEmpty()) return "missing signature";
        if (!mine.equals(theirs)) return "different signature";
        return null;
    }

    static Set<String> certs(Signature[] sigs) {
        Set<String> out = new HashSet<String>();
        if (sigs == null) return out;
        for (Signature s : sigs) {
            if (s == null) continue;
            try { out.add(UpdateFetch.hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))); } catch (Throwable e) { /* ignore */ }
        }
        return out;
    }

    // ---------------------------------------------------------------- install (UI thread)
    void install(MainActivity a) {
        act = a;
        final File f = ready;
        if (f == null || !f.isFile()) { emit("upd-fail", "why", "missing"); return; }
        if (!a.isOnScreen()) { pendingInstall = true; return; }   // Android blocks starting screens from the background
        if (!canInstall()) {
            // one-time: Android wants the user to allow Flick to install apps
            pendingPerm = true;
            emit("upd-perm");
            try {
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + app.getPackageName())));
            } catch (Throwable e) {
                try { a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)); }
                catch (Throwable x) { pendingPerm = false; emit("upd-fail", "why", "settings"); }
            }
            return;
        }
        launch(a, f);
    }

    @SuppressWarnings("deprecation")
    private void launch(MainActivity a, File f) {
        Uri u = FilesProvider.uriForUpdate(f);
        Intent i = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        i.setDataAndType(u, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            a.startActivity(i);
        } catch (ActivityNotFoundException e) {
            Intent v = new Intent(Intent.ACTION_VIEW);
            v.setDataAndType(u, "application/vnd.android.package-archive");
            v.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try { a.startActivity(v); }
            catch (Throwable x) { emit("upd-fail", "why", "installer"); return; }
        } catch (Throwable e) {
            emit("upd-fail", "why", "installer");
            return;
        }
        launched = true;
        emit("upd-installing");
    }

    /** Back in Flick: after the permission screen, or because the installer was closed (a finished update restarts the app). */
    void onResume(final MainActivity a) {
        act = a;
        if (pendingInstall) {
            pendingInstall = false;
            install(a);
            return;
        }
        if (pendingPerm) {
            pendingPerm = false;
            if (canInstall()) {
                a.ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        // whichever activity is current by now (it may have been recreated in the meantime)
                        MainActivity cur = act;
                        File f = ready;
                        if (f == null || cur == null) return;
                        if (cur.isOnScreen()) launch(cur, f); else pendingInstall = true;
                    }
                }, 250);
            } else {
                emit("upd-perm-denied");
            }
            return;
        }
        if (launched) {
            launched = false;
            emit("upd-back");
        }
    }

    @TargetApi(26)
    static final class Api26 {
        static boolean canInstall(Context c) { return c.getPackageManager().canRequestPackageInstalls(); }
    }

    @TargetApi(28)
    static final class Api28 {
        /**
         * The update must be signed by the key the installed app uses now, or prove (key rotation) that this key
         * handed over to its own. Signers that can't be read → refused.
         */
        static String sameDeveloper(PackageInfo me, PackageInfo arc) {
            SigningInfo a = me.signingInfo, b = arc.signingInfo;
            if (a == null || b == null) return "missing signature";
            Set<String> mine = certs(a.getApkContentsSigners());
            Set<String> theirs = certs(b.getApkContentsSigners());
            if (mine.isEmpty() || theirs.isEmpty()) return "missing signature";
            if (mine.equals(theirs)) return null;
            if (!b.hasMultipleSigners() && certs(b.getSigningCertificateHistory()).containsAll(mine)) return null;
            return "different signature";
        }
    }
}
