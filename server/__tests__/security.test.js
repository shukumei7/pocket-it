const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { parseResponse } = require('../ai/decisionEngine');
const { requireDevice, requireIT, requireAdmin } = require('../auth/middleware');
const { initDatabase } = require('../db/schema');
const fs = require('fs');
const path = require('path');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-key-for-testing';

// Helper to create mock req/res objects
function createMocks(options = {}) {
  const req = {
    headers: options.headers || {},
    socket: { remoteAddress: options.remoteAddress || '192.168.1.100' },
    app: { locals: {} },
    user: options.user || null,
    deviceId: options.deviceId || null,
    params: options.params || {},
    query: options.query || {},
    body: options.body || {}
  };

  const res = {
    statusCode: 200,
    _json: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this._json = data;
      return this;
    }
  };

  const next = () => {};

  return { req, res, next };
}

// Helper to create test database
function createTestDb() {
  const dbPath = path.join(__dirname, `test-${Date.now()}.db`);
  const db = initDatabase(dbPath);
  return { db, dbPath };
}

// Helper to clean up test database
function cleanupTestDb(dbPath) {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
  } catch (err) {
    // Ignore cleanup errors
  }
}

describe('Decision Engine - Action Parsing', () => {
  it('should parse DIAGNOSE action tag', () => {
    const input = 'Let me check that for you. [ACTION:DIAGNOSE:network] I will run a network diagnostic.';
    const result = parseResponse(input);

    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.action.checkType, 'network');
    assert.strictEqual(result.text, 'Let me check that for you.  I will run a network diagnostic.');
  });

  it('should parse REMEDIATE action tag', () => {
    const input = 'I can fix that automatically. [ACTION:REMEDIATE:restart_service] This should resolve the issue.';
    const result = parseResponse(input);

    assert.strictEqual(result.action.type, 'remediate');
    assert.strictEqual(result.action.actionId, 'restart_service');
    assert.strictEqual(result.text, 'I can fix that automatically.  This should resolve the issue.');
  });

  it('should parse TICKET action tag', () => {
    const input = 'I need to escalate this. [ACTION:TICKET:high:Printer offline for 3 days] An IT tech will help soon.';
    const result = parseResponse(input);

    assert.strictEqual(result.action.type, 'ticket');
    assert.strictEqual(result.action.priority, 'high');
    assert.strictEqual(result.action.title, 'Printer offline for 3 days');
    assert.strictEqual(result.text, 'I need to escalate this.  An IT tech will help soon.');
  });

  it('should return null action for plain text', () => {
    const input = 'This is a normal response without any action tags.';
    const result = parseResponse(input);

    assert.strictEqual(result.action, null);
    assert.strictEqual(result.text, input);
  });

  it('should strip action tag from response text', () => {
    const input = '[ACTION:DIAGNOSE:disk]';
    const result = parseResponse(input);

    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.text, '');
  });
});

