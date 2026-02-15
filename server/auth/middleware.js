const jwt = require('jsonwebtoken');

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

  if (!device.device_secret || device.device_secret !== deviceSecret) {
    return res.status(403).json({ error: 'Invalid device credentials' });
  }

  req.deviceId = deviceId;
  next();
}

function requireIT(req, res, next) {
  if (isLocalhost(req)) return next();
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (isLocalhost(req)) return next();
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, getJwtSecret());
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
  requireDevice,
  requireIT,
  requireAdmin
};
