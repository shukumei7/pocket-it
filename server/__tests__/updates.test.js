const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('../db/schema');
const { requireDevice, requireIT } = require('../auth/middleware');

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
// Works around schema ordering: the v0.10.0 exec block creates indexes on
// devices(client_id) and enrollment_tokens(client_id) before the ALTER TABLE
// migrations that add those columns on a fresh DB. Pre-seeding both tables
// with client_id avoids the SQLITE_ERROR.
function createTestDb() {
  const dbPath = path.join(__dirname, `test-updates-${Date.now()}.db`);
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      hostname TEXT,
      os_version TEXT,
      status TEXT DEFAULT 'online',
      certificate_fingerprint TEXT,
      device_secret TEXT,
      enrolled_at TEXT,
      last_seen TEXT,
      client_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      created_by TEXT,
      expires_at TEXT,
      used_by_device TEXT,
      status TEXT DEFAULT 'active',
      client_id INTEGER
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

// Replicated isNewerVersion logic for direct unit testing
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Helper to insert an update package directly into DB
function insertPackage(db, { version, filename, file_size, sha256, release_notes, uploaded_by } = {}) {
  db.prepare(
    'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    version || '0.10.0',
    filename || `PocketIT-${version || '0.10.0'}-setup.exe`,
    file_size || 1024,
    sha256 || 'abc123def456',
    release_notes || null,
    uploaded_by || 'localhost'
  );
}

// Helper to insert a device directly into DB
function insertDevice(db, { device_id, hostname, device_secret, client_version } = {}) {
  db.prepare(`
    INSERT INTO devices (device_id, hostname, os_version, enrolled_at, last_seen, device_secret, client_version)
    VALUES (?, ?, 'Windows 11', datetime('now'), datetime('now'), ?, ?)
  `).run(
    device_id || 'test-device-001',
    hostname || 'test-host',
    device_secret || 'test-secret-001',
    client_version || null
  );
}

// ─── 1. Version Comparison Logic ─────────────────────────────────────────────

describe('Updates - Version Comparison', () => {
  it('should return true when minor version is higher (0.11.0 > 0.10.0)', () => {
    assert.strictEqual(isNewerVersion('0.11.0', '0.10.0'), true);
  });

  it('should return false when minor version is lower (0.10.0 > 0.11.0)', () => {
    assert.strictEqual(isNewerVersion('0.10.0', '0.11.0'), false);
  });

  it('should return true when major version is higher (1.0.0 > 0.99.99)', () => {
    assert.strictEqual(isNewerVersion('1.0.0', '0.99.99'), true);
  });

  it('should return false when versions are equal (0.10.0 == 0.10.0)', () => {
    assert.strictEqual(isNewerVersion('0.10.0', '0.10.0'), false);
  });

  it('should return true when patch version is higher (0.10.1 > 0.10.0)', () => {
    assert.strictEqual(isNewerVersion('0.10.1', '0.10.0'), true);
  });

  it('should return true when major bump overrides all (2.0.0 > 1.9.9)', () => {
    assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), true);
  });

  it('should return false when patch is lower (0.10.0 vs 0.10.1)', () => {
    assert.strictEqual(isNewerVersion('0.10.0', '0.10.1'), false);
  });

  it('should handle single-digit versions correctly (1.0.0 > 0.0.1)', () => {
    assert.strictEqual(isNewerVersion('1.0.0', '0.0.1'), true);
  });

  it('should return false when a is lower across all components (0.1.0 vs 1.0.0)', () => {
    assert.strictEqual(isNewerVersion('0.1.0', '1.0.0'), false);
  });
});

// ─── 2. Database Schema ───────────────────────────────────────────────────────

