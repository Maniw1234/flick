// The hand stream's aim and smoothing (phone/hand/stream.js), with made-up frames at 30 a second:
// - a still open hand that closes into a fist while drifting (as hands and the tracker's palm do): the fist's aim is
//   where it was open, not where the closing took it; the same for a fist that opens
// - while a pose changes, move events keep the aim where it was before
// - a slow close through a half-closed hand aims where it was open; a hand carried half closed aims where it opened
// - a hand lost as it opened says so; edges only where it really went out; a hand found again far away starts afresh
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

// open at (0.40, 0.50) for 0.5 s; closing over 5 frames drifts it to (0.44, 0.54); then a fist there
const A = [0.4, 0.5], B = [0.44, 0.54];
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

// a fist at (0.60, 0.40) that opens, drifting to (0.56, 0.45)
const C = [0.6, 0.4], D = [0.56, 0.45];
const opening = [];
for (let i = 0; i < 15; i++) opening.push(['fist', C[0], C[1]]);
for (let i = 1; i <= 5; i++) opening.push([i < 2 ? 'other' : 'open', C[0] + (D[0] - C[0]) * i / 5, C[1] + (D[1] - C[1]) * i / 5]);
for (let i = 0; i < 8; i++) opening.push(['open', D[0], D[1]]);
ev = run(opening);
const open = ev.find((e) => e.type === 'pose' && e.pose === 'open');
ok(open && dist(open.aim, C) < 0.01, 'a fist that opens: its aim is where the fist was (' + (open && open.aim.map((v) => v.toFixed(3))) + ')');
const enteredFist = ev[0];
ok(enteredFist.type === 'enter' && enteredFist.pose === 'fist', 'entered as a fist');

// a slow close: open, then half closed ('other') for 0.4 s drifting a little, then a fist: aimed where it was open
const slow = [];
for (let i = 0; i < 15; i++) slow.push(['open', 0.3, 0.3]);
for (let i = 1; i <= 12; i++) slow.push(['other', 0.3 + 0.003 * i, 0.3 + 0.003 * i]);
for (let i = 0; i < 6; i++) slow.push(['fist', 0.336, 0.336]);
ev = run(slow);
const slowFist = ev.find((e) => e.type === 'pose' && e.pose === 'fist');
ok(slowFist && dist(slowFist.aim, [0.3, 0.3]) < 0.01, 'a slow close through a half-closed hand: the fist aims where it was open (' + (slowFist && slowFist.aim.map((v) => v.toFixed(3))) + ')');
const halfway = ev.filter((e) => e.type === 'move' && e.pose === 'other');
ok(halfway.length > 3 && halfway.every((e) => dist(e.aim, [0.3, 0.3]) < 0.01), 'and while it is half closed, its aim stays there (the light doesn\'t drift onto the next file)');

// a fist carried half open ('other') a long way, then opened: aimed where it opened, not where the fist was
const carried = [];
for (let i = 0; i < 10; i++) carried.push(['fist', 0.3, 0.4]);
for (let i = 1; i <= 13; i++) carried.push(['other', 0.3 + 0.025 * i, 0.4 + 0.004 * i]);   // 0.33 to the right in 0.43 s
for (let i = 0; i < 6; i++) carried.push(['open', 0.625, 0.452]);
ev = run(carried);
const carriedOpen = ev.find((e) => e.type === 'pose' && e.pose === 'open');
ok(carriedOpen && dist(carriedOpen.aim, [0.625, 0.452]) < 0.03, 'a fist carried half open, then opened: aimed where it opened (' + (carriedOpen && carriedOpen.aim.map((v) => v.toFixed(3))) + '), not back where the fist was');

// a fist that travels as it opens (a hand moving on, not drifting): no aim from back where it began
const moving = [];
for (let i = 0; i < 10; i++) moving.push(['fist', 0.2, 0.5]);
for (let i = 1; i <= 4; i++) moving.push([i < 2 ? 'other' : 'open', 0.2 + 0.06 * i, 0.5]);
for (let i = 0; i < 4; i++) moving.push(['open', 0.44 + 0.02 * i, 0.5]);
ev = run(moving);
const movingOpen = ev.find((e) => e.type === 'pose' && e.pose === 'open');
ok(movingOpen && movingOpen.aim[0] > 0.3, 'a fist that opens while moving fast: aimed on its way (' + (movingOpen && movingOpen.aim.map((v) => v.toFixed(3))) + '), not back at 0.2');

