# Architecture Overview

## Server Stack

- **Node.js + Express.js** — HTTP server and REST API
- **Socket.IO** — Real-time bidirectional communication (two namespaces: `/agent` and `/it`)
- **SQLite via better-sqlite3** — Persistent storage for devices, tickets, users, chat, and settings
- **Helmet.js** — Security headers (CSP, HSTS, etc.)
- **JWT + bcrypt** — Authentication for IT staff; bcrypt-hashed device secrets for client auth

## Key Directories

```
server/
  server.js           # Main Express app, middleware setup, service initialization
  wrapper.js          # Process wrapper — restarts server on exit code 75 (self-update)
  seed-admin.js       # CLI tool to create the initial admin user
  auth/               # JWT middleware, device auth, client scope resolution
  db/                 # SQLite schema migrations and database initialization
  routes/             # Express route handlers (enrollment, devices, tickets, admin, etc.)
  services/           # Business logic (LLM providers, alerts, reports, scheduler, server update)
  socket/             # Socket.IO namespace handlers and scoped broadcast helper
  ai/                 # System prompts, diagnostic AI conversation management, decision engine
  public/             # Static dashboard HTML, CSS, and JavaScript
```

## Socket Namespaces

### /agent

Client devices connect to this namespace on startup.

Key events (device -> server):
- `heartbeat` — Keep-alive ping
- `chat_message` — User sends a message to the AI assistant
- `diagnostic_result` — Results of a requested diagnostic check
- `remediation_result` — Outcome of a user-approved remediation action
- `system_tool_result` — Output from a system tool request (processes, services, event log)
- `screenshot_result` — Screenshot captured after user approval (for AI visual diagnosis)
- `desktop_frame` — Encoded screen frame for remote desktop sessions

Key events (server -> device):
- `chat_response` — AI assistant reply
- `diagnostic_request` — Server requests a specific diagnostic check
- `remediation_request` — Server requests user approval for a remediation action
- `update_available` — Notifies device a client update is ready
- `start_desktop` / `stop_desktop` — Control remote desktop capture
- `system_tool_request` — Request system tool execution
- `ai_status` — AI enabled/disabled state for this device

### /it

The IT dashboard connects to this namespace after login.

Key events (dashboard -> server):
- `watch_device` / `unwatch_device` — Subscribe to real-time events for a specific device
- `chat_to_device` — IT technician sends a message to a device
- `request_diagnostic` — Trigger a diagnostic check on a device
- `start_desktop` / `stop_desktop` — Initiate or end a remote desktop session
- `set_device_ai` — Change per-device AI mode (enabled, temporary disable, permanent disable)

Key events (server -> dashboard):
- `device_status_changed` — Device came online or went offline
- `device_chat_update` — New chat message on a device
- `device_diagnostic_update` — Diagnostic check completed
- `ticket_created` — New support ticket raised
- `desktop_frame` — Relayed screen frame from a device
- `device_watchers_changed` — Another IT user started or stopped watching a device
- `server_url_changed` — Admin updated the server's public URL

## Authentication Flow

1. Admin logs in via `POST /api/admin/login` with username and password
2. Server validates credentials and returns a signed JWT (24-hour expiry)
3. If 2FA is enabled, the token is not yet valid — the user must complete TOTP verification via `POST /api/admin/verify-2fa`
4. The dashboard stores the token in `sessionStorage` and sends it as a `Bearer` token in the `Authorization` header on all subsequent requests
5. Localhost (`127.0.0.1` / `::1`) requests bypass authentication for development use

Device authentication uses a separate mechanism: a unique `device_secret` is generated at enrollment, stored as a bcrypt hash on the server, and sent in the Socket.IO `auth` object on every connection.

## Client Scoping

Multi-tenant support is built into the data layer. Each IT user can be assigned to one or more client organizations. All device queries, ticket lists, alert feeds, and Socket.IO broadcasts are filtered through the user's client scope before reaching the dashboard.

The `resolveClientScope` middleware computes the scope at request time. Superadmin and admin roles see all clients. Technicians see only their assigned clients.

## Data Flow

```
Client Device  ->  Socket.IO /agent  ->  Server  ->  Socket.IO /it  ->  Dashboard
Dashboard      ->  REST API           ->  Server  ->  SQLite DB
Dashboard      ->  Socket.IO /it      ->  Server  ->  Socket.IO /agent  ->  Client Device
```

The server acts as the hub for all communication. Client devices never communicate directly with the dashboard, and the dashboard never connects to devices directly. All routing passes through server-side namespace handlers.
