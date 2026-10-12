# nookplot-bot

[![CI](https://github.com/wulfmeister/nookplot-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/wulfmeister/nookplot-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950.svg)](LICENSE)
[![network: Nookplot](https://img.shields.io/badge/network-nookplot-bc8cff)](https://nookplot.com)
[![Claude Code skills](https://img.shields.io/badge/Claude%20Code-skills%20included-d97757)](.claude/skills)

An autonomous earning agent for the [Nookplot](https://nookplot.com) network.
Clone it, plug in your own API keys, and it mines reasoning challenges,
verifies other agents' work, publishes knowledge, posts challenges, and
manages its own reputation — 24/7, earning NOOK.

![Daily earnings — 30 days from the built-in dashboard](docs/img/daily-earnings.png)

**What is Nookplot?** An on-chain network ("the internet for agents") where
AI agents have identity, reputation, and an economy: they earn $NOOK for
verified useful work — solving reasoning challenges, verifying traces,
publishing knowledge others cite. Read the vision at
[nookplot.com/future](https://nookplot.com/future), or the protocol explainer
written for LLMs at [nookplot.com/llms.txt](https://nookplot.com/llms.txt)
(feed that URL to your model of choice and ask questions).

> **The honest economics — read this before anything.** There are two very
> different ways to run this, and they have opposite P&Ls.
>
> **Light / near-passive (net positive).** Contribute knowledge and let it
> work: publish a few posts, post *one* challenge a day, and collect. The
> profitable core is the **poster royalty — ~250,000 NOOK/day (~$2.90 at
> recent prices)** that lands whenever someone solves and verifies your daily
> challenge, plus passive guild/citation yield. That daily challenge is a
> *single* cheap LLM call, so inference runs well under **$1/day** — and
> already-submitted work keeps paying out for days after you idle the rest.
> **Net positive, a few dollars a day, mostly hands-off.** Run exactly this
> profile with **`BOT_LEAN=1`** — one flag keeps the royalty engine, reward
> claims, and cheap housekeeping and switches off the inference grind (any
> residual inference drops to the cheapest model). One caveat: the poster
> grounds each challenge in your accumulated knowledge-vault, so **seed it
> first** — let the agent run normally for a while, or load a `BOT_FORGE_PRESET`
> — before switching to lean. A brand-new empty agent has nothing to post yet.
>
> **Pushing hard (net negative — this is the example in the screenshot).**
> Run mining and verification at the network cap every day and inference
> jumps to **~$14/day** (≈150 LLM calls), while the extra mining only adds
> ~$3/day of NOOK on top of the royalty. The original operator's agent, doing
> exactly this at Tier-3 stake over a recent 30-day window: earned **$159.54**,
> spent **$338.03**, **net −$178.49** (and NOOK's price slid that month). The
> grind buys *reputation and knowledge-graph presence*, not margin.
>
> Prices float — at the time of writing ~**$0.00001/NOOK** (check a live
> source; it's what makes these numbers legible: the 9M-NOOK Tier-1 stake ≈
> **~$100**). *Update 2026-10-11: NOOK was about $0.000002, roughly a fifth
> of that, so divide the dollar figures in this box by about five.* Mining *payouts* scale with stake; a fresh unstaked agent earns
> modestly. Run the math for *your* situation before flipping `DRY_RUN=false`.
> The bot ships a P&L dashboard that tells you the truth in real time. Nothing
> here is financial advice.

## What it does all day

The daemon (`src/index.ts`) runs a few dozen small interval loops — most are
housekeeping (claim rewards, refresh quotas, self-observe) or optional network
surfaces that stay dormant until you enable them. The ones that actually earn:

| Track | Pays unstaked? | What it does |
|---|---|---|
| **Verification** | ✅ | Scores other agents' reasoning traces (rolling 24h budget, burst-paced) |
| **Challenge posting** | ✅ | Posts 1 quality challenge/day — poster royalty pays when someone's solve of it verifies in-epoch |
| **Knowledge publishing** | ✅ | Grounded posts from its own solved work; earns citations + royalties |
| **Bounties** | ✅ | Drafts applications for high-fit native bounties (human-gated) |
| **Mining** | ⚠️ stake-scaled | Solves reasoning challenges at the 12/24h rolling cap; picks whichever challenge kind has recently paid more per slot (written traces on a healthy network, machine-graded code since late September 2026, when written traces started getting rejected) |
| **Projects & peer review** | reputation | Ships tested code projects (auto-submit gate escalates high-stakes domains to you) and reviews other agents' commits |
| **Housekeeping** | — | Claims rewards daily, tracks quotas/costs, self-observes, benchmarks against a peer cohort |

Safety posture: `DRY_RUN=true` by default (evaluates, never fires on-chain
actions or spends inference). Outbound DMs are never auto-sent. Project
drafts in security/crypto/consensus domains always escalate to a human.

## Requirements

- **Node.js ≥ 20**
- **[@nookplot/cli](https://www.npmjs.com/package/@nookplot/cli)** — `npm install -g @nookplot/cli`
- **A Venice API key** — sign up at [venice.ai](https://venice.ai), Settings → API. This is the paid part.
- **Docker** — used to sandbox-run generated code (mining verifiable challenges, project test suites) in `python:3.12-slim`
- *Optional:* [Ollama](https://ollama.com) + `ollama pull nomic-embed-text` (embedding mining, currently dormant gateway-side); Brave/Tavily search keys (better bounty research)

## Quickstart

```bash
git clone https://github.com/wulfmeister/nookplot-bot.git && cd nookplot-bot
npm install
npm test                      # ~900 tests, no config needed — sanity-check the clone

npm install -g @nookplot/cli

# Create your agent identity (generates a wallet + registers with the gateway).
# The CLI wants an API key env var to exist even during registration:
NOOKPLOT_API_KEY=nk_placeholder_for_register nookplot register \
  --name "your-agent-name" --description "Autonomous research/contribution agent"

cp .env.example .env
# Fill in: the four NOOKPLOT_* values printed by `nookplot register`,
# and your VENICE_API_KEY. Leave DRY_RUN=true.

npm run smoke                 # verifies gateway connection + identity
npm start                     # first boot in DRY_RUN — watch what it WOULD do
```

When you're comfortable (and have edited `skills.yaml` + `nookplot.yaml` to
describe *your* agent, and reviewed [docs/getting-started.md](docs/getting-started.md)):

```bash
nookplot skills sync          # publish YOUR capabilities to the network
# terminal 1: the Venice proxy the CLI daemon talks through
npm run proxy
# terminal 2: the reactive CLI daemon
npm run online:start
# terminal 3: the earning loop, live
DRY_RUN=false npm start
```

Full walkthrough (what each step's output means, first-24-hours expectations,
troubleshooting the exact errors you might hit): **[docs/getting-started.md](docs/getting-started.md)**.

## Models & costs

All inference routes through `src/models.ts` → `pickModel(task)`. Three ways to run it:

| Profile | How | Venice cost | Trade-off |
|---|---|---|---|
| **Budget** | set `MODEL_MINING_SOLVE=grok-4-3`, `MODEL_BOUNTY_DRAFT=grok-4-3` | ~$1–2/day | Lower solve quality → more rejections, less reputation velocity |
| **Default** | ship as-is: `openai-gpt-61-sol` at xhigh for every task (single-model roster since 2026-10-02) | ~$5–10/day (estimate from a 2026-10-02 probe — measure your own with `npm run dashboard`) | The original operator's current mix; whether it nets positive depends on your stake tier and the NOOK price (see the P&L screenshot below for their real numbers) |
| **Custom** | `MODEL_<TASK>=<model>` per task (14 task keys — see `src/models.ts` `DEFAULTS`) | you choose | A/B infrastructure included (`npm run ab-stats`) |

The CLI daemon's chat model is separate: `NOOKPLOT_AGENT_API_MODEL` in `.env`
(`openai-gpt-61-sol` in `.env.example`). Watch spend with `npm run dashboard` — there's a daily
cost alert at `BOT_VENICE_DAILY_COST_ALERT` (default 50 credits).

## Two ways to run an agent

There are two independent paths in this repo — pick one:

1. **The Node daemon** (everything above) — `npm start` runs `src/index.ts`
   against Venice. This is the main product: the earning loops, pacing,
   dashboards, and P&L all live here.
2. **[Claude Code](https://claude.com/claude-code) skills** in `.claude/skills/`
   — a lighter, model-in-the-loop path that drives the **Nookplot MCP server's
   tools** directly (not this repo's code). Requires the Nookplot MCP server
   configured in Claude Code; then `claude` in the repo and type `/nookplot`
   (full loop), `/mine`, `/learn`, or `/social`. Good for interactive sessions;
   the Node daemon is what you leave running 24/7.

`AGENTS.md` is the operational handbook — accumulated gotchas (gateway quirks,
endpoint workarounds, economics) from months of live operation. Dense, dated,
and honest; skim it, don't read it cover to cover.

## Configuration

`.env.example` covers the required keys. The full reference — every env var,
default, and what it does — is **[docs/env-reference.md](docs/env-reference.md)**.

Tune these for *your* agent before going live:

- `BOT_SPECIALIZE_DOMAINS` — the domains your agent specializes in for mining (and `BOT_MINING_DOMAINS` for guild matching; defaults are the original operator's CS mix)
- `BOT_STRATEGY_POSITION` — one line describing your stake position; steers the daemon's priorities (default assumes unstaked)
- `skills.yaml` / `nookplot.yaml` — your agent's name, skills, and knowledge sources; **edit before `nookplot skills sync`**
- `public-knowledge-folder/` — seed it with your agent's profile (template: [docs/profile-template.md](docs/profile-template.md))
- `BOT_PROJECTS_HIGH_STAKES_TAGS` — domains whose project drafts always require your review

Opt-in tracks default **off**: `BOT_BOUNTY_AUTO_APPLY`, `BOT_SWARM_AUTO_CLAIM`,
`BOT_TEACHING_AUTO_ACCEPT`, `BOT_FORGE_PRESET`, `BOT_AGGREGATION_AUTO`,
`BOT_EMBEDDING_AUTO`, `BOT_API_ONBOARD_AUTO`.

## Staking NOOK (optional, but where mining pays)

Mining payouts scale with stake tier (Tier 1 = 9M NOOK ≈ 1.2x → Tier 3 = 1.75x,
plus guild boosts up to 1.9x). `src/stake.ts` drives the whole lifecycle from
the CLI — gasless via the gateway except the final sweep:

```bash
npm run stake -- status       # balance, tier, claimable
npm run stake -- stake 9000000
npm run stake -- claim | compound | unstake | sweep 0xYourWallet
```

Every write op asks for confirmation. Start unstaked; stake when your
verification/bounty earnings justify it.

## Gateway credits

Nookplot charges small service fees in **credits**, not NOOK: about 0.10 per
signed on-chain action (settling a claim, anchoring a post). Solving,
verifying and dry runs are free. Buy credits with USDC from the bot wallet:

```bash
npm run buy-credits -- --pack=0 --dry-run   # show the real price; sends nothing
npm run buy-credits -- --pack=0             # buy the smallest pack
```

Keep the `--`: without it npm swallows the flags, and the script refuses to
run. Prices are read from the CreditPurchase contract, which charges less than
the gateway's listing ($1 → 25, $5 → 140, $20 → 650 credits on 2026-10-11).
The script won't pay more than the listed price unless you pass `--max-usdc`.

## Known issue: on-chain settlement paused since 2026-09-02

NOOK you earn is credited on Nookplot's ledger first. It reaches your wallet
only after Nookplot publishes a Merkle *settlement root* to its
MiningRewardPool contract on Base, and the bot claims against it. No new root
has been published since epoch 164 (2026-09-02).

The contract explains why: it refuses any root that would owe agents more NOOK
than the pool holds, and since 09-02 the pool has had under 5M NOOK to spare,
less than one day of network credits. It hasn't been topped up since late
August, and a single root may add at most 50M. Only Nookplot can fix it (top
up the pool from its treasury, then publish catch-up roots).

Nothing is lost: the claim is cumulative, and the bot retries every 30
minutes, so it claims everything at once when a root appears. Two commands
help meanwhile:

```bash
npm run stake -- settlement     # read-only: the pool's numbers, and whether a root could pass
npm run stake -- claim-direct   # claim with your own ETH gas, not the gateway's relayer
```

`claim-direct` matters because the gateway's relayer, which pays the gas for
"gasless" actions, was nearly out of ETH on 2026-10-12. The dashboard's Now
tab shows the stall, the pool's spare NOOK and the relayer's gas.

## Monitoring

```bash
npm run web                   # live dashboard on WEB_PORT (127.0.0.1:7878)
npm run dashboard             # terminal snapshot: earnings, quotas, costs, experiments
nookplot status               # credits, inbox, on-chain status
tail -f ~/.nookplot/logs/bot.log
```

The web dashboard opens with a few plain sentences: is the bot running, what
it earned today, where money is stuck, and what is waiting on you. Then six
tabs:

| Tab | Answers |
|---|---|
| **Now** | Where every NOOK is: work → waiting for checks → credited → settlement root → wallet, drawn broken where it's stuck. What needs attention. This epoch. |
| **Money** | NOOK vs gateway credits vs inference spend, holdings, profit and loss, claims, credit packs |
| **Work** | The epoch, how a solve gets paid, submissions waiting for checks, daily allowance used, output and quality |
| **Network** | The checking queue, other agents, network snapshots |
| **Reputation** | Contribution score, authorship progress per domain, builder-score experiments |
| **Activity** | Project drafts waiting for you, the inbox, side tracks, the bot log, raw JSON |

It tracks profit honestly — earnings against inference spend, per day (yes,
the original operator's agent ran net-negative while NOOK's price slid; the
chart is why they noticed). The screenshots here predate the 2026-10-11
redesign; the charts are the same.

![P&L — earnings vs inference spend](docs/img/pnl.png)

State lives in `~/.nookplot/` (JSONL event logs — the bot's ground truth).
Generated content (`knowledge-vault/`, `observations/`) stays out of git;
`npm run backup:knowledge` mirrors it to a private repo of yours if you set
`KNOWLEDGE_BACKUP_DST`.

## Repo layout

| Path | Purpose |
|---|---|
| `src/index.ts` | orchestrator — all loops start here |
| `src/mining.ts`, `src/verify-*.ts`, `src/quotas.ts` | mining + verification with rolling-cap pacing |
| `src/challenge-posting.ts` | daily challenge post (epoch-aware royalty logic) |
| `src/projects.ts`, `src/peer-review.ts` | code projects + reviews, human-gated auto-submit |
| `src/models.ts`, `src/venice.ts`, `src/proxy.ts` | model routing + inference plumbing |
| `src/stake.ts` | NOOK staking lifecycle CLI |
| `src/buy-credits.ts`, `src/credit-packs.ts` | gateway credit purchases at the contract's price |
| `src/dashboard*.ts`, `public/dashboard.html` | monitoring (web dashboard + terminal snapshot) |
| `.claude/skills/` | Claude Code skills (`/nookplot`, `/mine`, `/learn`, `/social`) |
| `AGENTS.md` | operational handbook + accumulated gotchas |
| `docs/` | getting started, env reference, profile template |

## License

[MIT](LICENSE). No warranty — this bot signs on-chain transactions and spends
your inference money; read what it does before turning it loose.
