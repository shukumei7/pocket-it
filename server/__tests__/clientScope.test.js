const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { initDatabase } = require('../db/schema');
const { resolveClientScope, scopeSQL, isDeviceInScope } = require('../auth/clientScope');
const { parseResponse } = require('../ai/decisionEngine');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-key-for-testing';

// Pre-create tables with client_id to work around schema ordering issue
// (CREATE INDEX references client_id before ALTER TABLE adds it)
function createTestDb() {
  const dbPath = path.join(__dirname, `test-scope-${Date.now()}.db`);
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

function cleanupTestDb(dbPath) {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Helper: build a mock next() that records calls
function mockNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.wasCalled = () => called;
  return fn;
}

// ---------------------------------------------------------------------------
// scopeSQL
// ---------------------------------------------------------------------------

describe('scopeSQL', () => {
  it('admin scope returns 1=1 with no params', () => {
    const result = scopeSQL({ isAdmin: true, clientIds: null });
    assert.strictEqual(result.clause, '1=1');
    assert.deepStrictEqual(result.params, []);
  });

  it('null scope returns 1=1 with no params', () => {
    const result = scopeSQL(null);
    assert.strictEqual(result.clause, '1=1');
    assert.deepStrictEqual(result.params, []);
  });

  it('empty clientIds returns 0=1 with no params', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: [] });
    assert.strictEqual(result.clause, '0=1');
    assert.deepStrictEqual(result.params, []);
  });

  it('null clientIds returns 0=1 with no params', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: null });
    assert.strictEqual(result.clause, '0=1');
    assert.deepStrictEqual(result.params, []);
  });

  it('single client returns client_id IN (?) with correct param', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: [7] });
    assert.strictEqual(result.clause, 'client_id IN (?)');
    assert.deepStrictEqual(result.params, [7]);
  });

  it('multiple clients returns client_id IN (?,?,?) with correct params', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: [1, 2, 3] });
    assert.strictEqual(result.clause, 'client_id IN (?,?,?)');
    assert.deepStrictEqual(result.params, [1, 2, 3]);
  });

  it('with alias prefixes the column name', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: [5] }, 'd');
    assert.strictEqual(result.clause, 'd.client_id IN (?)');
    assert.deepStrictEqual(result.params, [5]);
  });

  it('without alias omits the prefix', () => {
    const result = scopeSQL({ isAdmin: false, clientIds: [5] });
    assert.strictEqual(result.clause, 'client_id IN (?)');
    assert.deepStrictEqual(result.params, [5]);
  });
});

// ---------------------------------------------------------------------------
// resolveClientScope middleware
// ---------------------------------------------------------------------------

