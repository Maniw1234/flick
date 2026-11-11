'use strict';
// Send feedback (main.js -> feedback.js): Bug or Idea, the message, an optional email and, ticked by default, the device
// info shown under the box (exactly what is sent). Sent to the Google Form, or kept and sent later when there's no
// connection. State comes as 'panel:feedback'; the form goes back as 'panel:feedback' send.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:feedback', Object.assign({ what }, extra || {}));
  const NOT_READY = 'This version of Flick can’t send feedback yet.';
  let S = { ready: false, device: '', waiting: 0 };
  let type = 'bug', open = false, busy = false;
  let refusedBack = false;    // a message kept for later that the form didn't take is back in the box (said when opened)
  const REFUSED = 'The feedback form didn’t take this when Flick tried to send it. Try again later.';

  function setType(t) {
    type = t === 'idea' ? 'idea' : 'bug';
    for (const b of $('fbType').querySelectorAll('button')) { const on = b.dataset.v === type; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    $('fbMsgLbl').textContent = type === 'idea' ? 'What’s your idea?' : 'What went wrong?';
    $('fbMsg').placeholder = type === 'idea' ? 'What would make Flick better for you?' : 'What did you do, what happened, and what did you expect?';
  }
  for (const b of $('fbType').querySelectorAll('button')) b.onclick = () => setType(b.dataset.v);

  function render() {
    $('fbDevText').textContent = S.device || '';
    $('fbDevText').classList.toggle('off', !$('fbDev').checked);
    const sendBtn = $('fbSend');
    // (while it sends: not disabled, so the keyboard stays on it; the form takes no second send meanwhile)
    sendBtn.disabled = !S.ready;
    if (busy) sendBtn.setAttribute('aria-disabled', 'true'); else sendBtn.removeAttribute('aria-disabled');
    sendBtn.textContent = !S.ready ? 'Feedback isn’t set up yet' : busy ? 'Sending…' : 'Send';
    if (!S.ready) note(NOT_READY);
    else if ($('fbNote').textContent === NOT_READY) note('');
  }
  function note(text, bad) { $('fbNote').textContent = text || ''; $('fbNote').classList.toggle('bad', !!bad); }

  function showView(on) {
    open = !!on;
    $('fbView').hidden = !open;
    if (open) {
      $('fbForm').hidden = false; $('fbDone').hidden = true;
      note(refusedBack ? REFUSED : '', refusedBack);
      refusedBack = false;
      send('hello');
      render();
      $('fbView').focus();
      setTimeout(() => { if (open && S.ready) $('fbMsg').focus(); }, 50);
    }
  }
  $('fbOpen').onclick = () => showView(true);
  (window.flickViews = window.flickViews || {}).fb = (on) => { if (open !== !!on) showView(on); };   // (the bar closes it: nav.js)
  $('fbBack').onclick = () => showView(false);
  $('fbAgain').onclick = () => showView(false);
  $('fbDev').onchange = render;
  $('fbMsg').oninput = $('fbEmail').oninput = () => { if ($('fbNote').classList.contains('bad')) note(''); };   // being fixed

  $('fbForm').onsubmit = (e) => {
    e.preventDefault();
    if (busy || !S.ready) return;
    const message = $('fbMsg').value.trim();
    const email = $('fbEmail').value.trim();
    if (!message) { note(type === 'idea' ? 'Write your idea first.' : 'Say what went wrong first.', true); $('fbMsg').focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note('That email address doesn’t look right.', true); $('fbEmail').focus(); return; }
    busy = true;
    note('');
    render();
    send('send', { type, message, email, device: $('fbDev').checked });
  };

  function done(title, text) {
    // (the keyboard was in the form, hidden now: it goes to what's said instead of being dropped to the page)
    const had = $('fbForm').contains(document.activeElement);
    $('fbForm').hidden = true; $('fbDone').hidden = false;
    $('fbDoneTitle').textContent = title;
    $('fbDoneText').textContent = text;
    $('fbMsg').value = ''; $('fbEmail').value = ''; $('fbDev').checked = true;
    setType('bug');
    if (had) $('fbDoneTitle').focus();
  }

  api.on('panel:feedback', (s) => {
    if (!s) return;
    S = Object.assign(S, s);
    if (s.refused && !busy) {
      // (not over something being written: then it's only said)
      const back = !$('fbMsg').value.trim();
      if (back) { setType(s.refused.type); $('fbMsg').value = s.refused.message || ''; $('fbEmail').value = s.refused.email || ''; }
      if (open) { $('fbForm').hidden = false; $('fbDone').hidden = true; note(back ? REFUSED : 'The feedback form didn’t take the message Flick kept for later.', true); } else refusedBack = back;
      send('refused-seen');
    }
    if (s.result) {
      busy = false;
      const r = s.result;
      if (r.ok) done('Thanks', 'Your feedback was sent.');
      else if (r.queued) done('Saved for later', 'You’re offline right now. Flick sends your feedback once it can, and lets you know.');
      else note(r.why === 'refused' ? 'The feedback form didn’t take it. Try again later.' : r.why === 'email' ? 'That email address doesn’t look right.' : 'Couldn’t send it. Try again.', true);
    } else if (s.later && open && !$('fbDone').hidden) {
      done('Thanks', 'Your feedback was sent.');
    }
    render();
  });

  window.addEventListener('keydown', (e) => {
    // (a question in front, Accept, pairing, Quick Share: answered with its buttons; this view stays behind it)
    if (e.key !== 'Escape' || !open || [...document.querySelectorAll('.modal')].some((m) => !m.hidden)) return;
    e.stopImmediatePropagation();
    showView(false);
  }, true);

  setType('bug');
})();