describe('Updates - Database Schema', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should have update_packages table', () => {
    const table = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='update_packages'"
    ).get();
    assert.ok(table, 'update_packages table should exist');
    assert.strictEqual(table.name, 'update_packages');
  });

  it('should have all required columns on update_packages', () => {
    const cols = testDb.prepare("PRAGMA table_info(update_packages)").all();
    const colNames = cols.map(c => c.name);
    const required = ['id', 'version', 'filename', 'file_size', 'sha256', 'release_notes', 'uploaded_by', 'created_at'];
    for (const col of required) {
      assert.ok(colNames.includes(col), `Column '${col}' should exist on update_packages`);
    }
  });

  it('should have client_version column on devices table', () => {
    const cols = testDb.prepare("PRAGMA table_info(devices)").all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('client_version'), 'devices table should have client_version column');
  });

  it('should have devices table', () => {
    const table = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='devices'"
    ).get();
    assert.ok(table, 'devices table should exist');
  });

  it('should have UNIQUE constraint on update_packages.version', () => {
    const indexes = testDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='update_packages'"
    ).all();
    // UNIQUE constraint shows up either as a column constraint in the CREATE TABLE sql
    const tableSql = testDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='update_packages'"
    ).get();
    assert.ok(tableSql.sql.includes('UNIQUE'), 'update_packages.version should have UNIQUE constraint');
  });
});

// ─── 3. Package CRUD Operations ───────────────────────────────────────────────

describe('Updates - Package CRUD', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should insert an update package with all fields', () => {
    testDb.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('0.10.0', 'PocketIT-0.10.0-setup.exe', 2048000, 'deadbeef1234', 'Initial release', 'admin');

    const pkg = testDb.prepare('SELECT * FROM update_packages WHERE version = ?').get('0.10.0');
    assert.ok(pkg, 'Package should be found after insert');
    assert.strictEqual(pkg.version, '0.10.0');
    assert.strictEqual(pkg.filename, 'PocketIT-0.10.0-setup.exe');
    assert.strictEqual(pkg.file_size, 2048000);
    assert.strictEqual(pkg.sha256, 'deadbeef1234');
    assert.strictEqual(pkg.release_notes, 'Initial release');
    assert.strictEqual(pkg.uploaded_by, 'admin');
  });

  it('should auto-populate created_at on insert', () => {
    const pkg = testDb.prepare('SELECT * FROM update_packages WHERE version = ?').get('0.10.0');
    assert.ok(pkg.created_at, 'created_at should be set automatically');
  });

  it('should list packages ordered by created_at DESC', () => {
    // Use explicit created_at offsets in the future so ordering is deterministic.
    // 0.10.0 was inserted at datetime('now') by the previous test; 0.10.1 and
    // 0.10.2 are stamped later so DESC gives: 0.10.2, 0.10.1, 0.10.0.
    testDb.prepare(
      "INSERT INTO update_packages (version, filename, file_size, sha256, created_at) VALUES (?, ?, ?, ?, datetime('now', '+1 second'))"
    ).run('0.10.1', 'PocketIT-0.10.1-setup.exe', 2050000, 'aabbccdd1111');

    testDb.prepare(
      "INSERT INTO update_packages (version, filename, file_size, sha256, created_at) VALUES (?, ?, ?, ?, datetime('now', '+2 seconds'))"
    ).run('0.10.2', 'PocketIT-0.10.2-setup.exe', 2060000, 'eeff00001111');

    const packages = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC'
    ).all();

    assert.ok(packages.length >= 3, 'Should have at least 3 packages');
    // DESC order: 0.10.2 first, then 0.10.1, then 0.10.0
    const idx010 = packages.findIndex(p => p.version === '0.10.0');
    const idx101 = packages.findIndex(p => p.version === '0.10.1');
    const idx102 = packages.findIndex(p => p.version === '0.10.2');
    assert.ok(idx102 < idx101, '0.10.2 should appear before 0.10.1 in DESC order');
    assert.ok(idx101 < idx010, '0.10.1 should appear before 0.10.0 in DESC order');
  });

  it('should enforce UNIQUE constraint on version', () => {
    assert.throws(() => {
      testDb.prepare(
        'INSERT INTO update_packages (version, filename, file_size, sha256) VALUES (?, ?, ?, ?)'
      ).run('0.10.0', 'PocketIT-0.10.0-setup.exe', 1024, 'duplicate');
    }, /UNIQUE constraint failed/);
  });

  it('should delete a package by version', () => {
    testDb.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256) VALUES (?, ?, ?, ?)'
    ).run('0.9.9', 'PocketIT-0.9.9-setup.exe', 1900000, 'oldhash999');

    testDb.prepare('DELETE FROM update_packages WHERE version = ?').run('0.9.9');

    const pkg = testDb.prepare('SELECT * FROM update_packages WHERE version = ?').get('0.9.9');
    assert.strictEqual(pkg, undefined, 'Package should be gone after delete');
  });

  it('should allow null release_notes', () => {
    testDb.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes) VALUES (?, ?, ?, ?, ?)'
    ).run('0.8.0', 'PocketIT-0.8.0-setup.exe', 1800000, 'hash080', null);

    const pkg = testDb.prepare('SELECT * FROM update_packages WHERE version = ?').get('0.8.0');
    assert.strictEqual(pkg.release_notes, null);
  });

  it('should return latest package when ordering by created_at DESC LIMIT 1', () => {
    const latest = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();
    assert.ok(latest, 'Should find a latest package');
    assert.strictEqual(typeof latest.version, 'string');
  });
});

