function setup(io, app) {
  const agentNs = io.of('/agent');

  // Store connected devices: deviceId → socket
  const connectedDevices = new Map();

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

    console.log(`[Agent] Device connected: ${deviceId} (${hostname || 'unknown'})`);
    connectedDevices.set(deviceId, socket);

    // Update device status in DB
    const db = app.locals.db;
    try {
      const existing = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);
      if (existing) {
        db.prepare('UPDATE devices SET status = ?, last_seen = datetime(\'now\'), hostname = COALESCE(?, hostname) WHERE device_id = ?')
          .run('online', hostname, deviceId);
      }
    } catch (err) {
      console.error('[Agent] DB error on connect:', err.message);
    }

    // Send the assigned agent name to the client on connect
    const diagnosticAI = app.locals.diagnosticAI;
    if (diagnosticAI) {
      const agentName = diagnosticAI.getAgentNameForDevice(deviceId);
      socket.emit('agent_info', { agentName });
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

        // If action is remediate, request approval from client
        if (response.action && response.action.type === 'remediate') {
          socket.emit('remediation_request', {
            actionId: response.action.actionId,
            requestId: Date.now().toString()
          });
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
            socket.emit('remediation_request', {
              actionId: response.action.actionId,
              requestId: Date.now().toString()
            });
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
