/* Links. A link shared to Flick from another app opens on the PC or on another phone, or goes to the Flick list; a link
 * the PC sends opens here (the app shows a notification instead when Flick isn't in front); one another phone sends is
 * asked about here (or a notification), never opened by itself. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  let waiting = null;                         // { url, at }: "Open on <PC>" before the PC was connected

  // (no name before the host: "https://bank.example@evil.example" reads as one site and opens another; as the app's
  // Links.ok and the PC refuse it. An "@" in the path or query is fine. Nor a '%' in the host outside an IPv6 address's
  // brackets: "bank.example%40evil.example" is the same once decoded)
  const isLink = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\/(?:\[[^\s/?#@\]]+\][^\s/?#@%]*|[^\s/?#@%[]+)(?:[/?#]\S*)?$/i.test(u);
  // How an address shows: its host as the browser goes to it, and without direction controls (one from another phone
  // showed partly backwards, a different site than the one it opens). A host in another script that copies a known
  // site's letters ("аррӏе.com" in Cyrillic) showed as that site while the browser opened xn--80ak6aa92e.com: every
  // name with letters other than plain ones shows in the browser's xn-- form, as the PC shows it (whatever the script:
  // Chinese, Japanese and Korean have look-alikes too, of Latin letters and of each other).
  // the address with its host as the browser has it (the rest stays as written, minus direction controls)
  function shown(u) {
    const s = X.clean(u), m = /^(https?:\/\/)(\[[^\]]*\][^/?#\\]*|[^/?#\\]*)(.*)$/i.exec(s);
    if (!m) return s;
    let host;
    try {
      const x = new URL(u);
      host = x.hostname;
      if (x.port) host += ':' + x.port;
    } catch (e) {
      // not an address the browser takes: its letters other than plain ones as %XX, never as look-alikes
      host = m[2].replace(/[^\x21-\x7e]/gu, (c) => { try { return encodeURIComponent(c); } catch (x) { return '%3F'; } });
    }
    return m[1] + host + m[3];
  }
  // At most n characters, the host's end never cut: the path gives way first, then the host's start ("…verify.
  // evil.example"). A long host cut at its end showed only the site it begins with ("accounts.google.com.signin-…"),
  // never the one it opens.
  function fit(s, n) {
    const i = s.search(/[/?#]/), host = Array.from(i < 0 ? s : s.slice(0, i)), rest = Array.from(i < 0 ? '' : s.slice(i));
    if (host.length + rest.length <= n) return s;
    if (host.length >= n - 1) return '…' + host.slice(host.length - (n - 1)).join('');
    return host.join('') + rest.slice(0, n - 1 - host.length).join('') + '…';
  }
  const bare = (u) => shown(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const shortUrl = (u) => fit(bare(u).replace(/\/$/, ''), 60);
  const hostOf = (u) => fit(bare(u).split(/[/?#]/)[0], 60);

  // (with no PC paired, or one that no longer has this phone paired: "Open on a PC", which opens the Connect screen, as
  // the sends do (core.js X.sendPc); the link opens on the PC once connected. It named that PC, "once you connect")
  function openOnPc(url) {
    if (A.st.connected && X.sendPc()) {
      if (!X.newPc()) { A.toast(X.OLD_PC, 2800); return; }
      if (A.wsSend({ t: 'link', url })) { A.haptic('confirm'); A.toast('Opening on ' + X.pcName(), 1800); return; }
    }
    waiting = { url, at: Date.now() };
    if (!X.sendPc()) { X.toConnect(); A.toast('Opens on a PC once you connect', 2600); return; }
    A.toast('Opens on ' + X.pcName() + ' once you connect', 2600);
  }
  A.on('conn', () => {
    if (!waiting || !A.st.connected || !X.sendPc()) return;
    const w = waiting;
    waiting = null;
    if (Date.now() - w.at < 5 * 60e3) setTimeout(() => openOnPc(w.url), 600);
  });

  function saveToList(url, title) {
    // the app keeps it as a text item in the Flick list and answers with 'added', as for any share
    // (named by its site first: the sharing app's title alone could name another site than the one it opens)
    if (A.nc('saveLink', url, hostOf(url) + (title ? ' · ' + title : '')) === null) A.toast('Couldn’t save the link', 2400);
  }

  // on another phone: it shows there (a notification, or a question while Flick is open there)
  async function openOnPhone(d, url) {
    const nm = X.clean(d.name) || 'Phone';
    A.toast('Sending the link to ' + nm + '…', 1400);
    const r = await X.peerMsg(d.id, 'link', url);
    if (r.ok) { A.haptic('confirm'); A.toast('Sent to ' + nm + '. It shows there to open.', 2200); }
    else { A.haptic('reject'); A.toast(X.peerWhy(r.why, nm), 2800); }
  }

  A.on('native', (e) => {
    if (e.t === 'share-link' && isLink(e.url)) {
      const url = e.url, title = typeof e.title === 'string' ? X.clean(e.title.slice(0, 200)) : '';
      const items = [];
      // the PC (when there is one), each phone this one sends to, and the Flick list
      const phones = A.pairedPhones ? A.pairedPhones() : [];
      if (A.st.pc || !phones.length) items.push({ label: X.sendLabel('Open on '), icon: 'open', run: () => openOnPc(url) });
      for (const d of phones) items.push({ label: 'Open on ' + (X.clean(d.name) || 'Phone'), icon: 'phone', tag: d.nearby ? 'Nearby' : '', run: () => openOnPhone(d, url) });
      items.push({ label: 'Save to the Flick list', icon: 'save', run: () => saveToList(url, title) });
      // headed by the address it opens: the sharing app's subject (a page title) could be another site's address, so
      // it only shows under it
      A.openSheet(shortUrl(url), items);
      // (on two lines when it must: a heading cut to the width at its end hid the site again)
      // (and with large text the heading's three-line cap is lifted for it: the cap cut the host's end again). The mark
      // goes once the next sheet's heading replaces this one (a :has() rule needs a newer WebView than Android 9's)
      const head = document.getElementById('sheetTitle');
      head.textContent = ''; head.appendChild(X.nm('span', 'flhost', shortUrl(url)));
      head.classList.add('flhead');
      const mo = new MutationObserver(() => { if (!head.querySelector('.flhost')) { head.classList.remove('flhead'); mo.disconnect(); } });
      mo.observe(head, { childList: true });
      if (title) {
        const sub = X.nm('div', 'fknote flsub', '“' + title + '”');      // (quoted: the page's own words)
        document.getElementById('sheetItems').prepend(sub);
      }
    } else if (e.t === 'peer-link' && isLink(e.url)) {
      // another phone sent it: opened only if the user says so here (it may be someone else's phone). It waits while
      // another sheet is open, and each one waits its turn (a second link replaced the first)
      const url = e.url, from = X.clean(e.from) || 'Another phone';
      A.haptic('soft');
      A.openSheet(from + ' sent a link', [
        { label: 'Open ' + shortUrl(url), icon: 'open', run: () => { if (A.nc('openUrl', url) === null) A.toast('Couldn’t open it', 2000); } },
        { label: 'Save to the Flick list', icon: 'save', run: () => saveToList(url, '') },
      ], { wait: true });
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
