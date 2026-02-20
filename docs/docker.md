# Docker Deployment Guide

## Prerequisites

- Docker Engine 20+
- docker-compose v1.29+ or Docker Compose v2

## Basic Setup

```bash
git clone <repo-url>
cd pocket-it
docker-compose up -d --build
docker exec pocket-it node seed-admin.js --username admin --password YourSecurePassword
```

Dashboard: http://localhost:9100

## Data Persistence

The `./data/` directory is mounted as a Docker volume and contains all persistent state:

- `pocket-it.db` — SQLite database (devices, tickets, users, settings)
- `.jwt-secret` — Auto-generated JWT signing key (persisted across restarts)
- `reports/` — Generated scheduled reports
- `updates/` — Uploaded client update ZIPs

The JWT secret is auto-generated on first run and written to `./data/.jwt-secret`. Subsequent container restarts reuse the same secret, so existing sessions remain valid.

## Deploying Updates

Always use `--build` when deploying code changes. Without it, Docker reuses the old image — source code is `COPY`ed into the image at build time, not volume-mounted.

```bash
git pull origin main
docker stop pocket-it && docker rm pocket-it
docker-compose up -d --build pocket-it
```

Note: docker-compose v1 (1.29.x) has a known `ContainerConfig` KeyError when recreating containers. You must manually stop and remove the old container before running `docker-compose up`.

## CORS Configuration

By default, only requests from `localhost:9100` are allowed. For remote access, set `POCKET_IT_CORS_ORIGINS` in `docker-compose.yml`:

```yaml
environment:
  - POCKET_IT_CORS_ORIGINS=http://192.168.1.100:9100,http://10.0.0.5:9100
```

The server also auto-allows any origin on the same port (same-origin requests from the dashboard UI).

## LLM Provider Setup

Configure one of the supported AI providers via environment variables:

```yaml
# Ollama (local, recommended for Docker — use host.docker.internal to reach host)
environment:
  - POCKET_IT_LLM_PROVIDER=ollama
  - POCKET_IT_OLLAMA_URL=http://host.docker.internal:11434

# OpenAI
environment:
  - POCKET_IT_LLM_PROVIDER=openai
  - POCKET_IT_OPENAI_API_KEY=sk-...

# Anthropic
environment:
  - POCKET_IT_LLM_PROVIDER=anthropic
  - POCKET_IT_ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
environment:
  - POCKET_IT_LLM_PROVIDER=gemini
  - POCKET_IT_GEMINI_API_KEY=...
```

## Docker Limitations

The following features are disabled when `POCKET_IT_DOCKER=true`:

- Git-based auto-update detection (no git binary in container)
- Per-client installer generation (requires .NET SDK)
- Server self-update via `wrapper.js` restart
- Release ZIP registration from git

## Health Check

```bash
curl http://localhost:9100/health
# {"status":"ok","service":"pocket-it"}
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| CSS/JS fails with `ERR_SSL_PROTOCOL_ERROR` | Helmet `upgrade-insecure-requests` on an HTTP deployment | Fixed in v0.19.0+ |
| CORS "Not allowed" errors | Origin not in the whitelist | Set `POCKET_IT_CORS_ORIGINS` |
| "Invalid credentials" after rebuild | `seed-admin.js` wrote to wrong DB path | Fixed in v0.19.0+ (uses `DATA_DIR`) |
| Container recreate `ContainerConfig` KeyError | docker-compose v1 bug | Run `docker stop pocket-it && docker rm pocket-it` first, then `docker-compose up` |
