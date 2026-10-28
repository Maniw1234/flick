'use strict';
// A small mDNS / DNS-SD responder (RFC 6762/6763), just enough to advertise one service on the local network:
// answers PTR, SRV, TXT and A questions about it, and announces it when it starts and when addresses change.
// Used to make this PC show up in Android's Quick Share (see quickshare.js).
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const CLASS_IN = 1;

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
  return lanIPv4().some((a) => ((ip4(a.address) & ip4(a.netmask)) >>> 0) === ((s & ip4(a.netmask)) >>> 0));
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

// ---------------------------------------------------------------- responder
class MdnsService extends EventEmitter {
  /** svc: { type: '_x._tcp.local', instance: 'name', host: 'h.local', port, txt: { k: v } } */
  constructor(svc, log) {
    super();
    this.svc = svc;
    this.log = log || (() => {});
    this.sock = null;
    this.timers = new Set();    // (an announcement's timer leaves it once it has fired)
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
    // most of what's heard is other devices' answers and questions about other services: those are let go first
    if (pkt.length < 12 || (pkt.readUInt16BE(2) & 0x8000)) return null;
    let q;
    try { q = decode(pkt); } catch (e) { return null; }
    if (q.response) return null;
    const lc = (x) => String(x).toLowerCase();
    const ours = [lc(this.svc.type), lc(this.fullName), lc(this.svc.host), '_services._dns-sd._udp.local'];
    if (!q.questions.some((qu) => ours.includes(lc(qu.name)))) return null;
    const r = this.records(legacy ? 10 : null, addressesFor(src), legacy);
    const ans = [], add = [];
    let unicast = false;
    for (const qu of q.questions) {
      const n = lc(qu.name);
      if (n === lc(this.svc.type) && (qu.type === TYPE.PTR || qu.type === TYPE.ANY)) { ans.push(r.ptr); add.push(r.srv, r.txt, ...r.a); }
      else if (n === lc(this.fullName)) {
        if (qu.type === TYPE.SRV || qu.type === TYPE.ANY) { ans.push(r.srv); add.push(...r.a); }
        if (qu.type === TYPE.TXT || qu.type === TYPE.ANY) ans.push(r.txt);
      } else if (n === lc(this.svc.host) && (qu.type === TYPE.A || qu.type === TYPE.ANY)) ans.push(...r.a);
      else if (n === '_services._dns-sd._udp.local' && qu.type === TYPE.PTR) ans.push(record('_services._dns-sd._udp.local', TYPE.PTR, legacy ? 10 : 4500, encodeName(this.svc.type)));
      else continue;
      if (qu.unicast) unicast = true;
    }
    if (!ans.length) return null;
    const extra = add.filter((x) => !ans.includes(x));
    if (legacy) {
      // a plain DNS client asking directly: answer with its query id and question (RFC 6762 §6.7)
      const qEnd = questionEnd(pkt);
      const p = response(q.id, ans, extra);
      p.writeUInt16BE(qEnd > 12 ? pkt.readUInt16BE(4) : 0, 4);
      return { id: q.id, unicast: true, shared: false, packet: qEnd > 12 ? Buffer.concat([p.subarray(0, 12), pkt.subarray(12, qEnd), p.subarray(12)]) : p };
    }
    return { id: q.id, unicast, shared: ans.includes(r.ptr), packet: response(0, ans, extra) };
  }

  start() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => {
      this.log('mdns', e.message);
      // couldn't even open port 5353: nobody on the network will hear about this PC
      if (!this.bound && this.sock === sock) { this.sock = null; try { sock.close(); } catch (x) { /* ignore */ } this.emit('unavailable', e); }
    });
    sock.on('message', (msg, rinfo) => {
      // only answer this network (RFC 6762 §11): a query from elsewhere would turn us into a traffic reflector
      if (!onLink(rinfo.address)) return;
      const legacy = rinfo.port !== PORT;
      const a = this.answer(msg, rinfo.address, legacy);
      if (!a) return;
      if (legacy || a.unicast) { sock.send(a.packet, rinfo.port, rinfo.address, () => {}); return; }
      // shared answers wait a moment (RFC 6762 §6), on the interface that faces the querier
      const iface = addressesFor(rinfo.address)[0];
      setTimeout(() => this.send(a.packet, iface), a.shared ? 20 + Math.floor(Math.random() * 100) : 0);
    });
    sock.bind(PORT, () => {
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

function questionEnd(buf) {
  try {
    let off = 12;
    for (let i = 0; i < buf.readUInt16BE(4); i++) off = decodeName(buf, off).end + 4;
    return off;
  } catch (e) { return 12; }
}

module.exports = { MdnsService, encodeName, decodeName, decode, query, TYPE, addressesFor };
