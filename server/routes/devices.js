const express = require('express');
const { requireIT, requireAdmin } = require('../auth/middleware');
const { resolveClientScope, scopeSQL, isDeviceInScope } = require('../auth/clientScope');

const router = express.Router();

// Strip sensitive fields from device records before sending to clients
function sanitizeDevice({ device_secret, certificate_fingerprint, ...rest }) {
  return rest;
}

router.get('/', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { clause, params } = scopeSQL(req.clientScope);
  // Optional client_id filter for admin
  let extraClause = '';
  const extraParams = [];
  if (req.query.client_id) {
    extraClause = ' AND client_id = ?';
    extraParams.push(parseInt(req.query.client_id));
  }
  const devices = db.prepare(`SELECT * FROM devices WHERE ${clause}${extraClause}`).all(...params, ...extraParams);
  res.json(devices.map(sanitizeDevice));
});

router.get('/health/summary', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const FleetService = require('../services/fleetService');
  const fleet = new FleetService(db);
  res.json(fleet.getHealthSummary(req.clientScope));
});

router.get('/unread-counts', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const { clause, params } = scopeSQL(req.clientScope);
  const userId = req.user?.id ? String(req.user.id) : 'admin';

  try {
    const rows = db.prepare(`
      SELECT cm.device_id, COUNT(*) as unread_count
      FROM chat_messages cm
      WHERE cm.sender = 'user'
        AND cm.id > COALESCE(
          (SELECT crc.last_read_id FROM chat_read_cursors crc
           WHERE crc.device_id = cm.device_id AND crc.it_user_id = ?), 0)
        AND (cm.channel = 'user' OR cm.channel IS NULL)
        AND cm.device_id IN (SELECT device_id FROM devices WHERE ${clause})
      GROUP BY cm.device_id
    `).all(userId, ...params);

    const result = {};
    for (const row of rows) {
      result[row.device_id] = row.unread_count;
    }
    res.json(result);
  } catch (err) {
    console.error('[Devices] Unread counts error:', err.message);
    res.status(500).json({ error: 'Failed to get unread counts' });
  }
});

router.get('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (!isDeviceInScope(db, req.params.id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json(sanitizeDevice(device));
});

router.get('/:id/diagnostics', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (!isDeviceInScope(db, req.params.id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const diagnostics = db.prepare(`
    SELECT * FROM diagnostic_results
    WHERE device_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.params.id);

  res.json(diagnostics);
});

router.get('/:id/activity', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;

  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['target = ?'];
  const params = [deviceId];

  const actionParam = req.query.action || req.query.actions;
  if (actionParam) {
    const actions = actionParam.split(',').map(a => a.trim()).filter(Boolean);
    if (actions.length > 0) {
      conditions.push(`action IN (${actions.map(() => '?').join(',')})`);
      params.push(...actions);
    }
  }

  if (req.query.from) {
    conditions.push('created_at >= ?');
    params.push(req.query.from);
  }

  if (req.query.to) {
    conditions.push('created_at <= ?');
    params.push(req.query.to);
  }

  const whereClause = conditions.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) as count FROM audit_log WHERE ${whereClause}`).get(...params).count;
  const activities = db.prepare(
    `SELECT id, actor, action, details, created_at FROM audit_log WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ activities, total, page, limit });
});

router.patch('/:id/client', requireAdmin, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;
  const { client_id } = req.body;

  if (client_id !== null && client_id !== undefined) {
    const clientId = parseInt(client_id);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid client_id' });
    const client = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
  }

  const device = db.prepare('SELECT device_id, hostname FROM devices WHERE device_id = ?').get(deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  db.prepare('UPDATE devices SET client_id = ? WHERE device_id = ?').run(client_id === null ? null : parseInt(client_id), deviceId);

  // Audit log
  db.prepare(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(req.user?.username || 'admin', 'device_moved', deviceId, JSON.stringify({ client_id }));

  // Invalidate scoped emit cache
  const { invalidateDeviceCache } = require('../socket/scopedEmit');
  invalidateDeviceCache(deviceId);

  res.json({ success: true });
});

router.delete('/:id', requireAdmin, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;

  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const device = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Remove device and related data
  db.prepare('DELETE FROM chat_messages WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM diagnostic_results WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM device_notes WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM device_custom_fields WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);

  // Log to audit
  db.prepare(
    'INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(req.user?.username || 'admin', 'device_removed', deviceId, JSON.stringify({ hostname: device.hostname }));

  res.json({ success: true, message: 'Device removed' });
});

// v0.19.0: Device notes
router.get('/:id/notes', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (!isDeviceInScope(db, req.params.id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const notes = db.prepare('SELECT * FROM device_notes WHERE device_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json(notes);
});

router.post('/:id/notes', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;
  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { content } = req.body;
  if (!content || typeof content !== 'string' || content.length === 0) {
    return res.status(400).json({ error: 'Content is required' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'Content too long (max 5000 chars)' });
  }
  const author = req.user?.username || 'admin';
  try {
    const result = db.prepare("INSERT INTO device_notes (device_id, author, content) VALUES (?, ?, ?)").run(deviceId, author, content);
    const note = db.prepare('SELECT * FROM device_notes WHERE id = ?').get(result.lastInsertRowid);
    db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(author, 'device_note_added', deviceId, JSON.stringify({ noteId: note.id }));
    res.json(note);
  } catch (err) {
    console.error('[Devices] Add note error:', err.message);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

router.delete('/:id/notes/:noteId', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;
  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    db.prepare('DELETE FROM device_notes WHERE id = ? AND device_id = ?').run(req.params.noteId, deviceId);
    db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(req.user?.username || 'admin', 'device_note_deleted', deviceId, JSON.stringify({ noteId: req.params.noteId }));
    res.json({ success: true });
  } catch (err) {
    console.error('[Devices] Delete note error:', err.message);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// v0.19.0: Custom fields
router.get('/:id/custom-fields', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (!isDeviceInScope(db, req.params.id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const fields = db.prepare('SELECT * FROM device_custom_fields WHERE device_id = ? ORDER BY field_name ASC').all(req.params.id);
  res.json(fields);
});

router.put('/:id/custom-fields', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;
  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { fields } = req.body;
  if (!fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'fields object is required' });
  }
  const author = req.user?.username || 'admin';
  try {
    const upsert = db.prepare(
      `INSERT INTO device_custom_fields (device_id, field_name, field_value, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, field_name) DO UPDATE
       SET field_value = excluded.field_value, updated_at = datetime('now'), updated_by = excluded.updated_by`
    );
    for (const [name, value] of Object.entries(fields)) {
      if (typeof name !== 'string' || name.length > 100) continue;
      const val = value === null ? null : String(value).slice(0, 2000);
      upsert.run(deviceId, name, val, author);
    }
    const allFields = db.prepare('SELECT * FROM device_custom_fields WHERE device_id = ? ORDER BY field_name ASC').all(deviceId);
    res.json(allFields);
  } catch (err) {
    console.error('[Devices] Set custom fields error:', err.message);
    res.status(500).json({ error: 'Failed to update fields' });
  }
});

router.delete('/:id/custom-fields/:fieldName', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;
  if (!isDeviceInScope(db, deviceId, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    db.prepare('DELETE FROM device_custom_fields WHERE device_id = ? AND field_name = ?').run(deviceId, req.params.fieldName);
    res.json({ success: true });
  } catch (err) {
    console.error('[Devices] Delete custom field error:', err.message);
    res.status(500).json({ error: 'Failed to delete field' });
  }
});

module.exports = router;
