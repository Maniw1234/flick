#!/usr/bin/env node
'use strict';
// Signs a published Flick release with Flick's offline release key, so installed copies (PC and phone) accept it.
//
//   node signing/sign_release.js <version> [--key <pem>] [--repo Maniw1234/flick] [--commit <rev>] [--signer <jar>]
//                                          [--dry-run] [--via-workflow]
//
// Run it in your own checkout, on the commit you pushed for this release (or name that commit with --commit). Installed
// PCs run whatever a signed release holds, so the signature is only worth what is checked before it, against that
// commit as it is here (never against what GitHub says it is):
// - the release's tag on GitHub is that commit;
// - SHA256SUMS lists exactly the files the release workflow publishes, each of them matches it, and nothing else is
//   on the release;
// - every file of the three app bundles (flick-app-<version>.zip, flick-app-mac-<version>.zip and
//   flick-app-linux-<version>.zip: what installed PCs update themselves with) is that commit's, byte for byte, as the
//   build scripts copy them; package.json only gains what the build adds (flickElectron), and besides them there is
//   only what the build makes: the native helpers (bin/) and the phone app;
// - each native helper is one you have vouched for: its SHA-256 is in signing/helpers.sha256 as this checkout has it
//   (GitHub builds them from native/; every Windows PC and Mac that updates runs them);
// - the phone app (Flick-<its version>.apk) is com.flick.app, signed with Flick's own key and nothing else
//   (FlickVerify.java, run with uber-apk-signer 1.3.0's apksig as CI runs it, against expected-signature.txt; no v1 or
//   v2 signature); its page (assets/www) is the commit's phone/ byte for byte as build_apk.sh packs it; it was either
//   built for this release (its versionName and versionCode are the release's) or is the phone app an earlier release
//   you signed carries, unchanged since (android/, phone/ and build_apk.sh the same as at that release's commit); every
//   bundle carries that same file.
// What can't be checked against the source this way is still trusted as GitHub built it: the installers and disk
// images (Flick-Setup.exe, the .dmg files, the AppImage and the tar.gz) and the phone app's compiled code (Java,
// resources), which CI signs with the FLICK_SIGNING_KEY secret.
// Then it signs
//   "flick-release-v1\nversion <version>\n" followed by SHA256SUMS exactly as published
// (ECDSA P-256 with SHA-256, DER, base64) and uploads that as SHA256SUMS.sig. A release that already has a
// SHA256SUMS.sig is only checked. --dry-run does everything except the upload.
// Where a file can't be uploaded from (a network that lets only JSON requests through), the
// signature goes to GitHub as text instead: the "Attach release signature" workflow (.github/workflows/
// attach-signature.yml) checks it against the release key and attaches it. --via-workflow goes that way directly.
//
// Needs git, Java 11 or newer, uber-apk-signer.jar 1.3.0 (--signer, else $SIGNER, else $FLICK_TOOLS/uber-apk-signer.jar
// with FLICK_TOOLS defaulting to ~/flick-tools) and gh, signed in with write access to the repository (REST only).
// The key is a PKCS#8 PEM file, by default $FLICK_KEYS/flick-update-key.pem (FLICK_KEYS defaults to ~/flick-keys).
// Keep it offline: GitHub must never see it, or the signature would protect nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const core = require('../pc/updatecore');
const { findEntry, parseManifest } = require('../pc/apkinfo');

