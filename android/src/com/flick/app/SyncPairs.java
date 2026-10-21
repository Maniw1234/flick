package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.UUID;

/**
 * The phone's synced folders: one JSON file, a record per pair as syncPairs() shows it
 * ({"id","pc","pcName","path","name","pair","last","state","why"?,"files","folder"?}). "pair" is the PC's id for the
 * pair ("" until the PC made it); "state" is idle / running / error. No Android classes, so it runs on any JVM.
 */
final class SyncPairs {
    private final File file;
    private ArrayList<JSONObject> pairs;

    SyncPairs(File file) { this.file = file; }

    synchronized JSONArray list() {
        JSONArray a = new JSONArray();
        for (JSONObject p : load()) a.put(copy(p));
        return a;
    }

    synchronized JSONObject get(String id) {
        for (JSONObject p : load()) if (p.optString("id", "").equals(id)) return copy(p);
        return null;
    }

    /** The pair of this phone folder with this PC, if there is one. */
    synchronized JSONObject find(String pc, String path) {
        for (JSONObject p : load()) if (p.optString("pc", "").equals(pc) && p.optString("path", "").equals(path)) return copy(p);
        return null;
    }

    /** A new pair (not made on the PC yet). */
    synchronized JSONObject create(String pc, String pcName, String path, String name) {
        JSONObject p = new JSONObject();
        try {
            p.put("id", UUID.randomUUID().toString().replace("-", "").substring(0, 12));
            p.put("pc", pc);
            p.put("pcName", pcName);
            p.put("path", path);
            p.put("name", name);
            p.put("pair", "");
            p.put("last", 0L);
            p.put("state", "idle");
            p.put("files", 0);
        } catch (Exception e) { /* can't fail */ }
        load().add(p);
        save();
        return copy(p);
    }

    /** Sets fields of the pair id (a null value removes the field). False if there's no such pair (any more). */
    synchronized boolean update(String id, Object... kv) {
        for (JSONObject p : load()) {
            if (!p.optString("id", "").equals(id)) continue;
            try {
                for (int i = 0; i + 1 < kv.length; i += 2) {
                    String k = String.valueOf(kv[i]);
                    if (kv[i + 1] == null) p.remove(k); else p.put(k, kv[i + 1]);
                }
            } catch (Exception e) { /* bad value: skipped */ }
            save();
            return true;
        }
        return false;
    }

    synchronized boolean remove(String id) {
        ArrayList<JSONObject> l = load();
        for (int i = 0; i < l.size(); i++) {
            if (l.get(i).optString("id", "").equals(id)) { l.remove(i); save(); return true; }
        }
        return false;
    }

    synchronized int size() { return load().size(); }

    private ArrayList<JSONObject> load() {
        if (pairs != null) return pairs;
        pairs = new ArrayList<JSONObject>();
        if (!file.isFile()) return pairs;
        try {
            JSONArray a = new JSONArray(HistoryStore.read(file));
            for (int i = 0; i < a.length(); i++) {
                JSONObject p = a.optJSONObject(i);
                if (p == null || p.optString("id", "").length() == 0) continue;
                // nothing runs yet when the list is first read: a "running" left by a killed app is over
                if ("running".equals(p.optString("state", ""))) p.put("state", "idle");
                pairs.add(p);
            }
        } catch (Exception e) { /* damaged: no pairs (the PC keeps its folders) */ }
        return pairs;
    }

    private void save() {
        JSONArray a = new JSONArray();
        for (JSONObject p : load()) a.put(p);
        try { HistoryStore.write(file, a.toString()); } catch (IOException e) { /* kept in memory */ }
    }

    private static JSONObject copy(JSONObject p) {
        try { return new JSONObject(p.toString()); } catch (Exception e) { return new JSONObject(); }
    }
}
