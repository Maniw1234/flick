package com.flick.app;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
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

    private static final class Waiting {
        final String pkg;
        final JSONObject n;
        Waiting(String pkg, JSONObject n) { this.pkg = pkg; this.n = n; }
    }

    private final int perSecond;
    private final HashMap<String, ArrayDeque<Long>> sends = new HashMap<String, ArrayDeque<Long>>();   // app -> recent sends
    private final LinkedHashMap<String, Waiting> waiting = new LinkedHashMap<String, Waiting>();      // key -> newest version
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
            waiting.remove(key);
            waiting.put(key, new Waiting(pkg, n));
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
        waiting.remove(key);
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
        }
        return out;
    }

    /** ms until the next waiting notification can go; -1 when none waits. */
    synchronized long next(long now) {
        long best = -1;
        for (Waiting w : waiting.values()) {
            long d = waitFor(w.pkg, now);
            if (best < 0 || d < best) best = d;
        }
        return best;
    }

    synchronized int waitingCount() { return waiting.size(); }

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
