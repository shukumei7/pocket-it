function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireDevice(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) {
    return res.status(401).json({ error: 'Device ID required' });
  }
  req.deviceId = deviceId;
  next();
}

function requireIT(req, res, next) {
  // Localhost bypasses auth for MVP development
  if (isLocalhost(req)) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  // Localhost bypasses auth for MVP development
  if (isLocalhost(req)) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

module.exports = {
  requireDevice,
  requireIT,
  requireAdmin
};
