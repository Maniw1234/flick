package com.flick.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * An image the PC put on this phone's clipboard, for the app that pastes it: read-only, not exported (Android grants
 * the pasting app access to the one image on the clipboard). The newest few are kept in the app's cache.
 */
public class ClipProvider extends ContentProvider {
    static final String AUTHORITY = "com.flick.app.clip";
    private static final int KEEP = 3;

    static File dir(Context c) { return new File(c.getApplicationContext().getCacheDir(), "clip"); }

    /** Saves a PNG from the PC; older ones beyond the newest few go. */
    static File save(Context c, byte[] png) throws IOException {
        File d = dir(c);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("no cache folder");
        File f = new File(d, "clip-" + System.currentTimeMillis() + ".png");
        Clip.writeFile(f, png);
        Clip.keepNewest(d, KEEP);
        return f;
    }

    static Uri uriFor(File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(f.getName()).build();
    }

    @Override public boolean onCreate() { return true; }

    private File resolve(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() != 1 || getContext() == null) return null;
        String n = seg.get(0);
        if (!n.matches("clip-[0-9]{1,20}\\.png")) return null;
        File f = new File(dir(getContext()), n);
        return f.isFile() ? f : null;
    }

    @Override
    public String getType(Uri uri) { return resolve(uri) == null ? null : "image/png"; }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f = resolve(uri);
        if (f == null) return null;
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = "Image from PC.png";
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null || (mode != null && !mode.equals("r"))) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
