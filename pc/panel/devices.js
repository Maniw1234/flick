'use strict';
// Devices (on the bar: nav.js): the panel's side of peerlink.js (Flick on other computers nearby, pairing with the code, sending
// files and folders to them, what's being sent). State comes from main as 'panel:peers'.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:peers', Object.assign({ what }, extra || {}));
  let P = null;            // the latest state from main
  let open = false;        // the view is showing
  const rows = new Map();  // id -> { el, sig, parts }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  const plural = (n, one, many) => n.toLocaleString() + ' ' + (n === 1 ? one : many);
  const ICON = {
    pc: '<svg viewBox="0 0 24 24"><rect x="3" y="4.75" width="18" height="12" rx="1.75"/><path d="M8.5 20h7M12 16.75V20"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><rect x="6.75" y="2.75" width="10.5" height="18.5" rx="2.25"/><path d="M10.75 18h2.5"/></svg>',
  };
  const osName = (o) => ({ win32: 'Windows', darwin: 'Mac', linux: 'Linux' }[o] || '');
  // a name inside a sentence keeps to itself: right-to-left letters in it don't reorder the words around it
  const iso = (n) => '\u2068' + n + '\u2069';

  function showView(on) {
    open = !!on;
    $('peerView').hidden = !open;
    // (the main view behind it can't be reached with the keyboard or read by a screen reader while this one is up)
    $('main').inert = open;
    send(open ? 'open' : 'close');
    if (open) { $('peerView').focus(); render(); }
  }

  // the line under a device's name: what it is, or what's going on with it
  function status(d) {
    // allowed here a moment ago: its user is checking the code there (a phone, or another device)
    if ((d.phone || d.oneWay) && d.waiting) return 'Allowed here. Waiting for ' + iso(d.name) + ' to confirm the code there…';
    if (d.phone) return d.nearby ? (d.active ? 'Connected · in use' : 'Connected') : 'Not connected. Open Flick on it to send to it.';
    // it can send here, but this computer can't send to it: the pairing wasn't finished on it
    if (d.oneWay) return 'Can send files here. To send to it, pair from here too' + (d.nearby ? '.' : ' when it’s nearby.');
    // an older Flick: it takes files from its phones only
    if (d.old) return 'Flick on it needs updating before files can go to it.';
    const bits = [];
    if (d.paired) bits.push('Paired');
    bits.push(d.nearby ? (osName(d.os) ? osName(d.os) + ', nearby' : 'Nearby') : 'Not nearby right now');
    if (d.nearby && d.via === 'usb') bits.push('USB cable');
    return bits.join(' · ');
  }

  // a row is made again only when what it shows changes shape; progress updates in place
  const sigOf = (d) => JSON.stringify([d.name, d.kind, d.paired, d.oneWay, d.waiting, d.old, d.nearby, d.os, d.via, d.busy, d.code, d.codeOk, d.allowed, d.error, d.ask, d.phone, d.active, d.progress ? [d.progress.files, d.progress.items, d.progress.name, d.progress.asking, d.progress.total] : null]);
  // a control's place in its row (data-k): a row made again puts the keyboard back on the same control
  const key = (e, k) => { e.dataset.k = k; return e; };
  // Remove asks once more, as Clear does in History: it unpairs both ways, and pairing again needs both devices at hand
  const removing = new Map();             // device id -> when Remove was pressed once
  function removeBtn(d) {
    const rm = key(el('button', 'link danger'), 'remove');
    const armed = () => Date.now() - (removing.get(d.id) || 0) < 4000;
    const paint = () => {
      rm.textContent = armed() ? 'Remove?' : 'Remove';
      rm.setAttribute('aria-label', armed() ? 'Remove ' + d.name + '? Press again to remove it' : 'Remove ' + d.name);
    };
    // (back to "Remove" when the 4 s are up; a row made again meanwhile, its button made already asking, waits for the
    // time left: it stayed "Remove?" for good, and a press on it only asked again)
    const disarmIn = (ms) => setTimeout(() => { if (rm.isConnected) paint(); }, Math.max(0, ms) + 100);
    rm.onclick = () => {
      if (armed()) { removing.delete(d.id); send('forget', { id: d.id }); paint(); return; }
      removing.set(d.id, Date.now());
      paint();
      disarmIn(4000);
    };
    paint();
    if (armed()) disarmIn(4000 - (Date.now() - removing.get(d.id)));
    return rm;
  }

  function makeRow(d) {
    const r = el('div', 'wrow prow');
    r.dataset.id = d.id;
    const ico = el('div', 'pico'); ico.innerHTML = ICON[d.kind] || ICON.pc;
    const main = el('div', 'wmain');
    const nm = el('div', 'wname'); nm.appendChild(el('span', null, d.name));
    if (d.paired && d.nearby && !d.busy && !d.oneWay && !d.waiting) nm.appendChild(el('span', 'wtag ok', 'Ready'));
    main.appendChild(nm);
    const parts = {};
    const acts = el('div', 'pacts');

    if (d.busy === 'pairing') {
      main.appendChild(el('div', 'd', 'Pairing…'));
      const box = el('div', 'pcode');
      if (!d.code) {
        // (the keyboard waits here, not on Cancel, where an Enter more would stop it)
        const w = key(el('span', null, 'Connecting to ' + iso(d.name) + '…'), 'wait');
        w.tabIndex = -1;
        box.appendChild(w);
      } else {
        box.append('Pairing code');
        const pin = key(el('b', 'pin', d.code.slice(0, 3) + ' ' + d.code.slice(3)), 'pin');
        pin.tabIndex = -1;                         // (the keyboard lands on the code when it shows, not on an answer)
        pin.setAttribute('aria-label', 'Pairing code ' + d.code.split('').join(' '));
        box.appendChild(pin);
        box.append(d.codeOk ? 'Waiting for ' + iso(d.name) + ' to allow it…' : d.allowed ? iso(d.name) + ' allowed it. Is this the code it showed?' : 'Check that ' + iso(d.name) + ' shows the same code, and click Allow there.');
        const bb = el('div', 'pbtns2');
        if (!d.codeOk) {
          const same = key(el('button', 'btn', 'Same code'), 'same');
          same.onclick = () => send('confirm', { id: d.id, same: true });
          bb.appendChild(same);
        }
        const no = key(el('button', 'btn ghost', d.codeOk ? 'Cancel' : 'Different code'), d.codeOk ? 'cancel' : 'diff');
        no.onclick = () => send(d.codeOk ? 'cancel' : 'confirm', { id: d.id, same: false });
        bb.appendChild(no);
        box.appendChild(bb);
      }
      if (!d.code) {
        const bb = el('div', 'pbtns2');
        const c = key(el('button', 'btn ghost', 'Cancel'), 'cancel'); c.onclick = () => send('cancel', { id: d.id }); bb.appendChild(c);
        box.appendChild(bb);
      }
      main.appendChild(box);
    } else if (d.busy === 'sending') {
      const p = d.progress || {};
      const what = p.files > 1 ? plural(p.files, 'file', 'files') : (p.name || 'files');
      // (counted as the other side asks: the items picked, a folder being one)
      const asked = p.items > 1 ? plural(p.items, 'item', 'items') : (p.name ? iso(p.name) : 'them');
      parts.text = el('div', 'd', p.asking ? 'Sent. Waiting for ' + iso(d.name) + ' to accept ' + asked + '…' : 'Sending ' + what + '…');
      main.appendChild(parts.text);
      parts.bar = el('div', 'pbar' + (p.total ? '' : ' busy'));
      parts.fill = el('div');
      parts.bar.appendChild(parts.fill);
      main.appendChild(parts.bar);
      const c = key(el('button', 'btn ghost', 'Cancel'), 'cancel'); c.onclick = () => send('cancel', { id: d.id });
      c.setAttribute('aria-label', 'Cancel sending to ' + d.name);
      acts.appendChild(c);
    } else if (d.phone) {
      // one of this PC's phones (paired from the phone; Paired phones below has its settings). Nothing goes to one whose
      // user is still checking the code there.
      main.appendChild(el('div', 'd', status(d)));
      if (d.nearby && !d.waiting) {
        const b = key(el('button', 'btn', 'Send files'), 'send');
        b.onclick = () => send('pick', { id: d.id });
        b.setAttribute('aria-label', 'Send files to ' + d.name);
        acts.appendChild(b);
      }
    } else if (d.oneWay) {
      main.appendChild(el('div', 'd', status(d)));
      if (d.error) main.appendChild(el('div', 'd bad', d.error));
      if (d.nearby && !d.waiting) {
        const b = key(el('button', 'btn', 'Pair'), 'pair');
        b.onclick = () => send('pair', { id: d.id });
        b.setAttribute('aria-label', 'Pair with ' + d.name);
        acts.appendChild(b);
      }
      const links = el('div', 'plinks');
      const rm = removeBtn(d);
      links.appendChild(rm);
      main.appendChild(links);
    } else {
      main.appendChild(el('div', 'd', status(d)));
      if (d.error) main.appendChild(el('div', 'd bad', d.error));
      if (d.paired) {
        const b = key(el('button', 'btn', 'Send files'), 'send');
        b.onclick = () => send('pick', { id: d.id });
        b.setAttribute('aria-label', 'Send files to ' + d.name);
        acts.appendChild(b);
        const links = el('div', 'plinks');
        const fold = key(el('button', 'link', 'Send a folder'), 'folder'); fold.onclick = () => send('pick-folder', { id: d.id });
        fold.setAttribute('aria-label', 'Send a folder to ' + d.name);
        links.appendChild(fold);
        // what's copied here, onto its clipboard (a computer: a phone gets it as the phone in use does)
        if (d.kind !== 'phone') {
          const cl = key(el('button', 'link', 'Send clipboard'), 'clip'); cl.onclick = () => api.send('panel:feat', { what: 'p-clip', device: d.id });
          cl.setAttribute('aria-label', 'Send what’s copied here to ' + d.name);
          links.appendChild(cl);
        }
        // files from it: saved as they come, or after Accept here (as for a phone)
        const sel = key(el('select'), 'accept');
        sel.setAttribute('aria-label', 'Files from ' + d.name);
        for (const [v, t] of [['always', 'Always accept'], ['ask', 'Ask each time']]) { const o = el('option', null, t); o.value = v; sel.appendChild(o); }
        sel.value = d.ask ? 'ask' : 'always';
        sel.onchange = () => api.send('panel:feat', { what: 'accept', device: d.id, mode: sel.value });
        links.appendChild(sel);
        const rm = removeBtn(d);
        links.appendChild(rm);
        main.appendChild(links);
      } else if (d.nearby && !d.old) {
        const b = key(el('button', 'btn', 'Pair'), 'pair');
        b.onclick = () => send('pair', { id: d.id });
        b.setAttribute('aria-label', 'Pair with ' + d.name);
        acts.appendChild(b);
      }
    }
    // (the actions come before the details for the keyboard, as they're the first thing seen in a row; CSS keeps them
    // on the right)
    r.appendChild(ico); r.appendChild(acts); r.appendChild(main);
    return { el: r, parts };
  }

  function progress(row, d) {
    const p = d.progress;
    if (!p || !row.parts.fill) return;
    if (p.total) {
      row.parts.bar.classList.remove('busy');
      row.parts.fill.style.width = Math.min(100, Math.round((p.sent / p.total) * 100)) + '%';
      if (!p.asking) row.parts.text.textContent = 'Sending ' + (p.files > 1 ? plural(p.files, 'file', 'files') : p.name || 'files') + ' · ' + fmt(p.sent) + ' of ' + fmt(p.total);
    }
  }

  function render() {
    const list = $('peerList');
    const devs = (P && P.devices) || [];
    // a dot on Devices, on the bar, while files go to one of them
    $('tabDevicesDot').hidden = !devs.some((d) => d.busy === 'sending');
    if (!open) return;
    // the keyboard on a row that goes (a device removed): on to the row that took its place, else the one before, else
    // what follows the list, never dropped to the page where a screen reader says nothing
    const a = document.activeElement, had = a && list.contains(a) ? a.closest('[data-id]') : null;
    const keep = had ? { id: had.dataset.id, k: a.dataset.k || '', at: [...list.children].indexOf(had) } : null;
    const seen = new Set();
    let prev = null;
    for (const d of devs) {
      seen.add(d.id);
      let row = rows.get(d.id);
      const sig = sigOf(d);
      if (!row || row.sig !== sig) {
        // A focused control in a row made again keeps the keyboard: on the same control if it's still there; on the code
        // when one shows (never on an answer to it, where Enter would answer); else on the row's first control.
        const had = row && row.el.contains(document.activeElement) ? (document.activeElement.dataset.k || '') : null;
        const hadPin = !!(row && row.el.querySelector('[data-k="pin"]'));
        const made = makeRow(d);
        made.sig = sig;
        if (row) row.el.replaceWith(made.el);
        row = made;
        rows.set(d.id, row);
        if (had !== null) {
          // (a code that just showed takes the keyboard, from whatever had it: Cancel too, where Enter would stop it)
          const pin = row.el.querySelector('[data-k="pin"]');
          const f = (pin && !hadPin ? pin : null) || (had && row.el.querySelector('[data-k="' + had + '"]')) || pin || row.el.querySelector('[data-k="wait"]') || row.el.querySelector('button, select');
          if (f) f.focus();
        }
      }
      progress(row, d);
      // in the order main gives (not while files are dragged over the list: the rows stay put under the pointer)
      if (!depth && (prev ? prev.nextSibling !== row.el : list.firstChild !== row.el)) list.insertBefore(row.el, prev ? prev.nextSibling : list.firstChild);
      prev = row.el;
    }
    for (const [id, row] of rows) if (!seen.has(id)) { row.el.remove(); rows.delete(id); }
    if (keep && !rows.has(keep.id)) {
      const left = [...list.children], r = left[Math.min(keep.at, left.length - 1)];
      const f = r && (r.querySelector('[data-k="' + keep.k + '"]:not(:disabled)') || r.querySelector('button:not(:disabled), select:not(:disabled)'));
      const next = f || [...$('peerView').querySelectorAll('button, input, select, [tabindex="0"]')]
        .find((x) => (list.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) && !x.disabled && x.getClientRects().length);
      (next || $('peerView')).focus();
    }
    const foot = $('peerFoot');
    foot.textContent = '';
    if (!devs.length) {
      const w = el('div', 'pwait');
      w.appendChild(el('div', 'pspin'));
      w.appendChild(el('div', null, 'Looking for your other computers with Flick… Open Flick on them. They need to be on the same network as this one.'));
      foot.appendChild(w);
    } else {
      foot.textContent = (P && P.me ? 'This computer shows up on the others as ' + P.me + '. ' : '') + 'Drop files on a paired device to send them.';
    }
  }

  api.on('panel:peers', (p) => { P = p; render(); });
  (window.flickViews = window.flickViews || {}).peer = (on) => { if (open !== !!on) showView(on); };   // (the bar opens and closes it: nav.js)
  // a new device of any kind: Connect, on the main view (hold it there)
  $('peerConnect').onclick = () => { showView(false); if (window.flickConnect) window.flickConnect(); };
  // looking for devices only while the list can be seen (not with the window hidden behind others)
  document.addEventListener('visibilitychange', () => { if (open) send(document.hidden ? 'close' : 'open'); });

  // While the view is open, files dropped on a paired device go to it (and nowhere else: not to the phone). These run
  // before panel.js's own handlers and stop them.
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const rowAt = (e) => {
    const r = e.target && e.target.closest ? e.target.closest('.prow') : null;
    if (!r || !P) return null;
    const d = P.devices.find((x) => x.id === r.dataset.id);
    return d && d.paired && !d.oneWay && !d.busy && (!d.phone || d.nearby) ? r : null;
  };
  const mark = (r) => { for (const x of document.querySelectorAll('.prow.over')) if (x !== r) x.classList.remove('over'); if (r) r.classList.add('over'); };
  window.addEventListener('dragenter', (e) => { if (!open || !hasFiles(e)) return; e.preventDefault(); e.stopImmediatePropagation(); depth++; mark(rowAt(e)); $('peerDrop').hidden = !!rowAt(e) || !(P && P.devices.some((d) => d.paired)); }, true);
  window.addEventListener('dragover', (e) => {
    if (!open || !hasFiles(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const r = rowAt(e);
    mark(r);
    $('peerDrop').hidden = !!r || !(P && P.devices.some((d) => d.paired));
    e.dataTransfer.dropEffect = r ? 'copy' : 'none';
  }, true);
  window.addEventListener('dragleave', (e) => { if (!open) return; e.stopImmediatePropagation(); depth = Math.max(0, depth - 1); if (!depth) { mark(null); $('peerDrop').hidden = true; } }, true);
  window.addEventListener('drop', (e) => {
    if (!open || !hasFiles(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    depth = 0; $('peerDrop').hidden = true;
    const r = rowAt(e);
    mark(null);
    if (!r) return;
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (paths.length) send('send', { id: r.dataset.id, paths });
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    // a question in front (pairing, Accept, Quick Share, a browser's, the ringing): answered with its buttons
    if ([...document.querySelectorAll('.modal')].some((m) => !m.hidden)) return;
    e.stopImmediatePropagation();
    showView(false);
  }, true);

  send('hello');
})();
