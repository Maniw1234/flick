package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * History entries for the phone's sends to a PC that the send engine carries on with (Outbox). The page notes a send
 * it started once the PC has it (features/history.js: one entry per item); a send that ended while Flick was closed,
 * or after the page that started it had gone (a reload), was noted by nobody, as if it never happened. So a send that
 * went gets here what the page's entries would have been, for the items the page didn't note; one that failed gets one
 * entry per item saying so (the page notes no failure), unless it's noted as gone already; a cancel gets none. Each
 * item's entry is looked for in the history first (the same PC, the same file, since the send began): one there isn't
 * added again. No Android classes, so it runs on any JVM.
 */
final class SendHistory {
    private SendHistory() {}

    /** What the history needs from the app about an item: its file, and its kind ("image", "video"...). */
    interface Look {
        File file(Outbox.Item it);
        String kind(String name);
    }

    static final int MAX = 300;                   // entries one send adds at most (as the page; the history keeps 300)

    /** j's items (the first MAX) that the history has no entry for in this send: ones that went, when ok. */
    static List<Integer> missing(HistoryStore store, Outbox.Job j, boolean ok) {
        JSONArray all;
        try { all = new JSONArray(store.json()); } catch (Exception e) { all = new JSONArray(); }
        List<Integer> out = new ArrayList<Integer>();
        for (int i = 0; i < j.items.size() && i < MAX; i++) if (!noted(all, j, i, ok)) out.add(i);
        return out;
    }

    // an entry for item i of this send: the same PC and file, made since the send began (an earlier send of the same
    // file is another one). When ok, one that says it went (a failure noted for an earlier try doesn't count); when
    // not, any but the one noted here when it ended as gone (the PC's user said no after all: that one goes)
    private static boolean noted(JSONArray all, Outbox.Job j, int i, boolean ok) {
        Outbox.Item it = j.items.get(i);
        String mine = id(j, i, true);
        for (int k = 0; k < all.length(); k++) {
            JSONObject e = all.optJSONObject(k);
            if (e == null || !"out".equals(e.optString("dir")) || !j.pcId.equals(e.optString("pc", ""))) continue;
            if (e.optLong("time", 0) < j.created - 5000) continue;
            if (ok ? !e.optBoolean("ok", true) : mine.equals(e.optString("id"))) continue;
            if (it.path != null ? it.path.equals(e.optString("path", null)) : it.id != null && it.id.equals(e.optString("libId", null))) return true;
        }
        return false;
    }

    /**
     * Adds the entries of j's items at `which`, as the page makes them (how "fling"), for its ending at `ended`: ok, or
     * failed (why: the PC's user said no, "declined", or didn't answer in time, "timeout"). Its entries noted here for
     * the other outcome go: failures of earlier tries once it went, "sent" once the PC's user said no after all.
     * Returns how many were added.
     */
    static int add(HistoryStore store, Outbox.Job j, List<Integer> which, Look look, boolean ok, long ended) {
        for (int i = 0; i < j.items.size() && i < MAX; i++) store.remove(id(j, i, !ok));
        if (which.isEmpty()) return 0;
        String why = null;
        if (!ok) {
            String r = j.refusal();
            if (r != null) why = r.startsWith("Not accepted") ? "timeout" : "declined";
        }
        JSONArray a = new JSONArray();
        for (int i : which) {
            Outbox.Item it = j.items.get(i);
            try {
                JSONObject e = new JSONObject();
                e.put("id", id(j, i, ok));
                e.put("dir", "out");
                e.put("name", it.name == null || it.name.length() == 0 ? "File" : it.name);
                File f = look.file(it);
                e.put("size", it.dir ? (j.items.size() == 1 ? j.total() : 0) : f != null && f.isFile() ? f.length() : 0);
                e.put("time", ended > 0 ? ended : System.currentTimeMillis());
                e.put("pc", j.pcId);
                e.put("pcName", j.pcName);
                if (it.path != null) e.put("path", it.path); else if (it.id != null) e.put("libId", it.id);
                String kind = it.dir ? "folder" : look.kind(it.name == null ? "" : it.name);
                if (kind != null && kind.length() > 0) e.put("kind", kind);
                e.put("how", "fling");
                e.put("ok", ok);
                if (why != null) e.put("why", why);
                a.put(e);
            } catch (Exception x) { /* that one isn't noted */ }
        }
        return store.addJson(a.toString());
    }

