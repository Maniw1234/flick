package com.flick.app;

import android.app.Application;
import android.content.Context;

/** Flick's process. The first thing it does is start recording what makes Flick crash (CrashReport). */
public class FlickApp extends Application {
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        CrashReport.install(base);   // before anything else in the process runs, content providers included
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // connections to a PC go over its network, also for what runs without Flick's screen (the share sheet, tiles,
        // the widget, the background link): see Sends.Nets
        Sends.Nets.install(this);
        // what moves between this phone and other devices shows in the notifications and on the page
        Moving.install(new TransferService.Shown(this));
        // Find my phone's alarm volume, if Flick was stopped while ringing (off the main thread: a settings read)
        final Context app = this;
        Bg.run("ring volume", new Runnable() { @Override public void run() { Ringer.restoreLeft(app); } });
    }
}
