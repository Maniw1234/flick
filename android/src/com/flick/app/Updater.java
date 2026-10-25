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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wireless self-update. The PC offers a newer Flick APK; this downloads it, checks it really is Flick, newer, and
 * signed with the key the installed app is signed with now, then hands it to Android's own installer, which asks the
 * user to confirm ("Do you want to update this app?") and ends with an "Open" button.
 *
 * Every update (from the PC or from GitHub) must also come with its release's SHA256SUMS and SHA256SUMS.sig: signed
 * with Flick's offline release key, which GitHub never sees, and listing this exact file. Without that it is refused.
 *
 * One instance per process (the files are shared), attached to whichever activity is current.
 */
final class Updater {
    private static final Pattern NAME = Pattern.compile("flick-(\\d{1,12})-([0-9a-f]{16})\\.apk");
    // an update and, next to it, its release's signature + SHA256SUMS (written once the update passed every check)
    private static final Pattern FILE = Pattern.compile("flick-(\\d{1,12})-([0-9a-f]{16})\\.(apk|release)");
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
            Matcher m = FILE.matcher(f.getName());
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
            String[] rel = readRelease(f);                // no signed release next to it: never checked, not used
            if (rel != null && code > installedCode(app) && verify(f, code, rel[0], rel[1]) == null) {
                ready = f; readyCode = code; readySha = m.group(2); return code;
            }
        }
        return 0;
    }

    static File releaseFile(File apk) { return new File(apk.getParent(), apk.getName().replaceAll("\\.apk$", ".release")); }

    /** { sums, sig } kept next to a checked update, or null. The file is the signature line, then SHA256SUMS. */
    static String[] readRelease(File apk) {
        File f = releaseFile(apk);
        if (!f.isFile() || f.length() > 70 * 1024) return null;
        try {
            String t = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            int nl = t.indexOf('\n');
            return nl < 0 ? null : new String[]{t.substring(nl + 1), t.substring(0, nl)};
        } catch (Throwable e) { return null; }
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
    /** sums + sig: the SHA256SUMS of the Flick release this update comes from, and its SHA256SUMS.sig. */
    void download(final String url, final long code, final long size, final String sha256, final String sums, final String sig) {
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
                    // not even downloaded unless Flick's signed release lists it (checked again on the file below)
                    String why = checkRelease(sums, sig, releasedName(sums, sha256), sha256);
                    if (why != null) throw new IOException(why);
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
                    why = verify(dest, code, sums, sig);
                    if (why != null) throw new IOException(why);
                    writeRelease(dest, sums, sig);
                    synchronized (Updater.this) { ready = dest; readyCode = code; readySha = sha16; }
                    emit("upd-done", "ok", true, "code", code);
                } catch (Throwable e) {
                    if (dest != null) { dest.delete(); releaseFile(dest).delete(); }
                    emit("upd-done", "ok", false, "why", String.valueOf(e.getMessage()));
                } finally {
                    busy = false;
                }
            }
        }, "flick-update").start();
    }

    static void writeRelease(File apk, String sums, String sig) throws IOException {
        FileOutputStream o = new FileOutputStream(releaseFile(apk));
        try { o.write((sig.trim() + "\n" + sums).getBytes(StandardCharsets.UTF_8)); } finally { o.close(); }
    }

    /**
     * null when the file is an update Flick released (sums + sig, see checkRelease) and a newer Flick signed by the
     * same developer; otherwise why not.
     */
    @SuppressWarnings("deprecation")
    private String verify(File f, long expectCode, String sums, String sig) {
        // first: Flick's signed release lists exactly this file (as Flick-<version>.apk)
        String sha;
        try { sha = sha256(f); } catch (IOException e) { return "missing"; }
        String name = releasedName(sums, sha);
        String rel = checkRelease(sums, sig, name, sha);
        if (rel != null) return rel;
        PackageManager pm = app.getPackageManager();
        int flags = PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= 28) flags |= PackageManager.GET_SIGNING_CERTIFICATES;
        PackageInfo arc = pm.getPackageArchiveInfo(f.getPath(), flags);
        if (arc == null) return "not an app";
        if (!app.getPackageName().equals(arc.packageName)) return "not Flick";
        if (!name.equals(arc.versionName)) return "unexpected version";
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

    // ---------------------------------------------------------------- Flick's release signature
    /**
     * Flick's offline release keys (ECDSA P-256, SubjectPublicKeyInfo in base64): the same list as RELEASE_KEYS in
     * pc/updatecore.js. signing/sign_release.js signs each release with one of them. Not final: tests use their own.
     */
    static String[] KEYS = {"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUGJiEHyLcmPkuREqLXb7MLtKMKoRBQUNuKb8Gjcw7tIMuDVr0cRSM2Xjpu3SWDM4vdpGOJXnYjVG5Tin5P1DZA=="};
    private static final Pattern SUM = Pattern.compile("([0-9a-fA-F]{64}) [ *](\\S.*?)\\r?");
    private static final Pattern BUNDLE = Pattern.compile("flick-app-(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\.zip");
    private static final Pattern APK = Pattern.compile("Flick-(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\.apk");

    /**
     * null when sums is a release's SHA256SUMS that one of KEYS signed (sig: SHA256SUMS.sig, base64 DER ECDSA over
     * "flick-release-v1\nversion <release>\n" + sums) and that lists Flick-<versionName>.apk with this SHA-256;
     * otherwise why not. <release> is the version whose Windows bundle (flick-app-<release>.zip) the release carries:
     * the phone app in it can be older, when it didn't change since. versionName null: not listed at all.
     */
    static String checkRelease(String sums, String sig, String versionName, String sha256) {
        if (sums == null || sig == null || sums.isEmpty() || sig.trim().isEmpty()) return "not signed";
        Map<String, String> list = parseSums(sums);
        if (list == null) return "not signed: bad SHA256SUMS";
        Set<String> versions = new LinkedHashSet<String>();
        for (String n : list.keySet()) { Matcher m = BUNDLE.matcher(n); if (m.matches()) versions.add(m.group(1)); }
        if (versionName != null) versions.add(versionName);
        boolean signed = false;
        for (String v : versions) if (signedBy(v, sums, sig)) { signed = true; break; }
        if (!signed) return "not signed";
        String want = versionName == null ? null : list.get("Flick-" + versionName + ".apk");
        if (want == null || sha256 == null || !want.equalsIgnoreCase(sha256)) return "not signed: not in SHA256SUMS";
        return null;
    }

    /** true when sig is a valid signature of this release version's SHA256SUMS by one of KEYS. */
    static boolean signedBy(String version, String sums, String sig) {
        byte[] der;
        try { der = Base64.getDecoder().decode(sig.trim()); } catch (IllegalArgumentException e) { return false; }
        byte[] msg = ("flick-release-v1\nversion " + version + "\n" + sums).getBytes(StandardCharsets.UTF_8);
        for (String k : KEYS) {
            try {
                PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(k)));
                java.security.Signature v = java.security.Signature.getInstance("SHA256withECDSA");
                v.initVerify(key);
                v.update(msg);
                if (v.verify(der)) return true;
            } catch (Throwable e) { /* not this key */ }
        }
        return false;
    }

    /** SHA256SUMS as name -> lowercase SHA-256; null if a line doesn't parse or a name repeats. */
    static Map<String, String> parseSums(String text) {
        Map<String, String> out = new HashMap<String, String>();
        for (String line : text.split("\n")) {
            if (line.trim().isEmpty()) continue;
            Matcher m = SUM.matcher(line);
            if (!m.matches() || out.containsKey(m.group(2))) return null;
            out.put(m.group(2), m.group(1).toLowerCase(Locale.ROOT));
        }
        return out;
    }

    /** The version in the name SHA256SUMS gives this SHA-256 ("1.0.0" for Flick-1.0.0.apk), or null. */
    static String releasedName(String sums, String sha256) {
        Map<String, String> list = sums == null ? null : parseSums(sums);
        if (list == null || sha256 == null) return null;
        for (Map.Entry<String, String> e : list.entrySet()) {
            Matcher m = APK.matcher(e.getKey());
            if (m.matches() && e.getValue().equalsIgnoreCase(sha256)) return m.group(1);
        }
        return null;
    }

    static String sha256(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            InputStream in = new FileInputStream(f);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            } finally { in.close(); }
            return UpdateFetch.hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException("no SHA-256"); }
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
