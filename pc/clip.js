'use strict';
// Clipboard sync, the PC side. While a phone that has it is reachable, the clipboard is looked at once a
// second (a picture that stays there is read again less often, see tick): what the user copies (text, or a picture as
// PNG of at most 6 MB) goes to the phone in use. What a phone sends
// is put on the clipboard and remembered, so it's never sent back. The same look also tells the tray whether the
// clipboard holds a web link ("Send clipboard link to phone").
// Electron 44's clipboard (main process) is asynchronous and works like the web's: readText / writeText / has, and
// read / write with ClipboardItem (pictures come out as image/png). Older Electrons were synchronous with readImage /
// writeImage; both are handled. Looks and writes run one at a time, so a phone's clip can't cross a look in flight.
// Each read has a time limit (clipfiles.js ask: a program that never answers would otherwise hold every look, and
// every clip from a phone queued behind it, for good); a look that meets one ends there, seeing nothing new. On Linux
// the looks after it read the X server directly meanwhile (clipfiles.js, clipx11.js).
const crypto = require('crypto');
const { ask, filesOn } = require('./clipfiles');
const WAIT = 'ECLIPWAIT';

// What password managers put next to a copied password so clipboard tools leave it alone (Windows' own clipboard
// history and cloud clipboard skip it; so does Flick): never sent to a phone. Then macOS' mark, and Linux's (KDE's).
const PRIVATE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanUploadToCloudClipboard', 'org.nspasteboard.ConcealedType']
  .concat(process.platform === 'linux' ? ['x-kde-passwordManagerHint'] : []);
const TEXT_MAX = 1024 * 1024;
const PNG_MAX = 6 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** Is this text one http(s) link (and nothing else)? */
function isLink(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 4096 || /\s/.test(s)) return false;
  // (not one with a name before the host: "https://bank.example@evil.example" reads as one site and opens another;
  // phoneapi.js cleanUrl refuses it, and so do the phone and its page)
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch (e) { return false; }
}

// an older Electron's picture (a NativeImage): its size and pixels (every 4th row of a large one: enough to notice a
// new picture without hashing all of a 4K screenshot every second)
function imageFp(img) {
  const { width, height } = img.getSize();
  const px = img.toBitmap();
  const h = crypto.createHash('sha1').update(width + 'x' + height + ':' + px.length + ':');
  const row = width * 4;
  if (px.length <= 8 * 1024 * 1024 || !row) h.update(px);
  else for (let y = 0; y < height; y += 4) h.update(px.subarray(y * row, (y + 1) * row));
  return h.digest('hex');
}

class ClipWatch {
  /**
   * opts.clipboard, opts.ClipboardItem, opts.nativeImage: Electron's (tests pass fakes)
   * opts.send(msg) -> bool: the event for the phone in use ({t:'clip', kind, text | png})
   * opts.wanted() -> bool: clipboard sync is on and the phone in use takes it
   * opts.onLink(hasLink): the clipboard started or stopped holding a web link
   */
  constructor(opts) {
    this.cb = opts.clipboard || {};
    this.CI = opts.ClipboardItem || null;
    this.ni = opts.nativeImage || null;
    this.send = opts.send || (() => false);
    this.wanted = opts.wanted || (() => false);
    this.onLink = opts.onLink || (() => {});
    this.log = opts.log || (() => {});
    this.every = opts.every || 1000;
    this.timer = null;
    this.last = { text: '', img: '' };
    this.imgHad = false;        // was there a picture at the last look
    this.imgAt = 0;             // when the picture's bytes were last read, and what that took (ms)
    this.imgCost = 0;
    this.link = false;
    this.wasWanted = false;
    this.sent = 0;
    this.q = Promise.resolve();
    this.looking = false;
    this.based = false;         // where looking starts from was taken (see _baseline)
    this.unanswered = false;    // the clipboard didn't answer the last look in time
    this.usable = typeof this.cb.readText === 'function';
    this.modern = typeof this.cb.read === 'function' && typeof this.cb.write === 'function' && !!this.CI;
  }

  get running() { return !!this.timer; }

  // one clipboard job at a time
  _serial(fn) {
    const p = this.q.then(fn);
    this.q = p.catch((e) => this.log('clipboard: ' + (e && e.message)));
    return p;
  }

