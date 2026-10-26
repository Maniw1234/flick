/* Transfers: the sends the app carries on with (protocol 7 PCs). They go on with Flick closed, wait while the PC can't
 * be reached and carry on where they stopped. This page lists them with how far each got, its speed and time left, and
 * Pause / Resume / Cancel / Try again. Opened from the toolbar while something is sending, or from the ••• menu. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const ENDED = ['done', 'failed', 'canceled', 'skipped'];
  const ICON = {
    up: '<svg viewBox="0 0 24 24"><path d="M12 18.5V6M6.8 11.2L12 6l5.2 5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M7 12.4l3.3 3.3L17.2 8.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M12 6.5v7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.35" fill="currentColor"/></svg>',
    wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 7v10M15 7v10" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M9 6.8v10.4l8.2-5.2z" fill="currentColor"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M18.8 12a6.8 6.8 0 1 1-2-4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17.4 3.8v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const jobs = () => [...A.st.jobs.values()].filter((j) => j.committed || !ENDED.includes(j.state)).sort((a, b) => b.created - a.created);

  const page = X.page({ id: 'fXfers', title: 'Transfers', action: { text: 'Clear', label: 'Clear finished transfers', run: clearEnded } });
  X.menu(25, () => (A.has('sendList') && A.st.jobs.size ? { label: 'Transfers', icon: 'send', run: open } : null));
  A.on('countTap', () => { open(); return true; });
  A.on('native', (e) => { if (e.t === 'job' && page.isOpen()) soon(); });

  function open() { render(); page.open(); }
  let renderT = 0;
  function soon() { if (!renderT) renderT = setTimeout(() => { renderT = 0; if (page.isOpen()) render(); }, 120); }
  // time left and "tries again in" count down between events
  setInterval(() => { if (page.isOpen() && jobs().some((j) => j.state === 'running' || j.state === 'waiting')) render(); }, 1000);

  function render() {
    const body = page.body;
    const list = jobs();
    page.act.disabled = !list.some((j) => ENDED.includes(j.state));
    body.innerHTML = '';
    if (!list.length) {
      body.appendChild(X.empty(ICON.up, 'Nothing sending', 'Files you send to your PC show up here while they travel, and keep going if you close Flick.'));
      return;
    }
    const now = list.filter((j) => !ENDED.includes(j.state)), done = list.filter((j) => ENDED.includes(j.state));
    if (now.length) body.appendChild(group('Now', now));
    if (done.length) body.appendChild(group('Finished', done));
    if (now.some((j) => j.state === 'waiting')) {
      body.appendChild(h('div', 'fnote', 'Waiting sends carry on by themselves as soon as ' + (now.find((j) => j.state === 'waiting').pcName || 'your PC') + ' can be reached again, even with Flick closed.'));
    }
  }

  function group(title, list) {
    const g = h('section', 'sgroup');
    g.appendChild(h('h3', '', title));
    const card = h('div', 'scard');
    card.setAttribute('role', 'list');
    for (const j of list) card.appendChild(row(j));
    g.appendChild(card);
    return g;
  }

  function pct(j) { return j.total > 0 ? Math.min(100, Math.floor((j.sent / j.total) * 100)) : 0; }
  function left(s) {
    if (!(s >= 0)) return '';
    if (s < 60) return Math.max(1, Math.round(s)) + ' s left';
    if (s < 3600) return Math.round(s / 60) + ' min left';
    return (s / 3600).toFixed(1) + ' h left';
  }
  function line(j) {
    const pc = j.pcName || 'your PC';
    const size = j.total > 0 ? A.fmtSize(j.sent) + ' of ' + A.fmtSize(j.total) : '';
    switch (j.state) {
      case 'running': return [pct(j) + '%', size, j.rate > 0 ? A.fmtRate(j.rate) : '', left(j.eta)].filter(Boolean);
      case 'queued': return ['Starting…'];
      case 'waiting': return ['Waiting for ' + pc, j.retryIn > 1500 ? 'tries again in ' + Math.ceil(j.retryIn / 1000) + ' s' : 'trying…', j.total > 0 ? pct(j) + '% there' : ''].filter(Boolean);
      case 'paused': return ['Paused', j.total > 0 ? pct(j) + '% there' : ''].filter(Boolean);
      case 'done': return ['Sent to ' + pc, j.total > 0 ? A.fmtSize(j.total) : '', j.had ? j.had + ' already there' : ''].filter(Boolean);
      case 'skipped': return ['Already on ' + pc];
      case 'failed': return [j.why || 'Couldn’t send it'];
      case 'canceled': return [j.why || 'Canceled'];
      default: return [j.state];
    }
  }

  function row(j) {
    const r = h('div', 'frow fx' + j.state);
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    const bad = j.state === 'failed';
    const ic = h('span', 'fic' + (bad ? ' bad' : ''));
    ic.appendChild(A.svgEl(bad ? ICON.bad : j.state === 'done' || j.state === 'skipped' ? ICON.ok : j.state === 'waiting' ? ICON.wait : ICON.up));
    const tx = h('span', 'ftx');
    const top = h('span', 'ftop');
    top.append(h('b', '', j.name || 'File'), h('span', 'ftime', when(j)));
    tx.appendChild(top);
    const sm = h('small', bad ? 'fwrap fbad' : 'fwrap');
    line(j).forEach((b, i) => { if (i) sm.appendChild(document.createTextNode(' · ')); sm.appendChild(h('span', 'fbit', b)); });
    tx.appendChild(sm);
    if (j.state === 'running' || j.state === 'paused' || j.state === 'waiting') {
      const bar = h('span', 'fxbar');
      const fill = h('i');
      fill.style.transform = 'scaleX(' + (pct(j) / 100) + ')';
      bar.appendChild(fill);
      tx.appendChild(bar);
    }
    main.append(ic, tx);
    X.press(main, () => menu(j), () => menu(j));
    r.appendChild(main);
    // the one thing most often wanted, right there
    const quick = j.state === 'running' || j.state === 'queued' ? ['pause', 'Pause', () => act('sendPause', j)]
      : j.state === 'paused' ? ['play', 'Resume', () => act('sendResume', j)]
        : j.state === 'waiting' ? ['retry', 'Try now', () => act('sendResume', j)]
          : j.state === 'failed' || j.state === 'canceled' ? ['retry', 'Try again', () => act('sendRetry', j)] : null;
    if (quick) {
      const b = h('button', 'fmore');
      b.setAttribute('aria-label', quick[1] + ' ' + (j.name || ''));
      b.appendChild(A.svgEl(ICON[quick[0]]));
      b.onclick = quick[2];
      r.appendChild(b);
    }
    return r;
  }

  function when(j) {
    const t = j.ended || j.created;
    try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function act(m, j) { A.haptic('tick'); A.nc(m, j.tid); }

  function menu(j) {
    const live = !ENDED.includes(j.state);
    A.openSheet(j.name || 'Transfer', [
      j.state === 'running' || j.state === 'queued' ? { label: 'Pause', icon: 'send', run: () => act('sendPause', j) } : null,
      j.state === 'paused' ? { label: 'Resume', icon: 'send', run: () => act('sendResume', j) } : null,
      j.state === 'waiting' ? { label: 'Try now', icon: 'send', run: () => act('sendResume', j) } : null,
      j.state === 'failed' || j.state === 'canceled' ? { label: 'Try again', icon: 'send', run: () => act('sendRetry', j) } : null,
      live ? { label: 'Cancel', icon: 'trash', danger: true, run: () => act('sendCancel', j) } : null,
      !live ? { label: 'Remove from the list', icon: 'trash', run: () => { A.nc('sendForget', j.tid); A.st.jobs.delete(j.tid); render(); } } : null,
    ]);
  }

  function clearEnded() {
    for (const j of jobs()) if (ENDED.includes(j.state)) { A.nc('sendForget', j.tid); A.st.jobs.delete(j.tid); }
    render();
  }
});