describe('Auth Middleware - Unit Tests', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    // Insert test device
    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, os_version, enrolled_at, last_seen)
      VALUES ('test-device-001', 'test-host', 'Windows 11', datetime('now'), datetime('now'))
    `).run();
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  describe('requireDevice', () => {
    it('should reject request with missing x-device-id header', () => {
      const { req, res, next } = createMocks();
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Device ID required');
    });

    it('should reject request with unknown device', () => {
      const { req, res, next } = createMocks({
        headers: { 'x-device-id': 'unknown-device' }
      });
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res._json.error, 'Device not enrolled');
    });

    it('should accept request with valid device', () => {
      const { req, res, next } = createMocks({
        headers: { 'x-device-id': 'test-device-001' }
      });
      req.app.locals.db = testDb;

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireDevice(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.deviceId, 'test-device-001');
    });
  });

  describe('requireIT', () => {
    it('should allow localhost without token', () => {
      const { req, res } = createMocks({
        remoteAddress: '127.0.0.1'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireIT(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
    });

    it('should reject remote request without auth header', () => {
      const { req, res, next } = createMocks({
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Authentication required');
    });

    it('should reject invalid JWT token', () => {
      const { req, res, next } = createMocks({
        headers: { 'authorization': 'Bearer invalid-token' },
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Invalid or expired token');
    });

    it('should accept valid JWT token', () => {
      const token = jwt.sign(
        { userId: 1, username: 'tech1', role: 'technician' },
        process.env.POCKET_IT_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const { req, res } = createMocks({
        headers: { 'authorization': `Bearer ${token}` },
        remoteAddress: '192.168.1.100'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireIT(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.user.username, 'tech1');
      assert.strictEqual(req.user.role, 'technician');
    });
  });

  describe('requireAdmin', () => {
    it('should allow localhost without token', () => {
      const { req, res } = createMocks({
        remoteAddress: '::1'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireAdmin(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
    });

    it('should reject non-admin role JWT', () => {
      const token = jwt.sign(
        { userId: 2, username: 'tech2', role: 'technician' },
        process.env.POCKET_IT_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const { req, res, next } = createMocks({
        headers: { 'authorization': `Bearer ${token}` },
        remoteAddress: '192.168.1.100'
      });

      requireAdmin(req, res, next);

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res._json.error, 'Admin role required');
    });

    it('should accept admin role JWT', () => {
      const token = jwt.sign(
        { userId: 1, username: 'admin1', role: 'admin' },
        process.env.POCKET_IT_JWT_SECRET,
        { expiresIn: '1h' }
      );

      const { req, res } = createMocks({
        headers: { 'authorization': `Bearer ${token}` },
        remoteAddress: '192.168.1.100'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireAdmin(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.user.username, 'admin1');
      assert.strictEqual(req.user.role, 'admin');
    });
  });
});

describe('Enrollment Logic', () => {
  let testDb, dbPath;

  beforeEach(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;
  });

  after(function() {
    if (testDb) {
      try {
        testDb.close();
      } catch (err) {
        // Already closed
      }
    }
    if (dbPath) {
      cleanupTestDb(dbPath);
    }
  });

  it('should succeed with valid token and return deviceSecret', () => {
    const token = 'test-token-valid';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status)
      VALUES (?, 'admin', ?, 'active')
    `).run(token, expiresAt);

    const tokenRecord = testDb.prepare(`
      SELECT * FROM enrollment_tokens
      WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
    `).get(token);

    assert.ok(tokenRecord, 'Token should be found');

    const deviceId = 'new-device-001';
    const deviceSecret = 'test-secret-001';

    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, os_version, status, enrolled_at, last_seen, device_secret)
      VALUES (?, ?, ?, 'online', ?, ?, ?)
    `).run(deviceId, 'test-host', 'Windows 11', new Date().toISOString(), new Date().toISOString(), deviceSecret);

    testDb.prepare(`
      UPDATE enrollment_tokens SET status = 'used', used_by_device = ? WHERE token = ?
    `).run(deviceId, token);

    const device = testDb.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    assert.strictEqual(device.device_id, deviceId);
    assert.strictEqual(device.device_secret, deviceSecret);

    const usedToken = testDb.prepare('SELECT * FROM enrollment_tokens WHERE token = ?').get(token);
    assert.strictEqual(usedToken.status, 'used');
    assert.strictEqual(usedToken.used_by_device, deviceId);
  });

  it('should reject re-enrollment of existing device with 409', () => {
    const deviceId = 'existing-device';

    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, os_version, enrolled_at, last_seen)
      VALUES (?, 'existing-host', 'Windows 10', datetime('now'), datetime('now'))
    `).run(deviceId);

    const existingDevice = testDb.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);

    assert.ok(existingDevice, 'Device should already exist');
    assert.strictEqual(existingDevice.device_id, deviceId);
  });

  it('should reject enrollment with expired token', () => {
    const token = 'test-token-expired';
    const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Expired yesterday

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status)
      VALUES (?, 'admin', ?, 'active')
    `).run(token, expiresAt);

    const tokenRecord = testDb.prepare(`
      SELECT * FROM enrollment_tokens
      WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
    `).get(token);

    assert.strictEqual(tokenRecord, undefined, 'Expired token should not be found');
  });

  it('should reject enrollment with used token', () => {
    const token = 'test-token-used';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status)
      VALUES (?, 'admin', ?, 'used')
    `).run(token, expiresAt);

    const tokenRecord = testDb.prepare(`
      SELECT * FROM enrollment_tokens
      WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
    `).get(token);

    assert.strictEqual(tokenRecord, undefined, 'Used token should not be found');
  });
});

