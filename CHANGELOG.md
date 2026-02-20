# Changelog

All notable changes to Pocket IT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/1.0.0/).

## [Unreleased]

### Added
- **Periodic git-based client release detection** — server runs `git fetch origin main` every 24 hours, checks whether `releases/version.json` has changed, sparse-checkouts the updated release files, registers the new build in `update_packages`, and pushes `update_available` to all outdated connected devices; no server restart required
- **Manual client update check endpoint** — `GET /api/updates/client-check` (IT auth) triggers the git-based release check on demand and returns `{ updated, version?, notified?, reason? }`
- **Expected Version card on Updates page** — dashboard Updates page now shows the latest registered client version, fleet status (X up to date, Y outdated), and a "Check for Client Update" button for manual trigger

### Technical
- EDIT: `server/services/serverUpdate.js` — exported `checkClientRelease(db)` and `isNewerVersion` for use by the scheduled timer and the manual-check route
- EDIT: `server/routes/updates.js` — new `GET /api/updates/client-check` route (IT auth) calls `checkClientRelease` and returns result JSON
- EDIT: `server/public/dashboard/index.html` — Expected Version card added to Updates page with fleet up-to-date/outdated counts and manual check button

## [0.13.4] - 2026-02-19

### Security
- **Prompt injection defense hardened** — `sanitizeForLLM()` in `diagnosticAI.js` now strips prompt injection markers (`IGNORE`, `SYSTEM`, `OVERRIDE`, etc.), XML-like tags (`<system>`, `<prompt>`, etc.), and role markers (`[INST]`, `<<SYS>>`, etc.); new `sanitizeDiagnosticData()` recursively sanitizes JSON diagnostic objects before they reach the LLM
- **Admin fallback corrected** — JWT decode failure in `itNamespace.js` now defaults to `{ isAdmin: false, clientIds: [] }` instead of granting full admin access
- **Centralized action/service whitelist** — `VALID_ACTIONS` and `ALLOWED_SERVICES` extracted into `server/config/actionWhitelist.js` (single source of truth); all consumers import from this module
- **Scoped integrity warnings** — `integrity_warning` events are now emitted via `emitToScoped` so only IT users whose scope includes the affected device receive them
- **Chat history scope check** — `GET /api/chat/:deviceId` returns 403 if the requesting user does not have the device in their client scope
- **Device secrets hashed at rest** — Device secrets are now stored as bcrypt hashes in the server DB; backward-compatible migration hashes existing plaintext secrets on startup
- **Enrollment rate limiting** — Enrollment endpoint (`POST /api/enrollment/enroll`) is now rate-limited to 5 requests per IP per 15 minutes
- **PowerShell Base64 encoding** — `SecurityCheck.cs` and `BatteryCheck.cs` now pass PowerShell scripts via `-EncodedCommand` with Base64 instead of string escaping
- **DPAPI client credential protection** — Device secret is now encrypted with Windows DPAPI (`ProtectedData.Protect`) in `LocalDatabase.cs` before being written to the local SQLite database
- **Device secret moved out of query string** — Device secret is transmitted in the Socket.IO `auth` object rather than the query string, keeping it out of server logs and URL history
- **CSP `unsafe-inline` removed** — `scriptSrc` and `scriptSrcAttr` in `server.js` helmet configuration no longer include `unsafe-inline`
- **LLM API keys encrypted at rest** — API keys stored in settings are encrypted using AES-256-GCM via the new `server/config/encryption.js` module
- **LLM error sanitization** — LLM provider errors are no longer forwarded verbatim to clients; a generic error message is returned while the full error is logged server-side

