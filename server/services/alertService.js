class AlertService {
  constructor(db) {
    this.db = db;
    // Track consecutive threshold hits per device+threshold: Map<string, number>
    this.consecutiveHits = new Map();
  }

  /**
   * Extract a value from nested data using dot-notation field_path.
   * Supports: "usagePercent", "drives.0.usagePercent", "stoppedAutoServices.length"
   */
  _extractValue(data, fieldPath) {
    if (!data || !fieldPath) return undefined;
    const parts = fieldPath.split('.');
    let current = data;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (part === 'length' && Array.isArray(current)) return current.length;
      if (Array.isArray(current) && /^\d+$/.test(part)) {
        current = current[parseInt(part, 10)];
      } else if (typeof current === 'object') {
        current = current[part];
      } else {
        return undefined;
      }
    }
    return typeof current === 'number' ? current : undefined;
  }

  /**
   * Compare a value against a threshold using the given operator.
   */
  _compare(value, operator, thresholdValue) {
    switch (operator) {
      case '>': return value > thresholdValue;
      case '<': return value < thresholdValue;
      case '>=': return value >= thresholdValue;
      case '<=': return value <= thresholdValue;
      case '=': return value === thresholdValue;
      default: return false;
    }
  }

  /**
   * Evaluate a diagnostic result against all thresholds for its check_type.
   * Returns array of newly created alerts.
   */
  evaluateResult(deviceId, checkType, resultData) {
    const thresholds = this.db.prepare(
      'SELECT * FROM alert_thresholds WHERE check_type = ? AND enabled = 1'
    ).all(checkType);

    const newAlerts = [];

    for (const threshold of thresholds) {
      const value = this._extractValue(resultData, threshold.field_path);
      const key = `${deviceId}:${threshold.id}`;
      const breached = value !== undefined && this._compare(value, threshold.operator, threshold.threshold_value);

      if (breached) {
        // Increment consecutive hit counter
        const hits = (this.consecutiveHits.get(key) || 0) + 1;
        this.consecutiveHits.set(key, hits);

        if (hits >= threshold.consecutive_required) {
          // Check if active alert already exists for this device+threshold
          const existingAlert = this.db.prepare(
            "SELECT id FROM alerts WHERE device_id = ? AND threshold_id = ? AND status IN ('active', 'acknowledged')"
          ).get(deviceId, threshold.id);

          if (!existingAlert) {
            // Create new alert
            const message = `${checkType}.${threshold.field_path} is ${value} (threshold: ${threshold.operator} ${threshold.threshold_value})`;
            const result = this.db.prepare(
              'INSERT INTO alerts (device_id, threshold_id, check_type, severity, message, field_path, field_value) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(deviceId, threshold.id, checkType, threshold.severity, message, threshold.field_path, value);

            const alert = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
            newAlerts.push(alert);
          }
        }
      } else {
        // Reset consecutive counter
        this.consecutiveHits.delete(key);

        // Auto-resolve any active alert for this device+threshold
        this.db.prepare(
          "UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE device_id = ? AND threshold_id = ? AND status IN ('active', 'acknowledged')"
        ).run(deviceId, threshold.id);
      }
    }

    return newAlerts;
  }

  /**
   * Create an uptime alert when a device becomes unreachable.
   */
  createUptimeAlert(deviceId, hostname) {
    // Check if active uptime alert already exists
    const existing = this.db.prepare(
      "SELECT id FROM alerts WHERE device_id = ? AND check_type = 'uptime' AND status IN ('active', 'acknowledged')"
    ).get(deviceId);

    if (existing) return null;

    const message = `Device '${hostname || deviceId}' is unreachable (no heartbeat for >5 minutes)`;
    const result = this.db.prepare(
      "INSERT INTO alerts (device_id, threshold_id, check_type, severity, message, field_path, field_value) VALUES (?, NULL, 'uptime', 'critical', ?, 'heartbeat', 0)"
    ).run(deviceId, message);

    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
  }

  /**
   * Auto-resolve uptime alert when device comes back online.
   */
  resolveUptimeAlert(deviceId) {
    this.db.prepare(
      "UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE device_id = ? AND check_type = 'uptime' AND status IN ('active', 'acknowledged')"
    ).run(deviceId);
  }

  getActiveAlerts(deviceId) {
    if (deviceId) {
      return this.db.prepare(
        "SELECT a.*, d.hostname FROM alerts a LEFT JOIN devices d ON a.device_id = d.device_id WHERE a.device_id = ? AND a.status IN ('active', 'acknowledged') ORDER BY a.triggered_at DESC"
      ).all(deviceId);
    }
    return this.db.prepare(
      "SELECT a.*, d.hostname FROM alerts a LEFT JOIN devices d ON a.device_id = d.device_id WHERE a.status IN ('active', 'acknowledged') ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END, a.triggered_at DESC"
    ).all();
  }

  getAlertHistory(limit = 50) {
    return this.db.prepare(
      'SELECT a.*, d.hostname FROM alerts a LEFT JOIN devices d ON a.device_id = d.device_id ORDER BY a.triggered_at DESC LIMIT ?'
    ).all(limit);
  }

  acknowledgeAlert(alertId, acknowledgedBy) {
    this.db.prepare(
      "UPDATE alerts SET status = 'acknowledged', acknowledged_at = datetime('now'), acknowledged_by = ? WHERE id = ? AND status = 'active'"
    ).run(acknowledgedBy, alertId);
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  }

  resolveAlert(alertId) {
    this.db.prepare(
      "UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ? AND status IN ('active', 'acknowledged')"
    ).run(alertId);
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  }

  getStats() {
    const active = this.db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status = 'active'").get().count;
    const acknowledged = this.db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status = 'acknowledged'").get().count;
    const critical = this.db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status IN ('active', 'acknowledged') AND severity = 'critical'").get().count;
    const warning = this.db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status IN ('active', 'acknowledged') AND severity = 'warning'").get().count;
    return { activeCount: active + acknowledged, criticalCount: critical, warningCount: warning };
  }

  getAutoRemediationPolicy(thresholdId) {
    if (!thresholdId) return null;
    const policy = this.db.prepare(
      'SELECT * FROM auto_remediation_policies WHERE threshold_id = ? AND enabled = 1'
    ).get(thresholdId);
    if (!policy) return null;

    // Check cooldown
    if (policy.last_triggered_at) {
      const lastTriggered = new Date(policy.last_triggered_at + 'Z').getTime();
      const cooldownMs = policy.cooldown_minutes * 60 * 1000;
      if (Date.now() - lastTriggered < cooldownMs) return null;
    }

    return policy;
  }

  markPolicyTriggered(policyId) {
    this.db.prepare(
      "UPDATE auto_remediation_policies SET last_triggered_at = datetime('now') WHERE id = ?"
    ).run(policyId);
  }
}

module.exports = AlertService;