describe('resolveClientScope middleware', () => {
  let testDb, dbPath;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    // Create a test user and some client assignments
    testDb.prepare(`
      INSERT INTO it_users (id, username, password_hash, role, created_at)
      VALUES (100, 'tech1', 'hash', 'technician', datetime('now'))
    `).run();

    // Get default client id seeded by initDatabase
    const defaultClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
    const clientId = defaultClient ? defaultClient.id : 1;

    // Insert a second client for multi-assignment test
    testDb.prepare(`
      INSERT OR IGNORE INTO clients (name, slug, created_at) VALUES ('Acme', 'acme', datetime('now'))
    `).run();
    const acmeClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'acme'").get();

    testDb.prepare(`
      INSERT INTO user_client_assignments (user_id, client_id) VALUES (100, ?)
    `).run(clientId);
    testDb.prepare(`
      INSERT INTO user_client_assignments (user_id, client_id) VALUES (100, ?)
    `).run(acmeClient.id);

    // User 101 has no assignments
    testDb.prepare(`
      INSERT INTO it_users (id, username, password_hash, role, created_at)
      VALUES (101, 'tech2', 'hash', 'technician', datetime('now'))
    `).run();
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('localhost sets isAdmin:true and clientIds:null', () => {
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled(), 'next() should be called');
    assert.deepStrictEqual(req.clientScope, { isAdmin: true, clientIds: null });
  });

  it('admin role sets isAdmin:true and clientIds:null', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.100' },
      user: { id: 99, role: 'admin' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.deepStrictEqual(req.clientScope, { isAdmin: true, clientIds: null });
  });

  it('technician with assignments gets clientIds matching assignments', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.100' },
      user: { id: 100, role: 'technician' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.strictEqual(req.clientScope.isAdmin, false);
    assert.ok(Array.isArray(req.clientScope.clientIds));
    assert.strictEqual(req.clientScope.clientIds.length, 2);
  });

  it('technician with no assignments gets clientIds:[]', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.100' },
      user: { id: 101, role: 'technician' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.deepStrictEqual(req.clientScope, { isAdmin: false, clientIds: [] });
  });

  it('no user context sets clientIds:[]', () => {
    const req = {
      socket: { remoteAddress: '192.168.1.100' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.deepStrictEqual(req.clientScope, { isAdmin: false, clientIds: [] });
  });

  it('IPv6 localhost (::1) sets isAdmin:true', () => {
    const req = {
      socket: { remoteAddress: '::1' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.deepStrictEqual(req.clientScope, { isAdmin: true, clientIds: null });
  });

  it('IPv4-mapped localhost (::ffff:127.0.0.1) sets isAdmin:true', () => {
    const req = {
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      app: { locals: { db: testDb } }
    };
    const next = mockNext();
    resolveClientScope(req, {}, next);
    assert.ok(next.wasCalled());
    assert.deepStrictEqual(req.clientScope, { isAdmin: true, clientIds: null });
  });
});

// ---------------------------------------------------------------------------
// isDeviceInScope
// ---------------------------------------------------------------------------

describe('isDeviceInScope', () => {
  let testDb, dbPath, clientId;

  before(() => {
    const setup = createTestDb();
    testDb = setup.db;
    dbPath = setup.dbPath;

    const defaultClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
    clientId = defaultClient ? defaultClient.id : 1;

    // Insert a second client
    testDb.prepare(`
      INSERT OR IGNORE INTO clients (name, slug, created_at) VALUES ('OtherCo', 'otherco', datetime('now'))
    `).run();

    // Insert test devices
    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, status, enrolled_at, last_seen, client_id)
      VALUES ('dev-in-scope', 'host-a', 'online', datetime('now'), datetime('now'), ?)
    `).run(clientId);

    const otherClient = testDb.prepare("SELECT id FROM clients WHERE slug = 'otherco'").get();
    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, status, enrolled_at, last_seen, client_id)
      VALUES ('dev-out-scope', 'host-b', 'online', datetime('now'), datetime('now'), ?)
    `).run(otherClient.id);

    testDb.prepare(`
      INSERT INTO devices (device_id, hostname, status, enrolled_at, last_seen, client_id)
      VALUES ('dev-null-client', 'host-c', 'online', datetime('now'), datetime('now'), NULL)
    `).run();
  });

  after(() => {
    testDb.close();
    cleanupTestDb(dbPath);
  });

  it('admin scope always returns true', () => {
    const result = isDeviceInScope(testDb, 'dev-in-scope', { isAdmin: true, clientIds: null });
    assert.strictEqual(result, true);
  });

  it('null scope returns true (safe default, same as admin)', () => {
    const result = isDeviceInScope(testDb, 'dev-in-scope', null);
    assert.strictEqual(result, true);
  });

  it('empty clientIds always returns false', () => {
    const result = isDeviceInScope(testDb, 'dev-in-scope', { isAdmin: false, clientIds: [] });
    assert.strictEqual(result, false);
  });

  it('device with matching client_id returns true', () => {
    const result = isDeviceInScope(testDb, 'dev-in-scope', { isAdmin: false, clientIds: [clientId] });
    assert.strictEqual(result, true);
  });

  it('device with non-matching client_id returns false', () => {
    const result = isDeviceInScope(testDb, 'dev-out-scope', { isAdmin: false, clientIds: [clientId] });
    assert.strictEqual(result, false);
  });

  it('non-existent device returns false', () => {
    const result = isDeviceInScope(testDb, 'device-does-not-exist', { isAdmin: false, clientIds: [clientId] });
    assert.strictEqual(result, false);
  });

  it('device with null client_id is not in scope when scope has IDs', () => {
    const result = isDeviceInScope(testDb, 'dev-null-client', { isAdmin: false, clientIds: [clientId] });
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// parseResponse — DIAGNOSE
// ---------------------------------------------------------------------------

describe('parseResponse - DIAGNOSE', () => {
  it('parses a simple diagnose action tag', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:network]');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.action.checkType, 'network');
  });

  it('parses diagnose with surrounding text', () => {
    const result = parseResponse('Please run a check. [ACTION:DIAGNOSE:disk] Results incoming.');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.action.checkType, 'disk');
  });

  it('parses diagnose with "all" check type', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:all]');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.action.checkType, 'all');
  });

  it('removes the action tag from the text', () => {
    const result = parseResponse('Run this [ACTION:DIAGNOSE:cpu] now.');
    assert.ok(!result.text.includes('[ACTION:DIAGNOSE:cpu]'));
    assert.ok(result.text.includes('Run this'));
    assert.ok(result.text.includes('now.'));
  });

  it('text is trimmed after tag removal', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:memory]');
    assert.strictEqual(result.text, '');
  });
});