### Technical
- NEW: `server/config/actionWhitelist.js` — centralized `VALID_ACTIONS` and `ALLOWED_SERVICES` constants
- NEW: `server/config/encryption.js` — AES-256-GCM `encrypt()` / `decrypt()` helpers for settings secrets
- EDIT: `server/services/diagnosticAI.js` — hardened `sanitizeForLLM()`; added recursive `sanitizeDiagnosticData()`
- EDIT: `server/socket/itNamespace.js` — JWT decode failure defaults to `{ isAdmin: false, clientIds: [] }`; imports `actionWhitelist.js`
- EDIT: `server/socket/agentNamespace.js` — device secret read from Socket.IO `auth` object; imports `actionWhitelist.js`
- EDIT: `server/routes/chat.js` — scope check added to `GET /api/chat/:deviceId`
- EDIT: `server/routes/enrollment.js` — 5 req/IP/15 min rate limit applied to enroll endpoint
- EDIT: `server/auth/middleware.js` — imports `actionWhitelist.js` for validation
- EDIT: `server/db/schema.js` — startup migration hashes any plaintext device secrets with bcrypt
- EDIT: `server/routes/admin.js` — LLM API keys encrypted via `encryption.js` before persistence
- EDIT: `server/server.js` — removed `unsafe-inline` from CSP `scriptSrc` and `scriptSrcAttr`
- EDIT: `client/PocketIT/Diagnostics/Checks/SecurityCheck.cs` — PowerShell uses `-EncodedCommand` with Base64
- EDIT: `client/PocketIT/Diagnostics/Checks/BatteryCheck.cs` — PowerShell uses `-EncodedCommand` with Base64
- EDIT: `client/PocketIT/Core/LocalDatabase.cs` — device secret encrypted with DPAPI before storage
- EDIT: `client/PocketIT/Core/ServerConnection.cs` — device secret sent in Socket.IO `auth` object, not query string
- EDIT: `client/PocketIT/PocketIT.csproj` — added `System.Security.Cryptography.ProtectedData` package reference
- DEPS: Added `bcrypt` for server-side device secret hashing

## [0.12.8] - 2026-02-19

### Added
- **Current/Previous User Tracking** — Device cards in the dashboard now show the currently logged-in user with a 👤 icon; device detail page shows "Current User" and "Previous User" stat cards
- **AI Screenshot Diagnostic** — AI can now request a screenshot from the client for visual diagnosis; client presents a user approval flow before capturing; screenshot is sent to AI for multimodal analysis; providers that do not support vision (Ollama) receive a text fallback
- **`[ACTION:SCREENSHOT]` decision engine action** — Added to the AI decision engine so the system prompt can instruct the LLM to request a screenshot; Anthropic and OpenAI providers receive the image as base64; Claude CLI and Ollama receive a descriptive text fallback
- **Users Management Page** — New admin-only page in the dashboard under the Admin dropdown; supports full CRUD: create user (username, display name, password, role), inline edit (display name, role), reset password, and delete user
- **Admin Dropdown Navigation** — Updates, Settings, Wishlist, Clients, and Users pages are now grouped under a single "Admin" dropdown in the nav bar, visible only to `admin` and `superadmin` roles; non-admin users cannot navigate to admin pages
- **Superadmin Role** — New role added above admin in the hierarchy (`superadmin > admin > technician > viewer`); superadmin receives full client access identical to admin

### Changed
- **`DeviceIdentity.cs` user detection** — Falls back to `Environment.UserName` when the `query user` command fails (e.g., on headless or non-interactive sessions), ensuring `logged_in_users` is always populated
- **Auto-push updates on device connect** — Server now checks `update_packages` on device connect and emits `update_available` if the connecting client version is outdated; clients no longer need to wait for the 4-hour poll or a manual admin push
- **Form controls normalization** — Global CSS applied to all dashboard inputs, selects, and textareas: consistent 36px height, padding, margin, font-size, border-radius, `outline:none`, and blue focus highlight (`#66c0f4`)

### Fixed
- **Network adapters duplication** — `openDevice()` in the dashboard now removes existing `.net-adapters` elements before inserting new ones, preventing duplicate adapter sections when re-opening a device detail panel

