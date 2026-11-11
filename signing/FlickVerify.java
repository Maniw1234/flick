import com.android.apksig.ApkVerifier;
import com.android.apksig.SigningCertificateLineage;
import com.android.apksig.apk.ApkUtils;
import com.android.apksig.util.DataSources;
import java.io.File;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.List;

/**
 * Prints how an APK is signed: each scheme's signer, the v3 rotation lineage and what each key in it may still do, and
 * the oldest Android it installs on. Certificates are named by their whole SHA-256 (verify_apk.sh compares all of it).
 */
public class FlickVerify {
    static String sha(X509Certificate c) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(c.getEncoded())) s.append(String.format("%02X", b));
        return s.toString();
    }
    static String name(X509Certificate c) { return c.getSubjectX500Principal().getName().replaceAll(",.*", ""); }
    static String names(List<X509Certificate> l) throws Exception {
        StringBuilder s = new StringBuilder();
        for (X509Certificate c : l) s.append(name(c)).append(" ").append(sha(c)).append("; ");
        return s.toString();
    }
    public static void main(String[] a) throws Exception {
        for (String p : a) {
            ApkVerifier.Result r = new ApkVerifier.Builder(new File(p)).build().verify();
            System.out.println(new File(p).getName() + ": verified=" + r.isVerified() + " v1=" + r.isVerifiedUsingV1Scheme() + " v2=" + r.isVerifiedUsingV2Scheme() + " v3=" + r.isVerifiedUsingV3Scheme());
            try (RandomAccessFile f = new RandomAccessFile(p, "r")) {
                System.out.println("  minSdk: " + ApkUtils.getMinSdkVersionFromBinaryAndroidManifest(ApkUtils.getAndroidManifest(DataSources.asDataSource(f))));
            }
            if (!r.getV1SchemeSigners().isEmpty()) System.out.println("  v1 signer: " + names(r.getV1SchemeSigners().get(0).getCertificateChain()));
            if (!r.getV2SchemeSigners().isEmpty()) System.out.println("  v2 signer: " + names(r.getV2SchemeSigners().get(0).getCertificates()));
            for (ApkVerifier.Result.V3SchemeSignerInfo s : r.getV3SchemeSigners()) System.out.println("  v3 signer: " + names(s.getCertificates()) + " sdk " + s.getMinSdkVersion() + ".." + s.getMaxSdkVersion());
            for (ApkVerifier.Result.V3SchemeSignerInfo s : r.getV31SchemeSigners()) System.out.println("  v3.1 signer: " + names(s.getCertificates()) + " sdk " + s.getMinSdkVersion() + ".." + s.getMaxSdkVersion());
            System.out.println("  v3.1 verified: " + r.isVerifiedUsingV31Scheme());
            SigningCertificateLineage lin = r.getSigningCertificateLineage();
            System.out.println("  lineage: " + (lin == null ? "none" : names(lin.getCertificatesInLineage())));
            // what each key in the lineage may still do: the old (public) key must never roll back, i.e. sign an update
            if (lin != null) for (X509Certificate c : lin.getCertificatesInLineage()) {
                SigningCertificateLineage.SignerCapabilities k = lin.getSignerCapabilities(c);
                System.out.println("    " + name(c) + ": installedData=" + k.hasInstalledData() + " sharedUid=" + k.hasSharedUid()
                        + " permission=" + k.hasPermission() + " rollback=" + k.hasRollback() + " auth=" + k.hasAuth());
            }
            for (ApkVerifier.IssueWithParams e : r.getErrors()) System.out.println("  ERROR " + e);
        }
    }
}