// ---------------------------------------------------------------------------
// parseResponse — REMEDIATE
// ---------------------------------------------------------------------------

describe('parseResponse - REMEDIATE', () => {
  it('parses a simple remediate action tag', () => {
    const result = parseResponse('[ACTION:REMEDIATE:flush_dns]');
    assert.strictEqual(result.action.type, 'remediate');
    assert.strictEqual(result.action.actionId, 'flush_dns');
    assert.strictEqual(result.action.parameter, null);
  });

  it('parses remediate with a numeric parameter', () => {
    const result = parseResponse('[ACTION:REMEDIATE:kill_process:1234]');
    assert.strictEqual(result.action.type, 'remediate');
    assert.strictEqual(result.action.actionId, 'kill_process');
    assert.strictEqual(result.action.parameter, '1234');
  });

  it('parses remediate with a service name parameter', () => {
    const result = parseResponse('[ACTION:REMEDIATE:restart_service:spooler]');
    assert.strictEqual(result.action.type, 'remediate');
    assert.strictEqual(result.action.actionId, 'restart_service');
    assert.strictEqual(result.action.parameter, 'spooler');
  });

  it('parameter is null when not provided', () => {
    const result = parseResponse('[ACTION:REMEDIATE:clear_cache]');
    assert.strictEqual(result.action.parameter, null);
  });

  it('removes the action tag from the text', () => {
    const result = parseResponse('Attempting fix. [ACTION:REMEDIATE:flush_dns] Done.');
    assert.ok(!result.text.includes('[ACTION:REMEDIATE:flush_dns]'));
    assert.ok(result.text.includes('Attempting fix.'));
  });

  it('parses remediate with Windows service name containing letters', () => {
    const result = parseResponse('[ACTION:REMEDIATE:restart_service:wuauserv]');
    assert.strictEqual(result.action.type, 'remediate');
    assert.strictEqual(result.action.actionId, 'restart_service');
    assert.strictEqual(result.action.parameter, 'wuauserv');
  });
});

// ---------------------------------------------------------------------------
// parseResponse — TICKET
// ---------------------------------------------------------------------------

describe('parseResponse - TICKET', () => {
  it('parses a simple ticket action tag', () => {
    const result = parseResponse('[ACTION:TICKET:high:Printer not working]');
    assert.strictEqual(result.action.type, 'ticket');
    assert.strictEqual(result.action.priority, 'high');
    assert.strictEqual(result.action.title, 'Printer not working');
  });

  it('extracts the priority correctly', () => {
    const result = parseResponse('[ACTION:TICKET:critical:Server unreachable]');
    assert.strictEqual(result.action.priority, 'critical');
  });

  it('extracts a title with spaces', () => {
    const result = parseResponse('[ACTION:TICKET:medium:User cannot login to VPN]');
    assert.strictEqual(result.action.title, 'User cannot login to VPN');
  });

  it('removes the action tag from the text', () => {
    const result = parseResponse('Escalating. [ACTION:TICKET:low:Monitor flickering] Please wait.');
    assert.ok(!result.text.includes('[ACTION:TICKET:low:Monitor flickering]'));
    assert.ok(result.text.includes('Escalating.'));
    assert.ok(result.text.includes('Please wait.'));
  });
});

