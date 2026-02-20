const express = require('express');
const { requireAdmin, requireIT, isLocalhost } = require('../auth/middleware');
const { generateToken, hashPassword, comparePassword } = require('../auth/userAuth');
const { resolveClientScope } = require('../auth/clientScope');
const { encrypt, decrypt } = require('../config/encryption');
const { generateTOTPSecret, verifyTOTP, generateTempToken, verifyTempToken, generateBackupCodes, hashBackupCodes, verifyBackupCode } = require('../auth/totpAuth');

const router = express.Router();

// Account lockout: track failed attempts per username
const loginAttempts = new Map(); // username → { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

router.post('/login', async (req, res) => {
  const db = req.app.locals.db;
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Check lockout
  const attempts = loginAttempts.get(username);
  if (attempts && attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
  }

  const user = db.prepare('SELECT * FROM it_users WHERE username = ?').get(username);

  if (!user) {
    try {
      db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
        username, 'login_failed', 'auth', JSON.stringify({ reason: 'user_not_found', ip: req.socket?.remoteAddress })
      );
    } catch (e) { console.error('[Audit] Log write failed:', e.message); }
    // Track failed attempt
    const current = loginAttempts.get(username) || { count: 0, lockedUntil: null };
    current.count++;
    if (current.count >= MAX_ATTEMPTS) {
      current.lockedUntil = Date.now() + LOCKOUT_DURATION;
      current.count = 0;
    }
    loginAttempts.set(username, current);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const isValid = await comparePassword(password, user.password_hash);

  if (!isValid) {
    try {
      db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
        username, 'login_failed', 'auth', JSON.stringify({ reason: 'invalid_password', ip: req.socket?.remoteAddress })
      );
    } catch (e) { console.error('[Audit] Log write failed:', e.message); }
    // Track failed attempt
    const current = loginAttempts.get(username) || { count: 0, lockedUntil: null };
    current.count++;
    if (current.count >= MAX_ATTEMPTS) {
      current.lockedUntil = Date.now() + LOCKOUT_DURATION;
      current.count = 0;
    }
    loginAttempts.set(username, current);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  db.prepare('UPDATE it_users SET last_login = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id);

  loginAttempts.delete(username);

  try {
    db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
      username, 'login_success', 'auth', JSON.stringify({ ip: req.socket?.remoteAddress })
    );
  } catch (e) { console.error('[Audit] Log write failed:', e.message); }

  // 2FA check
  if (user.totp_enabled) {
    // User has 2FA enabled — require verification
    const tempToken = generateTempToken(user, '2fa_verify');
    return res.json({ requires2FA: true, tempToken });
  }

  // User has no 2FA set up — force setup
  const tempToken = generateTempToken(user, '2fa_setup');
  return res.json({ requiresSetup: true, tempToken });
});

function getClientsForUser(db, user) {
  if (user.role === 'admin' || user.role === 'superadmin') {
    return db.prepare('SELECT id, name, slug FROM clients ORDER BY name').all();
  }
  return db.prepare(`
    SELECT c.id, c.name, c.slug FROM clients c
    JOIN user_client_assignments uca ON c.id = uca.client_id
    WHERE uca.user_id = ? ORDER BY c.name
  `).all(user.id);
}

// Verify 2FA code (TOTP or backup code) to complete login
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Token and code required' });
  }

  const decoded = verifyTempToken(tempToken, '2fa_verify');
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const db = req.app.locals.db;
  const user = db.prepare('SELECT * FROM it_users WHERE id = ?').get(decoded.id);
  if (!user || !user.totp_enabled) {
    return res.status(400).json({ error: 'User not found or 2FA not enabled' });
  }

  // Check lockout
  const attempts = loginAttempts.get(user.username);
  if (attempts && attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
  }

  const normalizedCode = code.replace(/\s/g, '');

  // Try TOTP first
  if (await verifyTOTP(user.totp_secret, normalizedCode)) {
    loginAttempts.delete(user.username);
    db.prepare('UPDATE it_users SET last_login = ? WHERE id = ?')
      .run(new Date().toISOString(), user.id);

    const jwtSecret = process.env.POCKET_IT_JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ error: 'Server configuration error' });
    const token = generateToken(user, jwtSecret);
    const clients = getClientsForUser(db, user);

    return res.json({
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      clients
    });
  }

  // Try backup code
  if (user.backup_codes && normalizedCode.length === 8) {
    const result = verifyBackupCode(normalizedCode, user.backup_codes);
    if (result.valid) {
      db.prepare('UPDATE it_users SET backup_codes = ?, last_login = ? WHERE id = ?')
        .run(result.remainingEncrypted, new Date().toISOString(), user.id);
      loginAttempts.delete(user.username);

      try {
        db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
          user.username, '2fa_backup_code_used', 'auth', JSON.stringify({ ip: req.socket?.remoteAddress })
        );
      } catch (e) { console.error('[Audit] Log write failed:', e.message); }

      const jwtSecret = process.env.POCKET_IT_JWT_SECRET;
      if (!jwtSecret) return res.status(500).json({ error: 'Server configuration error' });
      const token = generateToken(user, jwtSecret);
      const clients = getClientsForUser(db, user);

      return res.json({
        token,
        user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        clients
      });
    }
  }

  // Failed verification — count toward lockout
  const current = loginAttempts.get(user.username) || { count: 0, lockedUntil: null };
  current.count++;
  if (current.count >= MAX_ATTEMPTS) {
    current.lockedUntil = Date.now() + LOCKOUT_DURATION;
    current.count = 0;
  }
  loginAttempts.set(user.username, current);

  try {
    db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
      user.username, '2fa_verification_failed', 'auth', JSON.stringify({ ip: req.socket?.remoteAddress })
    );
  } catch (e) { console.error('[Audit] Log write failed:', e.message); }

  return res.status(401).json({ error: 'Invalid verification code' });
});

