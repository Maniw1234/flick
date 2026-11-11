/* Get Flick for your PC. Flick on a phone does little alone, and someone who found it on Google Play may have nothing
 * on the computer yet. A link on the Connect screen (while no PC was ever paired here) and a row in Settings › Help open
 * a page: where to download it, and the link to send to the computer through Android's share sheet (Copy, an email or
 * a message to oneself). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const SHOWN = 'github.com/Maniw1234/flick/releases/latest';
  const LINK = 'https://' + SHOWN;
  const page = X.page({ id: 'fGetPc', title: 'Get Flick for your PC' });

  function build() {
    const b = page.body;
    b.innerHTML = '';
    const w = h('div', 'gp');
    w.appendChild(h('p', 'gpintro', 'Flick sends files, links and the clipboard between this phone and your computer. Your computer needs Flick too. It’s free, for Windows, Mac and Linux.'));
    const ol = h('ol', 'gpsteps');
    const s1 = h('li');
    s1.appendChild(h('span', '', 'On your computer, open this address in a web browser:'));
    // (it may break only after a slash: "releases/late / st" was hard to type)
    const addr = h('div', 'gpaddr');
    SHOWN.split('/').forEach((part, i) => { if (i) addr.append('/', h('wbr')); addr.append(part); });
    addr.setAttribute('dir', 'ltr');
    s1.appendChild(addr);
    ol.append(s1,
      h('li', '', 'Download Flick for your computer there, and open it.'),
      h('li', '', 'With both on the same Wi-Fi, hold Connect here, then click Allow on your computer.'));
    w.appendChild(ol);
    if (A.has('shareText')) {
      const send = h('button', 'fbig gpsend', 'Send the link to your computer');
      send.onclick = () => { A.haptic('soft'); A.nc('shareText', 'Flick for your computer', LINK); };
      w.appendChild(send);
      w.appendChild(h('p', 'gpnote', 'Email it or message it to yourself, or copy it.'));
    }
    b.appendChild(w);
  }
  function open() { build(); page.open(); }

  // the Connect screen's link: until a PC was paired here (after that, Help has it)
  const btn = h('button', 'plink', 'Get the PC app');
  btn.id = 'getPcBtn';
  btn.onclick = () => { A.haptic('soft'); open(); };
  const links = document.querySelector('#pair .plinks');
  if (links) links.insertBefore(btn, links.firstChild);
  function shown() { btn.hidden = Object.keys(A.knownPcs()).length > 0; }
  shown();
  A.on('conn', shown);
  A.on('native', (e) => { if (e.t === 'resume') shown(); });

  A.on('settings-end', (body) => {
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Get Flick for your PC'), h('small', '', 'Download it for Windows, Mac or Linux'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); open(); };
    X.helpCard(body).appendChild(row);
  });
});
