const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireIT, requireDevice, isLocalhost } = require('../auth/middleware');
const { checkForUpdates, applyUpdate, checkClientRelease, getServerVersion, getCurrentCommit } = require('../services/serverUpdate');

const router = express.Router();

const IS_DOCKER = process.env.POCKET_IT_DOCKER === 'true';

// Store uploads in server/updates/
const uploadsDir = path.join(__dirname, '..', 'updates');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure releases/ directory exists (at project root for git tracking)
const releasesDir = path.join(__dirname, '..', '..', 'releases');
if (!fs.existsSync(releasesDir)) {
  fs.mkdirSync(releasesDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Only .zip files are allowed'));
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
    const filename = `PocketIT-${version}.zip`;
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

// POST /api/updates/publish-local — auto-register from build output (localhost only)
router.post('/publish-local', async (req, res) => {
  if (IS_DOCKER) {
    return res.status(501).json({ error: 'Local publishing is not available in Docker mode. Upload client builds via the upload endpoint.' });
  }
  // Localhost only
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'Localhost only' });
  }

  try {
    const archiver = require('archiver');
    const db = req.app.locals.db;

    const publishDir = path.join(__dirname, '..', '..', 'client', 'publish', 'win-x64');
    if (!fs.existsSync(publishDir)) {
      return res.status(404).json({ error: 'Publish directory not found. Run dotnet publish first.' });
    }

    // Read version from csproj
    const csprojPath = path.join(__dirname, '..', '..', 'client', 'PocketIT', 'PocketIT.csproj');
    const csprojContent = fs.readFileSync(csprojPath, 'utf8');
    const versionMatch = csprojContent.match(/<Version>(\d+\.\d+\.\d+)<\/Version>/);
    if (!versionMatch) {
      return res.status(400).json({ error: 'Could not read version from PocketIT.csproj' });
    }
    const version = versionMatch[1];

    const filename = `PocketIT-${version}.zip`;
    const destPath = path.join(uploadsDir, filename);

    // Create ZIP from publish directory
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(publishDir, false);
      archive.finalize();
    });

    // Compute SHA-256
    const fileBuffer = fs.readFileSync(destPath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const fileSize = fileBuffer.length;

    // Upsert into DB (delete + insert to allow rebuilds of same version)
    const existing = db.prepare('SELECT id FROM update_packages WHERE version = ?').get(version);
    if (existing) {
      db.prepare('DELETE FROM update_packages WHERE version = ?').run(version);
    }

    db.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes, uploaded_by, exe_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(version, filename, fileSize, sha256, 'Auto-published from build', 'build-script', null);

    // Audit log
    try {
      db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run('build-script', 'update_published', version, JSON.stringify({ filename, fileSize, sha256 }));
    } catch (err) {
      console.error('[Updates] Audit log error:', err.message);
    }

    // Copy to releases/ for git tracking
    try {
      const releasesZipPath = path.join(releasesDir, 'PocketIT-latest.zip');
      fs.copyFileSync(destPath, releasesZipPath);

      const versionJson = {
        version,
        sha256,
        fileSize,
        publishedAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(releasesDir, 'version.json'), JSON.stringify(versionJson, null, 2) + '\n');
      console.log(`[Updates] Release files updated for v${version}`);
    } catch (releaseErr) {
      console.error('[Updates] Failed to copy to releases/:', releaseErr.message);
    }

    // Push update_available to all outdated connected devices
    let notified = 0;
    const connectedDevices = req.app.locals.connectedDevices;
    if (connectedDevices) {
      for (const [deviceId, socket] of connectedDevices) {
        const device = db.prepare('SELECT client_version FROM devices WHERE device_id = ?').get(deviceId);
        if (!device || !device.client_version || isNewerVersion(version, device.client_version)) {
          socket.emit('update_available', { version });
          notified++;
        }
      }
    }

    console.log(`[Updates] Auto-published v${version} (${fileSize} bytes, SHA-256: ${sha256.substring(0, 16)}...), notified ${notified} devices`);
    res.json({ success: true, version, filename, sha256, fileSize, notified });
  } catch (err) {
    console.error('[Updates] Publish-local error:', err.message);
    res.status(500).json({ error: 'Publish failed: ' + err.message });
  }
});

// GET /api/updates/client-check — check git for new client release (IT auth)
router.get('/client-check', requireIT, async (req, res) => {
  if (IS_DOCKER) {
    return res.status(501).json({ error: 'Git-based client release check is not available in Docker mode. Upload client builds via the upload endpoint.' });
  }
  try {
    const db = req.app.locals.db;
    const result = await checkClientRelease(db);

    if (result.updated) {
      const pushFn = req.app.locals.pushUpdateToOutdatedDevices;
      if (pushFn) {
        result.notified = pushFn(result.version);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[Updates] Client check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/updates/server-check — check if server updates available via git (IT auth)
router.get('/server-check', requireIT, async (req, res) => {
  if (IS_DOCKER) {
    return res.status(501).json({ error: 'Server update check is not available in Docker mode. Update by pulling a new container image.' });
  }
  try {
    const result = await checkForUpdates();
    result.serverVersion = getServerVersion();
    res.json(result);
  } catch (err) {
    console.error('[Updates] Server check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/updates/server-apply — pull server update from git (IT auth)
router.post('/server-apply', requireIT, async (req, res) => {
  if (IS_DOCKER) {
    return res.status(501).json({ error: 'Server self-update is not available in Docker mode. Update by pulling a new container image.' });
  }
  try {
    const db = req.app.locals.db;
    const io = req.app.locals.io;
    const result = await applyUpdate(db, io);

    // Audit log
    try {
      const actor = req.user?.username || 'localhost';
      db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run(actor, 'server_updated', 'server', JSON.stringify(result));
    } catch (logErr) {
      console.error('[Updates] Audit log error:', logErr.message);
    }

    res.json(result);
  } catch (err) {
    console.error('[Updates] Server apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
