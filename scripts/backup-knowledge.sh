#!/usr/bin/env bash
#
# Snapshot the bot's generated knowledge into the dedicated backup repo and push
# it off-machine. The bot writes knowledge-vault/, observations/ and
# OBSERVATIONS.md into the code repo (gitignored there); only ~13% of posts are
# published on-chain, so the bulk lives only on local disk. This mirrors it to a
# separate VERSIONED repo of your choosing so the knowledge has a durable,
# off-machine home that doesn't pollute code history.
#
# Idempotent: commits + pushes only when something changed. The local commit
# always lands even if the push fails (e.g. no network), and the next run
# retries the push. Run via `npm run backup:knowledge` or on a schedule.
#
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# SRC is this repo (script-relative); DST comes from KNOWLEDGE_BACKUP_DST
# (env or .env) — a local clone of YOUR private backup repo.
SRC="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${KNOWLEDGE_BACKUP_DST:-}" ] && [ -f "$SRC/.env" ]; then
  KNOWLEDGE_BACKUP_DST="$(grep -E '^KNOWLEDGE_BACKUP_DST=' "$SRC/.env" | cut -d= -f2-)"
fi
DST="${KNOWLEDGE_BACKUP_DST:-}"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "$DST" ]; then
  echo "[$(ts)] knowledge backup: KNOWLEDGE_BACKUP_DST not set — skipping (set it in .env to a local clone of your private backup repo)" >&2
  exit 0
fi
if [ ! -d "$DST/.git" ]; then
  echo "[$(ts)] ERROR: backup repo not found at $DST (clone your backup repo there first)" >&2
  exit 1
fi

# Mirror the generated dirs (delete keeps the backup in lockstep with source).
rsync -a --delete "$SRC/knowledge-vault" "$SRC/observations" "$DST/" 2>/dev/null
cp -f "$SRC/OBSERVATIONS.md" "$DST/OBSERVATIONS.md" 2>/dev/null || true

cd "$DST" || exit 1
git add -A
if git diff --cached --quiet; then
  echo "[$(ts)] knowledge backup: no changes"
  exit 0
fi

n=$(git diff --cached --numstat | wc -l | tr -d ' ')
git commit -q -m "knowledge snapshot $(ts) ($n files changed)"
echo "[$(ts)] knowledge backup: committed $n changed file(s)"

if git push -q origin main 2>/dev/null; then
  echo "[$(ts)] knowledge backup: pushed to origin"
else
  echo "[$(ts)] knowledge backup: push FAILED (committed locally; will retry next run)" >&2
fi
