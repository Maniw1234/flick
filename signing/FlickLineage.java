import com.android.apksig.SigningCertificateLineage;
import com.android.apksig.SigningCertificateLineage.SignerCapabilities;
import com.android.apksig.SigningCertificateLineage.SignerConfig;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;

/** Proof that Flick's old (public debug) signing key hands over to the new private key (APK Signature Scheme v3 rotation). */
public class FlickLineage {
    static Object[] load(String path, String type, String alias, String pass) throws Exception {
        KeyStore ks = KeyStore.getInstance(type);
        try (FileInputStream in = new FileInputStream(path)) { ks.load(in, pass.toCharArray()); }
        return new Object[]{(PrivateKey) ks.getKey(alias, pass.toCharArray()), (X509Certificate) ks.getCertificate(alias)};
    }
    static String sha(X509Certificate c) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(c.getEncoded())) s.append(String.format("%02X", b));
        return s.toString();
    }
    public static void main(String[] a) throws Exception {
        Object[] o = load(a[0], "JKS", "androiddebugkey", "android");
        Object[] n = load(a[1], "PKCS12", "flick", a[2]);
        SignerConfig oldCfg = new SignerConfig.Builder((PrivateKey) o[0], (X509Certificate) o[1]).build();
        SignerConfig newCfg = new SignerConfig.Builder((PrivateKey) n[0], (X509Certificate) n[1]).build();
        SigningCertificateLineage lin = new SigningCertificateLineage.Builder(oldCfg, newCfg)
                .setOriginalCapabilities(new SignerCapabilities.Builder().build())
                .setNewCapabilities(new SignerCapabilities.Builder().build())
                .build();
        lin.writeToFile(new File(a[3]));
        SigningCertificateLineage back = SigningCertificateLineage.readFromFile(new File(a[3]));
        System.out.println("lineage size " + back.size());
        for (X509Certificate c : back.getCertificatesInLineage()) {
            SignerCapabilities cap = back.getSignerCapabilities(c);
            System.out.println("  " + c.getSubjectX500Principal() + " " + sha(c).substring(0, 16) + "…  installedData=" + cap.hasInstalledData()
                    + " sharedUid=" + cap.hasSharedUid() + " permission=" + cap.hasPermission() + " rollback=" + cap.hasRollback() + " auth=" + cap.hasAuth());
        }
    }
}
