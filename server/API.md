# Pocket IT Server API Reference

Base URL: `http://localhost:9100`

**Authentication:** All endpoints accept requests from `localhost` (127.0.0.1) without authentication. Remote requests require authentication as noted.

## Health Check

### GET /health

Health check endpoint.

**Auth:** None

**Response:**
```json
{
  "status": "ok",
  "service": "pocket-it"
}
```

**Example:**
```bash
curl http://localhost:9100/health
```

---

## Enrollment

### POST /api/enrollment/token

Generate a one-time enrollment token for new devices. The token is tied to a specific client so the enrolling device is automatically assigned to that client on enrollment.

**Auth:** Admin (localhost bypass in MVP)

**Request Body:**
```json
{
  "client_id": 1
}
```

**Fields:**
- `client_id` (required) — ID of the client the enrolling device should be assigned to

**Response:**
```json
{
  "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "expiresAt": "2024-01-16T10:30:00.000Z",
  "client_id": 1,
  "client_name": "Acme Corp"
}
```

**Token properties:**
- UUID v4 format
- Single-use
- 24-hour expiration
- Marked as 'used' after enrollment
- Bound to the specified client; enrolled device inherits client assignment

**Errors:**
- `400` — `client_id` is required
- `404` — Client not found

**Example:**
```bash
curl -X POST http://localhost:9100/api/enrollment/token \
  -H "Content-Type: application/json" \
  -d '{"client_id": 1}'
```

### POST /api/enrollment/enroll

Enroll a device using a valid token.

**Auth:** None (token-based authorization)

**Request Body:**
```json
{
  "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "deviceId": "device-unique-id",
  "hostname": "DESKTOP-USER01",
  "osVersion": "Windows 11 Pro 23H2"
}
```

**Response:**
```json
{
  "success": true,
  "deviceId": "device-unique-id"
}
```

**Errors:**
- `400` — Missing required fields
- `400` — Invalid or expired token

**Example:**
```bash
curl -X POST http://localhost:9100/api/enrollment/enroll \
  -H "Content-Type: application/json" \
  -d '{
    "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "deviceId": "device-abc123",
    "hostname": "DESKTOP-USER01",
    "osVersion": "Windows 11"
  }'
```

---

## Devices

### GET /api/devices

List all enrolled devices.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
[
  {
    "device_id": "device-abc123",
    "hostname": "DESKTOP-USER01",
    "os_version": "Windows 11 Pro 23H2",
    "status": "online",
    "certificate_fingerprint": null,
    "enrolled_at": "2024-01-15T10:30:00.000Z",
    "last_seen": "2024-01-15T14:25:30.000Z"
  }
]
```

**Example:**
```bash
curl http://localhost:9100/api/devices
```

### GET /api/devices/:id

Get details for a specific device including hardware specs and health score.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
{
  "device_id": "device-abc123",
  "hostname": "DESKTOP-USER01",
  "os_version": "Windows 11 Pro 23H2",
  "status": "online",
  "cpu_model": "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz",
  "total_ram_gb": 16,
  "total_disk_gb": 512,
  "processor_count": 8,
  "health_score": 85,
  "certificate_fingerprint": null,
  "enrolled_at": "2024-01-15T10:30:00.000Z",
  "last_seen": "2024-01-15T14:25:30.000Z"
}
```

**Errors:**
- `404` — Device not found

**Example:**
```bash
curl http://localhost:9100/api/devices/device-abc123
```

### GET /api/devices/:id/diagnostics

Get diagnostic check history for a device.

**Auth:** IT staff (localhost bypass in MVP)

**Query Parameters:**
- None (defaults to last 50 results)

**Response:**
```json
[
  {
    "id": 1,
    "device_id": "device-abc123",
    "check_type": "network",
    "status": "completed",
    "data": "{\"adapters\":[...],\"internetConnectivity\":true}",
    "created_at": "2024-01-15T14:20:00.000Z"
  }
]
```

**Example:**
```bash
curl http://localhost:9100/api/devices/device-abc123/diagnostics
```

### GET /api/devices/health/summary

