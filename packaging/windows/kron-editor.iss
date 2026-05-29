; Inno Setup script for the KronEditor Windows installer.
; Build (on Windows, after running packaging/build-windows.sh):
;   iscc packaging\windows\kron-editor.iss
; Output: packaging\dist\windows\KronEditor-Setup.exe
;
; The payload (kron-host-agent.exe + resources\ + toolchains\) is installed as
; siblings, so the agent resolves them with no flags. Launching the app opens a
; console window (terminal-only UX) that prints the access URL; the user then
; opens http://localhost:7171 in a browser.

#define AppName "KronEditor"
#define AppVersion "0.2.0"
#define AppExe "kron-host-agent.exe"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Krontek
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\windows
OutputBaseFilename={#AppName}-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; toolchains/ is multi-GB — give the installer plenty of headroom.
DiskSpanning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Recurse the whole payload produced by build-windows.sh.
Source: "..\dist\windows\KronEditor\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent
