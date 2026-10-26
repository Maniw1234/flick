package com.flick.app;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Flick PCs over mDNS (_flick._tcp.local, see pc/mdns.js): a plain DNS question sent to the mDNS group from an ordinary
 * port, which the PC answers straight back (RFC 6762 §6.7). Some networks pass multicast (as for printers and TVs) but
 * drop the broadcast that Discovery sends. No Android classes, so it runs on any JVM.
 */
final class Mdns {
    static final String TYPE = "_flick._tcp.local";
    static final String GROUP = "224.0.0.251";
    static final int PORT = 5353;
    private static final int PTR = 12, TXT = 16, SRV = 33, A = 1;

    /** A PC the answer described: its id (from TXT), name, port and address. */
    static final class Pc {
        String id = "", name = "", ip;
        int port, v = 1, tls;
    }

    private Mdns() {}

    /** The question: PTR _flick._tcp.local (one, no flags). */
    static byte[] query() {
        ByteArrayOutputStream b = new ByteArrayOutputStream(64);
        int id = (int) (System.nanoTime() & 0x0fff) | 0x8000;    // never starts with '{' (Discovery tells answers apart by it)
        b.write(id >> 8); b.write(id & 255);
        b.write(0); b.write(0);                 // flags: a standard query
        b.write(0); b.write(1);                 // one question
        for (int i = 0; i < 6; i++) b.write(0); // no answers, authority, additional
        name(b, TYPE);
        b.write(0); b.write(PTR);
        b.write(0); b.write(1);                 // class IN
        return b.toByteArray();
    }

    private static void name(ByteArrayOutputStream b, String n) {
        for (String label : n.split("\\.")) {
            byte[] l;
            try { l = label.getBytes("UTF-8"); } catch (Exception e) { l = new byte[0]; }
            b.write(l.length);
            b.write(l, 0, l.length);
        }
        b.write(0);
    }

    /** The PCs an answer describes (empty when it isn't one). from: the address it came from. */
    static List<Pc> parse(byte[] buf, int off, int len, String from) {
        List<Pc> out = new ArrayList<Pc>();
        try {
            Reader r = new Reader(buf, off, len);
            r.u16();                                     // id
            int flags = r.u16();
            if ((flags & 0x8000) == 0) return out;       // a question, not an answer
            int qd = r.u16(), an = r.u16(), ns = r.u16(), ar = r.u16();
            for (int i = 0; i < qd; i++) { r.name(); r.skip(4); }
            List<String> instances = new ArrayList<String>();
            Map<String, int[]> srvPort = new HashMap<String, int[]>();
            Map<String, String> srvHost = new HashMap<String, String>();
            Map<String, Map<String, String>> txt = new HashMap<String, Map<String, String>>();
            Map<String, String> addr = new HashMap<String, String>();
            int total = an + ns + ar;
            for (int i = 0; i < total; i++) {
                String nm = r.name().toLowerCase(Locale.ROOT);
                int type = r.u16();
                r.u16();                                 // class (and the cache-flush bit)
                r.skip(4);                               // ttl
                int rdlen = r.u16();
                int end = r.pos + rdlen;
                if (end > r.end) break;
                if (type == PTR && nm.equals(TYPE)) {
                    instances.add(r.name().toLowerCase(Locale.ROOT));
                } else if (type == SRV) {
                    r.skip(4);                           // priority, weight
                    srvPort.put(nm, new int[]{r.u16()});
                    srvHost.put(nm, r.name().toLowerCase(Locale.ROOT));
                } else if (type == TXT) {
                    Map<String, String> m = new HashMap<String, String>();
                    while (r.pos < end) {
                        int l = r.u8();
                        if (l == 0 || r.pos + l > end) { r.pos += l; continue; }
                        String kv = new String(buf, r.pos, l, "UTF-8");
                        r.pos += l;
                        int eq = kv.indexOf('=');
                        if (eq > 0) m.put(kv.substring(0, eq).toLowerCase(Locale.ROOT), kv.substring(eq + 1));
                    }
                    txt.put(nm, m);
                } else if (type == A && rdlen == 4) {
                    addr.put(nm, (buf[r.pos] & 255) + "." + (buf[r.pos + 1] & 255) + "." + (buf[r.pos + 2] & 255) + "." + (buf[r.pos + 3] & 255));
                }
                r.pos = end;
            }
            // instances named in a PTR, or any SRV of the type (an answer to an SRV question)
            for (String k : srvPort.keySet()) if (k.endsWith("." + TYPE) && !instances.contains(k)) instances.add(k);
            for (String inst : instances) {
                Map<String, String> t = txt.get(inst);
                int[] port = srvPort.get(inst);
                if (t == null || port == null || !t.containsKey("id")) continue;
                Pc pc = new Pc();
                pc.id = t.get("id");
                pc.name = t.containsKey("n") ? t.get("n") : "PC";
                pc.port = port[0];
                String host = srvHost.get(inst);
                pc.ip = from != null ? from : host != null ? addr.get(host) : null;
                try { pc.v = Integer.parseInt(t.containsKey("v") ? t.get("v") : "1"); } catch (NumberFormatException e) { pc.v = 1; }
                pc.tls = "1".equals(t.get("tls")) ? 1 : 0;
                if (pc.ip != null && pc.id.length() > 0) out.add(pc);
            }
        } catch (Exception e) { /* a damaged answer: nothing */ }
        return out;
    }

    private static final class Reader {
        final byte[] b;
        int pos;
        final int base, end;
        Reader(byte[] b, int off, int len) { this.b = b; this.pos = off; this.base = off; this.end = off + len; }
        int u8() { if (pos >= end) throw new IllegalStateException("short"); return b[pos++] & 255; }
        int u16() { return (u8() << 8) | u8(); }
        void skip(int n) { pos += n; if (pos > end) throw new IllegalStateException("short"); }
        String name() {
            StringBuilder s = new StringBuilder();
            int p = pos, hops = 0;
            boolean jumped = false;
            while (true) {
                if (p >= end || hops++ > 64) throw new IllegalStateException("bad name");
                int l = b[p] & 255;
                if (l == 0) { p++; break; }
                if ((l & 0xc0) == 0xc0) {
                    if (p + 1 >= end) throw new IllegalStateException("bad name");
                    int ptr = ((l & 0x3f) << 8) | (b[p + 1] & 255);
                    if (!jumped) pos = p + 2;
                    jumped = true;
                    p = base + ptr;
                    continue;
                }
                if (s.length() > 0) s.append('.');
                try { s.append(new String(b, p + 1, l, "UTF-8")); } catch (Exception e) { throw new IllegalStateException("bad name"); }
                p += 1 + l;
            }
            if (!jumped) pos = p;
            return s.toString();
        }
    }
}