Get fleet health summary with average health score and device breakdown.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
{
  "avgScore": 78.5,
  "breakdown": {
    "healthy": 8,
    "warning": 3,
    "critical": 2,
    "unscanned": 1
  },
  "devices": [
    {
      "device_id": "device-abc123",
      "hostname": "DESKTOP-USER01",
      "health_score": 85,
      "cpu_model": "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz",
      "total_ram_gb": 16,
      "total_disk_gb": 512,
      "processor_count": 8,
      "last_seen": "2024-02-15T14:25:30.000Z"
    }
  ]
}
```

**Health categories:**
- `healthy`: health_score >= 70
- `warning`: health_score >= 40 and < 70
- `critical`: health_score < 40
- `unscanned`: health_score is null

**Example:**
```bash
curl http://localhost:9100/api/devices/health/summary
```

---

## Tickets

### GET /api/tickets

List all support tickets with optional filtering.

**Auth:** IT staff (localhost bypass in MVP)

**Query Parameters:**
- `status` (optional) — Filter by status: `open`, `in_progress`, `resolved`, `closed`

**Response:**
```json
[
  {
    "id": 1,
    "device_id": "device-abc123",
    "title": "Internet connection issues",
    "description": null,
    "status": "open",
    "priority": "medium",
    "category": null,
    "assigned_to": null,
    "ai_summary": "User experiencing slow internet speeds. Network diagnostic requested.",
    "created_at": "2024-01-15T14:22:00.000Z",
    "updated_at": null
  }
]
```

**Example:**
```bash
# All tickets
curl http://localhost:9100/api/tickets

# Only open tickets
curl http://localhost:9100/api/tickets?status=open
```

### GET /api/tickets/:id

Get ticket details including comments.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
{
  "id": 1,
  "device_id": "device-abc123",
  "title": "Internet connection issues",
  "description": null,
  "status": "open",
  "priority": "medium",
  "category": null,
  "assigned_to": null,
  "ai_summary": "User experiencing slow internet speeds. Network diagnostic requested.",
  "created_at": "2024-01-15T14:22:00.000Z",
  "updated_at": null,
  "comments": [
    {
      "id": 1,
      "ticket_id": 1,
      "author": "tech-user",
      "content": "Checking network diagnostics now",
      "created_at": "2024-01-15T14:25:00.000Z"
    }
  ]
}
```

**Errors:**
- `404` — Ticket not found

**Example:**
```bash
curl http://localhost:9100/api/tickets/1
```

### POST /api/tickets

Create a new support ticket.

**Auth:** None (can be called by devices or AI)

**Request Body:**
```json
{
  "device_id": "device-abc123",
  "title": "Recurring BSOD on startup",
  "description": "User reports blue screen errors when booting",
  "priority": "high",
  "category": "hardware"
}
```

**Response:**
```json
{
  "id": 2,
  "device_id": "device-abc123",
  "title": "Recurring BSOD on startup"
}
```

**Errors:**
- `400` — Missing required fields (device_id, title)

**Example:**
```bash
curl -X POST http://localhost:9100/api/tickets \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-abc123",
    "title": "Cannot print to network printer",
    "priority": "medium"
  }'
```

### PATCH /api/tickets/:id

Update ticket status, priority, or assignment.

**Auth:** IT staff (localhost bypass in MVP)

**Request Body (all fields optional):**
```json
{
  "status": "in_progress",
  "priority": "high",
  "assigned_to": 1
}
```

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- `400` — No fields to update

**Example:**
```bash
curl -X PATCH http://localhost:9100/api/tickets/1 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "assigned_to": 1
  }'
```

### POST /api/tickets/:id/comments

Add a comment to a ticket.

**Auth:** IT staff (localhost bypass in MVP)

**Request Body:**
```json
{
  "author": "tech-user",
  "content": "Diagnostic completed. DNS issue resolved."
}
```

**Response:**
```json
{
  "id": 2
}
```

**Errors:**
- `400` — Missing content

**Example:**
```bash
curl -X POST http://localhost:9100/api/tickets/1/comments \
  -H "Content-Type: application/json" \
  -d '{
    "author": "tech-user",
    "content": "Requested user to restart router"
  }'
```

---

## Chat

### GET /api/chat/:deviceId/history

Get chat message history for a device.

**Auth:** IT staff (localhost bypass in MVP)

**Query Parameters:**
- `limit` (optional, default: 50) — Number of messages to return
- `offset` (optional, default: 0) — Pagination offset

**Response:**
```json
[
  {
    "id": 1,
    "device_id": "device-abc123",
    "sender": "user",
    "content": "My internet is slow",
    "message_type": "text",
    "metadata": null,
    "created_at": "2024-01-15T14:20:00.000Z"
  },
  {
    "id": 2,
    "device_id": "device-abc123",
    "sender": "ai",
    "content": "I can help with that. Let me run a network diagnostic.",
    "message_type": "diagnose",
    "metadata": "{\"type\":\"diagnose\",\"checkType\":\"network\"}",
    "created_at": "2024-01-15T14:20:05.000Z"
  }
]
```

