const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireIT, requireDevice, isLocalhost } = require('../auth/middleware');

const router = express.Router();

// Store uploads in server/updates/
const uploadsDir = path.join(__dirname, '..', 'updates');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.exe') {
      return cb(new Error('Only .exe files are allowed'));
    }
    cb(null, true);
  }
});

// POST /api/updates/upload — admin uploads an installer
// Auth: requireIT (admin or localhost)
router.post('/upload', requireIT, upload.single('installer'), (req, res) => {
  try {
    const { version, release_notes } = req.body;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      // Clean up uploaded file
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Valid version (X.Y.Z) is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Installer file is required' });
    }

    const db = req.app.locals.db;

    // Check if version already exists
    const existing = db.prepare('SELECT id FROM update_packages WHERE version = ?').get(version);
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ error: `Version ${version} already exists` });
    }

    // Compute SHA-256
    const fileBuffer = fs.readFileSync(req.file.path);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Rename to proper filename
    const filename = `PocketIT-${version}-setup.exe`;
    const finalPath = path.join(uploadsDir, filename);
    fs.renameSync(req.file.path, finalPath);

    // Compute EXE hash from publish directory (if available)
    let exeHash = req.body.exe_hash || null;
    if (!exeHash) {
      const publishExe = path.join(__dirname, '..', '..', 'client', 'publish', 'win-x64', 'PocketIT.exe');
      if (fs.existsSync(publishExe)) {
        const exeBuffer = fs.readFileSync(publishExe);
        exeHash = crypto.createHash('sha256').update(exeBuffer).digest('hex');
      }
    }

    // Insert into DB
    const uploadedBy = req.user?.username || 'localhost';
    db.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes, uploaded_by, exe_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(version, filename, req.file.size, sha256, release_notes || null, uploadedBy, exeHash);

    // Audit log
    try {
      db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run(uploadedBy, 'update_uploaded', version, JSON.stringify({ filename, fileSize: req.file.size, sha256 }));
    } catch (err) {
      console.error('[Updates] Audit log error:', err.message);
    }

    res.json({ success: true, version, filename, sha256, fileSize: req.file.size });
  } catch (err) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('[Updates] Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/updates/latest — latest version info (any authenticated request)
router.get('/latest', (req, res) => {
  const db = req.app.locals.db;
  const latest = db.prepare(
    'SELECT version, filename, file_size, sha256, release_notes, created_at FROM update_packages ORDER BY created_at DESC LIMIT 1'
  ).get();

  if (!latest) {
    return res.json({ available: false });
  }

  res.json({
    available: true,
    version: latest.version,
    filename: latest.filename,
    fileSize: latest.file_size,
    sha256: latest.sha256,
    releaseNotes: latest.release_notes,
    uploadedAt: latest.created_at
  });
});

// GET /api/updates — list all uploaded versions (admin)
router.get('/', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const packages = db.prepare(
    'SELECT id, version, filename, file_size, sha256, release_notes, uploaded_by, created_at FROM update_packages ORDER BY created_at DESC'
  ).all();
  res.json(packages);
});

// DELETE /api/updates/:version — delete an update package (admin)
router.delete('/:version', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { version } = req.params;

  const pkg = db.prepare('SELECT filename FROM update_packages WHERE version = ?').get(version);
  if (!pkg) {
    return res.status(404).json({ error: 'Version not found' });
  }

  // Delete file
  const filePath = path.join(uploadsDir, pkg.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Delete from DB
  db.prepare('DELETE FROM update_packages WHERE version = ?').run(version);

  // Audit log
  try {
    const actor = req.user?.username || 'localhost';
    db.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(actor, 'update_deleted', version, JSON.stringify({ filename: pkg.filename }));
  } catch (err) {
    console.error('[Updates] Audit log error:', err.message);
  }

  res.json({ success: true });
});

// POST /api/updates/push/:version — notify all outdated online devices (admin)
router.post('/push/:version', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const { version } = req.params;

  const pkg = db.prepare('SELECT version FROM update_packages WHERE version = ?').get(version);
  if (!pkg) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const connectedDevices = req.app.locals.connectedDevices;
  if (!connectedDevices) {
    return res.json({ success: true, notified: 0 });
  }

  let notified = 0;
  for (const [deviceId, socket] of connectedDevices) {
    // Get device's current version
    const device = db.prepare('SELECT client_version FROM devices WHERE device_id = ?').get(deviceId);
    if (!device || !device.client_version || isNewerVersion(version, device.client_version)) {
      socket.emit('update_available', { version });
      notified++;
    }
  }

  // Audit log
  try {
    const actor = req.user?.username || 'localhost';
    db.prepare(
      "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(actor, 'update_pushed', version, JSON.stringify({ notified }));
  } catch (err) {
    console.error('[Updates] Audit log error:', err.message);
  }

  res.json({ success: true, notified });
});

// Helper: compare semver strings (returns true if a > b)
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// GET /api/updates/check?version=X.Y.Z — check if update is available (device auth)
router.get('/check', requireDevice, (req, res) => {
  const currentVersion = req.query.version;
  if (!currentVersion) {
    return res.status(400).json({ error: 'version query parameter required' });
  }

  const db = req.app.locals.db;
  const latest = db.prepare(
    'SELECT version, filename, file_size, sha256, release_notes FROM update_packages ORDER BY created_at DESC LIMIT 1'
  ).get();

  if (!latest || !isNewerVersion(latest.version, currentVersion)) {
    return res.json({ updateAvailable: false, currentVersion });
  }

  res.json({
    updateAvailable: true,
    currentVersion,
    latestVersion: latest.version,
    downloadUrl: `/api/updates/download/${latest.version}`,
    sha256: latest.sha256,
    fileSize: latest.file_size,
    releaseNotes: latest.release_notes
  });
});

// GET /api/updates/download/:version — download installer (device auth)
router.get('/download/:version', requireDevice, (req, res) => {
  const db = req.app.locals.db;
  const { version } = req.params;

  const pkg = db.prepare('SELECT filename, file_size FROM update_packages WHERE version = ?').get(version);
  if (!pkg) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const filePath = path.join(uploadsDir, pkg.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Installer file not found' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}"`);
  res.setHeader('Content-Length', pkg.file_size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// GET /api/updates/fleet-versions — version distribution across fleet (admin)
router.get('/fleet-versions', requireIT, (req, res) => {
  const db = req.app.locals.db;
  const versions = db.prepare(
    "SELECT COALESCE(client_version, 'Unknown') as version, COUNT(*) as count FROM devices GROUP BY client_version ORDER BY count DESC"
  ).all();
  res.json(versions);
});

module.exports = router;
