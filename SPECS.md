# Pocket IT — Technical Specification

Version: 0.9.0

## System Architecture

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  End User Devices (Windows)                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Pocket IT Client (.NET 8 WinForms)                         │    │
│  │  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐    │    │
│  │  │  Tray    │  │   WebView2   │  │  Socket.IO Client  │    │    │
│  │  │  Icon    │→ │   Chat UI    │→ │  (Persistent WS)   │    │    │
│  │  └──────────┘  └──────────────┘  └──────────┬─────────┘    │    │
│  │  ┌──────────┐  ┌──────────────┐             │               │    │
│  │  │Diagnostic│  │ Remediation  │             │               │    │
│  │  │ Engine   │  │   Engine     │             │               │    │
│  │  └──────────┘  └──────────────┘             │               │    │
│  └────────────────────────────────────────────┼────────────────┘    │
└────────────────────────────────────────────────┼─────────────────────┘
                                                  │
                                    WebSocket (Socket.IO)
                                                  │
┌─────────────────────────────────────────────────┼─────────────────────┐
│  Server (Node.js + Express + Socket.IO)        │                     │
│  ┌─────────────────────────────────────────────┼─────────────────┐   │
│  │  Socket.IO Multiplexer                      │                 │   │
│  │  ┌──────────────────────┐  ┌────────────────┼──────────────┐ │   │
│  │  │  /agent namespace    │  │  /it namespace │              │ │   │
│  │  │  (device clients)    │  │  (IT dashboard)│              │ │   │
│  │  └──────────┬───────────┘  └────────────────┘              │ │   │
│  └─────────────┼─────────────────────────────────────────────── ┘   │
│                │                                                     │
│  ┌─────────────▼────────────────────────────────────────────────┐   │
│  │  DiagnosticAI Service                                        │   │
│  │  ┌───────────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ Conversation Ctx  │→ │ LLM Service  │→ │ Decision     │ │   │
│  │  │ (per device)      │  │ (4 providers)│  │ Engine       │ │   │
│  │  └───────────────────┘  └──────────────┘  └──────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Express REST API                                            │   │
│  │  /api/enrollment, /api/devices, /api/tickets, /api/chat     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SQLite Database (better-sqlite3)                            │   │
│  │  8 tables: devices, enrollment_tokens, it_users,             │   │
│  │  chat_messages, tickets, ticket_comments,                    │   │
│  │  diagnostic_results, audit_log                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Communication Flow

#### User Message Flow

```
1. User types message in WebView2
      ↓
2. JavaScript (chat.js) calls:
      window.chrome.webview.postMessage({
        type: 'chat_message',
        content: userInput
      })
      ↓
3. C# WebView2 message handler (ChatWindow.cs):
      _webView.WebMessageReceived += (s, e) => {
        var msg = JsonSerializer.Deserialize<Message>(e.WebMessageAsJson);
        _connection.SendChatMessage(msg.content);
      }
      ↓
4. Socket.IO client emits to /agent namespace:
      await _socket.EmitAsync("chat_message", new { content })
      ↓
5. Server agentNamespace.js receives:
      socket.on('chat_message', async (data) => {
        const response = await diagnosticAI.processMessage(deviceId, content, deviceInfo);
        socket.emit('chat_response', response);
      })
      ↓
6. DiagnosticAI.processMessage():
      - Build conversation context (last 20 messages)
      - Add system prompt with agent name and capabilities
      - Call LLM provider
      - Parse response for action tags
      - Save to database
      - Return { text, action, agentName }
      ↓
7. Server emits response back to client
      ↓
8. Client receives chat_response:
      - Display AI message in UI
      - If action present, handle action flow
```

#### AI Decision Flow

```
AI response received
      ↓
decisionEngine.parseResponse(rawResponse)
      ↓
Check for action tags:
      │
      ├─ [ACTION:DIAGNOSE:checkType] ────────────────────┐
      │     → Server emits diagnostic_request to client   │
      │     → Client runs diagnostic check                │
      │     → Client emits diagnostic_result to server    │
      │     → Server feeds results back to AI             │
      │     → AI interprets and responds                  │
      │                                                    │
      ├─ [ACTION:REMEDIATE:actionId] ────────────────────┤
      │     → Server emits remediation_request to client  │
      │     → Client shows "Approve" button in UI         │
      │     → User clicks Approve                         │
      │     → Client executes whitelisted action          │
      │     → Client emits remediation_result to server   │
      │     → Server logs to audit_log                    │
      │                                                    │
      └─ [ACTION:TICKET:priority:title] ─────────────────┤
            → Server creates ticket in DB                 │
            → Server emits ticket_created to /it namespace│
            → IT staff dashboard updates                  │
                                                           │
All branches:                                              │
      ← Server notifies /it namespace watchers ───────────┘
```

### AI Personality Assignment

Each device receives a deterministic AI personality based on a hash of its `device_id`:

```javascript
// systemPrompt.js
const AGENT_NAMES = [
  'Rick', 'Mabel', 'Jordan', 'Casey', 'Morgan',
  'Alex', 'Sam', 'Taylor', 'Quinn', 'Avery',
  'Robin', 'Jamie', 'Drew', 'Sage', 'Reese',
  'Parker', 'Blake', 'Riley', 'Skyler', 'Dana'
];

function getAgentName(deviceId) {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = ((hash << 5) - hash) + deviceId.charCodeAt(i);
    hash = hash & hash;
  }
  return AGENT_NAMES[Math.abs(hash) % AGENT_NAMES.length];
}
```