**Message types:**
- `text` — Plain conversation
- `diagnose` — AI requested diagnostic
- `remediate` — AI suggested remediation
- `ticket` — AI created ticket

**Example:**
```bash
# Last 50 messages
curl http://localhost:9100/api/chat/device-abc123/history

# Last 100 messages
curl http://localhost:9100/api/chat/device-abc123/history?limit=100

# Pagination
curl http://localhost:9100/api/chat/device-abc123/history?limit=50&offset=50
```

---

## LLM Configuration

### GET /api/llm/config

Get current LLM provider configuration.

**Auth:** None

**Response:**
```json
{
  "provider": "ollama",
  "model": "llama3.2",
  "url": "http://localhost:11434"
}
```

**Providers:**
- `ollama` — Local Ollama server
- `openai` — OpenAI API
- `anthropic` — Anthropic API
- `claude-cli` — Claude Desktop CLI

**Example:**
```bash
curl http://localhost:9100/api/llm/config
```

### GET /api/llm/models

Get current provider and model information.

**Auth:** None

**Response:**
```json
{
  "provider": "ollama",
  "model": "llama3.2"
}
```

**Example:**
```bash
curl http://localhost:9100/api/llm/models
```

---

## Admin

### POST /api/admin/login

Authenticate as an IT staff user and receive JWT token. The response includes a `clients` array scoped to the user's role: admins receive all clients, technicians receive only their assigned clients.

**Auth:** None (credentials-based)

**Request Body:**
```json
{
  "username": "admin",
  "password": "password123"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "display_name": "Administrator",
    "role": "admin"
  },
  "clients": [
    { "id": 1, "name": "Default", "slug": "default" },
    { "id": 2, "name": "Acme Corp", "slug": "acme-corp" }
  ]
}
```

**Notes:**
- `clients` — admin: all clients; technician: only assigned clients; empty array means no client access
- `POST /api/admin/auto-login` returns the same shape

**Errors:**
- `400` — Username and password required
- `401` — Invalid credentials

**Example:**
```bash
curl -X POST http://localhost:9100/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "secure-password"
  }'
```

### GET /api/admin/users

List all IT staff users.

**Auth:** Admin (localhost bypass in MVP)

**Response:**
```json
[
  {
    "id": 1,
    "username": "admin",
    "display_name": "Administrator",
    "role": "admin",
    "created_at": "2024-01-01T00:00:00.000Z",
    "last_login": "2024-01-15T14:00:00.000Z"
  }
]
```

**Example:**
```bash
curl http://localhost:9100/api/admin/users
```

### POST /api/admin/users

Create a new IT staff user.

**Auth:** Admin (localhost bypass in MVP)

**Request Body:**
```json
{
  "username": "tech-user",
  "password": "secure-password",
  "display_name": "Tech User",
  "role": "technician"
}
```

**Roles:**
- `admin` — Full access, user management
- `technician` — View devices, manage tickets
- `viewer` — Read-only access

**Response:**
```json
{
  "id": 2,
  "username": "tech-user",
  "role": "technician"
}
```

**Errors:**
- `400` — Username and password required
- `400` — Username already exists

**Example:**
```bash
curl -X POST http://localhost:9100/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "tech-user",
    "password": "secure-password",
    "display_name": "Tech User",
    "role": "technician"
  }'
```

### GET /api/admin/stats

Get system statistics including fleet health metrics. All counts are scoped to the requesting user's assigned clients — admins see totals across the entire fleet; technicians see totals for their assigned clients only.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
{
  "totalDevices": 15,
  "onlineDevices": 12,
  "openTickets": 3,
  "totalTickets": 47,
  "averageHealth": 78.5,
  "criticalDevices": 2
}
```

**Health metrics:**
- `averageHealth`: Average health score across scoped devices with scores (0-100)
- `criticalDevices`: Count of scoped devices with health_score < 40

**Example:**
```bash
curl http://localhost:9100/api/admin/stats
```

---

## Clients

Manage client organizations (companies/tenants). Admins have full access; technicians can only view clients they are assigned to.

### GET /api/clients

List clients. Admins receive all clients; technicians receive only their assigned clients.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
[
  {
    "id": 1,
    "name": "Default",
    "slug": "default",
    "contact_name": null,
    "contact_email": null,
    "notes": null,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": null
  },
  {
    "id": 2,
    "name": "Acme Corp",
    "slug": "acme-corp",
    "contact_name": "Jane Smith",
    "contact_email": "jane@acme.com",
    "notes": "Primary enterprise client",
    "created_at": "2026-02-01T00:00:00.000Z",
    "updated_at": null
  }
]
```

