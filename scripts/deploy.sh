#!/usr/bin/env bash
# deploy.sh — Deploy Pocket IT server to a remote Docker host
#
# Usage:
#   ./scripts/deploy.sh [remote] [options]
#
#   remote          SSH target, e.g. user@192.168.1.10  (default: brownstone@100.120.23.109)
#
# Options:
#   --no-bootstrapper   Skip building and pushing the online installer bootstrapper
#   --no-client-zip     Skip pushing the client release ZIP
#   --bootstrapper-only Just build and push the bootstrapper EXE (no docker deploy)
#   --help              Show this message
#
# Prerequisites:
#   - SSH access to remote (key-based recommended)
#   - dotnet SDK installed locally (for bootstrapper build)
#   - Remote has docker + docker-compose and ~/pocket-it/ checked out

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE="${1:-brownstone@100.120.23.109}"
REMOTE_DIR="~/pocket-it"
BUILD_BOOTSTRAPPER=true
PUSH_CLIENT_ZIP=true
DEPLOY_SERVER=true

# Parse flags
for arg in "$@"; do
  case $arg in
    --no-bootstrapper)   BUILD_BOOTSTRAPPER=false ;;
    --no-client-zip)     PUSH_CLIENT_ZIP=false ;;
    --bootstrapper-only) DEPLOY_SERVER=false; PUSH_CLIENT_ZIP=false ;;
    --help)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0 ;;
  esac
done

echo "==> Deploying Pocket IT to $REMOTE"
echo ""

# ── 1. Build bootstrapper EXE ────────────────────────────────────────────────
BOOTSTRAPPER_CSPROJ="$PROJECT_ROOT/installer/online/PocketIT.Setup/PocketIT.Setup.csproj"
BOOTSTRAPPER_EXE="$PROJECT_ROOT/installer/online/PocketIT.Setup/bin/Release/net8.0-windows/win-x64/publish/PocketIT.Setup.exe"
REMOTE_INSTALLER_DIR="$REMOTE_DIR/installer"

if [ "$BUILD_BOOTSTRAPPER" = true ]; then
  if [ -f "$BOOTSTRAPPER_CSPROJ" ]; then
    echo "[1/4] Building online installer bootstrapper..."
    dotnet publish "$BOOTSTRAPPER_CSPROJ" \
      -c Release -r win-x64 --self-contained \
      -p:PublishSingleFile=true \
      -p:IncludeNativeLibrariesForSelfExtract=true \
      --nologo -v quiet
    echo "      Built: $BOOTSTRAPPER_EXE"
  else
    echo "[1/4] Bootstrapper project not found — skipping EXE build"
    BUILD_BOOTSTRAPPER=false
  fi
else
  echo "[1/4] Bootstrapper build skipped"
fi

# ── 2. Deploy server (git pull + docker rebuild) ─────────────────────────────
if [ "$DEPLOY_SERVER" = true ]; then
  echo "[2/4] Pulling latest code and rebuilding container..."
  ssh "$REMOTE" "cd $REMOTE_DIR && git pull && docker-compose up --build -d"
  echo "      Container restarted"
else
  echo "[2/4] Server deploy skipped"
fi

# ── 3. Push client release ZIP ───────────────────────────────────────────────
CLIENT_ZIP="$PROJECT_ROOT/releases/PocketIT-latest.zip"

if [ "$PUSH_CLIENT_ZIP" = true ] && [ -f "$CLIENT_ZIP" ]; then
  ZIP_SIZE=$(python3 -c "import os; s=os.path.getsize('$CLIENT_ZIP'); print(f'{s//1024//1024} MB')" 2>/dev/null || echo "?")
  echo "[3/4] Pushing client ZIP ($ZIP_SIZE)..."
  ssh "$REMOTE" "mkdir -p $REMOTE_DIR/releases"
  scp "$CLIENT_ZIP" "$REMOTE:$REMOTE_DIR/releases/PocketIT-latest.zip"
  echo "      Pushed releases/PocketIT-latest.zip"
else
  echo "[3/4] Client ZIP push skipped"
fi

# ── 4. Push bootstrapper EXE ─────────────────────────────────────────────────
if [ "$BUILD_BOOTSTRAPPER" = true ] && [ -f "$BOOTSTRAPPER_EXE" ]; then
  EXE_SIZE=$(python3 -c "import os; s=os.path.getsize('$BOOTSTRAPPER_EXE'); print(f'{s//1024//1024} MB')" 2>/dev/null || echo "?")
  echo "[4/4] Pushing bootstrapper EXE ($EXE_SIZE) to installer/PocketIT.Setup.exe..."
  ssh "$REMOTE" "mkdir -p $REMOTE_DIR/installer"
  scp "$BOOTSTRAPPER_EXE" "$REMOTE:$REMOTE_DIR/installer/PocketIT.Setup.exe"
  echo "      Pushed installer/PocketIT.Setup.exe"
else
  echo "[4/4] Bootstrapper EXE push skipped"
fi

echo ""
echo "==> Done! Server health check:"
curl -s --max-time 5 "http://$(echo $REMOTE | cut -d@ -f2):9100/health" 2>/dev/null && echo "" || echo "  (health check failed — server may still be starting)"
