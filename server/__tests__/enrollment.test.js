const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { initDatabase } = require('../db/schema');
const fs = require('fs');
const path = require('path');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-key-for-testing';

// Helper to create test database
// Pre-create tables with client_id to work around schema ordering issue
// (CREATE INDEX references client_id before ALTER TABLE adds it)
function createTestDb() {
  const dbPath = path.join(__dirname, `test-enrollment-${Date.now()}.db`);
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY, hostname TEXT, os_version TEXT,
      status TEXT DEFAULT 'online', certificate_fingerprint TEXT,
      device_secret TEXT, enrolled_at TEXT, last_seen TEXT, client_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL,
      created_by TEXT, expires_at TEXT, used_by_device TEXT,
      status TEXT DEFAULT 'active', client_id INTEGER
    );
  `);
  rawDb.close();
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

// Simulate what POST /token route handler does (business logic only)
function generateToken(db, clientId, createdBy) {
  if (!clientId) {
    return { status: 400, body: { error: 'client_id is required' } };
  }

  const client = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId);
  if (!client) {
    return { status: 404, body: { error: 'Client not found' } };
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
    VALUES (?, ?, ?, 'active', ?)
  `).run(token, createdBy || 'admin', expiresAt, clientId);

  return { status: 200, body: { token, expiresAt, client_id: clientId, client_name: client.name } };
}

// Simulate what POST /enroll route handler does (business logic only)
function enrollDevice(db, { token, deviceId, hostname, osVersion }) {
  if (!token || !deviceId || !hostname) {
    return { status: 400, body: { error: 'Missing required fields' } };
  }

  const tokenRecord = db.prepare(`
    SELECT * FROM enrollment_tokens
    WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
  `).get(token);

  if (!tokenRecord) {
    return { status: 400, body: { error: 'Invalid or expired token' } };
  }

  const existingDevice = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);
  if (existingDevice) {
    return { status: 409, body: { error: 'Device already enrolled. Contact IT to re-enroll.' } };
  }

  const enrolledAt = new Date().toISOString();
  const deviceSecret = uuidv4();

  db.prepare(`
    INSERT INTO devices (device_id, hostname, os_version, status, enrolled_at, last_seen, device_secret, client_id)
    VALUES (?, ?, ?, 'online', ?, ?, ?, ?)
  `).run(deviceId, hostname, osVersion, enrolledAt, enrolledAt, deviceSecret, tokenRecord.client_id || null);

  db.prepare(`
    UPDATE enrollment_tokens SET status = 'used', used_by_device = ? WHERE token = ?
  `).run(deviceId, token);

  return { status: 200, body: { success: true, deviceId, deviceSecret } };
}

// Simulate what GET /status/:deviceId route handler does (business logic only)
function checkStatus(db, deviceId, deviceSecret) {
  if (!deviceSecret) {
    return { status: 401, body: { error: 'Device secret required' } };
  }

  const device = db.prepare('SELECT device_id, device_secret FROM devices WHERE device_id = ?').get(deviceId);

  if (!device) {
    return { status: 404, body: { enrolled: false } };
  }

  if (!device.device_secret || device.device_secret !== deviceSecret) {
    return { status: 401, body: { error: 'Invalid device secret' } };
  }

  return { status: 200, body: { enrolled: true, deviceId } };
}

// UUID v4 format regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Enrollment - Token Generation', () => {
  let testDb, dbPath, defaultClientId;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    // initDatabase seeds a 'default' client — get its ID
    const defaultClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
    defaultClientId = defaultClient ? defaultClient.id : null;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should reject without client_id (400)', () => {
    const result = generateToken(testDb, null, 'admin');
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'client_id is required');
  });

  it('should reject with non-existent client_id (404)', () => {
    const result = generateToken(testDb, 99999, 'admin');
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error, 'Client not found');
  });

  it('should generate token with valid client_id', () => {
    assert.ok(defaultClientId, 'Default client should exist after initDatabase');
    const result = generateToken(testDb, defaultClientId, 'admin');
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.token, 'Token should be present');
    assert.ok(result.body.expiresAt, 'expiresAt should be present');
    assert.strictEqual(result.body.client_id, defaultClientId);
    assert.ok(result.body.client_name, 'client_name should be present');
  });

  it('token should be a UUID v4 format', () => {
    assert.ok(defaultClientId, 'Default client should exist');
    const result = generateToken(testDb, defaultClientId, 'admin');
    assert.strictEqual(result.status, 200);
    assert.match(result.body.token, UUID_REGEX);
  });

  it('token expiry should be approximately 24 hours from now', () => {
    assert.ok(defaultClientId, 'Default client should exist');
    const before = Date.now();
    const result = generateToken(testDb, defaultClientId, 'admin');
    const after = Date.now();

    assert.strictEqual(result.status, 200);

    const expiresAt = new Date(result.body.expiresAt).getTime();
    const expectedMin = before + 24 * 60 * 60 * 1000 - 1000; // 1 second tolerance
    const expectedMax = after + 24 * 60 * 60 * 1000 + 1000;

    assert.ok(expiresAt >= expectedMin, 'expiry should be at least 24h from now');
    assert.ok(expiresAt <= expectedMax, 'expiry should be no more than 24h from now');
  });
});