**Example:**
```bash
curl http://localhost:9100/api/clients
```

---

### GET /api/clients/:id

Get a single client by ID. Technicians receive 403 if the client is not in their scope.

**Auth:** IT staff (localhost bypass in MVP)

**Response:**
```json
{
  "id": 2,
  "name": "Acme Corp",
  "slug": "acme-corp",
  "contact_name": "Jane Smith",
  "contact_email": "jane@acme.com",
  "notes": "Primary enterprise client",
  "created_at": "2026-02-01T00:00:00.000Z",
  "updated_at": null
}
```

**Errors:**
- `403` — Not in scope (technician accessing unassigned client)
- `404` — Client not found

**Example:**
```bash
curl http://localhost:9100/api/clients/2
```

---

### POST /api/clients

Create a new client. A URL-safe slug is auto-generated from the name.

**Auth:** Admin only

**Request Body:**
```json
{
  "name": "Acme Corp",
  "contact_name": "Jane Smith",
  "contact_email": "jane@acme.com",
  "notes": "Primary enterprise client"
}
```

**Fields:**
- `name` (required) — Display name; must be unique
- `contact_name` (optional) — Primary contact person
- `contact_email` (optional) — Primary contact email
- `notes` (optional) — Free-form notes

**Response:**
```json
{
  "id": 2,
  "name": "Acme Corp",
  "slug": "acme-corp"
}
```

**Errors:**
- `400` — `name` is required
- `400` — Client name already exists
- `403` — Admin role required

**Example:**
```bash
curl -X POST http://localhost:9100/api/clients \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp",
    "contact_name": "Jane Smith",
    "contact_email": "jane@acme.com"
  }'
```

---

### PATCH /api/clients/:id

Update client details. Slug is not regenerated on name change.

**Auth:** Admin only

**Request Body (all fields optional):**
```json
{
  "name": "Acme Corporation",
  "contact_name": "John Doe",
  "contact_email": "john@acme.com",
  "notes": "Updated contact"
}
```

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- `400` — No fields to update
- `403` — Admin role required
- `404` — Client not found

**Example:**
```bash
curl -X PATCH http://localhost:9100/api/clients/2 \
  -H "Content-Type: application/json" \
  -d '{"contact_email": "newemail@acme.com"}'
```

---

### DELETE /api/clients/:id

Delete a client. Fails if the client still has devices assigned.

**Auth:** Admin only

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- `400` — Client has devices assigned (reassign or remove devices first)
- `403` — Admin role required
- `404` — Client not found

**Example:**
```bash
curl -X DELETE http://localhost:9100/api/clients/2
```

---

### GET /api/clients/:id/users

List IT users assigned to this client.

**Auth:** Admin only

**Response:**
```json
[
  {
    "id": 2,
    "username": "tech-user",
    "display_name": "Tech User",
    "role": "technician",
    "assigned_at": "2026-02-01T00:00:00.000Z"
  }
]
```

**Errors:**
- `403` — Admin role required
- `404` — Client not found

**Example:**
```bash
curl http://localhost:9100/api/clients/2/users
```

---

### POST /api/clients/:id/users

Assign an IT user to this client.

**Auth:** Admin only

**Request Body:**
```json
{
  "user_id": 2
}
```

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- `400` — `user_id` is required
- `400` — User already assigned to this client
- `403` — Admin role required
- `404` — Client or user not found

**Example:**
```bash
curl -X POST http://localhost:9100/api/clients/2/users \
  -H "Content-Type: application/json" \
  -d '{"user_id": 2}'
```

---

### DELETE /api/clients/:id/users/:userId

Unassign an IT user from a client. The user account is not deleted.

**Auth:** Admin only

**Response:**
```json
{
  "success": true
}
```

**Errors:**
- `403` — Admin role required
- `404` — Client not found or user not assigned to this client

**Example:**
```bash
curl -X DELETE http://localhost:9100/api/clients/2/users/2
```

---

### GET /api/clients/:id/installer

Download a pre-configured installer ZIP for this client. The archive contains the published client binary and an `appsettings.json` pre-seeded with the server URL and a freshly generated enrollment token bound to this client.

**Auth:** Admin only

**Response:** Binary ZIP file download

**Headers:**
```
Content-Type: application/zip
Content-Disposition: attachment; filename="pocket-it-acme-corp.zip"
```

**Errors:**
- `403` — Admin role required
- `404` — Client not found
- `500` — Client build not found (run `dotnet publish` first)

