# Building Pocket IT Client

The Pocket IT client is a .NET 8 Windows application built with WinForms and WebView2.

## Prerequisites

### Required Software

1. **.NET 8 SDK**
   - Download: https://dotnet.microsoft.com/download/dotnet/8.0
   - Verify installation: `dotnet --version`
   - Should output: `8.0.x` or higher

2. **WebView2 Runtime**
   - Usually pre-installed on Windows 10/11
   - Download if needed: https://developer.microsoft.com/microsoft-edge/webview2/
   - Verify: Check for "Microsoft Edge WebView2 Runtime" in Programs & Features

3. **Visual Studio 2022** (Optional)
   - Community edition is free
   - Workload: ".NET Desktop Development"
   - Useful for debugging and UI design

## Project Structure

```
client/PocketIT/
├── PocketIT.csproj              # Project file
├── Program.cs                   # Entry point
├── TrayApplication.cs           # System tray icon and menu
├── ChatWindow.cs                # WebView2 form window
├── appsettings.json             # Configuration file
│
├── Core/
│   ├── DeviceIdentity.cs        # Generate unique device ID
│   ├── ServerConnection.cs      # Socket.IO connection manager
│   └── LocalDatabase.cs         # SQLite for offline queue
│
├── Diagnostics/
│   ├── IDiagnosticCheck.cs      # Interface for diagnostic checks
│   ├── DiagnosticsEngine.cs     # Orchestrate checks
│   └── Checks/
│       ├── CpuCheck.cs          # CPU usage and top processes
│       ├── MemoryCheck.cs       # RAM usage and top processes
│       ├── DiskCheck.cs         # Disk space on all drives
│       └── NetworkCheck.cs      # Network adapters, connectivity, DNS
│
├── Remediation/
│   ├── IRemediationAction.cs    # Interface for remediation actions
│   ├── ActionWhitelist.cs       # Hardcoded whitelist
│   ├── RemediationEngine.cs     # Execute whitelisted actions
│   └── Actions/
│       ├── FlushDnsAction.cs    # ipconfig /flushdns
│       └── ClearTempFilesAction.cs  # Delete old temp files
│
├── Enrollment/
│   └── EnrollmentFlow.cs        # Device enrollment on first run
│
└── WebUI/
    ├── index.html               # Enrollment UI
    ├── chat.html                # Chat interface
    ├── chat.css                 # Styling
    └── chat.js                  # WebView2 JavaScript
```

## Building from Command Line

### Debug Build

```bash
cd client/PocketIT
dotnet restore
dotnet build
```

**Output:** `bin\Debug\net8.0-windows\PocketIT.exe`

### Release Build

```bash
dotnet build -c Release
```

**Output:** `bin\Release\net8.0-windows\PocketIT.exe`

### Self-Contained Release

Build with all dependencies bundled (no .NET runtime required on target):

```bash
dotnet publish -c Release -r win-x64 --self-contained
```

