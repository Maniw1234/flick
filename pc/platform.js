'use strict';
// What the PC app does differently on macOS and Linux (main.js keeps Windows' own code where it always was).
//
//   macOS  received files get the quarantine mark, like a download in Safari; the PC's default name is the Mac's own;
//          "Phone can't connect?" opens Local Network privacy, which Flick can't work without.
//   Linux  Flick's menu entries: the applications menu, file managers' Open With (the files go to the phone, like
//          Windows' Send to) and start at login; a restart keeps the launcher's switches; the PC's default name comes
//          from the account's full name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

// ------------------------------------------------------------ macOS
/**
 * Marks a received file (with all: a folder and everything in it) the way Safari marks a download, so Gatekeeper
 * checks an app, script or installer that came from another device before it first opens.
 */
function quarantine(file, all) {
  if (!IS_MAC) return;
  // flags;time (hex);agent;event id. 0083 is what browsers put on a download
  const value = '0083;' + Math.floor(Date.now() / 1000).toString(16) + ';Flick;';
  execFile('/usr/bin/xattr', ['-w'].concat(all ? ['-r'] : [], ['com.apple.quarantine', value, file]), { timeout: 60000 }, () => {});
}

/** The name the user gave this Mac ("Mani's MacBook Air", as AirDrop shows it), or '' */
function macName() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

// ------------------------------------------------------------ Linux
/** The account's full name ("Mani Weinstein": the GECOS field up to its first comma), or '' */
function fullName(user) {
  return new Promise((resolve) => {
    execFile('getent', ['passwd', String(user)], { timeout: 4000 }, (err, out) => {
      const f = err ? [] : String(out || '').split('\n')[0].split(':');
      resolve(f.length >= 7 ? f[4].split(',')[0].trim() : '');
    });
  });
}

const dataHome = () => { const x = process.env.XDG_DATA_HOME; return x && path.isAbsolute(x) ? x : path.join(os.homedir(), '.local', 'share'); };
const configHome = () => { const x = process.env.XDG_CONFIG_HOME; return x && path.isAbsolute(x) ? x : path.join(os.homedir(), '.config'); };

/**
 * What starts this copy of Flick, as [program, ...arguments]: the AppImage file itself (what it unpacks is only there
 * while it runs), the launcher next to the program in the tar.gz (it picks the switches this system needs), or the
 * program. appDir: the app folder of a copy run from source (electron <folder>).
 */
function startCommand(appDir) {
  const ai = process.env.APPIMAGE;
  if (ai && path.isAbsolute(ai)) return [ai];
  const sh = path.join(path.dirname(process.execPath), 'flick');
  if (sh !== process.execPath && isFile(sh)) return [sh];
  return appDir ? [process.execPath, appDir] : [process.execPath];
}

/**
 * One argument of a desktop entry's Exec line, as the freedesktop spec reads it: quoted when needed, with " ` $ \
 * escaped inside the quotes, then backslashes doubled (the value itself is an escaped string) and % doubled.
 */
function execArg(a) {
  let s = String(a);
  if (!/^[\w@%+=:,./-]+$/.test(s)) s = '"' + s.replace(/["`$\\]/g, '\\$&') + '"';
  return s.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

// writes a small file only when its contents change (then calls changed)
function writeIfChanged(file, text, log, changed) {
  try {
    let old = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* not there yet */ }
    if (old === text) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    if (changed) changed();
  } catch (e) { log(path.basename(path.dirname(file)) + '/' + path.basename(file) + ': ' + e.message); }
}

/**
 * Linux: Flick's own entries. applications/flick.desktop puts Flick in the applications menu and, with openWith, in
 * file managers' Open With for any file (Flick sends what it is given to the phone); autostart/flick.desktop starts it,
 * hidden, when the user logs in. Files are rewritten only when they change.
 * o: { cmd: startCommand(...), icon: a PNG, openWith, startup, log }
 */
function linuxEntries(o) {
  if (!IS_LINUX) return;
  const log = o.log || (() => {});
  const exec = o.cmd.map(execArg).join(' ');
  // the icon is copied where it stays (an AppImage's own files are gone once it closes)
  const icon = path.join(dataHome(), 'icons', 'hicolor', '512x512', 'apps', 'flick.png');
  try {
    const png = fs.readFileSync(o.icon);
    let same = false;
    try { same = fs.readFileSync(icon).equals(png); } catch (e) { /* not there yet */ }
    if (!same) { fs.mkdirSync(path.dirname(icon), { recursive: true }); fs.writeFileSync(icon, png); }
  } catch (e) { log('menu icon: ' + e.message); }
  const entry = (lines) => ['[Desktop Entry]', 'Type=Application', 'Name=Flick', 'Icon=' + icon, 'Terminal=false'].concat(lines).join('\n') + '\n';
  const apps = path.join(dataHome(), 'applications');
  writeIfChanged(path.join(apps, 'flick.desktop'), entry([
    'GenericName=File transfer',
    'Comment=Send files between your Android phone and this computer',
    'Exec=' + exec + (o.openWith ? ' --send %F' : ''),
    'Categories=Network;FileTransfer;',
    'StartupWMClass=Flick',
  ].concat(o.openWith ? ['MimeType=application/octet-stream;'] : [])), log, () => {
    // file managers find Open With entries through this folder's cache, where it has one
    execFile('update-desktop-database', [apps], { timeout: 20000 }, () => {});
  });
  const auto = path.join(configHome(), 'autostart', 'flick.desktop');
  if (o.startup) writeIfChanged(auto, entry(['Exec=' + exec + ' --hidden', 'X-GNOME-Autostart-enabled=true']), log);
  else fs.rm(auto, { force: true }, () => {});
}

/**
 * What app.relaunch needs to start this copy again with args. On Linux the switches the launcher chose are passed on
 * (no sandbox where the system can't give Chromium one, X11 under Wayland), and an AppImage starts again from its own
 * file. Elsewhere: just the arguments.
 */
function relaunch(args) {
  if (!IS_LINUX) return { args };
  const o = { args: process.argv.slice(1).filter((a) => a === '--no-sandbox' || a === '--ozone-platform=x11').concat(args) };
  const ai = process.env.APPIMAGE;
  if (ai && path.isAbsolute(ai)) o.execPath = ai;
  return o;
}

// ------------------------------------------------------------ "Phone can't connect?"
/** What to say (and the settings page to open) when the phone can't reach this computer: { text, url? } */
function connectHelp(ports) {
  if (IS_MAC) {
    return {
      text: 'Flick needs Local Network access to reach your phone: in System Settings > Privacy & Security > Local Network, ' +
        'turn on Flick. If the firewall is on (System Settings > Network > Firewall), let Flick accept incoming connections.',
      url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
    };
  }
  return {
    text: 'If a firewall is on, it has to let the phone in: TCP port ' + ports.tcp + ' and UDP port ' + ports.udp +
      '. With ufw: sudo ufw allow ' + ports.tcp + '/tcp && sudo ufw allow ' + ports.udp + '/udp',
  };
}

module.exports = { IS_MAC, IS_LINUX, quarantine, macName, fullName, startCommand, execArg, linuxEntries, relaunch, connectHelp };
