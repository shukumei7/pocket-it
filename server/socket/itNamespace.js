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

    socket.on('disconnect', () => {
      console.log(`[IT] Dashboard disconnected: ${socket.id}`);
      watchers.delete(socket.id);
    });
  });

  return itNs;
}

module.exports = { setup };