**Output:** `bin\Release\net8.0-windows\win-x64\publish\`

**Pros:**
- No .NET runtime installation needed
- Larger executable (~80-100 MB)

**Cons:**
- Larger deployment size

### Framework-Dependent Release

Build requiring .NET 8 runtime on target:

```bash
dotnet publish -c Release -r win-x64 --self-contained false
```

**Output:** `bin\Release\net8.0-windows\win-x64\publish\`

**Pros:**
- Smaller executable (~200 KB)

**Cons:**
- Requires .NET 8 runtime on target PC

## Running from Command Line

### Debug Mode

```bash
dotnet run
```

### Watch Mode (Auto-rebuild)

```bash
dotnet watch run
```

Changes to `.cs` files trigger automatic rebuild and restart.

## Building with Visual Studio

1. Open `client/PocketIT.sln` in Visual Studio 2022
2. Select build configuration: Debug or Release
3. Select platform: Any CPU
4. Build → Build Solution (Ctrl+Shift+B)
5. Debug → Start Debugging (F5) or Start Without Debugging (Ctrl+F5)

## Configuration

### appsettings.json

Located at `client/PocketIT/appsettings.json`, copied to output directory on build.

```json
{
  "Server": {
    "Url": "http://localhost:9100",
    "ReconnectInterval": 5000
  },
  "Enrollment": {
    "Token": ""
  },
  "Database": {
    "Path": "pocket-it.db"
  },
  "OfflineContacts": {
    "Phone": "",
    "Email": "",
    "Portal": ""
  }
}
```

**Server.Url:** Socket.IO server URL (change for remote servers)

**Server.ReconnectInterval:** Milliseconds between reconnection attempts

**Enrollment.Token:** One-time enrollment token (get from server API)

**Database.Path:** SQLite database filename (created in app directory)

**OfflineContacts:** IT support contact information displayed when server is unreachable

### Configuring Offline Contacts

When the server is unreachable, the chat UI displays friendly offline responses with alternative IT support contact information. This information is configured in `appsettings.json` under the `OfflineContacts` section.

**Configuration fields:**

- **Phone:** IT helpdesk phone number (e.g., "+1-555-IT-HELP" or "ext. 1234")
- **Email:** IT support email address (e.g., "support@example.com")
- **Portal:** IT support portal URL (e.g., "https://helpdesk.example.com")

**Example configuration:**

```json
{
  "OfflineContacts": {
    "Phone": "+1-555-867-5309",
    "Email": "itsupport@acmecorp.com",
    "Portal": "https://help.acmecorp.com"
  }
}
```

**How it flows:**

1. **appsettings.json** is loaded by the C# application on startup
2. The `OfflineContacts` configuration is read from the settings
3. C# sends an `offline_config` message to the WebView2 chat UI via the WebView2 bridge:
   ```csharp
   _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
   {
       type = "offline_config",
       phone = settings.OfflineContacts.Phone,
       email = settings.OfflineContacts.Email,
       portal = settings.OfflineContacts.Portal
   }));
   ```
4. The JavaScript code in `chat.js` receives the message and updates the `offlineContacts` object
5. When displaying offline responses, the contact block is appended to the message

**Fallback behavior:** If all three fields are left empty, the offline responses display a generic fallback message: "Please contact your IT department directly for urgent issues."

### Getting an Enrollment Token

1. Ensure server is running: `curl http://localhost:9100/health`
2. Generate token: `curl -X POST http://localhost:9100/api/enrollment/token`
3. Copy token from response into `appsettings.json`
4. Launch client — it will auto-enroll on first connection

## WebView2 Bridge

The client uses WebView2 to render the chat UI. Communication between C# and JavaScript happens via the WebView2 message bridge.

### JavaScript → C# (chat.js)

```javascript
window.chrome.webview.postMessage({
  type: 'chat_message',
  content: userInput
});
```

### C# → JavaScript (ChatWindow.cs)

```csharp
_webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
{
    type = "chat_response",
    text = response.Text,
    sender = response.Sender,
    agentName = response.AgentName
}));
```

### Message Handler (ChatWindow.cs)

```csharp
_webView.WebMessageReceived += async (sender, e) =>
{
    var json = e.WebMessageAsJson;
    var msg = JsonSerializer.Deserialize<WebMessage>(json);

    switch (msg.Type)
    {
        case "chat_message":
            await _connection.SendChatMessage(msg.Content);
            break;
        case "approve_remediation":
            await _remediation.ExecuteAsync(msg.ActionId);
            break;
    }
};
```

## Adding New Diagnostic Checks

### 1. Create Check Class

Create `Diagnostics/Checks/YourCheck.cs`:

```csharp
using System.Threading.Tasks;

namespace PocketIT.Diagnostics.Checks;

public class YourCheck : IDiagnosticCheck
{
    public string CheckType => "your_check";

    public async Task<DiagnosticResult> RunAsync()
    {
        // Collect diagnostic data
        var data = new
        {
            property1 = "value1",
            property2 = 42
        };

        return new DiagnosticResult
        {
            CheckType = CheckType,
            Status = "completed",
            Data = data
        };
    }
}
```

### 2. Register in DiagnosticsEngine

Edit `Diagnostics/DiagnosticsEngine.cs`:

```csharp
public DiagnosticsEngine()
{
    _checks.Add(new Checks.CpuCheck());
    _checks.Add(new Checks.MemoryCheck());
    _checks.Add(new Checks.DiskCheck());
    _checks.Add(new Checks.NetworkCheck());
    _checks.Add(new Checks.YourCheck());  // Add this line
}
```

### 3. Update Server System Prompt

Edit `server/ai/systemPrompt.js` to document the new check:

```javascript
### 1. Run Diagnostics
When you need system info, request a diagnostic check. Available checks:
- cpu — CPU usage and top processes
- memory — RAM usage and availability
- disk — Disk space on all drives
- network — Internet connectivity, DNS, adapter status
- your_check — Description of what your check does
- all — Run all checks
```

## Adding New Remediation Actions

### 1. Create Action Class

Create `Remediation/Actions/YourAction.cs`:

