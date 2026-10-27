// The hand stream's aim and smoothing (phone/hand/stream.js), with made-up frames at 30 a second:
// - a still open hand that closes into a fist while drifting (as hands and the tracker's palm do): the fist's aim is
//   where it was open, not where the closing took it; the same for a fist that opens
// - while a pose changes, move events keep the aim where it was before
// - a still hand that shakes a little (the tracker's noise) stays nearly still; a moving one isn't far behind
// usage: node stream_aim.js
const Stream = require('../../phone/hand/stream.js');
let fails = 0;
const ok = (c, what) => { console.log((c ? '  ok   ' : '  FAIL ') + what); if (!c) fails++; };
const g = (pose, x, y) => ({ center: [x, y], size: 0.15, open: pose === 'open', fist: pose === 'fist', pinch: false, pinchGap: 1 });
const run = (frames) => {
  const ev = [];
  const s = new Stream({ mirror: false, onEvent: (type, e) => ev.push(Object.assign({ type }, e)) });
  frames.forEach((f, i) => s.push({ hand: {}, g: g(f[0], f[1], f[2]), t: 1000 + i * 33.3 }));
  return ev;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// open at (0.40, 0.50) for 0.5 s; closing over 5 frames drifts it to (0.46, 0.56); then a fist there
const A = [0.4, 0.5], B = [0.46, 0.56];
const closing = [];
for (let i = 0; i < 15; i++) closing.push(['open', A[0], A[1]]);
for (let i = 1; i <= 5; i++) closing.push([i < 3 ? 'other' : 'fist', A[0] + (B[0] - A[0]) * i / 5, A[1] + (B[1] - A[1]) * i / 5]);
for (let i = 0; i < 8; i++) closing.push(['fist', B[0], B[1]]);
let ev = run(closing);
const fist = ev.find((e) => e.type === 'pose' && e.pose === 'fist');
ok(!!fist, 'the fist is seen');
ok(fist && dist(fist.aim, A) < 0.01, 'its aim is where the hand was open (' + (fist && fist.aim.map((v) => v.toFixed(3))) + '), not where closing took it (pos ' + (fist && fist.pos.map((v) => v.toFixed(3))) + ')');
const changing = ev.filter((e) => e.type === 'move' && e.raw !== e.pose);
ok(changing.length > 0 && changing.every((e) => dist(e.aim, A) < 0.01), 'while it closes, moves keep the aim where it was (' + changing.length + ' frames)');

// a fist at (0.60, 0.40) that opens, drifting to (0.55, 0.47)
const C = [0.6, 0.4], D = [0.55, 0.47];
const opening = [];
for (let i = 0; i < 15; i++) opening.push(['fist', C[0], C[1]]);
for (let i = 1; i <= 5; i++) opening.push([i < 2 ? 'other' : 'open', C[0] + (D[0] - C[0]) * i / 5, C[1] + (D[1] - C[1]) * i / 5]);
for (let i = 0; i < 8; i++) opening.push(['open', D[0], D[1]]);
ev = run(opening);
const open = ev.find((e) => e.type === 'pose' && e.pose === 'open');
ok(open && dist(open.aim, C) < 0.01, 'a fist that opens: its aim is where the fist was (' + (open && open.aim.map((v) => v.toFixed(3))) + ')');
const enteredFist = ev[0];
ok(enteredFist.type === 'enter' && enteredFist.pose === 'fist', 'entered as a fist');

// a pose seen for one frame only changes nothing
const blip = [];
for (let i = 0; i < 10; i++) blip.push(['open', 0.5, 0.5]);
blip.push(['fist', 0.5, 0.5]);
for (let i = 0; i < 10; i++) blip.push(['open', 0.5, 0.5]);
ev = run(blip);
ok(!ev.some((e) => e.type === 'pose'), 'one frame of a fist is not a fist');

// shaking: a still hand with the tracker's noise (+-0.006), 2 s
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const still = [];
for (let i = 0; i < 60; i++) still.push(['open', 0.5 + rnd() * 0.012, 0.5 + rnd() * 0.012]);
ev = run(still).filter((e) => e.type === 'move').slice(15);
const sd = (k) => { const v = ev.map((e) => e.pos[k]); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); };
const rawSd = 0.012 / Math.sqrt(12);
ok(sd(0) < rawSd * 0.45 && sd(1) < rawSd * 0.45, 'a still hand barely shakes: ' + (sd(0) * 1000).toFixed(2) + ' / ' + (sd(1) * 1000).toFixed(2) + ' thousandths (raw ' + (rawSd * 1000).toFixed(2) + ')');

// moving: 1 view width a second, left to right
const sweep = [];
for (let i = 0; i < 24; i++) sweep.push(['open', 0.1 + i * 0.0333, 0.5]);
ev = run(sweep).filter((e) => e.type === 'move');
const last = ev[ev.length - 1];
const lag = (0.1 + 23 * 0.0333) - last.pos[0];
ok(lag < 0.05, 'a hand moving a view width a second is ' + (lag * 1000).toFixed(0) + ' thousandths behind (less than 50)');

console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
