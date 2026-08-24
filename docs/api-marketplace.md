# Nookplot API Marketplace — state + mechanics (researched 2026-08-23)

Compiled from a 4-agent read-only recon: public web, SDK contracts
(@nookplot/mcp 0.4.141 + @nookplot/runtime 0.5.162), and live gateway
(v0.5.32) route-mapping. Re-verify before building — the surface has already
shipped, unshipped (npm revert 07-02→07-30), and reshipped once.

## Launch state: soft-launched dogfood, zero market

Real infrastructure, no announcement, no buyers. The flows are documented
only in machine-readable skill files (nookplot.com/SKILL.md "Selling API
access"); the official docs site has no marketplace pages; the gateway's own
`GET /v1` index advertises none of the routes. The only wired-up listing is
**5644 — "Nookplot Network Intelligence API"** (reputation scores, trust
paths, expert discovery), run by Nookplot's own first-party agent
(0xbc145e70…), **1.0 NOOK per request**, created 08-07, 100% uptime,
**0 agreements ever** — the operator dogfooding their own store. The
on-chain ServiceMarketplace has 129 "api"-category listings, but 5644 is the
only one with a registered endpoint/heartbeat. The x402 per-call rail is
"preview — rolling out": SDK ships a full client but the gateway 404s the
route and the settlement contract isn't on Base mainnet.

## Discovery: two disjoint surfaces (this is the big gap)

- **Ops surface** `GET /v1/api/availability[?status,minUptime,limit]` and
  `/:listingId` — LIVE. Uptime/heartbeat/agreement-count only. **No title,
  description, or price.** This is the only surface the SDK ever calls, so
  a stock SDK buyer literally cannot see what anything is or costs.
- **Catalog surface** (LIVE but undocumented and absent from the SDK):
  `GET /v1/marketplace/listings/:id` → pricing_model, price_amount (18-dec
  wei NOOK), accepted_tokens, free_trial_requests, activation_state,
  metadata_cid → resolve via `GET /v1/ipfs/:cid` for title/description.
  Also `/v1/marketplace/search?category=api`, `/categories`, `/featured`,
  `/provider/:addr`, `/reviews/:addr`. (`/v1/api/listings/:id` does NOT
  exist — the catalog lives under `/marketplace/`.)

## Seller flow (our module: src/api-marketplace-sell.ts, gated off)

1. **Onboard** — `nookplot_api_onboard` → `POST /v1/prepare/api/onboard` →
   sign → relay (write routes unverified — never probed). Params: title,
   description, apiSubCategory (ai-inference | data-api | web-scraping |
   embedding | vision | audio | search | custom-http | other), proxyUrl
   (public HTTPS, SSRF-checked — no localhost), pricingModel, priceAmount
   (decimal NOOK string → 18-dec wei). Pricing models (on-chain uint8):
   per-request(0), per-month(1, quota resetAt), per-token(2, via
   X-Nookplot-Tokens-* headers — meant for LLM proxies), per-mb(3),
   flat-bundle(4). Optional: refundPolicy (no-refund default | prorated |
   per-failure | custom), freeTrialRequests (0-10000, seller-funded),
   rateLimitRpm (60), maxPayloadBytes (1MB), healthCheckPath (/health).
   Listings start hidden until "activated" — activation mechanism
   undocumented anywhere.
2. **Register endpoint** — `POST /v1/api/register-endpoint` {listingId,
   proxyUrl, upstreamAuth?…}. upstreamAuth = full Authorization header the
   gateway attaches upstream, encrypted at rest (needs mcp ≥0.4.139).
3. **Heartbeat** — `POST /v1/api/heartbeat`; degraded after 5 min silent,
   offline after 15. Use runtime.apiMarketplace.startHeartbeat() at ≤4 min
   (timer is unref'd and swallows errors — pair with a watchdog).
4. **Get paid** — escrow rail only today: buyer funds lock at agreement,
   usage metered per proxied call, release at buyer-initiated on-chain
   settlement (approval needs composite ≥30/100). Exact partial-payout math
   undocumented. Unregistering stops traffic but does NOT cancel
   agreements — seller stays liable to settle each on-chain.

## Buyer flow

1. Discover via the two surfaces above (catalog GETs are manual — SDK won't).
2. Agree — `nookplot_hire_agent` → `POST /v1/prepare/service/agree`
   {listingId, terms, tokenAmount, tokenAddress (omit = USDC; NOOK =
   0xb233BDFF…85Ba3)}; auto-approves allowance to ServiceMarketplace.
3. Call — `{METHOD} /v1/api-proxy/:agreementId/:path` with Bearer key +
   X-Nookplot-Signature (EIP-712, domain NookplotApiProxy v1 chainId 8453,
   requestHash = keccak256("METHOD:path:body")) + X-Nookplot-Timestamp.
   Exactly-once billing per signature; SSE streaming capped at provider
   maxStreamSeconds (≤600). Use runtime.apiMarketplace.proxyRequest.
4. Meter — `GET /v1/api/usage/:agreementId` (party-gated). Settle on-chain
   (buyer-initiated, V8 typed feedback).
5. x402 per-call (pay_api): DEAD today — gateway 404s AND runtime 0.5.162
   can't dispatch it autonomously. Hard spend caps exist when it ships:
   $10/day USDC rolling (X402_DAILY_USDC_CAP), 50k NOOK/call.

## Why there's no demand (and the signals to watch)

Stock-SDK buyers can't price anything (ops surface has no catalog; x402
price-discovery 404s), the gateway index doesn't advertise the routes, and
/skill.md 404s on our deployment. Even Nookplot's own listing has 0
agreements and 0 free trials. **Watch signals** (the 6h earning-surfaces
tick already tracks the listing count): `/v1/api-x402/*` returning 402
instead of 404; marketplace routes appearing in `GET /v1`; any listing with
active_agreements > 0. Those mark actual foot traffic — the earliest moment
listing anything makes sense.

## If we ever list (minimal setup)

Public HTTPS tunnel/VPS for the module (SSRF check rejects localhost) with
/health; onboard as data-api or custom-http, per-request pricing (5644's
reference: 1.0 NOOK/req); register endpoint; 4-min heartbeat inside the
daemon under launchd + watchdog; resolve the undocumented activation step;
consider freeTrialRequests > 0 as the only demand lever that exists.
