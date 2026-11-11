; Flick installer (NSIS 3, Unicode)
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

Name "Flick"
OutFile "Flick-Setup.exe"
InstallDir "$PROGRAMFILES64\Flick"
RequestExecutionLevel admin
; the topmost folder made for Flick outside Program Files (see CheckFolder): it and everything in it get locked
Var LockRoot
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ManifestDPIAware true
BrandingText "Flick ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Flick"
VIAddVersionKey "FileDescription" "Flick Setup"
VIAddVersionKey "CompanyName" "Flick"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Flick"

!define MUI_ICON "Flick\Flick.ico"
!define MUI_UNICON "Flick\Flick.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install Flick"
!define MUI_WELCOMEPAGE_TEXT "Flick lets you throw files from your Android phone onto this PC's screen, and drag PC files back to the phone.$\r$\n$\r$\nClick Next, then Install."
!define MUI_FINISHPAGE_TITLE "Flick is ready"
!define MUI_FINISHPAGE_TEXT "Open Flick on your phone, hold it next to this screen, and press and hold Connect."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Flick now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchFlick

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Flick needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
  ; a folder given with /D= (winget's --location) gets a Flick folder of its own inside it: uninstalling removes
  ; Flick's folder with everything in it, which must never be a folder that holds anything else
  StrCpy $0 $INSTDIR "" -1
  ${If} $0 == "\"
    StrCpy $INSTDIR $INSTDIR -1
  ${EndIf}
  StrCpy $0 $INSTDIR "" -6
  ${If} $0 != "\Flick"
    StrCpy $INSTDIR "$INSTDIR\Flick"
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Function LaunchFlick
  ; started through Explorer, Flick runs as the normal (non-admin) user, so drag-and-drop from Explorer works
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\Flick.exe"'
FunctionEnd

; A folder given with /D= outside Program Files is used only if no one but the administrators can change it, nor any
; folder it is in: whoever could rename or replace one of them (on a drive's root C:\ gives Authenticated Users "Modify"
; in new folders) could put their own Flick.exe, which every user runs, or uninstaller, which an administrator runs, where
; the installer registered them. So, before anything is written: the folders on the way that exist already (below the
; drive's root) must be ones only administrators can change (folder-check.ps1, with Windows PowerShell); those that
; don't are made now and locked with Flick's own (LockFolder). Never Flick's own data folder, nor a folder that holds
; something other than an earlier Flick.
Function CheckFolder
  StrCpy $LockRoot ""
  StrLen $1 "$PROGRAMFILES64\"
  StrCpy $0 "$INSTDIR\" $1
  StrCmp $0 "$PROGRAMFILES64\" fine
  StrLen $1 "$PROGRAMFILES\"
  StrCpy $0 "$INSTDIR\" $1
  StrCmp $0 "$PROGRAMFILES\" fine
  ; (where Flick keeps the updates it downloads and the files it couldn't save: the user's, never Flick's program)
  StrCmp $INSTDIR "$LOCALAPPDATA\Flick" own
  StrCmp $INSTDIR "$APPDATA\Flick" own
  StrCpy $0 $INSTDIR 2
  StrCmp $0 "\\" network
  IfFileExists "$INSTDIR\Flick.exe" walk
  ${DirState} "$INSTDIR" $0
  StrCmp $0 1 other
  walk:
  StrCpy $LockRoot $INSTDIR
  StrCpy $1 ""
  IfFileExists "$INSTDIR\*.*" 0 +2
    StrCpy $1 $INSTDIR
  StrCpy $2 $INSTDIR
  up:
  ${GetParent} $2 $2
  StrLen $3 $2
  IntCmp $3 2 checked checked
  IfFileExists "$2\*.*" there
    StrCpy $LockRoot $2
    Goto up
  there:
  StrCmp $1 "" 0 +3
    StrCpy $1 $2
    Goto up
  StrCpy $1 "$1|$2"
  Goto up
  checked:
  StrCmp $1 "" fine
  InitPluginsDir
  File "/oname=$PLUGINSDIR\folder-check.ps1" "folder-check.ps1"
  System::Call 'Kernel32::SetEnvironmentVariable(t "FLICK_FOLDERS", t "$1") i'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\folder-check.ps1"'
  Pop $0
  Pop $3
  StrCmp $0 0 fine
  MessageBox MB_ICONSTOP "Flick can't be installed in $INSTDIR: someone other than an administrator could change it, or a folder it is in, and so replace Flick there.$\r$\n$\r$\n$3$\r$\nIf an earlier Flick is installed there, uninstall it first; otherwise choose a new folder, or the default one in Program Files." /SD IDOK
  Abort "Flick wasn't installed: $3"
  own:
  MessageBox MB_ICONSTOP "$INSTDIR is where Flick keeps your updates and files: choose another folder for Flick itself." /SD IDOK
  Abort "Flick wasn't installed: $INSTDIR is Flick's data folder."
  network:
  MessageBox MB_ICONSTOP "Flick can't be installed in a network folder: choose a folder on this PC." /SD IDOK
  Abort "Flick wasn't installed: $INSTDIR is a network folder."
  other:
  MessageBox MB_ICONSTOP "$INSTDIR already holds other files: Flick installs only into a new folder or an earlier Flick's. Choose another folder." /SD IDOK
  Abort "Flick wasn't installed: $INSTDIR holds other files."
  fine:
FunctionEnd

; The folders made for Flick (from $LockRoot down) get Program Files' permissions: owned by the administrators, changed
; only by them and the system, read and run by the rest (users, and apps that run in a sandbox). Done before any file is
; written, so each one is born with them.
Function LockFolder
  StrCmp $LockRoot "" locked
  ; (an earlier copy, or anything someone put there first: its owner could otherwise give itself the rights back)
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$LockRoot" /setowner *S-1-5-32-544 /T /C /Q'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$LockRoot" /reset /T /C /Q'
  Pop $0
  ; SYSTEM, Administrators: full; Users, ALL APPLICATION PACKAGES, ALL RESTRICTED APPLICATION PACKAGES: read and run
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$LockRoot" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *S-1-15-2-1:(OI)(CI)RX *S-1-15-2-2:(OI)(CI)RX /Q'
  Pop $0
  StrCmp $0 0 locked
  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "Windows couldn't keep other users of this PC from changing $LockRoot (icacls: $0): any of them could change Flick there.$\r$\n$\r$\nInstall Flick there anyway?" /SD IDCANCEL IDOK locked
  Abort "Flick wasn't installed: pick a folder Windows can protect, or the default one in Program Files."
  locked:
FunctionEnd

Section "Install"
  nsExec::Exec 'taskkill /F /IM Flick.exe'
  Pop $0
  Sleep 800
  Call CheckFolder
  SetOutPath "$INSTDIR"
  Call LockFolder
  RMDir /r "$INSTDIR\resources\app"
  ; what this installer brings is what runs: updates an earlier copy downloaded are dropped (Flick fetches newer ones
  ; itself), so installing a release by hand always takes effect
  RMDir /r "$LOCALAPPDATA\Flick\app"
  File /r "Flick\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Flick.exe"

  SetShellVarContext all
  CreateShortCut "$SMPROGRAMS\Flick.lnk" "$INSTDIR\Flick.exe" "" "$INSTDIR\Flick.ico" 0
  CreateShortCut "$DESKTOP\Flick.lnk" "$INSTDIR\Flick.exe" "" "$INSTDIR\Flick.ico" 0

  ; "Send with Flick" in File Explorer's right-click menu, for files and folders (next to Send to > Flick (phone)),
  ; for every user of this PC, as Flick itself is (the user installing may be another account, an administrator's).
  ; Windows 11 shows it under "Show more options": its first menu, like its Share sheet, only lists apps with package
  ; identity, which takes a signing certificate the PC trusts. Up to 15 items at once (Windows' default for such a
  ; verb; Send to takes any number).
  WriteRegStr HKLM "Software\Classes\*\shell\Flick" "MUIVerb" "Send with Flick"
  WriteRegStr HKLM "Software\Classes\*\shell\Flick" "Icon" "$INSTDIR\Flick.ico"
  WriteRegStr HKLM "Software\Classes\*\shell\Flick\command" "" '"$INSTDIR\Flick.exe" --send "%1"'
  WriteRegStr HKLM "Software\Classes\Directory\shell\Flick" "MUIVerb" "Send with Flick"
  WriteRegStr HKLM "Software\Classes\Directory\shell\Flick" "Icon" "$INSTDIR\Flick.ico"
  WriteRegStr HKLM "Software\Classes\Directory\shell\Flick\command" "" '"$INSTDIR\Flick.exe" --send "%1"'
  ; installers before 2.1 wrote them for the user installing only: those would win over these, so they go
  DeleteRegKey HKCU "Software\Classes\*\shell\Flick"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Flick"

  ; allow the phone to reach Flick on this PC (private and public Wi-Fi)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Flick"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Flick" dir=in action=allow program="$INSTDIR\Flick.exe" enable=yes profile=any'
  Pop $0

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "DisplayName" "Flick"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "DisplayIcon" "$INSTDIR\Flick.ico"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "Publisher" "Flick"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "UninstallString" '"$INSTDIR\Uninstall Flick.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "NoRepair" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick" "EstimatedSize" 260000
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM Flick.exe'
  Pop $0
  Sleep 800
  ; updates Flick downloaded by itself (per user, see updater.js)
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\Flick\app"
  RMDir "$LOCALAPPDATA\Flick"
  Delete "$APPDATA\Microsoft\Windows\SendTo\Flick (phone).lnk"
  SetShellVarContext all
  Delete "$SMPROGRAMS\Flick.lnk"
  Delete "$DESKTOP\Flick.lnk"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Flick"'
  Pop $0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flick"
  DeleteRegKey HKLM "Software\Classes\*\shell\Flick"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\Flick"
  DeleteRegKey HKCU "Software\Classes\*\shell\Flick"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Flick"
  ; the app id Flick registers for its notifications (pc/main.js registerAppId)
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.flick.pc"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick"
  ; only a folder of Flick's own goes with everything in it (see .onInit); anywhere else (a copy put there by hand, or
  ; by an installer from before 2.1) only what is surely Flick's, and the folder itself if that leaves it empty
  StrCpy $0 $INSTDIR "" -6
  ${If} $0 == "\Flick"
    RMDir /r "$INSTDIR"
  ${Else}
    Delete "$INSTDIR\Flick.exe"
    Delete "$INSTDIR\Flick.ico"
    RMDir /r "$INSTDIR\resources\app"
    Delete "$INSTDIR\Uninstall Flick.exe"
    RMDir "$INSTDIR"
  ${EndIf}
SectionEnd
