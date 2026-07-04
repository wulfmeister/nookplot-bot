# Changelog

> Historical journal of the original operator's agent. Kept because the
> reasoning behind each change is often more useful than the change itself.
> Earlier passes of the same journal live in the back half of AGENTS.md.

## 2026-06-23–25 — builder-dimension experiments (exec/collab) + Path C bounties

Pushed on the three zeroed-but-earnable surfaces, instrumented everything, and
got clean (mostly negative) answers.

- **Verify cap 30 → 38** (`BOT_VERIFY_DAILY_CAP`, `index.ts`). We were self-capping
  below the gateway's shared verify+crowd-jury budget while crowd-jury is dormant —
  ~8 slots idled/day. `canVerifyNow()` still hard-stops at the gateway cap.
- **Path C — bounties, now human-gated** (`src/bounty-review.ts`, `npm run bounties`).
  Replaced the old blind `BOT_BOUNTY_AUTO_APPLY` (now `0`) with a preview→approve
  queue mirroring Path A/B (`BOT_BOUNTY_REVIEW_AUTO/SUBMIT`, ≤1/day). Pure ranking
  core (`rankBounties`) is tested. Native supply is thin (mostly external Immunefi),
  so it often surfaces nothing — correct.
- **collab gate persisted** (`BOT_PEER_REVIEW_SUBMIT=1` in `.env`) so an approved
  review actually lands on-chain (previously needed an inline env var).
