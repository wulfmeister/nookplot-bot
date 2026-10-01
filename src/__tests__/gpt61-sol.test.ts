/**
 * 2026-10-01: single-model roster moves grok-4-7 → openai-gpt-61-sol, plus the
 * pure helpers of the pre-restart probe (src/_probe-gpt61.ts). The probe module
 * imports node builtins only at load time, so importing it here runs nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, brotliCompressSync } from "node:zlib";

import { pickModel, pickModelAB, effortFor, pickAlternateModel, abPool } from "../models.js";
import { estimateCallCost } from "../venice-cost.js";
import { gatewayModelName, maybeOverrideModelForVerifiable } from "../mining.js";
import {
  isBillingStop,
  decideAfterCall,
  wouldExceedBudget,
  preflightVerdict,
  parseProbeArgs,
  decodeBody,
  headerValue,
  hasCitationMarkers,
  parseMiningNote,
  parseVerificationNote,
  SHAPE_ORDER,
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
    assert.deepEqual([d.dry, d.budget, d.model, d.source, d.jev], [false, 3, SOL, "vault", true]);
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
    assert.deepEqual([...SHAPE_ORDER], ["smoke", "json", "review", "verify", "python", "standard", "jev"]);
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
