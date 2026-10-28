/* Shared clipboard. Android lets an app read the clipboard only while it is in front, so the phone sends it
 * when Flick comes to the front (Settings › Clipboard sync) or when asked (••• › Send clipboard). What comes from the
 * PC is put on this phone's clipboard by the app (clipWrite), and never sent back. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const TEXT_MAX = 1024 * 1024;              // /api/clip takes text up to 1 MB
  const MSG_MAX = 6 * 1024 * 1024;           // and a body (here: the message) up to 6 MB
  // a PC closes the link on a WebSocket message over 4 MB (pc/ws.js MAX_MESSAGE): a bigger clipboard (a large
  // screenshot, say) goes through the app instead, over HTTP (sendClipboard: POST /api/clip, the tile's way)
  const WS_MAX = 4 * 1024 * 1024 - 32 * 1024;
  // prefs: 'clipHash' = hash of the clipboard last sent to or taken from the PC; 'clipAdopt' = '1' when a clipboard
  // from the PC was put on this phone since (the next check takes it as already synced instead of sending it back);
  // 'clipSeen' = the app's id of the clipboard the last check dealt with (the same one again isn't read again)
  let wantAt = 0, tryT = 0, checking = false;
  let own = [];                              // { at, kind }: PC clipboards this page handed the app (an echo isn't news)

  // What's on this phone's clipboard, read by the app without holding up the page (it waits for Flick's window to
  // have focus, and a picture takes a while to convert): { c: { kind, text | png, fromPc, hash } or null, r: what the
  // app said ({ kind, id, fromPc, sensitive, same, hash, ... }) }. seen: the id of the clipboard dealt with last (the
  // app then only says it's the same one: r.same); adopt: it will be taken as synced, so its content isn't needed
  // (nor for one from the PC). A clipboard an app marked private (a password) reads as nothing (kind "none",
  // sensitive: true): it never leaves the phone on its own.
  const waiting = new Map();                 // req -> its answer's handler (a 'clip-read' event)
  let reqN = 0;
  function read(seen, adopt) {
    return new Promise((resolve) => {
      const done = (r) => resolve({ c: clipOf(r), r: r || {} });
      if (!A.has('clipPeek')) { done(A.njson('clipRead')); return; }
      const req = 'cr' + (++reqN);
      const t = setTimeout(() => { waiting.delete(req); done(null); }, 15000);
      waiting.set(req, (r) => { clearTimeout(t); done(r); });
      if (A.nc('clipPeek', req, seen || '', !!adopt) === null) { clearTimeout(t); waiting.delete(req); done(null); }
    });
  }
  function clipOf(r) {
    if (!r) return null;
    const fromPc = r.fromPc === true, hash = typeof r.hash === 'string' ? r.hash : '';
    if (r.kind === 'text' && typeof r.text === 'string' && r.text.length) return { kind: 'text', text: r.text, fromPc, hash };
    if (r.kind === 'image' && typeof r.png === 'string' && r.png.length) return { kind: 'image', png: r.png, fromPc, hash };
    return null;
  }
  // (the app's hash when it gave one: the same SHA-256, without sending megabytes back over the bridge)
  const hashOf = (c) => c.hash || X.hash(c.kind === 'image' ? c.png : c.text);
  const utf8 = (s) => { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 3; } };

  function send(c, auto) {
    const msg = c.kind === 'image' ? { t: 'clip', kind: 'image', png: c.png } : { t: 'clip', kind: 'text', text: c.text };
    const json = JSON.stringify(msg);
    const bytes = c.kind === 'image' ? json.length : utf8(json);
    if (c.kind === 'text' ? utf8(c.text) > TEXT_MAX : bytes > MSG_MAX) {
      if (!auto) A.toast(c.kind === 'image' ? 'That picture is too big to send' : 'That’s too much text to send', 2400);
      return false;
    }
    if (bytes > WS_MAX) {
      if (A.nc('sendClipboard') === null) { if (!auto) A.toast('That picture is too big to send', 2400); return false; }
    } else if (!A.wsSend(msg)) {
      if (!auto) A.toast('Couldn’t reach ' + X.pcName(), 2200);
      return false;
    } else {
      A.toast('Clipboard sent to ' + X.pcName(), 1800);   // (the app says how its own sending went)
      A.nc('clipHistoryAdd', 'out', json);                 // clipboard history (the app keeps what it sends itself)
    }
    A.pref.set('clipHash', hashOf(c));
    A.pref.set('clipAdopt', '');
    A.haptic('tick');
    return true;
  }

  // ••• › Send clipboard
  async function sendNow() {
    if (!X.needPc('Connect to your PC to send the clipboard')) return;
    const { c, r } = await read('', false);
    if (!c && r.sensitive === true) {
      // marked private: it goes only because the user asked, the way the Quick Settings tile sends it (the app reads
      // it, sends it and says how it went)
      if (A.nc('sendClipboard') === null) A.toast('Your clipboard is private, so it stays on this phone', 2600);
      return;
    }
    if (!c) { A.toast('Your clipboard is empty', 2000); return; }
    if (send(c, false) && r.id) A.pref.set('clipSeen', r.id);
  }
  X.menu(10, () => (A.has('clipRead') ? { label: 'Send clipboard', icon: 'clipboard', run: sendNow } : null));

  // Flick came to the front: send the clipboard if it changed since the last one that went either way
  function want(ms) { wantAt = Date.now(); clearTimeout(tryT); tryT = setTimeout(check, ms); }
  async function check() {
    clearTimeout(tryT);
    if (!wantAt || document.hidden) return;
    if (checking) { tryT = setTimeout(check, 300); return; }   // one read at a time (this one is looked at again)
    if (!A.settings.clipSync || !A.has('clipRead')) { wantAt = 0; return; }
    if (!A.st.connected) return;                        // tried again once connected ('conn')
    if (!X.newPc()) { wantAt = 0; return; }
    const at = wantAt;
    const adopt = A.pref.get('clipAdopt', '') === '1';
    checking = true;
    let got;
    try { got = await read(A.pref.get('clipSeen', ''), adopt); } finally { checking = false; }
    if (wantAt !== at || document.hidden) return;        // Flick went to the back meanwhile, or came back again
    const { c, r } = got;
    if (r.kind !== 'text' && r.kind !== 'image') {
      // Android hands the clipboard over only once the window has focus (the app waits a moment for it): an empty
      // answer right after coming back is asked again once
      if (Date.now() - wantAt < 2000) tryT = setTimeout(check, 900); else wantAt = 0;
      return;
    }
    wantAt = 0;
    // it came from the PC (the app marks what it put there; 'clipAdopt' covers an app that doesn't): not sent back
    if (r.fromPc || adopt) {
      A.pref.set('clipAdopt', '');
      if (r.hash) A.pref.set('clipHash', r.hash);
      A.pref.set('clipSeen', r.id || '');
      return;
    }
    if (r.same || !c) return;                            // the one dealt with last time (or unreadable)
    if (hashOf(c) === A.pref.get('clipHash', '') || send(c, true)) A.pref.set('clipSeen', r.id || '');
  }

  A.on('native', (e) => {
    if (e.t === 'clip-read') { const f = waiting.get(e.req); if (f) { waiting.delete(e.req); f(e); } }
    else if (e.t === 'resume') want(500);
    else if (e.t === 'pause') { wantAt = 0; clearTimeout(tryT); }
    else if (e.t === 'clip-in') {
      // the app put a clipboard from the PC on this phone (in the background, say)
      own = own.filter((w) => Date.now() - w.at < 1500);
      const i = own.findIndex((w) => w.kind === e.kind);
      if (i >= 0) { own.splice(i, 1); return; }         // the app's echo of what this page just handed over
      A.pref.set('clipAdopt', '1');
      A.toast('Copied from ' + X.pcName(), 1800);
    }
  });
  A.on('conn', () => {
    if (A.st.connected && wantAt) { clearTimeout(tryT); tryT = setTimeout(check, 1000); }   // after "Connected to …"
  });

  // the PC's clipboard, while this page is connected: on this phone's clipboard when "Clipboard from your PC" is on
  A.on('ws', (m) => {
    if (m.t !== 'clip' || !A.linkAuthed()) return;
    const f = A.njson('features');
    if (f && f.clipFromPc === false) return;
    let c = null;
    if (m.kind === 'image' && typeof m.png === 'string' && m.png.length) c = { kind: 'image', png: m.png };
    else if (m.kind === 'text' && typeof m.text === 'string' && m.text.length) c = { kind: 'text', text: m.text };
    if (!c) return;
    if (A.nc('clipWrite', JSON.stringify(c)) === null) return;
    own.push({ at: Date.now(), kind: c.kind });
    // a picture may come back from Android encoded differently: the next check takes whatever is there as synced
    // (so hashing its megabytes here would be for nothing)
    if (c.kind === 'image') A.pref.set('clipAdopt', '1'); else A.pref.set('clipHash', hashOf(c));
    A.toast('Copied from ' + X.pcName(), 1800);
  });
});
