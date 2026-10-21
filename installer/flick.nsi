; Flick installer (NSIS 3, Unicode)
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!addplugindir /x86-unicode "${RESDIR}\plugins\x86-unicode"

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
  ; start as the normal (non-admin) user so drag-and-drop from Explorer works
  StdUtils::ExecShellAsUser /NOUNLOAD "$INSTDIR\Flick.exe" "open" ""
  Pop $0
  ${If} $0 != "ok"
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\Flick.exe"'
  ${EndIf}
FunctionEnd

Section "Install"
  nsProcess::_KillProcess "Flick.exe"
  Pop $0
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources\app"
  File /r "Flick\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Flick.exe"

  SetShellVarContext all
  CreateShortCut "$SMPROGRAMS\Flick.lnk" "$INSTDIR\Flick.exe" "" "$INSTDIR\Flick.ico" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\Flick.lnk" "com.flick.pc"
  CreateShortCut "$DESKTOP\Flick.lnk" "$INSTDIR\Flick.exe" "" "$INSTDIR\Flick.ico" 0
  WinShell::SetLnkAUMI "$DESKTOP\Flick.lnk" "com.flick.pc"

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
  nsProcess::_KillProcess "Flick.exe"
  Pop $0
  Sleep 800
  SetShellVarContext all
  WinShell::UninstAppUserModelId "com.flick.pc"
  Delete "$SMPROGRAMS\Flick.lnk"
  Delete "$DESKTOP\Flick.lnk"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Flick"'
  Pop $0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flick"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Flick"
  RMDir /r "$INSTDIR"
SectionEnd
