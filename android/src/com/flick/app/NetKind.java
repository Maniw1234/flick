package com.flick.app;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * Which kind of link another device answered over (a USB cable, this phone's hotspot, a direct link, Wi-Fi through a
 * router, Bluetooth): the local network interface whose subnet holds its address. Plain Java (no Android classes), for
 * Discovery (PCs) and PeerClient (other phones) alike.
 */
final class NetKind {
    private NetKind() { }

    static String linkFor(InetAddress remote) {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof Inet4Address && sameSubnet(a, remote, ia.getNetworkPrefixLength())) return typeOf(ni.getName());
                }
            }
        } catch (Throwable e) { /* unknown */ }
        return "wifi";
    }

    static boolean sameSubnet(InetAddress a, InetAddress b, int prefix) {
        byte[] x = a.getAddress(), y = b.getAddress();
        if (x.length != y.length || prefix <= 0) return false;
        for (int i = 0; i < x.length && prefix > 0; i++, prefix -= 8) {
            int mask = prefix >= 8 ? 0xff : (0xff << (8 - prefix)) & 0xff;
            if ((x[i] & mask) != (y[i] & mask)) return false;
        }
        return true;
    }

    static String typeOf(String iface) {
        String n = iface == null ? "" : iface.toLowerCase(java.util.Locale.ROOT);
        if (n.startsWith("rndis") || n.startsWith("usb") || n.startsWith("ncm")) return "usb";
        if (n.startsWith("ap") || n.startsWith("swlan") || n.startsWith("softap") || n.startsWith("wigig") || n.equals("wlan1")) return "hotspot";
        if (n.startsWith("p2p")) return "direct";
        if (n.startsWith("eth")) return "ethernet";
        if (n.startsWith("bt-pan") || n.startsWith("bnep")) return "bluetooth";
        return "wifi";
    }

    /** Faster links first: a cable beats a direct radio link, which beats Wi-Fi through a router. */
    static int rank(String via) {
        if ("usb".equals(via)) return 5;
        if ("ethernet".equals(via)) return 4;
        if ("hotspot".equals(via) || "direct".equals(via)) return 3;
        if ("wifi".equals(via)) return 2;
        return 1;
    }
}
