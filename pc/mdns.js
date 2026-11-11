'use strict';
// A small mDNS / DNS-SD responder (RFC 6762/6763), just enough to advertise one service on the local network:
// answers PTR, SRV, TXT and A questions about it, and announces it when it starts and when addresses change.
// Used to make this PC show up in Android's Quick Share (see quickshare.js), and for phones to find Flick itself
// (_flick._tcp: server.js _startMdns) where the network drops discovery's broadcast.
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const CLASS_IN = 1;
// What a question may cost here (anything on the network can ask, from any address on it): a message is 9000 bytes at
// most (RFC 6762 §17); of its questions only the first MAX_QUESTIONS are read, each record is answered once however
// often it's asked for, and the known answers a querier lists aren't read at all. Answers are capped in time too: a few
// a second to each address (a phone holding Connect asks about three times a second), and not many more in all to
// addresses not heard from lately (see mayAnswer); and an answer multicast on a network isn't multicast there again
// within a second (§6: everyone there just heard it).
const MAX_PACKET = 9000, MAX_QUESTIONS = 64;
const PER_ADDR = { burst: 16, rate: 8 }, IN_ALL = { burst: 64, rate: 40 };
const mono = () => performance.now();

// ---------------------------------------------------------------- wire format
function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error('label too long');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function decodeName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    if (off >= buf.length) throw new Error('truncated name');
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) throw new Error('truncated pointer');
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) end = off + 2;
      jumped = true;
      off = ptr;
      continue;
    }
    if (off + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

function decode(buf) {
  if (buf.length < 12) throw new Error('short');
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  const questions = [], answers = [];
  for (let i = 0; i < qd; i++) {
    const n = decodeName(buf, off); off = n.end;
    if (off + 4 > buf.length) throw new Error('truncated question');
    const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2); off += 4;
    questions.push({ name: n.name, type, unicast: !!(cls & 0x8000) });
  }
  for (let i = 0; i < an + ns + ar; i++) {
    const n = decodeName(buf, off); off = n.end;
    if (off + 10 > buf.length) throw new Error('truncated record');
    const type = buf.readUInt16BE(off), cls = buf.readUInt16BE(off + 2), ttl = buf.readUInt32BE(off + 4), len = buf.readUInt16BE(off + 8); off += 10;
    if (off + len > buf.length) throw new Error('truncated rdata');
    const rd = { name: n.name, type, ttl, flush: !!(cls & 0x8000) };
    if (type === TYPE.PTR) rd.data = decodeName(buf, off).name;
    else if (type === TYPE.A && len === 4) rd.data = [...buf.subarray(off, off + 4)].join('.');
    else if (type === TYPE.SRV) rd.data = { port: buf.readUInt16BE(off + 4), target: decodeName(buf, off + 6).name };
    else if (type === TYPE.TXT) { const kv = {}; let p = off; while (p < off + len) { const l = buf[p]; const s = buf.toString('utf8', p + 1, p + 1 + l); const i2 = s.indexOf('='); kv[i2 < 0 ? s : s.slice(0, i2)] = i2 < 0 ? true : s.slice(i2 + 1); p += 1 + l; } rd.data = kv; }
    if (i < an) answers.push(rd);
    off += len;
  }
  return { id, response: !!(flags & 0x8000), questions, answers };
}

// a query's header and its first `max` questions, read no further: { id, questions, end (where the last one read ends) }
function questionsOf(buf, max) {
  if (buf.length < 12) throw new Error('short');
  const id = buf.readUInt16BE(0), qd = buf.readUInt16BE(4);
  let off = 12;
  const questions = [];
  for (let i = 0; i < Math.min(qd, max); i++) {
    const n = decodeName(buf, off); off = n.end;
    if (off + 4 > buf.length) throw new Error('truncated question');
    questions.push({ name: n.name, type: buf.readUInt16BE(off), unicast: !!(buf.readUInt16BE(off + 2) & 0x8000) });
    off += 4;
  }
  return { id, questions, end: off };
}

function record(name, type, ttl, rdata, flush) {
  const n = encodeName(name);
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(CLASS_IN | (flush ? 0x8000 : 0), 2);
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([n, h, rdata]);
}