// lost while opening: the leave says so, and where the fist was
const lostOpening = [];
for (let i = 0; i < 10; i++) lostOpening.push(['fist', 0.5, 0.5]);
lostOpening.push(['open', 0.51, 0.51]);
ev = [];
let s2 = new Stream({ mirror: false, onEvent: (type, e) => ev.push(Object.assign({ type }, e)) });
lostOpening.forEach((f, i) => s2.push({ hand: {}, g: g(f[0], f[1], f[2]), t: 1000 + i * 33.3 }));
for (let i = 0; i < 12; i++) s2.push({ hand: null, g: null, t: 1000 + (lostOpening.length + i) * 33.3 });
const lostLeave = ev.find((e) => e.type === 'leave');
ok(lostLeave && lostLeave.pose === 'fist' && lostLeave.raw === 'open' && dist(lostLeave.aim, [0.5, 0.5]) < 0.01, 'a fist lost as it opened: leave says pose fist, raw open, aimed where the fist was (' + (lostLeave && lostLeave.raw) + ')');
ok(lostLeave && lostLeave.edge === null, 'lost in the middle of the view: no edge');

// edges: at the edge, or heading out fast: an edge; in the middle, still: none
const leaveAt = (pts) => {
  const e2 = [];
  const s3 = new Stream({ mirror: false, onEvent: (type, e) => e2.push(Object.assign({ type }, e)) });
  pts.forEach((p, i) => s3.push({ hand: {}, g: g('fist', p[0], p[1]), t: 1000 + i * 33.3 }));
  for (let i = 0; i < 12; i++) s3.push({ hand: null, g: null, t: 1000 + (pts.length + i) * 33.3 });
  return e2.find((e) => e.type === 'leave');
};
const stillAt = (x, y) => Array.from({ length: 10 }, () => [x, y]);
ok(leaveAt(stillAt(0.5, 0.76)).edge === null, 'a still fist lost at y 0.76: no edge (it was ' + leaveAt(stillAt(0.5, 0.76)).edge + ')');
ok(leaveAt(stillAt(0.5, 0.95)).edge === 'bottom', 'a fist lost at the bottom edge: bottom');
ok(leaveAt(Array.from({ length: 8 }, (_, i) => [0.5, 0.5 - 0.06 * i])).edge === 'top', 'a fist heading up fast, last seen at y 0.08: top');
ok(leaveAt(Array.from({ length: 8 }, (_, i) => [0.4 + 0.012 * i, 0.5])).edge === null, 'a fist drifting slowly in the middle: no edge');

// found again far away after a lost frame (another hand): no aim or smoothing across the jump
ev = [];
const s4 = new Stream({ mirror: false, onEvent: (type, e) => ev.push(Object.assign({ type }, e)) });
let tt = 1000;
for (let i = 0; i < 10; i++) s4.push({ hand: {}, g: g('fist', 0.3, 0.6), t: (tt += 33.3) });
s4.push({ hand: null, g: null, t: (tt += 33.3) });
s4.push({ hand: {}, g: g('fist', 0.7, 0.3), t: (tt += 33.3) });
const afterJump = ev.filter((e) => e.type === 'move').pop();
ok(dist(afterJump.pos, [0.7, 0.3]) < 0.01, 'a hand found again far from where it was lost: its place is the new one at once (' + afterJump.pos.map((v) => v.toFixed(3)) + '), not smoothed from the old');
for (let i = 0; i < 2; i++) s4.push({ hand: {}, g: g('other', 0.7, 0.3), t: (tt += 33.3) });
for (let i = 0; i < 4; i++) s4.push({ hand: {}, g: g('open', 0.7, 0.3), t: (tt += 33.3) });
const jumpOpen = ev.find((e) => e.type === 'pose' && e.pose === 'open');
ok(jumpOpen && dist(jumpOpen.aim, [0.7, 0.3]) < 0.01, 'and when it opens, its aim is there, not where the other hand was (' + (jumpOpen && jumpOpen.aim.map((v) => v.toFixed(3))) + ')');

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
