'use strict';
// Flick PC server: HTTP (uploads/downloads) + WebSocket (live drag stream) + UDP discovery.
// Pure Node so it can be tested without Electron.
const http = require('http');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { acceptUpgrade, MAX_MESSAGE, MAX_PIECES, MAX_QUEUED } = require('./ws');
const { BundleReceiver, STAGE_FILE, STAGE_DIR } = require('./bundle');
const { PhoneApi, cleanUrl } = require('./phoneapi');
const { onLink, mayAnswer } = require('./mdns');

// Windows: marks a file sparse with bin/flick-sparse.exe (see native/flick-sparse.c) before it's written in parts. Best
// effort: without the helper, or on a drive that can't (FAT), the file is written as before.
const SPARSE_EXE = path.join(__dirname, 'bin', 'flick-sparse.exe');
let sparseOk = null;
function markSparse(file) {
  if (sparseOk === null) sparseOk = fs.existsSync(SPARSE_EXE);
  if (!sparseOk) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      require('child_process').execFile(SPARSE_EXE, [file], { windowsHide: true, timeout: 3000 }, (e) => resolve(!e));
    } catch (e) { resolve(false); }
  });
}

// 2: large files in parallel parts (/api/part) and byte ranges; 3: bundles over several streams; 4: encrypted links
// (TLS on the same port, a pinned certificate) and a sign-in that never sends the pairing token (see "sign-in");
// 5: several phones at once, the background link (/api/events), clipboard, links, notifications, folder sync (phoneapi.js);
// 6: a file sent in parts is checked end to end: the phone sends the whole file's SHA-256 once every part is in, and
// the PC checks the assembled file against it before the transfer counts as done (see _commitParts)
// 7: transfers that carry on where they stopped: with resume=1 the PC keeps what arrived of a large file's parts and of
// a bundle's streams for hours (not a minute), says how far each one got (/api/status), and takes the rest (a part
// from "from", a stream from its "skip"-th entry). Also /api/speed (a speed test) and /api/have (which files the PC
// already has, so they aren't sent twice)
// 8: Air grab (a hand carries files between the phone and this PC: 'air-go', 'air-catch', 'air-ready', see
// _onPhoneMessage and air.js)
const PROTO = 8;
// how long a resumable transfer that stopped (the phone left, its app was closed) waits for the phone to come back
const RESUME_KEEP_MS = 6 * 3600 * 1000;
// a file offered to the phone stays fetchable this long after the phone last asked for it (see offerFile)
const OFFER_IDLE_MS = 30 * 60 * 1000;
// open connections allowed at once from one address, and in all (see _onSocket). An address where no paired device or
// allowed browser is signed in gets fewer (still room for a phone's first burst of transfers, each connection opened
// before any has signed in): anyone on the network can use several addresses.
const SOCKS_PER_ADDR = 64, SOCKS_TOTAL = 512, STRANGER_PER_ADDR = 32;
// an address stays a signed-in device's this long after its last signed-in connection closed (a phone between links)
const TRUSTED_ADDR_MS = 120000;
// an address's connections that made way for others count against it for this long (see _makeRoom)
const MADE_WAY_MS = 30000;
const SOCK = Symbol('flick.sock');   // a connection's bookkeeping (see _onSocket), on its socket and its TLS socket
// a body that stops coming for this long (its phone vanished: a half-open connection never says it ended) is given up
// on (see _watchBody). Longer than a phone or another device waits on a stalled send itself (30 s), so this never cuts
// one that would carry on. (Not a part of a file sent in parts, nor a stream of a bundle sent in streams: those are
// let go after 20 s, sooner than their phone gives up, as it sends the part or the stream again: see _sweepAssemblies.)
const BODY_IDLE_MS = 60000;
// a file going to a phone that takes none of it for this long (its app stuck, a reader that stopped, a network gone
// without closing the connection) is closed, as the browser page's downloads are (webshare.js dlStallMs): it no longer
// counts as files moving, which keeps updates waiting (see _watchDownload)
let DL_STALL_MS = 120000;
// transfers a device is kept as the sender of (newest): see _own
const OWN_MAX = 1000;
// phone app version code from which 'connect' says whether the user asked for it (user: true)
const USER_FLAG_CODE = 10800;
// phones connected at once; past that a phone gets a place only when its user asks for it (busy / replaced)
const MAX_PHONES = 4;
// what another Flick device (a peer) says while it signs in or pairs; anything else from it goes to _onPeerMessage
const PEER_SIGN_IN = new Set(['hello', 'auth', 'connect', 'pair-reveal', 'ping']);
// What this computer takes from another Flick device besides files, said in 'welcome' and 'connected' (a device sends
// only what's listed; one from before says nothing): look (a send's animation), clip (its clipboard), link (a web
// address), ask (it may ask its user first: 'asking'), recv (it says how much of an upload has come while it comes, to
// a sender that asks: see _recvTell). Not ring: a computer isn't lost.
const PEER_CAPS = ['look', 'clip', 'link', 'ask', 'recv'];
const PEER_MSG_MAX = 7 * 1024 * 1024;     // a signed-in device's clipboard picture (4.4 MB of PNG, about 6 MB as text)
// What a link that hasn't signed in (nor been allowed to pair) may send in one message, and have waiting for it here:
// hello, the sign-in, a request to pair and pings are a few hundred bytes (a phone's hello, the biggest, under 1 KB),
// and so is all this PC says to it. Without these a link that never pairs held a 4 MB message half-sent, or 32 MB of
// answers it never read, for as long as it liked. Each of those messages comes whole, in one piece (a phone's page, a
// 2.0.0 one, another computer): one in more than a few pieces is refused, as the pieces of a message that never ends,
// kept apart, held four times the memory of its bytes.
const EARLY_MSG_MAX = 64 * 1024, EARLY_QUEUED = 256 * 1024, EARLY_PIECES = 64;
// how long a phone (or anything saying hello as one) that hasn't signed in keeps its link while it neither holds Connect
// nor asks to pair: its page links again by itself a moment after (and at once when its user holds Connect)
const UNPAIRED_IDLE_MS = 120000;
// (a clock that only moves forward, for that: the wall clock set ahead mustn't close every such link at once)
const mono = () => performance.now();
// lines anything on the network can cause (a failed sign-in, a body that stopped coming) said in the log each minute,
// of each kind: from one address, and from all (then only how many more: _logLimited)
const LOG_ADDR = 3, LOG_ALL = 20;

function rid(n = 12) { return crypto.randomBytes(n).toString('hex'); }
const { smallPicture } = require('./imgsize');
// A device's name as shown and kept here: text only, without control or direction characters (a name could otherwise
// turn the pairing question it's shown in backwards), at most 60 characters
// (the zero-width joiner and non-joiner stay: emoji and Persian names are written with them)
const cleanName = (x, fallback) => {
  const t = typeof x === 'string' ? x.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 60) : '';
  return t && /[^\s­͏ᅟᅠ឴឵᠋-᠏‌‍⠀ㅤ︀-️ﾠ]/.test(t) ? t : fallback;   // a name of only invisible marks (joiners, U+3164...) reads as none
};
// a transfer id as every route uses it (the upload routes keep these characters, the first 40): who owns a transfer is
// looked up by this, so an id that differs only in what is cleaned away can't reach another device's transfer
const tidOf = (v) => String(v == null ? '' : v).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
const TID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// how long another device that said hello may stay without signing in or asking to pair
const PEER_IDLE_MS = 25000;
// how long a phone's pairing allowed here stays only on the way while its user checks the code there (the phone gives
// its user 2 minutes): see approve
const PHONE_PROV_MS = 150000;
// what another device's bundle can't ask for (the phone's resumable, striped bundles: see _handleBundleStream)
const PEER_NOT = ['resume', 'streams', 'stream', 'skip', 'from', 'att', 'committed', 'again'];
// a write that failed because the drive is full: the phone hears 507 ("not enough space") and stops, instead of a 500
// it takes for a hiccup and answers by sending the same bytes again every second
const diskFull = (e) => !!(e && (e.code === 'ENOSPC' || e.code === 'EDQUOT'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', String(key)).update(s).digest('hex');
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** The pairing code both screens show: a MITM can't make them match (see 'connect' and 'pair-reveal'). */
function pairCode(chan, nonceP, nonceS) {
  const n = parseInt(sha256('flick-pair-v1|' + chan + '|' + nonceP + '|' + nonceS).slice(0, 8), 16) % 1000000;
  return String(n).padStart(6, '0');
}

// The SDK level of the Android version a WebView's user agent names ("...; Android 8.1.0; ...", the lower one where a
// version has two), or 0 when it doesn't say: for a phone app that doesn't send its SDK level in hello.
function uaSdk(ua) {
  const m = /\bAndroid (\d+)(?:\.(\d+))?/.exec(String(ua || ''));
  if (!m) return 0;
  const v = +m[1], dot1 = +(m[2] || 0) >= 1;
  if (v === 7 || v === 8) return (v === 7 ? 24 : 26) + (dot1 ? 1 : 0);   // 7.0 24, 7.1 25, 8.0 26, 8.1 27
  if (v === 9) return 28;
  if (v >= 10 && v <= 12) return v + 19;                                   // 10 29, 11 30, 12 31 (12L 32)
  return v >= 13 && v < 100 ? v + 20 : 0;                                  // 13 33, 14 34, ...
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address, netmask: a.netmask });
    }
  }
  // Prefer typical home LAN ranges first
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

