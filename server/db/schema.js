const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

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
      last_seen TEXT,
      current_user TEXT
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
      role TEXT DEFAULT 'technician' CHECK(role IN ('superadmin','admin','technician','viewer')),
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
      requested_by TEXT,
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

  // v0.9.0: Enhanced system profile columns
  const v09_columns = [
    { name: 'os_edition', type: 'TEXT' },
    { name: 'os_build', type: 'TEXT' },
    { name: 'os_architecture', type: 'TEXT' },
    { name: 'bios_manufacturer', type: 'TEXT' },
    { name: 'bios_version', type: 'TEXT' },
    { name: 'gpu_model', type: 'TEXT' },
    { name: 'serial_number', type: 'TEXT' },
    { name: 'domain', type: 'TEXT' },
    { name: 'last_boot_time', type: 'TEXT' },
    { name: 'uptime_hours', type: 'REAL' },
    { name: 'logged_in_users', type: 'TEXT' },
    { name: 'previous_logged_in_users', type: 'TEXT' },
    { name: 'network_adapters', type: 'TEXT' }
  ];
  for (const col of v09_columns) {
    try {
      db.prepare(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v0.15.0: Enhanced OS version columns
  const v15_os_columns = [
    { name: 'os_display_version', type: 'TEXT' },
    { name: 'os_install_date', type: 'TEXT' },
    { name: 'os_name', type: 'TEXT' },
  ];
  for (const col of v15_os_columns) {
    try {
      db.prepare(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v15: Enhanced device identity and security columns
  const v15_device_columns = [
    { name: 'device_manufacturer', type: 'TEXT' },
    { name: 'device_model', type: 'TEXT' },
    { name: 'form_factor', type: 'TEXT' },
    { name: 'tpm_version', type: 'TEXT' },
    { name: 'secure_boot', type: 'TEXT' },
    { name: 'domain_join_type', type: 'TEXT' },
  ];
  for (const col of v15_device_columns) {
    try {
      db.prepare(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v0.10.0: Multi-tenancy tables (must come before ALTER TABLE references)
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_client_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES it_users(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      assigned_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, client_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_client_user ON user_client_assignments(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_client_client ON user_client_assignments(client_id);
  `);

  // v0.10.0: Multi-tenancy columns (must come before index creation)
  try {
    db.prepare('ALTER TABLE devices ADD COLUMN client_id INTEGER REFERENCES clients(id)').run();
  } catch (err) {
    // Column already exists
  }
  try {
    db.prepare('ALTER TABLE enrollment_tokens ADD COLUMN client_id INTEGER REFERENCES clients(id)').run();
  } catch (err) {
    // Column already exists
  }

  // v0.10.0: Indexes on multi-tenancy columns (after ALTER TABLE)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_client_id ON devices(client_id);
    CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_client_id ON enrollment_tokens(client_id);
  `);

  // v0.11.0: Client version tracking
  try {
    db.prepare('ALTER TABLE devices ADD COLUMN client_version TEXT').run();
  } catch (err) {
    // Column already exists
  }

  // v0.11.0: Tamper protection — EXE hash tracking
  try {
    db.prepare('ALTER TABLE devices ADD COLUMN exe_hash TEXT').run();
  } catch (err) {
    // Column already exists
  }
  try {
    db.prepare('ALTER TABLE update_packages ADD COLUMN exe_hash TEXT').run();
  } catch (err) {
    // Column already exists
  }

  // v0.11.0: Update packages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      release_notes TEXT,
      uploaded_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

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

    CREATE TABLE IF NOT EXISTS auto_remediation_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threshold_id INTEGER REFERENCES alert_thresholds(id),
      action_id TEXT NOT NULL,
      parameter TEXT,
      cooldown_minutes INTEGER DEFAULT 30,
      require_consent INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      last_triggered_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS script_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      script_content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      requires_elevation INTEGER DEFAULT 0,
      timeout_seconds INTEGER DEFAULT 60,
      created_by TEXT,
      os_type TEXT DEFAULT 'windows',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_auto_remediation_threshold ON auto_remediation_policies(threshold_id);
  `);

  // v0.7.0: Reporting & Analytics indexes and tables
  db.exec(`
    -- v0.7.0: Reporting & Analytics indexes
    CREATE INDEX IF NOT EXISTS idx_diag_device_type_time ON diagnostic_results(device_id, check_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_device_triggered ON alerts(device_id, triggered_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

    -- v0.7.0: Report scheduling
    CREATE TABLE IF NOT EXISTS report_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      report_type TEXT NOT NULL CHECK(report_type IN ('fleet_health', 'device_metrics', 'alert_summary', 'ticket_summary')),
      filters TEXT,
      schedule TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'csv' CHECK(format IN ('csv', 'pdf')),
      recipients TEXT,
      enabled INTEGER DEFAULT 1,
      last_run_at TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      report_type TEXT NOT NULL,
      filters TEXT,
      format TEXT NOT NULL,
      file_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // v0.12.0: Server settings (key-value store, overrides env vars)
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // v0.14.0: Remote deployment tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('script', 'installer')),
      script_id INTEGER,
      script_content TEXT,
      installer_filename TEXT,
      installer_data BLOB,
      silent_args TEXT,
      timeout_seconds INTEGER DEFAULT 300,
      requires_elevation INTEGER DEFAULT 0,
      target_device_ids TEXT NOT NULL,
      scheduled_at TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'cancelled')),
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deployment_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      hostname TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'uploading', 'running', 'success', 'failed', 'skipped')),
      exit_code INTEGER,
      output TEXT,
      error_output TEXT,
      duration_ms INTEGER,
      timed_out INTEGER DEFAULT 0,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_results_deployment ON deployment_results(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_deploy_results_device ON deployment_results(device_id);
  `);

  // v0.14.0: Deployment templates for reusable configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('script', 'installer')),
      script_id INTEGER,
      script_content TEXT,
      installer_filename TEXT,
      silent_args TEXT,
      timeout_seconds INTEGER DEFAULT 300,
      requires_elevation INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // v0.14.0: Add channel column to chat_messages for IT guidance separation
  try {
    db.prepare("ALTER TABLE chat_messages ADD COLUMN channel TEXT DEFAULT 'user'").run();
  } catch (err) {
    // Column already exists
  }

  // v0.14.0: Index for channel-based chat queries
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(device_id, channel)');
  } catch (err) {
    // Index already exists
  }

  // v0.16.0: TOTP 2FA columns for it_users
  const totpColumns = [
    { name: 'totp_secret', type: 'TEXT' },
    { name: 'totp_enabled', type: 'INTEGER DEFAULT 0' },
    { name: 'backup_codes', type: 'TEXT' },
  ];
  for (const col of totpColumns) {
    try {
      db.prepare(`ALTER TABLE it_users ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v0.17.0: AI disable columns on devices table
  const aiDisableColumns = [
    { name: 'ai_disabled', type: 'TEXT' },      // NULL | 'temporary' | 'permanent'
    { name: 'ai_disabled_by', type: 'TEXT' },    // username or 'auto'
  ];
  for (const col of aiDisableColumns) {
    try {
      db.prepare(`ALTER TABLE devices ADD COLUMN ${col.name} ${col.type}`).run();
    } catch (err) {
      // Column already exists
    }
  }

  // v0.17.0: Chat read cursors for fleet unread badges
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_read_cursors (
      it_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(it_user_id, device_id)
    );
  `);

  // v0.18.0: User preferences (key-value store per user)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES it_users(id) ON DELETE CASCADE
    );
  `);

  // v0.18.0: AI Tool flag for script library
  try {
    db.prepare('ALTER TABLE script_library ADD COLUMN ai_tool INTEGER DEFAULT 0').run();
  } catch (err) {
    // Column already exists
  }

  // v0.13.0: Feature wishlist — AI logs capability gaps
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_wishes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_request TEXT NOT NULL,
      ai_need TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      device_id TEXT,
      hostname TEXT,
      vote_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_feature_wishes_category ON feature_wishes(category);
    CREATE INDEX IF NOT EXISTS idx_feature_wishes_status ON feature_wishes(status);
  `);

  // v0.19.0: Device notes and custom fields
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_device_notes_device ON device_notes(device_id);

    CREATE TABLE IF NOT EXISTS device_custom_fields (
      device_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL,
      PRIMARY KEY (device_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_dcf_device ON device_custom_fields(device_id);
  `);

  // v0.20.0 — Client notes + custom fields
  const hasClientNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_notes'").get();
  if (!hasClientNotes) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_client_notes_client ON client_notes(client_id);
    `);
    console.log('[Schema] v0.20.0: Created client_notes table');
  }

  const hasClientCustomFields = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_custom_fields'").get();
  if (!hasClientCustomFields) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS client_custom_fields (
        client_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        field_value TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT NOT NULL,
        PRIMARY KEY (client_id, field_name)
      );
      CREATE INDEX IF NOT EXISTS idx_ccf_client ON client_custom_fields(client_id);
    `);
    console.log('[Schema] v0.20.0: Created client_custom_fields table');
  }

  // v0.15.0: superadmin role — Note: SQLite does not support ALTER TABLE to modify CHECK
  // constraints on existing columns. The CREATE TABLE above now includes 'superadmin' so
  // new databases get the full constraint. Existing databases keep the old constraint but
  // rows with role='superadmin' can still be inserted via direct DB update or a fresh DB.

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

  // Seed default scripts (only if table is empty)
  const scriptCount = db.prepare('SELECT COUNT(*) as count FROM script_library').get().count;
  if (scriptCount === 0) {
    const defaultScripts = [
      {
        name: 'System Information',
        description: 'Detailed system information including OS, hardware, and network config',
        script_content: 'systeminfo /fo csv',
        category: 'info',
        requires_elevation: 0,
        timeout_seconds: 30
      },
      {
        name: 'Recent Crash Events',
        description: 'Last 10 application crash events from Windows Event Log',
        script_content: "Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001,1002} -MaxEvents 10 -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, Message | ConvertTo-Json",
        category: 'diagnostics',
        requires_elevation: 0,
        timeout_seconds: 30
      },
      {
        name: 'Disk Health (SMART)',
        description: 'Physical disk health status via SMART data',
        script_content: 'Get-PhysicalDisk | Select-Object FriendlyName, MediaType, OperationalStatus, HealthStatus, @{N="SizeGB";E={[math]::Round($_.Size/1GB,1)}} | ConvertTo-Json',
        category: 'diagnostics',
        requires_elevation: 0,
        timeout_seconds: 15
      },
      {
        name: 'Startup Programs',
        description: 'Programs configured to run at system startup',
        script_content: 'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | ConvertTo-Json',
        category: 'info',
        requires_elevation: 0,
        timeout_seconds: 15
      },
      {
        name: 'Network Configuration',
        description: 'Active network adapter configuration including IP, gateway, DNS',
        script_content: 'Get-NetIPConfiguration | Select-Object InterfaceAlias, @{N="IPv4";E={$_.IPv4Address.IPAddress}}, @{N="Gateway";E={$_.IPv4DefaultGateway.NextHop}}, @{N="DNS";E={($_.DNSServer.ServerAddresses) -join ","}} | ConvertTo-Json',
        category: 'network',
        requires_elevation: 0,
        timeout_seconds: 15
      },
      {
        name: 'Suspend BitLocker & Reboot',
        description: 'Suspends BitLocker protection on C: for one reboot cycle, then restarts the system. Use before BIOS updates or hardware changes that would trigger BitLocker recovery.',
        script_content: 'Suspend-BitLocker -MountPoint "C:" -RebootCount 1; Restart-Computer -Force',
        category: 'maintenance',
        requires_elevation: 1,
        timeout_seconds: 30
      }
    ];
    const insertScript = db.prepare(
      'INSERT INTO script_library (name, description, script_content, category, requires_elevation, timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const s of defaultScripts) {
      insertScript.run(s.name, s.description, s.script_content, s.category, s.requires_elevation, s.timeout_seconds);
    }
  }

  // v0.10.0: Seed "Default" client and assign orphaned devices/tokens
  const clientCount = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
  if (clientCount === 0) {
    db.prepare(
      "INSERT INTO clients (name, slug, contact_name, notes, created_at) VALUES ('Default', 'default', 'System', 'Auto-created default client', datetime('now'))"
    ).run();
  }
  const defaultClient = db.prepare("SELECT id FROM clients WHERE slug = 'default'").get();
  if (defaultClient) {
    db.prepare('UPDATE devices SET client_id = ? WHERE client_id IS NULL').run(defaultClient.id);
    db.prepare('UPDATE enrollment_tokens SET client_id = ? WHERE client_id IS NULL').run(defaultClient.id);
  }

  // v0.20.3: Add os_type column to script_library
  const hasOsType = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='script_library'").get() &&
    db.pragma("table_info(script_library)").some(col => col.name === 'os_type');
  if (!hasOsType) {
    db.exec("ALTER TABLE script_library ADD COLUMN os_type TEXT DEFAULT 'windows'");
    console.log('[Schema] v0.20.3: Added os_type column to script_library');
  }

  // v0.20.4 — requested_by column for tickets
  try {
    db.prepare('ALTER TABLE tickets ADD COLUMN requested_by TEXT').run();
  } catch (e) { /* column already exists */ }

  // v0.20.5 — current_user column for devices (active socket session username)
  try {
    db.prepare('ALTER TABLE devices ADD COLUMN current_user TEXT').run();
  } catch (e) { /* column already exists */ }

  // v0.20.2: Seed "Suspend BitLocker & Reboot" script if missing
  const hasBitlockerScript = db.prepare("SELECT id FROM script_library WHERE name = 'Suspend BitLocker & Reboot'").get();
  if (!hasBitlockerScript) {
    db.prepare(
      'INSERT INTO script_library (name, description, script_content, category, requires_elevation, timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'Suspend BitLocker & Reboot',
      'Suspends BitLocker protection on C: for one reboot cycle, then restarts the system. Use before BIOS updates or hardware changes that would trigger BitLocker recovery.',
      'Suspend-BitLocker -MountPoint "C:" -RebootCount 1; Restart-Computer -Force',
      'maintenance',
      1,
      30
    );
    console.log('[Schema] v0.20.2: Added "Suspend BitLocker & Reboot" script');
  }

  // Security migration: hash plaintext device secrets
  try {
    const devices = db.prepare('SELECT device_id, device_secret FROM devices WHERE device_secret IS NOT NULL').all();
    const updateSecret = db.prepare('UPDATE devices SET device_secret = ? WHERE device_id = ?');
    for (const device of devices) {
      // Skip already-hashed secrets (bcrypt hashes start with $2)
      if (device.device_secret && !device.device_secret.startsWith('$2')) {
        const hashed = bcrypt.hashSync(device.device_secret, 10);
        updateSecret.run(hashed, device.device_id);
      }
    }
  } catch (err) {
    console.error('[Schema] Device secret migration error:', err.message);
  }

  return db;
}

module.exports = { initDatabase };
