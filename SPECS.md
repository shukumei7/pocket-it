# Pocket IT — Technical Specification

Version: 0.1.2 (MVP)

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

**Server → Client Events:**

#### `agent_info`
Sent immediately after connection with assigned agent name. Also sent with each `chat_response` to allow dynamic agent name updates.

```json
{
  "agentName": "Jordan"
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
- `{ "type": "remediate", "actionId": "flush_dns|clear_temp" }`
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

## Database Schema

### Table: `devices`

Enrolled client devices.

```sql
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  hostname TEXT,
  os_version TEXT,
  status TEXT DEFAULT 'online',                -- online | offline
  certificate_fingerprint TEXT,                -- For future mTLS
  enrolled_at TEXT,                            -- ISO 8601 timestamp
  last_seen TEXT                               -- ISO 8601 timestamp
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

**Localhost bypass:**
- All requests from `127.0.0.1` or `::1` bypass authentication
- Implemented in `middleware.js`:

```javascript
function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireIT(req, res, next) {
  if (isLocalhost(req)) return next();
  // ... JWT validation for remote requests
}
```

**Device authentication:**
- Device connects to `/agent` namespace with `deviceId` query parameter
- Server verifies `deviceId` exists in `devices` table
- Server validates `device_secret` from handshake auth (required as of v0.1.2)
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

### Implemented Security Controls (v0.1.0)

| Control | Implementation | Location |
|---------|---------------|----------|
| JWT secret required | Server exits on startup if `POCKET_IT_JWT_SECRET` unset (no hardcoded fallback) | `server.js:5-9`, `socket/itNamespace.js` |
| Device DB validation | `requireDevice` middleware verifies device_id in database | `auth/middleware.js:17-31` |
| Device secret auth | Socket.IO handshake validates `device_secret` from enrollment; null secrets rejected | `socket/agentNamespace.js:23-35` |
| Re-enrollment protection | Existing device_id returns 409 Conflict | `routes/enrollment.js:43-44` |
| Enrollment status check | `GET /api/enrollment/status/:deviceId` validates device with `x-device-secret` header | `routes/enrollment.js` |
| Ticket auth | `POST /api/tickets` requires authenticated device | `routes/tickets.js:29` |
| Prompt injection defense | User messages wrapped in `<user_message>` tags | `services/diagnosticAI.js:30` |
| CORS hardened | No wildcard, no null origin allowed | `server.js:48-61` |
| Body size limit | 100KB max JSON payload | `server.js:63` |
| Account lockout | 5 failures → 15-minute lockout | `routes/admin.js:8-61` |
| LLM timeouts | 30s AbortController on HTTP calls | `services/llmService.js` |
| Server-side action whitelist | Remediation actions validated before forwarding | `socket/agentNamespace.js:104-112` |
| Status/priority validation | Ticket PATCH validates enum values | `routes/tickets.js:76-84` |

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

### Unit Tests

**Server:**
- `decisionEngine.js` — Parse action tags correctly
- `llmService.js` — Provider switching and error handling
- `diagnosticAI.js` — Conversation context management

**Client:**
- `ActionWhitelist.cs` — Whitelist validation
- `DiagnosticsEngine.cs` — Check orchestration
- `RemediationEngine.cs` — Action execution and error handling

### Integration Tests

**Socket.IO protocol:**
- Client connects to `/agent` namespace
- Send `chat_message`, receive `chat_response`
- Diagnostic request/result flow
- Remediation request/result flow
- IT namespace watch/unwatch flow

**Database operations:**
- Enrollment flow (token creation, device enrollment)
- Chat message persistence
- Ticket creation and retrieval

### End-to-End Tests

**User workflows:**
1. Launch client, enroll device
2. Send chat message, receive AI response
3. AI requests diagnostic, client executes, AI interprets
4. AI suggests remediation, user approves, action executes
5. AI creates ticket, verify in database

**IT staff workflows:**
1. Connect to `/it` namespace
2. Watch device
3. Receive chat updates
4. Send message to device
5. Request diagnostic from device

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
