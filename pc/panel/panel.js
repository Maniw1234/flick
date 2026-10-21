'use strict';
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  let S = null;
  let pairDevice = null;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function set(key, value) { api.send('panel:set', { key, value }); }
  function act(what, arg) { api.send('panel:action', { what, arg }); }

  function render(s) {
    S = s;
    if (s.accent) {
      document.documentElement.style.setProperty('--accent', s.accent);
      document.documentElement.style.setProperty('--on-accent', s.onAccent || '#000');
    }
    const VIA = { wifi: 'Wi-Fi', usb: 'USB cable', hotspot: 'hotspot', direct: 'a direct link', ethernet: 'Ethernet', bluetooth: 'Bluetooth' };
    $('statusText').textContent = s.connected ? `Connected to ${s.phone}` + (s.via && VIA[s.via] ? ` over ${VIA[s.via]}` : '') : 'Waiting for your phone';
    $('dot').classList.toggle('on', !!s.connected);
    $('hint').textContent = s.connected
      ? 'Drag a file off the edge of your phone toward this screen.'
      : 'On your phone, open Flick and press and hold Connect.';
    const scene = $('scene');
    scene.classList.toggle('right', s.side === 'right');
    scene.classList.toggle('left', s.side === 'left');
    scene.classList.toggle('on', !!s.connected);
    document.querySelector('.scene .phone').style.top = (14 + (s.anchor - 0.5) * 30) + 'px';
    for (const b of $('themes').querySelectorAll('.theme')) b.classList.toggle('on', b.dataset.v === s.theme);
    for (const b of $('side').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === s.side);
    if (document.activeElement !== $('anchor')) $('anchor').value = s.anchor;
    if (document.activeElement !== $('size')) $('size').value = s.size;
    $('saveDir').value = s.saveDir === 'desktop' || s.saveDir === 'downloads' ? s.saveDir : 'custom';
    const custom = $('saveDir').querySelector('option[value=custom]');
    custom.textContent = s.saveDir === 'desktop' || s.saveDir === 'downloads' ? 'Choose folder…' : s.saveDirLabel;
    $('sound').checked = !!s.sound;
    $('openAfter').checked = !!s.openAfter;
    $('showSpeed').checked = !!s.showSpeed;
    $('sendTo').checked = !!s.sendTo;
    $('sendToRow').hidden = !s.isWin;
    $('autoUpdate').checked = s.autoUpdate !== false;
    $('bluetooth').checked = !!s.bluetooth;
    $('quickShare').checked = !!s.quickShare;
    const status = (el, on, st, offText) => {
      const txt = { off: offText, starting: 'Starting…', on: on, 'no-radio': 'This PC has no Bluetooth (or it’s turned off).', error: 'Couldn’t start. See the log.', unsupported: 'Needs Windows.',
        'no-mdns': 'Phones can’t see this PC: another app is using the network port Quick Share needs (5353).' };
      el.textContent = txt[st] || offText;
      el.className = 'sub0' + (st === 'on' ? ' ok' : st === 'no-radio' || st === 'error' || st === 'no-mdns' ? ' warn' : '');
    };
    status($('btSub'), 'On. Pair your phone with this PC in Windows Bluetooth settings, then turn on Bluetooth in Flick on the phone.', s.btState, 'For when there’s no network. Much slower.');
    status($('qsSub'), 'On. In any app on the phone, tap Share > Quick Share and pick ' + (s.name || 'this PC') + '.', s.qsState, 'Show this PC in Android’s own Quick Share menu.');
    $('verLine').textContent = 'Flick ' + s.version;
    $('sendRow').hidden = !s.connected;
    $('edgeSend').checked = !!s.edgeSend;
    $('startup').checked = !!s.startup;
    $('startupRow').hidden = !s.isWin;
    if (document.activeElement !== $('name')) $('name').value = s.name || '';
    $('addr').textContent = (s.ips && s.ips.length ? s.ips.slice(0, 3).join(', ') : 'No network') + (s.port ? `  (port ${s.port})` : '');
    $('ver').textContent = 'Flick ' + s.version;
    // updates from GitHub
    const u = s.update || {};
    const ut = u.state === 'ready' ? 'Update ' + u.version + ' is downloaded. Flick restarts into it when it isn\u2019t busy.'
      : u.state === 'installer' ? 'Flick ' + u.version + ' is out and needs the full installer.' : '';
    $('upd').hidden = !ut;
    $('updText').textContent = ut;
    $('updLink').hidden = u.state !== 'installer';
    $('updLink').textContent = 'Get it';
    if (s.phoneApp) {
      // the phone app this PC hands out over Wi-Fi
      const line = document.createElement('div');
      const waiting = s.phoneHas && s.phoneHas.code && s.phoneHas.code < s.phoneApp.code;
      line.textContent = 'Phone app ' + s.phoneApp.name + (waiting ? ' (update waiting on your phone)' : '');
      $('ver').appendChild(line);
    }
    $('intro').hidden = !s.firstRun;
    const dr = $('displayRow');
    dr.hidden = !(s.displays && s.displays.length > 1);
    if (!dr.hidden) {
      const sel = $('display');
      sel.innerHTML = '';
      const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Automatic'; sel.appendChild(auto);
      for (const d of s.displays) { const o = document.createElement('option'); o.value = String(d.id); o.textContent = d.label + (d.primary ? ', main' : ''); sel.appendChild(o); }
      sel.value = s.displayId ? String(s.displayId) : '';
    }
    const list = $('devices');
    list.innerHTML = '';
    $('devicesCard').hidden = !(s.devices && s.devices.length);
    for (const d of s.devices || []) {
      const row = document.createElement('div'); row.className = 'dev';
      const l = document.createElement('div');
      const n = document.createElement('div'); n.textContent = d.name;
      const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = 'Paired ' + new Date(d.added || Date.now()).toLocaleDateString();
      l.appendChild(n); l.appendChild(dd);
      const b = document.createElement('button'); b.className = 'link danger'; b.textContent = 'Remove';
      b.onclick = () => act('forget', d.id);
      row.appendChild(l); row.appendChild(b);
      list.appendChild(row);
    }
  }

  // preview clips play while the window is open (paused with reduced motion)
  const videos = [...document.querySelectorAll('.theme video')];
  function playClips(on) { for (const v of videos) { if (on && !reduceMotion) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause(); } }
  // only while someone is looking at this window: an open but unfocused panel costs nothing
  document.addEventListener('visibilitychange', () => playClips(!document.hidden && document.hasFocus()));
  window.addEventListener('focus', () => playClips(true));
  window.addEventListener('blur', () => playClips(false));
  playClips(document.hasFocus());

  api.on('panel:state', render);
  api.on('panel:pair', (s) => {
    pairDevice = s.device;
    $('pairName').textContent = s.name || 'A phone';
    $('pair').hidden = false;
    $('allow').focus();
  });
  api.on('panel:pair-cancel', (d) => { if (d && d.device === pairDevice) { $('pair').hidden = true; pairDevice = null; } });

  // Quick Share: someone's phone wants to send files
  let qsId = null;
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  api.on('panel:qs', (m) => {
    qsId = m.id;
    $('qsFrom').textContent = m.from || 'A phone';
    const n = m.files.length, t = m.texts.length;
    $('qsWhat').textContent = n ? (n === 1 ? m.files[0].name : n + ' files') : t === 1 ? (m.texts[0].type === 2 ? 'a link' : 'some text') : t + ' items';
    $('qsPin').textContent = m.pin || '';
    const list = $('qsList');
    list.innerHTML = '';
    for (const f of m.files.slice(0, 50)) {
      const r = document.createElement('div');
      const a = document.createElement('span'); a.textContent = f.name;
      const b = document.createElement('span'); b.textContent = fmt(f.size || 0);
      r.appendChild(a); r.appendChild(b); list.appendChild(r);
    }
    list.hidden = n < 2;
    $('qs').hidden = false;
    $('qsAllow').focus();
  });
  api.on('panel:qs-done', (m) => { if (!m || m.id === qsId) { $('qs').hidden = true; qsId = null; } });
  $('qsAllow').onclick = () => { if (qsId) api.send('panel:qs-answer', { id: qsId, accept: true }); $('qs').hidden = true; qsId = null; };
  $('qsDeny').onclick = () => { if (qsId) api.send('panel:qs-answer', { id: qsId, accept: false }); $('qs').hidden = true; qsId = null; };

  $('allow').onclick = () => { if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: true }); $('pair').hidden = true; pairDevice = null; };
  $('deny').onclick = () => { if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: false }); $('pair').hidden = true; pairDevice = null; };
  $('close').onclick = () => act('hide');
  $('quit').onclick = () => act('quit');
  $('updLink').onclick = () => act(S && S.update && S.update.state === 'installer' ? 'openRelease' : 'checkUpdates');
  $('openFolder').onclick = () => act('openFolder');
  $('firewall').onclick = () => act('fixFirewall');
  $('introOk').onclick = () => act('dismissIntro');
  $('playFx').onclick = () => act('demo');
  for (const b of $('themes').querySelectorAll('.theme')) b.onclick = () => {
    for (const o of $('themes').querySelectorAll('.theme')) o.classList.toggle('on', o === b);
    set('theme', b.dataset.v);
  };
  for (const b of $('side').querySelectorAll('button')) b.onclick = () => set('side', b.dataset.v);
  $('anchor').oninput = (e) => { set('anchor', parseFloat(e.target.value)); document.querySelector('.scene .phone').style.top = (14 + (parseFloat(e.target.value) - 0.5) * 30) + 'px'; };
  $('size').oninput = (e) => set('size', parseFloat(e.target.value));
  $('sound').onchange = (e) => set('sound', e.target.checked);
  $('openAfter').onchange = (e) => set('openAfter', e.target.checked);
  $('showSpeed').onchange = (e) => set('showSpeed', e.target.checked);
  $('sendTo').onchange = (e) => set('sendTo', e.target.checked);
  $('autoUpdate').onchange = (e) => set('autoUpdate', e.target.checked);
  $('bluetooth').onchange = (e) => set('bluetooth', e.target.checked);
  $('quickShare').onchange = (e) => set('quickShare', e.target.checked);
  $('checkNow').onclick = () => act('checkUpdates');
  $('sendFiles').onclick = () => act('sendFiles');
  api.on('panel:note', (n) => { const el = $('note'); el.textContent = (n && n.text) || ''; el.hidden = !el.textContent; clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 15000); });
  // drop files anywhere on this window to send them to the phone
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (paths.length) act('sendPaths', paths);
  });
  $('edgeSend').onchange = (e) => set('edgeSend', e.target.checked);
  $('startup').onchange = (e) => set('startup', e.target.checked);
  $('display').onchange = (e) => set('displayId', e.target.value ? Number(e.target.value) : null);
  $('saveDir').onchange = (e) => {
    if (e.target.value === 'custom') { act('chooseFolder'); if (S) e.target.value = S.saveDir === 'desktop' || S.saveDir === 'downloads' ? S.saveDir : 'custom'; }
    else set('saveDir', e.target.value);
  };
  $('name').onchange = (e) => set('name', e.target.value);
  $('name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('pair').hidden && $('qs').hidden) act('hide'); });
})();
