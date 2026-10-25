package com.flick.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;

/** Lets other apps open/share files Flick shows (read-only, only via URIs Flick hands out with a grant). */
public class FilesProvider extends ContentProvider {
    public static final String AUTHORITY = "com.flick.app.files";

    static Uri uriFor(String id, String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("f").appendPath(id).appendPath(name).build();
    }

    /** A downloaded update, for Android's installer (only files directly inside the app's update folder). */
    static Uri uriForUpdate(File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("u").appendPath(f.getName()).build();
    }

    static Uri uriForPath(String path) {
        String enc = Base64.encodeToString(path.getBytes(java.nio.charset.Charset.forName("UTF-8")), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("p").appendPath(enc).appendPath(new File(path).getName()).build();
    }

    @Override public boolean onCreate() { return true; }

    /** Resolves a URI to {file, name, mime} or null. */
    private Object[] resolve(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() < 2 || getContext() == null) return null;
        if ("f".equals(seg.get(0))) {
            JSONObject o = Library.get(getContext()).find(seg.get(1));
            if (o == null) return null;
            return new Object[]{Library.get(getContext()).fileOf(o), o.optString("name"), o.optString("mime", "application/octet-stream"), o.optLong("size")};
        }
        if ("u".equals(seg.get(0))) {
            String n = seg.get(1);
            if (!Updater.validName(n)) return null;
            File f = new File(Updater.dir(getContext()), n);
            if (!f.isFile()) return null;
            return new Object[]{f, "Flick.apk", "application/vnd.android.package-archive", f.length()};
        }
        if ("p".equals(seg.get(0))) {
            try {
                String path = new String(Base64.decode(seg.get(1), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), "UTF-8");
                File f = new File(path);
                if (!Files.allowed(f) || !f.isFile()) return null;
                return new Object[]{f, f.getName(), Files.mimeOf(f.getName()), f.length()};
            } catch (Throwable e) { return null; }
        }
        return null;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        Object[] r = resolve(uri);
        if (r == null) return null;
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = r[1];
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = r[3];
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        Object[] r = resolve(uri);
        return r == null ? null : (String) r[2];
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Object[] r = resolve(uri);
        if (r == null) throw new FileNotFoundException();
        File f = (File) r[0];
        if (!f.exists()) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
