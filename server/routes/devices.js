const express = require('express');
const { requireIT, requireAdmin } = require('../auth/middleware');
const { resolveClientScope, scopeSQL, isDeviceInScope } = require('../auth/clientScope');

const router = express.Router();

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
  res.json(devices);
});

router.get('/health/summary', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const FleetService = require('../services/fleetService');
  const fleet = new FleetService(db);
  res.json(fleet.getHealthSummary(req.clientScope));
});

router.get('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (!isDeviceInScope(db, req.params.id, req.clientScope)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json(device);
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
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);

  // Log to audit
  db.prepare(
    'INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
  ).run(req.user?.username || 'admin', 'device_removed', deviceId, JSON.stringify({ hostname: device.hostname }));

  res.json({ success: true, message: 'Device removed' });
});

module.exports = router;
