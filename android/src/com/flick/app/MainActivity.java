package com.flick.app;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.RoundedCorner;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String TAG = "Flick";
    private static final int REQ_PICK = 41;

    WebView web;
    final Handler ui = new Handler(Looper.getMainLooper());
    volatile float insetTop = 28, insetBottom = 16, cornerRadius = 0;
    private Discovery discovery;
    private Transfers transfers;
    private volatile boolean ready = false;
    private final ArrayList<String> queue = new ArrayList<String>();
    private String devId, devName;
    private AppLock lock;                            // "Lock Flick" (Settings)

    AppLock lock() { return lock; }

    // ------------------------------------------------------------ lifecycle
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Flick closed unexpectedly last time: say what happened (once), instead of starting as usual
        String crash = null;
        try { crash = CrashReport.take(this); } catch (Throwable e) { /* ignore */ }
        if (crash != null && !crash.contains("CrashActivity")) {     // (never a loop of crash screens)
            try { startActivity(new Intent(this, CrashActivity.class).putExtra(CrashActivity.EXTRA, crash)); finish(); return; }
            catch (Throwable e) { /* start as usual */ }
        }
        Page.attach(this);                           // background features reach the page through it
        lock = new AppLock(this);
        setupWindow();

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setHapticFeedbackEnabled(true);
        web.setLongClickable(false);
        web.setOnLongClickListener(new View.OnLongClickListener() { @Override public boolean onLongClick(View v) { return true; } });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // muted animation previews in the picker
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.addJavascriptInterface(new Bridge(this), "FlickNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String u = uri != null ? uri.toString() : null;
                if (u == null || !u.startsWith("https://flick.local/")) return null;
                if ("/t".equals(uri.getPath())) return Thumbs.respond(MainActivity.this, uri);
                return Library.get(MainActivity.this).intercept(u);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                ui.post(new Runnable() { @Override public void run() { recreate(); } });
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // no grey play-button placeholder while a preview clip loads
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "js: " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                readInsets(in);
                return in;
            }
        });
        setContentView(web);
        lock.onCreate();                             // covered from the start when Flick is locked
        web.loadUrl("file:///android_asset/www/index.html");
        // a share is handled once: not again when Android restores the activity after killing the app (state != null)
        if (state == null) handleIntent(getIntent());
        io().execute(new Runnable() {
            @Override
            public void run() {
                // sends that were under way when Flick was closed carry on (Sends reads what was written down)
                try { Sends.get(getApplicationContext()); } catch (Throwable e) { Log.w(TAG, "sends: " + e); }
                try { Updater.cleanupInstalled(getApplicationContext()); } catch (Throwable e) { /* ignore */ }
                // what a killed app left half-done: downloads in Download/Flick, imports onto the shelf
                try { if (Files.granted(getApplicationContext())) Files.sweepParts(); } catch (Throwable e) { /* ignore */ }
                try { Library.get(getApplicationContext()).sweep(); } catch (Throwable e) { /* ignore */ }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (lock != null) lock.onStart();            // locks again after more than 30 s away
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        emitEvent("resume");
        onScreen = true;
        Updater u = Updater.peek();
        if (u != null) u.onResume(this);
        Page.onResume(this);                         // features
        if (lock != null) lock.onResume();
    }

    @Override
    protected void onPause() {
        onScreen = false;
        emitEvent("pause");
        if (lock != null) lock.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (lock != null) lock.onStop();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (lock != null) lock.onDestroy();
        Page.detach(this);                           // features
        Updater u = Updater.peek();
        if (u != null) u.detach(this);
        if (discovery != null) discovery.setActive(false);
        if (btLink != null) btLink.setWanted(false);
        if (web != null) { web.destroy(); web = null; }
        // this activity's own threads: work already handed to them finishes, nothing new starts
        synchronized (this) {
            if (ioPool != null) ioPool.shutdown();
            if (transfers != null) transfers.shutdown();
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (lock != null && lock.onBack()) return;
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.__back&&window.__back())?'1':'0'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("1")) moveTaskToBack(true);
            }
        });
    }

    // ------------------------------------------------------------ window / insets
    @SuppressWarnings("deprecation")
    private void setupWindow() {
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try { Api30.edgeToEdge(w); } catch (Throwable e) { Log.w(TAG, "edge to edge: " + e); }   // looks only: never fatal
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @SuppressWarnings("deprecation")
    private void readInsets(WindowInsets in) {
        float d = getResources().getDisplayMetrics().density;
        int top, bottom;
        if (Build.VERSION.SDK_INT >= 30) {
            int[] tb = Api30.insets(in);
            top = tb[0]; bottom = tb[1];
        } else {
            top = in.getSystemWindowInsetTop();
            bottom = in.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= 28 && in.getDisplayCutout() != null) top = Math.max(top, in.getDisplayCutout().getSafeInsetTop());
        }
        insetTop = top / d;
        insetBottom = bottom / d;
        if (Build.VERSION.SDK_INT >= 31) {
            int r = Api31.corner(in);
            if (r > 0) cornerRadius = r / d;
        }
        try {
            JSONObject o = new JSONObject();
            o.put("t", "insets");
            o.put("top", insetTop);
            o.put("bottom", insetBottom);
            emit(o.toString());
        } catch (Throwable e) { /* ignore */ }
    }

    @TargetApi(30)
    static final class Api30 {
        static void edgeToEdge(Window w) {
            w.setDecorFitsSystemWindows(false);
            // the controller belongs to the window's decor view: make it first (Android 17 crashes when there's none yet)
            w.getDecorView();
            WindowInsetsController c = w.getInsetsController();
            if (c != null) c.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }
        static int[] insets(WindowInsets in) {
            Insets i = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            return new int[]{i.top, i.bottom};
        }
    }

    @TargetApi(31)
    static final class Api31 {
        static int corner(WindowInsets in) {
            RoundedCorner rc = in.getRoundedCorner(RoundedCorner.POSITION_TOP_LEFT);
            return rc == null ? 0 : rc.getRadius();
        }
    }

    // ------------------------------------------------------------ JS events
    void pageReady() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                ready = true;
                ArrayList<String> q;
                synchronized (queue) { q = new ArrayList<String>(queue); queue.clear(); }
                for (String s : q) evalEvent(s);
            }
        });
    }

    void emit(final String json) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (!ready) { synchronized (queue) { if (queue.size() < 200) queue.add(json); } return; }
                evalEvent(json);
            }
        });
    }

    private void evalEvent(String json) {
        if (web == null) return;
        web.evaluateJavascript("window.__native&&window.__native(" + JSONObject.quote(json) + ")", null);
    }

    void toast(String msg) {
        try { JSONObject o = new JSONObject(); o.put("t", "toast"); o.put("msg", msg); emit(o.toString()); } catch (Throwable e) { /* ignore */ }
    }

    void emitEvent(String t) {
        try { JSONObject o = new JSONObject(); o.put("t", t); emit(o.toString()); } catch (Throwable e) { /* ignore */ }
    }

    // ------------------------------------------------------------ storage access
    private static final int REQ_STORAGE = 42;
    private static final int REQ_BT = 43;
    private BtLink btLink;

    synchronized BtLink btLink() {
        if (btLink == null) {
            btLink = new BtLink(this, new BtLink.Listener() {
                @Override
                public void onBt(String state, org.json.JSONObject pc) {
                    try {
                        org.json.JSONObject o = new org.json.JSONObject();
                        o.put("t", "bt");
                        o.put("state", state);
                        if (pc != null) o.put("pc", pc);
                        emit(o.toString());
                    } catch (Throwable e) { /* ignore */ }
                }
            });
        }
        return btLink;
    }

    /** Android 12+ asks once before Flick may use paired Bluetooth devices. */
    void askBluetooth() {
        if (Build.VERSION.SDK_INT >= 31 && !BtLink.permitted(this)) {
            requestPermissions(new String[]{android.Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
        }
    }
    private java.util.concurrent.ExecutorService ioPool;

    synchronized java.util.concurrent.ExecutorService io() {
        if (ioPool == null) ioPool = java.util.concurrent.Executors.newFixedThreadPool(2);
        return ioPool;
    }

    void result(String req, String json) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", "res");
            o.put("req", req);
            o.put("data", new JSONObject(json));
            emit(o.toString());
        } catch (Throwable e) { /* ignore */ }
    }

    @SuppressWarnings("deprecation")
    void askStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Throwable e) {
                try { startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); }
                catch (Throwable x) { toast("Open Settings › Apps › Flick › Permissions to allow file access"); }
            }
        } else {
            requestPermissions(new String[]{android.Manifest.permission.READ_EXTERNAL_STORAGE, android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        if (req == REQ_STORAGE) emitEvent("storage");
        if (req == REQ_BT) emitEvent("bt-perm");
        Page.onPermissions(this, req);               // features
    }

    // ------------------------------------------------------------ services
    synchronized Discovery discovery() {
        if (discovery == null) {
            discovery = new Discovery(this, deviceId(), deviceName(), new Discovery.Listener() {
                @Override
                public void onPcs(String json) {
                    try {
                        JSONObject o = new JSONObject();
                        o.put("t", "pcs");
                        o.put("list", new JSONArray(json));
                        emit(o.toString());
                    } catch (Throwable e) { /* ignore */ }
                }
            });
        }
        return discovery;
    }

    Updater updater() { return Updater.get(this); }

    private volatile boolean onScreen = false;
    boolean isOnScreen() { return onScreen; }

    synchronized Transfers transfers() {
        if (transfers == null) {
            transfers = new Transfers(this, Library.get(this), new Transfers.Emitter() {
                @Override public void emit(JSONObject o) { MainActivity.this.emit(o.toString()); }
            });
        }
        return transfers;
    }

    synchronized String deviceId() {
        if (devId == null) {
            SharedPreferences p = getSharedPreferences("flick", 0);
            devId = p.getString("device", null);
            if (devId == null) { devId = UUID.randomUUID().toString(); p.edit().putString("device", devId).apply(); }
        }
        return devId;
    }

    String deviceName() {
        if (devName == null) {
            String n = null;
            try { n = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME); } catch (Throwable e) { /* ignore */ }
            if (n == null || n.trim().length() == 0) {
                String model = Build.MODEL == null ? "Android" : Build.MODEL;
                String man = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
                n = model.toLowerCase().startsWith(man.toLowerCase()) ? model : (man.length() > 0 ? Character.toUpperCase(man.charAt(0)) + man.substring(1) + " " : "") + model;
            }
            devName = n.trim();
        }
        return devName;
    }

    // ------------------------------------------------------------ adding files
    void launchPicker(String kind) {
        Intent i;
        if ("media".equals(kind) && Build.VERSION.SDK_INT >= 33) {
            i = new Intent(MediaStore.ACTION_PICK_IMAGES);
            int max = 50;
            try { max = Math.min(50, MediaStore.getPickImagesMaxLimit()); } catch (Throwable e) { /* ignore */ }
            if (max > 1) i.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max);
        } else if ("media".equals(kind)) {
            i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        } else {
            i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try { startActivityForResult(i, REQ_PICK); }
        catch (Throwable e) {
            try {
                Intent g = new Intent(Intent.ACTION_GET_CONTENT);
                g.addCategory(Intent.CATEGORY_OPENABLE);
                g.setType("*/*");
                g.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(g, REQ_PICK);
            } catch (Throwable x) { /* nothing can pick */ }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (lock != null && lock.onResult(req, res)) return;
        if (req != REQ_PICK || res != RESULT_OK || data == null) return;
        ArrayList<Uri> uris = new ArrayList<Uri>();
        ClipData cd = data.getClipData();
        if (cd != null) for (int k = 0; k < cd.getItemCount(); k++) { Uri u = cd.getItemAt(k).getUri(); if (u != null) uris.add(u); }
        else if (data.getData() != null) uris.add(data.getData());
        importAll(uris, null);
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent in) {
        // reopened from Recents, Android hands back the intent the app was first started with: an old share
        if (in == null || (in.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String act = in.getAction();
        ArrayList<Uri> uris = new ArrayList<Uri>();
        String text = null;
        if (Intent.ACTION_SEND.equals(act)) {
            Object u = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u instanceof Uri) uris.add((Uri) u);
            else {
                CharSequence t = in.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (t != null && t.length() > 0) text = t.toString();
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(act)) {
            ArrayList<Uri> l = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) uris.addAll(l);
        } else {
            return;
        }
        if (uris.isEmpty() && in.getClipData() != null) {
            ClipData cd = in.getClipData();
            for (int k = 0; k < cd.getItemCount(); k++) { Uri u = cd.getItemAt(k).getUri(); if (u != null) uris.add(u); }
        }
        // a single web address goes to the page ("Open on <PC>" / "Save to the Flick list"), not into a .txt
        if (uris.isEmpty() && text != null && Page.sharedLink(this, text, in.getStringExtra(Intent.EXTRA_SUBJECT))) { in.setAction(Intent.ACTION_MAIN); return; }
        String subject = in.getStringExtra(Intent.EXTRA_SUBJECT);
        importAll(uris, text == null ? null : new String[]{text, subject});
        in.setAction(Intent.ACTION_MAIN); // don't re-import on recreate
    }

    private void importAll(final ArrayList<Uri> uris, final String[] text) {
        if ((uris == null || uris.isEmpty()) && text == null) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSONArray added = new JSONArray();
                Library lib = Library.get(MainActivity.this);
                if (uris != null) for (Uri u : uris) {
                    try { added.put(lib.importUri(u)); } catch (Throwable e) { Log.w(TAG, "import failed " + e); }
                }
                if (text != null) {
                    try {
                        String title = text[1] != null && text[1].trim().length() > 0 ? text[1].trim() : "Shared text";
                        added.put(lib.importText(text[0], title.length() > 60 ? title.substring(0, 60) : title));
                    } catch (Throwable e) { /* ignore */ }
                }
                if (added.length() == 0) return;
                try {
                    JSONObject o = new JSONObject();
                    o.put("t", "added");
                    o.put("items", added);
                    emit(o.toString());
                } catch (Throwable e) { /* ignore */ }
            }
        }, "flick-import").start();
    }
}
