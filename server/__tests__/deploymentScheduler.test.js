const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-key-for-testing';

// ─── Chunking math helpers (mirrors dispatchDeployment / dispatchPendingForDevice) ──

const CHUNK_SIZE = 262144; // 256KB of base64 chars

function buildChunks(base64Data) {
  const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push(base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
  return chunks;
}

// Simulate the emit sequence used in dispatchDeployment for installer type
function simulateInstallerDispatch(installerBuffer, requestId, filename, silentArgs, timeoutSeconds) {
  const base64Data = installerBuffer ? installerBuffer.toString('base64') : '';
  const emitted = [];

  if (base64Data.length <= CHUNK_SIZE) {
    emitted.push({
      event: 'installer_request',
      data: { requestId, filename, fileData: base64Data, silentArgs, timeoutSeconds }
    });
  } else {
    const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = base64Data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      emitted.push({
        event: 'installer_chunk',
        data: { requestId, filename, chunk, chunkIndex: i, totalChunks, silentArgs, timeoutSeconds }
      });
    }
    emitted.push({ event: 'installer_chunks_complete', data: { requestId } });
  }

  return emitted;
}

// ─── Mock setup helpers ──────────────────────────────────────────────────────

function makeMockSocket() {
  const calls = [];
  return {
    emit(event, data) { calls.push({ event, data }); },
    calls
  };
}

function makeMockDb(deployment, results) {
  const statements = {
    getDeployment: { get: () => deployment },
    getPendingResults: { all: () => results },
    updateResult: { run: () => {} },
    updateDeployment: { run: () => {} }
  };

  return {
    prepare(sql) {
      if (sql.includes('SELECT * FROM deployments WHERE id')) return statements.getDeployment;
      if (sql.includes('SELECT * FROM deployment_results')) return statements.getPendingResults;
      if (sql.includes('UPDATE deployment_results')) return statements.updateResult;
      if (sql.includes('UPDATE deployments')) return statements.updateDeployment;
      return { get: () => null, all: () => [], run: () => {} };
    }
  };
}

// ─── Installer chunking — direct logic tests ─────────────────────────────────

describe('installer chunking — CHUNK_SIZE boundary', () => {
  it('empty installer_data produces empty base64 string', () => {
    const base64 = Buffer.from('').toString('base64');
    assert.strictEqual(base64, '');
  });

  it('small file (1KB) base64 length is well below CHUNK_SIZE', () => {
    const buf = Buffer.alloc(1024, 0x41); // 1KB of 'A'
    const b64 = buf.toString('base64');
    assert.ok(b64.length <= CHUNK_SIZE, `1KB base64 (${b64.length} chars) should be <= ${CHUNK_SIZE}`);
  });

  it('chunk count for 512KB payload is exactly 3 (512KB base64 is ~699400 chars)', () => {
    // base64 expands ~4/3: 512*1024 bytes => ~699050 chars
    // Math.ceil(699050 / 262144) = 3
    const payloadBytes = 512 * 1024;
    const base64Len = Math.ceil(payloadBytes * 4 / 3);
    const expectedChunks = Math.ceil(base64Len / CHUNK_SIZE);
    assert.strictEqual(expectedChunks, 3);
  });

  it('chunk count for exactly CHUNK_SIZE chars is 1', () => {
    assert.strictEqual(Math.ceil(CHUNK_SIZE / CHUNK_SIZE), 1);
  });

  it('chunk count for CHUNK_SIZE + 1 chars is 2', () => {
    assert.strictEqual(Math.ceil((CHUNK_SIZE + 1) / CHUNK_SIZE), 2);
  });
});

