// Turns the tracker's frame-by-frame results into steady events: a pose only counts once it has held for a moment,
// a pinch is the moment thumb and index meet, and a hand that goes out of view leaves with its last place and speed.
//
//   const s = new FlickHandStream({ mirror: true, onEvent(type, e) {} });
//   cam.onResult = (r) => s.push(r);
// events (pos: the palm's centre, 0..1 of the view, mirrored when asked, so it moves the way the hand does):
//   enter { pose, pos }     a hand came into view
//   pose  { pose, from, pos }   it turned 'open' | 'fist' | 'other'
//   pinch { pos }           thumb and index tips met (while the other fingers stay out)
//   move  { pos, pose, size, pinch }   every frame it is seen (pinch: still pinched since the pinch event)
//   leave { pos, vel, pose, edge }  out of view (edge: 'left' | 'right' | 'top' | 'bottom' | null, from where it went)
(function (root) {
  'use strict';
  const HOLD_MS = 90;       // a new pose must last this long (and two frames)
  const GONE_MS = 260;      // and a hand missing this long has left

  class FlickHandStream {
    constructor(opts) {
      this.o = opts || {};
      this.present = false;
      this.pose = 'none';
      this.cand = null;
      this.pos = null;
      this.hist = [];
      this.lastSeen = 0;
      this.pinchArmed = true;
      this.pinchN = 0;
      this.pinchOn = false;
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
      const raw = [x, y];
      // smooth the position a little (more when the hand is still, less when it moves fast)
      if (!this.pos || !this.present) this.pos = raw.slice();
      else {
        const d = Math.hypot(raw[0] - this.pos[0], raw[1] - this.pos[1]);
        const a = Math.min(1, 0.35 + d * 6);
        this.pos = [this.pos[0] + (raw[0] - this.pos[0]) * a, this.pos[1] + (raw[1] - this.pos[1]) * a];
      }
      this.hist.push({ t, x: raw[0], y: raw[1] });
      while (this.hist.length > 2 && t - this.hist[0].t > 300) this.hist.shift();
      this.lastSeen = t;
      this.size = g.size;
      const pose = g.fist ? 'fist' : g.open ? 'open' : 'other';
      if (!this.present) {
        this.present = true;
        this.pose = pose;
        this.cand = null;
        this.pinchArmed = !g.pinch;
        this.pinchOn = false;
        this.emit('enter', { pose, pos: this.pos.slice() });
      } else if (pose !== this.pose) {
        if (!this.cand || this.cand.pose !== pose) this.cand = { pose, t, n: 1 };
        else if (++this.cand.n >= 2 && t - this.cand.t >= HOLD_MS) {
          const from = this.pose;
          this.pose = pose;
          this.cand = null;
          this.emit('pose', { pose, from, pos: this.pos.slice() });
        }
      } else this.cand = null;
      // pinch: armed while thumb and index are apart, fires once when they meet (two frames)
      if (g.pinchGap > 0.45) { this.pinchArmed = true; this.pinchN = 0; this.pinchOn = false; }
      if (this.pose === 'fist') this.pinchOn = false;
      if (g.pinch && this.pinchArmed && this.pose !== 'fist') {
        if (++this.pinchN >= 2) { this.pinchArmed = false; this.pinchN = 0; this.pinchOn = true; this.emit('pinch', { pos: this.pos.slice() }); }
      }
      this.emit('move', { pos: this.pos.slice(), pose: this.pose, size: g.size, pinch: this.pinchOn });
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
      this.hist = [];
      this.pinchOn = false;
      this.emit('leave', { pos: p.slice(), vel, pose, edge, t });
    }

    reset() { this.present = false; this.pose = 'none'; this.cand = null; this.hist = []; this.pos = null; this.pinchOn = false; }
  }

  root.FlickHandStream = FlickHandStream;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlickHandStream;
})(typeof globalThis !== 'undefined' ? globalThis : this);
