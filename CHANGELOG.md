# Changelog

> Historical journal of the original operator's agent. Kept because the
> reasoning behind each change is often more useful than the change itself.
> Earlier passes of the same journal live in the back half of AGENTS.md.

## 2026-08-05 — the fixes a dead session left behind

The 07-31 overnight review (12 agents) root-caused the 27.9h verify blackout:
~86% of the pool is farm spam we rightly abstain on, **plus** two bugs of our
own. The session died mid-turn before applying either fix, and the findings sat
in a tmp file for five days (now preserved at
`~/.nookplot/reports/2026-07-31-overnight-review-12agent.json`). Applied today:

- **Own-challenge submissions were filtered too late.** The guard lived inside
  `verifyOneSubmission`, *after* batch selection — so when our own posts
  dominated the pool (self-amplified by the 07-30 rescue/expert changes raising
  posting to 3-4/day), every batch slot went to a no-op skip: 68 skips across
  11 consecutive polls, zero verify attempts. Own-challenge subs are now
  excluded at poll selection (with a count log); the in-function guard stays as
  a backstop for the artifact path.
- **The 70s pacing sleep was unconditional.** Every no-op skip still cost 70s
  of the verify loop's budget. `verifyOneSubmission` now reports whether it
  actually did gateway work, and the sleep is only paid when it did.
- **`verifier_unavailable` was read as a real mismatch.** The gateway reports a
  down runner as a *completed* rerun (`outcomesMatch=false`,
  `rerunOutcome={pass:false, kind_specific:{reason:"verifier_unavailable"}}`),
  which took `decideFromRerun`'s abstain branch — 8/8 of the window's
  match=false results were this shape, so BOT_VERIFY_ARTIFACTS starved whenever
  the gateway's runner was down (and the flag front-loads exactly that path).
  The infra reason now routes to the existing inconclusive fallback (verify at
  1.0 from the submit-time gate). Genuine non-reproductions still abstain.

Not applied (flagged for a decision): the same review found the artifact path
double-records traces into the near-dupe cache (`recordTraceSeen` at both the
standard and artifact call sites), self-poisoning at least one clean submission
into a "100% near-dupe" abstain. Left alone today because it wasn't in the
approved scope; it deserves its own look.

## 2026-07-28–30 — a 53h blackout, three self-inflicted bugs, and one loop that never worked

A week of finding things that were quietly broken rather than adding features.
The recurring lesson: **a metric that cannot go down is worse than no metric**,
and **liveness is not earning**.

- **53-hour earning blackout (07-25 22:57Z → 07-28 reboot).** The host's network
  stack wedged. The daemon stayed alive, kept every loop ticking, and wrote a
  structurally valid all-zero snapshot every 30 minutes — so freshness checks
  passed and the dashboard badge stayed green while we earned nothing. Cost
  ~1.1M NOOK, ~43% of it the posting royalty (which does NOT accumulate; a
  missed day is gone). Proven host-level, not ours, by an unrelated cron's git
  pushes failing in the same minute and recovering 3.5 min after reboot. Fixed
  with a connectivity watchdog (3 consecutive epoch-less polls → exit 70; zero
  false positives across 3,152 historical samples) plus a launchd KeepAlive job,
  since the exit is only a repair if something restarts us. Replaying history
  found this had happened twice before, including a 4.6-day outage in May.
- **The verifiable-kind tilt was value-destroying** (shipped 07-23, corrected
  07-28). It preferred sandbox-graded kinds whenever standard-kind expiry passed
  20%, on the theory that converting forfeited slots into paid ones is free
  money. Gateway attribution says otherwise: standard returns 54,308 NOOK per
  paid solve at 55% survival (27,516/slot) vs verifiable 10,181 at 88%
  (8,960/slot). Standard wins 3.1x *despite* the expiry; break-even needs ~84%
  expiry. Ranked kinds by survival rate while ignoring what they pay. The
  trigger is now the EV comparison itself.
- **Cost accounting was wrong in three ways at once**, which mattered because
  it is the denominator in every model-pruning decision: the price table was
  stale and incomplete (grok-4-3 listed at 12.0 against a real $1.42/$2.83;
  three of four live arms had no entry and silently billed at a $15 default);
  reasoning tokens were double-counted (Venice follows the OpenAI convention
  where reasoning is a *subset* of completion — 6,108/6,108 rows confirm), and
  only on the two arms that report them; and revenue was compared over 7 days
  against 8 days of cost. Re-costing the last week: $13.46 actual vs $30.06 as
  logged.
- **GLM burned 52 paid solves for zero accepted submissions** over 13 days. The
  gateway rejects every dash-mangled form of its id, and the circuit breaker
  could not see it because *generation* was clean 146/148 times — so the breaker
  rated it our healthiest arm. Removed. Submit-time rejections now feed the
  breaker, and an id rejection sidelines an arm after ONE occurrence (it is
  deterministic evidence, not a rate). kimi-k3 hit the same wall and is retrying
  under an org/Model wire name, bounded to a single solve if wrong.
- **The circuit breaker's denominator counted only failures.** Successes were
  never tagged, so every model read as 100% failing and any arm was sidelined
  *permanently* once it accumulated 5 lifetime parse-fails. grok-4-3 was at 4.
- **The citation loop had never once succeeded — 18,338 failures.** It passed a
  network-learning id as the target to a knowledge-GRAPH citation endpoint: a
  different namespace. Every call 500'd, invisibly, since inception. Proven by
  probe (learning id fails, a knowledge node from the same author succeeds)
  rather than inferred. Now resolves the author's graph and cites a real node;
  first successful citations recorded 07-30.
- **Two dashboard metrics were coaching harm.** The "Are we winning · 100/100"
  score had no revenue, cost or net term among its eight, so it sat pinned at
  maximum while the bot lost money every day since 07-11 — deleted, replaced by
  real P&L as the first panel, with an operator toggle to view gross when
  inference is paid from DIEM/OpenRouter credits. The capacity warning measured
  verifications against the raw 38/day cap, but ~94% of the pool is Sybil-farm
  spam we correctly abstain on, and quorum is a COUNT with no reject field — so
  hitting that floor would have meant *paying the farm*. Now measured against
  genuine supply.
- **Verification throughput was capped by our own pacing, not by spam.** 22-109
  traces cleared the anti-farm gate per day while only 3-11 verifications
  landed; the 2/hour gate assumed uniform arrival and genuine work is bursty.
  Raised to 5/hour.
- **The royalty rescue checked the wrong thing.** It fired only on zero
  *submissions*, but the 250k needs a *verified* solve — so on 07-30 a single
  unverified submission suppressed it while the royalty went unqualified. Now
  counts verified solves across every challenge posted that epoch-day, starts
  10h out (median time-to-verified is 7.2h), and allows two rescues. It fired
  the same evening and drew a submission within 8 minutes.
- **Challenge attractiveness is not the royalty lever** (investigated, mostly a
  negative result). All 48 settled posts are byte-identical on every
  solver-visible field yet drew 0-20 submissions; submissions arrive in an
  exogenous network-wide sweep. Rejected on the evidence: raising the daily post
  cap, re-timing the post, shortening descriptions. Kept one free experiment —
  difficulty was never actually being chosen (the parser fell back to `hard` on
  all 49 posts, making us the cheapest listing on a board that is 84% `expert`),
  now pinned and, for the first time, *logged* so the experiment is measurable.

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