describe('installer chunking — small file emits installer_request', () => {
  it('small buffer produces single installer_request event', () => {
    const buf = Buffer.from('small installer content');
    const events = simulateInstallerDispatch(buf, 'dep-1-device1', 'setup.exe', '/S', 300);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'installer_request');
  });

  it('installer_request event contains full fileData', () => {
    const buf = Buffer.from('small installer content');
    const b64 = buf.toString('base64');
    const events = simulateInstallerDispatch(buf, 'dep-1-device1', 'setup.exe', '/S', 300);

    assert.strictEqual(events[0].data.fileData, b64);
  });

  it('installer_request event contains correct metadata fields', () => {
    const buf = Buffer.from('tiny');
    const events = simulateInstallerDispatch(buf, 'dep-42-dev99', 'app.msi', '/quiet', 600);
    const d = events[0].data;

    assert.strictEqual(d.requestId, 'dep-42-dev99');
    assert.strictEqual(d.filename, 'app.msi');
    assert.strictEqual(d.silentArgs, '/quiet');
    assert.strictEqual(d.timeoutSeconds, 600);
  });

  it('null buffer produces installer_request with empty fileData', () => {
    const events = simulateInstallerDispatch(null, 'dep-1-dev1', 'setup.exe', '', 300);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'installer_request');
    assert.strictEqual(events[0].data.fileData, '');
  });
});

describe('installer chunking — large file emits installer_chunk events', () => {
  // Build a buffer whose base64 length exceeds CHUNK_SIZE (>262144 chars)
  // base64 ratio ~4/3, so 200000 bytes => ~266667 chars > 262144
  const LARGE_BYTES = 200000;

  it('large file does not emit installer_request', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'big.exe', '/S', 300);
    const types = events.map(e => e.event);
    assert.ok(!types.includes('installer_request'), 'should not emit installer_request for large file');
  });

  it('large file emits installer_chunks_complete as final event', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'big.exe', '/S', 300);
    const last = events[events.length - 1];
    assert.strictEqual(last.event, 'installer_chunks_complete');
    assert.strictEqual(last.data.requestId, 'dep-1-dev1');
  });

  it('large file chunk count matches Math.ceil(length / CHUNK_SIZE)', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const b64Len = buf.toString('base64').length;
    const expectedChunks = Math.ceil(b64Len / CHUNK_SIZE);

    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'big.exe', '/S', 300);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');

    assert.strictEqual(chunkEvents.length, expectedChunks);
  });

  it('chunk events carry sequential chunkIndex values starting at 0', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'big.exe', '/S', 300);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');

    chunkEvents.forEach((evt, i) => {
      assert.strictEqual(evt.data.chunkIndex, i);
    });
  });

  it('all chunk events report the same totalChunks value', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const b64Len = buf.toString('base64').length;
    const expectedTotal = Math.ceil(b64Len / CHUNK_SIZE);

    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'big.exe', '/S', 300);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');

    chunkEvents.forEach(evt => {
      assert.strictEqual(evt.data.totalChunks, expectedTotal);
    });
  });

  it('chunk events carry correct requestId and filename', () => {
    const buf = Buffer.alloc(LARGE_BYTES, 0x42);
    const events = simulateInstallerDispatch(buf, 'dep-7-machine1', 'installer.exe', '/passive', 120);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');

    chunkEvents.forEach(evt => {
      assert.strictEqual(evt.data.requestId, 'dep-7-machine1');
      assert.strictEqual(evt.data.filename, 'installer.exe');
    });
  });
});

describe('installer chunking — chunk reassembly equals original data', () => {
  it('reassembled chunks equal original base64 for a multi-chunk payload', () => {
    const LARGE_BYTES = 200000;
    const buf = Buffer.alloc(LARGE_BYTES, 0x43);
    const originalB64 = buf.toString('base64');

    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'app.exe', '', 300);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');

    // Sort by chunkIndex to be safe, then join
    chunkEvents.sort((a, b) => a.data.chunkIndex - b.data.chunkIndex);
    const reassembled = chunkEvents.map(e => e.data.chunk).join('');

    assert.strictEqual(reassembled, originalB64);
  });

  it('reassembled chunks can be decoded back to original buffer', () => {
    const LARGE_BYTES = 200000;
    const original = Buffer.alloc(LARGE_BYTES);
    for (let i = 0; i < LARGE_BYTES; i++) original[i] = i % 256;

    const events = simulateInstallerDispatch(original, 'dep-1-dev1', 'app.exe', '', 300);
    const chunkEvents = events.filter(e => e.event === 'installer_chunk');
    chunkEvents.sort((a, b) => a.data.chunkIndex - b.data.chunkIndex);
    const reassembledB64 = chunkEvents.map(e => e.data.chunk).join('');
    const decoded = Buffer.from(reassembledB64, 'base64');

    assert.strictEqual(decoded.length, original.length);
    assert.ok(decoded.equals(original), 'decoded buffer should equal the original buffer');
  });

  it('single-chunk small file reassembles correctly via fileData field', () => {
    const content = 'hello world installer';
    const buf = Buffer.from(content);
    const originalB64 = buf.toString('base64');

    const events = simulateInstallerDispatch(buf, 'dep-1-dev1', 'setup.exe', '', 300);
    assert.strictEqual(events[0].event, 'installer_request');

    const decoded = Buffer.from(events[0].data.fileData, 'base64').toString();
    assert.strictEqual(decoded, content);
  });
});

