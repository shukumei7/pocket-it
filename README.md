# Pocket IT

AI-powered IT helpdesk system tray application that provides instant technical support to end users through conversational AI. Users can chat with a friendly AI assistant that can diagnose issues, suggest automated fixes, and escalate complex problems to IT staff.

## Overview

Pocket IT consists of two components:

- **Client**: .NET 8 WinForms system tray application with WebView2-based chat interface
- **Server**: Node.js backend with Express, Socket.IO, and SQLite database

The AI assistant can run diagnostics, suggest whitelisted remediation actions (with user approval), and create support tickets. Each device is assigned a deterministic AI personality from a pool of 20 names for a consistent, human-like experience.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Client (Windows System Tray App)                           │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐      │
│  │  WinForms  │  │   WebView2   │  │  Socket.IO    │      │
│  │  Tray Icon │→ │  Chat UI     │→ │  Client       │      │
│  └────────────┘  └──────────────┘  └───────┬───────┘      │
└───────────────────────────────────────────┼────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Server (Node.js)                                            │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐      │
│  │  Socket.IO │→ │  DiagnosticAI│→ │  LLM Service  │      │
│  │  Namespaces│  │   Service    │  │  (4 providers)│      │
│  └────────────┘  └──────────────┘  └───────────────┘      │
│  ┌────────────┐  ┌──────────────┐                          │
│  │  Express   │  │   SQLite DB  │                          │
│  │  REST API  │  │  (8 tables)  │                          │
│  └────────────┘  └──────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### Communication Flow

```
User types message
    ↓
WebView2 JavaScript (chat.js)
    ↓
C# WebView2 Message Handler (ChatWindow.cs)
    ↓
Socket.IO emit "chat_message" to /agent namespace
    ↓
Server agentNamespace.js receives message
    ↓
DiagnosticAI processes via LLM (with system prompt + conversation history)
    ↓
Decision engine parses response for action tags
    ↓
Server emits "chat_response" back to client
    │
    ├→ [ACTION:DIAGNOSE] → emit "diagnostic_request" → client runs check → "diagnostic_result" → AI interprets
    ├→ [ACTION:REMEDIATE] → emit "remediation_request" → user approves → "remediation_result"
    └→ [ACTION:TICKET] → create ticket in DB → notify /it namespace
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Client UI | .NET 8 WinForms + WebView2 | System tray app with HTML/CSS/JS chat interface |
| Client Networking | SocketIOClient 3.1.1 | Real-time bidirectional communication |
| Client Database | Microsoft.Data.Sqlite | Local message queue and settings |
| Server Runtime | Node.js (Express 4.21) | HTTP and WebSocket server |
| Server WebSockets | Socket.IO 4.7 | Two namespaces: /agent and /it |
| Server Database | SQLite (better-sqlite3) | 8 tables for devices, tickets, chat, diagnostics |
| LLM Providers | Ollama, OpenAI, Anthropic, Claude CLI | Flexible AI backend (4 provider options) |
| Authentication | JWT (jsonwebtoken 9.0) | IT staff authentication (MVP: localhost bypass) |

## Quick Start

### Server Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env to configure LLM provider
node server.js
```

Server runs on **port 9100** by default.

**Environment variables (all prefixed with `POCKET_IT_`):**

```bash
POCKET_IT_PORT=9100
POCKET_IT_LLM_PROVIDER=ollama           # ollama | openai | anthropic | claude-cli
POCKET_IT_OLLAMA_URL=http://localhost:11434
POCKET_IT_OLLAMA_MODEL=llama3.2
POCKET_IT_OPENAI_API_KEY=               # Required if provider=openai
POCKET_IT_OPENAI_MODEL=gpt-4o-mini
POCKET_IT_ANTHROPIC_API_KEY=            # Required if provider=anthropic
POCKET_IT_ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
POCKET_IT_CLAUDE_CLI_MODEL=             # Optional, uses default if empty
POCKET_IT_JWT_SECRET=change-me-in-production
```

### Client Setup

```bash
cd client/PocketIT
dotnet restore
dotnet build
dotnet run
```

**Prerequisites:**
- .NET 8 SDK
- WebView2 Runtime (usually pre-installed on Windows 10/11)