class FlickServer extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id || rid(8);
    this.name = opts.name || os.hostname();
    this.basePort = opts.port || 47860;
    this.lastPort = this.basePort + 5;    // (the last of the ports it may take when its own is taken: see start)
    this.port = null;
    this.discoveryPort = opts.discoveryPort || 47870;
    this.tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'flick-incoming');
    this.version = opts.version || '1.0.0';
    this.devices = Object.assign({}, opts.devices || {}); // deviceId -> { name, token, added }
    this.settings = Object.assign({ side: 'right', anchor: 0.5, theme: 'meteor' }, opts.settings || {});
    this.session = null;   // active phone session: the one PC-initiated sends go to
    this.sessions = new Map();  // deviceId -> session, every phone connected right now (several at once)
    // other Flick devices sending here (another PC, a phone sending to a phone): signed in like phones, but they only
    // send files. They're never the phone in use and reach none of the phone features (see _v5ok).
    this.peers = new Map();     // deviceId -> session
    this.usedAt = new Map();    // deviceId -> when the user last used that phone (a fling from it, a click in the panel)
    this.tidOwner = new Map();  // transfer id -> the phone that started it (its replies go there)
    this.ownedBy = new Map();   // deviceId -> its transfer ids in tidOwner, oldest first (see _own)
    this.uploads = new Map();   // tid -> { req, path }
    this.assemblies = new Map(); // tid -> a large file arriving in parallel parts (see _handlePart)
    this.partsSeen = new Map();  // "tid:att" -> { done | aborted, until }: late parts of a finished/aborted upload
    this.bundleAsm = new Map();  // tid -> a bundle arriving over several streams at once (see _handleBundleStream)
    this.outgoing = new Map();  // fid -> { path, name, size, mime }
    this.pending = new Map();   // deviceId -> session awaiting approval
    this.phoneProvT = new Map(); // deviceId -> when a phone's pairing still on the way goes (see approve)
    this.pairTimes = [];        // when recent pairing prompts were shown (rate limit)
    this.cool = new Map();      // address -> time until which its pairing requests are refused (after a "Don't allow")
    this.peeks = new Map();     // address -> when its recent pairing requests heard this side's half of the code
    this.phoneApp = null;       // newest phone app this PC can hand out: { path, code, name, size, sha256 }
    this.allowOrigin = opts.allowOrigin || null;   // tests only (a RegExp); never set by a normal start
    this.noMdns = opts.mdns === false;
    this.haveFiles = opts.haveFiles || null;       // async (items, device) -> { k: [fingerprint, ...] }: copies of the phone's files here
    // this PC's certificate ({ key, cert, fp } from tlscert.js): links to the phone are encrypted with it. Without one
    // (it couldn't be made) Flick still answers plain links, which the phone app refuses to use.
    this.tlsId = opts.tls || null;
    this.fp = this.tlsId ? this.tlsId.fp : null;
    this.sockByAddr = new Map(); // address -> open connections (see _onSocket)
    this.sockCount = 0;
    this.socks = new Set();      // every open connection's bookkeeping, oldest first
    this.keptByAddr = new Map(); // address -> open connections a paired device or allowed browser signed in on
    this.trustAt = new Map();    // address -> when a signed-in connection from it was last open
    this.madeWay = new Map();    // address -> how many of its connections made way of late, and when last (see _makeRoom)
    this.discLimit = {};         // discovery's answers so far (see mdns.js mayAnswer)
    this.bodies = new Map();     // request -> { last }: bodies coming in (see _watchBody)
    this.api = new PhoneApi(this, { proto: PROTO });   // the protocol 5 endpoints and background links (phoneapi.js)
    // Files still arriving are this account's alone, wherever they're staged (the temp folder can be one every account
    // on the computer shares): files only it can read (STAGE_FILE), folders only it can open (STAGE_DIR). The app
    // passes a folder of its own as tmpDir; the one in the shared temp folder is for tests.
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: STAGE_DIR });
  }

  // ---------- phone app updates ----------
  // what phone s is offered: nothing its Android can't install (minSdk); sums + sig are the signed SHA256SUMS of the
  // Flick release that lists this APK, which the phone app requires
  _appPublic(s) {
    const a = this.phoneApp;
    if (!a) return null;
    const sdk = s ? s.sdk || s.uaSdk || 0 : 0;
    if (a.minSdk && sdk && sdk < a.minSdk) return null;
    const o = { code: a.code, name: a.name, size: a.size, sha256: a.sha256, url: '/api/app.apk' };
    if (a.minSdk) o.minSdk = a.minSdk;
    if (a.sums && a.sig) { o.sums = a.sums; o.sig = a.sig; }
    return o;
  }

  /** The phone decides for itself whether this is newer than what it runs; `always` answers a "check for updates". */
  setPhoneApp(info, always) {
    const prev = this.phoneApp;
    this.phoneApp = info ? {
      path: info.path, code: info.code, name: info.name, size: info.size, sha256: info.sha256,
      minSdk: info.minSdk || 0, sums: info.sums || '', sig: info.sig || '',
    } : null;
    const changed = !prev !== !info || (prev && info && (prev.sha256 !== info.sha256 || prev.path !== info.path || prev.sig !== this.phoneApp.sig));
    // news for every phone (each offered what its Android can install); an unchanged answer only for the one that asked
    if (changed) {
      const seen = new Set();
      for (const x of [this.session, ...this.sessions.values()]) {
        if (!x || seen.has(x) || !x.trusted || !x.conn || !x.conn.open) continue;
        seen.add(x);
        x.conn.send({ t: 'app', app: this._appPublic(x) });
      }
    } else if (always) {
      const x = this.appAsker ? this._pageFor(this.appAsker) : this.session;
      if (x && x.trusted && x.conn && x.conn.open) x.conn.send({ t: 'app', app: this._appPublic(x) });
    }
  }

  // ---------- lifecycle ----------
  async start() {
    this.http = http.createServer({ connectionsCheckingInterval: 2000 }, (req, res) => this._onRequest(req, res));
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    // (streams relayed from a Bluetooth link come to this.http straight from bt.js: see _relayed)
    this.http.on('connection', (sock) => { if (sock && sock.remoteFamily === 'bluetooth') this._relayed(sock); });
    this.http.keepAliveTimeout = 30000;
    this.http.requestTimeout = 0; // large uploads
    this.http.headersTimeout = 20000;
    // Connections reach this.http from this.net below, so it never listens itself; Node only enforces the header
    // deadline once a server has said it's listening (without it, headers sent a byte at a time hold a connection open)
    this.http.emit('listening');
    this._useTls(this.tlsId);
    // One port for both: an encrypted link starts with a TLS handshake (first byte 0x16); anything else is plain HTTP
    // (phone apps that don't sign in, Bluetooth relayed from this PC, browsers)
    this.net = net.createServer((sock) => this._onSocket(sock));
    this.stopped = false;
    let lastErr;
    for (let p = this.basePort; p <= this.lastPort; p++) {
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => { this.net.removeListener('listening', onOk); reject(e); };
          const onOk = () => { this.net.removeListener('error', onErr); resolve(); };
          this.net.once('error', onErr);
          this.net.once('listening', onOk);
          this.net.listen(p, '0.0.0.0');
        });
        this.port = p;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.port) throw lastErr || new Error('No free port');
    if (this.port !== this.basePort) this._usualPort();
    this._startDiscovery();
    this._startMdns();
    // a phone's pairing still on the way when Flick last quit: what's left of its time to say so (see approve)
    for (const [id, d] of Object.entries(this.devices)) {
      if (d && !d.peer && d.phoneProv) this._phoneProv(id, d.token, Math.min(PHONE_PROV_MS, Math.max(0, d.phoneProv + PHONE_PROV_MS - Date.now())));
    }
    return this.port;
  }

  // Its own port was taken as Flick started, so it listens on the next free one. On Linux that can be any program's
  // connection, given that port by the system for a while (connections are given ports from that range too), or its
  // TIME_WAIT for a minute after. Flick keeps asking for its own port (every 2 s, after two minutes every 30 s), and once
  // it's free listens there too and says that port from then on (discovery, mDNS), so phones and computers that know
  // only that port, and a firewall rule made for it, reach Flick again; the other port stays open for those that found
  // Flick there.
  _usualPort(tries = 0) {
    this.usualT = setTimeout(() => {
      const srv = net.createServer((sock) => this._onSocket(sock));
      const onErr = () => { if (!this.stopped) this._usualPort(tries + 1); };
      srv.once('error', onErr);
      srv.listen(this.basePort, '0.0.0.0', () => {
        srv.removeListener('error', onErr);
        if (this.stopped) { srv.close(); return; }
        this.netUsual = srv;
        this.port = this.basePort;
        if (this.mdns) { this.mdns.svc.port = this.port; this.mdns.announce(); }
        this.emit('port', this.port);
      });
    }, tries < 60 ? 2000 : 30000);
  }

  // Also findable over mDNS (_flick._tcp): some networks pass multicast (as for printers and TVs) but drop the broadcast
  // that discovery uses. The phone asks with a plain DNS query and gets the answer straight back (mdns.js).
  _startMdns() {
    if (this.noMdns || this.mdns) return;
    try {
      const { MdnsService } = require('./mdns');
      this.mdns = new MdnsService({ type: '_flick._tcp.local', instance: 'Flick-' + this.id, host: 'flick-' + String(this.id).toLowerCase() + '.local', port: this.port,
        txt: this._mdnsTxt() }, (...a) => this.emit('log', a.join(' ')));
      this.mdns.on('unavailable', () => { this.mdns = null; });
      this.mdns.start();
    } catch (e) { this.emit('log', 'mdns: ' + e.message); this.mdns = null; }
  }
  _mdnsTxt() { return { id: this.id, v: String(PROTO), tls: this.tlsCtx ? '1' : '0', n: String(this.name).slice(0, 60) }; }

  _onSocket(sock) {
    sock.on('error', () => sock.destroy());
    // Caps on open connections, per address and in all, so nobody can tie up the PC with idle or half-made ones (a phone
    // uses a few at a time: the WebSocket, a handful of parallel transfer streams, thumbnails). Once they're all taken,
    // a newcomer takes the place of an idle one nobody signed in on (see _makeRoom): a device on the network that never
    // paired can't keep the user's own devices out.
    const addr = sock.remoteAddress || '';
    // (an address with all it may have: one of its own makes way, so one that keeps connecting from a phone's address,
    // behind the same router say, can't keep the phone out)
    const known = this._addrTrusted(addr);
    if ((this.sockByAddr.get(addr) || 0) >= (known ? SOCKS_PER_ADDR : STRANGER_PER_ADDR) && !this._makeRoom(addr)) { sock.destroy(); return; }
    if (this.sockCount >= SOCKS_TOTAL && !this._makeRoom()) { sock.destroy(); return; }
    const n = this.sockByAddr.get(addr) || 0;
    const rec = { sock, tls: null, addr, busy: 0, kept: false, s: null, gone: false, idle: mono() };   // idle: since when
    sock[SOCK] = rec;
    this.socks.add(rec);
    this.sockByAddr.set(addr, n + 1); this.sockCount++;
    sock.once('close', () => this._sockGone(rec));
    // a connection that never says anything doesn't get to hold a socket
    const quiet = setTimeout(() => sock.destroy(), 15000);
    sock.once('close', () => clearTimeout(quiet));
    sock.once('data', (first) => {
      clearTimeout(quiet);
      sock.pause();
      sock.unshift(first);
      if (first[0] === 0x16 && this.tlsCtx) {
        const t = new tls.TLSSocket(sock, { isServer: true, secureContext: this.tlsCtx });
        t[SOCK] = rec; rec.tls = t;
        const hs = setTimeout(() => t.destroy(), 15000);
        t.on('error', () => t.destroy());
        t.once('close', () => clearTimeout(hs));
        t.once('secure', () => { clearTimeout(hs); this.http.emit('connection', t); });
      } else {
        this.http.emit('connection', sock);
      }
      process.nextTick(() => sock.resume());
    });
  }

  _sockGone(rec) {
    if (rec.gone) return;
    rec.gone = true;
    this.socks.delete(rec);
    this.sockCount--;
    const k = (this.sockByAddr.get(rec.addr) || 1) - 1;
    if (k > 0) this.sockByAddr.set(rec.addr, k); else this.sockByAddr.delete(rec.addr);
    if (rec.kept) {
      const now = mono();
      if (this.trustAt.size >= 256 && !this.trustAt.has(rec.addr)) for (const [a, at] of this.trustAt) if (now - at > TRUSTED_ADDR_MS) this.trustAt.delete(a);
      this.trustAt.set(rec.addr, now);
      const j = (this.keptByAddr.get(rec.addr) || 1) - 1;
      if (j > 0) this.keptByAddr.set(rec.addr, j); else this.keptByAddr.delete(rec.addr);
    }
  }

  // A paired device signed in on this connection (a request with its token, a signed-in link) or a browser the user
  // allowed used it: it's never closed to make room, and its address gets a device's share of connections
  _keepSock(rec) {
    if (!rec || rec.kept || rec.gone) return;
    rec.kept = true;
    this.keptByAddr.set(rec.addr, (this.keptByAddr.get(rec.addr) || 0) + 1);
  }

  // A browser the user allowed (Share with a browser): its session header, or a download link of its own (a link
  // carries its key instead, and only works from that browser's address)
  _allowedBrowser(req, u) {
    const w = this.web._session(req);
    if (w) return w.state === 'ok';
    const m = /^\/w\/[^/]*\/dl\/([A-Za-z0-9_-]{22})\//.exec(u.pathname);
    const s = m && this.web.byDl && this.web.byDl.get(m[1]);
    return !!(s && s.state === 'ok' && s.address === this.web._addr(req));
  }

  // an answer waiting here for its connection's other end to read it
  _unread(r) { return r.sock.writableLength > 0 || !!(r.tls && r.tls.writableLength > 0); }

  _addrTrusted(addr) {
    if (this.keptByAddr.has(addr)) return true;
    const at = this.trustAt.get(addr);
    return at !== undefined && mono() - at < TRUSTED_ADDR_MS;
  }

  // Every connection place is taken: a stranger's connection goes (no request under way, nobody signed in on it, not a
  // pairing the user is being asked about): one from the address whose connections have had to make way the most of
  // late, then the one left idle the longest. One that keeps opening connections (bare ones, more than there are places)
  // so pushes out its own, never a new phone's few that are pairing or signing in, however long its network takes; and
  // a phone's burst, all still in their TLS handshakes, is the newest. Nothing from an address where a paired device or
  // an allowed browser is (or was a moment ago) signed in is ever closed for this.
  // only: just from that address (one with all it may have), and there from before a device signed in there too.
  _makeRoom(only) {
    const now = mono();
    const ok = (r) => {
      // (a request under way keeps its connection only while its answer is being taken: anyone can ask for answers and
      // never read them, and so have every connection look busy for as long as they like. Downloads that run slowly
      // are a signed-in device's or an allowed browser's, kept anyway.)
      if (r.gone || r.kept || (r.busy && !this._unread(r))) return false;
      if (r.s && r.s.device && this.pending.get(r.s.device) === r.s) return false;
      return only !== undefined ? r.addr === only : !this._addrTrusted(r.addr);
    };
    const made = (a) => { const m = this.madeWay.get(a); return m && now - m.at < MADE_WAY_MS ? m.n : 0; };
    let best = null, bestN = 0;
    for (const r of this.socks) {
      if (!ok(r)) continue;
      const n = made(r.addr);
      if (!best || n > bestN || (n === bestN && r.idle < best.idle)) { best = r; bestN = n; }
    }
    if (!best) return false;
    if (this.madeWay.size >= 1024 && !this.madeWay.has(best.addr)) for (const [a, m] of this.madeWay) if (now - m.at >= MADE_WAY_MS) this.madeWay.delete(a);
    if (this.madeWay.size < 1024 || this.madeWay.has(best.addr)) this.madeWay.set(best.addr, { n: bestN + 1, at: now });
    this._sockGone(best);
    best.sock.destroy();
    return true;
  }

  // A stream relayed from a Bluetooth link (bt.js, mux.js) gets the caps of a connection from the network: at most
  // SOCKS_TOTAL at once (counted apart from those, so neither can take the other's places; one link has at most mux.js
  // MAX_STREAMS open), and one that says nothing goes
  _relayed(sock) {
    this.relayCount = this.relayCount || 0;
    if (this.relayCount >= SOCKS_TOTAL) { sock.destroy(); return; }
    this.relayCount++;
    const quiet = setTimeout(() => sock.destroy(), 15000);
    sock.once('data', () => clearTimeout(quiet));
    sock.once('close', () => { this.relayCount--; clearTimeout(quiet); });
  }

  // How a socket reached us: 'plain', 'bluetooth' (a paired device over an encrypted Bluetooth link, relayed through
  // the mux) or this PC's certificate fingerprint (TLS). The sign-in and the pairing code are bound to it.
  _chan(sock) {
    if (sock && sock.remoteFamily === 'bluetooth') return 'bluetooth';
    if (sock && sock.encrypted && this.fp) return this.fp;
    return 'plain';
  }

  stop() {
    // Flick is closing here: every other Flick device sending here (or asking to pair) hears so first, before its links
    // and uploads go, and says that Flick was closed here rather than that it couldn't reach this PC ('bye')
    const peers = new Set([...this.peers.values(), ...this.pending.values()].filter((s) => s.peer && s.conn && s.conn.open));
    for (const s of peers) { try { s.conn.send({ t: 'bye', why: 'quit' }); } catch (e) { /* gone */ } }
    clearInterval(this.sweepT); this.sweepT = null;
    clearInterval(this.offerT); this.offerT = null;
    for (const kind of [...(this.logLimits || new Map()).keys()]) this._logLimitedEnd(kind);   // (how many more: said now)
    for (const t of this.phoneProvT.values()) clearTimeout(t);
    this.phoneProvT.clear();
    // what was still arriving can't be continued after this (a new start knows nothing of it): its staged part goes
    // now, as Flick quits, not hours later (unlinking an open file works on Windows too: libuv shares delete)
    const gone = [];
    for (const b of [...this.bundleAsm.values()]) { this._dropBundleAsm(b, true); gone.push(b.root); }
    for (const a of [...this.assemblies.values()]) { this._dropAssembly(a, true); gone.push(a.path); }
    for (const [tid, e] of [...this.uploads]) { e.superseded = true; this._release(tid, e); this._cut(e.req); gone.push(e.path); }
    for (const p of gone) { try { if (p) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* the sweep at the next start */ } }
    if (this.mdns) { try { this.mdns.stop(); } catch (e) { /* ignore */ } this.mdns = null; }
    this.stopped = true;
    clearTimeout(this.usualT); clearTimeout(this.udpT);
    try { this.net && this.net.close(); } catch (e) { /* ignore */ }
    try { this.netUsual && this.netUsual.close(); } catch (e) { /* ignore */ }
    this.netUsual = null;
    try { this.http && this.http.close(); } catch (e) { /* ignore */ }
    try { this.udp && this.udp.close(); } catch (e) { /* ignore */ }
    if (this.session && this.session.conn) this.session.conn.close();
    for (const x of this.sessions.values()) { try { x.conn.close(); } catch (e) { /* ignore */ } }
    for (const s of peers) { try { s.conn.close(); } catch (e) { /* ignore */ } }
    this.api.stop();
  }

  _startDiscovery(tries = 0) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;
    let bound = false;
    sock.on('error', (e) => {
      // its port was taken by another program as Flick started (on Linux, maybe a socket the system gave that port for a
      // while): asked for again as Flick's own port is (see _usualPort), so phones and computers asking there find
      // Flick once it's free (said once)
      if (!bound && this.udp === sock && !this.stopped) {
        if (!tries) this.emit('log', 'udp error ' + e.message + ': discovery waits for its port');
        this.udp = null;
        try { sock.close(); } catch (x) { /* ignore */ }
        this.udpT = setTimeout(() => this._startDiscovery(tries + 1), tries < 60 ? 2000 : 30000);
        return;
      }
      this.emit('log', 'udp error ' + e.message);
    });
    sock.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
      if (!m || m.t !== 'flick?') return;
      // Answered as mDNS is (mdns.js): only on this PC's own networks, a few times a second to each address and not
      // many more in all, so nobody can aim its answers (many times a question's size) at someone else. Whether the
      // asker is paired here ('known') isn't said: no phone or computer reads it, and it told anyone listening which
      // device ids are paired with this PC.
      if (!onLink(rinfo.address) || !mayAnswer(this.discLimit, rinfo.address)) return;
      const r = { t: 'flick!', v: PROTO, id: this.id, name: this.name, port: this.port, os: process.platform, tls: this.tlsCtx ? 1 : 0, kind: 'pc' };
      // Flick's window is open on this PC: a device whose user holds Connect nearby takes it for the one meant
      if (this.ready) r.ready = 1;
      const reply = Buffer.from(JSON.stringify(r));
      sock.send(reply, rinfo.port, rinfo.address, () => {});
    });
    sock.bind(this.discoveryPort, () => {
      bound = true;
      if (tries) this.emit('log', 'discovery listens on ' + this.discoveryPort + ' now');
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
    });
  }

  setName(name) {
    this.name = String(name || '').slice(0, 60) || this.name;
    this.broadcast({ t: 'pc', name: this.name });
    if (this.mdns) { this.mdns.svc.txt = this._mdnsTxt(); this.mdns.announce(); }
  }

  _useTls(id) {
    this.tlsCtx = null; this.fp = null;
    if (!id) return;
    try { this.tlsCtx = tls.createSecureContext({ key: id.key, cert: id.cert, minVersion: 'TLSv1.2' }); this.tlsId = id; this.fp = id.fp; }
    catch (e) { this.tlsCtx = null; this.fp = null; this.emit('log', 'tls off: ' + e.message); }
  }

  /**
   * This PC's certificate, read later in this run (it couldn't be read at the start: tlscert.js): encrypted links from
   * now on, and discovery says so. Only when there was none; true when it's in use.
   */
  setTls(id) {
    if (this.tlsCtx || !id) return !!this.tlsCtx;
    this._useTls(id);
    if (!this.tlsCtx) return false;
    if (this.mdns) { this.mdns.svc.txt = this._mdnsTxt(); this.mdns.announce(); }
    return true;
  }

  setSettings(s) {
    Object.assign(this.settings, s);
    this.broadcast({ t: 'settings', side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme });
  }

  // ---------- trust ----------
  _trusted(device, token) {
    const d = device && this.devices[device];
    if (!d || typeof d.token !== 'string' || typeof token !== 'string' || !token) return false;
    const a = Buffer.from(token), b = Buffer.from(d.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);             // constant-time comparison
  }

  // A request carrying a token: once a phone has signed in over a secure link, its token is only good on one (the
  // phone app never uses a plain link, so a plain request with its token is someone else)
  _trustedReq(req, device, token) {
    if (!this._trusted(device, token)) return false;
    if (this.devices[device].tls && this._chan(req.socket) === 'plain') return false;
    this._keepSock(req.socket && req.socket[SOCK]);
    return true;
  }

  // The protocol 5 features (clipboard, links, notifications, folder sync, the background link, the remote) are for
  // phones that paired securely (with the code: tls) and only over an encrypted link (TLS or Bluetooth). A pairing made
  // without the code sent its token in the clear, so that token reaches none of them, on any link; it pairs again first.
  _v5ok(device, chan) {
    const d = device && Object.prototype.hasOwnProperty.call(this.devices, device) ? this.devices[device] : null;
    return !!(d && d.tls === true && !d.peer && chan && chan !== 'plain');
  }

  // the pairing a device signs in with: a phone's for a phone, a peer's (another Flick device sending here) for a peer,
  // so one can't pass for the other
  _pairingOf(s) {
    const d = s && s.device && Object.prototype.hasOwnProperty.call(this.devices, s.device) ? this.devices[s.device] : null;
    return d && !!d.peer === !!s.peer ? d : null;
  }

  _proof(token, role, s) {
    return hmac(token, 'flick-auth-v1|' + role + '|' + s.nonceP + '|' + s.nonceS + '|' + s.chan + '|' + s.device + '|' + this.id);
  }

  // A real phone reaches us at a LAN IP and its page is local (file://), so it sends no web Origin and a Host that is
  // a bare IP:port. Reject anything with a real browser Origin (a web page trying to drive us) or a DNS-name Host
  // (so a rebinding page can't pose as the phone). Loopback/absent is fine — that's how the phone and tests connect.
  _hostOk(req) {
    const origin = req.headers.origin;
    // The phone's page is a local file: Android WebView reports that as "null" or as a file: origin, and it always comes
    // over an encrypted link (the app's TLS proxy or its Bluetooth link). A web page makes "null" too (a sandboxed frame,
    // a data: document), and reaches this port over plain HTTP: there it's a web page like any other. A Bluetooth stream
    // gets the same checks as TLS: it comes through a port on the phone that a web page in the phone's browser can reach
    // too (Flick 2.0.0 on the phone lets anything through it). allowOrigin lets tests serve the phone page over http.
    const local = origin === 'null' || /^file:/i.test(origin || '');
    if (origin && !(local && this._chan(req.socket) !== 'plain') && !(this.allowOrigin && this.allowOrigin.test(origin))) return false;
    const host = (req.headers.host || '').replace(/^\[(.*)\]/, '$1').replace(/:\d+$/, '').trim();
    if (!host) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost';
  }

  approve(device) {
    const s = this.pending.get(device);
    // nothing asking any more (an Allow clicked as the request went away): nothing is paired
    if (!s) { this.emit('pair-cancel', device); return; }
    if (!s.pairCode) return;                               // the code wasn't shown yet: nothing the user could approve
    this.pending.delete(device);
    // Another Flick device this PC paired with the other way a moment ago (it was given a token for here then: main.js
    // grant(), 'back') keeps that token: pairing from both ends at once leaves each direction with one token, not two
    // that don't match. Any other pairing gets a new one: whoever is allowed now never inherits a token an earlier
    // pairing under this id was given.
    const was = this.devices[device];
    const keep = s.peer && was && was.peer && was.tls === true && was.back && Date.now() - was.back < 10 * 60000 && /^[0-9a-f]{32}$/.test(String(was.token || ''));
    const token = keep ? was.token : rid(16);
    this.devices[device] = { name: s.name || 'Phone', token, added: (keep && was.added) || Date.now() };
    if (s.chan && s.chan !== 'plain') this.devices[device].tls = true;          // paired over a secure link: stays secure
    // A phone whose user checks the code there too (it asked with confirm: 1, and shows Same code once it's allowed
    // here): the pairing is only on the way until it says so ('pair-done' on this link) or signs in with it, and goes if
    // neither comes in time (its link closing doesn't end it sooner: it may sign in again on another). A phone that
    // doesn't ask (an older one) keeps it at once.
    clearTimeout(this.phoneProvT.get(device)); this.phoneProvT.delete(device);
    if (!s.peer && s.pairConfirm) {
      this.devices[device].phoneProv = Date.now();
      this._phoneProv(device, token, PHONE_PROV_MS);
    }
    if (s.peer) {
      this.devices[device].peer = true; this.devices[device].kind = s.kind;
      if (keep) this.devices[device].back = was.back;
      // its user still checks the code there too: until it says so ('pair-done'), the pairing is only on the way, and
      // goes if it leaves first
      else {
        this.devices[device].prov = Date.now();
        s.approved = Date.now();
        clearTimeout(s.provT);
        s.provT = setTimeout(() => this._dropProvisional(s), 150000);
      }
      s.approved = s.approved || Date.now();
    }
    this.emit('devices-changed', this.devices);
    this.emit('pair-cancel', device);
    if (s && s.peer) {
      if (s.conn && s.conn.open) {
        s.trusted = true;
        s.token = token;
        this._linkCaps(s);                           // (paired on this link: what a signed-in one may send, as at sign-in)
        s.conn.send({ t: 'paired', token, fp: this.fp || undefined });
        this._peerConnected(s);
      }
      return;
    }
    if (s && s.conn && s.conn.open) {
      s.trusted = true;
      s.token = token;
      this._linkCaps(s);
      // fp: this PC's certificate, for a phone that paired over Bluetooth (it sees no certificate there) to pin before
      // its first Wi-Fi connection. Over TLS the phone pins the one it sees itself.
      s.conn.send({ t: 'paired', token, fp: this.fp || undefined });
      this._join(s, true);                        // the user just allowed this phone: it joins and becomes the one in use
    }
  }

  // the phone the PC listens to becomes s, unless a different phone is connected right now (nothing is closed)
  _focus(s) {
    const cur = this.session;
    if (cur && cur !== s && cur.connected && cur.conn.open) return false;
    this.session = s;
    return true;
  }

  // make s the phone in use even though another one is connected (the user asked for it): that one is told why it
  // lost the PC and closed. quiet: it's the same phone's older link, so there's nobody to tell.
  _takeOver(s, quiet) {
    const cur = this.session;
    if (cur && cur !== s) {
      const was = cur.connected && cur.conn.open;
      if (was || quiet) { try { if (!quiet) cur.conn.send({ t: 'replaced' }); cur.conn.close(); } catch (e) { /* ignore */ } }
      if (was) { cur.connected = false; this._unlist(cur); this.emit('disconnected', this._publicSession(cur)); }
    }
    this.session = s;
  }

  // ---------- several phones at once ----------
  _unlist(s) { if (s && s.device && this.sessions.get(s.device) === s) this.sessions.delete(s.device); }
  _live() { return [...this.sessions.values()].filter((x) => x.connected && x.conn.open); }

  // s joins the phones connected right now. Past MAX_PHONES a phone takes a place only when its user asked for it
  // (held Connect, or allowed it here): the one used longest ago is told 'replaced'. Returns false when it can't join.
  _join(s, asked) {
    if (!this.sessions.has(s.device) && this._live().length >= MAX_PHONES) {
      if (!asked) return false;
      const live = this._live().filter((x) => x !== s);
      const old = live.reduce((a, b) => ((this.usedAt.get(b.device) || 0) < (this.usedAt.get(a.device) || 0) ? b : a), live[0]);
      if (old) {
        try { old.conn.send({ t: 'replaced' }); old.conn.close(); } catch (e) { /* ignore */ }
        old.connected = false; this._unlist(old);
        this.emit('disconnected', this._publicSession(old));
      }
    }
    this._connected(s);
    if (asked) this.use(s.device);
    return true;
  }

  /** The user used this phone (a fling from it, a click in the panel): what the PC sends now goes to it. */
  use(device) {
    const s = device && this.sessions.get(device);
    if (!s || !s.connected || !s.conn.open) return false;
    this.usedAt.set(device, Date.now());
    if (this.session !== s) { this.session = s; this.emit('active', this._publicSession(s)); }
    return true;
  }

  // the phone in use left: the connected one used most recently takes its place (or the only one left)
  _pickActive() {
    let best = null;
    for (const x of this._live()) if (!best || (this.usedAt.get(x.device) || 0) > (this.usedAt.get(best.device) || 0)) best = x;
    this.session = best;
    if (best) this.emit('active', this._publicSession(best));
  }

  /** Every phone connected right now (the panel's list): the active one is where the PC's sends go. */
  phones() {
    return this._live().map((x) => Object.assign(this._publicSession(x), { active: x === this.session }));
  }

  // the page of `device` if it's open and signed in: connected, or the session the PC is listening to
  _pageFor(device) {
    if (!device) return null;
    const p = this.peers.get(device);
    if (p && p.conn.open && p.trusted) return p;
    const x = this.sessions.get(device);
    if (x && x.conn.open && x.trusted) return x;
    const c = this.session;
    return c && c.device === device && c.trusted && c.conn && c.conn.open ? c : null;
  }

  // the staging folder, made again if it went (a cache or temp cleaner emptied it while Flick ran)
  _stageDir() { try { fs.mkdirSync(this.tmpDir, { recursive: true, mode: STAGE_DIR }); } catch (e) { /* the open says why */ } }

  // Which phone started a transfer: replies about it ('saved', 'failed') go to that phone only, and no other device can
  // send under its id. Each device is kept as the sender of its newest OWN_MAX transfers: one that names ever more (a
  // flood of messages with new ids) forgets only its own oldest, never another's (which would make that one nobody's,
  // for it to take over), and never one still coming in.
  _own(tid, device) {
    tid = tidOf(tid);
    if (!tid || !device) return;
    const was = this.tidOwner.get(tid);
    if (was && was !== device) { const o = this.ownedBy.get(was); if (o) o.delete(tid); }
    this.tidOwner.set(tid, device);
    let mine = this.ownedBy.get(device);
    if (!mine) { mine = new Set(); this.ownedBy.set(device, mine); }
    mine.delete(tid);
    mine.add(tid);
    if (mine.size <= OWN_MAX) return;
    for (const k of mine) {
      if (mine.size <= OWN_MAX) break;
      if (this.uploads.has(k) || this.assemblies.has(k) || this.bundleAsm.has(k)) continue;
      mine.delete(k);
      this.tidOwner.delete(k);
    }
  }
  ownerOf(tid) { const k = tidOf(tid); return (k && this.tidOwner.get(k)) || null; }
  // a tid that's this device's, or nobody's yet
  _ownOk(tid, device) { const k = tidOf(tid), o = k && this.tidOwner.get(k); return !!k && (!o || o === device); }
  // another Flick device's pairing (a computer, a phone sending to this PC): it sends files here, and nothing else
  _isPeer(device) { const d = device && Object.prototype.hasOwnProperty.call(this.devices, device) ? this.devices[device] : null; return !!(d && d.peer); }
  // Another Flick device's upload is all here: it hears so over its link too ('got'), as the answer to the upload can be
  // lost when its connection breaks right then; it then waits for 'saved' (or 'failed'), and otherwise knows soon that
  // it never all came.
  _gotAll(device, tid) { if (this.recvWant) this.recvWant.delete(tid); if (this._isPeer(device)) this.pushToPhone({ t: 'got', tid }, device); }
  // How much of another device's upload has come, said over its link while it comes, when it asked ('send' with
  // recv: 1): over a slow link its network holds megabytes in flight, and the sender goes by this, not by what it put
  // into its connection, both for its progress and for how long it waits (see peerlink.js _post). Said four times a
  // second, and for each megabyte that comes (at most twenty times a second), so its progress keeps up on a fast link.
  // st: this upload's { at, n } (when it was last said, and how much).
  _recvTell(device, tid, bytes, st) {
    if (!this.recvWant || this.recvWant.get(tid) !== device) return;
    const now = mono(), dt = st.at ? now - st.at : Infinity;
    if (dt < 50 || (dt < 250 && bytes - (st.n || 0) < 1024 * 1024)) return;
    st.at = now; st.n = bytes;
    this.pushToPhone({ t: 'recv', tid, bytes }, device);
  }
  /** Whether a transfer is another Flick device's (it never waits on that device to send it later, as a phone's can). */
  isPeerTransfer(tid) { return this._isPeer(this.ownerOf(tid)); }

  /** Something about this PC every phone shows (its name, the animation settings, the phone app it hands out). */
  broadcast(obj) {
    const seen = new Set();
    for (const x of [this.session, ...this.sessions.values()]) {
      if (!x || seen.has(x) || !x.trusted || !x.conn || !x.conn.open) continue;
      seen.add(x);
      x.conn.send(obj);
    }
    return seen.size > 0;
  }

  /**
   * An event for one phone (protocol 5: clip, link, ring, ring-stop): over its page's WebSocket when Flick is open
   * there, else over its background link (/api/events); false when it has neither (the PC drops it).
   */
  sendEvent(device, obj) {
    const s = this._pageFor(device);
    if (s) {
      if (!this._v5ok(s.device, s.chan)) return false;      // never the clipboard etc. to a phone paired without the code
      s.conn.send(obj);
      return true;
    }
    return this.api.streamSend(device, obj);
  }

  /** The phone PC-initiated events go to: the phone in use, else the background link used or opened last. */
  eventTarget() {
    const s = this.session;
    if (s && s.device && s.trusted && s.conn && s.conn.open) return s.device;
    let best = null, bestAt = -1;
    for (const d of this.api.streamDevices()) {
      const at = this.usedAt.get(d) || 0;
      if (best === null || at > bestAt || (at === bestAt && this.api.streamOpenedAt(d) > this.api.streamOpenedAt(best))) { best = d; bestAt = at; }
    }
    return best;
  }

  deny(device) {
    const s = this.pending.get(device);
    this.pending.delete(device);
    if (s) {
      const now = mono();
      for (const [a, until] of this.cool) if (until < now) this.cool.delete(a);
      this.cool.set(s.address, now + 20000);
    }
    this.emit('pair-cancel', device);
    if (s) this._denied(s);
  }

  // A pairing allowed here whose other side never confirmed the code (its user said no, or it went away first): gone,
  // so nothing here says it can send files here when it can't
  _dropProvisional(s) {
    clearTimeout(s.provT);
    const d = this.devices[s.device];
    if (d && d.peer && d.prov) this.forget(s.device);
  }

  // The same for a phone (see approve): the pairing with token goes in ms unless the phone said Same code (or signed in
  // with it) by then. One allowed anew meanwhile (another token) isn't touched.
  _phoneProv(device, token, ms) {
    clearTimeout(this.phoneProvT.get(device));
    this.phoneProvT.set(device, setTimeout(() => {
      this.phoneProvT.delete(device);
      const d = Object.prototype.hasOwnProperty.call(this.devices, device) ? this.devices[device] : null;
      if (!d || d.peer || !d.phoneProv || d.token !== token) return;
      this.emit('log', 'the phone ' + (d.name || device) + ' never confirmed the code: its pairing is gone');
      this.forget(device);
    }, ms));
  }
  // it said so: the pairing stays
  _phoneKept(device) {
    const d = Object.prototype.hasOwnProperty.call(this.devices, device) ? this.devices[device] : null;
    if (!d || d.peer || !d.phoneProv) return;
    delete d.phoneProv;
    clearTimeout(this.phoneProvT.get(device)); this.phoneProvT.delete(device);
    this.emit('devices-changed', this.devices);
  }

  // s is told no. Another Flick device asks once per link (it opens a new one to ask again), so its link closes too; a
  // phone's stays, for its user to hold Connect again.
  // wait: refused only for now (ms until it may ask again): it's told how long, so it can say "Try again in N s" (one
  // from before says only that it wasn't allowed)
  _denied(s, wait) {
    if (!s.conn || !s.conn.open) return;
    s.conn.send(wait > 0 ? { t: 'denied', why: 'wait', s: Math.max(1, Math.ceil(wait / 1000)) } : { t: 'denied' });
    if (s.peer) s.conn.close();
  }

  forget(device) {
    delete this.devices[device];
    clearTimeout(this.phoneProvT.get(device)); this.phoneProvT.delete(device);
    this.emit('devices-changed', this.devices);
    // what it's sending right now stops: it isn't paired any more (nothing more of it is taken, nor saved); what's all
    // here and being saved stays (kept: said by the 'cancel' listener)
    const kept = new Set();
    for (const [tid, d] of [...this.tidOwner]) {
      if (d !== device) continue;
      const ev = { tid, device };
      this.emit('cancel', ev);
      if (ev.kept) kept.add(tid); else this.abortUpload(tid);
    }
    const p = this.peers.get(device);
    if (p) {
      // (what it was sending is told it didn't go, before its link closes: it doesn't take a link that went for "sent")
      for (const [tid, d] of this.tidOwner) if (d === device && !kept.has(tid) && p.conn.open) p.conn.send({ t: 'failed', tid, why: 'removed' });
      // It's told it was removed, on its own link here: it may have no other way to hear it (removed right after it was
      // allowed, before it said how to reach it back), and would keep this PC as paired. (Not when it asked for it.)
      if (!p.forgot && p.conn.open) p.conn.send({ t: 'peer-forget' });
      p.trusted = false; this.peers.delete(device); clearTimeout(p.provT);
      try { p.conn.close(); } catch (e) { /* ignore */ }
    }
    const x = this.sessions.get(device);
    if (x && x !== this.session) x.conn.close();
    if (this.session && this.session.device === device) { this.session.conn.close(); }
    this.api.closeStream(device);                 // its background link ends with the pairing
  }

  // ---------- phone messaging ----------
  // `device` names the phone; without it a reply about a transfer goes to the phone that started it, and anything
  // else to the phone in use (the active one)
  pushToPhone(obj, device) {
    let s = this.session;
    if (device) s = this._pageFor(device);
    else if (obj && this.ownerOf(obj.tid)) s = this._pageFor(this.ownerOf(obj.tid));
    if (s && s.conn && s.conn.open && s.trusted) { s.conn.send(obj); return true; }
    return false;
  }

  get connected() { return !!(this.session && this.session.connected && this.session.conn.open); }

  _connected(s) {
    s.connected = true;
    if (s.device) this.sessions.set(s.device, s);
    // joining next to another phone: it becomes the one in use only if the user used it more recently (a phone back
    // from a dropped link gets its place back)
    const cur = this.session;
    if (cur !== s && (!cur || !cur.connected || !cur.conn.open || (this.usedAt.get(s.device) || 0) > (this.usedAt.get(cur.device) || 0))) this.session = s;
    // addrs: every address this PC has, so the phone finds it there next time even where discovery can't reach
    s.conn.send({ t: 'connected', pc: { id: this.id, name: this.name, port: this.port, addrs: lanAddresses().map((a) => a.address).slice(0, 8) },
      side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme, app: this._appPublic(s) });
    this.emit('connected', this._publicSession(s));
  }

  _publicSession(s) {
    const o = { device: s.device, name: s.name, screen: s.screen, address: s.address, app: s.app || 0, appName: s.appName || '', via: s.via || '', secure: !!s.chan && s.chan !== 'plain' };
    if (s.peer) { o.peer = true; o.kind = s.kind; }
    return o;
  }

  // Another Flick device signed in to send here: it joins the peers (never the phones: nothing this PC sends to "the
  // phone" goes to it), told this PC's addresses like a phone
  _peerConnected(s) {
    const prev = this.peers.get(s.device);
    if (prev && prev !== s) { try { prev.conn.close(); } catch (e) { /* ignore */ } }
    s.connected = true;
    this.peers.set(s.device, s);
    s.conn.send({ t: 'connected', pc: { id: this.id, name: this.name, port: this.port, addrs: lanAddresses().map((a) => a.address).slice(0, 8) }, caps: PEER_CAPS });
    this.emit('peer-connected', this._publicSession(s));
  }

  /** The other Flick devices connected here to send (another PC, a phone sending to a phone). */
  peerSessions() {
    return [...this.peers.values()].filter((x) => x.conn.open && x.trusted).map((x) => this._publicSession(x));
  }

  // A line for the log that anything on the network can cause again and again (kind: what happened, said by `about` in
  // the count): the first LOG_ADDR a minute from an address (LOG_ALL from all of them), then one line with how many more
  // there were in that minute. Each such line pushed the user's own log (what Open log and feedback carry) further out.
  _logLimited(kind, addr, line, about) {
    const now = Date.now(), a = addr || '?';
    this.logLimits = this.logLimits || new Map();
    let w = this.logLimits.get(kind);
    if (w && now - w.at >= 60000) { this._logLimitedEnd(kind); w = null; }
    if (!w) { w = { at: now, about, logged: 0, more: 0, by: new Map(), from: new Set(), t: null }; this.logLimits.set(kind, w); }
    const k = w.by.get(a) || 0;
    if (k < LOG_ADDR && w.logged < LOG_ALL) {
      w.by.set(a, k + 1); w.logged++;
      this.emit('log', line);
      return;
    }
    w.more++;
    if (w.from.size < 1000) w.from.add(a);
    if (!w.t) w.t = setTimeout(() => this._logLimitedEnd(kind), w.at + 60000 - now);
  }
  _logLimitedEnd(kind) {
    const w = this.logLimits && this.logLimits.get(kind);
    if (!w) return;
    this.logLimits.delete(kind);
    clearTimeout(w.t);
    if (w.more) this.emit('log', w.about + ' ' + w.more + ' more times in that minute (from ' + (w.from.size === 1 ? [...w.from][0] : w.from.size + ' addresses') + ')');
  }

  // a failed sign-in (a paired phone's id is no secret: every phone says it in discovery, so anyone can fail one link
  // after another)
  _signInFailed(s) {
    const a = s.address || '?';
    this._logLimited('sign-in', a, 'sign-in failed for a phone (from ' + a + ')', 'sign-in failed for a phone');
  }

  // what s's link may send in one message (and in how many pieces) and have waiting here: little until it has signed
  // in or was allowed to pair (see EARLY_MSG_MAX), then a phone's clipboard or another Flick device's
  _linkCaps(s) {
    s.conn.maxMessage = !s.trusted ? EARLY_MSG_MAX : s.peer ? PEER_MSG_MAX : MAX_MESSAGE;
    s.conn.maxPieces = s.trusted ? MAX_PIECES : EARLY_PIECES;
    s.conn.maxQueued = s.trusted ? MAX_QUEUED : EARLY_QUEUED;
    if (s.trusted) this._keepSock(s.rec);
  }

  // after hello (and the sign-in, if any): s joins as trusted or not, and is told so
  _helloDone(s, trusted, why) {
    s.trusted = !!trusted;
    if (!s.trusted) s.token = null;
    this._linkCaps(s);
    if (s.peer) {
      // another Flick device: it never becomes the session (the phone in use); 'connect' makes it a connected peer
      const w = { t: 'welcome', v: PROTO, pc: { id: this.id, name: this.name }, trusted: s.trusted, kind: 'pc', caps: PEER_CAPS };
      if (why) w.why = why;
      s.conn.send(w);
      this.emit('peer-hello', this._publicSession(s));
      return;
    }
    // Opening Flick on a second phone must not knock the connected one off: a new socket becomes the session when
    // nobody is connected, or when it's the same phone (signed in) on a newer link. Other phones join next to it when
    // they "connect" (several at once, see _join).
    const cur = this.session;
    if (cur && cur !== s && cur.device === s.device && s.trusted) this._takeOver(s, true);   // same phone, newer link
    else {
      const prev = s.trusted && this.sessions.get(s.device);
      if (prev && prev !== s) {                                  // same phone, newer link (connected, not the one in use)
        prev.connected = false; this._unlist(prev);
        try { prev.conn.close(); } catch (e) { /* ignore */ }
        this.emit('disconnected', this._publicSession(prev));
      }
      this._focus(s);                                                                           // never knocks one off
    }
    const w = { t: 'welcome', v: PROTO, pc: { id: this.id, name: this.name }, trusted: s.trusted, side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme };
    if (why) w.why = why;
    s.conn.send(w);
    this.emit('phone-hello', this._publicSession(s));
    if (s.resume && s.trusted && this.session === s) this._connected(s);
  }

  _onUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    if (!this._hostOk(req)) { try { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) { socket.destroy(); } return; }
    // a phone needs one socket (two while it moves to a faster link); a flood from one address is refused
    const addr = socket.remoteAddress || '';
    this.wsByAddr = this.wsByAddr || new Map();
    if ((this.wsByAddr.get(addr) || 0) >= 8) { socket.destroy(); return; }
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    this.wsByAddr.set(addr, (this.wsByAddr.get(addr) || 0) + 1);
    const s = { conn, device: null, name: 'Phone', trusted: false, connected: false, screen: null, address: socket.remoteAddress, chan: this._chan(socket), rec: socket[SOCK] || null };
    if (s.rec) s.rec.s = s;
    s.uaSdk = uaSdk(req.headers['user-agent']);
    this._linkCaps(s);
    // a phone says hello right away (and signs in right after); a socket that doesn't is closed
    const helloT = setTimeout(() => { if (!s.device || s.authWait) conn.close(); }, 10000);
    // A phone that hasn't signed in keeps its link while its user holds Connect or asks to pair (and while that request
    // waits for the user here), and goes once it has done neither for UNPAIRED_IDLE_MS: such a link stayed for ever,
    // each one holding a place here. (Another Flick device has its own, shorter time: PEER_IDLE_MS.)
    s.actAt = mono();
    const idle = () => {
      if (!conn.open || s.trusted || s.peer) return;
      if (this.pending.get(s.device) === s) s.actAt = mono();
      const left = s.actAt + UNPAIRED_IDLE_MS - mono();
      if (left <= 0) { conn.close(); return; }
      s.unpairedT = setTimeout(idle, Math.max(1000, left));
    };
    s.unpairedT = setTimeout(idle, UNPAIRED_IDLE_MS);
    conn.on('message', (txt) => {
      let m;
      try { m = JSON.parse(txt); } catch (e) { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;     // (JSON, but not a message: null, 7, "x", [])
      this._onPhoneMessage(s, m);
    });
    conn.on('close', () => {
      clearTimeout(helloT);
      clearTimeout(s.idleT);
      clearTimeout(s.unpairedT);
      if (s.peer && s.approved) this._dropProvisional(s);
      const n = (this.wsByAddr.get(addr) || 1) - 1;
      if (n > 0) this.wsByAddr.set(addr, n); else this.wsByAddr.delete(addr);
      const was = s.connected;
      s.connected = false;
      this._unlist(s);
      if (s.peer && this.peers.get(s.device) === s) {
        this.peers.delete(s.device);
        this.emit('peer-disconnected', this._publicSession(s));
      }
      if (this.session === s) {
        this.session = null;
        this._pickActive();                       // another connected phone (if any) gets what the PC sends now
        this.emit('disconnected', this._publicSession(s));
      } else if (was && !s.peer) this.emit('disconnected', this._publicSession(s));   // (a peer leaving isn't a phone: see above)
      if (s.device && this.pending.get(s.device) === s) {
        this.pending.delete(s.device);
        this.emit('pair-cancel', s.device);
      }
    });
  }

  _onPhoneMessage(s, m) {
    // another Flick device: past signing in and pairing, it only sends files (and says how to reach it back)
    if (s.peer && !PEER_SIGN_IN.has(m.t)) { this._onPeerMessage(s, m); return; }
    // its user holds Connect, or asks to pair: a link that hasn't signed in stays (see UNPAIRED_IDLE_MS)
    if (m.t === 'hold' || m.t === 'hold-cancel' || m.t === 'connect' || m.t === 'pair-reveal') s.actAt = mono();
    switch (m.t) {
      case 'hello': {
        if (s.helloed) break;                                   // one hello per socket
        s.helloed = true;
        s.device = String(m.device || '').slice(0, 64);
        // (an id that's a name every object has, "__proto__" say, can't be a key of the pairings: allowed, it replaced
        // the table's prototype instead of being kept)
        if (Object.prototype.hasOwnProperty.call(Object.prototype, s.device)) { s.conn.close(); break; }
        s.name = cleanName(m.name, 'Phone');
        s.named = !!cleanName(m.name, '');                     // (a name of its own: see 'auth')
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        s.app = Math.max(0, Math.floor(+m.app || 0));          // phone app version code (0 = not said)
        s.appName = String(m.appName || '').slice(0, 20);
        s.sdk = Math.max(0, Math.floor(+m.sdk || 0));           // Android SDK level (0 = not said)
        s.via = /^(wifi|usb|hotspot|direct|ethernet|bluetooth)$/.test(m.via) ? m.via : (s.via || '');
        s.resume = !!m.resume;
        // another Flick device sending here (peer: 1): a computer, or a phone sending to a phone. It signs in like a
        // phone, over an encrypted link only.
        if (m.peer === 1 || m.peer === true) {
          s.peer = true;
          s.kind = m.kind === 'phone' ? 'phone' : 'pc';
          if (!cleanName(m.name, '')) s.name = s.kind === 'phone' ? 'Phone' : 'Computer';
          if (!((+m.v || 0) >= 4 && /^[0-9a-f]{32,64}$/.test(String(m.nonce || ''))) || s.chan === 'plain' || !s.device) { s.conn.close(); break; }
          // it gets on with it: signs in, or asks to pair (and waits for the user's answer); a link that does neither,
          // pinging or not, doesn't keep its place
          s.idleT = setTimeout(() => { if (!s.trusted && this.pending.get(s.device) !== s) s.conn.close(); }, PEER_IDLE_MS);
        }
        const d = this._pairingOf(s);
        if ((+m.v || 0) >= 4 && /^[0-9a-f]{32,64}$/.test(String(m.nonce || ''))) {
          // Sign-in. The token never crosses the network: each side proves it holds it with an
          // HMAC over both sides' random numbers and the link's identity (this PC's certificate), so someone in the
          // middle can neither read it nor relay the proof onto a link of their own. The PC proves itself first.
          s.v4 = true; s.nonceP = m.nonce; s.nonceS = rid(16);
          if (d && d.token && d.tls && s.chan !== 'plain') {
            s.authWait = true;
            s.conn.send({ t: 'auth?', v: PROTO, nonce: s.nonceS, proof: this._proof(d.token, 'pc', s), pc: { id: this.id, name: this.name } });
            break;                                              // continues at 'auth'
          }
          // Not paired here: it can ask to pair. A phone paired without the code is one too: its token travelled in
          // the clear and may have been overheard, so it isn't enough to sign in with. It confirms once with the code.
          this._helloDone(s, false, d && d.token && !d.tls && s.chan !== 'plain' ? 'confirm' : undefined);
          break;
        }
        // a phone app that doesn't sign in sends the token itself: good only over a plain link, from a phone that never
        // signed in over a secure one
        s.trusted = !!d && this._trusted(s.device, m.token) && !d.tls;
        s.token = s.trusted ? m.token : null;
        if (s.trusted && d.phoneProv) this._phoneKept(s.device);
        this._helloDone(s, s.trusted);
        break;
      }
      case 'auth': {
        if (!s.authWait) break;
        s.authWait = false;
        const d = this._pairingOf(s);
        if (!d || !d.token || !sameHex(String(m.proof || ''), this._proof(d.token, 'phone', s))) {
          this._signInFailed(s);
          this._helloDone(s, false, 'auth');                    // it can still ask to pair again
          break;
        }
        s.token = d.token;
        if (s.peer && s.named && d.name !== s.name) { d.name = s.name; this.emit('devices-changed', this.devices); this.emit('peer-name', { device: s.device, name: s.name }); }
        // a phone this PC asked (its user held Connect here: main.js connect) signed in with the pairing it was given:
        // it stays
        if (!s.peer && d.homeProv) { delete d.homeProv; this.emit('devices-changed', this.devices); }
        // a phone that signs in with the pairing allowed here a moment ago kept it: it stays (see approve)
        if (!s.peer && d.phoneProv) this._phoneKept(s.device);
        this._helloDone(s, true);
        break;
      }
      case 'screen':
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        break;
      case 'hold':
        // a paired phone's hold shows even while another phone is connected (it's about to join)
        if (this.session === s || this._focus(s) || s.trusted) this.emit('hold', { p: Math.max(0, Math.min(1, +m.p || 0)) });
        break;
      case 'hold-cancel':
        if (this.session === s || s.trusted) this.emit('hold', { p: 0, cancel: true });
        break;
      case 'connect':
        if (s.trusted && s.peer) { this._peerConnected(s); break; }
        if (s.trusted) {
          // asked: the user held Connect on this phone (a phone app below USER_FLAG_CODE doesn't say, and only ever
          // sends "connect" when the user held it, so for it it always counts). It then becomes the phone in use.
          const asked = m.user === true || (s.app || 0) < USER_FLAG_CODE;
          if (this.session === s || this._focus(s)) { this._connected(s); if (asked) this.use(s.device); }
          else if (!this._join(s, asked)) s.conn.send({ t: 'busy' });   // MAX_PHONES connected and nobody asked
        } else {
          if (!s.helloed || s.authWait) break;
          // Another Flick device asks once per link (it opens a new one to ask again): asking again on the same link
          // would change the code of a request the user is looking at
          if (s.peer) { if (s.pairAsked) break; s.pairAsked = true; }
          // A device that asks without the code (a Flick from before protocol 4: 1.8 and older) isn't asked about here:
          // every pairing goes through the same code on both screens. It's told why (it needs a newer Flick), and holds
          // no place a phone asking with the code would need. (One paired that way long ago still signs in with its
          // pairing: see 'hello'.)
          // (said in the log, and as 'pair-refused' for whoever listens, once a minute for an address: one could ask
          // again and again, on link after link; this link is closed after it)
          if (!s.v4) {
            const now = mono();
            this.oldAsks = this.oldAsks || new Map();
            if (!(this.oldAsks.has(s.address) && now - this.oldAsks.get(s.address) < 60000)) {
              this.oldAsks.delete(s.address);
              this.oldAsks.set(s.address, now);                  // (oldest first)
              for (const [a, t] of this.oldAsks) if (this.oldAsks.size > 500 || now - t >= 60000) this.oldAsks.delete(a); else break;
              this.emit('log', 'a request to pair without the code (an older Flick) was refused');
              this.emit('pair-refused', Object.assign(this._publicSession(s), { why: 'old' }));
            }
            s.conn.send({ t: 'denied', why: 'old' });
            s.conn.close();
            break;
          }
          // Each request pulls the Flick window to the front, so a stranger mustn't be able to spam them: one prompt
          // at a time, a short pause for an address the user just declined, and a cap per minute. (Timed by a clock that
          // only moves forward: the wall clock set back an hour made a "Don't allow" or the cap last that hour.)
          const now = mono();
          const cool = this.cool.get(s.address) || 0;
          if (cool > now) { this._denied(s, cool - now); break; }
          // Nor can one hold the place: a request that hasn't revealed its half of the code a few seconds on (pinging or
          // not) makes way for a newer one. One on the screen stays until the user answers, or it goes.
          for (const [dev, p] of this.pending) {
            if (p === s) continue;
            if (!p.conn || !p.conn.open || (p.v4 && p.pairCommit && !p.pairCode && now - (p.pairAt || 0) > 5000)) {
              this.pending.delete(dev);
              if (p.conn && p.conn.open) { try { p.conn.send({ t: 'denied' }); p.conn.close(); } catch (e) { /* gone */ } }
            }
          }
          if ([...this.pending.values()].some((p) => p !== s)) { this._denied(s); break; }
          if (!/^[0-9a-f]{64}$/.test(String(m.commit || ''))) break;
          this.pairTimes = this.pairTimes.filter((t) => now - t < 60000);
          if (this.pairTimes.length >= 6) { this._denied(s, this.pairTimes[0] + 60000 - now); break; }
          // Each request that hears this side's half of the code counts for its address, shown to the user or not: one
          // that goes away unrevealed can't try again and again, unseen, until a code it wants comes up (another
          // address isn't held up by it)
          const peeks = (this.peeks.get(s.address) || []).filter((t) => now - t < 60000);
          if (peeks.length >= 6) { this._denied(s, peeks[0] + 60000 - now); break; }
          peeks.push(now);
          this.peeks.set(s.address, peeks);
          if (this.peeks.size > 500) for (const [a, ts] of this.peeks) if (now - ts[ts.length - 1] > 60000) this.peeks.delete(a);
          // a phone whose user checks the code there too once it's allowed here (confirm: 1): see approve
          s.pairConfirm = !s.peer && (m.confirm === 1 || m.confirm === true);
          this.pending.set(s.device, s);
          // Pairing code: the phone has committed to its random number (a hash of it); we answer with ours; only then
          // does it reveal its own. So nobody, the phone included, can pick numbers that steer the code, and someone in
          // the middle (with a different certificate) shows a different code.
          // Another Flick device is answered with a hash of this side's half too: the half itself comes only once the
          // request is on the user's screen ('pair-reveal'), so a requester never learns it unseen.
          s.pairCommit = String(m.commit); s.pairNonceS = rid(16); s.pairCode = null; s.pairAt = now;
          s.conn.send(s.peer ? { t: 'pairing', commit: sha256(s.pairNonceS) } : { t: 'pairing', nonce: s.pairNonceS });
          // (the PC asks once the phone reveals: 'pair-reveal')
        }
        break;
      case 'pair-reveal': {
        if (!s.v4 || !s.pairCommit || s.pairCode || this.pending.get(s.device) !== s) break;
        const n = String(m.nonce || '');
        const now = mono();
        this.pairTimes = this.pairTimes.filter((t) => now - t < 60000);
        if (!/^[0-9a-f]{32,64}$/.test(n) || sha256(n) !== s.pairCommit || this.pairTimes.length >= 6) {
          this.pending.delete(s.device);
          this._denied(s);
          break;
        }
        this.pairTimes.push(now);                                // a request shown to the user (the cap per minute)
        s.pairCode = pairCode(s.chan, n, s.pairNonceS);
        const was = this._pairingOf(s);
        // upgrade: a phone paired without the code confirming itself once with it
        this.emit('pair-request', Object.assign(this._publicSession(s), { code: s.pairCode, upgrade: !!(was && was.token && !was.tls), again: !!(s.peer && was && was.token && !was.prov) }));
        // (another Flick device: now that it's on the user's screen, this side's half, to show the same code there)
        if (s.peer) s.conn.send({ t: 'pair-nonce', nonce: s.pairNonceS });
        break;
      }
      // protocol 8: Air grab ('air-go': the hand let go of what it lifted; 'air-catch': a fist opened over the phone, for
      // the files a fist picked up here; 'air-ready': the phone has Air grab on and Flick open, or not any more)
      case 'lift': case 'move': case 'drop': case 'cancel': case 'send': case 'air-go': case 'air-catch': case 'air-ready':
        if (s.trusted && (this.session === s || (s.connected && this.sessions.get(s.device) === s))) {
          // (a transfer is its sender's: another phone's can't be announced, moved or stopped from this one)
          if (m.tid != null && !this._ownOk(m.tid, s.device)) break;
          // a fling makes this the phone in use; its replies ('saved', 'failed') go back to it
          if (m.t === 'lift' || m.t === 'send' || m.t === 'air-catch') this.use(s.device);
          this._own(m.tid, s.device);
          m.device = s.device;
          this.emit(m.t, m);
        }
        break;
      case 'pair-done': {
        // the phone's user saw the same code there too (Same code): the pairing allowed here, on this link, stays
        const d = this._pairingOf(s);
        if (s.trusted && !s.peer && d && d.phoneProv && s.token === d.token) this._phoneKept(s.device);
        break;
      }
      case 'set-side':
        if (s.trusted && (m.side === 'left' || m.side === 'right')) this.emit('set-side', m.side);
        break;
      case 'set-theme':
        if (s.trusted && typeof m.theme === 'string') this.emit('set-theme', m.theme.slice(0, 20));
        break;
      case 'incoming-done':
        if (s.trusted) this.emit('incoming-done', m);
        break;
      case 'incoming-stopped':
        // the phone's user stopped a file this PC offered it (its Cancel there): said Canceled here too
        if (s.trusted && s.device && typeof m.fid === 'string' && m.fid.length <= 64) this.emit('incoming-stopped', { fid: m.fid, device: s.device });
        break;
      case 'incoming-failed':
        // the phone gave up on a file this PC offered it because the file changed here meanwhile (a range refused with
        // 409 changed): its row says so, not "Didn't finish"
        if (s.trusted && s.device && typeof m.fid === 'string' && m.fid.length <= 64 && m.why === 'changed') this.emit('incoming-failed', { fid: m.fid, device: s.device, why: 'changed' });
        break;
      case 'app-check':
        if (s.trusted && (this.session === s || s.connected)) { this.appAsker = s.device; this.emit('app-check'); }
        break;
      case 'ping':
        // (the page's clock, said back: a number only, so no link can have this PC send it back megabytes it sent)
        s.conn.send(typeof m.ts === 'number' && Number.isFinite(m.ts) ? { t: 'pong', ts: m.ts } : { t: 'pong' });
        break;
      // protocol 5: the remote, the clipboard and links from the page, and "found it" after the PC rang the phone
      case 'media': case 'clip': case 'link': case 'ring-found':
        if (s.trusted && s.device && this._v5ok(s.device, s.chan)) this.api.fromPage(s, m);
        break;
      default:
        break;
    }
  }

  _onPeerMessage(s, m) {
    if (!s.trusted || this.peers.get(s.device) !== s || !s.conn.open) return;
    switch (m.t) {
      case 'send': case 'cancel': {
        // files coming: their card flies in like a phone's from its menu ('send'); replies go back to this device. A
        // transfer is its sender's: another device's (a phone's, another computer's) can't be announced or stopped.
        // Its id is one the upload routes take as it is (both senders make theirs that way).
        const tid = typeof m.tid === 'string' && TID_RE.test(m.tid) ? m.tid : '';
        if (!tid || !this._ownOk(tid, s.device)) break;
        if (m.t === 'cancel') {
          // (only one of its own transfers: a cancel for one nobody started stops nothing, and isn't kept)
          if (this.tidOwner.get(tid) !== s.device) break;
          // (why: its user canceled it there, or Flick was closed there in the middle of it: quit)
          this.emit('cancel', { t: 'cancel', tid, device: s.device, peer: true, failed: m.failed === true, why: m.why === 'canceled' || m.why === 'quit' ? m.why : undefined });
          break;
        }
        // a device sends one thing at a time: a flood of cards (more than two a second, for a minute) is not a send. Kept
        // for the device, not the link (linking again doesn't start it over).
        const now = Date.now();
        this.sendTimes = this.sendTimes || new Map();
        const times = (this.sendTimes.get(s.device) || []).filter((t) => now - t < 60000);
        if (times.length >= 120) { s.conn.send({ t: 'failed', tid, why: 'busy' }); break; }
        times.push(now);
        this.sendTimes.set(s.device, times);
        if (this.sendTimes.size > 200) for (const [k, v] of this.sendTimes) if (!v.length || now - v[v.length - 1] > 60000) this.sendTimes.delete(k);
        this._own(tid, s.device);
        // (it wants to hear how much of it has come while it comes: recv)
        if (m.recv === 1 || m.recv === true) {
          this.recvWant = this.recvWant || new Map();
          this.recvWant.set(tid, s.device);
          if (this.recvWant.size > 500) this.recvWant.delete(this.recvWant.keys().next().value);
        }
        this.emit('send', this._peerSend(m, tid, s.device));
        break;
      }
      case 'pair-done': {
        // its user saw the same code: the pairing allowed here stays
        const d = this._pairingOf(s);
        if (d && d.prov && s.approved) { delete d.prov; clearTimeout(s.provT); this.emit('devices-changed', this.devices); }
        break;
      }
      case 'peer-back': {
        // How to reach this device in return: pairing goes both ways at once. Its receiver's certificate and a token for
        // this PC come over this signed-in, encrypted link, from a device the user just allowed with the code: only on
        // the link allowed here, right after (never later, from a device that's just signed in).
        if (!s.approved || Date.now() - s.approved > 5 * 60000) break;
        const d = this._pairingOf(s);
        const token = typeof m.token === 'string' ? m.token : '', fp = typeof m.fp === 'string' ? m.fp.toLowerCase() : '';
        const port = typeof m.port === 'number' ? m.port : 0;
        if (!d || d.tls !== true || !/^[0-9a-f]{32}$/.test(token) || !/^[0-9a-f]{64}$/.test(fp) || !(Number.isInteger(port) && port > 0 && port < 65536)) break;
        if (d.prov) { delete d.prov; clearTimeout(s.provT); this.emit('devices-changed', this.devices); }
        this.emit('peer-back', { device: s.device, name: s.name, kind: s.kind, token, fp, port, address: s.address });
        break;
      }
      case 'peer-forget':
        // it removed this PC: this PC removes it too (both ways)
        s.forgot = true;
        this.emit('peer-forget', { device: s.device });
        this.forget(s.device);
        break;
      case 'clip': case 'link': {
        // Its clipboard, or a link (each only when its user asked there; a few a minute at most: more is a flood). The
        // answer ('ack', with its mid) says whether it was taken. features.js does what the user sees.
        const mid = typeof m.mid === 'string' ? m.mid.slice(0, 24) : '';
        let why = null;
        const now = Date.now();
        this.peerMsgTimes = this.peerMsgTimes || new Map();
        const k = s.device + '|' + m.t, times = (this.peerMsgTimes.get(k) || []).filter((t) => now - t < 60000);
        if (times.length >= 20) why = 'busy';
        else {
          times.push(now);
          this.peerMsgTimes.set(k, times);
          if (this.peerMsgTimes.size > 300) for (const [x, v] of this.peerMsgTimes) if (!v.length || now - v[v.length - 1] > 60000) this.peerMsgTimes.delete(x);
          why = m.t === 'clip' ? this._peerClip(s, m) : this._peerLink(s, m);
        }
        if (mid) s.conn.send({ t: 'ack', mid, ok: !why, why: why || '' });
        break;
      }
      default:
        break;
    }
  }

  // a clipboard from another device: null once it's handed on (features.js puts it on this computer's), else why not.
  // priv: one its device says is private (a password manager's): as from a phone, never kept in a history here
  _peerClip(s, m) {
    if (!this.api.feat.clip) return 'off';
    const priv = m.private === true;
    if (m.kind === 'text') {
      if (typeof m.text !== 'string' || !m.text) return 'empty';
      if (Buffer.byteLength(m.text, 'utf8') > 1024 * 1024) return 'too big';
      this.emit('peer-clip', { device: s.device, name: s.name, kind: 'text', text: m.text, priv });
      return null;
    }
    if (m.kind === 'image') {
      if (typeof m.png !== 'string' || !m.png) return 'empty';
      const b64 = m.png.replace(/^data:image\/png;base64,/, '');
      if (b64.length > Math.ceil(4400 * 1024 / 3) * 4 + 16) return 'too big';
      const png = Buffer.from(b64, 'base64');
      if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return 'bad';
      this.emit('peer-clip', { device: s.device, name: s.name, kind: 'image', png, priv });
      return null;
    }
    return 'bad';
  }

  // a link from another device: never opened by itself here (features.js asks)
  _peerLink(s, m) {
    const url = cleanUrl(m.url);
    if (!url) return 'bad';
    this.emit('peer-link', { device: s.device, name: s.name, url });
    return null;
  }

  // What another device announces, as the app takes it: only what a send carries (peerlink.js, PeerClient.java), each
  // value of its type and within its range, so its card on this screen is an ordinary card (a picture only as an image).
  _peerSend(m, tid, device) {
    const f = m.file && typeof m.file === 'object' && !Array.isArray(m.file) ? m.file : {};
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    const file = { name: str(f.name, 255) || 'file', size: Math.floor(num(f.size, 0, Number.MAX_SAFE_INTEGER, 0)), kind: str(f.kind, 20) || 'file',
      count: Math.floor(num(f.count, 1, 1000000, 1)), badge: str(f.badge, 8) };
    if (f.folder === true) file.folder = true;
    const o = { t: 'send', tid, device, peer: true, file, w: Math.round(num(m.w, 40, 400, 150)), h: Math.round(num(m.h, 40, 400, 150)) };
    // the animation it was sent with (the same leaves the other screen; a phone's flick says where it left, too)
    if (['meteor', 'volt', 'warp', 'glitch'].includes(m.look)) o.look = m.look;
    // (a small picture only: a few hundred kilobytes can describe one the overlay couldn't hold in memory)
    if (typeof m.thumb === 'string' && m.thumb.length < 400000 && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(m.thumb) && smallPicture(m.thumb)) o.thumb = m.thumb;
    return o;
  }

  // ---------- HTTP ----------
  _cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  _json(res, code, obj) {
    this._cors(res);
    // An answer before a large body has come in (no space, canceled, gone): the connection closes after it, so the
    // phone's writes stop at once and it reads this answer, instead of the rest of the file being sent to be thrown away
    // (phones keep their connections open for the next request).
    const req = res.req;
    const big = req && !req.complete && (+req.headers['content-length'] > 256 * 1024 || /chunked/i.test(String(req.headers['transfer-encoding'] || '')));
    res.writeHead(code, big ? { 'Content-Type': 'application/json', Connection: 'close' } : { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  _onRequest(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    // (a request under way: its connection isn't idle, see _makeRoom)
    const rec = req.socket && req.socket[SOCK];
    if (rec) { rec.busy++; res.once('close', () => { if (--rec.busy === 0) rec.idle = mono(); }); }
    // browsers on the "Share with a browser" page (webshare.js): their own routes under /w/ with their own checks
    if (this.web && this.web.handle(req, res, u)) {
      if (rec && !rec.kept && this._allowedBrowser(req, u)) this._keepSock(rec);
      return;
    }
    if (req.method === 'OPTIONS') { this._cors(res); res.writeHead(204); res.end(); return; }
    if (req.method === 'POST') this._watchBody(req);
    if (!this._hostOk(req)) { res.writeHead(403); res.end(); return; }
    const q = u.searchParams;
    if (req.method === 'GET' && u.pathname === '/api/hello') {
      // reachable only by non-browser clients (the host/origin gate above blocks web pages); the phone needs id+name
      return this._json(res, 200, { app: 'flick', v: PROTO, id: this.id, name: this.name, port: this.port, tls: this.tlsCtx ? 1 : 0, qparts: 1 });
    }
    // protocol 5: /api/events, /api/clip, /api/link, /api/notify, /api/sync/* (phoneapi.js, same token checks)
    if (this.api.handle(req, res, u)) return;
    // Another Flick device (a peer) only sends files here, as a whole file or a bundle with a card, and only its own
    // transfers: every other route is a phone's (quiet photos, resumable parts, what this PC has, its downloads, the app).
    const peer = this._isPeer(q.get('device'));
    // A transfer is its sender's: an id another phone (or device) started is turned away on every route that sends
    // (otherwise one paired phone could cut off another's upload and have its own bytes saved in its place)
    const ours = () => !tidOf(q.get('tid')) || this._ownOk(q.get('tid'), q.get('device'));
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      if (!ours() || (peer && (q.get('quiet') === '1' || q.has('kind') || !this._ownOk(q.get('tid'), q.get('device'))))) { req.resume(); return this._json(res, 403, { ok: false, error: 'not allowed' }); }
      // (another device sends a file with its length, which is checked against the room here before anything is kept)
      if (peer && !/^\d{1,16}$/.test(String(req.headers['content-length'] || ''))) { req.resume(); return this._json(res, 411, { ok: false, error: 'length required' }); }
      // (one sent quietly is its phone's too, as one in quiet parts is: another paired phone that came by its id can't
      // send into it, replace it or cancel it, and it stops with its phone's pairing)
      this._own(q.get('tid'), q.get('device'));
      return this._handleUpload(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/part') {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) { req.resume(); return this._json(res, 403, { ok: false, error: 'not paired' }); }
      if (!ours()) { req.resume(); return this._json(res, 403, { ok: false, error: 'not allowed' }); }
      this._own(q.get('tid'), q.get('device'));
      return this._handlePart(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/bundle') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      // Another device sends a bundle in one go, saying how much it holds: the phone's ways (several streams at once, kept
      // to carry on for hours, a card for each attempt) are its own
      if (!ours() || (peer && (!this._ownOk(q.get('tid'), q.get('device')) || PEER_NOT.some((k) => q.has(k)) || !/^\d{1,16}$/.test(q.get('bytes') || '')))) {
        req.resume(); return this._json(res, 403, { ok: false, error: 'not allowed' });
      }
      this._own(q.get('tid'), q.get('device'));
      return this._handleBundle(req, res, q);
    }
    // protocol 7: how far a resumable transfer got; a speed test; which files this PC has already
    if (req.method === 'GET' && u.pathname === '/api/status') {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._transferStatus(res, q);
    }
    if (u.pathname === '/api/speed' && (req.method === 'GET' || req.method === 'POST')) {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) { req.resume(); return this._json(res, 403, { ok: false, error: 'not paired' }); }
      return this._speed(req, res, q);
    }
    // a resumable transfer the phone canceled while away from the page (its card goes, what arrived is dropped)
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      req.resume();
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) return this._json(res, 403, { ok: false, error: 'not paired' });
      const tid = String(q.get('tid') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
      const owner = this.ownerOf(tid);
      if (!tid || (owner && owner !== q.get('device'))) return this._json(res, 404, { ok: false, error: 'gone' });
      this.emit('cancel', { tid });
      this.abortUpload(tid);
      return this._json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/have') {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) { req.resume(); return this._json(res, 403, { ok: false, error: 'not paired' }); }
      if (!ours()) { req.resume(); return this._json(res, 403, { ok: false, error: 'not allowed' }); }
      return this._have(req, res, q);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/file/')) {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) return this._json(res, 403, { ok: false, error: 'not paired' });
      let fid;
      try { fid = decodeURIComponent(u.pathname.slice('/api/file/'.length)); } catch (e) { return this._json(res, 404, { ok: false }); }   // (not one)
      return this._handleDownload(req, res, fid);
    }
    if (req.method === 'GET' && u.pathname === '/api/app.apk') {
      if (!this._trustedReq(req, q.get('device'), q.get('token')) || peer) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleAppDownload(req, res);
    }
    this._json(res, 404, { ok: false });
  }

  // the phone app update; the phone checks size + SHA-256 (and Android checks the signature) before installing
  _handleAppDownload(req, res) {
    const a = this.phoneApp;
    if (!a) return this._json(res, 404, { ok: false, error: 'no update' });
    fs.stat(a.path, (err, st) => {
      if (res.destroyed) return;                      // the phone went meanwhile: nothing is opened for it
      if (err || !st.isFile()) return this._json(res, 404, { ok: false, error: 'missing' });
      if (st.size !== a.size) return this._json(res, 409, { ok: false, error: 'changed' });
      this._cors(res);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'X-Flick-Version': String(a.code),
      });
      const rs = fs.createReadStream(a.path, { highWaterMark: req.socket && req.socket.remoteFamily === 'bluetooth' ? 64 * 1024 : 256 * 1024 });
      rs.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
      // a phone that goes partway: the file is closed (piping stops at its end, but leaves what it read from open)
      res.on('close', () => rs.destroy());
      this._watchDownload(res, rs);
      rs.pipe(res);
      this.emit('app-download', { code: a.code, size: st.size });
    });
  }

  // Is there room for `bytes` more (plus a margin) where incoming files land? A phone mustn't fill the disk.
  // dir: where they land when that isn't the staging folder (a synced file is written in its own folder: sync.js).
  // There the margin is small (the user's own folder, maybe a small drive nearly full: its files still sync), and
  // the drive is asked at most every few seconds, not for each file of a sync (it may be a slow network share).
  _roomFor(bytes, dir) {
    try {
      if (!dir) { const st = fs.statfsSync(this.tmpDir); return st.bavail * st.bsize >= (+bytes || 0) + 256 * 1024 * 1024; }
      const now = mono();
      let c = this.roomAt;
      if (!c || c.dir !== dir || now - c.at >= 3000) { const st = fs.statfsSync(dir); c = this.roomAt = { dir, at: now, free: st.bavail * st.bsize }; }
      if (c.free < (+bytes || 0) + 16 * 1024 * 1024) return false;
      c.free -= +bytes || 0;                          // (what's taken until it's asked again: files of a sync come fast)
      return true;
    } catch (e) { return true; }                      // can't tell: don't block transfers over it
  }

  // Another Flick device is told over its link too: it's still writing when this answer comes, and would only see the
  // connection end (and say it couldn't reach this PC) instead of "not enough space"
  _noRoom(q, tid) {
    const device = q.get('device');
    if (this._isPeer(device)) this.pushToPhone({ t: 'failed', tid, why: 'space' }, device);
  }

  // Ends a request that was replaced or aborted, connection and all. Destroying the request alone leaves the
  // connection open when its whole body had already arrived, and the phone would wait for an answer that never comes.
  // (its connection first: a request ended this way says nothing more, not even a 500 from its own error handling)
  _cut(req) {
    try { if (req.socket && !req.socket.destroyed) req.socket.destroy(); } catch (e) { /* ignore */ }
    try { req.destroy(); } catch (e) { /* ignore */ }
  }

  // A new attempt for a transfer the phone is retrying replaces the earlier one, which may still be running or
  // failing: each attempt writes its own file, and a replaced attempt never reports anything.
  _claim(tid, entry) {
    const old = this.uploads.get(tid);
    if (old && old !== entry) { old.superseded = true; this._cut(old.req); }
    const asm = this.assemblies.get(tid);
    if (asm) this._dropAssembly(asm, true);
    const ba = this.bundleAsm.get(tid);
    if (ba) this._dropBundleAsm(ba, true);
    this.uploads.set(tid, entry);
  }

  // why: the PC's user turned it down (declined | timeout, "Ask each time"): its phone's send says so, not "canceled".
  // canceled: the PC's user canceled it while it came (Transfers): its phone says Canceled on the PC (one from before
  // goes by why: declined)
  _remember(tid, att, what, long, why, canceled) {
    const now = Date.now();
    for (const [k, v] of this.partsSeen) if (v.until < now) this.partsSeen.delete(k);
    // a resumable transfer's phone may ask about it hours later (it was away): it must still hear "done"
    this.partsSeen.set(tid + ':' + att, { what, until: now + (long ? RESUME_KEEP_MS : 5 * 60000), why: why === 'declined' || why === 'timeout' ? why : undefined, canceled: canceled === true || undefined });
  }
  _quietEnd(a) { if (a.quiet && a.listed) this.emit('quiet-end', { tid: a.tid, device: a.device, ok: false, why: 'failed' }); }
  _aborted(why, canceled) {
    const o = why ? { ok: false, error: 'aborted', why } : { ok: false, error: 'aborted' };
    if (canceled === true) o.canceled = true;
    return o;
  }

  // a parallel upload with no part arriving for a minute was given up by the phone: free its file and say so (one
  // that has every part and waits for the phone's checksum gets ten minutes; one being checked is left alone)
  _sweepAssemblies() {
    const now = mono();
    if (this.downloads) {
      const t = mono();
      for (const [res, w] of [...this.downloads]) if (t - w.last > DL_STALL_MS) { this.downloads.delete(res); try { res.destroy(); } catch (e) { /* gone */ } }
    }
    // any other body that stopped coming (a file sent quietly, a synced file, a bundle in one go): closed, so what it was
    // sending fails (its partial file goes) instead of arriving for ever
    for (const [r, w] of [...this.bodies]) {
      if (r.complete || r.destroyed) this.bodies.delete(r);
      else if (!r.isPaused() && now - w.last > BODY_IDLE_MS) {
        this.bodies.delete(r);
        // (said with where it was going when that's a route of Flick's: any other path is whatever its sender made up)
        const p = String(r.url || '').split('?')[0], a = (r.socket && r.socket.remoteAddress) || '?';
        this._logLimited('body', a, 'nothing more came for ' + (/^\/api\/[a-z]+(\/[a-z]+)?$/.test(p) ? p : 'a request') + ' from ' + a + ': closed', 'nothing more came for a request');
        this._cut(r);
      }
    }
    // a request that stopped delivering (its phone vanished without closing the connection, which a receiving PC can't
    // otherwise tell) is closed after 20 s, so the transfer counts as paused and can continue on a new connection.
    // One that this PC paused itself (waiting for its disk) isn't stalled.
    for (const a of [...this.assemblies.values(), ...this.bundleAsm.values()]) {
      if (!a.live) continue;
      for (const [r, st] of a.live) if (!r.isPaused() && now - st.last > 20000) { a.live.delete(r); this._cut(r); }
    }
    for (const a of [...this.assemblies.values()]) {
      const keep = a.resumable ? RESUME_KEEP_MS : (a.complete ? 10 * 60000 : 60000);
      if (a.reqs.size === 0 && !a.check && now - a.active > keep) { this._dropAssembly(a, false); this.emit('upload-failed', { tid: a.tid, why: 'abandoned' }); this._quietEnd(a); }
      else this._pausedCheck(a, now);
    }
    for (const b of [...this.bundleAsm.values()]) {
      if (b.reqs.size === 0 && now - b.active > (b.resumable ? RESUME_KEEP_MS : 60000)) { this._dropBundleAsm(b, false); this.emit('upload-failed', { tid: b.tid, why: 'abandoned' }); }
      else this._pausedCheck(b, now);
    }
  }
  // a resumable transfer with nothing arriving for a while is paused (the phone left or its app was closed): say so
  // once, so the PC stops showing it as arriving; 'upload-resumed' when it carries on
  _pausedCheck(a, now) {
    if (!a.resumable || a.paused || a.reqs.size || a.check || now - a.active < 8000) return;
    a.paused = true;
    this.emit('upload-paused', { tid: a.tid });
  }
  _resumedCheck(a) {
    if (!a.paused) return;
    a.paused = false;
    this.emit('upload-resumed', { tid: a.tid });
  }
  /** A resumable transfer is waiting for its phone to come back (nothing is wrong with it). */
  uploadPaused(tid) {
    const a = this.assemblies.get(tid) || this.bundleAsm.get(tid);
    return !!(a && a.resumable && !a.finished && a.reqs.size === 0 && !a.check);
  }
  /** A transfer's file is being read back and checked: nothing arrives meanwhile, yet it's alive. */
  uploadChecking(tid) {
    const a = this.assemblies.get(tid);
    return !!(a && a.check && !a.finished);
  }
  /** Bytes are arriving right now (files sent quietly too), or a file is being checked: not a moment to restart. */
  receiving() {
    if (this.uploads.size) return true;
    const all = [...this.assemblies.values(), ...this.bundleAsm.values()];
    return all.some((a) => !a.finished && (a.reqs.size > 0 || !!a.check));
  }
  _sweepSoon() { if (!this.sweepT) { this.sweepT = setInterval(() => this._sweepAssemblies(), 5000); if (this.sweepT.unref) this.sweepT.unref(); } }
  // A body coming in is watched until it's all here: one with nothing more for BODY_IDLE_MS is closed by the sweep. The
  // watch reads along only once its handler reads (a listener of its own before that would let the body flow unread).
  _watchBody(req) {
    if (req.complete || this.bodies.has(req)) return;
    const w = { last: mono() };
    const touch = () => { w.last = mono(); };
    this.bodies.set(req, w);
    if (req.readableFlowing) req.on('data', touch); else req.once('resume', () => req.on('data', touch));
    // (also once its connection is gone: a request answered before its body came, by a sender that then left, never
    // ends nor closes, and was kept here for the whole minute, a few KB each, as fast as anything could send them)
    const sock = req.socket;
    const off = () => { this.bodies.delete(req); if (sock) sock.removeListener('close', off); };
    req.once('end', off);
    req.once('close', off);
    if (sock) sock.once('close', off);
    this._sweepSoon();
  }
  // A file going out is watched until its connection closes: the file is read only as fast as the phone takes it, so
  // nothing read for DL_STALL_MS means the phone took nothing. The sweep closes it then. (Not the socket's own idle
  // timer: a stream relayed from a Bluetooth link has none that fires, mux.js.)
  _watchDownload(res, rs) {
    if (!this.downloads) this.downloads = new Map();
    const w = { last: mono() };
    this.downloads.set(res, w);
    rs.on('data', () => { w.last = mono(); });
    res.once('close', () => this.downloads.delete(res));
    this._sweepSoon();
  }
  _release(tid, entry) { if (this.uploads.get(tid) === entry) this.uploads.delete(tid); }

  _handleUpload(req, res, q) {
    const tid = (q.get('tid') || rid(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || rid(6);
    const name = q.get('name') || 'file';
    // quiet=1 (protocol 5): sent without the fling gesture (auto-send, tile, widget). No card flies in; it's saved
    // like any received file once it's all here (phoneapi.js quietDone), and only then answered.
    const quiet = q.get('quiet') === '1';
    const note = (ev, x) => { if (!quiet) this.emit(ev, x); };
    // a quiet one is listed in Transfers on its own (a Browse phone copy, kind=pull, is listed as its copy)
    const listed = quiet && q.get('kind') !== 'pull';
    const qnote = (ev, x) => { if (listed) this.emit(ev, Object.assign({ tid, device: q.get('device') || '' }, x)); };
    // the request's own length is exact; the phone's size hint can be stale (media index)
    const clen = parseInt(req.headers['content-length'] || '', 10);
    const total = clen >= 0 ? clen : (parseInt(q.get('size') || '0', 10) || 0);
    if (!this._roomFor(total)) { this._noRoom(q, tid); req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    const tmpPath = path.join(this.tmpDir, tid + '-' + rid(4) + '.part');
    const entry = { req, path: tmpPath, superseded: false, device: q.get('device') || '', received: 0, total };
    this._claim(tid, entry);
    this._stageDir();
    const out = fs.createWriteStream(tmpPath, { highWaterMark: 1024 * 1024, mode: STAGE_FILE });
    let received = 0;
    let lastEmit = 0;
    let finished = false, ended = false;
    const t0 = mono();
    note('upload-start', { tid, name, total });
    qnote('quiet-start', { name, total });

    const removeTmp = () => { if (out.closed) fs.unlink(tmpPath, () => {}); else out.once('close', () => fs.unlink(tmpPath, () => {})); };
    const fail = (why, code) => {
      if (finished) return;
      finished = true;
      this._release(tid, entry);
      req.removeListener('data', onData);
      out.destroy();
      removeTmp();
      if (!entry.superseded) { note('upload-failed', { tid, why }); qnote('quiet-end', { ok: false, why }); }
      if (!res.headersSent) { try { this._json(res, code || (why === 'short' ? 400 : 500), { ok: false, error: code === 507 ? 'no space' : why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const peerDev = this._isPeer(q.get('device')) ? q.get('device') : null, told = { at: 0 };
    const onData = (chunk) => {
      if (finished) return;
      received += chunk.length;
      entry.received = received;
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!finished) req.resume(); }); }
      const now = mono();
      if (now - lastEmit > 40) { lastEmit = now; note('upload-progress', { tid, received, total }); qnote('quiet-progress', { received, total }); }
      if (peerDev) this._recvTell(peerDev, tid, received, told);
    };
    out.on('error', (e) => { if (diskFull(e)) this._noRoom(q, tid); fail('disk ' + (e.code || e.message), diskFull(e) ? 507 : 500); });
    req.on('data', onData);
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    // cut short in any other way (a replaced attempt's connection is closed): the file goes either way
    req.on('close', () => { if (!ended) fail('closed'); });
    req.on('end', () => {
      ended = true;
      if (finished) return;
      if (total && received < total) return fail('short');
      out.end((werr) => {
        if (finished) return;
        // (what was still to be written didn't make it to the disk: the file isn't whole, and isn't said to be)
        if (werr) { if (diskFull(werr)) this._noRoom(q, tid); return fail('disk ' + (werr.code || werr.message), diskFull(werr) ? 507 : 500); }
        finished = true;
        this._release(tid, entry);
        if (entry.superseded) {
          removeTmp();
          if (!res.headersSent && !res.destroyed) { try { this._json(res, 409, { ok: false, error: 'replaced' }); } catch (e) { /* ignore */ } }
          return;
        }
        if (quiet) {
          qnote('quiet-progress', { received, total: total || received });
          return this.api.quietDone(res, { tid, tmpPath, name, size: received, kind: q.get('kind'), device: q.get('device') })
            .then((r) => qnote('quiet-end', r || { ok: false, why: 'failed' }), () => qnote('quiet-end', { ok: false, why: 'failed' }));
        }
        this.emit('upload-progress', { tid, received, total: total || received });
        this.emit('upload-done', { tid, tmpPath, name, size: received, ms: Math.round(mono() - t0) });
        this._gotAll(q.get('device'), tid);
        this._json(res, 200, { ok: true, tid });
      });
    });
  }

  // A bundle striped over several connections (streams=K, stream=i): each stream is an ordinary bundle body carrying
  // some of the files; all of them write into one staging folder, and the transfer is done when every stream is.
  // A stream sent again (same "att") starts over and rewrites the files it had written; a new attempt replaces all.
  // resume=1 (protocol 7, also with a single stream): a stream cut off keeps the entries it delivered, and is sent
  // again from its skip-th entry, the first "from" bytes of that one (a file) being here already (see /api/status).
  // Entries are numbered by the phone ("i" in each entry), so one it leaves out (a file it couldn't read) shifts nothing.
  _handleBundleStream(req, res, q) {
    const clean = (v, n) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
    const tid = clean(q.get('tid'), 40) || rid(6);
    const att = clean(q.get('att'), 20) || 'a';
    const resume = q.get('resume') === '1';
    const K = parseInt(q.get('streams') || '1', 10), si = parseInt(q.get('stream') || '0', 10);
    const skip = resume ? Number(q.get('skip') || 0) : 0, from = resume ? Number(q.get('from') || 0) : 0;
    if (!(K >= (resume ? 1 : 2) && K <= 8 && si >= 0 && si < K && Number.isSafeInteger(skip) && skip >= 0 && Number.isSafeInteger(from) && from >= 0)) {
      req.resume(); return this._json(res, 400, { ok: false, error: 'bad stream' });
    }
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) {
      req.resume();
      return seen.what === 'done' ? this._json(res, 200, { ok: true, stream: si, done: true }) : this._json(res, 410, this._aborted(seen.why, seen.canceled));
    }
    let A = this.bundleAsm.get(tid);
    if (A && (A.att !== att || A.K !== K || !!A.resumable !== resume)) { if (A.att !== att) this._remember(tid, A.att, 'aborted', A.resumable); this._dropBundleAsm(A, true); A = null; }
    // continuing a transfer that isn't here any more (this PC restarted, or it waited too long): it starts over
    if (!A && (skip > 0 || from > 0)) { req.resume(); return this._json(res, 409, { ok: false, error: 'gone' }); }
    if (!A) {
      if (!this._roomFor(+q.get('bytes') || 0)) { req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
      const old = this.uploads.get(tid);
      if (old) { old.superseded = true; this._cut(old.req); }
      const pa = this.assemblies.get(tid);
      if (pa) this._dropAssembly(pa, true);
      const root = path.join(this.tmpDir, 'b-' + tid + '-' + att + '-' + rid(3));
      try { fs.mkdirSync(root, { recursive: true, mode: STAGE_DIR }); } catch (e) { req.resume(); return this._json(res, 500, { ok: false, error: 'staging' }); }
      A = { tid, att, K, root, shared: { taken: new Map(), tops: [], topSet: new Set(), assigned: new Map() }, got: new Array(K).fill(0), done: new Array(K).fill(false),
        reqs: new Set(), manifest: null, total: +q.get('bytes') || 0, finished: false, superseded: false, t0: mono(), lastEmit: 0, active: mono(),
        // resumable: each stream's delivered entries, the file it was writing when cut off, and the request sending it
        resumable: resume, ents: Array.from({ length: K }, () => []), part: new Array(K).fill(null), cur: new Array(K).fill(null),
        live: new Map(), paused: false };
      this.bundleAsm.set(tid, A);
      this.emit('upload-start', { tid, name: 'bundle', total: A.total, streams: K, committed: q.get('committed') === '1', again: q.get('again') === '1' });
    }
    if (A.finished) { req.resume(); return this._json(res, 409, { ok: false, error: 'finished' }); }
    let base = 0, resumeAt = null;
    if (A.resumable) {
      if (A.done[si]) { req.resume(); return this._json(res, 200, { ok: true, stream: si, done: true }); }
      const ents = A.ents[si], part = A.part[si];
      const next = ents.length ? ents[ents.length - 1].i + 1 : 0;
      // where this stream continues: where what arrived ends (the file it was writing, else the next entry), or at an
      // earlier entry (written again)
      const done = ents.find((e) => e.i === skip);
      const ok = skip <= (part ? part.i : next) &&
        (from === 0 || (part && part.i === skip && from <= part.written) || (done && !done.dir && from <= done.size));
      if (!ok) { req.resume(); return this._json(res, 409, Object.assign({ ok: false, error: 'behind' }, this._streamAt(A, si))); }
      if (from > 0) resumeAt = { p: part && part.i === skip ? part.p : done.p, from };
      const prev = A.cur[si];
      if (prev && prev !== req) { A.reqs.delete(prev); A.live.delete(prev); this._cut(prev); }
      A.cur[si] = req;
      A.ents[si] = ents.filter((e) => e.i < skip);
      A.part[si] = null;
      for (const e of A.ents[si]) base += e.size;
      base += from;
      this._resumedCheck(A);
    }
    A.reqs.add(req); A.active = mono();
    A.live.set(req, { last: mono() });
    this._sweepSoon();
    A.got[si] = base; A.done[si] = false;
    const mine = () => !A.resumable || A.cur[si] === req;
    const live = A.live.get(req);
    let over = false;
    const progress = () => {
      const now = mono();
      if (now - A.lastEmit < 40) return;
      A.lastEmit = now;
      this.emit('upload-progress', { tid, received: A.got.reduce((x, y) => x + y, 0), total: A.total });
    };
    const rx = new BundleReceiver(A.root, {
      onManifest: (m) => {
        if (A.manifest) return;
        A.manifest = m; A.total = +m.bytes || A.total;
        this.emit('bundle-manifest', { tid, files: +m.files || 0, bytes: +m.bytes || 0, roots: Array.isArray(m.roots) ? m.roots.slice(0, 500).map(String) : [], count: Array.isArray(m.roots) ? m.roots.length : 0 });
      },
      onProgress: (got) => {
        if (!mine()) return;
        A.got[si] = base + got; A.active = mono(); live.last = A.active;
        if (A.part[si] && rx.cur) A.part[si].written = rx.cur.written;
        progress();
      },
      onFile: (e) => { if (mine() && A.resumable) A.part[si] = { i: e.i, p: e.p, size: e.size, written: e.from }; },
      onEntry: (e) => { if (mine() && A.resumable) { A.ents[si].push({ i: e.i, p: e.p, size: e.size, dir: e.dir }); A.part[si] = null; } },
    }, A.shared, { first: skip, resume: resumeAt });
    const fail = (why, code) => {
      if (over) return;
      over = true;
      A.reqs.delete(req); A.live.delete(req); A.active = mono();
      // resumable: what arrived stays and counts; otherwise the stream starts over
      if (mine()) { if (A.resumable) { A.cur[si] = null; A.got[si] = A.ents[si].reduce((x, e) => x + e.size, 0) + (A.part[si] ? A.part[si].written : 0); } else A.got[si] = 0; }
      Promise.resolve().then(() => rx.abort()).catch(() => {});
      if (!res.headersSent) { try { this._json(res, code || 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const complete = () => {
      if (over) return;
      if (!rx.done) return fail('short', 400);
      over = true;
      A.reqs.delete(req); A.live.delete(req);
      if (A.resumable) { if (!mine()) return; A.cur[si] = null; }
      A.done[si] = true;
      this._json(res, 200, { ok: true, stream: si });
      if (A.finished || A.superseded || !A.done.every(Boolean)) return progress();
      A.finished = true;
      this.bundleAsm.delete(tid);
      this._remember(tid, att, 'done', A.resumable);
      // the items in the order the phone listed them, whichever stream carried them (looked up in a map: a search of
      // the list for each comparison froze the PC for seconds with thousands of picked files)
      const rank = new Map();
      if (A.manifest && Array.isArray(A.manifest.roots)) A.manifest.roots.forEach((x, i) => { x = String(x); if (!rank.has(x)) rank.set(x, i); });
      const order = (x) => (rank.has(x) ? rank.get(x) : 1e9);
      const tops = A.shared.tops.slice().sort((a, b) => order(a) - order(b));
      const received = A.got.reduce((x, y) => x + y, 0);
      this.emit('upload-progress', { tid, received, total: A.total || received });
      this.emit('upload-done', { tid, tmpPath: A.root, name: tops.length === 1 ? tops[0] : tops.length + ' items', size: received, ms: Math.round(mono() - A.t0), streams: K,
        bundle: { tops, files: +(A.manifest && A.manifest.files) || 0, bytes: received } });
    };
    // What comes in while the disk is busy is written in one go (up to 1 MB at a time): the TLS link hands over 16 KB
    // at a time, and a disk write (and a pause and resume of the connection) for each was the PC's limit with many files.
    // The connection is paused only when the disk falls well behind.
    const queue = [];
    let queued = 0, busy = false, ended = false;
    const pump = async () => {
      busy = true;
      try {
        while (queue.length && !over && !A.superseded) {
          let chunk = queue.shift();
          if (queue.length && chunk.length < 1 << 20) {
            const parts = [chunk];
            let n = chunk.length;
            while (queue.length && n + queue[0].length <= 1 << 20) { n += queue[0].length; parts.push(queue.shift()); }
            if (parts.length > 1) chunk = Buffer.concat(parts, n);
          }
          queued -= chunk.length;
          await rx.push(chunk);
          A.nospace = 0;
          if (req.isPaused() && queued < 2 << 20 && !ended) req.resume();
        }
      } catch (e) {
        busy = false;
        // the drive is full: 507, the phone stops and says so (and /api/status says so too while it stays full); the
        // disk otherwise (a file held by another program): 500, and the phone carries on from where it got; a body that
        // isn't a proper bundle: 400, and it starts over
        if (diskFull(e)) { A.nospace = Date.now(); return fail('no space', 507); }
        return fail(e.message || 'bad bundle', e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code) ? 500 : 400);
      }
      busy = false;
      if (over || A.superseded) return;
      if (ended) return complete();
    };
    req.on('data', (chunk) => {
      if (over || A.superseded) return;
      queue.push(chunk);
      queued += chunk.length;
      if (queued > 8 << 20) req.pause();
      if (!busy) pump();
    });
    req.on('end', () => { ended = true; if (!busy) complete(); });
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    // cut short in any other way (a replaced attempt destroys its requests): the open file is closed either way
    req.on('close', () => { if (!ended) fail('closed'); });
  }

  _dropBundleAsm(A, superseded) {
    A.superseded = !!superseded; A.finished = true;
    if (this.bundleAsm.get(A.tid) === A) this.bundleAsm.delete(A.tid);
    for (const r of A.reqs) this._cut(r);
    A.reqs.clear();
    setTimeout(() => fs.rm(A.root, { recursive: true, force: true, maxRetries: 3 }, () => {}), 50);
  }

  // many files and folders in one streamed request (see bundle.js); staged in a folder of their own
  _handleBundle(req, res, q) {
    if (q.get('resume') === '1' || (q.get('streams') && q.get('streams') !== '1')) return this._handleBundleStream(req, res, q);
    const tid = (q.get('tid') || rid(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || rid(6);
    const root = path.join(this.tmpDir, 'b-' + tid + '-' + rid(4));
    let finished = false;
    const entry = { req, path: root, superseded: false };
    this._claim(tid, entry);
    try { fs.mkdirSync(root, { recursive: true, mode: STAGE_DIR }); }
    catch (e) { this._release(tid, entry); return this._json(res, 500, { ok: false, error: 'staging' }); }
    const t0 = mono();
    let lastEmit = 0;
    // another device's bundle holds what it said it would: past that, it stops (the room for it was checked for that much)
    const limit = this._isPeer(q.get('device')) ? +q.get('bytes') : -1;
    const peerDev = limit >= 0 ? q.get('device') : null, told = { at: 0 };
    const rx = new BundleReceiver(root, {
      onManifest: (m) => this.emit('bundle-manifest', { tid, files: +m.files || 0, bytes: +m.bytes || 0, roots: Array.isArray(m.roots) ? m.roots.slice(0, 500).map(String) : [], count: Array.isArray(m.roots) ? m.roots.length : 0 }),
      onFile: (e) => { if (limit >= 0 && rx.received + e.size - e.from > limit) throw new Error('more than it said'); },
      onProgress: (got, total) => {
        if (limit >= 0 && got > limit) throw new Error('more than it said');
        const now = mono(); if (now - lastEmit > 40) { lastEmit = now; this.emit('upload-progress', { tid, received: got, total }); }
        if (peerDev) this._recvTell(peerDev, tid, got, told);
      },
    });
    if (!this._roomFor(+q.get('bytes') || 0)) { this._noRoom(q, tid); this._release(tid, entry); fs.rm(root, { recursive: true, force: true }, () => {}); req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    this.emit('upload-start', { tid, name: 'bundle', total: +q.get('bytes') || 0 });

    const fail = (why, code) => {
      if (finished) return;
      finished = true;
      this._release(tid, entry);
      Promise.resolve().then(() => rx.abort()).catch(() => {}).finally(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }, () => {}));
      if (code && !res.headersSent) { try { this._json(res, code, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
      if (!entry.superseded) this.emit('upload-failed', { tid, why });
    };

    // one chunk at a time: the socket is paused while the previous chunk is written to disk
    const queue = [];
    let busy = false, ended = false;
    const pump = async () => {
      busy = true;
      try {
        while (queue.length && !finished) await rx.push(queue.shift());
      } catch (e) { if (diskFull(e)) { this._noRoom(q, tid); fail('no space', 507); } else fail(e.message || 'bad bundle', 400); return; }
      busy = false;
      if (finished) return;
      if (ended) return complete();
      req.resume();
    };
    const complete = () => {
      if (finished) return;
      if (!rx.done) return fail('short', 400);
      finished = true;
      this._release(tid, entry);
      if (entry.superseded) { fs.rm(root, { recursive: true, force: true }, () => {}); return; }
      this.emit('upload-progress', { tid, received: rx.received, total: rx.total || rx.received });
      this.emit('upload-done', { tid, tmpPath: root, name: rx.tops.length === 1 ? rx.tops[0] : rx.tops.length + ' items', size: rx.received, ms: Math.round(mono() - t0), bundle: { tops: rx.tops.slice(), files: +(rx.manifest && rx.manifest.files) || 0, bytes: rx.received } });
      this._gotAll(q.get('device'), tid);
      this._json(res, 200, { ok: true, tid });
    };
    req.on('data', (chunk) => { if (finished) return; queue.push(chunk); if (!busy) { req.pause(); pump(); } });
    req.on('end', () => { ended = true; if (!busy) complete(); });
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    req.on('close', () => { if (!ended) fail('closed'); });
  }

  // One large file sent as several parts at once, each over its own connection (Wi-Fi moves more data that way),
  // written straight into place. A part that fails is sent again by the phone; a new attempt ("att") of the same
  // transfer replaces the old one. With verify=1 the transfer is done only once the phone's checksum of the whole file
  // matches the assembled file (commit=1, see _commitParts).
  // resume=1 (protocol 7): what arrived is kept when a part is cut off, for hours (the phone's app was closed, its Wi-Fi
  // dropped), and a part sent again continues from "from" (its bytes already here, see /api/status) instead of
  // starting over. Each part always covers the same bytes: offset is where it starts, from + body length its length.
  _handlePart(req, res, q) {
    const clean = (v, n) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
    const tid = clean(q.get('tid'), 40) || rid(6);
    const att = clean(q.get('att'), 20) || 'a';
    if (q.get('commit') === '1') return this._commitParts(req, res, q, tid, att);
    const index = parseInt(q.get('index'), 10), parts = parseInt(q.get('parts'), 10);
    const offset = Number(q.get('offset')), total = Number(q.get('total'));
    const len = parseInt(req.headers['content-length'] || '', 10);
    const resume = q.get('resume') === '1';
    const from = resume ? Number(q.get('from') || 0) : 0;
    // quiet=1&kind=… (a phone's auto-send): the file comes in resumable, checked parts like any other, but no card flies
    // in: it's listed as arriving quietly, and once its commit checks out it's saved like any file sent quietly
    // (phoneapi quietOutcome), whose outcome the commit answers (a declined one: 410 why=declined)
    const quiet = q.get('quiet') === '1';
    if (quiet && (!resume || q.get('verify') !== '1')) { req.resume(); return this._json(res, 400, { ok: false, error: 'bad part' }); }
    if (!(parts >= 1 && parts <= 16 && index >= 0 && index < parts && Number.isSafeInteger(offset) && Number.isSafeInteger(total) &&
      Number.isSafeInteger(from) && from >= 0 && offset >= 0 && total >= 0 && len >= 0 && offset + from + len <= total)) {
      req.resume();
      return this._json(res, 400, { ok: false, error: 'bad part' });
    }
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) {
      req.resume();
      // already complete (its 200 got lost, say): the part is in. Aborted: stop sending.
      return seen.what === 'done' ? this._json(res, 200, { ok: true, index, done: true }) : this._json(res, 410, this._aborted(seen.why, seen.canceled));
    }
    let asm = this.assemblies.get(tid);
    if (asm && (asm.att !== att || asm.total !== total || asm.parts !== parts)) {
      // a new attempt replaces this one; parts of the old attempt that still turn up are turned away, not let back in
      if (asm.att !== att) this._remember(tid, asm.att, 'aborted');
      this._dropAssembly(asm, true); asm = null;
    }
    // continuing a transfer that isn't here any more (this PC restarted, or it waited too long): it starts over
    if (!asm && from > 0) { req.resume(); return this._json(res, 409, { ok: false, error: 'gone' }); }
    if (!asm && !this._roomFor(total)) { req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    if (!asm) {
      const old = this.uploads.get(tid);
      if (old) { old.superseded = true; this._cut(old.req); }
      const p = path.join(this.tmpDir, tid + '-' + att + '-' + rid(3) + '.part');
      asm = { tid, att, total, parts, path: p, name: q.get('name') || 'file', got: new Array(parts).fill(0), done: new Array(parts).fill(false),
        reqs: new Set(), finished: false, superseded: false, t0: mono(), lastEmit: 0, active: mono(),
        verify: q.get('verify') === '1', complete: false, check: null,
        // resumable: where each part starts and how long it is, how much of it is on disk, and the request writing it
        resumable: resume, start: new Array(parts).fill(-1), plen: new Array(parts).fill(-1), saved: new Array(parts).fill(0),
        cur: new Array(parts).fill(null), live: new Map(), paused: false,
        // each part's SHA-256, worked out as its bytes are written (in order, from its start): the check at the end
        // then reads back only parts that arrived out of order (sent again from an earlier point)
        ph: Array.from({ length: parts }, () => ({ h: crypto.createHash('sha256'), at: 0 })),
        // (a Browse phone copy, kind=pull, is listed as its copy, as in _handleUpload)
        quiet: quiet ? String(q.get('kind') || 'share').slice(0, 20) : null, listed: quiet && q.get('kind') !== 'pull', device: q.get('device') || '' };
      // pre-size the file; if that fails (disk full) close it again rather than leaking the handle. Opened for
      // reading too: a checked transfer reads the assembled file back (_checkAssembly)
      this._openStage(asm);
      this.assemblies.set(tid, asm);
      // committed=1: the user already sent it (a transfer starting over after this PC restarted: no drop will come)
      if (asm.quiet) { if (asm.listed) this.emit('quiet-start', { tid, device: asm.device, name: asm.name, total }); }
      else this.emit('upload-start', { tid, name: asm.name, total, parts, committed: q.get('committed') === '1', again: q.get('again') === '1' });
    }
    if (asm.finished) { req.resume(); return this._json(res, 409, { ok: false, error: 'finished' }); }
    // its file couldn't be made when its first part came (nothing of it is on disk): tried again for this part, not
    // failed for every part the phone sends from then on, whatever became of what was in the way
    if (asm.fdBad) this._openStage(asm);
    const A = asm;
    if (A.check) { req.resume(); return this._json(res, 409, { ok: false, error: 'checking' }); }
    if (A.resumable) {
      if (A.start[index] < 0) { A.start[index] = offset; A.plen[index] = from + len; }
      else if (A.start[index] !== offset || A.plen[index] !== from + len) { req.resume(); return this._json(res, 400, { ok: false, error: 'bad part' }); }
      // in already (its answer got lost): nothing to send
      if (A.done[index]) { req.resume(); return this._json(res, 200, { ok: true, index, done: true }); }
      // a gap would be left between what's on disk and where this one starts
      if (from > A.saved[index]) { req.resume(); return this._json(res, 409, { ok: false, error: 'behind', saved: A.saved[index] }); }
      // the same part's earlier request may still look open (its phone vanished mid-send): this one takes over
      const prev = A.cur[index];
      if (prev && prev !== req) { A.reqs.delete(prev); A.live.delete(prev); this._cut(prev); }
      A.cur[index] = req;
      A.saved[index] = from;                       // anything past it is written again (with the same bytes)
      // the part's running checksum goes on only from where it stands (or starts over from the start)
      const ph = A.ph[index];
      if (from === 0) { ph.h = crypto.createHash('sha256'); ph.at = 0; }
      else if (ph.h && ph.at !== from) ph.h = null;
      this._resumedCheck(A);
    } else {
      A.done[index] = false;                       // a part sent again starts over
    }
    A.reqs.add(req); A.active = mono();
    A.live.set(req, { last: mono() });
    this._sweepSoon();
    A.got[index] = from;
    A.complete = false;
    let pos = offset + from, got = 0, queued = 0, writing = false, ended = false, over = false;
    const queue = [];
    const progress = () => {
      const now = mono();
      if (now - A.lastEmit < 40) return;
      A.lastEmit = now;
      this._partsProgress(A, A.got.reduce((s, x) => s + x, 0));
    };
    const mine = () => !A.resumable || A.cur[index] === req;
    // a resumable part cut off: what had already arrived is still written (it counts for where the part carries on),
    // unless a newer request for the part takes over meanwhile; then the part is let go
    let draining = false;
    const letGo = () => { draining = false; if (A.cur[index] === req) { A.cur[index] = null; A.got[index] = A.saved[index]; } };
    const partFail = (why, code) => {
      if (over) return;
      over = true;
      A.reqs.delete(req); A.live.delete(req); A.active = mono();
      // resumable: what's on disk stays and counts; otherwise the part starts over
      if (A.resumable && mine() && queue.length && !A.superseded) { draining = true; if (!writing) pump(); }
      else if (mine()) { A.got[index] = A.resumable ? A.saved[index] : 0; if (A.resumable) A.cur[index] = null; }
      if (!res.headersSent) { try { this._json(res, code || 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const partDone = async () => {
      if (over) return;
      if (got !== len) return partFail('short');
      over = true;
      A.reqs.delete(req); A.live.delete(req);
      if (A.resumable) { if (!mine()) return; A.cur[index] = null; A.saved[index] = A.plen[index]; }
      A.done[index] = true;
      this._json(res, 200, { ok: true, index });
      if (A.finished || A.superseded || !A.done.every(Boolean)) return progress();
      if (A.verify) {
        // every part is in: the phone's checksum of the whole file comes next (commit), and decides
        A.complete = true; A.active = mono();
        this._partsProgress(A, total);
        return;
      }
      A.finished = true;
      this.assemblies.delete(tid);
      // done only once the file is safely closed: a phone asking again then hears "done" only for a file that's here
      try { await (await A.fdP).close(); } catch (e) { fs.unlink(A.path, () => {}); this.emit('upload-failed', { tid, why: 'disk' }); return; }
      this._remember(tid, A.att, 'done', A.resumable);
      this.emit('upload-progress', { tid, received: total, total });
      this.emit('upload-done', { tid, tmpPath: A.path, name: A.name, size: total, ms: Math.round(mono() - A.t0), parts });
    };
    const pump = async () => {
      writing = true;
      try {
        const fd = await A.fdP;
        while (queue.length && (!over || draining) && !A.superseded) {
          if (draining && A.cur[index] !== req) break;     // a newer request for this part took over
          // write what has arrived in one go (fewer, larger writes)
          let n = 0, k = 0;
          while (k < queue.length && n < 4 * 1024 * 1024) n += queue[k++].length;
          // one writev for everything that has arrived: no copy into a joined buffer
          let bufs = queue.splice(0, k);
          const wrote = A.resumable ? bufs.slice() : null;
          const at = pos - offset;                 // where in the part these bytes go
          queued -= n;
          let left = n;
          while (left > 0) {
            const r = await fd.writev(bufs, pos);
            pos += r.bytesWritten; left -= r.bytesWritten;
            if (left > 0) { let skip = r.bytesWritten; while (skip >= bufs[0].length) { skip -= bufs[0].length; bufs.shift(); } if (skip) bufs[0] = bufs[0].subarray(skip); }
          }
          // on disk now: a resumed part can continue from here, and its checksum takes the bytes in
          if (A.resumable && A.cur[index] === req) {
            A.saved[index] = pos - A.start[index];
            const ph = A.ph[index];
            if (ph.h && ph.at === at) { for (const b of wrote) ph.h.update(b); ph.at += n; } else ph.h = null;
          }
          A.nospace = 0;
          if (req.isPaused() && queued < 4 * 1024 * 1024) req.resume();
        }
      } catch (e) {
        writing = false;
        // the drive is full: 507 (the phone stops and says so; /api/status says so too while it stays full)
        if (diskFull(e)) A.nospace = Date.now();
        if (draining) return letGo();
        return diskFull(e) ? partFail('no space', 507) : partFail('disk ' + (e.code || e.message));
      }
      writing = false;
      if (draining) return letGo();
      if (A.superseded && !over) return partFail('replaced');
      if (ended && !queue.length) partDone();
    };
    const live = A.live.get(req);
    req.on('data', (chunk) => {
      if (over || A.superseded) return;
      got += chunk.length;
      if (got > len) return partFail('too long');
      A.got[index] = from + got; A.active = mono(); live.last = A.active;
      queue.push(chunk); queued += chunk.length;
      if (queued > 8 * 1024 * 1024) req.pause();
      if (!writing) pump();
      progress();
    });
    req.on('end', () => { ended = true; if (!writing) pump(); });
    req.on('aborted', () => partFail('aborted'));
    req.on('error', () => partFail('error'));
    req.on('close', () => { if (!ended) partFail('closed'); });
  }

  // The staging file of a transfer in parts (asm.fdP: its open file, once it's made and pre-sized). fdBad: it couldn't
  // be made (see _handlePart).
  _openStage(asm) {
    const p = asm.path;
    asm.fdBad = false;
    this._stageDir();
    const fdP = asm.fdP = fs.promises.open(p, 'w+', STAGE_FILE).then(async (fd) => {
      try {
        // Windows: parts written at once, far into an ordinary file, make NTFS fill everything before each part's
        // first write with zeros (most of the file written twice, and a stall at the start): sparse first, it doesn't
        if (asm.parts > 1 && process.platform === 'win32') await markSparse(p);
        if (asm.total) await fd.truncate(asm.total);
      } catch (e) { await fd.close().catch(() => {}); throw e; }
      return fd;
    });
    fdP.catch(() => { if (asm.fdP === fdP) asm.fdBad = true; });
  }

  // The phone's SHA-256 of the whole file (commit=1&sha256=…, no body), sent once every part of a verify=1 transfer
  // is in. The assembled file is read back and hashed: a match makes the transfer done; a mismatch (a part that
  // arrived damaged, say) drops it, the phone is told "checksum" and sends the file again.
  // Protocol 7 (resumable): sums=<sha256 of part 0>,<part 1>,… instead. Each part's checksum was worked out as it
  // arrived, so nothing is read back except parts that arrived out of order.
  _commitParts(req, res, q, tid, att) {
    req.resume();
    const sums = q.get('sums') ? String(q.get('sums')).toLowerCase().split(',') : null;
    const want = sums ? 'parts:' + sums.join(',') : String(q.get('sha256') || '').toLowerCase();
    if (sums ? !sums.every((x) => /^[0-9a-f]{64}$/.test(x)) : !/^[0-9a-f]{64}$/.test(want)) return this._json(res, 400, { ok: false, error: 'bad commit' });
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) {
      // checked already (its answer got lost, say), or dropped
      return seen.what === 'done' ? this._json(res, 200, { ok: true, done: true }) : this._json(res, 410, this._aborted(seen.why, seen.canceled));
    }
    const A = this.assemblies.get(tid);
    if (!A || A.att !== att || !A.verify || A.finished) return this._json(res, 409, { ok: false, error: 'unknown' });
    if (!A.complete || !A.done.every(Boolean) || A.reqs.size) return this._json(res, 409, { ok: false, error: 'incomplete' });
    if (sums && (!A.resumable || sums.length !== A.parts)) return this._json(res, 400, { ok: false, error: 'bad commit' });
    if (A.check && A.want !== want) return this._json(res, 409, { ok: false, error: 'checking' });
    // the outcome is worked out once, however many times the phone asks: a commit sent again while the check runs (the
    // first one's connection broke during a long read-back) used to finish the transfer a second time
    if (!A.check) {
      A.want = want;
      A.check = (sums ? this._checkParts(A, sums) : this._checkAssembly(A, want)).then((why) => this._checked(A, why)).catch(() => [500, { ok: false, error: 'check' }]);
    }
    A.check.then(([code, o]) => { if (!res.headersSent && !res.destroyed) { try { this._json(res, code, o); } catch (e) { /* ignore */ } } });
  }

  // what a commit answers once its check is over ([status, body]); a passed check makes the transfer done
  async _checked(A, why) {
    const { tid, att } = A;
    if (A.dropped) return [410, this._aborted(A.why, A.canceled)];
    if (why) {
      this._remember(tid, att, 'aborted', A.resumable);
      this._dropAssembly(A, true);           // dropped quietly: the phone sends the file again (or gives up and says so)
      this.emit('log', 'upload ' + tid + ' refused: ' + why);
      // 422 for any check that failed (a wrong checksum, a file that can't be read back whole): the phone starts over.
      // (A 500 made it ask again, hear "aborted" and show the send as canceled on the PC.)
      return [422, { ok: false, error: why }];
    }
    if (A.quiet) return this._quietSaved(A);
    A.finished = true;
    this.assemblies.delete(tid);
    // (done only once the file is safely closed; otherwise the phone sends it again)
    try { await (await A.fdP).close(); } catch (e) { fs.unlink(A.path, () => {}); this.emit('upload-failed', { tid, why: 'disk' }); return [500, { ok: false, error: 'disk' }]; }
    this._remember(tid, att, 'done', A.resumable);
    this.emit('upload-progress', { tid, received: A.total, total: A.total });
    this.emit('upload-done', { tid, tmpPath: A.path, name: A.name, size: A.total, ms: Math.round(mono() - A.t0), parts: A.parts });
    return [200, { ok: true, done: true }];
  }

  // progress of a transfer in parts (one sent quietly is listed as such)
  _partsProgress(A, received) {
    if (!A.quiet) this.emit('upload-progress', { tid: A.tid, received, total: A.total });
    else if (A.listed) this.emit('quiet-progress', { tid: A.tid, device: A.device, received, total: A.total });
  }

  // A quiet transfer in parts that checked out: saved like any file sent quietly (asked first on a PC set to "Ask each
  // time"). Until that's over it stays listed, so its phone asking how far it got hears it's being checked, never
  // "gone" (which would make it send the file again); after, "done" (or declined) is remembered for hours, so a commit
  // whose answer was lost doesn't save a second copy. [status, body] for the commit.
  async _quietSaved(A) {
    const { tid, att } = A;
    let out;
    try {
      await (await A.fdP).close();
      out = await this.api.quietOutcome({ tid, tmpPath: A.path, name: A.name, size: A.total, kind: A.quiet, device: A.device });
    } catch (e) {
      fs.unlink(A.path, () => {});
      out = [500, { ok: false, error: 'save' }];
    }
    // (its phone canceled it while it was being saved: that was said, and is the answer)
    if (A.dropped) return [410, this._aborted(A.why, A.canceled)];
    A.finished = true;
    if (this.assemblies.get(tid) === A) this.assemblies.delete(tid);
    const [code, body] = out;
    if (code === 200) {
      this._remember(tid, att, 'done', true);
      if (A.listed) this.emit('quiet-end', { tid, device: A.device, ok: true });
      return [200, Object.assign({}, body, { done: true })];
    }
    const no = body && (body.error === 'declined' || body.error === 'timeout') ? body.error : null;
    if (A.listed) this.emit('quiet-end', { tid, device: A.device, ok: false, why: no ? 'declined' : 'save' });
    if (!no) return [code, body];                // (not saved: its phone sends it again, from the start)
    this._remember(tid, att, 'aborted', true, no);
    return [410, this._aborted(no)];
  }

  // null when the assembled file's SHA-256 is want, otherwise why not
  async _checkAssembly(A, want) {
    let fd;
    try { fd = await A.fdP; } catch (e) { return 'disk'; }
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let pos = 0;
    try {
      while (pos < A.total) {
        if (A.dropped) return 'aborted';
        const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, A.total - pos), pos);
        if (!bytesRead) return 'short';
        h.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
        pos += bytesRead;
        A.active = mono();
      }
    } catch (e) { return A.dropped ? 'aborted' : 'disk'; }
    return h.digest('hex') === want ? null : 'checksum';
  }

  // null when every part's SHA-256 is the one the phone worked out, otherwise why not
  async _checkParts(A, sums) {
    let fd;
    try { fd = await A.fdP; } catch (e) { return 'disk'; }
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
      for (let i = 0; i < A.parts; i++) {
        const ph = A.ph[i], len = A.plen[i];
        let got;
        if (ph.h && ph.at === len) got = ph.h.digest('hex');
        else {
          // arrived out of order: read it back
          const h = crypto.createHash('sha256');
          let pos = 0;
          while (pos < len) {
            if (A.dropped) return 'aborted';
            const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, len - pos), A.start[i] + pos);
            if (!bytesRead) return 'short';
            h.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
            pos += bytesRead;
            A.active = mono();
          }
          got = h.digest('hex');
        }
        ph.h = null;                               // used up (a second check reads back)
        if (got !== sums[i]) return 'checksum';
      }
    } catch (e) { return A.dropped ? 'aborted' : 'disk'; }
    return null;
  }

  _dropAssembly(asm, superseded) {
    asm.superseded = !!superseded;
    asm.finished = true;
    asm.dropped = true;
    if (this.assemblies.get(asm.tid) === asm) this.assemblies.delete(asm.tid);
    for (const r of asm.reqs) this._cut(r);
    asm.reqs.clear();
    asm.fdP.then((fd) => fd.close()).catch(() => {}).finally(() => fs.unlink(asm.path, () => {}));
  }

  // How far a resumable transfer got, for its phone to continue it: per part, the bytes on disk; per bundle stream, the
  // entries delivered and the bytes of the file it was writing. done: complete; 410: aborted; 404: not here (start over).
  _transferStatus(res, q) {
    const clean = (v, n) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
    const tid = clean(q.get('tid'), 40), att = clean(q.get('att'), 20) || 'a';
    const owner = this.ownerOf(tid);
    if (!tid || (owner && owner !== q.get('device'))) return this._json(res, 404, { ok: false, error: 'gone' });
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) return seen.what === 'done' ? this._json(res, 200, { ok: true, done: true }) : this._json(res, 410, this._aborted(seen.why, seen.canceled));
    // (a transfer whose writes ran into a full drive, which still has no room for the rest: 507, and the phone stops
    // and says so, even when it didn't hear the answer to the write that failed)
    const full = (X, got) => X.nospace && !this._roomFor(X.total - got);
    const A = this.assemblies.get(tid);
    if (A && A.att === att && !A.finished && A.resumable) {
      if (full(A, A.saved.reduce((x, y) => x + y, 0))) return this._json(res, 507, { ok: false, error: 'no space' });
      return this._json(res, 200, { ok: true, kind: 'parts', total: A.total, parts: A.parts, start: A.start, plen: A.plen, saved: A.saved, done: A.done,
        complete: A.complete, checking: !!A.check, verify: A.verify });
    }
    const B = this.bundleAsm.get(tid);
    if (B && B.att === att && !B.finished && B.resumable) {
      if (full(B, B.got.reduce((x, y) => x + y, 0))) return this._json(res, 507, { ok: false, error: 'no space' });
      const at = B.ents.map((e, si) => this._streamAt(B, si));
      return this._json(res, 200, { ok: true, kind: 'bundle', streams: B.K, next: at.map((x) => x.next), part: at.map((x) => x.part),
        done: B.done, bytes: B.got.reduce((x, y) => x + y, 0) });
    }
    // a file coming in one request (sent quietly, or by an older phone): how much of it is here, for its phone only
    const U = this.uploads.get(tid);
    if (U && !U.superseded && U.device && U.device === q.get('device')) return this._json(res, 200, { ok: true, kind: 'upload', received: U.received, total: U.total });
    return this._json(res, 404, { ok: false, error: 'gone' });
  }

  // where a resumable bundle's stream si stands: next: the number of the first entry not in yet; part: the file it was
  // writing when cut off ({i, written}: its number and the bytes on disk), if any. It continues at part.i (from
  // part.written), else at next.
  _streamAt(B, si) {
    const ents = B.ents[si], part = B.part[si];
    return { next: ents.length ? ents[ents.length - 1].i + 1 : 0, part: part ? { i: part.i, written: part.written } : null };
  }

  // Speed test (Settings on the phone): POST sends bytes that are counted and dropped; GET ?bytes=N sends N bytes back
  _speed(req, res, q) {
    if (req.method === 'POST') {
      const t0 = Date.now();
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => this._json(res, 200, { ok: true, bytes: n, ms: Date.now() - t0 }));
      req.on('error', () => {});
      return;
    }
    const want = Math.max(0, Math.min(2 * 1024 * 1024 * 1024, Math.floor(Number(q.get('bytes')) || 0)));
    if (!this.speedBuf) this.speedBuf = crypto.randomBytes(1024 * 1024);
    const buf = this.speedBuf;
    this._cors(res);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': want, 'Cache-Control': 'no-store' });
    let left = want, stop = false;
    res.on('close', () => { stop = true; });
    const more = () => {
      while (left > 0 && !stop) {
        const n = Math.min(left, buf.length);
        left -= n;
        if (!res.write(n === buf.length ? buf : buf.subarray(0, n))) { res.once('drain', more); return; }
      }
      if (!stop) res.end();
    };
    more();
  }

  // Which of the phone's files this PC has already (so they aren't sent twice): {files: [{k, name, size}]} → for each
  // one with a likely copy here, the fingerprints of those copies (see have.js); the phone compares them with its own.
  // tid=&skip=1&name=: the phone sent nothing for that transfer because the PC has all of it ('already-have').
  _have(req, res, q) {
    const tid = String(q.get('tid') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    let body = '', n = 0, over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { if (over) return; n += c.length; if (n > 4 * 1024 * 1024) { over = true; this._json(res, 413, { ok: false, error: 'too big' }); this._cut(req); return; } body += c; });
    req.on('error', () => {});
    req.on('end', async () => {
      if (over) return;
      if (q.get('skip') === '1') {
        if (!tid) return this._json(res, 400, { ok: false, error: 'tid' });
        this._own(tid, q.get('device'));
        this.emit('already-have', { tid, name: String(q.get('name') || '').slice(0, 300), files: Math.max(1, +q.get('files') || 1) });
        return this._json(res, 200, { ok: true });
      }
      // (bytes: the whole send's size, asked before any of it goes: no room for it is said now, not halfway)
      const need = Math.floor(Number(q.get('bytes'))) || 0;
      if (need > 0 && !this._roomFor(need)) return this._json(res, 507, { ok: false, error: 'no space' });
      let list;
      try { list = JSON.parse(body).files; } catch (e) { return this._json(res, 400, { ok: false, error: 'bad list' }); }
      if (!Array.isArray(list) || list.length > 20000) return this._json(res, 400, { ok: false, error: 'bad list' });
      const items = list.map((x) => ({ k: String((x && x.k) || '').slice(0, 64), name: String((x && x.name) || '').slice(0, 300), size: Math.floor(Number(x && x.size)) || 0 }))
        .filter((x) => x.k && x.size > 0);
      if (!this.haveFiles) return this._json(res, 200, { ok: true, have: {} });
      // The lookup can take a while (a large re-send on a slow disk: each likely copy here is read). Until it's ready a
      // space goes out every 2 s, the answer's head with the first (JSON may start with spaces): the phone neither gives
      // up on its connection after a few silent seconds and asks again (the lookup ran twice), nor after 30 s (and sent
      // everything the PC has).
      this._cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.on('error', () => {});
      const alive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(' '); }, 2000);
      let have = {};
      // (the phone asking: it hears only about files it sent itself, see have.js)
      try { have = (await this.haveFiles(items, String(q.get('device') || ''))) || {}; } catch (e) { have = {}; }
      clearInterval(alive);
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ ok: true, have }));
    });
  }

  /** why: declined | timeout when the PC's user turned it down ("Ask each time"); the phone hears it with the 410.
   * canceled: the PC's user canceled it (Transfers): the 410 says that too. */
  abortUpload(tid, why, canceled) {
    const e = this.uploads.get(tid);
    if (e) this._cut(e.req);
    const c = canceled === true || undefined;
    const a = this.assemblies.get(tid);
    if (a) { a.why = why; a.canceled = c; this._remember(tid, a.att, 'aborted', a.resumable, why, c); this._dropAssembly(a, false); this.emit('upload-failed', { tid, why: 'aborted' }); this._quietEnd(a); }
    const b = this.bundleAsm.get(tid);
    if (b) { b.why = why; b.canceled = c; this._remember(tid, b.att, 'aborted', b.resumable, why, c); this._dropBundleAsm(b, false); this.emit('upload-failed', { tid, why: 'aborted' }); }
  }

  /** files are on their way to the phone, or were just offered and not fetched yet: don't restart now */
  outgoingBusy() {
    if (this.streaming > 0) return true;
    if (!this.connected) return false;                // offered to a phone that's gone: it can't fetch them now
    const now = mono();
    for (const f of this.outgoing.values()) if (!f.doneSent && now - f.at < 2 * 60000) return true;
    return false;
  }

  // An offer lasts as long as the phone may still fetch it: until 30 minutes after it last asked for it (never while it's
  // being sent), and hours for one it hasn't asked for yet. The phone fetches a large batch a few files at a time, so
  // the last files of it can start long after they were all offered (they used to be gone after 30 minutes: 404).
  offerFile(filePath, mime, device) {
    const st = fs.statSync(filePath);
    const fid = rid(8);
    // device: the phone it's offered to (the one named, else the one in use), for the history once it has fetched it
    // (its size, time and file number too: a range asked for later must come from the same file, see _handleDownload)
    this.outgoing.set(fid, { path: filePath, name: path.basename(filePath), size: st.size, mtime: st.mtimeMs, ino: st.ino, mime: mime || 'application/octet-stream', at: mono(),
      used: 0, sending: 0, device: device || (this.session ? this.session.device : null) });
    if (!this.offerT) {
      this.offerT = setInterval(() => {
        const now = mono();
        for (const [k, f] of this.outgoing) {
          if (!f.sending && (f.used ? now - f.used > OFFER_IDLE_MS : now - f.at > RESUME_KEEP_MS)) this.outgoing.delete(k);
        }
        if (!this.outgoing.size) { clearInterval(this.offerT); this.offerT = null; }
      }, 60000);
      if (this.offerT.unref) this.offerT.unref();
    }
    return { fid, name: path.basename(filePath), size: st.size };
  }

  // Whole file, or one byte range of it (the phone fetches large files in several ranges at once).
  _handleDownload(req, res, fid) {
    const f = this.outgoing.get(fid);
    if (!f) return this._json(res, 404, { ok: false });
    f.used = mono();
    let st;
    try { st = fs.statSync(f.path); } catch (e) { return this._json(res, 404, { ok: false }); }
    let start = 0, end = st.size - 1, partial = false;
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    // The phone joins ranges fetched at once, and a range cut off is fetched again from where it stopped, hours later
    // even: a file saved again on the PC meanwhile (an editor, a sync program) would be saved on the phone as a mix of
    // the two versions, with no error. So a file that isn't the one offered any more is refused, whole or a range of
    // it, before anything of it goes, and the phone says it changed (2.0.0: "Couldn't receive"). (One stat per range
    // asked for, not per read.)
    if (st.size !== f.size || st.mtimeMs !== f.mtime || (st.ino && f.ino && st.ino !== f.ino)) return this._json(res, 409, { ok: false, error: 'changed' });
    if (m) {
      start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (!(start <= end) || start >= st.size) { this._cors(res); res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      partial = true;
    }
    this._cors(res);
    const headers = {
      'Content-Type': f.mime,
      'Content-Length': st.size ? end - start + 1 : 0,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
    };
    if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    res.writeHead(partial ? 206 : 200, headers);
    if (!st.size) { res.end(); this.emit('download-done', { fid, total: 0 }); return; }
    // (over Bluetooth in 64 KB reads, as its frames are: the stall limit counts progress by reads, and a slow link shared
    // by a few files moves 1 MB of each in minutes)
    const bt = !!(req.socket && req.socket.remoteFamily === 'bluetooth');
    const rs = fs.createReadStream(f.path, { highWaterMark: bt ? 64 * 1024 : 1024 * 1024, start, end });
    this.streaming = (this.streaming || 0) + 1;
    f.sending = (f.sending || 0) + 1;
    res.on('close', () => { rs.destroy(); this.streaming = Math.max(0, (this.streaming || 0) - 1); f.sending--; f.used = mono(); });
    this._watchDownload(res, rs);
    f.sent = f.sent || 0;
    // What the phone has of it: each range handed to the network to its end, and of a range cut short and asked for
    // again from a point inside it (the phone asks from where its copy stops), what came before that point. It went
    // once that's all of it: bytes read for a connection that broke, or a range fetched twice, aren't more of it.
    // (A request starting right after a range is the next range, fetched at the same time: it says nothing of that one.)
    f.asked = f.asked || [];
    for (const [a, b] of f.asked) if (a < start && start <= b) gotRange(f, a, start);
    f.asked.push([start, end]);
    if (f.asked.length > 64) f.asked.shift();
    let last = 0;
    rs.on('data', (c) => {
      f.sent += c.length;
      const now = mono();
      if (now - last > 50) { last = now; this.emit('download-progress', { fid, sent: Math.min(f.sent, st.size), total: st.size }); }
    });
    res.on('finish', () => {
      gotRange(f, start, end + 1);
      if (!f.doneSent && f.got.length === 1 && f.got[0][0] === 0 && f.got[0][1] >= st.size) { f.doneSent = true; this.emit('download-done', { fid, total: st.size }); }
    });
    rs.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    // A file saved again while this range was on its way: what went is part old, part new. So its last piece is held
    // back until the file is seen unchanged once it has all been read; if it changed, the response is cut short instead,
    // the phone asks for the rest, and that is refused (409 changed). (One stat more per range, not per read; one piece,
    // at most 1 MB, held.)
    let held = null;
    rs.on('data', (c) => {
      if (held && !res.write(held)) { rs.pause(); res.once('drain', () => rs.resume()); }
      held = c;
    });
    rs.on('end', () => {
      fs.stat(f.path, (err, now) => {
        if (res.destroyed) return;
        if (err || now.size !== f.size || now.mtimeMs !== f.mtime || (now.ino && f.ino && now.ino !== f.ino)) { this._cut(req); return; }
        res.end(held);
      });
    });
  }
}

// a file the phone has the bytes [a, b) of: f.got, the pieces it has, joined where they meet
function gotRange(f, a, b) {
  if (!(b > a)) return;
  const out = [];
  for (const [x, y] of f.got || []) {
    if (y < a || x > b) out.push([x, y]);
    else { a = Math.min(a, x); b = Math.max(b, y); }
  }
  out.push([a, b]);
  f.got = out.sort((p, q) => p[0] - q[0]);
}

module.exports = { FlickServer, lanAddresses, rid, pairCode, PROTO, _setDlStallMs: (ms) => { DL_STALL_MS = ms; } };
