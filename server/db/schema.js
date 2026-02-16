const Database = require('better-sqlite3');

function initDatabase(dbPath) {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      hostname TEXT,
      os_version TEXT,
      status TEXT DEFAULT 'online',
      certificate_fingerprint TEXT,
      device_secret TEXT,
      enrolled_at TEXT,
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      created_by TEXT,
      expires_at TEXT,
      used_by_device TEXT,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS it_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'technician' CHECK(role IN ('admin','technician','viewer')),
      created_at TEXT,
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      sender TEXT NOT NULL CHECK(sender IN ('user','ai','it_tech')),
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      category TEXT,
      assigned_to INTEGER REFERENCES it_users(id),
      ai_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS diagnostic_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      check_type TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_device_id ON chat_messages(device_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_device_id ON tickets(device_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_diagnostic_results_device_id ON diagnostic_results(device_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
  `);

  // Migrations for existing databases
  try {
    db.prepare('ALTER TABLE devices ADD COLUMN device_secret TEXT').run();
  } catch (err) {
    // Column already exists
  }

  // Phase B migrations: hardware profile + health score
  const phaseB_columns = [
    { name: 'cpu_model', type: 'TEXT' },
    { name: 'total_ram_gb', type: 'REAL' },
    { name: 'total_disk_gb', type: 'REAL' },
    { name: 'processor_count', type: 'INTEGER' },
    { name: 'health_score', type: 'INTEGER' }
  ];
  for (const col of phaseB_columns) {
    try {
      db.prepare(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v0.4.0: Alert monitoring tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_type TEXT NOT NULL,
      field_path TEXT NOT NULL,
      operator TEXT NOT NULL CHECK(operator IN ('>', '<', '>=', '<=', '=')),
      threshold_value REAL NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
      consecutive_required INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      threshold_id INTEGER REFERENCES alert_thresholds(id),
      check_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'acknowledged', 'resolved')),
      message TEXT NOT NULL,
      field_path TEXT,
      field_value REAL,
      triggered_at TEXT DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL CHECK(channel_type IN ('webhook', 'slack', 'teams')),
      config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_device_status ON alerts(device_id, status);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alert_thresholds_check_type ON alert_thresholds(check_type);
  `);

  // Seed default alert thresholds (only if table is empty)
  const thresholdCount = db.prepare('SELECT COUNT(*) as count FROM alert_thresholds').get().count;
  if (thresholdCount === 0) {
    const defaultThresholds = [
      { check_type: 'cpu', field_path: 'usagePercent', operator: '>', threshold_value: 90, severity: 'critical', consecutive_required: 2 },
      { check_type: 'cpu', field_path: 'usagePercent', operator: '>', threshold_value: 80, severity: 'warning', consecutive_required: 3 },
      { check_type: 'memory', field_path: 'usagePercent', operator: '>', threshold_value: 95, severity: 'critical', consecutive_required: 2 },
      { check_type: 'memory', field_path: 'usagePercent', operator: '>', threshold_value: 85, severity: 'warning', consecutive_required: 3 },
      { check_type: 'disk', field_path: 'drives.0.usagePercent', operator: '>', threshold_value: 95, severity: 'critical', consecutive_required: 1 },
      { check_type: 'disk', field_path: 'drives.0.usagePercent', operator: '>', threshold_value: 85, severity: 'warning', consecutive_required: 1 },
      { check_type: 'event_log', field_path: 'criticals', operator: '>', threshold_value: 0, severity: 'critical', consecutive_required: 1 },
      { check_type: 'services', field_path: 'stoppedAutoServices.length', operator: '>', threshold_value: 0, severity: 'warning', consecutive_required: 2 },
    ];
    const insertThreshold = db.prepare(
      'INSERT INTO alert_thresholds (check_type, field_path, operator, threshold_value, severity, consecutive_required) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const t of defaultThresholds) {
      insertThreshold.run(t.check_type, t.field_path, t.operator, t.threshold_value, t.severity, t.consecutive_required);
    }
  }

  return db;
}

module.exports = { initDatabase };
