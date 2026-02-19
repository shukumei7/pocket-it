const { verifyToken } = require('../auth/userAuth');
const jwt = require('jsonwebtoken');
const { emitToScoped } = require('./scopedEmit');

// Rate limiter for sensitive operations
const opRateLimits = new Map(); // key: `${socketId}:${eventType}` → { count, resetTime }

function checkOpRateLimit(socketId, eventType, maxPerMin) {
  const key = `${socketId}:${eventType}`;
  const now = Date.now();
  const entry = opRateLimits.get(key) || { count: 0, resetTime: now + 60000 };
  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + 60000;
  }
  entry.count++;
  opRateLimits.set(key, entry);
  return entry.count <= maxPerMin;
}

// Tool whitelist and parameter validation
const VALID_TOOLS = ['process_list', 'process_kill', 'service_list', 'service_action', 'event_log_query'];

function validateToolParams(tool, params) {
  switch (tool) {
    case 'process_list':
      return { valid: true };
    case 'process_kill': {
      const pid = parseInt(params?.pid, 10);
      if (!Number.isInteger(pid) || pid <= 0) return { valid: false, reason: 'pid must be a positive integer' };
      return { valid: true };
    }
    case 'service_list': {
      const validFilters = ['all', 'running', 'stopped'];
      if (params?.filter && !validFilters.includes(params.filter)) return { valid: false, reason: `filter must be one of: ${validFilters.join(', ')}` };
      return { valid: true };
    }
    case 'service_action': {
      const namePattern = /^[a-zA-Z0-9_\-\.]{1,256}$/;
      if (!params?.serviceName || !namePattern.test(params.serviceName)) return { valid: false, reason: 'serviceName must be alphanumeric/underscores/hyphens/dots, max 256 chars' };
      const validActions = ['start', 'stop', 'restart'];
      if (!validActions.includes(params?.action)) return { valid: false, reason: `action must be one of: ${validActions.join(', ')}` };
      return { valid: true };
    }
    case 'event_log_query': {
      const validLogs = ['System', 'Application', 'Security', 'Setup'];
      if (params?.logName && !validLogs.includes(params.logName)) return { valid: false, reason: `logName must be one of: ${validLogs.join(', ')}` };
      return { valid: true };
    }
    default:
      return { valid: false, reason: 'Unknown tool' };
  }
}

