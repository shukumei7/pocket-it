const express = require('express');
const { requireIT } = require('../auth/middleware');

const router = express.Router();

router.get('/:deviceId', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { limit = 50, offset = 0 } = req.query;

  const messages = db.prepare(`
    SELECT * FROM chat_messages
    WHERE device_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.deviceId, parseInt(limit), parseInt(offset));

  res.json(messages.reverse());
});

module.exports = router;
