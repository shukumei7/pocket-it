# Pocket IT — Technical Specification

Version: 0.18.0

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
│  │  │ (per device)      │  │ (5 providers)│  │ Engine       │ │   │
│  │  └───────────────────┘  └──────────────┘  └──────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Express REST API                                            │   │
│  │  /api/enrollment, /api/devices, /api/tickets, /api/chat,    │   │
│  │  /api/clients, /api/updates                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SQLite Database (better-sqlite3)                            │   │
│  │  20 tables: devices, enrollment_tokens, it_users,            │   │
│  │  chat_messages, tickets, ticket_comments,                    │   │
│  │  diagnostic_results, audit_log, alert_thresholds, alerts,   │   │
│  │  notification_channels, auto_remediation_policies,           │   │
│  │  script_library, report_schedules, report_history,           │   │
│  │  clients, user_client_assignments, update_packages,          │   │
│  │  chat_read_cursors, user_preferences                         │   │
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
      - Check AI disable gate (order: global → per-device → IT-active)
        - If disabled: save user message, send system message to user, notify IT watchers, return early
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
      ├─ [ACTION:SCREENSHOT] ────────────────────────────┤
      │     → Server emits screenshot_request to client   │
      │     → Client shows user approval prompt           │
      │     → User approves                               │
      │     → Client captures screen (quality=40, 0.5f)  │
      │     → Client emits screenshot_result to server    │
      │     → Server passes image to AI (multimodal)      │
      │     → Ollama/Claude CLI receive text fallback     │
      │     → Gemini receives image via inlineData        │
      │                                                    │
      ├─ [ACTION:RUN_SCRIPT:<id>] ────────────────────────┤
      │     → decisionEngine produces { type: 'run_script', scriptId }
      │     → Server looks up script in script_library    │
      │     → Server emits script_request to client       │
      │       (aiInitiated: true)                         │
      │     → Client shows "AI Script Request" consent    │
      │       card (robot emoji, "AI assistant wants to   │
      │       run" message)                               │
      │     → User approves or denies                     │
      │     → If approved: client executes script,        │
      │       emits script_result with aiInitiated: true  │
      │     → Server routes result to                     │
      │       diagnosticAI.processScriptResult()          │
      │     → AI receives output, sends follow-up         │
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

## Updates API

The self-update system allows IT admins to upload installer packages and push them to managed devices. Clients poll the server periodically and apply updates silently.

### Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/updates/upload` | IT/admin | Upload installer `.exe` (multipart `file` field + optional `version`, `release_notes`) |
| `GET` | `/api/updates/latest` | any | Latest package version info (`{ version, sha256, file_size, release_notes }`) |
| `GET` | `/api/updates` | IT/admin | List all packages sorted by version descending |
| `DELETE` | `/api/updates/:version` | IT/admin | Delete a package and its file from disk |
| `POST` | `/api/updates/push/:version` | IT/admin | Emit update notification to all connected devices older than `:version` |
| `GET` | `/api/updates/check?version=X.Y.Z` | device | Returns `{ updateAvailable, version, sha256, downloadUrl }` or `{ updateAvailable: false }` |
| `GET` | `/api/updates/download/:version` | device | Stream installer file as `application/octet-stream` |
| `GET` | `/api/updates/fleet-versions` | IT/admin | Returns `{ versions: [{ version, count }] }` across all enrolled devices |

### Self-Update Flow (Client)

```
1. On connect / every 4 hours:
   GET /api/updates/check?version=<current>
         ↓
   { updateAvailable: true, version: "0.12.0", sha256: "...", downloadUrl: "..." }
         ↓
2. Download to %TEMP%\PocketIT-Update\PocketIT-<version>-setup.exe
         ↓
3. Compute SHA-256 of downloaded file
   Compare to sha256 from check response
   Abort if mismatch
         ↓
4. Launch installer:
   PocketIT-<version>-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS
```

### Client Version Reporting

The client passes `clientVersion` as a Socket.IO query parameter on connect. The `/agent` namespace handler reads this value and persists it to `devices.client_version`. This column feeds the fleet-versions endpoint.

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
Client sends device hardware information. Extended fields were added in v0.9.0. Hardware identity fields were added in v0.13.0.

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
  ],
  "deviceManufacturer": "Dell Inc.",
  "deviceModel": "Latitude 5520",
  "formFactor": "Laptop",
  "tpmVersion": "2.0",
  "secureBoot": "True",
  "domainJoinType": "On-Premises AD"
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

#### `screenshot_result`
Client sends a captured screenshot after user approval. Added in v0.12.8.

```json
{
  "requestId": "req_1707857234999",
  "imageBase64": "<base64-encoded JPEG>",
  "mimeType": "image/jpeg"
}
```

Capture settings: quality=40 (JPEG compression), scale=0.5 (50% of native resolution). If the user denies the request, no event is emitted.

#### `script_result`
Client reports the outcome of a script execution. Sent for both IT-initiated and AI-initiated scripts. Added in v0.18.0.

```json
{
  "requestId": "req_1707857234999",
  "scriptId": 42,
  "success": true,
  "output": "Service restarted successfully.\n",
  "aiInitiated": true
}
```

When `aiInitiated` is `true`, `agentNamespace.js` routes the result to `diagnosticAI.processScriptResult()` so the AI can analyze the output and respond. When `false`, the result is relayed to the IT dashboard as a `script_result` event on the `/it` namespace.

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
- `{ "type": "run_script", "scriptId": "<id>" }` — AI-requested script execution (v0.18.0)

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

#### `screenshot_request`
Request client to capture a screenshot after presenting user approval prompt. Added in v0.12.8.

```json
{
  "requestId": "req_1707857234999"
}
```

Client presents a consent dialog before capturing. If approved, responds with `screenshot_result`. If denied, no event is sent.

#### `script_request`
Request client to run a script library script after presenting a user consent card. Added in v0.18.0.

```json
{
  "requestId": "req_1707857235001",
  "scriptId": 42,
  "scriptName": "Clear Print Queue",
  "aiInitiated": true
}
```

When `aiInitiated` is `true`, the client chat UI displays an "AI Script Request" card with a robot emoji and the message "AI assistant wants to run: [scriptName]". When `false`, it displays a standard "Script Execution Request" card. User must approve before the script runs. Responds with `script_result`.

