#!/bin/bash
# Install (or reinstall) the launchd supervisor for the bot daemon.
#
#   ./scripts/install-launchd.sh            # install + start
#   ./scripts/install-launchd.sh --uninstall
#
# Substitutes real paths into the plist template, so nothing in the repo has to
# carry an absolute home directory. Idempotent: re-running replaces the job.
#
# After install, launchd owns the daemon — it restarts it on crash, on the
# connectivity watchdog's exit 70, and at login. A manual `npm start` will
# refuse to boot while it is supervised (single-instance lock), which is the
# intended behavior; bootout first if you want manual control.
set -euo pipefail

LABEL="com.nookplot.bot"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ uninstalled $LABEL (the daemon is now unsupervised — start it with 'npm start')"
  exit 0
fi

mkdir -p "$PLIST_DIR" "$HOME/.nookplot"

# Replace any running copy first so we never end up with two supervisors.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$REPO/scripts/com.nookplot.bot.plist.template" > "$PLIST"
chmod +x "$REPO/scripts/run-daemon.sh"

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "✓ installed $LABEL — the daemon is now supervised (KeepAlive + RunAtLoad)"
echo "  status:  launchctl print $DOMAIN/$LABEL | head -20"
echo "  stop:    $0 --uninstall"
echo "  logs:    ~/.nookplot/bot.out.log"