  /** Starts looking (a phone became reachable). What's on the clipboard now is where it starts from: not sent. */
  start() {
    if (this.timer || !this.usable) return;
    this.timer = setInterval(() => this.look(), this.every);
    this.based = false;
    this._serial(() => this.tick());
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** One look (the timer's; tests call it directly). Skipped while the previous one is still at it. */
  look() {
    if (this.looking) return this.q;
    this.looking = true;
    return this._serial(() => this.tick()).catch(() => {}).then(() => { this.looking = false; });
  }

  // a read of the clipboard, in its time (a picture's bytes can take the program that has it a while to make)
  _ask(f, ms) { return ask(this.cb, f, ms || 2000); }

  async _text() { try { return String((await this._ask((c) => c.readText(), 5000)) || ''); } catch (e) { if (e && e.code === WAIT) throw e; return ''; } }

  // the picture on the clipboard: { fp, png() -> Buffer (≤ 6 MB) | null }, or null
  async _image() {
    try {
      if (this.modern) {
        if (typeof this.cb.has === 'function' && !(await this._ask((c) => c.has('image/png')))) return null;
        for (const it of (await this._ask((c) => c.read())) || []) {
          if (!(it.types || []).includes('image/png')) continue;
          const b = await this._ask(() => it.getType('image/png'), 15000);
          const png = Buffer.isBuffer(b) ? b : Buffer.from(await b.arrayBuffer());
          return png.length ? { fp: sha(png), png: (max) => this._fit(png, max) } : null;
        }
        return null;
      }
      const f = typeof this.cb.availableFormats === 'function' ? this.cb.availableFormats() : [];
      if (!f.some((x) => /^image\//i.test(x)) || typeof this.cb.readImage !== 'function') return null;
      const img = this.cb.readImage();
      return img && !img.isEmpty() ? { fp: imageFp(img), png: (max) => this._fitImage(img, max) } : null;
    } catch (e) { if (e && e.code === WAIT) throw e; return null; }
  }

  // Is there a picture on the clipboard? Cheap: no bytes are read.
  async _hasImage() {
    try {
      if (this.modern) return typeof this.cb.has === 'function' ? !!(await this._ask((c) => c.has('image/png'))) : true;
      const f = typeof this.cb.availableFormats === 'function' ? this.cb.availableFormats() : [];
      return f.some((x) => /^image\//i.test(x));
    } catch (e) { if (e && e.code === WAIT) throw e; return false; }
  }

  // The picture, read (timed: see _imgEvery)
  async _readImage() {
    const t0 = performance.now();
    const im = await this._image();
    this.imgAt = performance.now();
    this.imgCost = this.imgAt - t0;
    return im;
  }

  // How often a picture that stays on the clipboard is read again to see whether it was replaced by another (nothing
  // cheaper tells): reading one can mean encoding a whole screenshot as PNG, so the more it cost, the rarer, up to 5 s
  _imgEvery() { return Math.min(5000, Math.max(this.every, this.imgCost * 20)); }

  // Are there files copied in a file manager on the clipboard? (only this clipboard's own list of them counts)
  async _files() {
    if (!this.modern || typeof this.cb.has !== 'function') return false;
    try { return (await filesOn(this.cb)).length > 0; } catch (e) { if (e && e.code === WAIT) throw e; return false; }
  }

  async _private() {
    if (typeof this.cb.has !== 'function') return false;
    for (const f of PRIVATE_FORMATS) {
      try { if (await this._ask((c) => c.has(f))) return true; } catch (e) { if (e && e.code === WAIT) throw e; /* a format this clipboard can't ask about */ }
    }
    return false;
  }

  // The clipboard answered a look, or didn't (said once each way). A look it didn't answer leaves the next answered one
  // to start afresh: what's on the clipboard then is where it starts from, not sent (it may be what was there before).
  _answered(ok) {
    if (!ok) this.based = false;
    if (ok === !this.unanswered) return;
    this.unanswered = !ok;
    this.log(ok ? 'clipboard: answering again' : 'clipboard: not answering (a program that has it doesn’t reply): nothing copied here goes to the phone meanwhile');
  }

  _setLink(text) {
    const l = isLink(text);
    if (l !== this.link) { this.link = l; this.onLink(l); }
  }

  async _baseline() {
    const text = await this._text();
    this._setLink(text);
    this.last.text = text ? sha(text) : '';
    this.wasWanted = !!this.wanted();
    if (this.wasWanted) { const im = await this._readImage(); this.last.img = im ? im.fp : ''; this.imgHad = !!im; }
    this.based = true;
  }

  /** One look: what's new on the clipboard goes to the phone (the first, or the first after one that wasn't answered,
   * only notes what's there). */
  async tick() {
    try {
      if (this.based) await this._tick(); else await this._baseline();
      this._answered(true);
    } catch (e) { if (e && e.code === WAIT) this._answered(false); else throw e; }
  }

  async _tick() {
    const text = await this._text();
    this._setLink(text);
    const want = !!this.wanted();
    if (want && !this.wasWanted) { await this._baseline(); return; }   // just turned on: only what's copied from now on
    this.wasWanted = want;
    const tfp = text ? sha(text) : '';
    const textNew = tfp !== this.last.text;
    this.last.text = tfp;
    if (!want) return;
    // a picture's bytes are read only when they may be new: none was there before, the text changed with it (a new
    // copy), or it's been a while (see _imgEvery). Otherwise it's taken to be the same one.
    let im = null, ifp = '';
    const has = await this._hasImage();
    if (has && (textNew || !this.imgHad || performance.now() - this.imgAt >= this._imgEvery())) {
      im = await this._readImage();
      ifp = im ? im.fp : '';
    } else if (has) ifp = this.last.img;
    this.imgHad = has;
    if ((textNew || ifp !== this.last.img) && await this._private()) { this.last.img = ifp; return; }   // a password
    const imgNew = ifp !== this.last.img;
    this.last.img = ifp;
    // new text wins when both changed at once (Office copies a picture of the cells along with their text)
    if (textNew && text) {
      // (files copied in a file manager come with text of their own, their paths or the file manager's own words, as
      // Nautilus's "x-special/nautilus-clipboard copy file:///…": not text the user copied. Ctrl+Alt+F sends files.)
      if (await this._files()) return;
      if (Buffer.byteLength(text, 'utf8') <= TEXT_MAX && this.send({ t: 'clip', kind: 'text', text })) this.sent++;
      return;
    }
    if (im && imgNew) {
      const png = await im.png();
      if (png && this.send({ t: 'clip', kind: 'image', png: png.toString('base64') })) this.sent++;
    }
  }

  // PNG of at most 6 MB (or max): a picture too large for that (a 4K screenshot) is sent smaller
  _fit(png, max = PNG_MAX) {
    if (png.length <= max) return png;
    if (!this.ni) { this.log('clipboard picture too large to send'); return null; }
    return this._fitImage(this.ni.createFromBuffer(png), max);
  }

  _fitImage(img, max = PNG_MAX) {
    let im = img;
    for (let i = 0; i < 5 && im && !im.isEmpty(); i++) {
      const png = im.toPNG();
      if (png.length <= max) return png;
      const { width, height } = im.getSize();
      im = im.resize({ width: Math.max(1, Math.round(width * 0.7)), height: Math.max(1, Math.round(height * 0.7)) });
    }
    this.log('clipboard picture too large to send');
    return null;
  }

  /** What a phone sent: onto the clipboard, and remembered (as the next look will see it) so it isn't sent back. */
  put(kind, data) { return this._serial(() => this._put(kind, data)); }

  async _put(kind, data) {
    if (kind === 'text') {
      await this.cb.writeText(String(data));
    } else if (this.modern) {
      await this.cb.write([new this.CI({ 'image/png': new Blob([data], { type: 'image/png' }) })]);
    } else if (this.ni && typeof this.cb.writeImage === 'function') {
      const im = this.ni.createFromBuffer(data);
      if (!im || im.isEmpty()) return false;
      this.cb.writeImage(im);
    } else return false;
    // (read back as the next look will see it. A clipboard not answering reads: the next look that's answered starts
    // afresh, so what was just put there isn't sent back)
    try {
      const t = await this._text();
      this.last.text = t ? sha(t) : '';
      this._setLink(t);
      const im = kind === 'text' ? null : await this._readImage();
      this.imgHad = !!im;
      this.last.img = im ? im.fp : '';
    } catch (e) { if (e && e.code === WAIT) this.based = false; else throw e; }
    return true;
  }
}

module.exports = { ClipWatch, isLink, imageFp };
