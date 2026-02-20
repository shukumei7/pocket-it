const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

function getJwtSecret() {
  const secret = process.env.POCKET_IT_JWT_SECRET;
  if (!secret) {
    throw new Error('POCKET_IT_JWT_SECRET environment variable is required');
  }
  return secret;
}

function isLocalhost(req) {
  // Use req.socket.remoteAddress (not req.ip) to avoid X-Forwarded-For spoofing
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireDevice(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const deviceSecret = req.headers['x-device-secret'];

  if (!deviceId || !deviceSecret) {
    return res.status(401).json({ error: 'Device authentication required' });
  }

  const db = req.app.locals.db;
  const device = db.prepare('SELECT device_id, device_secret FROM devices WHERE device_id = ?').get(deviceId);
  if (!device) {
    return res.status(403).json({ error: 'Device not enrolled' });
  }

  if (!device.device_secret) {
    return res.status(403).json({ error: 'Invalid device credentials' });
  }
  const isHashed = device.device_secret.startsWith('$2');
  const secretValid = isHashed
    ? bcrypt.compareSync(deviceSecret, device.device_secret)
    : (device.device_secret.length === deviceSecret.length &&
       crypto.timingSafeEqual(Buffer.from(device.device_secret), Buffer.from(deviceSecret)));
  if (!secretValid) {
    return res.status(403).json({ error: 'Invalid device credentials' });
  }

  req.deviceId = deviceId;
  next();
}

function requireIT(req, res, next) {
  if (isLocalhost(req)) {
    // Still populate req.user from JWT if present (for consistent user identity)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), getJwtSecret());
        if (!decoded.purpose) req.user = decoded;
      } catch (err) { /* ignore — localhost doesn't require valid token */ }
    }
    return next();
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.purpose) {
      return res.status(401).json({ error: 'Full authentication required' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (isLocalhost(req)) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), getJwtSecret());
        if (!decoded.purpose) req.user = decoded;
      } catch (err) { /* ignore */ }
    }
    return next();
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.purpose) {
      return res.status(401).json({ error: 'Full authentication required' });
    }
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  isLocalhost,
  requireDevice,
  requireIT,
  requireAdmin
};