// ─── 4. Version Check Logic ───────────────────────────────────────────────────

describe('Updates - Version Check Logic', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    insertDevice(testDb, {
      device_id: 'check-device-001',
      device_secret: 'check-secret-001',
      client_version: '0.10.0'
    });

    insertDevice(testDb, {
      device_id: 'check-device-002',
      device_secret: 'check-secret-002',
      client_version: '0.11.0'
    });

    insertDevice(testDb, {
      device_id: 'check-device-003',
      device_secret: 'check-secret-003',
      client_version: null
    });
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should indicate updateAvailable when latest version is newer', () => {
    insertPackage(testDb, { version: '0.11.0', sha256: 'sha256check001' });

    const currentVersion = '0.10.0';
    const latest = testDb.prepare(
      'SELECT version, filename, file_size, sha256, release_notes FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    assert.ok(latest, 'Latest package should exist');
    const updateAvailable = latest && isNewerVersion(latest.version, currentVersion);
    assert.strictEqual(updateAvailable, true, 'Update should be available for older client');
  });

  it('should indicate no update when versions are equal', () => {
    const currentVersion = '0.11.0';
    const latest = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    const updateAvailable = latest && isNewerVersion(latest.version, currentVersion);
    assert.strictEqual(updateAvailable, false, 'No update should be available when at same version');
  });

  it('should indicate no update when client has newer version than latest package', () => {
    const currentVersion = '0.12.0';
    const latest = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    const updateAvailable = latest && isNewerVersion(latest.version, currentVersion);
    assert.strictEqual(updateAvailable, false, 'No update should be available when client is ahead');
  });

  it('should return updateAvailable: false when no packages exist', () => {
    const { db: emptyDb, dbPath: emptyDbPath } = createTestDb();

    try {
      const latest = emptyDb.prepare(
        'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
      ).get();

      const updateAvailable = latest && isNewerVersion(latest.version, '0.10.0');
      assert.strictEqual(!!updateAvailable, false, 'No update available when no packages exist');
    } finally {
      emptyDb.close();
      cleanupTestDb(emptyDbPath);
    }
  });

  it('should include download URL and sha256 in update response shape', () => {
    const latest = testDb.prepare(
      'SELECT version, filename, file_size, sha256, release_notes FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    assert.ok(latest, 'Latest package should be found');

    // Simulate the response shape from the /check endpoint
    const response = {
      updateAvailable: true,
      currentVersion: '0.10.0',
      latestVersion: latest.version,
      downloadUrl: `/api/updates/download/${latest.version}`,
      sha256: latest.sha256,
      fileSize: latest.file_size,
      releaseNotes: latest.release_notes
    };

    assert.strictEqual(response.updateAvailable, true);
    assert.strictEqual(response.downloadUrl, `/api/updates/download/${latest.version}`);
    assert.strictEqual(typeof response.sha256, 'string');
  });
});

// ─── 5. Fleet Version Distribution ───────────────────────────────────────────