#### `update_available`
Notify client that a newer version is available on the server. Sent on connect when the connecting client version is outdated (v0.12.8). Previously only emitted via manual admin push or the 4-hour poll.

```json
{
  "version": "0.12.8",
  "downloadUrl": "/api/updates/download/0.12.8"
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

#### `ai_status`
Sent to the device client when its AI enabled/disabled state changes, and on initial connection. Added in v0.17.0.

```json
{
  "enabled": false,
  "reason": "IT technician is active"
}
```

**Possible `reason` values (when `enabled` is `false`):**
- `"AI is globally disabled"` — global toggle is off
- `"AI is disabled for this device"` — per-device disable (temporary or permanent)
- `"IT technician is active"` — IT tech sent a message within the last 5 minutes (transient, clears automatically)

When `enabled` is `true`, the `reason` field is omitted.

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

#### `set_device_ai`
IT staff sets the AI mode for a specific device. Added in v0.17.0.

```json
{
  "deviceId": "abc123",
  "mode": "temporary"
}
```

**`mode` values:**
- `"enabled"` — clears per-device disable; AI resumes if no other disable condition applies
- `"temporary"` — sets `devices.ai_disabled = 'temporary'`; AI paused until IT manually re-enables
- `"permanent"` — sets `devices.ai_disabled = 'permanent'`; AI permanently disabled for this device

The server records `devices.ai_disabled_by` as the IT username, emits `ai_status` to the device client, and broadcasts `device_ai_changed` to all IT watchers.

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

#### `device_ai_changed`
Broadcast to all IT dashboard clients when a device's AI mode is changed. Added in v0.17.0.

```json
{
  "deviceId": "abc123",
  "aiDisabled": "temporary",
  "aiDisabledBy": "tech_sarah"
}
```

`aiDisabled` is `null` when AI is enabled, `"temporary"` or `"permanent"` when disabled per-device.

#### `device_ai_reenabled`
Broadcast to all IT dashboard clients watching a device when the AI re-enables after an IT-active auto-disable period expires. Added in v0.18.0.

```json
{
  "deviceId": "abc123"
}
```

The dashboard shows a toast notification: "AI re-enabled for [hostname]". Distinct from `device_ai_changed` which is emitted on explicit IT-controlled state changes.

#### `device_watchers`
Sent to an IT client immediately after `watch_device` with the current list of IT users viewing that device. Added in v0.17.0.

```json
{
  "deviceId": "abc123",
  "watchers": ["tech_sarah", "admin_tom"]
}
```

#### `device_watchers_changed`
Broadcast to all IT clients watching a device when the watcher list changes (someone joins or leaves the device page). Added in v0.17.0.

```json
{
  "deviceId": "abc123",
  "watchers": ["tech_sarah"]
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
  network_adapters TEXT,                       -- JSON array of adapter objects
  -- Multi-tenancy (v0.10.0)
  client_id INTEGER REFERENCES clients(id),    -- Owning client (NULL = Default)
  -- Self-update (v0.11.0)
  client_version TEXT,                         -- Last reported client application version
  -- User tracking (v0.12.8)
  previous_logged_in_users TEXT,               -- JSON array saved when logged_in_users changes
  -- Hardware identity (v0.13.0)
  device_manufacturer TEXT,                    -- e.g. "Dell Inc." (wmic computersystem get Manufacturer)
  device_model TEXT,                           -- e.g. "Latitude 5520" (wmic computersystem get Model)
  form_factor TEXT,                            -- e.g. "Laptop", "Desktop", "Tower" (Win32_SystemEnclosure ChassisTypes)
  tpm_version TEXT,                            -- e.g. "2.0" or "Not Present" (PowerShell Get-Tpm)
  secure_boot TEXT,                            -- "True", "False", or "Unknown" (Confirm-SecureBootUEFI)
  domain_join_type TEXT,                       -- "On-Premises AD", "Azure AD", "Hybrid", or "Workgroup" (dsregcmd /status)
  -- AI disable (v0.17.0)
  ai_disabled TEXT,                            -- NULL | 'temporary' | 'permanent'
  ai_disabled_by TEXT                          -- IT username who set the disable state
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
  status TEXT DEFAULT 'active',                -- active | used | expired
  -- Multi-tenancy (v0.10.0)
  client_id INTEGER REFERENCES clients(id)     -- Target client for enrolled device
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
  role TEXT DEFAULT 'technician'               -- superadmin | admin | technician | viewer
    CHECK(role IN ('superadmin','admin','technician','viewer')),
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

### Table: `clients`

Client organizations managed by the MSP. Each client groups one or more enrolled devices.

```sql
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,                   -- Display name, e.g. "Acme Corp"
  slug TEXT UNIQUE NOT NULL,                   -- URL-safe identifier, e.g. "acme-corp"
  contact_name TEXT,                           -- Primary contact person
  contact_email TEXT,                          -- Primary contact email
  notes TEXT,                                  -- Free-form notes
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX idx_clients_slug ON clients(slug);
```

**Indexes:**
- Unique index on `name`
- Unique index on `slug`
- Index on `slug` for lookup

**Seed:** On first run (empty table), a "Default" client is inserted and all existing devices/tokens are assigned to it.

### Table: `user_client_assignments`

Many-to-many join between IT users and clients. A technician assigned to a client can see all devices belonging to that client.

```sql
CREATE TABLE user_client_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES it_users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assigned_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, client_id)
);

CREATE INDEX idx_uca_user_id ON user_client_assignments(user_id);
CREATE INDEX idx_uca_client_id ON user_client_assignments(client_id);
```

**Indexes:**
- Unique constraint on `(user_id, client_id)` prevents duplicate assignments
- Index on `user_id` for per-user scope lookups
- Index on `client_id` for per-client user listings

**Admin behavior:** Admin role users bypass this table entirely — admins always see all clients and all devices.

### Table: `update_packages`

Installer packages available for client self-update. Packages are stored on disk in `server/updates/` and tracked in this table.

```sql
CREATE TABLE update_packages (
  id INTEGER PRIMARY KEY,
  version TEXT UNIQUE NOT NULL,                -- Semver string, e.g. "0.11.0"
  filename TEXT NOT NULL,                      -- Installer filename, e.g. "PocketIT-0.11.0-setup.exe"
  file_size INTEGER,                           -- File size in bytes
  sha256 TEXT NOT NULL,                        -- SHA-256 hex digest for integrity verification
  release_notes TEXT,                          -- Free-form release notes
  uploaded_by TEXT,                            -- Username of the IT admin who uploaded the package
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Indexes:**
- Unique index on `version` (only one package per version)

**Update flow:**
1. IT admin uploads installer via `POST /api/updates/upload` (multipart)
2. Server computes SHA-256 of uploaded file and stores package metadata
3. Client sends current version via Socket.IO query param `clientVersion` on connect
4. Client polls `GET /api/updates/check?version=X.Y.Z` every 4 hours and on each connect
5. If server returns a newer version, client downloads from `GET /api/updates/download/:version`
6. Client verifies downloaded file's SHA-256 against the value from the check response
7. Client launches installer with `/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS`

### Table: `chat_read_cursors`

Per-IT-user read position per device. Used to compute unread chat message counts for the fleet badge system. Added in v0.17.0.

```sql
CREATE TABLE chat_read_cursors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  it_user_id INTEGER NOT NULL REFERENCES it_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL,               -- id of the last chat_messages row the IT user has read
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(it_user_id, device_id)
);