**Configuration (`appsettings.json`):**

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
  }
}
```

### First Run: Device Enrollment

1. Start the server
2. Generate an enrollment token:
   ```bash
   curl -X POST http://localhost:9100/api/enrollment/token
   ```
3. Copy the token into client's `appsettings.json` under `Enrollment.Token`
4. Start the client — it will auto-enroll on first connection
5. Token is single-use and expires in 24 hours

## Remote Deployment

Push-install Pocket IT to multiple Windows machines using PowerShell Remoting (WinRM) with pre-seeded enrollment tokens for zero-touch deployment.

### Prerequisites

- **WinRM enabled on target machines** — Default on domain-joined Windows systems. See "Enabling WinRM" below.
- **.NET 8 runtime** installed on target machines
- **Client must be built first:**
  ```bash
  cd client/PocketIT
  dotnet publish -c Release
  ```

### Usage Examples

**Deploy to a single machine:**
```powershell
.\deploy\Deploy-PocketIT.ps1 -ComputerName WS-042 -ServerUrl http://10.0.0.5:9100
```

**Deploy to multiple machines from a text file:**
```powershell
Get-Content .\deploy\targets.txt | .\deploy\Deploy-PocketIT.ps1 -ServerUrl http://10.0.0.5:9100 -AutoLaunch
```

**Deploy with explicit AD credentials:**
```powershell
$cred = Get-Credential DOMAIN\Admin
.\deploy\Deploy-PocketIT.ps1 -ComputerName WS-042,WS-043 -ServerUrl http://10.0.0.5:9100 -Credential $cred
```

**Force reinstall on machine with existing installation:**
```powershell
.\deploy\Deploy-PocketIT.ps1 -ComputerName WS-042 -ServerUrl http://10.0.0.5:9100 -Force
```

### What It Does

The deployment script performs these steps automatically:

1. **Tests WinRM connectivity** to target machine
2. **Generates enrollment token** from server API (or uses provided token)
3. **Copies client files** to `C:\Program Files\PocketIT` (or custom install path)
4. **Pre-seeds `appsettings.json`** with server URL and enrollment token
5. **Creates startup shortcut** in All Users startup folder
6. **Adds Windows Firewall rule** for outbound connections

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `-ComputerName` | `string[]` | Target machine names or IPs (accepts pipeline input) |
| `-ServerUrl` | `string` | Pocket IT server URL (e.g., `http://10.0.0.5:9100`) |
| `-BuildPath` | `string` | Path to published client folder (auto-detected if omitted) |
| `-Token` | `string` | Enrollment token (auto-generated from server if omitted) |
| `-InstallPath` | `string` | Remote install path (default: `C:\Program Files\PocketIT`) |
| `-Credential` | `PSCredential` | Credentials for remote access (uses current user if omitted) |
| `-AutoLaunch` | `switch` | Launch Pocket IT on target after installation |
| `-Force` | `switch` | Overwrite existing installation without prompting |

### Enabling WinRM on Target Machines

**On individual machines:**
```powershell
Enable-PSRemoting -Force
```

**Via Group Policy:**
```
Computer Configuration → Administrative Templates → Windows Components → Windows Remote Management (WinRM) → WinRM Service
→ Enable "Allow remote server management through WinRM"
```

**Verify WinRM is enabled:**
```powershell
Test-WSMan -ComputerName WS-042
```

## Building the Installer

For enterprise deployment, Pocket IT includes an Inno Setup installer that creates a self-contained, production-ready package.

### Prerequisites

