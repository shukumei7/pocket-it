const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IS_DOCKER = process.env.POCKET_IT_DOCKER === 'true';

// Project root is 2 levels up from services/
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RELEASES_DIR = path.join(PROJECT_ROOT, 'releases');
const UPDATES_DIR = path.join(__dirname, '..', 'updates');

// In Docker: git operations run against the mounted host repo
const GIT_ROOT = IS_DOCKER
  ? (process.env.POCKET_IT_REPO_DIR || '/app/repo')
  : PROJECT_ROOT;

const COMPOSE_SERVICE = process.env.POCKET_IT_COMPOSE_SERVICE || 'pocket-it';

/**
 * checkForUpdates() — git fetch + compare HEAD vs origin/main
 * Returns: { available, currentCommit, remoteCommit, commitsBehind, summary[] }
 */
async function checkForUpdates() {
  try {
    // git fetch origin main
    execSync('git fetch origin main', { cwd: GIT_ROOT, stdio: 'pipe', timeout: 30000 });

    const currentCommit = execSync('git rev-parse --short HEAD', { cwd: GIT_ROOT, stdio: 'pipe' }).toString().trim();
    const remoteCommit = execSync('git rev-parse --short origin/main', { cwd: GIT_ROOT, stdio: 'pipe' }).toString().trim();

    if (currentCommit === remoteCommit) {
      return { available: false, currentCommit, remoteCommit, commitsBehind: 0, summary: [] };
    }

    // Count commits behind
    const behindOutput = execSync('git rev-list --count HEAD..origin/main', { cwd: GIT_ROOT, stdio: 'pipe' }).toString().trim();
    const commitsBehind = parseInt(behindOutput, 10) || 0;

    // Get commit summaries
    const logOutput = execSync('git log HEAD..origin/main --oneline --no-decorate', { cwd: GIT_ROOT, stdio: 'pipe' }).toString().trim();
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
    const pullOutput = execSync('git pull origin main', { cwd: GIT_ROOT, stdio: 'pipe', timeout: 120000 }).toString().trim();
    emit('pull', 'done', pullOutput);

    // Step 2: npm install (non-Docker only; Docker rebuild handles npm ci)
    emit('install', 'in_progress', 'Checking dependencies...');
    if (IS_DOCKER) {
      emit('install', 'done', 'Dependencies will be refreshed in rebuild');
    } else {
      try {
        const changedFiles = execSync('git diff HEAD~1 --name-only', { cwd: GIT_ROOT, stdio: 'pipe' }).toString();
        if (changedFiles.includes('package.json') || changedFiles.includes('package-lock.json')) {
          execSync('npm install --production', { cwd: path.join(GIT_ROOT, 'server'), stdio: 'pipe', timeout: 120000 });
          emit('install', 'done', 'Dependencies updated');
        } else {
          emit('install', 'done', 'No dependency changes');
        }
      } catch (installErr) {
        emit('install', 'warning', 'npm install had issues: ' + installErr.message);
      }
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

    // Step 4: Schedule restart / container rebuild
    emit('restart', 'in_progress', IS_DOCKER ? 'Triggering container rebuild...' : 'Server restarting...');

    if (IS_DOCKER) {
      // Spawn docker compose up --build -d (detached so it survives this container stopping)
      const rebuild = spawn('docker', ['compose', 'up', '--build', '-d', COMPOSE_SERVICE], {
        cwd: GIT_ROOT,
        detached: true,
        stdio: 'ignore'
      });
      rebuild.unref();
    } else {
      setTimeout(() => {
        process.exit(75);
      }, 1500);
    }

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
  if (IS_DOCKER) {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: GIT_ROOT, stdio: 'pipe' }).toString().trim();
    } catch {
      return process.env.POCKET_IT_VERSION || 'docker';
    }
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * checkClientRelease(db) — git fetch + check if releases/version.json changed
 * If remote has a newer client build, sparse-checkout just the release files and register.
 * Returns: { updated: boolean, version?, reason? }
 */
async function checkClientRelease(db) {
  if (IS_DOCKER) {
    return { updated: false, reason: 'Git-based client release check disabled in Docker mode' };
  }
  try {
    execSync('git fetch origin main', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30000 });

    const diffOutput = execSync(
      'git diff HEAD..origin/main -- releases/version.json',
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    ).toString().trim();

    if (!diffOutput) {
      return { updated: false, reason: 'No client release changes in remote' };
    }

    execSync('git checkout origin/main -- releases/version.json releases/PocketIT-latest.zip',
      { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 60000 });

    const result = await registerReleaseZip(db);
    if (result.registered) {
      console.log(`[AutoUpdate] New client build from git: v${result.version}`);
      return { updated: true, version: result.version };
    }

    return { updated: false, reason: result.reason || 'Release already registered' };
  } catch (err) {
    if (err.message && !err.message.includes('not a git repository')) {
      console.error('[AutoUpdate] Client release check failed:', err.message);
    }
    return { updated: false, reason: err.message };
  }
}

module.exports = { checkForUpdates, applyUpdate, registerReleaseZip, checkClientRelease, isNewerVersion, getServerVersion, getCurrentCommit };
