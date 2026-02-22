# Pocket IT — AI-Powered IT Helpdesk

A lightweight, self-hosted IT helpdesk system with real-time device management, AI-assisted diagnostics, and a Windows tray client.

## Overview

Pocket IT consists of two components working together over Socket.IO:

- **.NET 8 Windows Forms client** — system tray app with an embedded WebView2 UI
- **Node.js Express server** — REST API and Socket.IO real-time communication hub

Additional capabilities:

- AI diagnostic assistant (supports Ollama, OpenAI, Anthropic, Google Gemini, Claude CLI)
- Remote device management: script execution, file browser, remote desktop
- Alert policies, scheduled reports, and deployment management
- Multi-tenant client scoping with role-based access control (superadmin, admin, technician, viewer)
- Per-client logbook notes and custom key-value fields; scripts can auto-populate client fields via the `POCKET_IT_CLIENT_FIELDS:` output marker

## Architecture

```
pocket-it/
  server/          # Node.js Express + Socket.IO server
  client/          # .NET 8 Windows Forms tray application
  installer/       # InnoSetup and online installer generators
  releases/        # Git-tracked client release ZIPs
  docker-compose.yml
  Dockerfile
```

## Quick Start (Local)

```bash
cd server
cp .env.example .env  # Edit with your settings
npm install
node seed-admin.js --username admin --password YourPassword
npm start             # uses wrapper.js for self-update support
# or: node server.js  # direct (development, no wrapper)
```

Dashboard: http://localhost:9100

## Quick Start (Docker)

```bash
docker-compose up -d --build
docker exec pocket-it node seed-admin.js --username admin --password YourSecurePassword
```

Dashboard: http://localhost:9100

See [docs/docker.md](docs/docker.md) for full Docker deployment details.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POCKET_IT_PORT` | `9100` | Server port |
| `POCKET_IT_JWT_SECRET` | (required) | JWT signing secret. Auto-generated and persisted in Docker. |
| `POCKET_IT_DATA_DIR` | `./db` | Persistent data directory |
| `POCKET_IT_LLM_PROVIDER` | `ollama` | AI provider: `ollama`, `openai`, `anthropic`, `gemini`, `claude-cli` |
| `POCKET_IT_OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL |
| `POCKET_IT_OLLAMA_MODEL` | `llama3.2` | Ollama model name |
| `POCKET_IT_OPENAI_API_KEY` | | OpenAI API key |
| `POCKET_IT_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model |
| `POCKET_IT_ANTHROPIC_API_KEY` | | Anthropic API key |
| `POCKET_IT_ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model |
| `POCKET_IT_CLAUDE_CLI_MODEL` | | Claude CLI model override |
| `POCKET_IT_GEMINI_API_KEY` | | Google Gemini API key |
| `POCKET_IT_GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini model |
| `POCKET_IT_CORS_ORIGINS` | | Extra CORS origins (comma-separated) |
| `POCKET_IT_DOCKER` | | Set to `true` in Docker (auto-set by Dockerfile) |
| `POCKET_IT_ENCRYPTION_SALT` | | Salt for API key encryption at rest |

## Client Build

```bash
dotnet publish client/PocketIT/PocketIT.csproj \
  -c Release \
  -r win-x64 \
  --self-contained \
  -p:PublishSingleFile=true
```

## Testing

```bash
cd server
npm test              # Unit tests (node --test)
npx playwright test   # E2E tests (server must be running on port 9100)
```

## Security

- JWT authentication with bcrypt password hashing
- 2FA/TOTP support with backup codes
- Helmet.js security headers
- Rate limiting on authentication endpoints
- Role-based access: superadmin, admin, technician, viewer
- Client scope isolation (multi-tenant)
- API key encryption at rest

## License

Private
