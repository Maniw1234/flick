package com.flick.app;

import java.text.Normalizer;
import java.util.Locale;

/** Which links Flick opens or passes on: web addresses only (http/https, with a host, at most 4096 characters). */
final class Links {
    static final int MAX = 4096;

    private Links() {}

    /**
     * url is an http(s) address with a host, and nothing else (no javascript:, intent:, file:, no user name before the
     * host, no blanks inside, none of Unicode's direction controls: shown in a notification or on the page, they would
     * turn the rest of the address around, so that one going elsewhere reads as a known site; an address never has them,
     * a browser writes %E2%80%AE).
     */
    static boolean ok(String url) {
        if (url == null || url.length() == 0 || url.length() > MAX) return false;
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c <= 0x20 || c == 0x7f || c == '\\') return false;
            if (c == 0x061c || c == 0x200e || c == 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return false;
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
        // a name before the host ("https://bank.example@evil.example") reads as one site and opens another: refused, as
        // the PC does (phoneapi.js cleanUrl); an "@" after the host (a path, a query) is fine
        if (host.indexOf('@') >= 0) return false;
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
            // (no '%': "bank.example%40evil.example" is an '@' once decoded, and no real host is written so; the PC
            // refuses it too)
            boolean fine = Character.isLetterOrDigit(c) || c == '.' || c == '-' || c == '_' || c == '~';
            if (!fine) return false;
        }
        return true;
    }

    /**
     * url (one ok() takes) as it shows in a notification: its host as the browser goes to it. A host in another script
     * that copies a known site's letters ("аррӏе.com" in Cyrillic) read as that site while the browser opened
     * xn--80ak6aa92e.com: every part of the name with letters other than plain ones shows in the browser's xn-- form,
     * as the PC and the page show it. A plain (ASCII) host shows as it is.
     */
    static String shown(String url) {
        if (!ok(url)) return url;
        int start = url.indexOf("://") + 3, end = url.length();
        for (int i = start; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c == '/' || c == '?' || c == '#') { end = i; break; }
        }
        String host = url.substring(start, end), port = "";
        if (host.startsWith("[")) return url;
        int colon = host.indexOf(':');
        if (colon >= 0) { port = host.substring(colon); host = host.substring(0, colon); }
        boolean plain = true;
        for (int i = 0; i < host.length() && plain; i++) plain = host.charAt(i) < 0x80;
        if (plain) return url;
        String icu = uts46(host);
        if (icu != null) return url.substring(0, start) + icu + port + url.substring(end);
        StringBuilder b = new StringBuilder();
        String[] parts = host.split("\\.", -1);
        for (int j = 0; j < parts.length; j++) {
            String part = parts[j];
            if (j > 0) b.append('.');
            if (part.length() > 63) { b.append(percent(part)); continue; }       // (longer than a name's part may be)
            String m = map(part);
            boolean ascii = true;
            for (int i = 0; i < m.length() && ascii; i++) ascii = m.charAt(i) < 0x80;
            String p = ascii ? m : puny(m);
            if (p == null) { b.append(percent(part)); continue; }
            if (!ascii) p = "xn--" + p;
            // (what isn't a letter, digit, '-' or '_' once mapped, a blank from an Arabic presentation form say, is
            // escaped, as the browser shows it)
            for (int i = 0; i < p.length(); i++) {
                char c = p.charAt(i);
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '~') b.append(c);
                else b.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
            }
        }
        return url.substring(0, start) + b + port + url.substring(end);
    }

    // Android's own UTS 46 (android.icu.text.IDNA, Android 7 and newer), set as Chromium sets it; looked up by name so
    // that the tests' plain Java runs without it (then map() below does the same for what it covers)
    private static final Object UTS46;
    private static final java.lang.reflect.Method TO_ASCII, HAS_ERRORS;
    private static final java.lang.reflect.Constructor<?> INFO;
    static {
        Object u = null;
        java.lang.reflect.Method m = null, h = null;
        java.lang.reflect.Constructor<?> k = null;
        try {
            Class<?> c = Class.forName("android.icu.text.IDNA"), info = Class.forName("android.icu.text.IDNA$Info");
            int o = c.getField("NONTRANSITIONAL_TO_ASCII").getInt(null) | c.getField("NONTRANSITIONAL_TO_UNICODE").getInt(null) | c.getField("CHECK_BIDI").getInt(null);
            u = c.getMethod("getUTS46Instance", int.class).invoke(null, o);
            m = c.getMethod("nameToASCII", CharSequence.class, StringBuilder.class, info);
            h = info.getMethod("hasErrors");
            k = info.getConstructor();
        } catch (Throwable e) { u = null; }
        UTS46 = u; TO_ASCII = m; HAS_ERRORS = h; INFO = k;
    }

    /**
     * host as the browser has it, from Android's UTS 46: what isn't a letter, digit, '.', '-' or '_' once mapped (a
     * blank from an Arabic presentation form, say) escaped as the browser shows it; a host it refuses (the browser
     * doesn't open it) with its letters other than plain ones as %XX. null without it.
     */
    private static String uts46(String host) {
        if (UTS46 == null) return null;
        try {
            Object info = INFO.newInstance();
            StringBuilder sb = new StringBuilder();
            // (ẞ is ß for the browser since Unicode 15.1; an older Android's mapping makes it "ss", another site's name)
            TO_ASCII.invoke(UTS46, host.replace('\u1e9e', '\u00df'), sb, info);
            if (Boolean.TRUE.equals(HAS_ERRORS.invoke(info))) return percent(host);
            StringBuilder b = new StringBuilder(sb.length());
            for (int i = 0; i < sb.length(); i++) {
                char c = sb.charAt(i);
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == '~') b.append(c);
                else if (c < 0x80) b.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
                else return percent(host);
            }
            return b.toString();
        } catch (Throwable e) {
            return percent(host);              // (a part too long for it, past the 63 letters a name may have)
        }
    }

    /**
     * A part of a host name mapped as the browser maps it (Unicode's IDNA mapping, UTS 46, non-transitional): compatibility
     * forms (full width, ligatures) to plain ones, each letter to lower case on its own (Σ is σ wherever it stands, not
     * the final ς; İ is i and a dot above), Cherokee to its capitals, ß and ς kept.
     */
    static String map(String part) {
        String n = Normalizer.normalize(part, Normalizer.Form.NFKC);
        StringBuilder b = new StringBuilder(n.length());
        for (int i = 0; i < n.length(); ) {
            int c = n.codePointAt(i);
            i += Character.charCount(c);
            if (c >= 0xab70 && c <= 0xabbf) b.appendCodePoint(c - 0xab70 + 0x13a0);          // Cherokee small letters
            else if (c >= 0x13f8 && c <= 0x13fd) b.appendCodePoint(c - 8);
            else if (c >= 0x13a0 && c <= 0x13f5) b.appendCodePoint(c);
            else if (c < 0x80 || (Character.toLowerCase(c) == c && Character.toUpperCase(c) == c)) b.appendCodePoint(c < 0x80 ? Character.toLowerCase(c) : c);
            else b.append(new String(Character.toChars(c)).toLowerCase(Locale.ROOT));
        }
        return Normalizer.normalize(b, Normalizer.Form.NFKC);
    }

    /**
     * url as one short line (the collapsed notification): without "https://" and "www.", at most n characters, the
     * host's end never cut: the path gives way first, then the host's start ("…verify.evil.example"). A long host cut
     * at its end showed only the site it begins with ("accounts.google.com.signin-…"), never the one it opens.
     */
    static String brief(String url, int n) {
        String s = shown(url);
        int k = s.indexOf("://");
        if (k >= 0) s = s.substring(k + 3);
        if (s.regionMatches(true, 0, "www.", 0, 4)) s = s.substring(4);
        if (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return fit(s, n);
    }

    /** s (a host, then maybe a path) in at most n characters, the host's end kept, as brief() says. */
    static String fit(String s, int n) {
        int end = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '/' || c == '?' || c == '#') { end = i; break; }
        }
        int host = s.codePointCount(0, end), all = s.codePointCount(0, s.length());
        if (all <= n) return s;
        if (host >= n - 1) return "…" + s.substring(s.offsetByCodePoints(end, -(n - 1)), end);
        return s.substring(0, s.offsetByCodePoints(0, n - 1)) + "…";
    }

    // RFC 3492's encoding of a part of a name (without "xn--"), or null
    private static String puny(String w) {
        int[] cp = new int[w.codePointCount(0, w.length())];
        for (int i = 0, j = 0; i < w.length(); j++) { cp[j] = w.codePointAt(i); i += Character.charCount(cp[j]); }
        StringBuilder out = new StringBuilder();
        for (int c : cp) if (c < 0x80) out.append((char) c);
        int basic = out.length(), h = basic;
        if (basic > 0) out.append('-');
        long n = 128, delta = 0;
        int bias = 72;
        while (h < cp.length) {
            long m = Long.MAX_VALUE;
            for (int c : cp) if (c >= n && c < m) m = c;
            delta += (m - n) * (h + 1);
            if (delta > Integer.MAX_VALUE) return null;
            n = m;
            for (int c : cp) {
                if (c < n) delta++;
                if (c == n) {
                    long q = delta;
                    for (int k = 36; ; k += 36) {
                        int t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
                        if (q < t) break;
                        out.append(digit((int) (t + (q - t) % (36 - t))));
                        q = (q - t) / (36 - t);
                    }
                    out.append(digit((int) q));
                    bias = adapt((int) delta, h + 1, h == basic);
                    delta = 0;
                    h++;
                }
            }
            delta++;
            n++;
        }
        return out.toString();
    }

    private static char digit(int d) { return (char) (d < 26 ? 'a' + d : '0' + d - 26); }

    private static int adapt(int d, int n, boolean first) {
        d = first ? d / 700 : d / 2;
        d += d / n;
        int k = 0;
        while (d > 455) { d /= 35; k += 36; }
        return k + 36 * d / (d + 38);
    }

    private static String percent(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            int v = x & 0xff;
            if (v < 0x80) b.append((char) v);
            else b.append('%').append(Character.toUpperCase(Character.forDigit(v >> 4, 16))).append(Character.toUpperCase(Character.forDigit(v & 15, 16)));
        }
        return b.toString();
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
