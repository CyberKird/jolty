; Jolty installer additions: installs the Microsoft Visual C++ runtime when it is missing.
!include LogicLib.nsh

; NSIS 3.04 has no Romanian text for the "for me / for everyone" page. Defined here, before the
; language files load, they replace the English fallback (a build warning, treated as an error).
!define MULTIUSER_TEXT_INSTALLMODE_TITLE "Alegeți utilizatorii"
!define MULTIUSER_TEXT_INSTALLMODE_SUBTITLE "Alegeți pentru care utilizatori instalați $(^NameDA)."
!define MULTIUSER_INNERTEXT_INSTALLMODE_TOP "Alegeți dacă instalați $(^NameDA) doar pentru dumneavoastră sau pentru toți utilizatorii acestui calculator. $(^ClickNext)"
!define MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS "Instalează pentru toți utilizatorii acestui calculator"
!define MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER "Instalează doar pentru mine"

!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  SetRegView lastused
  ${If} $0 != 1
    ${If} ${FileExists} "$INSTDIR\resources\redist\vc_redist.x64.exe"
      DetailPrint "Se instalează Microsoft Visual C++ Runtime…"
      ; ShellExecute lets the redistributable ask for admin rights on its own (UAC)
      ExecShellWait "" "$INSTDIR\resources\redist\vc_redist.x64.exe" "/install /passive /norestart"
    ${EndIf}
  ${EndIf}
!macroend
