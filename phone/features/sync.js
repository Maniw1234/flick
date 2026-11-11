/* Two-way folder sync. The app does the syncing (syncPairs, syncAdd, syncNow, syncRemove, 'sync' events);
 * this page lists the synced folders and lets the user pick a new one in the file browser ("Use this folder"). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const live = new Map();          // pair id -> { done, total } while it syncs
  let adding = null;               // { path, name, at }: handed to syncAdd, the app hasn't said it took it yet
  let pick = null;                 // folder-pick mode: { back } = the view to return to

  const page = X.page({ id: 'fSync', title: 'Synced folders', action: { text: 'Sync now', label: 'Sync all folders now', run: syncNow } });
  X.menu(40, () => (A.has('syncPairs') ? { label: 'Synced folders', icon: 'sync', run: () => { render(); page.open(); } } : null));

  const trim = (p) => String(p || '').replace(/\/+$/, '');
  const files = (n) => (n === 1 ? '1 file' : A.fmtNum(+n || 0) + ' files');
  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) { const n = Math.round(s / 3600); return n + (n === 1 ? ' hour ago' : ' hours ago'); }
    return A.fmtWhen(ms);
  }
  // each folder's name on its own (isolated), so Hebrew or Arabic names next to each other keep their order
  const iso = (s) => '\u2068' + s + '\u2069';
  function where(path) {
    const root = trim(A.stg.root);
    path = trim(path);
    if (root && path.indexOf(root + '/') === 0) return ['Phone storage'].concat(path.slice(root.length + 1).split('/').filter(Boolean)).map(iso).join(' › ');
    return path.split('/').map((s) => (s ? iso(s) : s)).join('/');
  }
  // why a folder couldn't sync, for people. The app says it in a sentence that says what to do ("Connect Flick to your PC
  // first", "Desk PC doesn't know this phone any more: pair again in Flick") or in a few words ("folder missing"): shown
  // as they are (it read "Couldn't reach", or was cut in the middle of a word inside "Couldn't sync (…)"). An error
  // straight from storage or the network is said plainly; anything else technical just as that it didn't sync
  function whyText(why) {
    why = X.clean(why);
    if (/ENOSPC|No space left/i.test(why)) return 'Not enough space';
    if (/EACCES|EPERM|EROFS|Permission denied|Read-only file system/i.test(why)) return 'Flick can’t write to this folder';
    if (/ETIMEDOUT|ECONN(REFUSED|RESET|ABORTED)|E(NET|HOST)UNREACH|EPIPE|timed? ?out|failed to connect|connection (refused|reset|abort|closed)|network is unreachable|no route to host|unable to resolve host|broken pipe|socket closed|end of stream/i.test(why)) return 'Couldn’t reach ' + X.pcName();
    if (!why || /^(null|undefined)$/.test(why) || /Exception|java\.|errno|\w failed: E[A-Z]|\bHTTP \d|^[^\p{L}\p{N}]/u.test(why)) return 'Couldn’t sync';
    let c;
    try { c = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(why), (g) => g.segment); } catch (e) { c = Array.from(why); }
    if (c.length > 160) c = c.slice(0, 159).concat('…');
    c[0] = c[0].toUpperCase();
    return c.join('');
  }

  // While a folder syncs the page is drawn every few hundred ms. Its rows stay the same elements and only their figures
  // change: rebuilt each time, a screen reader lost its place on the page, and a row being pressed its highlight. The
  // page is built anew only when the list itself changes (a folder added or stopped).
  const rows = new Map();                          // pair id -> its row
  let shape = null;
  function render() {
    const pairs = (A.njson('syncPairs') || []).filter((p) => p && p.id && p.path);
    // (kept until the app's event for it: a folder already in the list, one stopped on the PC, is in syncPairs() before
    // the app took it up again, and dropped then it never said "Syncing")
    if (adding && Date.now() - adding.at > 90000) adding = null;
    const pending = adding && !pairs.some((p) => trim(p.path) === trim(adding.path)) ? adding : null;
    const body = page.body;
    page.setAct(pairs.length > 0 && A.has('syncNow'));
    const old = !!(A.st.connected && !X.newPc());
    const key = pairs.map((p) => p.id).join('|') + '|' + (pending ? pending.path : '') + '|' + old;
    if (key === shape) { for (const p of pairs) { const r = rows.get(p.id); if (r) figures(r, p); } return; }
    shape = key;
    const refocus = X.keepFocus(body, '.frow', page.back);
    rows.clear();
    body.innerHTML = '';
    if (old) body.appendChild(h('div', 'fnote', X.OLD_PC));
    if (!pairs.length && !pending) {
      body.appendChild(X.empty(A.icons.sync, 'No synced folders', 'Keep a folder the same on this phone and your PC. Changes on either side reach the other.', addButton()));
      refocus();
      return;
    }
    const g = h('section', 'sgroup');
    const card = h('div', 'scard');
    card.setAttribute('role', 'list');
    for (const p of pairs) card.appendChild(row(p));
    if (pending) card.appendChild(row({ id: '', name: pending.name, path: pending.path, pcName: X.pcName(), state: 'adding' }));
    g.appendChild(card);
    body.appendChild(g);
    const foot = h('div', 'ffoot');
    foot.appendChild(addButton());
    body.appendChild(foot);
    refocus();
  }
  let soonT = 0;
  function renderSoon() { if (!soonT) soonT = setTimeout(() => { soonT = 0; if (page.isOpen()) render(); }, 250); }

  function row(p) {
    const r = h('div', 'frow');
    r.setAttribute('role', 'listitem');
    r.dataset.rk = String(p.id || '');
    const main = h('button', 'fmain');
    const ic = h('span', 'fic folder');
    ic.appendChild(A.svgEl(X.SVG.folder));
    const tx = h('span', 'ftx');
    r._name = X.nm('b');
    r._sub = h('small');
    r._state = h('small');
    tx.append(r._name, r._sub, r._state);
    main.append(ic, tx);
    r.appendChild(main);
    if (p.state === 'adding') { main.disabled = true; figures(r, p); return r; }
    rows.set(p.id, r);
    main.onclick = () => menu(r._p);                // (the folder as it is now)
    r._more = h('button', 'fmore');
    r._more.appendChild(A.svgEl(X.SVG.dots));
    r._more.onclick = () => menu(r._p);
    r.appendChild(r._more);
    figures(r, p);
    return r;
  }
  // a row's figures: its name, how many files, how its sync is going
  function figures(r, p) {
    r._p = p;
    const name = p.name || trim(p.path).split('/').pop();
    if (r._name.textContent !== name) r._name.textContent = name;
    const sub = 'With ' + (X.clean(p.pcName) || 'your PC') + (p.state !== 'adding' && p.files >= 0 ? ' · ' + files(p.files) : '');
    if (r._sub.textContent !== sub) r._sub.textContent = sub;
    const lv = live.get(p.id);
    let state, bad = false;
    if (p.state === 'adding' || (p.stopped && adding && ownPc(p) && trim(p.path) === trim(adding.path))) state = 'Setting up…';   // (Sync again)
    else if (lv || p.state === 'running') state = lv && lv.total ? 'Syncing… ' + A.fmtNum(Math.min(lv.done, lv.total)) + ' of ' + A.fmtNum(lv.total) : 'Syncing…';
    else if (p.state === 'error') { state = whyText(p.why); bad = p.stopped !== 'pc'; }   // stopped there on purpose: not a fault
    else state = p.last ? 'Synced ' + ago(p.last) : 'Not synced yet';
    const cls = 'fstate' + (bad ? ' fbad' : lv || p.state === 'running' || state === 'Setting up…' ? ' fbusy' : '');
    if (r._state.textContent !== state) r._state.textContent = state;
    if (r._state.className !== cls) r._state.className = cls;
    if (r._more) r._more.setAttribute('aria-label', 'More for ' + (name || 'this folder'));   // (the name the row shows)
  }

  // Sync again only with the PC the folder was synced with: the app adds a folder to the PC it uses now, so with
  // another PC it started a second sync, with that one, and the folder stayed stopped on its own
  const ownPc = (p) => !!(p.pc && A.st.pc && p.pc === A.st.pc.id);
  function menu(p) {
    const stopped = p.stopped === 'pc' && A.has('syncAdd'), mine = stopped && ownPc(p);
    A.openSheet(where(p.path), [
      { label: 'Open folder', icon: 'folder', run: () => { page.close(); setTimeout(() => { if (A.st.screen !== 'main') A.showScreen('main'); A.showInFolder(trim(p.path)); }, 220); } },
      mine ? { label: 'Sync again', icon: 'sync', run: () => again(p) } : null,
      A.has('syncRemove') ? { label: 'Stop syncing', icon: 'off', tag: 'Files stay', danger: true, run: () => stop(p) } : null,
    ], stopped && !mine ? { note: 'Connect to ' + (X.clean(p.pcName) || 'the PC it was synced with') + ' to sync this folder again' } : undefined);
  }
  function stop(p) {
    A.nc('syncRemove', String(p.id));
    live.delete(p.id);
    // (stopped while its Sync again was still being set up: no "Setting up…" row stays behind for it)
    if (adding && ownPc(p) && trim(adding.path) === trim(p.path)) adding = null;
    render();
    A.toast('Stopped syncing ' + A.midName(p.name || trim(p.path).split('/').pop() || 'the folder'), 2000);
  }
  // stopped on the PC: adding the same folder again is what starts it there again (the app keeps the pair for this)
  // ("Adding" until the app took it, as for a new folder: it may still refuse it, the folder gone)
  // One folder is set up at a time: the app's "couldn't" for a new folder doesn't say which one, so with two on their
  // way it was said of the wrong one. (For a few seconds: an answer that never comes doesn't keep the next one out)
  function busyAdding() {
    if (!adding || Date.now() - adding.at > 20000) return false;
    A.toast('Wait until “' + A.midName(adding.name) + '” is added', 2400);
    return true;
  }
  function again(p) {
    if (!X.needPc('Connect to your PC to sync this folder')) return;
    if (busyAdding()) return;
    if (!ownPc(p)) { A.toast('Connect to ' + (X.clean(p.pcName) || 'the PC it was synced with') + ' to sync this folder again', 2800); return; }
    const path = trim(p.path), name = p.name || path.split('/').pop() || 'the folder';
    if (A.nc('syncAdd', path) === null) { A.toast('Couldn’t sync that folder', 2400); return; }
    A.haptic('confirm');
    adding = { path, name, at: Date.now() };
    render();
    A.toast('Adding “' + A.midName(name) + '”…', 2400);
  }
  function syncNow() {
    if (A.nc('syncNow') === null) return;
    A.haptic('tick');
    A.toast('Syncing now…', 1600);
  }

  function addButton() {
    const b = h('button', 'fbig');
    b.appendChild(A.svgEl(X.SVG.plus));
    b.appendChild(h('span', '', 'Add a folder'));
    b.onclick = add;
    b.hidden = !A.has('syncAdd');
    return b;
  }
  function add() {
    if (!X.needPc('Connect to your PC to add a folder')) return;
    if (busyAdding()) return;
    startPick();
  }

  A.on('native', (e) => {
    if (e.t !== 'sync') return;
    if (e.id && e.state === 'running') live.set(e.id, { done: +e.done || 0, total: +e.total || 0 });
    else if (e.id) live.delete(e.id);
    if (e.state === 'error' && !e.id && adding) {          // the app or the PC didn't take the new folder: say why
      let why = e.why ? whyText(e.why) : '';
      if (why === 'Couldn’t sync') why = '';               // nothing a person could act on
      A.toast('Couldn’t add “' + A.midName(adding.name) + '”' + (why ? ': ' + why : ''), why ? 4000 : 2600, !!why);
      adding = null;
    } else if (e.id && adding && (A.njson('syncPairs') || []).some((p) => p && p.id === e.id && trim(p.path) === trim(adding.path) && (!p.pc || ownPc(p)))) {
      // the app took it: only now does it sync (an error of its own shows on its row). (Its pair with this PC: the same
      // folder can be in the list with another PC, stopped there.)
      if (e.state !== 'error') A.toast('Syncing “' + A.midName(adding.name) + '” with ' + X.pcName(), 2400);
      adding = null;
    }
    renderSoon();
  });
  A.on('conn', renderSoon);

  // ---- folder-pick mode: the file browser (Phone storage) with a "Use this folder" bar
  const bar = h('div', 'fpick');
  bar.id = 'fPickBar'; bar.hidden = true;
  const cap = h('div', 'fpcap');
  const btns = h('div', 'fprow');
  const cancel = h('button', 'fpx');
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.appendChild(A.svgEl(X.SVG.close));
  const go = h('button', 'fpgo');
  const goT = h('b'), goS = h('small');
  go.append(goT, goS);
  btns.append(cancel, go);
  bar.append(cap, btns);
  // before the files, as the toolbar is (index.html), though it shows over the bottom of them: after them, Tab and a
  // screen reader reached Use this folder and Cancel only past every folder and file
  const main = document.getElementById('main');
  main.insertBefore(bar, document.getElementById('scroller'));
  cancel.onclick = () => { A.haptic('soft'); endPick(); };
  go.onclick = use;

  function startPick() {
    const V = A.V;
    pick = { back: V.cat === 'dir' ? V.rootCat || 'storage' : V.cat };
    page.close();
    if (A.sheetOpen) A.closeSheet();
    if (A.st.screen !== 'main') A.showScreen('main');
    document.body.classList.add('fpicking');
    cap.textContent = 'Pick a folder to keep in sync with ' + X.pcName();
    bar.hidden = false;
    A.openCat('storage');
    update();
  }
  function usable() {
    const V = A.V;
    return !!(pick && V.cat === 'dir' && V.path && !V.loading && trim(V.path) !== trim(A.stg.root));
  }
  function update() {
    if (!pick) return;
    const ok = usable();
    go.disabled = !ok;
    goT.textContent = ok ? 'Use this folder' : 'Open a folder to sync';
    goS.textContent = ok ? A.V.title : '';
    goS.hidden = !ok;
  }
  A.on('view', update);
  function use() {
    if (!usable()) return;
    const path = trim(A.V.path), name = A.V.title || path.split('/').pop();
    if (A.nc('syncAdd', path) === null) { A.toast('Couldn’t add that folder', 2400); return; }
    A.haptic('confirm');
    adding = { path, name, at: Date.now() };
    endPick();
    A.toast('Adding “' + A.midName(name) + '”…', 2400);   // not "Syncing" yet: the app may still refuse it
  }
  function endPick() {
    if (!pick) return;
    const back = pick.back;
    pick = null;
    document.body.classList.remove('fpicking');
    bar.hidden = true;
    A.openCat(back || 'recent');
    render();
    page.open();
  }
  X.back(10, () => {
    if (!pick || document.body.classList.contains('selecting')) return false;
    if (A.V.cat === 'dir' && A.V.stack.length) return false;     // up one folder first (app.js does that)
    endPick();
    return true;
  });
});
