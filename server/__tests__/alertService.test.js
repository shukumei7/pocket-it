const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { initDatabase } = require('../db/schema');
const AlertService = require('../services/alertService');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-key-for-testing';

function createTestDb() {
  const dbPath = path.join(__dirname, `test-alerts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function insertTestDevice(db, deviceId = 'test-dev') {
  db.prepare(
    "INSERT OR IGNORE INTO devices (device_id, hostname, status, enrolled_at, last_seen, device_secret) VALUES (?, 'test-host', 'online', datetime('now'), datetime('now'), 'secret')"
  ).run(deviceId);
}

function insertThreshold(db, { checkType, fieldPath, operator, thresholdValue, severity, consecutiveRequired = 1 }) {
  const result = db.prepare(
    'INSERT INTO alert_thresholds (check_type, field_path, operator, threshold_value, severity, consecutive_required, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).run(checkType, fieldPath, operator, thresholdValue, severity, consecutiveRequired);
  return result.lastInsertRowid;
}

// ─── _extractValue ────────────────────────────────────────────────────────────

describe('AlertService._extractValue — dot-path traversal', () => {
  let service;

  before(() => {
    service = new AlertService(null);
  });

  it('simple top-level field returns numeric value', () => {
    const result = service._extractValue({ usagePercent: 85 }, 'usagePercent');
    assert.strictEqual(result, 85);
  });

  it('nested field via dot notation returns numeric value', () => {
    const result = service._extractValue({ drives: [{ usagePercent: 92 }] }, 'drives.0.usagePercent');
    assert.strictEqual(result, 92);
  });

  it('array length via .length on array property', () => {
    const result = service._extractValue({ stoppedAutoServices: [{}, {}, {}] }, 'stoppedAutoServices.length');
    assert.strictEqual(result, 3);
  });

  it('array length when data itself is the array', () => {
    const result = service._extractValue([{}, {}], 'length');
    assert.strictEqual(result, 2);
  });

  it('returns undefined for missing field', () => {
    const result = service._extractValue({ foo: 1 }, 'bar');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for null data', () => {
    const result = service._extractValue(null, 'usagePercent');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for undefined data', () => {
    const result = service._extractValue(undefined, 'usagePercent');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for empty field path', () => {
    const result = service._extractValue({ x: 1 }, '');
    assert.strictEqual(result, undefined);
  });

  it('deep nesting three levels returns value', () => {
    const result = service._extractValue({ a: { b: { c: 42 } } }, 'a.b.c');
    assert.strictEqual(result, 42);
  });

  it('returns undefined for string value (non-number)', () => {
    const result = service._extractValue({ x: 'hello' }, 'x');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for out-of-bounds array index', () => {
    const result = service._extractValue({ drives: [{ x: 1 }] }, 'drives.5.x');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when intermediate path segment is null', () => {
    const result = service._extractValue({ a: null }, 'a.b');
    assert.strictEqual(result, undefined);
  });

  it('returns 0 as a valid numeric value', () => {
    const result = service._extractValue({ criticals: 0 }, 'criticals');
    assert.strictEqual(result, 0);
  });

  it('returns undefined when path traverses into a primitive', () => {
    const result = service._extractValue({ a: 42 }, 'a.b');
    assert.strictEqual(result, undefined);
  });

  it('empty array length returns 0', () => {
    const result = service._extractValue({ items: [] }, 'items.length');
    assert.strictEqual(result, 0);
  });
});

// ─── _compare ─────────────────────────────────────────────────────────────────

describe('AlertService._compare — threshold comparison', () => {
  let service;

  before(() => {
    service = new AlertService(null);
  });

  it('> returns true when value exceeds threshold', () => {
    assert.strictEqual(service._compare(91, '>', 90), true);
  });

  it('> returns false when value is below threshold', () => {
    assert.strictEqual(service._compare(89, '>', 90), false);
  });

  it('< returns true when value is below threshold', () => {
    assert.strictEqual(service._compare(5, '<', 10), true);
  });

  it('>= returns true when value equals threshold', () => {
    assert.strictEqual(service._compare(90, '>=', 90), true);
  });

  it('>= returns false when value is below threshold', () => {
    assert.strictEqual(service._compare(89, '>=', 90), false);
  });

  it('<= returns true when value equals threshold', () => {
    assert.strictEqual(service._compare(90, '<=', 90), true);
  });

  it('= returns true when value equals threshold exactly', () => {
    assert.strictEqual(service._compare(90, '=', 90), true);
  });

  it('= returns false when value differs', () => {
    assert.strictEqual(service._compare(91, '=', 90), false);
  });

  it('unknown operator returns false', () => {
    assert.strictEqual(service._compare(100, '!=', 90), false);
  });
});

// ─── evaluateResult ───────────────────────────────────────────────────────────

describe('AlertService.evaluateResult — no thresholds', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('returns empty array when no thresholds exist for check type', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.deepStrictEqual(alerts, []);
  });

  it('returns empty array for unknown check type', () => {
    const alerts = service.evaluateResult('test-dev', 'unknown_check', { value: 100 });
    assert.deepStrictEqual(alerts, []);
  });
});

describe('AlertService.evaluateResult — below threshold', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('returns empty array when value is below threshold', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 70 });
    assert.deepStrictEqual(alerts, []);
  });

  it('does not insert an alert row when value is below threshold', () => {
    service.evaluateResult('test-dev', 'cpu', { usagePercent: 50 });
    const count = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE device_id = 'test-dev'").get().c;
    assert.strictEqual(count, 0);
  });
});

describe('AlertService.evaluateResult — consecutive_required=1', () => {
  let db, dbPath, service, thresholdId;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    thresholdId = insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('creates alert immediately on first breach with consecutive_required=1', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].device_id, 'test-dev');
    assert.strictEqual(alerts[0].check_type, 'cpu');
    assert.strictEqual(alerts[0].severity, 'critical');
    assert.strictEqual(alerts[0].status, 'active');
  });

  it('alert message contains checkType, fieldPath, value, operator, and thresholdValue', () => {
    const alerts = db.prepare("SELECT message FROM alerts WHERE device_id = 'test-dev' AND check_type = 'cpu'").all();
    assert.ok(alerts.length > 0, 'alert should exist');
    const msg = alerts[0].message;
    assert.ok(msg.includes('cpu'), 'message should contain checkType');
    assert.ok(msg.includes('usagePercent'), 'message should contain fieldPath');
    assert.ok(msg.includes('95'), 'message should contain value');
    assert.ok(msg.includes('>'), 'message should contain operator');
    assert.ok(msg.includes('90'), 'message should contain threshold');
  });
});

describe('AlertService.evaluateResult — consecutive_required=2', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'warning', consecutiveRequired: 2 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('returns empty array on first breach when consecutive_required=2', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.deepStrictEqual(alerts, []);
  });

  it('creates alert on second consecutive breach', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.strictEqual(alerts.length, 1);
  });
});

describe('AlertService.evaluateResult — consecutive counter reset', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'warning', consecutiveRequired: 2 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('resets consecutive counter when value drops below threshold', () => {
    // Call 1: above — counter = 1, no alert
    service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    // Call 2: below — counter resets to 0
    service.evaluateResult('test-dev', 'cpu', { usagePercent: 50 });
    // Call 3: above — counter = 1 again (still needs 2), no alert
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.deepStrictEqual(alerts, []);
  });

  it('creates alert after two consecutive breaches following a reset', () => {
    // Call 4: above — counter = 2, now alert fires
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.strictEqual(alerts.length, 1);
  });
});

describe('AlertService.evaluateResult — duplicate suppression', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('does not create a second alert when an active alert already exists', () => {
    service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    const second = service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    assert.deepStrictEqual(second, []);
    const count = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE device_id = 'test-dev' AND status = 'active'").get().c;
    assert.strictEqual(count, 1);
  });
});

describe('AlertService.evaluateResult — auto-resolve', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('active alert is auto-resolved when value drops below threshold', () => {
    service.evaluateResult('test-dev', 'cpu', { usagePercent: 95 });
    const before = db.prepare("SELECT status FROM alerts WHERE device_id = 'test-dev'").get();
    assert.strictEqual(before.status, 'active');

    service.evaluateResult('test-dev', 'cpu', { usagePercent: 50 });
    const after = db.prepare("SELECT status, resolved_at FROM alerts WHERE device_id = 'test-dev'").get();
    assert.strictEqual(after.status, 'resolved');
    assert.ok(after.resolved_at, 'resolved_at should be set');
  });
});

describe('AlertService.evaluateResult — multiple thresholds', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 80, severity: 'warning', consecutiveRequired: 1 });
    insertThreshold(db, { checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1 });
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('value 91 triggers both warning and critical thresholds', () => {
    const alerts = service.evaluateResult('test-dev', 'cpu', { usagePercent: 91 });
    assert.strictEqual(alerts.length, 2);
    const severities = alerts.map(a => a.severity).sort();
    assert.deepStrictEqual(severities, ['critical', 'warning']);
  });
});

// ─── Uptime alerts ────────────────────────────────────────────────────────────

describe('AlertService — uptime alerts', () => {
  let db, dbPath, service;

  before(() => {
    ({ db, dbPath } = createTestDb());
    insertTestDevice(db);
    service = new AlertService(db);
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('createUptimeAlert creates alert with check_type=uptime and severity=critical', () => {
    const alert = service.createUptimeAlert('test-dev', 'test-host');
    assert.ok(alert, 'alert should be returned');
    assert.strictEqual(alert.check_type, 'uptime');
    assert.strictEqual(alert.severity, 'critical');
    assert.strictEqual(alert.status, 'active');
    assert.strictEqual(alert.device_id, 'test-dev');
  });

  it('createUptimeAlert message contains device hostname', () => {
    // Resolve the existing alert first to allow a new test
    service.resolveUptimeAlert('test-dev');
    const alert = service.createUptimeAlert('test-dev', 'my-special-host');
    assert.ok(alert.message.includes('my-special-host'), 'message should contain hostname');
  });

  it('duplicate createUptimeAlert is suppressed (returns null)', () => {
    // An active uptime alert should already exist from the previous test
    const duplicate = service.createUptimeAlert('test-dev', 'test-host');
    assert.strictEqual(duplicate, null);
  });

  it('resolveUptimeAlert resolves active uptime alert', () => {
    service.resolveUptimeAlert('test-dev');
    const alert = db.prepare(
      "SELECT status FROM alerts WHERE device_id = 'test-dev' AND check_type = 'uptime' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.strictEqual(alert.status, 'resolved');
  });

  it('resolveUptimeAlert on non-existent alert does not throw', () => {
    assert.doesNotThrow(() => {
      service.resolveUptimeAlert('nonexistent-device-xyz');
    });
  });
});

// ─── Alert lifecycle ──────────────────────────────────────────────────────────

describe('AlertService — alert lifecycle', () => {
  let db, dbPath, service, alertId;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);

    const thresholdId = insertThreshold(db, {
      checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1
    });

    service = new AlertService(db);

    // Create one alert for lifecycle tests
    const result = db.prepare(
      "INSERT INTO alerts (device_id, threshold_id, check_type, severity, message, field_path, field_value) VALUES ('test-dev', ?, 'cpu', 'critical', 'test alert', 'usagePercent', 95)"
    ).run(thresholdId);
    alertId = result.lastInsertRowid;
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('acknowledgeAlert transitions active alert to acknowledged and sets acknowledged_by', () => {
    const updated = service.acknowledgeAlert(alertId, 'tech-user');
    assert.strictEqual(updated.status, 'acknowledged');
    assert.strictEqual(updated.acknowledged_by, 'tech-user');
    assert.ok(updated.acknowledged_at, 'acknowledged_at should be set');
  });

  it('acknowledgeAlert on already-acknowledged alert leaves it unchanged', () => {
    // Alert is now acknowledged; trying to acknowledge again (only works on 'active')
    const result = service.acknowledgeAlert(alertId, 'another-tech');
    // Status should remain 'acknowledged' — the WHERE clause only matches 'active'
    assert.strictEqual(result.status, 'acknowledged');
    assert.strictEqual(result.acknowledged_by, 'tech-user');
  });

  it('resolveAlert transitions acknowledged alert to resolved', () => {
    const resolved = service.resolveAlert(alertId);
    assert.strictEqual(resolved.status, 'resolved');
    assert.ok(resolved.resolved_at, 'resolved_at should be set');
  });

  it('resolveAlert on an active alert transitions it to resolved', () => {
    const result = db.prepare(
      "INSERT INTO alerts (device_id, threshold_id, check_type, severity, message, field_path, field_value) VALUES ('test-dev', NULL, 'cpu', 'warning', 'active alert', 'usagePercent', 85)"
    ).run();
    const newAlertId = result.lastInsertRowid;
    const resolved = service.resolveAlert(newAlertId);
    assert.strictEqual(resolved.status, 'resolved');
  });

  it('getStats returns correct active, critical, and warning counts', () => {
    // Insert known alerts: 1 active critical, 1 acknowledged warning
    db.prepare("INSERT INTO alerts (device_id, threshold_id, check_type, severity, status, message) VALUES ('test-dev', NULL, 'cpu', 'critical', 'active', 'stats test critical')").run();
    db.prepare("INSERT INTO alerts (device_id, threshold_id, check_type, severity, status, message) VALUES ('test-dev', NULL, 'memory', 'warning', 'acknowledged', 'stats test warning')").run();

    const stats = service.getStats();
    // activeCount = all active + acknowledged; verify criticalCount and warningCount are at least 1
    assert.ok(typeof stats.activeCount === 'number', 'activeCount should be a number');
    assert.ok(stats.criticalCount >= 1, 'criticalCount should be at least 1');
    assert.ok(stats.warningCount >= 1, 'warningCount should be at least 1');
  });
});

// ─── Auto-remediation ─────────────────────────────────────────────────────────

describe('AlertService — auto-remediation policies', () => {
  let db, dbPath, service, thresholdId, policyId;

  before(() => {
    ({ db, dbPath } = createTestDb());
    db.prepare('DELETE FROM alert_thresholds').run();
    insertTestDevice(db);

    thresholdId = insertThreshold(db, {
      checkType: 'cpu', fieldPath: 'usagePercent', operator: '>', thresholdValue: 90, severity: 'critical', consecutiveRequired: 1
    });

    service = new AlertService(db);

    // Insert a base policy with no cooldown history
    const result = db.prepare(
      'INSERT INTO auto_remediation_policies (threshold_id, action_id, parameter, cooldown_minutes, require_consent, enabled, last_triggered_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(thresholdId, 'restart_service', 'WinRM', 30, 1, 1, null);
    policyId = result.lastInsertRowid;
  });

  after(() => {
    db.close();
    cleanupTestDb(dbPath);
  });

  it('getAutoRemediationPolicy returns policy when it exists and has no cooldown', () => {
    const policy = service.getAutoRemediationPolicy(thresholdId);
    assert.ok(policy, 'policy should be returned');
    assert.strictEqual(policy.action_id, 'restart_service');
    assert.strictEqual(policy.threshold_id, thresholdId);
  });

  it('getAutoRemediationPolicy returns null when thresholdId is null', () => {
    const policy = service.getAutoRemediationPolicy(null);
    assert.strictEqual(policy, null);
  });

  it('getAutoRemediationPolicy returns null when no policy exists for threshold', () => {
    const policy = service.getAutoRemediationPolicy(99999);
    assert.strictEqual(policy, null);
  });

  it('getAutoRemediationPolicy returns null when policy is disabled', () => {
    const result = db.prepare(
      'INSERT INTO auto_remediation_policies (threshold_id, action_id, cooldown_minutes, enabled, last_triggered_at) VALUES (?, ?, ?, ?, ?)'
    ).run(thresholdId, 'clear_temp', 30, 0, null);
    const disabledPolicyThresholdId = thresholdId;

    // We cannot easily distinguish by threshold alone since multiple policies share one threshold.
    // Test using a new threshold for the disabled policy.
    const disabledThresholdId = insertThreshold(db, {
      checkType: 'disk', fieldPath: 'drives.0.usagePercent', operator: '>', thresholdValue: 95, severity: 'critical', consecutiveRequired: 1
    });
    db.prepare(
      'INSERT INTO auto_remediation_policies (threshold_id, action_id, cooldown_minutes, enabled) VALUES (?, ?, ?, ?)'
    ).run(disabledThresholdId, 'clean_disk', 60, 0);

    const policy = service.getAutoRemediationPolicy(disabledThresholdId);
    assert.strictEqual(policy, null);
  });

  it('getAutoRemediationPolicy returns null when within cooldown period', () => {
    const recentlyTriggered = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');

    // Create a new threshold and policy with a recent trigger
    const cooldownThresholdId = insertThreshold(db, {
      checkType: 'memory', fieldPath: 'usagePercent', operator: '>', thresholdValue: 85, severity: 'warning', consecutiveRequired: 1
    });
    db.prepare(
      'INSERT INTO auto_remediation_policies (threshold_id, action_id, cooldown_minutes, enabled, last_triggered_at) VALUES (?, ?, ?, ?, ?)'
    ).run(cooldownThresholdId, 'kill_process', 30, 1, recentlyTriggered);

    const policy = service.getAutoRemediationPolicy(cooldownThresholdId);
    assert.strictEqual(policy, null);
  });

  it('getAutoRemediationPolicy returns policy when cooldown has expired', () => {
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');

    const expiredCooldownThresholdId = insertThreshold(db, {
      checkType: 'event_log', fieldPath: 'criticals', operator: '>', thresholdValue: 0, severity: 'critical', consecutiveRequired: 1
    });
    db.prepare(
      'INSERT INTO auto_remediation_policies (threshold_id, action_id, cooldown_minutes, enabled, last_triggered_at) VALUES (?, ?, ?, ?, ?)'
    ).run(expiredCooldownThresholdId, 'clear_log', 30, 1, longAgo);

    const policy = service.getAutoRemediationPolicy(expiredCooldownThresholdId);
    assert.ok(policy, 'policy should be returned after cooldown expires');
    assert.strictEqual(policy.action_id, 'clear_log');
  });

  it('markPolicyTriggered updates last_triggered_at', () => {
    const before = db.prepare('SELECT last_triggered_at FROM auto_remediation_policies WHERE id = ?').get(policyId);
    assert.strictEqual(before.last_triggered_at, null);

    service.markPolicyTriggered(policyId);

    const after = db.prepare('SELECT last_triggered_at FROM auto_remediation_policies WHERE id = ?').get(policyId);
    assert.ok(after.last_triggered_at, 'last_triggered_at should be set after markPolicyTriggered');
  });
});