describe('installer chunking — dispatchDeployment integration (mock db + socket)', () => {
  const { dispatchDeployment } = require('../services/deploymentScheduler');

  function makeMockIo(connectedDevices) {
    const itNsEmits = [];
    return {
      _connectedDevices: connectedDevices,
      of(ns) {
        return {
          emit(event, data) { itNsEmits.push({ ns, event, data }); },
          _emits: itNsEmits
        };
      },
      engine: {}
    };
  }

  it('small installer: device socket receives installer_request', () => {
    const socket = makeMockSocket();
    const connectedDevices = new Map([['dev-a', socket]]);

    const installerBuf = Buffer.from('small-file-content');
    const deployment = {
      id: 1,
      type: 'installer',
      name: 'Test Installer',
      installer_data: installerBuf,
      installer_filename: 'setup.exe',
      silent_args: '/S',
      timeout_seconds: 300,
      requires_elevation: 0,
      script_content: null
    };
    const results = [{ id: 10, device_id: 'dev-a' }];
    const db = makeMockDb(deployment, results);
    const io = makeMockIo(connectedDevices);

    dispatchDeployment(db, io, 1);

    const requestEvent = socket.calls.find(c => c.event === 'installer_request');
    assert.ok(requestEvent, 'installer_request should be emitted for small file');
    assert.ok(requestEvent.data.fileData, 'fileData should be present');
    assert.ok(!socket.calls.find(c => c.event === 'installer_chunk'), 'no chunks for small file');
  });

  it('large installer: device socket receives installer_chunk and installer_chunks_complete', () => {
    const socket = makeMockSocket();
    const connectedDevices = new Map([['dev-b', socket]]);

    // 200000 bytes => ~266667 base64 chars > CHUNK_SIZE
    const installerBuf = Buffer.alloc(200000, 0x44);
    const deployment = {
      id: 2,
      type: 'installer',
      name: 'Big Installer',
      installer_data: installerBuf,
      installer_filename: 'bigsetup.exe',
      silent_args: '/quiet',
      timeout_seconds: 600,
      requires_elevation: 0,
      script_content: null
    };
    const results = [{ id: 20, device_id: 'dev-b' }];
    const db = makeMockDb(deployment, results);
    const io = makeMockIo(connectedDevices);

    dispatchDeployment(db, io, 2);

    const chunkEvents = socket.calls.filter(c => c.event === 'installer_chunk');
    const completeEvent = socket.calls.find(c => c.event === 'installer_chunks_complete');

    assert.ok(chunkEvents.length > 1, 'multiple installer_chunk events expected');
    assert.ok(completeEvent, 'installer_chunks_complete should be emitted');
    assert.ok(!socket.calls.find(c => c.event === 'installer_request'), 'no installer_request for large file');
  });

  it('offline device: no socket events emitted, result left as pending', () => {
    const socket = makeMockSocket();
    // Device not in connectedDevices map
    const connectedDevices = new Map();

    const installerBuf = Buffer.from('content');
    const deployment = {
      id: 3,
      type: 'installer',
      name: 'Offline Test',
      installer_data: installerBuf,
      installer_filename: 'setup.exe',
      silent_args: '',
      timeout_seconds: 300,
      requires_elevation: 0,
      script_content: null
    };
    const results = [{ id: 30, device_id: 'dev-offline' }];
    const db = makeMockDb(deployment, results);
    const io = makeMockIo(connectedDevices);

    dispatchDeployment(db, io, 3);

    assert.strictEqual(socket.calls.length, 0, 'offline device should receive no socket events');
  });
});
