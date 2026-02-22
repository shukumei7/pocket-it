const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Set test env vars
process.env.NODE_ENV = 'test';
process.env.POCKET_IT_JWT_SECRET = 'test-secret-for-e2e';
process.env.POCKET_IT_LLM_PROVIDER = 'ollama';

describe('E2E Smoke Tests', () => {
    let server;
    let baseUrl;
    let app;
    let io;
    let testDbPath;
    let enrolledDeviceSecret; // raw secret from enrollment (bcrypt hash stored in DB — must use raw value)

    before(async () => {
        // Setup test database
        const Database = require('better-sqlite3');
        const { initDatabase } = require('../db/schema');

        const express = require('express');
        const cors = require('cors');
        const { Server } = require('socket.io');

        app = express();
        app.use(cors());
        app.use(express.json({ limit: '100kb' }));

        // Use temp DB
        testDbPath = path.join(__dirname, `test-e2e-${Date.now()}.db`);
        const db = initDatabase(testDbPath);
        app.locals.db = db;

        // Seed test client (required for enrollment token creation)
        const testClient = db.prepare('INSERT INTO clients (name, slug) VALUES (?, ?)').run('Test Client', 'test-client');
        app.locals.testClientId = testClient.lastInsertRowid;

        // Setup minimal LLM service
        const LLMService = require('../services/llmService');
        const DiagnosticAI = require('../services/diagnosticAI');

        const llmService = new LLMService({
            provider: 'ollama',
            ollamaUrl: 'http://localhost:11434',
            ollamaModel: 'llama3.2'
        });

        const diagnosticAI = new DiagnosticAI(llmService, db);
        app.locals.diagnosticAI = diagnosticAI;
        app.locals.llmService = llmService;

        // Setup routes
        const enrollmentRouter = require('../routes/enrollment');
        const devicesRouter = require('../routes/devices');
        const ticketsRouter = require('../routes/tickets');
        const adminRouter = require('../routes/admin');

        app.use('/api/enrollment', enrollmentRouter);
        app.use('/api/devices', devicesRouter);
        app.use('/api/tickets', ticketsRouter);
        app.use('/api/admin', adminRouter);

        app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'pocket-it' });
        });

        const httpServer = http.createServer(app);
        io = new Server(httpServer, { cors: { origin: '*' } });
        app.locals.io = io;

        const { setupSocket } = require('../socket/index');
        setupSocket(io, app);

        await new Promise((resolve) => {
            httpServer.listen(0, () => {
                const port = httpServer.address().port;
                baseUrl = `http://localhost:${port}`;
                server = httpServer;
                resolve();
            });
        });
    });

    after(() => {
        if (server) server.close();
        // Clean up test DB
        try {
            if (testDbPath && fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
            if (testDbPath && fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
            if (testDbPath && fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
        } catch (err) {
            // Ignore cleanup errors
        }
    });

    // Test 1: Health check
    it('should return health status', async () => {
        const res = await fetch(`${baseUrl}/health`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status, 'ok');
    });

    // Test 2: Create admin user and login (2FA is mandatory — no direct token from /login)
    it('should seed admin and require 2FA on login', async () => {
        const db = app.locals.db;
        const { hashPassword } = require('../auth/userAuth');
        const hash = await hashPassword('testpass123');
        db.prepare('INSERT INTO it_users (username, password_hash, role, created_at) VALUES (?, ?, ?, datetime(\'now\'))').run('testadmin', hash, 'admin');

        const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testadmin', password: 'testpass123' })
        });
        assert.strictEqual(loginRes.status, 200);
        const loginData = await loginRes.json();
        // 2FA is mandatory — /login never returns a token directly
        assert.ok(loginData.requiresSetup || loginData.requires2FA, 'Should require 2FA setup or verification');
        assert.ok(loginData.tempToken, 'Should return temp token for 2FA flow');
        // Full JWT token is available via /auto-login on localhost (see test #18)
    });

    // Test 3: Login with wrong password
    it('should reject invalid credentials', async () => {
        const res = await fetch(`${baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testadmin', password: 'wrongpass' })
        });
        assert.strictEqual(res.status, 401);
    });

    // Test 4: Enrollment flow
    it('should create enrollment token and enroll device', async () => {
        // Create token (localhost bypasses admin auth; client_id is required)
        const tokenRes = await fetch(`${baseUrl}/api/enrollment/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: app.locals.testClientId })
        });
        assert.strictEqual(tokenRes.status, 200);
        const tokenData = await tokenRes.json();
        assert.ok(tokenData.token, 'Should return enrollment token');

        // Enroll device
        const enrollRes = await fetch(`${baseUrl}/api/enrollment/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: tokenData.token,
                deviceId: 'test-device-001',
                hostname: 'TEST-PC',
                osVersion: 'Windows 11'
            })
        });
        assert.strictEqual(enrollRes.status, 200);
        const enrollData = await enrollRes.json();
        assert.ok(enrollData.deviceSecret, 'Should return device secret');
        assert.strictEqual(enrollData.deviceId, 'test-device-001');
        enrolledDeviceSecret = enrollData.deviceSecret; // Save raw secret (DB stores bcrypt hash)
    });

    // Test 5: Check enrollment status with secret
    it('should verify enrollment status with device secret', async () => {
        // Must use raw secret from enrollment (DB stores bcrypt hash, not plaintext)
        const res = await fetch(`${baseUrl}/api/enrollment/status/test-device-001`, {
            headers: { 'x-device-secret': enrolledDeviceSecret }
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.enrolled, true);
    });

    // Test 6: Reject enrollment status with wrong secret
    it('should reject enrollment check with wrong secret', async () => {
        const res = await fetch(`${baseUrl}/api/enrollment/status/test-device-001`, {
            headers: { 'x-device-secret': 'wrong-secret' }
        });
        assert.strictEqual(res.status, 401);
    });

    // Test 7: Device re-enrollment rejected
    it('should reject re-enrollment of existing device', async () => {
        // Create another token (client_id required)
        const tokenRes = await fetch(`${baseUrl}/api/enrollment/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: app.locals.testClientId })
        });
        const tokenData = await tokenRes.json();

        const enrollRes = await fetch(`${baseUrl}/api/enrollment/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: tokenData.token,
                deviceId: 'test-device-001',
                hostname: 'TEST-PC',
                osVersion: 'Windows 11'
            })
        });
        assert.strictEqual(enrollRes.status, 409);
    });

    // Test 8: List devices (localhost = no auth needed)
    it('should list enrolled devices', async () => {
        const res = await fetch(`${baseUrl}/api/devices`);
        assert.strictEqual(res.status, 200);
        const devices = await res.json();
        assert.ok(Array.isArray(devices));
        assert.ok(devices.length >= 1);
        assert.strictEqual(devices[0].device_id, 'test-device-001');
    });

    // Test 9: Create ticket via device
    it('should create a ticket', async () => {
        // Must use raw secret from enrollment (DB stores bcrypt hash, not plaintext)
        const res = await fetch(`${baseUrl}/api/tickets`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-device-id': 'test-device-001',
                'x-device-secret': enrolledDeviceSecret
            },
            body: JSON.stringify({
                title: 'Test ticket',
                description: 'My printer is not working',
                priority: 'medium'
            })
        });
        assert.strictEqual(res.status, 201);
        const data = await res.json();
        assert.ok(data.id, 'Should return ticket ID');
    });

    // Test 10: List tickets
    it('should list tickets', async () => {
        const res = await fetch(`${baseUrl}/api/tickets`);
        assert.strictEqual(res.status, 200);
        const tickets = await res.json();
        assert.ok(tickets.length >= 1);
        assert.strictEqual(tickets[0].title, 'Test ticket');
    });

    // Test 11: Update ticket status
    it('should update ticket status', async () => {
        const ticketsRes = await fetch(`${baseUrl}/api/tickets`);
        const tickets = await ticketsRes.json();
        const ticketId = tickets[0].id;

        const res = await fetch(`${baseUrl}/api/tickets/${ticketId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'in_progress' })
        });
        assert.strictEqual(res.status, 200);
    });

    // Test 12: Add ticket comment
    it('should add comment to ticket', async () => {
        const ticketsRes = await fetch(`${baseUrl}/api/tickets`);
        const tickets = await ticketsRes.json();
        const ticketId = tickets[0].id;

        const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Looking into this', author: 'IT Staff' })
        });
        assert.strictEqual(res.status, 201);
    });

    // Test 13: Get ticket with comments
    it('should get ticket detail with comments', async () => {
        const ticketsRes = await fetch(`${baseUrl}/api/tickets`);
        const tickets = await ticketsRes.json();
        const ticketId = tickets[0].id;

        const res = await fetch(`${baseUrl}/api/tickets/${ticketId}`);
        assert.strictEqual(res.status, 200);
        const ticket = await res.json();
        assert.strictEqual(ticket.status, 'in_progress');
        assert.ok(ticket.comments.length >= 1);
    });

    // Test 14: Delete device
    it('should delete device and cascade data', async () => {
        // First enroll another device to delete (client_id required)
        const tokenRes = await fetch(`${baseUrl}/api/enrollment/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: app.locals.testClientId })
        });
        const tokenData = await tokenRes.json();

        await fetch(`${baseUrl}/api/enrollment/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: tokenData.token,
                deviceId: 'test-device-delete',
                hostname: 'DELETE-PC',
                osVersion: 'Windows 10'
            })
        });

        const res = await fetch(`${baseUrl}/api/devices/test-device-delete`, { method: 'DELETE' });
        assert.strictEqual(res.status, 200);

        // Verify deleted
        const checkRes = await fetch(`${baseUrl}/api/devices/test-device-delete`);
        assert.strictEqual(checkRes.status, 404);
    });

    // Test 15: Admin stats
    it('should return dashboard stats', async () => {
        const res = await fetch(`${baseUrl}/api/admin/stats`);
        assert.strictEqual(res.status, 200);
        const stats = await res.json();
        assert.ok('totalDevices' in stats);
        assert.ok('onlineDevices' in stats);
        assert.ok('openTickets' in stats);
        assert.ok('totalTickets' in stats);
    });

    // Test 16: Reject invalid ticket status
    it('should reject invalid ticket status update', async () => {
        const ticketsRes = await fetch(`${baseUrl}/api/tickets`);
        const tickets = await ticketsRes.json();
        const ticketId = tickets[0].id;

        const res = await fetch(`${baseUrl}/api/tickets/${ticketId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'invalid_status' })
        });
        assert.strictEqual(res.status, 400);
    });

    // Test 17: Mount reports router, helmet (for CSP), and static files for report API tests
    it('should register reports routes and serve static dashboard', () => {
        const path = require('path');
        const express = require('express');
        const helmet = require('helmet');
        const ReportService = require('../services/reportService');
        const ExportService = require('../services/exportService');
        const createReportsRouter = require('../routes/reports');

        const reportService = new ReportService(app.locals.db);
        const exportService = new ExportService();
        app.use('/api/reports', createReportsRouter(reportService, exportService));
        app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
                    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
                    connectSrc: ["'self'", "ws:", "wss:"],
                    imgSrc: ["'self'", "data:"],
                    fontSrc: ["'self'", "data:"]
                }
            }
        }));
        app.use(express.static(path.join(__dirname, '..', 'public')));
    });

    // Test 18: Auto-login endpoint returns a token from localhost
    it('should auto-login from localhost and return a token', async () => {
        const res = await fetch(`${baseUrl}/api/admin/auto-login`, { method: 'POST' });
        assert.ok(res.status === 200 || res.status === 201);
        const data = await res.json();
        assert.ok(data.token, 'Should return JWT token');
        assert.ok(data.user, 'Should return user info');
    });

    // Test 19: Fleet health trend returns an array
    it('should return fleet health trend as an array', async () => {
        const res = await fetch(`${baseUrl}/api/reports/fleet/health-trend?days=7`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data), 'Fleet health trend should be an array');
    });

    // Test 20: Alert summary returns expected shape
    it('should return alert summary with expected shape', async () => {
        const res = await fetch(`${baseUrl}/api/reports/alerts/summary?days=30`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok('total' in data, 'Should have total');
        assert.ok('by_severity' in data, 'Should have by_severity');
        assert.ok('per_day' in data, 'Should have per_day');
        assert.ok(Array.isArray(data.by_severity), 'by_severity should be an array');
        assert.ok(Array.isArray(data.per_day), 'per_day should be an array');
    });

    // Test 21: Ticket summary returns expected shape
    it('should return ticket summary with expected shape', async () => {
        const res = await fetch(`${baseUrl}/api/reports/tickets/summary?days=30`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok('total' in data, 'Should have total');
        assert.ok('by_status' in data, 'Should have by_status');
        assert.ok('per_day' in data, 'Should have per_day');
        assert.ok(Array.isArray(data.by_status), 'by_status should be an array');
        assert.ok(Array.isArray(data.per_day), 'per_day should be an array');
    });

    // Test 22: CSV export returns text/csv content-type
    it('should export fleet health as CSV with text/csv content-type', async () => {
        const res = await fetch(`${baseUrl}/api/reports/export?type=fleet_health&days=7&format=csv`);
        assert.strictEqual(res.status, 200);
        const contentType = res.headers.get('content-type');
        assert.ok(contentType && contentType.includes('text/csv'), `Expected text/csv, got: ${contentType}`);
    });

    // Test 23: Schedule CRUD — create, list, delete
    it('should create, list, and delete a report schedule', async () => {
        // Create
        const createRes = await fetch(`${baseUrl}/api/reports/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Weekly Fleet Report',
                report_type: 'fleet_health',
                schedule: '0 9 * * 1',
                format: 'csv'
            })
        });
        assert.strictEqual(createRes.status, 201);
        const created = await createRes.json();
        assert.ok(created.id, 'Should return schedule id');
        assert.strictEqual(created.name, 'Weekly Fleet Report');

        // List — should contain the created schedule
        const listRes = await fetch(`${baseUrl}/api/reports/schedules`);
        assert.strictEqual(listRes.status, 200);
        const schedules = await listRes.json();
        assert.ok(Array.isArray(schedules));
        assert.ok(schedules.some(s => s.id === created.id), 'Created schedule should appear in list');

        // Delete
        const deleteRes = await fetch(`${baseUrl}/api/reports/schedules/${created.id}`, { method: 'DELETE' });
        assert.strictEqual(deleteRes.status, 200);
        const deleteData = await deleteRes.json();
        assert.strictEqual(deleteData.success, true);
    });

    // Test 24: Dashboard serves index.html with CSP header containing cdn.jsdelivr.net
    it('should serve dashboard with Content-Security-Policy including cdn.jsdelivr.net', async () => {
        const res = await fetch(`${baseUrl}/dashboard/`);
        assert.strictEqual(res.status, 200);
        const csp = res.headers.get('content-security-policy');
        assert.ok(csp, 'Should have Content-Security-Policy header');
        assert.ok(csp.includes('cdn.jsdelivr.net'), `CSP should include cdn.jsdelivr.net, got: ${csp}`);
    });
});
