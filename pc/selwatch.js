'use strict';
// Which files are selected in the file manager in front, for Air grab on the PC (pc/air.js): selecting files is what
// turns the PC's camera on for a few seconds, and what a fist in front of the screen picks up. It runs only while a
// phone is ready to catch (Flick open on it with Air grab on), and a minute after (pc/air.js: a phone back from a look
// at another app finds it running; nothing it sees meanwhile turns the camera on).
//   Windows  File Explorer's window in front (the tab in front, on Windows 11) or the desktop: a PowerShell loop asks
//            the shell for its selected items
//   macOS    Finder in front: an osascript loop asks Finder for its selection (macOS asks once to let Flick do that)
//   Linux    file managers don't say what's selected: copied files (Ctrl+C) count as the selection (clipfiles.js)
// Each change is emitted as 'change' { kind: 'folder' | 'desktop' | 'copied' | 'denied' | 'other', paths, first }:
// first, the first report after the watching (re)started, says what was already selected then, not a selection just
// made. At most 100 files (all the PC picks up at once).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { clipFiles } = require('./clipfiles');

const MAX = 100;

// (one statement a line: PowerShell needs them apart)
const PS = String.raw`$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Namespace FlickSel -Name W -MemberDefinition '
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
public static IntPtr FirstChild(IntPtr parent, string cls) { return FindWindowEx(parent, IntPtr.Zero, cls, null); }
[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IServices { [PreserveSig] int QueryService(ref Guid service, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object obj); }
[ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBrowser { [PreserveSig] int GetWindow(out IntPtr hwnd); }
public static long TabOf(object w) {
  try {
    Guid sid = new Guid("000214E2-0000-0000-C000-000000000046"), iid = sid;
    object o;
    if (((IServices)w).QueryService(ref sid, ref iid, out o) != 0 || o == null) return 0;
    IntPtr h;
    return ((IBrowser)o).GetWindow(out h) == 0 ? h.ToInt64() : 0;
  } catch { return 0; }
}
'
$sh = New-Object -ComObject Shell.Application
# Flick (FLICK_PID) gone without stopping this, as after a crash: this stops too
$parent = $null
if ($env:FLICK_PID) { try { $parent = [System.Diagnostics.Process]::GetProcessById([int]$env:FLICK_PID) } catch {} }
$last = $null
while ($true) {
  if ($parent -and $parent.HasExited) { exit }
  $fg = [FlickSel.W]::GetForegroundWindow()
  $cb = New-Object System.Text.StringBuilder 256
  [void][FlickSel.W]::GetClassName($fg, $cb, 256)
  $cls = $cb.ToString()
  $paths = New-Object System.Collections.Generic.List[string]
  $kind = "other"
  if ($cls -eq "CabinetWClass" -or $cls -eq "ExploreWClass") {
    $kind = "folder"
    $tb = New-Object System.Text.StringBuilder 512
    [void][FlickSel.W]::GetWindowText($fg, $tb, 512)
    $title = $tb.ToString()
    $wins = @()
    foreach ($w in $sh.Windows()) {
      try { if ([int64]$w.HWND -eq $fg.ToInt64()) { $wins += $w } } catch {}
    }
    # Windows 11 lists every tab of the window. The one in front: its tab window comes first among the window's tabs
    # (each tab's shell browser names its own); else the one tab whose name, or folder, the window's title starts with.
    # Never a guess: no files rather than another tab's.
    if ($wins.Count -gt 1) {
      $front = @()
      $tab = [FlickSel.W]::FirstChild($fg, "ShellTabWindowClass")
      if ($tab -ne [IntPtr]::Zero) { $front = @($wins | Where-Object { [FlickSel.W]::TabOf($_) -eq $tab.ToInt64() }) }
      if ($front.Count -ne 1) {
        $front = @($wins | Where-Object {
          $n = $_.LocationName
          $f = $null
          try { $f = $_.Document.Folder.Self.Path } catch {}
          ($n -and ($title -eq $n -or $title.StartsWith($n + " - "))) -or ($f -and ($title -eq $f -or $title.StartsWith($f + " - ")))
        })
      }
      if ($front.Count -eq 1) { $wins = $front } else { $wins = @() }
    }
    foreach ($w in $wins) {
      try { foreach ($i in $w.Document.SelectedItems()) { $paths.Add($i.Path); if ($paths.Count -ge 100) { break } } } catch {}
      if ($paths.Count) { break }
    }
  } elseif ($cls -eq "Progman" -or $cls -eq "WorkerW") {
    $kind = "desktop"
    try {
      $d = $sh.Windows().FindWindowSW(0, $null, 8, [ref]0, 1)
      foreach ($i in $d.Document.SelectedItems()) { $paths.Add($i.Path); if ($paths.Count -ge 100) { break } }
    } catch {}
  }
  $now = $kind + "|" + ($paths -join "|")
  if ($now -ne $last) {
    $last = $now
    [Console]::Out.WriteLine("@ " + $kind)
    foreach ($p in $paths) { [Console]::Out.WriteLine($p) }
    [Console]::Out.WriteLine(".")
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 400
}
`;

