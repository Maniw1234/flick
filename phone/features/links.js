/* Links. A link shared to Flick from another app opens on the PC or goes to the Flick list; a link the PC
 * sends opens here (the app shows a notification instead when Flick isn't in front). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  let waiting = null;                         // { url, at }: "Open on <PC>" before the PC was connected

  const isLink = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(u);
  function shortUrl(u) {
    const s = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }
  const hostOf = (u) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].slice(0, 60);

  function openOnPc(url) {
    if (A.st.connected) {
      if (!X.newPc()) { A.toast(X.OLD_PC, 2800); return; }
      if (A.wsSend({ t: 'link', url })) { A.haptic('confirm'); A.toast('Opening on ' + X.pcName(), 1800); return; }
    }
    if (!A.st.pc) { A.toast('Connect to your PC first', 2400); return; }
    waiting = { url, at: Date.now() };
    A.toast('Opens on ' + X.pcName() + ' once you connect', 2600);
  }
  A.on('conn', () => {
    if (!waiting || !A.st.connected) return;
    const w = waiting;
    waiting = null;
    if (Date.now() - w.at < 5 * 60e3) setTimeout(() => openOnPc(w.url), 600);
  });

  function saveToList(url, title) {
    // the app keeps it as a text item in the Flick list and answers with 'added', as for any share
    if (A.nc('saveLink', url, title || hostOf(url)) === null) A.toast('Couldn’t save the link', 2400);
  }

  A.on('native', (e) => {
    if (e.t === 'share-link' && isLink(e.url)) {
      const url = e.url, title = typeof e.title === 'string' ? e.title.trim().slice(0, 200) : '';
      A.openSheet(title || shortUrl(url), [
        { label: 'Open on ' + X.pcName(), icon: 'open', run: () => openOnPc(url) },
        { label: 'Save to the Flick list', icon: 'save', run: () => saveToList(url, title) },
      ]);
    } else if (e.t === 'link-in' && isLink(e.url) && !document.hidden) {
      // a link from the PC over the background link: the app opens it itself while Flick is in front
      A.toast('Opening a link from ' + X.pcName(), 1800);
    }
  });

  // a link from the PC while this page is connected: opened at once. The app's openUrl starts the browser; Android
  // doesn't let an app do that from the background, so then it shows the "Link from <PC>" notification instead.
  A.on('ws', (m) => {
    if (m.t !== 'link' || !A.linkAuthed() || !isLink(m.url)) return;
    if (A.nc('openUrl', m.url) === null) return;
    if (!document.hidden) A.toast('Opening a link from ' + X.pcName(), 1800);
  });
});