**Consistency:** The same device always gets the same agent name across sessions and server restarts. This creates a familiar, consistent support experience.

**First message behavior:** The system prompt includes a special instruction on the first message to introduce the agent by name with varied greetings.

## Socket.IO Protocol Specification

### Namespace: `/agent` (Device Clients)

**Connection query parameters:**
- `deviceId` (required) — Unique device identifier
- `hostname` (optional) — Device hostname for display

**Client → Server Events:**

#### `chat_message`
User sends a message to AI.

```json
{
  "content": "My internet isn't working"
}
```

#### `system_profile`
Client sends device hardware information. Extended fields were added in v0.9.0.

```json
{
  "cpuModel": "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz",
  "totalRamGB": 16,
  "totalDiskGB": 512,
  "processorCount": 8,
  "osEdition": "Professional",
  "osBuild": "22621.3007",
  "osArchitecture": "64-bit",
  "biosManufacturer": "American Megatrends Inc.",
  "biosVersion": "F16",
  "gpuModel": "NVIDIA GeForce RTX 3080",
  "serialNumber": "SN-1234567890",
  "domain": "CORP",
  "lastBootTime": "2024-01-15T08:00:00Z",
  "uptimeHours": 6.5,
  "loggedInUsers": ["CORP\\jsmith", "CORP\\admin"],
  "networkAdapters": [
    { "name": "Ethernet", "macAddress": "00:1A:2B:3C:4D:5E", "ipAddress": "192.168.1.100", "speed": "1 Gbps" }
  ]
}
```

#### `diagnostic_result`
Client sends diagnostic check results.

```json
{
  "checkType": "network",
  "status": "completed",
  "results": {
    "adapters": [
      { "name": "Ethernet", "status": "Up", "ipAddress": "192.168.1.100" }
    ],
    "internetConnectivity": true,
    "dnsResolution": true,
    "latency": 12
  }
}
```

#### `remediation_result`
Client reports remediation action outcome.

```json
{
  "actionId": "flush_dns",
  "success": true,
  "message": "DNS cache flushed successfully"
}
```

#### `heartbeat`
Keep-alive ping (sent every 30 seconds).

```json
{}
```

#### `system_tool_result`
Client sends the result of a system tool execution requested by the server.

```json
{
  "requestId": "req_1707857234789",
  "tool": "process_list",
  "success": true,
  "data": [
    { "pid": 1234, "name": "chrome.exe", "owner": "DOMAIN\\user", "cpuPercent": 3.2, "memoryMB": 412 }
  ],
  "error": null
}
```

**Server → Client Events:**

#### `agent_info`
Sent immediately after connection with assigned agent name. Also sent with each `chat_response` to allow dynamic agent name updates.

```json
{
  "agentName": "Jordan"
}
```

#### `chat_history`
Sent on connection with last 20 messages for conversation continuity.

```json
{
  "messages": [
    {
      "id": 1,
      "sender": "user",
      "content": "My internet is slow",
      "created_at": "2024-01-15T14:20:00Z"
    },
    {
      "id": 2,
      "sender": "ai",
      "content": "Let me check your network connection.",
      "created_at": "2024-01-15T14:20:05Z"
    }
  ]
}
```

#### `chat_response`
AI response to user message.

```json
{
  "text": "Let me check your network connection.",
  "sender": "ai",
  "agentName": "Jordan",
  "action": {
    "type": "diagnose",
    "checkType": "network"
  }
}
```

**Action types:**
- `null` — Plain text response
- `{ "type": "diagnose", "checkType": "cpu|memory|disk|network|all" }`
- `{ "type": "remediate", "actionId": "flush_dns|clear_temp|restart_spooler|repair_network|clear_browser_cache" }`
- `{ "type": "ticket", "priority": "low|medium|high|critical", "title": "..." }`

#### `diagnostic_request`
Request client to run a diagnostic check.

```json
{
  "checkType": "all",
  "requestId": "1707857234123"
}
```

#### `remediation_request`
Request user approval for remediation action.

```json
{
  "actionId": "flush_dns",
  "requestId": "1707857234456"
}
```

#### `system_tool_request`
Request client to execute a system tool and return results.

```json
{
  "requestId": "req_1707857234789",
  "tool": "process_list",
  "params": {}
}
```

**Available tools and their params:**
- `process_list` — `{}` — Returns all running processes with PID, name, owner, CPU%, memory MB
- `process_kill` — `{ "pid": 1234 }` — Terminates process by PID (blocked-process safety check applied)
- `service_list` — `{ "filter": "running" }` — Returns Windows services; filter: `"all"` | `"running"` | `"stopped"`
- `service_action` — `{ "name": "Spooler", "action": "restart" }` — Performs start/stop/restart on named service
- `event_log_query` — `{ "log": "System", "level": "Error", "count": 50, "source": "" }` — Queries Windows Event Log

### Namespace: `/it` (IT Staff Dashboard)

**Connection authentication:**
- `token` — JWT token (optional in MVP, localhost bypasses)

**Client → Server Events:**

#### `watch_device`
Subscribe to a device's events.

```json
{
  "deviceId": "abc123"
}
```

**Server sends back:**
- `device_status` — Current device info
- `device_chat_history` — Last 50 messages

#### `unwatch_device`
Unsubscribe from device events.

```json
{
  "deviceId": "abc123"
}
```

#### `chat_to_device`
IT tech sends message directly to device user.

