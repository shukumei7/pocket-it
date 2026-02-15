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

### Devices
- `GET /api/devices` — List all devices (IT auth)
- `GET /api/devices/:id` — Get device details (IT auth)
- `GET /api/devices/:id/diagnostics` — Get diagnostic history (IT auth)

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
- `GET /api/admin/stats` — System statistics (admin auth)

## Socket.IO Namespaces

### /agent (Device Clients)

**Client events:**
- `chat_message` — User sends message: `{ content: string }`
- `diagnostic_result` — Diagnostic check results: `{ checkType, status, results }`
- `remediation_result` — Remediation action result: `{ actionId, success, message }`
- `heartbeat` — Keep-alive ping

**Server events:**
- `agent_info` — Assigned agent name: `{ agentName: string }`
- `chat_response` — AI response: `{ text, sender, agentName, action }`
- `diagnostic_request` — Request diagnostic check: `{ checkType, requestId }`
- `remediation_request` — Request remediation approval: `{ actionId, requestId }`

### /it (IT Staff Dashboard)

**Client events:**
- `watch_device` — Subscribe to device updates: `{ deviceId }`
- `unwatch_device` — Unsubscribe: `{ deviceId }`
- `chat_to_device` — IT sends message to device: `{ deviceId, content }`
- `request_diagnostic` — Request diagnostic from device: `{ deviceId, checkType }`

**Server events:**
- `device_status` — Device status update: `{ deviceId, status, ... }`
- `device_chat_history` — Chat history: `{ deviceId, messages }`
- `device_chat_update` — New chat message: `{ deviceId, message, response }`
- `device_diagnostic_update` — Diagnostic completed: `{ deviceId, checkType, results }`
- `device_remediation_update` — Remediation completed: `{ deviceId, success, message }`
- `device_status_changed` — Device online/offline: `{ deviceId, status }`
- `ticket_created` — New ticket: `{ id, deviceId, title, priority }`

## Database Schema

The server uses SQLite with 8 tables:

| Table | Purpose |
|-------|---------|
| `devices` | Enrolled devices (device_id, hostname, os_version, status, enrolled_at, last_seen) |
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

## Whitelisted Remediation Actions

The client only executes actions from a hardcoded whitelist:

| Action ID | Description | Implementation |
|-----------|-------------|----------------|
| `flush_dns` | Flush DNS resolver cache | `ipconfig /flushdns` |
| `clear_temp` | Clear temporary files | Deletes files in `%TEMP%` older than 7 days |

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

## Current Status (v0.1.1)

### Completed
- AI chat with 4 LLM providers (Ollama, OpenAI, Anthropic, Claude CLI)
- Device enrollment with one-time tokens
- Device secret authentication on Socket.IO connections
- 4 diagnostic checks (CPU, memory, disk, network)
- 2 whitelisted remediation actions (flush DNS, clear temp)
- Support ticket system with IT staff escalation
- Offline message queueing with IT contact fallback
- Remote deployment via PowerShell/WinRM
- Security hardening: JWT required, rate limiting, account lockout, CORS whitelist, input validation, prompt injection defense, server-side action whitelist

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
- No IT staff web dashboard (planned)
- Devices enrolled before v0.1.1 have no device_secret (backwards-compatible but weaker auth)
- .NET 8 SDK required for client build (not included in .NET 6)
- Only 2 remediation actions available

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

**Phase 2 roadmap:**
- IT staff dashboard (web UI)
- Remote IT staff access with JWT authentication
- Device certificate authentication (mTLS)
- Additional remediation actions (restart services, update drivers)
- Proactive monitoring and alerting
- Knowledge base integration
- Multi-language support
- Mobile app for IT staff

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

## License

Proprietary. Not licensed for redistribution.

## Authors

Developed for sysadmin use case: providing instant AI-powered IT support to end users while maintaining control over remediation actions and escalation paths.
