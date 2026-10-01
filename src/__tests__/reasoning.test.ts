/**
 * Code-kind submissions are driven from `reasoning` (2026-10-01).
 *
 * On /submit-solution the gateway stores, length-checks and scores the
 * `reasoning` field, not traceSummary. These tests pin:
 *   - the composed reasoning (never the ~65-char stub, `||` not `??`),
 *   - the exact /submit-solution body (reasoning === traceSummary),
 *   - that the on-400 retry revises the field SENT as `reasoning` — the
 *     regression the whole change exists to prevent (the old retry enriched
 *     traceSummary and failed 74/76 times on python),
 *   - that real gateway-ACCEPTED reasonings go out untouched (the local mirror
 *     rejects most of them, so it must not gate this path).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifiableReasoning,
  buildSubmitSolutionBody,
  planReasoningRetry,
  withReasoning,
  summaryRejectionKind,
  scoredFieldFor,
  clipAtBoundary,
  challengeGrounding,
  REASONING_MIN_CHARS,
  REASONING_MAX_CHARS,
  type SubmitSolutionBody,
} from "../verifiable-reasoning.js";
import { enrichSummarySpecificity, specificityCategories } from "../specificity-gate.js";

// Verbatim gateway bodies from ~/.nookplot/logs/bot.log.
// b0249d97, 2026-10-01T02:33Z — scored on the reasoning sent beside a
// traceSummary that the local mirror passed 5/6.
const SPEC_400 =
  "Gateway request failed (400): traceSummary specificity score 33/100 (threshold 35). Sub-scores: numbers +0, techniques +0, comparisons +0, code +3, failures +0, actionable +0. Missing categories: numbers (no concrete measurements/percentages/counts with units); technique names (no camelCase/quoted method names); comparisons (no 'X vs Y' / 'better than' / 'instead of' phrasing). Pick at least TWO and add to the summary. Concrete fix: rewrite the summary with the specific algorithm step + a measurable claim (e.g., \"the bit-length method returns 1 << (n.bit_length() - 1) for n>=1, n=0 returns 0\"). Avoid adding METADATA (reward amounts, function names, learning IDs) — those don't increase specificity; reasoning details do.";
// 5deacf30, 2026-09-21T07:41Z (python_tests, deepseek-v4-1-flash).
const MIN100_400 =
  "Gateway request failed (400): traceSummary is required (minimum 100 characters). Describe your approach, the key decision you made, and why it works. Generic summaries are rejected.";
const CAP_429 = "Gateway request failed (429): Maximum 12 regular challenge per 24-hour epoch. Try again next epoch.";

const CH = {
  title: "Count a file's lines with wc -l (line_total)",
  description:
    "Write `line_total(path)` that returns the line count of a file by running wc -l. The path is user-supplied: reject '..' traversal and never pass it through a shell. Return -1 when the file is missing.",
};
const CODE = [
  "import os, subprocess",
  "def line_total(path):",
  "    norm = os.path.normpath(path)",
  "    if norm.startswith('..') or os.path.isabs(norm):",
  "        return -1",
  "    if not os.path.isfile(norm):",
  "        return -1",
  '    out = subprocess.run(["wc", "-l", norm], capture_output=True, text=True, encoding="utf-8")',
  "    if out.returncode != 0:",
  "        return -1",
  "    return int(out.stdout.split()[0])",
].join("\n");

// Real reasonings the gateway ACCEPTED on python_tests (vault "Our reasoning",
// i.e. the exact text sent as `reasoning`; verdict = accepted, field = reasoning).
const ACCEPTED_REASONINGS = [
  "Active SSRF threat model (CWE-918, CVE-2021-26855). Block private, loopback, link-local, and metadata hosts before fetch; a blind scan costs about 2^32 IPv4 ops vs one request.",
  "Active local file-disclosure threat (CWE-22, CVE-2021-41773). Check cost is 2 path ops, under 2^12 comparisons, vs unbounded traversal.",
  "SSRF-safe unfurler: http/https only, decode obfuscated IPv4/IPv6 forms, reject userinfo/backslash/%, resolve DNS and block any non-global IP, cap output at 512 bytes.",
  "Active attacker model: tagged JSON allowlist, never pickle. Cites CWE-502 and CVE-2017-18342; breakage above 2^128 ops. Round-trips nested values and fails closed.",
];

function body(reasoning: string): SubmitSolutionBody {
  return buildSubmitSolutionBody({
    artifactType: "code",
    artifact: { files: { "solution.py": CODE } },
    reasoning,
    modelUsed: "grok-4-7",
    selfReportedWallMs: 1234,
    guildId: 100002,
  });
}

describe("verifiable-reasoning.buildVerifiableReasoning", () => {
  it("an empty reasoning falls through to the summary (|| not ??)", () => {
    const summary = "Confines the path with os.path.normpath and runs wc -l through an argv list, so a '..' segment fails closed and returns -1.";
    assert.equal(buildVerifiableReasoning({ reasoning: "", summary }, CH), summary);
  });

  it("never ships the ~65-char 'Python solution for <title>.' stub — grounds in the challenge instead", () => {
    const out = buildVerifiableReasoning({}, CH);
    assert.ok(out.length >= REASONING_MIN_CHARS, `got ${out.length}: ${out}`);
    assert.ok(!/solution for/i.test(out), out);
    assert.ok(out.startsWith("Challenge: Count a file's lines"), out);
    assert.ok(out.includes("reject '..' traversal"), "grounding is verbatim challenge text, not filler");
  });

  it("an in-spec but sub-100 reasoning is extended with the summary, then grounding", () => {
    const short = "Uses an argv list for `subprocess.run` and fails closed on '..'.";
    assert.ok(short.length < 100);
    const withSummary = buildVerifiableReasoning({ reasoning: short, summary: "Missing files return -1 instead of raising." }, CH);
    assert.ok(withSummary.startsWith(short));
    assert.ok(withSummary.includes("Missing files return -1"));
    const grounded = buildVerifiableReasoning({ reasoning: short }, CH);
    assert.ok(grounded.startsWith(short) && grounded.includes("Challenge:") && grounded.length >= 100, grounded);
  });

  it("a ≥100-char reasoning ships verbatim (whitespace collapsed), the summary is ignored", () => {
    for (const r of ACCEPTED_REASONINGS) {
      assert.equal(buildVerifiableReasoning({ reasoning: r, summary: "IGNORED summary text" }, CH), r);
    }
    assert.equal(buildVerifiableReasoning({ reasoning: `  ${ACCEPTED_REASONINGS[0].replace(". ", ".\n\n")}  ` }, CH), ACCEPTED_REASONINGS[0]);
  });

  it("clips an over-long reasoning at a boundary, at most REASONING_MAX_CHARS", () => {
    const long = Array.from({ length: 20 }, (_, i) => `Step ${i} confines the path and fails closed on traversal.`).join(" ");
    const out = buildVerifiableReasoning({ reasoning: long }, CH);
    assert.ok(out.length <= REASONING_MAX_CHARS && out.length > REASONING_MAX_CHARS * 0.6);
    assert.ok(out.endsWith("."), `clipped at a sentence end: …${out.slice(-30)}`);
  });

  it("non-string fields are treated as absent", () => {
    const out = buildVerifiableReasoning({ reasoning: 42, summary: { text: "x" } }, CH);
    assert.ok(out.startsWith("Challenge:"));
  });
});

describe("verifiable-reasoning.buildSubmitSolutionBody", () => {
  it("sends one text in both fields; reasoning is the scored field on this route", () => {
    const b = body(ACCEPTED_REASONINGS[1]);
    assert.equal(b.reasoning, ACCEPTED_REASONINGS[1]);
    assert.equal(b.traceSummary, b.reasoning);
    assert.equal(scoredFieldFor("submit-solution"), "reasoning");
    assert.equal(scoredFieldFor("submit"), "traceSummary");
    assert.deepEqual(Object.keys(b).sort(), ["artifact", "artifactType", "guildId", "modelUsed", "reasoning", "selfReportedWallMs", "traceSummary"]);
  });

  it("omits guildId when not in a guild", () => {
    const b = buildSubmitSolutionBody({ reasoning: "r".repeat(120), modelUsed: "m", selfReportedWallMs: 1, guildId: null });
    assert.equal("guildId" in b, false);
  });

  it("withReasoning moves both fields together", () => {
    const b = withReasoning(body(ACCEPTED_REASONINGS[0]), "x".repeat(130));
    assert.equal(b.reasoning, "x".repeat(130));
    assert.equal(b.traceSummary, b.reasoning);
    assert.equal(b.artifactType, "code");
  });
});

describe("verifiable-reasoning.planReasoningRetry (regression: revise the field SENT as reasoning)", () => {
  it("classifies the gateway's text verdicts, and nothing else", () => {
    assert.equal(summaryRejectionKind(SPEC_400), "specificity");
    assert.equal(summaryRejectionKind(MIN100_400), "length");
    assert.equal(summaryRejectionKind(CAP_429), null);
    assert.equal(planReasoningRetry(body(ACCEPTED_REASONINGS[0]), CAP_429, [CODE], CH), null);
  });

  it("on a specificity 400 it reads body.reasoning — NOT a divergent traceSummary — and writes both fields", () => {
    // What the gateway scored 33/100 (code +3 only): a backticked identifier
    // and nothing else it credits.
    const sentReasoning = "Implements `line_total(path)` by normalizing the user path and running the wc binary through a subprocess argv list.";
    // A rich traceSummary like the one sent beside it on 10-01 — the field
    // the old retry enriched and the gateway never read on this route.
    const ignoredSummary =
      'The counter calls `subprocess.run` with an argv list and shell disabled, using "os.path.normpath" to confine the user path before spawn. It fails closed with an error on \'..\' segments.';
    const sent: SubmitSolutionBody = { ...body(sentReasoning), traceSummary: ignoredSummary };
    const plan = planReasoningRetry(sent, SPEC_400, [CODE, CH.description], CH);
    assert.ok(plan, "something extractable for the missing categories");
    assert.equal(plan.before, sent.reasoning, "the revision starts from the text sent as reasoning");
    assert.ok(plan.after.startsWith(sentReasoning), "the sent reasoning is extended, not replaced");
    assert.ok(!plan.after.includes("os.path.normpath\" to confine"), "the ignored traceSummary is not the source of the revision");
    assert.notEqual(plan.after, sentReasoning);
    assert.equal(plan.body.reasoning, plan.after, "the retry body carries the revision in `reasoning`");
    assert.equal(plan.body.traceSummary, plan.body.reasoning, "and the identical traceSummary");
    assert.equal(plan.body.artifact, sent.artifact);
    assert.ok(plan.missing.includes("techniques") && plan.missing.includes("numbers"));
  });

  it("trusts the gateway's +0 over the local mirror (snake_case reads as a technique locally)", () => {
    const sentReasoning = "Implements `line_total` by normalizing the user path with os normpath and running the wc binary via subprocess argv.";
    assert.equal(specificityCategories(sentReasoning).techniques, true, "the mirror credits snake_case");
    // Without trust the enricher would skip techniques entirely:
    assert.equal(
      enrichSummarySpecificity(sentReasoning, [CODE], ["techniques"]),
      sentReasoning,
      "default behavior (standard path) unchanged",
    );
    const plan = planReasoningRetry(body(sentReasoning), SPEC_400, [CODE], CH);
    assert.ok(plan && /technique "/.test(plan.after), `a technique fragment is added: ${plan?.after}`);
  });

  it("on a 'minimum 100 characters' 400 it lifts the sent reasoning over 100 chars", () => {
    const sent = body("Counts lines with wc via an argv list.");
    const plan = planReasoningRetry(sent, MIN100_400, [CODE, CH.description], CH);
    assert.ok(plan);
    assert.equal(plan.kind, "length");
    assert.ok(plan.after.startsWith("Counts lines with wc via an argv list."));
    assert.ok(plan.after.length >= REASONING_MIN_CHARS, `${plan.after.length}: ${plan.after}`);
    assert.equal(plan.body.traceSummary, plan.body.reasoning);
  });

  it("returns null when nothing can be added — a retry would fail identically", () => {
    const sent = body("x".repeat(150));
    const onlyComparisons = SPEC_400.replace(/Sub-scores:[^.]*\./, "Sub-scores: comparisons +0.").replace(
      /Missing categories:[^.]*\./,
      "Missing categories: comparisons (no 'X vs Y' phrasing).",
    );
    assert.equal(planReasoningRetry(sent, onlyComparisons, ["no comparative phrasing anywhere in here"], {}), null);
  });
});

describe("real gateway-accepted reasonings are submitted untouched (no local mirror gate on this path)", () => {
  it("each fixture survives compose → body unchanged, in both fields", () => {
    for (const r of ACCEPTED_REASONINGS) {
      const b = body(buildVerifiableReasoning({ reasoning: r }, CH));
      assert.equal(b.reasoning, r);
      assert.equal(b.traceSummary, r);
    }
  });
});

describe("helpers", () => {
  it("clipAtBoundary prefers a sentence end and never exceeds max", () => {
    assert.equal(clipAtBoundary("short", 10), "short");
    const s = "First sentence is here. Second sentence runs on and on past the limit";
    assert.equal(clipAtBoundary(s, 34), "First sentence is here.");
    assert.ok(clipAtBoundary("word ".repeat(40), 50).length <= 50);
  });
  it("challengeGrounding is empty without a title or description", () => {
    assert.equal(challengeGrounding({}), "");
    assert.equal(challengeGrounding({ title: "T" }), "Challenge: T");
  });
});

describe("mining.ts wiring pin (the pipeline posts and revises the same body)", () => {
  // The mining loop needs a live runtime + a model call, so it is not driven
  // here. Pin the two lines that decide WHICH field the retry touches: the
  // /submit-solution POST sends the built body, and the on-400 plan reads that
  // same body. If someone re-splits reasoning and traceSummary, this fails.
  it("POSTs solutionBody to /submit-solution and plans the retry from solutionBody", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../mining.ts", import.meta.url), "utf8");
    assert.match(src, /\/submit-solution`,\s*\n\s*solutionBody,\s*\n/);
    assert.match(src, /planReasoningRetry\(solutionBody, /);
    assert.match(src, /buildSubmitSolutionBody\(\{[\s\S]{0,200}reasoning: sv\.reasoning/);
    // The old split (traceSummary from a separate variable) must not come back on this route.
    const route = src.slice(src.indexOf("/submit-solution`"), src.indexOf("/submit-solution`") + 200);
    assert.doesNotMatch(route, /traceSummary: submitSummary/);
  });
});

describe("SUMMARY_SPECIFICITY_RULE shapes the reasoning field now", () => {
  it("names the reasoning and the 100-400 char window", async () => {
    const { SUMMARY_SPECIFICITY_RULE } = await import("../mining.js");
    assert.match(SUMMARY_SPECIFICITY_RULE, /"reasoning"/);
    assert.match(SUMMARY_SPECIFICITY_RULE, /100-400 characters/);
    assert.doesNotMatch(SUMMARY_SPECIFICITY_RULE, /The "summary" is scored/);
  });
});
