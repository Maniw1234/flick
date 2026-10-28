// Turns the tracker's frame-by-frame results into steady events: a pose only counts once it has held for a moment,
// a pinch is the moment thumb and index meet, and a hand that goes out of view leaves with its last place and speed.
//
//   const s = new FlickHandStream({ mirror: true, onEvent(type, e) {} });
//   cam.onResult = (r) => s.push(r);
// events (pos: the palm's centre, 0..1 of the view, mirrored when asked, so it moves the way the hand does):
//   enter { pose, pos }     a hand came into view (pose: its first frame's, not settled yet)
//   pose  { pose, from, pos, aim }   it turned 'open' | 'fist' | 'other'
//   pinch { pos }           thumb and index tips met (while the other fingers stay out)
//   move  { pos, pose, raw, aim, size, pinch }   every frame it is seen (raw: this frame's own pose; pinch: still
//                           pinched since the pinch event)
//   leave { pos, vel, pose, raw, aim, edge }  out of view (raw: its last frame's own pose, so a fist lost while it
//                           opened says 'open'; edge: 'left' | 'right' | 'top' | 'bottom' | null, where it went out: an
//                           edge it was at, or one it was heading out of fast)
//
// Aiming. A hand moves a little as it closes or opens (and so does the tracker's idea of its palm): what it was aimed at
// is where it was just before. aim is where it was in the last frame of the pose it is leaving (a fist closing: its
// last open frame; opening: its last fist frame), also through a half-way pose ('other') between the two, as long as
// that was recent and the hand hasn't moved since further than a hand drifts while it closes. A hand that travels half
// closed aims where it got to (where its last change began). Otherwise aim is pos.
// The position is smoothed with a One Euro filter: still hands don't shake, quick ones don't lag. A hand found again far
// from where the tracker lost it (another hand, or one that moved fast) starts afresh: no smoothing or aim across that.
(function (root) {
  'use strict';
  const HOLD_MS = 80;       // a new pose must last this long (and two frames)
  const GONE_MS = 240;      // and a hand missing this long has left
  const AIM_MS = 1200;      // how old the place before a change may be and still count as the aim
  // distances in view units, against the hand's size (wrist to the middle finger's knuckle): how far a hand drifts while
  // it closes or opens; how far from where it was lost a hand found again is another one (or one that moved fast)
  const drift = (size) => Math.max(0.04, Math.min(0.15, size * 0.5));
  const jump = (size) => Math.max(0.1, Math.min(0.2, size));

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
      this.raw = 'none';      // the last frame's own pose
      this.cand = null;
      this.pos = null;
      this.at = null;         // where the tracker last saw it (not smoothed)
      this.lost = 0;          // frames the tracker looked at without finding it, since it was last seen
      this.hist = [];
      this.lastSeen = 0;
      this.lastT = 0;
      this.pinchArmed = true;
      this.pinchN = 0;
      this.pinchOn = false;
      this.fx = new Euro();
      this.fy = new Euro();
      this.size = 0;
      this.aim = null;        // the last move's aim
      this.steady = {};       // pose -> { pos, t }: the last frame that pose was both seen and settled
      this.changeFrom = null; // { pos, t }: where the hand was when the pose it holds began to change
      this.left = null;       // { pose, pos, t }: the last frame of the last open or fist pose the hand left
    }

    emit(type, e) { if (this.o.onEvent) try { this.o.onEvent(type, e); } catch (err) { /* ignore */ } }

    // a place from before ({ pos, t }) still counts as the aim: recent, and the hand hasn't moved far from it since
    _fits(s, t) {
      return !!s && t - s.t < AIM_MS && Math.hypot(s.pos[0] - this.pos[0], s.pos[1] - this.pos[1]) <= drift(this.size);
    }

    // where the hand aims: from is the pose it holds (settled), to the one it is turning to (pose events only)
    _aimOf(t, from, to) {
      const L = this.left;
      // half way between (a slow close or open): where it last was the other way, unless that's the way it turns back
      if (from === 'other' && L && L.pose !== to && this._fits(L, t)) return L.pos.slice();
      // where the change began
      if (this.changeFrom && this._fits(this.changeFrom, t)) return this.changeFrom.pos.slice();
      return this.pos.slice();
    }

    // r: { hand, g, t, detected }; with no result for a while, call push({ t }) so a hand can still leave
    push(r) {
      const t = r.t || performance.now();
      if (!r.hand || !r.g) {
        if (this.present && r.hand === null) this.lost++;          // the tracker looked and didn't find it
        if (this.present && t - this.lastSeen > GONE_MS) this._leave(t);
        return;
      }
      const g = r.g;
      let x = g.center[0], y = g.center[1];
      if (this.o.mirror) x = 1 - x;
      // found again (after frames without it, or by looking afresh), far from where it was: another hand, or one that
      // moved fast. Either way it starts afresh here: no smoothing across the gap, no aim from before it
      const jumped = this.present && !!this.at && (this.lost > 0 || !!r.detected) &&
        Math.hypot(x - this.at[0], y - this.at[1]) > jump(this.size || g.size || 0);
      this.lost = 0;
      this.at = [x, y];
      const fresh = !this.pos || !this.present || jumped;
      if (fresh) { this.fx.reset(); this.fy.reset(); this.steady = {}; this.changeFrom = null; this.left = null; this.hist = []; }
      const dt = fresh ? 0 : Math.min(0.25, Math.max(0.001, (t - this.lastT) / 1000));
      this.pos = [this.fx.next(x, dt), this.fy.next(y, dt)];
      this.size = fresh || !this.size ? g.size : this.size + (g.size - this.size) * alpha(2, dt);
      this.hist.push({ t, x, y });
      while (this.hist.length > 2 && t - this.hist[0].t > 300) this.hist.shift();
      this.lastSeen = this.lastT = t;
      const raw = g.fist ? 'fist' : g.open ? 'open' : 'other';
      this.raw = raw;
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
          const aim = this._aimOf(t, from, raw);
          // the last frame of an open hand or a fist it leaves: a half-way pose after it still aims there
          if (from !== 'other') this.left = { pose: from, pos: this.changeFrom.pos.slice(), t: this.changeFrom.t };
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
      this.aim = this._aimOf(t, this.pose, null);
      this.emit('move', { pos: this.pos.slice(), pose: this.pose, raw, aim: this.aim.slice(), size: this.size, pinch: this.pinchOn });
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
      const q = this.at || p;
      // where it went out: an edge it was at (the tracker loses a hand once its palm reaches the edge), or one it was
      // heading out of fast enough to be past it now. A hand lost elsewhere (the tracker missed it) has no edge.
      const near = Math.max(0.05, Math.min(0.16, (this.size || 0.15) * 0.55));
      const at = { left: q[0], right: 1 - q[0], top: q[1], bottom: 1 - q[1] };
      const out = { left: -vel[0], right: vel[0], top: -vel[1], bottom: vel[1] };   // its speed toward each edge
      let edge = null, best = Infinity;
      for (const k in at) {
        const ahead = at[k] - Math.max(0, out[k]) * 0.15;                          // 150 ms on
        if ((at[k] < near || (ahead < near * 0.5 && out[k] > 0.3)) && ahead < best) { best = ahead; edge = k; }
      }
      const pose = this.pose, raw = this.raw;
      const aim = this.aim ? this.aim.slice() : p.slice();
      this.present = false;
      this.pose = 'none';
      this.raw = 'none';
      this.cand = null;
      this.changeFrom = null;
      this.left = null;
      this.aim = null;
      this.hist = [];
      this.lost = 0;
      this.pinchOn = false;
      this.emit('leave', { pos: p.slice(), vel, pose, raw, aim, edge, t });
    }

    reset() {
      this.present = false; this.pose = 'none'; this.raw = 'none'; this.cand = null; this.changeFrom = null; this.left = null;
      this.aim = null; this.hist = []; this.pos = null; this.at = null; this.lost = 0; this.pinchOn = false; this.steady = {};
    }
  }

  root.FlickHandStream = FlickHandStream;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlickHandStream;
})(typeof globalThis !== 'undefined' ? globalThis : this);
