package com.flick.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Downloads the phone-app update from the PC and makes sure it is exactly the file the PC announced
 * (size + SHA-256). No Android classes in here, so it can be exercised on any JVM.
 */
final class UpdateFetch {
    interface Progress { void onBytes(long got, long total); }

    static final long MAX = 200L * 1024 * 1024;

    static void fetch(String url, File dest, long size, String sha256, AtomicBoolean abort, Progress p) throws IOException {
        if (size <= 0 || size > MAX) throw new IOException("bad size");
        if (sha256 == null || sha256.length() != 64) throw new IOException("bad checksum");
        File part = new File(dest.getPath() + ".part");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(30000);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("http " + code);
            long len = c.getContentLengthLong();
            if (len >= 0 && len != size) throw new IOException("size changed");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            InputStream in = c.getInputStream();
            OutputStream out = new FileOutputStream(part);
            long got = 0;
            try {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (abort != null && abort.get()) throw new IOException("aborted");
                    got += n;
                    if (got > size) throw new IOException("too long");
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                    if (p != null) p.onBytes(got, size);
                }
            } finally {
                try { out.close(); } catch (IOException e) { /* ignore */ }
                try { in.close(); } catch (IOException e) { /* ignore */ }
            }
            if (got != size) throw new IOException("incomplete");
            if (!hex(md.digest()).equalsIgnoreCase(sha256)) throw new IOException("checksum");
            if (dest.exists() && !dest.delete()) throw new IOException("can't replace");
            if (!part.renameTo(dest)) throw new IOException("rename failed");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("no SHA-256");
        } finally {
            if (c != null) c.disconnect();
            if (part.exists()) part.delete();
        }
    }

    /** A small text resource (GitHub's "latest release" JSON). */
    static String getText(String url, int max) throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "Flick-phone");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("http " + code);
            InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (out.size() + n > max) throw new IOException("too long");
                    out.write(buf, 0, n);
                }
            } finally {
                try { in.close(); } catch (IOException e) { /* ignore */ }
            }
            return new String(out.toByteArray(), "UTF-8");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String hex(byte[] b) {
        char[] d = "0123456789abcdef".toCharArray();
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(d[(x >> 4) & 15]).append(d[x & 15]);
        return s.toString();
    }
}