CREATE INDEX idx_crc_user_id ON chat_read_cursors(it_user_id);
CREATE INDEX idx_crc_device_id ON chat_read_cursors(device_id);
```

**Indexes:**
- Unique constraint on `(it_user_id, device_id)` — one cursor per IT user per device
- Index on `it_user_id` for `GET /api/devices/unread-counts` queries
- Index on `device_id` for cleanup on device removal

**Behavior:**
- Cursor upserted when an IT user calls `watch_device`
- `GET /api/devices/unread-counts` returns `COUNT(*)` of `chat_messages` with `id > last_read_id` per device
- Devices with no cursor row are treated as having zero read messages (all messages unread)

### Table: `user_preferences`

Per-user key-value preference store. Each row represents one preference setting for one IT user. Added in the account self-service update.

```sql
CREATE TABLE user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES it_users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                           -- Preference key (whitelisted)
  value TEXT NOT NULL,                         -- Preference value (stored as string)
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);

CREATE INDEX idx_user_prefs_user_id ON user_preferences(user_id);
```

**Indexes:**
- Unique constraint on `(user_id, key)` — one value per key per user; upsert replaces on conflict
- Index on `user_id` for fast per-user preference fetch

**Whitelisted keys:**
- `theme` — `"dark"` (default) | `"light"`
- `defaultPage` — dashboard landing page after login
- `itemsPerPage` — rows shown in paginated tables
- `dateFormat` — `"relative"` | `"absolute"`

**Behavior:**
- `GET /api/admin/user/preferences` returns all rows for the authenticated user as a flat `{ key: value }` object
- `PUT /api/admin/user/preferences` accepts a partial object; only whitelisted keys are written; uses `INSERT OR REPLACE` for each key
- Preferences are cached in `sessionStorage` after fetch; cache is invalidated and re-fetched on save
- `ON DELETE CASCADE` removes preferences when the owning IT user is deleted

### Table: `script_library` (updated v0.18.0)

The `script_library` table gains an `ai_tool` column in v0.18.0 to flag scripts that the AI assistant is permitted to suggest running.

```sql
-- New column added via migration in v0.18.0
ALTER TABLE script_library ADD COLUMN ai_tool INTEGER DEFAULT 0;
```

**`ai_tool` behavior:**
- `0` (default) — script is only available for manual IT-initiated execution
- `1` — script is included in the AI system prompt as an available action; AI may emit `[ACTION:RUN_SCRIPT:<id>]` referencing this script

## AI Script Toolbelt (v0.18.0)

Allows the AI assistant to suggest running pre-approved scripts from the script library on the device user's machine, with mandatory user consent before execution.

### System Prompt Injection

`diagnosticAI.js` queries all `ai_tool = 1` scripts from `script_library` before building the system prompt. These are passed to `systemPrompt.js` as the `aiToolScripts` parameter. When at least one AI-tool script exists, a conditional section is appended:

```
### 6. Run Library Scripts
You can run pre-approved scripts to resolve issues. Use: [ACTION:RUN_SCRIPT:<id>]
Available scripts:
- ID 42: "Clear Print Queue" — Stops and restarts the print spooler and clears stuck jobs (category: printing, elevated: true)
- ID 7: "Flush DNS and Reset Winsock" — Full network stack reset (category: network, elevated: true)
```

### Decision Engine Parsing

`server/ai/decisionEngine.js` parses `[ACTION:RUN_SCRIPT:<id>]` and produces:

```javascript
{ type: 'run_script', scriptId: 42 }
```

This action type is handled in `agentNamespace.js` after the LLM response is parsed.

### Consent Flow (Client)

`client/PocketIT/WebUI/chat.js` — `createScriptPrompt(scriptId, scriptName, aiInitiated)`:

- When `aiInitiated` is `true`: renders an "AI Script Request" card with a robot emoji and the text "AI assistant wants to run: [scriptName]"
- When `aiInitiated` is `false`: renders a standard "Script Execution Request" card (IT-initiated flow)
- Both variants present Approve/Deny buttons; no script runs without user approval

### Result Feedback Loop

On approval, the client executes the script and emits `script_result` with `aiInitiated: true`. `agentNamespace.js` detects the flag, looks up the pending request in the `pendingAIScripts` Map, and calls `diagnosticAI.processScriptResult(deviceId, scriptId, output)`. This builds a follow-up message to the LLM containing the script output so the AI can analyze the result and respond to the user.

The `pendingAIScripts` Map is keyed by `requestId` and cleaned up on `disconnect`.

## Script Library Admin Page (v0.18.0)

A new "Scripts" page under the Admin dropdown provides full CRUD management of the script library.

### Navigation

- Admin dropdown item: "Scripts" (renamed from "Script Library")
- Alphabetical order in dropdown: Clients, Scripts, Settings, Updates, Users, Wishlist

### UI Components

- **Category filter bar** — buttons to filter the script table by category; "All" shows everything
- **Script table** — columns: Name, Category, Elevated, Timeout, AI Tool, Actions (Edit / Delete)
- **Create/Edit form** — fields: name (required), description, PowerShell content (required, textarea), category, elevation toggle (`requires_elevation`), timeout (seconds), AI tool toggle (`ai_tool`)
- **Delete confirmation** — inline confirmation before removal

### API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/scripts` | IT | List all scripts; optional `?category=` filter |
| `POST` | `/api/scripts` | IT | Create script (name, description, content, category, requires_elevation, timeout, ai_tool) |
| `PATCH` | `/api/scripts/:id` | IT | Update allowed fields including `ai_tool` |
| `DELETE` | `/api/scripts/:id` | IT | Delete script |

