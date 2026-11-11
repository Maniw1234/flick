package com.flick.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * Home-screen widget with two buttons, "Last photo" and "Clipboard": each sends that where one-tap sends go (the paired
 * PC, or the phone picked on the page) through ActionActivity. Layout res/layout/widget_flick.xml, provider info
 * res/xml/widget_flick_info.xml (no R class: found by name).
 */
public class FlickWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        try {
            for (int id : ids) m.updateAppWidget(id, views(c));
        } catch (Throwable e) { Bg.warn("widget", e); }
    }

    static RemoteViews views(Context c) {
        String res = Features.resPackage(c);       // (not the app's package in the Google Play version)
        RemoteViews v = new RemoteViews(c.getPackageName(), c.getResources().getIdentifier("widget_flick", "layout", res));
        v.setOnClickPendingIntent(c.getResources().getIdentifier("w_photo", "id", res), pending(c, "photo", 31));
        v.setOnClickPendingIntent(c.getResources().getIdentifier("w_clip", "id", res), pending(c, "clip", 32));
        return v;
    }

    private static PendingIntent pending(Context c, String what, int code) {
        return PendingIntent.getActivity(c, code, ActionActivity.intent(c, what, "widget"), Features.piFlags());
    }

    /** Redraws every Flick widget (after an update of the app, say). */
    static void refresh(Context c) {
        try {
            AppWidgetManager m = AppWidgetManager.getInstance(c);
            if (m == null) return;
            int[] ids = m.getAppWidgetIds(new ComponentName(c, FlickWidget.class));
            if (ids != null && ids.length > 0) for (int id : ids) m.updateAppWidget(id, views(c));
        } catch (Throwable e) { Bg.warn("widget", e); }
    }
}
