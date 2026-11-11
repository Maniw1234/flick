/* Settings › Help: "Rate Flick" (the Google Play version only: it opens Flick's page in Google Play) and "Open-source
 * notices": what Flick is made with and each part's license. The licenses' full text is in the app itself
 * (fonts/Inter-LICENSE.txt, hand/LICENSE-MediaPipe.txt; MainActivity.noticeFile serves them), read when asked for. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const PLAY = A.INFO.store === 'play';
  const PLAY_PAGE = 'https://play.google.com/store/apps/details?id=io.github.maniw1234.flick';
  const page = X.page({ id: 'fNotices', title: 'Open-source notices' });
  // [name, what it is and whose, its license, the name the app serves the license's text under, its file in the source]
  const PARTS = [
    ['Flick', 'This app and Flick for your computer. The source is at github.com/Maniw1234/flick.', 'MIT License', null],
    ['Inter', 'The typeface Flick is set in. Copyright The Inter Project Authors (github.com/rsms/inter).', 'SIL Open Font License 1.1', 'inter', 'phone/fonts/Inter-LICENSE.txt'],
    ['MediaPipe hand models', 'Air grab finds your hand with MediaPipe’s palm detection and hand landmark models. Copyright The MediaPipe Authors.', 'Apache License 2.0', 'mediapipe', 'phone/hand/LICENSE-MediaPipe.txt'],
  ];
  const MIT = 'MIT License\n\nCopyright (c) 2026 Maniw1234\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';

  function build() {
    const b = page.body;
    b.innerHTML = '';
    const w = h('div', 'gp pv');
    w.appendChild(h('p', '', 'Flick is free and open source. It’s made with these, each under its own license.'));
    PARTS.forEach(function (p) {
      w.appendChild(h('h2', 'pvh', p[0]));
      w.appendChild(h('p', '', p[1]));
      const more = h('button', 'plink onl', p[2]);
      const text = h('pre', 'ontext');
      text.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      more.onclick = function () {
        A.haptic('soft');
        const show = text.hidden;
        text.hidden = !show;
        more.setAttribute('aria-expanded', String(show));
        if (!show || text.textContent) return;
        if (!p[3]) { text.textContent = MIT; return; }
        text.textContent = 'Loading…';
        // (served by the app, as the hand tracker's files are: a file:// page can't fetch files)
        fetch('https://flick.local/notice/' + p[3]).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (t) { text.textContent = t; })
          .catch(function () { text.textContent = 'The license’s text is at github.com/Maniw1234/flick, in ' + p[4]; });
      };
      w.append(more, text);
    });
    b.appendChild(w);
  }

  A.on('settings-end', (body) => {
    const card = X.helpCard(body);
    if (PLAY && A.has('openUrl')) {
      const rate = h('button', 'srow nav');
      const rl = h('div', 'sl');
      rl.append(h('b', '', 'Rate Flick'), h('small', '', 'Opens Flick in Google Play'));
      rate.appendChild(rl);
      rate.onclick = () => { A.haptic('soft'); A.nc('openUrl', PLAY_PAGE); };
      card.appendChild(rate);
    }
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Open-source notices'), h('small', '', 'What Flick is made with, and the licenses'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); build(); page.open(); };
    card.appendChild(row);
  });
});