```json
{
  "deviceId": "abc123",
  "content": "Hi, I'm reviewing your ticket. Can you restart your PC and try again?"
}
```

#### `request_diagnostic`
IT staff requests diagnostic check from device.

```json
{
  "deviceId": "abc123",
  "checkType": "network"
}
```

#### `system_tool_request`
IT staff requests execution of a system tool on a specific device. The server forwards the request to the device via the `/agent` namespace.

```json
{
  "deviceId": "abc123",
  "requestId": "req_1707857234789",
  "tool": "process_list",
  "params": {}
}
```

**Server → Client Events:**

#### `device_status`
Device information.

```json
{
  "device_id": "abc123",
  "hostname": "DESKTOP-USER01",
  "os_version": "Windows 11",
  "status": "online",
  "enrolled_at": "2024-01-15T10:30:00Z",
  "last_seen": "2024-01-15T14:25:30Z"
}
```

#### `device_chat_history`
Chat history for watched device.

```json
{
  "deviceId": "abc123",
  "messages": [
    {
      "id": 1,
      "device_id": "abc123",
      "sender": "user",
      "content": "My internet is slow",
      "message_type": "text",
      "created_at": "2024-01-15T14:20:00Z"
    },
    {
      "id": 2,
      "device_id": "abc123",
      "sender": "ai",
      "content": "I can help with that. Let me run a network diagnostic.",
      "message_type": "diagnose",
      "metadata": "{\"type\":\"diagnose\",\"checkType\":\"network\"}",
      "created_at": "2024-01-15T14:20:05Z"
    }
  ]
}
```

#### `device_chat_update`
Real-time chat update.

```json
{
  "deviceId": "abc123",
  "message": { "sender": "user", "content": "..." },
  "response": { "sender": "ai", "text": "...", "action": {...} }
}
```

#### `device_diagnostic_update`
Diagnostic check completed.

```json
{
  "deviceId": "abc123",
  "checkType": "network",
  "results": { ... }
}
```

#### `device_remediation_update`
Remediation action completed.

```json
{
  "deviceId": "abc123",
  "success": true,
  "message": "DNS cache flushed successfully"
}
```

#### `device_status_changed`
Device went online or offline.

```json
{
  "deviceId": "abc123",
  "status": "offline"
}
```

#### `ticket_created`
New ticket created by AI.

```json
{
  "id": 42,
  "deviceId": "abc123",
  "title": "Recurring BSOD on startup",
  "priority": "high"
}
```

#### `system_tool_result`
System tool execution result relayed from device back to the requesting IT dashboard client.

```json
{
  "deviceId": "abc123",
  "requestId": "req_1707857234789",
  "tool": "process_list",
  "success": true,
  "data": [
    { "pid": 1234, "name": "chrome.exe", "owner": "DOMAIN\\user", "cpuPercent": 3.2, "memoryMB": 412 }
  ],
  "error": null
}
```

## Database Schema

### Table: `devices`

Enrolled client devices with hardware specifications and health metrics.

```sql
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  hostname TEXT,
  os_version TEXT,
  status TEXT DEFAULT 'online',                -- online | offline
  cpu_model TEXT,                              -- CPU model string
  total_ram_gb REAL,                           -- Total RAM in GB
  total_disk_gb REAL,                          -- Total disk space in GB
  processor_count INTEGER,                     -- Number of logical processors
  health_score INTEGER,                        -- 0-100 computed health score
  certificate_fingerprint TEXT,                -- For future mTLS
  enrolled_at TEXT,                            -- ISO 8601 timestamp
  last_seen TEXT,                              -- ISO 8601 timestamp
  -- Extended profile fields (v0.9.0)
  os_edition TEXT,                             -- e.g. "Professional", "Home"
  os_build TEXT,                               -- e.g. "22621.3007"
  os_architecture TEXT,                        -- e.g. "64-bit"
  bios_manufacturer TEXT,                      -- e.g. "American Megatrends Inc."
  bios_version TEXT,                           -- e.g. "F16"
  gpu_model TEXT,                              -- e.g. "NVIDIA GeForce RTX 3080"
  serial_number TEXT,                          -- System serial number
  domain TEXT,                                 -- Domain or workgroup name
  last_boot_time TEXT,                         -- ISO 8601 timestamp of last boot
  uptime_hours REAL,                           -- Hours since last boot
  logged_in_users TEXT,                        -- JSON array of logged-in usernames
  network_adapters TEXT                        -- JSON array of adapter objects
);
```

**Indexes:**
- Primary key on `device_id`

### Table: `enrollment_tokens`

One-time tokens for device enrollment.

```sql
CREATE TABLE enrollment_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,                  -- UUID v4
  created_by TEXT,                             -- Username of creator
  expires_at TEXT,                             -- ISO 8601 timestamp
  used_by_device TEXT,                         -- device_id after use
  status TEXT DEFAULT 'active'                 -- active | used | expired
);
```

**Indexes:**
- Unique index on `token`

### Table: `it_users`

IT staff accounts.

```sql
CREATE TABLE it_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                 -- bcrypt hash
  display_name TEXT,
  role TEXT DEFAULT 'technician'               -- admin | technician | viewer
    CHECK(role IN ('admin','technician','viewer')),
  created_at TEXT,
  last_login TEXT
);
```

**Indexes:**
- Unique index on `username`

### Table: `chat_messages`

Conversation history between users and AI.

```sql
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  sender TEXT NOT NULL                         -- user | ai | it_tech
    CHECK(sender IN ('user','ai','it_tech')),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',            -- text | diagnose | remediate | ticket
  metadata TEXT,                               -- JSON string of action details
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_device_id ON chat_messages(device_id);
```

