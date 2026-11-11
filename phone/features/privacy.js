/* Settings › Help › Privacy: the privacy policy, in the app itself (it works with no internet). The same text is
 * PRIVACY.md, the page Google Play links to (there the addresses are links, with https://): change both together. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const page = X.page({ id: 'fPrivacy', title: 'Privacy' });
  // [heading, paragraphs or a list (an array)]
  const TEXT = [
    [null, 'Flick has no accounts, no ads, no analytics and no servers of its own. What you send goes straight from one of your devices to another, encrypted, over your Wi-Fi, a USB cable, a hotspot or Bluetooth. It doesn’t go through the internet, and nobody else, us included, receives it. The one exception to “encrypted” is Share with a browser, on the computer: a web browser can’t check Flick’s certificate, so what you share with a browser you allowed travels over plain HTTP on your local network, where others on that network could read it.'],
    ['What Flick handles, and where it goes', [
      ['Files, links and the clipboard', ' you send, or that your other devices send to this one. They go only to the device you paired and chose, and are saved only on that device.'],
      ['Notifications', ', only if you turn on “Show notifications on your PC”. Flick then reads this phone’s notifications and shows them on your paired computer. They aren’t kept on the phone, and go nowhere else.'],
      ['Your files', ', with “All files access”, so Flick can show and send any file on this phone as a file manager does. With “Let your PC browse this phone” on, your paired computer can see and copy them; it can’t change or delete them.'],
      ['The camera', ', only while you use Air grab. The pictures are looked at on the phone to find your hand, and are never saved or sent.'],
      ['Wi-Fi and Bluetooth', ', to find your devices nearby and connect to them. Android calls this location access on some versions; Flick doesn’t use or keep your location.'],
    ]],
    ['What stays on your device', 'Your settings, the devices you paired, the list of what was sent (History), the last 20 things copied through Flick (Clipboard history) and, after a crash, a crash report. They stay on that device until you clear them or remove Flick.'],
    ['When something leaves your devices', [
      ['Send feedback', ' sends your message to us (a Google Form) only when you press Send: the message, your email address if you give one, and the device details and the last crash report only if you leave them ticked. Google’s privacy policy covers the form: policies.google.com/privacy'],
      // (both versions say the whole of it, as PRIVACY.md does: which one this is shows in Advanced settings › About)
      ['Updates', ': Flick on the computer, and the phone app from GitHub, ask GitHub whether there’s a newer version and download it from there. GitHub sees the device’s internet address, as any website does, and that it is Flick asking. Google Play updates the Google Play version of the phone app itself.'],
    ]],
    ['Children', 'Flick isn’t made for children and doesn’t knowingly collect anything from anyone.'],
    ['Changes and contact', 'A change to this policy is published in PRIVACY.md at github.com/Maniw1234/flick and in the app, with a new date. Questions: use Send feedback in the app, or open an issue at github.com/Maniw1234/flick/issues.'],
  ];

  function build() {
    const b = page.body;
    b.innerHTML = '';
    const w = h('div', 'gp pv');
    for (const [head, body] of TEXT) {
      if (head) w.appendChild(h('h2', 'pvh', head));
      if (typeof body === 'string') { w.appendChild(h('p', '', body)); continue; }
      const ul = h('ul', 'pvl');
      for (const [b1, rest] of body) { const li = h('li'); li.append(h('b', '', b1), document.createTextNode(rest)); ul.appendChild(li); }
      w.appendChild(ul);
    }
    w.appendChild(h('p', 'gpnote', 'Effective 9 November 2026'));
    b.appendChild(w);
  }

  A.on('settings-end', (body) => {
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Privacy'), h('small', '', 'What Flick does with your files and data'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); build(); page.open(); };
    X.helpCard(body).appendChild(row);
  });
});
