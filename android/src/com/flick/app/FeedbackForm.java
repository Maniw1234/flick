package com.flick.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Send feedback, the part that needs nothing from Android: the Google Form (the one place its ids live in the phone
 * app), the form post (application/x-www-form-urlencoded to .../formResponse, one entry.<id> per field) and the outbox
 * of messages that wait for a connection (one JSON file). Runs on any JVM. Feedback is the Android side.
 */
final class FeedbackForm {
    // ==================================================================================================================
    // THE GOOGLE FORM. Fill these in from the form's pre-filled link (in the form: More > Get pre-filled link; the
    // address it gives has /forms/d/e/<FORM_ID>/viewform and one entry.<number>=... per question). The PC app has the
    // same block in pc/feedback.js. While FORM_ID is the placeholder, Settings > Send feedback says it isn't set up yet
    // and nothing is sent.
    static final String FORM_ID = "PLACEHOLDER_FORM_ID";              // the long id between /forms/d/e/ and /viewform
    static final String ENTRY_TYPE = "entry.PLACEHOLDER_TYPE";        // "Bug" or "Idea" (a choice with those two)
    static final String ENTRY_MESSAGE = "entry.PLACEHOLDER_MESSAGE";
    static final String ENTRY_EMAIL = "entry.PLACEHOLDER_EMAIL";
    static final String ENTRY_DEVICE = "entry.PLACEHOLDER_DEVICE";    // device info, and the last crash report if attached
    // ==================================================================================================================

    /** Tests only: a JVM test points this at a local stand-in for Google. Nothing in the app ever sets it. */
    static volatile String testUrl;

    static final int MESSAGE_MAX = 5000;
    static final int EMAIL_MAX = 200;
    static final int DEVICE_MAX = 40000;
    static final int OUTBOX_MAX = 20;
    static volatile int CONNECT_MS = 15000;
    static volatile int READ_MS = 20000;

    static final String OK = "ok";                  // the form took it
    static final String REFUSED = "refused";        // the form said no (gone, closed, wants a sign-in): sending again won't help
    static final String OFFLINE = "offline";        // no connection, or a hiccup: kept and sent later

    private FeedbackForm() {}

    static boolean ready() {
        return testUrl != null || !(FORM_ID + ENTRY_TYPE + ENTRY_MESSAGE + ENTRY_EMAIL + ENTRY_DEVICE).contains("PLACEHOLDER");
    }

    static String url() {
        String t = testUrl;
        return t != null ? t : "https://docs.google.com/forms/d/e/" + FORM_ID + "/formResponse";
    }

    /** The form's body: exactly these four fields. */
    static String body(String type, String message, String email, String device) {
        return field(ENTRY_TYPE, "idea".equals(type) ? "Idea" : "Bug") + "&" + field(ENTRY_MESSAGE, cut(message, MESSAGE_MAX)) + "&"
                + field(ENTRY_EMAIL, cut(email, EMAIL_MAX)) + "&" + field(ENTRY_DEVICE, cut(device, DEVICE_MAX));
    }

    private static String field(String k, String v) {
        try { return URLEncoder.encode(k, "UTF-8") + "=" + URLEncoder.encode(v == null ? "" : v, "UTF-8"); }
        catch (Exception e) { return ""; }
    }

    static String cut(String s, int max) { return s == null ? "" : s.length() > max ? s.substring(0, max) : s; }

    /** A plain email address check (something@something.something, no blanks). */
    static boolean emailOk(String e) { return e != null && e.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"); }

    /** Posts a body made by body(): OK, REFUSED or OFFLINE. */
    static String post(String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url()).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(true);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            byte[] b = body.getBytes("UTF-8");
            c.setFixedLengthStreamingMode(b.length);
            OutputStream o = c.getOutputStream();
            try { o.write(b); } finally { o.close(); }
            int code = c.getResponseCode();
            drain(code >= 400 ? c.getErrorStream() : c.getInputStream());
            // a form that wants a Google sign-in sends the post on to the sign-in page: that isn't a response
            String host = c.getURL() == null ? "" : c.getURL().getHost();
            if (code >= 200 && code < 300 && !"accounts.google.com".equals(host)) return OK;
            return code >= 500 || code == 429 || code == 408 ? OFFLINE : REFUSED;
        } catch (IOException e) {
            return OFFLINE;
        } catch (RuntimeException e) {
            return OFFLINE;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void drain(InputStream in) {
        if (in == null) return;
        try {
            byte[] buf = new byte[16 * 1024];
            int total = 0, n;
            while ((n = in.read(buf)) > 0 && (total += n) < 2 * 1024 * 1024) { /* Google's page isn't needed */ }
        } catch (IOException e) { /* ignore */ }
        finally { try { in.close(); } catch (IOException e) { /* ignore */ } }
    }

    // ------------------------------------------------------------ the outbox: messages that wait for a connection
    /** Keeps a message ({id, at, body, ...}) to send later; the oldest go when there are too many. */
    static synchronized void keep(File f, JSONObject item) {
        JSONArray a = waiting(f);
        JSONArray out = new JSONArray();
        int skip = Math.max(0, a.length() + 1 - OUTBOX_MAX);
        for (int i = skip; i < a.length(); i++) out.put(a.opt(i));
        out.put(item);
        try { HistoryStore.write(f, out.toString()); } catch (IOException e) { /* it can't be kept */ }
    }

    /** What waits, oldest first. */
    static synchronized JSONArray waiting(File f) {
        if (!f.isFile()) return new JSONArray();
        try { return new JSONArray(HistoryStore.read(f)); } catch (Exception e) { return new JSONArray(); }
    }

    /** One message went (or will never go): out of the outbox. */
    static synchronized void drop(File f, String id) {
        JSONArray a = waiting(f), out = new JSONArray();
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o != null && !id.equals(o.optString("id"))) out.put(o); }
        try {
            if (out.length() == 0) f.delete(); else HistoryStore.write(f, out.toString());
        } catch (IOException e) { /* ignore */ }
    }
}
