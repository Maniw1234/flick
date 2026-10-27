// Runs the tracker on raw RGBA frames (<name>-<w>x<h>.rgba) and prints a few landmarks and the gesture.
// usage: node frames.js <folder> [track]   (track: keep following the hand from frame to frame)
const fs = require('fs'), path = require('path');
const H = require('../../phone/hand/hand.js');
const dir = process.argv[2], track = process.argv[3] === 'track';
const fetch = async (u) => { const b = fs.readFileSync(path.join(__dirname, '../../phone/hand', path.basename(u))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
(async () => {
  const hands = await H.load({ fetch });
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.rgba')).sort()) {
    const [, w, h] = f.match(/-(\d+)x(\d+)\.rgba$/).map(Number);
    const px = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    if (!track) hands.reset();
    const r = hands.track(px, w, h);
    if (!r.hand) { console.log(f.split('-').slice(0, 2).join('-'), 'none', r.ms.toFixed(1) + 'ms'); continue; }
    const lm = r.hand.lm, g = H.gesture(lm, w, h);
    const pts = [0, 4, 8, 12, 20].map((i) => `${i}:(${lm[3 * i].toFixed(3)},${lm[3 * i + 1].toFixed(3)})`).join(' ');
    console.log(f.split('-').slice(0, 2).join('-'), pts, `score ${r.hand.score.toFixed(2)} ${g.open ? 'OPEN' : ''}${g.fist ? 'FIST' : ''}${g.pinch ? ' PINCH' : ''} fingers ${g.fingers.map((v) => v.toFixed(2)).join(',')} ${r.ms.toFixed(1)}ms`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