function response(id, answers, extra) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(0x8400, 2);                 // response, authoritative
  h.writeUInt16BE(answers.length, 6);
  h.writeUInt16BE((extra || []).length, 10);
  return Buffer.concat([h].concat(answers, extra || []));
}

function query(name, type) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(1, 4);
  const t = Buffer.alloc(4); t.writeUInt16BE(type, 0); t.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([h, encodeName(name), t]);
}

// IPv4 addresses of this PC (no link-local 169.254.x.x), with their netmasks. Every packet on the network is checked
// against them, so they're asked of the system at most every few seconds (fresh: now, for the network-change check).
let addrs = null, addrsAt = 0;
function lanIPv4(fresh) {
  const now = Date.now();
  if (addrs && !fresh && now - addrsAt < 3000) return addrs;
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const a of ifs[k] || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ address: a.address, netmask: a.netmask || '255.255.255.0' });
  addrs = out; addrsAt = now;
  return out;
}
const ip4 = (s) => s.split('.').reduce((n, x) => ((n << 8) | (+x & 255)) >>> 0, 0);
/** true when src is this machine or on one of its networks */
function onLink(src) {
  if (!src || /^127\./.test(src)) return true;
  const s = ip4(src);
  const on = (list) => list.some((a) => ((ip4(a.address) & ip4(a.netmask)) >>> 0) === ((s & ip4(a.netmask)) >>> 0));
  if (on(lanIPv4())) return true;
  // not on a network known a moment ago: maybe one that just came up (a cable with tethering plugged in, a hotspot
  // turned on), whose phone is meant to find this PC within a second. Asked again, at most four times a second.
  const age = Date.now() - addrsAt;
  return age >= 0 && age < 250 ? false : on(lanIPv4(true));
}
/** The addresses a querier at `src` can reach: the one on its subnet, or all of them. */
function addressesFor(src) {
  const all = lanIPv4();
  if (src) {
    const s = ip4(src);
    const same = all.filter((a) => ((ip4(a.address) & ip4(a.netmask)) >>> 0) === ((s & ip4(a.netmask)) >>> 0));
    if (same.length) return same.map((a) => a.address);
  }
  return all.map((a) => a.address);
}

// Whether an answer may go now (see PER_ADDR, IN_ALL): a token bucket for the address asking (to: an answer sent to it
// alone), kept on st with the MAX_ADDRS addresses heard from last; and one for all, which only answers to addresses not
// heard from lately (and multicast ones) draw on. So a device that asks from many addresses, or forged ones, uses up
// the overall share without silencing a phone that keeps asking (holding Connect); and as answers go to this PC's own
// networks only, what each address can be sent stays capped by its own bucket. Discovery's answers (server.js) are
// capped the same way.
const MAX_ADDRS = 4096;
function mayAnswer(st, to) {
  const now = mono();
  const take = (b, cap) => {
    b.n = Math.min(cap.burst, b.n + ((now - b.at) * cap.rate) / 1000); b.at = now;
    if (b.n < 1) return false;
    b.n--; return true;
  };
  st.inAll = st.inAll || { n: IN_ALL.burst, at: now };
  if (!to) return take(st.inAll, IN_ALL);
  st.perAddr = st.perAddr || new Map();
  let b = st.perAddr.get(to);
  if (b) st.perAddr.delete(to);                       // (kept in the order last heard from: the oldest goes first)
  else if (st.perAddr.size >= MAX_ADDRS) st.perAddr.delete(st.perAddr.keys().next().value);
  const fresh = !b;
  if (fresh) b = { n: PER_ADDR.burst, at: now };
  st.perAddr.set(to, b);
  if (!take(b, PER_ADDR)) return false;
  return !fresh || take(st.inAll, IN_ALL);
}

// ---------------------------------------------------------------- responder
class MdnsService extends EventEmitter {
  /** svc: { type: '_x._tcp.local', instance: 'name', host: 'h.local', port, txt: { k: v } } */
  constructor(svc, log) {
    super();
    this.svc = svc;
    this.log = log || (() => {});
    this.sock = null;
    this.timers = new Set();    // (an announcement's or a shared answer's timer leaves it once it has fired)
    this.joined = new Set();
  }

  get fullName() { return this.svc.instance + '.' + this.svc.type; }

