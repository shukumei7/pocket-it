const { isLocalhost } = require('./middleware');

/**
 * Middleware: resolves client scope from JWT user data.
 * Sets req.clientScope = { isAdmin: bool, clientIds: int[]|null }
 *   - null clientIds = see all (admin or localhost)
 *   - [] = see nothing (unassigned tech)
 *   - [1,2,3] = see only these client IDs
 */
function resolveClientScope(req, res, next) {
  const db = req.app.locals.db;

  // Localhost or admin sees everything
  if (isLocalhost(req) || (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin'))) {
    req.clientScope = { isAdmin: true, clientIds: null };
    return next();
  }

  // Authenticated technician — look up assigned clients
  if (req.user && req.user.id) {
    const assignments = db.prepare(
      'SELECT client_id FROM user_client_assignments WHERE user_id = ?'
    ).all(req.user.id);
    req.clientScope = {
      isAdmin: false,
      clientIds: assignments.map(a => a.client_id)
    };
    return next();
  }

  // No user context (shouldn't happen after requireIT, but safe default)
  req.clientScope = { isAdmin: false, clientIds: [] };
  next();
}

/**
 * Build SQL WHERE clause fragment for client_id scoping.
 * @param {object} scope - { isAdmin, clientIds }
 * @param {string} [alias] - table alias prefix (e.g. 'd' for d.client_id)
 * @returns {{ clause: string, params: any[] }}
 */
function scopeSQL(scope, alias) {
  const pfx = alias ? alias + '.' : '';
  if (!scope || scope.isAdmin) return { clause: '1=1', params: [] };
  if (!scope.clientIds || scope.clientIds.length === 0) return { clause: '0=1', params: [] };
  const placeholders = scope.clientIds.map(() => '?').join(',');
  return { clause: `${pfx}client_id IN (${placeholders})`, params: [...scope.clientIds] };
}

/**
 * Check if a single device is within scope.
 * @param {object} db - better-sqlite3 database
 * @param {string} deviceId - device_id to check
 * @param {object} scope - { isAdmin, clientIds }
 * @returns {boolean}
 */
function isDeviceInScope(db, deviceId, scope) {
  if (!scope || scope.isAdmin) return true;
  if (!scope.clientIds || scope.clientIds.length === 0) return false;
  const device = db.prepare('SELECT client_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device) return false;
  return scope.clientIds.includes(device.client_id);
}

module.exports = { resolveClientScope, scopeSQL, isDeviceInScope };