## Move Device to Client (v0.18.0)

Allows admin users to reassign an enrolled device from one client to another without re-enrollment.

### Endpoint

`PATCH /api/devices/:id/client` — requires admin auth.

**Request body:**
```json
{ "clientId": 3 }
```

**Validation:**
- `clientId` must be a valid integer referencing an existing row in `clients`
- Returns 404 if device or target client does not exist
- Returns 400 if `clientId` is missing or invalid

**Behavior:**
- Updates `devices.client_id` to the new value
- Writes an audit log entry: `{ action: 'device_moved', actor: username, target: deviceId, details: { fromClientId, toClientId } }`
- Returns the updated device object

### Dashboard UI

- "Move to Client" button appears in the device detail danger zone, next to "Remove Device"
- Clicking opens a modal with a client picker dropdown (populated from `GET /api/clients`)
- Confirming the selection calls `PATCH /api/devices/:id/client` and reloads the device detail

## User Self-Service — "My Account" Page (v0.18.0)

All authenticated users (any role) can access a personal account management page. The page is reached by clicking the avatar circle (showing user initials) in the nav bar.

### Supported Operations

| Operation | Requirement | Endpoint |
|-----------|-------------|----------|
| View profile (display name, username, role) | Authenticated | `GET /api/admin/user/profile` |
| Update display name | Authenticated | `PUT /api/admin/user/profile` |
| Change password | Current password verification | `PUT /api/admin/user/password` |
| Regenerate own backup codes | Password verification | `POST /api/admin/user/2fa/backup-codes` |
| Reset own 2FA | Password verification | `POST /api/admin/user/2fa/reset` — clears TOTP secret; forces re-setup on next login |

All endpoints use `requireIT` middleware (any authenticated IT user). Password verification uses bcrypt compare against the stored hash before any sensitive operation is performed.

### Nav Bar Avatar

The avatar circle displays the user's initials derived from `display_name` (first letter of first and last word). Clicking navigates to the account page. The avatar and the existing "Connected" badge are ordered: badge left, avatar right.

## Theme System (v0.18.0)

The dashboard supports dark (default) and light themes via CSS custom properties.

### CSS Custom Properties

All structural dashboard CSS uses `var()` references. The following properties are defined on `:root` for dark (default) and overridden under `[data-theme="light"]`:

| Property | Dark value | Light value |
|----------|-----------|-------------|
| `--bg-primary` | `#1b2838` | `#f0f2f5` |
| `--bg-secondary` | `#2a3f5f` | `#ffffff` |
| `--text-primary` | `#c6d4df` | `#1a1a1a` |
| `--text-secondary` | `#8ba0b4` | `#555555` |
| (additional surface, border, accent vars) | ... | ... |

Theme is applied by setting `document.documentElement.setAttribute('data-theme', value)`.

### Persistence

- Theme preference stored in `user_preferences` table under key `theme` (`"dark"` | `"light"`)
- Fetched from `GET /api/admin/user/preferences` after login and applied immediately
- Cached in `sessionStorage` under `userPrefs` for instant re-apply without a round-trip on page navigation
- Toggle available on the account page; saved via `PUT /api/admin/user/preferences`

### Scope

All pages within `server/public/dashboard/` use the CSS custom properties, including the account page. No hardcoded color values remain in structural CSS rules.

### Dashboard CSS File

All dashboard CSS (~900 lines) is extracted into `server/public/dashboard/dashboard.css`. The `index.html` references it via a `<link>` tag. Checkbox inputs in settings and script library forms use the toggle switch pattern (`.toggle-switch` wrapping a checkbox with a `.toggle-track` span) rather than raw `<input type="checkbox">` elements.

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

### Check: `security`

**Data collected:**
- BitLocker encryption status per volume
- Windows Defender real-time protection state and signature age
- Firewall status per profile (Domain, Private, Public)
- Local administrator account list

**Implementation:** `SecurityCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var script = @"
        $bitlocker = Get-BitLockerVolume | Select-Object MountPoint, ProtectionStatus, EncryptionPercentage
        $defender = Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, AntivirusSignatureLastUpdated
        $firewall = Get-NetFirewallProfile | Select-Object Name, Enabled
        $admins = Get-LocalGroupMember -Group 'Administrators' | Select-Object Name, ObjectClass
        [PSCustomObject]@{
            BitLocker = $bitlocker
            Defender  = $defender
            Firewall  = $firewall
            LocalAdmins = $admins
        } | ConvertTo-Json -Depth 5
    ";

    var psi = new ProcessStartInfo
    {
        FileName = "powershell",
        Arguments = $"-NonInteractive -NoProfile -Command \"{script}\"",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        CreateNoWindow = true
    };

    using var process = Process.Start(psi)!;
    var output = await process.StandardOutput.ReadToEndAsync();
    await process.WaitForExitAsync();

    var data = JsonSerializer.Deserialize<JsonElement>(output);

    return new DiagnosticResult
    {
        CheckType = "security",
        Status = "completed",
        Data = data
    };
}
```

**Status determination:**
- `error` — BitLocker protection off on any volume, or Defender real-time protection disabled
- `warning` — any firewall profile disabled, or Defender signatures older than 7 days
- `ok` — all checks pass

**Example output:**

```json
{
  "checkType": "security",
  "status": "completed",
  "results": {
    "bitLocker": [
      { "mountPoint": "C:", "protectionStatus": "On", "encryptionPercentage": 100 }
    ],
    "defender": {
      "realTimeProtectionEnabled": true,
      "antivirusSignatureLastUpdated": "2024-01-15T03:00:00Z"
    },
    "firewall": [
      { "name": "Domain", "enabled": true },
      { "name": "Private", "enabled": true },
      { "name": "Public", "enabled": true }
    ],
    "localAdmins": [
      { "name": "CORP\\Administrator", "objectClass": "User" }
    ]
  }
}
```

### Check: `battery`

**Data collected:**
- Charge percentage
- Battery health percentage (full charge capacity vs. design capacity)
- Cycle count
- Design capacity (mWh)
- Full charge capacity (mWh)
- Estimated runtime (minutes)

