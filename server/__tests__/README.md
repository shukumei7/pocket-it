# Pocket IT Security Test Suite

## Running Tests

```bash
npm test
```

## Test Coverage

### Decision Engine (6 tests)
- Parse DIAGNOSE action tag
- Parse REMEDIATE action tag
- Parse TICKET action tag
- Parse SCREENSHOT action tag (v0.12.8)
- Handle plain text without action tags
- Strip action tags from response text

### Auth Middleware (10 tests)
**requireDevice:**
- Reject missing x-device-id header (401)
- Reject unknown device (403)
- Accept valid enrolled device

**requireIT:**
- Allow localhost without token
- Reject remote request without auth header
- Reject invalid JWT token
- Accept valid JWT token

**requireAdmin:**
- Allow localhost without token
- Reject non-admin role JWT (403)
- Accept admin role JWT

### Enrollment Logic (4 tests)
- Succeed with valid token and return deviceSecret
- Reject re-enrollment of existing device (409)
- Reject enrollment with expired token
- Reject enrollment with used token

### Ticket Validation (6 tests)
- Reject POST without x-device-id (401)
- Reject POST with unknown device (403)
- Validate invalid status values
- Validate invalid priority values
- Accept valid status values
- Accept valid priority values

### Security - Input Validation (5 tests)
- Enforce title length limit (500 chars)
- Enforce description length limit (10000 chars)
- Enforce category length limit (100 chars)
- Sanitize priority to valid values
- Use prepared statements for SQL safety

### Security - JWT Token Handling (3 tests)
- Reject expired JWT tokens
- Reject JWT with wrong signature
- Use socket.remoteAddress to prevent X-Forwarded-For spoofing

### Admin User Management (covered in security.test.js)
- `PUT /api/admin/users/:id` — reject non-admin role (403)
- `PUT /api/admin/users/:id` — accept valid field updates (display_name, role, password)
- `PUT /api/admin/users/:id` — reject unknown role values (400)
- `DELETE /api/admin/users/:id` — reject self-deletion (400)
- `DELETE /api/admin/users/:id` — reject non-admin role (403)
- `DELETE /api/admin/users/:id` — succeed and write audit log entry

## Test File Summary

| File | Tests | Coverage |
|------|-------|----------|
| `security.test.js` | 34+ | JWT, device auth, enrollment, input validation, rate limiting, user management |
| `updates.test.js` | 57 | Upload, check, download, list, delete, push, fleet-versions, SHA-256 |
| `enrollment.test.js` | 27 | Token creation, enrollment flow, scope assignment, expiry, single-use |
| `alertService.test.js` | 54 | Threshold evaluation, consecutive hit tracking, auto-resolve, notifications |
| `clientScope.test.js` | 47 | `resolveClientScope`, `scopeSQL`, `isDeviceInScope` for all role combinations |

Total: **219+ tests** (unit) + **16 E2E smoke tests**

## Test Framework

Uses Node.js built-in test runner (`node:test` and `node:assert`).

## Environment Variables

Tests automatically set:
- `NODE_ENV=test`
- `POCKET_IT_JWT_SECRET=test-secret-key-for-testing`

## Database

Each test suite creates temporary SQLite databases that are automatically cleaned up after tests complete.

## Adding New Tests

1. Create test file in `__tests__/` with `.test.js` extension
2. Use `node:test` and `node:assert` modules
3. Run `npm test` to execute all tests
