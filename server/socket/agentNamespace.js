function setup(io, app) {
  const agentNs = io.of('/agent');

  // Store connected devices: deviceId → socket
  const connectedDevices = new Map();

  // Chat rate limiting: deviceId → { count, resetTime }
  const chatRateLimiter = new Map();

  // Make connectedDevices accessible from app for other handlers
  app.locals.connectedDevices = connectedDevices;

  agentNs.on('connection', (socket) => {
    const deviceId = socket.handshake.query.deviceId;
    const hostname = socket.handshake.query.hostname;

    if (!deviceId) {
      console.log('[Agent] Connection rejected: no deviceId');
      socket.disconnect();
      return;
    }

    // Verify device is enrolled
    const db = app.locals.db;

    // Verify device secret
    const deviceSecret = socket.handshake.query.deviceSecret;
    const fullDevice = db.prepare('SELECT device_id, device_secret FROM devices WHERE device_id = ?').get(deviceId);
    if (!fullDevice) {
      console.log(`[Agent] Connection rejected: unknown device ${deviceId}`);
      socket.disconnect();
      return;
    }
    if (!fullDevice.device_secret) {
      console.log(`[Agent] Connection rejected: device ${deviceId} has no secret (re-enrollment required)`);
      socket.disconnect();
      return;
    }
    if (fullDevice.device_secret !== deviceSecret) {
      console.log(`[Agent] Connection rejected: invalid secret for ${deviceId}`);
      socket.disconnect();
      return;
    }

    console.log(`[Agent] Device connected: ${deviceId} (${hostname || 'unknown'})`);
    connectedDevices.set(deviceId, socket);

    // Update device status in DB (device already verified above)
    try {
      db.prepare('UPDATE devices SET status = ?, last_seen = datetime(\'now\'), hostname = COALESCE(?, hostname) WHERE device_id = ?')
        .run('online', hostname, deviceId);
    } catch (err) {
      console.error('[Agent] DB error on connect:', err.message);
    }

    // Send the assigned agent name to the client on connect
    const diagnosticAI = app.locals.diagnosticAI;
    if (diagnosticAI) {
      const agentName = diagnosticAI.getAgentNameForDevice(deviceId);
      socket.emit('agent_info', { agentName });
    }

    // Send recent chat history on reconnect
    try {
      const recentMessages = db.prepare(
        'SELECT sender, content, created_at FROM chat_messages WHERE device_id = ? ORDER BY created_at DESC LIMIT 20'
      ).all(deviceId).reverse();
      if (recentMessages.length > 0) {
        socket.emit('chat_history', { messages: recentMessages });
      }
    } catch (err) {
      console.error('[Agent] Chat history load error:', err.message);
    }

    // Heartbeat
    socket.on('heartbeat', (data) => {
      try {
        db.prepare('UPDATE devices SET last_seen = datetime(\'now\'), status = ? WHERE device_id = ?')
          .run('online', deviceId);
      } catch (err) {
        console.error('[Agent] Heartbeat DB error:', err.message);
      }
    });

    // Chat message from user
    socket.on('chat_message', async (data) => {
      const content = data.content;
      console.log(`[Agent] Chat from ${deviceId}: ${content.substring(0, 50)}...`);

      // Rate limit: 20 messages per minute per device
      const now = Date.now();
      const rateLimit = chatRateLimiter.get(deviceId) || { count: 0, resetTime: now + 60000 };
      if (now > rateLimit.resetTime) {
        rateLimit.count = 0;
        rateLimit.resetTime = now + 60000;
      }
      rateLimit.count++;
      chatRateLimiter.set(deviceId, rateLimit);

      if (rateLimit.count > 20) {
        socket.emit('chat_response', {
          text: 'Please slow down — you can send up to 20 messages per minute.',
          sender: 'ai',
          action: null
        });
        return;
      }

      const diagnosticAI = app.locals.diagnosticAI;
      if (!diagnosticAI) {
        socket.emit('chat_response', {
          text: 'Sorry, AI service is not available right now.',
          sender: 'ai',
          action: null
        });
        return;
      }

      try {
        // Get device info for context
        const device = db.prepare('SELECT hostname, os_version FROM devices WHERE device_id = ?').get(deviceId);
        const deviceInfo = device ? { hostname: device.hostname, osVersion: device.os_version, deviceId } : { deviceId };

        const response = await diagnosticAI.processMessage(deviceId, content, deviceInfo);

        socket.emit('chat_response', {
          text: response.text,
          sender: 'ai',
          agentName: response.agentName,
          action: response.action
        });

        // If action is diagnose, also request diagnostic from client
        if (response.action && response.action.type === 'diagnose') {
          socket.emit('diagnostic_request', {
            checkType: response.action.checkType,
            requestId: Date.now().toString()
          });
        }

        // If action is remediate, validate action ID before requesting approval
        if (response.action && response.action.type === 'remediate') {
          const VALID_ACTIONS = ['flush_dns', 'clear_temp', 'restart_spooler', 'repair_network', 'clear_browser_cache'];
          if (VALID_ACTIONS.includes(response.action.actionId)) {
            socket.emit('remediation_request', {
              actionId: response.action.actionId,
              requestId: Date.now().toString()
            });
          } else {
            console.warn(`[Agent] Blocked invalid remediation action: ${response.action.actionId}`);
          }
        }

        // If action is ticket, create ticket in DB
        if (response.action && response.action.type === 'ticket') {
          try {
            const ticketResult = db.prepare(
              'INSERT INTO tickets (device_id, title, priority, ai_summary, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
            ).run(deviceId, response.action.title, response.action.priority, response.text);

            // Notify IT namespace
            io.of('/it').emit('ticket_created', {
              id: ticketResult.lastInsertRowid,
              deviceId,
              title: response.action.title,
              priority: response.action.priority
            });
          } catch (err) {
            console.error('[Agent] Ticket creation error:', err.message);
          }
        }

        // Notify IT namespace watchers
        io.of('/it').emit('device_chat_update', {
          deviceId,
          message: { sender: 'user', content },
          response: { sender: 'ai', text: response.text, action: response.action }
        });

      } catch (err) {
        console.error('[Agent] Chat processing error:', err.message);
        socket.emit('chat_response', {
          text: 'I encountered an error processing your message. Please try again.',
          sender: 'ai',
          action: null
        });
      }
    });

    // Diagnostic results from client
    socket.on('diagnostic_result', async (data) => {
      console.log(`[Agent] Diagnostic result from ${deviceId}: ${data.checkType}`);

      // Save to DB
      try {
        db.prepare(
          'INSERT INTO diagnostic_results (device_id, check_type, status, data, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
        ).run(deviceId, data.checkType, data.status || 'completed', JSON.stringify(data.results));
      } catch (err) {
        console.error('[Agent] Diagnostic save error:', err.message);
      }

      // Feed results back to AI for interpretation
      const diagnosticAI = app.locals.diagnosticAI;
      if (diagnosticAI) {
        try {
          const device = db.prepare('SELECT hostname, os_version FROM devices WHERE device_id = ?').get(deviceId);
          const deviceInfo = device ? { hostname: device.hostname, osVersion: device.os_version, deviceId } : { deviceId };

          const response = await diagnosticAI.processDiagnosticResult(deviceId, data.checkType, data.results);

          socket.emit('chat_response', {
            text: response.text,
            sender: 'ai',
            agentName: response.agentName,
            action: response.action
          });

          // Handle any follow-up actions
          if (response.action && response.action.type === 'remediate') {
            const VALID_ACTIONS = ['flush_dns', 'clear_temp', 'restart_spooler', 'repair_network', 'clear_browser_cache'];
            if (VALID_ACTIONS.includes(response.action.actionId)) {
              socket.emit('remediation_request', {
                actionId: response.action.actionId,
                requestId: Date.now().toString()
              });
            } else {
              console.warn(`[Agent] Blocked invalid remediation action: ${response.action.actionId}`);
            }
          }
        } catch (err) {
          console.error('[Agent] Diagnostic AI processing error:', err.message);
        }
      }

      // Notify IT namespace
      io.of('/it').emit('device_diagnostic_update', {
        deviceId,
        checkType: data.checkType,
        results: data.results
      });
    });

    // Remediation result from client
    socket.on('remediation_result', (data) => {
      console.log(`[Agent] Remediation result from ${deviceId}: ${data.success ? 'success' : 'failed'}`);

      // Log to audit
      try {
        db.prepare(
          'INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
        ).run(deviceId, 'remediation_executed', data.actionId || 'unknown', JSON.stringify(data));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Notify IT namespace
      io.of('/it').emit('device_remediation_update', {
        deviceId,
        success: data.success,
        message: data.message
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Agent] Device disconnected: ${deviceId}`);
      connectedDevices.delete(deviceId);
      chatRateLimiter.delete(deviceId);

      try {
        db.prepare('UPDATE devices SET status = ?, last_seen = datetime(\'now\') WHERE device_id = ?')
          .run('offline', deviceId);
      } catch (err) {
        console.error('[Agent] DB error on disconnect:', err.message);
      }

      // Notify IT namespace
      io.of('/it').emit('device_status_changed', {
        deviceId,
        status: 'offline'
      });
    });
  });

  return agentNs;
}

module.exports = { setup };
