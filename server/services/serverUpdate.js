const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Project root is 2 levels up from services/
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RELEASES_DIR = path.join(PROJECT_ROOT, 'releases');
const UPDATES_DIR = path.join(__dirname, '..', 'updates');

/**
 * checkForUpdates() — git fetch + compare HEAD vs origin/main
 * Returns: { available, currentCommit, remoteCommit, commitsBehind, summary[] }
 */
async function checkForUpdates() {
  try {
    // git fetch origin main
    execSync('git fetch origin main', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30000 });

    const currentCommit = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
    const remoteCommit = execSync('git rev-parse --short origin/main', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();

    if (currentCommit === remoteCommit) {
      return { available: false, currentCommit, remoteCommit, commitsBehind: 0, summary: [] };
    }

    // Count commits behind
    const behindOutput = execSync('git rev-list --count HEAD..origin/main', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
    const commitsBehind = parseInt(behindOutput, 10) || 0;

    // Get commit summaries
    const logOutput = execSync('git log HEAD..origin/main --oneline --no-decorate', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
    const summary = logOutput ? logOutput.split('\n').map(line => line.trim()).filter(Boolean) : [];

    return { available: commitsBehind > 0, currentCommit, remoteCommit, commitsBehind, summary };
  } catch (err) {
    console.error('[ServerUpdate] Check failed:', err.message);
    throw new Error('Failed to check for updates: ' + err.message);
  }
}

/**
 * applyUpdate(db, io) — git pull + npm install + register ZIP + restart
 * Emits 'server_update_progress' events on the /it namespace for real-time UI
 * Exits with code 75 to signal wrapper.js to restart
 */
async function applyUpdate(db, io) {
  const itNs = io ? io.of('/it') : null;
  const emit = (step, status, detail) => {
    if (itNs) itNs.emit('server_update_progress', { step, status, detail });
    console.log(`[ServerUpdate] ${step}: ${status}${detail ? ' — ' + detail : ''}`);
  };

  try {
    // Step 1: git pull
    emit('pull', 'in_progress', 'Pulling latest changes...');
    const pullOutput = execSync('git pull origin main', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 }).toString().trim();
    emit('pull', 'done', pullOutput);

    // Step 2: npm install (only if package.json changed in the pull)
    emit('install', 'in_progress', 'Checking dependencies...');
    try {
      const changedFiles = execSync('git diff HEAD~1 --name-only', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString();
      if (changedFiles.includes('package.json') || changedFiles.includes('package-lock.json')) {
        execSync('npm install --production', { cwd: path.join(PROJECT_ROOT, 'server'), stdio: 'pipe', timeout: 120000 });
        emit('install', 'done', 'Dependencies updated');
      } else {
        emit('install', 'done', 'No dependency changes');
      }
    } catch (installErr) {
      emit('install', 'warning', 'npm install had issues: ' + installErr.message);
    }

    // Step 3: Register release ZIP if present
    emit('register', 'in_progress', 'Checking for client release...');
    const regResult = await registerReleaseZip(db);
    if (regResult.registered) {
      emit('register', 'done', `Registered client v${regResult.version}`);

      // Push update_available to outdated clients
      const connectedDevices = io._connectedDevices;
      if (connectedDevices) {
        for (const [deviceId, socket] of connectedDevices) {
          const device = db.prepare('SELECT client_version FROM devices WHERE device_id = ?').get(deviceId);
          if (!device || !device.client_version || isNewerVersion(regResult.version, device.client_version)) {
            socket.emit('update_available', { version: regResult.version });
          }
        }
      }
    } else {
      emit('register', 'done', regResult.reason || 'No new client release');
    }

    // Step 4: Schedule restart
    emit('restart', 'in_progress', 'Server restarting...');

    // Give time for the response to be sent and socket events to flush
    setTimeout(() => {
      process.exit(75);
    }, 1500);

    return { success: true, pulled: true, installed: true, registered: regResult.registered, restarting: true };
  } catch (err) {
    emit('error', 'failed', err.message);
    throw new Error('Update failed: ' + err.message);
  }
}

/**
 * registerReleaseZip(db) — register releases/PocketIT-latest.zip in DB
 * 1. Read releases/version.json
 * 2. If version not in update_packages OR sha256 differs → copy ZIP to server/updates/, upsert DB
 * 3. Return { registered: boolean, version?, reason? }
 */
async function registerReleaseZip(db) {
  try {
    const versionJsonPath = path.join(RELEASES_DIR, 'version.json');
    if (!fs.existsSync(versionJsonPath)) {
      return { registered: false, reason: 'No releases/version.json found' };
    }

    const releaseZipPath = path.join(RELEASES_DIR, 'PocketIT-latest.zip');
    if (!fs.existsSync(releaseZipPath)) {
      return { registered: false, reason: 'No releases/PocketIT-latest.zip found' };
    }

    const versionInfo = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
    const { version, sha256, fileSize } = versionInfo;

    if (!version || !sha256) {
      return { registered: false, reason: 'Invalid version.json (missing version or sha256)' };
    }

    // Check if already registered with same hash
    const existing = db.prepare('SELECT sha256 FROM update_packages WHERE version = ?').get(version);
    if (existing && existing.sha256 === sha256) {
      return { registered: false, version, reason: `v${version} already registered with same hash` };
    }

    // Ensure updates/ directory exists
    if (!fs.existsSync(UPDATES_DIR)) {
      fs.mkdirSync(UPDATES_DIR, { recursive: true });
    }

    // Copy ZIP to server/updates/
    const filename = `PocketIT-${version}.zip`;
    const destPath = path.join(UPDATES_DIR, filename);
    fs.copyFileSync(releaseZipPath, destPath);

    // Verify SHA-256
    const fileBuffer = fs.readFileSync(destPath);
    const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (computedHash !== sha256) {
      console.warn(`[ServerUpdate] SHA-256 mismatch for v${version}: expected ${sha256.substring(0, 16)}..., got ${computedHash.substring(0, 16)}...`);
    }

    // Upsert in DB (delete + insert to handle version updates)
    if (existing) {
      db.prepare('DELETE FROM update_packages WHERE version = ?').run(version);
    }

    db.prepare(
      'INSERT INTO update_packages (version, filename, file_size, sha256, release_notes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(version, filename, fileSize || fileBuffer.length, sha256, 'Auto-registered from git release', 'git-release');

    // Audit log
    try {
      db.prepare(
        "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).run('git-release', 'release_registered', version, JSON.stringify({ filename, sha256: sha256.substring(0, 16) }));
    } catch (logErr) {
      console.error('[ServerUpdate] Audit log error:', logErr.message);
    }

    console.log(`[ServerUpdate] Registered release v${version} from releases/`);
    return { registered: true, version };
  } catch (err) {
    console.error('[ServerUpdate] registerReleaseZip error:', err.message);
    return { registered: false, reason: err.message };
  }
}

// Helper: compare semver strings (true if a > b)
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * getServerVersion() — read version from server/package.json
 */
function getServerVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * getCurrentCommit() — get current git HEAD short hash
 */
function getCurrentCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
  } catch {
    return 'unknown';
  }
}

module.exports = { checkForUpdates, applyUpdate, registerReleaseZip, getServerVersion, getCurrentCommit };