    private static String id(Outbox.Job j, int i, boolean ok) {
        String t = j.tid.length() > 60 ? j.tid.substring(0, 60) : j.tid;
        return "s" + t + "." + i + (ok ? "" : "x");
    }

    /**
     * Each send's History entries, settled once for each ending (kept with the send: Outbox.noted): at once when the
     * page that started it is gone (Flick closed, or the page loaded again since), else what that page hasn't noted
     * by the time it would have (its 'saved', or 75 s at most).
     */
    static final class Settler {
        /** The page open now (anything that tells one page from another), or null; told History changed. */
        interface Pages {
            Object now();
            void changed();
            void warn(Throwable e);
        }

        static long[] CHECKS = {2000, 8000, 20000, 90000};      // (2 minutes in all: the page takes 75 s at most)

        private final HistoryStore store;
        private final Outbox box;
        private final Look look;
        private final Pages pages;
        private final Map<String, WeakReference<Object>> starters = new HashMap<String, WeakReference<Object>>();
        private final Set<String> waiting = new HashSet<String>();
        private static final ScheduledExecutorService LATER = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "flick-send-history"); t.setDaemon(true); return t; }
        });

        Settler(HistoryStore store, Outbox box, Look look, Pages pages) { this.store = store; this.box = box; this.look = look; this.pages = pages; }

        /** The page open now started this send. */
        void started(String tid) {
            Object p = pages.now();
            synchronized (starters) { starters.put(tid, new WeakReference<Object>(p)); }
        }

        /** j changed: once it ended, its entries are settled (later, while the page that started it may note them). */
        void changed(final Outbox.Job j) {
            if (!j.historyDue()) return;
            final long ended = j.ended();
            synchronized (waiting) { if (!waiting.add(j.tid + "@" + ended)) return; }
            try { LATER.execute(new Runnable() { @Override public void run() { settle(j, ended, 0); } }); }
            catch (Throwable e) { synchronized (waiting) { waiting.remove(j.tid + "@" + ended); } }
        }

        private void settle(final Outbox.Job j, final long ended, final int check) {
            boolean last = true;
            try {
                if (j.ended() != ended || !j.historyDue()) return;           // (tried again since: its next ending counts)
                String state = j.state();
                boolean ok = Outbox.DONE.equals(state) || Outbox.SKIPPED.equals(state);
                if (!ok && !Outbox.FAILED.equals(state)) { box.noted(j, ended); return; }      // a cancel: nothing
                List<Integer> miss = missing(store, j, ok);
                if (!miss.isEmpty() && ok && check < CHECKS.length && pageOf(j.tid)) {
                    last = false;
                    LATER.schedule(new Runnable() { @Override public void run() { settle(j, ended, check + 1); } }, CHECKS[check], TimeUnit.MILLISECONDS);
                    return;
                }
                if (add(store, j, miss, look, ok, ended) > 0) pages.changed();
                box.noted(j, ended);
            } catch (Throwable e) {
                last = true;
                pages.warn(e);
            } finally {
                if (last) {
                    synchronized (waiting) { waiting.remove(j.tid + "@" + ended); }
                    synchronized (starters) { starters.remove(j.tid); }
                }
            }
        }

        /** The page that started this send is still the one open (it notes the send itself). */
        private boolean pageOf(String tid) {
            WeakReference<Object> w;
            synchronized (starters) { w = starters.get(tid); }
            Object p = w == null ? null : w.get();
            return p != null && p == pages.now();
        }
    }
}