function setup(io, app) {
  const itNs = io.of('/it');

  // Store which devices each IT user is watching
  const watchers = new Map(); // socketId → Set of deviceIds

  itNs.on('connection', (socket) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    // Verify JWT (skip for localhost in MVP)
    const ip = socket.handshake.address;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

    let decoded = null;
    if (!isLocal) {
      if (!token) {
        socket.disconnect();
        return;
      }
      try {
        const secret = process.env.POCKET_IT_JWT_SECRET;
        if (!secret) {
          console.error('[IT] JWT secret not configured, rejecting remote connection');
          socket.disconnect();
          return;
        }
        decoded = jwt.verify(token, secret);
      } catch (err) {
        socket.disconnect();
        return;
      }
    } else if (token) {
      // Local connection with token — try to decode for scope
      try {
        const secret = process.env.POCKET_IT_JWT_SECRET;
        if (secret) decoded = jwt.verify(token, secret);
      } catch (err) { /* ignore, treat as admin */ }
    }

    // Resolve client scope for this socket
    const db = app.locals.db;
    if (isLocal || (decoded && decoded.role === 'admin')) {
      socket.userScope = { isAdmin: true, clientIds: null };
    } else if (decoded && decoded.id) {
      const assignments = db.prepare(
        'SELECT client_id FROM user_client_assignments WHERE user_id = ?'
      ).all(decoded.id);
      socket.userScope = { isAdmin: false, clientIds: assignments.map(a => a.client_id) };
    } else {
      socket.userScope = { isAdmin: true, clientIds: null }; // fallback for localhost without token
    }

    console.log(`[IT] Dashboard connected: ${socket.id}`);
    watchers.set(socket.id, new Set());

    // Scope check helper — avoids inline require in every handler
    function checkDeviceScope(deviceId) {
      if (!socket.userScope || socket.userScope.isAdmin) return true;
      if (!socket.userScope.clientIds || socket.userScope.clientIds.length === 0) return false;
      const dev = db.prepare('SELECT client_id FROM devices WHERE device_id = ?').get(deviceId);
      if (!dev) return false;
      return socket.userScope.clientIds.includes(dev.client_id);
    }

    // Watch a specific device (subscribe to its events)
    socket.on('watch_device', (data) => {
      const deviceId = data.deviceId;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      const watched = watchers.get(socket.id);
      if (watched) {
        watched.add(deviceId);
        console.log(`[IT] ${socket.id} watching device ${deviceId}`);

        // Send current device status
        const db = app.locals.db;
        try {
          const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
          if (device) {
            socket.emit('device_status', device);
          }
          // Send recent chat
          const messages = db.prepare(
            "SELECT * FROM chat_messages WHERE device_id = ? AND (channel = 'user' OR channel IS NULL) ORDER BY id DESC LIMIT 50"
          ).all(deviceId).reverse();
          socket.emit('device_chat_history', { deviceId, messages });
        } catch (err) {
          console.error('[IT] Watch device error:', err.message);
        }
      }
    });

    // Unwatch device
    socket.on('unwatch_device', (data) => {
      const watched = watchers.get(socket.id);
      if (watched) watched.delete(data.deviceId);
    });

    // IT tech sends chat message to device user
    socket.on('chat_to_device', (data) => {
      const { deviceId, content } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Chat to device ${deviceId}: ${content.substring(0, 50)}...`);

      const db = app.locals.db;

      // Save to DB
      try {
        db.prepare(
          'INSERT INTO chat_messages (device_id, sender, content, message_type) VALUES (?, ?, ?, ?)'
        ).run(deviceId, 'it_tech', content, 'text');
      } catch (err) {
        console.error('[IT] Chat save error:', err.message);
      }

      // Relay to device via /agent namespace
      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('chat_response', {
            text: content,
            sender: 'it_tech',
            action: null
          });
        }
      }

      // Notify IT dashboard watchers so the sent message appears in Live Chat
      emitToScoped(itNs, db, deviceId, 'device_chat_update', {
        deviceId,
        message: { sender: 'it_tech', content }
      });
    });

    // Request diagnostic from device
    socket.on('request_diagnostic', (data) => {
      const { deviceId, checkType } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Requesting diagnostic ${checkType} from ${deviceId}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'diagnostic_requested', deviceId, JSON.stringify({ checkType }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('diagnostic_request', {
            checkType: checkType || 'all',
            requestId: Date.now().toString(),
            itInitiated: true
          });
          socket.emit('diagnostic_requested', { deviceId, checkType });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.5.0: File access requests from IT dashboard
    socket.on('request_file_browse', (data) => {
      const { deviceId, path: browsePath } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] File browse request for ${deviceId}: ${browsePath}`);

      // Rate limit: 30/min
      if (!checkOpRateLimit(socket.id, 'request_file_browse', 30)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file browse (30/min)' });
        return;
      }

      // Audit log
      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_browse_requested', deviceId, JSON.stringify({ path: browsePath }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fb-${Date.now()}`;
          deviceSocket.emit('file_browse_request', {
            requestId,
            path: browsePath,
            itInitiated: true
          });
          socket.emit('file_browse_requested', { deviceId, requestId, path: browsePath });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_read', (data) => {
      const { deviceId, path: filePath } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] File read request for ${deviceId}: ${filePath}`);

      // Rate limit: 20/min
      if (!checkOpRateLimit(socket.id, 'request_file_read', 20)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file read (20/min)' });
        return;
      }

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_read_requested', deviceId, JSON.stringify({ path: filePath }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fr-${Date.now()}`;
          deviceSocket.emit('file_read_request', {
            requestId,
            path: filePath,
            itInitiated: true
          });
          socket.emit('file_read_requested', { deviceId, requestId, path: filePath });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.5.0: Script execution from IT dashboard
    socket.on('execute_script', (data) => {
      const { deviceId, scriptName, scriptContent, requiresElevation, timeoutSeconds } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Script execution request for ${deviceId}: ${scriptName || 'ad-hoc'}`);

      // Rate limit: 5/min
      if (!checkOpRateLimit(socket.id, 'execute_script', 5)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for script execution (5/min)' });
        return;
      }

      // Validate script parameters
      if (!scriptContent || typeof scriptContent !== 'string' || scriptContent.length === 0) {
        socket.emit('error_message', { message: 'Script content is required' });
        return;
      }
      if (scriptContent.length > 50000) {
        socket.emit('error_message', { message: 'Script exceeds maximum length of 50,000 characters' });
        return;
      }
      if (scriptName && scriptName.length > 200) {
        socket.emit('error_message', { message: 'Script name exceeds maximum length of 200 characters' });
        return;
      }
      const clampedTimeout = Math.max(5, Math.min(300, parseInt(timeoutSeconds, 10) || 60));

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'script_requested', deviceId, JSON.stringify({
          scriptName: scriptName || 'ad-hoc',
          scriptLength: scriptContent.length,
          requiresElevation: !!requiresElevation
        }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `sc-${Date.now()}`;
          deviceSocket.emit('script_request', {
            requestId,
            scriptName: scriptName || 'Ad-hoc Script',
            scriptContent,
            requiresElevation: !!requiresElevation,
            timeoutSeconds: clampedTimeout,
            itInitiated: true
          });
          socket.emit('script_requested', { deviceId, requestId, scriptName });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('execute_library_script', (data) => {
      const { deviceId, scriptId } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Library script execution for ${deviceId}: scriptId=${scriptId}`);

      const db = app.locals.db;
      const script = db.prepare('SELECT * FROM script_library WHERE id = ?').get(scriptId);
      if (!script) {
        socket.emit('error_message', { message: 'Script not found in library' });
        return;
      }

      try {
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'script_requested', deviceId, JSON.stringify({
          scriptId, scriptName: script.name, requiresElevation: !!script.requires_elevation
        }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `sc-${Date.now()}`;
          deviceSocket.emit('script_request', {
            requestId,
            scriptName: script.name,
            scriptContent: script.script_content,
            requiresElevation: !!script.requires_elevation,
            timeoutSeconds: script.timeout_seconds || 60,
            itInitiated: true
          });
          socket.emit('script_requested', { deviceId, requestId, scriptName: script.name });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.6.0: Remote terminal
    socket.on('start_terminal', (data) => {
      const { deviceId } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Terminal start request for ${deviceId}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'terminal_requested', deviceId, JSON.stringify({}));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `term-${Date.now()}`;
          deviceSocket.emit('terminal_start_request', { requestId, itInitiated: true });
          socket.emit('terminal_requested', { deviceId, requestId });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('terminal_input', (data) => {
      const { deviceId, input } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('terminal_input', { input });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('stop_terminal', (data) => {
      const { deviceId } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Terminal stop request for ${deviceId}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'terminal_stop_requested', deviceId, JSON.stringify({}));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `term-${Date.now()}`;
          deviceSocket.emit('terminal_stop_request', { requestId });
          socket.emit('terminal_stop_requested', { deviceId, requestId });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.8.0: Remote desktop
    socket.on('start_desktop', (data) => {
      const { deviceId } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Desktop start request for ${deviceId}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'desktop_requested', deviceId, JSON.stringify({}));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `desk-${Date.now()}`;
          deviceSocket.emit('desktop_start_request', { requestId, itInitiated: true });
          socket.emit('desktop_requested', { deviceId, requestId });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('desktop_mouse', (data) => {
      const { deviceId, x, y, button, action } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('desktop_mouse_input', { x, y, button, action });
        }
      }
    });

    socket.on('desktop_keyboard', (data) => {
      const { deviceId, vkCode, action } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('desktop_keyboard_input', { vkCode, action });
        }
      }
    });

    socket.on('desktop_quality', (data) => {
      const { deviceId, quality, fps, scale } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('desktop_quality_update', { quality, fps, scale });
        }
      }
    });

    socket.on('stop_desktop', (data) => {
      const { deviceId } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] Desktop stop request for ${deviceId}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'desktop_stop_requested', deviceId, JSON.stringify({}));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `desk-${Date.now()}`;
          deviceSocket.emit('desktop_stop_request', { requestId });
          socket.emit('desktop_stop_requested', { deviceId, requestId });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.9.0: System tools
    socket.on('system_tool_request', (data) => {
      const { deviceId, requestId, tool, params } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] System tool request for ${deviceId}: ${tool}`);

      // Rate limit: 30/min
      if (!checkOpRateLimit(socket.id, 'system_tool_request', 30)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for system tool requests (30/min)' });
        return;
      }

      // Tool whitelist
      if (!VALID_TOOLS.includes(tool)) {
        console.warn(`[IT] Blocked invalid system tool: ${tool}`);
        socket.emit('error_message', { message: `Invalid tool: ${tool}` });
        return;
      }

      // Parameter validation
      const validation = validateToolParams(tool, params);
      if (!validation.valid) {
        console.warn(`[IT] Blocked system tool ${tool} with invalid params: ${validation.reason}`);
        socket.emit('error_message', { message: `Invalid parameters for ${tool}: ${validation.reason}` });
        return;
      }

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'system_tool_requested', deviceId, JSON.stringify({ tool, requestId }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('system_tool_request', {
            requestId: requestId || `st-${Date.now()}`,
            tool,
            params: params || null
          });
          socket.emit('system_tool_requested', { deviceId, requestId, tool });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // File management operations (IT-initiated, unrestricted)
    socket.on('request_file_delete', (data) => {
      const { deviceId, paths } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      if (!Array.isArray(paths) || paths.length === 0) {
        socket.emit('error_message', { message: 'paths must be a non-empty array' });
        return;
      }

      if (!checkOpRateLimit(socket.id, 'request_file_delete', 20)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file delete (20/min)' });
        return;
      }

      console.log(`[IT] File delete request for ${deviceId}: ${paths.length} paths`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_delete_requested', deviceId, JSON.stringify({ paths }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fd-${Date.now()}`;
          deviceSocket.emit('request_file_delete', { requestId, paths });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_properties', (data) => {
      const { deviceId, path: filePath } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      console.log(`[IT] File properties request for ${deviceId}: ${filePath}`);

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fp-${Date.now()}`;
          deviceSocket.emit('request_file_properties', { requestId, path: filePath });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_paste', (data) => {
      const { deviceId, operation, paths, destination } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      if (!Array.isArray(paths) || paths.length === 0) {
        socket.emit('error_message', { message: 'paths must be a non-empty array' });
        return;
      }

      if (!['copy', 'move'].includes(operation)) {
        socket.emit('error_message', { message: 'operation must be "copy" or "move"' });
        return;
      }

      if (!checkOpRateLimit(socket.id, 'request_file_paste', 20)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file paste (20/min)' });
        return;
      }

      console.log(`[IT] File paste request for ${deviceId}: ${operation} ${paths.length} items to ${destination}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_paste_requested', deviceId, JSON.stringify({ operation, paths, destination }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fp-${Date.now()}`;
          deviceSocket.emit('request_file_paste', { requestId, operation, paths, destination });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_download', (data) => {
      const { deviceId, path: filePath } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      if (!checkOpRateLimit(socket.id, 'request_file_download', 20)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file download (20/min)' });
        return;
      }

      console.log(`[IT] File download request for ${deviceId}: ${filePath}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_download_requested', deviceId, JSON.stringify({ path: filePath }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fdl-${Date.now()}`;
          deviceSocket.emit('request_file_download', { requestId, path: filePath });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_upload', (data) => {
      const { deviceId, destinationPath, filename, data: base64Data, size } = data;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      if (!filename || typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
        socket.emit('error_message', { message: 'Invalid filename' });
        return;
      }

      const MAX_UPLOAD_SIZE = 52_428_800; // 50MB
      if (size && size > MAX_UPLOAD_SIZE) {
        socket.emit('error_message', { message: `File too large. Maximum is 50MB.` });
        return;
      }

      if (!checkOpRateLimit(socket.id, 'request_file_upload', 10)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for file upload (10/min)' });
        return;
      }

      console.log(`[IT] File upload request for ${deviceId}: ${filename} to ${destinationPath}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'file_upload_requested', deviceId, JSON.stringify({ filename, destinationPath, size }));
      } catch (err) {
        console.error('[IT] Audit log error:', err.message);
      }

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          const requestId = `fu-${Date.now()}`;
          deviceSocket.emit('request_file_upload', { requestId, destinationPath, filename, data: base64Data });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    // v0.14.0: Remote Deployment
    socket.on('create_deployment', (data) => {
      const { name, type, scriptId, scriptContent, installerFilename, installerData,
              silentArgs, timeoutSeconds, requiresElevation, targetDeviceIds, scheduledAt } = data || {};

      // Validate
      if (!name || typeof name !== 'string' || name.length > 200) {
        socket.emit('error_message', { message: 'Deployment name is required (max 200 chars)' });
        return;
      }
      if (!['script', 'installer'].includes(type)) {
        socket.emit('error_message', { message: 'Type must be "script" or "installer"' });
        return;
      }
      if (!Array.isArray(targetDeviceIds) || targetDeviceIds.length === 0) {
        socket.emit('error_message', { message: 'At least one target device is required' });
        return;
      }
      if (targetDeviceIds.length > 100) {
        socket.emit('error_message', { message: 'Maximum 100 target devices per deployment' });
        return;
      }

      // Scope check all targets
      for (const did of targetDeviceIds) {
        if (!checkDeviceScope(did)) {
          socket.emit('error_message', { message: `Device ${did} not in your scope` });
          return;
        }
      }

      // Rate limit: 5/min
      if (!checkOpRateLimit(socket.id, 'create_deployment', 5)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for deployments (5/min)' });
        return;
      }

      try {
        const db = app.locals.db;
        let resolvedScriptContent = scriptContent || null;
        let installerBinary = null;

        if (type === 'script') {
          if (scriptId) {
            const script = db.prepare('SELECT * FROM script_library WHERE id = ?').get(scriptId);
            if (!script) {
              socket.emit('error_message', { message: 'Script not found in library' });
              return;
            }
            resolvedScriptContent = script.script_content;
          }
          if (!resolvedScriptContent || resolvedScriptContent.length === 0) {
            socket.emit('error_message', { message: 'Script content is required' });
            return;
          }
        }

        if (type === 'installer') {
          if (!installerFilename || !installerData) {
            socket.emit('error_message', { message: 'Installer file is required' });
            return;
          }
          // Validate extension
          const ext = installerFilename.split('.').pop().toLowerCase();
          if (!['exe', 'msi', 'ps1', 'bat'].includes(ext)) {
            socket.emit('error_message', { message: 'Only .exe, .msi, .ps1, and .bat files are allowed' });
            return;
          }
          // Decode base64 to Buffer for BLOB storage
          installerBinary = Buffer.from(installerData, 'base64');
          // 50MB limit
          if (installerBinary.length > 52_428_800) {
            socket.emit('error_message', { message: 'Installer exceeds 50MB limit' });
            return;
          }
        }

        const clampedTimeout = Math.max(30, Math.min(600, parseInt(timeoutSeconds, 10) || 300));

        // Insert deployment
        const result = db.prepare(
          `INSERT INTO deployments (name, type, script_id, script_content, installer_filename, installer_data, silent_args, timeout_seconds, requires_elevation, target_device_ids, scheduled_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          name, type,
          scriptId || null, resolvedScriptContent,
          installerFilename || null, installerBinary,
          silentArgs || null,
          clampedTimeout,
          requiresElevation ? 1 : 0,
          JSON.stringify(targetDeviceIds),
          scheduledAt || null,
          'it_staff'
        );

        const deploymentId = result.lastInsertRowid;

        // Insert per-device result rows
        const insertResult = db.prepare(
          'INSERT INTO deployment_results (deployment_id, device_id, hostname) VALUES (?, ?, ?)'
        );
        for (const did of targetDeviceIds) {
          const dev = db.prepare('SELECT hostname FROM devices WHERE device_id = ?').get(did);
          insertResult.run(deploymentId, did, dev?.hostname || '');
        }

        // Audit log
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'deployment_created', String(deploymentId), JSON.stringify({
          name, type, targetCount: targetDeviceIds.length, scheduled: !!scheduledAt
        }));

        socket.emit('deployment_created', { deploymentId, name, type, status: scheduledAt ? 'scheduled' : 'dispatching' });

        // Dispatch immediately if no schedule
        if (!scheduledAt || new Date(scheduledAt) <= new Date()) {
          const scheduler = require('../services/deploymentScheduler');
          scheduler.dispatchDeployment(db, app.locals.io, deploymentId);
        }

      } catch (err) {
        console.error('[IT] create_deployment error:', err.message);
        socket.emit('error_message', { message: 'Failed to create deployment: ' + err.message });
      }
    });

    // Get deployment history
    socket.on('get_deployments', () => {
      try {
        const db = app.locals.db;
        const deployments = db.prepare(
          "SELECT id, name, type, target_device_ids, scheduled_at, status, created_by, created_at FROM deployments ORDER BY id DESC LIMIT 50"
        ).all();

        // Get result summaries
        const withResults = deployments.map(d => {
          const results = db.prepare(
            'SELECT device_id, hostname, status, exit_code, output, error_output, duration_ms, timed_out FROM deployment_results WHERE deployment_id = ?'
          ).all(d.id);
          return { ...d, target_device_ids: JSON.parse(d.target_device_ids || '[]'), results };
        });

        socket.emit('deployment_list', { deployments: withResults });
      } catch (err) {
        console.error('[IT] get_deployments error:', err.message);
        socket.emit('deployment_list', { deployments: [] });
      }
    });

    // Cancel a pending/running deployment
    socket.on('cancel_deployment', (data) => {
      const { deploymentId } = data || {};
      if (!deploymentId) return;

      try {
        const db = app.locals.db;
        db.prepare("UPDATE deployments SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'running')").run(deploymentId);
        db.prepare("UPDATE deployment_results SET status = 'skipped', completed_at = datetime('now') WHERE deployment_id = ? AND status IN ('pending', 'uploading')").run(deploymentId);
        socket.emit('deployment_cancelled', { deploymentId });
      } catch (err) {
        console.error('[IT] cancel_deployment error:', err.message);
      }
    });

    // ---- Deployment Templates ----
    socket.on('save_deploy_template', (data) => {
      try {
        const { name, type, scriptId, scriptContent, installerFilename, silentArgs, timeoutSeconds, requiresElevation } = data || {};
        if (!name || !type) {
          socket.emit('deploy_template_error', { error: 'Name and type are required' });
          return;
        }
        if (!['script', 'installer'].includes(type)) {
          socket.emit('deploy_template_error', { error: 'Invalid type' });
          return;
        }

        const result = db.prepare(`
          INSERT INTO deployment_templates (name, type, script_id, script_content, installer_filename, silent_args, timeout_seconds, requires_elevation, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          name, type,
          type === 'script' ? (scriptId || null) : null,
          type === 'script' ? (scriptContent || null) : null,
          type === 'installer' ? (installerFilename || null) : null,
          silentArgs || null,
          timeoutSeconds || 300,
          requiresElevation ? 1 : 0,
          socket.username || 'unknown'
        );

        socket.emit('deploy_template_saved', { id: result.lastInsertRowid, name });
      } catch (err) {
        console.error('[IT] save_deploy_template error:', err.message);
        socket.emit('deploy_template_error', { error: err.message });
      }
    });

    socket.on('get_deploy_templates', () => {
      try {
        const templates = db.prepare('SELECT * FROM deployment_templates ORDER BY name ASC').all();
        socket.emit('deploy_template_list', { templates });
      } catch (err) {
        console.error('[IT] get_deploy_templates error:', err.message);
        socket.emit('deploy_template_list', { templates: [] });
      }
    });

    socket.on('delete_deploy_template', (data) => {
      try {
        const { id } = data || {};
        if (!id) return;
        db.prepare('DELETE FROM deployment_templates WHERE id = ?').run(id);
        socket.emit('deploy_template_deleted', { id });
      } catch (err) {
        console.error('[IT] delete_deploy_template error:', err.message);
      }
    });

    // v0.14.0: IT-to-AI Guidance Chat
    socket.on('it_guidance_message', async (data) => {
      let deviceId;
      try {
      const { deviceId: did, content } = data || {};
      deviceId = did;

      if (!deviceId || !content) {
        socket.emit('error_message', { message: 'deviceId and content are required' });
        return;
      }

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      if (typeof content !== 'string' || content.length > 5000) {
        socket.emit('error_message', { message: 'Message too long (max 5000 chars)' });
        return;
      }

      // Rate limit: 20/min
      if (!checkOpRateLimit(socket.id, 'it_guidance', 20)) {
        socket.emit('error_message', { message: 'Rate limit exceeded for guidance messages (20/min)' });
        return;
      }

      console.log(`[IT] Guidance message for ${deviceId}: ${content.substring(0, 50)}...`);

      const diagnosticAI = app.locals.diagnosticAI;
      if (!diagnosticAI) {
        socket.emit('it_guidance_response', { deviceId, text: 'AI service not available.', action: null });
        return;
      }

        const db = app.locals.db;
        const device = db.prepare('SELECT hostname, os_version, cpu_model, total_ram_gb, total_disk_gb, processor_count FROM devices WHERE device_id = ?').get(deviceId);
        const deviceInfo = device ? {
          hostname: device.hostname, osVersion: device.os_version, deviceId,
          cpuModel: device.cpu_model, totalRamGB: device.total_ram_gb,
          totalDiskGB: device.total_disk_gb, processorCount: device.processor_count
        } : { deviceId };

        const response = await diagnosticAI.processITGuidanceMessage(deviceId, content, deviceInfo);

        // Emit response to the requesting IT socket
        socket.emit('it_guidance_response', {
          deviceId,
          text: response.text,
          agentName: response.agentName,
          action: response.action
        });

        // Also emit to other IT watchers of this device (exclude sender to avoid duplicates)
        emitToScoped(itNs, db, deviceId, 'it_guidance_update', {
          deviceId,
          message: { sender: 'it_tech', content },
          response: { sender: 'ai', text: response.text, action: response.action }
        }, socket.id);

        // If action is diagnose, request from device immediately (no user consent needed)
        if (response.action && response.action.type === 'diagnose') {
          const connectedDevices = app.locals.connectedDevices;
          if (connectedDevices) {
            const deviceSocket = connectedDevices.get(deviceId);
            if (deviceSocket) {
              const requestId = `itg-${Date.now()}`;
              deviceSocket.emit('diagnostic_request', {
                checkType: response.action.checkType,
                requestId,
                itInitiated: true
              });
            }
          }
        }

        // If action is remediate, execute immediately on device (IT authority)
        if (response.action && response.action.type === 'remediate') {
          const VALID_ACTIONS = ['flush_dns', 'clear_temp', 'restart_spooler', 'repair_network', 'clear_browser_cache', 'kill_process', 'restart_service', 'restart_explorer', 'sfc_scan', 'dism_repair', 'clear_update_cache', 'reset_network_adapter'];
          if (VALID_ACTIONS.includes(response.action.actionId)) {
            const connectedDevices = app.locals.connectedDevices;
            if (connectedDevices) {
              const deviceSocket = connectedDevices.get(deviceId);
              if (deviceSocket) {
                deviceSocket.emit('remediation_request', {
                  actionId: response.action.actionId,
                  requestId: `itg-${Date.now()}`,
                  parameter: response.action.parameter || null,
                  autoApprove: true  // IT authority: auto-approve
                });
              }
            }
          }
        }

        // If action is ticket, create it
        if (response.action && response.action.type === 'ticket') {
          try {
            const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
            const ticketTitle = (response.action.title || 'Untitled').replace(/[<>&"']/g, '').substring(0, 200);
            const ticketPriority = VALID_PRIORITIES.includes(response.action.priority) ? response.action.priority : 'medium';

            const ticketResult = db.prepare(
              "INSERT INTO tickets (device_id, title, priority, ai_summary, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
            ).run(deviceId, ticketTitle, ticketPriority, response.text);

            emitToScoped(itNs, db, deviceId, 'ticket_created', {
              id: ticketResult.lastInsertRowid, deviceId, title: ticketTitle, priority: ticketPriority
            });
          } catch (err) {
            console.error('[IT] Guidance ticket creation error:', err.message);
          }
        }

      } catch (err) {
        console.error('[IT] it_guidance_message error:', err.message);
        socket.emit('it_guidance_response', { deviceId: deviceId || null, text: 'Error processing guidance request: ' + err.message, action: null });
      }
    });

    socket.on('get_it_guidance_history', (data) => {
      const { deviceId } = data || {};
      if (!deviceId) return;

      if (!checkDeviceScope(deviceId)) {
        socket.emit('error_message', { message: 'Device not in your scope' });
        return;
      }

      try {
        const db = app.locals.db;
        const messages = db.prepare(
          "SELECT * FROM chat_messages WHERE device_id = ? AND channel = 'it_guidance' ORDER BY id DESC LIMIT 50"
        ).all(deviceId).reverse();
        socket.emit('it_guidance_history', { deviceId, messages });
      } catch (err) {
        console.error('[IT] get_it_guidance_history error:', err.message);
        socket.emit('it_guidance_history', { deviceId, messages: [] });
      }
    });

    socket.on('clear_it_guidance_context', (data) => {
      const { deviceId } = data || {};
      if (!deviceId) return;
      const diagnosticAI = app.locals.diagnosticAI;
      if (diagnosticAI) diagnosticAI.clearITGuidanceContext(deviceId);
      socket.emit('it_guidance_context_cleared', { deviceId });
    });

    // Feature wishlist
    socket.on('get_feature_wishes', (data) => {
      const status = data?.status || null;
      const category = data?.category || null;

      let query = 'SELECT * FROM feature_wishes';
      const conditions = [];
      const params = [];

      if (status) { conditions.push('status = ?'); params.push(status); }
      if (category) { conditions.push('category = ?'); params.push(category); }
      if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
      query += ' ORDER BY vote_count DESC, created_at DESC';

      try {
        const wishes = db.prepare(query).all(...params);
        socket.emit('feature_wishes_list', { wishes });
      } catch (err) {
        console.error('[IT] get_feature_wishes error:', err.message);
        socket.emit('feature_wishes_list', { wishes: [] });
      }
    });

    socket.on('update_feature_wish', (data) => {
      const { id, status } = data || {};
      const VALID_STATUSES = ['pending', 'approved', 'rejected', 'implemented'];
      if (!id || !VALID_STATUSES.includes(status)) return;

      try {
        db.prepare("UPDATE feature_wishes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
        socket.emit('feature_wish_updated', { id, status });

        try {
          db.prepare("INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
            .run('it_tech', 'wish_status_update', String(id), JSON.stringify({ status }));
        } catch (err) {}
      } catch (err) {
        console.error('[IT] update_feature_wish error:', err.message);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[IT] Dashboard disconnected: ${socket.id}`);
      watchers.delete(socket.id);
      // Clean up rate limit entries for this socket
      for (const key of opRateLimits.keys()) {
        if (key.startsWith(`${socket.id}:`)) opRateLimits.delete(key);
      }
    });
  });

  return itNs;
}

module.exports = { setup };
