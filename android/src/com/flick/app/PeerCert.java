package com.flick.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/**
 * This phone's own certificate, for taking files from other phones (PeerServer): an EC P-256 key and a self-signed
 * certificate, made once and kept in the app's private files. Other phones pin its SHA-256 when they pair, the way a
 * phone pins a PC's. Plain Java (no Android classes), so it can be exercised on any JVM.
 */
final class PeerCert {
    private static final char[] PASS = "flick-peer".toCharArray();   // the file is private to the app; this only opens it
    private static final String ALIAS = "flick";

    final PrivateKey key;
    final X509Certificate cert;
    final String fp;                  // SHA-256 of the certificate (DER), hex: what the other side pins

    private PeerCert(PrivateKey key, X509Certificate cert) throws Exception {
        this.key = key;
        this.cert = cert;
        this.fp = hex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
    }

    /** The certificate in dir (made the first time, or again when the file can't be read). */
    static synchronized PeerCert ensure(File dir, String name) throws Exception {
        File f = new File(dir, "peer.p12");
        if (f.isFile()) {
            // Every paired phone knows this certificate: a new one would make them all refuse this phone (they'd have to
            // pair again). So a read that fails is tried again, and a file that really can't be read is kept aside, not
            // replaced over.
            for (int i = 0; i < 2; i++) {
                try {
                    KeyStore ks = KeyStore.getInstance("PKCS12");
                    FileInputStream in = new FileInputStream(f);
                    try { ks.load(in, PASS); } finally { in.close(); }
                    PrivateKey k = (PrivateKey) ks.getKey(ALIAS, PASS);
                    Certificate c = ks.getCertificate(ALIAS);
                    if (k != null && c instanceof X509Certificate) return new PeerCert(k, (X509Certificate) c);
                } catch (Throwable e) { /* again, then made anew below */ }
                try { Thread.sleep(300); } catch (InterruptedException e) { break; }
            }
            f.renameTo(new File(dir, "peer.p12.unreadable-" + System.currentTimeMillis()));
        }
        dir.mkdirs();
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"), new SecureRandom());
        KeyPair kp = g.generateKeyPair();
        X509Certificate c = selfSigned(kp, name);
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry(ALIAS, kp.getPrivate(), PASS, new Certificate[]{c});
        File tmp = new File(dir, "peer.p12.tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        // (on the disk before it takes its name: a power cut then leaves no half-written file, which the next start would
        // put aside for a new certificate, and every phone paired with this one would refuse that)
        try { ks.store(out, PASS); out.flush(); out.getFD().sync(); } finally { out.close(); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new java.io.IOException("can't keep the certificate"); }
        return new PeerCert(kp.getPrivate(), c);
    }

    /** A TLS server context with this certificate. */
    SSLContext serverContext() throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        ks.setKeyEntry(ALIAS, key, PASS, new Certificate[]{cert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, PASS);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), null, new SecureRandom());
        return ctx;
    }

    // ------------------------------------------------------------ a self-signed X.509 v3 certificate, by hand (DER)
    private static X509Certificate selfSigned(KeyPair kp, String cn) throws Exception {
        byte[] sigAlg = seq(oid(new int[]{1, 2, 840, 10045, 4, 3, 2}));              // ecdsa-with-SHA256
        byte[] name = seq(set(seq(oid(new int[]{2, 5, 4, 3}), utf8(cn.length() > 60 ? cn.substring(0, 60) : cn))));
        long now = System.currentTimeMillis();
        byte[] validity = seq(utcTime(new Date(now - 24L * 3600 * 1000)), genTime(new Date(now + 30L * 365 * 24 * 3600 * 1000)));
        byte[] serial = new byte[16];
        new SecureRandom().nextBytes(serial);
        serial[0] &= 0x7f;
        byte[] tbs = seq(
            tag(0xa0, integer(BigInteger.valueOf(2))),                                 // v3
            integer(new BigInteger(1, serial)),
            sigAlg, name, validity, name,
            kp.getPublic().getEncoded());                                                // SubjectPublicKeyInfo
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(kp.getPrivate());
        s.update(tbs);
        byte[] sig = s.sign();
        byte[] bits = new byte[sig.length + 1];
        System.arraycopy(sig, 0, bits, 1, sig.length);
        byte[] der = seq(tbs, sigAlg, tag(0x03, bits));
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    private static byte[] tag(int t, byte[] body) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(t);
        int n = body.length;
        if (n < 128) o.write(n);
        else if (n < 256) { o.write(0x81); o.write(n); }
        else if (n < 65536) { o.write(0x82); o.write(n >> 8); o.write(n & 255); }
        else { o.write(0x83); o.write(n >> 16); o.write((n >> 8) & 255); o.write(n & 255); }
        o.write(body, 0, n);
        return o.toByteArray();
    }
    private static byte[] cat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }
    private static byte[] seq(byte[]... parts) { return tag(0x30, cat(parts)); }
    private static byte[] set(byte[]... parts) { return tag(0x31, cat(parts)); }
    private static byte[] integer(BigInteger v) { return tag(0x02, v.toByteArray()); }
    private static byte[] utf8(String s) { try { return tag(0x0c, s.getBytes("UTF-8")); } catch (Exception e) { throw new RuntimeException(e); } }
    private static byte[] oid(int[] arcs) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(arcs[0] * 40 + arcs[1]);
        for (int i = 2; i < arcs.length; i++) {
            int v = arcs[i];
            byte[] tmp = new byte[5];
            int k = 0;
            do { tmp[k++] = (byte) (v & 0x7f); v >>>= 7; } while (v != 0);
            for (int j = k - 1; j >= 0; j--) o.write(tmp[j] | (j > 0 ? 0x80 : 0));
        }
        return tag(0x06, o.toByteArray());
    }
    private static byte[] utcTime(Date d) { return time(0x17, "yyMMddHHmmss'Z'", d); }
    private static byte[] genTime(Date d) { return time(0x18, "yyyyMMddHHmmss'Z'", d); }
    private static byte[] time(int t, String pattern, Date d) {
        SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        try { return tag(t, f.format(d).getBytes("US-ASCII")); } catch (Exception e) { throw new RuntimeException(e); }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