// Start 2FA setup — generate secret + QR
router.post('/2fa/setup', async (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken) return res.status(400).json({ error: 'Token required' });

  const decoded = verifyTempToken(tempToken, '2fa_setup');
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  try {
    const result = await generateTOTPSecret(decoded.username);
    // Store encrypted secret temporarily — not yet enabled
    const db = req.app.locals.db;
    db.prepare('UPDATE it_users SET totp_secret = ? WHERE id = ?')
      .run(result.secret, decoded.id);

    res.json({
      qrDataUri: result.qrDataUri,
      manualKey: result.rawSecret,
      otpauthUri: result.otpauthUri
    });
  } catch (err) {
    console.error('[2FA] Setup error:', err.message);
    res.status(500).json({ error: 'Failed to generate 2FA secret' });
  }
});

// Confirm 2FA setup — verify first code, activate, return backup codes + full JWT
router.post('/2fa/confirm', async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'Token and code required' });

  const decoded = verifyTempToken(tempToken, '2fa_setup');
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  const db = req.app.locals.db;
  const user = db.prepare('SELECT * FROM it_users WHERE id = ?').get(decoded.id);
  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: 'Run setup first' });
  }

  const normalizedCode = code.replace(/\s/g, '');
  if (!await verifyTOTP(user.totp_secret, normalizedCode)) {
    return res.status(401).json({ error: 'Invalid code. Check your authenticator and try again.' });
  }

  // Generate backup codes
  const backupCodes = generateBackupCodes();
  const encryptedBackupCodes = hashBackupCodes(backupCodes);

  // Activate 2FA
  db.prepare('UPDATE it_users SET totp_enabled = 1, backup_codes = ?, last_login = ? WHERE id = ?')
    .run(encryptedBackupCodes, new Date().toISOString(), user.id);

  try {
    db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
      user.username, '2fa_enabled', 'auth', JSON.stringify({ ip: req.socket?.remoteAddress })
    );
  } catch (e) { console.error('[Audit] Log write failed:', e.message); }

  // Issue full JWT
  const jwtSecret = process.env.POCKET_IT_JWT_SECRET;
  if (!jwtSecret) return res.status(500).json({ error: 'Server configuration error' });
  const token = generateToken(user, jwtSecret);
  const clients = getClientsForUser(db, user);

  res.json({
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    clients,
    backupCodes
  });
});

// Disable 2FA for another user (admin recovery)
router.post('/2fa/disable', requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = req.app.locals.db;
  const target = db.prepare('SELECT id, username FROM it_users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE it_users SET totp_enabled = 0, totp_secret = NULL, backup_codes = NULL WHERE id = ?')
    .run(userId);

  try {
    db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)').run(
      req.user?.username || 'admin', '2fa_disabled', target.username, JSON.stringify({ targetUserId: userId, ip: req.socket?.remoteAddress })
    );
  } catch (e) { console.error('[Audit] Log write failed:', e.message); }

  res.json({ success: true });
});

router.get('/users', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const users = db.prepare('SELECT id, username, display_name, role, totp_enabled, created_at, last_login FROM it_users').all();
  res.json(users);
});

