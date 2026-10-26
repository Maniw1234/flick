'use strict';
// "Ask each time" (main -> features.js -> ask.js): a file or batch from a phone set to ask waits for Accept here. The
// questions come as 'panel:ask' (oldest first; one shows at a time); the answer goes back as 'panel:feat' ask-answer.
// Focus starts on Decline and Accept ignores clicks for a moment, so a keystroke meant for something else can't accept.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  let list = [];
  let cur = null, shownAt = 0, tick = 0;
  const answered = new Set();

  function render() {
    const q = list.filter((a) => !answered.has(a.id));
    const a = q[0] || null;
    $('askBox').hidden = !a;
    clearInterval(tick);
    if (!a) { cur = null; return; }
    if (!cur || cur.id !== a.id) {
      shownAt = Date.now();
      setTimeout(() => { if (!$('askBox').hidden) $('askNo').focus(); }, 0);
    }
    cur = a;
    $('askFrom').textContent = a.deviceName || 'Your phone';
    $('askWhat').textContent = a.count > 1 ? a.count + ' items' : a.name;
    const what = a.count > 1 ? a.names.slice(0, 3).join(', ') + (a.names.length > 3 ? ' and ' + (a.count - 3) + ' more' : '') : '';
    $('askSub').textContent = [what, a.size ? fmt(a.size) : ''].filter(Boolean).join(' · ') || 'Nothing is saved until you accept.';
    const box = $('askList');
    box.textContent = '';
    box.hidden = !(a.names.length > 3);
    for (const n of a.names.slice(0, 50)) { const r = document.createElement('div'); const s = document.createElement('span'); s.textContent = n; r.appendChild(s); box.appendChild(r); }
    $('askMore').hidden = q.length < 2;
    $('askMore').textContent = q.length - 1 === 1 ? '1 more waiting' : (q.length - 1) + ' more waiting';
    const left = () => { const s = Math.max(0, Math.ceil((a.until - Date.now()) / 1000)); $('askTime').textContent = 'Declines by itself in ' + s + ' s'; };
    left();
    tick = setInterval(left, 1000);
  }

  function answer(yes) {
    if (!cur) return;
    if (yes && Date.now() - shownAt < 700) return;
    answered.add(cur.id);
    api.send('panel:feat', { what: 'ask-answer', id: cur.id, yes });
    render();
  }
  $('askYes').onclick = () => answer(true);
  $('askNo').onclick = () => answer(false);

  api.on('panel:ask', (l) => {
    list = Array.isArray(l) ? l : [];
    for (const id of [...answered]) if (!list.some((a) => a.id === id)) answered.delete(id);
    render();
  });

  // Escape doesn't answer: the buttons do (and it mustn't hide the window either)
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('askBox').hidden) e.stopImmediatePropagation(); }, true);
})();
