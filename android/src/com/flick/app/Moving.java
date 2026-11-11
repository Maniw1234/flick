package com.flick.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

/**
 * Everything moving between this phone and another device, both ways, in one list: sends to a PC (Sends, and the
 * page's own uploads to an older one), files from the PC (Transfers), sends to another phone and files from one
 * (Peers). The notifications (TransferService: one per transfer) and the page (Settings › Transfers, the Transfers
 * page) show it. Callers tell it what happens from any thread, as often as bytes move: what goes on to the page (at
 * most every 250 ms) and to the notifications (each at most twice a second, and all of them together at most about
 * four times: Android drops updates past five a second) is paced here. Finished ones stay listed for 10 minutes (the
 * last 30). No Android classes (the Context is the callers'; the Hook brings the screen and the clock), so it runs on
 * any JVM.
 *
 * Keys: pc-out:<tid> (sends to the PC), pc-in:<fid> (files from the PC), ph-out:<device>:<tid> (sends to another
 * device's receiver), ph-in:<tid> (files to this phone's receiver).
 */
final class Moving {
    /** What shows the list. Called from any thread, never under Moving's lock (note and gone one at a time, in order). */
    interface Hook {
        /** ms, for pacing (never jumps). */
        long clock();
        /** ms since 1970, for the times shown. */
        long wall();
        /** r once, about ms from now, on a thread of the hook's. */
        void later(Runnable r, long ms);
        /** The page is due news of the list (snapshot()). */
        void page();
        /** A transfer's notification is due (it: a copy, as it is now). */
        void note(Item it);
        /** A transfer ended (it: a copy, with ended, ok, why): its notification goes. */
        void gone(Item it);
    }

    static final long PAGE_MS = 250;          // the page hears at most this often
    static final long NOTE_MS = 500;          // a transfer's notification changes at most this often
    static final long NOTE_GAP_MS = 250;      // and any notification at most this often
    static final long FIRST_NOTE_MS = 400;    // one that's over in a moment never flashes a notification
    static final long KEEP_MS = 10 * 60000L;  // finished ones stay listed this long
    static final int KEEP = 30;               // at most this many
    static final long RATE_MS = 500;          // the speed is measured over this long at least
    static final long STILL_MS = 3000;        // nothing moved for this long: no speed to show
    static final long CANCEL_MS = 15000;      // a Cancel on its way: tapped again meanwhile, it isn't run again

    /** One transfer. Its fields are read under LOCK, or on a copy (copy()). */
    static final class Item {
        final String key, dir, device;
        String deviceName, kind, name, current, state = "running", why;
        String there;                         // canceled on the other device: the words that say so, for its note
        int files;
        long done, total = -1, started, ended;
        double rate;
        boolean ok;
        Runnable cancel;
        boolean cancelable;
        boolean canceling;                    // its Cancel is on its way (since canceledAt)
        long canceledAt;
        // pacing
        long born, notedAt = Long.MIN_VALUE, movedAt, rateT = Long.MIN_VALUE, rateB;
        int notedPct = Integer.MIN_VALUE;
        String notedState;
        boolean notedCancel;                  // its notification, as last shown, had a Cancel
        boolean dirty;

        Item(String key, String dir, String device) { this.key = key; this.dir = dir; this.device = device; }

        Item copy() {
            Item c = new Item(key, dir, device);
            c.deviceName = deviceName; c.kind = kind; c.name = name; c.current = current; c.state = state; c.why = why; c.there = there;
            c.files = files; c.done = done; c.total = total; c.started = started; c.ended = ended; c.rate = rate; c.ok = ok;
            c.cancelable = cancel != null;
            return c;
        }

        /** 0-100, or -1 while the size isn't known. */
        int pct() { return total > 0 ? (int) Math.min(100, Math.max(0, done) * 100 / total) : -1; }

        JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("key", key); o.put("dir", dir); o.put("device", device); o.put("deviceName", deviceName); o.put("kind", kind);
                o.put("name", name); o.put("files", files); o.put("done", done); o.put("total", total); o.put("rate", Math.round(rate));
                o.put("state", state); o.put("started", started); o.put("cancel", cancel != null || cancelable);
                if (current != null) o.put("current", current);
                if (why != null) o.put("why", why);
                if (there != null) o.put("there", there);
                if (ended > 0) { o.put("ended", ended); o.put("ok", ok); }
            } catch (Exception e) { /* as far as it got */ }
            return o;
        }
    }

    private static final Object LOCK = new Object();
    // a notification due and an end are told the hook one at a time: none is due for a transfer after its end was told
    private static final Object TELL = new Object();
    private static volatile Hook hook;
    private static final Map<String, Item> now = new LinkedHashMap<String, Item>();      // live ones, oldest first
    private static final LinkedList<Item> recent = new LinkedList<Item>();               // ended ones, newest first
    private static boolean pageDirty;
    private static long pageAt = Long.MIN_VALUE / 4, noteAt = Long.MIN_VALUE / 4;
    // the pacing run asked for next (its number and when): a run asked for earlier replaces it, one that comes late
    // finds it isn't the one asked for and does nothing
    private static long wakeAt = Long.MAX_VALUE, wakeSeq, seq;

    private Moving() {}

    /** The app's hook (TransferService.Shown), or a test's; null: nothing is shown (the list is still kept). */
    static void install(Hook h) {
        hook = h;
        synchronized (LOCK) { wakeAt = Long.MAX_VALUE; pageDirty = true; for (Item it : now.values()) it.dirty = true; ask(h, clock(h), clock(h)); }
    }

    // ------------------------------------------------------------ what the transfers say
    /**
     * A transfer starts (or, for a key under way, what it is changed: the rest stays). dir "in" | "out"; kind of the
     * other device "pc" | "phone"; name: the file's, the folder's, or "3 files"; files: how many; total: bytes, -1 when
     * not known yet. c: the app's, for callers' convenience (the hook knows the rest).
     */
    static void start(Context c, String key, String dir, String device, String deviceName, String kind, String name, int files, long total) {
        if (key == null) return;
        Hook h = hook;
        synchronized (LOCK) {
            long t = clock(h);
            Item it = now.get(key);
            if (it == null) {
                // (the same key again after it ended: a send tried again is a new transfer)
                for (Iterator<Item> i = recent.iterator(); i.hasNext(); ) if (i.next().key.equals(key)) i.remove();
                it = new Item(key, "in".equals(dir) ? "in" : "out", device == null ? "" : device);
                it.started = wall(h);
                it.born = t; it.movedAt = t;
                now.put(key, it);
            }
            String dn = clean(deviceName, 80), n = clean(name, 300);
            if (n.length() == 0) n = "File";
            // (what it's called is in its notification: a new name shows)
            if (!n.equals(it.name) || !dn.equals(it.deviceName)) it.dirty = true;
            it.deviceName = dn;
            it.kind = "pc".equals(kind) ? "pc" : "phone";
            it.name = n;
            it.files = Math.max(1, files);
            if (total >= 0) it.total = total;
            changed(h, it, t);
        }
    }

    /** Bytes so far (and the total, when it's known now: -1 keeps the one there). Cheap: any thread, any often. */
    static void update(String key, long done, long total) {
        if (key == null) return;
        Hook h = hook;
        synchronized (LOCK) {
            Item it = now.get(key);
            if (it == null) return;
            long t = clock(h);
            if (done < it.done || it.rateT == Long.MIN_VALUE || t - it.rateT > STILL_MS) { it.rateT = t; it.rateB = done; if (done < it.done || t - it.movedAt > STILL_MS) it.rate = 0; }
            else if (t - it.rateT >= RATE_MS) {
                double inst = (done - it.rateB) * 1000.0 / (t - it.rateT);
                it.rate = it.rate <= 0 ? inst : it.rate * 0.6 + inst * 0.4;
                it.rateT = t; it.rateB = done;
            }
            if (done != it.done) it.movedAt = t;
            boolean news = done != it.done || (total >= 0 && total != it.total);
            it.done = Math.max(0, done);
            if (total >= 0) it.total = total;
            if (news) changed(h, it, t);
        }
    }

    /** Which file of a batch is going now. */
    static void current(String key, String name) {
        if (key == null) return;
        Hook h = hook;
        synchronized (LOCK) {
            Item it = now.get(key);
            if (it == null) return;
            String n = name == null ? null : clean(name, 300);
            if (n != null && n.length() == 0) n = null;
            if (n == null ? it.current == null : n.equals(it.current)) return;
            it.current = n;
            it.dirty = true;
            changed(h, it, clock(h));
        }
    }

    /** "running" | "waiting" (for the other device: it isn't there, or its user is asked) | "paused". */
    static void state(String key, String state) {
        if (key == null || !("running".equals(state) || "waiting".equals(state) || "paused".equals(state))) return;
        Hook h = hook;
        synchronized (LOCK) {
            Item it = now.get(key);
            if (it == null || state.equals(it.state)) return;
            it.state = state;
            if (!"running".equals(state)) it.rate = 0;
            changed(h, it, clock(h));
        }
    }

    /** It's over: ok, or why not (words for the user; "canceled" when it was canceled; null when there are none). */
    static void end(String key, boolean ok, String why) { end(key, ok, why, null); }

    /**
     * The same; there: for one canceled on the other device, the words that say so ("Canceled on Pixel 7"), so its note
     * tells the user (one canceled here needs none: they did it).
     */
    static void end(String key, boolean ok, String why, String there) {
        if (key == null) return;
        Hook h = hook;
        Item gone;
        synchronized (LOCK) {
            Item it = now.remove(key);
            if (it == null) return;                                   // (never started, or ended already)
            long t = clock(h);
            it.ended = Math.max(it.started, wall(h));
            it.ok = ok;
            it.why = ok ? null : why == null || why.trim().length() == 0 ? null : "canceled".equals(why) ? why : clean(why, 400);
            it.state = ok ? "done" : "canceled".equals(it.why) ? "canceled" : "failed";
            it.there = "canceled".equals(it.state) && there != null && there.trim().length() > 0 ? clean(there, 400) : null;
            it.cancel = null;
            it.rate = 0;
            if (ok && it.total > 0) it.done = it.total;
            recent.addFirst(it);
            prune(it.ended);
            pageDirty = true;
            ask(h, t, Math.max(t, pageAt + PAGE_MS));
            gone = it.copy();
        }
        if (h != null) synchronized (TELL) { try { h.gone(gone); } catch (Throwable e) { /* only the notification */ } }
    }

    /** What its Cancel (notification, Settings) does. */
    static void onCancel(String key, Runnable r) {
        if (key == null) return;
        Hook h = hook;
        synchronized (LOCK) {
            Item it = now.get(key);
            if (it == null) return;
            boolean was = it.cancel != null;
            it.cancel = r;
            if (r == null) it.canceling = false;
            if (was != (r != null)) changed(h, it, clock(h));
        }
    }

    /**
     * Cancel: runs what its transfer said it does (on this thread), once: tapped again (in the notification and in Settings,
     * say) while it's on its way, nothing more runs (it could stop the next transfer to that device); one that came to
     * nothing in CANCEL_MS can be tried again. False when it's over, can't be canceled, or is being canceled.
     */
    static boolean cancel(String key) {
        if (key == null) return false;
        Hook h = hook;
        Runnable r;
        synchronized (LOCK) {
            Item it = now.get(key);
            r = it == null ? null : it.cancel;
            if (r == null) return false;
            long t = clock(h);
            if (it.canceling && t - it.canceledAt < CANCEL_MS) return false;
            it.canceling = true;
            it.canceledAt = t;
        }
        try { r.run(); } catch (Throwable e) { /* it ends as it does */ }
        return true;
    }

    /**
     * cancel(), on a thread of its own: for a button (a notification's, the page's), whose caller mustn't wait for a
     * connection to close or the other device to be told.
     */
    static void cancelSoon(final String key) {
        if (key == null) return;
        Thread t = new Thread(new Runnable() { @Override public void run() { cancel(key); } }, "flick-cancel");
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------ what's shown
    /** { now: [items, oldest first], recent: [items that ended, newest first, the last 10 minutes] }. */
    static JSONObject snapshot() {
        Hook h = hook;
        JSONArray n = new JSONArray(), r = new JSONArray();
        synchronized (LOCK) {
            long t = clock(h);
            prune(wall(h));
            for (Item it : now.values()) { JSONObject o = it.json(); try { o.put("rate", Math.round(speed(it, t))); } catch (Exception e) { /* */ } n.put(o); }
            for (Item it : recent) r.put(it.json());
        }
        JSONObject o = new JSONObject();
        try { o.put("now", n); o.put("recent", r); } catch (Exception e) { /* can't fail */ }
        return o;
    }

    /** Copies of the transfers under way, oldest first (what the notifications show). */
    static List<Item> live() {
        Hook h = hook;
        List<Item> out = new ArrayList<Item>();
        synchronized (LOCK) {
            long t = clock(h);
            for (Item it : now.values()) { Item c = it.copy(); c.rate = speed(it, t); out.add(c); }
        }
        return out;
    }

    /** One under way (a copy), or null. */
    static Item get(String key) {
        synchronized (LOCK) { Item it = key == null ? null : now.get(key); return it == null ? null : it.copy(); }
    }

    // ------------------------------------------------------------ pacing
    // Under LOCK: what the page or the notification shows of it changed (the notification only for a new percent, state,
    // name, or a byte count that isn't a percentage yet).
    private static void changed(Hook h, Item it, long t) {
        pageDirty = true;
        int pct = it.pct();
        boolean noteNews = pct != it.notedPct || !it.state.equals(it.notedState) || it.notedAt == Long.MIN_VALUE
            || (pct < 0 && it.done > 0) || it.notedCancel != (it.cancel != null);
        if (noteNews) it.dirty = true;
        if (h == null) return;
        long due = Math.max(t, pageAt + PAGE_MS);
        if (it.dirty) due = Math.min(due, Math.max(dueOf(it), noteAt + NOTE_GAP_MS));
        ask(h, t, due);
    }

    private static long dueOf(Item it) { return it.notedAt == Long.MIN_VALUE ? it.born + FIRST_NOTE_MS : it.notedAt + NOTE_MS; }

    // Under LOCK: a pacing run at `at` (unless one is asked for by then).
    private static void ask(Hook h, long t, long at) {
        if (h == null || at >= wakeAt) return;
        final long my = ++seq;
        wakeAt = at;
        wakeSeq = my;
        try { h.later(new Runnable() { @Override public void run() { tick(my); } }, Math.max(0, at - t)); }
        catch (Throwable e) { wakeAt = Long.MAX_VALUE; }
    }

    // A pacing run: the page, if it's due, and the notification waiting longest, if it may change now.
    static void tick(long my) {
        Hook h = hook;
        if (h == null) return;
        boolean page = false;
        Item note = null, of = null;
        synchronized (LOCK) {
            long t = clock(h);
            if (my != wakeSeq && t < wakeAt) return;                  // (one asked for since replaced it)
            wakeAt = Long.MAX_VALUE;
            if (pageDirty && t - pageAt >= PAGE_MS) { pageDirty = false; pageAt = t; page = true; }
            if (t - noteAt >= NOTE_GAP_MS) {
                Item best = null;
                for (Item it : now.values()) {
                    if (!it.dirty || dueOf(it) > t) continue;
                    if (best == null || it.notedAt < best.notedAt) best = it;   // the one waiting longest first
                }
                if (best != null) {
                    best.dirty = false; best.notedAt = t; best.notedPct = best.pct(); best.notedState = best.state; best.notedCancel = best.cancel != null;
                    noteAt = t;
                    note = best.copy();
                    note.rate = speed(best, t);
                    of = best;
                }
            }
            long next = pageDirty ? pageAt + PAGE_MS : Long.MAX_VALUE;
            for (Item it : now.values()) if (it.dirty) next = Math.min(next, Math.max(dueOf(it), noteAt + NOTE_GAP_MS));
            if (next != Long.MAX_VALUE) ask(h, t, Math.max(next, t + 1));
        }
        if (page) { try { h.page(); } catch (Throwable e) { /* only the page */ } }
        if (note != null) {
            // (still under way as it's told: one that ended meanwhile, on its own thread, was told gone, or will be after)
            synchronized (TELL) {
                boolean live;
                synchronized (LOCK) { live = now.get(note.key) == of; }
                if (live) { try { h.note(note); } catch (Throwable e) { /* only the notification */ } }
            }
        }
    }

    // Under LOCK: the ended ones from the last 10 minutes, the last 30 at most.
    private static void prune(long wall) {
        while (recent.size() > KEEP) recent.removeLast();
        for (Iterator<Item> i = recent.iterator(); i.hasNext(); ) {
            Item it = i.next();
            if (wall - it.ended > KEEP_MS || it.ended - wall > KEEP_MS) i.remove();   // (or a clock set back far)
        }
    }

    // bytes a second now (none when nothing moved for a while, or it isn't running)
    private static double speed(Item it, long t) { return "running".equals(it.state) && t - it.movedAt < STILL_MS ? Math.max(0, it.rate) : 0; }

    private static long clock(Hook h) { return h != null ? h.clock() : System.nanoTime() / 1000000L; }
    private static long wall(Hook h) { return h != null ? h.wall() : System.currentTimeMillis(); }

    /**
     * A name as the list shows it: text only, without control or direction characters (a name from the network could
     * otherwise turn the words around it backwards), at most max characters.
     */
    static String clean(String s, int max) {
        if (s == null) return "";
        String c = s.replaceAll("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]", "").trim();
        if (c.length() > max) c = c.substring(0, Character.isHighSurrogate(c.charAt(max - 1)) ? max - 1 : max).trim();
        return c;
    }

    /** "IMG_2041.jpg", "Trip" (a folder), "3 files" or "3 items" (some are folders): what a send of items is called. */
    static String what(List<String> names, int items, int files) {
        if (items <= 1 && names != null && !names.isEmpty()) return names.get(0);
        return items + (files == items ? " files" : " items");
    }

    /** (tests) Everything forgotten. */
    static void reset() {
        synchronized (LOCK) { now.clear(); recent.clear(); pageDirty = false; pageAt = noteAt = Long.MIN_VALUE / 4; wakeAt = Long.MAX_VALUE; }
    }
}