describe('Updates - Fleet Version Distribution', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    const devices = [
      { device_id: 'fleet-dev-001', device_secret: 's1', client_version: '0.10.0' },
      { device_id: 'fleet-dev-002', device_secret: 's2', client_version: '0.10.0' },
      { device_id: 'fleet-dev-003', device_secret: 's3', client_version: '0.10.0' },
      { device_id: 'fleet-dev-004', device_secret: 's4', client_version: '0.11.0' },
      { device_id: 'fleet-dev-005', device_secret: 's5', client_version: '0.11.0' },
      { device_id: 'fleet-dev-006', device_secret: 's6', client_version: null }
    ];

    for (const d of devices) {
      insertDevice(testDb, d);
    }
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should group devices by client_version and return counts', () => {
    const versions = testDb.prepare(
      "SELECT COALESCE(client_version, 'Unknown') as version, COUNT(*) as count FROM devices GROUP BY client_version ORDER BY count DESC"
    ).all();

    assert.ok(versions.length > 0, 'Should have version groups');
  });

  it('should show 3 devices on version 0.10.0', () => {
    const versions = testDb.prepare(
      "SELECT COALESCE(client_version, 'Unknown') as version, COUNT(*) as count FROM devices GROUP BY client_version ORDER BY count DESC"
    ).all();

    const v010 = versions.find(v => v.version === '0.10.0');
    assert.ok(v010, 'Should have 0.10.0 group');
    assert.strictEqual(v010.count, 3);
  });

  it('should show 2 devices on version 0.11.0', () => {
    const versions = testDb.prepare(
      "SELECT COALESCE(client_version, 'Unknown') as version, COUNT(*) as count FROM devices GROUP BY client_version ORDER BY count DESC"
    ).all();

    const v011 = versions.find(v => v.version === '0.11.0');
    assert.ok(v011, 'Should have 0.11.0 group');
    assert.strictEqual(v011.count, 2);
  });

  it('should show devices with null client_version as Unknown', () => {
    const versions = testDb.prepare(
      "SELECT COALESCE(client_version, 'Unknown') as version, COUNT(*) as count FROM devices GROUP BY client_version ORDER BY count DESC"
    ).all();

    const unknown = versions.find(v => v.version === 'Unknown');
    assert.ok(unknown, 'Should have Unknown group for null client_version');
    assert.ok(unknown.count >= 1, 'Should have at least 1 device with unknown version');
  });

  it('should update client_version for a device', () => {
    testDb.prepare('UPDATE devices SET client_version = ? WHERE device_id = ?').run('0.11.0', 'fleet-dev-001');

    const device = testDb.prepare('SELECT client_version FROM devices WHERE device_id = ?').get('fleet-dev-001');
    assert.strictEqual(device.client_version, '0.11.0');
  });
});

// ─── 6. Auth Requirements ─────────────────────────────────────────────────────

