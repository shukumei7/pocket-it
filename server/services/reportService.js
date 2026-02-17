class ReportService {
  constructor(db) {
    this.db = db;
  }

  getFleetHealthTrend(days = 7) {
    // Daily avg health score: ok=100, warning=50, critical/error=0
    return this.db.prepare(`
      SELECT date(created_at) as day,
             avg(CASE status WHEN 'ok' THEN 100 WHEN 'warning' THEN 50 ELSE 0 END) as avg_score,
             count(*) as check_count
      FROM diagnostic_results
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY day
    `).all(days);
  }

  getDeviceMetricTrend(deviceId, checkType, days = 7) {
    // Group by hour for <=7 days, by day for >7
    const groupExpr = days <= 7
      ? "strftime('%Y-%m-%dT%H:00:00', created_at)"
      : "date(created_at)";

    // Extract numeric value from JSON data based on check_type
    // cpu → usagePercent, memory → usagePercent, disk → drives[0].usagePercent
    let extractExpr;
    switch (checkType) {
      case 'cpu':
        extractExpr = "json_extract(data, '$.usagePercent')";
        break;
      case 'memory':
        extractExpr = "json_extract(data, '$.usagePercent')";
        break;
      case 'disk':
        extractExpr = "json_extract(data, '$.drives[0].usagePercent')";
        break;
      default:
        extractExpr = "json_extract(data, '$.value')";
    }

    return this.db.prepare(`
      SELECT ${groupExpr} as period,
             avg(${extractExpr}) as avg_value,
             min(${extractExpr}) as min_value,
             max(${extractExpr}) as max_value,
             count(*) as sample_count
      FROM diagnostic_results
      WHERE device_id = ? AND check_type = ?
        AND created_at > datetime('now', '-' || ? || ' days')
        AND ${extractExpr} IS NOT NULL
      GROUP BY ${groupExpr}
      ORDER BY period
    `).all(deviceId, checkType, days);
  }

  getDeviceHealthHistory(deviceId, days = 30) {
    return this.db.prepare(`
      SELECT date(created_at) as day,
             sum(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
             sum(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warning,
             sum(CASE WHEN status IN ('critical', 'error') THEN 1 ELSE 0 END) as critical,
             avg(CASE status WHEN 'ok' THEN 100 WHEN 'warning' THEN 50 ELSE 0 END) as avg_score
      FROM diagnostic_results
      WHERE device_id = ? AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY day
    `).all(deviceId, days);
  }

  getAlertSummary(days = 30) {
    const total = this.db.prepare(`
      SELECT count(*) as total,
             sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
             sum(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
             avg(CASE WHEN resolved_at IS NOT NULL
               THEN (julianday(resolved_at) - julianday(triggered_at)) * 24
               ELSE NULL END) as mttr_hours
      FROM alerts
      WHERE triggered_at > datetime('now', '-' || ? || ' days')
    `).get(days);

    const bySeverity = this.db.prepare(`
      SELECT severity, count(*) as count
      FROM alerts
      WHERE triggered_at > datetime('now', '-' || ? || ' days')
      GROUP BY severity ORDER BY count DESC
    `).all(days);

    const byCheckType = this.db.prepare(`
      SELECT check_type, count(*) as count
      FROM alerts
      WHERE triggered_at > datetime('now', '-' || ? || ' days')
      GROUP BY check_type ORDER BY count DESC
    `).all(days);

    const topDevices = this.db.prepare(`
      SELECT a.device_id, d.hostname, count(*) as count
      FROM alerts a
      LEFT JOIN devices d ON a.device_id = d.device_id
      WHERE a.triggered_at > datetime('now', '-' || ? || ' days')
      GROUP BY a.device_id ORDER BY count DESC LIMIT 5
    `).all(days);

    const perDay = this.db.prepare(`
      SELECT date(triggered_at) as day, count(*) as count
      FROM alerts
      WHERE triggered_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(triggered_at) ORDER BY day
    `).all(days);

    return {
      ...total,
      mttr_hours: total.mttr_hours ? Math.round(total.mttr_hours * 10) / 10 : null,
      by_severity: bySeverity,
      by_check_type: byCheckType,
      top_devices: topDevices,
      per_day: perDay
    };
  }

  getTicketSummary(days = 30) {
    const total = this.db.prepare(`
      SELECT count(*) as total,
             sum(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as open,
             sum(CASE WHEN status IN ('resolved', 'closed') THEN 1 ELSE 0 END) as resolved,
             avg(CASE WHEN updated_at IS NOT NULL AND status IN ('resolved', 'closed')
               THEN (julianday(updated_at) - julianday(created_at)) * 24
               ELSE NULL END) as avg_resolution_hours
      FROM tickets
      WHERE created_at > datetime('now', '-' || ? || ' days')
    `).get(days);

    const byStatus = this.db.prepare(`
      SELECT status, count(*) as count
      FROM tickets
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY status ORDER BY count DESC
    `).all(days);

    const byPriority = this.db.prepare(`
      SELECT priority, count(*) as count
      FROM tickets
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY priority ORDER BY count DESC
    `).all(days);

    const byCategory = this.db.prepare(`
      SELECT coalesce(category, 'uncategorized') as category, count(*) as count
      FROM tickets
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY category ORDER BY count DESC
    `).all(days);

    const perDay = this.db.prepare(`
      SELECT date(created_at) as day,
             count(*) as opened,
             sum(CASE WHEN status IN ('resolved', 'closed') THEN 1 ELSE 0 END) as closed
      FROM tickets
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at) ORDER BY day
    `).all(days);

    return {
      ...total,
      avg_resolution_hours: total.avg_resolution_hours ? Math.round(total.avg_resolution_hours * 10) / 10 : null,
      by_status: byStatus,
      by_priority: byPriority,
      by_category: byCategory,
      per_day: perDay
    };
  }

  // --- Schedule CRUD ---
  getSchedules() {
    return this.db.prepare('SELECT * FROM report_schedules ORDER BY created_at DESC').all();
  }

  createSchedule(data) {
    const stmt = this.db.prepare(`
      INSERT INTO report_schedules (name, report_type, filters, schedule, format, recipients, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.name, data.report_type,
      JSON.stringify(data.filters || {}),
      data.schedule, data.format || 'csv',
      JSON.stringify(data.recipients || []),
      data.created_by || null
    );
    return this.db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(result.lastInsertRowid);
  }

  updateSchedule(id, data) {
    const existing = this.db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);
    if (!existing) return null;

    const fields = [];
    const values = [];
    for (const key of ['name', 'report_type', 'schedule', 'format', 'enabled']) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }
    if (data.filters !== undefined) {
      fields.push('filters = ?');
      values.push(JSON.stringify(data.filters));
    }
    if (data.recipients !== undefined) {
      fields.push('recipients = ?');
      values.push(JSON.stringify(data.recipients));
    }
    if (fields.length === 0) return existing;

    values.push(id);
    this.db.prepare(`UPDATE report_schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id);
  }

  deleteSchedule(id) {
    const result = this.db.prepare('DELETE FROM report_schedules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // --- Report History ---
  getHistory(limit = 50) {
    return this.db.prepare(`
      SELECT rh.*, rs.name as schedule_name
      FROM report_history rh
      LEFT JOIN report_schedules rs ON rh.schedule_id = rs.id
      ORDER BY rh.created_at DESC LIMIT ?
    `).all(limit);
  }

  logReport(data) {
    return this.db.prepare(`
      INSERT INTO report_history (schedule_id, report_type, filters, format, file_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.schedule_id || null,
      data.report_type,
      JSON.stringify(data.filters || {}),
      data.format,
      data.file_path || null
    );
  }
}

module.exports = ReportService;
