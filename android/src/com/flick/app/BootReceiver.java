package com.flick.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * After the phone starts, or after Flick was updated: the background link comes back if it was on, auto-send's media
 * trigger is armed again (such jobs don't survive a reboot), and widgets are redrawn.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i == null ? null : i.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        try { if (Features.bg(c)) LinkService.start(c); } catch (Throwable e) { Bg.warn("boot: link", e); }
        try { FlickWidget.refresh(c); } catch (Throwable e) { Bg.warn("boot: widget", e); }
        // the job check reads a file: off the main thread, with the broadcast kept open until it's done
        final Context app = c.getApplicationContext();
        final PendingResult done = goAsync();
        boolean started = Bg.run("boot: auto-send", new Runnable() {
            @Override
            public void run() {
                try { AutoSend.ensure(app); } finally { done.finish(); }
            }
        });
        if (!started) done.finish();
    }
}
