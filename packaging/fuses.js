'use strict';
// Turns off three Electron features ("fuses") Flick never uses, each of which would let any program running as the user
// run its own code as Flick, under Flick's name (its firewall rule on Windows, the camera, Finder and Accessibility
// permissions given to Flick on a Mac):
//   RunAsNode                              ELECTRON_RUN_AS_NODE=1 <Flick's program> script.js runs script.js as Node
//   EnableNodeOptionsEnvironmentVariable   NODE_OPTIONS=--require ... loads code into Flick at its start
//   EnableNodeCliInspectArguments          <Flick's program> --inspect=<port> opens a debugger that runs any code sent
// Electron keeps its fuses in a "fuse wire" inside its program (Flick.exe, flick-bin; on a Mac the Electron Framework,
// which then has to be signed again): a fixed marker, the wire's format (1), the number of fuses, then one byte per fuse,
// '0' off, '1' on, 'r' removed, in Electron's own order, which only ever grows at the end. This sets those three bytes in
// place and reads them back from the file; anything unexpected (no wire, another format, a fuse missing) stops the build.
//   node packaging/fuses.js <Electron program>
const fs = require('fs');
const path = require('path');

const MARKER = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// their places on the wire (Electron's FuseV1Options)
const OFF = { RunAsNode: 0, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3 };

const file = process.argv[2];
if (!file || process.argv.length > 3) { console.error('usage: node packaging/fuses.js <Electron program>'); process.exit(2); }
function fail(msg) { console.error('fuses: ' + file + ': ' + msg); process.exit(1); }

// every wire in the file (a universal Mac program has one per architecture), checked to be one
function wires(buf) {
  const out = [];
  for (let at = buf.indexOf(MARKER); at >= 0; at = buf.indexOf(MARKER, at + 1)) {
    const w = at + MARKER.length;
    if (buf[w] !== 1) fail(`its fuse wire is format ${buf[w]}; this knows format 1`);
    const n = buf[w + 1];
    if (w + 2 + n > buf.length || !/^[01r]+$/.test(buf.toString('latin1', w + 2, w + 2 + n))) fail("what follows the fuse marker isn't a fuse wire");
    out.push({ at: w + 2, n });
  }
  if (!out.length) fail('no fuse wire in it (is it Electron 12 or newer?)');
  return out;
}

let buf;
try { buf = fs.readFileSync(file); } catch (e) { fail("can't read it (" + e.code + ')'); }
const fd = fs.openSync(file, 'r+');
try {
  for (const w of wires(buf)) {
    for (const [name, i] of Object.entries(OFF)) {
      if (i >= w.n) fail('its fuse wire has no ' + name);
      if (buf[w.at + i] === 0x72) fail(name + ' is removed from this Electron: check what replaces it');      // 'r'
      if (buf[w.at + i] !== 0x30) fs.writeSync(fd, Buffer.from('0'), 0, 1, w.at + i);
    }
  }
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
buf = null;
const now = fs.readFileSync(file);
const got = wires(now);
for (const w of got) for (const [name, i] of Object.entries(OFF)) if (now[w.at + i] !== 0x30) fail(name + ' is still on');
console.log(`${path.basename(file)}: ${Object.keys(OFF).join(', ')} off (fuse wire: ${got.map((w) => now.toString('latin1', w.at, w.at + w.n)).join(', ')})`);
