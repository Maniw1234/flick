package com.flick.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * Home-screen widget with two buttons, "Last photo" and "Clipboard": each sends that to the paired PC through
 * ActionActivity. Layout res/layout/widget_flick.xml, provider info res/xml/widget_flick_info.xml (no R class: found by
 * name).
 */
public class FlickWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        try {
            for (int id : ids) m.updateAppWidget(id, views(c));
        } catch (Throwable e) { Bg.warn("widget", e); }
    }

    static RemoteViews views(Context c) {
        String pkg = c.getPackageName();
        RemoteViews v = new RemoteViews(pkg, c.getResources().getIdentifier("widget_flick", "layout", pkg));
        v.setOnClickPendingIntent(c.getResources().getIdentifier("w_photo", "id", pkg), pending(c, "photo", 31));
        v.setOnClickPendingIntent(c.getResources().getIdentifier("w_clip", "id", pkg), pending(c, "clip", 32));
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
