# Pocket IT Security Test Suite

## Running Tests

```bash
npm test
```

## Test Coverage

### Decision Engine (5 tests)
- Parse DIAGNOSE action tag
- Parse REMEDIATE action tag
- Parse TICKET action tag
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
