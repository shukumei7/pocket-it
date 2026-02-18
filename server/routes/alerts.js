const express = require('express');
const router = express.Router();
const { requireIT } = require('../auth/middleware');
const { resolveClientScope } = require('../auth/clientScope');

module.exports = function createAlertsRouter(alertService, notificationService) {
  // ---- Thresholds ----
  router.get('/thresholds', (req, res) => {
    try {
      const thresholds = req.app.locals.db.prepare('SELECT * FROM alert_thresholds ORDER BY check_type, severity').all();
      res.json(thresholds);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/thresholds', (req, res) => {
    const { check_type, field_path, operator, threshold_value, severity, consecutive_required } = req.body;
    if (!check_type || !field_path || !operator || threshold_value === undefined || !severity) {
      return res.status(400).json({ error: 'Missing required fields: check_type, field_path, operator, threshold_value, severity' });
    }
    try {
      const result = req.app.locals.db.prepare(
        'INSERT INTO alert_thresholds (check_type, field_path, operator, threshold_value, severity, consecutive_required) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(check_type, field_path, operator, threshold_value, severity, consecutive_required || 1);
      const threshold = req.app.locals.db.prepare('SELECT * FROM alert_thresholds WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(threshold);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/thresholds/:id', (req, res) => {
    const { id } = req.params;
    const allowed = ['check_type', 'field_path', 'operator', 'threshold_value', 'severity', 'consecutive_required', 'enabled'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    values.push(id);
    try {
      req.app.locals.db.prepare(`UPDATE alert_thresholds SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const threshold = req.app.locals.db.prepare('SELECT * FROM alert_thresholds WHERE id = ?').get(id);
      res.json(threshold);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/thresholds/:id', (req, res) => {
    try {
      req.app.locals.db.prepare('DELETE FROM alert_thresholds WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Alerts ----
  router.get('/', requireIT, resolveClientScope, (req, res) => {
    try {
      const { status, device_id, limit } = req.query;
      if (status === 'active') {
        res.json(alertService.getActiveAlerts(device_id || null, req.clientScope));
      } else {
        res.json(alertService.getAlertHistory(parseInt(limit) || 50, req.clientScope));
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/stats', requireIT, resolveClientScope, (req, res) => {
    try {
      res.json(alertService.getStats(req.clientScope));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/acknowledge', (req, res) => {
    try {
      const acknowledgedBy = req.body.acknowledgedBy || 'IT Staff';
      const alert = alertService.acknowledgeAlert(req.params.id, acknowledgedBy);
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      req.app.locals.db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run('it_staff', 'alert_acknowledged', alert.device_id, JSON.stringify({ acknowledgedBy }));
      res.json(alert);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/resolve', (req, res) => {
    try {
      const alert = alertService.resolveAlert(req.params.id);
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      req.app.locals.db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run('it_staff', 'alert_resolved', alert.device_id, JSON.stringify({}));
      res.json(alert);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Notification Channels ----
  router.get('/channels', (req, res) => {
    try {
      const channels = req.app.locals.db.prepare('SELECT * FROM notification_channels ORDER BY name').all();
      res.json(channels);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/channels', (req, res) => {
    const { name, channel_type, config } = req.body;
    if (!name || !channel_type || !config) {
      return res.status(400).json({ error: 'Missing required fields: name, channel_type, config' });
    }
    try {
      const configStr = typeof config === 'string' ? config : JSON.stringify(config);
      const result = req.app.locals.db.prepare(
        'INSERT INTO notification_channels (name, channel_type, config) VALUES (?, ?, ?)'
      ).run(name, channel_type, configStr);
      const channel = req.app.locals.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(channel);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/channels/:id', (req, res) => {
    const { id } = req.params;
    const allowed = ['name', 'channel_type', 'config', 'enabled'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (key === 'config' && typeof val === 'object') val = JSON.stringify(val);
        updates.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    values.push(id);
    try {
      req.app.locals.db.prepare(`UPDATE notification_channels SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const channel = req.app.locals.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
      res.json(channel);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/channels/:id', (req, res) => {
    try {
      req.app.locals.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/channels/:id/test', async (req, res) => {
    try {
      const result = await notificationService.testChannel(parseInt(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
