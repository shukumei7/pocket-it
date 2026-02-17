const express = require('express');
const { requireAdmin, requireIT, isLocalhost } = require('../auth/middleware');
const { generateToken, hashPassword, comparePassword } = require('../auth/userAuth');
const { resolveClientScope } = require('../auth/clientScope');

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

  const jwtSecret = process.env.POCKET_IT_JWT_SECRET;
  if (!jwtSecret) {
    console.error('[SECURITY] JWT secret not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const token = generateToken(user, jwtSecret);

  // Fetch clients for the user
  let clients;
  if (user.role === 'admin') {
    clients = db.prepare('SELECT id, name, slug FROM clients ORDER BY name').all();
  } else {
    clients = db.prepare(`
      SELECT c.id, c.name, c.slug FROM clients c
      JOIN user_client_assignments uca ON c.id = uca.client_id
      WHERE uca.user_id = ? ORDER BY c.name
    `).all(user.id);
  }

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role
    },
    clients
  });
});

router.get('/users', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const users = db.prepare('SELECT id, username, display_name, role, created_at, last_login FROM it_users').all();
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

module.exports = router;
