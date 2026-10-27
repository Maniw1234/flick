// Runs the tracker and the event stream over a video (decoded by ffmpeg) and prints the events.
// usage: node video_events.js <video> [fps] [start] [duration]
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const H = require('../../phone/hand/hand.js');
const Stream = require('../../phone/hand/stream.js');
const [video, fps = '15', ss = '0', dur = '60'] = process.argv.slice(2);
const fetch = async (u) => { const b = fs.readFileSync(path.join(__dirname, '../../phone/hand', path.basename(u))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
(async () => {
  const hands = await H.load({ fetch });
  // probe size after scaling to 320 on the long side
  const W0 = 720, H0 = 1280, k = 320 / Math.max(W0, H0), w = Math.round(W0 * k / 2) * 2, h = Math.round(H0 * k / 2) * 2;
  const ff = spawn('ffmpeg', ['-v', 'error', '-ss', ss, '-t', dur, '-i', video, '-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const frame = w * h * 4;
  let acc = Buffer.alloc(0), n = 0, msSum = 0, looked = -1e9;
  const s = new Stream({ mirror: false, onEvent: (type, e) => { if (type !== 'move') console.log((+ss + n / +fps).toFixed(2) + 's', type, JSON.stringify(e, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v)); } });
  ff.stdout.on('data', (d) => {
    acc = Buffer.concat([acc, d]);
    while (acc.length >= frame) {
      const px = new Uint8Array(acc.subarray(0, frame)); acc = acc.subarray(frame);
      const t = n * 1000 / +fps;
      const mo = hands.motion(px, w, h);
      let r = { hand: null, ms: 0 };
      if (hands.tracker.roi || mo.motion >= 1.6 || t - looked > 1000) { if (!hands.tracker.roi) looked = t; r = hands.track(px, w, h); }
      msSum += r.ms;
      s.push({ hand: r.hand, g: r.hand ? H.gesture(r.hand.lm, w, h) : null, t });
      n++;
    }
  });
  ff.on('close', () => console.log(`${n} frames ${w}x${h}, mean ${(msSum / n).toFixed(1)} ms/frame`));
})();