**Indexes:**
- Index on `device_id` for efficient history queries

### Table: `tickets`

Support tickets created by AI or users.

```sql
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open'                   -- open | in_progress | resolved | closed
    CHECK(status IN ('open','in_progress','resolved','closed')),
  priority TEXT DEFAULT 'medium'               -- low | medium | high | critical
    CHECK(priority IN ('low','medium','high','critical')),
  category TEXT,
  assigned_to INTEGER REFERENCES it_users(id),
  ai_summary TEXT,                             -- AI's analysis of the issue
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX idx_tickets_device_id ON tickets(device_id);
CREATE INDEX idx_tickets_status ON tickets(status);
```

**Indexes:**
- Index on `device_id` for device ticket history
- Index on `status` for dashboard queries

### Table: `ticket_comments`

Comments on tickets from IT staff or system.

```sql
CREATE TABLE ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL,                        -- Username or 'system'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Indexes:**
- Foreign key on `ticket_id`

### Table: `diagnostic_results`

Historical diagnostic check results.

```sql
CREATE TABLE diagnostic_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  check_type TEXT NOT NULL,                    -- cpu | memory | disk | network | all
  status TEXT NOT NULL,                        -- completed | error
  data TEXT,                                   -- JSON string of results
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_diagnostic_results_device_id ON diagnostic_results(device_id);
```

**Indexes:**
- Index on `device_id` for device diagnostic history

### Table: `audit_log`

Audit trail for security and compliance.

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,                         -- device_id or username
  action TEXT NOT NULL,                        -- remediation_executed, ticket_created, etc.
  target TEXT,                                 -- Affected entity (device_id, ticket_id, etc.)
  details TEXT,                                -- JSON string of additional info
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
```

**Indexes:**
- Index on `created_at` for time-based queries

## Whitelisted Remediation Actions

The client uses a hardcoded whitelist to prevent execution of unapproved actions.

### Implementation: `ActionWhitelist.cs`

```csharp
public static class ActionWhitelist
{
    private static readonly Dictionary<string, RemediationInfo> _whitelist = new()
    {
        ["flush_dns"] = new RemediationInfo
        {
            ActionId = "flush_dns",
            DisplayName = "Flush DNS Cache",
            Description = "Clears the DNS resolver cache. Fixes many connectivity issues.",
            RequiresApproval = true,
            RequiresElevation = true
        },
        ["clear_temp"] = new RemediationInfo
        {
            ActionId = "clear_temp",
            DisplayName = "Clear Temporary Files",
            Description = "Deletes temporary files older than 7 days to free disk space.",
            RequiresApproval = true,
            RequiresElevation = false
        },
        ["restart_spooler"] = new RemediationInfo
        {
            ActionId = "restart_spooler",
            DisplayName = "Restart Print Spooler",
            Description = "Restarts the Windows Print Spooler service to fix stuck print jobs.",
            RequiresApproval = true,
            RequiresElevation = true
        },
        ["repair_network"] = new RemediationInfo
        {
            ActionId = "repair_network",
            DisplayName = "Repair Network Stack",
            Description = "Full network reset: Winsock, TCP/IP, DNS flush, IP release/renew.",
            RequiresApproval = true,
            RequiresElevation = true
        },
        ["clear_browser_cache"] = new RemediationInfo
        {
            ActionId = "clear_browser_cache",
            DisplayName = "Clear Browser Cache",
            Description = "Clears cache files for Chrome, Edge, and Firefox.",
            RequiresApproval = true,
            RequiresElevation = false
        }
    };

    public static bool IsAllowed(string actionId) => _whitelist.ContainsKey(actionId);
    public static RemediationInfo? GetInfo(string actionId) =>
        _whitelist.TryGetValue(actionId, out var info) ? info : null;
}
```

### Action: `flush_dns`

**Implementation:** `FlushDnsAction.cs`

```csharp
public async Task<RemediationResult> ExecuteAsync()
{
    var psi = new ProcessStartInfo
    {
        FileName = "ipconfig",
        Arguments = "/flushdns",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        CreateNoWindow = true
    };

    using var process = Process.Start(psi);
    await process.WaitForExitAsync();

    return new RemediationResult
    {
        ActionId = "flush_dns",
        Success = process.ExitCode == 0,
        Message = process.ExitCode == 0
            ? "DNS cache flushed successfully"
            : "Failed to flush DNS cache"
    };
}
```

### Action: `clear_temp`

**Implementation:** `ClearTempFilesAction.cs`

```csharp
public async Task<RemediationResult> ExecuteAsync()
{
    var tempPath = Path.GetTempPath();
    var cutoffDate = DateTime.Now.AddDays(-7);
    int deletedCount = 0;

    await Task.Run(() =>
    {
        foreach (var file in Directory.GetFiles(tempPath))
        {
            try
            {
                var fileInfo = new FileInfo(file);
                if (fileInfo.LastWriteTime < cutoffDate)
                {
                    fileInfo.Delete();
                    deletedCount++;
                }
            }
            catch { /* Skip files in use */ }
        }
    });

    return new RemediationResult
    {
        ActionId = "clear_temp",
        Success = true,
        Message = $"Deleted {deletedCount} temporary files"
    };
}
```

## Diagnostic Checks

### Check: `cpu`

**Data collected:**
- CPU usage percentage (average over 1 second)
- Top 5 processes by CPU usage

