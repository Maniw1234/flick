'use strict';
// A small picture's width and height from its first bytes (PNG, JPEG, GIF, WebP), without decoding it: a card's picture
// that another device sends is only shown when it really is small. A few hundred kilobytes can describe a picture of
// billions of pixels, which the window drawing it would try to hold in memory.

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** [width, height], or null when it can't be told. */
function dims(b) {
  const n = b.length;
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (n >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return [u16le(b, 6), u16le(b, 8)];
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) return null;
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; }                                     // (fill)
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }   // (no length)
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      // a frame's header: its height and width (SOF0-15, but DHT C4, JPG C8 and DAC CC)
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [u16be(b, i + 7), u16be(b, i + 5)];
      i += 2 + len;
    }
    return null;
  }
  if (n >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const c = b.toString('latin1', 12, 16);
    if (c === 'VP8X') return [1 + u24le(b, 24), 1 + u24le(b, 27)];
    if (c === 'VP8 ') return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
    if (c === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >>> 14) & 0x3fff)]; }
  }
  return null;
}

/**
 * Whether a data: URL is a picture of at most max pixels a side (and max * max in all), that can be told so. JPEG, PNG
 * and WebP only (what Flick makes card pictures as): a GIF's own size says nothing of its frames, which can be larger.
 */
function smallPicture(url, max = 2048) {
  if (typeof url !== 'string') return false;
  const i = url.indexOf(';base64,');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(url) || i < 0) return false;
  let b;
  // (the header is in the first few kilobytes, unless a JPEG carries a big preview before its frame: then all of it)
  try { b = Buffer.from(url.slice(i + 8, i + 8 + 65536), 'base64'); } catch (e) { return false; }
  let d = dims(b);
  if (!d && url.length > i + 8 + 65536) { try { d = dims(Buffer.from(url.slice(i + 8), 'base64')); } catch (e) { return false; } }
  return !!d && d[0] > 0 && d[1] > 0 && d[0] <= max && d[1] <= max;
}

module.exports = { dims, smallPicture };
