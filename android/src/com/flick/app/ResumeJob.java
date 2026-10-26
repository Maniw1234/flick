package com.flick.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Brings Flick back to carry on with sends that were under way when Android stopped the app (it ran out of memory, an
 * aggressive battery saver closed it, the phone restarted). Scheduled while any send is unfinished, it runs once the
 * phone is on a network; while it runs, the app stays up and the sends carry on from where the PC stands. Android ends
 * a job like this after some minutes: it's then scheduled again until nothing is left.
 */
public class ResumeJob extends JobService {
    static final int ID = 2101;
    private static volatile JobParameters current;

    static void schedule(Context c, long delayMs) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null || js.getPendingJob(ID) != null || current != null) return;
            JobInfo.Builder b = new JobInfo.Builder(ID, new ComponentName(c, ResumeJob.class));
            b.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY);
            b.setMinimumLatency(delayMs);
            b.setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_LINEAR);
            b.setPersisted(true);                       // after a restart too (RECEIVE_BOOT_COMPLETED)
            js.schedule(b.build());
        } catch (Throwable e) { Bg.warn("resume job", e); }
    }

    static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null && js.getPendingJob(ID) != null && current == null) js.cancel(ID);
        } catch (Throwable e) { /* ignore */ }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Sends s = Sends.get(this);               // reading what was written down carries on with it
        if (!s.box.active()) return false;
        current = params;
        s.box.kick();
        // done once nothing is left to send (checked now and then; the sends themselves run on their own threads)
        final Runnable check = new Runnable() {
            @Override
            public void run() {
                if (current != params) return;
                if (s.box.active()) { Bg.mainDelayed(this, 5000); return; }
                current = null;
                try { jobFinished(params, false); } catch (Throwable e) { /* replaced */ }
            }
        };
        Bg.mainDelayed(check, 5000);
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (current == params) current = null;
        // Android ends it (time's up, or the network went): again later if anything is left
        Sends s = Sends.peek();
        return s != null && s.box.active();
    }
}
