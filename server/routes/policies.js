const express = require('express');
const router = express.Router();

module.exports = function createPoliciesRouter(alertService) {
  router.get('/', (req, res) => {
    try {
      const policies = req.app.locals.db.prepare(`
        SELECT p.*, t.check_type, t.field_path, t.operator, t.threshold_value, t.severity
        FROM auto_remediation_policies p
        JOIN alert_thresholds t ON p.threshold_id = t.id
        ORDER BY p.created_at DESC
      `).all();
      res.json(policies);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    const { threshold_id, action_id, parameter, cooldown_minutes, require_consent } = req.body;
    if (!threshold_id || !action_id) {
      return res.status(400).json({ error: 'Missing required fields: threshold_id, action_id' });
    }
    try {
      const result = req.app.locals.db.prepare(
        'INSERT INTO auto_remediation_policies (threshold_id, action_id, parameter, cooldown_minutes, require_consent) VALUES (?, ?, ?, ?, ?)'
      ).run(threshold_id, action_id, parameter || null, cooldown_minutes || 30, require_consent !== undefined ? require_consent : 1);
      const policy = req.app.locals.db.prepare('SELECT * FROM auto_remediation_policies WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(policy);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    const { id } = req.params;
    const allowed = ['threshold_id', 'action_id', 'parameter', 'cooldown_minutes', 'require_consent', 'enabled'];
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
      req.app.locals.db.prepare(`UPDATE auto_remediation_policies SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const policy = req.app.locals.db.prepare('SELECT * FROM auto_remediation_policies WHERE id = ?').get(id);
      res.json(policy);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      req.app.locals.db.prepare('DELETE FROM auto_remediation_policies WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
