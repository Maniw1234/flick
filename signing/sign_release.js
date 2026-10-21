#!/usr/bin/env node
'use strict';
// Signs a published Flick release with Flick's offline release key, so installed copies (PC and phone) accept it.
//
//   node signing/sign_release.js <version> [--key <pem>] [--repo Maniw1234/flick] [--dry-run] [--via-workflow]
//
// Downloads the release's SHA256SUMS and every file it lists, checks each one's SHA-256 (and that nothing on the
// release is missing from SHA256SUMS) and that flick-app-<version>.zip really is that version, then signs
//   "flick-release-v1\nversion <version>\n" followed by SHA256SUMS exactly as published
// (ECDSA P-256 with SHA-256, DER, base64) and uploads that as SHA256SUMS.sig. A release that already has a
// SHA256SUMS.sig is only checked. --dry-run does everything except the upload.
// Where a file can't be uploaded from (a network that lets only JSON requests through, like Claude's workspace), the
// signature goes to GitHub as text instead: the "Attach release signature" workflow (.github/workflows/
// attach-signature.yml) checks it against the release key and attaches it. --via-workflow goes that way directly.
//
// Needs gh, signed in with write access to the repository (REST calls only). The key is a PKCS#8 PEM file, by default
// $FLICK_KEYS/flick-update-key.pem (FLICK_KEYS defaults to /home/claude/tools/keys). Keep it offline: GitHub must never
// see it, or the signature would protect nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const core = require('../pc/updatecore');
const { findEntry, parseManifest } = require('../pc/apkinfo');

const USAGE = 'usage: node signing/sign_release.js <version> [--key <pem>] [--repo owner/name] [--dry-run] [--via-workflow]';
function die(msg) { console.error('sign_release: ' + msg); process.exit(1); }

const opt = { key: path.join(process.env.FLICK_KEYS || '/home/claude/tools/keys', 'flick-update-key.pem'), repo: 'Maniw1234/flick', dry: false };
let version = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opt.dry = true;
  else if (a === '--via-workflow') opt.viaWorkflow = true;
  else if (a === '--key' || a === '--repo') { if (i + 1 >= argv.length) die(USAGE); opt[a.slice(2)] = argv[++i]; }
  else if (!version && !a.startsWith('-')) version = a.replace(/^v/, '');
  else die(USAGE);
}
if (!version || !core.parseVersion(version)) die(USAGE);
if (!/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) die('--repo must look like owner/name');
// the keys the apps trust (pc/updatecore.js; the Java copy is in android/.../Updater.java); tests swap in their own
const TRUSTED = process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : core.RELEASE_KEYS;