router.post('/users', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { username, password, display_name, role = 'technician' } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const passwordHash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  try {
    const result = db.prepare(`
      INSERT INTO it_users (username, password_hash, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, passwordHash, display_name, role, createdAt);

    res.status(201).json({ id: result.lastInsertRowid, username, role });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    throw error;
  }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { display_name, role, password } = req.body;

  const user = db.prepare('SELECT id FROM it_users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (role && !['superadmin', 'admin', 'technician', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (display_name !== undefined) {
    db.prepare('UPDATE it_users SET display_name = ? WHERE id = ?').run(display_name, id);
  }
  if (role !== undefined) {
    db.prepare('UPDATE it_users SET role = ? WHERE id = ?').run(role, id);
  }
  if (password) {
    const passwordHash = await hashPassword(password);
    db.prepare('UPDATE it_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  const updated = db.prepare('SELECT id, username, display_name, role, created_at, last_login FROM it_users WHERE id = ?').get(id);
  res.json(updated);
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  const user = db.prepare('SELECT id, username FROM it_users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Prevent deleting yourself
  if (req.user && req.user.id === parseInt(id)) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  db.prepare('DELETE FROM it_users WHERE id = ?').run(id);

  try {
    db.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(req.user?.username || 'admin', 'user_deleted', user.username, JSON.stringify({ userId: id }));
  } catch (err) {
    console.error('[Admin] Audit log error:', err.message);
  }

  res.json({ success: true });
});

router.get('/stats', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const FleetService = require('../services/fleetService');
  const TicketService = require('../services/ticketService');
  const fleet = new FleetService(db);
  const tickets = new TicketService(db);
  const healthSummary = fleet.getHealthSummary(req.clientScope);

  res.json({
    totalDevices: fleet.getTotalCount(req.clientScope),
    onlineDevices: fleet.getOnlineCount(req.clientScope),
    openTickets: tickets.getOpenCount(req.clientScope),
    totalTickets: tickets.getTotalCount(req.clientScope),
    averageHealth: healthSummary.avgScore,
    criticalDevices: healthSummary.breakdown.critical
  });
});

// Auto-login for localhost — no credentials needed
router.post('/auto-login', async (req, res) => {
  if (!isLocalhost(req)) {
    return res.status(403).json({ error: 'Auto-login only available from localhost' });
  }

  const db = req.app.locals.db;
  let user = db.prepare('SELECT * FROM it_users WHERE username = ?').get('admin');

  if (!user) {
    const passwordHash = await hashPassword('admin');
    db.prepare(
      'INSERT INTO it_users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('admin', passwordHash, 'Administrator', 'admin', new Date().toISOString());
    user = db.prepare('SELECT * FROM it_users WHERE username = ?').get('admin');
  }

  const jwtSecret = process.env.POCKET_IT_JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const token = generateToken(user, jwtSecret);
  const clients = db.prepare('SELECT id, name, slug FROM clients ORDER BY name').all();
  res.json({
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    clients
  });
});

// Get all server settings (admin only)
router.get('/settings', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const rows = db.prepare('SELECT key, value, updated_at FROM server_settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }

  // Merge with env defaults (DB overrides env)
  const defaults = {
    'server.publicUrl': process.env.POCKET_IT_PUBLIC_URL || '',
    'llm.provider': process.env.POCKET_IT_LLM_PROVIDER || 'ollama',
    'llm.ollama.url': process.env.POCKET_IT_OLLAMA_URL || 'http://localhost:11434',
    'llm.ollama.model': process.env.POCKET_IT_OLLAMA_MODEL || 'llama3.2',
    'llm.openai.apiKey': process.env.POCKET_IT_OPENAI_API_KEY || '',
    'llm.openai.model': process.env.POCKET_IT_OPENAI_MODEL || 'gpt-4o-mini',
    'llm.anthropic.apiKey': process.env.POCKET_IT_ANTHROPIC_API_KEY || '',
    'llm.anthropic.model': process.env.POCKET_IT_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
    'llm.claudeCli.model': process.env.POCKET_IT_CLAUDE_CLI_MODEL || ''
  };

  // Fill in defaults for keys not in DB
  for (const [key, defaultVal] of Object.entries(defaults)) {
    if (!(key in settings)) {
      settings[key] = defaultVal;
    }
  }

  // Decrypt API keys before masking
  for (const key of ['llm.openai.apiKey', 'llm.anthropic.apiKey']) {
    if (settings[key]) {
      settings[key] = decrypt(settings[key]);
    }
  }

  // Mask API keys in response
  const masked = { ...settings };
  for (const key of ['llm.openai.apiKey', 'llm.anthropic.apiKey']) {
    if (masked[key] && masked[key].length > 8) {
      masked[key] = masked[key].substring(0, 4) + '****' + masked[key].substring(masked[key].length - 4);
    }
  }

  res.json(masked);
});

// Update server settings (admin only)
router.put('/settings', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const updates = req.body;

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Settings object required' });
  }

  const allowedKeys = [
    'server.publicUrl',
    'llm.provider', 'llm.ollama.url', 'llm.ollama.model',
    'llm.openai.apiKey', 'llm.openai.model',
    'llm.anthropic.apiKey', 'llm.anthropic.model',
    'llm.claudeCli.model',
    'llm.timeout'
  ];

  const upsert = db.prepare(
    "INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );

  const updateMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!allowedKeys.includes(key)) continue;
      // Don't overwrite API keys with masked values
      if ((key === 'llm.openai.apiKey' || key === 'llm.anthropic.apiKey') && value && value.includes('****')) {
        continue;
      }
      // Encrypt API keys before storing
      const storeValue = (key === 'llm.openai.apiKey' || key === 'llm.anthropic.apiKey')
        ? encrypt(value || '')
        : (value || '');
      upsert.run(key, storeValue);
    }
  });

  updateMany(Object.entries(updates));

  // Reconfigure LLM service with new settings
  const llmService = req.app.locals.llmService;
  if (llmService) {
    // Read fresh settings from DB (to get actual API keys, not masked)
    const rows = db.prepare('SELECT key, value FROM server_settings').all();
    const fresh = {};
    for (const row of rows) {
      // Decrypt API keys for LLM use
      fresh[row.key] = (row.key === 'llm.openai.apiKey' || row.key === 'llm.anthropic.apiKey')
        ? decrypt(row.value)
        : row.value;
    }

    llmService.reconfigure({
      provider: fresh['llm.provider'] || process.env.POCKET_IT_LLM_PROVIDER || 'ollama',
      ollamaUrl: fresh['llm.ollama.url'] || process.env.POCKET_IT_OLLAMA_URL || 'http://localhost:11434',
      ollamaModel: fresh['llm.ollama.model'] || process.env.POCKET_IT_OLLAMA_MODEL || 'llama3.2',
      openaiKey: fresh['llm.openai.apiKey'] || process.env.POCKET_IT_OPENAI_API_KEY || '',
      openaiModel: fresh['llm.openai.model'] || process.env.POCKET_IT_OPENAI_MODEL || 'gpt-4o-mini',
      anthropicKey: fresh['llm.anthropic.apiKey'] || process.env.POCKET_IT_ANTHROPIC_API_KEY || '',
      anthropicModel: fresh['llm.anthropic.model'] || process.env.POCKET_IT_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
      claudeCliModel: fresh['llm.claudeCli.model'] || process.env.POCKET_IT_CLAUDE_CLI_MODEL || '',
      timeoutMs: parseInt(fresh['llm.timeout'], 10) || 120000
    });
  }

  // If server URL changed, notify all connected clients
  if (updates['server.publicUrl']) {
    const newUrl = updates['server.publicUrl'];
    const io = req.app.locals.io;
    if (io) {
      const agentNs = io.of('/agent');
      agentNs.emit('server_url_changed', { url: newUrl });
      console.log(`[Settings] Broadcasted server_url_changed to all clients: ${newUrl}`);
    }
  }

  // Audit log
  try {
    db.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(req.user?.username || 'admin', 'settings_updated', 'server', JSON.stringify(Object.keys(updates)));
  } catch (err) {
    console.error('[Settings] Audit log error:', err.message);
  }

  res.json({ success: true });
});

// Test LLM connection (admin only)
router.post('/settings/test-llm', requireAdmin, async (req, res) => {
  const llmService = req.app.locals.llmService;
  if (!llmService) {
    return res.status(500).json({ error: 'LLM service not available' });
  }

  try {
    const response = await llmService.chat([
      { role: 'system', content: 'You are a test assistant. Respond with exactly: "LLM connection successful"' },
      { role: 'user', content: 'Test' }
    ]);

    res.json({
      success: true,
      provider: llmService.provider,
      model: llmService.provider === 'ollama' ? llmService.ollamaModel
        : llmService.provider === 'openai' ? llmService.openaiModel
        : llmService.provider === 'anthropic' ? llmService.anthropicModel
        : llmService.claudeCliModel || 'default',
      response: response.substring(0, 200)
    });
  } catch (err) {
    console.error('[Admin] LLM test error:', err.message);
    res.json({
      success: false,
      provider: llmService.provider,
      error: 'LLM service error — check server logs for details'
    });
  }
});

module.exports = router;
