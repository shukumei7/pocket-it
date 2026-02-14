class FleetService {
  constructor(db) {
    this.db = db;
  }

  getAllDevices() {
    return this.db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
  }

  getDevice(deviceId) {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  }

  getDeviceDiagnostics(deviceId, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM diagnostic_results WHERE device_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(deviceId, limit);
  }

  getOnlineCount() {
    return this.db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'online'").get().count;
  }

  getTotalCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
  }
}

module.exports = FleetService;
