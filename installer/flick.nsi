; Flick installer (NSIS 3, Unicode)
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "Flick"
OutFile "Flick-Setup.exe"
InstallDir "$PROGRAMFILES64\Flick"
RequestExecutionLevel admin
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
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Function LaunchFlick
  ; started through Explorer, Flick runs as the normal (non-admin) user, so drag-and-drop from Explorer works
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\Flick.exe"'
FunctionEnd

Section "Install"
  nsExec::Exec 'taskkill /F /IM Flick.exe'
  Pop $0
  Sleep 800
  SetOutPath "$INSTDIR"
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
  ; for the user installing: per-user keys, no admin rights needed for them. Windows 11 shows it under "Show more
  ; options": its first menu, like its Share sheet, only lists apps with package identity, which takes a signing
  ; certificate the PC trusts. Up to 15 items at once (Windows' default for such a verb; Send to takes any number).
  WriteRegStr HKCU "Software\Classes\*\shell\Flick" "MUIVerb" "Send with Flick"
  WriteRegStr HKCU "Software\Classes\*\shell\Flick" "Icon" "$INSTDIR\Flick.ico"
  WriteRegStr HKCU "Software\Classes\*\shell\Flick\command" "" '"$INSTDIR\Flick.exe" --send "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flick" "MUIVerb" "Send with Flick"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flick" "Icon" "$INSTDIR\Flick.ico"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Flick\command" "" '"$INSTDIR\Flick.exe" --send "%1"'

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
  Delete "$APPDATA\Microsoft\Windows\SendTo\Flick (phone).lnk"
  SetShellVarContext all
  Delete "$SMPROGRAMS\Flick.lnk"
  Delete "$DESKTOP\Flick.lnk"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Flick"'
  Pop $0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flick"
  DeleteRegKey HKCU "Software\Classes\*\shell\Flick"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Flick"
  ; the app id Flick registers for its notifications (pc/main.js registerAppId)
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.flick.pc"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick"
  RMDir /r "$INSTDIR"
SectionEnd
