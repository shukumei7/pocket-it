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
    db.prepare('DELETE FROM client_notes WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM client_custom_fields WHERE client_id = ?').run(clientId);
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

// === Client Notes ===

// List notes for a client (newest first, max 50)
router.get('/:id/notes', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  if (!req.clientScope.isAdmin && (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const notes = db.prepare('SELECT * FROM client_notes WHERE client_id = ? ORDER BY created_at DESC LIMIT 50').all(clientId);
  res.json(notes);
});

// Add note to client
router.post('/:id/notes', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  if (!req.clientScope.isAdmin && (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Note content is required' });
  if (content.length > 5000) return res.status(400).json({ error: 'Note too long (max 5000 chars)' });
  const author = req.user?.username || 'system';
  const result = db.prepare("INSERT INTO client_notes (client_id, author, content, created_at) VALUES (?, ?, ?, datetime('now'))").run(clientId, author, content.trim());
  const note = db.prepare('SELECT * FROM client_notes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(note);
});

// Delete note
router.delete('/:id/notes/:noteId', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  if (!req.clientScope.isAdmin && (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const noteId = parseInt(req.params.noteId);
  const note = db.prepare('SELECT * FROM client_notes WHERE id = ? AND client_id = ?').get(noteId, clientId);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  db.prepare('DELETE FROM client_notes WHERE id = ?').run(noteId);
  res.json({ success: true });
});

// === Client Custom Fields ===

// Get all custom fields for a client
router.get('/:id/custom-fields', requireIT, resolveClientScope, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  if (!req.clientScope.isAdmin && (!req.clientScope.clientIds || !req.clientScope.clientIds.includes(clientId))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const fields = db.prepare('SELECT * FROM client_custom_fields WHERE client_id = ? ORDER BY field_name ASC').all(clientId);
  res.json(fields);
});

// Upsert custom fields (batch)
router.put('/:id/custom-fields', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { fields } = req.body;
  if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields object is required' });
  const author = req.user?.username || 'admin';
  const upsert = db.prepare("INSERT INTO client_custom_fields (client_id, field_name, field_value, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?) ON CONFLICT(client_id, field_name) DO UPDATE SET field_value = excluded.field_value, updated_at = excluded.updated_at, updated_by = excluded.updated_by");
  const runAll = db.transaction(() => {
    for (const [name, value] of Object.entries(fields)) {
      if (!name || name.length > 100) continue;
      const val = value !== null && value !== undefined ? String(value).slice(0, 2000) : '';
      upsert.run(clientId, name, val, author);
    }
  });
  runAll();
  const updated = db.prepare('SELECT * FROM client_custom_fields WHERE client_id = ? ORDER BY field_name ASC').all(clientId);
  res.json(updated);
});

// Delete a custom field
router.delete('/:id/custom-fields/:fieldName', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const fieldName = decodeURIComponent(req.params.fieldName);
  const result = db.prepare('DELETE FROM client_custom_fields WHERE client_id = ? AND field_name = ?').run(clientId, fieldName);
  if (result.changes === 0) return res.status(404).json({ error: 'Field not found' });
  res.json({ success: true });
});

// Per-client installer download (admin only)
// Serves bootstrapper EXE with embedded config, or falls back to ZIP
router.get('/:id/installer', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const clientId = parseInt(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const path = require('path');
  const fs = require('fs');

  // Resolve paths — Docker mounts releases/ and installer/ at /app/
  const PROJECT_ROOT = path.join(__dirname, '..', '..');
  const publishDir = path.join(PROJECT_ROOT, 'client', 'publish', 'win-x64');
  const releaseZip = path.join(PROJECT_ROOT, 'releases', 'PocketIT-latest.zip');
  const setupExePath = path.join(PROJECT_ROOT, 'installer', 'online', 'PocketIT.Setup', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'PocketIT.Setup.exe');

  // Need either publish dir (local) or release ZIP (Docker/remote)
  const hasPublishDir = fs.existsSync(publishDir);
  const hasReleaseZip = fs.existsSync(releaseZip) && fs.statSync(releaseZip).size > 1000;
  if (!hasPublishDir && !hasReleaseZip) {
    return res.status(503).json({ error: 'Client binaries not available. Build the client or place PocketIT-latest.zip in releases/.' });
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

  // Check if bootstrapper EXE exists — serve with embedded config
  if (fs.existsSync(setupExePath)) {
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

  // Fallback: serve ZIP with patched appsettings.json
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 5 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="PocketIT-${client.slug}-setup.zip"`);
  archive.pipe(res);

  if (hasPublishDir) {
    // Local dev: use publish directory directly
    const entries = fs.readdirSync(publishDir);
    for (const entry of entries) {
      const fullPath = path.join(publishDir, entry);
      const stat = fs.statSync(fullPath);
      if (entry === 'appsettings.json') continue; // patched below
      if (stat.isDirectory()) {
        archive.directory(fullPath, entry);
      } else {
        archive.file(fullPath, { name: entry });
      }
    }

    // Patch appsettings.json from publish dir
    const appsettingsPath = path.join(publishDir, 'appsettings.json');
    let appsettings = {};
    if (fs.existsSync(appsettingsPath)) {
      try { appsettings = JSON.parse(fs.readFileSync(appsettingsPath, 'utf8')); } catch (e) { /* use empty */ }
    }
    appsettings.Server = { Url: serverUrl };
    appsettings.Enrollment = { Token: token };
    if (!appsettings.Database) appsettings.Database = { Path: 'pocket-it.db' };
    if (!appsettings.Monitoring) appsettings.Monitoring = { IntervalMinutes: 15 };
    archive.append(JSON.stringify(appsettings, null, 2), { name: 'appsettings.json' });
  } else {
    // Docker/remote: repackage release ZIP with patched appsettings
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(releaseZip);
    const zipEntries = zip.getEntries();
    let appsettings = {};

    for (const entry of zipEntries) {
      if (entry.entryName === 'appsettings.json') {
        try { appsettings = JSON.parse(entry.getData().toString('utf8')); } catch (e) { /* use empty */ }
        continue; // patched below
      }
      if (entry.isDirectory) {
        continue; // archiver handles directories implicitly
      }
      archive.append(entry.getData(), { name: entry.entryName });
    }

    appsettings.Server = { Url: serverUrl };
    appsettings.Enrollment = { Token: token };
    if (!appsettings.Database) appsettings.Database = { Path: 'pocket-it.db' };
    if (!appsettings.Monitoring) appsettings.Monitoring = { IntervalMinutes: 15 };
    archive.append(JSON.stringify(appsettings, null, 2), { name: 'appsettings.json' });
  }

  await archive.finalize();
});

module.exports = router;
