/* Flick 2.0: shared clipboard. Android lets an app read the clipboard only while it is in front, so the phone sends it
 * when Flick comes to the front (Settings › Clipboard sync) or when asked (••• › Send clipboard). What comes from the
 * PC is put on this phone's clipboard by the app (clipWrite), and never sent back. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const TEXT_MAX = 1024 * 1024;              // spec §2 /api/clip: text up to 1 MB
  const MSG_MAX = 6 * 1024 * 1024;           // and a body (here: the message) up to 6 MB
  // a PC closes the link on a WebSocket message over 4 MB (pc/ws.js MAX_MESSAGE): a bigger clipboard (a large
  // screenshot, say) goes through the app instead, over HTTP (sendClipboard: POST /api/clip, the tile's way)
  const WS_MAX = 4 * 1024 * 1024 - 32 * 1024;
  // prefs: 'clipHash' = hash of the clipboard last sent to or taken from the PC; 'clipAdopt' = '1' when a clipboard
  // from the PC was put on this phone since (the next check takes it as already synced instead of sending it back)
  let wantAt = 0, tryT = 0;
  let own = [];                              // { at, kind }: PC clipboards this page handed the app (an echo isn't news)

  // what's on this phone's clipboard; fromPc: Flick put it there from the PC. A clipboard an app marked private (a
  // password) reads as nothing (kind "none", sensitive: true): it never leaves the phone on its own.
  let lastRead = null;
  function read() {
    const c = lastRead = A.njson('clipRead');
    if (!c) return null;
    const fromPc = c.fromPc === true;
    if (c.kind === 'text' && typeof c.text === 'string' && c.text.length) return { kind: 'text', text: c.text, fromPc };
    if (c.kind === 'image' && typeof c.png === 'string' && c.png.length) return { kind: 'image', png: c.png, fromPc };
    return null;
  }
  const hashOf = (c) => X.hash(c.kind === 'image' ? c.png : c.text);
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
    }
    A.pref.set('clipHash', hashOf(c));
    A.pref.set('clipAdopt', '');
    A.haptic('tick');
    return true;
  }

  // ••• › Send clipboard
  function sendNow() {
    if (!X.needPc('Connect to your PC to send the clipboard')) return;
    const c = read();
    if (!c && lastRead && lastRead.sensitive === true) {
      // marked private: it goes only because the user asked, the way the Quick Settings tile sends it (the app reads
      // it, sends it and says how it went)
      if (A.nc('sendClipboard') === null) A.toast('Your clipboard is private, so it stays on this phone', 2600);
      return;
    }
    if (!c) { A.toast('Your clipboard is empty', 2000); return; }
    send(c, false);
  }
  X.menu(10, () => (A.has('clipRead') ? { label: 'Send clipboard', icon: 'clipboard', run: sendNow } : null));

  // Flick came to the front: send the clipboard if it changed since the last one that went either way
  function want(ms) { wantAt = Date.now(); clearTimeout(tryT); tryT = setTimeout(check, ms); }
  function check() {
    clearTimeout(tryT);
    if (!wantAt || document.hidden) return;
    if (!A.settings.clipSync || !A.has('clipRead')) { wantAt = 0; return; }
    if (!A.st.connected) return;                        // tried again once connected ('conn')
    if (!X.newPc()) { wantAt = 0; return; }
    const c = read();
    if (!c) {
      // Android hands the clipboard over only once the window has focus, which can come a moment after 'resume'
      if (Date.now() - wantAt < 2000) tryT = setTimeout(check, 900); else wantAt = 0;
      return;
    }
    wantAt = 0;
    const h = hashOf(c);
    // it came from the PC (the app marks what it put there; 'clipAdopt' covers an app that doesn't): not sent back
    if (c.fromPc || A.pref.get('clipAdopt', '') === '1') { A.pref.set('clipAdopt', ''); A.pref.set('clipHash', h); return; }
    if (h === A.pref.get('clipHash', '')) return;
    send(c, true);
  }

  A.on('native', (e) => {
    if (e.t === 'resume') want(500);
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
    A.pref.set('clipHash', hashOf(c));
    if (c.kind === 'image') A.pref.set('clipAdopt', '1');   // a picture may come back from Android encoded differently
    A.toast('Copied from ' + X.pcName(), 1800);
  });
});
