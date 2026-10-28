package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Downloads the phone-app update from the PC and makes sure it is exactly the file the PC announced
 * (size + SHA-256). No Android classes in here (org.json aside), so it can be exercised on any JVM.
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
            c = open(new URL(url));
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

    /**
     * A connection to url. The PC's address on this phone (the local port of the encrypted link or of the Bluetooth
     * link) is reached directly: Android gives an app its network's proxy for 127.0.0.1 too, and that proxy would get
     * the request with the pairing token in it (and can't reach this phone's ports anyway). Anything else (GitHub) goes
     * the way the network says.
     */
    static HttpURLConnection open(URL u) throws IOException {
        return (HttpURLConnection) (local(u.getHost()) ? u.openConnection(Proxy.NO_PROXY) : u.openConnection());
    }

    /** host is this phone itself (127.x.x.x, localhost, ::1). */
    static boolean local(String host) {
        String h = host == null ? "" : host.toLowerCase(java.util.Locale.US);
        return h.startsWith("127.") || h.equals("localhost") || h.equals("::1") || h.equals("[::1]");
    }

    /** A small text resource (GitHub's "latest release" JSON). */
    static String getText(String url, int max) throws IOException { return getText(url, max, "application/vnd.github+json"); }

    /** The same for any small file (a release's SHA256SUMS); redirects to another https host are followed. */
    static String getText(String url, int max, String accept) throws IOException {
        HttpURLConnection c = null;
        try {
            c = open(new URL(url));
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Accept", accept);
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

    /**
     * A GitHub release's SHA256SUMS and SHA256SUMS.sig as { sums, sig }, fetched from the download links in its JSON that
     * start with prefix (GitHub answers those with a redirect to its file host); null when it doesn't have both.
     */
    static String[] releaseSums(String releaseJson, String prefix) throws IOException {
        String sums = null, sig = null;
        try {
            JSONArray as = new JSONObject(releaseJson).optJSONArray("assets");
            for (int i = 0; as != null && i < as.length(); i++) {
                JSONObject x = as.optJSONObject(i);
                String u = x == null ? "" : x.optString("browser_download_url", "");
                if (!u.startsWith(prefix)) continue;
                if ("SHA256SUMS".equals(x.optString("name"))) sums = u;
                else if ("SHA256SUMS.sig".equals(x.optString("name"))) sig = u;
            }
        } catch (Exception e) { throw new IOException("bad release"); }
        if (sums == null || sig == null) return null;
        return new String[]{getText(sums, 64 * 1024, "application/octet-stream"), getText(sig, 4096, "application/octet-stream")};
    }

    static String hex(byte[] b) {
        char[] d = "0123456789abcdef".toCharArray();
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(d[(x >> 4) & 15]).append(d[x & 15]);
        return s.toString();
    }
}
