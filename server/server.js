const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const { initDatabase } = require('./db/schema');

const app = express();

app.use(cors());
app.use(express.json());

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
  ollamaModel: process.env.POCKET_IT_OLLAMA_MODEL || 'llama3.2'
});

const diagnosticAI = new DiagnosticAI(llmService, db);
app.locals.diagnosticAI = diagnosticAI;
app.locals.llmService = llmService;

const enrollmentRouter = require('./routes/enrollment');
const devicesRouter = require('./routes/devices');
const ticketsRouter = require('./routes/tickets');
const chatRouter = require('./routes/chat');
const adminRouter = require('./routes/admin');
const createLLMRouter = require('./routes/llm');

app.use('/api/enrollment', enrollmentRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);
app.use('/api/llm', createLLMRouter(llmService));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocket-it' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
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

module.exports = { app, server, io };