Returns "No battery detected (desktop)" on machines without a battery.

**Implementation:** `BatteryCheck.cs`

```csharp
public async Task<DiagnosticResult> RunAsync()
{
    var batteries = new ManagementObjectSearcher(
        "SELECT * FROM Win32_Battery").Get();

    if (!batteries.Cast<ManagementObject>().Any())
    {
        return new DiagnosticResult
        {
            CheckType = "battery",
            Status = "completed",
            Data = new { message = "No battery detected (desktop)" }
        };
    }

    var designCapacities = new ManagementObjectSearcher(
        "SELECT * FROM BatteryStaticData",
        new ManagementScope("\\\\.\\root\\WMI")).Get();

    var fullCapacities = new ManagementObjectSearcher(
        "SELECT * FROM BatteryFullChargedCapacity",
        new ManagementScope("\\\\.\\root\\WMI")).Get();

    var results = batteries.Cast<ManagementObject>().Select(b => new
    {
        ChargePercent      = (ushort)b["EstimatedChargeRemaining"],
        CycleCount         = designCapacities.Cast<ManagementObject>()
                                .FirstOrDefault()?["CycleCount"],
        DesignCapacityMWh  = designCapacities.Cast<ManagementObject>()
                                .FirstOrDefault()?["DesignedCapacity"],
        FullCapacityMWh    = fullCapacities.Cast<ManagementObject>()
                                .FirstOrDefault()?["FullChargedCapacity"],
        EstimatedRuntimeMin = (uint)b["EstimatedRunTime"]
    }).ToList();

    var first = results.First();
    var healthPercent = first.DesignCapacityMWh is uint d && d > 0 && first.FullCapacityMWh is uint f
        ? (double)f / d * 100 : (double?)null;

    return new DiagnosticResult
    {
        CheckType = "battery",
        Status = "completed",
        Data = new { batteries = results, healthPercent }
    };
}
```

**Status determination:**
- `error` — health < 50% or charge < 10%
- `warning` — health < 80% or charge < 20%
- `ok` — otherwise

**Example output:**

```json
{
  "checkType": "battery",
  "status": "completed",
  "results": {
    "batteries": [
      {
        "chargePercent": 82,
        "cycleCount": 143,
        "designCapacityMWh": 86000,
        "fullCapacityMWh": 79000,
        "estimatedRuntimeMin": 210
      }
    ],
    "healthPercent": 91.9
  }
}
```

## Admin Elevation & Auto-Start (v0.11.0)

### Elevation

`client/PocketIT/app.manifest` declares `requestedExecutionLevel="requireAdministrator"`. Windows prompts for UAC consent once at first launch (or installation). All subsequent operations — including diagnostic checks, service management, and process kill — run with full administrator rights without per-action prompts.

### Auto-Start via Task Scheduler

`StartupManager.cs` registers a scheduled task on enrollment/first-run instead of a registry Run key:

```
schtasks /Create /TN "PocketIT" /TR "<exe_path>" /SC ONLOGON /RL HIGHEST /F
```

- `/RL HIGHEST` — task runs at highest available privilege; combined with the manifest, this means full administrator rights on login without UAC
- `/SC ONLOGON` — triggers for the logged-in user on each login
- `/F` — overwrites existing task silently

**Uninstall:** `pocket-it.iss` [UninstallRun] calls `schtasks /Delete /TN "PocketIT" /F` to clean up.

**Previous behavior (before v0.11.0):** Registry key `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` was used; this did not support elevated execution.

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

### Client-Scoped Access (v0.10.0)

IT technicians are scoped to one or more clients via the `user_client_assignments` table. The `resolveClientScope` middleware runs on every authenticated request and resolves one of two scope shapes:

- `{ isAdmin: true, clientIds: null }` — admin role; all devices and clients visible
- `{ isAdmin: false, clientIds: [1, 2] }` — technician; only devices belonging to listed clients visible
- `{ isAdmin: false, clientIds: [] }` — unassigned technician; sees no devices

All service methods that return lists (fleet, tickets, alerts, reports) accept an optional `scope` parameter. `scopeSQL(scope, alias)` returns a parameterized SQL fragment and bind values that are injected at query time. Socket.IO handlers in the `/it` namespace enforce scope on connection and on each device-specific event — unauthorized access attempts are silently ignored.

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
- Gemini API: 1-3 seconds

**Mitigation:**
- Show "typing" indicator in UI during LLM call
- Stream responses (future feature)
- Cache common responses (future feature)

## Security Threat Model

### Implemented Security Controls (current)

