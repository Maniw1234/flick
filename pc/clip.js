'use strict';
// Clipboard sync, the PC side. While a phone that has it is reachable, the clipboard is looked at once a
// second: what the user copies (text, or a picture as PNG of at most 6 MB) goes to the phone in use. What a phone sends
// is put on the clipboard and remembered, so it's never sent back. The same look also tells the tray whether the
// clipboard holds a web link ("Send clipboard link to phone").
// Electron 44's clipboard (main process) is asynchronous and works like the web's: readText / writeText / has, and
// read / write with ClipboardItem (pictures come out as image/png). Older Electrons were synchronous with readImage /
// writeImage; both are handled. Looks and writes run one at a time, so a phone's clip can't cross a look in flight.
const crypto = require('crypto');

// What password managers put next to a copied password so clipboard tools leave it alone (Windows' own clipboard
// history and cloud clipboard skip it; so does Flick): never sent to a phone
const PRIVATE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanUploadToCloudClipboard', 'org.nspasteboard.ConcealedType'];
const TEXT_MAX = 1024 * 1024;
const PNG_MAX = 6 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** Is this text one http(s) link (and nothing else)? */
function isLink(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 4096 || /\s/.test(s)) return false;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
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
    this.link = false;
    this.wasWanted = false;
    this.sent = 0;
    this.q = Promise.resolve();
    this.looking = false;
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
    this._serial(() => this._baseline());
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** One look (the timer's; tests call it directly). Skipped while the previous one is still at it. */
  look() {
    if (this.looking) return this.q;
    this.looking = true;
    return this._serial(() => this.tick()).catch(() => {}).then(() => { this.looking = false; });
  }

  async _text() { try { return String((await this.cb.readText()) || ''); } catch (e) { return ''; } }

  // the picture on the clipboard: { fp, png() -> Buffer (≤ 6 MB) | null }, or null
  async _image() {
    try {
      if (this.modern) {
        if (typeof this.cb.has === 'function' && !(await this.cb.has('image/png'))) return null;
        for (const it of (await this.cb.read()) || []) {
          if (!(it.types || []).includes('image/png')) continue;
          const b = await it.getType('image/png');
          const png = Buffer.isBuffer(b) ? b : Buffer.from(await b.arrayBuffer());
          return png.length ? { fp: sha(png), png: () => this._fit(png) } : null;
        }
        return null;
      }
      const f = typeof this.cb.availableFormats === 'function' ? this.cb.availableFormats() : [];
      if (!f.some((x) => /^image\//i.test(x)) || typeof this.cb.readImage !== 'function') return null;
      const img = this.cb.readImage();
      return img && !img.isEmpty() ? { fp: imageFp(img), png: () => this._fitImage(img) } : null;
    } catch (e) { return null; }
  }

  async _private() {
    if (typeof this.cb.has !== 'function') return false;
    for (const f of PRIVATE_FORMATS) {
      try { if (await this.cb.has(f)) return true; } catch (e) { /* a format this clipboard can't ask about */ }
    }
    return false;
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
    if (this.wasWanted) { const im = await this._image(); this.last.img = im ? im.fp : ''; }
  }

  async tick() {
    const text = await this._text();
    this._setLink(text);
    const want = !!this.wanted();
    if (want && !this.wasWanted) { await this._baseline(); return; }   // just turned on: only what's copied from now on
    this.wasWanted = want;
    const tfp = text ? sha(text) : '';
    const textNew = tfp !== this.last.text;
    this.last.text = tfp;
    if (!want) return;
    const im = await this._image();
    if ((textNew || (im ? im.fp : '') !== this.last.img) && await this._private()) { this.last.img = im ? im.fp : ''; return; }   // a password
    const ifp = im ? im.fp : '';
    const imgNew = ifp !== this.last.img;
    this.last.img = ifp;
    // new text wins when both changed at once (Office copies a picture of the cells along with their text)
    if (textNew && text) {
      if (Buffer.byteLength(text, 'utf8') <= TEXT_MAX && this.send({ t: 'clip', kind: 'text', text })) this.sent++;
      return;
    }
    if (im && imgNew) {
      const png = await im.png();
      if (png && this.send({ t: 'clip', kind: 'image', png: png.toString('base64') })) this.sent++;
    }
  }

  // PNG of at most 6 MB: a picture too large for that (a 4K screenshot) is sent smaller
  _fit(png) {
    if (png.length <= PNG_MAX) return png;
    if (!this.ni) { this.log('clipboard picture too large to send'); return null; }
    return this._fitImage(this.ni.createFromBuffer(png));
  }

  _fitImage(img) {
    let im = img;
    for (let i = 0; i < 5 && im && !im.isEmpty(); i++) {
      const png = im.toPNG();
      if (png.length <= PNG_MAX) return png;
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
    const t = await this._text();
    this.last.text = t ? sha(t) : '';
    this._setLink(t);
    const im = kind === 'text' ? null : await this._image();
    this.last.img = im ? im.fp : '';
    return true;
  }
}

module.exports = { ClipWatch, isLink, imageFp };