- .NET 8.0 SDK
- Inno Setup 6 ([download](https://jrsoftware.org/isdl.php))

### Build

```bash
cd installer
build.bat
```

**Output:** `installer/output/PocketIT-0.2.0-setup.exe`

### Silent Deployment (for IT Admins)

```bash
# Silent install (shows progress bar)
PocketIT-0.2.0-setup.exe /SILENT

# Fully silent (no UI at all)
PocketIT-0.2.0-setup.exe /VERYSILENT /SUPPRESSMSGBOXES

# Custom install directory
PocketIT-0.2.0-setup.exe /SILENT /DIR="C:\PocketIT"
```

### What the Installer Does

- Installs self-contained app to Program Files (no .NET runtime needed)
- Optional auto-start on Windows login (registry Run key, enabled by default)
- Preserves `appsettings.json` on upgrade (IT config not overwritten)
- WebView2 runtime check (pre-installed on Win10 21H2+ / Win11)
- Clean uninstall removes app + local database

### Client Configuration

After install, edit `appsettings.json` in the install directory:

- `Server.Url` — Pocket IT server address (default: `http://localhost:9100`)
- `Enrollment.Token` — One-time enrollment token from the dashboard

## LLM Provider Options

Pocket IT supports four LLM providers. Choose based on your requirements:

### 1. Ollama (Default)
**Best for:** Privacy, no API costs, local inference

```bash
POCKET_IT_LLM_PROVIDER=ollama
POCKET_IT_OLLAMA_URL=http://localhost:11434
POCKET_IT_OLLAMA_MODEL=llama3.2
```

Install Ollama and pull a model:
```bash
ollama pull llama3.2
```

### 2. OpenAI
**Best for:** Highest quality responses, GPT-4 reasoning

```bash
POCKET_IT_LLM_PROVIDER=openai
POCKET_IT_OPENAI_API_KEY=sk-...
POCKET_IT_OPENAI_MODEL=gpt-4o-mini
```

### 3. Anthropic
**Best for:** Claude models via API, strong reasoning and safety

```bash
POCKET_IT_LLM_PROVIDER=anthropic
POCKET_IT_ANTHROPIC_API_KEY=sk-ant-...
POCKET_IT_ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
```

### 4. Claude CLI
**Best for:** Claude Desktop users, uses `claude -p` pipe mode

```bash
POCKET_IT_LLM_PROVIDER=claude-cli
POCKET_IT_CLAUDE_CLI_MODEL=          # Optional, uses default
```

Requires [Claude Desktop](https://claude.ai/download) with CLI support.

## API Endpoints

All endpoints accept `localhost` without authentication for MVP development.

### Health
- `GET /health` — Health check

### Enrollment
- `POST /api/enrollment/token` — Generate enrollment token (admin)
- `POST /api/enrollment/enroll` — Enroll device with token
- `GET /api/enrollment/status/:deviceId` — Check enrollment status (requires `x-device-secret` header)

### Authentication
- `POST /api/auth/login` — IT staff login (returns JWT token)

### Devices
- `GET /api/devices` — List all devices (IT auth)
- `GET /api/devices/:id` — Get device details with hardware specs and health score (IT auth)
- `GET /api/devices/:id/diagnostics` — Get diagnostic history (IT auth)
- `GET /api/devices/health/summary` — Get fleet health summary (IT auth)
- `DELETE /api/devices/:id` — Remove device and all related data (admin auth)

### Tickets
- `GET /api/tickets?status=open` — List tickets, optional status filter (IT auth)
- `GET /api/tickets/:id` — Get ticket with comments (IT auth)
- `POST /api/tickets` — Create ticket (no auth required)
- `PATCH /api/tickets/:id` — Update ticket status/priority/assignment (IT auth)
- `POST /api/tickets/:id/comments` — Add comment to ticket (IT auth)

### Chat
- `GET /api/chat/:deviceId/history` — Get chat history (IT auth)

### LLM
- `GET /api/llm/config` — Current LLM provider and model
- `GET /api/llm/models` — Available models for current provider

### Admin
- `GET /api/admin/stats` — System statistics including average health and critical devices (admin auth)

### Reports
- `GET /api/reports/fleet/health-trend?days=7` — Fleet average health per day
- `GET /api/reports/device/:id/metrics?check_type=cpu&days=30` — Device metric trend
- `GET /api/reports/device/:id/health-history?days=30` — Device health over time
- `GET /api/reports/alerts/summary?days=30` — Alert statistics
- `GET /api/reports/tickets/summary?days=30` — Ticket statistics
- `GET /api/reports/export?type=fleet_health&days=30&format=csv` — Export CSV/PDF
- `GET /api/reports/schedules` — List scheduled reports
- `POST /api/reports/schedules` — Create scheduled report
- `PATCH /api/reports/schedules/:id` — Update schedule
- `DELETE /api/reports/schedules/:id` — Delete schedule
- `GET /api/reports/history` — Report generation history

## Socket.IO Namespaces

### /agent (Device Clients)

**Client events:**
- `chat_message` — User sends message: `{ content: string }`
- `diagnostic_result` — Diagnostic check results: `{ checkType, status, results }`
- `remediation_result` — Remediation action result: `{ actionId, success, message }`
- `system_tool_result` — System tool execution result: `{ requestId, tool, success, data, error }`
- `heartbeat` — Keep-alive ping
- `desktop_started` — Confirms desktop session is active
- `desktop_frame` — Encoded screen frame: `{ frame: base64 JPEG }`
- `desktop_stopped` — Desktop session ended
- `desktop_denied` — Desktop access denied by client

**Server events:**
- `agent_info` — Assigned agent name (sent on connect and with each chat response): `{ agentName: string }`
- `chat_history` — Last 20 messages sent on connection: `{ messages: array }`
- `chat_response` — AI response: `{ text, sender, agentName, action }`
- `diagnostic_request` — Request diagnostic check: `{ checkType, requestId }`
- `remediation_request` — Request remediation approval: `{ actionId, requestId }`
- `start_desktop` — Start desktop capture session: `{ quality, fps, scale }`
- `desktop_mouse` — Mouse input event: `{ type, x, y, button, delta }`
- `desktop_keyboard` — Keyboard input event: `{ type, keyCode }`
- `desktop_quality` — Adjust capture settings: `{ quality, fps, scale }`
- `stop_desktop` — Stop desktop capture session
- `system_tool_request` — Request system tool execution: `{ requestId, tool, params }`

### /it (IT Staff Dashboard)

**Client events:**
- `watch_device` — Subscribe to device updates: `{ deviceId }`
- `unwatch_device` — Unsubscribe: `{ deviceId }`
- `chat_to_device` — IT sends message to device: `{ deviceId, content }`
- `request_diagnostic` — Request diagnostic from device: `{ deviceId, checkType }`
- `start_desktop` — Start remote desktop session: `{ deviceId, quality, fps, scale }`
- `desktop_mouse` — Send mouse input to device: `{ deviceId, type, x, y, button, delta }`
- `desktop_keyboard` — Send keyboard input to device: `{ deviceId, type, keyCode }`
- `desktop_quality` — Change capture quality/FPS/scale: `{ deviceId, quality, fps, scale }`
- `stop_desktop` — Stop remote desktop session: `{ deviceId }`
- `system_tool_request` — Forward tool request to a device: `{ deviceId, requestId, tool, params }`

**Server events:**
- `device_status` — Device status update: `{ deviceId, status, ... }`
- `device_chat_history` — Chat history: `{ deviceId, messages }`
- `device_chat_update` — New chat message: `{ deviceId, message, response }`
- `device_diagnostic_update` — Diagnostic completed: `{ deviceId, checkType, results }`
- `device_remediation_update` — Remediation completed: `{ deviceId, success, message }`
- `device_status_changed` — Device online/offline: `{ deviceId, status }`
- `ticket_created` — New ticket: `{ id, deviceId, title, priority }`
- `desktop_started` — Desktop session active: `{ deviceId }`
- `desktop_frame` — Screen frame relay: `{ deviceId, frame: base64 JPEG }`
- `desktop_stopped` — Desktop session ended: `{ deviceId }`
- `desktop_denied` — Device denied desktop access: `{ deviceId }`
- `system_tool_result` — Tool result relayed from device: `{ deviceId, requestId, tool, success, data, error }`

## Database Schema

The server uses SQLite with 8 tables:

| Table | Purpose |
|-------|---------|
| `devices` | Enrolled devices (device_id, hostname, os_version, status, cpu_model, total_ram_gb, total_disk_gb, processor_count, health_score, enrolled_at, last_seen, + 12 extended profile fields: os_edition, os_build, os_architecture, bios_manufacturer, bios_version, gpu_model, serial_number, domain, last_boot_time, uptime_hours, logged_in_users, network_adapters) |
| `enrollment_tokens` | One-time enrollment tokens (token, expires_at, status, used_by_device) |
| `it_users` | IT staff accounts (username, password_hash, role, last_login) |
| `chat_messages` | Chat history (device_id, sender, content, message_type, metadata) |
| `tickets` | Support tickets (device_id, title, status, priority, assigned_to, ai_summary) |
| `ticket_comments` | Ticket comments (ticket_id, author, content) |
| `diagnostic_results` | Diagnostic check results (device_id, check_type, status, data) |
| `audit_log` | System audit trail (actor, action, target, details) |

## AI Personality System

Each device is assigned a deterministic AI personality based on a hash of its `device_id`. The same device always gets the same agent name, creating consistency.

**Name pool (20 names):**
Rick, Mabel, Jordan, Casey, Morgan, Alex, Sam, Taylor, Quinn, Avery, Robin, Jamie, Drew, Sage, Reese, Parker, Blake, Riley, Skyler, Dana

**AI personality traits:**
- Warm, approachable, patient
- Plain language (avoids jargon unless user seems technical)
- Encouraging and reassuring
- Concise but thorough
- Conversational tone with variation

## Remote Terminal

IT admins can open interactive PowerShell sessions on managed endpoints directly from the dashboard. This feature enables real-time command execution for advanced troubleshooting and system administration tasks.

**Key features:**
- **User consent required** — endpoint users must approve terminal access before session starts
- **Real-time I/O** — live terminal interaction via Socket.IO with xterm.js terminal UI in dashboard
- **Line-buffered input** — command execution on Enter key press with local echo support
- **Auto-disconnect** — sessions automatically end after 15 minutes of inactivity
- **Bidirectional control** — either party (IT admin or endpoint user) can end the session at any time
- **Audit logging** — all terminal session events (start, stop, deny) logged to audit trail
- **Ctrl+C support** — send break signals to interrupt running processes
- **Visual indicators** — active session status badge in dashboard and banner in client chat

**Security notes:**
- Terminal sessions run under the client application's user context (not SYSTEM)
- PowerShell execution policy applies to all commands
- Consent denial is logged and notifies the IT admin immediately
- Session timeout prevents abandoned connections from remaining open

## Reports & Analytics

IT admins can generate comprehensive reports and analytics to track fleet health, alerts, and ticket trends over time. The dashboard provides interactive visualizations with drill-down capabilities.

**Key features:**
- **Fleet health trends** — Average health score over time (7, 30, 90 days)
- **Device metrics** — Individual device performance trends (CPU, memory, disk, network)
- **Alert summaries** — Alert counts by severity, status, and device
- **Ticket summaries** — Ticket volume by status, priority, and category
- **Export capabilities** — Download reports as CSV or PDF
- **Scheduled reports** — Automated report generation with cron expressions
- **Report history** — Track all generated reports with timestamps and parameters
- **Chart.js visualizations** — Interactive line, bar, and pie charts in dashboard

**Report types:**
- `fleet_health` — Fleet average health score per day
- `device_metrics` — Specific device metric trends (CPU/memory/disk/network)
- `device_health_history` — Device health score over time
- `alert_summary` — Alert statistics by severity and status
- `ticket_summary` — Ticket statistics by status and priority

**Scheduled reports:**
Create recurring reports with cron expressions (e.g., `0 9 * * 1` for weekly Monday 9am reports). Reports are automatically generated and stored in history with export links.

## Whitelisted Remediation Actions

The client only executes actions from a hardcoded whitelist:

| Action ID | Description | Implementation |
|-----------|-------------|----------------|
| `flush_dns` | Flush DNS resolver cache | `ipconfig /flushdns` |
| `clear_temp` | Clear temporary files | Deletes files in `%TEMP%` older than 7 days |
| `restart_spooler` | Restart Windows Print Spooler service | `net stop spooler && net start spooler` |
| `repair_network` | Full network stack repair | Winsock reset, TCP/IP reset, DNS flush, IP release/renew |
| `clear_browser_cache` | Clear browser cache files | Deletes cache for Chrome, Edge, Firefox |

**User approval required:** All remediation actions require explicit user consent via an "Approve" button in the UI.

## Diagnostic Checks

The client can run four types of diagnostic checks:

| Check Type | Data Collected |
|------------|----------------|
| `cpu` | CPU usage percentage, top 5 processes by CPU |
| `memory` | RAM usage, available memory, top 5 processes by memory |
| `disk` | Disk space on all drives (total, free, percentage used) |
| `network` | Adapter status, internet connectivity, DNS resolution |

**Usage:** AI can request checks using action tag `[ACTION:DIAGNOSE:checkType]`. Results are sent back to AI for interpretation.

## Offline Behavior

**Message queueing:** When the server is unreachable, user messages are queued locally in the SQLite database and automatically synced when the connection is restored.

**Offline responses:** The chat UI displays friendly rotating offline responses to let users know their message was saved. Each response includes contact information for alternative IT support channels (phone, email, support portal).

**Configurable contacts:** Offline contact information is configured per deployment in `appsettings.json` under the `OfflineContacts` section. This allows IT administrators to customize phone numbers, email addresses, and portal URLs for their organization.

**Connection state tracking:** The UI displays connection status (Connected/Disconnected) and adapts behavior automatically. When offline, AI responses are replaced with helpful offline messages directing users to alternative support options.

## Security

Pocket IT prioritizes security and integrity at every layer:

### Authentication & Authorization
- **JWT required** — `POCKET_IT_JWT_SECRET` must be set (server refuses to start without it)
- **Device enrollment** — one-time tokens with 24-hour expiry; re-enrollment of existing devices rejected
- **Device secrets** — unique `device_secret` generated at enrollment, validated on every Socket.IO connection
- **IT staff auth** — JWT Bearer tokens with role-based access (admin/technician/viewer)
- **Localhost bypass** — development only; remote access requires full auth

### Input Validation & Integrity
- **Parameterized SQL** — all database queries use prepared statements
- **Body size limit** — 100KB max on JSON payloads
- **CORS whitelist** — specific origins only (no wildcard, no null)
- **Ticket validation** — status and priority values validated against allowed enums
- **Prompt injection defense** — user messages wrapped in `<user_message>` tags

### Rate Limiting & Abuse Prevention
- **API rate limit** — 100 requests per 15 minutes per IP
- **Auth rate limit** — 10 attempts per 15 minutes per IP
- **Account lockout** — 5 failed logins locks account for 15 minutes
- **LLM timeouts** — 30-second abort on all LLM HTTP calls

### Remediation Safety
- **Hardcoded whitelist** — only `flush_dns` and `clear_temp` allowed (client AND server)
- **User approval required** — no action executes without explicit user consent
- **Server-side validation** — AI-suggested actions checked against whitelist before forwarding to client
- **Audit logging** — all remediation executions logged to `audit_log` table

## Security Model

**MVP scope (localhost bypass):**
- Requests from `127.0.0.1` or `::1` bypass all authentication
- Production deployment should use JWT for IT staff and device certificates

**Production roadmap:**
- Device authentication via mTLS certificates
- IT staff JWT authentication with role-based access control (admin/technician/viewer)
- TOTP 2FA for admin actions
- Network-level restrictions (firewall rules, VPN)

## Project Structure

```
pocket-it/
├── deploy/
│   ├── Deploy-PocketIT.ps1      # Remote deployment via PS Remoting
│   └── targets.example.txt      # Example target machines list
├── server/
│   ├── server.js                 # Main entry point
│   ├── package.json              # Dependencies
│   ├── .env.example              # Environment template
│   ├── db/
│   │   └── schema.js             # Database initialization
│   ├── services/
│   │   ├── llmService.js         # Multi-provider LLM abstraction
│   │   └── diagnosticAI.js       # Conversation management + AI decision logic
│   ├── ai/
│   │   ├── systemPrompt.js       # Agent personality + capabilities
│   │   └── decisionEngine.js     # Parse action tags from responses
│   ├── socket/
│   │   ├── index.js              # Socket.IO setup
│   │   ├── agentNamespace.js     # /agent namespace (device clients)
│   │   └── itNamespace.js        # /it namespace (IT dashboard)
│   ├── routes/
│   │   ├── enrollment.js         # Token generation and device enrollment
│   │   ├── devices.js            # Device management
│   │   ├── tickets.js            # Ticket CRUD
│   │   ├── chat.js               # Chat history
│   │   ├── llm.js                # LLM config endpoints
│   │   └── admin.js              # Admin stats
│   ├── auth/
│   │   └── middleware.js         # Auth middleware (localhost bypass)
│   └── public/
│       └── dashboard/            # IT staff web dashboard (future)
└── client/
    └── PocketIT/
        ├── PocketIT.csproj       # .NET project file
        ├── Program.cs            # Entry point (single instance mutex)
        ├── TrayApplication.cs    # System tray icon and context menu
        ├── ChatWindow.cs         # WebView2 form window
        ├── appsettings.json      # Configuration
        ├── Core/
        │   ├── DeviceIdentity.cs # Generate device ID from hardware
        │   ├── ServerConnection.cs # Socket.IO connection manager
        │   └── LocalDatabase.cs  # SQLite for offline queue
        ├── Diagnostics/
        │   ├── DiagnosticsEngine.cs  # Coordinate checks
        │   ├── IDiagnosticCheck.cs   # Check interface
        │   └── Checks/
        │       ├── CpuCheck.cs
        │       ├── MemoryCheck.cs
        │       ├── DiskCheck.cs
        │       └── NetworkCheck.cs
        ├── SystemTools/
        │   ├── ISystemTool.cs            # Interface + SystemToolResult
        │   ├── SystemToolsEngine.cs      # Tool registry + dispatch
        │   └── Tools/
        │       ├── ProcessListTool.cs    # All processes via WMI with owner
        │       ├── ProcessKillTool.cs    # Kill by PID with safety checks
        │       ├── ServiceListTool.cs    # All Windows services with filter
        │       ├── ServiceActionTool.cs  # Start/Stop/Restart services
        │       └── EventLogQueryTool.cs  # Flexible event log query
        ├── Remediation/
        │   ├── RemediationEngine.cs      # Execute whitelisted actions
        │   ├── IRemediationAction.cs     # Action interface
        │   ├── ActionWhitelist.cs        # Hardcoded whitelist
        │   └── Actions/
        │       ├── FlushDnsAction.cs
        │       └── ClearTempFilesAction.cs
        ├── Enrollment/
        │   └── EnrollmentFlow.cs         # Device enrollment on first run
        └── WebUI/
            ├── index.html                # Chat interface (enrollment)
            ├── chat.html                 # Chat interface (main)
            ├── chat.css
            └── chat.js                   # WebView2 JavaScript
```

## Current Status (v0.9.0)

### Completed
- AI chat with 4 LLM providers (Ollama, OpenAI, Anthropic, Claude CLI)
- Device enrollment with one-time tokens
- Device secret authentication on Socket.IO connections (required, no legacy null secrets allowed)
- 10 diagnostic checks (CPU, memory, disk, network, top_processes, event_log, windows_update, installed_software, services, system profile)
- 7 whitelisted remediation actions (flush DNS, clear temp, restart spooler, repair network, clear browser cache, kill process, restart service)
- **Real device diagnostics**: auto-collect system profile (CPU model, RAM, disk, cores) on connect
- **Health scoring system**: 0-100 score computed from all 8 check types (ok=100, warning=50, error=0)
- **Health dashboard**: colored health bars, hardware info display, average health stats
- **AI hardware context**: diagnostics include CPU/RAM/disk specs for better recommendations
- **Proactive monitoring**: scheduled diagnostics (15-minute interval), alert thresholds with consecutive hit tracking
- **Notification channels**: webhook, Slack, and Teams notifications with retry logic
- **Dashboard Alerts tab**: real-time alert updates, acknowledge/resolve actions, threshold configuration, notification channel management
- **Remote terminal**: IT admins can open interactive PowerShell sessions with user consent, 15-minute idle timeout, Ctrl+C support
- **Remote desktop**: IT admins can view and control device screens in real time via GDI+ frame streaming to an HTML5 Canvas viewer, with mouse and keyboard relay
- **Reports & Analytics**: fleet health trends, device metrics, alert/ticket summaries, CSV/PDF export, scheduled reports with cron
- **System Tools Engine**: generic `system_tool_request`/`system_tool_result` socket event pattern with 5 tools: process_list, process_kill, service_list, service_action, event_log_query
- **Enhanced Device Profile**: 12 new fields collected on connect — GPU, serial number, BIOS, OS edition/build/architecture, domain, uptime, logged-in users, network adapters
- **Dashboard System Tools tab**: tabbed UI (Processes, Services, Event Log) for live system inspection from the IT dashboard
- Support ticket system with IT staff escalation
- Offline message queueing with IT contact fallback
- Remote deployment via PowerShell/WinRM
- IT staff dashboard (Fleet, Tickets, Enrollment, Alerts, System Tools) with login overlay for remote access
- Security hardening: JWT required, rate limiting, account lockout, CORS whitelist, input validation, prompt injection defense, server-side action whitelist, XSS prevention, Socket.IO chat rate limiting
- Device removal with cascade delete (chat messages, diagnostics)
- Chat history on reconnect (last 20 messages)
- Full ticket detail view with comments and status/priority editing
- 50+ tests (34 security unit tests + 16 E2E smoke tests)

### Setup

**Server:**
```bash
cd server
cp .env.example .env
# Edit .env — set POCKET_IT_JWT_SECRET (required)
node seed-admin.js --username admin --password <your-password>
npm install
node server.js
```

**Client (requires .NET 8 SDK):**
```bash
cd client/PocketIT
dotnet build
# Configure appsettings.json with server URL and enrollment token
dotnet run
```

### Known Limitations
- No HTTPS (plaintext transport)
- Devices enrolled before v0.1.1 require re-enrollment (null device_secret connections now rejected)
- .NET 8 SDK required for client build (not included in .NET 6)

## MVP Scope

**Current features:**
- AI chat interface with 4 LLM provider options
- Deterministic AI personality assignment
- 4 diagnostic checks (CPU, memory, disk, network)
- 2 whitelisted remediation actions (flush_dns, clear_temp)
- Support ticket creation and management
- IT staff can watch devices and view chat history
- Device online/offline status tracking
- Localhost authentication bypass for development

## Roadmap

### Delivered
| Version | Theme | Highlights |
|---------|-------|------------|
| v0.1.0 | Core MVP | AI chat, device enrollment, basic diagnostics, 2 remediation actions |
| v0.1.4 | Dashboard & Actions | IT dashboard login, ticket detail views, 3 more remediation actions |
| v0.2.0 | Real Diagnostics | System profiling, health scoring, auto-diagnostics on connect |
| v0.2.1 | Reliability | File-based logger, config validation, elevation checks |
| v0.3.0 | Expanded Capabilities | 5 new diagnostic checks, parameterized remediation, kill_process, restart_service |
| v0.4.0 | Proactive Monitoring | Scheduled diagnostics, alert thresholds, notifications (webhook/Slack/Teams), dashboard alerts tab |
| v0.6.0 | Remote Terminal | Interactive PowerShell sessions, user consent flow, xterm.js UI, 15-minute timeout |
| v0.7.0 | Reporting & Analytics | Fleet health trends, device metrics, alert/ticket summaries, CSV/PDF export, scheduled reports |
| v0.8.0 | Remote Desktop | Real-time screen view and control, GDI+ frame streaming, mouse/keyboard relay, configurable quality/FPS/scale |
| v0.9.0 | System Tools & Enhanced Device Info | System Tools Engine (process_list, process_kill, service_list, service_action, event_log_query), 12 new device profile fields, dashboard System Tools tab |

### Planned
| Version | Theme | Key Capabilities |
|---------|-------|-----------------|
| v0.5.0 | Remote Execution & File Access | Auto-remediation policies, IT-admin file browser, remote PowerShell script execution |
| v1.0.0 | Patch & Software Management | Trigger Windows Update, remote install/uninstall, compliance policies |
| v1.1.0 | Knowledge Base | Searchable KB, AI references KB in responses, IT staff curated solutions |
| v1.2.0 | Multi-tenant & RBAC | Organizations, role-based permissions, IT team management |
| v1.3.0 | Production Ready | mTLS device certs, audit compliance, MSI installer packaging |

## Development

**Server:**
```bash
cd server
npm run dev
```

**Client:**
```bash
cd client/PocketIT
dotnet watch run
```

**Health check:**
```bash
curl http://localhost:9100/health
```

**Generate enrollment token:**
```bash
curl -X POST http://localhost:9100/api/enrollment/token
```

**Run tests:**
```bash
cd server
npm test                    # Security unit tests (34)
npm run test:e2e           # E2E smoke tests (16)
```

## License

Proprietary. Not licensed for redistribution.

## Authors

Developed for sysadmin use case: providing instant AI-powered IT support to end users while maintaining control over remediation actions and escalation paths.