- **exec experiment** (`BOT_VERIFY_ARTIFACTS=1`). The standard verify loop *skips*
  code submissions → that's why `artifactReruns` was 0. Added a flag-gated path for
  `python_tests`/`javascript_tests`/`replication`: comprehension → `inspect_submission_artifact`
  → **`rerun_submission_artifact`** (the `exec` lever) → grade → verify, with rerunnable
  subs front-loaded + threshold-exempt so the experiment generates data. The standard
  path is byte-identical with the flag off. Kind logic extracted to `verify-kinds.ts` (tested).
  - The rerun's `outcomesMatch` drives correctness via `decideFromRerun` (tested):
    reproduced→1.0, mismatch→**abstain** (don't vouch), no signal→submit-time-gate 1.0.
  - The older `BOT_EXEC_SCORING_AUTO` in-project re-run tick (`projects.ts`) is kept as a
    control — its gateway response carries no attribution and `exec` never moved.
- **Instrumentation**: `~/.nookplot/dimension-watch.jsonl` (30-min snapshots of the 5
  builder dims + rerun count), `/api/experiments` endpoint, and the **Reputation
  experiments** dashboard tile (exec/collab, rerun match-rate, abstains, reviews-given,
  verdict). Rerun log/audit now records `original`/`rerun` outcomes to diagnose mismatches.

**Findings (the point of the exercise):**
- `exec` = re-running *others'* verifiable artifacts (only ~33% of top agents have it),
  **not** our own `exec_code`. But **15/15 reruns with a signal returned `match=false`**
  (artifacts don't reproduce on our rerun) → we abstain on all → `artifactReruns`/`exec`
  stay 0. Looks like a systematic rerun-env mismatch; exec is **blocked**, not slow.
- `collab` = cross-agent work; near-universal among top agents yet 0 for us despite our
  own projects. 2 `comment` reviews on-chain didn't move it → comment verdicts likely
  don't score; **MRs (Path B2) are the probable lever**.

Shipped this window: **4th project** on-chain (a directory-traversal safe-path
resolver, security/CWE-22, 274 lines) and a **2nd peer review** (`comment`). Tests **286 → 299**;
`tsc` clean.

## 2026-06-22 — first on-chain project (builder reputation) + Path A code rebuild

Closed the reputation gap's root cause: we now ship **code projects** (the
network norm — ~89% of live projects are `main.py`+`test_main.py`+`README.md`,
incl. the "W##-research" series), not notes.

- **Path A rebuilt to code+tests** (`src/projects.ts`). Each draft is a tested
  reference implementation grounded in a vault-note cluster. The anti-slop gate
  is now **execution**: the candidate's own `unittest` suite must pass in a clean
  `python:3.12-slim` sandbox (`python test_main.py` → exit 0) or it's never
  queued. stdlib-only, ≥4 assertions, one auto-repair attempt.
- **First project published on-chain**: a Python docstring-coverage analyzer
  (`main.py`+`test_main.py`+`README.md`, 8 passing tests, +334 lines), via the
  human-in-the-loop review flow (draft → peer comparison → approve).
- **Dashboard**: new `📦 Our published projects` card + `/api/my-projects`
  (live commits / reviewStatus / lines / files per owned project).

### How to submit a project (and the gotchas we hit)

```
npm run projects -- review                       # see the pending draft + peer comparison
BOT_PROJECTS_SUBMIT=1 npm run projects -- submit <slug>   # create_project → commit_files (on-chain, confirm-gated)
```

Gotchas, all now handled in code:
1. **`BOT_PROJECTS_SUBMIT=1` is required** (a deliberate second gate beyond the
   review queue); the CLI also prompts `[y/N]`.
2. **Stray `__pycache__/`** — running the tests locally during review leaves a
   `__pycache__` *directory* in the draft folder; the submit tried to
   `readFileSync` it → `EISDIR`. Fixed: only commit regular files, skipping
   `_`/`.`-prefixed names and directories.
3. **create→commit race** — `create_project` returns, but `commit_files` can
   briefly 404 `"Project not found"` while the on-chain create propagates. Fixed:
   retry `commit_files` on "not found" for ~12s.
4. **exists-vs-queued disambiguation** — `list_project_files(<id>)` returns
   `{files:[]}` for a real-but-empty project, and errors `"Project not found"` for
   a fake id; calibrate against a fake id to tell "created" from "doesn't exist".
   (In autonomous/SDK mode `create_project` *can* instead queue for dashboard
   owner-approval — check `proactive.getPendingApprovals()` if a project never
   appears.)
5. **Reputation recompute lag** — the score ticks immediately (13,500→13,613,
   vel 1.20→1.21) but the dimensional breakdown (`commits/projects/lines/exec`)
   updates on a periodic recompute; don't expect it instantly.
6. **`list_projects` search lag** — a just-created project isn't searchable for a
   while; fetch it by id via `list_project_commits`/`list_project_files` or find
   it on `get_frontiers`.

## 2026-06-20 — runtime 0.5.145 upgrade + new earning surfaces

Audited the bot against `@nookplot/runtime` 0.5.145 from first principles, then
shipped the API updates and earning opportunities it surfaced.

### Part 1 — API updates / fixes

- **Bumped `@nookplot/runtime` 0.5.142 → 0.5.145.** No breaking changes (the
  removed `frontierInference` / `api_*` actions weren't used; the bot reaches the
  gateway via raw REST + `runtime.tools.executeTool`). Typecheck + smoke + tests pass.
- **Swarm heartbeat cadence 30 min → 2 min** (`index.ts`, `swarms.ts`). 0.5.145
  reassigns a claimed subtask after `claim_timeout_seconds` (≈5 min) unless
  heartbeated every 2–5 min — the old 30-min cadence silently lost every claim.
  Override with `BOT_SWARM_HEARTBEAT_MS`.
- **Mining now gates verifiable submits on the real grader sandbox**
  (`mining.ts`, `mining-sandbox.ts`). `python_tests` candidates run through
  `sandbox_test_code` (the actual grader env, 18/hr-budgeted) before submission; a
  hard compile/import failure **skips the submit to preserve the scarce epoch slot**
  and is logged as a *retryable* `error` (not a permanent `skipped`), so a later
  attempt can still win the challenge. Unsupported/rate-limited cases fall back to
  the legacy `/v1/exec` smoke (annotate-only). Previously it submitted even on a
  known-failing smoke test, burning a ~10–20k-NOOK slot.

### Part 2 — new earning surfaces

Each new track is built on `runtime.tools.executeTool` (the SDK owns the
request/response contract) and is **liveness-gated**: while the gateway returns
"Endpoint does not exist" the module is a logged no-op, so nothing fires
speculatively. Activation is opt-in per the existing `BOT_*_AUTO` convention.

- **`src/forge.ts` (LIVE today).** Forge presets — load curated knowledge into
  memory at 5% of external rate via the SDK `PresetLoader` (idempotent,
  cost-capped). `npm run forge` lists presets + live estimates (free); `load <slug>`
  spends NOOK (confirm-gated); opt-in boot hook `BOT_FORGE_PRESET` + `BOT_FORGE_MAX_NOOK`.
- **`src/aggregation.ts` (dormant — endpoint not deployed).** Tier-3 aggregation
  mining: LLM-synthesize `KnowledgeAggregateV1` from source traces → `submit_aggregation`
  (miner 50%; 2/day). Flag `BOT_AGGREGATION_AUTO=1`.
- **`src/embedding-mining.ts` (dormant + needs Ollama).** Tier-1 embedding mining:
  local `nomic-embed-text` → 768-dim → `submit_embeddings` (consensus cosine>0.95).
  Flag `BOT_EMBEDDING_AUTO=1`.
- **`src/api-marketplace-sell.ts` (dormant — actions not deployed).** List a metered
  API via `api_onboard` + 60s heartbeat; `report_endpoint_status` remediation. Flag
  `BOT_API_ONBOARD_AUTO=1` + `BOT_API_LISTING_{TITLE,DESC,URL}`.
- **`src/earning-surfaces.ts`.** Liveness watcher (`npm run surfaces`, 6h tick) that
  probes the three dormant tracks via correct MCP dispatch, persists state, and
  shouts the moment any flips live — the cue to set its flag. Supersedes
  `forge-watch.ts` (which guessed REST paths and misreported).

Gateway liveness verified 2026-06-20 (`GET /v1`): forge LIVE; aggregation,
embedding, and api-marketplace-sell endpoints not deployed.

### Code-review fixes (post-review hardening)

A review of the above surfaced six items; all fixed:

1. **Heartbeat could grow unbounded** (`swarms.ts`). `heartbeatHeldSubtasks` polled
   *every* historically-claimed-but-unsubmitted id forever — and the 30m→2m change
   would have amplified that waste 15×. Now bounded: only ids claimed within
   `BOT_SWARM_HEARTBEAT_WINDOW_MS` (default 90 min), and a terminal heartbeat error
   (404/409/410/"reassigned"/…) records `heartbeat-dead` so a lost claim is polled
   once, not forever. Transient 5xx/network errors still retry.
2. **Embedding task prefix** (`embedding-mining.ts`). nomic-embed-text vectors differ
   with/without an instruction prefix, and consensus needs all miners to agree on the
   convention. Now applies `NOOK_EMBED_PREFIX` (default `"search_document: "`) with a
   prominent note to confirm against the spec at go-live.
3. **Embedding dup-check widened** (`embedding-mining.ts`). Duplicate detection hashed
   only the first 8 dims (could false-flag distinct vectors). Now an FNV-1a hash over
   all 768 dims.
4. **Aggregation dropped web search** (`aggregation.ts`). `submit_aggregation` is graded
   on verbatim-overlap + provenance grounding, so synthesis must derive only from the
   provided traces; external content risked failing those checks.
5. **`priceAmount` units documented** (`api-marketplace-sell.ts`). Clarified it's a decimal
   string in the listing's quote token (USDC by default) and the default is a placeholder
   to set deliberately before onboarding.
6. **Dropped boot-test artifacts.** Reverted `OBSERVATIONS.md` / `observations/2026-06-20.md`
   (bot-generated during smoke tests, not intended changes).

Tests: 286 pass (added coverage for `validateVectors`, `isWellFormed`, the dup-key
regression, and `isTerminalHeartbeatError`).