const USAGE = 'usage: node signing/sign_release.js <version> [--key <pem>] [--repo owner/name] [--commit <rev>] [--signer <jar>] [--dry-run] [--via-workflow]';
function die(msg) { console.error('sign_release: ' + msg); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
const TOOLS = process.env.FLICK_TOOLS || path.join(os.homedir(), 'flick-tools');
const opt = {
  key: path.join(process.env.FLICK_KEYS || path.join(os.homedir(), 'flick-keys'), 'flick-update-key.pem'), repo: 'Maniw1234/flick', dry: false,
  commit: 'HEAD', signer: process.env.SIGNER || path.join(TOOLS, 'uber-apk-signer.jar'),
};
let version = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opt.dry = true;
  else if (a === '--via-workflow') opt.viaWorkflow = true;
  else if (a === '--key' || a === '--repo' || a === '--commit' || a === '--signer') { if (i + 1 >= argv.length) die(USAGE); opt[a.slice(2)] = argv[++i]; }
  else if (!version && !a.startsWith('-')) version = a.replace(/^v/, '');
  else die(USAGE);
}
if (!version || !core.parseVersion(version)) die(USAGE);
if (!/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) die('--repo must look like owner/name');
// the keys the apps trust (pc/updatecore.js; the Java copy is in android/.../Updater.java); tests swap in their own
const TRUSTED = process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : core.RELEASE_KEYS;
// uber-apk-signer 1.3.0, as .github/workflows/release.yml pins it: the phone app's signature is checked with its apksig
const SIGNER_SHA256 = 'e1299fd6fcf4da527dd53735b56127e8ea922a321128123b9c32d619bba1d835';

