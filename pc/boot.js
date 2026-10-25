'use strict';
// Starts Flick. Runs the newest app code that is known to be good: this installed copy, or a newer version that
// Flick downloaded from GitHub by itself (see updater.js). A downloaded version that fails to start three times in a
// row is skipped, so a bad update can never stop Flick from starting.
const fs = require('fs');
const path = require('path');

let target = __dirname;
try {
  const core = require('./updatecore');
  const root = core.updatesRoot();
  const cur = core.readCurrent(root);
  const installed = require('./package.json').version;
  if (cur && core.newer(cur.version, installed) && cur.tries < 3 && fs.existsSync(path.join(root, cur.dir, 'main.js'))) {
    cur.tries += 1;                                  // main.js resets this once the update has started properly
    core.writeCurrent(root, cur);
    target = path.join(root, cur.dir);
    global.FLICK_BOOT = { root, version: cur.version, dir: cur.dir, installed };
  } else {
    global.FLICK_BOOT = { root, version: installed, dir: null, installed };
  }
} catch (e) {
  global.FLICK_BOOT = null;
}

try {
  require(path.join(target, 'main.js'));
} catch (e) {
  if (target === __dirname) throw e;
  // the downloaded version is broken: use the installed one now, and stop trying that update
  try {
    const core = require('./updatecore');
    const cur = core.readCurrent(global.FLICK_BOOT.root);
    if (cur) { cur.tries = 99; core.writeCurrent(global.FLICK_BOOT.root, cur); }
  } catch (x) { /* ignore */ }
  global.FLICK_BOOT = Object.assign({}, global.FLICK_BOOT, { dir: null, version: global.FLICK_BOOT && global.FLICK_BOOT.installed, failed: String(e && e.message) });
  require('./main.js');
}
