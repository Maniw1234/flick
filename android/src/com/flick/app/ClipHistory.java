package com.flick.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;

/**
 * Clipboard history on the phone (setting "Clipboard history", on unless turned off): the last 20 clipboards Flick put
 * on this phone from the PC or sent there (ClipStore), in Flick's own files only. A clipboard an app marked as private
 * (a password) is never kept, even when the user sent it on purpose. The page shows the list in a sheet (••• ›
 * Clipboard history): tap to copy, Send to PC. Turning the setting off clears it.
 */
final class ClipHistory {
    private static ClipStore store;

    private ClipHistory() {}

    static synchronized ClipStore store(Context c) {
        if (store == null) store = new ClipStore(new File(c.getApplicationContext().getFilesDir(), "cliphist"));
        return store;
    }

    /**
     * A clipboard went through Flick (dir "in": from the PC, "out": to it). clip: {kind:"text", text} or
     * {kind:"image", png (base64)}, as Clip.read / the PC's message have it; "sensitive" or "private": never kept.
     */
    static void add(Context c, String dir, JSONObject clip, String pcId, String pcName) {
        try {
            if (clip == null || !Features.clipHistory(c) || clip.optBoolean("sensitive", false) || clip.optBoolean("private", false)) return;
            String kind = clip.optString("kind", "");
            JSONObject e = null;
            if ("text".equals(kind)) {
                e = store(c).add(clip.optString("text", ""), null, null, dir, pcId, pcName);
            } else if ("image".equals(kind)) {
                byte[] png = Base64.decode(clip.optString("png", ""), Base64.DEFAULT);
                e = store(c).add(null, png, thumb(png), dir, pcId, pcName);
            }
            if (e != null) Page.event("cliphist");
        } catch (Throwable x) { Bg.warn("clipboard history", x); }
    }

    /** add() off the calling thread (a picture is decoded for its thumbnail). */
    static void addLater(final Context c, final String dir, final JSONObject clip, final String pcId, final String pcName) {
        final Context app = c.getApplicationContext();
        Bg.run("clipboard history", new Runnable() { @Override public void run() { add(app, dir, clip, pcId, pcName); } });
    }

    /** A small JPEG of the picture for the list (at most 160 px), or null. */
    static byte[] thumb(byte[] png) {
        Bitmap b = null;
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(png, 0, png.length, o);
            if (o.outWidth <= 0 || o.outHeight <= 0) return null;
            int s = 1;
            while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= 320) s *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = s;
            b = Library.scaleTo(BitmapFactory.decodeByteArray(png, 0, png.length, o2), 160);
            if (b == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 80, out);
            return out.toByteArray();
        } catch (Throwable e) {
            return null;
        } finally { if (b != null) b.recycle(); }
    }

    static String listJson(Context c) { return store(c).listJson(); }

    /** An entry's content as the clipboard message the PC takes: {kind:"text", text} or {kind:"image", png}; null if gone. */
    static JSONObject content(Context c, String id) {
        try {
            ClipStore s = store(c);
            JSONObject e = s.find(id);
            if (e == null) return null;
            JSONObject m = new JSONObject();
            if ("image".equals(e.optString("kind"))) {
                byte[] png = s.png(id);
                if (png == null) return null;
                m.put("kind", "image");
                m.put("png", Base64.encodeToString(png, Base64.NO_WRAP));
            } else {
                String t = s.text(id);
                if (t == null) return null;
                m.put("kind", "text");
                m.put("text", t);
            }
            return m;
        } catch (Throwable x) { return null; }
    }

    /** Puts an entry back on this phone's clipboard, marked as Flick's own (so it isn't sent to the PC by itself). */
    static boolean copy(Context c, String id) {
        JSONObject m = content(c, id);
        JSONObject e = store(c).find(id);
        return m != null && Clip.write(c, m, e == null ? "" : e.optString("pcName")) != null;
    }

    /** Sends an entry to the PC the app uses (POST /api/clip); r says how it went. */
    static void send(Context ctx, final String id, final Actions.Report r) {
        final Context c = ctx.getApplicationContext();
        Bg.send("send from clipboard history", new Runnable() {
            @Override
            public void run() {
                PcClient.Target t = null;
                try {
                    JSONObject m = content(c, id);
                    if (m == null) { r.say("That’s no longer in the clipboard history"); return; }
                    PcClient client = Bg.client(c);
                    t = client.target();
                    t.eager = true;
                    client.post(t, "/api/clip", null, m);
                    add(c, "out", m, t.id, t.name);
                    r.say(("text".equals(m.optString("kind")) ? "Copied to " : "Image copied to ") + t.name);
                } catch (Throwable e) {
                    r.say(Bg.why(e, t == null ? null : t.name));
                }
            }
        });
    }

    static boolean remove(Context c, String id) {
        boolean ok = store(c).remove(id);
        if (ok) Page.event("cliphist");
        return ok;
    }

    static void clear(Context c) {
        store(c).clear();
        Page.event("cliphist");
    }
}
