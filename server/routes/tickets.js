const express = require('express');
const { requireIT, requireDevice } = require('../auth/middleware');

const router = express.Router();

router.get('/', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { status } = req.query;

  let query = 'SELECT * FROM tickets';
  let params = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const tickets = db.prepare(query).all(...params);
  res.json(tickets);
});

router.get('/:id', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const comments = db.prepare(`
    SELECT * FROM ticket_comments
    WHERE ticket_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);

  res.json({ ...ticket, comments });
});

router.post('/', (req, res) => {
  const db = req.app.locals.db;
  const { device_id, title, description, priority, category } = req.body;

  if (!device_id || !title) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO tickets (device_id, title, description, priority, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(device_id, title, description, priority || 'medium', category, now, now);

  res.status(201).json({ id: result.lastInsertRowid, device_id, title });
});

router.patch('/:id', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { status, assigned_to, priority } = req.body;

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

  const query = `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...params);

  res.json({ success: true });
});

router.post('/:id/comments', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { author, content } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'Comment content required' });
  }

  const result = db.prepare(`
    INSERT INTO ticket_comments (ticket_id, author, content)
    VALUES (?, ?, ?)
  `).run(req.params.id, author || 'anonymous', content);

  res.status(201).json({ id: result.lastInsertRowid });
});

module.exports = router;
