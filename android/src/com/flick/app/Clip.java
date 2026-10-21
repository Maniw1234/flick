package com.flick.app;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.PersistableBundle;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The phone's clipboard as Flick shares it: text (up to 1 MB) and images (as PNG, up to 6 MB of base64). Android lets
 * an app read the clipboard only while it is in front with focus (Android 10+); writing works any time.
 */
final class Clip {
    static final int MAX_TEXT = 1024 * 1024;              // bytes of UTF-8
    static final int MAX_PNG = 4400 * 1024;               // bytes: 6 MB once in base64
    static final String FROM_PC = "com.flick.app.fromPc"; // marks a clipboard Flick set from the PC
    static final String SENSITIVE = "android.content.extra.IS_SENSITIVE";   // ClipDescription.EXTRA_IS_SENSITIVE (13+)

    private Clip() {}

    /**
     * {"kind":"text","text"} / {"kind":"image","png"} / {"kind":"none"}. Also "fromPc":true when Flick put it there
     * from the PC (sending it back is pointless). Something an app marked sensitive (a password) is kind "none" with
     * "sensitive":true unless allowSensitive (the user asked to send the clipboard, with a tile, say): it never leaves
     * the phone on its own.
     */
    static JSONObject read(Context c, boolean allowSensitive) { return describe(c, grab(c), allowSensitive); }

    /** The clipboard itself: only while Flick is in front with focus (Android 10+); null otherwise or when empty. */
    static ClipData grab(Context c) {
        try {
            ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            return cm == null ? null : cm.getPrimaryClip();
        } catch (Throwable e) {
            Bg.warn("clipboard read", e);
            return null;
        }
    }

    /** What grab() got, as read() answers it (reads an image's bytes: off the main thread). */
    static JSONObject describe(Context c, ClipData cd, boolean allowSensitive) {
        JSONObject o = new JSONObject();
        try {
            o.put("kind", "none");
            if (cd == null || cd.getItemCount() == 0) return o;
            ClipDescription d = cd.getDescription();
            PersistableBundle x = d == null ? null : d.getExtras();
            if (x != null && x.getBoolean(SENSITIVE, false)) {
                o.put("sensitive", true);
                if (!allowSensitive) return o;
            }
            boolean fromPc = x != null && x.getBoolean(FROM_PC, false);
            ClipData.Item it = cd.getItemAt(0);
            Uri u = it.getUri();
            if (u != null) {
                String mime = mimeOf(c, u, d);
                if (mime.startsWith("image/")) {
                    String png = png(c.getContentResolver(), u, mime);
                    if (png != null) {
                        o.put("kind", "image");
                        o.put("png", png);
                        if (fromPc) o.put("fromPc", true);
                        return o;
                    }
                }
            }
            CharSequence t = it.getText();
            if (t == null && it.getHtmlText() != null) { try { t = it.coerceToText(c); } catch (Throwable e) { /* none */ } }
            if (t == null && u != null && mimeOf(c, u, d).startsWith("text/")) { try { t = it.coerceToText(c); } catch (Throwable e) { /* none */ } }
            if (t == null || t.length() == 0) return o;
            o.put("kind", "text");
            o.put("text", cut(t.toString(), MAX_TEXT));
            if (fromPc) o.put("fromPc", true);
        } catch (Throwable e) {
            Bg.warn("clipboard read", e);
        }
        return o;
    }

    /** Puts the PC's clipboard ({kind:text,text} / {kind:image,png}) on the phone's. Returns the kind, or null. */
    static String write(Context c, JSONObject m, String pcName) {
        try {
            String kind = m.optString("kind", "");
            String label = "From " + (pcName == null || pcName.length() == 0 ? "your PC" : pcName);
            final ClipData cd;
            if ("text".equals(kind)) {
                String text = m.optString("text", "");
                if (text.length() == 0) return null;
                cd = ClipData.newPlainText(label, cut(text, MAX_TEXT));
            } else if ("image".equals(kind)) {
                byte[] png = Base64.decode(m.optString("png", ""), Base64.DEFAULT);
                if (png.length < 8 || png.length > 6 * 1024 * 1024 || !isPng(png)) return null;
                File f = ClipProvider.save(c, png);
                cd = ClipData.newUri(c.getContentResolver(), label, ClipProvider.uriFor(f));
            } else {
                return null;
            }
            PersistableBundle x = new PersistableBundle();
            x.putBoolean(FROM_PC, true);
            cd.getDescription().setExtras(x);
            return set(c, cd) ? kind : null;
        } catch (Throwable e) {
            Bg.warn("clipboard write", e);
            return null;
        }
    }

