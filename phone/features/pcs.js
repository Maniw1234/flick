/* Several PCs. With more than one paired PC around, the PC button on the main screen opens a sheet to
 * switch between them (like "Not your PC?" on the pairing screen); with one, it does what it always did. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';

  // the paired PCs this phone can see now (and the one it uses), each once, by its fastest link
  function pairedPcs() {
    const best = new Map();
    for (const p of (A.st.pcs || []).concat(A.st.pc ? [A.st.pc] : [])) {
      if (!p || !p.id || !A.paired(p.id)) continue;
      const have = best.get(p.id);
      if (!have || A.rankOf(p) > A.rankOf(have)) best.set(p.id, p);
    }
    return Array.from(best.values());
  }

  function switchTo(p) {
    if (A.busyMoving()) { A.toast('Wait until your files finish moving', 2400); return; }
    A.st.wantResume = true;                        // connect as soon as it has signed in, as after a lost link
    A.closeLink();
    A.choosePc(p);
    A.toast('Connecting to ' + p.name + '…', 2400);
  }

  A.on('pcTap', () => {
    const list = pairedPcs();
    if (list.length < 2) return false;
    const st = A.st, cur = st.pc && st.pc.id;
    list.sort((a, b) => (b.id === cur) - (a.id === cur) || String(a.name).localeCompare(String(b.name)));
    const items = list.map((p) => {
      const here = p.id === cur;
      return {
        label: p.name, icon: 'side',
        tag: here ? (st.connected ? 'Connected' : 'Not connected') : A.LINK_NAMES[p.via] || 'Wi-Fi',
        run: () => {
          if (!here) switchTo(p);
          else if (!st.connected) { A.showScreen('pair'); A.openLinkSoon(); }
        },
      };
    });
    if (st.connected) items.push({ label: 'Disconnect', icon: 'off', danger: true, run: () => { st.wantResume = false; st.noAuto = true; A.closeLink(); A.showScreen('pair'); A.openLinkSoon(); } });
    A.openSheet(st.connected ? 'Connected to ' + st.pc.name : 'Choose your PC', items);
    return true;
  });
});
