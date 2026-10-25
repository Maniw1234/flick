package com.flick.app;

import java.util.Locale;

/** Which links Flick opens or passes on: web addresses only (http/https, with a host, at most 4096 characters). */
final class Links {
    static final int MAX = 4096;

    private Links() {}

    /** url is an http(s) address with a host, and nothing else (no javascript:, intent:, file:, no blanks inside). */
    static boolean ok(String url) {
        if (url == null || url.length() == 0 || url.length() > MAX) return false;
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c <= 0x20 || c == 0x7f || c == '\\') return false;
        }
        String lower = url.toLowerCase(Locale.US);
        String rest;
        if (lower.startsWith("http://")) rest = url.substring(7);
        else if (lower.startsWith("https://")) rest = url.substring(8);
        else return false;
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') { end = i; break; }
        }
        String host = rest.substring(0, end);
        int at = host.lastIndexOf('@');
        if (at >= 0) host = host.substring(at + 1);
        if (host.startsWith("[")) {                                       // an IPv6 address
            int close = host.indexOf(']');
            return close > 1 && (close == host.length() - 1 || port(host.substring(close + 1)));
        }
        int colon = host.indexOf(':');
        if (colon >= 0) {
            if (!port(host.substring(colon))) return false;
            host = host.substring(0, colon);
        }
        if (host.length() == 0) return false;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            boolean fine = Character.isLetterOrDigit(c) || c == '.' || c == '-' || c == '_' || c == '%' || c == '~';
            if (!fine) return false;
        }
        return true;
    }

    // ":" followed by 1-5 digits
    private static boolean port(String s) {
        if (s.length() < 2 || s.length() > 6 || s.charAt(0) != ':') return false;
        for (int i = 1; i < s.length(); i++) if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
        return true;
    }

    /** text (shared from another app) is exactly one web address, give or take surrounding blanks: that address. */
    static String singleUrl(String text) {
        if (text == null) return null;
        String t = text.trim();
        return ok(t) ? t : null;
    }
}
