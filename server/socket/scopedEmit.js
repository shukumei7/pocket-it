/**
 * Device-to-client_id cache to avoid DB queries on every emitted event.
 * Key: deviceId, Value: { clientId, ts }
 */
const deviceClientCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function getDeviceClientId(db, deviceId) {
  const cached = deviceClientCache.get(deviceId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.clientId;
  }
  try {
    const device = db.prepare('SELECT client_id FROM devices WHERE device_id = ?').get(deviceId);
    const clientId = device ? device.client_id : null;
    deviceClientCache.set(deviceId, { clientId, ts: Date.now() });
    return clientId;
  } catch (err) {
    return null;
  }
}

/**
 * Invalidate cache for a device (call when device client_id changes).
 */
function invalidateDeviceCache(deviceId) {
  deviceClientCache.delete(deviceId);
}

/**
 * Emit an event only to IT dashboard sockets that have the device's client in scope.
 */
function emitToScoped(itNs, db, deviceId, event, data, excludeSocketId) {
  const clientId = getDeviceClientId(db, deviceId);

  for (const [, socket] of itNs.sockets) {
    if (excludeSocketId && socket.id === excludeSocketId) continue;
    const scope = socket.userScope;
    if (!scope) continue;
    if (scope.isAdmin ||
        (clientId !== null && scope.clientIds && scope.clientIds.includes(clientId))) {
      socket.emit(event, data);
    }
  }
}

/**
 * Broadcast to ALL connected IT sockets.
 */
function emitToAll(itNs, event, data) {
  itNs.emit(event, data);
}

module.exports = { emitToScoped, emitToAll, invalidateDeviceCache };
