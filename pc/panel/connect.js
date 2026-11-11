'use strict';
// Connect, in Flick's window: hold it here (or on the other device) and the other one asks its user to allow it. Every
// Flick device nearby is looked for while it's held, phones and computers alike; main picks the one meant (or lists
// them here to pick from) and asks it (main.js: Connect). What's going on comes from main as 'panel:connect'; the hold
// itself (its ring) is drawn here.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:connect', Object.assign({ what }, extra || {}));
  const HOLD_MS = 950, LEN = 131.95;                 // (the ring: 2πr, r = 21)
  const btn = $('cnBtn'), arc = $('cnArc'), title = $('cnTitle'), text = $('cnText'), body = $('cnBody');
  const ICON = {
    pc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.75" width="18" height="12" rx="1.75"/><path d="M8.5 20h7M12 16.75V20"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.75" y="2.75" width="10.5" height="18.5" rx="2.25"/><path d="M10.75 18h2.5"/></svg>',
  };
  // a name inside a sentence keeps to itself: right-to-left letters in it don't reorder the words around it
  const iso = (n) => '⁨' + n + '⁩';
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  // a control's place in the card (data-k): drawn again, the keyboard goes back to the same one
  const key = (e, k) => { e.dataset.k = k; return e; };
  let C = { phase: 'idle' };
  let down = false, done = false, t0 = 0, p = 0, raf = 0, nudge = '';
  // when a pointer last pressed or let go of Connect, and when Enter or Space last started it: a click that follows
  // either is theirs (already answered), any other click is a screen reader's or voice control's press
  let ptrAt = -1e9, keyAt = -1e9;

  const asking = () => C.phase === 'asking';
  // allowed there: the user here says whether it's the same code (the pairing counts only with Same code)
  const sameAsked = () => asking() && C.allowed && !C.codeOk;
  // allowed there and the same code here (or on a cable, where its Allow is enough): it's being connected (a phone takes
  // a moment to say it has this PC's pairing). Nothing is asked of anyone any more, so there's nothing to cancel.
  const linking = () => asking() && C.allowed && C.codeOk;
  function frame(t) {
    if (down) p = Math.min(1, (t - t0) / HOLD_MS); else p = Math.max(0, p - 0.06);
    arc.style.strokeDashoffset = String(LEN * (1 - (1 - Math.pow(1 - p, 3))));
    if (down && p >= 1 && !done) { done = true; down = false; btn.classList.remove('down'); send('go'); }
    if (down || p > 0) raf = requestAnimationFrame(frame); else { raf = 0; arc.style.strokeDashoffset = String(LEN); }
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // Connect pressed: the card stays on Home for it, with a phone connected too (nav.css: it's out of the way there once
  // nothing is being connected). Pressed again after "Can't find your phone?", "Not connected" or "Connected to", main
  // starts over from nothing being connected: that isn't the connecting ending, and the card stays under the press.
  // (A press with nothing being connected, let go too soon, connects nothing: the card it kept for itself isn't kept
  // after it, or it would stay on Home once a phone connects by itself. added: this press put it there.)
  let again = false, added = false;
  const hold = () => {
    added = C.phase === 'idle' && !$('cn').classList.contains('want');
    $('cn').classList.add('want');
    if (/^(looking|none|done|failed)$/.test(C.phase)) again = true;
    send('hold');
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || asking()) return;
    e.preventDefault();
    ptrAt = performance.now();
    try { btn.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    down = true; done = false; nudge = ''; t0 = performance.now() - p * HOLD_MS;
    btn.classList.add('down');
    hold();
    render();
    kick();
  });
  const up = () => {
    if (!down) return;
    down = false;
    btn.classList.remove('down');
    if (!done) {
      send('let-go');
      if (added && C.phase === 'idle') $('cn').classList.remove('want');
      added = false;
      // a click: it's held, not clicked (said once, where the user is looking)
      if (p < 0.5) { nudge = 'Keep holding Connect until the ring fills.'; render(); }
    }
  };
  const ptrEnd = () => { ptrAt = performance.now(); };
  btn.addEventListener('pointerup', ptrEnd);
  btn.addEventListener('pointercancel', ptrEnd);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
  // the keyboard, screen readers and voice control can't hold: Enter or Space, or their press, goes ahead at once
  const goNow = () => { nudge = ''; hold(); send('go'); };
  btn.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || asking()) return;
    e.preventDefault();
    keyAt = performance.now();
    // (a key held down repeats: it went ahead once, and the click a held Space ends with isn't another press)
    if (e.repeat) return;
    goNow();
  });
  // A screen reader's press (browse mode Enter, VoiceOver's VO-Space, Narrator) and voice control's "click Connect" come
  // as a click alone, with no pointer held before it. A mouse or a finger did press it first: that click is the end of
  // a hold already answered above (too short: it says to hold, and nothing connects). (A tap's click can come a moment
  // after the finger lifts.)
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - ptrAt < 1000 || now - keyAt < 1000 || asking()) return;
    goNow();
    render();
  });

  // The card's body is drawn again only when what it shows changes (main says something many times a second while it
  // asks, once for each change in the devices around), so the keyboard and a screen reader stay where they are. When it
  // is drawn again, the keyboard goes back to the same control (data-k), or to Connect if that one went: never to the page.
  let drawn = '';
  function render() {
    const t = C.target, nm = t ? iso(t.name) : '';
    const hs = C.hot || {};
    const stays = C.hotStays && /^(idle|none|done|failed)$/.test(C.phase) ? C.hotStays : null;
    const sig = JSON.stringify([C.phase, !!C.hotCan, C.phase === 'hot' ? [hs.state, hs.ssid, hs.pass, !!hs.qr] : 0,
      C.phase === 'choose' ? C.list : 0, C.phase === 'asking' ? [C.code, sameAsked(), linking()] : 0, stays ? stays.ssid : 0]);
    const draw = sig !== drawn;
    const had = draw && body.contains(document.activeElement) ? document.activeElement.dataset.k || '' : null;
    if (draw) { drawn = sig; body.textContent = ''; }
    // (not disabled while it asks: the keyboard stays on it, rather than being dropped to the page)
    if (asking()) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
    btn.classList.toggle('busy', C.phase === 'looking' || C.phase === 'hot' || asking());
    let a = 'Connect a device', b = nudge || 'Hold Connect here, or on your phone or other computer. The other one asks to allow it.';
    switch (C.phase) {
      case 'looking': a = 'Looking for devices nearby…'; b = 'Keep Flick open on the other device.'; break;
      case 'none':
        // (something answered that can't be asked, an older Flick or one paired already: main says which, and why, and
        // it's said, with the usual way on. Nothing answered: "Can't find your phone?", with the ways that don't need
        // the same Wi-Fi as plain choices)
        if (C.near === 'old' || C.near === 'paired') {
          a = C.near === 'old' ? 'Flick needs updating there' : 'Nothing new to connect';
          b = C.why || 'Open Flick on the other device, on the same network as this PC, then hold Connect again.';
          if (draw) hotWay();
          break;
        }
        a = 'Can’t find your phone?';
        b = C.why ? C.why + '. Try one of these, or hold Connect again.' : 'Check that Flick is open on it. Then try one of these, or hold Connect again.';
        if (draw) ways();
        break;
      case 'hot': {
        const h = hs;
        if (h.state === 'on' && h.qr) {
          a = 'Join this PC’s Wi-Fi on your phone';
          b = 'Scan the code with your phone’s camera and join the network, then open Flick on it. It’s asked here as soon as it’s there.';
          if (draw) {
            const box = el('div', 'cnqr');
            box.setAttribute('role', 'img');
            box.setAttribute('aria-label', 'Code to join this PC’s Wi-Fi network ' + h.ssid);
            const NS = 'http://www.w3.org/2000/svg';
            const sv = document.createElementNS(NS, 'svg');
            const px = Math.max(1, Math.floor(168 / h.qr.n)) * h.qr.n;
            sv.setAttribute('viewBox', '0 0 ' + h.qr.n + ' ' + h.qr.n);
            sv.setAttribute('width', px); sv.setAttribute('height', px);
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', h.qr.d);
            sv.appendChild(path);
            box.appendChild(sv);
            // (the network's name and password, to type in by hand: behind "Can't scan?")
            const t = el('div', 'cnwifi');
            t.id = 'cnWifi';
            t.hidden = true;
            t.append('Wi-Fi ', el('b', 'mono', h.ssid), ' · password ', el('b', 'mono', h.pass));
            const cs = key(el('button', 'link cnscan', 'Can’t scan?'), 'scan');
            cs.type = 'button';
            cs.setAttribute('aria-expanded', 'false');
            cs.setAttribute('aria-controls', 'cnWifi');
            cs.onclick = () => { t.hidden = !t.hidden; cs.setAttribute('aria-expanded', String(!t.hidden)); };
            body.append(box, cs, t);
          }
        } else {
          a = 'Starting this PC’s Wi-Fi…';
          b = 'This takes a few seconds.';
        }
        if (draw) body.appendChild(cancelLink('Cancel'));
        break;
      }
      case 'choose': {
        a = 'Which one?';
        b = 'Pick the device to connect to. It asks to allow it.';
        if (!draw) break;
        const list = el('div', 'cnlist');
        list.setAttribute('role', 'list');
        for (const d of C.list || []) {
          // (the list item holds the button: a screen reader says each is a button, in a list)
          const li = el('div', 'cnli');
          li.setAttribute('role', 'listitem');
          const r = key(el('button', 'cnitem'), 'item:' + d.id);
          r.type = 'button';
          const ic = el('span', 'cnic'); ic.innerHTML = ICON[d.kind === 'phone' ? 'phone' : 'pc'];
          const n = el('span', 'cnname', d.name);
          r.append(ic, n);
          if (d.ready) r.appendChild(el('span', 'cntag', 'Flick open'));
          r.setAttribute('aria-label', 'Connect to ' + d.name + (d.kind === 'phone' ? ', a phone' : ', a computer'));
          r.onclick = () => send('pick', { id: d.id });
          li.appendChild(r);
          list.appendChild(li);
        }
        body.appendChild(list);
        hotWay();                                    // (the phone meant may not be among them)
        body.appendChild(cancelLink('Cancel'));
        break;
      }
      case 'asking':
        if (linking()) {
          a = 'Connecting to ' + nm + '…';
          b = 'Allowed there. A moment…';
          break;
        }
        a = sameAsked() ? nm + ' allowed it' : 'Asking ' + nm + '…';
        b = sameAsked() ? 'Is this the code it showed?' : 'Allow it on ' + nm + '.' + (C.code ? ' It shows the same code.' : '');
        if (!draw) break;
        if (C.code) {
          const pin = el('b', 'cnpin', C.code.slice(0, 3) + ' ' + C.code.slice(3));
          pin.id = 'cnPin';
          pin.setAttribute('aria-label', 'Code ' + C.code.split('').join(' '));
          body.appendChild(pin);
        }
        if (sameAsked()) {
          // (as Devices asks it: only Same code pairs them; Different code undoes it on both)
          const bb = el('div', 'cnbtns');
          const same = key(el('button', 'btn', 'Same code'), 'same');
          same.type = 'button';
          if (C.code) same.setAttribute('aria-describedby', 'cnPin');
          same.onclick = () => send('confirm', { same: true });
          const diff = key(el('button', 'btn ghost', 'Different code'), 'diff');
          diff.type = 'button';
          diff.onclick = () => send('confirm', { same: false });
          bb.append(same, diff);
          body.appendChild(bb);
        } else {
          // (the one asked at once, the only one found here, may not be the phone meant: until it shows a code)
          if (!C.code) hotWay();
          body.appendChild(cancelLink('Cancel'));
        }
        break;
      case 'done':
        a = 'Connected to ' + nm;
        b = t && t.kind === 'phone' ? 'It connects to this PC in a moment. Send files either way.' : 'Send files either way: drop them on it in Devices.';
        break;
      case 'failed': a = 'Not connected'; b = C.why || 'It didn’t work. Hold Connect to try again.'; break;
      default: break;
    }
    // this PC's own Wi-Fi network, still on for a phone connected over it: said, and it can be turned off here
    if (draw && stays) {
      const w = el('div', 'cnhoton');
      w.append('This PC’s Wi-Fi network ', el('b', 'mono', stays.ssid), ' is on for your phone. ');
      const off = key(el('button', 'link cnhotoff', 'Turn it off'), 'hotoff');
      off.type = 'button';
      off.onclick = () => send('hot-off');
      w.appendChild(off);
      body.appendChild(w);
    }
    if (title.textContent !== a) title.textContent = a;
    if (text.textContent !== b) text.textContent = b;
    $('cn').dataset.phase = C.phase;
    if (had !== null) {
      const f = had ? body.querySelector('[data-k="' + CSS.escape(had) + '"]') : null;
      (f || btn).focus({ preventScroll: true });
    }
  }
  // a phone on another Wi-Fi: this PC's own network, joined from a code (main takes back a request it's asking first)
  function hotWay() {
    if (!C.hotCan) return;
    const h = key(el('button', 'btn ghost cnhot', 'Use this PC’s Wi-Fi'), 'hot');
    h.type = 'button';
    h.setAttribute('aria-describedby', 'cnHotWhy');
    h.onclick = () => send('hot');
    const w = el('div', 'cnhotwhy', 'This PC makes a Wi-Fi network your phone joins from a code.');
    w.id = 'cnHotWhy';
    body.append(h, w);
  }
  // Can't find your phone?: this PC's own Wi-Fi (from a code), a USB cable, and help for the same Wi-Fi; then, as small
  // links, this PC's address to type on the phone, and Bluetooth (Advanced settings › Connections: on Windows, where
  // Flick has it; the window's state says so, kept by tour.js)
  function ways() {
    const list = el('div', 'cnways');
    const way = (k, t1, t2, go) => {
      const b = key(el('button', 'cnway'), k);
      b.type = 'button';
      b.append(el('span', 'cnw1', t1), el('span', 'cnw2', t2));
      b.onclick = go;
      list.appendChild(b);
      return b;
    };
    if (C.hotCan) way('hot', 'Use this PC’s Wi-Fi', 'Your phone joins a network this PC makes, from a code.', () => send('hot'));
    const cable = way('cable', 'Use a USB cable', 'The fastest way. Plug the phone into this PC.', null);
    const how = el('div', 'cnhow2', 'Plug the phone into this PC, then on the phone turn on USB tethering (in its settings, under Hotspot and tethering). Then hold Connect again.');
    how.id = 'cnCableHow';
    how.hidden = true;
    cable.setAttribute('aria-expanded', 'false');
    cable.setAttribute('aria-controls', 'cnCableHow');
    cable.onclick = () => { how.hidden = !how.hidden; cable.setAttribute('aria-expanded', String(!how.hidden)); };
    cable.after(how);
    way('wifi', 'Same Wi-Fi, still nothing?', 'Let Flick through this PC’s firewall, and other fixes.', () => {
      if (window.flickNav) window.flickNav.go('settings');
      $('firewall').click();
    });
    body.appendChild(list);
    const more = el('div', 'cnmore');
    const ad = key(el('button', 'link', 'Type this PC’s address on the phone'), 'addr');
    ad.type = 'button';
    const at = el('div', 'cnaddr mono');
    at.id = 'cnAddr';
    at.hidden = true;
    ad.setAttribute('aria-expanded', 'false');
    ad.setAttribute('aria-controls', 'cnAddr');
    ad.onclick = () => { at.textContent = $('addr').textContent; at.hidden = !at.hidden; ad.setAttribute('aria-expanded', String(!at.hidden)); };
    more.append(ad, at);
    if (window.flickState && window.flickState.isWin) {
      const bt = key(el('button', 'link', 'Bluetooth'), 'bt');
      bt.type = 'button';
      bt.onclick = () => { if (window.flickNav) window.flickNav.adv('conn'); };
      more.appendChild(bt);
    }
    body.append(more, cancelLink('Close'));
  }
  function cancelLink(label) {
    const c = key(el('button', 'link cncancel', label), 'cancel');
    c.type = 'button';
    c.onclick = () => send('cancel');
    return c;
  }

  api.on('panel:connect', (s) => {
    const was = C.phase, wasSame = sameAsked();
    const inCard = $('cn').contains(document.activeElement);
    C = s || { phase: 'idle' };
    // (asked for while a phone is connected, from Devices or by pressing Connect: shown on Home until that connecting
    // ends. Not when Connect was pressed again and main started over for it: hold())
    if (was !== 'idle' && C.phase === 'idle') { if (again) again = false; else $('cn').classList.remove('want'); }
    else if (/^(choose|hot|asking)$/.test(C.phase)) again = false;
    if (C.phase !== 'idle') added = false;
    if (C.phase !== 'idle') nudge = '';
    render();
    // (the card left Home with that, a phone being connected: the keyboard on it goes to Send files, not to the page)
    if (inCard && !$('cn').getClientRects().length) $('sendFiles').focus();
    // (a list to pick from, or the code: the keyboard goes there)
    if (was !== C.phase && C.phase === 'choose') { const f = body.querySelector('.cnitem'); if (f && $('cn').contains(document.activeElement)) f.focus(); }
    // (allowed there: the keyboard goes to Same code, the answer asked for now; from the card, or from nowhere)
    if (!wasSame && sameAsked()) {
      const f = body.querySelector('[data-k="same"]'), at = document.activeElement;
      if (f && (!at || at === document.body || $('cn').contains(at))) f.focus();
    }
  });
  // Devices: Connect a device brings this one into view
  window.flickConnect = () => { $('cn').classList.add('want'); $('cn').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); btn.focus({ preventScroll: true }); $('cn').classList.remove('flash'); void $('cn').offsetWidth; $('cn').classList.add('flash'); };
  render();
  send('hello');
})();
