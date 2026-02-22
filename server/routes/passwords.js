const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireIT } = require('../auth/middleware');
const { resolveClientScope, scopeSQL } = require('../auth/clientScope');
const { encrypt, decrypt } = require('../config/encryption');

const router = express.Router();

const secretRevealLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.username || 'anonymous',
  message: { error: 'Too many secret requests. Wait before revealing more.' }
});

function requireTechOrAbove(req, res, next) {
  if (req.user && req.user.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot access password secrets' });
  }
  next();
}

// GET / — list passwords (masked)
router.get('/', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { clause, params } = scopeSQL(req.clientScope, 'p');
  const filters = [];
  const filterParams = [];

  if (req.query.client_id) {
    const clientId = parseInt(req.query.client_id, 10);
    if (!req.clientScope.isAdmin) {
      if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId)) {
        return res.json([]);
      }
    }
    filters.push('p.client_id = ?');
    filterParams.push(clientId);
  }

  if (req.query.device_id) {
    filters.push('p.device_id = ?');
    filterParams.push(req.query.device_id);
  }

  const whereClause = [clause, ...filters].join(' AND ');

  const rows = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.client_id,
      c.name AS client_name,
      p.device_id,
      d.hostname AS device_hostname,
      p.username,
      CASE WHEN p.password_encrypted IS NOT NULL THEN 1 ELSE 0 END AS has_password,
      CASE WHEN p.otp_secret_encrypted IS NOT NULL THEN 1 ELSE 0 END AS has_otp,
      p.notes,
      p.created_by,
      p.created_at,
      p.updated_at
    FROM passwords p
    LEFT JOIN clients c ON p.client_id = c.id
    LEFT JOIN devices d ON p.device_id = d.device_id
    WHERE ${whereClause}
    ORDER BY p.name ASC
  `).all(...params, ...filterParams);

  res.json(rows);
});

// GET /:id/secret — reveal decrypted secret(s)
router.get('/:id/secret', requireIT, requireTechOrAbove, secretRevealLimiter, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const id = parseInt(req.params.id, 10);
  const record = db.prepare('SELECT * FROM passwords WHERE id = ?').get(id);
  if (!record) return res.status(404).json({ error: 'Password record not found' });

  if (!req.clientScope.isAdmin) {
    if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(record.client_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const fieldsParam = req.query.fields || 'password,otp_secret';
  const requestedFields = fieldsParam.split(',').map(f => f.trim()).filter(f => f === 'password' || f === 'otp_secret');

  const result = {};
  if (requestedFields.includes('password') && record.password_encrypted) {
    result.password = decrypt(record.password_encrypted);
  }
  if (requestedFields.includes('otp_secret') && record.otp_secret_encrypted) {
    result.otp_secret = decrypt(record.otp_secret_encrypted);
  }

  const actor = req.user?.username || 'system';
  db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(
    actor,
    'password_secret_revealed',
    `password:${id}`,
    JSON.stringify({ name: record.name, fields: requestedFields })
  );

  res.json(result);
});

// POST / — create password record
router.post('/', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { name, client_id, device_id, username, password, otp_secret, notes } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 255) return res.status(400).json({ error: 'Name too long (max 255 chars)' });
  if (notes && notes.length > 10000) return res.status(400).json({ error: 'Notes too long (max 10000 chars)' });
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const clientId = parseInt(client_id, 10);
  if (!req.clientScope.isAdmin) {
    if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId)) {
      return res.status(403).json({ error: 'Access denied to this client' });
    }
  }

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const passwordEncrypted = password ? encrypt(password) : null;
  const otpEncrypted = otp_secret ? encrypt(otp_secret) : null;
  const actor = req.user?.username || 'system';

  const result = db.prepare(`
    INSERT INTO passwords (name, client_id, device_id, username, password_encrypted, otp_secret_encrypted, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    name.trim(),
    clientId,
    device_id || null,
    username || null,
    passwordEncrypted,
    otpEncrypted,
    notes || null,
    actor
  );

  db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(
    actor,
    'password_created',
    `password:${result.lastInsertRowid}`,
    JSON.stringify({ name: name.trim(), client_id: clientId })
  );

  const record = db.prepare('SELECT id, name, client_id, device_id, username, notes, created_by, created_at FROM passwords WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(record);
});

// PUT /:id — update password record
router.put('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM passwords WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Password record not found' });

  if (!req.clientScope.isAdmin) {
    if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(existing.client_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const { name, client_id, device_id, username, password, otp_secret, notes } = req.body;
  const updates = [];
  const values = [];

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    if (name.length > 255) return res.status(400).json({ error: 'Name too long (max 255 chars)' });
    updates.push('name = ?');
    values.push(name.trim());
  }
  if (client_id !== undefined) {
    const newClientId = parseInt(client_id, 10);
    if (!req.clientScope.isAdmin) {
      if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(newClientId)) {
        return res.status(403).json({ error: 'Access denied to target client' });
      }
    }
    updates.push('client_id = ?');
    values.push(newClientId);
  }
  if (device_id !== undefined) { updates.push('device_id = ?'); values.push(device_id || null); }
  if (username !== undefined) { updates.push('username = ?'); values.push(username || null); }
  if (notes !== undefined) {
    if (notes && notes.length > 10000) return res.status(400).json({ error: 'Notes too long (max 10000 chars)' });
    updates.push('notes = ?');
    values.push(notes || null);
  }
  if (password !== undefined) {
    if (password === '') {
      updates.push('password_encrypted = ?');
      values.push(null);
    } else {
      updates.push('password_encrypted = ?');
      values.push(encrypt(password));
    }
  }
  if (otp_secret !== undefined) {
    if (otp_secret === '') {
      updates.push('otp_secret_encrypted = ?');
      values.push(null);
    } else {
      updates.push('otp_secret_encrypted = ?');
      values.push(encrypt(otp_secret));
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  const actor = req.user?.username || 'system';
  updates.push("updated_at = datetime('now')");
  updates.push('updated_by = ?');
  values.push(actor, id);

  db.prepare(`UPDATE passwords SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(
    actor,
    'password_updated',
    `password:${id}`,
    JSON.stringify({ name: existing.name })
  );

  res.json({ success: true });
});

// DELETE /:id — delete password record
router.delete('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM passwords WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Password record not found' });

  if (!req.clientScope.isAdmin) {
    if (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(existing.client_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  db.prepare('DELETE FROM passwords WHERE id = ?').run(id);

  const actor = req.user?.username || 'system';
  db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(
    actor,
    'password_deleted',
    `password:${id}`,
    JSON.stringify({ name: existing.name })
  );

  res.json({ success: true });
});

module.exports = router;
