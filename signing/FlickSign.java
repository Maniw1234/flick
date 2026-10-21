import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import com.android.apksig.SigningCertificateLineage;
import com.android.apksig.apk.ApkUtils;
import com.android.apksig.util.DataSources;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Signs Flick's phone app the way Android 9+ (SDK 28) checks it: APK Signature Scheme v3 only, signed with Flick's key
 * alone, carrying the rotation lineage (old public key → Flick's key) so phones still on the old key take it as an
 * update. The APK is zip-aligned first (apksig keeps alignment but doesn't create it).
 *
 *   java -cp uber-apk-signer.jar signing/FlickSign.java <keys folder> <unsigned.apk> <signed.apk>
 *
 * The keys folder holds flick-release.p12 (alias "flick"), password.txt and flick.lineage (see README.md).
 */
public class FlickSign {
    static final int MIN_SDK = 28;   // v3 needs Android 9+: older phones can't install what this signs

    public static void main(String[] a) throws Exception {
        if (a.length != 3) {
            System.err.println("usage: java -cp uber-apk-signer.jar signing/FlickSign.java <keys folder> <unsigned.apk> <signed.apk>");
            System.exit(2);
        }
        File keys = new File(a[0]), in = new File(a[1]), out = new File(a[2]);
        String pw = new String(Files.readAllBytes(new File(keys, "password.txt").toPath()), StandardCharsets.UTF_8).trim();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream s = new FileInputStream(new File(keys, "flick-release.p12"))) { ks.load(s, pw.toCharArray()); }
        PrivateKey key = (PrivateKey) ks.getKey("flick", pw.toCharArray());
        X509Certificate cert = (X509Certificate) ks.getCertificate("flick");
        if (key == null || cert == null) fail("flick-release.p12 has no key \"flick\"");
        SigningCertificateLineage lineage = SigningCertificateLineage.readFromFile(new File(keys, "flick.lineage"));
        List<X509Certificate> chain = lineage.getCertificatesInLineage();
        if (chain.isEmpty() || !chain.get(chain.size() - 1).equals(cert)) fail("flick.lineage doesn't end in Flick's key");

        int minSdk;
        try (RandomAccessFile f = new RandomAccessFile(in, "r")) {
            minSdk = ApkUtils.getMinSdkVersionFromBinaryAndroidManifest(ApkUtils.getAndroidManifest(DataSources.asDataSource(f)));
        }
        if (minSdk < MIN_SDK) fail(in.getName() + " has minSdkVersion " + minSdk + "; a v3-only signature needs " + MIN_SDK + " or higher");

        File aligned = new File(out.getPath() + ".aligned");
        try {
            align(in, aligned);
            ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder("flick", key, Collections.singletonList(cert)).build();
            new ApkSigner.Builder(Collections.singletonList(signer))
                    .setInputApk(aligned).setOutputApk(out)
                    .setMinSdkVersion(minSdk)
                    .setV1SigningEnabled(false).setV2SigningEnabled(false).setV3SigningEnabled(true)
                    .setSigningCertificateLineage(lineage).setMinSdkVersionForRotation(MIN_SDK)
                    .build().sign();
        } finally {
            aligned.delete();
        }

        String bad = misaligned(Files.readAllBytes(out.toPath()));
        if (bad != null) { out.delete(); fail("signed APK isn't aligned: " + bad); }
        ApkVerifier.Result r = new ApkVerifier.Builder(out).build().verify();
        if (!r.isVerified() || r.getV3SchemeSigners().size() != 1 || !r.getV3SchemeSigners().get(0).getCertificate().equals(cert)) {
            out.delete();
            fail("the signed APK doesn't verify: " + r.getErrors());
        }
        System.out.println("signed " + out.getName() + ": v3, Flick's key, lineage of " + chain.size() + ", Android " + minSdk + "+ (SDK), aligned");
    }

    static void fail(String why) {
        System.err.println("FlickSign: " + why);
        System.exit(1);
    }

    // ---------------------------------------------------------------- zip alignment (what zipalign -p 4 does)
    static final int ALIGN_FIELD = 0xd935;   // the "alignment" extra field apksig and zipalign use for padding

    /** Data of every uncompressed entry starts at a multiple of 4 (4096 for .so libraries), as Android expects. */
    static int alignmentOf(String name) { return name.endsWith(".so") ? 4096 : 4; }

    /** Copies a zip, padding the local header of each uncompressed entry so its data is aligned. */
    static void align(File in, File out) throws IOException {
        byte[] z = Files.readAllBytes(in.toPath());
        ByteBuffer b = ByteBuffer.wrap(z).order(ByteOrder.LITTLE_ENDIAN);
        int eocd = eocd(b);
        int count = b.getShort(eocd + 10) & 0xffff;
        int cdOff = b.getInt(eocd + 16), cdSize = b.getInt(eocd + 12);
        if (cdOff < 0 || cdSize < 0 || (long) cdOff + cdSize > eocd) throw new IOException("bad zip directory");
        List<int[]> ents = new ArrayList<int[]>();               // { central record, local header, end of entry data, index }
        int p = cdOff;
        for (int i = 0; i < count; i++) {
            if (b.getInt(p) != 0x02014b50) throw new IOException("bad zip directory");
            int flags = b.getShort(p + 8) & 0xffff;
            long csize = b.getInt(p + 20) & 0xffffffffL;
            int local = b.getInt(p + 42);
            if (csize == 0xffffffffL || local < 0) throw new IOException("zip64 isn't supported");
            if (b.getInt(local) != 0x04034b50) throw new IOException("bad zip entry");
            long end = local + 30L + (b.getShort(local + 26) & 0xffff) + (b.getShort(local + 28) & 0xffff) + csize;
            if ((flags & 8) != 0) end += (end + 4 <= z.length && b.getInt((int) end) == 0x08074b50) ? 16 : 12;   // data descriptor
            if (end > cdOff) throw new IOException("bad zip entry");
            ents.add(new int[]{p, local, (int) end, i});
            p += 46 + (b.getShort(p + 28) & 0xffff) + (b.getShort(p + 30) & 0xffff) + (b.getShort(p + 32) & 0xffff);
        }
        List<int[]> byPos = new ArrayList<int[]>(ents);
        Collections.sort(byPos, (x, y) -> Integer.compare(x[1], y[1]));
        ByteArrayOutputStream o = new ByteArrayOutputStream(z.length + count * 16);
        int[] newLocal = new int[ents.size()];
        for (int[] e : byPos) {
            int lh = e[1], n = b.getShort(lh + 26) & 0xffff, x = b.getShort(lh + 28) & 0xffff;
            boolean stored = (b.getShort(lh + 8) & 0xffff) == 0;
            String name = new String(z, lh + 30, n, StandardCharsets.UTF_8);
            byte[] extra = withoutPadding(z, lh + 30 + n, x);
            int at = o.size();
            if (stored) extra = padded(extra, at + 30 + n, alignmentOf(name));
            if (extra.length > 0xffff) throw new IOException("extra field too long");
            byte[] h = new byte[30];
            System.arraycopy(z, lh, h, 0, 30);
            h[28] = (byte) extra.length; h[29] = (byte) (extra.length >> 8);
            o.write(h);
            o.write(z, lh + 30, n);
            o.write(extra);
            o.write(z, lh + 30 + n + x, e[2] - (lh + 30 + n + x));
            newLocal[e[3]] = at;
        }
        int newCd = o.size();
        for (int i = 0; i < ents.size(); i++) {
            int c = ents.get(i)[0];
            int len = 46 + (b.getShort(c + 28) & 0xffff) + (b.getShort(c + 30) & 0xffff) + (b.getShort(c + 32) & 0xffff);
            byte[] r = new byte[len];
            System.arraycopy(z, c, r, 0, len);
            ByteBuffer.wrap(r).order(ByteOrder.LITTLE_ENDIAN).putInt(42, newLocal[i]);
            o.write(r);
        }
        byte[] end = new byte[z.length - eocd];
        System.arraycopy(z, eocd, end, 0, end.length);
        ByteBuffer.wrap(end).order(ByteOrder.LITTLE_ENDIAN).putInt(12, o.size() - newCd).putInt(16, newCd);
        o.write(end);
        Files.write(out.toPath(), o.toByteArray());
    }

    static int eocd(ByteBuffer b) throws IOException {
        for (int i = b.capacity() - 22; i >= Math.max(0, b.capacity() - 65557); i--) if (b.getInt(i) == 0x06054b50) return i;
        throw new IOException("not a zip");
    }

    /** The extra fields minus old padding (zero bytes, or an alignment field). */
    static byte[] withoutPadding(byte[] z, int off, int len) {
        ByteBuffer e = ByteBuffer.wrap(z, off, len).order(ByteOrder.LITTLE_ENDIAN);
        ByteArrayOutputStream keep = new ByteArrayOutputStream();
        while (e.remaining() >= 4) {
            int id = e.getShort() & 0xffff, size = e.getShort() & 0xffff;
            if (size > e.remaining()) break;
            if ((id == 0 && size == 0) || id == ALIGN_FIELD) { e.position(e.position() + size); continue; }
            keep.write(z, e.position() - 4, 4 + size);
            e.position(e.position() + size);
        }
        return keep.toByteArray();
    }

    /** extra plus an alignment field sized so that data starting right after it is a multiple of m. */
    static byte[] padded(byte[] extra, int extraAt, int m) {
        int pad = (int) ((m - ((extraAt + extra.length + 6L) % m)) % m);
        ByteBuffer r = ByteBuffer.allocate(extra.length + 6 + pad).order(ByteOrder.LITTLE_ENDIAN);
        r.put(extra).putShort((short) ALIGN_FIELD).putShort((short) (2 + pad)).putShort((short) m);
        return r.array();
    }

    /** null when every uncompressed entry's data is aligned; otherwise the first one that isn't. */
    static String misaligned(byte[] z) throws IOException {
        ByteBuffer b = ByteBuffer.wrap(z).order(ByteOrder.LITTLE_ENDIAN);
        int eocd = eocd(b), count = b.getShort(eocd + 10) & 0xffff, p = b.getInt(eocd + 16);
        for (int i = 0; i < count; i++) {
            int n = b.getShort(p + 28) & 0xffff, local = b.getInt(p + 42);
            String name = new String(z, p + 46, n, StandardCharsets.UTF_8);
            int data = local + 30 + (b.getShort(local + 26) & 0xffff) + (b.getShort(local + 28) & 0xffff);
            if ((b.getShort(p + 10) & 0xffff) == 0 && data % alignmentOf(name) != 0) return name + " at " + data;
            p += 46 + n + (b.getShort(p + 30) & 0xffff) + (b.getShort(p + 32) & 0xffff);
        }
        return null;
    }
}
