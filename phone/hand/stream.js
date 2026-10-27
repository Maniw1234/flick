// Turns the tracker's frame-by-frame results into steady events: a pose only counts once it has held for a moment,
// a pinch is the moment thumb and index meet, and a hand that goes out of view leaves with its last place and speed.
//
//   const s = new FlickHandStream({ mirror: true, onEvent(type, e) {} });
//   cam.onResult = (r) => s.push(r);
// events (pos: the palm's centre, 0..1 of the view, mirrored when asked, so it moves the way the hand does):
//   enter { pose, pos }     a hand came into view
//   pose  { pose, from, pos, aim }   it turned 'open' | 'fist' | 'other'
//   pinch { pos }           thumb and index tips met (while the other fingers stay out)
//   move  { pos, pose, raw, aim, size, pinch }   every frame it is seen (pinch: still pinched since the pinch event)
//   leave { pos, vel, pose, edge }  out of view (edge: 'left' | 'right' | 'top' | 'bottom' | null, from where it went)
//
// Aiming. A hand that closes or opens moves a little as it does (and so does the tracker's idea of its palm): what it
// was aimed at is where it was just before. aim, on a pose event, is where the hand was in its last frame of the pose
// it left (a fist closing: the last open frame; a fist opening: the last fist frame); on a move, while the pose is
// changing (raw, this frame's own pose, differs from pose), where it was before the change began; else pos.
// The position is smoothed with a One Euro filter: still hands don't shake, quick ones don't lag.
(function (root) {
  'use strict';
  const HOLD_MS = 80;       // a new pose must last this long (and two frames)
  const GONE_MS = 240;      // and a hand missing this long has left
  const AIM_MS = 700;       // how old the place before a change may be and still count as the aim

  // One Euro filter (Casiez, Roussel, Vogel 2012) for one coordinate, in view units (0..1) and seconds
  const MIN_CUTOFF = 0.8;   // Hz: how smooth a still hand is
  const BETA = 8;           // how much less smoothing a moving one gets
  const D_CUTOFF = 1.2;     // Hz: the speed's own smoothing
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  class Euro {
    constructor() { this.x = null; this.dx = 0; }
    reset() { this.x = null; this.dx = 0; }
    next(x, dt) {
      if (this.x === null || !(dt > 0)) { this.x = x; this.dx = 0; return x; }
      const dx = (x - this.x) / dt;
      this.dx += (dx - this.dx) * alpha(D_CUTOFF, dt);
      this.x += (x - this.x) * alpha(MIN_CUTOFF + BETA * Math.abs(this.dx), dt);
      return this.x;
    }
  }

  class FlickHandStream {
    constructor(opts) {
      this.o = opts || {};
      this.present = false;
      this.pose = 'none';
      this.cand = null;
      this.pos = null;
      this.hist = [];
      this.lastSeen = 0;
      this.lastT = 0;
      this.pinchArmed = true;
      this.pinchN = 0;
      this.pinchOn = false;
      this.fx = new Euro();
      this.fy = new Euro();
      this.size = 0;
      this.steady = {};       // pose -> { pos, t }: the last frame that pose was both seen and settled
      this.changeFrom = null; // { pos, t }: where the hand was when the pose it holds began to change
    }

    emit(type, e) { if (this.o.onEvent) try { this.o.onEvent(type, e); } catch (err) { /* ignore */ } }

    // r: { hand, g, t }; with no result for a while, call push({ t }) so a hand can still leave
    push(r) {
      const t = r.t || performance.now();
      if (!r.hand || !r.g) {
        if (this.present && t - this.lastSeen > GONE_MS) this._leave(t);
        return;
      }
      const g = r.g;
      let x = g.center[0], y = g.center[1];
      if (this.o.mirror) x = 1 - x;
      const fresh = !this.pos || !this.present;
      if (fresh) { this.fx.reset(); this.fy.reset(); this.steady = {}; this.changeFrom = null; }
      const dt = fresh ? 0 : Math.min(0.25, Math.max(0.001, (t - this.lastT) / 1000));
      this.pos = [this.fx.next(x, dt), this.fy.next(y, dt)];
      this.size = fresh || !this.size ? g.size : this.size + (g.size - this.size) * alpha(2, dt);
      this.hist.push({ t, x, y });
      while (this.hist.length > 2 && t - this.hist[0].t > 300) this.hist.shift();
      this.lastSeen = this.lastT = t;
      const raw = g.fist ? 'fist' : g.open ? 'open' : 'other';
      if (!this.present) {
        this.present = true;
        this.pose = raw;
        this.cand = null;
        this.pinchArmed = !g.pinch;
        this.pinchOn = false;
        this.steady[raw] = { pos: this.pos.slice(), t };
        this.emit('enter', { pose: raw, pos: this.pos.slice() });
      } else if (raw !== this.pose) {
        // the pose is changing: keep where it was before the change began (the frames of the change don't move it)
        if (!this.changeFrom) this.changeFrom = this.steady[this.pose] && t - this.steady[this.pose].t < AIM_MS ? this.steady[this.pose] : { pos: this.pos.slice(), t };
        if (!this.cand || this.cand.pose !== raw) this.cand = { pose: raw, t, n: 1 };
        else if (++this.cand.n >= 2 && t - this.cand.t >= HOLD_MS) {
          const from = this.pose;
          // aimed: a fist that closed, where the hand last was open; a fist that opened, where it last was a fist (else
          // where this change began)
          const recent = (s) => (s && t - s.t < AIM_MS ? s : null);
          const before = recent(raw === 'fist' ? this.steady.open : raw === 'open' ? this.steady.fist : null) || recent(this.changeFrom);
          const aim = before ? before.pos.slice() : this.pos.slice();
          this.pose = raw;
          this.cand = null;
          this.changeFrom = null;
          this.steady[raw] = { pos: this.pos.slice(), t };
          this.emit('pose', { pose: raw, from, pos: this.pos.slice(), aim });
        }
      } else {
        this.cand = null;
        this.changeFrom = null;
        this.steady[raw] = { pos: this.pos.slice(), t };
      }
      // pinch: armed while thumb and index are apart, fires once when they meet (two frames)
      if (g.pinchGap > 0.45) { this.pinchArmed = true; this.pinchN = 0; this.pinchOn = false; }
      if (this.pose === 'fist') this.pinchOn = false;
      if (g.pinch && this.pinchArmed && this.pose !== 'fist') {
        if (++this.pinchN >= 2) { this.pinchArmed = false; this.pinchN = 0; this.pinchOn = true; this.emit('pinch', { pos: this.pos.slice() }); }
      }
      const aim = this.changeFrom ? this.changeFrom.pos.slice() : this.pos.slice();
      this.emit('move', { pos: this.pos.slice(), pose: this.pose, raw, aim, size: this.size, pinch: this.pinchOn });
    }

    velocity() {
      const h = this.hist;
      if (h.length < 2) return [0, 0];
      const a = h[0], b = h[h.length - 1];
      const dt = Math.max(30, b.t - a.t);
      return [(b.x - a.x) / dt * 1000, (b.y - a.y) / dt * 1000];  // view widths per second
    }

    _leave(t) {
      const vel = this.velocity();
      const p = this.pos || [0.5, 0.5];
      // where it left: the nearest edge, if it was close to one or heading for one
      const ex = p[0] + vel[0] * 0.15, ey = p[1] + vel[1] * 0.15;
      const d = { left: ex, right: 1 - ex, top: ey, bottom: 1 - ey };
      let edge = null, best = 0.22;
      for (const k in d) if (d[k] < best) { best = d[k]; edge = k; }
      const pose = this.pose;
      this.present = false;
      this.pose = 'none';
      this.cand = null;
      this.changeFrom = null;
      this.hist = [];
      this.pinchOn = false;
      this.emit('leave', { pos: p.slice(), vel, pose, edge, t });
    }

    reset() { this.present = false; this.pose = 'none'; this.cand = null; this.changeFrom = null; this.hist = []; this.pos = null; this.pinchOn = false; this.steady = {}; }
  }

  root.FlickHandStream = FlickHandStream;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlickHandStream;
})(typeof globalThis !== 'undefined' ? globalThis : this);
