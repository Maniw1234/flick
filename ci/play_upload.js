#!/usr/bin/env node
// Uploads the Google Play version (build/Flick-play.aab) to Google Play. Used by .github/workflows/release.yml.
//
// usage: node ci/play_upload.js <bundle.aab> <version> [notes.md]
//
// PLAY_SERVICE_ACCOUNT: the key (JSON) of a Google Cloud service account that the Play Console lets release Flick
// (Play Console > Users and permissions). PLAY_TRACK: internal, alpha (closed testing), beta (open testing) or
// production (the default). PLAY_STATUS: draft (the default: it waits in the Play Console for "Start rollout") or
// completed (it goes to Google's review, and out once approved).
//
// Google's API can't make an app or its first release: the first one is uploaded by hand in the Play Console
// (play/listing.md, "The first release"), and this takes over from the next. A bundle whose version code Google Play
// has already (that one, or a release run again) is left alone, with a notice. Only Node's own modules: nothing else
// runs with the key.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const PKG = 'io.github.maniw1234.flick';
const API = 'https://androidpublisher.googleapis.com';
const fail = (m) => { console.log('::error title=Google Play::' + m); process.exit(1); };

const [aab, version, notesFile] = process.argv.slice(2);
if (!aab || !version) fail('usage: node ci/play_upload.js <bundle.aab> <version> [notes.md]');
const track = process.env.PLAY_TRACK || 'production';
const status = process.env.PLAY_STATUS || 'draft';
if (!/^(internal|alpha|beta|production)$/.test(track)) fail('PLAY_TRACK is internal, alpha, beta or production, not ' + track);
if (!/^(draft|completed)$/.test(status)) fail('PLAY_STATUS is draft or completed, not ' + status);

let sa;
try { sa = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT || ''); } catch (e) { sa = null; }
if (!sa || !sa.client_email || !sa.private_key) fail("PLAY_SERVICE_ACCOUNT isn't a service account's key (JSON)");

// What's new: the version's section of CHANGES.md as plain text, within Play's 500 characters
function notes() {
  let t = '';
  try { t = fs.readFileSync(notesFile, 'utf8'); } catch (e) { /* none */ }
  t = t.replace(/\r/g, '').replace(/\*\*|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*- /gm, '• ')
    .split(/\n\s*Everything that changed/)[0]            // the short list at the top, not the long one
    .replace(/\n\s*\n/g, '\n').replace(/\n(?!•)\s*/g, ' ').trim();
  if (!t) t = 'Flick ' + version;
  if (t.length > 500) {
    // whole lines only (the opening line, then one "•" line per change): as many as fit, never half of one
    const lines = t.split('\n');
    let n = 0, len = -1;
    while (n < lines.length && len + 1 + lines[n].length <= 500) len += 1 + lines[n++].length;
    t = n ? lines.slice(0, n).join('\n') : t.slice(0, 497).replace(/\s+\S*$/, '') + '…';
  }
  return t;
}

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) fail("Google didn't accept the service account: " + (j.error_description || j.error || r.status));
  return j.access_token;
}

// Google's words for a bundle whose version code Google Play has had before
const usedBefore = (m) => /version code/i.test(m) && /already/i.test(m);

async function call(tok, method, url, body, type) {
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': type || 'application/json' },
    body: body == null ? undefined : type ? body : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || String(r.status);
    // this very version is on Google Play already (uploaded by hand in the Play Console, or by an earlier run of this
    // release): nothing to do, and no reason to call a release that went out failed. Nothing was changed there.
    if (type && usedBefore(m)) {
      console.log('::notice title=Google Play::Flick ' + version + " is on Google Play already (its version code was used before): not uploaded again. Google's answer: " + m);
      process.exit(0);
    }
    if (r.status === 404) fail('Google Play has no app ' + PKG + ' this account can release yet (upload the first one in the Play Console by hand): ' + m);
    fail(method + ' ' + url.replace(API, '') + ': ' + m);
  }
  return j;
}

(async () => {
  const bytes = fs.readFileSync(aab);
  const tok = await token();
  const app = API + '/androidpublisher/v3/applications/' + PKG;
  const edit = await call(tok, 'POST', app + '/edits', {});
  const up = await call(tok, 'POST', API + '/upload/androidpublisher/v3/applications/' + PKG + '/edits/' + edit.id + '/bundles?uploadType=media',
    bytes, 'application/octet-stream');
  const code = up.versionCode;
  await call(tok, 'PUT', app + '/edits/' + edit.id + '/tracks/' + track, {
    track, releases: [{ name: version, versionCodes: [String(code)], status, releaseNotes: [{ language: 'en-US', text: notes() }] }],
  });
  await call(tok, 'POST', app + '/edits/' + edit.id + ':commit');
  console.log('::notice title=Google Play::Flick ' + version + ' (' + code + ') uploaded to the ' + track + ' track as ' +
    (status === 'draft' ? 'a draft: start its rollout in the Play Console' : 'a release: it goes out once Google has reviewed it'));
})().catch((e) => fail(String(e && e.message || e)));
