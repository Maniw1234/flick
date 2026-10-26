'use strict';
// "On another Wi-Fi?" for Share with a browser: this PC makes a Wi-Fi network of its own, and a phone or tablet on
// some other network joins it from a Wi-Fi QR code, then opens the share page from the second code.
//  - Windows: the Mobile hotspot (Settings › Network › Mobile hotspot, which also gives joined devices the internet),
//    with the name and password set there; without an internet connection to share, a Wi-Fi Direct network instead
//    (Flick names it and makes up a password; it lasts while Flick keeps it open).
//  - Linux: NetworkManager's hotspot (nmcli). The PC's own Wi-Fi connection pauses while it's on.
//  - Mac: not possible for an app (Internet Sharing is set up in System Settings by hand).
// Every step runs in a separate process (PowerShell / nmcli) with fixed arguments: nothing from the network goes in.
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // nothing that reads two ways (0/O, 1/I/l)
const pick = (n) => Array.from(crypto.randomBytes(n), (b) => ABC[b % ABC.length]).join('');

/** The text of a Wi-Fi QR code (what phone cameras join from): WIFI:T:WPA;S:<name>;P:<password>;; */
function wifiQrText(ssid, pass) {
  const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  return 'WIFI:T:WPA;S:' + esc(ssid) + ';P:' + esc(pass) + ';;';
}

// ---------------------------------------------------------------- Windows (PowerShell, WinRT)
const PS_PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  // (single quotes in PowerShell: in double quotes the backtick of IAsyncOperation`1 would be taken as an escape)
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",

  'function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '$null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]',
  '$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]',
  '$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]',
].join('\n');

// turns the Mobile hotspot on (unless it already is) and says its name and password
const PS_MOBILE_ON = PS_PRELUDE + '\n' + [
  'try {',
  '  $p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  '  if ($p -eq $null) { "error no-internet"; exit 2 }',
  '  $cap = [string][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::GetTetheringCapabilityFromConnectionProfile($p)',
  '  if ($cap -ne "Enabled") { "error " + $cap; exit 2 }',
  '  $tm = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p)',
  '  $cfg = $tm.GetCurrentAccessPointConfiguration()',
  '  $was = [string]$tm.TetheringOperationalState',
  '  if ($was -ne "On") {',
  '    $r = Await ($tm.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])',
  '    if ([string]$r.Status -ne "Success") { "error " + [string]$r.Status + " " + $r.AdditionalErrorMessage; exit 3 }',
  '  }',
  '  "ok " + $(if ($was -eq "On") { "was-on" } else { "started" })',
  '  "ssid " + $cfg.Ssid',
  '  "pass " + $cfg.Passphrase',
  '} catch { "error " + $_.Exception.Message; exit 1 }',
].join('\n');

const PS_MOBILE_OFF = PS_PRELUDE + '\n' + [
  'try {',
  '  $p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  '  if ($p -eq $null) { "ok"; exit 0 }',
  '  $tm = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p)',
  '  $r = Await ($tm.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])',
  '  "ok " + [string]$r.Status',
  '} catch { "error " + $_.Exception.Message; exit 1 }',
].join('\n');

// a Wi-Fi Direct network that ordinary devices can join, for as long as this script runs (name and password from env)
const PS_DIRECT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'try {',
  '  $null = [Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher, Windows.Devices.WiFiDirect, ContentType = WindowsRuntime]',
  '  $null = [Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]',
  '  $pub = New-Object Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher',
  '  $pub.Advertisement.IsAutonomousGroupOwnerEnabled = $true',
  '  $leg = $pub.Advertisement.LegacySettings',
  '  $leg.IsEnabled = $true',
  '  $leg.Ssid = $env:FLICK_SSID',
  '  $c = New-Object Windows.Security.Credentials.PasswordCredential',
  '  $c.Password = $env:FLICK_PASS',
  '  $leg.Passphrase = $c',
  '  $pub.Start()',
  '  $last = ""',
  '  while ($true) {',
  '    $s = [string]$pub.Status',
  '    if ($s -ne $last) { "status " + $s; $last = $s }',
  '    if ($s -eq "Aborted" -or $s -eq "Stopped") { exit 4 }',
  '    Start-Sleep -Milliseconds 500',
  '  }',
  '} catch { "error " + $_.Exception.Message; exit 1 }',
].join('\n');