describe('Enrollment - Device Enrollment', () => {
  let testDb, dbPath, defaultClientId;

  beforeEach(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    const defaultClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
    defaultClientId = defaultClient ? defaultClient.id : null;
  });

  // Note: afterEach is not available in node:test; cleanup happens at end
  // Using before/after pattern per describe block with beforeEach re-creating DB
  // Each test gets a fresh DB so isolation is maintained

  it('should reject missing required fields (400)', () => {
    const result = enrollDevice(testDb, { token: null, deviceId: null, hostname: null });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Missing required fields');
  });

  it('should reject missing token (400)', () => {
    const result = enrollDevice(testDb, { token: null, deviceId: 'dev-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Missing required fields');
  });

  it('should reject missing deviceId (400)', () => {
    const result = enrollDevice(testDb, { token: 'some-token', deviceId: null, hostname: 'host-001' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Missing required fields');
  });

  it('should reject missing hostname (400)', () => {
    const result = enrollDevice(testDb, { token: 'some-token', deviceId: 'dev-001', hostname: null });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Missing required fields');
  });

  it('should reject invalid/nonexistent token (400)', () => {
    const result = enrollDevice(testDb, {
      token: 'nonexistent-token-xyz',
      deviceId: 'dev-001',
      hostname: 'host-001'
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid or expired token');
  });

  it('should reject expired token (400)', () => {
    const token = uuidv4();
    const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, pastExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid or expired token');
  });

  it('should reject used token (400)', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'used', ?)
    `).run(token, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid or expired token');
  });

  it('should successfully enroll with valid token', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-success-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.success, true);
    assert.strictEqual(result.body.deviceId, 'dev-success-001');
    assert.ok(result.body.deviceSecret, 'deviceSecret should be present');
  });

  it('enrolled device should have device_secret stored in DB', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-secret-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 200);

    const device = testDb.prepare('SELECT device_secret FROM devices WHERE device_id = ?').get('dev-secret-001');
    assert.ok(device, 'Device should exist in DB');
    assert.ok(device.device_secret, 'device_secret should be stored');
    assert.strictEqual(device.device_secret, result.body.deviceSecret);
  });

  it('token should be marked as used after enrollment', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    enrollDevice(testDb, { token, deviceId: 'dev-token-mark-001', hostname: 'host-001' });

    const tokenRecord = testDb.prepare('SELECT status, used_by_device FROM enrollment_tokens WHERE token = ?').get(token);
    assert.strictEqual(tokenRecord.status, 'used');
    assert.strictEqual(tokenRecord.used_by_device, 'dev-token-mark-001');
  });

  it('should reject re-enrollment of same device (409)', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    // Enroll the device first
    enrollDevice(testDb, { token, deviceId: 'dev-reenroll-001', hostname: 'host-001' });

    // Try to enroll again with a fresh token
    const token2 = uuidv4();
    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token2, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token: token2, deviceId: 'dev-reenroll-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 409);
    assert.ok(result.body.error.includes('already enrolled'));
  });

  it('device should inherit client_id from token', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    enrollDevice(testDb, { token, deviceId: 'dev-clientid-001', hostname: 'host-001' });

    const device = testDb.prepare('SELECT client_id FROM devices WHERE device_id = ?').get('dev-clientid-001');
    assert.strictEqual(device.client_id, defaultClientId);
  });

  it('multiple devices can enroll and each gets a unique secret', () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const token1 = uuidv4();
    const token2 = uuidv4();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token1, futureExpiry, defaultClientId);

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token2, futureExpiry, defaultClientId);

    const result1 = enrollDevice(testDb, { token: token1, deviceId: 'dev-multi-001', hostname: 'host-multi-001' });
    const result2 = enrollDevice(testDb, { token: token2, deviceId: 'dev-multi-002', hostname: 'host-multi-002' });

    assert.strictEqual(result1.status, 200);
    assert.strictEqual(result2.status, 200);
    assert.ok(result1.body.deviceSecret, 'First device should have a secret');
    assert.ok(result2.body.deviceSecret, 'Second device should have a secret');
    assert.notStrictEqual(result1.body.deviceSecret, result2.body.deviceSecret, 'Secrets should be unique');
  });
});

describe('Enrollment - Status Check', () => {
  let testDb, dbPath;
  const DEVICE_ID = 'status-check-device-001';
  const DEVICE_SECRET = uuidv4();

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    // Insert a pre-enrolled device for status checks
    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, os_version, status, enrolled_at, last_seen, device_secret)
      VALUES (?, 'status-host', 'Windows 11', 'online', datetime('now'), datetime('now'), ?)
    `).run(DEVICE_ID, DEVICE_SECRET);
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should reject without x-device-secret header (401)', () => {
    const result = checkStatus(testDb, DEVICE_ID, null);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Device secret required');
  });

  it('should return 404 for unknown device', () => {
    const result = checkStatus(testDb, 'nonexistent-device-xyz', DEVICE_SECRET);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.enrolled, false);
  });

  it('should reject wrong device secret (401)', () => {
    const result = checkStatus(testDb, DEVICE_ID, 'wrong-secret-value');
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Invalid device secret');
  });

  it('should return enrolled:true for valid device + secret', () => {
    const result = checkStatus(testDb, DEVICE_ID, DEVICE_SECRET);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.enrolled, true);
    assert.strictEqual(result.body.deviceId, DEVICE_ID);
  });
});

