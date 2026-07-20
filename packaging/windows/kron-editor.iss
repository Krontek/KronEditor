; ── KronEditor — Windows installer (Inno Setup) ──────────────────────────────
;
; Builds KronEditor-<ver>-Setup.exe from the payload produced by
; packaging/build-windows.sh (packaging\dist\windows\KronEditor\).
;
; Build it:
;   1) On Linux:  ./packaging/build-windows.sh      (creates the payload + version.iss)
;   2) On Windows (or Linux+Wine) with Inno Setup 6 installed:
;         iscc packaging\windows\kron-editor.iss
;      → packaging\dist\windows\KronEditor-<ver>-Setup.exe
;
; The payload is multi-GB (bundled LLVM toolchains), so compiling the installer
; takes a while and needs disk headroom. See Compression note below.

; AppVersion is single-sourced from package.json — build-windows.sh writes this.
#include "version.iss"

#define AppName        "KronEditor"
#define AppPublisher   "Fehim Kus"
#define AppExeName     "kron-host-agent.exe"
#define AppUrl         "http://localhost:7171"
#define PayloadDir     "..\dist\windows\KronEditor"

[Setup]
; A STABLE AppId — never change it, or upgrades install side-by-side instead of
; replacing the previous version.
AppId={{167BC2A7-CEA2-4165-BB07-59DBB1A235DF}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
OutputDir=..\dist\windows
OutputBaseFilename=KronEditor-{#AppVersion}-Setup
WizardStyle=modern
; x64 only — the bundled clang.exe and the agent are 64-bit.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; The ~2 GB payload is mostly already-compressed binaries (LLVM), so max/solid
; compression costs a lot of time for little gain. lzma2/normal is the practical
; balance; bump to lzma2/max (and SolidCompression=yes) if installer size matters
; more than build time.
Compression=lzma2/normal
SolidCompression=no
; Installs read-only resources/toolchains under Program Files; the agent writes
; its build output to %APPDATA% at runtime, so admin install is fine.
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The whole payload: kron-host-agent.exe + resources\ + toolchains\.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Comment: "Start KronEditor, then open {#AppUrl} in a browser"
Name: "{group}\Open KronEditor ({#AppUrl})"; Filename: "{#AppUrl}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; Offer to launch right after install. The agent runs in a console window and
; prints the URL; nowait so the wizard can finish.
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
