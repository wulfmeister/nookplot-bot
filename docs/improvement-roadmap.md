# Improvement roadmap

Drafted 2026-07-23, after the anti-slop publishing gates, the anti-farm
verification abstention, and the completion-budget floor all shipped. Ranked
by expected impact against our own measured data. Checkboxes track adoption;
items graduate out of this file when they ship (see CHANGELOG / git history).

## Tier 1 — our own data already says "do this"

- [ ] **Verifiable-kind tilt.** The solve funnel's decision rule ("a rising
  expired% is the trigger to tilt mining toward sandbox-graded verifiable
  kinds") has FIRED: ~26% of recent submissions expired unpaid in a starved
  verifier pool. Verifiable kinds grade deterministically in a sandbox and
  are immune to quorum starvation. Add a `BOT_VERIFIABLE_TILT` ratio (e.g.
  50-70% of daily slots while expired% > 20) and convert forfeited slots
  into paid ones.
- [ ] **Don't solve into starvation.** When the network shows acute verifier
  starvation (pool pinned at v0, own pendings averaging ~0/3 verifiers), a
  standard solve's EV collapses regardless of quality. The signals already
  exist in `quorum-watch` / network-status — the solver should consume them:
  defer standard solves within the rolling window (or swap to verifiable
  kinds) while starvation is acute.
- [ ] **File the farm dossier with the network team.** We hold: hundreds of
  fingerprinted abstains, generator `wallet=` leaks tying ~19 Sybil wallets
  to one operator, the generated challenge-title pattern, and the design
  flaw being exploited (quorum is a verification COUNT, so low scores still
  advance spam toward payment — see `src/trace-fingerprint.ts`). If the team
  acts, the pool detoxifies and genuine submissions stop expiring — the only
  lever that fixes the NETWORK we earn from. Pricing-mismatch and
  epoch-boundary-stall reports ride along.
- [ ] **Close the model-P&L loop.** Join settled epoch_solving income to the
  submitting model (per-submission attribution via the gateway API) and have
  `mining-stats` emit NOOK-per-dollar per A/B arm with a standing prune
  recommendation. The 2x-cost arm justifies itself on data or exits.

## Tier 2 — structural robustness (cheap, permanent)

- [ ] **Single-instance lock in the daemon.** The 5-daemon pileup (07-11→16:
  tsx re-exec survived pattern-based kills; doubled spend, bypassed gates)
  is currently prevented by *procedure*. Make it code: pidfile/flock at
  boot, exit if another instance holds it; expose pid / boot time / git rev
  in `/api/health` for a dashboard identity chip.
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