**Implementation:** `CpuCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var cpuCounter = new PerformanceCounter("Processor", "% Processor Time", "_Total");
    cpuCounter.NextValue(); // First call always returns 0
    await Task.Delay(1000);
    var cpuUsage = cpuCounter.NextValue();

    var topProcesses = Process.GetProcesses()
        .OrderByDescending(p => p.TotalProcessorTime)
        .Take(5)
        .Select(p => new { p.ProcessName, CPU = p.TotalProcessorTime.TotalSeconds })
        .ToList();

    return new DiagnosticResult
    {
        CheckType = "cpu",
        Status = "completed",
        Data = new { cpuUsage, topProcesses }
    };
}
```

### Check: `memory`

**Data collected:**
- Total RAM
- Available RAM
- RAM usage percentage
- Top 5 processes by memory usage

**Implementation:** `MemoryCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var totalMemory = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
    var availableMemory = new PerformanceCounter("Memory", "Available MBytes").NextValue() * 1024 * 1024;
    var usedMemory = totalMemory - (long)availableMemory;
    var usagePercent = (double)usedMemory / totalMemory * 100;

    var topProcesses = Process.GetProcesses()
        .OrderByDescending(p => p.WorkingSet64)
        .Take(5)
        .Select(p => new { p.ProcessName, MemoryMB = p.WorkingSet64 / 1024 / 1024 })
        .ToList();

    return new DiagnosticResult
    {
        CheckType = "memory",
        Status = "completed",
        Data = new { totalMemory, availableMemory, usagePercent, topProcesses }
    };
}
```

### Check: `disk`

**Data collected:**
- All drives (name, total space, free space, usage percentage)

**Implementation:** `DiskCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var drives = DriveInfo.GetDrives()
        .Where(d => d.IsReady)
        .Select(d => new
        {
            Name = d.Name,
            TotalSpaceGB = d.TotalSize / 1024.0 / 1024 / 1024,
            FreeSpaceGB = d.AvailableFreeSpace / 1024.0 / 1024 / 1024,
            UsagePercent = (1 - (double)d.AvailableFreeSpace / d.TotalSize) * 100
        })
        .ToList();

    return new DiagnosticResult
    {
        CheckType = "disk",
        Status = "completed",
        Data = new { drives }
    };
}
```

### Check: `network`

**Data collected:**
- Network adapters (name, status, IP address)
- Internet connectivity (ping 8.8.8.8)
- DNS resolution (resolve google.com)
- Latency to 8.8.8.8

**Implementation:** `NetworkCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var adapters = NetworkInterface.GetAllNetworkInterfaces()
        .Where(a => a.OperationalStatus == OperationalStatus.Up)
        .Select(a => new
        {
            Name = a.Name,
            Status = a.OperationalStatus.ToString(),
            IpAddress = a.GetIPProperties().UnicastAddresses
                .FirstOrDefault(ip => ip.Address.AddressFamily == AddressFamily.InterNetwork)
                ?.Address.ToString()
        })
        .ToList();

    var ping = new Ping();
    var internetConnectivity = false;
    var latency = -1L;

    try
    {
        var reply = await ping.SendPingAsync("8.8.8.8", 3000);
        internetConnectivity = reply.Status == IPStatus.Success;
        latency = reply.RoundtripTime;
    }
    catch { }

    var dnsResolution = false;
    try
    {
        var host = await Dns.GetHostEntryAsync("google.com");
        dnsResolution = host.AddressList.Length > 0;
    }
    catch { }

    return new DiagnosticResult
    {
        CheckType = "network",
        Status = "completed",
        Data = new { adapters, internetConnectivity, dnsResolution, latency }
    };
}
```

## Authentication Model

### MVP Scope (Development)

**Dashboard authentication:**
- Remote IT staff use login overlay at `/dashboard/index.html`
- JWT token stored in sessionStorage and included in API calls via `fetchWithAuth()` wrapper
- Socket.IO handshake includes JWT in auth query parameter
- Localhost requests still bypass authentication for development

**Device authentication:**
- Device connects to `/agent` namespace with `deviceId` query parameter
- Server verifies `deviceId` exists in `devices` table
- Server validates `device_secret` from handshake auth (required as of v0.1.2) AND `x-device-secret` header via `requireDevice` middleware (v0.1.4)
- Devices with null `device_secret` are rejected (requires re-enrollment)

### Production Roadmap

**Device authentication:**
- mTLS (mutual TLS) with client certificates
- Certificate fingerprint stored in `devices.certificate_fingerprint`
- Certificate issued during enrollment
- Server validates certificate on Socket.IO connection

**IT staff authentication:**
- JWT tokens with role-based access control
- Login via `/api/auth/login` endpoint
- Token includes: `userId`, `username`, `role`, `exp`
- Middleware validates JWT and checks role
- TOTP 2FA for admin role

**Network-level security:**
- Firewall rules restricting server port access
- VPN requirement for remote IT staff
- Tailscale/ZeroTier for secure remote access

## Error Handling

### LLM Service Errors

**Strategy:** Graceful degradation with user-friendly messages.

```javascript
// diagnosticAI.js
try {
  const rawResponse = await this.llm.chat(llmMessages);
  // ... process response
} catch (err) {
  console.error('DiagnosticAI error:', err.message);
  return {
    text: "I'm having trouble connecting to my brain right now. Let me try again in a moment, or you can describe your issue again.",
    action: null,
    agentName: ctx.agentName
  };
}
```

**Logged to:** Console output (future: structured logging to audit_log)