  /** ttl: null = the usual (4500 s for PTR/TXT, 120 s for SRV/A), 0 = goodbye, n = cap (legacy unicast) */
  records(ttl, addrs, legacy) {
    const s = this.svc;
    const t = (normal) => (ttl == null ? normal : Math.min(ttl, normal));
    const flush = !legacy;
    const txt = Buffer.concat(Object.entries(s.txt || {}).map(([k, v]) => { const b = Buffer.from(k + '=' + v, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }));
    const srv = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([s.port >> 8, s.port & 255]), encodeName(s.host)]);
    return {
      ptr: record(s.type, TYPE.PTR, t(4500), encodeName(this.fullName)),
      srv: record(this.fullName, TYPE.SRV, t(120), srv, flush),
      txt: record(this.fullName, TYPE.TXT, t(4500), txt.length ? txt : Buffer.from([0]), flush),
      a: (addrs || lanIPv4().map((a) => a.address)).map((ip) => record(s.host, TYPE.A, t(120), Buffer.from(ip.split('.').map(Number)), flush)),
    };
  }

  /** The answer to one incoming packet (null when it isn't about us). Exposed for tests. */
  answer(pkt, src, legacy) {
    // most of what's heard is other devices' answers and questions about other services: those are let go first. Never
    // one: an answer, a message bigger than any can be, anything but a standard query without an error code (RFC 6762
    // §18.3, §18.11), and from a plain DNS client anything but one question (§6.7: it's answered as a DNS server would)
    if (pkt.length < 12 || pkt.length > MAX_PACKET || (pkt.readUInt16BE(2) & 0xf80f)) return null;
    if (legacy && pkt.readUInt16BE(4) !== 1) return null;
    let q;
    try { q = questionsOf(pkt, MAX_QUESTIONS); } catch (e) { return null; }
    const lc = (x) => String(x).toLowerCase();
    const ours = [lc(this.svc.type), lc(this.fullName), lc(this.svc.host), '_services._dns-sd._udp.local'];
    if (!q.questions.some((qu) => ours.includes(lc(qu.name)))) return null;
    const r = this.records(legacy ? 10 : null, addressesFor(src), legacy);
    // (each record once, however many times or ways it's asked for)
    const ans = new Set(), add = new Set();
    let unicast = false, svcs = null;
    for (const qu of q.questions) {
      const n = lc(qu.name);
      if (n === lc(this.svc.type) && (qu.type === TYPE.PTR || qu.type === TYPE.ANY)) { ans.add(r.ptr); for (const x of [r.srv, r.txt, ...r.a]) add.add(x); }
      else if (n === lc(this.fullName)) {
        if (qu.type === TYPE.SRV || qu.type === TYPE.ANY) { ans.add(r.srv); for (const x of r.a) add.add(x); }
        if (qu.type === TYPE.TXT || qu.type === TYPE.ANY) ans.add(r.txt);
      } else if (n === lc(this.svc.host) && (qu.type === TYPE.A || qu.type === TYPE.ANY)) { for (const x of r.a) ans.add(x); }
      else if (n === '_services._dns-sd._udp.local' && qu.type === TYPE.PTR) ans.add(svcs = svcs || record('_services._dns-sd._udp.local', TYPE.PTR, legacy ? 10 : 4500, encodeName(this.svc.type)));
      else continue;
      if (qu.unicast) unicast = true;
    }
    if (!ans.size) return null;
    const answers = [...ans], extra = [...add].filter((x) => !ans.has(x));
    if (legacy) {
      // a plain DNS client asking directly: answer with its query id and its question (RFC 6762 §6.7)
      const p = response(q.id, answers, extra);
      p.writeUInt16BE(1, 4);
      return { id: q.id, unicast: true, shared: false, packet: Buffer.concat([p.subarray(0, 12), pkt.subarray(12, q.end), p.subarray(12)]) };
    }
    return { id: q.id, unicast, shared: ans.has(r.ptr), packet: response(0, answers, extra) };
  }

  _mayAnswer(to) { return mayAnswer(this, to); }

  // an answer multicast on the network of iface less than a second ago isn't multicast there again
  _multicastNow(packet, iface) {
    const now = mono(), key = iface + '|' + packet.toString('latin1');
    this.multicastAt = this.multicastAt || new Map();
    if (now - (this.multicastAt.get(key) || -Infinity) < 1000) return false;
    if (this.multicastAt.size >= 64) for (const [k, at] of this.multicastAt) if (now - at >= 1000) this.multicastAt.delete(k);
    this.multicastAt.set(key, now);
    return this._mayAnswer(null);
  }

  start() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => {
      this.log('mdns', e.message);
      // couldn't even open port 5353: nobody on the network will hear about this PC (and its timers stop: nothing else
      // ever would, the server lets go of it)
      if (!this.bound && this.sock === sock && !this.stopped) {
        this.sock = null;
        try { sock.close(); } catch (x) { /* ignore */ }
        for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
        this.timers.clear();
        this.emit('unavailable', e);
      }
    });
    sock.on('message', (msg, rinfo) => {
      // only answer this network (RFC 6762 §11): a query from elsewhere would turn us into a traffic reflector. Nor once
      // stopped: it said goodbye, and a live answer after that would list this PC again, at a port that's closed
      if (this.stopped || !onLink(rinfo.address)) return;
      const legacy = rinfo.port !== PORT;
      const a = this.answer(msg, rinfo.address, legacy);
      if (!a) return;
      if (legacy || a.unicast) { if (this._mayAnswer(rinfo.address)) sock.send(a.packet, rinfo.port, rinfo.address, () => {}); return; }
      // shared answers wait a moment (RFC 6762 §6), on the interface that faces the querier (one still waiting when it's
      // stopped doesn't go)
      const iface = addressesFor(rinfo.address)[0];
      if (!this._multicastNow(a.packet, iface)) return;
      const t = setTimeout(() => { this.timers.delete(t); this.send(a.packet, iface); }, a.shared ? 20 + Math.floor(Math.random() * 100) : 0);
      this.timers.add(t);
    });
    sock.bind(PORT, () => {
      if (this.stopped) return;      // (stopped before its port was even open: it announces nothing)
      this.bound = true;
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch (e) { /* ignore */ }
      this.join();
      this.announce();
    });
    // networks come and go (a hotspot, a cable): join new ones and tell them about us
    this.timers.add(setInterval(() => { if (this.bound && this.join()) this.announce(); }, 15000));
    this.timers.add(setInterval(() => { if (this.bound) this.announce(1); }, 60000));
  }

  join() {
    if (!this.sock) return false;
    let added = false;
    const now = new Set(lanIPv4(true).map((a) => a.address));
    for (const ip of [...this.joined]) if (!now.has(ip)) this.joined.delete(ip);
    for (const ip of now) {
      if (this.joined.has(ip)) continue;
      try { this.sock.addMembership(GROUP, ip); } catch (e) { if (e.code !== 'EADDRINUSE') continue; /* else: still a member from before */ }
      this.joined.add(ip); added = true;
    }
    return added;
  }

  // sends go one at a time: the outgoing interface must not change under a send still in flight
  send(packet, onlyIface) {
    const ifaces = onlyIface ? [onlyIface] : [...this.joined];
    for (const ip of ifaces) this._queue(() => new Promise((res) => {
      if (!this.sock) return res();
      try { this.sock.setMulticastInterface(ip); this.sock.send(typeof packet === 'function' ? packet(ip) : packet, PORT, GROUP, () => res()); } catch (e) { res(); }
    }));
  }
  _queue(job) { this.q = (this.q || Promise.resolve()).then(job).catch(() => {}); }

  // each network hears only the address it can reach
  announce(times) {
    const pkt = (ip) => { const r = this.records(null, [ip]); return response(0, [r.ptr, r.srv, r.txt, ...r.a]); };
    const n = times || 2;
    for (let i = 0; i < n; i++) {
      const t = setTimeout(() => { this.timers.delete(t); this.send(pkt); }, i * 1000);
      this.timers.add(t);
    }
  }

  stop() {
    this.stopped = true;              // (from now on it says nothing more: the goodbye below is the last of it)
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers.clear();
    if (this.sock) {
      // goodbye: the same records with a TTL of 0
      try { const r = this.records(0); this.send(response(0, [r.ptr, r.srv, r.txt])); } catch (e) { /* ignore */ }
      const s = this.sock;
      setTimeout(() => { this.sock = null; try { s.close(); } catch (e) { /* ignore */ } }, 300);
    }
    this.joined.clear();
  }
}

module.exports = { MdnsService, encodeName, decodeName, decode, query, TYPE, addressesFor, onLink, mayAnswer };