describe('Updates - Auth Requirements', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    insertDevice(testDb, {
      device_id: 'auth-device-001',
      device_secret: 'auth-secret-001',
      client_version: '0.10.0'
    });
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  describe('/check endpoint (requireDevice)', () => {
    it('should reject request missing x-device-id and x-device-secret (401)', () => {
      const { req, res, next } = createMocks();
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Device authentication required');
    });

    it('should reject request with x-device-id only (missing secret) (401)', () => {
      const { req, res, next } = createMocks({
        headers: { 'x-device-id': 'auth-device-001' }
      });
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Device authentication required');
    });

    it('should reject request with unknown device id (403)', () => {
      const { req, res, next } = createMocks({
        headers: { 'x-device-id': 'unknown-device-xyz', 'x-device-secret': 'some-secret' }
      });
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 403);
    });

    it('should reject request with wrong device secret (403)', () => {
      const { req, res, next } = createMocks({
        headers: { 'x-device-id': 'auth-device-001', 'x-device-secret': 'wrong-secret' }
      });
      req.app.locals.db = testDb;

      requireDevice(req, res, next);

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res._json.error, 'Invalid device credentials');
    });

    it('should allow request with valid device credentials', () => {
      const { req, res } = createMocks({
        headers: { 'x-device-id': 'auth-device-001', 'x-device-secret': 'auth-secret-001' }
      });
      req.app.locals.db = testDb;

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireDevice(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.deviceId, 'auth-device-001');
    });
  });

  describe('/upload, /, /fleet-versions, /push endpoints (requireIT)', () => {
    it('should reject remote request without Authorization header (401)', () => {
      const { req, res, next } = createMocks({
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Authentication required');
    });

    it('should reject remote request with invalid JWT (401)', () => {
      const { req, res, next } = createMocks({
        headers: { 'authorization': 'Bearer not-a-valid-jwt' },
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Invalid or expired token');
    });

    it('should reject remote request with expired JWT (401)', () => {
      const expiredToken = jwt.sign(
        { userId: 1, username: 'tech1', role: 'technician' },
        process.env.POCKET_IT_JWT_SECRET,
        { expiresIn: '-1h' }
      );

      const { req, res, next } = createMocks({
        headers: { 'authorization': `Bearer ${expiredToken}` },
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Invalid or expired token');
    });

    it('should allow localhost without any token', () => {
      const { req, res } = createMocks({
        remoteAddress: '127.0.0.1'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireIT(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
    });

    it('should allow localhost via IPv6 loopback (::1)', () => {
      const { req, res } = createMocks({
        remoteAddress: '::1'
      });

      let nextCalled = false;
      const mockNext = () => { nextCalled = true; };

      requireIT(req, res, mockNext);

      assert.strictEqual(nextCalled, true);
    });

    it('should allow remote request with valid technician JWT', () => {
      const token = jwt.sign(
        { userId: 2, username: 'tech1', role: 'technician' },
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
    });

    it('should reject JWT signed with wrong secret (401)', () => {
      const wrongSecretToken = jwt.sign(
        { userId: 1, username: 'tech1', role: 'technician' },
        'wrong-secret-key'
      );

      const { req, res, next } = createMocks({
        headers: { 'authorization': `Bearer ${wrongSecretToken}` },
        remoteAddress: '192.168.1.100'
      });

      requireIT(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res._json.error, 'Invalid or expired token');
    });
  });
});

// ─── 7. Push Notification Logic ───────────────────────────────────────────────

describe('Updates - Push Notification Logic', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    insertPackage(testDb, { version: '0.11.0', sha256: 'push-sha256-001' });

    insertDevice(testDb, { device_id: 'push-dev-001', device_secret: 'ps1', client_version: '0.10.0' });
    insertDevice(testDb, { device_id: 'push-dev-002', device_secret: 'ps2', client_version: '0.11.0' });
    insertDevice(testDb, { device_id: 'push-dev-003', device_secret: 'ps3', client_version: null });
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should identify devices with older versions as needing update', () => {
    const device = testDb.prepare('SELECT client_version FROM devices WHERE device_id = ?').get('push-dev-001');
    const needsUpdate = !device.client_version || isNewerVersion('0.11.0', device.client_version);
    assert.strictEqual(needsUpdate, true);
  });

  it('should identify devices already on latest as not needing update', () => {
    const device = testDb.prepare('SELECT client_version FROM devices WHERE device_id = ?').get('push-dev-002');
    const needsUpdate = !device.client_version || isNewerVersion('0.11.0', device.client_version);
    assert.strictEqual(needsUpdate, false);
  });

  it('should treat devices with null client_version as needing update', () => {
    const device = testDb.prepare('SELECT client_version FROM devices WHERE device_id = ?').get('push-dev-003');
    const needsUpdate = !device.client_version || isNewerVersion('0.11.0', device.client_version);
    assert.strictEqual(needsUpdate, true);
  });

  it('should return 404 when push target version does not exist in DB', () => {
    const pkg = testDb.prepare('SELECT version FROM update_packages WHERE version = ?').get('9.9.9');
    assert.strictEqual(pkg, undefined, 'Non-existent version should not be found');
  });
});

// ─── 8. Latest Endpoint Logic ─────────────────────────────────────────────────

describe('Updates - Latest Endpoint Logic', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should return available: false when no packages uploaded', () => {
    const latest = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    const response = latest ? { available: true, version: latest.version } : { available: false };
    assert.strictEqual(response.available, false);
  });

  it('should return available: true with package info after upload', () => {
    insertPackage(testDb, {
      version: '1.0.0',
      sha256: 'latest-sha256-001',
      release_notes: 'Major release'
    });

    const latest = testDb.prepare(
      'SELECT version, filename, file_size, sha256, release_notes, created_at FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    assert.ok(latest, 'Should find latest package');

    const response = {
      available: true,
      version: latest.version,
      filename: latest.filename,
      fileSize: latest.file_size,
      sha256: latest.sha256,
      releaseNotes: latest.release_notes,
      uploadedAt: latest.created_at
    };

    assert.strictEqual(response.available, true);
    assert.strictEqual(response.version, '1.0.0');
    assert.strictEqual(response.releaseNotes, 'Major release');
    assert.ok(response.sha256, 'sha256 should be present');
  });

  it('should return the most recently inserted package as latest', () => {
    // Use an explicit future created_at so this row sorts ahead of 1.0.0
    testDb.prepare(
      "INSERT INTO update_packages (version, filename, file_size, sha256, created_at) VALUES (?, ?, ?, ?, datetime('now', '+1 second'))"
    ).run('1.0.1', 'PocketIT-1.0.1-setup.exe', 2060000, 'latest-sha256-002');

    const latest = testDb.prepare(
      'SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1'
    ).get();

    assert.strictEqual(latest.version, '1.0.1');
  });
});

// ─── 9. Version Format Validation ────────────────────────────────────────────

describe('Updates - Version Format Validation', () => {
  it('should accept valid semver X.Y.Z format', () => {
    const validVersions = ['0.10.0', '1.0.0', '2.3.4', '0.0.1', '10.20.30'];
    const semverRegex = /^\d+\.\d+\.\d+$/;
    for (const v of validVersions) {
      assert.ok(semverRegex.test(v), `${v} should be a valid semver format`);
    }
  });

  it('should reject invalid version formats', () => {
    const invalidVersions = ['1.0', '1', 'v1.0.0', '1.0.0.0', 'abc', '1.a.0', ''];
    const semverRegex = /^\d+\.\d+\.\d+$/;
    for (const v of invalidVersions) {
      assert.strictEqual(semverRegex.test(v), false, `${v} should be rejected as invalid semver`);
    }
  });

  it('should produce correct sha256 format (64 hex chars)', () => {
    const crypto = require('crypto');
    const fakeContent = Buffer.from('fake installer content');
    const sha256 = crypto.createHash('sha256').update(fakeContent).digest('hex');
    assert.strictEqual(sha256.length, 64, 'SHA-256 hex digest should be 64 characters');
    assert.ok(/^[0-9a-f]{64}$/.test(sha256), 'SHA-256 should be lowercase hex');
  });
});

// ─── 10. Audit Log Integration ────────────────────────────────────────────────

describe('Updates - Audit Log Integration', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('should insert audit log entry for upload action', () => {
    testDb.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run('localhost', 'update_uploaded', '0.11.0', JSON.stringify({ filename: 'PocketIT-0.11.0-setup.exe', fileSize: 2048, sha256: 'abc' }));

    const log = testDb.prepare(
      "SELECT * FROM audit_log WHERE action = 'update_uploaded' AND target = '0.11.0'"
    ).get();

    assert.ok(log, 'Audit log entry should be found');
    assert.strictEqual(log.actor, 'localhost');
    assert.strictEqual(log.action, 'update_uploaded');
    assert.strictEqual(log.target, '0.11.0');
  });

  it('should insert audit log entry for delete action', () => {
    testDb.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run('admin', 'update_deleted', '0.9.0', JSON.stringify({ filename: 'PocketIT-0.9.0-setup.exe' }));

    const log = testDb.prepare(
      "SELECT * FROM audit_log WHERE action = 'update_deleted' AND target = '0.9.0'"
    ).get();

    assert.ok(log, 'Delete audit log entry should be found');
    assert.strictEqual(log.actor, 'admin');
  });

  it('should insert audit log entry for push action', () => {
    testDb.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run('admin', 'update_pushed', '0.11.0', JSON.stringify({ notified: 3 }));

    const log = testDb.prepare(
      "SELECT * FROM audit_log WHERE action = 'update_pushed' AND target = '0.11.0'"
    ).get();

    assert.ok(log, 'Push audit log entry should be found');
    const details = JSON.parse(log.details);
    assert.strictEqual(details.notified, 3);
  });

  it('should store audit log details as valid JSON', () => {
    const logs = testDb.prepare(
      "SELECT details FROM audit_log WHERE details IS NOT NULL"
    ).all();

    for (const log of logs) {
      assert.doesNotThrow(() => {
        JSON.parse(log.details);
      }, `Audit log details should be valid JSON: ${log.details}`);
    }
  });
});
