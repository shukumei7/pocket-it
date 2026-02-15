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

  computeHealthScore(deviceId) {
    // Get latest result per check type
    const checkTypes = ['cpu', 'memory', 'disk', 'network'];
    const scores = [];

    for (const type of checkTypes) {
      const result = this.db.prepare(
        'SELECT status FROM diagnostic_results WHERE device_id = ? AND check_type = ? ORDER BY created_at DESC LIMIT 1'
      ).get(deviceId, type);

      if (result) {
        switch (result.status) {
          case 'ok': scores.push(100); break;
          case 'warning': scores.push(50); break;
          case 'error': scores.push(0); break;
          default: scores.push(50); break;
        }
      }
    }

    if (scores.length === 0) return null;

    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    // Save to devices table
    this.db.prepare('UPDATE devices SET health_score = ? WHERE device_id = ?').run(avgScore, deviceId);

    return avgScore;
  }

  getHealthSummary() {
    const devices = this.db.prepare(`
      SELECT device_id, hostname, status, health_score, cpu_model, total_ram_gb, total_disk_gb, processor_count, last_seen
      FROM devices ORDER BY last_seen DESC
    `).all();

    let healthy = 0, warning = 0, critical = 0, unscanned = 0;
    let totalScore = 0, scoredCount = 0;

    for (const d of devices) {
      if (d.health_score === null) { unscanned++; continue; }
      scoredCount++;
      totalScore += d.health_score;
      if (d.health_score >= 75) healthy++;
      else if (d.health_score >= 40) warning++;
      else critical++;
    }

    return {
      avgScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
      breakdown: { healthy, warning, critical, unscanned },
      devices
    };
  }
}

module.exports = FleetService;