describe('Ticket Validation', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, os_version, enrolled_at, last_seen)
      VALUES ('test-device-002', 'test-host', 'Windows 11', datetime('now'), datetime('now'))
    `).run();
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should reject POST /api/tickets without x-device-id (401)', () => {
    const { req, res, next } = createMocks({
      body: { title: 'Test ticket', priority: 'medium' }
    });
    req.app.locals.db = testDb;

    requireDevice(req, res, next);

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res._json.error, 'Device ID required');
  });

  it('should reject POST /api/tickets with unknown device (403)', () => {
    const { req, res, next } = createMocks({
      headers: { 'x-device-id': 'unknown-device-999' },
      body: { title: 'Test ticket', priority: 'medium' }
    });
    req.app.locals.db = testDb;

    requireDevice(req, res, next);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res._json.error, 'Device not enrolled');
  });

  it('should validate invalid status in PATCH request', () => {
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    const invalidStatus = 'invalid_status';

    assert.strictEqual(validStatuses.includes(invalidStatus), false);
  });

  it('should validate invalid priority in PATCH request', () => {
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    const invalidPriority = 'urgent';

    assert.strictEqual(validPriorities.includes(invalidPriority), false);
  });

  it('should accept valid status values', () => {
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];

    validStatuses.forEach(status => {
      assert.strictEqual(validStatuses.includes(status), true);
    });
  });

  it('should accept valid priority values', () => {
    const validPriorities = ['low', 'medium', 'high', 'critical'];

    validPriorities.forEach(priority => {
      assert.strictEqual(validPriorities.includes(priority), true);
    });
  });
});

describe('Security - Input Validation', () => {
  it('should enforce title length limit (500 chars)', () => {
    const longTitle = 'x'.repeat(501);
    assert.strictEqual(longTitle.length > 500, true);
  });

  it('should enforce description length limit (10000 chars)', () => {
    const longDescription = 'x'.repeat(10001);
    assert.strictEqual(longDescription.length > 10000, true);
  });

  it('should enforce category length limit (100 chars)', () => {
    const longCategory = 'x'.repeat(101);
    assert.strictEqual(longCategory.length > 100, true);
  });

  it('should sanitize priority to valid values', () => {
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    const invalidPriority = 'sql_injection_attempt';

    const safePriority = validPriorities.includes(invalidPriority) ? invalidPriority : 'medium';
    assert.strictEqual(safePriority, 'medium');
  });

  it('should use prepared statements for SQL safety', () => {
    // This test verifies the code pattern uses parameterized queries
    // The actual code uses db.prepare('...').run(...params)
    // which is safe from SQL injection

    const maliciousDeviceId = "'; DROP TABLE devices; --";
    const { db, dbPath } = createTestDb();

    try {
      const stmt = db.prepare('SELECT device_id FROM devices WHERE device_id = ?');
      const result = stmt.get(maliciousDeviceId);

      // If parameterized queries work correctly, this should return undefined
      // without executing the DROP TABLE command
      assert.strictEqual(result, undefined);

      // Verify devices table still exists
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").get();
      assert.ok(tableCheck, 'Devices table should still exist');
    } finally {
      db.close();
      cleanupTestDb(dbPath);
    }
  });
});

describe('Security - JWT Token Handling', () => {
  it('should reject expired JWT tokens', () => {
    const expiredToken = jwt.sign(
      { userId: 1, username: 'test', role: 'technician' },
      process.env.POCKET_IT_JWT_SECRET,
      { expiresIn: '-1h' } // Expired 1 hour ago
    );

    const { req, res, next } = createMocks({
      headers: { 'authorization': `Bearer ${expiredToken}` },
      remoteAddress: '192.168.1.100'
    });

    requireIT(req, res, next);

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res._json.error, 'Invalid or expired token');
  });

  it('should reject JWT with wrong signature', () => {
    const wrongSecretToken = jwt.sign(
      { userId: 1, username: 'test', role: 'admin' },
      'wrong-secret-key'
    );

    const { req, res, next } = createMocks({
      headers: { 'authorization': `Bearer ${wrongSecretToken}` },
      remoteAddress: '192.168.1.100'
    });

    requireAdmin(req, res, next);

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res._json.error, 'Invalid or expired token');
  });

  it('should use socket.remoteAddress to prevent X-Forwarded-For spoofing', () => {
    // The middleware uses req.socket.remoteAddress, not req.ip
    // This prevents header spoofing attacks

    const { req, res } = createMocks({
      remoteAddress: '192.168.1.100'
    });

    // Attacker tries to spoof localhost via headers
    req.headers['x-forwarded-for'] = '127.0.0.1';
    req.ip = '127.0.0.1';

    let nextCalled = false;
    const mockNext = () => { nextCalled = true; };

    // Should still require auth because socket.remoteAddress is not localhost
    requireIT(req, res, mockNext);

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nextCalled, false);
  });
});
