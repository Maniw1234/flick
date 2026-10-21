package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("key", key); o.put("uri", uri); o.put("path", path == null ? "" : path);
                o.put("name", name); o.put("mime", mime == null ? "" : mime); o.put("kind", kind);
                o.put("size", size); o.put("added", added); o.put("taken", taken); o.put("tries", tries);
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
            return it;
        }
    }

    long floor;                                       // seconds: the feature was turned on; nothing older is sent
    long since;                                       // seconds: where the next look starts
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
            if (it.added < floor) continue;
            // copied in now but taken long before (a restore from a backup): not a new screenshot or photo
            if (it.taken > 0 && it.taken < (floor - 86400) * 1000L) { done.put(it.key, it.added); continue; }
            done.put(it.key, it.added);
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

    /** After a look at the media index: the next one starts SLACK seconds before now (never before floor). */
    void advance(long nowSec) {
        since = Math.max(since, Math.max(floor, nowSec - SLACK));
        Iterator<Map.Entry<String, Long>> it = done.entrySet().iterator();
        while (it.hasNext()) if (it.next().getValue() < since) it.remove();
        it = done.entrySet().iterator();
        while (done.size() > MAX_DONE && it.hasNext()) { it.next(); it.remove(); }
    }

    List<Item> waitingItems() { return new ArrayList<Item>(outbox); }

    private boolean waiting(String key) {
        for (Item x : outbox) if (key.equals(x.key)) return true;
        return false;
    }

    private void remove(String key) {
        Iterator<Item> it = outbox.iterator();
        while (it.hasNext()) if (key.equals(it.next().key)) it.remove();
    }

    // ------------------------------------------------------------ saved in prefs as JSON
    String toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("floor", floor);
            o.put("since", since);
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