### Socket.IO Connection Errors

**Client-side reconnection:**
```csharp
// ServerConnection.cs
_socket.OnDisconnect += async (sender, e) =>
{
    _logger.LogWarning("Disconnected from server, reconnecting...");
    await Task.Delay(5000);
    await _socket.ConnectAsync();
};
```

**Server-side tracking:**
- Device status set to `offline` on disconnect
- IT namespace notified via `device_status_changed` event

### Diagnostic Check Errors

**Strategy:** Return error status with message.

```csharp
// DiagnosticsEngine.cs
try
{
    results.Add(await check.RunAsync());
}
catch (Exception ex)
{
    results.Add(new DiagnosticResult
    {
        CheckType = check.CheckType,
        Status = "error",
        Label = check.CheckType,
        Value = $"Error: {ex.Message}"
    });
}
```

**Server-side handling:**
- Error status saved to `diagnostic_results` table
- AI receives error message and can respond appropriately

### Remediation Action Errors

**Strategy:** Validate whitelist, execute with try/catch, return result.

```csharp
// RemediationEngine.cs
if (!ActionWhitelist.IsAllowed(actionId))
{
    return new RemediationResult
    {
        ActionId = actionId,
        Success = false,
        Message = $"Action '{actionId}' is not in the whitelist."
    };
}

try
{
    return await action.ExecuteAsync();
}
catch (Exception ex)
{
    return new RemediationResult
    {
        ActionId = actionId,
        Success = false,
        Message = $"Action failed: {ex.Message}"
    };
}
```

**Audit logging:**
- All remediation attempts logged to `audit_log` table
- Includes success/failure status

## Offline Behavior

### Client Message Queue

**Strategy:** Queue messages locally when disconnected, sync on reconnect.

```csharp
// LocalDatabase.cs
public void QueueMessage(string content)
{
    using var cmd = _connection.CreateCommand();
    cmd.CommandText = "INSERT INTO message_queue (content, timestamp) VALUES (@content, @timestamp)";
    cmd.Parameters.AddWithValue("@content", content);
    cmd.Parameters.AddWithValue("@timestamp", DateTime.UtcNow.ToString("o"));
    cmd.ExecuteNonQuery();
}

public List<QueuedMessage> GetQueuedMessages()
{
    // ... retrieve and return queued messages
}
```

**Sync on reconnect:**
```csharp
_socket.OnConnect += async (sender, e) =>
{
    var queued = _database.GetQueuedMessages();
    foreach (var msg in queued)
    {
        await _connection.SendChatMessage(msg.Content);
        _database.DeleteQueuedMessage(msg.Id);
    }
};
```

### Client UI Offline Responses

**Connection state tracking:** The chat UI tracks connection status via `isConnected` boolean. When the server is unreachable, friendly offline responses are displayed to the user.

**Rotating responses:** Eight distinct offline response messages rotate to provide variety while maintaining consistency. Each response acknowledges the offline state and assures the user their message was saved.

**Contact information block:** Each offline response appends IT contact information (phone, email, support portal) to direct users to alternative support channels. If no contacts are configured, a fallback message is shown instead.

**Offline configuration:** The C# bridge sends an `offline_config` message to the WebView2 chat UI with contact information from `appsettings.json`:

```json
{
  "type": "offline_config",
  "phone": "+1-555-IT-HELP",
  "email": "support@example.com",
  "portal": "https://helpdesk.example.com"
}
```

The JavaScript chat UI stores these values in the `offlineContacts` object and includes them in the `contactBlock()` function appended to each offline response.

**Example offline response:**

```
Hi! Unfortunately the server is offline at the moment. Your message is queued
and I'll get right on it once the connection is restored.

For immediate help:
Phone: **+1-555-IT-HELP**
Email: **support@example.com**
Portal: **https://helpdesk.example.com**
```

### Server-Side Behavior

**Device offline:**
- Socket.IO disconnect event sets `status = 'offline'` in database
- IT namespace watchers notified via `device_status_changed`
- Messages sent to offline devices are queued (future feature)

## Performance Considerations

### Conversation Context Management

**Memory usage:**
- Server keeps last 20 messages per device in memory
- Map structure: `deviceId → { agentName, messages[], deviceInfo }`
- Auto-trimmed on each new message
- Context cleared manually via `clearContext(deviceId)` if needed

**Database queries:**
- Chat history queries limited to last 50 messages
- Indexes on `device_id` for efficient lookups

### Socket.IO Scaling

**Current limitations:**
- Single-process server (no clustering)
- In-memory device connection map
- Not suitable for >1000 concurrent devices

**Future scaling:**
- Redis adapter for multi-process Socket.IO
- Horizontal scaling with load balancer
- Sticky sessions or shared connection state

### LLM Latency

**Typical response times:**
- Ollama (local): 1-5 seconds
- OpenAI API: 1-3 seconds
- Anthropic API: 2-4 seconds
- Claude CLI: 2-5 seconds

**Mitigation:**
- Show "typing" indicator in UI during LLM call
- Stream responses (future feature)
- Cache common responses (future feature)

## Security Threat Model

### Implemented Security Controls (v0.1.4)

