package com.flick.app;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * When phone notifications go to the PC: at most PER_SECOND per app in any second. A burst (a chat app posting ten
 * updates at once) sends the first ones now; for the rest only the newest version of each notification waits, and goes
 * when its app has room again. A removal goes at once, and only for a notification the PC was shown. No Android
 * classes, so it runs on any JVM.
 */
final class NotifyGate {
    static final int PER_SECOND = 2;
    static final int KEEP_KEYS = 500;
    // what waits at most: an app flooding new notifications (each one new) leaves only its own newest KEEP_PER_APP
    // waiting (its oldest wouldn't be news by the time they went), so no other app's make way for its flood; all apps
    // together at most KEEP_WAITING (then the app with the most waiting loses its oldest), so that what's kept never
    // slows down handling each new one
    static final int KEEP_PER_APP = 100;
    static final int KEEP_WAITING = 500;

    private static final class Waiting {
        final String pkg;
        final JSONObject n;
        Waiting(String pkg, JSONObject n) { this.pkg = pkg; this.n = n; }
    }

    private final int perSecond;
    private final HashMap<String, ArrayDeque<Long>> sends = new HashMap<String, ArrayDeque<Long>>();   // app -> recent sends
    private final LinkedHashMap<String, Waiting> waiting = new LinkedHashMap<String, Waiting>();      // key -> newest version
    private final HashMap<String, LinkedHashSet<String>> waitingOf = new HashMap<String, LinkedHashSet<String>>();   // app -> its keys
    private final LinkedHashMap<String, Boolean> shown = new LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        private static final long serialVersionUID = 1L;
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > KEEP_KEYS; }
    };

    NotifyGate() { this(PER_SECOND); }
    NotifyGate(int perSecond) { this.perSecond = Math.max(1, perSecond); }

    /** A notification posted or updated (now: a clock in ms): what to send right away (it, or nothing: it waits). */
    synchronized List<JSONObject> posted(String pkg, String key, JSONObject n, long now) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        if (waiting.containsKey(key) || !room(pkg, now)) {
            hold(pkg, key, n);
            return out;
        }
        take(pkg, now);
        shown.put(key, Boolean.TRUE);
        out.add(n);
        return out;
    }

    /** A notification removed: its removal to send, if the PC was shown it (a waiting version is simply dropped). */
    synchronized List<JSONObject> removed(String key, JSONObject n) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        drop(key);
        if (shown.remove(key) != null) out.add(n);
        return out;
    }

    /** The waiting notifications whose app has room now (oldest first). */
    synchronized List<JSONObject> due(long now) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        Iterator<Map.Entry<String, Waiting>> it = waiting.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Waiting> e = it.next();
            Waiting w = e.getValue();
            if (!room(w.pkg, now)) continue;
            take(w.pkg, now);
            shown.put(e.getKey(), Boolean.TRUE);
            out.add(w.n);
            it.remove();
            unlist(w.pkg, e.getKey());
        }
        return out;
    }

    /** ms until the next waiting notification can go; -1 when none waits. */
    synchronized long next(long now) {
        long best = -1;
        for (String pkg : waitingOf.keySet()) {
            long d = waitFor(pkg, now);
            if (best < 0 || d < best) best = d;
        }
        return best;
    }

    synchronized int waitingCount() { return waiting.size(); }

    // n waits (the newest version of key, after any older one), within what's kept (KEEP_PER_APP, KEEP_WAITING)
    private void hold(String pkg, String key, JSONObject n) {
        drop(key);
        waiting.put(key, new Waiting(pkg, n));
        LinkedHashSet<String> mine = waitingOf.get(pkg);
        if (mine == null) waitingOf.put(pkg, mine = new LinkedHashSet<String>());
        mine.add(key);
        if (mine.size() > KEEP_PER_APP) drop(mine.iterator().next());
        if (waiting.size() > KEEP_WAITING) {
            LinkedHashSet<String> most = null;
            for (LinkedHashSet<String> l : waitingOf.values()) if (most == null || l.size() > most.size()) most = l;
            drop(most.iterator().next());
        }
    }

    // key no longer waits (replaced, removed, or too many)
    private void drop(String key) {
        Waiting w = waiting.remove(key);
        if (w != null) unlist(w.pkg, key);
    }

    private void unlist(String pkg, String key) {
        LinkedHashSet<String> l = waitingOf.get(pkg);
        if (l != null && l.remove(key) && l.isEmpty()) waitingOf.remove(pkg);
    }

    private ArrayDeque<Long> recent(String pkg, long now) {
        ArrayDeque<Long> q = sends.get(pkg);
        if (q == null) return null;
        while (!q.isEmpty() && q.peekFirst() <= now - 1000) q.pollFirst();
        if (q.isEmpty()) { sends.remove(pkg); return null; }
        return q;
    }

    private boolean room(String pkg, long now) {
        ArrayDeque<Long> q = recent(pkg, now);
        return q == null || q.size() < perSecond;
    }

    private long waitFor(String pkg, long now) {
        ArrayDeque<Long> q = recent(pkg, now);
        if (q == null || q.size() < perSecond) return 0;
        return Math.max(0, q.peekFirst() + 1000 - now + 1);
    }

    private void take(String pkg, long now) {
        ArrayDeque<Long> q = sends.get(pkg);
        if (q == null) { q = new ArrayDeque<Long>(); sends.put(pkg, q); }
        q.addLast(now);
    }
}
