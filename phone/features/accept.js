/* A PC set to "Ask each time" for this phone: what it sends waits there until someone accepts it ({t:'asking'}). A no,
 * or no answer within a minute, comes back as 'failed' with why declined | timeout (app.js says so). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  let saidAt = 0;
  A.on('ws', (m) => {
    if (m.t !== 'asking' || !A.linkTrusted()) return;
    if (Date.now() - saidAt < 3000) return;                // a stack asks once
    saidAt = Date.now();
    A.toast('Waiting for ' + X.pcName() + ' to accept', 2600);
  });
});
