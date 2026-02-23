# Brownstone Server Setup (192.168.3.248 / slave248)

Reference document for duplicating the brownstone production server environment.

## Server Info

| Property | Value |
|----------|-------|
| Hostname | slave248 |
| LAN IP | 192.168.3.248 |
| Tailscale IP | 100.120.23.109 |
| OS | Ubuntu 24.04.1 LTS (kernel 6.8.0-100-generic) |
| Arch | x86_64 |
| Docker | 28.2.2 |
| SSH user | brownstone |

## Directory Layout

```
~/
├── pocket-it/                  # pocket-it app repo (git clone)
│   ├── docker-compose.yml      # builds + runs pocket-it container
│   ├── Dockerfile
│   ├── data/                   # persistent volume (db, uploads) — NOT in git
│   ├── releases/               # installer release packages
│   └── installer/              # installer scripts
│
├── tailscale/                  # nginx + tailscale stack
│   ├── docker-compose.yaml
│   ├── nginx.conf              # nginx reverse proxy config
│   ├── certs/                  # SSL certs (manually issued CA or LE)
│   │   ├── pocket-it.app.crt
│   │   └── pocket-it.app.key
│   ├── webroot/                # ACME http-01 challenge dir
│   └── tailscale-249/state/    # tailscale state for 249 node
│
└── cloudflared-config/         # Cloudflare Tunnel local config
    ├── config.yml
    └── creds.json
```

## Running Services

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `pocket-it` | built from `~/pocket-it/Dockerfile` | 9100 | pocket-it Node.js app |
| `tailscale` | `tailscale/tailscale:latest` | — | Tailscale VPN (host network) |
| `tailscale-nginx-1` | `nginx` | 80, 443 | SSL reverse proxy (host network) |
| `cloudflared` | `cloudflare/cloudflared:latest` | — | Cloudflare Tunnel (host network) |

## pocket-it Stack (`~/pocket-it/`)

Started with:
```bash
cd ~/pocket-it
docker compose up -d --build
```

Key docker-compose.yml settings:
- `restart: unless-stopped` — auto-restarts on crash or reboot
- `ports: "9100:9100"` — bridge-mode, exposes to host
- Volume `./data:/app/data` — persistent DB and uploads
- Volume `/var/run/docker.sock` — allows self-rebuild on update
- CMD: `node wrapper.js` — wrapper catches exit code 75 to hot-restart on updates

Environment variables (set in docker-compose.yml or `.env`):
```
POCKET_IT_PORT=9100
POCKET_IT_DOCKER=true
POCKET_IT_REPO_DIR=/app/repo
POCKET_IT_COMPOSE_SERVICE=pocket-it
# LLM provider (uncomment one):
# POCKET_IT_LLM_PROVIDER=ollama|openai|anthropic|gemini
# POCKET_IT_LLM_PROVIDER=anthropic
# POCKET_IT_ANTHROPIC_API_KEY=sk-ant-...
```

## nginx + Tailscale Stack (`~/tailscale/`)

Started with:
```bash
cd ~/tailscale
docker compose up -d
```

**nginx.conf** handles:
- `pocket-it.app` / `www.pocket-it.app` — HTTP→HTTPS redirect, HTTPS proxy to `127.0.0.1:9100`
- ACME challenge served from `~/tailscale/webroot/`
- WebSocket support via `Connection: upgrade` map

**SSL certs** for pocket-it.app:
- Stored at `~/tailscale/certs/pocket-it.app.crt` + `.key`
- Issued as a CA-signed cert (not Let's Encrypt)
- For Let's Encrypt renewal: certs land in `/etc/letsencrypt/live/` — already mounted into nginx container

**Tailscale** node:
- `TS_AUTHKEY` in docker-compose.yaml — re-auth when expired
- State persisted to `~/tailscale/tailscale-249/state/`

## Cloudflare Tunnel (`cloudflared`)

Tunnel ID: `e0617d9a-d320-4fa5-9513-fe3622bfb394`

Started with:
```bash
docker run -d \
  --name cloudflared \
  --restart unless-stopped \
  --network host \
  -v ~/cloudflared-config/creds.json:/etc/cloudflared/creds.json:ro \
  -v ~/cloudflared-config/config.yml:/etc/cloudflared/config.yml:ro \
  cloudflare/cloudflared:latest \
  tunnel --config /etc/cloudflared/config.yml run
```

`~/cloudflared-config/config.yml`:
```yaml
tunnel: e0617d9a-d320-4fa5-9513-fe3622bfb394
credentials-file: /etc/cloudflared/creds.json
ingress:
  - hostname: pocket-it.app
    service: http://localhost:9100
  - service: http_status:404
```

`~/cloudflared-config/creds.json`:
```json
{"AccountTag":"<account-tag>","TunnelID":"e0617d9a-d320-4fa5-9513-fe3622bfb394","TunnelSecret":"<secret>"}
```
> Credentials come from the Cloudflare Zero Trust dashboard → Tunnels → tunnel token (base64-decoded JWT with keys `a`, `t`, `s`).

**Important**: This tunnel is **remotely managed** (created via dashboard). The Cloudflare dashboard must have the public hostname configured with **HTTP** (not HTTPS) for `pocket-it.app → localhost:9100`. The local `config.yml` is overridden by dashboard config for ingress rules — the service type must match in both places.

## Network / Firewall

- Router forwards ports 80 and 443 to `192.168.3.248`
- `192.168.3.249` (separate host) runs Apache for batinc.work — different machine
- UFW installed but not blocking (traffic allowed through)
- Cloudflare Tunnel bypasses NAT entirely — no port forwarding needed for tunnel traffic

## Replication Checklist (New Server)

1. Install Docker: `apt install docker.io docker-compose`
2. Clone pocket-it repo: `git clone git@github.com:shukumei7/pocket-it.git ~/pocket-it`
3. Build and start pocket-it: `cd ~/pocket-it && docker compose up -d --build`
4. Set up tailscale + nginx:
   ```bash
   mkdir ~/tailscale && cd ~/tailscale
   # copy docker-compose.yaml and nginx.conf from this repo's deploy/ dir
   mkdir certs webroot
   # copy SSL certs into certs/
   docker compose up -d
   ```
5. Create Cloudflare Tunnel in Zero Trust dashboard, get tunnel token
6. Decode token: `echo "<token>" | base64 -d` → extract `a`, `t`, `s` fields
7. Create `~/cloudflared-config/creds.json` with AccountTag, TunnelID, TunnelSecret
8. Create `~/cloudflared-config/config.yml` with HTTP service URL
9. Start cloudflared: `docker run -d --name cloudflared --restart unless-stopped --network host -v ~/cloudflared-config/creds.json:/etc/cloudflared/creds.json:ro -v ~/cloudflared-config/config.yml:/etc/cloudflared/config.yml:ro cloudflare/cloudflared:latest tunnel --config /etc/cloudflared/config.yml run`
10. In Cloudflare dashboard: confirm public hostname type is **HTTP** (not HTTPS) → `localhost:9100`
11. Point DNS CNAME for domain to tunnel (Cloudflare manages this automatically)
