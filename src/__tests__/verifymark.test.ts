/**
 * Verify failure classification — src/verify-errors.ts.
 *
 * Strings marked [log] are verbatim from ~/.nookplot/bot.out.log or
 * ~/.nookplot/logs/bot.log (some truncated where our own logger sliced them at
 * 180-200 chars). Strings marked [test] are the production bodies already
 * pinned in backend.test.ts ("[real-body]" suite); our log prints a summary for
 * those classes instead of the raw body. [reconstructed] means the wording
 * comes from a code comment, not a captured body.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerifyError,
  decideVerifyFailure,
  errorStatus,
  isComprehensionGateError,
  isVeniceBudgetError,
  SCORE_PARSE_FAIL,
  VERIFY_RETRY_DEFAULTS,
  type VerifyErrorKind,
  type VerifyRetryConfig,
} from "../verify-errors.js";
import { verifyTransientSkip, verifyBudgetPause, VERIFY_BUDGET_PAUSE_KEY, finalizedSubmissionSkip } from "../skip-caches.js";

const VENICE_402_SPEND_LIMIT =
  'Venice API 402: {"error":"API key DIEM spend limit exceeded. Your account may still have DIEM balance, but this API key has reached its configured DIEM spending limit."}';
const VENICE_402_BALANCE =
  'Venice API 402: {"error":"Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits."}';
const GATEWAY_502_HTML =
  "Gateway request failed (502): <!DOCTYPE html>\n<!--[if lt IE 7]> <html class=\"no-js ie6 oldie\" lang=\"en-US\"> <![endif]-->\n<!--[if IE 7]>    <html class=\"no-js ie7 oldie\" lang=\"en-US\"> <![endif]-->";
const GATEWAY_500_RECORDING =
  "Gateway request failed (500): The gateway hit an unexpected error while recording your verification. Your sandbox attestation is still intact on the client — the CLI will offer to resume on the next r";

type Row = { msg: string; kind: VerifyErrorKind; permanent: boolean; strikes: boolean; pauseAll?: boolean; src: string };

const TABLE: Row[] = [
  // ── Gateway-permanent: mark done ────────────────────────────────────────────
  { src: "[test]", kind: "finalized", permanent: true, strikes: false,
    msg: "Gateway request failed (410): Submission already finalized (status: verified)" },
  { src: "[test]", kind: "diversity", permanent: true, strikes: false,
    msg: "Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days" },
  { src: "[test]", kind: "reciprocal", permanent: true, strikes: false,
    msg: "Gateway request failed (429): Reciprocal verification detected: this solver has verified your work 3+ times recently. Mutual verification pairs are limited to prevent score inflation rings." },
  { src: "[reconstructed]", kind: "comprehension-gate", permanent: true, strikes: false,
    msg: "Gateway request failed (422): Complete the comprehension challenge before verifying" },
  { src: "[reconstructed]", kind: "comprehension-gate", permanent: true, strikes: false,
    msg: "Gateway request failed (422): ARTIFACT_INSPECTION_REQUIRED" },
  { src: "[log]", kind: "client-4xx", permanent: true, strikes: false,
    msg: "Gateway request failed (403): Cannot verify submissions on your own challenge. This is a conflict of interest." },
  { src: "[log]", kind: "client-4xx", permanent: true, strikes: false,
    msg: "Gateway request failed (422): Knowledge insight doesn't reference the specific challenge enough (similarity 0.220 < 0.25). **How to fix:** name specific terms from the challenge description or test ca" },
  { src: "[log]", kind: "client-4xx", permanent: true, strikes: false,
    msg: "Gateway request failed (400): Invalid CID format" },
  { src: "[log]", kind: "client-4xx", permanent: true, strikes: false,
    msg: `Venice API 400: {"error":"Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.","request_id":"F-LuUCVBrBkRpxdJ70IwH"}` },

  // ── Temporary, not about this submission: retry later, no strike ────────────
  { src: "[log]", kind: "budget", permanent: false, strikes: false, pauseAll: true, msg: VENICE_402_SPEND_LIMIT },
  { src: "[log]", kind: "budget", permanent: false, strikes: false, pauseAll: true, msg: VENICE_402_BALANCE },
  { src: "[test]", kind: "verify-cap", permanent: false, strikes: false,
    msg: "Gateway request failed (429): Maximum 40 verification challenge per 24-hour epoch. Try again next epoch." },
  { src: "[log]", kind: "rate", permanent: false, strikes: false,
    msg: 'Venice API 429: {"error":"The model is currently overloaded. Please try again later."}' },
  { src: "[log]", kind: "rate", permanent: false, strikes: false,
    msg: "Gateway request failed (429): Verification cooldown: wait 55s before your next verification or crowd score (anti-spam protection, shared across both paths)" },
  { src: "[log]", kind: "rate", permanent: false, strikes: false,
    msg: "Gateway request failed (429): Rate limit exceeded: max 10 executions per hour" },
  { src: "[log]", kind: "unavailable", permanent: false, strikes: false, msg: GATEWAY_502_HTML },
  { src: "[log]", kind: "unavailable", permanent: false, strikes: false,
    msg: "Gateway request failed (503): Failed to pin submission to IPFS (one of: artifact, reasoning). Retry." },
  { src: "[log]", kind: "transport", permanent: false, strikes: false, msg: "fetch failed" },
  { src: "[log]", kind: "transport", permanent: false, strikes: false,
    msg: '{"message":"fetch failed","cause":{"errno":-54,"code":"ECONNRESET","syscall":"read"}}' },

  // ── Temporary, possibly about this submission: retry later, strike ───────────
  { src: "[log]", kind: "server", permanent: false, strikes: true, msg: GATEWAY_500_RECORDING },
  { src: "[log]", kind: "server", permanent: false, strikes: true, msg: 'Venice API 500: {"error":"Inference processing failed"}' },
  { src: "[log]", kind: "timeout", permanent: false, strikes: true, msg: "This operation was aborted" },
  { src: "synthetic", kind: "parse", permanent: false, strikes: true, msg: SCORE_PARSE_FAIL },
  { src: "synthetic", kind: "unknown", permanent: false, strikes: true, msg: "Cannot read properties of undefined (reading 'trim')" },
];

describe("verify-errors.classifyVerifyError (table over production strings)", () => {
  for (const row of TABLE) {
    it(`${row.src} ${row.kind}: ${row.msg.slice(0, 70)}`, () => {
      const c = classifyVerifyError(row.msg);
      assert.equal(c.kind, row.kind);
      assert.equal(c.permanent, row.permanent);
      assert.equal(c.strikes, row.strikes);
      assert.equal(c.pauseAll, row.pauseAll ?? false);
    });
  }

  it("the cooldown 429 is a rate limit, not the shared verify cap", () => {
    // It mentions "verification or crowd score" and "shared"; must not halt the day.
    const c = classifyVerifyError(TABLE.find((r) => r.msg.includes("Verification cooldown"))!.msg);
    assert.equal(c.kind, "rate");
  });

  it("the gateway's permanent 429s win over the generic 429 rule", () => {
    assert.equal(classifyVerifyError("Gateway request failed (429): You've verified this solver's work 3+ times in the last 14 days").kind, "diversity");
    assert.equal(classifyVerifyError("Gateway request failed (429): Reciprocal verification detected: x").kind, "reciprocal");
  });

  it("a non-Error throw (message undefined) classifies as unknown instead of throwing", () => {
    const c = classifyVerifyError(undefined as unknown as string);
    assert.equal(c.kind, "unknown");
    assert.equal(decideVerifyFailure(undefined as unknown as string, 0).action, "retry-later");
  });

  it("no temporary class is permanent and no permanent class strikes", () => {
    for (const row of TABLE) {
      const c = classifyVerifyError(row.msg);
      if (c.permanent) assert.equal(c.strikes, false, row.msg);
      if (c.pauseAll) assert.equal(c.permanent, false, row.msg);
    }
  });
});

describe("verify-errors detectors", () => {
  it("errorStatus reads both error formats", () => {
    assert.equal(errorStatus(GATEWAY_500_RECORDING), 500);
    assert.equal(errorStatus(GATEWAY_502_HTML), 502);
    assert.equal(errorStatus(VENICE_402_SPEND_LIMIT), 402);
    assert.equal(errorStatus("fetch failed"), null);
  });

  it("isVeniceBudgetError matches both 402 bodies and nothing else in the table", () => {
    assert.ok(isVeniceBudgetError(VENICE_402_SPEND_LIMIT));
    assert.ok(isVeniceBudgetError(VENICE_402_BALANCE));
    for (const row of TABLE.filter((r) => r.kind !== "budget")) assert.equal(isVeniceBudgetError(row.msg), false, row.msg);
  });

  it("isComprehensionGateError (moved from index.ts) keeps both patterns", () => {
    assert.ok(isComprehensionGateError("complete the comprehension challenge before verifying"));
    assert.ok(isComprehensionGateError("422 ARTIFACT_INSPECTION_REQUIRED"));
    assert.equal(isComprehensionGateError(GATEWAY_500_RECORDING), false);
  });
});

describe("verify-errors.decideVerifyFailure", () => {
  const cfg: VerifyRetryConfig = { retryAfterMs: 45 * 60_000, strikeLimit: 3 };

  it("defaults: 45-minute retry window, 3 strikes", () => {
    // The test script does not set BOT_VERIFY_RETRY_MIN / BOT_VERIFY_RETRY_STRIKES.
    assert.equal(VERIFY_RETRY_DEFAULTS.retryAfterMs, 45 * 60_000);
    assert.equal(VERIFY_RETRY_DEFAULTS.strikeLimit, 3);
  });

  it("permanent outcomes mark done whatever the strike count", () => {
    for (const prior of [0, 2, 9]) {
      const d = decideVerifyFailure("Gateway request failed (410): Submission already finalized (status: verified)", prior, cfg);
      assert.equal(d.action, "mark-done");
      assert.equal(d.retired, false);
      assert.equal(d.retryAfterMs, 0);
    }
  });

  it("Venice 402 keeps the candidate, never strikes, and pauses the loop", () => {
    const d = decideVerifyFailure(VENICE_402_SPEND_LIMIT, 2, cfg);
    assert.equal(d.action, "retry-later");
    assert.equal(d.retryAfterMs, cfg.retryAfterMs);
    assert.equal(d.pauseAllMs, cfg.retryAfterMs);
    assert.equal(d.strikesAfter, 2, "a 402 does not consume a strike");
    // Even a long outage (many 402s) never retires the submission.
    assert.equal(decideVerifyFailure(VENICE_402_SPEND_LIMIT, 1000, cfg).action, "retry-later");
  });

  it("rate limits, outages and transport errors never retire", () => {
    for (const msg of ["fetch failed", GATEWAY_502_HTML, 'Venice API 429: {"error":"The model is currently overloaded. Please try again later."}']) {
      const d = decideVerifyFailure(msg, 50, cfg);
      assert.equal(d.action, "retry-later", msg);
      assert.equal(d.pauseAllMs, 0, msg);
      assert.equal(d.strikesAfter, 50, msg);
    }
  });

  it("strike-counting failures retire on the third strike", () => {
    const first = decideVerifyFailure(GATEWAY_500_RECORDING, 0, cfg);
    assert.deepEqual([first.action, first.strikesAfter], ["retry-later", 1]);
    const second = decideVerifyFailure("This operation was aborted", first.strikesAfter, cfg);
    assert.deepEqual([second.action, second.strikesAfter], ["retry-later", 2]);
    const third = decideVerifyFailure(SCORE_PARSE_FAIL, second.strikesAfter, cfg);
    assert.equal(third.action, "mark-done");
    assert.equal(third.retired, true);
  });

  it("strikeLimit=1 restores the old mark-on-first-failure behaviour for strike kinds only", () => {
    const one: VerifyRetryConfig = { retryAfterMs: cfg.retryAfterMs, strikeLimit: 1 };
    assert.equal(decideVerifyFailure(GATEWAY_500_RECORDING, 0, one).action, "mark-done");
    assert.equal(decideVerifyFailure(VENICE_402_SPEND_LIMIT, 0, one).action, "retry-later");
  });
});

describe("verify-errors replay of the 2026-10-01 incidents", () => {
  // Minimal model of index.ts handleVerifyFailure's bookkeeping.
  function replay(msgs: string[], cfg: VerifyRetryConfig = { retryAfterMs: 45 * 60_000, strikeLimit: 3 }) {
    let strikes = 0;
    let done = false;
    let paused = false;
    for (const m of msgs) {
      const d = decideVerifyFailure(m, strikes, cfg);
      if (d.pauseAllMs > 0) paused = true;
      if (d.action === "mark-done") { done = true; break; }
      strikes = d.strikesAfter;
    }
    return { done, strikes, paused };
  }

  it("8fc39106 (trace fetched, then a 402) stays a candidate", () => {
    assert.deepEqual(replay([VENICE_402_SPEND_LIMIT]), { done: false, strikes: 0, paused: true });
  });

  it("34618e81 (rerun spent, 402 on two separate passes) stays a candidate", () => {
    assert.deepEqual(replay([VENICE_402_SPEND_LIMIT, VENICE_402_SPEND_LIMIT]), { done: false, strikes: 0, paused: true });
  });

  it("a mixed bad night (402, 429, fetch failed, 502, one 500) keeps the candidate", () => {
    const r = replay([
      VENICE_402_SPEND_LIMIT,
      'Venice API 429: {"error":"The model is currently overloaded. Please try again later."}',
      "fetch failed",
      GATEWAY_502_HTML,
      GATEWAY_500_RECORDING,
    ]);
    assert.equal(r.done, false);
    assert.equal(r.strikes, 1);
  });

  it("a poison pill (three 500s) is retired after three attempts, not one and not forever", () => {
    assert.equal(replay([GATEWAY_500_RECORDING, GATEWAY_500_RECORDING]).done, false);
    assert.equal(replay([GATEWAY_500_RECORDING, GATEWAY_500_RECORDING, GATEWAY_500_RECORDING]).done, true);
  });
});

describe("skip-caches: verify transient caches", () => {
  it("transient skip, budget pause and finalized skip are separate caches", () => {
    const id = `verifymark-test-${Date.now()}`;
    verifyTransientSkip.markFor(id, 60_000);
    assert.ok(verifyTransientSkip.isSkipped(id));
    assert.equal(finalizedSubmissionSkip.isSkipped(id), false);
    assert.equal(verifyBudgetPause.isSkipped(id), false);
    verifyBudgetPause.markFor(VERIFY_BUDGET_PAUSE_KEY, 60_000);
    assert.ok(verifyBudgetPause.isSkipped(VERIFY_BUDGET_PAUSE_KEY));
    assert.equal(verifyTransientSkip.isSkipped(VERIFY_BUDGET_PAUSE_KEY), false);
  });

  it("an expired transient skip releases the candidate", () => {
    const id = `verifymark-expired-${Date.now()}`;
    verifyTransientSkip.markUntil(id, Date.now() - 1);
    assert.equal(verifyTransientSkip.isSkipped(id), false);
  });
});
