/* Settings › Send feedback: Bug or Idea, the message, an optional email address and, ticked by default, the device info
 * shown under it (exactly what is sent); the last crash report too, when there is one and the user ticks it (it shows
 * then). The app posts it to the feedback form itself (Feedback.java), or keeps it and sends it once it can. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const NOT_READY = 'This version of Flick can’t send feedback yet.';
  const page = X.page({ id: 'fFeedback', title: 'Send feedback' });
  let info = {}, type = 'bug', busy = false, busyT = 0, f = null;

  // Settings › Help, the last group (shared with Show tips again, features/tips.js): Send feedback goes last in it
  A.on('settings-end', (body) => {
    if (!A.has('feedbackSend')) return;
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Send feedback'), h('small', '', 'Report a bug or share an idea'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); open(); };
    X.helpCard(body).appendChild(row);
  });

  function open() {
    info = A.njson('feedbackInfo') || {};
    build();
    page.open();
  }

  function check(label, sub, on) {
    const l = h('label', 'fbchk');
    const i = h('input');
    i.type = 'checkbox'; i.checked = !!on;
    const tx = h('span', 'fbct');
    tx.appendChild(document.createTextNode(label));
    if (sub) tx.appendChild(h('small', '', sub));
    l.append(i, h('span', 'fbbox'), tx);
    l.input = i;
    return l;
  }

  function build() {
    const body = page.body;
    body.innerHTML = '';
    busy = false;
    const form = h('form', 'fbform');
    form.setAttribute('novalidate', '');
    form.autocomplete = 'off';
    if (+info.waiting > 0) form.appendChild(h('div', 'fnote fbwait', +info.waiting === 1 ? 'One message is waiting to be sent.' : info.waiting + ' messages are waiting to be sent.'));

    const seg = h('div', 'sseg fbseg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Kind of feedback');
    for (const [v, text] of [['bug', 'Bug'], ['idea', 'Idea']]) {
      const b = h('button', '', text);
      b.type = 'button'; b.dataset.v = v;
      b.setAttribute('role', 'radio');
      b.onclick = () => { A.haptic('tick'); setType(v); };
      seg.appendChild(b);
    }
    const msgLbl = h('label', 'fblbl');
    msgLbl.htmlFor = 'fbMsg';
    const msg = h('textarea', 'fbin');
    msg.id = 'fbMsg'; msg.rows = 6; msg.maxLength = 5000; msg.spellcheck = true;
    const mailLbl = h('label', 'fblbl');
    mailLbl.htmlFor = 'fbMail';
    mailLbl.append(document.createTextNode('Email '), h('small', '', 'optional, if you’d like an answer'));
    const mail = h('input', 'fbin');
    mail.id = 'fbMail'; mail.type = 'email'; mail.inputMode = 'email'; mail.maxLength = 200; mail.spellcheck = false;
    mail.placeholder = 'name@example.com';
    mail.setAttribute('autocapitalize', 'off');

    const dev = check('Include device info', '', true);
    const devText = h('div', 'fbdev', String(info.device || ''));
    form.append(seg, msgLbl, msg, mailLbl, mail, dev, devText);

    let crash = null, crashText = null;
    if (info.crash) {
      let when = '';
      try { when = new Date(+info.crashAt).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (e) { /* no date */ }
      crash = check('Attach the last crash report', when ? 'From ' + when + '. It shows here when ticked.' : 'It shows here when ticked.', false);
      crashText = h('div', 'fbdev fbcrash', String(info.crash));
      crashText.hidden = true;
      crash.input.onchange = () => { crashText.hidden = !crash.input.checked; };
      form.append(crash, crashText);
    }
    dev.input.onchange = () => devText.classList.toggle('off', !dev.input.checked);

    const send = h('button', 'fbig fbsend');
    send.type = 'submit';
    const note = h('div', 'fbnote');
    note.setAttribute('role', 'status');
    form.append(send, note);
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    msg.oninput = mail.oninput = () => { if (note.classList.contains('bad')) { note.textContent = ''; note.classList.remove('bad'); } };   // being fixed
    body.appendChild(form);
    f = { form, seg, msgLbl, msg, mail, dev, crash, send, note };
    setType('bug');
    render();
  }

  function setType(v) {
    type = v === 'idea' ? 'idea' : 'bug';
    for (const b of f.seg.querySelectorAll('button')) { const on = b.dataset.v === type; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    f.msgLbl.textContent = type === 'idea' ? 'What’s your idea?' : 'What went wrong?';
    f.msg.placeholder = type === 'idea' ? 'What would make Flick better for you?' : 'What did you do, what happened, and what did you expect?';
  }

  function render() {
    if (!f) return;
    const ready = info.ready === true;
    f.send.disabled = busy || !ready;
    f.send.textContent = !ready ? 'Feedback isn’t set up yet' : busy ? 'Sending…' : 'Send';
    if (!ready) note(NOT_READY);
    else if (f.note.textContent === NOT_READY) note('');
  }
  function note(text, bad) { f.note.textContent = text || ''; f.note.classList.toggle('bad', !!bad); }

  function submit() {
    if (busy || info.ready !== true) return;
    const message = f.msg.value.trim(), email = f.mail.value.trim();
    if (!message) { note(type === 'idea' ? 'Write your idea first.' : 'Say what went wrong first.', true); f.msg.focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note('That email address doesn’t look right.', true); f.mail.focus(); return; }
    busy = true;
    note('');
    render();
    try { document.activeElement.blur(); } catch (e) { /* the keyboard goes */ }
    A.nc('feedbackSend', JSON.stringify({ type, message, email, device: f.dev.input.checked, crash: !!(f.crash && f.crash.input.checked) }));
    clearTimeout(busyT);
    busyT = setTimeout(() => { if (busy) { busy = false; note('Couldn’t send it. Try again.', true); render(); } }, 60000);
  }

  function done(title, text) {
    const body = page.body;
    body.innerHTML = '';
    f = null;
    const b = h('button', 'fbig fbdone', 'Done');
    b.onclick = () => page.close();
    body.appendChild(X.empty(A.icons.check, title, text, b));
  }

  A.on('native', (e) => {
    if (e.t !== 'feedback') return;
    if (e.later) {
      // feedback that waited went just now
      if (!page.isOpen()) A.toast('Your feedback was sent', 2200);
      else if (f) { info.waiting = 0; const w = f.form.querySelector('.fbwait'); if (w) w.remove(); }
      return;
    }
    if (!busy || !f) return;
    busy = false;
    clearTimeout(busyT);
    if (e.ok || e.queued) {
      if (!page.isOpen()) A.toast(e.ok ? 'Your feedback was sent' : 'Feedback saved, it goes once you’re online', 2400);
      if (e.ok) done('Thanks', 'Your feedback was sent.');
      else done('Saved for later', 'You’re offline right now. Flick sends your feedback once it can, and lets you know.');
    } else {
      note(e.why === 'refused' ? 'The feedback form didn’t take it. Try again later.' : e.why === 'email' ? 'That email address doesn’t look right.'
        : e.why === 'setup' ? NOT_READY : 'Couldn’t send it. Try again.', true);
      render();
    }
  });
});