| Control | Implementation | Location |
|---------|---------------|----------|
| JWT secret required | In Docker mode (`POCKET_IT_DOCKER=true`): auto-generated 256-bit secret saved to `db/.jwt-secret` on first run; env var `POCKET_IT_JWT_SECRET` takes priority. In bare-metal mode: server exits on startup if neither is present (no hardcoded fallback) | `server.js:5-9`, `socket/itNamespace.js` |
| Docker mode guard | `POCKET_IT_DOCKER=true` disables git-based update features (server self-update, client release check, publish-local) with 501 responses; auto-set in `Dockerfile` | `server/server.js`, `server/routes/updates.js`, `server/services/serverUpdate.js` |
| Device DB validation | `requireDevice` middleware verifies device_id in database | `auth/middleware.js:17-31` |
| Device secret auth (Socket.IO) | Socket.IO handshake validates `device_secret` from enrollment; null secrets rejected | `socket/agentNamespace.js:23-35` |
| Device secret auth (HTTP) | `requireDevice` middleware validates `x-device-secret` header | `auth/middleware.js` |
| Device secret timing-safe compare | `crypto.timingSafeEqual` used for plaintext secret comparison (prevents timing attacks) | `auth/middleware.js` |
| Re-enrollment protection | Existing device_id returns 409 Conflict | `routes/enrollment.js:43-44` |
| Enrollment status check | `GET /api/enrollment/status/:deviceId` validates device with `x-device-secret` header | `routes/enrollment.js` |
| Ticket auth | `POST /api/tickets` requires authenticated device | `routes/tickets.js:29` |
| Prompt injection defense | Hardened `sanitizeForLLM()` strips injection markers, XML tags, and role markers; `sanitizeDiagnosticData()` recursively sanitizes JSON before LLM | `services/diagnosticAI.js` |
| XSS prevention | All user-controlled data in dashboard escaped via `escapeHtml()` | `public/dashboard/*.html` |
| Socket.IO chat rate limiting | 20 messages/minute per device | `socket/agentNamespace.js` |
| Chat message size limit | 10,000 character cap per message (prevents LLM cost abuse) | `socket/agentNamespace.js` |
| CORS hardened | No wildcard, no null origin, `file://` origin removed | `server.js` |
| Body size limit | 100KB max JSON payload | `server.js:63` |
| Account lockout | 5 failures → 15-minute lockout | `routes/admin.js:8-61` |
| LLM timeouts | 30s AbortController on HTTP calls | `services/llmService.js` |
| LLM API key transport | Gemini API key sent via `x-goog-api-key` header (not URL query parameter) | `services/llmService.js` |
| LLM error sanitization | Provider errors not forwarded verbatim to clients; generic message returned, full error logged server-side | `services/llmService.js`, `routes/` |
| LLM API keys encrypted at rest | AES-256-GCM via `server/config/encryption.js`; salt configurable via `POCKET_IT_ENCRYPTION_SALT` env var | `config/encryption.js`, `routes/admin.js` |
| Server-side action whitelist | Remediation actions validated before forwarding; centralized in `actionWhitelist.js` | `config/actionWhitelist.js` |
| Auto-remediate PID/service guard | IT Guidance auto-remediate validates PID range and service whitelist before executing | `socket/agentNamespace.js` |
| Critical service protection | `service_action` system tool blocks stop/restart of WinDefend, Sysmon, EventLog, and other security-critical services | `config/actionWhitelist.js` |
| Status/priority validation | Ticket PATCH validates enum values | `routes/tickets.js:76-84` |
| JWT secret fallback removed | Admin login route no longer has hardcoded fallback | `routes/admin.js` |
| Admin JWT fallback corrected | JWT decode failure in itNamespace defaults to `{ isAdmin: false, clientIds: [] }` | `socket/itNamespace.js` |
| Device secrets hashed at rest | bcrypt hashes stored in server DB; backward-compatible migration on startup | `db/schema.js` |
| Enrollment rate limiting | 5 requests per IP per 15 minutes | `routes/enrollment.js` |
| PowerShell Base64 encoding | Scripts passed via `-EncodedCommand` with Base64 (no string escaping) | `SecurityCheck.cs`, `BatteryCheck.cs` |
| DPAPI client credential protection | Device secret encrypted with Windows DPAPI in local SQLite | `Core/LocalDatabase.cs` |
| Device secret out of query string | Transmitted in Socket.IO `auth` object (not URL/query string) | `Core/ServerConnection.cs` |
| CSP `unsafe-inline` removed | `scriptSrc` and `scriptSrcAttr` no longer include `unsafe-inline` | `server.js` |
| Device secret sanitization | `GET /api/devices` and `GET /api/devices/:id` strip `device_secret` and `certificate_fingerprint` via `sanitizeDevice()` | `routes/devices.js` |
| Scoped integrity warnings | `integrity_warning` events emitted only to IT users whose scope includes the affected device | `socket/agentNamespace.js` |
| Chat history scope check | `GET /api/chat/:deviceId` returns 403 if device not in user's client scope | `routes/chat.js` |

### Security Audit Remediation (post-0.18.0)

The following controls were added following an internal security audit. Items are labeled by severity: **[C]** critical, **[H]** high, **[M]** medium, **[L]** low.

| ID | Area | Measure |
|----|------|---------|
| C1 | IT Guidance | Auto-remediate validates PID range and service whitelist before executing any action |
| C2 | Gemini provider | API key moved from URL query parameter to `x-goog-api-key` request header |
| H1 | Encryption | AES-256-GCM salt configurable via `POCKET_IT_ENCRYPTION_SALT`; warns on default value at startup |
| H2 | Device auth | Plaintext device secret comparison uses `crypto.timingSafeEqual` to prevent timing attacks |
| M1 | System tools | `service_action` blocks stop/restart of security-critical services (WinDefend, Sysmon, EventLog, etc.) |
| M2 | Error handling | IT Guidance error responses sanitized; internal details no longer leaked to clients |
| M3 | CORS | `file://` origin removed from allowed origins list |
| M4 | Chat input | Messages capped at 10,000 characters to prevent LLM cost abuse |
| L3 | Settings | DB size calculation fixed (incorrect destructuring was returning 0) |

### Threats and Mitigations

| Threat | Mitigation |
|--------|-----------|
| Malicious remediation actions | Hardcoded whitelist, user approval required, PID/service validation on auto-remediate |
| Unauthorized device enrollment | One-time tokens with expiration, 5 req/IP/15 min rate limit |
| Impersonation of IT staff | JWT authentication with TOTP (production) |
| Eavesdropping on chat | TLS encryption (production), mTLS (future) |
| Privilege escalation | Role-based access control for IT staff; JWT fallback defaults to no access |
| LLM prompt injection | Structured action parsing, no eval() of LLM output, hardened sanitizeForLLM() |
| Database injection | Parameterized queries (better-sqlite3 prepared statements) |
| Denial of service | Rate limiting on enrollment, chat rate limiting, message size cap |
| API key exposure | Keys encrypted at rest (AES-256-GCM), sent via headers not URL params |
| Timing attacks | `crypto.timingSafeEqual` for secret comparison |
| Critical service sabotage | Service action whitelist blocks stops of security-critical Windows services |

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
4. If the provider supports vision, add it to the `supportsVision` list in `diagnosticAI.js`
5. Add settings keys (`llm.<provider>.apiKey`, `llm.<provider>.model`) in `routes/admin.js` defaults, allowedKeys, and encrypt/decrypt flows
6. Add provider option and settings inputs to dashboard `index.html` and `dashboard.js`
7. Update documentation

## Testing Strategy

### Unit Tests (203 tests across 5 test files)

**Test files:**
- `security.test.js` (34 tests) — JWT secret requirement, device secret validation, re-enrollment protection, prompt injection defense, XSS prevention, Socket.IO rate limiting, CORS, body size limits, account lockout, LLM timeouts, server-side action whitelist, ticket status/priority validation
- `updates.test.js` (57 tests) — Upload, check, download, list, delete, push, fleet-versions endpoints; SHA-256 verification; version comparison logic
- `enrollment.test.js` (27 tests) — Token creation with client_id, enrollment flow, scope assignment, expiry and single-use enforcement
- `alertService.test.js` (54 tests) — Alert threshold evaluation, consecutive hit tracking, auto-resolve, notification dispatch
- `clientScope.test.js` (47 tests) — `resolveClientScope` middleware, `scopeSQL` helper, `isDeviceInScope` for all admin/tech/unassigned combinations

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
- LLM provider (Ollama, OpenAI API key, Anthropic API key, Gemini API key, or Claude CLI)

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

