/**
 * Review fixes to the code-kind `reasoning` retry (2026-10-01).
 *
 * Finding 1: any extracted byte skipped the model rewrite, and on snake_case
 * Python the extractor produced fragments the module's own matcher scores
 * zero (`technique "http"`, `technique "utf-8"`) or that repeat a token the
 * gateway had just scored +0 ("measured 2048 bytes" next to "2048 bytes").
 * Now: rewrite first, extraction only as a gated fallback, and the techniques
 * extractor only returns identifier shapes the matcher credits.
 *
 * Finding 2: the retry text (now what verifiers read) was cut mid-sentence,
 * carried raw `#` comment lines twice and a "hold vs arbitrary" fragment, and
 * was clipped at 500. Now: whole sentences, markers stripped, deduped, no
 * comparisons lifted from code, body kept whole up to a 1000-char ceiling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubmitSolutionBody,
  buildVerifiableReasoning,
  codeCommentProse,
  composeRetryReasoning,
  decideReasoningRetry,
  evaluateExtractiveRetry,
  looksLikeProse,
  overlapsText,
  planReasoningRetry,
  proseSentences,
  rewritePlan,
  REASONING_RETRY_MAX_CHARS,
  type SubmitSolutionBody,
} from "../verifiable-reasoning.js";
import {
  extractCategoryFragment,
  findTechniqueName,
  specificityCategories,
  type SpecificityCategory,
} from "../specificity-gate.js";

// Verbatim gateway body, b0249d97 2026-10-01T02:33Z (33/100, code +3 only).
const SPEC_400 =
  "Gateway request failed (400): traceSummary specificity score 33/100 (threshold 35). Sub-scores: numbers +0, techniques +0, comparisons +0, code +3, failures +0, actionable +0. Missing categories: numbers (no concrete measurements/percentages/counts with units); technique names (no camelCase/quoted method names); comparisons (no 'X vs Y' / 'better than' / 'instead of' phrasing). Pick at least TWO and add to the summary. Concrete fix: rewrite the summary with the specific algorithm step + a measurable claim (e.g., \"the bit-length method returns 1 << (n.bit_length() - 1) for n>=1, n=0 returns 0\"). Avoid adding METADATA (reward amounts, function names, learning IDs) — those don't increase specificity; reasoning details do.";
const MIN100_400 =
  "Gateway request failed (400): traceSummary is required (minimum 100 characters). Describe your approach, the key decision you made, and why it works. Generic summaries are rejected.";

// A realistic SSRF-safe URL unfurler: snake_case Python, no comments, no
// camelCase, string literals "http" / "https" / "utf-8".
const UNFURL_CODE = [
  "import ipaddress, socket",
  "from urllib.parse import urlsplit",
  "MAX_BYTES = 2048",
  "def unfurl(url):",
  "    parts = urlsplit(url)",
  '    if parts.scheme not in ("http", "https"):',
  "        return None",
  '    host = parts.hostname or ""',
  "    for info in socket.getaddrinfo(host, None):",
  "        ip = ipaddress.ip_address(info[4][0])",
  "        if not ip.is_global:",
  "            return None",
  "    data = fetch(url)[:MAX_BYTES]",
  '    return data.decode("utf-8", "replace")',
].join("\n");
const UNFURL_CH = {
  title: "SSRF-safe link unfurler (unfurl)",
  description: "Write `unfurl(url)` that fetches a URL safely and returns at most 2048 bytes of its body.",
};
const UNFURL_REASONING =
  "Splits the URL with `urlsplit`, allows only the http/https schemes, resolves every address of the host and rejects any that is not global, then reads at most 2048 bytes and decodes them leniently.";

// The finding-2 shape: ordinary Python with comments, one of which carries a
// failure word, an actionable verb AND "instead of".
const SESSION_CODE = [
  "import json",
  "def load_session(blob):",
  "    # Use json instead of pickle so a crafted blob raises an error rather than running code",
  "    try:",
  '        data = json.loads(blob.decode("utf-8"))',
  "    except ValueError:",
  "        return None",
  "    # Bound the work: at most 64 steps of nested lookup before giving up",
  "    return data if isinstance(data, dict) else None",
].join("\n");
const SESSION_CH = {
  title: "Safe session store (load_session)",
  description: "Load a session blob from a cookie. The store must hold versus arbitrary attacker input.",
};
const SESSION_REASONING =
  "Deserializes the session blob with a data-only parser and validates that the decoded object is a mapping of string keys before returning it; any malformed input is rejected by returning None to the caller, so a tampered cookie can never execute code and the store only ever holds plain data. The loader keeps nested structures intact and never trusts type tags from the payload, which keeps the contract simple for callers that hold versus arbitrary input from clients.";

const COMMENT_MARKER = /#|\/\/|\/\*|\*\//;

function body(reasoning: string): SubmitSolutionBody {
  return buildSubmitSolutionBody({
    artifactType: "code",
    artifact: { files: { "solution.py": "pass" } },
    reasoning,
    modelUsed: "grok-4-7",
    selfReportedWallMs: 1,
  });
}

/** The last word of `text` is a whole word of `original` (no mid-word cut). */
function endsOnWholeWord(text: string, original: string): boolean {
  const words = (s: string): string[] => s.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")).filter(Boolean);
  const last = words(text).pop();
  return last !== undefined && words(original).includes(last);
}