| Control | Implementation | Location |
|---------|---------------|----------|
| JWT secret required | Server exits on startup if `POCKET_IT_JWT_SECRET` unset (no hardcoded fallback) | `server.js:5-9`, `socket/itNamespace.js` |
| Device DB validation | `requireDevice` middleware verifies device_id in database | `auth/middleware.js:17-31` |
| Device secret auth (Socket.IO) | Socket.IO handshake validates `device_secret` from enrollment; null secrets rejected | `socket/agentNamespace.js:23-35` |
| Device secret auth (HTTP) | `requireDevice` middleware validates `x-device-secret` header (v0.1.4) | `auth/middleware.js` |
| Re-enrollment protection | Existing device_id returns 409 Conflict | `routes/enrollment.js:43-44` |
| Enrollment status check | `GET /api/enrollment/status/:deviceId` validates device with `x-device-secret` header | `routes/enrollment.js` |
| Ticket auth | `POST /api/tickets` requires authenticated device | `routes/tickets.js:29` |
| Prompt injection defense | User messages wrapped in `<user_message>` tags | `services/diagnosticAI.js:30` |
| XSS prevention | All user-controlled data in dashboard escaped via `escapeHtml()` (v0.1.4) | `public/dashboard/*.html` |
| Socket.IO chat rate limiting | 20 messages/minute per device (v0.1.4) | `socket/agentNamespace.js` |
| CORS hardened | No wildcard, no null origin allowed | `server.js:48-61` |
| Body size limit | 100KB max JSON payload | `server.js:63` |
| Account lockout | 5 failures → 15-minute lockout | `routes/admin.js:8-61` |
| LLM timeouts | 30s AbortController on HTTP calls | `services/llmService.js` |
| Server-side action whitelist | Remediation actions validated before forwarding | `socket/agentNamespace.js:104-112` |
| Status/priority validation | Ticket PATCH validates enum values | `routes/tickets.js:76-84` |
| JWT secret fallback removed | Admin login route no longer has hardcoded fallback (v0.1.4) | `routes/admin.js` |

### Threats and Mitigations

| Threat | Mitigation |
|--------|-----------|
| Malicious remediation actions | Hardcoded whitelist, user approval required |
| Unauthorized device enrollment | One-time tokens with expiration |
| Impersonation of IT staff | JWT authentication with TOTP (production) |
| Eavesdropping on chat | TLS encryption (production), mTLS (future) |
| Privilege escalation | Role-based access control for IT staff |
| LLM prompt injection | Structured action parsing, no eval() of LLM output |
| Database injection | Parameterized queries (better-sqlite3 prepared statements) |
| Denial of service | Rate limiting (future), connection limits |

### Data Privacy

**Sensitive data stored:**
- Chat messages (user questions, AI responses)
- Diagnostic results (CPU usage, process names, disk space)
- Device identifiers (hostname, OS version)

**Retention policy:**
- Chat messages: 90 days (future auto-cleanup)
- Diagnostic results: 30 days
- Audit logs: 1 year

**Data minimization:**
- No PII collected beyond hostname
- No file content scanned or uploaded
- Diagnostic checks only collect aggregated metrics

## Extensibility Points

### Adding New Diagnostic Checks

1. Create new check class implementing `IDiagnosticCheck`:
   ```csharp
   public class MyCheck : IDiagnosticCheck
   {
       public string CheckType => "my_check";
       public async Task<DiagnosticResult> RunAsync() { ... }
   }
   ```

2. Register in `DiagnosticsEngine.cs`:
   ```csharp
   _checks.Add(new MyCheck());
   ```

3. Update server `systemPrompt.js` to document new check

### Adding New Remediation Actions

1. Create new action class implementing `IRemediationAction`:
   ```csharp
   public class MyAction : IRemediationAction
   {
       public string ActionId => "my_action";
       public async Task<RemediationResult> ExecuteAsync() { ... }
   }
   ```

2. Add to `ActionWhitelist.cs`:
   ```csharp
   ["my_action"] = new RemediationInfo { ... }
   ```

3. Register in `RemediationEngine.cs`:
   ```csharp
   RegisterAction(new MyAction());
   ```

4. Update server `systemPrompt.js` to document new action

### Adding New System Tools

System tools follow the `ISystemTool` interface. Each tool receives a `params` dictionary and returns a `SystemToolResult`.

1. Create new tool class implementing `ISystemTool`:
   ```csharp
   public class MyTool : ISystemTool
   {
       public string ToolName => "my_tool";

       public async Task<SystemToolResult> ExecuteAsync(Dictionary<string, object> params)
       {
           try
           {
               var data = new { /* collected data */ };
               return SystemToolResult.Ok(data);
           }
           catch (Exception ex)
           {
               return SystemToolResult.Fail(ex.Message);
           }
       }
   }
   ```

2. Register in `SystemToolsEngine.cs`:
   ```csharp
   RegisterTool(new MyTool());
   ```

3. The tool becomes available immediately via the `system_tool_request` socket event pattern. No server changes are required — the server routes requests by `tool` name and relays results.

### Adding New LLM Providers

1. Add new provider case in `llmService.js`:
   ```javascript
   async _myProviderChat(messages) {
     // Implement API call
   }
   ```

2. Update `chat()` method switch statement
3. Add environment variables to `.env.example`
4. Update documentation

## Testing Strategy

### Unit Tests (34 tests)

**Server security tests:**
- JWT secret requirement on startup
- Device secret validation (Socket.IO and HTTP)
- Re-enrollment protection
- Prompt injection defense
- XSS prevention (escapeHtml utility)
- Socket.IO rate limiting (chat messages)
- CORS configuration
- Body size limits
- Account lockout
- LLM timeouts
- Server-side action whitelist
- Ticket status/priority validation

**Run tests:**
```bash
cd server
npm test
```

### End-to-End Tests (16 tests)