// The script goes in whole as -EncodedCommand (UTF-16LE, base64): read from stdin, PowerShell would run it line by line
function powershell(script, env, onLine) {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line) onLine(line); } });
  p.stderr.on('data', () => {});
  p.on('error', () => onLine('error no-powershell'));
  return p;
}

function runPs(script, ms) {
  return new Promise((resolve) => {
    const lines = [];
    let done = false;
    const p = powershell(script, null, (l) => lines.push(l));
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (e) { /* ignore */ } resolve(lines.concat('error timeout')); } }, ms || 30000);
    p.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve(lines); } });
  });
}

// ---------------------------------------------------------------- Linux (nmcli)
function nmcli(args, ms) {
  return new Promise((resolve) => {
    execFile('nmcli', args, { timeout: ms || 20000 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') }));
  });
}

class Hotspot extends EventEmitter {
  /** opts: { log, platform (tests), run (tests: replaces the PowerShell / nmcli steps) } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.log = opts.log || (() => {});
    this.platform = opts.platform || process.platform;
    this.run = opts.run || null;
    this.state = 'off';      // off | starting | on | error
    this.kind = '';          // mobile (Windows Mobile hotspot) | direct (Wi-Fi Direct) | nm (NetworkManager)
    this.ssid = ''; this.pass = ''; this.why = '';
    this.mine = false;       // Flick turned it on (and turns it off again)
    this.proc = null;
  }

  get can() { return this.platform === 'win32' || this.platform === 'linux'; }

  view() {
    return { can: this.can, state: this.state, kind: this.kind, ssid: this.ssid, pass: this.pass, why: this.why,
      wifi: this.state === 'on' ? wifiQrText(this.ssid, this.pass) : '' };
  }

  _set(state, why) { this.state = state; this.why = why || ''; this.emit('state', this.view()); }

  async start() {
    if (!this.can || this.state === 'on' || this.state === 'starting') return this.view();
    this._set('starting');
    try {
      if (this.platform === 'win32') await this._startWindows();
      else await this._startLinux();
      this._set('on');
    } catch (e) {
      this.log('hotspot: ' + e.message);
      this.kind = ''; this.ssid = ''; this.pass = '';
      this._set('error', e.message);
    }
    return this.view();
  }

  async stop() {
    const was = this.state;
    if (was === 'off') return;
    const kind = this.kind, mine = this.mine;
    this.mine = false; this.kind = ''; this.ssid = ''; this.pass = '';
    if (this.proc) { try { this.proc.kill(); } catch (e) { /* ignore */ } this.proc = null; }
    this._set('off');
    if (!mine) return;                                       // it was on before Flick: it stays on
    try {
      if (kind === 'mobile') await (this.run ? this.run('mobile-off') : runPs(PS_MOBILE_OFF, 20000));
      else if (kind === 'nm') { await (this.run ? this.run('nm-down') : nmcli(['connection', 'down', 'Flick'])); await (this.run ? this.run('nm-delete') : nmcli(['connection', 'delete', 'Flick'])); }
    } catch (e) { this.log('hotspot stop: ' + e.message); }
  }

  async _startWindows() {
    // the Mobile hotspot first: what people know, and devices that join it keep the internet
    const lines = await (this.run ? this.run('mobile-on') : runPs(PS_MOBILE_ON, 40000));
    const ok = lines.find((l) => l.startsWith('ok '));
    if (ok) {
      const ssid = (lines.find((l) => l.startsWith('ssid ')) || '').slice(5), pass = (lines.find((l) => l.startsWith('pass ')) || '').slice(5);
      if (ssid && pass.length >= 8) {
        this.kind = 'mobile'; this.ssid = ssid; this.pass = pass; this.mine = ok === 'ok started';
        return;
      }
    }
    const err = (lines.find((l) => l.startsWith('error ')) || 'error unknown').slice(6);
    this.log('mobile hotspot: ' + err + ' (trying a Wi-Fi Direct network)');
    // without an internet connection to share (or if the Mobile hotspot can't): a Wi-Fi Direct network Flick keeps up
    await this._startDirect(err);
  }

  _startDirect(before) {
    const ssid = 'DIRECT-FL-' + pick(4), pass = pick(10);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (e) => { if (settled) return; settled = true; clearTimeout(t); if (e) reject(e); else resolve(); };
      const onLine = (l) => {
        if (l === 'status Started') { this.kind = 'direct'; this.ssid = ssid; this.pass = pass; this.mine = true; finish(); }
        else if (l.startsWith('error ') || l === 'status Aborted') finish(new Error(words(before, l.slice(l.indexOf(' ') + 1))));
      };
      const p = this.run ? this.run('direct', { ssid, pass, onLine }) : powershell(PS_DIRECT, { FLICK_SSID: ssid, FLICK_PASS: pass }, onLine);
      this.proc = p;
      if (p && p.on) p.on('close', () => { if (this.proc === p) { this.proc = null; if (this.state === 'on' && this.kind === 'direct') { this.kind = ''; this._set('error', 'The PC’s Wi-Fi network stopped'); } } finish(new Error(words(before, 'stopped'))); });
      const t = setTimeout(() => { try { if (p && p.kill) p.kill(); } catch (e) { /* ignore */ } finish(new Error(words(before, 'timeout'))); }, 25000);
    });
  }

  async _startLinux() {
    const dev = await (this.run ? this.run('nm-devices') : nmcli(['-t', '-f', 'DEVICE,TYPE,STATE', 'device']));
    if (!dev.ok) throw new Error('This needs NetworkManager (nmcli)');
    const wifi = dev.out.split('\n').map((l) => l.split(':')).find((f) => f[1] === 'wifi' && f[2] !== 'unavailable');
    if (!wifi) throw new Error('This PC has no Wi-Fi to make a network with');
    const ssid = 'Flick-' + pick(4), pass = pick(10);
    const r = await (this.run ? this.run('nm-hotspot', { dev: wifi[0], ssid, pass }) : nmcli(['device', 'wifi', 'hotspot', 'ifname', wifi[0], 'con-name', 'Flick', 'ssid', ssid, 'password', pass], 30000));
    if (!r.ok) throw new Error('Couldn’t start the PC’s Wi-Fi network: ' + (r.err.trim().split('\n').pop() || 'nmcli failed'));
    this.kind = 'nm'; this.ssid = ssid; this.pass = pass; this.mine = true;
  }
}

// why it couldn't start, in words
function words(mobile, direct) {
  const m = String(mobile || '');
  if (/no-powershell/.test(m)) return 'Windows PowerShell isn’t available';
  if (/DisabledByGroupPolicy/i.test(m)) return 'Your organization turned off the Mobile hotspot on this PC';
  if (/DisabledByHardwareLimitation|DisabledBySku/i.test(m)) return 'This PC’s Wi-Fi can’t make a network of its own';
  if (/WiFiDeviceOff|RadioRestriction/i.test(m)) return 'Turn on this PC’s Wi-Fi first';
  if (/no-internet/.test(m) && /timeout|stopped|Aborted/i.test(String(direct))) return 'This PC’s Wi-Fi can’t make a network of its own';
  return 'Couldn’t start the PC’s Wi-Fi network';
}

module.exports = { Hotspot, wifiQrText };
