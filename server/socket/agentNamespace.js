function setup(io, app) {
  const agentNs = io.of('/agent');

  // Store connected devices: deviceId → socket
  const connectedDevices = new Map();

  // Chat rate limiting: deviceId → { count, resetTime }
  const chatRateLimiter = new Map();

  // Diagnostic result buffers: deviceId → { results: {}, timer }
  const diagnosticBuffers = new Map();

  // Diagnostic descriptions for chat UI
  const DIAGNOSTIC_DESCRIPTIONS = {
    cpu: 'CPU Usage Check',
    memory: 'Memory Usage Check',
    disk: 'Disk Space Check',
    network: 'Network Connectivity Check',
    top_processes: 'Top 15 processes by memory usage with CPU estimates',
    event_log: 'Recent Windows Event Log errors and critical events (last 24h)',
    windows_update: 'Windows Update status — recent patches and pending reboots',
    installed_software: 'List of installed programs with versions',
    services: 'Windows services status — focuses on stopped auto-start services',
    all: 'Full System Diagnostic'
  };

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

    // v0.4.0: Resolve uptime alert on reconnect
    try {
      const alertService = app.locals.alertService;
      if (alertService) {
        alertService.resolveUptimeAlert(deviceId);
        io.of('/it').emit('alert_stats_updated', alertService.getStats());
      }
    } catch (err) {
      console.error('[Agent] Uptime resolve error:', err.message);
    }

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

        // v0.4.0: Resolve uptime alert on heartbeat
        try {
          const alertService = app.locals.alertService;
          if (alertService) {
            alertService.resolveUptimeAlert(deviceId);
          }
        } catch (err) {
          console.error('[Agent] Heartbeat alert resolve error:', err.message);
        }
      } catch (err) {
        console.error('[Agent] Heartbeat DB error:', err.message);
      }
    });

    // System profile from client (Phase B)
    socket.on('system_profile', (data) => {
      console.log(`[Agent] System profile from ${deviceId}`);
      try {
        db.prepare(`
          UPDATE devices SET
            cpu_model = ?, total_ram_gb = ?, total_disk_gb = ?, processor_count = ?,
            os_edition = ?, os_build = ?, os_architecture = ?,
            bios_manufacturer = ?, bios_version = ?, gpu_model = ?,
            serial_number = ?, domain = ?, last_boot_time = ?,
            uptime_hours = ?, logged_in_users = ?, network_adapters = ?
          WHERE device_id = ?
        `).run(
          data.cpuModel || null,
          data.totalRamGB || null,
          data.totalDiskGB || null,
          data.processorCount || null,
          data.osEdition || null,
          data.osBuild || null,
          data.osArchitecture || null,
          data.biosManufacturer || null,
          data.biosVersion || null,
          data.gpuModel || null,
          data.serialNumber || null,
          data.domain || null,
          data.lastBootTime || null,
          data.uptimeHours || null,
          data.loggedInUsers ? JSON.stringify(data.loggedInUsers) : null,
          data.networkAdapters ? JSON.stringify(data.networkAdapters) : null,
          deviceId
        );
      } catch (err) {
        console.error('[Agent] System profile save error:', err.message);
      }

      // Notify IT dashboard
      io.of('/it').emit('device_status_changed', { deviceId, status: 'online' });
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
        const device = db.prepare('SELECT hostname, os_version, cpu_model, total_ram_gb, total_disk_gb, processor_count FROM devices WHERE device_id = ?').get(deviceId);
        const deviceInfo = device ? {
          hostname: device.hostname, osVersion: device.os_version, deviceId,
          cpuModel: device.cpu_model, totalRamGB: device.total_ram_gb,
          totalDiskGB: device.total_disk_gb, processorCount: device.processor_count
        } : { deviceId };

        const response = await diagnosticAI.processMessage(deviceId, content, deviceInfo);

        socket.emit('chat_response', {
          text: response.text,
          sender: 'ai',
          agentName: response.agentName,
          action: response.action
        });

        // If action is diagnose, also request diagnostic from client
        if (response.action && response.action.type === 'diagnose') {
          const requestId = Date.now().toString();
          const checkType = response.action.checkType;

          // Audit log: AI-triggered diagnostic request
          try {
            db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
              .run('ai', 'diagnostic_requested', deviceId, JSON.stringify({ checkType, requestId }));
          } catch (err) {
            console.error('[Agent] Audit log error:', err.message);
          }

          socket.emit('diagnostic_request', {
            checkType,
            requestId,
            description: DIAGNOSTIC_DESCRIPTIONS[checkType] || checkType
          });
        }

        // If action is remediate, validate action ID before requesting approval
        if (response.action && response.action.type === 'remediate') {
          const VALID_ACTIONS = ['flush_dns', 'clear_temp', 'restart_spooler', 'repair_network', 'clear_browser_cache', 'kill_process', 'restart_service'];
          if (VALID_ACTIONS.includes(response.action.actionId)) {
            // Validate parameters for parameterized actions
            const param = response.action.parameter || null;
            if (response.action.actionId === 'kill_process') {
              const pid = parseInt(param, 10);
              if (!Number.isInteger(pid) || pid < 1 || pid > 65535) {
                console.warn(`[Agent] Blocked kill_process with invalid PID: ${param}`);
              } else {
                socket.emit('remediation_request', {
                  actionId: response.action.actionId,
                  requestId: Date.now().toString(),
                  parameter: String(pid)
                });
              }
            } else if (response.action.actionId === 'restart_service') {
              const ALLOWED_SERVICES = ['spooler', 'wuauserv', 'bits', 'dnscache', 'w32time', 'winmgmt', 'themes', 'audiosrv', 'wsearch'];
              if (!param || !ALLOWED_SERVICES.includes(param.toLowerCase())) {
                console.warn(`[Agent] Blocked restart_service with invalid service: ${param}`);
              } else {
                socket.emit('remediation_request', {
                  actionId: response.action.actionId,
                  requestId: Date.now().toString(),
                  parameter: param.toLowerCase()
                });
              }
            } else {
              socket.emit('remediation_request', {
                actionId: response.action.actionId,
                requestId: Date.now().toString(),
                parameter: param
              });
            }
          } else {
            console.warn(`[Agent] Blocked invalid remediation action: ${response.action.actionId}`);
          }
        }

        // If action is ticket, create ticket in DB
        if (response.action && response.action.type === 'ticket') {
          try {
            // Sanitize ticket fields
            const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
            const ticketTitle = (response.action.title || 'Untitled').replace(/[<>&"']/g, '').substring(0, 200);
            const ticketPriority = VALID_PRIORITIES.includes(response.action.priority) ? response.action.priority : 'medium';

            const ticketResult = db.prepare(
              'INSERT INTO tickets (device_id, title, priority, ai_summary, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
            ).run(deviceId, ticketTitle, ticketPriority, response.text);

            // Notify IT namespace
            io.of('/it').emit('ticket_created', {
              id: ticketResult.lastInsertRowid,
              deviceId,
              title: ticketTitle,
              priority: ticketPriority
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

      // Audit log: Diagnostic completed
      try {
        db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
          .run(deviceId, 'diagnostic_completed', data.checkType, JSON.stringify({ status: data.status }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Recompute health score (Phase B)
      let healthScore = null;
      try {
        const FleetService = require('../services/fleetService');
        const fleet = new FleetService(db);
        healthScore = fleet.computeHealthScore(deviceId);

        // Notify IT dashboard with health score
        io.of('/it').emit('device_diagnostic_update', {
          deviceId,
          checkType: data.checkType,
          results: data.results,
          healthScore: healthScore
        });
      } catch (err) {
        console.error('[Agent] Health score computation error:', err.message);
      }

      // Evaluate alert thresholds (v0.4.0)
      try {
        const alertService = app.locals.alertService;
        if (alertService) {
          const newAlerts = alertService.evaluateResult(deviceId, data.checkType, data.results);
          if (newAlerts.length > 0) {
            // Get device info for notifications
            const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);

            // Emit each new alert to IT dashboard
            for (const alert of newAlerts) {
              io.of('/it').emit('new_alert', { alert, hostname: device?.hostname || deviceId });
            }

            // Dispatch notifications
            const notificationService = app.locals.notificationService;
            if (notificationService) {
              for (const alert of newAlerts) {
                notificationService.dispatchAlert(alert, device).catch(err => {
                  console.error('[Agent] Notification dispatch error:', err.message);
                });
              }
            }

            // Emit updated stats
            io.of('/it').emit('alert_stats_updated', alertService.getStats());

            // v0.5.0: Check auto-remediation policies for each new alert
            for (const alert of newAlerts) {
              try {
                const policy = alertService.getAutoRemediationPolicy(alert.threshold_id);
                if (policy) {
                  alertService.markPolicyTriggered(policy.id);

                  // Emit remediation request to device
                  socket.emit('remediation_request', {
                    actionId: policy.action_id,
                    requestId: `auto-${Date.now()}`,
                    parameter: policy.parameter || null,
                    autoApprove: !policy.require_consent
                  });

                  // Audit log
                  db.prepare(
                    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
                  ).run('system', 'auto_remediation_triggered', deviceId, JSON.stringify({
                    policyId: policy.id, actionId: policy.action_id, alertId: alert.id
                  }));

                  // Notify IT dashboard
                  io.of('/it').emit('auto_remediation_triggered', {
                    deviceId,
                    hostname: device?.hostname || deviceId,
                    actionId: policy.action_id,
                    parameter: policy.parameter,
                    alertId: alert.id,
                    requiresConsent: !!policy.require_consent
                  });

                  console.log(`[Agent] Auto-remediation triggered: ${policy.action_id} for device ${deviceId}`);
                }
              } catch (policyErr) {
                console.error('[Agent] Auto-remediation policy error:', policyErr.message);
              }
            }
          }
        }
      } catch (err) {
        console.error('[Agent] Alert evaluation error:', err.message);
      }

      // Buffer diagnostic results — debounce 2s so "all" checks produce one AI response
      let buffer = diagnosticBuffers.get(deviceId);
      if (!buffer) {
        buffer = { results: {}, timer: null, silent: false };
        diagnosticBuffers.set(deviceId, buffer);
      }
      buffer.results[data.checkType] = data.results;
      if (data.silent) buffer.silent = true;

      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = setTimeout(async () => {
        const bufferedResults = buffer.results;
        const wasSilent = buffer.silent;
        diagnosticBuffers.delete(deviceId);

        if (wasSilent) return; // Skip AI chat for silent diagnostics

        const diagnosticAI = app.locals.diagnosticAI;
        if (!diagnosticAI) return;

        try {
          const checkTypes = Object.keys(bufferedResults);
          const label = checkTypes.length === 1 ? checkTypes[0] : 'all';

          const response = await diagnosticAI.processDiagnosticResult(deviceId, label, bufferedResults);

          socket.emit('chat_response', {
            text: response.text,
            sender: 'ai',
            agentName: response.agentName,
            action: response.action
          });

          if (response.action && response.action.type === 'remediate') {
            const VALID_ACTIONS = ['flush_dns', 'clear_temp', 'restart_spooler', 'repair_network', 'clear_browser_cache', 'kill_process', 'restart_service'];
            if (VALID_ACTIONS.includes(response.action.actionId)) {
              // Validate parameters for parameterized actions
              const param = response.action.parameter || null;
              if (response.action.actionId === 'kill_process') {
                const pid = parseInt(param, 10);
                if (!Number.isInteger(pid) || pid < 1 || pid > 65535) {
                  console.warn(`[Agent] Blocked kill_process with invalid PID: ${param}`);
                } else {
                  socket.emit('remediation_request', {
                    actionId: response.action.actionId,
                    requestId: Date.now().toString(),
                    parameter: String(pid)
                  });
                }
              } else if (response.action.actionId === 'restart_service') {
                const ALLOWED_SERVICES = ['spooler', 'wuauserv', 'bits', 'dnscache', 'w32time', 'winmgmt', 'themes', 'audiosrv', 'wsearch'];
                if (!param || !ALLOWED_SERVICES.includes(param.toLowerCase())) {
                  console.warn(`[Agent] Blocked restart_service with invalid service: ${param}`);
                } else {
                  socket.emit('remediation_request', {
                    actionId: response.action.actionId,
                    requestId: Date.now().toString(),
                    parameter: param.toLowerCase()
                  });
                }
              } else {
                socket.emit('remediation_request', {
                  actionId: response.action.actionId,
                  requestId: Date.now().toString(),
                  parameter: param
                });
              }
            } else {
              console.warn(`[Agent] Blocked invalid remediation action: ${response.action.actionId}`);
            }
          }
        } catch (err) {
          console.error('[Agent] Diagnostic AI processing error:', err.message);
        }
      }, 2000);
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

    // Clear chat context
    socket.on('clear_context', () => {
      console.log(`[Agent] Context cleared for ${deviceId}`);
      const diagnosticAI = app.locals.diagnosticAI;
      if (diagnosticAI) {
        diagnosticAI.clearContext(deviceId);
      }
    });

    // v0.5.0: File access results from client
    socket.on('file_browse_result', (data) => {
      console.log(`[Agent] File browse result from ${deviceId}: ${data.requestId}`);

      // Audit log
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_browse_completed', data.path || '', JSON.stringify({ requestId: data.requestId, approved: data.approved }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Relay to IT dashboard
      io.of('/it').emit('file_browse_result', {
        deviceId,
        requestId: data.requestId,
        approved: data.approved,
        path: data.path,
        entries: data.entries || [],
        error: data.error || null
      });
    });

    socket.on('file_read_result', (data) => {
      console.log(`[Agent] File read result from ${deviceId}: ${data.requestId}`);

      // Audit log
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_read_completed', data.path || '', JSON.stringify({ requestId: data.requestId, approved: data.approved, sizeBytes: data.sizeBytes }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('file_read_result', {
        deviceId,
        requestId: data.requestId,
        approved: data.approved,
        path: data.path,
        content: data.content || '',
        sizeBytes: data.sizeBytes || 0,
        error: data.error || null
      });
    });

    // v0.5.0: Script execution results from client
    socket.on('script_result', (data) => {
      console.log(`[Agent] Script result from ${deviceId}: ${data.requestId} (exit=${data.exitCode})`);

      // Audit log
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'script_completed', data.scriptName || 'ad-hoc', JSON.stringify({
          requestId: data.requestId, exitCode: data.exitCode, success: data.success,
          durationMs: data.durationMs, truncated: data.truncated, timedOut: data.timedOut
        }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('script_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        output: data.output || '',
        errorOutput: data.errorOutput || '',
        exitCode: data.exitCode,
        durationMs: data.durationMs,
        truncated: data.truncated || false,
        timedOut: data.timedOut || false,
        validationError: data.validationError || null
      });
    });

    // v0.6.0: Remote terminal events from client
    socket.on('terminal_started', (data) => {
      console.log(`[Agent] Terminal started on ${deviceId}: ${data.requestId}`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'terminal_session_started', deviceId, JSON.stringify({ requestId: data.requestId }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('terminal_started', {
        deviceId,
        requestId: data.requestId
      });
    });

    socket.on('terminal_output', (data) => {
      io.of('/it').emit('terminal_output', {
        deviceId,
        output: data.output
      });
    });

    socket.on('terminal_stopped', (data) => {
      console.log(`[Agent] Terminal stopped on ${deviceId}: ${data.requestId} (exit=${data.exitCode})`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'terminal_session_ended', deviceId, JSON.stringify({
          requestId: data.requestId, exitCode: data.exitCode, reason: data.reason
        }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('terminal_stopped', {
        deviceId,
        requestId: data.requestId,
        exitCode: data.exitCode,
        reason: data.reason
      });
    });

    socket.on('terminal_denied', (data) => {
      console.log(`[Agent] Terminal denied on ${deviceId}: ${data.requestId}`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'terminal_denied', deviceId, JSON.stringify({ requestId: data.requestId }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('terminal_denied', {
        deviceId,
        requestId: data.requestId
      });
    });

    // v0.8.0: Remote desktop events from client
    socket.on('desktop_started', (data) => {
      console.log(`[Agent] Desktop session started on ${deviceId}: ${data.requestId}`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'desktop_session_started', deviceId, JSON.stringify({ requestId: data.requestId }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('desktop_started', {
        deviceId,
        requestId: data.requestId
      });
    });

    socket.on('desktop_frame', (data) => {
      // High-frequency: no logging, relay directly
      io.of('/it').emit('desktop_frame', {
        deviceId,
        frame: data.frame,
        width: data.width,
        height: data.height,
        timestamp: data.timestamp
      });
    });

    socket.on('desktop_stopped', (data) => {
      console.log(`[Agent] Desktop session stopped on ${deviceId}: ${data.requestId} (${data.reason})`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'desktop_session_ended', deviceId, JSON.stringify({
          requestId: data.requestId, reason: data.reason
        }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('desktop_stopped', {
        deviceId,
        requestId: data.requestId,
        reason: data.reason
      });
    });

    socket.on('desktop_denied', (data) => {
      console.log(`[Agent] Desktop denied on ${deviceId}: ${data.requestId}`);

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'desktop_denied', deviceId, JSON.stringify({ requestId: data.requestId }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      io.of('/it').emit('desktop_denied', {
        deviceId,
        requestId: data.requestId
      });
    });

    // v0.9.0: System tool results from client
    socket.on('system_tool_result', (data) => {
      console.log(`[Agent] System tool result from ${deviceId}: ${data.tool} (${data.success ? 'success' : 'failed'})`);

      // Audit log
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'system_tool_completed', data.tool || 'unknown', JSON.stringify({
          requestId: data.requestId, success: data.success, error: data.error || null
        }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Relay to IT dashboard
      io.of('/it').emit('system_tool_result', {
        deviceId,
        requestId: data.requestId,
        tool: data.tool,
        success: data.success,
        data: data.data || null,
        error: data.error || null
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Agent] Device disconnected: ${deviceId}`);
      connectedDevices.delete(deviceId);
      chatRateLimiter.delete(deviceId);
      diagnosticBuffers.delete(deviceId);

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

  // v0.4.0: Uptime monitoring — check for stale devices every 60s
  const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  setInterval(() => {
    try {
      const db = app.locals.db;
      const alertService = app.locals.alertService;
      const notificationService = app.locals.notificationService;
      if (!alertService) return;

      // Find online devices that haven't sent a heartbeat in >5 minutes
      const staleDevices = db.prepare(
        "SELECT device_id, hostname FROM devices WHERE status = 'online' AND last_seen < datetime('now', '-5 minutes')"
      ).all();

      for (const device of staleDevices) {
        // Mark as offline
        db.prepare("UPDATE devices SET status = 'offline' WHERE device_id = ?").run(device.device_id);

        // Create uptime alert
        const alert = alertService.createUptimeAlert(device.device_id, device.hostname);
        if (alert) {
          io.of('/it').emit('new_alert', { alert, hostname: device.hostname || device.device_id });
          io.of('/it').emit('device_status_changed', { deviceId: device.device_id, status: 'offline' });

          if (notificationService) {
            notificationService.dispatchAlert(alert, device).catch(err => {
              console.error('[Agent] Uptime notification error:', err.message);
            });
          }

          io.of('/it').emit('alert_stats_updated', alertService.getStats());
        }
      }
    } catch (err) {
      console.error('[Agent] Uptime check error:', err.message);
    }
  }, 60 * 1000);

  return agentNs;
}

module.exports = { setup };
