#!/bin/bash
# Daemon entrypoint for the launchd supervisor (com.nookplot.bot).
#
# Why a wrapper: launchd needs an absolute, login-shell-independent command and
# inherits none of the PATH a normal shell provides. Keep this dumb —
# supervision policy lives in the plist, not here.
#
# The repo path is derived from this script's own location, so the file is
# checkout-independent (no absolute paths baked in).
#
# The daemon holds a single-instance lock (~/.nookplot/bot.pid), so a manual
# `npm start` while launchd is supervising refuses to boot rather than doubling
# up. To take manual control, bootout the job first:
#   launchctl bootout gui/$(id -u)/com.nookplot.bot
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

exec npm start
