'use strict';
// The phone as a media remote (WS 'media'): a small helper presses the media keys, so the player in front and the
// volume react as if the key were on the keyboard: bin/flick-keys.exe on Windows (native/flick-keys.c, SendInput),
// bin/flick-keys on macOS (native/flick-keys-mac.swift, which needs Accessibility permission). One helper, started with
// the first key and started again if it has died; it reads one key name per line and exits when its input closes.
// Linux has no helper of Flick's own: playerctl tells the players what to do (MPRIS), and the sound server's own tool
// changes the volume (see _linux).
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const KEYS = new Set(['play', 'next', 'prev', 'vol-up', 'vol-down', 'mute']);

// a program on the PATH, or null
function which(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch (e) { /* not here */ }
  }
  return null;
}

class MediaKeys {
  /**
   * opts: { exe, log, cmd?: [program, ...args] to run instead of exe (tests: under Wine),
   *   onTrouble?(why): the remote can't work here yet: 'untrusted' (macOS: Accessibility not allowed), 'missing' (no
   *   helper), 'playerctl' (Linux: not installed) }
   */
  constructor(opts) {
    this.exe = opts.exe;
    this.cmd = opts.cmd || null;
    this.log = opts.log || (() => {});
    this.onTrouble = opts.onTrouble || (() => {});
    this.linux = !this.cmd && process.platform === 'linux';
    this.child = null;
    this.recent = [];
    this.starts = [];
    this.pressed = [];        // the last keys passed on (for the test control)
  }

  /** Presses `key` on this PC; false when it can't (helper or playerctl missing, too many at once). */
  press(key) {
    if (!KEYS.has(key)) return false;
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= 20) return false;          // a flood (or a stuck button) isn't passed on
    this.recent.push(now);
    if (this.linux) return this._linux(key);
    const c = this._helper();
    if (!c) return false;
    try { c.stdin.write(key + '\n'); } catch (e) { return false; }
    this.pressed.push(key);
    if (this.pressed.length > 50) this.pressed.shift();
    return true;
  }

  _helper() {
    if (this.child) return this.child;
    const [prog, ...args] = this.cmd || [this.exe];
    if (!this.cmd && (!this.exe || !fs.existsSync(this.exe))) {
      if (!this.warned) { this.warned = true; this.log('media keys: no helper here (' + this.exe + ')'); }
      if (process.platform === 'darwin') this.onTrouble('missing');
      return null;
    }
    // a helper that keeps dying isn't started more than 3 times a minute
    const now = Date.now();
    this.starts = this.starts.filter((t) => now - t < 60000);
    if (this.starts.length >= 3) return null;
    this.starts.push(now);
    let child;
    try { child = spawn(prog, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { this.log('media keys: ' + e.message); return null; }
    this.child = child;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line && !/^sent /.test(line)) this.log('media keys: ' + line.slice(0, 120));
        if (/^untrusted /.test(line)) this.onTrouble('untrusted');      // macOS: Flick isn't allowed to press keys yet
      }
    });
    const gone = () => { if (this.child === child) this.child = null; };
    child.on('error', (e) => { this.log('media keys: ' + e.message); gone(); });
    child.on('exit', (code) => { if (code) this.log('media keys helper exited ' + code); gone(); });
    return child;
  }

  // Linux: play, next and previous through playerctl (the remote needs it); volume and mute through the sound server:
  // wpctl (PipeWire, kept at 100% at most), else pactl (PulseAudio), else the player's own volume (playerctl)
  _linux(key) {
    const now = Date.now();
    if (!this.tools || (!this.tools.playerctl && now - this.tools.at > 60000)) {     // installed meanwhile? look again
      this.tools = { at: now, playerctl: which('playerctl'), wpctl: which('wpctl'), pactl: which('pactl') };
    }
    const t = this.tools;
    if (!t.playerctl) {
      if (!this.warned) { this.warned = true; this.log('media keys: playerctl is not installed'); }
      this.onTrouble('playerctl');
      return false;
    }
    const up = key === 'vol-up';
    let cmd = null, sink = null;
    if (key === 'play') cmd = [t.playerctl, 'play-pause'];
    else if (key === 'next') cmd = [t.playerctl, 'next'];
    else if (key === 'prev') cmd = [t.playerctl, 'previous'];
    else if (t.wpctl) { sink = 'wpctl'; cmd = key === 'mute' ? [t.wpctl, 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'] : [t.wpctl, 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', up ? '5%+' : '5%-']; }
    else if (t.pactl) { sink = 'pactl'; cmd = key === 'mute' ? [t.pactl, 'set-sink-mute', '@DEFAULT_SINK@', 'toggle'] : [t.pactl, 'set-sink-volume', '@DEFAULT_SINK@', up ? '+5%' : '-5%']; }
    else if (key !== 'mute') cmd = [t.playerctl, 'volume', up ? '0.05+' : '0.05-'];
    if (!cmd) return false;
    execFile(cmd[0], cmd.slice(1), { timeout: 4000 }, (err) => {
      if (!err) return;
      // an older wpctl (no -l) or a broken sound server: the next press tries the next tool
      if (sink && t[sink] === cmd[0]) t[sink] = null;
      const what = path.basename(cmd[0]) + ' ' + cmd[1];
      if (what !== this.failed) { this.failed = what; this.log('media keys: ' + what + ' failed: ' + String(err.message).split('\n')[0].slice(0, 120)); }
    });
    this.pressed.push(key);
    if (this.pressed.length > 50) this.pressed.shift();
    return true;
  }

  stop() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch (e) { /* ignore */ } setTimeout(() => { try { c.kill(); } catch (e) { /* ignore */ } }, 2000).unref(); }
  }
}

module.exports = { MediaKeys, KEYS };
