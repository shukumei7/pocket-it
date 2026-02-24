const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// GET /api/installer/package?token=<enrollment-token>
// Downloads client binaries ZIP (used by the online installer bootstrapper)
// Validates token but does NOT consume it — enrollment happens when client starts
router.get('/package', async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  const db = req.app.locals.db;
  const tokenRow = db.prepare(
    "SELECT * FROM enrollment_tokens WHERE token = ? AND status = 'active'"
  ).get(token);

  if (!tokenRow) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Check for published client binaries or release ZIP
  const publishDir = path.join(__dirname, '..', '..', 'client', 'publish', 'win-x64');
  const releaseZip = path.join(__dirname, '..', '..', 'releases', 'PocketIT-latest.zip');
  const hasPublishDir = fs.existsSync(publishDir);
  const hasReleaseZip = fs.existsSync(releaseZip) && fs.statSync(releaseZip).size > 1000;

  if (!hasPublishDir && !hasReleaseZip) {
    return res.status(503).json({ error: 'Client binaries not built. Run installer/build.bat first.' });
  }

  // Serve ZIP of client binaries (without appsettings.json — the bootstrapper writes its own)
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 5 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="pocket-it-client.zip"');
  archive.pipe(res);

  if (hasPublishDir) {
    const entries = fs.readdirSync(publishDir);
    for (const entry of entries) {
      if (entry === 'appsettings.json') continue; // bootstrapper writes its own
      const fullPath = path.join(publishDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        archive.directory(fullPath, entry);
      } else {
        archive.file(fullPath, { name: entry });
      }
    }
  } else {
    // Docker/remote: serve from release ZIP, stripping appsettings.json (bootstrapper writes its own)
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(releaseZip);
    for (const entry of zip.getEntries()) {
      if (entry.entryName === 'appsettings.json' || entry.isDirectory) continue;
      archive.append(entry.getData(), { name: entry.entryName });
    }
  }

  await archive.finalize();
});

module.exports = router;
