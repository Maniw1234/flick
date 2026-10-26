package com.flick.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.SparseArray;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Auto-send (setting "screenshots" or "photos"): new screenshots (a folder named Screenshots), or new camera photos and
 * videos (DCIM/Camera), go to the paired PC by themselves, as quiet uploads (kind=screenshot|photo). A JobScheduler job
 * with content triggers on the media index wakes it when something is added (re-armed after each run, and at boot:
 * such jobs can't persist); what can't be sent now (PC away, no pairing yet) waits, at most 50, and is retried by a
 * second job every 15 minutes and whenever the background link reaches the PC.
 */
public class AutoSend extends JobService {
    static final int JOB_TRIGGER = 2001, JOB_RETRY = 2002;
    static final long RETRY_MS = 15 * 60 * 1000L;
    private static final int MAX_ROWS = 200;

    private static final AtomicBoolean busy = new AtomicBoolean(false);
    private static final AtomicBoolean again = new AtomicBoolean(false);
    private static int gen;                             // bumped when the mode changes: a pass under the old one saves nothing
    private final SparseArray<AtomicBoolean> stops = new SparseArray<AtomicBoolean>();

    // ------------------------------------------------------------ switching and scheduling (any thread)
    /** The setting changed: a new mode starts from now (nothing taken before is sent); off forgets what waits. */
    static void modeChanged(Context c, String mode) {
        Context app = c.getApplicationContext();
        synchronized (AutoSend.class) {
            gen++;
            if ("off".equals(mode)) new File(app.getFilesDir(), "autosend.json").delete();
            else save(app, AutoSendQueue.start(System.currentTimeMillis() / 1000));
        }
        schedule(app);
    }

    /** Arms the media trigger for the current mode (or cancels both jobs when it's off). */
    static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            String mode = Features.autoSend(c);
            if ("off".equals(mode)) { js.cancel(JOB_TRIGGER); js.cancel(JOB_RETRY); return; }
            JobInfo.Builder b = new JobInfo.Builder(JOB_TRIGGER, new ComponentName(c, AutoSend.class));
            b.addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS));
            if ("photos".equals(mode)) b.addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS));
            b.setTriggerContentUpdateDelay(1000);              // a burst of changes (a photo being written) settles first
            b.setTriggerContentMaxDelay(10000);
            js.schedule(b.build());
        } catch (Throwable e) { Bg.warn("auto-send schedule", e); }
    }

    /** At boot, after an update, or when Flick opens: the trigger is armed and waiting items get their retry. */
    static void ensure(Context c) {
        try {
            if ("off".equals(Features.autoSend(c))) return;
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            if (js.getPendingJob(JOB_TRIGGER) == null) schedule(c);
            if (js.getPendingJob(JOB_RETRY) == null && !load(c.getApplicationContext()).outbox.isEmpty()) retryLater(c, RETRY_MS);
        } catch (Throwable e) { Bg.warn("auto-send ensure", e); }
    }

    static void retryLater(Context c, long ms) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo.Builder b = new JobInfo.Builder(JOB_RETRY, new ComponentName(c, AutoSend.class));
            b.setMinimumLatency(ms);
            b.setOverrideDeadline(ms * 2);
            js.schedule(b.build());
        } catch (Throwable e) { Bg.warn("auto-send retry", e); }
    }

    /** The PC is reachable again (the background link connected): what waits goes now. */
    static void kick(Context c) {
        final Context app = c.getApplicationContext();
        if ("off".equals(Features.autoSend(app))) return;
        Bg.run("auto-send", new Runnable() { @Override public void run() { work(app, null); } });
    }

    // ------------------------------------------------------------ jobs
    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context app = getApplicationContext();
        final AtomicBoolean stop = new AtomicBoolean(false);
        synchronized (stops) { stops.put(params.getJobId(), stop); }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    work(app, stop);
                } catch (Throwable e) {
                    Bg.warn("auto-send", e);
                } finally {
                    synchronized (stops) { stops.remove(params.getJobId()); }
                    // re-armed before finishing: changes seen while this ran carry over to the new job
                    if (params.getJobId() == JOB_TRIGGER) schedule(app);
                    try { jobFinished(params, false); } catch (Throwable e) { /* the job was replaced */ }
                }
            }
        }, "flick-autosend");
        t.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        AtomicBoolean stop;
        synchronized (stops) { stop = stops.get(params.getJobId()); }
        if (stop != null) Watchdog.abort(stop);                // the upload under way stops now; its item waits
        return false;                                          // re-armed / retried by work() itself
    }

    // ------------------------------------------------------------ the work
    /** One pass (two if something new arrived meanwhile); never two at once. */
    static void work(Context c, AtomicBoolean stop) {
        if (!busy.compareAndSet(false, true)) { again.set(true); return; }
        try {
            do {
                again.set(false);
                once(c, stop);
            } while (again.get() && (stop == null || !stop.get()));
        } finally {
            busy.set(false);
        }
    }

    private static void once(Context c, AtomicBoolean stop) {
        String mode = Features.autoSend(c);
        if ("off".equals(mode)) return;
        long now = System.currentTimeMillis() / 1000;
        final int g;
        final AutoSendQueue q;
        synchronized (AutoSend.class) { g = gen; q = load(c); }
        List<AutoSendQueue.Item> rows;
        try { rows = query(c, mode, q.since); } catch (Throwable e) { Bg.warn("auto-send query", e); rows = new ArrayList<AutoSendQueue.Item>(); }
        List<AutoSendQueue.Item> dropped = q.offer(rows, now);
        q.advance(now);
        if (!save(c, q, g)) return;
        for (AutoSendQueue.Item d : dropped) history(c, d, false, null);
        if (q.outbox.isEmpty()) return;

        PcClient client = Bg.client(c);
        PcClient.Target t;
        try { t = client.target(); }
        catch (PcClient.Failure f) { retryLater(c, RETRY_MS); return; }   // no paired PC yet: quietly, later
        ContentResolver cr = c.getContentResolver();
        for (AutoSendQueue.Item it : q.waitingItems()) {
            if ((stop != null && stop.get()) || !mode.equals(Features.autoSend(c))) break;
            try {
                Uri u = Uri.parse(it.uri);
                long size = sizeOf(cr, u, it.size);
                client.upload(t, Bg.uriSource(c, u, size), it.name, it.kind, stop);
                q.sent(it);
                it.size = size;
                if (!save(c, q, g)) return;
                history(c, it, true, t);
            } catch (FileNotFoundException gone) {
                q.gone(it);                                              // deleted before it could go
                if (!save(c, q, g)) return;
            } catch (PcClient.Failure f) {
                if (f.is(PcClient.Failure.REFUSED) || f.is(PcClient.Failure.LOCAL)) {
                    String no = Bg.declined(f);                          // the PC's user said no: it isn't asked again
                    boolean givenUp;
                    if (no != null) { q.gone(it); givenUp = true; } else givenUp = q.failed(it);
                    if (!save(c, q, g)) return;
                    if (givenUp) history(c, it, false, t, no);
                    continue;
                }
                // the PC is away, not paired any more, or this was stopped: everything waits for the next try
                save(c, q, g);
                retryLater(c, RETRY_MS);
                return;
            } catch (Throwable e) {
                Bg.warn("auto-send item", e);
                boolean givenUp = q.failed(it);
                if (!save(c, q, g)) return;
                if (givenUp) history(c, it, false, t);
            }
        }
        if (!q.outbox.isEmpty()) retryLater(c, RETRY_MS);
    }

    private static long sizeOf(ContentResolver cr, Uri u, long fallback) throws FileNotFoundException {
        ParcelFileDescriptor fd = cr.openFileDescriptor(u, "r");
        if (fd == null) throw new FileNotFoundException();
        try { long s = fd.getStatSize(); return s >= 0 ? s : fallback; }
        finally { try { fd.close(); } catch (Throwable e) { /* ignore */ } }
    }

    private static void history(Context c, AutoSendQueue.Item it, boolean ok, PcClient.Target t) { history(c, it, ok, t, null); }

    private static void history(Context c, AutoSendQueue.Item it, boolean ok, PcClient.Target t, String why) {
        String kind = it.mime != null && it.mime.startsWith("video/") ? "video" : "image";
        Bg.historyAdd(c, "out", it.name, it.size, it.path, kind, "auto", ok, t, why);
    }

    // ------------------------------------------------------------ the media index
    /** New items for the mode, added at or after since (seconds), oldest first. */
    static List<AutoSendQueue.Item> query(Context c, String mode, long since) {
        List<AutoSendQueue.Item> out = new ArrayList<AutoSendQueue.Item>();
        boolean shots = "screenshots".equals(mode);
        rows(c, out, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "i:", shots, since);
        if (!shots) rows(c, out, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "v:", false, since);
        Collections.sort(out, new Comparator<AutoSendQueue.Item>() {
            @Override public int compare(AutoSendQueue.Item a, AutoSendQueue.Item b) { return a.added == b.added ? 0 : (a.added < b.added ? -1 : 1); }
        });
        return out;
    }

    private static void rows(Context c, List<AutoSendQueue.Item> out, Uri coll, String prefix, boolean shots, long since) {
        boolean q = Build.VERSION.SDK_INT >= 29;
        String[] proj = q ? new String[]{"_id", "_display_name", "_size", "date_added", "datetaken", "mime_type", "_data", "relative_path"}
                : new String[]{"_id", "_display_name", "_size", "date_added", "datetaken", "mime_type", "_data"};
        String where;
        String[] args;
        if (q) {
            where = "(relative_path LIKE ? OR _data LIKE ?)";
            args = shots ? new String[]{"%Screenshots%", "%/Screenshots/%", ""} : new String[]{"DCIM/Camera/%", "%/DCIM/Camera/%", ""};
        } else {
            where = "_data LIKE ?";
            args = new String[]{shots ? "%/Screenshots/%" : "%/DCIM/Camera/%", ""};
        }
        where += " AND date_added >= ? AND _size > 0";
        args[args.length - 1] = String.valueOf(since);
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(coll, proj, where, args, "date_added ASC");
            if (cur == null) return;
            int iId = cur.getColumnIndex("_id"), iName = cur.getColumnIndex("_display_name"), iSize = cur.getColumnIndex("_size");
            int iAdded = cur.getColumnIndex("date_added"), iTaken = cur.getColumnIndex("datetaken"), iMime = cur.getColumnIndex("mime_type"), iData = cur.getColumnIndex("_data");
            int n = 0;
            while (cur.moveToNext() && n++ < MAX_ROWS) {
                long id = cur.getLong(iId);
                String path = iData >= 0 ? cur.getString(iData) : null;
                String name = iName >= 0 ? cur.getString(iName) : null;
                if (name == null || name.length() == 0) name = path != null ? new File(path).getName() : "photo-" + id;
                if (name.startsWith(".")) continue;                     // a hidden file (an app's own)
                AutoSendQueue.Item it = new AutoSendQueue.Item();
                it.key = prefix + id;
                it.uri = ContentUris.withAppendedId(coll, id).toString();
                it.path = path == null ? "" : path;
                it.name = name;
                it.mime = iMime >= 0 ? cur.getString(iMime) : "";
                it.kind = shots ? "screenshot" : "photo";
                it.size = cur.getLong(iSize);
                it.added = cur.getLong(iAdded);
                it.taken = iTaken >= 0 && !cur.isNull(iTaken) ? cur.getLong(iTaken) : 0;
                out.add(it);
            }
        } catch (SecurityException e) {
            Bg.log("auto-send: no access to photos (Flick needs file access)");
        } finally {
            if (cur != null) cur.close();
        }
    }

    // ------------------------------------------------------------ state file
    static synchronized AutoSendQueue load(Context c) {
        File f = new File(c.getFilesDir(), "autosend.json");
        long now = System.currentTimeMillis() / 1000;
        if (!f.isFile()) {
            AutoSendQueue q = AutoSendQueue.start(now);
            save(c, q);
            return q;
        }
        try { return AutoSendQueue.fromJson(HistoryStore.read(f), now); } catch (Throwable e) { return AutoSendQueue.start(now); }
    }

    /** Saves q unless the mode changed since it was loaded (generation g); false then. */
    static synchronized boolean save(Context c, AutoSendQueue q, int g) {
        if (g != gen) return false;
        save(c, q);
        return true;
    }

    static synchronized void save(Context c, AutoSendQueue q) {
        try { HistoryStore.write(new File(c.getFilesDir(), "autosend.json"), q.toJson()); } catch (Throwable e) { Bg.warn("auto-send save", e); }
    }
}
