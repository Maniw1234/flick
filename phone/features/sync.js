/* Two-way folder sync. The app does the syncing (syncPairs, syncAdd, syncNow, syncRemove, 'sync' events);
 * this page lists the synced folders and lets the user pick a new one in the file browser ("Use this folder"). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const live = new Map();          // pair id -> { done, total } while it syncs
  let adding = null;               // { path, name, at }: handed to syncAdd, not in syncPairs() yet
  let pick = null;                 // folder-pick mode: { back } = the view to return to

  const page = X.page({ id: 'fSync', title: 'Synced folders', action: { text: 'Sync now', label: 'Sync all folders now', run: syncNow } });
  X.menu(40, () => (A.has('syncPairs') ? { label: 'Synced folders', icon: 'sync', run: () => { render(); page.open(); } } : null));

  const trim = (p) => String(p || '').replace(/\/+$/, '');
  const files = (n) => (n === 1 ? '1 file' : (+n || 0).toLocaleString() + ' files');
  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) { const n = Math.round(s / 3600); return n + (n === 1 ? ' hour ago' : ' hours ago'); }
    return A.fmtWhen(ms);
  }
  function where(path) {
    const root = trim(A.stg.root);
    path = trim(path);
    if (root && path.indexOf(root + '/') === 0) return ['Phone storage'].concat(path.slice(root.length + 1).split('/').filter(Boolean)).join(' › ');
    return path;
  }
  function whyText(why) {
    why = String(why || '');
    if (/reach|timed? ?out|refused|unreachable|network|connect|offline/i.test(why)) return 'Couldn’t reach ' + X.pcName();
    if (/space|ENOSPC/i.test(why)) return 'Not enough space';
    if (/permission|denied|access|EACCES|read-only/i.test(why)) return 'Flick can’t write to this folder';
    return why ? 'Couldn’t sync (' + why.slice(0, 60) + ')' : 'Couldn’t sync';
  }

  function render() {
    const pairs = (A.njson('syncPairs') || []).filter((p) => p && p.id && p.path);
    if (adding && (pairs.some((p) => trim(p.path) === trim(adding.path)) || Date.now() - adding.at > 90000)) adding = null;
    const body = page.body;
    body.innerHTML = '';
    page.act.disabled = !pairs.length || !A.has('syncNow');
    if (A.st.connected && !X.newPc()) body.appendChild(h('div', 'fnote', X.OLD_PC));
    if (!pairs.length && !adding) {
      body.appendChild(X.empty(A.icons.sync, 'No synced folders', 'Keep a folder the same on this phone and your PC. Changes on either side reach the other.', addButton()));
      return;
    }
    const g = h('section', 'sgroup');
    const card = h('div', 'scard');
    card.setAttribute('role', 'list');
    for (const p of pairs) card.appendChild(row(p));
    if (adding) card.appendChild(row({ id: '', name: adding.name, path: adding.path, pcName: X.pcName(), state: 'adding' }));
    g.appendChild(card);
    body.appendChild(g);
    const foot = h('div', 'ffoot');
    foot.appendChild(addButton());
    body.appendChild(foot);
  }
  let soonT = 0;
  function renderSoon() { if (!soonT) soonT = setTimeout(() => { soonT = 0; if (page.isOpen()) render(); }, 250); }

  function row(p) {
    const r = h('div', 'frow');
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    const ic = h('span', 'fic folder');
    ic.appendChild(A.svgEl(X.SVG.folder));
    const tx = h('span', 'ftx');
    tx.appendChild(h('b', '', p.name || trim(p.path).split('/').pop()));
    tx.appendChild(h('small', '', 'With ' + (p.pcName || 'your PC') + (p.state !== 'adding' && p.files >= 0 ? ' · ' + files(p.files) : '')));
    const lv = live.get(p.id);
    let state, bad = false;
    if (p.state === 'adding') state = 'Setting up…';
    else if (lv || p.state === 'running') state = lv && lv.total ? 'Syncing… ' + Math.min(lv.done, lv.total).toLocaleString() + ' of ' + lv.total.toLocaleString() : 'Syncing…';
    else if (p.state === 'error') { state = whyText(p.why); bad = true; }
    else state = p.last ? 'Synced ' + ago(p.last) : 'Not synced yet';
    tx.appendChild(h('small', 'fstate' + (bad ? ' fbad' : lv || p.state === 'running' || p.state === 'adding' ? ' fbusy' : ''), state));
    main.append(ic, tx);
    r.appendChild(main);
    if (p.state === 'adding') { main.disabled = true; return r; }
    main.onclick = () => menu(p);
    const more = h('button', 'fmore');
    more.setAttribute('aria-label', 'More for ' + (p.name || 'this folder'));
    more.appendChild(A.svgEl(X.SVG.dots));
    more.onclick = () => menu(p);
    r.appendChild(more);
    return r;
  }

  function menu(p) {
    A.openSheet(where(p.path), [
      { label: 'Open folder', icon: 'folder', run: () => { page.close(); setTimeout(() => { if (A.st.screen !== 'main') A.showScreen('main'); A.showInFolder(trim(p.path)); }, 220); } },
      A.has('syncRemove') ? { label: 'Stop syncing', icon: 'off', tag: 'Files stay', danger: true, run: () => stop(p) } : null,
    ]);
  }
  function stop(p) {
    A.nc('syncRemove', String(p.id));
    live.delete(p.id);
    render();
    A.toast('Stopped syncing ' + A.midName(p.name || ''), 2000);
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
    startPick();
  }

  A.on('native', (e) => {
    if (e.t !== 'sync') return;
    if (e.id && e.state === 'running') live.set(e.id, { done: +e.done || 0, total: +e.total || 0 });
    else if (e.id) live.delete(e.id);
    if (e.state === 'error' && !e.id && adding) {          // the PC didn't take the new folder
      A.toast('Couldn’t add “' + A.midName(adding.name) + '”', 2600);
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
  document.getElementById('main').appendChild(bar);
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
    A.toast('Syncing “' + A.midName(name) + '” with ' + X.pcName(), 2400);
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
