const express = require('express');
const { requireAdmin, requireIT } = require('../auth/middleware');
const { generateToken, hashPassword, comparePassword } = require('../auth/userAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const db = req.app.locals.db;
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM it_users WHERE username = ?').get(username);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const isValid = await comparePassword(password, user.password_hash);

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  db.prepare('UPDATE it_users SET last_login = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id);

  const token = generateToken(user, process.env.POCKET_IT_JWT_SECRET || 'pocket-it-dev-secret');

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role
    }
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

router.get('/stats', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const FleetService = require('../services/fleetService');
  const TicketService = require('../services/ticketService');
  const fleet = new FleetService(db);
  const tickets = new TicketService(db);

  res.json({
    totalDevices: fleet.getTotalCount(),
    onlineDevices: fleet.getOnlineCount(),
    openTickets: tickets.getOpenCount(),
    totalTickets: tickets.getTotalCount()
  });
});

module.exports = router;
