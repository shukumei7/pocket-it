#define MyAppName "Pocket IT"
#define MyAppVersion "0.11.0"
#define MyAppPublisher "Pocket IT"
#define MyAppExeName "PocketIT.exe"
#define MyAppURL "https://github.com/pocket-it"

; Publish output directory (relative to this .iss file)
#define PublishDir "..\client\publish\win-x64"

[Setup]
AppId={{B7E2F4A1-3D8C-4E5F-9A1B-2C6D7E8F0A3B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=PocketIT-{#MyAppVersion}-setup
SetupIconFile=..\client\PocketIT\Resources\tray-icon.ico
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}.0
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start {#MyAppName} when Windows starts"; GroupDescription: "Startup:"; Flags: checkedonce
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Main application files (self-contained publish output)
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "appsettings.json"
; Config file — don't overwrite on upgrade so IT admins keep their settings
Source: "{#PublishDir}\appsettings.json"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Clean up old registry auto-start on uninstall (migration cleanup)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "PocketIT"; Flags: deletevalue uninsdeletevalue

[Run]
; Register scheduled task for elevated auto-start (when user chose autostart)
Filename: "schtasks"; Parameters: "/Create /TN ""PocketIT"" /TR """"""{app}\{#MyAppExeName}"""""" /SC ONLOGON /RL HIGHEST /F"; Flags: runhidden; Tasks: autostart
; Lock down install folder permissions (Administrators + SYSTEM only)
Filename: "icacls"; Parameters: """{app}"" /inheritance:r /grant:r ""SYSTEM:(OI)(CI)F"" ""BUILTIN\Administrators:(OI)(CI)F"" ""BUILTIN\Users:(OI)(CI)RX"""; Flags: runhidden
; Launch after install
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
; Auto-relaunch after silent update
Filename: "{app}\{#MyAppExeName}"; Flags: nowait postinstall skipifnotsilent

[UninstallRun]
Filename: "schtasks"; Parameters: "/Delete /TN ""PocketIT"" /F"; Flags: runhidden

[UninstallDelete]
; Clean up local database and logs on uninstall
Type: files; Name: "{app}\pocket-it.db"
Type: files; Name: "{app}\pocket-it.db-wal"
Type: files; Name: "{app}\pocket-it.db-shm"

[Code]
function IsWebView2Installed: Boolean;
var
  ResultCode: Integer;
  RegValue: String;
begin
  Result := False;
  // Check per-machine install
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', RegValue) then
  begin
    if RegValue <> '' then
      Result := True;
  end;
  // Check per-user install
  if not Result then
  begin
    if RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', RegValue) then
    begin
      if RegValue <> '' then
        Result := True;
    end;
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if not IsWebView2Installed then
  begin
    if MsgBox('{#MyAppName} requires Microsoft Edge WebView2 Runtime.'#13#10#13#10 +
              'WebView2 is included with Windows 10 (21H2+) and Windows 11. ' +
              'If you see this message, please install it from:'#13#10 +
              'https://developer.microsoft.com/en-us/microsoft-edge/webview2/'#13#10#13#10 +
              'Continue installation anyway?', mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := False;
    end;
  end;
end;
