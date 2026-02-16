class NotificationService {
  constructor(db) {
    this.db = db;
  }

  async dispatchAlert(alert, device) {
    const channels = this.db.prepare(
      'SELECT * FROM notification_channels WHERE enabled = 1'
    ).all();

    for (const channel of channels) {
      try {
        await this.sendToChannel(channel, alert, device);
      } catch (err) {
        console.error(`Notification to channel '${channel.name}' failed:`, err.message);
      }
    }
  }

  async sendToChannel(channel, alert, device) {
    let config;
    try {
      config = JSON.parse(channel.config);
    } catch {
      throw new Error(`Invalid config for channel '${channel.name}'`);
    }

    if (!config.url) throw new Error('Channel config missing url');

    let payload;
    const hostname = device?.hostname || alert.device_id?.substring(0, 8) || 'Unknown';
    const severityEmoji = alert.severity === 'critical' ? '\uD83D\uDD34' : '\uD83D\uDFE1';
    const text = `${severityEmoji} [${alert.severity.toUpperCase()}] ${hostname}: ${alert.message}`;

    switch (channel.channel_type) {
      case 'slack':
        payload = {
          text,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*${severityEmoji} ${alert.severity.toUpperCase()} Alert*\n*Device:* ${hostname}\n*Check:* ${alert.check_type}\n*Message:* ${alert.message}\n*Time:* ${alert.triggered_at}` }
            }
          ]
        };
        break;
      case 'teams':
        payload = {
          '@type': 'MessageCard',
          '@context': 'http://schema.org/extensions',
          themeColor: alert.severity === 'critical' ? 'FF0000' : 'FFA500',
          summary: text,
          sections: [{
            activityTitle: `${severityEmoji} ${alert.severity.toUpperCase()} Alert`,
            facts: [
              { name: 'Device', value: hostname },
              { name: 'Check', value: alert.check_type },
              { name: 'Message', value: alert.message },
              { name: 'Time', value: alert.triggered_at }
            ]
          }]
        };
        break;
      case 'webhook':
      default:
        payload = { alert, device: { device_id: device?.device_id, hostname } };
        break;
    }

    const headers = { 'Content-Type': 'application/json', ...(config.headers || {}) };

    // Send with 5s timeout and 1 retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
          // Audit log
          this.db.prepare(
            "INSERT INTO audit_log (actor, action, target, details) VALUES ('system', 'notification_sent', ?, ?)"
          ).run(channel.name, JSON.stringify({ alertId: alert.id, channelId: channel.id, severity: alert.severity }));
          return;
        }

        if (attempt === 0) continue; // retry once
        console.error(`Notification to '${channel.name}' failed: HTTP ${res.status}`);
      } catch (err) {
        if (attempt === 1) throw err; // throw on second failure
      }
    }
  }

  async testChannel(channelId) {
    const channel = this.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(channelId);
    if (!channel) throw new Error('Channel not found');

    const testAlert = {
      id: 0,
      severity: 'warning',
      check_type: 'test',
      message: 'This is a test notification from Pocket IT',
      triggered_at: new Date().toISOString()
    };
    const testDevice = { device_id: 'test-device', hostname: 'TEST-PC' };

    await this.sendToChannel(channel, testAlert, testDevice);
    return { success: true, message: 'Test notification sent' };
  }
}

module.exports = NotificationService;