### Docker Deployment

The server supports containerized deployment via `Dockerfile` and `docker-compose.yml`. Set `POCKET_IT_DOCKER=true` to disable git-based features that require a `.git` directory.

**Quick start:**
```bash
docker compose up -d
```

**JWT secret:** Auto-generated on first run and saved to `db/.jwt-secret` (persisted via volume mount). To use an explicit secret, set `POCKET_IT_JWT_SECRET` env var — it takes priority over the file.

**Volumes:**
- `./data/db:/app/server/db` — SQLite database persistence
- `./data/updates:/app/server/updates` — Client installer packages

**Disabled in Docker mode (501 responses):**
- `GET /api/updates/server-check` — Use container image tags instead
- `POST /api/updates/server-apply` — Pull new image and recreate container
- `GET /api/updates/client-check` — Upload builds via `/api/updates/upload`
- `POST /api/updates/publish-local` — Upload builds via `/api/updates/upload`

**Ollama connectivity:** If Ollama runs on the Docker host, set `POCKET_IT_OLLAMA_URL=http://host.docker.internal:11434` (Docker Desktop) or `http://172.17.0.1:11434` (Linux).

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
- Task Scheduler task at `HIGHEST` privilege level via `schtasks /RL HIGHEST /SC ONLOGON` (v0.11.0+); no UAC prompt on login
- Previous: registry key `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` (replaced in v0.11.0)
- Startup folder shortcut (manual alternative)

## Version History

**Unreleased**
- Google Gemini LLM Provider: `_geminiChat()` in `llmService.js` using Gemini REST API with `systemInstruction`, multimodal `inlineData` for vision; env vars `POCKET_IT_GEMINI_API_KEY` and `POCKET_IT_GEMINI_MODEL` (default: `gemini-2.0-flash`); settings keys `llm.gemini.apiKey` and `llm.gemini.model`; `'gemini'` added to `supportsVision` list in `diagnosticAI.js`; "Google Gemini" option in dashboard provider dropdown with API key and model inputs
- Dashboard CSS extraction: inline `<style>` block (~900 lines) moved to `server/public/dashboard/dashboard.css`; `index.html` references it via `<link>`; checkbox inputs in settings and script library forms replaced with toggle switch markup (`.toggle-switch` / `.toggle-track` pattern)
- Client terminal notification fix: IT-initiated remote terminal sessions no longer send `terminal_session_ended` or `terminal_session_active` WebView messages to the end-user's chat window; only user-approved (consent-flow) terminal sessions produce chat notifications (`TrayApplication.cs`)

**0.18.0**
- AI Script Toolbelt: `ai_tool INTEGER DEFAULT 0` column on `script_library`; AI-tool scripts injected into system prompt as available actions; `[ACTION:RUN_SCRIPT:<id>]` parsed by decision engine; `pendingAIScripts` Map in `agentNamespace.js` tracks in-flight AI script requests; `processScriptResult()` in `diagnosticAI.js` feeds script output back to the LLM; client consent card distinguishes AI-initiated (robot emoji) from IT-initiated scripts
- Script Library Admin Page: "Scripts" page under Admin dropdown with full CRUD (create/edit form with `ai_tool` toggle, category filter bar, sortable table); admin dropdown alphabetized (Clients, Scripts, Settings, Updates, Users, Wishlist)
- Move Device to Client: `PATCH /api/devices/:id/client` (admin auth) updates `devices.client_id` with audit log; "Move to Client" button and client picker modal on device detail danger zone
- User Self-Service "My Account" Page: account page accessible from avatar circle in nav bar (all roles); supports display name update, password change, backup code regen, and 2FA reset (all sensitive ops require password verification)
- User Preferences System: `user_preferences (id, user_id, key, value, updated_at)` table; whitelisted keys: `theme`, `defaultPage`, `itemsPerPage`, `dateFormat`; `GET /api/admin/user/preferences` and `PUT /api/admin/user/preferences`; cached in `sessionStorage`
- Theme System: dark/light themes via CSS custom properties (`--bg-primary`, `--bg-secondary`, `--text-primary`, etc.); theme stored in `user_preferences`; applied via `data-theme` attribute on `:root`; account page fully themed
- Dashboard AI Control Fixes: AI button visual states (blue glow = Enabled, red glow = Temporary/Permanent); toast notifications on AI re-enable; new `device_ai_reenabled` socket event for cross-user sync
- MFA Management Enhancements: `backup_code_count` per user in admin users list; `POST /api/admin/users/:id/backup-codes` regenerates codes without resetting TOTP
- Database Size in Settings: `_dbSizeBytes` via `PRAGMA page_count * page_size` in settings API response; displayed as KB/MB
- OS Version Display: fleet cards and device detail prefer `os_name` (friendly) over raw `os_version`

**0.17.0**
- AI Disable System: `ai.enabled` key in `server_settings` for global toggle; `devices.ai_disabled` column (NULL | 'temporary' | 'permanent') and `devices.ai_disabled_by` for per-device control; `itActiveChatDevices` Map for transient IT-active auto-disable (5-minute pause); disable gate checked in order: global → per-device → IT-active; user messages saved and IT notified when AI is off
- New socket events: `ai_status` (server→/agent), `set_device_ai` (dashboard→/it), `device_ai_changed` (server→/it), `device_watchers` (server→/it), `device_watchers_changed` (server→/it)
- Fleet Unread Chat Badges: new `chat_read_cursors` table (it_user_id, device_id, last_read_id, updated_at); `GET /api/devices/unread-counts` endpoint; cursor updated on `watch_device`; orange unread badges on fleet device cards with live increment via `device_chat_update`
- IT User Presence: `deviceWatchers` Map on server; `device_watchers` sent on `watch_device`; `device_watchers_changed` broadcast on join/leave/disconnect; dashboard shows colored IT username pills on device pages
- Client RDP In/Out Alerts: `start_desktop` and `stop_desktop` events include `it_username`; client displays system chat messages on connect and disconnect
- Client Resizable Window + Dark Chrome: `FormBorderStyle.Sizable`, `MinimumSize(360, 500)`, `MaximizeBox = true`; DWM dark titlebar via `DwmSetWindowAttribute` (DWMWA_USE_IMMERSIVE_DARK_MODE); Mica backdrop on Win11 22H2+ with silent fallback
- Dashboard AI Controls: AI toggle on Settings page; AI control buttons (Enabled / Disable Temporarily / Disable Permanently) on Device page; real-time state sync via `device_ai_changed`