### Technical
- EDIT: `server/db/schema.js` — Added `previous_logged_in_users TEXT` column to `devices` table; updated `it_users.role` CHECK constraint to include `superadmin`
- EDIT: `server/socket/agentNamespace.js` — Saves old `logged_in_users` to `previous_logged_in_users` before overwriting; checks `update_packages` on connect and emits `update_available` to outdated clients
- EDIT: `client/PocketIT/Core/DeviceIdentity.cs` — `Environment.UserName` fallback when `query user` fails
- EDIT: `server/ai/decisionEngine.js` — Added `SCREENSHOT` action type parsing
- EDIT: `server/services/llmService.js` — Multimodal support for Anthropic and OpenAI (base64 image); text fallback for Ollama and Claude CLI
- EDIT: `server/ai/systemPrompt.js` — Documented screenshot capability for AI
- EDIT: `server/socket/agentNamespace.js` — `screenshot_result` handler; routes captured image into AI context
- EDIT: `client/PocketIT/Core/ServerConnection.cs` — `screenshot_request` event handler; user approval flow; captures screen at quality=40, scale=0.5f
- EDIT: `server/routes/admin.js` — `PUT /api/admin/users/:id` (update display_name, role, or password); `DELETE /api/admin/users/:id` (with self-deletion guard and audit log)
- EDIT: `server/public/dashboard/index.html` — Users management page; Admin dropdown nav; current/previous user display; network adapter deduplication fix; form controls CSS normalization
- CLIENT: Version bumped to **v0.12.8**

## [0.11.0] - 2026-02-17

### Added
- **Self-Update System** — Server can host installer packages; clients poll every 4 hours and check on connect, download updates with SHA-256 verification, and launch installer silently (`/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS`)
- **Updates Management Dashboard Page** — Upload form, fleet version distribution stats, package table, and push-to-fleet button
- **Fleet Version Stats** — `GET /api/updates/fleet-versions` returns version distribution across all enrolled devices
- **Admin Elevation** — Client now runs as administrator via `app.manifest` `requestedExecutionLevel="requireAdministrator"`
- **Task Scheduler Auto-Start** — Elevated auto-start on login via `schtasks /RL HIGHEST /SC ONLOGON`, replacing registry Run key; no UAC prompt on startup
- **Column Sorting** — Processes, Services, and Event Log tables in dashboard support clickable column headers with sort direction indicators (▲/▼)
- **Event Log Search** — Filter event log entries by Event ID, source, or message text
- **Services Auto-Load** — Services tab now loads automatically on first switch (was requiring manual Refresh click)
- `multer` dependency added for multipart file upload handling

### Changed
- **Client version tracking** — Client sends `clientVersion` via Socket.IO query params on connect; value saved to `devices.client_version` column
- **Installer uses Task Scheduler** — `pocket-it.iss` creates a scheduled task at `HIGHEST` privilege level instead of a registry Run key; uninstall removes the task

### Fixed
- **Device credential leakage** — `GET /api/devices` and `GET /api/devices/:id` no longer include `device_secret` or `certificate_fingerprint` in API responses; a `sanitizeDevice()` helper strips these fields before returning data

