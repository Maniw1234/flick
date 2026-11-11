package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Auto-send's memory: which new screenshots / photos it has already taken care of, and the ones still to send (sent
 * oldest first, at most MAX waiting: older ones are given up). A media item is new when it was added after the
 * feature was turned on; the media index can show an item late (a camera app writes a video for minutes before it
 * appears), so each look covers the last SLACK seconds again and skips what it already took. No Android classes, so it
 * runs on any JVM; AutoSend feeds it what the media index shows.
 */
final class AutoSendQueue {
    static final int MAX = 50;
    static final int MAX_TRIES = 5;
    static final long SLACK = 6 * 3600;              // seconds
    static final int MAX_DONE = 2000;

    /** One screenshot, photo or video (as the media index shows it). */
    static final class Item {
        String key;            // "i:<id>" (image) or "v:<id>" (video)
        String uri;            // content:// address to read it from
        String path;           // its file (for history: Open / Show in folder), may be ""
        String name, mime, kind;
        long size, added;      // added: seconds (MediaStore DATE_ADDED)
        long taken;            // ms (DATE_TAKEN), 0 when unknown
        int tries;
        // its transfer to the PC so far (a PC that keeps what arrived): the next try carries on with it, and one whose
        // answer was lost hears that the PC has it instead of sending it again
        PcClient.Resume up = new PcClient.Resume();

        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("key", key); o.put("uri", uri); o.put("path", path == null ? "" : path);
                o.put("name", name); o.put("mime", mime == null ? "" : mime); o.put("kind", kind);
                o.put("size", size); o.put("added", added); o.put("taken", taken); o.put("tries", tries);
                if (up.tid != null) o.put("up", up.json());
            } catch (Exception e) { /* can't fail */ }
            return o;
        }

        static Item of(JSONObject o) {
            Item it = new Item();
            it.key = o.optString("key", "");
            it.uri = o.optString("uri", "");
            it.path = o.optString("path", "");
            it.name = o.optString("name", "file");
            it.mime = o.optString("mime", "");
            it.kind = o.optString("kind", "photo");
            it.size = o.optLong("size", 0);
            it.added = o.optLong("added", 0);
            it.taken = o.optLong("taken", 0);
            it.tries = o.optInt("tries", 0);
            it.up = PcClient.Resume.of(o.optJSONObject("up"));
            return it;
        }
    }

    long floor;                                       // seconds: the feature was turned on; nothing older is sent
    long since;                                       // seconds: where the next look starts
    long top;                                         // the highest media id taken care of (one numbering for all media)
    // after the clock went back: what was taken care of before then (media ids up to fence) can show again in looks
    // (the overlap moved back with the clock; and what was stamped while the clock ran ahead, up to fenceUntil, shows
    // until the clock gets there) but isn't sent again; 0 when there's no such window
    long fence, fenceUntil;
    final LinkedHashMap<String, Long> done = new LinkedHashMap<String, Long>();   // key -> added, for items >= since
    final ArrayList<Item> outbox = new ArrayList<Item>();

    /** A fresh start: nothing before now is ever sent. */
    static AutoSendQueue start(long nowSec) {
        AutoSendQueue q = new AutoSendQueue();
        q.floor = nowSec;
        q.since = nowSec;
        return q;
    }

    /**
     * The items among rows (what the media index shows for date_added >= since) that are new: put at the end of the
     * outbox. Returns the items given up because the outbox was full (oldest first).
     */
    List<Item> offer(List<Item> rows, long nowSec) {
        List<Item> dropped = new ArrayList<Item>();
        for (Item it : rows) {
            if (it == null || it.key == null || it.key.length() == 0) continue;
            if (done.containsKey(it.key) || waiting(it.key)) continue;
            if (fenceUntil > 0 && idOf(it.key) <= fence) { took(it); continue; }
            if (it.added < floor) continue;
            // copied in now but taken long before (a restore from a backup): not a new screenshot or photo
            if (it.taken > 0 && it.taken < (floor - 86400) * 1000L) { took(it); continue; }
            took(it);
            outbox.add(it);
            while (outbox.size() > MAX) dropped.add(outbox.remove(0));
        }
        return dropped;
    }

    /** It reached the PC. */
    void sent(Item it) { remove(it.key); }

    /** It couldn't be sent for a reason of its own (not because the PC is away): true when it's given up now. */
    boolean failed(Item it) {
        it.tries++;
        if (it.tries < MAX_TRIES) return false;
        remove(it.key);
        return true;
    }

    /** It's gone from the phone (deleted before it could be sent). */
    void gone(Item it) { remove(it.key); }

    private void took(Item it) {
        done.put(it.key, it.added);
        top = Math.max(top, idOf(it.key));
    }

    /** The media id in a key ("i:<id>", "v:<id>"), or 0. */
    static long idOf(String key) {
        try { return Long.parseLong(key.substring(key.indexOf(':') + 1)); } catch (Exception e) { return 0; }
    }

    /**
     * Before a look: a clock that went back (set right after running ahead, or set by hand) takes where the look starts
     * back with it. Kept ahead, the media index was asked for photos added after a time the clock hadn't reached, and
     * screenshots taken meanwhile were never sent. The overlap then may hold what was sent before the clock ran ahead,
     * no longer remembered by key: fenced off by its media id (ids only grow).
     */
    void clock(long nowSec) {
        if (since <= nowSec) return;
        // (what a look forgot by key was added before since: until the looks are past it, it's fenced off by id)
        fence = Math.max(fence, top);
        fenceUntil = Math.max(fenceUntil, since);
        floor = Math.min(floor, nowSec);
        since = Math.max(floor, nowSec - SLACK);
    }

    /** After a look at the media index: the next one starts SLACK seconds before now (never before floor). */
    void advance(long nowSec) {
        clock(nowSec);
        since = Math.max(since, Math.max(floor, nowSec - SLACK));
        if (fenceUntil > 0 && since > fenceUntil) { fence = 0; fenceUntil = 0; }   // its window is behind every look
        Iterator<Map.Entry<String, Long>> it = done.entrySet().iterator();
        while (it.hasNext()) if (it.next().getValue() < since) it.remove();
        it = done.entrySet().iterator();
        while (done.size() > MAX_DONE && it.hasNext()) { it.next(); it.remove(); }
    }

    List<Item> waitingItems() { return new ArrayList<Item>(outbox); }

    /**
     * Sends one item: to a PC that keeps what arrived (resumable), in a part that carries on after a cut, and that
     * doesn't go twice when the PC's answer was lost (keep writes the item's progress down: see PcClient.Resume); to an
     * older PC, in one request. sig: the file as it is now ("<size>:<modified>"). The PC's answer.
     */
    static JSONObject send(PcClient client, PcClient.Target t, Item it, PcClient.Source src, String sig, boolean resumable, Runnable keep,
                           AtomicBoolean stop) throws PcClient.Failure {
        if (resumable) return client.uploadResumable(t, src, it.name, it.kind, sig, it.up, keep, stop);
        return client.upload(t, src, it.name, it.kind, stop);
    }

    private boolean waiting(String key) {
        for (Item x : outbox) if (key.equals(x.key)) return true;
        return false;
    }

    private void remove(String key) {
        Iterator<Item> it = outbox.iterator();
        while (it.hasNext()) if (key.equals(it.next().key)) it.remove();
    }

    // ------------------------------------------------------------ saved as JSON (AutoSend: autosend.json)
    String toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("floor", floor);
            o.put("since", since);
            if (top > 0) o.put("top", top);
            if (fenceUntil > 0) { o.put("fence", fence); o.put("fenceUntil", fenceUntil); }
            JSONObject d = new JSONObject();
            for (Map.Entry<String, Long> e : done.entrySet()) d.put(e.getKey(), (long) e.getValue());
            o.put("done", d);
            JSONArray a = new JSONArray();
            for (Item it : outbox) a.put(it.json());
            o.put("outbox", a);
        } catch (Exception e) { /* can't fail */ }
        return o.toString();
    }

    static AutoSendQueue fromJson(String s, long nowSec) {
        if (s == null || s.length() == 0) return start(nowSec);
        try {
            JSONObject o = new JSONObject(s);
            AutoSendQueue q = new AutoSendQueue();
            q.floor = o.optLong("floor", nowSec);
            q.since = o.optLong("since", q.floor);
            q.top = o.optLong("top", 0);
            q.fence = o.optLong("fence", 0);
            q.fenceUntil = o.optLong("fenceUntil", 0);
            JSONObject d = o.optJSONObject("done");
            if (d != null) {
                Iterator<String> k = d.keys();
                while (k.hasNext()) { String key = k.next(); q.done.put(key, d.optLong(key, 0)); }
            }
            JSONArray a = o.optJSONArray("outbox");
            if (a != null) for (int i = 0; i < a.length() && q.outbox.size() < MAX; i++) {
                JSONObject x = a.optJSONObject(i);
                if (x != null) q.outbox.add(Item.of(x));
            }
            return q;
        } catch (Exception e) {
            return start(nowSec);
        }
    }
}
