'use strict';
// Keeps the PC app up to date from the GitHub releases of github.com/Maniw1234/flick.
//
// Each release carries flick-app-<version>.zip: this app's own files (code, overlay, panel, and the phone app).
// When a newer one is out, Flick downloads it, checks its SHA-256 against what GitHub reports, unpacks it into
// %LOCALAPPDATA%\Flick\app\<version> and restarts into it (see boot.js). No installer and no admin prompt is needed.
// A release that needs a newer Electron than this install has can't be applied this way; the panel then offers
// the full installer instead.
const core = require('./updatecore');

const API = process.env.FLICK_UPDATE_API || 'https://api.github.com/repos/Maniw1234/flick/releases/latest';

class Updater {
  /**
   * @param {object} o { version: running version, electron: process.versions.electron, fetch: fetch-like, log, root }
   */
  constructor(o) {
    this.version = o.version;
    this.electron = String(o.electron || '');
    this.fetch = o.fetch;
    this.log = o.log || (() => {});
    this.root = o.root || core.updatesRoot();
    this.state = { state: 'idle' };
  }

  async _get(url, accept, maxBytes) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await this.fetch(url, { headers: { Accept: accept, 'User-Agent': 'Flick/' + this.version }, signal: ctl.signal, redirect: 'follow' });
      if (r.status !== 200) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
      const len = +r.headers.get('content-length') || 0;
      if (maxBytes && len > maxBytes) throw new Error('too big');
      const buf = Buffer.from(await r.arrayBuffer());
      if (maxBytes && buf.length > maxBytes) throw new Error('too big');
      return buf;
    } finally { clearTimeout(t); }
  }

  /** Checks GitHub once. Returns the new state: current | ready (restart to apply) | installer | error. */
  async check() {
    let rel;
    try {
      rel = JSON.parse((await this._get(API, 'application/vnd.github+json', 2 * 1024 * 1024)).toString('utf8'));
    } catch (e) {
      return (this.state = { state: e.status === 404 ? 'current' : 'error', why: e.message });
    }
    const ver = String(rel.tag_name || '').replace(/^v/, '');
    if (rel.draft || rel.prerelease || !core.parseVersion(ver)) return (this.state = { state: 'current' });
    if (!core.newer(ver, this.version)) return (this.state = { state: 'current', latest: ver });

    const page = String(rel.html_url || '');
    if (this._bad().includes(ver)) return (this.state = { state: 'error', version: ver, why: 'this version failed to start' });
    const cur = core.readCurrent(this.root);
    if (cur && cur.version === ver && cur.tries < 3 && this.state.state === 'ready') return this.state;  // already waiting for a restart

    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const bundle = assets.find((a) => a && a.name === 'flick-app-' + ver + '.zip');
    if (!bundle) return (this.state = { state: 'installer', version: ver, page });

    // the checksum GitHub computed for the upload (or, failing that, the release's SHA256SUMS file)
    let sum = /^sha256:([0-9a-f]{64})$/i.exec(String(bundle.digest || ''));
    sum = sum ? sum[1].toLowerCase() : null;
    if (!sum) {
      const sums = assets.find((a) => a && a.name === 'SHA256SUMS');
      if (sums) {
        try {
          const txt = (await this._get(sums.browser_download_url, 'application/octet-stream', 64 * 1024)).toString('utf8');
          const m = new RegExp('^([0-9a-f]{64})\\s+\\*?' + bundle.name.replace(/[.]/g, '\\.') + '\\s*$', 'mi').exec(txt);
          if (m) sum = m[1].toLowerCase();
        } catch (e) { /* no checksum: refused below */ }
      }
    }
    if (!sum) return (this.state = { state: 'error', version: ver, why: 'no checksum' });

    let buf;
    try {
      buf = await this._get(bundle.browser_download_url, 'application/octet-stream', 80 * 1024 * 1024);
    } catch (e) {
      return (this.state = { state: 'error', version: ver, why: 'download ' + e.message });
    }
    if (core.sha256(buf) !== sum || (bundle.size && buf.length !== bundle.size)) return (this.state = { state: 'error', version: ver, why: 'checksum' });

    let meta;
    try {
      const files = core.unzipAll(buf);
      const pkg = files.find((f) => f.name === 'package.json');
      meta = pkg ? JSON.parse(pkg.data.toString('utf8')) : {};
    } catch (e) {
      return (this.state = { state: 'error', version: ver, why: 'bundle ' + e.message });
    }
    // code built for a different Electron runtime needs the full installer
    const need = String(meta.flickElectron || '');
    if (need && this.electron && need.split('.')[0] !== this.electron.split('.')[0]) return (this.state = { state: 'installer', version: ver, page });

    try {
      const r = core.installBundle(this.root, ver, buf);
      core.writeCurrent(this.root, { version: ver, dir: r.dir, tries: 0, sha256: sum });
      this.log('update', ver, 'ready', r.files, 'files');
    } catch (e) {
      return (this.state = { state: 'error', version: ver, why: 'install ' + e.message });
    }
    return (this.state = { state: 'ready', version: ver, page });
  }

  _bad() {
    try { const b = JSON.parse(require('fs').readFileSync(require('path').join(this.root, 'bad.json'), 'utf8')); return Array.isArray(b) ? b : []; } catch (e) { return []; }
  }

  /** The running version started fine: stop counting failed starts, and tidy up old copies. */
  markHealthy(boot) {
    try {
      const cur = core.readCurrent(this.root);
      if (boot && boot.dir && cur && cur.dir === boot.dir) {
        if (cur.tries) { cur.tries = 0; core.writeCurrent(this.root, cur); }
        core.pruneUpdates(this.root, [cur.dir, 'bad.json']);
      } else if (!cur || !core.newer(cur.version, this.version) || cur.tries >= 3) {
        // the installed copy is newest (or the update kept failing): downloaded copies aren't needed
        if (cur && cur.tries >= 3) {
          // never retry a version that couldn't start; a newer release will be tried normally
          const bad = this._bad().concat(cur.version).slice(-20);
          require('fs').writeFileSync(require('path').join(this.root, 'bad.json'), JSON.stringify(bad));
          this.log('update', cur.version, 'failed to start, skipped');
        }
        core.pruneUpdates(this.root, ['bad.json']);
        if (cur) require('fs').rmSync(require('path').join(this.root, 'current.json'), { force: true });
      }
    } catch (e) { this.log('update tidy failed', e.message); }
  }
}

module.exports = { Updater, API };
