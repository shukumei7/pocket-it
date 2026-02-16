const { verifyToken } = require('../auth/userAuth');
const jwt = require('jsonwebtoken');

function setup(io, app) {
  const itNs = io.of('/it');

  // Store which devices each IT user is watching
  const watchers = new Map(); // socketId → Set of deviceIds

  itNs.on('connection', (socket) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    // Verify JWT (skip for localhost in MVP)
    const ip = socket.handshake.address;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

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
        jwt.verify(token, secret);
      } catch (err) {
        socket.disconnect();
        return;
      }
    }

    console.log(`[IT] Dashboard connected: ${socket.id}`);
    watchers.set(socket.id, new Set());

    // Watch a specific device (subscribe to its events)
    socket.on('watch_device', (data) => {
      const deviceId = data.deviceId;
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
            'SELECT * FROM chat_messages WHERE device_id = ? ORDER BY created_at DESC LIMIT 50'
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
    });

    // Request diagnostic from device
    socket.on('request_diagnostic', (data) => {
      const { deviceId, checkType } = data;
      console.log(`[IT] Requesting diagnostic ${checkType} from ${deviceId}`);

      const connectedDevices = app.locals.connectedDevices;
      if (connectedDevices) {
        const deviceSocket = connectedDevices.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('diagnostic_request', {
            checkType: checkType || 'all',
            requestId: Date.now().toString()
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
      console.log(`[IT] File browse request for ${deviceId}: ${browsePath}`);

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
            path: browsePath
          });
          socket.emit('file_browse_requested', { deviceId, requestId, path: browsePath });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('request_file_read', (data) => {
      const { deviceId, path: filePath } = data;
      console.log(`[IT] File read request for ${deviceId}: ${filePath}`);

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
            path: filePath
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
      console.log(`[IT] Script execution request for ${deviceId}: ${scriptName || 'ad-hoc'}`);

      try {
        const db = app.locals.db;
        db.prepare(
          "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
        ).run('it_staff', 'script_requested', deviceId, JSON.stringify({
          scriptName: scriptName || 'ad-hoc',
          scriptLength: (scriptContent || '').length,
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
            timeoutSeconds: timeoutSeconds || 60
          });
          socket.emit('script_requested', { deviceId, requestId, scriptName });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('execute_library_script', (data) => {
      const { deviceId, scriptId } = data;
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
            timeoutSeconds: script.timeout_seconds || 60
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
          deviceSocket.emit('terminal_start_request', { requestId });
          socket.emit('terminal_requested', { deviceId, requestId });
        } else {
          socket.emit('error_message', { message: 'Device is not connected' });
        }
      }
    });

    socket.on('terminal_input', (data) => {
      const { deviceId, input } = data;

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

    socket.on('disconnect', () => {
      console.log(`[IT] Dashboard disconnected: ${socket.id}`);
      watchers.delete(socket.id);
    });
  });

  return itNs;
}

module.exports = { setup };
