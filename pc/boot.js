'use strict';
// Starts Flick. Runs the newest app code that is known to be good: this installed copy, or a newer version that
// Flick downloaded from GitHub by itself (see updater.js). A downloaded version that fails to start three times in a
// row is skipped, so a bad update can never stop Flick from starting.
const fs = require('fs');
const path = require('path');

// Chromium's debugging switches aren't among Electron's fuses (packaging/fuses.js): a packaged Flick started with
// --remote-debugging-port (or --remote-debugging-pipe) would let any program running as the user run code in Flick's
// windows, and through them ask Flick for anything its windows can. They're dropped here, before any window exists; a
// developer's run (Electron's own program, not packaged) keeps them.
if (process.versions.electron) {
  const { app } = require('electron');
  if (app && app.isPackaged) for (const s of ['remote-debugging-port', 'remote-debugging-pipe']) if (app.commandLine.hasSwitch(s)) app.commandLine.removeSwitch(s);
}

let target = __dirname;
try {
  const core = require('./updatecore');
  const root = core.updatesRoot();
  const cur = core.readCurrent(root);
  const installed = require('./package.json').version;
  const due = cur && core.newer(cur.version, installed) && cur.tries < 3 && fs.existsSync(path.join(root, cur.dir, 'main.js'));
  // What's there runs only if it's still what Flick's release key signed (see updatecore.checkUpdate). Only a test run
  // that isn't a packaged Flick (Electron's own binary, as main.js's TEST_MODE) may trust its throwaway key.
  const testRun = process.env.FLICK_TEST === '1' && (!process.versions.electron || /^electron(\.exe)?$/i.test(path.basename(process.execPath)));
  const keys = testRun && process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : undefined;
  const bad = due ? core.checkUpdate(path.join(root, cur.dir), cur.version, keys) : null;
  if (due && !bad) {
    cur.tries += 1;                                  // main.js resets this once the update has started properly
    core.writeCurrent(root, cur);
    target = path.join(root, cur.dir);
    global.FLICK_BOOT = { root, version: cur.version, dir: cur.dir, installed };
  } else {
    // (one that isn't is skipped for good, as one that fails to start is: see Updater.markHealthy)
    if (bad) { cur.tries = 99; core.writeCurrent(root, cur); }
    global.FLICK_BOOT = { root, version: installed, dir: null, installed, failed: bad ? 'not as signed (' + bad + ')' : undefined };
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
