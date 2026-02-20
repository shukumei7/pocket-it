const { emitToScoped, emitToAll } = require('./scopedEmit');
const deploymentScheduler = require('../services/deploymentScheduler');
const { VALID_ACTIONS, ALLOWED_SERVICES } = require('../config/actionWhitelist');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

function checkAIDisabled(db, app, deviceId) {
  // 1. Global AI disabled
  try {
    const globalSetting = db.prepare("SELECT value FROM server_settings WHERE key = 'ai.enabled'").get();
    if (globalSetting && globalSetting.value === 'false') {
      return { disabled: true, reason: 'global' };
    }
  } catch (err) { /* ignore */ }

  // 2. Per-device AI disabled
  try {
    const device = db.prepare('SELECT ai_disabled FROM devices WHERE device_id = ?').get(deviceId);
    if (device && device.ai_disabled) {
      return { disabled: true, reason: 'per_device' };
    }
  } catch (err) { /* ignore */ }

  // 3. IT actively chatting with this device
  if (app.locals.itActiveChatDevices && app.locals.itActiveChatDevices.has(deviceId)) {
    return { disabled: true, reason: 'it_active' };
  }

  return { disabled: false, reason: null };
}

function setup(io, app) {
  const agentNs = io.of('/agent');
  const itNs = io.of('/it');

  // Store connected devices: deviceId → socket
  const connectedDevices = new Map();

  // Chat rate limiting: deviceId → { count, resetTime }
  const chatRateLimiter = new Map();

  // Diagnostic result buffers: deviceId → { results: {}, timer }
  const diagnosticBuffers = new Map();

  // Track AI-initiated diagnostic requests: deviceId → Set of pending requestIds
  // Only diagnostic results matching a pending AI request get fed back to the AI
  const pendingAIDiagnostics = new Set();

  // Track AI-initiated script requests: deviceId → Set<requestId>
  const pendingAIScripts = new Map();

  // Defense-in-depth: track PIDs seen in recent diagnostic results per device
  // Used to verify kill_process PIDs before emitting remediation requests
  const recentDiagnosticPIDs = new Map(); // deviceId -> Set of PIDs

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
    security: 'Security posture — BitLocker, Defender, Firewall, Local Admins',
    battery: 'Battery health and charge status (laptops)',
    all: 'Full System Diagnostic'
  };

  // Make connectedDevices accessible from app for other handlers
  app.locals.connectedDevices = connectedDevices;

  agentNs.on('connection', (socket) => {
    const deviceId = socket.handshake.query.deviceId;
    const hostname = socket.handshake.query.hostname;
    const clientVersion = socket.handshake.query.clientVersion;
    const exeHash = socket.handshake.query.exeHash;
    const lastSeenChat = socket.handshake.query.lastSeenChat;

    if (!deviceId) {
      console.log('[Agent] Connection rejected: no deviceId');
      socket.disconnect();
      return;
    }

    // Verify device is enrolled
    const db = app.locals.db;

    // Verify device secret
    const deviceSecret = socket.handshake.auth?.deviceSecret || socket.handshake.query.deviceSecret;
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
    const isHashed = fullDevice.device_secret.startsWith('$2');
    const secretValid = isHashed
      ? bcrypt.compareSync(deviceSecret, fullDevice.device_secret)
      : (fullDevice.device_secret.length === deviceSecret.length &&
         crypto.timingSafeEqual(Buffer.from(fullDevice.device_secret), Buffer.from(deviceSecret)));
    if (!secretValid) {
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
        emitToAll(itNs, 'alert_stats_updated', alertService.getStats());
      }
    } catch (err) {
      console.error('[Agent] Uptime resolve error:', err.message);
    }

    // Update device status in DB (device already verified above)
    try {
      db.prepare('UPDATE devices SET status = ?, last_seen = datetime(\'now\'), hostname = COALESCE(?, hostname), client_version = COALESCE(?, client_version), exe_hash = COALESCE(?, exe_hash) WHERE device_id = ?')
        .run('online', hostname, clientVersion || null, exeHash || null, deviceId);

      // Integrity check: compare device exe_hash against known good hash for its version
      if (exeHash && exeHash !== 'unknown' && clientVersion) {
        const knownPkg = db.prepare('SELECT exe_hash FROM update_packages WHERE version = ?').get(clientVersion);
        if (knownPkg && knownPkg.exe_hash && knownPkg.exe_hash !== exeHash) {
          console.warn(`[Agent] INTEGRITY WARNING: Device ${deviceId} (v${clientVersion}) has unexpected EXE hash. Expected: ${knownPkg.exe_hash.substring(0, 16)}... Got: ${exeHash.substring(0, 16)}...`);
          // Notify IT dashboard
          emitToScoped(itNs, db, deviceId, 'integrity_warning', { deviceId, hostname, clientVersion, expectedHash: knownPkg.exe_hash, actualHash: exeHash });
        }
      }
    } catch (err) {
      console.error('[Agent] DB error on connect:', err.message);
    }

    // Auto-push update if client is outdated
    try {
      if (clientVersion) {
        const latest = db.prepare('SELECT version FROM update_packages ORDER BY created_at DESC LIMIT 1').get();
        if (latest && latest.version !== clientVersion) {
          const pa = latest.version.split('.').map(Number);
          const pb = clientVersion.split('.').map(Number);
          let newer = false;
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) { newer = true; break; }
            if ((pa[i] || 0) < (pb[i] || 0)) break;
          }
          if (newer) {
            console.log(`[Agent] Device ${deviceId} (v${clientVersion}) outdated, pushing update v${latest.version}`);
            socket.emit('update_available', { version: latest.version });
          }
        }
      }
    } catch (err) {
      console.error('[Agent] Auto-update check error:', err.message);
    }

    // Send the assigned agent name to the client on connect
    const diagnosticAI = app.locals.diagnosticAI;
    if (diagnosticAI) {
      const agentName = diagnosticAI.getAgentNameForDevice(deviceId);
      socket.emit('agent_info', { agentName });
    }

    // Send AI status to device
    const aiCheck = checkAIDisabled(db, app, deviceId);
    socket.emit('ai_status', { enabled: !aiCheck.disabled, reason: aiCheck.reason });

    // Send recent chat history on reconnect (only unseen messages)
    try {
      let recentMessages;
      if (lastSeenChat) {
        recentMessages = db.prepare(
          'SELECT sender, content, created_at FROM chat_messages WHERE device_id = ? AND created_at > ? ORDER BY id DESC LIMIT 20'
        ).all(deviceId, lastSeenChat).reverse();
      } else {
        recentMessages = db.prepare(
          'SELECT sender, content, created_at FROM chat_messages WHERE device_id = ? ORDER BY id DESC LIMIT 20'
        ).all(deviceId).reverse();
      }
      if (recentMessages.length > 0) {
        socket.emit('chat_history', { messages: recentMessages });
      }
    } catch (err) {
      console.error('[Agent] Chat history load error:', err.message);
    }

    // v0.14.0: Dispatch pending deployments for reconnected device
    try {
      deploymentScheduler.dispatchPendingForDevice(db, io, deviceId, socket);
    } catch (err) {
      console.error('[Agent] Pending deployment dispatch error:', err.message);
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
        // Track previous logged-in users
        const newUsers = JSON.stringify(data.loggedInUsers || []);
        const currentRow = db.prepare('SELECT logged_in_users FROM devices WHERE device_id = ?').get(deviceId);
        if (currentRow && currentRow.logged_in_users && currentRow.logged_in_users !== newUsers) {
          db.prepare('UPDATE devices SET previous_logged_in_users = ? WHERE device_id = ?').run(currentRow.logged_in_users, deviceId);
        }

        db.prepare(`
          UPDATE devices SET
            cpu_model = ?, total_ram_gb = ?, total_disk_gb = ?, processor_count = ?,
            os_edition = ?, os_build = ?, os_architecture = ?,
            os_display_version = ?, os_install_date = ?, os_name = ?,
            bios_manufacturer = ?, bios_version = ?, gpu_model = ?,
            serial_number = ?, domain = ?, last_boot_time = ?,
            uptime_hours = ?, logged_in_users = ?, network_adapters = ?,
            device_manufacturer = ?, device_model = ?, form_factor = ?,
            tpm_version = ?, secure_boot = ?, domain_join_type = ?
          WHERE device_id = ?
        `).run(
          data.cpuModel || null,
          data.totalRamGB || null,
          data.totalDiskGB || null,
          data.processorCount || null,
          data.osEdition || null,
          data.osBuild || null,
          data.osArchitecture || null,
          data.osDisplayVersion || null,
          data.osInstallDate || null,
          data.osName || null,
          data.biosManufacturer || null,
          data.biosVersion || null,
          data.gpuModel || null,
          data.serialNumber || null,
          data.domain || null,
          data.lastBootTime || null,
          data.uptimeHours || null,
          data.loggedInUsers ? JSON.stringify(data.loggedInUsers) : null,
          data.networkAdapters ? JSON.stringify(data.networkAdapters) : null,
          data.deviceManufacturer || null,
          data.deviceModel || null,
          data.formFactor || null,
          data.tpmVersion || null,
          data.secureBoot || null,
          data.domainJoinType || null,
          deviceId
        );
      } catch (err) {
        console.error('[Agent] System profile save error:', err.message);
      }

      // Notify IT dashboard
      emitToScoped(itNs, db, deviceId, 'device_status_changed', { deviceId, status: 'online' });
    });

    // Chat message from user
    socket.on('chat_message', async (data) => {
      const content = data.content;

      if (!content || typeof content !== 'string' || content.length === 0) return;
      if (content.length > 10000) {
        socket.emit('chat_response', {
          text: 'Your message is too long. Please keep messages under 10,000 characters.',
          sender: 'system',
          action: null
        });
        return;
      }

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

      // Check if AI is disabled for this device
      const aiDisableCheck = checkAIDisabled(db, app, deviceId);
      if (aiDisableCheck.disabled) {
        // Still save user message
        try {
          db.prepare(
            "INSERT INTO chat_messages (device_id, sender, content, message_type) VALUES (?, ?, ?, ?)"
          ).run(deviceId, 'user', content, 'text');
        } catch (err) {
          console.error('[Agent] Chat save error:', err.message);
        }

        // Send system response to device
        const disabledMsg = aiDisableCheck.reason === 'it_active'
          ? 'An IT technician is currently assisting you. Please hold while they review your message.'
          : "We're connecting you with a live IT technician. Please hold tight — someone will be with you shortly.";

        socket.emit('chat_response', {
          text: disabledMsg,
          sender: 'system',
          ai_disabled: true,
          action: null
        });

        // Broadcast to IT watchers so they see the user's message
        const itNs = io.of('/it');
        emitToScoped(itNs, db, deviceId, 'device_chat_update', {
          deviceId,
          message: { sender: 'user', content }
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
          pendingAIDiagnostics.add(deviceId);

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
          if (VALID_ACTIONS.includes(response.action.actionId)) {
            // Audit log: AI remediation requested
            try {
              db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
                .run('ai', 'remediation_requested', deviceId, JSON.stringify({ action: response.action.actionId, params: response.action.parameter || null }));
            } catch (err) {
              console.error('[Agent] Audit log error:', err.message);
            }

            // Validate parameters for parameterized actions
            const param = response.action.parameter || null;
            if (response.action.actionId === 'kill_process') {
              const pid = parseInt(param, 10);
              if (!Number.isInteger(pid) || pid < 1 || pid > 65535) {
                console.warn(`[Agent] Blocked kill_process with invalid PID: ${param}`);
              } else {
                // Defense-in-depth: verify PID was seen in recent diagnostics
                const knownPIDs = recentDiagnosticPIDs.get(deviceId);
                if (!knownPIDs || !knownPIDs.has(pid)) {
                  console.warn(`[Agent] Blocked kill_process: PID ${pid} not found in recent diagnostics for ${deviceId}`);
                } else {
                  socket.emit('remediation_request', {
                    actionId: response.action.actionId,
                    requestId: Date.now().toString(),
                    parameter: String(pid)
                  });
                }
              }
            } else if (response.action.actionId === 'restart_service') {
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

        // If action is screenshot, request from client
        if (response.action && response.action.type === 'screenshot') {
          const requestId = `ss-${Date.now()}`;
          try {
            db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
              .run('ai', 'screenshot_requested', deviceId, JSON.stringify({ requestId }));
          } catch (err) {
            console.error('[Agent] Audit log error:', err.message);
          }

          socket.emit('screenshot_request', {
            requestId,
            reason: 'AI needs to see your screen to help diagnose the issue'
          });
        }

        // If action is run_script, look up script and send to device
        if (response.action && response.action.type === 'run_script') {
          const scriptId = response.action.scriptId;
          const script = db.prepare('SELECT * FROM script_library WHERE id = ? AND ai_tool = 1').get(scriptId);
          if (script) {
            const requestId = `ai-sc-${Date.now()}`;
            // Track as AI-initiated
            if (!pendingAIScripts.has(deviceId)) pendingAIScripts.set(deviceId, new Set());
            pendingAIScripts.get(deviceId).add(requestId);
            // Audit log
            try {
              db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
                .run('ai', 'script_requested', deviceId, JSON.stringify({ scriptId, scriptName: script.name, requestId }));
            } catch (err) {
              console.error('[Agent] Audit log error:', err.message);
            }
            // Emit to device
            socket.emit('script_request', {
              requestId,
              scriptName: script.name,
              scriptContent: script.script_content,
              requiresElevation: !!script.requires_elevation,
              timeoutSeconds: script.timeout_seconds || 60,
              aiInitiated: true
            });
          } else {
            console.warn(`[Agent] AI requested invalid/non-AI-tool script ID: ${scriptId}`);
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
            emitToScoped(itNs, db, deviceId, 'ticket_created', {
              id: ticketResult.lastInsertRowid,
              deviceId,
              title: ticketTitle,
              priority: ticketPriority
            });
          } catch (err) {
            console.error('[Agent] Ticket creation error:', err.message);
          }
        }

        // Handle feature wish (can coexist with other actions)
        if (response.wish) {
          const VALID_CATEGORIES = ['software', 'network', 'security', 'hardware', 'account', 'automation', 'other'];
          const category = VALID_CATEGORIES.includes(response.wish.category) ? response.wish.category : 'other';
          const need = (response.wish.need || '').trim().slice(0, 200);

          if (need.length > 0) {
            try {
              const userRequest = (content || '').slice(0, 500);
              const device = db.prepare('SELECT hostname FROM devices WHERE device_id = ?').get(deviceId);
              const hostname = device?.hostname || '';

              const existing = db.prepare(
                "SELECT id, vote_count FROM feature_wishes WHERE category = ? AND ai_need = ? AND status != 'implemented'"
              ).get(category, need);

              if (existing) {
                db.prepare(
                  "UPDATE feature_wishes SET vote_count = vote_count + 1, updated_at = datetime('now') WHERE id = ?"
                ).run(existing.id);
                console.log(`[Agent] Feature wish voted: "${need}" (${existing.vote_count + 1} votes)`);
              } else {
                db.prepare(
                  "INSERT INTO feature_wishes (user_request, ai_need, category, device_id, hostname) VALUES (?, ?, ?, ?, ?)"
                ).run(userRequest, need, category, deviceId, hostname);
                console.log(`[Agent] Feature wish logged: [${category}] "${need}"`);
              }

              emitToAll(itNs, 'feature_wish_logged', { category, need, deviceId, hostname });
            } catch (err) {
              console.error('[Agent] Feature wish error:', err.message);
            }
          }
        }

        // Notify IT namespace watchers
        emitToScoped(itNs, db, deviceId, 'device_chat_update', {
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

      // Extract PIDs from diagnostic results for kill_process defense-in-depth validation
      if (data.results) {
        const pids = new Set();
        const extractPIDs = (obj) => {
          if (Array.isArray(obj)) {
            obj.forEach(item => {
              if (item && (item.pid || item.PID || item.processId)) {
                pids.add(Number(item.pid || item.PID || item.processId));
              }
            });
          }
          if (obj && typeof obj === 'object') {
            Object.values(obj).forEach(v => {
              if (Array.isArray(v)) extractPIDs(v);
            });
          }
        };
        extractPIDs(data.results);
        if (pids.size > 0) {
          recentDiagnosticPIDs.set(deviceId, pids);
          // Clear after 10 minutes
          setTimeout(() => recentDiagnosticPIDs.delete(deviceId), 600000);
        }
      }

      // Recompute health score (Phase B)
      let healthScore = null;
      try {
        const FleetService = require('../services/fleetService');
        const fleet = new FleetService(db);
        healthScore = fleet.computeHealthScore(deviceId);

        // Notify IT dashboard with health score
        emitToScoped(itNs, db, deviceId, 'device_diagnostic_update', {
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
              emitToScoped(itNs, db, deviceId, 'new_alert', { alert, hostname: device?.hostname || deviceId });
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
            emitToAll(itNs, 'alert_stats_updated', alertService.getStats());

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
                  emitToScoped(itNs, db, deviceId, 'auto_remediation_triggered', {
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

      // v0.14.0: If IT guidance context is active for this device, also feed results there
      const diagnosticAI2 = app.locals.diagnosticAI;
      if (diagnosticAI2 && diagnosticAI2.itGuidanceContexts && diagnosticAI2.itGuidanceContexts.has(deviceId)) {
        try {
          const guidanceResponse = await diagnosticAI2.processITGuidanceDiagnosticResult(deviceId, data.checkType, data.results);
          emitToScoped(itNs, db, deviceId, 'it_guidance_response', {
            deviceId,
            text: guidanceResponse.text,
            agentName: guidanceResponse.agentName,
            action: guidanceResponse.action
          });
        } catch (guidanceErr) {
          console.error('[Agent] IT guidance diagnostic routing error:', guidanceErr.message);
        }
      }

      // Only feed results to AI if the AI requested them (not scheduled/IT-initiated)
      if (!pendingAIDiagnostics.has(deviceId)) return;

      // Buffer diagnostic results — debounce 2s so "all" checks produce one AI response
      let buffer = diagnosticBuffers.get(deviceId);
      if (!buffer) {
        buffer = { results: {}, timer: null };
        diagnosticBuffers.set(deviceId, buffer);
      }
      buffer.results[data.checkType] = data.results;

      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = setTimeout(async () => {
        const bufferedResults = buffer.results;
        diagnosticBuffers.delete(deviceId);
        pendingAIDiagnostics.delete(deviceId);

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
            if (VALID_ACTIONS.includes(response.action.actionId)) {
              // Validate parameters for parameterized actions
              const param = response.action.parameter || null;
              if (response.action.actionId === 'kill_process') {
                const pid = parseInt(param, 10);
                if (!Number.isInteger(pid) || pid < 1 || pid > 65535) {
                  console.warn(`[Agent] Blocked kill_process with invalid PID: ${param}`);
                } else {
                  // Defense-in-depth: verify PID was seen in recent diagnostics
                  const knownPIDs = recentDiagnosticPIDs.get(deviceId);
                  if (!knownPIDs || !knownPIDs.has(pid)) {
                    console.warn(`[Agent] Blocked kill_process: PID ${pid} not found in recent diagnostics for ${deviceId}`);
                  } else {
                    socket.emit('remediation_request', {
                      actionId: response.action.actionId,
                      requestId: Date.now().toString(),
                      parameter: String(pid)
                    });
                  }
                }
              } else if (response.action.actionId === 'restart_service') {
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

          // Handle run_script action from diagnostic follow-up
          if (response.action && response.action.type === 'run_script') {
            const scriptId = response.action.scriptId;
            const script = db.prepare('SELECT * FROM script_library WHERE id = ? AND ai_tool = 1').get(scriptId);
            if (script) {
              const requestId = `ai-sc-${Date.now()}`;
              if (!pendingAIScripts.has(deviceId)) pendingAIScripts.set(deviceId, new Set());
              pendingAIScripts.get(deviceId).add(requestId);
              try {
                db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
                  .run('ai', 'script_requested', deviceId, JSON.stringify({ scriptId, scriptName: script.name, requestId }));
              } catch (err) {
                console.error('[Agent] Audit log error:', err.message);
              }
              socket.emit('script_request', {
                requestId,
                scriptName: script.name,
                scriptContent: script.script_content,
                requiresElevation: !!script.requires_elevation,
                timeoutSeconds: script.timeout_seconds || 60,
                aiInitiated: true
              });
            } else {
              console.warn(`[Agent] AI requested invalid/non-AI-tool script ID: ${scriptId}`);
            }
          }

          // Handle feature wish from diagnostic follow-up (no user message available)
          if (response.wish) {
            const VALID_CATEGORIES = ['software', 'network', 'security', 'hardware', 'account', 'automation', 'other'];
            const category = VALID_CATEGORIES.includes(response.wish.category) ? response.wish.category : 'other';
            const need = (response.wish.need || '').trim().slice(0, 200);

            if (need.length > 0) {
              try {
                const devInfo = db.prepare('SELECT hostname FROM devices WHERE device_id = ?').get(deviceId);
                const hostname = devInfo?.hostname || '';

                const existing = db.prepare(
                  "SELECT id, vote_count FROM feature_wishes WHERE category = ? AND ai_need = ? AND status != 'implemented'"
                ).get(category, need);

                if (existing) {
                  db.prepare(
                    "UPDATE feature_wishes SET vote_count = vote_count + 1, updated_at = datetime('now') WHERE id = ?"
                  ).run(existing.id);
                  console.log(`[Agent] Feature wish voted: "${need}" (${existing.vote_count + 1} votes)`);
                } else {
                  db.prepare(
                    "INSERT INTO feature_wishes (user_request, ai_need, category, device_id, hostname) VALUES (?, ?, ?, ?, ?)"
                  ).run('', need, category, deviceId, hostname);
                  console.log(`[Agent] Feature wish logged: [${category}] "${need}"`);
                }

                emitToAll(itNs, 'feature_wish_logged', { category, need, deviceId, hostname });
              } catch (err) {
                console.error('[Agent] Feature wish error:', err.message);
              }
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
      emitToScoped(itNs, db, deviceId, 'device_remediation_update', {
        deviceId,
        success: data.success,
        message: data.message
      });
    });

    // Screenshot result from client
    socket.on('screenshot_result', async (data) => {
      const { requestId, approved, imageData, width, height } = data;
      console.log(`[Agent] Screenshot result from ${deviceId}: ${approved ? 'approved' : 'denied'} ${width || 0}x${height || 0}`);

      try {
        db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
          .run(deviceId, 'screenshot_completed', deviceId, JSON.stringify({ requestId, approved, width, height }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Notify IT dashboard
      emitToScoped(itNs, db, deviceId, 'device_screenshot_update', {
        deviceId, approved, width, height,
        imageData: approved ? imageData : null
      });

      // Check if this is an IT guidance screenshot
      if (requestId && requestId.startsWith('itg-ss-')) {
        if (approved && imageData) {
          try {
            const diagnosticAI = app.locals.diagnosticAI;
            if (diagnosticAI) {
              const response = await diagnosticAI.processITGuidanceScreenshotResult(deviceId, imageData, width, height);
              emitToScoped(itNs, db, deviceId, 'it_guidance_response', {
                deviceId,
                text: response.text,
                agentName: response.agentName,
                action: response.action
              });
            }
          } catch (err) {
            console.error('[Agent] IT guidance screenshot analysis error:', err.message);
          }
        }
        return; // Don't process as user chat
      }

      const diagnosticAI = app.locals.diagnosticAI;
      if (!diagnosticAI) return;

      if (approved && imageData) {
        try {
          const response = await diagnosticAI.processScreenshotResult(deviceId, imageData, width, height);

          socket.emit('chat_response', {
            text: response.text,
            agentName: response.agentName,
            action: response.action
          });

          emitToScoped(itNs, db, deviceId, 'device_chat_update', {
            deviceId,
            message: { sender: 'ai', content: response.text, action: response.action }
          });

          // Handle any follow-up actions from the AI's screenshot analysis
          if (response.action && response.action.type === 'diagnose') {
            socket.emit('diagnostic_request', {
              checkType: response.action.checkType,
              requestId: Date.now().toString()
            });
          }
        } catch (err) {
          console.error('[Agent] Screenshot AI analysis error:', err.message);
        }
      } else {
        // User denied — tell AI
        try {
          const ctx = diagnosticAI.getOrCreateContext(deviceId, {});
          ctx.messages.push({ role: 'user', content: '[The user declined the screenshot request.]' });
        } catch (err) {}

        socket.emit('chat_response', {
          text: 'No problem! Could you describe what you see on your screen instead? Any error messages, unusual windows, or visual issues you can tell me about?',
          agentName: diagnosticAI.getAgentNameForDevice(deviceId),
          action: null
        });
      }
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
      emitToScoped(itNs, db, deviceId, 'file_browse_result', {
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

      emitToScoped(itNs, db, deviceId, 'file_read_result', {
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
    socket.on('script_result', async (data) => {
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

      // Check if this is an AI-initiated script result — feed back to AI
      if (data.requestId && pendingAIScripts.has(deviceId)) {
        const pendingSet = pendingAIScripts.get(deviceId);
        if (pendingSet.has(data.requestId)) {
          pendingSet.delete(data.requestId);
          if (pendingSet.size === 0) pendingAIScripts.delete(deviceId);

          const diagnosticAI = app.locals.diagnosticAI;
          if (diagnosticAI) {
            try {
              const scriptOutput = data.success
                ? (data.output || 'Script completed successfully with no output.')
                : `Script failed (exit code ${data.exitCode}): ${data.errorOutput || data.output || 'No output'}`;
              const aiResponse = await diagnosticAI.processScriptResult(deviceId, data.scriptName || 'Script', scriptOutput);

              socket.emit('chat_response', {
                text: aiResponse.text,
                sender: 'ai',
                agentName: aiResponse.agentName,
                action: aiResponse.action
              });

              emitToScoped(itNs, db, deviceId, 'device_chat_update', {
                deviceId,
                message: { sender: 'ai', content: aiResponse.text, action: aiResponse.action }
              });

              // Handle follow-up actions from AI's script analysis
              if (aiResponse.action && aiResponse.action.type === 'diagnose') {
                const diagRequestId = Date.now().toString();
                pendingAIDiagnostics.add(deviceId);
                socket.emit('diagnostic_request', {
                  checkType: aiResponse.action.checkType,
                  requestId: diagRequestId,
                  description: DIAGNOSTIC_DESCRIPTIONS[aiResponse.action.checkType] || aiResponse.action.checkType
                });
              }
              if (aiResponse.action && aiResponse.action.type === 'remediate') {
                if (VALID_ACTIONS.includes(aiResponse.action.actionId)) {
                  const param = aiResponse.action.parameter || null;
                  socket.emit('remediation_request', {
                    actionId: aiResponse.action.actionId,
                    parameter: param,
                    requestId: `rem-${Date.now()}`,
                    autoApprove: false
                  });
                }
              }
            } catch (err) {
              console.error('[Agent] AI script result processing error:', err.message);
            }
          }
        }
      }

      emitToScoped(itNs, db, deviceId, 'script_result', {
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

      // Check if this is a deployment result
      if (data.requestId && data.requestId.startsWith('dep-')) {
        deploymentScheduler.handleDeploymentResult(db, io, data.requestId, data);
      }
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

      emitToScoped(itNs, db, deviceId, 'terminal_started', {
        deviceId,
        requestId: data.requestId
      });
    });

    socket.on('terminal_output', (data) => {
      emitToScoped(itNs, db, deviceId, 'terminal_output', {
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

      emitToScoped(itNs, db, deviceId, 'terminal_stopped', {
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

      emitToScoped(itNs, db, deviceId, 'terminal_denied', {
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

      emitToScoped(itNs, db, deviceId, 'desktop_started', {
        deviceId,
        requestId: data.requestId
      });
    });

    socket.on('desktop_frame', (data) => {
      // High-frequency: no logging, relay directly
      emitToScoped(itNs, db, deviceId, 'desktop_frame', {
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

      emitToScoped(itNs, db, deviceId, 'desktop_stopped', {
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

      emitToScoped(itNs, db, deviceId, 'desktop_denied', {
        deviceId,
        requestId: data.requestId
      });
    });

    // v0.10.0: Remote desktop sidebar events from client
    socket.on('desktop_monitors', (data) => {
      emitToScoped(itNs, db, deviceId, 'desktop_monitors', {
        deviceId,
        monitors: data.monitors
      });
    });

    socket.on('desktop_perf_data', (data) => {
      emitToScoped(itNs, db, deviceId, 'desktop_perf_data', {
        deviceId,
        cpu: data.cpu,
        memoryPercent: data.memoryPercent,
        diskPercent: data.diskPercent
      });
    });

    socket.on('desktop_file_upload_ack', (data) => {
      emitToScoped(itNs, db, deviceId, 'desktop_file_upload_ack', {
        deviceId,
        success: data.success,
        fileName: data.fileName,
        path: data.path,
        error: data.error
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
      emitToScoped(itNs, db, deviceId, 'system_tool_result', {
        deviceId,
        requestId: data.requestId,
        tool: data.tool,
        success: data.success,
        data: data.data || null,
        error: data.error || null
      });
    });

    // File management results from client (IT-initiated)
    socket.on('file_delete_result', (data) => {
      console.log(`[Agent] File delete result from ${deviceId}: ${data.requestId}`);
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_delete_completed', deviceId, JSON.stringify({ requestId: data.requestId, success: data.success }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }
      emitToScoped(itNs, db, deviceId, 'file_delete_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        results: data.results || []
      });
    });

    socket.on('file_properties_result', (data) => {
      console.log(`[Agent] File properties result from ${deviceId}: ${data.requestId}`);
      emitToScoped(itNs, db, deviceId, 'file_properties_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        properties: data.properties || null,
        error: data.error || null
      });
    });

    socket.on('file_paste_result', (data) => {
      console.log(`[Agent] File paste result from ${deviceId}: ${data.requestId}`);
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_paste_completed', deviceId, JSON.stringify({ requestId: data.requestId, success: data.success }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }
      emitToScoped(itNs, db, deviceId, 'file_paste_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        results: data.results || [],
        error: data.error || null
      });
    });

    socket.on('file_download_result', (data) => {
      console.log(`[Agent] File download result from ${deviceId}: ${data.requestId} (size=${data.size})`);
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_download_completed', data.path || '', JSON.stringify({ requestId: data.requestId, success: data.success, size: data.size }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }
      emitToScoped(itNs, db, deviceId, 'file_download_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        path: data.path,
        filename: data.filename,
        data: data.data || null,
        mimeType: data.mimeType || 'application/octet-stream',
        size: data.size || 0,
        error: data.error || null
      });
    });

    socket.on('file_upload_result', (data) => {
      console.log(`[Agent] File upload result from ${deviceId}: ${data.requestId}`);
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'file_upload_completed', data.path || '', JSON.stringify({ requestId: data.requestId, success: data.success }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }
      emitToScoped(itNs, db, deviceId, 'file_upload_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        path: data.path || null,
        error: data.error || null
      });
    });

    // v0.14.0: Installer execution results from client
    socket.on('installer_result', (data) => {
      console.log(`[Agent] Installer result from ${deviceId}: ${data.requestId} (exit=${data.exitCode})`);

      // Audit log
      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run(deviceId, 'installer_completed', data.requestId || '', JSON.stringify({
          requestId: data.requestId, exitCode: data.exitCode, success: data.success,
          durationMs: data.durationMs, timedOut: data.timedOut
        }));
      } catch (err) {
        console.error('[Agent] Audit log error:', err.message);
      }

      // Relay to IT dashboard
      emitToScoped(itNs, db, deviceId, 'installer_result', {
        deviceId,
        requestId: data.requestId,
        success: data.success,
        output: data.output || '',
        errorOutput: data.errorOutput || '',
        exitCode: data.exitCode,
        durationMs: data.durationMs,
        timedOut: data.timedOut || false,
        validationError: data.validationError || null
      });

      // Check if this is a deployment result
      if (data.requestId && data.requestId.startsWith('dep-')) {
        deploymentScheduler.handleDeploymentResult(db, io, data.requestId, data);
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Agent] Device disconnected: ${deviceId}`);
      connectedDevices.delete(deviceId);
      chatRateLimiter.delete(deviceId);
      diagnosticBuffers.delete(deviceId);
      pendingAIDiagnostics.delete(deviceId);
      pendingAIScripts.delete(deviceId);

      try {
        db.prepare('UPDATE devices SET status = ?, last_seen = datetime(\'now\') WHERE device_id = ?')
          .run('offline', deviceId);
      } catch (err) {
        console.error('[Agent] DB error on disconnect:', err.message);
      }

      // Notify IT namespace
      emitToScoped(itNs, db, deviceId, 'device_status_changed', {
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
          emitToScoped(itNs, db, device.device_id, 'new_alert', { alert, hostname: device.hostname || device.device_id });
          emitToScoped(itNs, db, device.device_id, 'device_status_changed', { deviceId: device.device_id, status: 'offline' });

          if (notificationService) {
            notificationService.dispatchAlert(alert, device).catch(err => {
              console.error('[Agent] Uptime notification error:', err.message);
            });
          }

          emitToAll(itNs, 'alert_stats_updated', alertService.getStats());
        }
      }
    } catch (err) {
      console.error('[Agent] Uptime check error:', err.message);
    }
  }, 60 * 1000);

  return agentNs;
}

module.exports = { setup };