**Example:**
```bash
curl -O -J http://localhost:9100/api/clients/2/installer
```

---

## Socket.IO Events

Pocket IT uses Socket.IO for real-time bidirectional communication. See SPECS.md for complete Socket.IO protocol documentation.

### Namespaces

| Namespace | Purpose | Authentication |
|-----------|---------|----------------|
| `/agent` | Device clients | Query param: `deviceId` |
| `/it` | IT staff dashboard | JWT token (optional in MVP) |

### Key Events — /agent Namespace

**Client → Server:**
- `chat_message` — User sends message
- `system_profile` — Device hardware information (CPU model, RAM, disk, cores, + 12 extended fields added in v0.9.0)
- `diagnostic_result` — Diagnostic check results
- `remediation_result` — Remediation action outcome
- `system_tool_result` — System tool execution result: `{ requestId, tool, success, data, error }`
- `heartbeat` — Keep-alive ping

**Server → Client:**
- `agent_info` — Assigned AI agent name
- `chat_response` — AI response with optional action
- `diagnostic_request` — Request diagnostic check
- `remediation_request` — Request remediation approval
- `system_tool_request` — Request system tool execution: `{ requestId, tool, params }`

### Key Events — /it Namespace

**Client → Server:**
- `watch_device` — Subscribe to device updates
- `unwatch_device` — Unsubscribe from device
- `chat_to_device` — IT sends message to device
- `request_diagnostic` — Request diagnostic from device
- `system_tool_request` — Forward tool request to a device: `{ deviceId, requestId, tool, params }`

**Server → Client:**
- `device_status` — Device information
- `device_chat_history` — Chat message history
- `device_chat_update` — Real-time chat update
- `device_diagnostic_update` — Diagnostic completed
- `device_remediation_update` — Remediation completed
- `device_status_changed` — Device online/offline
- `ticket_created` — New ticket created
- `system_tool_result` — Tool result relayed from device: `{ deviceId, requestId, tool, success, data, error }`

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message description"
}
```

**Common HTTP status codes:**
- `200` — Success
- `201` — Created
- `400` — Bad request (validation error)
- `401` — Unauthorized
- `403` — Forbidden
- `404` — Not found
- `500` — Internal server error

---

## Rate Limiting

**MVP:** No rate limiting implemented.

**Production roadmap:**
- Device chat messages: 30 per minute
- Diagnostic requests: 10 per minute
- API endpoints: 100 per minute per IP
- Enrollment token generation: 10 per hour

---

## CORS Configuration

**Current:** Allow all origins (`origin: '*'`)

**Production:** Restrict to known origins:
```javascript
{
  origin: [
    'http://localhost:9100',
    'https://pocket-it.example.com'
  ]
}
```

---

## WebSocket Connection Examples

### Device Client Connection (JavaScript)

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:9100/agent', {
  query: {
    deviceId: 'device-abc123',
    hostname: 'DESKTOP-USER01'
  }
});

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('agent_info', (data) => {
  console.log('Agent name:', data.agentName);
});

socket.on('chat_response', (data) => {
  console.log('AI:', data.text);
  if (data.action) {
    console.log('Action:', data.action);
  }
});

socket.emit('chat_message', {
  content: 'My internet is slow'
});
```

### IT Dashboard Connection (JavaScript)

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:9100/it', {
  auth: {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  }
});

socket.on('connect', () => {
  socket.emit('watch_device', { deviceId: 'device-abc123' });
});

socket.on('device_chat_update', (data) => {
  console.log('New chat:', data.message.content);
  console.log('AI response:', data.response.text);
});

socket.emit('chat_to_device', {
  deviceId: 'device-abc123',
  content: 'Hi, I can help with that issue'
});
```

---

## Development Workflow

### 1. Start Server
```bash
cd server
npm run dev
```

### 2. Check Health
```bash
curl http://localhost:9100/health
```

### 3. Generate Enrollment Token
```bash
curl -X POST http://localhost:9100/api/enrollment/token
```

### 4. Configure Client
Edit `client/PocketIT/appsettings.json`:
```json
{
  "Enrollment": {
    "Token": "paste-token-here"
  }
}
```

### 5. Start Client
```bash
cd client/PocketIT
dotnet run
```

### 6. Monitor Logs
Server logs show:
- Device connections/disconnections
- Chat messages
- Diagnostic requests/results
- Remediation executions
- Ticket creation

---

## API Versioning

**Current:** No versioning (MVP phase)

**Future:** API v1 at `/api/v1/*` with backward compatibility for v0 endpoints.
