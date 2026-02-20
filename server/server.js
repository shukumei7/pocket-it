const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Security: require JWT secret in non-test environments
if (!process.env.POCKET_IT_JWT_SECRET && process.env.NODE_ENV !== 'test') {
  console.error('[SECURITY] POCKET_IT_JWT_SECRET is not set. Server will not start without it.');
  console.error('[SECURITY] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const fs = require('fs');
const { initDatabase } = require('./db/schema');

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: [],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "ws:", "wss:", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"]
    }
  }
}));

// Trust proxy only if explicitly configured
// Do NOT set trust proxy to true blindly — it enables X-Forwarded-For which can be spoofed
// app.set('trust proxy', 1); // Only enable behind a known reverse proxy

// Rate limiting (skip localhost — consistent with auth bypass)
const rateLimit = require('express-rate-limit');
const { isLocalhost } = require('./auth/middleware');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isLocalhost(req),
  message: { error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // stricter for auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isLocalhost(req),
  message: { error: 'Too many authentication attempts' }
});

// Allow additional origins via env var (comma-separated)
const extraOrigins = (process.env.POCKET_IT_CORS_ORIGINS || '').split(',').filter(Boolean);
const allowedOrigins = [
    'http://localhost:9100',
    'https://localhost:9100',
    'file://',
    ...extraOrigins
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (same-origin, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(express.json({ limit: '100kb' }));

// Sanitize null bytes from request body strings
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key].replace(/\0/g, '');
      }
    }
  }
  next();
});

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = initDatabase(path.join(dbDir, 'pocket-it.db'));
app.locals.db = db;

const LLMService = require('./services/llmService');
const DiagnosticAI = require('./services/diagnosticAI');

const llmService = new LLMService({
  provider: process.env.POCKET_IT_LLM_PROVIDER || 'ollama',
  ollamaUrl: process.env.POCKET_IT_OLLAMA_URL || 'http://localhost:11434',
  openaiKey: process.env.POCKET_IT_OPENAI_API_KEY || '',
  openaiModel: process.env.POCKET_IT_OPENAI_MODEL || 'gpt-4o-mini',
  anthropicKey: process.env.POCKET_IT_ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.POCKET_IT_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
  claudeCliModel: process.env.POCKET_IT_CLAUDE_CLI_MODEL || '',
  ollamaModel: process.env.POCKET_IT_OLLAMA_MODEL || 'llama3.2',
  timeoutMs: 120000
});

const diagnosticAI = new DiagnosticAI(llmService, db);
app.locals.diagnosticAI = diagnosticAI;
app.locals.llmService = llmService;

// Load saved settings from DB and reconfigure LLM service
try {
  const savedSettings = db.prepare('SELECT key, value FROM server_settings').all();
  if (savedSettings.length > 0) {
    const s = {};
    for (const row of savedSettings) s[row.key] = row.value;
    llmService.reconfigure({
      provider: s['llm.provider'] || llmService.provider,
      ollamaUrl: s['llm.ollama.url'] || llmService.ollamaUrl,
      ollamaModel: s['llm.ollama.model'] || llmService.ollamaModel,
      openaiKey: s['llm.openai.apiKey'] || llmService.openaiKey,
      openaiModel: s['llm.openai.model'] || llmService.openaiModel,
      anthropicKey: s['llm.anthropic.apiKey'] || llmService.anthropicKey,
      anthropicModel: s['llm.anthropic.model'] || llmService.anthropicModel,
      claudeCliModel: s['llm.claudeCli.model'] || llmService.claudeCliModel,
      timeoutMs: parseInt(s['llm.timeout'], 10) || 120000
    });
  }
} catch (err) {
  console.error('[Settings] Failed to load saved settings:', err.message);
}

const AlertService = require('./services/alertService');
const NotificationService = require('./services/notificationService');

const alertService = new AlertService(db);
const notificationService = new NotificationService(db);
app.locals.alertService = alertService;
app.locals.notificationService = notificationService;

const enrollmentRouter = require('./routes/enrollment');
const devicesRouter = require('./routes/devices');
const ticketsRouter = require('./routes/tickets');
const chatRouter = require('./routes/chat');
const adminRouter = require('./routes/admin');
const createLLMRouter = require('./routes/llm');

app.use('/api/', apiLimiter);
app.use('/api/admin/login', authLimiter);
app.use('/api/admin/verify-2fa', authLimiter);
app.use('/api/admin/2fa', authLimiter);
app.use('/api/enrollment/token', authLimiter);

app.use('/api/enrollment', enrollmentRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);
app.use('/api/llm', createLLMRouter(llmService));
const clientsRouter = require('./routes/clients');
app.use('/api/clients', clientsRouter);
const updatesRouter = require('./routes/updates');
app.use('/api/updates', updatesRouter);
const installerRouter = require('./routes/installer');
app.use('/api/installer', installerRouter);

const createAlertsRouter = require('./routes/alerts');
app.use('/api/alerts', createAlertsRouter(alertService, notificationService));

const createPoliciesRouter = require('./routes/policies');
app.use('/api/alerts/policies', createPoliciesRouter(alertService));

const createScriptsRouter = require('./routes/scripts');
app.use('/api/scripts', createScriptsRouter());

const ReportService = require('./services/reportService');
const ExportService = require('./services/exportService');
const reportService = new ReportService(db);
const exportService = new ExportService();

const createReportsRouter = require('./routes/reports');
app.use('/api/reports', createReportsRouter(reportService, exportService));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'), {
    headers: { 'Content-Type': 'image/svg+xml' }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocket-it' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  }
});

app.locals.io = io;

const { setupSocket } = require('./socket/index');
setupSocket(io, app);

const PORT = process.env.POCKET_IT_PORT || 9100;
server.listen(PORT, () => {
  console.log(`Pocket IT server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

const SchedulerService = require('./services/schedulerService');
const schedulerService = new SchedulerService(db, reportService, exportService, notificationService);
schedulerService.start();

// v0.14.0: Deployment scheduler
const deploymentScheduler = require('./services/deploymentScheduler');
deploymentScheduler.start(db, io);

// Auto-register release ZIP from git (if present)
const { registerReleaseZip } = require('./services/serverUpdate');
registerReleaseZip(db).then(result => {
  if (result.registered) {
    console.log(`[Updates] Registered release v${result.version} from git`);
  }
}).catch(err => {
  console.error('[Updates] Release registration error:', err.message);
});
// Scheduler needs access to connected devices map
io._connectedDevices = app.locals.connectedDevices;

module.exports = { app, server, io };
