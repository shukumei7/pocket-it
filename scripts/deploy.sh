#!/usr/bin/env bash
# deploy.sh — Deploy Pocket IT server to a remote Docker host
#
# Usage:
#   ./scripts/deploy.sh [remote] [options]
#
#   remote              SSH target (default: brownstone@100.120.23.109)
#
# Options:
#   --skip-bootstrapper   Skip building and committing the bootstrapper EXE
#   --skip-client-zip     Skip building and committing the client ZIP
#   --help                Show this message
#
# First-time remote setup:
#   ssh user@host "apt-get install -y git-lfs && cd ~/pocket-it && git lfs install && git lfs pull"
#
# Prerequisites:
#   - SSH access to remote (key-based recommended)
#   - dotnet SDK installed locally (for bootstrapper build)
#   - Remote has docker + docker-compose and ~/pocket-it/ checked out with git lfs installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE="${1:-brownstone@100.120.23.109}"
REMOTE_DIR="~/pocket-it"
BUILD_BOOTSTRAPPER=true
BUILD_CLIENT_ZIP=true

# Parse flags
for arg in "$@"; do
  case $arg in
    --skip-bootstrapper) BUILD_BOOTSTRAPPER=false ;;
    --skip-client-zip)   BUILD_CLIENT_ZIP=false ;;
    --help)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0 ;;
  esac
done

echo "==> Deploying Pocket IT to $REMOTE"
echo ""

BOOTSTRAPPER_CSPROJ="$PROJECT_ROOT/installer/online/PocketIT.Setup/PocketIT.Setup.csproj"
BOOTSTRAPPER_BUILD="$PROJECT_ROOT/installer/online/PocketIT.Setup/bin/Release/net8.0-windows/win-x64/publish/PocketIT.Setup.exe"
BOOTSTRAPPER_DEST="$PROJECT_ROOT/installer/PocketIT.Setup.exe"
CLIENT_ZIP_SRC="$PROJECT_ROOT/releases/PocketIT-latest.zip"
COMMITTED=false

# ── 1. Build + commit bootstrapper EXE ───────────────────────────────────────
if [ "$BUILD_BOOTSTRAPPER" = true ]; then
  if [ -f "$BOOTSTRAPPER_CSPROJ" ]; then
    echo "[1/3] Building online installer bootstrapper..."
    dotnet publish "$BOOTSTRAPPER_CSPROJ" \
      -c Release -r win-x64 --self-contained \
      -p:PublishSingleFile=true \
      -p:IncludeNativeLibrariesForSelfExtract=true \
      --nologo -v quiet
    cp "$BOOTSTRAPPER_BUILD" "$BOOTSTRAPPER_DEST"
    SIZE=$(python3 -c "import os; s=os.path.getsize('$BOOTSTRAPPER_DEST'); print(f'{s//1024//1024} MB')" 2>/dev/null || echo "?")
    echo "      Built ($SIZE) → installer/PocketIT.Setup.exe"
    COMMITTED=true
  else
    echo "[1/3] Bootstrapper project not found — skipping"
    BUILD_BOOTSTRAPPER=false
  fi
else
  echo "[1/3] Bootstrapper build skipped"
fi

# Commit and push LFS files if any were updated
if [ "$COMMITTED" = true ]; then
  echo "      Committing LFS files and pushing..."
  git -C "$PROJECT_ROOT" add installer/PocketIT.Setup.exe
  [ "$BUILD_CLIENT_ZIP" = true ] && [ -f "$CLIENT_ZIP_SRC" ] && git -C "$PROJECT_ROOT" add releases/PocketIT-latest.zip
  git -C "$PROJECT_ROOT" diff --cached --quiet || \
    git -C "$PROJECT_ROOT" commit -m "chore: update release binaries (LFS)" --no-verify
  git -C "$PROJECT_ROOT" push
  # Prune old LFS objects locally (keeps last 2 versions per .lfsconfig)
  git -C "$PROJECT_ROOT" lfs prune --verify-remote
  echo "      Pushed and pruned old LFS objects"
fi

# ── 2. Deploy server (git pull + docker rebuild) ─────────────────────────────
echo "[2/3] Deploying to remote (git pull + docker rebuild)..."
ssh "$REMOTE" "cd $REMOTE_DIR && git pull && docker-compose up --build -d"
echo "      Container restarted"

# ── 3. Health check ───────────────────────────────────────────────────────────
echo "[3/3] Health check..."
sleep 3
REMOTE_HOST=$(echo "$REMOTE" | cut -d@ -f2)
curl -s --max-time 10 "http://$REMOTE_HOST:9100/health" && echo "" || echo "  (health check failed — server may still be starting)"

echo ""
echo "==> Done!"
