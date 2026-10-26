package com.flick.app;

import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Ends HTTP connections that stop moving. HttpURLConnection has a read timeout but no write timeout, and a transfer
 * only looks at its abort flag between writes, so a PC that vanishes mid-upload would leave write() blocked for good.
 * Every connection that carries a file is watched here under its transfer's abort flag: abort(flag) disconnects them
 * at once, and one watchdog thread disconnects any whose body has moved no bytes for STALL_MS. No Android classes, so
 * it runs on any JVM.
 */
final class Watchdog {
    static volatile long STALL_MS = 30000;
    private static final long TICK_MS = 1000;

    private static final Set<Guard> LIVE = Collections.newSetFromMap(new ConcurrentHashMap<Guard, Boolean>());
    private static Thread thread;               // guarded by Watchdog.class; runs only while something is watched

    private Watchdog() {}

    /** One watched connection. Use watch() on the body's stream, idle() once the body is through, close() at the end. */
    static final class Guard {
        private final AtomicBoolean abort;
        private final Object c;                 // an HttpURLConnection, or anything Closeable (a socket)
        private volatile boolean moving;        // the body is going through (before and after it the timeouts apply)
        private volatile long last;
        private volatile String ended;          // why abort() or the watchdog disconnected it

        private Guard(AtomicBoolean abort, Object c) { this.abort = abort; this.c = c; }

        /** The stream the request body is written to: every write is progress; the stall clock starts now. */
        OutputStream watch(OutputStream o) {
            start();
            return new FilterOutputStream(o) {
                @Override public void write(int b) throws IOException { out.write(b); last = now(); }
                @Override public void write(byte[] b, int off, int len) throws IOException { out.write(b, off, len); last = now(); }
            };
        }

        /** The stream the response body is read from: every read is progress; the stall clock starts now. */
        InputStream watch(InputStream i) {
            start();
            return new FilterInputStream(i) {
                @Override public int read() throws IOException { int r = in.read(); last = now(); return r; }
                @Override public int read(byte[] b, int off, int len) throws IOException { int r = in.read(b, off, len); last = now(); return r; }
            };
        }

        /** The body is through; waiting for the PC's answer is left to the read timeout. */
        void idle() { moving = false; }

        /** "aborted" or "stalled" when this guard cut the connection, otherwise null. */
        String ended() { return ended; }

        /** Done with the connection (call in finally). */
        void close() { LIVE.remove(this); }

        private void start() { last = now(); moving = true; }

        private void kill(String why) {
            if (ended != null) return;
            ended = why;
            try {
                if (c instanceof HttpURLConnection) ((HttpURLConnection) c).disconnect();
                else if (c instanceof Closeable) ((Closeable) c).close();
            } catch (Throwable e) { /* ignore */ }
        }
    }

    /** Starts watching c, which belongs to the transfer whose abort flag is abort (may be null: no abort for it). */
    static Guard guard(AtomicBoolean abort, HttpURLConnection c) { return watch(abort, c); }

    /** The same for a connection made by hand (Wire): closing it is how it's cut. */
    static Guard guard(AtomicBoolean abort, Closeable c) { return watch(abort, c); }

    private static Guard watch(AtomicBoolean abort, Object c) {
        Guard g = new Guard(abort, c);
        LIVE.add(g);
        synchronized (Watchdog.class) {
            if (thread == null) {
                thread = new Thread(new Runnable() { @Override public void run() { loop(); } }, "flick-watchdog");
                thread.setDaemon(true);
                thread.start();
            }
        }
        if (abort != null && abort.get()) g.kill("aborted");
        return g;
    }

    /** Sets the flag and disconnects every connection watched under it right away (a blocked write ends too). */
    static void abort(AtomicBoolean abort) {
        abort.set(true);
        for (Guard g : LIVE) if (g.abort == abort) g.kill("aborted");
    }

    private static void loop() {
        while (true) {
            try { Thread.sleep(TICK_MS); } catch (InterruptedException e) { /* keep watching */ }
            long now = now();
            for (Guard g : LIVE) {
                if (g.abort != null && g.abort.get()) g.kill("aborted");
                else if (g.moving && now - g.last > STALL_MS) g.kill("stalled");
            }
            synchronized (Watchdog.class) {
                if (LIVE.isEmpty()) { thread = null; return; }
            }
        }
    }

    /** A clock that doesn't run while the phone sleeps, so waking up never looks like a stall. */
    private static long now() { return System.nanoTime() / 1000000L; }
}