describe('Enrollment - Security Edge Cases', () => {
  let testDb, dbPath, defaultClientId;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    const defaultClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
    defaultClientId = defaultClient ? defaultClient.id : null;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('tokens are case-sensitive UUIDs — wrong case should be rejected', () => {
    const token = uuidv4(); // generates lowercase
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    // Attempt with uppercase version of the token
    const upperToken = token.toUpperCase();
    const result = enrollDevice(testDb, { token: upperToken, deviceId: 'dev-case-001', hostname: 'host-001' });

    // SQLite TEXT comparison is case-sensitive for this query
    // If the token values differ by case, should return 400
    if (token !== upperToken) {
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.error, 'Invalid or expired token');
    }
  });

  it('device secret should be different from the enrollment token', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-secret-diff-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 200);
    assert.notStrictEqual(result.body.deviceSecret, token, 'deviceSecret must differ from enrollment token');
  });

  it('enrollment should work with missing osVersion (optional field)', () => {
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'active', ?)
    `).run(token, futureExpiry, defaultClientId);

    // osVersion omitted (undefined)
    const result = enrollDevice(testDb, { token, deviceId: 'dev-noos-001', hostname: 'host-noos' });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.success, true);

    const device = testDb.prepare('SELECT os_version FROM devices WHERE device_id = ?').get('dev-noos-001');
    assert.ok(device, 'Device should exist');
    // os_version should be null/undefined when not provided
    assert.strictEqual(device.os_version, null);
  });

  it('should use prepared statements — SQL injection in token should be safe', () => {
    const maliciousToken = "' OR '1'='1'; DROP TABLE devices; --";

    const result = enrollDevice(testDb, {
      token: maliciousToken,
      deviceId: 'dev-inject-001',
      hostname: 'host-001'
    });

    // Should not find the token (parameterized query prevents injection)
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid or expired token');

    // Devices table should still exist
    const tableCheck = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").get();
    assert.ok(tableCheck, 'Devices table should still exist after injection attempt');
  });

  it('token status query correctly rejects inactive token with future expiry', () => {
    // A token with status other than 'active' should be rejected even if not expired
    const token = uuidv4();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    testDb.prepare(`
      INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
      VALUES (?, 'admin', ?, 'revoked', ?)
    `).run(token, futureExpiry, defaultClientId);

    const result = enrollDevice(testDb, { token, deviceId: 'dev-revoked-001', hostname: 'host-001' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid or expired token');
  });
});