describe("finding 1: the rewrite goes first; extraction is a gated fallback", () => {
  it("URL unfurler + the verbatim 10-01 400: rewrite only — no `technique \"http\"`, no repeated 2048 bytes", () => {
    const decision = decideReasoningRetry(body(UNFURL_REASONING), SPEC_400, UNFURL_CODE, UNFURL_CH);
    assert.ok(decision);
    assert.equal(decision.kind, "specificity");
    assert.deepEqual(decision.order, ["rewrite"]);
    assert.equal(decision.extract, null);
    assert.match(decision.extractRefusal ?? "", /at least two/);
    const { plan } = evaluateExtractiveRetry(body(UNFURL_REASONING), SPEC_400, UNFURL_CODE, UNFURL_CH);
    assert.equal(plan, null);
  });

  it("every text verdict puts the rewrite first, whether or not an extractive plan exists", () => {
    const cases: Array<[string, string, string | undefined, { title?: string; description?: string }]> = [
      [UNFURL_REASONING, SPEC_400, UNFURL_CODE, UNFURL_CH],
      [SESSION_REASONING, SPEC_400, SESSION_CODE, SESSION_CH],
      ["Counts lines with wc via an argv list.", MIN100_400, SESSION_CODE, SESSION_CH],
      ["x".repeat(150), SPEC_400, undefined, {}],
    ];
    for (const [r, msg, code, ch] of cases) {
      const d = decideReasoningRetry(body(r), msg, code, ch);
      assert.ok(d, r.slice(0, 40));
      assert.equal(d.order[0], "rewrite", r.slice(0, 40));
      assert.equal(d.order.includes("extract"), d.extract !== null);
    }
  });

  it("non-text errors get no decision (the 429 cap, a dupe) — the caller rethrows", () => {
    assert.equal(decideReasoningRetry(body(SESSION_REASONING), "Gateway request failed (429): Maximum 12 regular challenge per 24-hour epoch.", SESSION_CODE, SESSION_CH), null);
    assert.equal(decideReasoningRetry(body(SESSION_REASONING), "Gateway request failed (409): You already submitted this challenge", SESSION_CODE, SESSION_CH), null);
  });

  it("when the rewrite returns nothing, the gated extractive plan is the next step", () => {
    const sent = body(SESSION_REASONING);
    const d = decideReasoningRetry(sent, SPEC_400, SESSION_CODE, SESSION_CH);
    assert.ok(d);
    assert.deepEqual(d.order, ["rewrite", "extract"]);
    // The mining loop: rewrite → rewritePlan(null) → next step → d.extract.
    assert.equal(rewritePlan(sent, d, null), null);
    assert.equal(rewritePlan(sent, d, ""), null);
    assert.equal(rewritePlan(sent, d, SESSION_REASONING), null, "an unchanged rewrite is not a retry");
    assert.ok(d.extract && d.extract.after.startsWith(SESSION_REASONING));
  });

  it("a rewrite that returns new text becomes the retry body, in both fields", () => {
    const sent = body(UNFURL_REASONING);
    const d = decideReasoningRetry(sent, SPEC_400, UNFURL_CODE, UNFURL_CH);
    assert.ok(d);
    const rewritten =
      'Resolves each host with "socket.getaddrinfo" and fails closed with an error on any non-global address instead of trusting the hostname; the body is capped at 2048 bytes.';
    const plan = rewritePlan(sent, d, rewritten);
    assert.ok(plan);
    assert.equal(plan.body.reasoning, rewritten);
    assert.equal(plan.body.traceSummary, rewritten);
    assert.equal(plan.before, UNFURL_REASONING);
    assert.deepEqual(plan.missing, d.missing);
  });

  it("the gate counts only categories the tail adds that the sent text lacked (≥2), not repeats", () => {
    // The sent text already shows numbers ("64 steps"): the extractor must not
    // add the 64-steps comment again, and numbers must not count as new.
    const sentWithNumbers = `${SESSION_REASONING.slice(0, 200).replace(/[,;]?\s+\S*$/, "")}, walking at most 64 steps of nested lookup.`;
    const plan = planReasoningRetry(body(sentWithNumbers), SPEC_400, SESSION_CODE, SESSION_CH);
    assert.ok(plan, "failures + actionable + techniques are still new");
    assert.equal(plan.after.match(/64 steps/g)?.length, 1, plan.after);
  });

  it("a tail whose only new credit is numbers + actionable is refused (never passing evidence; the mirror over-credits both)", () => {
    const sent = "Reads the whole file through a single handle and returns its text to the caller once the path has been validated.";
    const code = "def read_all(path):\n    # Prefer a 64 KB read buffer for large files\n    return open(path).read(65536)";
    const { plan, refusal } = evaluateExtractiveRetry(body(sent), SPEC_400, code, { description: "Read a file and return its text." });
    assert.equal(plan, null);
    assert.match(refusal ?? "", /numbers,actionable|actionable,numbers/);
    assert.match(refusal ?? "", /one of techniques\/code\/failures/);
  });

  it("wiring: mining.ts asks the decision, runs the rewrite inside its ordered loop, and only then reads decision.extract", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../mining.ts", import.meta.url), "utf8");
    assert.match(src, /decideReasoningRetry\(solutionBody, smsg, codeText, ch\)/);
    assert.match(
      src,
      /for \(const step of decision\.order\) \{[\s\S]{0,200}step === "rewrite"[\s\S]{0,400}regenerateVerifiableReasoning\([\s\S]{0,400}plan = decision\.extract/,
    );
    assert.doesNotMatch(src, /planReasoningRetry\(/, "the old extract-first call is gone from the pipeline");
  });
});

describe("finding 1: the techniques extractor only returns shapes the matcher credits", () => {
  it("never a bare quoted literal (the July `technique \"http\"` false pass)", () => {
    assert.equal(findTechniqueName('if parts.scheme not in ("http", "https"): return None'), null);
    assert.equal(findTechniqueName('return data.decode("utf-8", "replace")'.replace("data.decode(", "decode(")), null);
    assert.equal(extractCategoryFragment("techniques", 'scheme == "http" and enc == "utf-8"'), "");
  });

  it("returns camelCase, a dotted call, or a quoted dotted/call/camelCase name", () => {
    assert.equal(findTechniqueName("we call readIndex on the buffer"), "readIndex");
    assert.equal(findTechniqueName("norm = os.path.normpath(path)"), "os.path.normpath");
    assert.equal(findTechniqueName('see "json.loads" and "urlsplit()"'), "json.loads");
    assert.equal(findTechniqueName(UNFURL_CODE), "socket.getaddrinfo");
  });

  it("skips pure snake_case, filenames, instance plumbing, and anything already in the text", () => {
    assert.equal(findTechniqueName('use line_total and "line_total" here'), null);
    assert.equal(findTechniqueName('write "data.json" then "solution.py"'), null);
    assert.equal(findTechniqueName("self.cache.get(key)"), null);
    assert.equal(findTechniqueName("norm = os.path.normpath(p); json.loads(s)", "uses os.path.normpath already"), "json.loads");
  });

  it("property: extractCategoryFragment never emits a fragment the matcher does not credit for its category", () => {
    const sources = [
      UNFURL_CODE,
      SESSION_CODE,
      SESSION_CH.description,
      'if scheme == "http": raise ValueError("bad")',
      "We benchmarked quickSort vs mergeSort on 10000 elements; the `partition()` helper fails on sorted input, so prefer random pivots.",
      "nothing concrete here",
    ];
    const cats: SpecificityCategory[] = ["numbers", "techniques", "comparisons", "code", "failures", "actionable"];
    for (const src of sources) {
      for (const c of cats) {
        const frag = extractCategoryFragment(c, src);
        assert.ok(frag === "" || specificityCategories(frag)[c], `${c} ← ${JSON.stringify(frag)}`);
      }
    }
  });
});

describe("finding 2: the retry text verifiers read is clean", () => {
  it("session store: body kept whole, whole sentences appended, no comment marker, no duplicate, no lifted 'vs'", () => {
    const plan = planReasoningRetry(body(SESSION_REASONING), SPEC_400, SESSION_CODE, SESSION_CH);
    assert.ok(plan, "extractive fallback accepted: failures + actionable + techniques + numbers are new");
    const { after } = plan;
    assert.ok(after.startsWith(SESSION_REASONING), "the sent sentence is not cut");
    assert.match(after, /[.!?]$/, `ends at a sentence end: …${after.slice(-40)}`);
    assert.doesNotMatch(after, COMMENT_MARKER, after);
    assert.doesNotMatch(after, /Specifics:|failure mode:|technique "/, "no label-list tail");
    assert.doesNotMatch(after, /hold vs arbitrary|\bvs\b/, "no comparison fragment lifted from code/description");
    assert.equal(after.match(/Use json instead of pickle/g)?.length, 1, "the comment line appears once");
    assert.ok(after.includes("Use json instead of pickle so a crafted blob raises an error rather than running code."));
    assert.ok(after.includes('"json.loads"'), "a credited method name");
    assert.ok(after.length > 500, "no 500 cap on the reasoning retry");
    assert.ok(after.length <= REASONING_RETRY_MAX_CHARS);
    assert.equal(plan.body.reasoning, after);
    assert.equal(plan.body.traceSummary, after);
  });

  it("a smoke-annotated reasoning (500 composed + annotation) is kept whole — no 'use f Specifics:' cut", () => {
    // One long run-on sentence past 300 chars, so the 500 compose clip lands
    // at a word boundary near 500 (the real case ended "…the check and use").
    const long =
      "Confines the user path with a normalizing join and rejects any segment that escapes the root, then runs the counter through an argv list with the shell disabled so no metacharacter is ever interpreted, parses the first stdout field as the count, returns minus one for a missing file so the caller contract stays simple, keeps the check and use phases adjacent so a swapped file between them cannot redirect the read, and reads the file once through the subprocess pipe so memory stays flat for large inputs as well as small ones";
    const composed = buildVerifiableReasoning({ reasoning: long }, SESSION_CH);
    assert.ok(composed.length > 450, `${composed.length}`);
    const sent = `${composed} [self-smoke failed: ${"AssertionError: expected -1 for '../etc/passwd' but got 3 lines from the host file system path".slice(0, 100)}]`;
    assert.ok(sent.length > 550, `${sent.length}`);
    const plan = planReasoningRetry(body(sent), SPEC_400, SESSION_CODE, SESSION_CH);
    assert.ok(plan);
    assert.ok(plan.after.startsWith(sent), "no mid-word cut of the sent text");
    assert.match(plan.after, /[.!?]$/);
    assert.doesNotMatch(plan.after.slice(sent.length), COMMENT_MARKER);
  });

  it("comparisons are never lifted from code or the description", () => {
    const onlyComparisons = SPEC_400.replace(/Sub-scores:[^.]*\./, "Sub-scores: comparisons +0.").replace(
      /Missing categories:[^.]*\./,
      "Missing categories: comparisons (no 'X vs Y' phrasing).",
    );
    const d = decideReasoningRetry(body("x".repeat(150)), onlyComparisons, "# must hold vs arbitrary input\nx = 1", {
      description: "The store must hold versus arbitrary attacker input.",
    });
    assert.ok(d);
    assert.equal(d.extract, null);
    assert.deepEqual(d.order, ["rewrite"]);
  });

  it("composeRetryReasoning keeps the tail whole and clips an over-long body at a boundary, never mid-word", () => {
    const sentence = "Each step confines the path and fails closed on traversal attempts.";
    const base = Array.from({ length: 16 }, () => sentence).join(" ");
    assert.ok(base.length > 1000);
    const tail = ["Use json instead of pickle so a crafted blob raises an error rather than running code.", 'Key calls: "json.loads".'];
    const out = composeRetryReasoning(base, tail);
    assert.ok(out.length <= REASONING_RETRY_MAX_CHARS, `${out.length}`);
    assert.ok(out.endsWith(tail.join(" ")), "the additions survive whole");
    const head = out.slice(0, out.length - tail.join(" ").length).trim();
    assert.ok(endsOnWholeWord(head, base), `body cut mid-word: …${head.slice(-30)}`);
    assert.match(head, /[.!?]$/);
    assert.equal(composeRetryReasoning("Short body", []), "Short body", "no additions → unchanged");
    assert.equal(composeRetryReasoning("Short body", ["Added sentence here."]), "Short body. Added sentence here.");
  });

  it("dedupes against the sent text: a comment the reasoning already states is not appended again", () => {
    const sent = "Use json instead of pickle so a crafted blob raises an error rather than running code; the decoded value must be a mapping or the loader returns None to its caller.";
    const plan = planReasoningRetry(body(sent), SPEC_400, SESSION_CODE, SESSION_CH);
    const after = plan?.after ?? sent;
    assert.equal(after.match(/instead of pickle/g)?.length, 1, after);
  });
});

describe("code-route prose helpers", () => {
  it("codeCommentProse strips #, //, /* */, JSDoc * and docstring markers; joins comment runs", () => {
    const code = [
      "#!/usr/bin/env python3",
      "# Use json instead of pickle so a crafted",
      "# blob raises an error.",
      "x = 1  # trailing note about the cap",
      'url = "http://example.com/a#b"',
      "/** Parse the header.",
      " * Fails closed on an error.",
      " */",
      "const n = 2; // under 5 ms per call",
      "def f():",
      '    """Return the count.',
      '    Raises an error on a missing file."""',
      "    return 1",
    ].join("\n");
    const blocks = codeCommentProse(code);
    assert.deepEqual(blocks, [
      "Use json instead of pickle so a crafted blob raises an error.",
      "trailing note about the cap",
      "Parse the header. Fails closed on an error.",
      "under 5 ms per call",
      "Return the count. Raises an error on a missing file.",
    ]);
    for (const b of blocks) assert.doesNotMatch(b, COMMENT_MARKER, b);
    assert.deepEqual(codeCommentProse(undefined), []);
  });

  it("separate unpunctuated comment statements do not run together", () => {
    const blocks = codeCommentProse(
      "# A '..' segment fails closed and returns -1 instead of reaching the shell\n# One subprocess call per path, under 5 ms for a 10000 line file\nx = 1",
    );
    assert.deepEqual(blocks, [
      "A '..' segment fails closed and returns -1 instead of reaching the shell. One subprocess call per path, under 5 ms for a 10000 line file",
    ]);
    assert.deepEqual(proseSentences(blocks[0]), [
      "A '..' segment fails closed and returns -1 instead of reaching the shell.",
      "One subprocess call per path, under 5 ms for a 10000 line file.",
    ]);
  });

  it("proseSentences: bullets, fences and emphasis removed; each ≤160 chars and terminated", () => {
    const text = "Intro line\n- **Reject** '..' traversal\n```py\nx = 1\n```\n1. Return -1 when missing. Then stop!\n" + "word ".repeat(60);
    const out = proseSentences(text);
    assert.deepEqual(out.slice(0, 4), ["Intro line.", "Reject '..' traversal.", "Return -1 when missing.", "Then stop!"]);
    for (const s of out) {
      assert.ok(s.length <= 161, `${s.length}`);
      assert.match(s, /[.!?]$/);
    }
  });

  it("looksLikeProse rejects code and marker-bearing text", () => {
    assert.equal(looksLikeProse("Use json instead of pickle for untrusted bytes."), true);
    assert.equal(looksLikeProse("data = json.loads(blob)"), false);
    assert.equal(looksLikeProse("# a comment line that leaked through"), false);
    assert.equal(looksLikeProse("see http://host/path for the spec here"), false);
    assert.equal(looksLikeProse("too short."), false);
    assert.equal(looksLikeProse("!/usr/bin/env python three words"), false);
  });

  it("overlapsText catches a repeated window and ignores quoting differences", () => {
    assert.equal(overlapsText("measured 2048 bytes", "then reads at most 2048 bytes"), false, "different words around it");
    assert.equal(overlapsText("2048 bytes", "then reads at most 2048 bytes"), true);
    assert.equal(overlapsText('Calls "json.loads" on the decoded blob', "it calls `json.loads` on the decoded blob first"), true);
    assert.equal(overlapsText("A wholly different sentence about caching", "nothing in common at all here"), false);
  });
});
