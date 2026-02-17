const express = require('express');
const router = express.Router();
const { requireIT } = require('../auth/middleware');
const { resolveClientScope, isDeviceInScope } = require('../auth/clientScope');

module.exports = function createReportsRouter(reportService, exportService) {

  // Fleet health trend
  router.get('/fleet/health-trend', requireIT, resolveClientScope, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const data = reportService.getFleetHealthTrend(days, req.clientScope);
      res.json(data);
    } catch (err) {
      console.error('Fleet health trend error:', err);
      res.status(500).json({ error: 'Failed to fetch fleet health trend' });
    }
  });

  // Device metric trend
  router.get('/device/:id/metrics', requireIT, resolveClientScope, (req, res) => {
    try {
      if (!isDeviceInScope(req.app.locals.db, req.params.id, req.clientScope)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const days = parseInt(req.query.days) || 7;
      const checkType = req.query.check_type || 'cpu';
      const data = reportService.getDeviceMetricTrend(req.params.id, checkType, days);
      res.json(data);
    } catch (err) {
      console.error('Device metric trend error:', err);
      res.status(500).json({ error: 'Failed to fetch device metrics' });
    }
  });

  // Device health history
  router.get('/device/:id/health-history', requireIT, resolveClientScope, (req, res) => {
    try {
      if (!isDeviceInScope(req.app.locals.db, req.params.id, req.clientScope)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const days = parseInt(req.query.days) || 30;
      const data = reportService.getDeviceHealthHistory(req.params.id, days);
      res.json(data);
    } catch (err) {
      console.error('Device health history error:', err);
      res.status(500).json({ error: 'Failed to fetch device health history' });
    }
  });

  // Alert summary
  router.get('/alerts/summary', requireIT, resolveClientScope, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const data = reportService.getAlertSummary(days, req.clientScope);
      res.json(data);
    } catch (err) {
      console.error('Alert summary error:', err);
      res.status(500).json({ error: 'Failed to fetch alert summary' });
    }
  });

  // Ticket summary
  router.get('/tickets/summary', requireIT, resolveClientScope, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const data = reportService.getTicketSummary(days, req.clientScope);
      res.json(data);
    } catch (err) {
      console.error('Ticket summary error:', err);
      res.status(500).json({ error: 'Failed to fetch ticket summary' });
    }
  });

  // Export report
  router.get('/export', requireIT, resolveClientScope, async (req, res) => {
    try {
      const { type, days: daysStr, format = 'csv', device_id, check_type } = req.query;
      const days = parseInt(daysStr) || 30;

      let data, title, columns;
      switch (type) {
        case 'fleet_health': {
          const rows = reportService.getFleetHealthTrend(days, req.clientScope);
          data = rows;
          title = 'Fleet Health Trend';
          columns = ['day', 'avg_score', 'check_count'];
          break;
        }
        case 'device_metrics': {
          if (!device_id || !check_type) {
            return res.status(400).json({ error: 'device_id and check_type required for device_metrics export' });
          }
          data = reportService.getDeviceMetricTrend(device_id, check_type, days);
          title = `Device Metrics - ${check_type}`;
          columns = ['period', 'avg_value', 'min_value', 'max_value', 'sample_count'];
          break;
        }
        case 'alert_summary': {
          const summary = reportService.getAlertSummary(days, req.clientScope);
          data = summary.per_day;
          title = 'Alert Summary';
          columns = ['day', 'count'];
          break;
        }
        case 'ticket_summary': {
          const summary = reportService.getTicketSummary(days, req.clientScope);
          data = summary.per_day;
          title = 'Ticket Summary';
          columns = ['day', 'opened', 'closed'];
          break;
        }
        default:
          return res.status(400).json({ error: 'Invalid report type. Use: fleet_health, device_metrics, alert_summary, ticket_summary' });
      }

      if (format === 'pdf') {
        const pdfBuffer = await exportService.exportPDF({
          title,
          dateRange: `Last ${days} days`,
          rows: data,
          columns
        });
        reportService.logReport({ report_type: type, filters: { days, device_id, check_type }, format: 'pdf' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${type}_${days}d.pdf"`);
        return res.send(pdfBuffer);
      }

      // Default CSV
      const csv = exportService.exportCSV(data, columns);
      reportService.logReport({ report_type: type, filters: { days, device_id, check_type }, format: 'csv' });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_${days}d.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ error: 'Failed to export report' });
    }
  });

  // --- Scheduled Reports CRUD ---
  router.get('/schedules', requireIT, (req, res) => {
    try {
      res.json(reportService.getSchedules());
    } catch (err) {
      console.error('Get schedules error:', err);
      res.status(500).json({ error: 'Failed to fetch schedules' });
    }
  });

  router.post('/schedules', requireIT, (req, res) => {
    try {
      const { name, report_type, filters, schedule, format, recipients } = req.body;
      if (!name || !report_type || !schedule) {
        return res.status(400).json({ error: 'name, report_type, and schedule are required' });
      }
      const created = reportService.createSchedule({
        name, report_type, filters, schedule, format, recipients,
        created_by: req.user ? req.user.username : null
      });
      res.status(201).json(created);
    } catch (err) {
      console.error('Create schedule error:', err);
      res.status(500).json({ error: 'Failed to create schedule' });
    }
  });

  router.patch('/schedules/:id', requireIT, (req, res) => {
    try {
      const updated = reportService.updateSchedule(parseInt(req.params.id), req.body);
      if (!updated) return res.status(404).json({ error: 'Schedule not found' });
      res.json(updated);
    } catch (err) {
      console.error('Update schedule error:', err);
      res.status(500).json({ error: 'Failed to update schedule' });
    }
  });

  router.delete('/schedules/:id', requireIT, (req, res) => {
    try {
      const deleted = reportService.deleteSchedule(parseInt(req.params.id));
      if (!deleted) return res.status(404).json({ error: 'Schedule not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('Delete schedule error:', err);
      res.status(500).json({ error: 'Failed to delete schedule' });
    }
  });

  // Report history
  router.get('/history', requireIT, (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      res.json(reportService.getHistory(limit));
    } catch (err) {
      console.error('Get history error:', err);
      res.status(500).json({ error: 'Failed to fetch report history' });
    }
  });

  return router;
};
