/* Browse phone: the PC asks over this page's link to see this phone's photos, videos and files ({t:'browse', ...}).
 * The app answers the PC itself (Browse.java), and only while Settings › Let your PC browse this phone is on; this page
 * hands the requests over and says when the PC is looking. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';

  A.on('ws', (m) => {
    if (m.t !== 'browse' || !A.linkAuthed() || !A.st.pc || !A.has('browse')) return;
    A.nc('browse', JSON.stringify(m), String(A.st.pc.id || ''));
  });

  // said while Flick is in front: the PC copies files, or is looking (at most once a minute), or would like to
  let saidAt = 0;
  A.on('native', (e) => {
    if (e.t !== 'browse' || document.hidden) return;
    const pc = X.pcName();
    if (e.op === 'pull') {
      saidAt = Date.now();
      A.toast(pc + ' is copying ' + (+e.n > 1 ? e.n + ' files' : 'a file') + ' from this phone', 2600);
      return;
    }
    if (Date.now() - saidAt < 60000) return;
    saidAt = Date.now();
    A.toast(e.off ? pc + ' wants to browse this phone' : pc + ' is browsing this phone', 2400);
  });
});
