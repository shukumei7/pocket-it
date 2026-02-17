const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAdmin } = require('../auth/middleware');

const router = express.Router();

router.post('/token', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const { client_id } = req.body;

  // Validate client exists
  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }
  const client = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(client_id);
  if (!client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const insert = db.prepare(`
    INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id)
    VALUES (?, ?, ?, 'active', ?)
  `);

  insert.run(token, req.user?.username || 'admin', expiresAt, client_id);

  res.json({ token, expiresAt, client_id, client_name: client.name });
});

router.post('/enroll', (req, res) => {
  const db = req.app.locals.db;
  const { token, deviceId, hostname, osVersion } = req.body;

  if (!token || !deviceId || !hostname) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tokenRecord = db.prepare(`
    SELECT * FROM enrollment_tokens
    WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
  `).get(token);

  if (!tokenRecord) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const enrolledAt = new Date().toISOString();

  // Check if device already exists — reject re-enrollment
  const existingDevice = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);
  if (existingDevice) {
    return res.status(409).json({ error: 'Device already enrolled. Contact IT to re-enroll.' });
  }

  // Generate device secret for Socket.IO authentication
  const deviceSecret = uuidv4();

  // Insert new device
  db.prepare(`
    INSERT INTO devices (device_id, hostname, os_version, status, enrolled_at, last_seen, device_secret, client_id)
    VALUES (?, ?, ?, 'online', ?, ?, ?, ?)
  `).run(deviceId, hostname, osVersion, enrolledAt, enrolledAt, deviceSecret, tokenRecord.client_id || null);

  // Mark token as used
  db.prepare(`
    UPDATE enrollment_tokens SET status = 'used', used_by_device = ? WHERE token = ?
  `).run(deviceId, token);

  res.json({ success: true, deviceId, deviceSecret });
});

router.get('/status/:deviceId', (req, res) => {
  const db = req.app.locals.db;
  const { deviceId } = req.params;
  const deviceSecret = req.headers['x-device-secret'];

  if (!deviceSecret) {
    return res.status(401).json({ error: 'Device secret required' });
  }

  const device = db.prepare('SELECT device_id, device_secret FROM devices WHERE device_id = ?').get(deviceId);

  if (!device) {
    return res.status(404).json({ enrolled: false });
  }

  if (!device.device_secret || device.device_secret !== deviceSecret) {
    return res.status(401).json({ error: 'Invalid device secret' });
  }

  res.json({ enrolled: true, deviceId });
});

module.exports = router;
