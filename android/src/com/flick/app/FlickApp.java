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
}
