/**
 * 2026-10-01: single-model roster moves grok-4-7 → openai-gpt-61-sol, plus the
 * pure helpers of the pre-restart probe (src/_probe-gpt61.ts). The probe module
 * imports node builtins only at load time, so importing it here runs nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, brotliCompressSync } from "node:zlib";

import { pickModel, pickModelAB, effortFor, pickAlternateModel, abPool } from "../models.js";
import { estimateCallCost, computeParseFailureRates } from "../venice-cost.js";
import { gatewayModelName, maybeOverrideModelForVerifiable, idRejectionStandDown, discountStaleIdRejections } from "../mining.js";
import { acceptsTemperature, markTemperatureRejected, isTemperatureRejection } from "../venice.js";
import {
  isBillingStop,
  decideAfterCall,
  wouldExceedBudget,
  preflightVerdict,
  preflightFloorUsd,
  parseProbeArgs,
  decodeBody,
  headerValue,
  hasCitationMarkers,
  parseMiningNote,
  parseVerificationNote,
  billAttempts,
  ledgerSpendInWindow,
  bracketReport,
  envModelOverrides,
  auditRevise,
  auditComprehensionAnswers,
  resolveProbePaths,
  buildPlan,
  shapeWorstUsd,
  worstCallUsd,
  SHAPE_ORDER,
  DEFAULT_BUDGET_USD,
} from "../_probe-gpt61.js";

const SOL = "openai-gpt-61-sol";

describe("2026-10-01 roster: openai-gpt-61-sol", () => {
  it("every task defaults to it and both A/B pools hold only it (absent MODEL_<TASK> / lean)", () => {
    const savedLean = process.env.BOT_LEAN;
    delete process.env.BOT_LEAN;
    try {
      for (const t of [
        "bounty_draft", "bounty_work", "bounty_critique", "bounty_revise", "mining_solve", "mining_learning",
        "verification_score", "verification_comprehension", "crowd_jury_score", "knowledge_topic",
        "knowledge_body", "research_extract", "action_suggest", "fit_evaluate",
      ] as const) {
        const env = process.env[`MODEL_${t.toUpperCase()}`];
        assert.equal(pickModel(t), env ?? SOL, t);
      }
      assert.deepEqual([...abPool("mining_solve")], [SOL]);
      assert.deepEqual([...abPool("bounty_draft")], [SOL]);
      if (!process.env.MODEL_MINING_SOLVE) {
        const pick = pickModelAB("mining_solve");
        assert.equal(pick.model, SOL);
        assert.equal(pick.reasoning_effort, "xhigh");
      }
    } finally {
      if (savedLean === undefined) delete process.env.BOT_LEAN; else process.env.BOT_LEAN = savedLean;
    }
  });

  it("runs at xhigh — never an effort the catalog lacks (no none/minimal) and not max", () => {
    assert.equal(effortFor(SOL), "xhigh");
    // Rollback via MODEL_<TASK>=grok-4-7 must still get its dial.
    assert.equal(effortFor("grok-4-7"), "xhigh");
  });

  it("is priced from the live catalog ($2.50 / $12.50 per M), not DEFAULT_PRICING", () => {
    const got = estimateCallCost(SOL, 12_000, 8_000);
    assert.ok(Math.abs(got - (4_000 * 2.5 + 8_000 * 12.5) / 1e6) < 1e-12, `got ${got}`);
    assert.notEqual(got.toFixed(6), estimateCallCost("some-unknown-model", 12_000, 8_000).toFixed(6));
    // grok-4-7 keeps its own row so a rollback is costed correctly.
    assert.ok(Math.abs(estimateCallCost("grok-4-7", 12_000, 8_000) - (4_000 * 2.27 + 8_000 * 6.8) / 1e6) < 1e-12);
  });

  it("goes on the wire unchanged and keeps the verifiable lane (no reroute)", () => {
    assert.equal(gatewayModelName(SOL), SOL);
    const saved = { ov: process.env.BOT_VERIFIABLE_MODEL_OVERRIDE, m: process.env.BOT_VERIFIABLE_MODEL };
    delete process.env.BOT_VERIFIABLE_MODEL_OVERRIDE;
    delete process.env.BOT_VERIFIABLE_MODEL;
    try {
      const py = { id: "c1", verifierKind: "python_tests" } as never;
      const ab = (model: string) => ({ model, reasoning_effort: "xhigh" as const });
      assert.equal(maybeOverrideModelForVerifiable(py, ab(SOL)).model, SOL);
      // A weak-code pick is routed TO it; a grok-4-7 rollback pick is left alone.
      assert.equal(maybeOverrideModelForVerifiable(py, ab("grok-4-3")).model, SOL);
      assert.equal(maybeOverrideModelForVerifiable(py, ab("grok-4-7")).model, "grok-4-7");
    } finally {
      if (saved.ov === undefined) delete process.env.BOT_VERIFIABLE_MODEL_OVERRIDE; else process.env.BOT_VERIFIABLE_MODEL_OVERRIDE = saved.ov;
      if (saved.m === undefined) delete process.env.BOT_VERIFIABLE_MODEL; else process.env.BOT_VERIFIABLE_MODEL = saved.m;
    }
  });

  it("one-arm pool: transient failover has no alternative (known trade-off, same as the grok-4-7 roster)", () => {
    assert.equal(pickAlternateModel("mining_solve", SOL), null);
  });
});

describe("_probe-gpt61 stop conditions", () => {
  it("402 / 429 / spend limit / lockout / Insufficient stop the run", () => {
    assert.equal(isBillingStop(402, undefined), true);
    assert.equal(isBillingStop(429, undefined), true);
    assert.equal(isBillingStop(undefined, 'Venice API 402: {"error":"API key DIEM spend limit exceeded."}'), true);
    assert.equal(isBillingStop(undefined, "Too many failed attempts (> 50). Try again later."), true);
    assert.equal(isBillingStop(undefined, "Insufficient USD or DIEM balance"), true);
    assert.equal(isBillingStop(500, "Inference processing failed"), false);
    assert.equal(isBillingStop(400, "Unsupported value: 'temperature' does not support 0.2 with this model."), false);
    assert.equal(isBillingStop(undefined, undefined), false);
  });

  it("a billing signature stops immediately, even on an otherwise ok call", () => {
    const d = decideAfterCall(0, { ok: true, statuses: [429], errorTexts: [] });
    assert.equal(d.action, "stop");
    assert.equal(d.billing, true);
    const e = decideAfterCall(0, { ok: false, statuses: [], errorTexts: ["Venice API 402: spend limit"] });
    assert.equal(e.action, "stop");
    assert.match(e.reason ?? "", /billing/);
  });

  it("first non-billing error continues; the second stops", () => {
    const first = decideAfterCall(0, { ok: false, statuses: [500], errorTexts: ["Venice API 500: Inference processing failed"] });
    assert.equal(first.action, "continue");
    assert.equal(first.nonBillingErrors, 1);
    const ok = decideAfterCall(first.nonBillingErrors, { ok: true, statuses: [400, 200], errorTexts: ["Unsupported value: 'temperature'"] });
    assert.equal(ok.action, "continue", "a temperature 400 that chat() retried through is not an error");
    assert.equal(ok.nonBillingErrors, 1);
    const second = decideAfterCall(ok.nonBillingErrors, { ok: false, statuses: [400], errorTexts: ["Venice API 400: bad effort"] });
    assert.equal(second.action, "stop");
    assert.equal(second.billing, false);
  });

  it("budget gate stops before a call that would cross the budget", () => {
    assert.equal(wouldExceedBudget(2.5, 0.4, 3), false);
    assert.equal(wouldExceedBudget(2.7, 0.4, 3), true);
    assert.equal(wouldExceedBudget(0, 3, 3), false, "exactly at budget is allowed");
  });

  it("pre-flight requires accessPermitted === true and DIEM+USD over the floor", () => {
    assert.equal(preflightVerdict(null, 3).ok, false);
    assert.equal(preflightVerdict({ accessPermitted: false, usd: 50, diem: 50 }, 3).ok, false);
    assert.equal(preflightVerdict({ accessPermitted: "true", usd: 50, diem: 50 }, 3).ok, false, "a truthy string is not true");
    assert.equal(preflightVerdict({ accessPermitted: true, usd: -1, diem: 3.5 }, 3).ok, false, "negative USD counts against the sum");
    assert.equal(preflightVerdict({ accessPermitted: true, usd: 0, diem: 3 }, 3).ok, true);
  });
});

describe("_probe-gpt61 helpers", () => {
  it("parses flags and rejects bad ones", () => {
    const d = parseProbeArgs([]);
    assert.deepEqual([d.dry, d.budget, d.model, d.source, d.jev], [false, 5, SOL, "vault", true]);
    const e = parseProbeArgs(["--env", "/x/.env", "--vault", "/x/knowledge-vault", "--report-dir", "/tmp/r"]);
    assert.deepEqual([e.envPath, e.vaultDir, e.reportDir], ["/x/.env", "/x/knowledge-vault", "/tmp/r"]);
    assert.throws(() => parseProbeArgs(["--only", "refine"]), /needs standard/);
    assert.deepEqual(parseProbeArgs(["--only", "standard,refine"]).only, ["standard", "refine"]);
    const a = parseProbeArgs(["--dry", "--budget", "1.5", "--only", "smoke,json", "--effort", "high", "--no-jev"]);
    assert.equal(a.dry, true);
    assert.equal(a.budget, 1.5);
    assert.deepEqual(a.only, ["smoke", "json"]);
    assert.equal(a.effort, "high");
    assert.equal(a.jev, false);
    assert.throws(() => parseProbeArgs(["--budget", "0"]));
    assert.throws(() => parseProbeArgs(["--budget"]));
    assert.throws(() => parseProbeArgs(["--only", "smoke,nope"]));
    assert.throws(() => parseProbeArgs(["--effort", "ultra"]));
    assert.throws(() => parseProbeArgs(["--frobnicate"]));
    // Jev first, so its own balance bracket is not blended into 6.1-sol's; refine last (it needs standard).
    assert.deepEqual([...SHAPE_ORDER], ["jev", "smoke", "json", "review", "verify", "comprehension", "python", "standard", "refine"]);
  });

  it("decodes gzip / br / identity bodies and reads raw undici headers", () => {
    const json = '{"choices":[{"finish_reason":"stop"}]}';
    assert.equal(decodeBody([gzipSync(json)], "gzip"), json);
    assert.equal(decodeBody([brotliCompressSync(Buffer.from(json))], "br"), json);
    assert.equal(decodeBody([Buffer.from(json.slice(0, 10)), Buffer.from(json.slice(10))], undefined), json);
    assert.equal(headerValue([Buffer.from("Content-Encoding"), Buffer.from("br")], "content-encoding"), "br");
    assert.equal(headerValue({ "content-encoding": ["gzip"] }, "Content-Encoding"), "gzip");
    assert.equal(headerValue([], "x"), undefined);
  });

  it("flags Venice citation markers", () => {
    assert.equal(hasCitationMarkers("uses `bisect_right`^1^ for O(log n)"), true);
    assert.equal(hasCitationMarkers("see ^1,2^"), true);
    assert.equal(hasCitationMarkers("x ** 2 ^ 3"), false);
    assert.equal(hasCitationMarkers(undefined), false);
  });

  it("rebuilds a challenge from a vault mining note (mining.ts writeNote shape)", () => {
    const note = [
      "---",
      "id: mining-50600038-e9a9",
      "title: Mining solve: URL unfurler (fetch_preview)",
      "type: mining-submission",
      'tags: ["mining", "python_tests", "deferred", "security", "ssrf"]',
      "challengeId: 50600038-e9a9-4368-941d-0ad5675d102b",
      "verifierKind: python_tests",
      "model: grok-4-7",
      "---",
      "## Challenge",
      "",
      "Implement fetch_preview(url, fetcher) -> bytes.",
      "",
      "Return b\"\" on failure.",
      "",
      "## Our reasoning",
      "",
      "SSRF guard.",
    ].join("\n");
    const n = parseMiningNote(note)!;
    assert.equal(n.challengeId, "50600038-e9a9-4368-941d-0ad5675d102b");
    assert.equal(n.title, "URL unfurler (fetch_preview)");
    assert.equal(n.kind, "python_tests");
    assert.deepEqual(n.tags, ["security", "ssrf"]);
    assert.equal(n.description, 'Implement fetch_preview(url, fetcher) -> bytes.\n\nReturn b"" on failure.');
    assert.equal(parseMiningNote("no frontmatter"), null);
    // Standard notes carry no verifierKind line → kind comes from tags[1].
    const std = parseMiningNote(note.replace("verifierKind: python_tests\n", "").replace('"python_tests"', '"standard"'))!;
    assert.equal(std.kind, "standard");
  });

  it("reads a verification note's excerpt and the scores we gave", () => {
    const note = [
      "---",
      "type: verification",
      'tags: ["verification", "sybil-detection", "quality-review"]',
      "submissionId: d4d3fa1a",
      "scores: [0.43, 0.52, 0.48, 0.45]",
      "---",
      "## Trace source",
      "",
      "ipfs",
      "",
      "## Trace excerpt",
      "",
      "Step 1. p99 rises 2.1x.",
      "",
      "## Scores (0-1)",
    ].join("\n");
    const v = parseVerificationNote(note)!;
    assert.equal(v.source, "ipfs");
    assert.equal(v.excerpt, "Step 1. p99 rises 2.1x.");
    assert.deepEqual(v.tags, ["sybil-detection"]);
    assert.deepEqual(v.scores, [0.43, 0.52, 0.48, 0.45]);
  });
});

describe("one-arm roster: gateway id rejection stands mining down", () => {
  const row = (ageMs: number, outcome: "parse-ok" | "submit-reject", wireName?: string) => ({
    ts: new Date(Date.now() - ageMs).toISOString(),
    model: SOL,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estCost: 0,
    outcome,
    callSite: "mining_solve",
    ...(wireName ? { wireName } : {}),
  });

  it("the fail-safe hands the rejected sole arm back, and the stand-down catches it", () => {
    const rates = discountStaleIdRejections(computeParseFailureRates([row(60_000, "parse-ok"), row(30_000, "submit-reject", SOL)]));
    assert.equal(rates[SOL].idRejected, 1);
    if (!process.env.MODEL_MINING_SOLVE && process.env.BOT_LEAN !== "1") {
      // The regression: filterPoolByParseFailure's empty-pool fail-safe re-admits it.
      assert.equal(pickModelAB("mining_solve", rates).model, SOL);
    }
    const msg = idRejectionStandDown(SOL, rates);
    assert.ok(msg, "a rejected sole arm must stop the paid solve");
    assert.match(msg!, /openai-gpt-61-sol/);
    assert.match(msg!, /MODEL_MINING_SOLVE/);
  });

  it("does not fire for a healthy arm, an unknown arm, or a rejection of a different wire name", () => {
    const healthy = computeParseFailureRates([row(60_000, "parse-ok")]);
    assert.equal(idRejectionStandDown(SOL, healthy), null);
    assert.equal(idRejectionStandDown("grok-4-7", {}), null, "a MODEL_MINING_SOLVE rollback to another model is not blocked");
    const stale = discountStaleIdRejections(computeParseFailureRates([row(30_000, "submit-reject", "openai/gpt-6.1-sol")]));
    assert.equal(idRejectionStandDown(SOL, stale), null, "a rejection of an OLD wire name is stale evidence");
  });
});

describe("chat() temperature memo", () => {
  it("terra is seeded; 6.1-sol is not (UNVERIFIED until the probe runs)", () => {
    assert.equal(acceptsTemperature("openai-gpt-56-terra"), false);
    assert.equal(acceptsTemperature(SOL), true);
  });

  it("a runtime rejection is remembered for the rest of the process", () => {
    const m = "test-only-model-no-temperature";
    assert.equal(acceptsTemperature(m), true);
    markTemperatureRejected(m);
    assert.equal(acceptsTemperature(m), false);
  });

  it("recognises the temperature 400 and nothing else", () => {
    assert.equal(isTemperatureRejection("Venice API 400: {\"error\":\"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.\"}"), true);
    assert.equal(isTemperatureRejection("Venice API 400: Unsupported parameter: 'temperature' is not supported with this model."), true);
    assert.equal(isTemperatureRejection("Venice API 400: Unsupported value: 'reasoning_effort' does not support 'max' with this model."), false);
    assert.equal(isTemperatureRejection("Venice API 402: Unsupported value: 'temperature'"), false, "only a 400");
  });
});

describe("_probe-gpt61 budget and billing", () => {
  const price = (m: string, pt: number, ct: number) => estimateCallCost(m, pt + ct, ct);
  const opts = { model: SOL, worstCallUsd: 0.65, webSearchUsd: 0.01, price };

  it("prices 2xx usage, books the worst case where the wire shows none, and counts 4xx as $0", () => {
    const ok = { status: 200, usage: { prompt_tokens: 1000, completion_tokens: 4000 }, responseModel: SOL };
    const b = billAttempts([ok], opts);
    assert.ok(Math.abs(b.usd - (1000 * 2.5 + 4000 * 12.5) / 1e6) < 1e-12);
    assert.equal(b.assumedAttempts, 0);
    // Aborted (no status), 502, 2xx without usage: each assumed at the worst case.
    const r = billAttempts([{ status: undefined }, { status: 502 }, { status: 200 }, ok], opts);
    assert.equal(r.assumedAttempts, 3);
    assert.ok(Math.abs(r.assumedUsd - 3 * 0.65) < 1e-12);
    assert.ok(Math.abs(r.usd - (r.actualUsd + r.assumedUsd)) < 1e-12);
    // A temperature 400 and a 402 are refusals: nothing generated, nothing billed.
    assert.equal(billAttempts([{ status: 400 }, { status: 402 }, { status: 429 }], opts).usd, 0);
    // Web search is added only when a search ran (citations > 0).
    assert.ok(Math.abs(billAttempts([{ ...ok, citations: 2 }], opts).usd - b.usd - 0.01) < 1e-12);
  });

  it("gates each shape on its worst case: chat()'s 50k completion floor fully spent", () => {
    const plan = buildPlan(parseProbeArgs([]), effortFor);
    assert.deepEqual(plan.map((p) => p.id), [...SHAPE_ORDER]);
    const smoke = plan.find((p) => p.id === "smoke")!;
    const refine = plan.find((p) => p.id === "refine")!;
    const python = plan.find((p) => p.id === "python")!;
    assert.ok(Math.abs(worstCallUsd(smoke, estimateCallCost, 50_000) - ((300 * 2.5 + 50_000 * 12.5) / 1e6)) < 1e-12);
    assert.ok(Math.abs(shapeWorstUsd(refine, estimateCallCost, 50_000) - 2 * worstCallUsd(refine, estimateCallCost, 50_000)) < 1e-12, "refine is two calls");
    assert.ok(worstCallUsd(python, estimateCallCost, 50_000) > worstCallUsd(smoke, estimateCallCost, 50_000), "web search on top");
    // Typical spend runs every shape; if every call maxes out, the gate stops the run under budget.
    let spent = 0;
    let ran = 0;
    for (const p of plan) {
      const w = shapeWorstUsd(p, estimateCallCost, 50_000);
      if (wouldExceedBudget(spent, w, DEFAULT_BUDGET_USD)) break;
      spent += w;
      ran++;
    }
    assert.ok(spent <= DEFAULT_BUDGET_USD, `worst-case run spends ${spent}`);
    assert.ok(ran >= plan.length - 1, "all but the last shape still fit when every call maxes out");
    // refine's dial is the model's own (refine.ts passes none), whatever --effort says.
    assert.equal(buildPlan(parseProbeArgs(["--effort", "high"]), effortFor).find((p) => p.id === "refine")!.effort, "xhigh");
  });

  it("pre-flight floor leaves a reserve for the live daemon on the same key", () => {
    assert.equal(preflightFloorUsd(5, 1.27, 10), 16.27);
    assert.equal(preflightVerdict({ accessPermitted: true, usd: 0, diem: 16 }, preflightFloorUsd(5, 1.27, 10)).ok, false);
    assert.equal(preflightVerdict({ accessPermitted: true, usd: 1, diem: 16 }, preflightFloorUsd(5, 1.27, 10)).ok, true);
  });
});

describe("_probe-gpt61 balance brackets", () => {
  const snap = (diem: number, epoch = "2026-10-03T00:00:00Z") => ({ accessPermitted: true, usd: 0, diem, nextEpochBegins: epoch });

  it("subtracts the daemon's ledgered spend inside the window only", () => {
    const rows = [
      { ts: "2026-10-02T00:10:00.000Z", estCost: 0.2, model: "grok-4-7" },
      { ts: "2026-10-02T00:20:00.000Z", estCost: 0.1, model: "jev-latest" },
      { ts: "2026-10-02T01:00:00.000Z", estCost: 9, model: "grok-4-7" }, // after the window
      { ts: "nonsense", estCost: 5 },
    ];
    const d = ledgerSpendInWindow(rows, Date.parse("2026-10-02T00:05:00Z"), Date.parse("2026-10-02T00:30:00Z"));
    assert.ok(Math.abs(d.usd - 0.3) < 1e-12);
    assert.equal(d.rows, 2);
    assert.ok(Math.abs(d.byModel["grok-4-7"] - 0.2) < 1e-12);
  });

  it("reports an attributable ratio, and says when it is not comparable", () => {
    const base = { label: SOL, startMs: 0, endMs: 1, probeEstUsd: 1 };
    const clean = bracketReport({ ...base, before: snap(30), after: snap(28.9), daemon: { usd: 0.1, rows: 2 } });
    assert.ok(Math.abs(clean.attributableDropUsd! - 1.0) < 1e-9);
    assert.ok(Math.abs(clean.ratio! - 1.0) < 1e-9);
    assert.equal(clean.comparable, true);
    const busy = bracketReport({ ...base, before: snap(30), after: snap(28), daemon: { usd: 1, rows: 9 } });
    assert.equal(busy.comparable, false, "daemon over a quarter of the drop");
    const refill = bracketReport({ ...base, before: snap(2), after: snap(35, "2026-10-04T00:00:00Z"), daemon: { usd: 0, rows: 0 } });
    assert.equal(refill.comparable, false);
    assert.match(refill.notes.join(" "), /rolled over/);
    const unread = bracketReport({ ...base, before: snap(30), after: null, daemon: { usd: 0, rows: 0 } });
    assert.equal(unread.balanceDropUsd, null);
    assert.equal(unread.comparable, false);
  });
});

describe("_probe-gpt61 swap completeness and shape audits", () => {
  it("lists the .env keys that keep call sites off the probed model (the 2026-10-01 .env:47 / .env:80 leak)", () => {
    const env = { NOOKPLOT_AGENT_API_MODEL: "grok-4-7", MODEL_OBSERVE: "grok-4-7", MODEL_MINING_SOLVE: SOL, BOT_LEAN: "0", VENICE_API_KEY: "x" };
    const o = envModelOverrides(env, SOL);
    assert.deepEqual(o.map((x) => x.key), ["NOOKPLOT_AGENT_API_MODEL", "MODEL_OBSERVE"]);
    assert.match(o[0].effect, /projects/);
    assert.deepEqual(envModelOverrides({ NOOKPLOT_AGENT_API_MODEL: SOL, MODEL_OBSERVE: SOL }, SOL), []);
    assert.deepEqual(envModelOverrides({ MODEL_VERIFICATION_SCORE: "grok-4-7", BOT_LEAN: "1" }, SOL).map((x) => x.key), ["MODEL_VERIFICATION_SCORE", "BOT_LEAN"]);
  });

  it("flags a revise pass that would ship a fence, a preamble, or dropped headings", () => {
    // The draft has no "## Uncertainty", so its absence from the revise is not a drop.
    const draft = "## Approach\na\n## Steps\nb\n## Conclusion\nc\n## Citations\nd";
    assert.deepEqual(auditRevise(draft, draft), { cleanStart: true, preamble: false, headingsMissing: [] });
    assert.equal(auditRevise(draft, "```markdown\n" + draft).cleanStart, false);
    assert.equal(auditRevise(draft, '{"trace": "..."}').cleanStart, false);
    assert.equal(auditRevise(draft, "Here is the revised trace:\n" + draft).preamble, true);
    assert.deepEqual(auditRevise(draft, draft.replace("## Citations\nd", "")).headingsMissing, ["## Citations"]);
  });

  it("checks comprehension answers are flat strings keyed by question id (index.ts reads parsed[q.id])", () => {
    const ex = (s: string) => {
      const m = s.match(/\{[\s\S]*\}/);
      return m ? m[0] : null;
    };
    const ids = ["q1", "q2"];
    assert.deepEqual(auditComprehensionAnswers('{"q1":"uses paging here","q2":"waste under 4%"}', ids, ex), { parsed: true, answered: 2, nested: false });
    assert.equal(auditComprehensionAnswers('{"answers":{"q1":"uses paging here","q2":"waste under 4%"}}', ids, ex).nested, true);
    assert.equal(auditComprehensionAnswers('{"q1":{"answer":"uses paging"},"q2":"waste under 4%"}', ids, ex).answered, 1);
    assert.equal(auditComprehensionAnswers('{"q1":"ok","q2":"waste under 4%"}', ids, ex).answered, 1, "≤5 chars is replaced by a canned fallback");
    assert.equal(auditComprehensionAnswers("no json here", ids, ex).parsed, false);
  });

  it("from a linked worktree, defaults .env and the vault to the main working tree", () => {
    const main = "/r/nookplot-bot";
    const wt = "/r/nookplot-bot/.claude/worktrees/w1";
    const present = new Set([`${main}/.env`, `${main}/knowledge-vault/research`]);
    const exists = (p: string) => present.has(p);
    const fromWt = resolveProbePaths({ cwd: wt, repoRoot: wt, mainTree: main, exists });
    assert.equal(fromWt.envPath, `${main}/.env`);
    assert.equal(fromWt.vaultDir, `${main}/knowledge-vault`);
    assert.equal(fromWt.notes.length, 2);
    // Explicit flags and DOTENV_CONFIG_PATH win; the main tree itself needs no fallback.
    assert.equal(resolveProbePaths({ cwd: wt, repoRoot: wt, mainTree: main, exists, envPathArg: "/e/.env" }).envPath, "/e/.env");
    assert.equal(resolveProbePaths({ cwd: wt, repoRoot: wt, mainTree: main, exists, dotenvConfigPath: "/d/.env" }).envPath, "/d/.env");
    const fromMain = resolveProbePaths({ cwd: main, repoRoot: main, mainTree: main, exists });
    assert.equal(fromMain.envPath, `${main}/.env`);
    assert.equal(fromMain.mainTree, null);
    assert.equal(fromMain.notes.length, 0);
    // Nothing anywhere: no env path (the real run then refuses: no key).
    assert.equal(resolveProbePaths({ cwd: wt, repoRoot: wt, mainTree: null, exists: () => false }).envPath, undefined);
  });
});
