package com.flick.app;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Moves bytes between the phone and the PC over plain HTTP on the local network. */
final class Transfers {
    interface Emitter { void emit(JSONObject o); }

    private final Context ctx;
    private final Library lib;
    private final Emitter em;
    private final ConcurrentHashMap<String, AtomicBoolean> aborts = new ConcurrentHashMap<String, AtomicBoolean>();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    Transfers(Context ctx, Library lib, Emitter em) {
        this.ctx = ctx.getApplicationContext();
        this.lib = lib;
        this.em = em;
    }

    private void event(String t, String key, String id, Object a, Object b, Object c) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", t);
            o.put(key, id);
            if (a != null) o.put(t.endsWith("-done") ? "ok" : (t.equals("up") ? "sent" : "got"), a);
            if (b != null) o.put(t.endsWith("-done") ? (t.startsWith("up") ? "code" : "item") : "total", b);
            if (c != null) o.put("why", c);
            em.emit(o);
        } catch (Throwable e) { /* ignore */ }
    }

    void upload(final String tid, final String id, final String url) {
        uploadFile(tid, null, id, url);
    }

    void uploadPath(final String tid, final String path, final String url) {
        uploadFile(tid, path, null, url);
    }

    private void uploadFile(final String tid, final String path, final String id, final String url) {
        final AtomicBoolean abort = new AtomicBoolean(false);
        AtomicBoolean prev = aborts.put(tid, abort);
        if (prev != null) prev.set(true);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                int code = 0;
                String why = null;
                HttpURLConnection c = null;
                InputStream in = null;
                try {
                    File f = path != null ? new File(path) : lib.file(id);
                    if (path != null && !Files.allowed(f)) throw new IOException("not allowed");
                    if (f == null || !f.exists()) throw new IOException("missing file");
                    long total = f.length();
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(60000);
                    c.setDoOutput(true);
                    c.setUseCaches(false);
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/octet-stream");
                    c.setFixedLengthStreamingMode(total);
                    OutputStream out = c.getOutputStream();
                    in = new FileInputStream(f);
                    byte[] buf = new byte[256 * 1024];
                    long sent = 0, last = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (abort.get()) throw new IOException("aborted");
                        out.write(buf, 0, n);
                        sent += n;
                        long now = SystemClock.uptimeMillis();
                        if (now - last > 150) { last = now; event("up", "tid", tid, sent, total, null); }
                    }
                    out.flush();
                    out.close();
                    code = c.getResponseCode();
                    ok = code == 200;
                    try { InputStream r = ok ? c.getInputStream() : c.getErrorStream(); if (r != null) Library.readAll(r, 64 * 1024); } catch (Throwable e) { /* ignore */ }
                } catch (Throwable e) {
                    why = e.getMessage();
                } finally {
                    try { if (in != null) in.close(); } catch (Throwable e) { /* ignore */ }
                    if (c != null) c.disconnect();
                    aborts.remove(tid, abort);
                }
                event("up-done", "tid", tid, ok, code, why);
            }
        });
    }

    /** Several items and/or folders in one streamed request (see Bundle). */
    void uploadBundle(final String tid, final String itemsJson, final String url) {
        final AtomicBoolean abort = new AtomicBoolean(false);
        AtomicBoolean prev = aborts.put(tid, abort);
        if (prev != null) prev.set(true);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                int code = 0;
                String why = null;
                HttpURLConnection c = null;
                try {
                    JSONArray arr = new JSONArray(itemsJson);
                    Bundle b = new Bundle();
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject it = arr.getJSONObject(i);
                        String name = it.optString("name", "");
                        File f;
                        if (it.has("path")) {
                            f = new File(it.getString("path"));
                            if (!Files.allowed(f)) throw new IOException("not allowed");
                        } else {
                            f = lib.file(it.optString("id"));
                        }
                        if (f == null || !f.exists()) throw new IOException("missing " + name);
                        b.add(f, name, abort);
                    }
                    c = (HttpURLConnection) new URL(url + "&files=" + b.files + "&bytes=" + b.bytes).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(120000);
                    c.setDoOutput(true);
                    c.setUseCaches(false);
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/x-flick-bundle");
                    c.setChunkedStreamingMode(256 * 1024);
                    OutputStream out = new BufferedOutputStream(c.getOutputStream(), 256 * 1024);
                    final long[] last = {0};
                    b.write(out, abort, new Bundle.Progress() {
                        @Override
                        public void onBytes(long sent, long total) {
                            long now = SystemClock.uptimeMillis();
                            if (now - last[0] > 150) { last[0] = now; event("up", "tid", tid, sent, total, null); }
                        }
                    });
                    out.close();
                    code = c.getResponseCode();
                    ok = code == 200;
                    try { InputStream r = ok ? c.getInputStream() : c.getErrorStream(); if (r != null) Library.readAll(r, 64 * 1024); } catch (Throwable e) { /* ignore */ }
                } catch (Throwable e) {
                    why = e.getMessage();
                } finally {
                    if (c != null) c.disconnect();
                    aborts.remove(tid, abort);
                }
                event("up-done", "tid", tid, ok, code, why);
            }
        });
    }

    void abort(String tid) {
        AtomicBoolean a = aborts.get(tid);
        if (a != null) a.set(true);
    }

    void download(final String fid, final String url, final String name, final String mime) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                JSONObject item = null;
                HttpURLConnection c = null;
                String why = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(60000);
                    c.setUseCaches(false);
                    int code = c.getResponseCode();
                    if (code != 200) throw new IOException("http " + code);
                    final long total = c.getContentLengthLong();
                    InputStream in = c.getInputStream();
                    Library.Progress prog = new Library.Progress() {
                        long last = 0;
                        @Override
                        public boolean onBytes(long got) {
                            long now = SystemClock.uptimeMillis();
                            if (now - last > 120) { last = now; event("down", "fid", fid, got, total, null); }
                            return true;
                        }
                    };
                    try {
                        if (Files.granted(ctx)) {
                            // Flick can see shared storage: save straight into Download/Flick like a normal download
                            File dest = Files.uniqueIn(Files.inbox(), name);
                            File part = new File(dest.getPath() + ".flickpart");
                            OutputStream out = new java.io.FileOutputStream(part);
                            try {
                                byte[] buf = new byte[256 * 1024];
                                long got = 0;
                                int n;
                                while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); got += n; prog.onBytes(got); }
                            } catch (IOException e) { out.close(); part.delete(); throw e; }
                            out.close();
                            if (!part.renameTo(dest)) { part.delete(); throw new IOException("rename failed"); }
                            android.media.MediaScannerConnection.scanFile(ctx, new String[]{dest.getPath()}, null, null);
                            item = Files.fileJson(dest, null);
                        } else {
                            item = lib.importStream(in, name, mime, prog);
                            if (Build.VERSION.SDK_INT >= 29) {
                                try {
                                    File f = lib.file(item.optString("id"));
                                    if (f != null) PublicSave.save(ctx, f, item.optString("name"), item.optString("mime"));
                                } catch (Throwable e) { /* the copy inside Flick still exists */ }
                            }
                        }
                    } finally { try { in.close(); } catch (Throwable e) { /* ignore */ } }
                    ok = true;
                } catch (Throwable e) {
                    why = e.getMessage();
                } finally {
                    if (c != null) c.disconnect();
                }
                event("down-done", "fid", fid, ok, item, why);
            }
        });
    }

    /** Copy a file into the phone's public Pictures / Movies / Music / Download folders. */
    @TargetApi(29)
    static final class PublicSave {
        static String save(Context ctx, File f, String name, String mime) throws IOException {
            ContentResolver cr = ctx.getContentResolver();
            String m = mime == null ? "application/octet-stream" : mime;
            Uri coll;
            String rel, label;
            if (m.startsWith("image/")) {
                coll = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                rel = Environment.DIRECTORY_PICTURES + "/Flick"; label = "Pictures";
            } else if (m.startsWith("video/")) {
                coll = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                rel = Environment.DIRECTORY_MOVIES + "/Flick"; label = "Movies";
            } else if (m.startsWith("audio/")) {
                coll = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                rel = Environment.DIRECTORY_MUSIC + "/Flick"; label = "Music";
            } else {
                coll = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                rel = Environment.DIRECTORY_DOWNLOADS + "/Flick"; label = "Downloads";
            }
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, m);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri u = cr.insert(coll, v);
            if (u == null) throw new IOException("insert failed");
            OutputStream out = cr.openOutputStream(u);
            InputStream in = new FileInputStream(f);
            try {
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                in.close();
                if (out != null) out.close();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(u, done, null, null);
            return label + "/Flick";
        }
    }
}
