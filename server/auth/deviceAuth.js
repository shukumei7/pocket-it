function validateDevice(db, deviceId, fingerprint) {
  const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  return !!device;
}

module.exports = {
  validateDevice
};
