'use strict';
// Clipboard history in the panel (main -> features.js -> cliphist.js): the last 20 clipboards that went between this
// PC and a phone, each with Copy and Send to phone. The list comes as 'panel:clips'; actions go back as 'panel:feat'.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:feat', Object.assign({ what }, extra || {}));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (paths, cls) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const ICON = {
    text: ['M3.5 4.5h9', 'M3.5 8h9', 'M3.5 11.5h5.5'],
    link: ['M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6', 'M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6'],
    x: ['M4 4l8 8M12 4l-8 8'],
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    if (t >= d0.getTime()) return 'at ' + clock(t);
    if (t >= d0.getTime() - 86400000) return 'yesterday';
    return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  let F = null;            // the phone features' state (the entry)
  let C = { on: true, items: [], target: null };
  let open = false;
  let clearArmed = 0;

  function renderEntry() {
    const show = !!(F && F.seenFeat && F.clipHistory);
    $('cEntry').hidden = !show;
    if (!show) { if (open) showView(false); return; }
    const l = F.clipLast;
    $('cEntrySub').textContent = !l ? 'Text, links and pictures you copy show up here.'
      : (l.kind === 'image' ? 'A picture' : '“' + (l.preview.length > 60 ? l.preview.slice(0, 59) + '…' : l.preview) + '”') + ' · ' + ago(l.time);
  }
  api.on('panel:feat-state', (s) => { F = s; renderEntry(); });

  function showView(on) {
    open = !!on;
    $('cView').hidden = !open;
    if (open) { send('c-hello'); render(); $('cView').focus(); }
  }
  $('cEntry').onclick = () => showView(true);
  $('cBack').onclick = () => showView(false);
  $('cClear').onclick = () => {
    // asks once more: it can't be undone
    if (Date.now() - clearArmed < 4000) { clearArmed = 0; send('c-clear'); $('cClear').textContent = 'Clear'; return; }
    clearArmed = Date.now();
    $('cClear').textContent = 'Clear all?';
    setTimeout(() => { if (clearArmed && Date.now() - clearArmed >= 4000) { clearArmed = 0; $('cClear').textContent = 'Clear'; } }, 4100);
  };

  function render() {
    const items = C.items || [];
    $('cEmpty').hidden = items.length > 0;
    $('cClear').hidden = !items.length;
    $('cFoot').hidden = !items.length;
    const list = $('cList');
    list.textContent = '';
    const t = C.target;
    for (const it of items) {
      const row = el('div', 'crow');
      const ic = el('span', 'cic' + (it.kind === 'image' ? ' pic' : ''));
      if (it.kind === 'image' && it.thumb) { const i = el('img'); i.alt = ''; i.src = it.thumb; ic.appendChild(i); }
      else ic.appendChild(svg(it.kind === 'link' ? ICON.link : ICON.text));
      row.appendChild(ic);
      const main = el('div', 'cmain');
      const prev = el('div', 'cprev' + (it.kind === 'link' ? ' link' : ''), it.kind === 'image' ? 'Picture' + (it.w && it.h ? ' · ' + it.w + ' × ' + it.h : '') : it.preview);
      main.appendChild(prev);
      main.appendChild(el('div', 'csub', (it.dir === 'out' ? 'Sent to ' : 'From ') + (it.deviceName || 'your phone') + ' · ' + ago(it.time)));
      row.appendChild(main);
      const btns = el('div', 'cbtns');
      const copy = el('button', 'btn ghost cbtn', 'Copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', 'Copy ' + (it.kind === 'image' ? 'the picture' : it.preview.slice(0, 40)));
      copy.onclick = () => { send('c-copy', { id: it.id }); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
      const snd = el('button', 'btn ghost cbtn', 'Send');
      snd.type = 'button';
      snd.disabled = !(t && t.ok);
      snd.title = t ? (t.ok ? 'Send to ' + t.name : 'Update Flick on ' + t.name + ' first') : 'Connect your phone first';
      snd.setAttribute('aria-label', t ? 'Send to ' + t.name : 'Send to phone');
      snd.onclick = () => send('c-send', { id: it.id });
      btns.appendChild(copy); btns.appendChild(snd);
      row.appendChild(btns);
      const x = el('button', 'wx cx');
      x.type = 'button'; x.title = 'Remove'; x.setAttribute('aria-label', 'Remove from clipboard history');
      x.appendChild(svg(ICON.x));
      x.onclick = () => send('c-remove', { id: it.id });
      row.appendChild(x);
      list.appendChild(row);
    }
  }

  api.on('panel:clips', (c) => { C = c || { on: true, items: [], target: null }; if (open) render(); });
  setInterval(() => { if (open) render(); else if (F) renderEntry(); }, 30000);    // "2 min ago" stays true

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open || !$('askBox').hidden) return;
    e.stopImmediatePropagation();
    showView(false);
  }, true);
})();