const GH = process.env.FLICK_GH || 'gh';   // tests point this at a stand-in for gh
function gh(args) {
  try {
    return execFileSync(GH, ['api', ...args], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die('gh api ' + args.filter((x) => !x.startsWith('-') && !x.includes(':')).join(' ') + ' failed: ' + String(e.stderr || e.message).trim());
  }
}
// the same, for what may not be there: null then
function ghMaybe(args) {
  try { return execFileSync(GH, ['api', ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return null; }
}
const release = () => JSON.parse(gh([`repos/${opt.repo}/releases/tags/v${version}`]).toString('utf8'));
const download = (asset) => gh(['-H', 'Accept: application/octet-stream', `repos/${opt.repo}/releases/assets/${asset.id}`]);
function git(args, input) {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { input: input || '', maxBuffer: 1024 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    die(`git ${args[0]} failed in ${ROOT}: ` + String(e.stderr || e.message).trim().split('\n')[0]);
  }
}

// ---- the key: one the apps trust, or everything it signs would be refused anyway
let key;
try { key = crypto.createPrivateKey(fs.readFileSync(opt.key)); } catch (e) { die("can't read the release key " + opt.key + ' (' + e.code + ')'); }
if (key.asymmetricKeyType !== 'ec' || (key.asymmetricKeyDetails || {}).namedCurve !== 'prime256v1') die(opt.key + ' is not an ECDSA P-256 key');
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
if (!TRUSTED.includes(pub)) die(opt.key + " isn't a release key Flick trusts (RELEASE_KEYS in pc/updatecore.js)");

// ---- the phone app's signature check can run (before anything is downloaded)
let jar = null;
try { jar = fs.readFileSync(opt.signer); } catch (e) { /* said below */ }
if (!jar) die(`checking the phone app's signature needs uber-apk-signer.jar 1.3.0 (github.com/patrickfav/uber-apk-signer/releases, the one CI uses): put it in ${TOOLS}, or name it with --signer (${opt.signer} isn't there)`);
if (core.sha256(jar) !== SIGNER_SHA256) die(`${opt.signer} isn't uber-apk-signer 1.3.0 (its SHA-256 is ${core.sha256(jar)}, 1.3.0's is ${SIGNER_SHA256}): the phone app's signature is checked with it, so it must be that one`);
const javaRun = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (javaRun.error || javaRun.status !== 0) die("checking the phone app's signature needs Java 11 or newer, and `java -version` didn't run here" + (javaRun.error ? ' (' + javaRun.error.code + ')' : ''));

// ---- the native helpers you have vouched for, as this checkout has them: "<sha256>  <win32|darwin> bin/<name>" lines
const PINS = path.join(__dirname, 'helpers.sha256');
const pins = new Map();
{
  let text = '';
  try { text = fs.readFileSync(PINS, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') die(`can't read ${PINS} (${e.code})`); }
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    const m = /^([0-9a-fA-F]{64})\s+(win32|darwin)\s+(bin\/\S+)$/.exec(l);
    if (!m) die(`signing/helpers.sha256, line ${i + 1}, isn't "<sha256>  <win32 or darwin> bin/<name>": ${l}`);
    if (pins.has(m[2] + ' ' + m[3])) die(`signing/helpers.sha256 names ${m[2]} ${m[3]} twice (line ${i + 1}): keep only the one you vouch for now`);
    pins.set(m[2] + ' ' + m[3], m[1].toLowerCase());
  });
}

// ---- your commit, as this checkout has it: the files the build scripts put in an update bundle, by their name there
let commit;
try {
  commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', opt.commit + '^{commit}'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
} catch (e) {
  die(`there's no commit ${opt.commit} in ${ROOT}: run this in your own git checkout of Flick, on the commit you pushed for v${version} (or name it with --commit)`);
}
const short = commit.slice(0, 12);
// build_win.sh, build_mac.sh and build_linux.sh copy pc/*.js, pc/package.json, these folders of pc/ and phone/hand (as
// hand/); pc/phone-app/Flick.apk is the release's phone app (ci/phone_app.sh), not the commit's. Keep this in step
// with them: a bundle holding anything else is refused below.
const COPIED_DIRS = ['overlay', 'panel', 'catcher', 'assets', 'web', 'air'];
function bundleName(p) {
  let m;
  if (p === 'pc/package.json') return 'package.json';
  if ((m = /^pc\/([^/.][^/]*\.js)$/.exec(p))) return m[1];
  if ((m = /^pc\/([^/]+)\/(.+)$/.exec(p)) && COPIED_DIRS.includes(m[1])) return m[1] + '/' + m[2];
  if ((m = /^phone\/hand\/(.+)$/.exec(p))) return 'hand/' + m[1];
  return null;
}
// build_apk.sh copies phone/* into the phone app's assets/www, and aapt2 leaves out what it always leaves out (its
// default --ignore-assets: names starting with ".", folders starting with "_", CVS, thumbs.db, picasa.ini, *.scc, *~)
function pageName(p) {
  const m = /^phone\/(.+)$/.exec(p);
  if (!m) return null;
  const parts = m[1].split('/');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].toLowerCase();
    if (s.startsWith('.') || (i < parts.length - 1 && s.startsWith('_')) || ['cvs', 'thumbs.db', 'picasa.ini'].includes(s) || s.endsWith('.scc') || s.endsWith('~')) return null;
  }
  return 'assets/www/' + m[1];
}
const tree = new Map();                                       // name in the bundle -> { path, data }
const page = new Map();                                       // name in the phone app -> { path, data }
for (const rec of git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'pc', 'phone']).toString('utf8').split('\0')) {
  if (!rec) continue;
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([^]*)$/.exec(rec);
  if (!m) die("can't read the commit's file list (git ls-tree)");
  const name = bundleName(m[4]), asset = pageName(m[4]);
  if (!name && !asset) continue;
  if (m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) die(`${m[4]} in ${short} is a ${m[1] === '120000' ? 'link' : m[2]}, which the build would copy as it is: this check only knows files`);
  if (name) tree.set(name, { path: m[4], sha: m[3] });
  if (asset) page.set(asset, { path: m[4], sha: m[3] });
}
{
  const want = [...tree.values(), ...page.values()];
  const out = git(['cat-file', '--batch'], want.map((t) => t.sha).join('\n') + '\n');
  let p = 0;
  for (const t of want) {
    const nl = out.indexOf(10, p);
    const head = out.toString('utf8', p, nl).split(' ');          // "<sha> blob <size>"
    if (head[0] !== t.sha || head[1] !== 'blob' || nl + 1 + +head[2] > out.length) die(`can't read ${t.path} of ${short} (git cat-file)`);
    t.data = out.subarray(nl + 1, nl + 1 + +head[2]);
    p = nl + 1 + +head[2] + 1;
  }
}
if (!tree.has('package.json')) die(`${short} has no pc/package.json`);
let srcPkg = null;
try { srcPkg = JSON.parse(tree.get('package.json').data.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { /* said below */ }
if (!srcPkg || typeof srcPkg !== 'object') die(`pc/package.json of ${short} isn't JSON`);
if (srcPkg.version !== version) die(`pc/package.json of ${short} (${opt.commit}) says version ${srcPkg.version}, not ${version}: run this on the commit you pushed for v${version}, or name it with --commit`);
if (!srcPkg.electronVersion) die(`pc/package.json of ${short} has no electronVersion`);
// package.json as the build scripts write it: the commit's, plus the Electron the code was built for, which is
// electronVersion (they refuse any other Electron zip), laid out the way JSON.stringify(p, null, 2) does
const builtPkg = Buffer.from(JSON.stringify(Object.assign(srcPkg, { flickElectron: srcPkg.electronVersion }), null, 2) + '\n');
// what is about to be vouched for, as this checkout says it: a commit pulled from GitHub since the push would show here
const about = git(['log', '-1', '--date=short', '--format="%s" (%an, %ad)', commit]).toString('utf8').trim();
console.log(`your commit: ${commit}${opt.commit === commit ? '' : ' (' + opt.commit + ')'} ${about}, Flick ${version}, ${tree.size} files for the app bundles`);

// ---- the release, and its tag: that very commit
const rel = release();
const assets = Array.isArray(rel.assets) ? rel.assets : [];
const byName = new Map(assets.map((a) => [a.name, a]));
console.log(`v${version} of ${opt.repo}: ${assets.length} files`);
// the commit a tag on GitHub names (an annotated tag followed to its commit)
function tagCommit(tag) {
  let o = JSON.parse(gh([`repos/${opt.repo}/git/ref/tags/${tag}`]).toString('utf8')).object;
  for (let i = 0; o && o.type === 'tag' && i < 5; i++) o = JSON.parse(gh([`repos/${opt.repo}/git/tags/${o.sha}`]).toString('utf8')).object;
  if (!o || o.type !== 'commit' || !/^[0-9a-f]{40,64}$/.test(String(o.sha))) die(`can't tell which commit ${tag}'s tag on GitHub is`);
  return o.sha;
}
const tagged = { sha: tagCommit(`v${version}`) };
if (tagged.sha !== commit) {
  let here = null;
  try { here = execFileSync('git', ['-C', ROOT, 'log', '-1', '--date=short', '--format="%s" (%an, %ad)', tagged.sha + '^{commit}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { /* not here */ }
  die(`v${version}'s tag on GitHub is commit ${tagged.sha}, but you are signing for ${commit} (${opt.commit === 'HEAD' ? 'HEAD' : '--commit ' + opt.commit}).\n` + (here
    ? `  In this checkout, ${tagged.sha.slice(0, 12)} is ${here}.\n  Only if that is the commit you pushed for v${version}: run this on it, or with --commit ${tagged.sha.slice(0, 12)}.`
    : `  That commit isn't in this checkout: nothing you committed here. Don't sign this release; find out where it came from.`));
}
console.log(`  ok its tag v${version} is your commit ${short}`);

// ---- SHA256SUMS: exactly what the release workflow publishes (release.yml, "Publish the release"), and every file
const PUBLISHED = ['Flick-Setup.exe', `flick-app-${version}.zip`, 'Flick-mac-arm64.dmg', 'Flick-mac-x64.dmg', `flick-app-mac-${version}.zip`,
  'Flick-linux-x86_64.AppImage', 'Flick-linux-x64.tar.gz', `flick-app-linux-${version}.zip`];
if (!byName.has('SHA256SUMS')) die(`v${version} has no SHA256SUMS`);
const sums = download(byName.get('SHA256SUMS'));
const list = core.parseSums(sums.toString('utf8'));
if (!list || !list.size) die("SHA256SUMS doesn't parse");
{
  const apks = [...list.keys()].filter((n) => /^Flick-\d+\.\d+\.\d+\.apk$/.test(n));
  const missing = PUBLISHED.filter((n) => !list.has(n));
  const extra = [...list.keys()].filter((n) => !PUBLISHED.includes(n) && !apks.includes(n));
  if (missing.length || extra.length || apks.length !== 1) {
    die(`SHA256SUMS must list exactly what the release workflow publishes: ${PUBLISHED.join(', ')} and one Flick-<version>.apk` +
      (missing.length ? '\n  missing: ' + missing.join(', ') : '') + (extra.length ? '\n  not expected: ' + extra.join(', ') : '') +
      (apks.length > 1 ? '\n  more than one phone app: ' + apks.join(', ') : apks.length ? '' : '\n  no phone app'));
  }
}
// (Flick.apk: the phone app once more, under a name that stays the same from release to release, for a link that
// always gives the latest. It isn't in SHA256SUMS; it is checked below to be the listed phone app, byte for byte.)
const SAME_APK = 'Flick.apk';
for (const a of assets) if (a.name !== 'SHA256SUMS' && a.name !== 'SHA256SUMS.sig' && a.name !== SAME_APK && !list.has(a.name)) die(`${a.name} is on the release but not in SHA256SUMS`);
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
if (byName.has(SAME_APK)) {
  const listed = [...files.keys()].find((n) => /^Flick-\d+\.\d+\.\d+\.apk$/.test(n));
  if (!download(byName.get(SAME_APK)).equals(files.get(listed))) die(`${SAME_APK} on the release isn't ${listed}, the phone app SHA256SUMS lists`);
  console.log(`  ok ${SAME_APK} is ${listed}`);
}

// the IDs in an APK's signing block (just before the central directory; 0x7109871a is a v2 signature, 0xf05368c0 v3);
// [] when there is none, null when it doesn't read
function signingBlockIds(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const cd = buf.readUInt32LE(eocd + 16);
  if (cd < 32 || cd > buf.length || buf.toString('latin1', cd - 16, cd) !== 'APK Sig Block 42') return [];
  const size = Number(buf.readBigUInt64LE(cd - 24)), start = cd - size - 8;
  if (start < 0 || Number(buf.readBigUInt64LE(start)) !== size) return null;
  const ids = [];
  for (let p = start + 8; p < cd - 24;) {
    const len = Number(buf.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > cd - 24) return null;
    ids.push(buf.readUInt32LE(p + 8));
    p += 8 + len;
  }
  return ids;
}
// where a file differs from the commit's: sizes, and the bundle's first differing line for text
function howDiffers(want, got) {
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i++;
  const sizes = `${got.length} bytes, the commit's ${want.length}`;
  if (want.subarray(0, 8192).includes(0) || got.subarray(0, 8192).includes(0)) return `${sizes}; they differ from byte ${i}`;
  const line = got.subarray(0, i).toString('utf8').split('\n').length;
  if (i === got.length) return `${sizes}; it stops at line ${line}`;
  const text = got.toString('utf8', i > 0 ? got.lastIndexOf(10, i - 1) + 1 : 0).split('\n')[0];
  return `${sizes}; ${i === want.length ? 'added' : 'from'} line ${line}: ${JSON.stringify(text.length > 120 ? text.slice(0, 120) + '…' : text)}`;
}

// ---- the phone app: Flick's, signed with Flick's own key only, its page the commit's, and the version it should be
const apkName = [...files.keys()].find((n) => /^Flick-\d+\.\d+\.\d+\.apk$/.test(n));
const apk = files.get(apkName);
const apkVersion = /^Flick-(.*)\.apk$/.exec(apkName)[1];
let apkEntries;
{
  let info = null;
  try { info = parseManifest(findEntry(apk, 'AndroidManifest.xml')); } catch (e) { /* refused below */ }
  if (!info || info.package !== 'com.flick.app' || info.versionName !== apkVersion) die(`${apkName} isn't Flick's phone app ${apkVersion}`);
  // FlickVerify prints how the APK is signed; verify_apk.sh's comparison with expected-signature.txt, in Node (no bash
  // needed), line endings aside
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flick-apk-'));
  let r;
  try {
    fs.writeFileSync(path.join(dir, 'Flick.apk'), apk);
    r = spawnSync('java', ['-cp', opt.signer, path.join(__dirname, 'FlickVerify.java'), path.join(dir, 'Flick.apk')], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const got = String(r.stdout || '').replace(/\r\n/g, '\n').replace(/^[^:\n]*: /, '').trimEnd();
  const want = fs.readFileSync(path.join(__dirname, 'expected-signature.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (r.status !== 0 || got !== want) {
    const err = String(r.stderr || '').split('\n').filter((l) => l.trim() && !/^Picked up JAVA_TOOL_OPTIONS/.test(l)).join('\n');
    die(`${apkName} isn't signed the way signing/expected-signature.txt says (Flick's own key):\n${got || '(FlickVerify printed nothing)'}${err ? '\n' + err : ''}`);
  }
  // and by nothing else: apksig doesn't look at v1 or v2 signatures of an app for Android 9+, nor does Android, but a
  // second signer next to Flick's (the old public debug key, say) has no business there
  try { apkEntries = core.unzipAll(apk); } catch (e) { die(`${apkName} doesn't unpack (${e.message})`); }
  const ids = signingBlockIds(apk);
  if (!ids) die(`${apkName}'s signing block can't be read`);
  if (ids.includes(0x7109871a)) die(`${apkName} carries a v2 signature besides Flick's v3 one`);
  const v1 = apkEntries.find((e) => /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(e.name));
  if (v1) die(`${apkName} carries a v1 (JAR) signature besides Flick's v3 one (${v1.name})`);
  console.log(`  ok ${apkName} is com.flick.app ${info.versionName} (${info.versionCode}), signed with Flick's key only`);

  // its page: the commit's phone/, as build_apk.sh packs it, and nothing else under assets/
  const pageProblems = [];
  const seen = new Map();
  for (const e of apkEntries) {
    if (!e.name.startsWith('assets/')) continue;
    if (seen.has(e.name)) pageProblems.push(`${e.name} is in it twice`);
    seen.set(e.name, e.data);
  }
  for (const [n, d] of seen) {
    const t = page.get(n);
    if (!t) pageProblems.push(`${n} isn't in ${short}'s phone/`);
    else if (!d.equals(t.data)) pageProblems.push(`${n} isn't the commit's ${t.path} (${howDiffers(t.data, d)})`);
  }
  for (const [n, t] of page) if (!seen.has(n)) pageProblems.push(`${n} is missing (the commit has ${t.path})`);
  if (pageProblems.length) {
    die(`${apkName}'s page isn't your commit ${short}'s phone/ as build_apk.sh packs it: nothing was signed.\n  ` + pageProblems.slice(0, 40).join('\n  ') +
      (pageProblems.length > 40 ? `\n  … and ${pageProblems.length - 40} more` : ''));
  }
  console.log(`  ok its page is the commit's phone/ (${page.size} files)`);

  // its version: this release's when it was built for it (as ci/phone_app.sh builds it), else an earlier release's
  // phone app, reused because nothing it's built from changed since (ci/phone_app.sh), which you signed then
  const [ma, mi, pa] = version.split('.').map(Number);
  if (apkVersion === version) {
    const code = 100000 + ma * 10000 + mi * 100 + pa;
    if (mi >= 100 || pa >= 100 || info.versionCode !== code) die(`${apkName} has versionCode ${info.versionCode}; ci/phone_app.sh builds ${version} as ${code}`);
    console.log(`  ok it was built for ${version} (versionCode ${code})`);
  } else if (!core.newer(version, apkVersion)) {
    die(`${apkName} is a newer phone app than the release (${version})`);
  } else {
    const pr = ghMaybe([`repos/${opt.repo}/releases/tags/v${apkVersion}`]);
    const pa2 = new Map(((pr && JSON.parse(pr.toString('utf8')).assets) || []).map((x) => [x.name, x]));
    if (!pa2.has('SHA256SUMS') || !pa2.has('SHA256SUMS.sig')) die(`${apkName} is ${apkVersion}'s phone app, but there's no signed release v${apkVersion} on GitHub that carries it`);
    const psums = download(pa2.get('SHA256SUMS'));
    if (!core.verifyRelease(apkVersion, psums, download(pa2.get('SHA256SUMS.sig')).toString('utf8'), TRUSTED)) die(`v${apkVersion}'s SHA256SUMS.sig isn't valid, so it can't vouch for ${apkName}`);
    const plist = core.parseSums(psums.toString('utf8'));
    const was = plist && plist.get(apkName);
    if (was !== core.sha256(apk)) die(`${apkName} isn't the phone app you signed in v${apkVersion} (its SHA-256 is ${core.sha256(apk)}; v${apkVersion} lists ${was || 'no such file'})`);
    const prev = tagCommit(`v${apkVersion}`);
    try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', prev + '^{commit}'], { stdio: 'ignore' }); } catch (e) { die(`v${apkVersion}'s tag on GitHub is commit ${prev}, which isn't in this checkout: can't tell whether the phone app's sources changed since`); }
    let same = true;
    try { execFileSync('git', ['-C', ROOT, 'diff', '--quiet', prev, commit, '--', 'android', 'phone', 'build_apk.sh'], { stdio: 'ignore' }); } catch (e) { same = false; }
    if (!same) die(`this release carries ${apkVersion}'s phone app, but android/, phone/ or build_apk.sh changed since v${apkVersion} (${prev.slice(0, 12)}): it should carry one built from ${short} as ${version}`);
    console.log(`  ok it is v${apkVersion}'s phone app, which you signed then, and nothing it's built from changed since`);
  }
}

// ---- the app bundles: the commit's files, and only what the build makes besides them
// made by the build, not taken from the commit: the native helpers (build_win.sh: MinGW from native/*.c; build_mac.sh:
// swiftc, lipo and codesign from native/flick-keys-mac.swift) and the phone app
const MADE = { win32: ['bin/flick-bt.exe', 'bin/flick-keys.exe', 'bin/flick-sparse.exe'], darwin: ['bin/flick-keys'], linux: [] };
// what is known of a helper without its source: the kind of program the build makes
function helperProblem(b, sys) {
  if (sys === 'win32') {
    const pe = b.length > 0x40 && b.readUInt16LE(0) === 0x5a4d ? b.readUInt32LE(0x3c) : 0;
    return pe && pe + 6 <= b.length && b.readUInt32LE(pe) === 0x4550 && b.readUInt16LE(pe + 4) === 0x8664 ? null : 'not a 64-bit Windows program';
  }
  const types = new Set();                                     // a universal Mac program: arm64 and x86_64
  if (b.length >= 8 && b.readUInt32BE(0) === 0xcafebabe) for (let i = 0; i < b.readUInt32BE(4) && 28 + 20 * i <= b.length; i++) types.add(b.readUInt32BE(8 + 20 * i));
  return types.has(0x0100000c) && types.has(0x01000007) ? null : 'not a Mac program for both Apple Silicon and Intel';
}
function pkgProblem(data) {
  let got = null;
  try { got = JSON.parse(data.toString('utf8')); } catch (e) { return "isn't JSON"; }
  if (!got || typeof got !== 'object') return "isn't JSON";
  const want = JSON.parse(builtPkg.toString('utf8'));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const out = [];
  for (const k of Object.keys(got)) if (!own(want, k)) out.push(`it has "${k}", which neither the commit nor the build gives it`);
  for (const k of Object.keys(want)) {
    if (!own(got, k)) out.push(`it lacks "${k}"`);
    else if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) out.push(`its "${k}" is ${JSON.stringify(got[k])}, should be ${JSON.stringify(want[k])}`);
  }
  return out.length ? out.join('; ') : 'the same settings, but not as the build writes them';
}
const problems = [];
const helpers = [];
const unvouched = [];
for (const sys of ['win32', 'darwin', 'linux']) {
  const name = core.bundleName(version, sys);
  const bad = (m) => problems.push(`${name}: ${m}`);
  let entries;
  try { entries = core.unzipAll(files.get(name)); } catch (e) { bad(`it doesn't unpack the way installed PCs unpack it (${e.message})`); continue; }
  const seen = new Map();
  for (const f of entries) {
    if (seen.has(f.name)) bad(`${f.name} is in it twice (a PC keeps the last one)`);
    seen.set(f.name, f.data);
  }
  for (const [n, data] of seen) {
    if (n === 'package.json') { if (!data.equals(builtPkg)) bad(`package.json isn't the commit's as the build writes it: ${pkgProblem(data)}`); continue; }
    const t = tree.get(n);
    if (t) { if (!data.equals(t.data)) bad(`${n} isn't the commit's ${t.path} (${howDiffers(t.data, data)})`); continue; }
    if (n === 'phone-app/Flick.apk') { if (!data.equals(apk)) bad(`${n} isn't the release's ${apkName}`); continue; }
    if (MADE[sys].includes(n)) {
      const why = helperProblem(data, sys), h = core.sha256(data), pin = pins.get(sys + ' ' + n);
      if (why) bad(`${n}: ${why}`);
      else if (pin !== h) unvouched.push({ bundle: name, line: `${h}  ${sys} ${n}`, n, h, pin });
      else helpers.push(`${h}  ${name}: ${n}`);
      continue;
    }
    bad(`${n} isn't in ${short}, nor something the build makes`);
  }
  for (const n of [...tree.keys(), 'phone-app/Flick.apk', ...MADE[sys]]) if (!seen.has(n)) bad(`${n} is missing (${tree.has(n) ? 'the commit has ' + tree.get(n).path : 'the build makes it'})`);
  if (!problems.some((p) => p.startsWith(name + ': '))) console.log(`  ok ${name}: ${seen.size} files, the commit's ${tree.size} as built${MADE[sys].length ? ', ' + MADE[sys].join(', ') : ''} and the phone app`);
}
if (problems.length) {
  const shown = problems.slice(0, 40);
  die(`the release's app bundles aren't what your commit ${short} builds: nothing was signed.\n  ` + shown.join('\n  ') +
    (problems.length > shown.length ? `\n  … and ${problems.length - shown.length} more` : ''));
}
if (unvouched.length) {
  let prev = null;
  try { prev = execFileSync('git', ['-C', ROOT, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', commit + '^'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { /* no earlier release here */ }
  die("the release's native helpers aren't ones you have vouched for (signing/helpers.sha256): nothing was signed.\n" +
    unvouched.map((u) => `  ${u.bundle}: ${u.n}  sha256 ${u.h}  ` + (u.pin ? `(you vouched for ${u.pin})` : '(not listed)')).join('\n') +
    `\nGitHub built them from native/ in ${short}, and every Windows PC and Mac that updates runs them. To vouch for them:\n` +
    `  1. check that native/ is what you wrote: git log -p ${prev ? prev + '..' : ''}${short} -- native/\n` +
    '  2. best, build them yourself the way build_win.sh and build_mac.sh do and compare the SHA-256s above (with the same\n' +
    '     MinGW compiler, the Windows ones come out the same byte for byte)\n' +
    '  3. put these lines in signing/helpers.sha256 (in place of older lines for the same helper), run this again, and\n' +
    '     commit the file:\n' + unvouched.map((u) => '     ' + u.line).join('\n'));
}
console.log('native helpers, each one you vouched for in signing/helpers.sha256 (sha256):\n  ' + helpers.join('\n  '));

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
  const run = tryGh(['api', '--method', 'POST', `repos/${opt.repo}/actions/workflows/attach-signature.yml/dispatches`,
    '-f', 'ref=main', '-f', 'inputs[version]=' + version, '-f', 'inputs[sig]=' + sig.trim()]);
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
