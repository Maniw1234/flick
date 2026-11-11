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
 * clipboard, to the paired PC, or to the phone picked as where flicks go. Each answers with a short sentence for a
 * toast ("Sent to <PC>", or why not).
 */
final class Actions {
    interface Report { void say(String msg); }

    private Actions() {}

    /**
     * The phone a one-tap send goes to: the one picked on the page as where flicks go (its pref 'target'), while it's
     * paired; with no PC paired, the only phone paired. null: the PC.
     */
    static String phoneTarget(Context c) {
        try {
            android.content.SharedPreferences p = Bg.prefs(c);
            JSONObject t = new JSONObject(p.getString("p:target", "").length() > 0 ? p.getString("p:target", "") : "{}");
            String id = "phone".equals(t.optString("kind")) ? t.optString("id", "") : "";
            Peers ps = Peers.get(c);
            if (id.length() > 0 && ps.paired(id)) return id;
            String pc = p.getString("p:lastPc", "");
            if (pc.length() > 0 && p.getString("p:token:" + pc, "").length() > 0) return null;
            return ps.onlyPaired();
        } catch (Throwable e) { return null; }
    }

    /** What to say when something didn't reach another phone (PeerClient.message's why). */
    static String peerWhy(String why, String name) {
        if ("old".equals(why)) return "Update Flick on " + name + " first";
        if ("unpaired".equals(why)) return name + " isn’t paired with this phone any more";
        if ("auth".equals(why)) return name + " doesn’t know this phone any more. Remove it and pair again.";
        if ("busy".equals(why)) return "That was a lot at once. Try again in a minute.";
        if ("too big".equals(why)) return "That’s too big to send";
        if ("quiet".equals(why)) return name + " was found a moment ago";
        if ("empty".equals(why) || "bad".equals(why) || "refused".equals(why)) return name + " couldn’t take that";
        return "Couldn’t reach " + name + ". Open Flick on it, on the same Wi-Fi.";
    }

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
        boolean started = Bg.send("send photo", new Runnable() {
            @Override
            public void run() {
                PcClient.Target t = null;
                try {
                    if (!Files.granted(c)) { r.say("Allow Flick to see your files first"); return; }
                    AutoSendQueue.Item it = latestPhoto(c);
                    if (it == null) { r.say("No photos on this phone yet"); return; }
                    // to a phone: sent like a flick there (its progress, History and the answer come from Peers)
                    String phone = phoneTarget(c);
                    if (phone != null) {
                        Peers ps = Peers.get(c);
                        String nm = ps.nameOf(phone);
                        String res = it.path == null ? "none" : ps.send(phone, new org.json.JSONArray().put(new JSONObject().put("path", it.path)).toString());
                        r.say("ok".equals(res) ? "Sending " + it.name + " to " + nm + "…" : "busy".equals(res) ? "Wait until what’s going to " + nm + " is sent"
                            : "unpaired".equals(res) ? peerWhy("unpaired", nm) : "That photo can’t be sent from here");
                        return;
                    }
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

    static final String TOO_MUCH_TEXT = "That’s too much text to send (over 1 MB)";

    /**
     * Sends a clipboard read with Clip.read() (POST /api/clip), to where one-tap sends go (phoneTarget). over: what lets
     * go of the hold the caller took for it (hold()), run once the send is over.
     */
    static void sendClipboard(Context ctx, final JSONObject clip, Runnable over, final Report r) { sendClipboard(ctx, clip, phoneTarget(ctx), over, r); }

    /** The same, to a paired phone (phone: its id), or to the PC (null). */
    static void sendClipboard(Context ctx, final JSONObject clip, final String phone, final Report r) { sendClipboard(ctx, clip, phone, null, r); }

    static void sendClipboard(Context ctx, final JSONObject clip, final String phone, Runnable held, final Report r) {
        final Context c = ctx.getApplicationContext();
        final Runnable over = held == null ? NOTHING : held;
        String kind = clip == null ? "none" : clip.optString("kind", "none");
        if (!"text".equals(kind) && !"image".equals(kind)) {
            over.run();
            r.say(clip != null && clip.optBoolean("sensitive", false) ? "That was copied as private: Flick leaves it on the phone" : "Your clipboard is empty");
            return;
        }
        if (clip.optBoolean("tooBig", false)) {               // (Clip: over 1 MB) never sent cut short without a word
            over.run();
            r.say(TOO_MUCH_TEXT);
            return;
        }
        if (phone != null) {
            String nm = "the other phone";
            try {
                final Peers ps = Peers.get(c);
                nm = ps.nameOf(phone);
                final String name = nm, k = kind;
                final boolean priv = clip.optBoolean("sensitive", false);
                final JSONObject body = new JSONObject();
                try {
                    body.put("kind", k);
                    if ("text".equals(k)) body.put("text", clip.optString("text", "")); else body.put("png", clip.optString("png", ""));
                    if (priv) body.put("private", true);         // an app marked it private: the other phone keeps no history of it
                } catch (Exception e) { over.run(); r.say("Your clipboard is empty"); return; }
                ps.message(phone, "clip", body.toString(), null, new PeerClient.Done() {
                    @Override public void done(String why) {
                        try {
                            if (why != null) { r.say(peerWhy(why, name)); return; }
                            if (!priv) ClipHistory.add(c, "out", body, phone, name);
                            r.say(("text".equals(k) ? "Copied to " : "Image copied to ") + name);
                        } finally { over.run(); }
                    }
                });
            } catch (Throwable e) {
                over.run();
                r.say(peerWhy("unreachable", nm));
            }
            return;
        }
        boolean started = Bg.send("send clipboard", new Runnable() {
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
                    boolean priv = clip.optBoolean("sensitive", false);
                    if (priv) body.put("private", true);             // an app marked it private: the PC keeps no history of it
                    client.post(t, "/api/clip", null, body);
                    if (!priv) ClipHistory.add(c, "out", body, t.id, t.name);
                    r.say(("text".equals(k) ? "Copied to " : "Image copied to ") + t.name);
                } catch (Throwable e) {
                    r.say(Bg.why(e, t == null ? null : t.name));
                } finally {
                    over.run();
                }
            }
        });
        if (!started) over.run();
    }

    private static final Runnable NOTHING = new Runnable() { @Override public void run() { } };

    /**
     * Counts a send as a transfer (Transfers.hold): Flick keeps running, with the transfer service, where Android would
     * otherwise soon stop an app that isn't in front. Taken while Flick is in front (Android 12+ starts the service only
     * then). Returns what lets go of it, once however often it's run: let go of twice, it would take another transfer's
     * hold with it.
     */
    static Runnable hold(Context ctx) {
        final Context c = ctx.getApplicationContext();
        Transfers.hold(c, true);
        final java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean();
        return new Runnable() { @Override public void run() { if (done.compareAndSet(false, true)) Transfers.hold(c, false); } };
    }
}
