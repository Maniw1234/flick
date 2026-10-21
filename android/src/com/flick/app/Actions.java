package com.flick.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.File;

/**
 * The one-tap sends of the Quick Settings tiles and the widget (also callable from the page): the newest photo, or the
 * clipboard, to the paired PC. Each answers with a short sentence for a toast ("Sent to <PC>", or why not).
 */
final class Actions {
    interface Report { void say(String msg); }

    private Actions() {}

    /** The newest photo or screenshot on the phone (not one Flick saved from the PC), or null. */
    static AutoSendQueue.Item latestPhoto(Context c) {
        Uri coll = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String[] proj = {"_id", "_display_name", "_size", "date_added", "mime_type", "_data"};
        String where = "_size > 0 AND (_data IS NULL OR (_data NOT LIKE ? AND _data NOT LIKE ? AND _data NOT LIKE ?))";
        String[] args = {"%/Download/Flick/%", "%/Pictures/Flick/%", "%/.%"};
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(coll, proj, where, args, "date_added DESC, _id DESC");
            if (cur == null || !cur.moveToFirst()) return null;
            AutoSendQueue.Item it = new AutoSendQueue.Item();
            long id = cur.getLong(cur.getColumnIndex("_id"));
            it.key = "i:" + id;
            it.uri = ContentUris.withAppendedId(coll, id).toString();
            it.path = cur.getString(cur.getColumnIndex("_data"));
            it.name = cur.getString(cur.getColumnIndex("_display_name"));
            if (it.name == null || it.name.length() == 0) it.name = it.path != null ? new File(it.path).getName() : "photo-" + id + ".jpg";
            it.size = cur.getLong(cur.getColumnIndex("_size"));
            it.added = cur.getLong(cur.getColumnIndex("date_added"));
            it.mime = cur.getString(cur.getColumnIndex("mime_type"));
            it.kind = "photo";
            return it;
        } catch (Throwable e) {
            Bg.warn("latest photo", e);
            return null;
        } finally {
            if (cur != null) cur.close();
        }
    }

    /**
     * Sends the newest photo (a quiet upload, kind=photo) and adds it to the history (how: "tile", "widget", "share").
     * held: the caller already counted this send as a transfer (Transfers.hold), which this releases when done.
     */
    static void sendLatestPhoto(final Context ctx, final String how, final boolean held, final Report r) {
        final Context c = ctx.getApplicationContext();
        boolean started = Bg.run("send photo", new Runnable() {
            @Override
            public void run() {
                PcClient.Target t = null;
                try {
                    if (!Files.granted(c)) { r.say("Allow Flick to see your files first"); return; }
                    AutoSendQueue.Item it = latestPhoto(c);
                    if (it == null) { r.say("No photos on this phone yet"); return; }
                    PcClient client = Bg.client(c);
                    t = client.target();
                    t.eager = true;                                  // the user is waiting: look for the PC now
                    ContentResolver cr = c.getContentResolver();
                    Uri u = Uri.parse(it.uri);
                    long size = it.size;
                    try {
                        android.os.ParcelFileDescriptor fd = cr.openFileDescriptor(u, "r");
                        if (fd != null) { if (fd.getStatSize() >= 0) size = fd.getStatSize(); fd.close(); }
                    } catch (Throwable e) { /* the index's size */ }
                    client.upload(t, Bg.uriSource(c, u, size), it.name, "photo", null);
                    Bg.historyAdd(c, "out", it.name, size, it.path, "image", how, true, t);
                    r.say("Sent " + it.name + " to " + t.name);
                } catch (Throwable e) {
                    r.say(Bg.why(e, t == null ? null : t.name));
                } finally {
                    if (held) Transfers.hold(c, false);
                }
            }
        });
        if (!started && held) Transfers.hold(c, false);
    }

    /** Sends a clipboard read with Clip.read() (POST /api/clip). */
    static void sendClipboard(Context ctx, final JSONObject clip, final Report r) {
        final Context c = ctx.getApplicationContext();
        String kind = clip == null ? "none" : clip.optString("kind", "none");
        if (!"text".equals(kind) && !"image".equals(kind)) {
            r.say(clip != null && clip.optBoolean("sensitive", false) ? "That was copied as private: Flick leaves it on the phone" : "Your clipboard is empty");
            return;
        }
        Bg.run("send clipboard", new Runnable() {
            @Override
            public void run() {
                PcClient.Target t = null;
                try {
                    PcClient client = Bg.client(c);
                    t = client.target();
                    t.eager = true;
                    JSONObject body = new JSONObject();
                    String k = clip.optString("kind");
                    body.put("kind", k);
                    if ("text".equals(k)) body.put("text", clip.optString("text", ""));
                    else body.put("png", clip.optString("png", ""));
                    client.post(t, "/api/clip", null, body);
                    r.say(("text".equals(k) ? "Copied to " : "Image copied to ") + t.name);
                } catch (Throwable e) {
                    r.say(Bg.why(e, t == null ? null : t.name));
                }
            }
        });
    }
}
