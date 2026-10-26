package com.flick.app;

import android.annotation.TargetApi;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Process;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * What made Flick close unexpectedly, kept so the next start can show it (CrashActivity) and the user can pass it on.
 * A crash in Flick's own code is written to crash.txt as it happens; a crash Android records itself (one in native
 * code, or an app that stopped responding) is read back from Android's list of how Flick's process ended.
 */
final class CrashReport {
    private static final String FILE = "crash.txt";
    private static final String SEEN = "crashSeenAt";       // the newest exit already shown (ms)

    private CrashReport() {}

    static void install(final Context base) {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    PrintWriter pw = new PrintWriter(sw);
                    pw.println(header(base));
                    pw.println("Thread: " + t.getName());
                    e.printStackTrace(pw);
                    pw.flush();
                    FileOutputStream o = new FileOutputStream(new File(base.getFilesDir(), FILE));
                    try { o.write(sw.toString().getBytes(StandardCharsets.UTF_8)); } finally { o.close(); }
                } catch (Throwable x) { /* nothing more can be done */ }
                if (prev != null) prev.uncaughtException(t, e);
                else { Process.killProcess(Process.myPid()); System.exit(10); }
            }
        });
    }

    /** The report of the last unexpected close not shown yet, or null; once taken, it isn't shown again. */
    static String take(Context c) {
        StringBuilder out = new StringBuilder();
        File f = new File(c.getFilesDir(), FILE);
        if (f.isFile()) {
            out.append(read(f, 64 * 1024));
            f.delete();
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try { String sys = Api30.exits(c, out.length() == 0); if (sys != null) out.append(out.length() > 0 ? "\n" : header(c) + "\n").append(sys); }
            catch (Throwable e) { /* Android's own record is a bonus */ }
        }
        if (out.length() == 0) return null;
        // kept (until a newer one, or until it went with feedback) so Settings > Send feedback can offer to attach it
        try { FileOutputStream o = new FileOutputStream(new File(c.getFilesDir(), LAST)); try { o.write(out.toString().getBytes(StandardCharsets.UTF_8)); } finally { o.close(); } }
        catch (Throwable e) { /* only feedback would have used it */ }
        return out.toString();
    }

    private static final String LAST = "crash-last.txt";
    private static final long LAST_DAYS = 30;

    /** The last report shown, for Send feedback (at most LAST_DAYS old), or null. */
    static String last(Context c) {
        File f = new File(c.getFilesDir(), LAST);
        if (!f.isFile()) return null;
        if (System.currentTimeMillis() - f.lastModified() > LAST_DAYS * 86400000L) { f.delete(); return null; }
        String s = read(f, 64 * 1024);
        return s.length() > 0 ? s : null;
    }

    /** When the last report was kept (ms), or 0. */
    static long lastAt(Context c) { File f = new File(c.getFilesDir(), LAST); return f.isFile() ? f.lastModified() : 0; }

    /** It went with feedback: not offered again. */
    static void forgetLast(Context c) { new File(c.getFilesDir(), LAST).delete(); }

    private static String header(Context c) {
        String v = "?";
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            v = pi.versionName + " (" + (Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode) + ")";
        } catch (Throwable e) { /* ignore */ }
        return "Flick " + v + " on " + Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (SDK "
                + Build.VERSION.SDK_INT + "), " + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    private static String read(File f, int max) {
        try {
            InputStream in = new FileInputStream(f);
            try { return new String(readAll(in, max), StandardCharsets.UTF_8); } finally { in.close(); }
        } catch (Throwable e) { return ""; }
    }

    private static byte[] readAll(InputStream in, int max) throws java.io.IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while (b.size() < max && (n = in.read(buf, 0, Math.min(buf.length, max - b.size()))) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }

    /** The readable runs of characters in a binary record (Android's native crash report is a protobuf). */
    private static String strings(byte[] b, int maxLines) {
        StringBuilder out = new StringBuilder();
        StringBuilder run = new StringBuilder();
        int lines = 0;
        for (int i = 0; i <= b.length && lines < maxLines; i++) {
            int ch = i < b.length ? b[i] & 0xff : 0;
            if (ch >= 0x20 && ch < 0x7f) { run.append((char) ch); continue; }
            if (run.length() >= 6) { out.append(run).append('\n'); lines++; }
            run.setLength(0);
        }
        return out.toString();
    }

    @TargetApi(30)
    static final class Api30 {
        /** Crashes and freezes Android recorded since the last one shown (any=false: not the plain crashes crash.txt has). */
        static String exits(Context c, boolean any) throws Exception {
            ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return null;
            SharedPreferences p = c.getSharedPreferences("flick", 0);
            long seen = p.getLong(SEEN, 0), newest = seen;
            List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(c.getPackageName(), 0, 5);
            StringBuilder out = new StringBuilder();
            for (ApplicationExitInfo x : list) {
                if (x.getTimestamp() <= seen) continue;
                newest = Math.max(newest, x.getTimestamp());
                int r = x.getReason();
                boolean nativeCrash = r == ApplicationExitInfo.REASON_CRASH_NATIVE, anr = r == ApplicationExitInfo.REASON_ANR;
                if (!nativeCrash && !anr && !(any && r == ApplicationExitInfo.REASON_CRASH)) continue;
                out.append("Android recorded: ").append(nativeCrash ? "crash in native code" : anr ? "not responding" : "crash")
                        .append(" at ").append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date(x.getTimestamp())))
                        .append(" (").append(x.getProcessName()).append(")\n");
                if (x.getDescription() != null) out.append(x.getDescription()).append('\n');
                InputStream in = null;
                try {
                    in = x.getTraceInputStream();
                    if (in != null) {
                        byte[] t = readAll(in, 512 * 1024);
                        out.append(nativeCrash ? strings(t, 160) : new String(t, 0, Math.min(t.length, 24 * 1024), StandardCharsets.UTF_8)).append('\n');
                    }
                } catch (Throwable e) { /* no trace */ } finally { try { if (in != null) in.close(); } catch (Throwable e) { /* ignore */ } }
            }
            if (newest > seen) p.edit().putLong(SEEN, newest).apply();
            return out.length() > 0 ? out.toString() : null;
        }
    }
}
