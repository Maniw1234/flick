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
    $('statusText').textContent = s.connected ? `Connected to ${s.phone}` : 'Waiting for your phone';
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
    $('edgeSend').checked = !!s.edgeSend;
    $('startup').checked = !!s.startup;
    $('startupRow').hidden = !s.isWin;
    if (document.activeElement !== $('name')) $('name').value = s.name || '';
    $('addr').textContent = (s.ips && s.ips.length ? s.ips.slice(0, 3).join(', ') : 'No network') + (s.port ? `  (port ${s.port})` : '');
    $('ver').textContent = 'Flick ' + s.version;
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
  document.addEventListener('visibilitychange', () => playClips(!document.hidden));
  window.addEventListener('focus', () => playClips(true));
  playClips(true);

  api.on('panel:state', render);
  api.on('panel:pair', (s) => {
    pairDevice = s.device;
    $('pairName').textContent = s.name || 'A phone';
    $('pair').hidden = false;
    $('allow').focus();
  });
  api.on('panel:pair-cancel', (d) => { if (d && d.device === pairDevice) { $('pair').hidden = true; pairDevice = null; } });

  $('allow').onclick = () => { if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: true }); $('pair').hidden = true; pairDevice = null; };
  $('deny').onclick = () => { if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: false }); $('pair').hidden = true; pairDevice = null; };
  $('close').onclick = () => act('hide');
  $('quit').onclick = () => act('quit');
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
  $('edgeSend').onchange = (e) => set('edgeSend', e.target.checked);
  $('startup').onchange = (e) => set('startup', e.target.checked);
  $('display').onchange = (e) => set('displayId', e.target.value ? Number(e.target.value) : null);
  $('saveDir').onchange = (e) => {
    if (e.target.value === 'custom') { act('chooseFolder'); if (S) e.target.value = S.saveDir === 'desktop' || S.saveDir === 'downloads' ? S.saveDir : 'custom'; }
    else set('saveDir', e.target.value);
  };
  $('name').onchange = (e) => set('name', e.target.value);
  $('name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('pair').hidden) act('hide'); });
})();
