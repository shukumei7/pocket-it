# Changelog

All notable changes to Pocket IT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/1.0.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/example/pocket-it/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/example/pocket-it/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/example/pocket-it/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/example/pocket-it/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/example/pocket-it/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/example/pocket-it/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/example/pocket-it/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/example/pocket-it/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/example/pocket-it/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/example/pocket-it/releases/tag/v0.1.0
