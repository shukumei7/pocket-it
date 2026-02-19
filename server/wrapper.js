const { spawn } = require('child_process');
const path = require('path');

const SERVER_DIR = __dirname;

function start() {
  console.log('[Wrapper] Starting server...');
  const child = spawn('node', ['server.js'], {
    stdio: 'inherit',
    cwd: SERVER_DIR
  });

  child.on('exit', (code) => {
    if (code === 75) {
      console.log('[Wrapper] Restart requested (exit code 75), restarting server...');
      setTimeout(start, 1500); // brief delay for port release
    } else {
      console.log(`[Wrapper] Server exited with code ${code}`);
      process.exit(code || 0);
    }
  });

  child.on('error', (err) => {
    console.error('[Wrapper] Failed to start server:', err.message);
    process.exit(1);
  });
}

start();