**Coverage:**
- Health check and API availability
- IT staff authentication (login/logout)
- Device enrollment flow
- Device lifecycle (enrollment, status check, device removal)
- Ticket CRUD operations
- Ticket comments
- Cascade delete verification (device removal clears chat/diagnostics/tickets)
- Dashboard statistics endpoint

**Run tests:**
```bash
cd server
npm run test:e2e
```

**Implementation:**
- Node.js built-in test runner (`node --test`)
- Isolated test database (`test-pocket-it.db`)
- Automated cleanup after each test suite

## Deployment

### Server Deployment

**Requirements:**
- Node.js 18+
- SQLite 3
- LLM provider (Ollama, OpenAI API key, or Claude CLI)

**Steps:**
1. Clone repository
2. `cd server && npm install`
3. Copy `.env.example` to `.env` and configure
4. `node server.js`

**Production considerations:**
- Use process manager (PM2, systemd)
- Configure HTTPS with reverse proxy (nginx, Caddy)
- Set up log rotation
- Enable firewall rules
- Configure backup for SQLite database

### Client Deployment

**Build:**
```bash
cd client/PocketIT
dotnet publish -c Release -r win-x64 --self-contained
```

**Distribution:**
- MSI installer (future)
- MSIX package (future)
- ZIP archive with enrollment token included

**Auto-start:**
- Registry key: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
- Startup folder shortcut

## Version History

**0.9.0**
- System Tools Engine: generic `system_tool_request`/`system_tool_result` socket event pattern on both `/agent` and `/it` namespaces
- 5 system tools: process_list (WMI process enumeration with owner), process_kill (by PID, blocked-process safety), service_list (all Windows services with filter), service_action (start/stop/restart), event_log_query (flexible Windows Event Log query)
- Enhanced device profile: 12 new fields on `devices` table (os_edition, os_build, os_architecture, bios_manufacturer, bios_version, gpu_model, serial_number, domain, last_boot_time, uptime_hours, logged_in_users JSON, network_adapters JSON)
- `system_profile` event extended: client sends all 12 new fields on connect
- Dashboard System Tools tab: tabbed interface (Processes, Services, Event Log) for live system inspection from IT dashboard
- Expanded device info cards in dashboard: GPU, serial number, BIOS, domain, uptime, logged-in users, network adapters
- New client packages: System.Management (WMI access) and System.ServiceProcess.ServiceController

**0.2.0**
- Real device diagnostics: client auto-collects system profile (CPU model, RAM, disk, cores) on connect
- Health scoring system: 0-100 score computed from diagnostic results (ok=100, warning=50, error=0, averaged)
- Health summary API: `GET /api/devices/health/summary` returns average health, breakdown, device list
- Dashboard health visualization: colored health bars (green/yellow/red), hardware info display
- AI hardware context: diagnostics include CPU/RAM/disk specs and threshold guidance for better recommendations
- Auto-diagnostics on connect: client automatically runs all 4 checks when connecting to server
- Database schema: 5 new columns on `devices` table (cpu_model, total_ram_gb, total_disk_gb, processor_count, health_score)
- Socket.IO: new `system_profile` event, health score recomputation on diagnostic results
- Admin stats: `GET /api/admin/stats` now includes `averageHealth` and `criticalDevices`

**0.1.4**
- Dashboard login overlay for remote IT staff access (JWT stored in sessionStorage, included in API calls via `fetchWithAuth()` and Socket.IO handshake)
- Full ticket detail view: click ticket to see description, AI summary, editable status/priority dropdowns, comments with add-comment form
- 3 new remediation actions: `restart_spooler`, `repair_network`, `clear_browser_cache` (total: 5 actions)
- 16 E2E smoke tests covering health, auth, enrollment, device lifecycle, tickets CRUD, comments, cascade delete, dashboard stats
- Security fixes: XSS prevention (all user data escaped via `escapeHtml()`), `requireDevice` middleware validates `x-device-secret` header, Socket.IO chat rate limiting (20 messages/minute), JWT secret fallback removed from admin login route
- Test totals: 50 tests (34 security unit tests + 16 E2E tests)

**0.1.3**
- New endpoint: `DELETE /api/devices/:id` (admin auth) — removes device and all related data (chat messages, diagnostics)
- Chat history on reconnect: server sends last 20 messages when device connects
- Bug fix: C# WebView2 bridge now injects `"type":"chat_response"` before forwarding to chat.js (was silently dropping all AI responses)
- Dashboard: "Remove Device" button with confirmation dialog

**0.1.2**
- Security hardening: null device_secret connections now rejected (requires re-enrollment)
- Security hardening: removed hardcoded JWT secret fallback in IT namespace
- New endpoint: `GET /api/enrollment/status/:deviceId` with device_secret validation
- Client device_secret validation before Socket.IO connect
- Chat UI: agent name updates from chat responses (not just initial handshake)
- Chat UI: "Connected to [agentName]" system message on connection
- IT Dashboard fully functional with Fleet, Tickets, and Enrollment pages (localhost auth bypass)

**0.1.1**
- Device secret authentication on Socket.IO connections
- Security hardening: JWT secret required, rate limiting, account lockout
- Server-side remediation action whitelist

**0.1.0 (MVP)**
- Initial release
- AI chat with 4 LLM provider options
- 4 diagnostic checks (CPU, memory, disk, network)
- 2 remediation actions (flush_dns, clear_temp)
- Support ticket creation
- IT staff device watching
- Localhost authentication bypass