// (Finder itself says whether it is in front: an app's own idea of the app in front isn't kept up to date in a loop
// like this one. The first question to Finder is when macOS asks the user, once; refused, it says 'denied' once. An
// empty line every few seconds: with Flick gone, as after a crash, writing it ends this.)
const JXA = [
  'ObjC.import("Foundation");var out=$.NSFileHandle.fileHandleWithStandardOutput;',
  'function emit(s){out.writeData($(s+"\\n").dataUsingEncoding($.NSUTF8StringEncoding));}',
  'var finder=Application("Finder"),last=null,beat=0;',
  'while(true){var kind="other",paths=[];',
  'try{if(finder.frontmost()){kind="folder";var sel=finder.selection();',
  'for(var i=0;i<sel.length&&i<100;i++){try{var u=String(sel[i].url()||"");if(u.indexOf("file://")===0)paths.push(decodeURIComponent(u.slice(7)).replace(/\\/$/,""));}catch(e){}}}',
  '}catch(e){if(e&&e.errorNumber===-1743)kind="denied";}',
  'var now=kind+"|"+paths.join("|");if(now!==last){last=now;emit("@ "+kind);for(var j=0;j<paths.length;j++)emit(paths[j]);emit(".");}',
  'if(++beat%12===0)emit("");delay(0.4);}',
].join('');

class SelWatch extends EventEmitter {
  /** o: { log, platform } */
  constructor(o) {
    super();
    this.o = o || {};
    this.p = null;
    this.timer = null;
    this.active = false;
    this.cur = { kind: 'other', paths: [] };
    this.restarts = 0;
    this.fresh = true;           // the next report is the first since the watching (re)started
  }

  get running() { return this.active; }

  start() {
    if (this.active) return;
    this.active = true;
    this.restarts = 0;
    this.fresh = true;
    const plat = this.o.platform || process.platform;
    if (plat === 'linux') this._poll();
    else this._spawn(plat);
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.p) { try { this.p.kill(); } catch (e) { /* ignore */ } this.p = null; }
    this._set('other', []);
  }

  // report: from the watching itself (not the reset when it stops)
  _set(kind, paths, report) {
    const list = paths.filter((p) => p && path.isAbsolute(p)).slice(0, MAX);
    const first = !!report && this.fresh;
    if (report) this.fresh = false;
    const was = this.cur;
    if (was.kind === kind && was.paths.length === list.length && was.paths.every((p, i) => p === list[i])) return;
    if (kind === 'denied') this._log('macOS doesn\'t let Flick ask Finder (System Settings › Privacy & Security › Automation)');
    this.cur = { kind, paths: list };
    this.emit('change', { kind, paths: list, first });
  }

  _spawn(plat) {
    let cmd, args;
    if (plat === 'win32') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      cmd = fs.existsSync(ps) ? ps : 'powershell.exe';
      // the script as -EncodedCommand (UTF-16LE, base64): no quoting rules to get wrong on the way
      args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')];
    } else if (plat === 'darwin') {
      cmd = '/usr/bin/osascript';
      args = ['-l', 'JavaScript', '-e', JXA];
    } else return;
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { FLICK_PID: String(process.pid) }) });
    } catch (e) { this._log('could not start: ' + e.message); return; }
    this.p = p;
    let buf = '', kind = null, paths = [];
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\uFEFF/, '').replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('@ ')) { kind = line.slice(2).trim(); paths = []; }
        else if (line === '.') { if (kind) this._set(kind, paths, true); kind = null; }
        else if (kind && line) paths.push(line);
      }
    });
    p.stderr.on('data', () => {});
    p.on('error', (e) => this._log('error: ' + e.message));
    p.on('exit', (code) => {
      if (this.p !== p) return;
      this.p = null;
      this._set('other', []);
      this.fresh = true;
      // it shouldn't stop while wanted: started again a few times, a bit later each time
      if (this.active && this.restarts < 3) { this.restarts++; this.timer = setTimeout(() => { if (this.active) this._spawn(plat); }, 2000 * this.restarts); }
      else if (this.active) this._log('stopped (' + code + '): selecting files won\'t turn the camera on');
    });
  }

  // Linux: what's copied stands for what's selected
  _poll() {
    clearTimeout(this.timer);
    if (!this.active) return;
    clipFiles().then((list) => {
      if (!this.active) return;
      this._set(list.length ? 'copied' : 'other', list, true);
      this.timer = setTimeout(() => this._poll(), 1000);
    }, () => { if (this.active) this.timer = setTimeout(() => this._poll(), 2000); });
  }

  _log(s) { if (this.o.log) this.o.log('selection: ' + s); }
}

module.exports = { SelWatch, PS, JXA };
