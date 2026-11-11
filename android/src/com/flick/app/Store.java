package com.flick.app;

import android.content.Context;

/**
 * Which Flick this is. The one from GitHub is com.flick.app and updates itself (from the PC or GitHub); the one from
 * Google Play has its own package name (that one was taken on Play), is updated by Play, and never installs apps.
 * Both are built from the same code: build_apk.sh's "play" variant only renames the package (and, after it, the two
 * content providers' authorities) and drops the permission to install apps.
 */
final class Store {
    private Store() {}

    static final String GITHUB_PKG = "com.flick.app";
    static final String PLAY_PKG = "io.github.maniw1234.flick";    // (PLAY_PKG in build_apk.sh)

    static boolean play(Context c) {
        try { return !GITHUB_PKG.equals(c.getPackageName()); } catch (Throwable e) { return false; }
    }
}