    /** setPrimaryClip on the main thread (waits up to 2 s for it). */
    private static boolean set(Context c, final ClipData cd) throws InterruptedException {
        final ClipboardManager cm = (ClipboardManager) c.getApplicationContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return false;
        final AtomicBoolean ok = new AtomicBoolean(false);
        final CountDownLatch done = new CountDownLatch(1);
        Bg.main(new Runnable() {
            @Override
            public void run() {
                try { cm.setPrimaryClip(cd); ok.set(true); } catch (Throwable e) { Bg.warn("clipboard set", e); }
                done.countDown();
            }
        });
        done.await(2, TimeUnit.SECONDS);
        return ok.get();
    }

    private static String mimeOf(Context c, Uri u, ClipDescription d) {
        try {
            String t = c.getContentResolver().getType(u);
            if (t != null) return t.toLowerCase(java.util.Locale.US);
        } catch (Throwable e) { /* ask the description */ }
        if (d != null && d.getMimeTypeCount() > 0) {
            for (int i = 0; i < d.getMimeTypeCount(); i++) {
                String t = d.getMimeType(i);
                if (t != null && (t.startsWith("image/") || t.startsWith("text/"))) return t;
            }
        }
        return "";
    }

    /** The image at u as base64 PNG of at most MAX_PNG bytes (made smaller if needed), or null. */
    static String png(ContentResolver cr, Uri u, String mime) {
        try {
            if ("image/png".equals(mime)) {
                byte[] raw = read(cr, u, MAX_PNG + 1);
                if (raw != null && raw.length <= MAX_PNG && isPng(raw)) return Base64.encodeToString(raw, Base64.NO_WRAP);
            }
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            InputStream in = cr.openInputStream(u);
            if (in == null) return null;
            try { BitmapFactory.decodeStream(in, null, o); } finally { in.close(); }
            if (o.outWidth <= 0 || o.outHeight <= 0) return null;
            int sample = 1;
            while (Math.max(o.outWidth, o.outHeight) / sample > 4096) sample *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            in = cr.openInputStream(u);
            if (in == null) return null;
            Bitmap b;
            try { b = BitmapFactory.decodeStream(in, null, o2); } finally { in.close(); }
            if (b == null) return null;
            try {
                for (int round = 0; round < 6; round++) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    b.compress(Bitmap.CompressFormat.PNG, 100, out);
                    if (out.size() <= MAX_PNG) return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    Bitmap s = Bitmap.createScaledBitmap(b, Math.max(1, b.getWidth() * 7 / 10), Math.max(1, b.getHeight() * 7 / 10), true);
                    if (s != b) { b.recycle(); b = s; }
                }
            } finally { b.recycle(); }
        } catch (Throwable e) {
            Bg.warn("clipboard image", e);
        }
        return null;
    }

    private static byte[] read(ContentResolver cr, Uri u, int max) throws java.io.IOException {
        InputStream in = cr.openInputStream(u);
        if (in == null) return null;
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) { b.write(buf, 0, n); if (b.size() > max) return null; }
            return b.toByteArray();
        } finally { in.close(); }
    }

    static boolean isPng(byte[] b) {
        return b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0d && b[5] == 0x0a && b[6] == 0x1a && b[7] == 0x0a;
    }

    /** s cut to at most max bytes of UTF-8 (never inside a character). */
    static String cut(String s, int max) {
        if (s.length() * 3 <= max) return s;
        int bytes = 0;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            int n = ch < 0x80 ? 1 : ch < 0x800 ? 2 : Character.isHighSurrogate(ch) ? 4 : Character.isLowSurrogate(ch) ? 0 : 3;
            if (bytes + n > max) return s.substring(0, i);
            bytes += n;
        }
        return s;
    }

    private static final Comparator<File> OLDEST = new Comparator<File>() {
        @Override public int compare(File a, File b) { return Long.compare(a.lastModified(), b.lastModified()); }
    };

    static void keepNewest(File dir, int n) {
        File[] fs = dir.listFiles();
        if (fs == null || fs.length <= n) return;
        Arrays.sort(fs, OLDEST);
        for (int i = 0; i < fs.length - n; i++) fs[i].delete();
    }

    static void writeFile(File f, byte[] b) throws java.io.IOException {
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(b); } finally { out.close(); }
    }
}
