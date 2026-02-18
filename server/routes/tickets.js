const express = require('express');
const { requireIT, requireDevice } = require('../auth/middleware');
const { resolveClientScope, scopeSQL, isDeviceInScope } = require('../auth/clientScope');

const router = express.Router();

router.get('/', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { status } = req.query;
  const { clause, params } = scopeSQL(req.clientScope, 'd');

  let query = `SELECT t.* FROM tickets t JOIN devices d ON t.device_id = d.device_id WHERE ${clause}`;
  if (status) {
    query += ' AND t.status = ?';
    params.push(status);
  }
  query += ' ORDER BY t.created_at DESC';

  const tickets = db.prepare(query).all(...params);
  res.json(tickets);
});

router.get('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (!isDeviceInScope(db, ticket.device_id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const comments = db.prepare(`
    SELECT * FROM ticket_comments
    WHERE ticket_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);

  res.json({ ...ticket, comments });
});

router.post('/', requireDevice, (req, res) => {
  const db = req.app.locals.db;
  const { title, description, priority, category } = req.body;
  const device_id = req.deviceId;

  if (!title) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (title.length > 500) {
    return res.status(400).json({ error: 'Title too long (max 500 chars)' });
  }
  if (description && description.length > 10000) {
    return res.status(400).json({ error: 'Description too long (max 10000 chars)' });
  }
  const validPriorities = ['low', 'medium', 'high', 'critical'];
  const safePriority = validPriorities.includes(priority) ? priority : 'medium';
  if (category && category.length > 100) {
    return res.status(400).json({ error: 'Category too long (max 100 chars)' });
  }

  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO tickets (device_id, title, description, priority, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(device_id, title, description, safePriority, category, now, now);

  db.prepare(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run('it_staff', 'ticket_created', device_id, JSON.stringify({ title, priority: safePriority, deviceId: device_id }));

  res.status(201).json({ id: result.lastInsertRowid, device_id, title });
});

router.patch('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { status, assigned_to, priority } = req.body;

  const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
  const validPriorities = ['low', 'medium', 'high', 'critical'];

  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  if (priority && !validPriorities.includes(priority)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${validPriorities.join(', ')}` });
  }

  const updates = [];
  const params = [];

  if (status) {
    updates.push('status = ?');
    params.push(status);
  }
  if (assigned_to !== undefined) {
    updates.push('assigned_to = ?');
    params.push(assigned_to);
  }
  if (priority) {
    updates.push('priority = ?');
    params.push(priority);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(req.params.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  if (!isDeviceInScope(db, ticket.device_id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const query = `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...params);

  db.prepare(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run('it_staff', 'ticket_updated', ticket.device_id, JSON.stringify({ status, assigned_to, priority }));

  res.json({ success: true });
});

router.post('/:id/comments', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { author, content } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'Comment content required' });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  if (!isDeviceInScope(db, ticket.device_id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const result = db.prepare(`
    INSERT INTO ticket_comments (ticket_id, author, content)
    VALUES (?, ?, ?)
  `).run(req.params.id, author || 'anonymous', content);

  db.prepare(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run('it_staff', 'ticket_comment_added', ticket.device_id, JSON.stringify({ author: author || 'anonymous' }));

  res.status(201).json({ id: result.lastInsertRowid });
});

module.exports = router;
