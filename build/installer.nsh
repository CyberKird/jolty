; Jolty installer additions: installs the Microsoft Visual C++ runtime when it is missing.
!include LogicLib.nsh

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