### Technical
- NEW: `server/routes/updates.js` — 8 endpoints: upload, check, download, list, delete, push, fleet-versions, latest
- NEW: `client/PocketIT/Core/UpdateService.cs` — 4-hour polling loop, on-connect check, SHA-256 verification, downloads to `%TEMP%\PocketIT-Update\`, launches installer
- NEW: `client/PocketIT/Core/AppVersion.cs` — Reads application version from assembly attribute
- NEW: `client/PocketIT/app.manifest` — `requestedExecutionLevel="requireAdministrator"`
- NEW: `server/updates/` — Directory where update packages are stored on disk
- EDIT: `server/routes/devices.js` — Added `sanitizeDevice()` helper; applied to all device list and detail responses
- EDIT: `server/db/schema.js` — Added `client_version TEXT` column to `devices` table; new `update_packages` table
- EDIT: `server/server.js` — Register `/api/updates` routes
- EDIT: `server/socket/agentNamespace.js` — Read `clientVersion` from Socket.IO query params, persist to `devices.client_version`
- EDIT: `client/PocketIT/Core/ServerConnection.cs` — Pass `clientVersion` in Socket.IO query params; wire update check events
- EDIT: `client/PocketIT/TrayApplication.cs` — Instantiate and start `UpdateService`
- EDIT: `client/PocketIT/Core/StartupManager.cs` — Replace registry Run key with Task Scheduler via `schtasks`
- EDIT: `installer/pocket-it.iss` — Create scheduled task in `[Run]` section, remove task in `[UninstallRun]`
- EDIT: `client/PocketIT/PocketIT.csproj` — Reference `app.manifest`
- EDIT: `server/public/dashboard/index.html` — Updates management page; column sorting on Processes/Services/Event Log; event log search input; services auto-load on tab switch
- DEPS: Added `multer` ^1.4.5
- TEST: 219 total tests (was ~34); new files: `updates.test.js` (57), `enrollment.test.js` (27), `alertService.test.js` (54), `clientScope.test.js` (47)

## [0.10.0] - 2026-02-17

### Added
- **Client-Based Multi-Tenancy (MSP Model)** — Devices are organized by client (company/organization); IT technicians only see devices belonging to their assigned clients; admins see everything
- **Client CRUD API** — Full REST API for managing clients: create, read, update, delete; with slug generation, contact info, and notes fields
- **User-to-Client Assignment** — Admins can assign/unassign IT technicians to clients; unassigned technicians see zero devices
- **Scope Middleware** — `resolveClientScope` middleware resolves per-request access scope from JWT claims; `scopeSQL` injects WHERE clause fragments for filtering; `isDeviceInScope` for per-device authorization checks
- **Scoped Socket.IO Broadcasts** — `emitToScoped()` helper targets only IT sockets whose scope includes a given device; device-client mapping cached in-process for fast lookup
- **Per-Client Installer Download** — Admin can download a pre-configured installer ZIP per client (`GET /api/clients/:id/installer`), bundling the enrollment token and client assignment
- **Dashboard Client Selector** — Nav bar dropdown to filter the entire dashboard by client (admin: "All Clients" + individual; tech: assigned clients only)
- **Dashboard Clients Management Page** — Admin-only page for full client CRUD, user assignment, and per-client installer download
- **Fleet Grouped View** — When "All Clients" selected by admin, fleet page groups devices under client headers
- **Enrollment Client Picker** — Enrollment token creation now includes a client picker dropdown; `client_id` is stored on the token and propagated to the device on enroll
- **Default Client Seed** — On first run (empty clients table), a "Default" client is seeded and all existing devices/tokens are auto-assigned to it
- **`archiver` dependency** — ZIP creation for per-client installer download endpoint

### Changed
- **Enrollment token creation requires `client_id`** — `POST /api/enrollment/token` body must include `client_id`; enrolled device is automatically assigned to that client
- **Login response includes `clients` array** — `POST /api/admin/login` and `POST /api/admin/auto-login` responses now include a `clients` array (admin: all clients; tech: assigned clients)
- **Stats endpoint is scope-aware** — `GET /api/admin/stats` returns counts scoped to the requesting user's assigned clients
- **All device, ticket, alert, and report list endpoints are scope-filtered** — technicians only receive records belonging to their assigned clients
- **Socket.IO /it namespace** — Scope resolved on connect and stored as `socket.userScope`; all 16+ device-specific event handlers enforce scope before forwarding; fleet-wide events (e.g. `alert_stats_updated`) still broadcast to all
- **Socket.IO /agent namespace** — All ~23 `io.of('/it').emit()` calls replaced with `emitToScoped()` to restrict broadcasts to in-scope IT sockets

### Technical
- NEW: `server/auth/clientScope.js` — `resolveClientScope` middleware, `scopeSQL` helper, `isDeviceInScope` check
- NEW: `server/routes/clients.js` — Client CRUD endpoints, user assignment endpoints, per-client installer download
- NEW: `server/socket/scopedEmit.js` — `emitToScoped(io, deviceId, event, data)` with device-client cache
- EDIT: `server/db/schema.js` — Added `clients` table, `user_client_assignments` table, `client_id` column on `devices` and `enrollment_tokens`, indexes, Default client seed migration
- EDIT: `server/server.js` — Register `/api/clients` routes
- EDIT: `server/services/fleetService.js` — Optional `scope` param on `getAllDevices`, `getOnlineCount`, `getTotalCount`, `getHealthSummary`
- EDIT: `server/services/ticketService.js` — Optional `scope` param on `getOpenCount`, `getTotalCount` (JOINs through devices)
- EDIT: `server/services/alertService.js` — Optional `scope` param on `getStats`, `getActiveAlerts`, `getAlertHistory`
- EDIT: `server/services/reportService.js` — Optional `scope` param on `getFleetHealthTrend`, `getAlertSummary`, `getTicketSummary`
- EDIT: `server/routes/devices.js` — Scope filter on `GET /`, scope check on `GET /:id`, `GET /:id/diagnostics`, `DELETE /:id`
- EDIT: `server/routes/enrollment.js` — `client_id` required on token creation; auto-assign device to client on enroll
- EDIT: `server/routes/admin.js` — Scoped stats; `clients` array included in login response
- EDIT: `server/routes/tickets.js` — Scope filter via device JOIN
- EDIT: `server/routes/alerts.js` — Scope filter via alertService
- EDIT: `server/routes/reports.js` — Scope filter on all report endpoints
- EDIT: `server/socket/itNamespace.js` — Scope resolution on connect, scope guard on all 16+ handlers
- EDIT: `server/socket/agentNamespace.js` — All ~23 `io.of('/it').emit()` calls replaced with `emitToScoped()`
- DEPS: Added `archiver` ^7.0.0

## [0.9.0] - 2026-02-17

### Added
- **System Tools Engine** — generic `system_tool_request`/`system_tool_result` socket event pattern for extensible remote management tools
- **Process Manager** — view all processes with PID, name, CPU%, memory, user; kill processes with safety-blocked list
- **Service Manager** — list all Windows services with status and start type; start/stop/restart services remotely
- **Event Log Viewer** — query Windows Event Log with flexible filters (log name, level, time range, source)
- **Enhanced Device Profile** — 12 new system fields: OS edition, build, architecture, BIOS manufacturer/version, GPU model, serial number, domain, last boot time, uptime, logged-in users, network adapters
- **Dashboard System Tools tab** — tabbed interface (Processes, Services, Event Log) with inline controls
- **Dashboard info cards expansion** — GPU, serial number, BIOS, domain, uptime, network adapters in device detail view
- Auto-refresh for process list (10-second interval toggle)
- Service filter by status (All/Running/Stopped) and local search
- Event log preset buttons ("Errors 24h", "Critical 7d")

### Changed
- System profile handler now saves 12 additional columns to the devices table
- Database schema includes v0.9.0 migration columns for enhanced device data

## [0.8.0] - 2026-02-16

### Added
- Remote Desktop — IT staff can view and control a device's desktop remotely from the dashboard
- Screen capture via GDI+ CopyFromScreen with configurable quality (Low/Medium/High), scale (25%/50%/75%/100%), and frame rate (5/10/15/24 FPS)
- HTML5 Canvas viewer in dashboard with live frame rendering
- Mouse input relay: click, right-click, middle-click, move, and scroll events forwarded to client
- Keyboard input relay: key down/up events mapped to Windows virtual key codes via SendInput
- 15-minute idle timeout with automatic session teardown on client
- IT-initiated session (starts without user consent, consistent with terminal feature)

### Technical
- NEW: `client/PocketIT/Desktop/ScreenCaptureService.cs` — GDI+ screen capture with configurable quality and scale
- NEW: `client/PocketIT/Desktop/InputInjectionService.cs` — Win32 SendInput P/Invoke for mouse and keyboard injection
- NEW: `client/PocketIT/Desktop/RemoteDesktopService.cs` — capture loop orchestrator and session lifecycle management
- EDIT: `client/PocketIT/Core/ServerConnection.cs` — desktop socket event wiring
- EDIT: `client/PocketIT/TrayApplication.cs` — desktop event handlers
- EDIT: `server/socket/agentNamespace.js` — relay desktop frames from /agent to /it namespace
- EDIT: `server/socket/itNamespace.js` — relay desktop control events from /it to /agent namespace
- EDIT: `server/public/dashboard/index.html` — Remote Desktop viewer section with Canvas, quality/FPS/scale controls

## [0.7.0] - 2026-02-16

### Added
- Reports & Analytics dashboard tab with fleet health trends, alert summaries, ticket summaries, and device drill-down charts
- CSV and PDF export for all report types
- Scheduled reports with cron expressions via node-cron
- Report history tracking
- New API endpoints under `/api/reports/` (fleet health trend, device metrics, alert summary, ticket summary, export, schedules CRUD, history)
- Performance indexes on `diagnostic_results`, `alerts`, and `tickets` tables
- Chart.js integration for data visualization in dashboard

### Technical
- DEPS: Added `node-cron` (cron scheduling), `pdfkit` (PDF generation)
- NEW: `server/routes/reports.js` — Reports API endpoints
- NEW: `server/services/reportGenerator.js` — Report data aggregation and formatting
- EDIT: `server/db/schema.js` — Added `report_schedules` and `report_history` tables
- EDIT: `server/public/dashboard/index.html` — Reports & Analytics tab with Chart.js visualizations

## [0.6.0] - 2026-02-16

### Added
- Remote interactive terminal — IT admins can open a live PowerShell session on managed endpoints via the dashboard
- User consent flow — endpoint users must approve terminal access before session starts
- xterm.js terminal UI in dashboard with line-buffered input and local echo
- Socket.IO relay for real-time terminal I/O between dashboard and client
- 15-minute idle timeout with automatic session cleanup
- Audit logging for terminal session lifecycle (start, stop, deny)
- Ctrl+C break signal support
- Session indicators in both dashboard (status badge) and client chat (active banner)

### Technical
- NEW: `client/PocketIT/Terminal/RemoteTerminalService.cs` — persistent PowerShell process manager
- EDIT: `client/PocketIT/Core/ServerConnection.cs` — terminal socket events
- EDIT: `server/socket/itNamespace.js` — dashboard → device terminal relay
- EDIT: `server/socket/agentNamespace.js` — device → dashboard terminal relay
- EDIT: `client/PocketIT/TrayApplication.cs` — terminal event wiring and consent bridge
- EDIT: `client/PocketIT/WebUI/chat.js` — terminal consent prompt and session indicator
- EDIT: `client/PocketIT/WebUI/chat.css` — terminal banner styling
- EDIT: `server/public/dashboard/index.html` — xterm.js terminal UI

## [0.4.0] - 2026-02-16

### Added
- Scheduled client-side diagnostics with configurable interval (default 15 minutes)
- Alert threshold system with configurable check_type, field_path, operator, threshold_value, severity
- Consecutive hit tracking for alert thresholds (reduces false positives)
- Auto-resolve alerts when conditions clear
- Uptime monitoring via heartbeat timeout detection (5-minute threshold)
- Webhook, Slack, and Teams notification channels with retry logic
- REST API for alert thresholds, alerts, and notification channel CRUD
- Dashboard Alerts tab with real-time updates, acknowledge/resolve actions
- Threshold configuration management in dashboard
- Notification channel management with test functionality
- Alert count badge in navigation bar
- 8 default alert thresholds seeded on first run (CPU, memory, disk, event log, services)

### Changed
- Health score now computed from all 8 check types (was 4)
- Fleet stats include active alert count
- Database schema adds 3 tables: alert_thresholds, alerts, notification_channels

## [0.3.0] - 2026-02-16

### Added
- 5 new diagnostic checks: top_processes (CPU/memory per process), event_log (Windows errors/criticals), windows_update (patch status), installed_software (registry scan), services (auto-start service health)
- Parameterized remediation support: IRemediationAction interface extended with RequiresParameter, ParameterLabel, ExecuteAsync(string)
- kill_process remediation action with safety blocklist (csrss, lsass, svchost, etc.) and Session 0 protection
- restart_service remediation action with service whitelist (spooler, wuauserv, bits, dnscache, etc.)
- Process table renderer in chat UI with CPU/memory highlighting
- Event log renderer with color-coded severity badges
- Software list renderer with search/filter
- Services list renderer focusing on stopped auto-start services

### Changed
- Decision engine regex now supports optional parameter: `[ACTION:REMEDIATE:action:param]`
- Server connection passes optional parameter through remediation request pipeline
- AI system prompt updated with new check types and safety guidelines

## [0.2.1] - 2026-02-15

### Fixed
- Enrollment UI now shows when device is not enrolled and no token is configured
- `requestId` now correctly included in remediation approval/denial bridge messages
- Remediation request handler added to chat UI for server-initiated remediation prompts
- Offline queue now covers diagnostic results, remediation results, and system profile (previously only chat messages were queued)
- Silent exception swallowing in CPU, memory, network diagnostics and DeviceIdentity replaced with proper logging
- ClearBrowserCacheAction byte counting now counts after successful deletion, not before
- ConnectAsync() now properly disposes existing socket before reconnecting

### Added
- File-based rolling logger (`%LOCALAPPDATA%/PocketIT/logs/pocket-it.log`) - 5MB max, 3 file rotation
- Config validation on startup with user-friendly balloon tip errors
- Elevation check for remediation actions requiring admin privileges (RestartSpooler, RepairNetwork)
- "Run Diagnostics" tray menu now fully functional - opens chat, runs all checks, shows results
- Tray tooltip shows "Connected" / "Disconnected" status with balloon notification on connection loss
- DPI-aware chat window positioning on multi-monitor setups
- LocalDatabase.PurgeSyncedMessages() with automatic cleanup after connection
- RequiresElevation property on IRemediationAction interface

## [0.2.0] - 2026-02-15

### Added
- **Real Device Diagnostics**: Client auto-collects and sends system profile on connect
- **System Profile Collection**: CPU model, total RAM, total disk space, processor count (via wmic/DriveInfo)
- **Health Score System**: 0-100 computed score based on diagnostic results (ok=100, warning=50, error=0)
- **Health Summary API**: `GET /api/devices/health/summary` (IT auth) — returns average health, breakdown, device list
- **Dashboard Health Stats**: Health score cards, colored health bars (green/yellow/red), hardware info in device detail panel
- **Hardware Context in AI**: AI prompts now include CPU, RAM, disk, cores for better diagnostic recommendations
- **Diagnostic Threshold Guidance**: AI receives threshold context (CPU >80%, RAM >85%, disk >90% = warnings)
- **Auto-Diagnostics on Connect**: Client automatically runs all 4 checks (CPU, memory, disk, network) on server connection

### Changed
- **Database Schema**: 5 new columns on `devices` table: `cpu_model`, `total_ram_gb`, `total_disk_gb`, `processor_count`, `health_score`
- **Device Detail API**: `GET /api/devices/:id` now includes hardware specs and health score
- **Admin Stats API**: `GET /api/admin/stats` now includes `averageHealth` and `criticalDevices` count
- **Socket.IO Handler**: New `system_profile` event for receiving hardware info from client
- **FleetService**: Added `computeHealthScore(deviceId)` and `getHealthSummary()` methods

### Technical
- Client `DeviceIdentity.cs`: New `GetSystemProfileAsync()` method
- Client `ServerConnection.cs`: New `OnConnectedReady` event + `SendSystemProfile()` method
- Client `TrayApplication.cs`: Auto-sends profile and runs diagnostics on connect
- Server `socket/agentNamespace.js`: Health score recomputation on diagnostic results
- Server `services/diagnosticAI.js`: Hardware context injection into system prompt

## [0.1.4] - 2024-01-20

### Added
- Dashboard login overlay for remote IT staff access (JWT in sessionStorage, `fetchWithAuth()` wrapper, Socket.IO handshake)
- Full ticket detail view: click ticket to see description, AI summary, editable status/priority dropdowns, comments with add-comment form
- 3 new remediation actions: `restart_spooler`, `repair_network`, `clear_browser_cache` (total: 5 actions)
- 16 E2E smoke tests covering health, auth, enrollment, device lifecycle, tickets CRUD, comments, cascade delete, dashboard stats

### Fixed
- XSS prevention: all user data escaped via `escapeHtml()` in dashboard
- `requireDevice` middleware validates `x-device-secret` header
- Socket.IO chat rate limiting (20 messages/minute per device)
- JWT secret fallback removed from admin login route

### Technical
- Test totals: 50 tests (34 security unit tests + 16 E2E tests)

## [0.1.3] - 2024-01-18

### Added
- New endpoint: `DELETE /api/devices/:id` (admin auth) — removes device and all related data (chat messages, diagnostics)
- Chat history on reconnect: server sends last 20 messages when device connects
- Dashboard: "Remove Device" button with confirmation dialog

### Fixed
- C# WebView2 bridge now injects `"type":"chat_response"` before forwarding to chat.js (was silently dropping all AI responses)

## [0.1.2] - 2024-01-17

### Added
- New endpoint: `GET /api/enrollment/status/:deviceId` with device_secret validation
- Chat UI: agent name updates from chat responses (not just initial handshake)
- Chat UI: "Connected to [agentName]" system message on connection
- IT Dashboard fully functional with Fleet, Tickets, and Enrollment pages (localhost auth bypass)

### Changed
- Client device_secret validation before Socket.IO connect

### Fixed
- Security hardening: null device_secret connections now rejected (requires re-enrollment)
- Security hardening: removed hardcoded JWT secret fallback in IT namespace

## [0.1.1] - 2024-01-16

### Added
- Device secret authentication on Socket.IO connections
- Server-side remediation action whitelist

### Changed
- Security hardening: JWT secret required (server exits on startup if unset)
- Security hardening: rate limiting added
- Security hardening: account lockout after 5 failed login attempts

## [0.1.0] - 2024-01-15

### Added
- Initial MVP release
- AI chat with 4 LLM provider options (Ollama, OpenAI, Anthropic, Claude CLI)
- Deterministic AI personality assignment (20 agent names)
- 4 diagnostic checks (CPU, memory, disk, network)
- 2 remediation actions (flush_dns, clear_temp)
- Support ticket creation and management
- IT staff device watching via Socket.IO
- Device online/offline status tracking
- Localhost authentication bypass for development
- Device enrollment with one-time tokens (24-hour expiry)
- Offline message queueing with IT contact fallback
- Remote deployment via PowerShell/WinRM

[Unreleased]: https://github.com/example/pocket-it/compare/v0.13.4...HEAD
[0.13.4]: https://github.com/example/pocket-it/compare/v0.12.8...v0.13.4
[0.12.8]: https://github.com/example/pocket-it/compare/v0.11.0...v0.12.8
[0.11.0]: https://github.com/example/pocket-it/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/example/pocket-it/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/example/pocket-it/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/example/pocket-it/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/example/pocket-it/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/example/pocket-it/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/example/pocket-it/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/example/pocket-it/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/example/pocket-it/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/example/pocket-it/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/example/pocket-it/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/example/pocket-it/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/example/pocket-it/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/example/pocket-it/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/example/pocket-it/releases/tag/v0.1.0
