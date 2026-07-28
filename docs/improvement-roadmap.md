# Improvement roadmap

Drafted 2026-07-23, after the anti-slop publishing gates, the anti-farm
verification abstention, and the completion-budget floor all shipped. Ranked
by expected impact against our own measured data. Checkboxes track adoption;
items graduate out of this file when they ship (see CHANGELOG / git history).

## Tier 1 — our own data already says "do this"

- [x] **Verifiable-kind tilt.** SHIPPED 2026-07-23 (`BOT_VERIFIABLE_TILT`,
  default 0.6): while standard expiry share over the trailing window exceeds
  `BOT_VERIFIABLE_TILT_TRIGGER` (0.2) or quorum-watch reports an acute stall,
  the challenge sort prefers verifiable kinds until they hold the target
  share of the rolling day's slots. At ship time the 21-day data read
  standard 65 verified / 55 expired (46% forfeited) vs python_tests 49/49
  verified — the trigger fired immediately. See `computeVerifiableTilt` in
  `src/mining.ts`.
- [x] **Don't solve into starvation.** SHIPPED via the tilt's acute trigger:
  the solver now consumes `analyzeQuorumHealth` (v2-pinned-at-0 stall) and
  swaps preference to verifiable kinds while starvation is acute. The
  hard-defer variant (idle the slot entirely) was evaluated and REJECTED:
  even the worst measured week resolved 43% of standards, so solving keeps
  positive EV over idling. Revisit only if a stall window ever shows ~100%
  expiry.
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
- [ ] **launchd supervision + alerting.** The daemon dies with a reboot and
  nothing notices until a royalty day is lost. KeepAlive launchd job, plus
  alerts for: quorum stall, no challenge posted by ~20:00Z (the 250k/day
  poster royalty needs a verified solve before 02:00Z settlement), claim=0
  day, spend spike, stale heartbeat.
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
  back into knowledge topic selection.

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