const GH = process.env.FLICK_GH || 'gh';   // tests point this at a stand-in for gh
function gh(args) {
  try {
    return execFileSync(GH, ['api', ...args], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die('gh api ' + args.filter((x) => !x.startsWith('-') && !x.includes(':')).join(' ') + ' failed: ' + String(e.stderr || e.message).trim());
  }
}
const release = () => JSON.parse(gh([`repos/${opt.repo}/releases/tags/v${version}`]).toString('utf8'));
const download = (asset) => gh(['-H', 'Accept: application/octet-stream', `repos/${opt.repo}/releases/assets/${asset.id}`]);

// ---- the key: one the apps trust, or everything it signs would be refused anyway
let key;
try { key = crypto.createPrivateKey(fs.readFileSync(opt.key)); } catch (e) { die("can't read the release key " + opt.key + ' (' + e.code + ')'); }
if (key.asymmetricKeyType !== 'ec' || (key.asymmetricKeyDetails || {}).namedCurve !== 'prime256v1') die(opt.key + ' is not an ECDSA P-256 key');
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
if (!TRUSTED.includes(pub)) die(opt.key + " isn't a release key Flick trusts (RELEASE_KEYS in pc/updatecore.js)");

// ---- the release and every file SHA256SUMS lists
const rel = release();
const assets = Array.isArray(rel.assets) ? rel.assets : [];
const byName = new Map(assets.map((a) => [a.name, a]));
console.log(`v${version} of ${opt.repo}: ${assets.length} files`);
if (!byName.has('SHA256SUMS')) die(`v${version} has no SHA256SUMS`);
const sums = download(byName.get('SHA256SUMS'));
const list = core.parseSums(sums.toString('utf8'));
if (!list || !list.size) die("SHA256SUMS doesn't parse");
for (const a of assets) if (a.name !== 'SHA256SUMS' && a.name !== 'SHA256SUMS.sig' && !list.has(a.name)) die(`${a.name} is on the release but not in SHA256SUMS`);
const files = new Map();
for (const [name, want] of list) {
  const a = byName.get(name);
  if (!a) die(`${name} is in SHA256SUMS but not on the release`);
  const buf = download(a);
  const got = core.sha256(buf);
  if (got !== want) die(`${name}: its SHA-256 is ${got}, SHA256SUMS says ${want}`);
  const d = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
  if ((d && d[1].toLowerCase() !== want) || (a.size && a.size !== buf.length)) die(`${name}: GitHub's size or digest doesn't match SHA256SUMS`);
  files.set(name, buf);
  console.log(`  ok ${name} (${buf.length} bytes, sha256 ${got.slice(0, 16)}…)`);
}

// ---- the Windows bundle is this version (installed PCs update to it), and each phone app is the version its name says
const bundleName = `flick-app-${version}.zip`;
if (!files.has(bundleName)) die(`${bundleName} isn't in SHA256SUMS`);
let pkg = null;
try { pkg = JSON.parse(core.unzipAll(files.get(bundleName)).find((f) => f.name === 'package.json').data.toString('utf8')); } catch (e) { die(`${bundleName} has no readable package.json`); }
if (pkg.version !== version) die(`${bundleName} holds version ${pkg.version}, not ${version}`);
console.log(`  ok ${bundleName} is Flick ${pkg.version}`);
for (const [name, buf] of files) {
  const m = /^Flick-(\d+\.\d+\.\d+)\.apk$/.exec(name);
  if (!m) continue;
  let info = null;
  try { info = parseManifest(findEntry(buf, 'AndroidManifest.xml')); } catch (e) { /* refused below */ }
  if (!info || info.package !== 'com.flick.app' || info.versionName !== m[1]) die(`${name} isn't Flick's phone app ${m[1]}`);
  console.log(`  ok ${name} is com.flick.app ${info.versionName} (${info.versionCode})`);
}

// ---- sign (or check the signature that is already there)
const old = byName.get('SHA256SUMS.sig');
if (old) {
  if (core.verifyRelease(version, sums, download(old).toString('utf8'), TRUSTED)) { console.log(`v${version} is already signed, and its SHA256SUMS.sig is valid`); process.exit(0); }
  die(`v${version} already has a SHA256SUMS.sig and it is NOT valid for this SHA256SUMS. Nothing was changed; find out how it got there before you do anything else.`);
}
const sig = crypto.sign('sha256', core.releaseMessage(version, sums), { key, dsaEncoding: 'der' }).toString('base64') + '\n';
if (!core.verifyRelease(version, sums, sig, TRUSTED)) die("the new signature doesn't verify");
if (opt.dry) { console.log(`dry run: v${version} checks out and the signature verifies; nothing was uploaded`); process.exit(0); }

// ---- attach it: straight to the release, or as text through the "Attach release signature" workflow
function tryGh(args) {
  try { return { ok: true, out: execFileSync(GH, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message).trim() }; }
}
let direct = { ok: false, err: 'skipped (--via-workflow)' };
if (!opt.viaWorkflow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flick-sig-'));
  const file = path.join(dir, 'SHA256SUMS.sig');
  fs.writeFileSync(file, sig);
  try {
    direct = tryGh(['api', '--method', 'POST', '-H', 'Content-Type: application/octet-stream', '--input', file,
      `https://uploads.github.com/repos/${opt.repo}/releases/${rel.id}/assets?name=SHA256SUMS.sig`]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (!direct.ok) {
  console.log('direct upload: ' + direct.err.split('\n')[0] + '\nattaching it through the "Attach release signature" workflow instead');
  const run = tryGh(['workflow', 'run', 'attach-signature.yml', '--repo', opt.repo, '-f', 'version=' + version, '-f', 'sig=' + sig.trim()]);
  if (!run.ok) die("couldn't start the workflow: " + run.err);
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = Date.now() + 15 * 60 * 1000;
  let seen = null;
  while (!seen && Date.now() < until) { nap(10000); seen = (release().assets || []).find((a) => a.name === 'SHA256SUMS.sig'); }
  if (!seen) die("the workflow didn't attach SHA256SUMS.sig within 15 minutes: see Actions > Attach release signature");
}
// read it back from the release, the way installed copies will see it
const up = (release().assets || []).find((a) => a.name === 'SHA256SUMS.sig');
if (!up || !core.verifyRelease(version, sums, download(up).toString('utf8'), TRUSTED)) die('the upload finished, but the release has no valid SHA256SUMS.sig');
console.log(`signed v${version}: SHA256SUMS.sig is on the release and verifies`);
