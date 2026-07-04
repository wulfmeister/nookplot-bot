#!/usr/bin/env bash
#
# install-tunnel.sh — one-command setup for the bot's optional public webhook tunnel.
#
# Detects the OS, installs cloudflared (preferred) or falls back to ngrok if
# already installed, and prints next steps. Idempotent: re-running on a
# machine where the binary is already present prints "already installed" and
# exits cleanly.
#
# After install, set BOT_TUNNEL_AUTOSPAWN=1 in .env and restart the bot —
# the daemon will then spawn the tunnel on every start and capture the
# public URL into BOT_WEBHOOK_URL in-process.
#
# Security note: a tunnel exposes your dashboard publicly. ALWAYS set
# WEB_AUTH_TOKEN to a random string before enabling the tunnel.
#

set -euo pipefail

PURPLE='\033[0;35m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { printf "${PURPLE}→${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
fail()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }

if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared already installed: $(command -v cloudflared)"
  cloudflared --version | head -1
  EXISTING=1
elif command -v ngrok >/dev/null 2>&1; then
  warn "cloudflared not found, but ngrok IS installed: $(command -v ngrok)"
  warn "The bot will auto-detect ngrok and use it. No action needed."
  EXISTING=1
else
  EXISTING=0
fi

if [[ "${EXISTING}" == "0" ]]; then
  OS=$(uname -s)
  ARCH=$(uname -m)
  info "Installing cloudflared for ${OS}/${ARCH}…"

  case "${OS}" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install cloudflared
      else
        fail "Homebrew not found. Install brew first (https://brew.sh) or grab the macOS binary from https://github.com/cloudflare/cloudflared/releases"
      fi
      ;;
    Linux)
      DEB="cloudflared-linux-amd64.deb"
      if [[ "${ARCH}" == "aarch64" || "${ARCH}" == "arm64" ]]; then
        DEB="cloudflared-linux-arm64.deb"
      fi
      info "Downloading ${DEB}…"
      curl -fsSL -o /tmp/${DEB} "https://github.com/cloudflare/cloudflared/releases/latest/download/${DEB}"
      if command -v dpkg >/dev/null 2>&1; then
        sudo dpkg -i /tmp/${DEB}
      else
        fail "dpkg not found. For non-debian Linux see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/installation/"
      fi
      ;;
    *)
      fail "Unsupported OS: ${OS}. See https://github.com/cloudflare/cloudflared/releases"
      ;;
  esac
  ok "cloudflared installed: $(command -v cloudflared)"
fi

echo
info "Next steps:"
cat <<EOF
  1. Set in your .env:
       BOT_TUNNEL_AUTOSPAWN=1
       WEB_AUTH_TOKEN=$(openssl rand -hex 16)    # ←  REQUIRED: tunnel exposes dashboard publicly
  2. Restart the bot (npm start) — it will spawn the tunnel automatically.
  3. The public URL will appear in the bot log as:  📡 tunnel UP via cloudflared: https://…
  4. The dashboard at that URL will require the WEB_AUTH_TOKEN bearer header.
EOF
ok "Done."
