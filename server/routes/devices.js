const express = require('express');
const { requireIT, requireAdmin } = require('../auth/middleware');

const router = express.Router();

router.get('/', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const devices = db.prepare('SELECT * FROM devices').all();
  res.json(devices);
});

router.get('/:id', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(req.params.id);

  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  res.json(device);
});

router.get('/:id/diagnostics', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const diagnostics = db.prepare(`
    SELECT * FROM diagnostic_results
    WHERE device_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.params.id);

  res.json(diagnostics);
});

router.delete('/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const deviceId = req.params.id;

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
