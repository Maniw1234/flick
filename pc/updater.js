'use strict';
// Keeps the PC app up to date from the GitHub releases of github.com/Maniw1234/flick.
//
// Each release carries flick-app-<version>.zip: this app's own files (code, overlay, panel, and the phone app), and
// flick-app-mac-<version>.zip and flick-app-linux-<version>.zip with the Mac's and Linux's own helpers.
// When a newer one is out, Flick downloads its system's bundle, checks its SHA-256 against the release's SHA256SUMS,
// unpacks it into the per-user update folder (%LOCALAPPDATA%\Flick\app\<version> on Windows, see
// updatecore.updatesRoot) and restarts into it (see boot.js). No installer and no admin prompt is needed.
// A release that needs a newer Electron than this install has can't be applied this way; the panel then offers
// the full installer instead.
//
// Nothing in a release is trusted until its SHA256SUMS carries a valid SHA256SUMS.sig, made with Flick's offline
// release key (signing/sign_release.js): GitHub never holds that key, so a hijacked account can't ship an update.
// A release that isn't signed (yet) is skipped quietly and checked again later.
const core = require('./updatecore');

const API = process.env.FLICK_UPDATE_API || 'https://api.github.com/repos/Maniw1234/flick/releases/latest';
const TAGS = API.replace(/\/latest$/, '/tags/');   // one release by its tag: TAGS + 'v1.0.0'

class Updater {
  /**
   * @param {object} o { version: running version, electron: process.versions.electron, fetch: fetch-like, log, root,
   *   keys: trusted release keys (tests only; Flick's own when left out) }
   */
  constructor(o) {
    this.version = o.version;
    this.electron = String(o.electron || '');
    this.fetch = o.fetch;
    this.log = o.log || (() => {});
    this.root = o.root || core.updatesRoot();
    this.keys = o.keys || core.RELEASE_KEYS;
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

  /**
   * A release's SHA256SUMS, if Flick's release key signed it for this version: { ok: true, sums, sig, list } or
   * { ok: false, why, unsigned } (unsigned: there's no valid signature, as opposed to a failed download).
   */
  async _proof(ver, assets) {
    const sa = assets.find((a) => a && a.name === 'SHA256SUMS');
    const ga = assets.find((a) => a && a.name === 'SHA256SUMS.sig');
    if (!sa || !ga) return { ok: false, unsigned: true, why: 'not signed' };
    let sums, sig;
    try {
      sums = await this._get(sa.browser_download_url, 'application/octet-stream', 64 * 1024);
      sig = (await this._get(ga.browser_download_url, 'application/octet-stream', 4096)).toString('utf8');
    } catch (e) {
      return { ok: false, why: 'signature download ' + e.message };
    }
    if (!core.verifyRelease(ver, sums, sig, this.keys)) return { ok: false, unsigned: true, why: 'bad signature' };
    const list = core.parseSums(sums.toString('utf8'));
    if (!list) return { ok: false, unsigned: true, why: 'bad SHA256SUMS' };
    return { ok: true, sums, sig, list };
  }

  /** The signed SHA256SUMS of one release (this PC's own, for the phones): { sums, sig, list } or null. */
  async releaseProof(ver) {
    try {
      const rel = JSON.parse((await this._get(TAGS + 'v' + ver, 'application/vnd.github+json', 2 * 1024 * 1024)).toString('utf8'));
      const p = await this._proof(ver, Array.isArray(rel.assets) ? rel.assets : []);
      return p.ok ? p : null;
    } catch (e) { return null; }
  }

  /** Checks GitHub once. Returns the new state: current | ready (restart to apply) | installer | unsigned | error. */
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
    // the signature first: nothing else in the release counts without it
    const proof = await this._proof(ver, assets);
    if (!proof.ok) {
      if (proof.unsigned) this.log('update', ver, 'skipped:', proof.why);   // main.js logs errors itself
      return (this.state = { state: proof.unsigned ? 'unsigned' : 'error', version: ver, why: proof.why });
    }
    const bundle = assets.find((a) => a && a.name === core.bundleName(ver));
    if (!bundle) return (this.state = { state: 'installer', version: ver, page });

    // the checksum the signed SHA256SUMS gives; GitHub's own for the upload (if it reports one) must agree
    const sum = proof.list.get(bundle.name);
    if (!sum) return (this.state = { state: 'unsigned', version: ver, why: 'bundle not in SHA256SUMS' });
    const gh = /^sha256:([0-9a-f]{64})$/i.exec(String(bundle.digest || ''));
    if (gh && gh[1].toLowerCase() !== sum) return (this.state = { state: 'error', version: ver, why: 'checksum' });

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
      // the signed SHA256SUMS stays with this version: it lets phones trust the phone app inside (see main.js)
      core.writeProof(require('path').join(this.root, r.dir), proof);
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

module.exports = { Updater, API, TAGS };