```csharp
using System.Threading.Tasks;

namespace PocketIT.Remediation.Actions;

public class YourAction : IRemediationAction
{
    public string ActionId => "your_action";

    public async Task<RemediationResult> ExecuteAsync()
    {
        // Execute the remediation action
        bool success = false;
        string message = "";

        try
        {
            // Your action logic here
            success = true;
            message = "Action completed successfully";
        }
        catch (Exception ex)
        {
            success = false;
            message = $"Action failed: {ex.Message}";
        }

        return new RemediationResult
        {
            ActionId = ActionId,
            Success = success,
            Message = message
        };
    }
}
```

### 2. Add to Whitelist

Edit `Remediation/ActionWhitelist.cs`:

```csharp
private static readonly Dictionary<string, RemediationInfo> _whitelist = new()
{
    ["flush_dns"] = new RemediationInfo { ... },
    ["clear_temp"] = new RemediationInfo { ... },
    ["your_action"] = new RemediationInfo
    {
        ActionId = "your_action",
        DisplayName = "Your Action Name",
        Description = "What this action does and why it's useful",
        RequiresApproval = true,
        RequiresElevation = false  // Set to true if needs admin rights
    }
};
```

### 3. Register in RemediationEngine

Edit `Remediation/RemediationEngine.cs`:

```csharp
public RemediationEngine()
{
    RegisterAction(new Actions.FlushDnsAction());
    RegisterAction(new Actions.ClearTempFilesAction());
    RegisterAction(new Actions.YourAction());  // Add this line
}
```

### 4. Update Server System Prompt

Edit `server/ai/systemPrompt.js`:

```javascript
### 2. Suggest Remediation
For common fixes you can suggest automated actions. Available actions:
- flush_dns — Flush the DNS resolver cache (fixes many connectivity issues)
- clear_temp — Clear temporary files to free disk space
- your_action — Description of what your action does
```

## Deployment

### Manual Deployment

1. Build release:
   ```bash
   dotnet publish -c Release -r win-x64 --self-contained
   ```

2. Copy `bin\Release\net8.0-windows\win-x64\publish\` folder to target PC

3. Edit `appsettings.json` with enrollment token and server URL

4. Run `PocketIT.exe`

### Auto-Start on Login

**Registry method:**

```powershell
$exePath = "C:\Path\To\PocketIT.exe"
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $registryPath -Name "PocketIT" -Value $exePath
```

**Startup folder method:**

1. Create shortcut to `PocketIT.exe`
2. Copy shortcut to: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`

### Future: MSI Installer

Planned features:
- Windows Installer (WiX Toolset)
- Auto-enrollment with pre-configured token
- Auto-start configuration
- Automatic updates

## Development Workflow

### 1. Make Code Changes

Edit `.cs` files in your preferred editor (Visual Studio, VS Code, Rider).

### 2. Test Changes

```bash
dotnet watch run
```

This rebuilds and restarts the app on file save.

### 3. Test with Server

1. Start server: `cd server && npm run dev`
2. Start client: `cd client/PocketIT && dotnet run`
3. Test chat, diagnostics, remediation flows

### 4. Debug

**Visual Studio:**
- Set breakpoints in `.cs` files
- Press F5 to start debugging
- Step through code, inspect variables

**VS Code:**
- Install C# extension
- Set breakpoints
- Run → Start Debugging

### 5. Build Release

```bash
dotnet build -c Release
```

## Troubleshooting

### Issue: WebView2 not found

**Solution:**
- Install WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/

### Issue: Server connection fails

**Check:**
1. Server is running: `curl http://localhost:9100/health`
2. Server URL in `appsettings.json` is correct
3. Firewall allows connections to port 9100

**Logs:**
- Client logs are printed to console
- Server logs show connection events

### Issue: Enrollment fails

**Check:**
1. Token is valid and not expired
2. Token has not been used before
3. Server enrollment endpoint is accessible

**Debug:**
```bash
curl -X POST http://localhost:9100/api/enrollment/enroll \
  -H "Content-Type: application/json" \
  -d '{
    "token": "your-token",
    "deviceId": "test-device",
    "hostname": "TEST-PC",
    "osVersion": "Windows 11"
  }'
```

### Issue: Diagnostic checks fail

**Check:**
- Performance counters are available (some checks require admin rights)
- WMI service is running

**Debug:**
- Check `DiagnosticResult.Status` — should be "completed" or "error"
- Error message is in `DiagnosticResult.Value`

### Issue: Remediation actions fail

