const express = require('express');
const { requireIT } = require('../auth/middleware');

const router = express.Router();

router.get('/:deviceId', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const messages = db.prepare(`
    SELECT * FROM chat_messages
    WHERE device_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.deviceId, limit, offset);

  res.json(messages.reverse());
});

module.exports = router;
