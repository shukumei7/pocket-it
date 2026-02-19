const express = require('express');
const { requireIT, requireAdmin } = require('../auth/middleware');
const { resolveClientScope } = require('../auth/clientScope');

const router = express.Router();

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// List clients (admin: all, tech: assigned only)
router.get('/', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  if (req.clientScope.isAdmin) {
    const clients = db.prepare('SELECT * FROM clients ORDER BY name').all();
    res.json(clients);
  } else {
    if (!req.clientScope.clientIds || req.clientScope.clientIds.length === 0) {
      return res.json([]);
    }
    const placeholders = req.clientScope.clientIds.map(() => '?').join(',');
    const clients = db.prepare(`SELECT * FROM clients WHERE id IN (${placeholders}) ORDER BY name`).all(...req.clientScope.clientIds);
    res.json(clients);
  }
});

// Get single client (scope-checked)
router.get('/:id', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  if (!req.clientScope.isAdmin && (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

// Create client (admin only)
router.post('/', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const { name, contact_name, contact_email, notes } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  const slug = slugify(name.trim());
  if (!slug) {
    return res.status(400).json({ error: 'Invalid client name' });
  }
  try {
    const result = db.prepare(
      "INSERT INTO clients (name, slug, contact_name, contact_email, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(name.trim(), slug, contact_name || null, contact_email || null, notes || null);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(client);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Client name or slug already exists' });
    }
    throw err;
  }
});

// Update client (admin only)
router.patch('/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const { name, contact_name, contact_email, notes } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) {
    updates.push('name = ?', 'slug = ?');
    values.push(name.trim(), slugify(name.trim()));
  }
  if (contact_name !== undefined) { updates.push('contact_name = ?'); values.push(contact_name); }
  if (contact_email !== undefined) { updates.push('contact_email = ?'); values.push(contact_email); }
  if (notes !== undefined) { updates.push('notes = ?'); values.push(notes); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(clientId);
  try {
    db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    res.json(client);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Client name or slug already exists' });
    }
    throw err;
  }
});

// Delete client (admin only, fail if has devices)
router.delete('/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const deviceCount = db.prepare('SELECT COUNT(*) as count FROM devices WHERE client_id = ?').get(clientId).count;
  if (deviceCount > 0) {
    return res.status(409).json({ error: `Cannot delete client with ${deviceCount} device(s). Reassign or remove devices first.` });
  }

  try {
    db.prepare('DELETE FROM enrollment_tokens WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM user_client_assignments WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Clients] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete client: ' + err.message });
  }
});

// List assigned users for a client (admin only)
router.get('/:id/users', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, uca.assigned_at
    FROM user_client_assignments uca
    JOIN it_users u ON uca.user_id = u.id
    WHERE uca.client_id = ?
    ORDER BY u.username
  `).all(clientId);
  res.json(users);
});

// Assign user to client (admin only)
router.post('/:id/users', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const user = db.prepare('SELECT id FROM it_users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    db.prepare(
      "INSERT INTO user_client_assignments (user_id, client_id, assigned_at) VALUES (?, ?, datetime('now'))"
    ).run(user_id, clientId);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'User already assigned to this client' });
    }
    throw err;
  }
});

// Unassign user from client (admin only)
router.delete('/:id/users/:userId', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);

  const result = db.prepare('DELETE FROM user_client_assignments WHERE user_id = ? AND client_id = ?').run(userId, clientId);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.json({ success: true });
});

// Per-client installer download (admin only)
// Serves bootstrapper EXE with embedded config, or falls back to ZIP
router.get('/:id/installer', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Check for published client binaries
  const path = require('path');
  const fs = require('fs');
  const publishDir = path.join(__dirname, '..', '..', 'client', 'publish', 'win-x64');
  if (!fs.existsSync(publishDir)) {
    return res.status(503).json({ error: 'Client binaries not built. Run installer/build.bat first.' });
  }

  // Auto-generate an enrollment token for this client
  const { v4: uuidv4 } = require('uuid');
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO enrollment_tokens (token, created_by, expires_at, status, client_id) VALUES (?, ?, ?, 'active', ?)"
  ).run(token, req.user?.username || 'admin', expiresAt, clientId);

  // Determine server URL
  const serverUrl = process.env.POCKET_IT_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  // Check if bootstrapper EXE exists
  const setupExePath = path.join(__dirname, '..', '..', 'installer', 'online', 'PocketIT.Setup', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'PocketIT.Setup.exe');
  if (fs.existsSync(setupExePath)) {
    // Serve bootstrapper EXE with embedded config
    const exeBytes = fs.readFileSync(setupExePath);
    const config = JSON.stringify({ ServerUrl: serverUrl, EnrollmentToken: token });
    const configBytes = Buffer.from(config, 'utf8');
    const lengthBytes = Buffer.alloc(4);
    lengthBytes.writeInt32LE(configBytes.length, 0);
    const magic = Buffer.from('PKIT_CFG', 'ascii');

    const result = Buffer.concat([exeBytes, configBytes, lengthBytes, magic]);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="PocketIT-${client.slug}-setup.exe"`);
    res.setHeader('Content-Length', result.length);
    return res.send(result);
  }

  // Fallback: serve ZIP package (no bootstrapper built)
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 5 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="PocketIT-${client.slug}-setup.zip"`);
  archive.pipe(res);

  // Add all files from publish directory
  const entries = fs.readdirSync(publishDir);
  for (const entry of entries) {
    const fullPath = path.join(publishDir, entry);
    const stat = fs.statSync(fullPath);
    if (entry === 'appsettings.json') continue; // handled below
    if (stat.isDirectory()) {
      archive.directory(fullPath, entry);
    } else {
      archive.file(fullPath, { name: entry });
    }
  }

  // Create patched appsettings.json
  const appsettingsPath = path.join(publishDir, 'appsettings.json');
  let appsettings = {};
  if (fs.existsSync(appsettingsPath)) {
    try {
      appsettings = JSON.parse(fs.readFileSync(appsettingsPath, 'utf8'));
    } catch (e) { /* use empty */ }
  }
  appsettings.Server = { Url: serverUrl };
  appsettings.Enrollment = { Token: token };
  if (!appsettings.Database) appsettings.Database = { Path: 'pocket-it.db' };
  if (!appsettings.Monitoring) appsettings.Monitoring = { IntervalMinutes: 15 };

  archive.append(JSON.stringify(appsettings, null, 2), { name: 'appsettings.json' });

  await archive.finalize();
});

module.exports = router;
