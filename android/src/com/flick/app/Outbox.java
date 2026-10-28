package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilenameFilter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The phone's sends to the PC as jobs that outlive the screen. Each one is written down (files/outbox) and carried out
 * here in the app's process, whether or not Flick's page is open. A send that is cut off (Flick closed, the Wi-Fi
 * dropped, the PC asleep) waits and carries on where it stopped: the PC keeps what arrived (protocol 7) and says how
 * far it got (/api/status). Jobs can be paused, resumed, canceled and retried. Large files go as several parts at once,
 * several items or folders as a bundle over a few streams, straight to the PC (Wire). No Android classes (Env brings
 * files, the PC's address, locks and the screen), so it runs on any JVM.
 */
final class Outbox {
    static final String QUEUED = "queued", RUNNING = "running", WAITING = "waiting", PAUSED = "paused",
            DONE = "done", FAILED = "failed", CANCELED = "canceled", SKIPPED = "skipped";

    interface Env {
        /** The file an item stands for (a path on the phone, or one in Flick's own list). */
        File file(Item it) throws IOException;
        /** How to reach j's PC now; look: the last try didn't get through (look for it elsewhere first). */
        Wire.Link link(Job j, boolean look) throws IOException;
        /** "device=..&token=.." for j's PC; Fatal when this phone isn't paired with it any more. */
        String auth(Job j) throws IOException;
        /** Anything about j changed, progress included (throttle there). */
        void changed(Job j);
        /** Bytes start or stop moving (wake and Wi-Fi locks): calls come in pairs. */
        void moving(boolean on);
        void log(String msg);
    }

    /** Nothing more to try: the PC refused (not paired, no space) or the file is gone. msg is for the user. */
    static class Fatal extends IOException {
        private static final long serialVersionUID = 1L;
        Fatal(String msg) { super(msg); }
    }
    /** The PC canceled this transfer (on the PC, or it gave up on it). */
    static final class Aborted extends IOException {
        private static final long serialVersionUID = 1L;
        final String refused;                         // turned down there ("Ask each time"): why, for the list
        Aborted() { this(null); }
        Aborted(String refused) { super(refused != null ? refused : "canceled on the PC"); this.refused = refused; }
    }

    /** The PC's 410: canceled there, or turned down by its user (why declined | timeout, a PC set to "Ask each time"). */
    private static Aborted aborted(Job j, Wire.Answer a) {
        String why = a.json().optString("why", "");
        if ("declined".equals(why)) return new Aborted("Declined on " + j.pcName);
        if ("timeout".equals(why)) return new Aborted("Not accepted on " + j.pcName + " in time");
        return new Aborted();
    }
    /** What the PC has can't be continued (it restarted, or the file changed): start over. */
    static final class Restart extends IOException {
        private static final long serialVersionUID = 1L;
        Restart(String why) { super(why); }
    }
    /**
     * The PC answered with an error of its own (500: it couldn't write a file, say). Tried again a few times, as it may
     * pass (a file another program holds); one that keeps coming ends the send (MAX_REFUSALS). Bytes moving in between
     * don't count as getting anywhere: each try sends some before the PC answers.
     */
    static final class Refusal extends IOException {
        private static final long serialVersionUID = 1L;
        Refusal(String why) { super(why); }
    }

    static final class Item {
        final String path, id, name;
        final boolean dir;
        Item(String path, String id, String name, boolean dir) { this.path = path; this.id = id; this.name = name; this.dir = dir; }
    }

    static final class Job {
        final String tid, pcId, pcName, label;
        final long created;
        final List<Item> items;
        final boolean bundle, skipDup, parallel;
        // guarded by this
        String host, via;
        int port;
        boolean committed, checked, retried;
        boolean again;                                // tried again by the user: the PC takes it even if it was dropped there
        boolean begun;                                // this attempt sent the PC data: ask how far it got before more
        boolean retake;                               // paused and resumed before the pause took effect (see failed)
        String state = QUEUED, why, want, sig, refused;
        volatile String att;                          // written under this, read by the part threads
        int ways, restarts, fails;
        int refusals;                                 // tries the PC answered with an error in a row (see Refusal)
        long total, ended, waitingSince, wakeAt;
        final Set<Integer> had = new HashSet<Integer>();
        AtomicBoolean stop = new AtomicBoolean(false);
        final Object disk = new Object();             // its record is written by one thread at a time (see save)
        String[] psums;                               // each part's checksum once the PC has it whole (this attempt)
        // each part's checksum so far at a few points it passed (this attempt, this process): carrying on after a cut
        // starts from the last point the PC has, instead of reading everything the PC has again (see sendPart)
        final Map<Integer, TreeMap<Long, MessageDigest>> marks = new HashMap<Integer, TreeMap<Long, MessageDigest>>();
        // progress (any thread)
        final AtomicLong sent = new AtomicLong();
        private double rate;
        private long rateT, rateB, lastNote;

        Job(String tid, long created, String pcId, String pcName, List<Item> items, boolean skipDup, boolean parallel) {
            this.tid = tid; this.created = created; this.pcId = pcId; this.pcName = pcName == null || pcName.length() == 0 ? "your PC" : pcName;
            this.items = Collections.unmodifiableList(new ArrayList<Item>(items));
            this.bundle = items.size() != 1 || items.get(0).dir;
            this.label = items.size() == 1 ? items.get(0).name : items.size() + " items";
            this.skipDup = skipDup; this.parallel = parallel;
        }

        synchronized boolean finished() { return isEnd(state); }
        synchronized String state() { return state; }
        synchronized String why() { return why; }
        synchronized boolean committed() { return committed; }
        synchronized long total() { return total; }
        synchronized double rate() { return RUNNING.equals(state) ? rate : 0; }
        synchronized int had() { return had.size(); }
        synchronized void at(String host, int port, String via) { this.host = host; this.port = port; if (via != null) this.via = via; }
        synchronized String host() { return host; }
        synchronized int port() { return port; }
        synchronized String via() { return via; }

        /** What the transfer list shows. */
        synchronized JSONObject view() {
            JSONObject o = new JSONObject();
            try {
                o.put("tid", tid);
                o.put("name", label);
                o.put("count", items.size());
                o.put("pc", pcId);
                o.put("pcName", pcName);
                o.put("state", state);
                if (why != null) o.put("why", why);
                long s = Math.min(sent.get(), total);
                o.put("sent", s);
                o.put("total", total);
                double r = RUNNING.equals(state) ? rate : 0;
                o.put("rate", Math.round(r));
                o.put("eta", r > 1 && total > s ? Math.round((total - s) / r) : -1);
                o.put("created", created);
                if (ended > 0) o.put("ended", ended);
                if (WAITING.equals(state)) o.put("retryIn", Math.max(0, wakeAt - now()));
                if (!had.isEmpty()) o.put("had", had.size());
                o.put("committed", committed);
                JSONArray it = new JSONArray();
                for (int i = 0; i < items.size() && i < 3; i++) {
                    Item x = items.get(i);
                    JSONObject a = new JSONObject();
                    if (x.path != null) a.put("path", x.path);
                    if (x.id != null) a.put("id", x.id);
                    a.put("name", x.name);
                    if (x.dir) a.put("dir", true);
                    it.put(a);
                }
                o.put("items", it);
            } catch (Exception e) { /* ignore */ }
            return o;
        }

        synchronized JSONObject save() throws Exception {
            JSONObject o = new JSONObject();
            o.put("v", 1);
            o.put("tid", tid);
            o.put("created", created);
            o.put("pc", pcId);
            o.put("pcName", pcName);
            JSONArray it = new JSONArray();
            for (Item x : items) {
                JSONObject a = new JSONObject();
                if (x.path != null) a.put("path", x.path);
                if (x.id != null) a.put("id", x.id);
                a.put("name", x.name);
                if (x.dir) a.put("dir", true);
                it.put(a);
            }
            o.put("items", it);
            o.put("skipDup", skipDup);
            o.put("parallel", parallel);
            if (host != null) o.put("host", host);
            o.put("port", port);
            if (via != null) o.put("via", via);
            o.put("committed", committed);
            o.put("checked", checked);
            o.put("retried", retried);
            if (again) o.put("again", true);
            o.put("begun", begun);
            o.put("state", state);
            if (why != null) o.put("why", why);
            if (refused != null) o.put("refused", refused);
            if (att != null) o.put("att", att);
            if (sig != null) o.put("sig", sig);
            o.put("ways", ways);
            o.put("restarts", restarts);
            o.put("total", total);
            o.put("sent", sent.get());
            o.put("ended", ended);
            o.put("waitingSince", waitingSince);
            JSONArray h = new JSONArray();
            for (Integer i : had) h.put(i.intValue());
            o.put("had", h);
            if (psums != null) {
                JSONArray ps = new JSONArray();
                for (String x : psums) ps.put(x == null ? "" : x);
                o.put("psums", ps);
            }
            return o;
        }

        static Job load(JSONObject o) {
            JSONArray it = o.optJSONArray("items");
            List<Item> items = new ArrayList<Item>();
            for (int i = 0; it != null && i < it.length(); i++) {
                JSONObject a = it.optJSONObject(i);
                if (a == null) continue;
                items.add(new Item(a.has("path") ? a.optString("path") : null, a.has("id") ? a.optString("id") : null, a.optString("name", "file"), a.optBoolean("dir", false)));
            }
            if (items.isEmpty() || o.optString("tid", "").length() == 0) return null;
            Job j = new Job(o.optString("tid"), o.optLong("created", 0), o.optString("pc", ""), o.optString("pcName", ""), items,
                    o.optBoolean("skipDup", false), o.optBoolean("parallel", true));
            j.host = o.has("host") ? o.optString("host") : null;
            j.port = o.optInt("port", 0);
            j.via = o.has("via") ? o.optString("via") : null;
            j.committed = o.optBoolean("committed", false);
            j.checked = o.optBoolean("checked", false);
            j.retried = o.optBoolean("retried", false);
            j.again = o.optBoolean("again", false);
            j.begun = o.optBoolean("begun", true);       // (saved before this was kept: ask, to be safe)
            j.state = o.optString("state", QUEUED);
            j.why = o.has("why") ? o.optString("why") : null;
            j.refused = o.has("refused") ? o.optString("refused") : null;
            j.att = o.has("att") ? o.optString("att") : null;
            j.sig = o.has("sig") ? o.optString("sig") : null;
            j.ways = o.optInt("ways", 0);
            j.restarts = o.optInt("restarts", 0);
            j.total = o.optLong("total", 0);
            j.sent.set(o.optLong("sent", 0));
            j.ended = o.optLong("ended", 0);
            j.waitingSince = o.optLong("waitingSince", 0);
            JSONArray h = o.optJSONArray("had");
            for (int i = 0; h != null && i < h.length(); i++) j.had.add(h.optInt(i));
            JSONArray ps = o.optJSONArray("psums");
            if (ps != null) {
                j.psums = new String[ps.length()];
                for (int i = 0; i < ps.length(); i++) { String x = ps.optString(i, ""); j.psums[i] = x.length() == 64 ? x : null; }
            }
            return j;
        }
    }

    // ------------------------------------------------------------ tuning (tests shorten some)
    static final int MAX_RUNNING = 2;                     // jobs moving bytes at once (each over several connections)
    static final long PARALLEL_MIN = 8L * 1024 * 1024;    // smaller files go as one part
    static final int MANY_FILES = 64;                     // this many files go over several streams, however small
    static final int MAX_RESTARTS = 4;
    static final int MAX_REFUSALS = 6;                    // (about a minute of tries, see BACKOFF_MS)
    static volatile long GIVE_UP_MS = 6 * 3600 * 1000L;    // as long as the PC keeps what arrived
    static volatile long KEEP_ENDED_MS = 24 * 3600 * 1000L; // finished ones stay in the list this long
    static final int KEEP_ENDED = 30;
    static volatile long[] BACKOFF_MS = {1000, 2000, 4000, 8000, 15000, 30000};
    static volatile int READ_MS = 60000;                   // the PC's answer once a body is through
    static volatile long DRAG_MS = 90000;                  // a send whose drag never ended gives up after this
    static final int BUF = 512 * 1024;

    private static final SecureRandom RNG = new SecureRandom();
    private final File dir;
    private final Env env;
    private final LinkedHashMap<String, Job> jobs = new LinkedHashMap<String, Job>();   // guarded by this
    private int running;                                                                 // guarded by this
    private final ExecutorService pool = Executors.newCachedThreadPool(daemon("flick-send"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(daemon("flick-send-timer"));
    private final Runnable kickTask = new Runnable() { @Override public void run() { kick(); } };
    private volatile boolean dead;                                                       // kill(): nothing more happens

    /** Reads what was written down; start() then carries on with what was under way. */
    Outbox(File dir, Env env) {
        this.dir = dir;
        this.env = env;
        dir.mkdirs();
        load();
    }

    /** Sends that were under way when the app stopped carry on (call once, after construction). */
    void start() { kick(); }

    private static ThreadFactory daemon(final String name) {
        return new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, name); t.setDaemon(true); return t; }
        };
    }

    static long now() { return System.currentTimeMillis(); }

    static boolean isEnd(String s) { return DONE.equals(s) || FAILED.equals(s) || CANCELED.equals(s) || SKIPPED.equals(s); }

    // ------------------------------------------------------------ what the page (or anyone) asks
    /** A new send. host/port/via: where the PC is now. committed: the user already let go of it (not a drag). */
    Job add(String tid, String pcId, String pcName, String host, int port, String via, List<Item> items, boolean committed, boolean skipDup, boolean parallel) {
        Job j = new Job(tid, now(), pcId, pcName, items, skipDup, parallel);
        j.host = host; j.port = port; j.via = via;
        j.committed = committed;
        Job old;
        synchronized (this) {
            old = jobs.get(tid);
            if (old != null && !old.finished()) return old;          // the same send asked twice
            jobs.remove(tid);
            jobs.put(tid, j);
        }
        save(j);
        env.changed(j);
        kick();
        return j;
    }

    /** The drag ended over the PC: the send is meant (until then a lost link cancels it rather than waiting). */
    void commit(String tid) {
        Job j = get(tid);
        if (j == null) return;
        synchronized (j) { if (j.committed) return; j.committed = true; }
        save(j);
    }

    void pause(String tid) {
        Job j = get(tid);
        if (j == null) return;
        synchronized (j) {
            if (RUNNING.equals(j.state)) { j.want = PAUSED; Watchdog.abort(j.stop); return; }   // the runner settles it
            if (!QUEUED.equals(j.state) && !WAITING.equals(j.state)) return;
            j.state = PAUSED; j.why = null;
        }
        save(j);
        env.changed(j);
    }

    void resume(String tid) {
        Job j = get(tid);
        if (j == null) return;
        synchronized (j) {
            if (PAUSED.equals(j.state)) { j.state = QUEUED; j.why = null; j.fails = 0; j.refusals = 0; j.waitingSince = 0; }
            else if (WAITING.equals(j.state)) j.wakeAt = 0;
            else if (RUNNING.equals(j.state) && PAUSED.equals(j.want)) { j.want = null; j.retake = true; }
            else return;
        }
        save(j);
        env.changed(j);
        kick();
    }

    /** Stops it for good. The PC is told (it drops what arrived) when it can be reached. */
    void cancel(String tid) {
        Job j = get(tid);
        if (j == null) return;
        boolean now;
        synchronized (j) {
            if (j.finished()) return;
            if (RUNNING.equals(j.state)) { j.want = CANCELED; Watchdog.abort(j.stop); now = false; }
            else { j.state = CANCELED; now = true; }               // (at once: kick() can't start it in between)
        }
        if (now) { settle(j, CANCELED, null); tellCancel(j); }
    }

    /** A failed or canceled send, tried again (from where the PC stands, if it kept anything). */
    void retry(String tid) {
        Job j = get(tid);
        if (j == null) return;
        synchronized (j) {
            if (!FAILED.equals(j.state) && !CANCELED.equals(j.state) && !WAITING.equals(j.state)) return;
            if (WAITING.equals(j.state)) { j.wakeAt = 0; }
            else {
                // a canceled one was dropped on the PC too, and so was one turned down there: it starts over
                if (CANCELED.equals(j.state) || j.refused != null) newAttempt(j);
                j.state = QUEUED; j.why = null; j.ended = 0; j.fails = 0; j.refusals = 0; j.waitingSince = 0; j.restarts = 0; j.committed = true; j.retried = true;
                j.again = true; j.refused = null;
            }
        }
        save(j);
        env.changed(j);
        kick();
    }

    /**
     * The PC turned it down after all: a PC set to "Ask each time" for this phone, where it was declined (why
     * "declined") or not accepted within a minute ("timeout"). The send ends as failed, saying so; Try again asks again.
     */
    void refused(String tid, String why) {
        Job j = get(tid);
        if (j == null) return;
        String text = "timeout".equals(why) ? "Not accepted on " + j.pcName + " in time" : "Declined on " + j.pcName;
        boolean now;
        synchronized (j) {
            if (FAILED.equals(j.state) && text.equals(j.why)) return;
            j.refused = text;
            if (RUNNING.equals(j.state)) { Watchdog.abort(j.stop); now = false; }   // the runner settles it
            else now = true;
        }
        if (now) settle(j, FAILED, text);
    }

    /** A finished send leaves the list. */
    void forget(String tid) {
        Job j;
        synchronized (this) {
            j = jobs.get(tid);
            if (j == null || !j.finished()) return;
            jobs.remove(tid);
        }
        new File(dir, tid + ".json").delete();
    }

    /** Where a PC is now (the page found it, over Wi-Fi or another link): sends waiting for it try again there. */
    void relink(String pcId, String host, int port, String via) {
        for (Job j : list()) {
            if (!pcId.equals(j.pcId) || j.finished()) continue;
            boolean moved;
            synchronized (j) {
                moved = !host.equals(j.host) || port != j.port;
                j.host = host; j.port = port; if (via != null) j.via = via;
                if (WAITING.equals(j.state)) j.wakeAt = 0;
            }
            if (moved) save(j);
        }
        kick();
    }

    /** The network changed (or came back): sends waiting for the PC try again now. */
    void poke() {
        for (Job j : list()) synchronized (j) { if (WAITING.equals(j.state)) j.wakeAt = 0; }
        kick();
    }

    synchronized Job get(String tid) { return jobs.get(tid); }

    synchronized List<Job> list() { return new ArrayList<Job>(jobs.values()); }

    /** Something is still to do: running, waiting for the PC, or queued (paused ones don't count). */
    boolean active() {
        for (Job j : list()) { String s = j.state(); if (QUEUED.equals(s) || RUNNING.equals(s) || WAITING.equals(s)) return true; }
        return false;
    }

    JSONArray views() {
        JSONArray a = new JSONArray();
        for (Job j : list()) a.put(j.view());
        return a;
    }

    // ------------------------------------------------------------ running
    void kick() {
        if (dead) return;
        List<Job> start = new ArrayList<Job>();
        long later = Long.MAX_VALUE;
        synchronized (this) {
            long now = now();
            for (Job j : jobs.values()) {
                synchronized (j) {
                    boolean due = QUEUED.equals(j.state) || (WAITING.equals(j.state) && j.wakeAt <= now);
                    if (WAITING.equals(j.state) && j.wakeAt > now) later = Math.min(later, j.wakeAt - now);
                    if (!due || running >= MAX_RUNNING) continue;
                    j.state = RUNNING;
                    j.want = null;
                    j.retake = false;
                    j.stop = new AtomicBoolean(false);
                    running++;
                    start.add(j);
                }
            }
        }
        if (later != Long.MAX_VALUE) { try { timer.schedule(kickTask, later + 20, TimeUnit.MILLISECONDS); } catch (Throwable e) { /* shutting down */ } }
        for (final Job j : start) {
            env.changed(j);
            pool.execute(new Runnable() { @Override public void run() { runJob(j); } });
        }
    }

    private void runJob(Job j) {
        env.moving(true);
        try {
            String end;
            try {
                end = attempt(j);
            } catch (Throwable e) {
                failed(j, e);
                return;
            }
            String want, refused;
            synchronized (j) { want = j.want; refused = j.refused; }
            if (refused != null) { settle(j, FAILED, refused); return; }   // turned down on the PC as it finished
            // canceled just as it finished: it's on the PC anyway
            settle(j, end, null);
            if (CANCELED.equals(want)) env.log("send " + j.tid + " finished before it could be canceled");
        } finally {
            env.moving(false);
            synchronized (this) { running--; }
            kick();
        }
    }

    private void failed(Job j, Throwable e) {
        String want, refused;
        synchronized (j) { want = j.want; j.want = null; refused = j.refused; }
        if (refused != null) { settle(j, FAILED, refused); return; }     // turned down on the PC ("Ask each time")
        if (CANCELED.equals(want)) { settle(j, CANCELED, null); tellCancel(j); return; }
        if (PAUSED.equals(want)) {
            synchronized (j) { j.state = PAUSED; j.why = null; }
            save(j);
            env.changed(j);
            return;
        }
        if (e instanceof Aborted) {
            String no = ((Aborted) e).refused;
            if (no != null) { synchronized (j) { j.refused = no; } settle(j, FAILED, no); return; }   // Try again starts over
            settle(j, CANCELED, "Canceled on " + j.pcName);
            return;
        }
        if (e instanceof Fatal) { settle(j, FAILED, e.getMessage()); return; }
        if (e instanceof Restart) {
            boolean again;
            String late;                                             // paused or canceled while this was failing
            synchronized (j) { late = j.want; j.want = null; again = late == null && j.restarts < MAX_RESTARTS; if (again) { newAttempt(j); j.state = QUEUED; } }
            if (lateWish(j, late)) return;
            env.log("send " + j.tid + " starts over: " + e.getMessage());
            if (!again) { settle(j, FAILED, "Couldn't send it to " + j.pcName); return; }
            save(j);
            env.changed(j);
            return;                                                  // runJob's kick() starts it again
        }
        // paused and resumed again before the pause took effect: this try was cut for the pause, and carries on at once
        // (it used to wait as for a PC that can't be reached, showing "Waiting for" it meanwhile)
        boolean retake;
        synchronized (j) { retake = j.retake; j.retake = false; if (retake) j.state = QUEUED; }
        if (retake) { save(j); env.changed(j); return; }             // runJob's kick() starts it again
        if (!(e instanceof IOException)) env.log("send " + j.tid + ": " + e);
        long delay;
        String late;                                                 // paused or canceled while this was failing
        synchronized (j) {
            late = j.want;
            j.want = null;
            if (late != null) { delay = 0; }
            else if (!j.committed && now() - j.created > DRAG_MS) { delay = -1; }   // a drag that was never finished
            else {
                j.fails++;
                if (e instanceof Refusal) j.refusals++;
                long now = now();
                if (j.waitingSince == 0) j.waitingSince = now;
                if (now - j.waitingSince > GIVE_UP_MS) delay = -2;
                else if (j.refusals >= MAX_REFUSALS) delay = -3;
                else {
                    long[] b = BACKOFF_MS;
                    delay = b[Math.min(Math.max(j.fails, j.refusals) - 1, b.length - 1)];
                    j.state = WAITING;
                    j.why = "Waiting for " + j.pcName;
                    j.wakeAt = now + delay;
                }
            }
        }
        if (lateWish(j, late)) return;
        if (delay == -1) { settle(j, CANCELED, null); return; }
        if (delay == -2) { settle(j, FAILED, "Couldn't reach " + j.pcName); return; }
        if (delay == -3) { env.log("send " + j.tid + " gives up: " + e.getMessage()); settle(j, FAILED, "Couldn't save it on " + j.pcName); return; }
        env.log("send " + j.tid + " waits " + delay + " ms: " + e.getMessage());
        save(j);
        env.changed(j);
        try { timer.schedule(kickTask, delay + 20, TimeUnit.MILLISECONDS); } catch (Throwable x) { /* shutting down */ }
    }

    /** A pause or cancel the user asked for while the send was failing: done now, instead of being lost. */
    private boolean lateWish(Job j, String want) {
        if (CANCELED.equals(want)) { settle(j, CANCELED, null); tellCancel(j); return true; }
        if (PAUSED.equals(want)) {
            synchronized (j) { j.state = PAUSED; j.why = null; }
            save(j);
            env.changed(j);
            return true;
        }
        return false;
    }

    private void settle(Job j, String state, String why) {
        if (dead) return;
        synchronized (j) {
            j.state = state;
            j.why = why;
            j.want = null;
            j.again = false;
            j.ended = now();
            if (DONE.equals(state)) j.sent.set(j.total);
        }
        save(j);
        env.changed(j);
        trim();
    }

    private static void newAttempt(Job j) {
        j.att = Long.toString(RNG.nextLong() & 0xffffffffffL, 36);
        j.restarts++;
        j.sent.set(0);
        j.ways = 0;
        j.begun = false;
        j.psums = null;
        synchronized (j.marks) { j.marks.clear(); }
    }

    // what the PC answered to a part, a stream or a commit
    private void check(Job j, Wire.Answer a) throws IOException {
        if (a.code == 200) return;
        String err = a.error();
        if (a.code == 403) throw new Fatal("This phone isn't paired with " + j.pcName + " any more: connect again to pair");
        if (a.code == 410) throw aborted(j, a);
        if (a.code == 507) throw new Fatal("Not enough space on " + j.pcName);
        if (a.code == 422) throw new Restart("arrived damaged");
        if (a.code == 409 && "gone".equals(err)) throw new Restart("the PC doesn't have it any more");
        if (a.code == 400) throw new Restart("refused: " + err);
        if (a.code >= 500) throw new Refusal("http " + a.code + " " + err);
        throw new IOException("http " + a.code + " " + err);
    }

    /** The PC took a part or a stream: it isn't refusing this send. */
    private static void accepted(Job j) { synchronized (j) { j.refusals = 0; } }

    private void progress(Job j, long n) {
        long s = j.sent.addAndGet(n);
        long t = now();
        boolean note = false;
        synchronized (j) {
            j.fails = 0;
            j.waitingSince = 0;
            if (j.rateT == 0) { j.rateT = t; j.rateB = s; }
            else if (t - j.rateT >= 500) {
                double inst = (s - j.rateB) * 1000.0 / (t - j.rateT);
                j.rate = j.rate <= 0 ? inst : j.rate * 0.6 + inst * 0.4;
                j.rateT = t; j.rateB = s;
            }
            if (t - j.lastNote >= 200) { j.lastNote = t; note = true; }
        }
        if (note) env.changed(j);
    }

    /** One run at a job: DONE or SKIPPED when the PC has it all, else it throws. */
    private String attempt(Job j) throws IOException {
        synchronized (j) { j.rate = 0; j.rateT = 0; }
        Wire.Link l;
        int fails;
        synchronized (j) { fails = j.fails; }
        l = env.link(j, fails > 0);
        String auth = env.auth(j);
        return j.bundle ? sendBundle(j, l, auth) : sendFile(j, l, auth);
    }

    private String q(Job j, String auth) {
        boolean again;
        synchronized (j) { again = j.again; }
        return auth + "&tid=" + Wire.enc(j.tid) + "&att=" + j.att + (again ? "&again=1" : "");
    }

    private static boolean retried(Job j) { synchronized (j) { if (!j.retried) return false; j.retried = false; return true; } }

    // ------------------------------------------------------------ one file, in parts
    private String sendFile(final Job j, final Wire.Link l, final String auth) throws IOException {
        final Item it = j.items.get(0);
        final File f;
        try { f = env.file(it); } catch (IOException e) { throw new Fatal("Couldn't read " + it.name); }
        if (f == null || !f.isFile()) throw new Fatal(it.name + " isn't on this phone any more");
        final long total = f.length();
        String sig = total + ":" + f.lastModified();
        boolean check;
        synchronized (j) {
            if (j.att == null || (j.sig != null && !j.sig.equals(sig))) { newAttempt(j); j.restarts = Math.max(0, j.restarts - 1); }
            j.sig = sig;
            j.total = total;
            if (j.ways == 0) j.ways = !split(j) || total < PARALLEL_MIN ? 1 : total < (256L << 20) ? 4 : 6;
            check = j.skipDup && !j.checked;
        }
        save(j);
        if (check) {
            boolean[] full = new boolean[1];
            Set<Integer> have = Have.check(l, auth, Collections.singletonList(f), Collections.singletonList(it.name), total, full);
            if (full[0]) throw new Fatal("Not enough space on " + j.pcName);
            synchronized (j) { j.checked = true; if (have.contains(0)) j.had.add(0); }
            save(j);
            if (have.contains(0)) { tellHave(j, l, auth, it.name, 1); return SKIPPED; }
        } else if (j.had() > 0) {
            tellHave(j, l, auth, it.name, 1);
            return SKIPPED;
        }
        final int n;
        boolean begun;
        synchronized (j) { n = j.ways; begun = j.begun; }
        final long size = (total + n - 1) / n;
        final long[] from = new long[n];
        final boolean[] done = new boolean[n];
        // how far the PC got: only worth a round trip when this attempt has already sent it something
        Wire.Answer st = begun ? Wire.get(l, "/api/status?" + q(j, auth), 15000) : null;
        if (st != null && st.code == 403) check(j, st);
        if (st != null && st.code == 410) { if (retried(j)) throw new Restart("tried again"); throw aborted(j, st); }
        if (st != null && st.code == 507) check(j, st);
        if (st != null && st.code == 200) {
            JSONObject o = st.json();
            if (o.optBoolean("done", false)) return DONE;
            JSONArray sv = o.optJSONArray("saved"), dn = o.optJSONArray("done");
            if ("parts".equals(o.optString("kind")) && o.optInt("parts", 0) == n && o.optLong("total", -1) == total && sv != null && dn != null) {
                for (int i = 0; i < n; i++) { from[i] = Math.max(0, sv.optLong(i, 0)); done[i] = dn.optBoolean(i, false); }
            } else {
                throw new Restart("the PC has something else under this name");
            }
        }
        long base = 0;
        for (int i = 0; i < n; i++) {
            long len = Math.max(0, Math.min(size, total - i * size));
            if (from[i] > len) from[i] = 0;
            base += done[i] ? len : from[i];
        }
        j.sent.set(base);
        env.changed(j);
        final AtomicBoolean stop;
        synchronized (j) { stop = j.stop; }
        markBegun(j);
        // each part's checksum (the PC checks what it got against them): worked out from the bytes as they go, and kept
        // (written down) once the PC has the part whole; a part the PC has whole whose checksum isn't known here is read
        // for it (reading the parts again after a cut at the end, the whole file, was most of carrying on)
        final String[] sums = new String[n];
        final String[] known;
        synchronized (j) { if (j.psums == null || j.psums.length != n) j.psums = new String[n]; known = j.psums.clone(); }
        List<Future<?>> parts = new ArrayList<Future<?>>();
        for (int i = 0; i < n; i++) {
            final int index = i;
            final long off = i * size, len = Math.max(0, Math.min(size, total - off));
            if (done[i] && known[i] != null) { sums[i] = known[i]; continue; }
            if (done[i]) {
                parts.add(pool.submit(new Callable<Void>() {
                    @Override public Void call() throws Exception { sums[index] = rangeSum(f, off, len, stop); keepSum(j, n, index, sums[index]); return null; }
                }));
                continue;
            }
            parts.add(pool.submit(new Callable<Void>() {
                @Override public Void call() throws Exception {
                    // one part failing stops the others at once (even one waiting for its answer): all of them
                    // carry on together from where the PC stands
                    try { sums[index] = sendPart(j, l, auth, f, it.name, index, n, size, total, from[index], stop); keepSum(j, n, index, sums[index]); return null; }
                    catch (Exception e) { Watchdog.abort(stop); throw e; }
                }
            }));
        }
        finish(parts, stop);
        StringBuilder sha = new StringBuilder(n * 65);
        for (int i = 0; i < n; i++) { if (i > 0) sha.append(','); sha.append(sums[i]); }
        commit(j, l, auth, sha.toString(), total, stop);
        return DONE;
    }

    /**
     * Several connections at once (the user's "parallel" setting), except over Bluetooth: one link carries them all
     * there, so they only take turns, each one slower than the stall limit allows on a weak link (and the page sends
     * over Bluetooth on one connection too). Called under j's lock.
     */
    private static boolean split(Job j) { return j.parallel && !"bluetooth".equals(j.via); }

    /** Part index's checksum, now that the PC has the part whole: a later try (in a new process too) needn't read it. */
    private void keepSum(Job j, int n, int index, String sum) {
        synchronized (j) { if (j.psums == null || j.psums.length != n) return; j.psums[index] = sum; }
        save(j);
    }

    /** This attempt is about to send the PC data: from now on a retry asks how far it got first. */
    private void markBegun(Job j) {
        boolean was;
        synchronized (j) { was = j.begun; j.begun = true; }
        if (!was) save(j);
    }

    /** Sends part index (from its byte from on); returns the SHA-256 of the whole part, worked out on the way. */
    private String sendPart(Job j, Wire.Link l, String auth, File f, String name, int index, int n, long size, long total, long from, AtomicBoolean stop) throws IOException {
        long off = index * size, len = Math.max(0, Math.min(size, total - off));
        String target = "/api/part?" + q(j, auth) + "&parts=" + n + "&total=" + total + "&index=" + index + "&offset=" + off +
                "&resume=1&from=" + from + "&verify=1&name=" + Wire.enc(name) + (j.committed() ? "&committed=1" : "");
        // a part carried on from the middle: its checksum starts with the bytes the PC has already, from the last point
        // this part's checksum passed before them (or from its start)
        long[] at = {0};
        MessageDigest md = mark(j, index, from, at);
        if (md == null) md = sha256();
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        byte[] buf = new byte[BUF];
        try {
            if (from > at[0]) { raf.seek(off + at[0]); hashFrom(raf, md, from - at[0], buf, stop); }
        } catch (IOException e) {
            try { raf.close(); } catch (IOException x) { /* ignore */ }
            throw e;
        }
        Wire.Call c;
        try { c = Wire.Call.open(l, "POST", target, len - from, "application/octet-stream", READ_MS); }
        catch (IOException e) { try { raf.close(); } catch (IOException x) { /* ignore */ } throw e; }
        Watchdog.Guard g = Watchdog.guard(stop, c);
        boolean through = false;
        try {
            OutputStream out = g.watch(c.body());
            raf.seek(off + from);
            long left = len - from, pos = from, next = (from / MARK + 1) * MARK;
            while (left > 0) {
                if (stop.get()) throw new IOException("stopped");
                int r = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (r < 0) throw new Restart("the file changed");
                md.update(buf, 0, r);
                pos += r;
                if (pos >= next) { mark(j, index, pos, md); next = (pos / MARK + 1) * MARK; }
                out.write(buf, 0, r);
                left -= r;
                progress(j, r);
            }
            g.idle();
            through = true;
            check(j, c.answer(64 * 1024));
            accepted(j);
            return hex(md.digest());
        } catch (Fatal e) {
            throw e;
        } catch (Aborted e) {
            throw e;
        } catch (Restart e) {
            throw e;
        } catch (IOException e) {
            if (!through) cutAnswer(j, c, g, stop);
            throw g.ended() != null ? new IOException(g.ended(), e) : e;
        } finally {
            g.close();
            try { raf.close(); } catch (IOException e) { /* ignore */ }
            c.close();
        }
    }

    /**
     * A body that couldn't be written: the PC may have answered before closing the connection (no space, a send it
     * canceled or doesn't have any more). That answer counts (its Fatal, Aborted or Restart is thrown); otherwise the
     * caller treats it as a cut. Not when the cut was this phone's own (stopped, stalled).
     */
    private void cutAnswer(Job j, Wire.Call c, Watchdog.Guard g, AtomicBoolean stop) throws IOException {
        if (g.ended() != null || stop.get()) return;
        Wire.Answer a = c.answerAfterCut(64 * 1024);
        if (a != null && a.code != 200) check(j, a);
    }

    static final long MARK = 16L << 20;                    // a part's checksum so far is kept every this many bytes

    /** Part index's checksum so far (bytes [0, pos) of it): kept, the last few. */
    private static void mark(Job j, int index, long pos, MessageDigest md) {
        MessageDigest copy;
        try { copy = (MessageDigest) md.clone(); } catch (CloneNotSupportedException e) { return; }
        synchronized (j.marks) {
            TreeMap<Long, MessageDigest> m = j.marks.get(index);
            if (m == null) j.marks.put(index, m = new TreeMap<Long, MessageDigest>());
            m.put(pos, copy);
            while (m.size() > 4) m.pollFirstEntry();
        }
    }

    /** Part index's checksum at the last kept point at or before from (that point in at[0]), or null (from its start). */
    private static MessageDigest mark(Job j, int index, long from, long[] at) {
        synchronized (j.marks) {
            TreeMap<Long, MessageDigest> m = j.marks.get(index);
            Map.Entry<Long, MessageDigest> e = m == null ? null : m.floorEntry(from);
            if (e == null) return null;
            try { at[0] = e.getKey(); return (MessageDigest) e.getValue().clone(); } catch (CloneNotSupportedException x) { return null; }
        }
    }

    private static java.security.MessageDigest sha256() throws IOException {
        try { return java.security.MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("no SHA-256"); }
    }

    private static void hashFrom(RandomAccessFile raf, java.security.MessageDigest md, long n, byte[] buf, AtomicBoolean stop) throws IOException {
        while (n > 0) {
            if (stop.get() || Thread.currentThread().isInterrupted()) throw new IOException("stopped");
            int r = raf.read(buf, 0, (int) Math.min(buf.length, n));
            if (r < 0) throw new Restart("the file changed");
            md.update(buf, 0, r);
            n -= r;
        }
    }

    private static String hex(byte[] d) {
        StringBuilder s = new StringBuilder(d.length * 2);
        for (byte x : d) s.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return s.toString();
    }

    /** The SHA-256 of len bytes of f from off (a part the PC has whole already). */
    static String rangeSum(File f, long off, long len, AtomicBoolean stop) throws IOException {
        java.security.MessageDigest md = sha256();
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        try {
            raf.seek(off);
            hashFrom(raf, md, len, new byte[1024 * 1024], stop);
        } finally { raf.close(); }
        return hex(md.digest());
    }

    /** Every part is in: the PC checks each part against the phone's checksums (worked out as they arrived). */
    private void commit(Job j, Wire.Link l, String auth, String sha, long total, AtomicBoolean stop) throws IOException {
        int readMs = (int) Math.min(30 * 60000L, 60000L + total / (25L << 20) * 1000L);
        Wire.Call c = Wire.Call.open(l, "POST", "/api/part?" + q(j, auth) + "&commit=1&sums=" + sha, 0, null, readMs);
        Watchdog.Guard g = Watchdog.guard(stop, c);
        try {
            check(j, c.answer(64 * 1024));
        } finally {
            g.close();
            c.close();
        }
    }

    // ------------------------------------------------------------ several items or folders, as a bundle
    private String sendBundle(final Job j, final Wire.Link l, final String auth) throws IOException {
        final AtomicBoolean stop;
        synchronized (j) { stop = j.stop; }
        List<File> files = new ArrayList<File>();
        int missing = 0;
        for (Item it : j.items) {
            File f = null;
            try { f = env.file(it); } catch (IOException e) { /* gone */ }
            if (f == null || !f.exists()) { files.add(null); missing++; } else files.add(f);
        }
        if (missing == j.items.size()) throw new Fatal(j.items.size() == 1 ? j.items.get(0).name + " isn't on this phone any more" : "These files aren't on this phone any more");
        boolean check;
        synchronized (j) { check = j.skipDup && !j.checked; }
        if (check) {
            // picked files (not folders: those always go whole) the PC has already stay here
            List<File> tops = new ArrayList<File>();
            List<String> names = new ArrayList<String>();
            List<Integer> at = new ArrayList<Integer>();
            for (int i = 0; i < j.items.size(); i++) {
                File f = files.get(i);
                if (f != null && f.isFile() && !j.items.get(i).dir) { tops.add(f); names.add(j.items.get(i).name); at.add(i); }
            }
            long bytes = 0;
            for (File f : files) if (f != null) bytes += f.isFile() ? f.length() : 0;
            boolean[] full = new boolean[1];
            Set<Integer> have = Have.check(l, auth, tops, names, bytes, full);
            if (full[0]) throw new Fatal("Not enough space on " + j.pcName);
            synchronized (j) { j.checked = true; for (Integer k : have) j.had.add(at.get(k)); }
            save(j);
        }
        Bundle b = new Bundle();
        Set<Integer> had;
        synchronized (j) { had = new HashSet<Integer>(j.had); }
        for (int i = 0; i < j.items.size(); i++) {
            File f = files.get(i);
            if (f == null || had.contains(i)) continue;
            b.add(f, j.items.get(i).name, stop);
        }
        if (b.entries.isEmpty()) {
            if (!had.isEmpty()) { tellHave(j, l, auth, j.label, had.size()); return SKIPPED; }
            throw new Fatal("Nothing to send");
        }
        String sig = b.signature();
        synchronized (j) {
            if (j.att == null || (j.sig != null && !j.sig.equals(sig))) { newAttempt(j); j.restarts = Math.max(0, j.restarts - 1); }
            j.sig = sig;
            j.total = b.bytes;
            // several streams for many files, however small they are: each file costs the PC a few disk calls in turn
            // (opened, written, dated, closed), and streams side by side do them at once (8,000 tiny files: about twice
            // as fast on the PC)
            if (j.ways == 0) j.ways = !split(j) || b.files < 2 || (b.bytes < PARALLEL_MIN && b.files < MANY_FILES) ? 1 : Math.min(4, b.files);
        }
        save(j);
        final List<Bundle> streams = b.split(j.ways);
        final int K = streams.size();
        final int[] skip = new int[K];
        final long[] from = new long[K];
        final boolean[] done = new boolean[K];
        boolean begun;
        synchronized (j) { begun = j.begun; }
        // how far the PC got: only worth a round trip when this attempt has already sent it something
        Wire.Answer st = begun ? Wire.get(l, "/api/status?" + q(j, auth), 15000) : null;
        if (st != null && st.code == 403) check(j, st);
        if (st != null && st.code == 410) { if (retried(j)) throw new Restart("tried again"); throw aborted(j, st); }
        if (st != null && st.code == 507) check(j, st);
        if (st != null && st.code == 200) {
            JSONObject o = st.json();
            if (o.optBoolean("done", false)) return DONE;
            JSONArray nx = o.optJSONArray("next"), pt = o.optJSONArray("part"), dn = o.optJSONArray("done");
            if (!"bundle".equals(o.optString("kind")) || o.optInt("streams", 0) != K || nx == null || pt == null || dn == null) throw new Restart("the PC has something else under this name");
            for (int si = 0; si < K; si++) {
                JSONObject p = pt.optJSONObject(si);
                skip[si] = p != null ? p.optInt("i", 0) : nx.optInt(si, 0);
                from[si] = p != null ? Math.max(0, p.optLong("written", 0)) : 0;
                done[si] = dn.optBoolean(si, false);
                // a file the PC was writing that's larger here than there: fine; one it has more of than exists: start it over
                if (skip[si] < streams.get(si).entries.size() && from[si] > streams.get(si).entries.get(skip[si]).size) from[si] = 0;
            }
        }
        long base = 0;
        for (int si = 0; si < K; si++) base += done[si] ? streams.get(si).bytes : streams.get(si).bytesBefore(skip[si]) + from[si];
        j.sent.set(base);
        env.changed(j);
        markBegun(j);
        List<Future<?>> fs = new ArrayList<Future<?>>();
        for (int si = 0; si < K; si++) {
            if (done[si]) continue;
            final int index = si;
            fs.add(pool.submit(new Callable<Void>() {
                @Override public Void call() throws Exception {
                    try { sendStream(j, l, auth, streams.get(index), index, K, skip[index], from[index], stop); return null; }
                    catch (Exception e) { Watchdog.abort(stop); throw e; }
                }
            }));
        }
        finish(fs, stop);
        return DONE;
    }

    private void sendStream(final Job j, Wire.Link l, String auth, Bundle b, int si, int K, int skip, long from, AtomicBoolean stop) throws IOException {
        String target = "/api/bundle?" + q(j, auth) + "&streams=" + K + "&stream=" + si + "&resume=1&skip=" + skip + "&from=" + from +
                "&files=" + (b.manifestFiles >= 0 ? b.manifestFiles : b.files) + "&bytes=" + (b.manifestBytes >= 0 ? b.manifestBytes : b.bytes) +
                (j.committed() ? "&committed=1" : "");
        Wire.Call c = Wire.Call.open(l, "POST", target, Wire.CHUNKED, "application/x-flick-bundle", 120000);
        Watchdog.Guard g = Watchdog.guard(stop, c);
        final long[] last = {0};
        boolean through = false;
        try {
            OutputStream out = new BufferedOutputStream(g.watch(c.body()), BUF);
            b.write(out, stop, new Bundle.Progress() {
                @Override public void onBytes(long sent, long total) { long d = sent - last[0]; last[0] = sent; if (d > 0) progress(j, d); }
            }, skip, from);
            out.flush();
            g.idle();
            through = true;
            check(j, c.answer(64 * 1024));
            accepted(j);
            return;
        } catch (Bundle.ResumeLost e) {
            // the file it was to carry on with can't be read now: that entry goes again from its start (or is left out)
            j.sent.addAndGet(-last[0] - from);
        } catch (Fatal e) {
            throw e;
        } catch (Aborted e) {
            throw e;
        } catch (Restart e) {
            throw e;
        } catch (IOException e) {
            if (!through) cutAnswer(j, c, g, stop);
            throw g.ended() != null ? new IOException(g.ended(), e) : e;
        } finally {
            g.close();
            c.close();
        }
        sendStream(j, l, auth, b, si, K, skip, 0, stop);
    }

    /**
     * Waits for all of them. One that failed has stopped the others (their connections are cut); the error thrown is
     * the most telling one: the PC's refusal or a "start over" over a connection that was merely cut as a result.
     */
    private static void finish(List<Future<?>> fs, AtomicBoolean stop) throws IOException {
        IOException failed = null;
        for (Future<?> f : fs) {
            IOException e2 = null;
            try { f.get(); }
            catch (ExecutionException e) {
                Throwable c = e.getCause();
                e2 = c instanceof IOException ? (IOException) c : new IOException(String.valueOf(c), c);
            } catch (InterruptedException e) {
                e2 = new IOException("interrupted");
            }
            if (e2 == null) continue;
            Watchdog.abort(stop);
            if (failed == null || rank(e2) > rank(failed)) failed = e2;
        }
        if (failed != null) throw failed;
    }

    private static int rank(IOException e) {
        if (e instanceof Fatal) return 5;
        if (e instanceof Aborted) return 4;
        if (e instanceof Restart) return 3;
        if (e instanceof Refusal) return 2;
        String m = e.getMessage();
        return m != null && (m.startsWith("aborted") || m.startsWith("stopped")) ? 0 : 1;
    }

    // ------------------------------------------------------------ telling the PC
    /** The PC has all of it already: it shows that, and nothing is sent. */
    private void tellHave(Job j, Wire.Link l, String auth, String name, int files) throws IOException {
        Wire.Answer a = Wire.call(l, "POST", "/api/have?" + auth + "&tid=" + Wire.enc(j.tid) + "&skip=1&name=" + Wire.enc(name) + "&files=" + files, new byte[0], null, 15000);
        if (a.code != 200) throw new IOException("http " + a.code);
    }

    /** Canceled here: the PC drops what arrived (best effort, off this thread). */
    private void tellCancel(final Job j) {
        final String att;
        synchronized (j) { att = j.att; }
        if (att == null) return;
        try {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        Wire.Link l = env.link(j, false);
                        Wire.call(l, "POST", "/api/cancel?" + env.auth(j) + "&tid=" + Wire.enc(j.tid), new byte[0], null, 10000);
                    } catch (Throwable e) { /* unreachable: the PC lets it go after a while */ }
                }
            });
        } catch (Throwable e) { /* shutting down */ }
    }

    // ------------------------------------------------------------ written down
    private void save(Job j) {
        if (dead) return;
        // one thread at a time: two at once (the send itself, and the page moving it to the PC's new address, say) wrote
        // over each other's half-made file, and could leave a damaged record or none (the send lost on the next start)
        synchronized (j.disk) {
            try {
                byte[] b = j.save().toString().getBytes("UTF-8");
                File tmp = new File(dir, j.tid + ".json.tmp"), f = new File(dir, j.tid + ".json");
                OutputStream o = new FileOutputStream(tmp);
                try { o.write(b); } finally { o.close(); }
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
            } catch (Throwable e) {
                env.log("outbox: can't save " + j.tid + ": " + e);
            }
        }
    }

    private void load() {
        File[] fs = dir.listFiles(new FilenameFilter() { @Override public boolean accept(File d, String n) { return n.endsWith(".json"); } });
        if (fs == null) return;
        List<Job> found = new ArrayList<Job>();
        long now = now();
        for (File f : fs) {
            Job j = null;
            try { j = Job.load(new JSONObject(read(f))); } catch (Throwable e) { /* damaged: dropped */ }
            if (j == null) { f.delete(); continue; }
            if (j.finished() && now - j.ended > KEEP_ENDED_MS) { f.delete(); continue; }
            // what was under way when the app stopped carries on; a drag that never ended doesn't
            if (QUEUED.equals(j.state) || RUNNING.equals(j.state) || WAITING.equals(j.state)) {
                if (j.committed) { j.state = QUEUED; j.why = null; }
                else { j.state = CANCELED; j.ended = now; }
            }
            found.add(j);
        }
        Collections.sort(found, new Comparator<Job>() {
            @Override public int compare(Job a, Job b) { return a.created == b.created ? 0 : (a.created < b.created ? -1 : 1); }
        });
        synchronized (this) { for (Job j : found) jobs.put(j.tid, j); }
        for (Job j : found) if (CANCELED.equals(j.state) && j.ended == now) save(j);
    }

    private void trim() {
        List<Job> drop = new ArrayList<Job>();
        synchronized (this) {
            List<Job> ended = new ArrayList<Job>();
            for (Job j : jobs.values()) if (j.finished()) ended.add(j);
            for (int i = 0; i < ended.size() - KEEP_ENDED; i++) { drop.add(ended.get(i)); jobs.remove(ended.get(i).tid); }
        }
        for (Job j : drop) new File(dir, j.tid + ".json").delete();
    }

    private static String read(File f) throws IOException {
        InputStream in = new java.io.FileInputStream(f);
        try {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) b.write(buf, 0, r);
            return b.toString("UTF-8");
        } finally { in.close(); }
    }

    /** Stops everything at once (tests: the app's process ending without warning). Nothing is written. */
    void kill() {
        dead = true;
        for (Job j : list()) synchronized (j) { Watchdog.abort(j.stop); }
        pool.shutdownNow();
        timer.shutdownNow();
    }
}