**0.13.0**
- Enhanced system information collection: 6 new hardware identity fields collected once on connect and stored in `devices` table (`device_manufacturer`, `device_model`, `form_factor`, `tpm_version`, `secure_boot`, `domain_join_type`)
- `DeviceIdentity.cs` extended: manufacturer and model via `wmic computersystem`, form factor from `Win32_SystemEnclosure` ChassisTypes mapping, TPM version via `Get-Tpm`, Secure Boot via `Confirm-SecureBootUEFI`, domain join type parsed from `dsregcmd /status`
- `SecurityCheck.cs` (new): composite PowerShell check covering BitLocker, Windows Defender, firewall profiles, and local administrator accounts; type: `security`
- `BatteryCheck.cs` (new): WMI/CIM check for charge%, health%, cycle count, design/full capacity, runtime; gracefully returns "No battery detected" on desktops; type: `battery`
- `DiagnosticsEngine.cs`: registers SecurityCheck and BatteryCheck (total diagnostic checks: 11)
- `agentNamespace.js`: stores 6 new hardware identity fields from `system_profile` event
- `db/schema.js`: v15 migration adds 6 new columns to `devices` table

**0.12.8**
- Current/previous user tracking: `previous_logged_in_users TEXT` column added to `devices`; `agentNamespace.js` saves old `logged_in_users` before overwriting; dashboard device cards show current user with 👤 icon; device detail shows "Current User" and "Previous User" stat cards
- `DeviceIdentity.cs`: `Environment.UserName` fallback when `query user` fails
- AI Screenshot Diagnostic: `[ACTION:SCREENSHOT]` in decision engine; server emits `screenshot_request` to client; client presents approval flow, captures at quality=40 scale=0.5f, emits `screenshot_result`; server routes image to AI (Anthropic/OpenAI/Gemini: base64 multimodal; Ollama/Claude CLI: text fallback); `systemPrompt.js` updated with screenshot capability
- Auto-push updates on connect: `agentNamespace.js` checks `update_packages` on device connect and emits `update_available` if client version is outdated
- Users Management Page: admin-only dashboard page with full CRUD; `PUT /api/admin/users/:id` (update display_name, role, or password); `DELETE /api/admin/users/:id` (with self-deletion guard and audit log)
- Admin Dropdown Navigation: Updates, Settings, Wishlist, Clients, and Users pages grouped under Admin dropdown; visible to `admin` and `superadmin` only; `navigateTo` guard prevents non-admin access
- Superadmin Role: `it_users.role` CHECK constraint updated to include `superadmin`; role hierarchy: `superadmin > admin > technician > viewer`; superadmin has full client access same as admin
- Network adapters duplication fix: `openDevice()` removes existing `.net-adapters` elements before inserting
- Form controls normalization: global dashboard CSS for consistent height (36px), padding, font-size, border-radius, focus highlight

**0.11.0**
- Self-update system: server hosts installer packages in `server/updates/`; tracked in new `update_packages` table (version, filename, file_size, sha256, release_notes, uploaded_by)
- Client `UpdateService.cs`: polls `GET /api/updates/check` every 4 hours and on connect; downloads to `%TEMP%\PocketIT-Update\`; verifies SHA-256 before launch; launches installer with `/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS`
- Client `AppVersion.cs`: reads application version from assembly attribute
- New `client_version TEXT` column on `devices` table; populated from Socket.IO `clientVersion` query param on connect
- New `server/routes/updates.js`: 8 endpoints — upload (multer multipart), check, download, list, delete, push, fleet-versions, latest
- Admin elevation: `app.manifest` sets `requestedExecutionLevel="requireAdministrator"`
- `StartupManager.cs`: replaced registry Run key with Task Scheduler (`schtasks /RL HIGHEST /SC ONLOGON`) for elevated auto-start without UAC prompt
- `pocket-it.iss`: creates scheduled task in `[Run]`; removes task in `[UninstallRun]`
- Dashboard: Updates management page (upload form, fleet version stats, package table, push-to-fleet)
- Dashboard: column sorting on Processes, Services, Event Log tables; event log search input; services auto-load on tab switch
- Security: `sanitizeDevice()` helper in `devices.js` strips `device_secret` and `certificate_fingerprint` from all device API responses
- Test suite expanded to 219 total tests: `updates.test.js` (57), `enrollment.test.js` (27), `alertService.test.js` (54), `clientScope.test.js` (47); fixed pre-existing schema ordering bug in test helpers
- DEPS: Added `multer` ^1.4.5

**0.10.0**
- Client-based multi-tenancy (MSP model): devices organized by client, IT technicians scoped to assigned clients
- New `clients` table (id, name, slug, contact_name, contact_email, notes) with Default client seed
- New `user_client_assignments` table for many-to-many user-to-client mapping
- New `client_id` column on `devices` and `enrollment_tokens` tables
- `resolveClientScope` middleware: resolves `{ isAdmin, clientIds }` scope from JWT claims per request
- `scopeSQL` helper: generates SQL WHERE clause fragment to filter by client scope
- `emitToScoped()` Socket.IO helper: targets only in-scope /it sockets using device-client cache
- Full client CRUD REST API (`/api/clients`): create, read, update, delete clients
- User assignment REST API: assign/unassign IT technicians to clients
- Per-client installer download: `GET /api/clients/:id/installer` returns pre-configured ZIP with enrollment token
- All fleet, ticket, alert, and report service methods accept optional `scope` param
- /it namespace: scope resolved on connect, all 16+ device event handlers enforce scope
- /agent namespace: all ~23 `io.of('/it').emit()` calls replaced with `emitToScoped()`
- Login responses include `clients` array; admin stats are scope-aware
- Enrollment token creation requires `client_id`; device auto-assigned to client on enroll
- Dashboard: client selector dropdown in nav, grouped fleet view, Clients admin page

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
