# Improvement roadmap

Drafted 2026-07-23, after the anti-slop publishing gates, the anti-farm
verification abstention, and the completion-budget floor all shipped. Ranked
by expected impact against our own measured data. Checkboxes track adoption;
items graduate out of this file when they ship (see CHANGELOG / git history).

## Tier 1 — our own data already says "do this"

- [x] **Verifiable-kind tilt.** SHIPPED 2026-07-23, **CORRECTED 2026-07-28.**
  The original trigger (expiry share > 20%) was WRONG: it ranked kinds by
  survival rate while ignoring what each kind pays. Gateway per-submission
  attribution showed standard returns 54,308 NOOK per paid solve at 55%
  survival (27,516/slot) vs verifiable 10,181 at 88% (8,960/slot) — standard
  wins 3.1x DESPITE the expiry, and break-even needs ~84% standard expiry.
  The 20% trigger fired constantly and steered slots toward work paying ~5x
  less, into a path that only submits 38% of the time. The trigger is now the
  EV comparison itself (`BOT_STANDARD_REWARD_MULTIPLE`, measured 5.3x), which
  correctly reports "standard first" on current data. Lesson: rank by NOOK
  per slot, never by a survival rate alone.
- [x] **Don't solve into starvation.** RESOLVED — as "no action needed",
  which the numbers above make explicit. Both proposed responses lose money
  at any starvation level yet observed: idling a slot earns 0, and switching
  to verifiable earns ~5x less per slot, while a standard solve survives
  ~55% of the time. The quorum-stall trigger added on 07-23 was REMOVED on
  07-28 for the same reason — a stall depresses standard survival, which the
  EV test already sees through the expiry share, and even the worst stall
  week resolved 43% of standards (far above the ~16% break-even). Revisit
  only if a window ever shows ~85%+ expiry, which the tilt now handles
  automatically.
- [x] **File the farm dossier with the network team.** DONE 2026-07-25 — all
  three reports filed.
  - **Epoch-boundary-stall:** public issue nookprotocol/nookplot#10 — 15 ≥3h
    verification freezes in 14 days, ~46% standard-kind expiry.
  - **Farm dossier:** filed privately via GitHub security advisory (in
    triage). Evidence: 1,188/1,370 traces (87%) abstained as farm spam over
    4 days, `wallet=` leaks tying 69 distinct Sybil wallets to one operator,
    three fixed-text fingerprint families, and the design flaw (quorum is a
    verification COUNT, so low scores still advance spam toward payment —
    see `src/trace-fingerprint.ts`). Wallet list included in the private
    report; fingerprint regexes withheld, offered on request.
  - **Credit-pricing mismatch:** filed privately via GitHub security
    advisory (in triage) — CreditPurchase charges 2.5× the advertised
    per-credit rate.
  Watch for maintainer responses on all three; if the team acts on the
  dossier, the pool detoxifies and genuine submissions stop expiring.
- [ ] **Close the model-P&L loop.** Join settled epoch_solving income to the
  submitting model (per-submission attribution via the gateway API) and have
  `mining-stats` emit NOOK-per-dollar per A/B arm with a standing prune
  recommendation. The 2x-cost arm justifies itself on data or exits.

## Tier 2 — structural robustness (cheap, permanent)

- [x] **Single-instance lock in the daemon.** SHIPPED 2026-07-23
  (`src/instance-lock.ts`): pidfile at `~/.nookplot/bot.pid` taken FIRST in
  main() — a second boot refuses before any side effect. Handles stale files
  (dead pid), OS pid reuse (command-line check), and same-named tsx projects
  (cwd check); refuses conservatively when identity is unknowable;
  `BOT_INSTANCE_LOCK=0` escape hatch. `/api/health` now reports the daemon's
  pid / boot time / git rev from the pidfile instead of a `pgrep` pattern
  that matched unrelated projects.
- [x] **launchd supervision.** SHIPPED 2026-07-28 after the blackout below:
  `scripts/com.nookplot.bot.plist` (RunAtLoad + KeepAlive + 60s throttle) and
  `scripts/run-daemon.sh`. Paired with the connectivity watchdog
  (`BOT_GATEWAY_WATCHDOG_POLLS`) — the watchdog's exit is only a repair if
  something restarts us. Safe alongside a manual `npm start` because of the
  single-instance lock.
- [ ] **Alerting (still open).** Supervision restarts a dead daemon but
  nothing yet tells the operator when we are *up and not earning*: no
  challenge posted by ~20:00Z (the 250k/day poster royalty needs a verified
  solve before 02:00Z settlement), claim=0 day, spend spike. The dashboard
  now goes red on a dead gateway, but only if someone is looking at it.
- [x] **Connectivity watchdog.** SHIPPED 2026-07-28. On 07-25 the host
  network wedged for 53h; the daemon stayed alive, kept writing all-zero
  snapshots, and earned nothing — ~1.1M NOOK forfeited (2 days of posting
  royalty, which does NOT accumulate, plus ~19 un-mined slots). The SDK has
  no reconnect primitive and `connect()` throws on a live runtime, so the
  watchdog exits 70 after 3 consecutive epoch-less polls and lets the
  supervisor rebuild the connection. Dashboard shows a high blocker and a red
  "GATEWAY DOWN" badge from 2 samples (~1h).
- [ ] **Back up operational state.** `~/.nookplot/*.jsonl` (gate caches,
  rolling-cap state, claim history) is unbacked-up operational gold — extend
  the existing knowledge-backup script. Also rotate
  `verify-trace-cache.jsonl` (grows ~450KB/day at current abstain rates).

## Tier 3 — reputation & relationships (slow compounding)

- [ ] **Light up the zeroed reputation dimensions.** `exec=0` (nobody reruns
  our artifacts — historical blocker: non-reproduction) and `collab=0` (we
  have never submitted an MR to another agent's project). Fix exec with a
  uniform run-manifest making all published projects trivially rerunnable;
  fix collab with one genuine MR to a real researcher's project.
- [ ] **Evaluate the claimed peer artifact.** A screening reply asking for a
  verifiable artifact was answered with a knowledge-graph ID claiming a
  128-node dataset. Fetch and evaluate: independent reproduction would be
  our first true cross-agent verification collab; a debunk is more
  farm-adjacent evidence. Either outcome pays.
- [ ] **Citation-aware topic steering.** We publish ~4 knowledge posts/day
  and never look at which earn citations/access royalties.
  `citation-velocity.jsonl` has the data; feed "what actually gets cited"
  back into knowledge topic selection. NOTE (2026-07-30): this was unmeasurable
  until now — the citation loop had never succeeded once (18,338 failures from
  passing a learning id to a knowledge-graph endpoint), so citation counts were
  all structurally zero. Fixed; let real data accumulate for a week before
  building steering on top of it.

## Tier 4 — investigate, unclear payoff

- [ ] **RLM spot-checks show 0/10.** An entire earning track at zero — no
  supply, or non-participation? One investigation session answers it.
- [ ] **Stake-tier analysis.** Idle liquid NOOK could compound every future
  claim if a higher stake tier/multiplier exists — but locks capital at a
  price bottom. Needs the tier table before any move.
- [ ] **Price-risk posture.** We earn NOOK and spend USD — a structural
  long-NOOK book. Academic at current sums; if price recovers materially,
  auto-sweeping a percentage of claims to stablecoin becomes real treasury
  management. Parked until relevant.
- [ ] **Cheap-model cascade for solves.** Draft with the budget model,
  escalate to the premium model only when the local specificity mirror
  scores the draft borderline. Could halve the biggest remaining cost line,
  but risks the score-scaled payouts — trial on a small slice first.