**Check:**
- Action is in whitelist (`ActionWhitelist.IsAllowed()`)
- User has necessary permissions (some actions require elevation)

**Debug:**
- Check `RemediationResult.Success`
- Error message is in `RemediationResult.Message`

### Issue: Build fails

**Common causes:**
1. Wrong .NET version: `dotnet --version` should be 8.0.x
2. Missing packages: Run `dotnet restore`
3. Corrupted package cache: Delete `bin/` and `obj/` folders, rebuild

## Testing

### Unit Tests

**Framework:** xUnit (not yet implemented)

**Planned tests:**
- `ActionWhitelist` — Validate whitelist entries
- `DiagnosticsEngine` — Check orchestration
- `RemediationEngine` — Action execution
- `DeviceIdentity` — Device ID generation

### Integration Tests

**Manual testing checklist:**

1. **Enrollment:**
   - [ ] First run shows enrollment UI
   - [ ] Valid token enrolls successfully
   - [ ] Invalid token shows error
   - [ ] After enrollment, shows chat UI

2. **Chat:**
   - [ ] Send message, receive AI response
   - [ ] AI personality is consistent
   - [ ] Messages persist across restarts

3. **Diagnostics:**
   - [ ] AI requests diagnostic check
   - [ ] Client executes check
   - [ ] Results sent to server
   - [ ] AI interprets results

4. **Remediation:**
   - [ ] AI suggests remediation
   - [ ] User sees approval button
   - [ ] Action executes after approval
   - [ ] Result sent to server

5. **Offline:**
   - [ ] Stop server
   - [ ] Send messages — queued locally
   - [ ] Start server
   - [ ] Messages sync automatically

## Project Dependencies

**NuGet packages (defined in PocketIT.csproj):**

```xml
<PackageReference Include="Microsoft.Web.WebView2" Version="1.0.2739.15" />
<PackageReference Include="SocketIOClient" Version="3.1.1" />
<PackageReference Include="Microsoft.Data.Sqlite" Version="8.0.0" />
<PackageReference Include="Microsoft.Extensions.Configuration.Json" Version="8.0.0" />
```

**To update dependencies:**
```bash
dotnet add package PackageName --version x.x.x
```

## Performance Considerations

### Startup Time

**Typical:** 2-3 seconds to tray icon visible

**Optimizations:**
- WebView2 initialization is async
- Device ID generated once and cached
- Socket.IO connects in background

### Memory Usage

**Baseline:** ~50-80 MB

**Contributors:**
- WebView2 runtime: ~30-40 MB
- .NET runtime: ~15-20 MB
- Application code: ~5-10 MB

### CPU Usage

**Idle:** <1%

**Active chat:** 2-5% (WebView2 rendering + Socket.IO)

**Diagnostics running:** 5-15% (collecting system info)

## Security Best Practices

### Whitelisted Actions Only

**Never:**
- Execute arbitrary commands from server
- Eval or deserialize untrusted data
- Allow file system access outside temp folder

**Always:**
- Check `ActionWhitelist.IsAllowed(actionId)`
- Require user approval for all actions
- Log all actions to audit trail

### Data Validation

**User input:**
- Sanitize before sending to server
- Limit message length (10,000 chars)

**Server responses:**
- Validate JSON structure
- Ignore unknown action types

### Credentials

**Never:**
- Store passwords in code or config
- Log sensitive data to console

**Always:**
- Use appsettings.json for configuration
- Keep enrollment tokens secret

## Future Enhancements

**Planned features:**

1. **Proactive Monitoring:**
   - Background diagnostic checks every 15 minutes
   - Alert user to issues before they notice
   - Send anomaly reports to server

2. **Rich Chat UI:**
   - Markdown rendering in AI responses
   - Code blocks for technical solutions
   - Image/screenshot sharing

3. **Notification System:**
   - Toast notifications for AI responses
   - Tray icon badge for unread messages
   - Sound alerts for critical issues

4. **Additional Actions:**
   - Restart services (e.g., Print Spooler)
   - Update device drivers
   - Run Windows troubleshooters
   - Clear browser cache

5. **Knowledge Base Integration:**
   - Search company knowledge base
   - Link to help articles
   - Step-by-step guided workflows

## Contributing

**Code style:**
- Follow C# naming conventions
- Use async/await for I/O operations
- Add XML doc comments for public APIs
- Keep methods under 50 lines

**Pull requests:**
- Include unit tests for new features
- Update BUILDING.md if process changes
- Test on Windows 10 and 11

## License

Proprietary. Not licensed for redistribution.