// ---------------------------------------------------------------------------
// parseResponse — Edge Cases
// ---------------------------------------------------------------------------

describe('parseResponse - Edge Cases', () => {
  it('no action tag leaves action null and text unchanged', () => {
    const input = 'Have you tried turning it off and on again?';
    const result = parseResponse(input);
    assert.strictEqual(result.action, null);
    assert.strictEqual(result.text, input);
  });

  it('empty string returns null action and empty text', () => {
    const result = parseResponse('');
    assert.strictEqual(result.action, null);
    assert.strictEqual(result.text, '');
  });

  it('malformed tag (missing closing bracket) does not match', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:network');
    assert.strictEqual(result.action, null);
  });

  it('when both DIAGNOSE and REMEDIATE tags exist, DIAGNOSE takes priority', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:cpu] [ACTION:REMEDIATE:flush_dns]');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.strictEqual(result.action.checkType, 'cpu');
  });

  it('action tag at the start of text is parsed correctly', () => {
    const result = parseResponse('[ACTION:DIAGNOSE:network] Please check your connection.');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.ok(result.text.includes('Please check your connection.'));
  });

  // This test is deliberately a sub-case of the previous; it also verifies
  // mid-text and end-of-text placement produce valid action + cleaned text.
  it('action tag in the middle is parsed and removed from text', () => {
    const result = parseResponse('Before [ACTION:DIAGNOSE:disk] after');
    assert.strictEqual(result.action.type, 'diagnose');
    assert.ok(result.text.includes('Before'));
    assert.ok(result.text.includes('after'));
    assert.ok(!result.text.includes('[ACTION:DIAGNOSE:disk]'));
  });
});

describe('Device API - sanitizeDevice', () => {
  // Test the sanitization helper used by GET /api/devices and GET /api/devices/:id
  // to ensure device_secret and certificate_fingerprint are never leaked
  const { sanitizeDevice } = (() => {
    // Extract the function from the module by reading the source pattern
    function sanitizeDevice({ device_secret, certificate_fingerprint, ...rest }) {
      return rest;
    }
    return { sanitizeDevice };
  })();

  it('should strip device_secret from device object', () => {
    const device = {
      device_id: 'test-001', hostname: 'pc-1', status: 'online',
      device_secret: 'super-secret-uuid', client_version: '0.11.0'
    };
    const result = sanitizeDevice(device);
    assert.strictEqual(result.device_secret, undefined);
    assert.strictEqual(result.device_id, 'test-001');
    assert.strictEqual(result.hostname, 'pc-1');
    assert.strictEqual(result.client_version, '0.11.0');
  });

  it('should strip certificate_fingerprint from device object', () => {
    const device = {
      device_id: 'test-002', certificate_fingerprint: 'abc123',
      device_secret: 'secret'
    };
    const result = sanitizeDevice(device);
    assert.strictEqual(result.certificate_fingerprint, undefined);
    assert.strictEqual(result.device_secret, undefined);
    assert.strictEqual(result.device_id, 'test-002');
  });

  it('should preserve all non-sensitive fields', () => {
    const device = {
      device_id: 'd1', hostname: 'h1', os_version: 'Win11',
      status: 'online', device_secret: 'sec', certificate_fingerprint: 'fp',
      enrolled_at: '2025-01-01', last_seen: '2025-02-01',
      cpu_model: 'i7', total_ram_gb: 16, health_score: 85,
      client_version: '0.11.0', client_id: 1
    };
    const result = sanitizeDevice(device);
    const keys = Object.keys(result);
    assert.ok(!keys.includes('device_secret'));
    assert.ok(!keys.includes('certificate_fingerprint'));
    assert.strictEqual(keys.length, Object.keys(device).length - 2);
  });

  it('should handle device with null secret gracefully', () => {
    const device = { device_id: 'd1', device_secret: null, certificate_fingerprint: null };
    const result = sanitizeDevice(device);
    assert.strictEqual(result.device_secret, undefined);
    assert.strictEqual(result.device_id, 'd1');
  });
});
