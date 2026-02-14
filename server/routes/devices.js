const express = require('express');
const { requireIT } = require('../auth/middleware');

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

module.exports = router;
