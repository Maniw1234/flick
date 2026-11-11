/* Other phones: phone to phone. Another phone with Flick open on the same Wi-Fi (or on this one's hotspot) shows up
 * here while this page looks for it (peerScan). Pairing is once, with a 6-digit code shown on both: one phone allows
 * it, the other says the codes match, and from then on each can send to the other (peerSend): files and folders from
 * Flick, or picked with Android's pickers. A phone asking to pair with this one gets Allow / Don't allow wherever Flick
 * is (peer-ask); what it sends lands at the top of the view like files from the PC (app.js: incomingCard). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  if (!A.has('peerState')) return;                 // a phone app from before this
  const h = X.h;
  A.icons.phone = '<svg viewBox="0 0 24 24"><rect x="6.6" y="2.8" width="10.8" height="18.4" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.6 18.1h2.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  A.icons.ring = '<svg viewBox="0 0 24 24"><rect x="8" y="4" width="8" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.6 9a6.2 6.2 0 0 0 0 6M19.4 9a6.2 6.2 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  // A name from the network is shown as text, without direction controls (a name can't turn the words around it
  // backwards: "Mia" + U+202E would show the rest of a sentence reversed), and in a sentence it's set apart (<bdi>), so a
  // Hebrew or Arabic name doesn't reorder the words around it either.
  // (core.js X.clean: without direction controls, and a name of only invisible marks is none, so the default shows)
  const clean = (s) => X.clean(s);
  function cleanState(st) {
    st = st || {};
    for (const d of st.devices || []) d.name = clean(d.name) || 'Phone';
    if (st.ask) st.ask.name = clean(st.ask.name) || 'A phone';
    if (st.me) st.me = clean(st.me);
    return st;
  }
  // an element with words and names: say('p', '', ['Allow it if ', { n: name }, ' shows the same code.'])
  function say(tag, cls, parts) {
    const e = h(tag, cls);
    for (const x of parts) {
      if (x && typeof x === 'object') { const b = document.createElement('bdi'); b.textContent = x.n; e.appendChild(b); }
      else e.appendChild(document.createTextNode(String(x)));
    }
    return e;
  }

  let S = cleanState(A.njson('peerState'));         // the app's state ('peers' events keep it)
  const devs = () => S.devices || [];
  // (paired one way: it can send here, this phone can't send to it: listed, to remove it or pair from here too)
  const paired = () => devs().filter((d) => d.paired && !d.oneWay);
  const byId = (id) => devs().find((d) => d.id === id) || null;
  // numbers through the page's one formatter (A.fmtNum), made just after the first frame: the first toLocaleString()
  // had Chromium ready its number formatting on the way to that frame (30 ms of a mid-range phone's start). Words with
  // a number that can come before it (another phone's files announced as Flick opens) wait for it: toast(() => ...),
  // and the Accept question (accShow).
  const num = (n) => (A.fmtNum ? A.fmtNum(+n || 0) : (+n || 0).toLocaleString());
  let framed = false;
  requestAnimationFrame(() => setTimeout(() => { framed = true; accShow(); }, 0));
  const plural = (n, one, many) => num(n) + ' ' + (+n === 1 ? one : many);
  const what = (items) => (items.length === 1 ? A.midName(items[0].name) : plural(items.length, 'item', 'items'));

  // ------------------------------------------------------------------ the page
  const page = X.page({ id: 'fPhones', title: 'Other phones' });
  X.menu(5, () => ({ label: 'Other phones', icon: 'phone', tile: true, tag: devs().some((d) => d.busy === 'sending') ? 'Sending…' : '', run: openPage }));
  // other phones are looked for while this page shows them (the Connect screen looks for them too: app.js)
  const scan = (on) => { if (A.peerScanFor) A.peerScanFor('phones', on); else A.nc('peerScan', on); };
  const close0 = page.close;
  page.close = () => { const r = close0(); if (r) scan(false); return r; };

  function openPage() {
    scan(true);
    S = cleanState(A.njson('peerState') || S);
    shape = '';
    render();
    page.open();
  }

  let renderT = 0;
  function renderSoon() { if (!renderT) renderT = setTimeout(() => { renderT = 0; if (page.isOpen()) render(); }, 60); }

  // Rows stay the same elements while a send's figures change (a row rebuilt under a finger lost its tap); the page is
  // built anew only when what it shows changes shape.
  const rows = new Map();                          // phone id -> its row
  const canceledThere = new Map();                 // phone id -> the words of its send canceled there ("Canceled on …")
  let shape = '';
  const sigOf = (d) => [d.id, d.name, d.paired, !!d.oneWay, !!d.waiting, d.nearby, d.busy || '', d.code || '', d.codeOk, d.allowed, d.error || '', d.progress ? [d.progress.files, d.progress.name, d.progress.asking, d.progress.total > 0] : 0];

  function render() {
    const body = page.body;
    const list = devs();
    const sig = JSON.stringify([list.map(sigOf), S.on, S.receiving, S.me, ringing ? ringing.id : '']);
    if (sig === shape) { for (const d of list) { const r = rows.get(d.id); if (r) figures(r, d); } return; }
    // A focused control keeps the keyboard and screen reader where they were: the same control (data-k) in the same
    // row, or the switch; the code when one shows (never an answer to it); else the row's first control.
    const act = document.activeElement && page.el.contains(document.activeElement) ? document.activeElement : null;
    const hadRow = act ? act.closest('.fphrow') : null;
    const focusId = hadRow ? hadRow.dataset.id : null;
    const focusK = act ? act.dataset.k || '' : null;
    const rowAt = hadRow ? Array.from(body.querySelectorAll('.fphrow')).indexOf(hadRow) : -1;
    shape = sig;
    rows.clear();
    body.innerHTML = '';
    const mine = list.filter((d) => d.paired), near = list.filter((d) => !d.paired);
    if (mine.length) body.appendChild(group('Paired', mine));
    if (near.length) body.appendChild(group('Nearby', near));
    if (!list.length) {
      const w = h('div', 'fphwait');
      w.appendChild(h('i', 'spin'));
      w.appendChild(h('b', '', 'Looking for phones…'));
      w.appendChild(h('p', '', 'Open Flick on the other phone. Both need to be on the same Wi-Fi, or one on the other’s hotspot.'));
      body.appendChild(w);
    } else if (!mine.length) {
      body.appendChild(h('div', 'fknote fphnote', 'Connect once, then send files to each other any time. Make sure Flick is open on the other phone.'));
    }
    // a new device of any kind: the Connect screen (hold Connect, Allow on the other one)
    if (A.connectNew) {
      const c = key(h('button', 'fphconnect', 'Connect a device'), 'connect');
      c.onclick = () => { A.haptic('soft'); page.close(); setTimeout(() => A.connectNew(), 220); };
      body.appendChild(c);
    }
    body.appendChild(receiveSwitch());
    let f = null;
    if (focusId) {
      let r = rows.get(focusId);
      // (Same code as it shows, to answer at once, unless the keyboard was on Different code)
      const same = focusK !== 'diff' && r ? r.querySelector('[data-k="same"]') : null;
      if (r) f = same || (focusK && r.querySelector('[data-k="' + focusK + '"]:not([disabled])')) || r.querySelector('[data-k="pin"]') || r.querySelector('button:not([disabled])');
      else {
        // its phone went (Remove, from its own ⋯): the phone now in its place, or the last; none left, Connect a device.
        // The focus dropped to the start of the document, and TalkBack lost its place
        const all = Array.from(body.querySelectorAll('.fphrow'));
        r = all[Math.min(rowAt, all.length - 1)];
        f = (r && ((focusK && r.querySelector('[data-k="' + focusK + '"]:not([disabled])')) || r.querySelector('button:not([disabled])'))) ||
          body.querySelector('[data-k="connect"]') || body.querySelector('[data-k="recv"]');
      }
    } else if (focusK) f = body.querySelector('[data-k="' + focusK + '"]');
    if (f) f.focus({ preventScroll: true });
  }
  const key = (e, k) => { e.dataset.k = k; return e; };

  function group(title, list) {
    const g = h('section', 'sgroup');
    g.appendChild(h('h3', '', title));
    const card = h('div', 'scard');
    card.setAttribute('role', 'list');
    for (const d of list) card.appendChild(row(d));
    g.appendChild(card);
    return g;
  }

  function row(d) {
    const r = h('div', 'fphrow');
    r.setAttribute('role', 'listitem');
    r.dataset.id = d.id;
    const top = h('div', 'frow');
    const main = h('button', 'fmain');
    const ic = h('span', 'fic');
    ic.appendChild(A.svgEl(A.icons.phone));
    const tx = h('span', 'ftx');
    r._name = X.nm('b', '', d.name);
    r._sub = h('small');
    r._bad = h('small', 'fbad');
    r._bar = h('span', 'fxbar');
    r._fill = h('i');
    r._bar.appendChild(r._fill);
    tx.append(r._name, r._sub, r._bad, r._bar);
    main.append(ic, tx);
    top.appendChild(main);
    key(main, 'main');
    if (d.busy === 'sending') {
      const c = key(h('button', 'fphpill ghost', 'Cancel'), 'stop');
      c.setAttribute('aria-label', 'Stop sending to ' + d.name);
      c.onclick = () => { A.haptic('tick'); A.nc('peerCancel', d.id); };
      top.appendChild(c);
      main.disabled = true;
    } else if (d.busy === 'pairing') {
      main.disabled = true;
    } else if (d.oneWay) {
      // it can send here; to send to it, pair from here too (once it's nearby, and its own pairing is confirmed)
      if (d.nearby && !d.waiting) {
        const b = key(h('button', 'fphpill', 'Pair'), 'pair');
        b.setAttribute('aria-label', 'Pair with ' + d.name);
        b.onclick = () => pair(d);
        main.onclick = () => pair(d);
        top.appendChild(b);
      } else main.disabled = true;
      const more = key(h('button', 'fmore'), 'more');
      more.setAttribute('aria-label', 'More for ' + d.name);
      more.appendChild(A.svgEl(X.SVG.dots));
      more.onclick = () => moreSheet(d);
      top.appendChild(more);
    } else if (d.paired) {
      const b = key(h('button', 'fphpill', 'Send'), 'send');
      b.setAttribute('aria-label', 'Send to ' + d.name);
      b.onclick = () => sendSheet(d);
      main.onclick = () => sendSheet(d);
      const more = key(h('button', 'fmore'), 'more');
      more.setAttribute('aria-label', 'More for ' + d.name);
      more.appendChild(A.svgEl(X.SVG.dots));
      more.onclick = () => moreSheet(d);
      top.append(b, more);
    } else if (d.nearby) {
      const b = key(h('button', 'fphpill', 'Pair'), 'pair');
      b.setAttribute('aria-label', 'Pair with ' + d.name);
      b.onclick = () => pair(d);
      main.onclick = () => pair(d);
      top.appendChild(b);
    }
    r.appendChild(top);
    if (d.busy === 'pairing') r.appendChild(codeBox(d));
    rows.set(d.id, r);
    figures(r, d);
    return r;
  }

  // a row's words and bar: what it is, or how its send is going
  function figures(r, d) {
    const p = d.progress;
    let sub;
    if (d.busy === 'sending') {
      const it = p && p.files > 1 ? plural(p.files, 'file', 'files') : (p && p.name) ? clean(p.name) : 'files';
      // (what it waits on is counted as the other side asks: the items picked, a folder being one)
      const asked = p && p.items > 1 ? plural(p.items, 'item', 'items') : (p && p.name) ? clean(p.name) : 'them';
      sub = p && p.asking ? 'Waiting for ' + d.name + ' to accept ' + asked + '…'
        : p && p.total > 0 ? 'Sending ' + it + ' · ' + A.fmtSize(Math.min(p.sent, p.total)) + ' of ' + A.fmtSize(p.total) : 'Sending ' + it + '…';
    } else if (d.busy === 'pairing') sub = 'Pairing…';
    else if (d.oneWay && d.waiting) sub = 'Allowed here. Waiting for ' + d.name + ' to confirm the code there…';
    else if (d.oneWay) sub = 'Can send files here. To send to it, pair from here too' + (d.nearby ? '.' : ' when it’s nearby.');
    else if (ringing && ringing.id === d.id) sub = 'Ringing…';
    else if (d.paired) sub = d.nearby ? 'Ready' + (d.via === 'usb' ? ' · USB cable' : d.via === 'bluetooth' ? ' · Bluetooth' : '') : 'Not seen nearby right now';
    else sub = d.via === 'usb' ? 'On the USB cable' : d.via === 'bluetooth' ? 'Nearby · Bluetooth' : 'Nearby';
    if (r._sub.textContent !== sub) { r._sub.textContent = sub; r._sub.dir = 'auto'; }
    r._sub.className = d.busy ? 'fbusy' : d.oneWay ? 'fway' : '';
    const bad = d.busy ? '' : clean(d.error || '');
    if (r._bad.textContent !== bad) r._bad.textContent = bad;
    // (its last send canceled there: the words say so, as a note, not as an error. The app's state says so (errorKind),
    // also after a reload; with an app that doesn't, the event that came with it)
    const cls = bad && (d.errorKind === 'canceled' || canceledThere.get(d.id) === bad) ? 'fcan' : 'fbad';
    if (r._bad.className !== cls) r._bad.className = cls;
    r._bad.hidden = !bad;
    r._bar.hidden = d.busy !== 'sending';
    if (d.busy === 'sending') r._fill.style.transform = 'scaleX(' + (p && p.total > 0 ? Math.min(1, p.sent / p.total) : 0) + ')';
  }

  // pairing: the code, and what to do with it
  function codeBox(d) {
    const box = h('div', 'fphcode');
    const btns = h('div', 'abtns');
    const nm = { n: d.name };
    if (!d.code) {
      box.appendChild(say('p', '', ['Connecting to ', nm, '…']));
      btns.appendChild(key(button('Cancel', '', () => A.nc('peerCancel', d.id)), 'cancel'));
    } else {
      box.appendChild(h('small', '', 'Pairing code'));
      const pin = key(h('b', 'fphpin', d.code.slice(0, 3) + ' ' + d.code.slice(3)), 'pin');
      pin.tabIndex = -1;                           // (the keyboard and screen reader land on the code when it shows)
      pin.setAttribute('aria-label', 'Pairing code ' + d.code.split('').join(' '));
      box.appendChild(pin);
      // (as on the Connect screen: Allow there first; then, unless the app knows it already (a USB cable), the codes
      // are compared here, and the pairing counts once they match)
      const check = d.allowed && !d.codeOk;
      box.appendChild(say('p', '', check ? [nm, ' allowed it. Is this the code it showed?'] : ['Tap Allow on ', nm, '. It shows the same code.']));
      if (check) {
        btns.appendChild(key(button('Different code', '', () => A.nc('peerConfirm', d.id, false)), 'diff'));
        btns.appendChild(key(button('Same code', 'primary', () => A.nc('peerConfirm', d.id, true)), 'same'));
      } else btns.appendChild(key(button('Cancel', '', () => A.nc('peerCancel', d.id)), 'cancel'));
    }
    box.appendChild(btns);
    return box;
  }
  function button(text, cls, run) {
    const b = h('button', cls, text);
    b.onclick = () => { A.haptic('tick'); run(); };
    return b;
  }

  // asked from here: once the other phone's user allows it there, both are paired (the code shows on both, to check)
  function pair(d) {
    A.haptic('tick');
    A.nc(A.has('peerPairAuto') ? 'peerPairAuto' : 'peerPair', d.id);
  }

  function moreSheet(d0) {
    const d = byId(d0.id) || d0;                   // (as it is now: its row may be older than the last change)
    const items = [];
    if (!d.oneWay && d.paired && A.has('peerMsg')) {
      // Find my phone, for the other phone: it rings there until it's found (or Stop here)
      if (ringing && ringing.id === d.id) items.push({ label: 'Stop ringing ' + d.name, icon: 'off', run: () => ring(d, false) });
      else items.push({ label: 'Find ' + d.name, icon: 'ring', tag: 'Makes it ring', run: () => ring(d, true) });
      if (A.has('sendClipboardTo')) items.push({ label: 'Send clipboard', icon: 'clipboard', tag: 'What’s copied here goes onto its clipboard', run: () => { A.haptic('tick'); A.nc('sendClipboardTo', d.id); } });
    }
    if (d.paired && A.has('peerAsk')) {
      // files from it: saved as they come, or after Accept here
      items.push(d.ask
        ? { label: 'Always accept its files', icon: 'check', tag: 'Now: you’re asked before each one is saved', run: () => { A.nc('peerAsk', d.id, false); A.toast('Files from ' + d.name + ' are saved as they come', 2200); } }
        : { label: 'Ask before saving its files', icon: 'check', tag: 'Now: they’re saved as they come', run: () => { A.nc('peerAsk', d.id, true); A.toast('You’ll be asked before files from ' + d.name + ' are saved', 2400); } });
    }
    // (asked first, as Clear the Flick list is: it can't be taken back, pairing again needs both phones in hand)
    items.push({ label: 'Remove', icon: 'trash', danger: true, tag: d.oneWay ? 'It can’t send files here any more' : 'Unpairs both phones', run: () => {
      A.openSheet('Remove ' + d.name + '? ' + (d.oneWay ? 'It can’t send files here any more.' : 'Both phones forget each other.'), [
        { label: 'Remove', icon: 'trash', danger: true, run: () => { A.nc('peerForget', d.id); A.toast('Removed ' + d.name, 1800); } },
        { label: 'Cancel', run: () => {} },
      ], { focus: 'Cancel' });
    } });
    A.openSheet(d.name, items);
  }

  // ------------------------------------------------------------------ Find my phone, for another phone
  let ringing = null, ringT = 0;                   // { id, name }: ringing there now (30 s, or until it's found)
  async function ring(d, on) {
    A.haptic('tick');
    if (on) A.toast('Making ' + d.name + ' ring…', 1400);
    const r = await X.peerMsg(d.id, 'ring', on ? 'on' : 'off');
    if (!on) { ringEnd(); A.toast(r.ok ? d.name + ' stopped ringing' : X.peerWhy(r.why, d.name), 2000); return; }
    if (!r.ok) { A.haptic('reject'); A.toast(X.peerWhy(r.why, d.name), 2800); return; }
    ringing = { id: d.id, name: d.name };
    clearTimeout(ringT);
    ringT = setTimeout(ringEnd, 32000);
    A.toast(d.name + ' is ringing. It stops when it’s found.', 2600);
    shape = ''; renderSoon();
  }
  function ringEnd() { clearTimeout(ringT); if (!ringing) return; ringing = null; shape = ''; renderSoon(); }
  A.on('native', (e) => {
    if (e.t !== 'peer-ring-found') return;
    const nm = clean(e.name) || (byId(e.id) || {}).name || 'The other phone';
    if (ringing && ringing.id === e.id) ringEnd();
    A.haptic('confirm');
    A.toast(nm + ' was found', 2400);
  });

  // "Let other phones send to this phone"
  function receiveSwitch() {
    const g = h('section', 'sgroup');
    const card = h('div', 'scard');
    const row = h('div', 'srow');
    const lab = h('div', 'sl');
    lab.appendChild(h('b', '', 'Let other phones send to this phone'));
    lab.appendChild(S.on === false ? h('small', '', 'Other phones can’t find this phone or send to it.')
      : S.receiving === false ? h('small', '', 'Other phones can’t send to this phone right now. Close Flick and open it again.')
      : say('small', '', ['Phones you paired with can send you files while Flick is open, or any time with Settings › Stay connected in the background on. Others nearby see “', { n: S.me || 'this phone' }, '”.']));
    const l = h('label', 'stog');
    const i = key(h('input'), 'recv');
    i.type = 'checkbox';
    i.checked = S.on !== false;
    i.setAttribute('aria-label', 'Let other phones send to this phone');
    i.onchange = () => { A.haptic('tick'); A.nc('peerReceive', i.checked); S.on = i.checked; setTimeout(() => { shape = ''; renderSoon(); }, 250); };
    l.append(i, h('span'));
    row.append(lab, l);
    card.appendChild(row);
    g.appendChild(card);
    return g;
  }

  // ------------------------------------------------------------------ sending
  /** Sends items to a phone (also History's "Send again": X.phoneSend). fx: how it was flicked ({ look, y, vx }: its
   *  card arrives there the same way), or nothing. */
  function send(id, name, items, fx) {
    items = (items || []).filter((x) => x && !x.incoming);
    if (!items.length) { A.toast('Choose what to send first', 2000); return false; }
    const spec = items.map((x) => (x.path ? { path: x.path } : { id: x.id }));
    const r = fx && A.has('peerSendFx') ? A.nc('peerSendFx', id, JSON.stringify(spec), JSON.stringify(fx)) : A.nc('peerSend', id, JSON.stringify(spec));
    const nm = clean(name || (byId(id) || {}).name) || 'that phone';
    if (r === 'busy') { A.toast('Wait until what’s going to ' + nm + ' is sent', 2400); return false; }
    if (r === 'unpaired') { A.toast(nm + ' isn’t paired with this phone any more', 2600); return false; }
    if (r !== 'ok') { A.toast(items.length === 1 ? 'That file can’t be read any more' : 'Those files can’t be read any more', 2400); return false; }
    A.haptic('confirm');
    A.endSelection();
    A.toast('Sending ' + what(items) + ' to ' + nm + '…', 2000);
    return true;
  }
  X.phoneSend = send;

  // to which phone: the one there is, or one picked from a sheet
  function sendTo(items, title) {
    const list = paired();
    if (!list.length) { openPage(); return; }
    if (list.length === 1) { send(list[0].id, list[0].name, items); return; }
    A.openSheet(title || 'Send ' + what(items) + ' to', list.map((d) => ({
      label: d.name, icon: 'phone', tag: d.busy === 'sending' ? 'Sending…' : d.nearby ? 'Nearby' : '',
      run: () => send(d.id, d.name, items),
    })));
  }

  // from the page: Android's pickers (the picked files come back tagged with this pick), or choosing in Flick
  let picking = null;                              // { tag, id, name }
  function sendSheet(d) {
    A.openSheet('Send to ' + d.name, [
      A.has('pickFor') ? { label: 'Photos & videos', icon: 'photo', run: () => pick(d, 'media') } : null,
      A.has('pickFor') ? { label: 'Files', icon: 'file', run: () => pick(d, 'files') } : null,
      { label: 'Choose in Flick', icon: 'check', run: () => choose(d) },
    ]);
  }
  function pick(d, kind) {
    picking = { tag: 'ph' + A.rid(), id: d.id, name: d.name };
    A.nc('pickFor', kind, picking.tag);
  }
  let chooseFor = null;                            // { id, name }: what's selected goes to this phone
  function choose(d) {
    chooseFor = { id: d.id, name: d.name };
    page.close();
    setTimeout(() => {
      if (A.st.screen !== 'main') A.showScreen('main');
      A.startSelection();
      A.redrawSelection();
      A.toast('Tap what to send to ' + d.name, 2200);
    }, 220);
  }
  A.on('select', (on) => { if (!on) chooseFor = null; updateSelBtn(); });
  // choosing for a phone goes on until it's sent or closed: through nothing selected for a moment, another tab, a search
  A.on('selKeep', () => !!chooseFor);

  // The selection's Send button goes where it says, and doesn't change under a finger when the link to the PC comes
  // and goes: to the PC on a phone that has one (connected or not: "Connect to send", as always), and to the paired
  // phone(s) only on a phone that never paired with a PC. The phone button next to it sends to a phone otherwise.
  const hasPc = () => !!A.st.connected || Object.keys(A.knownPcs ? A.knownPcs() : {}).some((id) => A.paired(id)) ||
    !!(A.pref && A.paired(A.pref.get('lastPc', '')));
  const phonesMain = () => !chooseFor && paired().length > 0 && !hasPc();
  A.on('selOther', (n) => {
    const items = n === 1 ? '1 item' : num(n) + ' items';
    if (chooseFor) return n ? 'Send ' + items + ' to ' + chooseFor.name : 'Choose what to send to ' + chooseFor.name;
    if (!phonesMain()) return null;
    const list = paired();
    return 'Send ' + items + ' to ' + (list.length === 1 ? list[0].name : 'a phone');
  });
  A.on('selSend', (items) => {
    if (chooseFor) {
      if (!items.length) { A.toast('Tap the files to send first', 2000); return true; }
      send(chooseFor.id, chooseFor.name, items);
      return true;
    }
    if (!phonesMain()) return false;
    sendTo(items);
    return true;
  });

  // ...and, next to a Send button that goes to the PC, a phone button
  const selBtn = h('button', 'fphsel');
  selBtn.setAttribute('aria-label', 'Send to another phone');
  selBtn.appendChild(A.svgEl(A.icons.phone));
  selBtn.onclick = () => { A.haptic('tick'); sendTo(A.selected()); };
  selBtn.hidden = true;
  const bar = document.getElementById('selBar');
  if (bar) bar.insertBefore(selBtn, document.getElementById('selSend'));
  function updateSelBtn() { selBtn.hidden = !paired().length || !!chooseFor || phonesMain(); }
  A.on('conn', updateSelBtn);

  // a file's or folder's menu: to each paired phone (a sheet of them when there are more than two)
  A.on('itemMenu', (it) => {
    const list = paired();
    if (!list.length || !it || it.incoming) return null;
    if (list.length > 2) return { label: 'Send to a phone', icon: 'phone', run: () => sendTo([it], 'Send ' + A.midName(clean(it.name)) + ' to') };
    return list.map((d) => ({ label: 'Send to ' + d.name, icon: 'phone', run: () => send(d.id, d.name, [it]) }));
  });

  // ------------------------------------------------------------------ a phone asking to pair with this one
  // The app numbers each change to the question (seq): a state made before a newer 'peer-ask' or 'peer-ask-end' (it's
  // made off the app's main thread) neither closes a question that's on screen nor brings back one that was answered.
  let ask = null;                                  // { el, device, code, seq }
  let askSeq = -1, doneSeq = -1, askN = 0;
  const ringOpen = () => !!document.querySelector('.fring:not([hidden])');
  // what the question covers: everything a tap or the keyboard could reach behind it (the ringing screen stays on top)
  const behind = () => ['pair', 'main', 'settings', 'sheet', 'ask', 'fPv'].map((id) => document.getElementById(id))
    .concat([...document.querySelectorAll('.fpage, .ftips, .ftour, .airlayer')]).filter(Boolean);
  function askOpen(e) {
    const seq = +e.seq || 0;
    if (seq && seq <= doneSeq) return;             // answered here already
    if (ask && ask.device === e.device && ask.code === e.code) return;
    askClose(true);
    // A question about files on screen makes way, first in line again (askClose brings it back once this one is answered):
    // the two shared the screen, the one under it still in reach, its words showing through
    let before = document.activeElement;
    if (acc) {
      const a = acc;
      acc = null;
      X.block('fphacc', a.blocked, false);
      a.el.remove();
      accQ.unshift(a.e);
      before = a.before;
    }
    const n = ++askN;
    const name = clean(e.name) || 'A phone';
    const el = h('div', 'fphask');
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'fphAskT' + n);
    el.setAttribute('aria-describedby', 'fphAskS' + n);
    const box = h('div', 'box');
    box.tabIndex = -1;                             // (focus goes to the question, not a ring around one answer)
    // a PC asking (its user held Connect there and picked this phone): allowing it makes it this phone's PC
    const pc = e.kind === 'pc';
    const ic = h('div', 'fphaic');
    ic.appendChild(A.svgEl(pc ? A.icons.pc || A.icons.side : A.icons.phone));
    const t = say('div', 'atitle', [{ n: name }, ' wants to connect']);
    t.id = 'fphAskT' + n;
    const pin = h('b', 'fphpin', String(e.code).slice(0, 3) + ' ' + String(e.code).slice(3));
    pin.setAttribute('aria-label', 'Pairing code ' + String(e.code).split('').join(' '));
    const again = pc ? !!(A.paired && A.paired(e.device)) : !!e.again;
    const s = say('div', 'asub', ['Allow it if ', { n: e.name ? name : pc ? 'the computer' : 'the other phone' }, ' shows the same code. '
      + (pc ? 'Then this phone connects to it.' : 'Then you can send each other files.')
      + (again ? ' It’s paired with this phone already: allowing it replaces that pairing.' : '')]);
    s.id = 'fphAskS' + n;
    const btns = h('div', 'abtns');
    const no = h('button', '', 'Don’t allow');
    const yes = h('button', 'primary', 'Allow');
    no.onclick = () => answer(false);
    yes.onclick = () => answer(true);
    btns.append(no, yes);
    box.append(ic, t, h('small', 'fphcap', 'Pairing code'), pin, s, btns);
    el.append(h('div', 'backdrop'), box);
    document.body.appendChild(el);
    ask = { el, device: e.device, code: e.code, seq, before, blocked: behind(), pc, name: e.name ? name : '' };
    X.block('fphask', ask.blocked, true);
    A.haptic('confirm');
    // (the ringing screen, if it's up, keeps the focus: Stop ringing first)
    setTimeout(() => { if (ask && ask.el === el && !ringOpen()) box.focus({ preventScroll: true }); }, 60);
  }
  function answer(allow) {
    if (!ask) return;
    const a = ask;
    A.haptic(allow ? 'confirm' : 'tick');
    A.nc('peerAnswer', a.device, allow);
    doneSeq = Math.max(doneSeq, a.seq);
    askClose();
    // a PC allowed: its user checks the code there now; the Connect screen says so until its pairing comes
    if (allow && a.pc && A.homeWait) A.homeWait({ device: a.device, name: a.name, code: a.code });
  }
  function askClose(now) {
    if (!ask) return;
    const a = ask;
    ask = null;
    X.block('fphask', a.blocked, false);
    // (replaced by another question: the old one goes at once, so two never share the screen or a screen reader's ear)
    if (now) a.el.remove();
    else { a.el.classList.add('closing'); setTimeout(() => a.el.remove(), 200); }
    if (!now && a.before && a.before.isConnected && typeof a.before.focus === 'function') { try { a.before.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
    if (!now) setTimeout(() => { if (typeof accShow === 'function') accShow(); }, 260);    // a question about files was waiting
  }
  X.back(92, () => { if (!ask) return false; answer(false); return true; });

  // ------------------------------------------------------------------ files waiting for Accept ("Ask each time")
  // One question at a time, after a pairing question if one is up; the app answers the sender (or the time runs out
  // there: 'peer-accept-end').
  let acc = null;                                  // { el, tid }
  const accQ = [];                                 // the ones waiting their turn: { tid, from, name, size, count, folder }
  function accShow() {
    if (acc || ask || !accQ.length || !framed) return;
    const e = accQ.shift();
    const n = ++askN;
    const from = clean(e.from) || 'A device', name = clean(e.name) || 'Files';
    const what = e.folder ? 'the folder ' + A.midName(name) : +e.count > 1 ? plural(e.count, 'item', 'items') : A.midName(name);
    const el = h('div', 'fphask');
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'fphAccT' + n);
    const box = h('div', 'box');
    box.tabIndex = -1;
    const ic = h('div', 'fphaic');
    ic.appendChild(A.svgEl(A.icons.phone));
    const t = say('div', 'atitle', [{ n: from }, ' wants to send you ', what]);
    t.id = 'fphAccT' + n;
    const sub = h('div', 'asub', (+e.size > 0 ? A.fmtSize(+e.size) + '. ' : '') + 'Nothing is saved unless you accept.');
    const btns = h('div', 'abtns');
    const no = h('button', '', 'Decline');
    const yes = h('button', 'primary', 'Accept');
    no.onclick = () => accAnswer(false);
    yes.onclick = () => accAnswer(true);
    btns.append(no, yes);
    box.append(ic, t, sub, btns);
    el.append(h('div', 'backdrop'), box);
    document.body.appendChild(el);
    acc = { el, tid: e.tid, e, before: document.activeElement, blocked: behind() };
    X.block('fphacc', acc.blocked, true);
    A.haptic('confirm');
    setTimeout(() => { if (acc && acc.el === el && !ringOpen()) box.focus({ preventScroll: true }); }, 60);
  }
  function accAnswer(yes) {
    if (!acc) return;
    A.haptic(yes ? 'confirm' : 'tick');
    A.nc('peerAccept', acc.tid, yes);
    accClose(acc.tid);
  }
  function accClose(tid) {
    const i = accQ.findIndex((q) => q.tid === tid);
    if (i >= 0) accQ.splice(i, 1);
    if (!acc || acc.tid !== tid) return;
    const a = acc;
    acc = null;
    X.block('fphacc', a.blocked, false);
    a.el.classList.add('closing');
    setTimeout(() => a.el.remove(), 200);
    if (a.before && a.before.isConnected && typeof a.before.focus === 'function') { try { a.before.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
    setTimeout(accShow, 260);
  }
  function accAdd(e) {
    if (!e || !e.tid || (acc && acc.tid === e.tid) || accQ.some((q) => q.tid === e.tid)) return;
    accQ.push(e);
    accShow();
  }
  X.back(91, () => { if (!acc) return false; accAnswer(false); return true; });

  // ------------------------------------------------------------------ what the app says
  const recentIn = new Set();                      // file ids shown here lately (a repeated 'peer-in' adds no card)
  A.on('native', (e) => {
    switch (e.t) {
      case 'peers': {
        S = cleanState(e.state || S);
        const seq = typeof S.askSeq === 'number' ? S.askSeq : null;
        // (a state older than the last question event says nothing about the question)
        if (seq === null || seq >= askSeq) {
          if (seq !== null) askSeq = seq;
          if (S.ask && (!ask || ask.device !== S.ask.device || ask.code !== S.ask.code)) askOpen(S.ask);
          else if (!S.ask && ask) askClose();
        }
        updateSelBtn();
        A.redrawSelection();
        if (page.isOpen()) renderSoon();
        break;
      }
      case 'peer-ask':
        askSeq = Math.max(askSeq, +e.seq || 0);
        askOpen(e);
        break;
      case 'peer-ask-end':
        askSeq = Math.max(askSeq, +e.seq || 0);
        if (ask && ask.device === e.device) askClose();
        break;
      case 'peer-accept': accAdd(e); break;
      case 'peer-accept-end': accClose(e.tid); break;
      case 'peer-in': {
        if (recentIn.has(e.fid)) break;
        recentIn.add(e.fid);
        if (recentIn.size > 200) recentIn.delete(recentIn.values().next().value);
        const from = clean(e.from) || 'Another phone', name = clean(e.name) || 'Files';
        // (flicked there: it comes in the same way, at that height here)
        A.incomingCard({ fid: e.fid, name, size: e.size, kind: e.count > 1 ? 'doc' : e.kind, folder: !!e.folder, count: e.count, thumb: e.thumb, aspect: e.aspect, peer: true,
          look: typeof e.look === 'string' ? e.look : undefined, y: typeof e.y === 'number' && e.y >= 0 && e.y <= 1 ? e.y * innerHeight : undefined });
        const it = () => (e.folder ? 'the folder ' + A.midName(name) : e.count > 1 ? plural(e.count, 'item', 'items') : A.midName(name));
        A.toast(() => from + ' is sending ' + it(), 2200);
        break;
      }
      case 'peer-sent': {
        // (the app puts it in History: also when it ends after this page reloaded, or with no page at all)
        const to = clean(e.to) || 'the other phone';
        const note = clean(e.note);
        A.toast('Sent to ' + to + (note ? '. ' + note : ''), note ? 4200 : 1800);
        A.haptic('tick');
        break;
      }
      case 'peer-failed': {
        if (e.canceled) break;                       // (stopped here: nothing to say)
        // Canceled there by its user (there): a cancel, said as one ("Canceled on Galaxy A"), not a send that failed: no
        // error buzz, and its row (the same words, as the phone's error in the state) not in red
        if (e.there) {
          const why = clean(e.why) || 'Canceled on ' + (clean(e.to) || 'the other phone');
          if (e.id) canceledThere.set(String(e.id), why);
          if (page.isOpen()) renderSoon(); else A.toast(why, 2600);
          break;
        }
        if (e.id) canceledThere.delete(String(e.id));
        // (the page shows it on the row, in red: a screen reader is told so too, it heard only "Sending…")
        const why = clean(e.why) || 'Couldn’t send to ' + (clean(e.to) || 'the other phone');
        if (!page.isOpen()) A.toast(why, 3200); else A.say(why);
        A.haptic('reject');
        break;
      }
      case 'down-done':                            // (a 'peer-in' coming after its files arrived adds no card)
        if (e.peer && e.fid) { recentIn.add(e.fid); if (recentIn.size > 200) recentIn.delete(recentIn.values().next().value); }
        break;
      case 'added':                                // what was picked for a phone (pick)
        if (picking && e.tag === picking.tag) { const p = picking; picking = null; send(p.id, p.name, e.items || []); }
        break;
      case 'pause': if (page.isOpen()) A.nc('peerScan', false); break;
      case 'resume': if (page.isOpen()) A.nc('peerScan', true); break;
    }
  });
  if (S.ask) setTimeout(() => { if (S.ask) askOpen(S.ask); }, 600);   // asked before this page was there
  for (const q of S.accepts || []) setTimeout(() => accAdd(q), 700);   // (files waiting for Accept, the same)
  updateSelBtn();
});
