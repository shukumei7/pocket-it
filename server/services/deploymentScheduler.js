/**
 * Deployment Scheduler — checks for pending scheduled deployments every 30s.
 * Also handles expiry: deployments older than 24h with pending results get marked skipped.
 */

let intervalHandle = null;

function start(db, io) {
  if (intervalHandle) return;

  const itNs = io.of('/it');
  const { emitToAll } = require('../socket/scopedEmit');

  intervalHandle = setInterval(() => {
    try {
      // Find deployments whose scheduled time has arrived
      const due = db.prepare(
        "SELECT * FROM deployments WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')"
      ).all();

      for (const deployment of due) {
        console.log(`[Scheduler] Dispatching scheduled deployment ${deployment.id}: ${deployment.name}`);
        dispatchDeployment(db, io, deployment.id);
      }

      // Expire old pending results (deployments older than 24h)
      const expired = db.prepare(
        "SELECT d.id FROM deployments d WHERE d.status = 'running' AND d.created_at < datetime('now', '-24 hours')"
      ).all();

      for (const dep of expired) {
        db.prepare(
          "UPDATE deployment_results SET status = 'skipped', completed_at = datetime('now') WHERE deployment_id = ? AND status = 'pending'"
        ).run(dep.id);

        // Check if all results are done
        const pending = db.prepare(
          "SELECT COUNT(*) as count FROM deployment_results WHERE deployment_id = ? AND status IN ('pending', 'uploading', 'running')"
        ).get(dep.id);

        if (pending.count === 0) {
          db.prepare("UPDATE deployments SET status = 'completed' WHERE id = ?").run(dep.id);
          emitToAll(itNs, 'deployment_completed', { deploymentId: dep.id });
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error:', err.message);
    }
  }, 30000);

  console.log('[Scheduler] Deployment scheduler started (30s interval)');
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Dispatch a deployment to all target devices. Shared by immediate and scheduled paths.
 */
function dispatchDeployment(db, io, deploymentId) {
  const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId);
  if (!deployment) return;

  const pendingResults = db.prepare(
    "SELECT * FROM deployment_results WHERE deployment_id = ? AND status = 'pending'"
  ).all();

  if (pendingResults.length === 0) return;

  const app = io.engine; // We need connectedDevices from app.locals
  // Access connectedDevices from the io server's attached app
  const connectedDevices = io._connectedDevices; // Will be set by server.js

  const agentNs = io.of('/agent');
  const itNs = io.of('/it');

  let dispatched = 0;

  for (const result of pendingResults) {
    const deviceSocket = connectedDevices ? connectedDevices.get(result.device_id) : null;

    if (!deviceSocket) {
      // Device offline — leave as pending for connect-time dispatch
      continue;
    }

    const requestId = `dep-${deploymentId}-${result.device_id}`;

    if (deployment.type === 'script') {
      // Use existing script_request event
      const scriptContent = deployment.script_content || '';
      deviceSocket.emit('script_request', {
        requestId,
        scriptName: deployment.name,
        scriptContent,
        requiresElevation: !!deployment.requires_elevation,
        timeoutSeconds: deployment.timeout_seconds || 300,
        itInitiated: true
      });
    } else if (deployment.type === 'installer') {
      // Send installer with file data
      deviceSocket.emit('installer_request', {
        requestId,
        filename: deployment.installer_filename,
        fileData: deployment.installer_data ? deployment.installer_data.toString('base64') : '',
        silentArgs: deployment.silent_args || '',
        timeoutSeconds: deployment.timeout_seconds || 300
      });
    }

    // Update result status to running
    db.prepare(
      "UPDATE deployment_results SET status = 'running', started_at = datetime('now') WHERE id = ?"
    ).run(result.id);

    dispatched++;
  }

  if (dispatched > 0) {
    db.prepare("UPDATE deployments SET status = 'running' WHERE id = ?").run(deploymentId);

    // Notify IT dashboard
    const { emitToAll } = require('../socket/scopedEmit');
    emitToAll(itNs, 'deployment_progress', {
      deploymentId,
      status: 'running',
      dispatched
    });
  }
}

/**
 * Handle a deployment result (called from agentNamespace when script_result or installer_result
 * has a dep-prefixed requestId).
 */
function handleDeploymentResult(db, io, requestId, data) {
  // Parse dep-{deploymentId}-{deviceId}
  const match = requestId.match(/^dep-(\d+)-(.+)$/);
  if (!match) return false;

  const deploymentId = parseInt(match[1], 10);
  const deviceId = match[2];

  const itNs = io.of('/it');
  const { emitToAll } = require('../socket/scopedEmit');

  const resultStatus = data.success ? 'success' : 'failed';

  db.prepare(
    "UPDATE deployment_results SET status = ?, exit_code = ?, output = ?, error_output = ?, duration_ms = ?, timed_out = ?, completed_at = datetime('now') WHERE deployment_id = ? AND device_id = ? AND status IN ('pending', 'uploading', 'running')"
  ).run(
    resultStatus,
    data.exitCode ?? -1,
    data.output || '',
    data.errorOutput || data.error_output || '',
    data.durationMs || data.duration_ms || 0,
    data.timedOut || data.timed_out ? 1 : 0,
    deploymentId,
    deviceId
  );

  // Emit per-device progress
  emitToAll(itNs, 'deployment_progress', {
    deploymentId,
    deviceId,
    status: resultStatus,
    exitCode: data.exitCode ?? -1,
    output: data.output || '',
    errorOutput: data.errorOutput || data.error_output || ''
  });

  // Check if all results are complete
  const remaining = db.prepare(
    "SELECT COUNT(*) as count FROM deployment_results WHERE deployment_id = ? AND status IN ('pending', 'uploading', 'running')"
  ).get(deploymentId);

  if (remaining.count === 0) {
    db.prepare("UPDATE deployments SET status = 'completed' WHERE id = ?").run(deploymentId);
    emitToAll(itNs, 'deployment_completed', { deploymentId });
  }

  return true;
}

/**
 * Dispatch pending deployments for a newly connected device.
 */
function dispatchPendingForDevice(db, io, deviceId, deviceSocket) {
  const pendingResults = db.prepare(
    "SELECT dr.*, d.type, d.name, d.script_content, d.installer_filename, d.installer_data, d.silent_args, d.timeout_seconds, d.requires_elevation FROM deployment_results dr JOIN deployments d ON dr.deployment_id = d.id WHERE dr.device_id = ? AND dr.status = 'pending' AND d.status IN ('pending', 'running')"
  ).all(deviceId);

  for (const result of pendingResults) {
    const requestId = `dep-${result.deployment_id}-${deviceId}`;

    if (result.type === 'script') {
      deviceSocket.emit('script_request', {
        requestId,
        scriptName: result.name,
        scriptContent: result.script_content || '',
        requiresElevation: !!result.requires_elevation,
        timeoutSeconds: result.timeout_seconds || 300,
        itInitiated: true
      });
    } else if (result.type === 'installer') {
      deviceSocket.emit('installer_request', {
        requestId,
        filename: result.installer_filename,
        fileData: result.installer_data ? result.installer_data.toString('base64') : '',
        silentArgs: result.silent_args || '',
        timeoutSeconds: result.timeout_seconds || 300
      });
    }

    db.prepare(
      "UPDATE deployment_results SET status = 'running', started_at = datetime('now') WHERE id = ?"
    ).run(result.id);

    // Mark parent deployment as running if needed
    db.prepare("UPDATE deployments SET status = 'running' WHERE id = ? AND status = 'pending'").run(result.deployment_id);
  }

  if (pendingResults.length > 0) {
    console.log(`[Scheduler] Dispatched ${pendingResults.length} pending deployments to reconnected device ${deviceId}`);
  }
}

module.exports = { start, stop, dispatchDeployment, handleDeploymentResult, dispatchPendingForDevice };
