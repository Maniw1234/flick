package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * "Skip files already on the PC": which of the files about to be sent the PC has already (pc/have.js on the other side).
 * The phone asks with names and sizes; the PC answers with the fingerprints of its likely copies; only files with a
 * candidate are fingerprinted here. A fingerprint is the SHA-256 of "flick-fp1|size|" and the file's first and last
 * 256 KB (all of it when it's 512 KB or less), as hex cut to 32 characters. No Android classes, so it runs on any JVM.
 */
final class Have {
    static final int EDGE = 256 * 1024;

    private Have() {}

    static String fingerprint(File f) throws IOException {
        RandomAccessFile r = new RandomAccessFile(f, "r");
        try {
            long size = r.length();
            MessageDigest md;
            try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("no SHA-256"); }
            md.update(("flick-fp1|" + size + "|").getBytes("UTF-8"));
            if (size <= 2L * EDGE) {
                byte[] b = new byte[(int) size];
                r.readFully(b);
                md.update(b);
            } else {
                byte[] b = new byte[EDGE];
                r.readFully(b);
                md.update(b);
                r.seek(size - EDGE);
                r.readFully(b);
                md.update(b);
            }
            StringBuilder s = new StringBuilder(64);
            for (byte x : md.digest()) s.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
            return s.substring(0, 32);
        } finally {
            r.close();
        }
    }

    /**
     * Which of files (by index) the PC has already. auth: "device=..&token=..". Anything that goes wrong asking counts as
     * "none": the files are simply sent.
     */
    static Set<Integer> check(Wire.Link l, String auth, List<File> files, List<String> names) {
        return check(l, auth, files, names, 0, null);
    }

    /**
     * The same, also asking whether the PC has room for bytes (the whole send): full[0] is set when it hasn't (it
     * answers 507), so the send can say so before any of it goes.
     */
    static Set<Integer> check(Wire.Link l, String auth, List<File> files, List<String> names, long bytes, boolean[] full) {
        Set<Integer> have = new HashSet<Integer>();
        if (files.isEmpty() && bytes <= 0) return have;
        try {
            JSONArray list = new JSONArray();
            for (int i = 0; i < files.size(); i++) {
                File f = files.get(i);
                long size = f.length();
                if (size <= 0) continue;
                JSONObject o = new JSONObject();
                o.put("k", String.valueOf(i));
                o.put("name", names.get(i));
                o.put("size", size);
                list.put(o);
            }
            if (list.length() == 0 && bytes <= 0) return have;
            JSONObject body = new JSONObject();
            body.put("files", list);
            // a PC reads each likely copy it has, which takes a while for a large re-send on a slow disk: a large list goes
            // over a new connection (a kept one silent for a few seconds is given up as dead, and the list asked about
            // again), with more time the more files it names (a PC from 1.1.0 says nothing until it's done)
            int n = list.length();
            Wire.Answer a = Wire.postJson(l, "/api/have?" + auth + (bytes > 0 ? "&bytes=" + bytes : ""), body.toString(),
                    (int) Math.min(600000L, 30000L + 100L * n), n >= 20);
            if (a.code == 507 && full != null) full[0] = true;
            if (a.code != 200) return have;
            JSONObject got = a.json().optJSONObject("have");
            if (got == null) return have;
            for (int i = 0; i < files.size(); i++) {
                JSONArray fps = got.optJSONArray(String.valueOf(i));
                if (fps == null || fps.length() == 0) continue;
                String mine;
                try { mine = fingerprint(files.get(i)); } catch (IOException e) { continue; }
                for (int k = 0; k < fps.length(); k++) if (mine.equals(fps.optString(k))) { have.add(i); break; }
            }
        } catch (Throwable e) { /* asking failed: send them all */ }
        return have;
    }
}
