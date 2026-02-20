const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

class SchedulerService {
  constructor(db, reportService, exportService, notificationService) {
    this.db = db;
    this.reportService = reportService;
    this.exportService = exportService;
    this.notificationService = notificationService;
    this.cronJob = null;
    const DATA_DIR = process.env.POCKET_IT_DATA_DIR || path.join(__dirname, '..', 'db');
    this.reportsDir = path.join(DATA_DIR, 'reports');

    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  start() {
    // Check schedules every minute
    this.cronJob = cron.schedule('* * * * *', () => {
      this._checkSchedules();
    });
    console.log('[Scheduler] Report scheduler started');
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('[Scheduler] Report scheduler stopped');
    }
  }

  _checkSchedules() {
    try {
      const schedules = this.db.prepare(
        'SELECT * FROM report_schedules WHERE enabled = 1'
      ).all();

      for (const schedule of schedules) {
        if (!cron.validate(schedule.schedule)) continue;

        // Check if this schedule should run now
        // Compare last_run_at with current time based on cron expression
        const task = cron.schedule(schedule.schedule, () => {}, { scheduled: false });

        // Simple approach: if last_run_at is more than 1 minute ago (or null),
        // and cron matches current minute, run it
        if (this._shouldRun(schedule)) {
          this._runSchedule(schedule);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking schedules:', err);
    }
  }

  _shouldRun(schedule) {
    if (!cron.validate(schedule.schedule)) return false;

    // If never run, should run on next match
    if (!schedule.last_run_at) {
      // Only run if cron expression matches current time
      return this._cronMatchesNow(schedule.schedule);
    }

    // Check if at least 1 minute has passed since last run
    const lastRun = new Date(schedule.last_run_at);
    const now = new Date();
    const diffMs = now - lastRun;
    if (diffMs < 55000) return false; // Less than ~1 minute

    return this._cronMatchesNow(schedule.schedule);
  }

  _cronMatchesNow(cronExpr) {
    // node-cron doesn't have a "matches now" method, so we use a workaround:
    // Create a task and check if it would fire in the next few seconds
    // Simple approach: parse cron fields and compare with current time
    const parts = cronExpr.split(' ');
    if (parts.length < 5) return false;

    const now = new Date();
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (minute !== '*' && parseInt(minute) !== now.getMinutes()) return false;
    if (hour !== '*' && parseInt(hour) !== now.getHours()) return false;
    if (dayOfMonth !== '*' && parseInt(dayOfMonth) !== now.getDate()) return false;
    if (month !== '*' && parseInt(month) !== (now.getMonth() + 1)) return false;
    if (dayOfWeek !== '*' && parseInt(dayOfWeek) !== now.getDay()) return false;

    return true;
  }

  async _runSchedule(schedule) {
    try {
      console.log(`[Scheduler] Running report: ${schedule.name}`);

      const filters = JSON.parse(schedule.filters || '{}');
      const days = filters.days || 30;

      let data, title, columns;
      switch (schedule.report_type) {
        case 'fleet_health':
          data = this.reportService.getFleetHealthTrend(days);
          title = 'Fleet Health Trend';
          columns = ['day', 'avg_score', 'check_count'];
          break;
        case 'device_metrics':
          data = this.reportService.getDeviceMetricTrend(
            filters.device_id, filters.check_type || 'cpu', days
          );
          title = `Device Metrics - ${filters.check_type || 'cpu'}`;
          columns = ['period', 'avg_value', 'min_value', 'max_value', 'sample_count'];
          break;
        case 'alert_summary': {
          const summary = this.reportService.getAlertSummary(days);
          data = summary.per_day;
          title = 'Alert Summary';
          columns = ['day', 'count'];
          break;
        }
        case 'ticket_summary': {
          const summary = this.reportService.getTicketSummary(days);
          data = summary.per_day;
          title = 'Ticket Summary';
          columns = ['day', 'opened', 'closed'];
          break;
        }
        default:
          console.error(`[Scheduler] Unknown report type: ${schedule.report_type}`);
          return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let filePath, content;

      if (schedule.format === 'pdf') {
        content = await this.exportService.exportPDF({
          title,
          dateRange: `Last ${days} days`,
          rows: data,
          columns
        });
        filePath = path.join(this.reportsDir, `${schedule.report_type}_${timestamp}.pdf`);
        fs.writeFileSync(filePath, content);
      } else {
        content = this.exportService.exportCSV(data, columns);
        filePath = path.join(this.reportsDir, `${schedule.report_type}_${timestamp}.csv`);
        fs.writeFileSync(filePath, content);
      }

      // Log to history
      this.reportService.logReport({
        schedule_id: schedule.id,
        report_type: schedule.report_type,
        filters,
        format: schedule.format,
        file_path: filePath
      });

      // Update last_run_at
      this.db.prepare('UPDATE report_schedules SET last_run_at = datetime(\'now\') WHERE id = ?')
        .run(schedule.id);

      // Notify recipients
      const recipients = JSON.parse(schedule.recipients || '[]');
      if (recipients.length > 0 && this.notificationService) {
        const message = `Scheduled report "${schedule.name}" generated: ${title} (${days} days, ${schedule.format.toUpperCase()})`;
        // Use existing notification channels
        try {
          const channels = this.db.prepare('SELECT * FROM notification_channels WHERE enabled = 1').all();
          for (const channel of channels) {
            await this.notificationService.send(channel, {
              severity: 'info',
              message,
              check_type: 'report'
            });
          }
        } catch (notifErr) {
          console.error('[Scheduler] Notification error:', notifErr);
        }
      }

      console.log(`[Scheduler] Report saved: ${filePath}`);
    } catch (err) {
      console.error(`[Scheduler] Error running schedule ${schedule.id}:`, err);
    }
  }
}

module.exports = SchedulerService;
