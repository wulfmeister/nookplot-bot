/**
 * Calibration prompt for the verify-scoring LLM call, plus a structural
 * audit helper.
 *
 * History: pre-06-08, the verify scorer ran with a permissive prompt and
 * our verification means landed at 0.20–0.54 across dimensions —
 * well below the gateway-intended 0.50-baseline. Solver payouts depend
 * on quorum-averaged scores; consistently-low verifies drag the entire
 * network, which hurts us too (slower quorum = slower NOOK).
 *
 * The prompt below grounds the 0–1 scale with explicit anchors and
 * per-dimension rubrics. It also includes a dual guard — anti-rubber-
 * stamp (would trip the gateway's uniform-high detection) AND anti-floor
 * (the failure mode we shipped here pre-calibration).
 *
 * `auditVerifyCalibrationPrompt()` asserts the required structural
 * elements are present. Wire it into a test so any drift back to a
 * permissive or one-sided prompt is caught before deploy.
 */

export const VERIFY_CALIBRATION_PROMPT =
  'Score this FULL reasoning-trace submission on four 0.0-1.0 dimensions. Be honest, calibrated, and evidence-based.\n\n**CALIBRATION ANCHORS (most submissions should land in 0.40-0.75 range):**\n- 0.30 = clearly weak, missing approach or with obvious errors\n- 0.50 = average — meets basic standard for the dimension\n- 0.65 = solid, above-average for typical submissions on the network\n- 0.80 = strong, with concrete evidence + structured work\n- 0.95 = exceptional, breakthrough-quality\n\n**Per-dimension rubric:**\n- correctness: does it actually solve the problem? (0.50 = mostly right with gaps; 0.70 = correct with minor edge-case misses; 0.85 = correct + robust)\n- reasoning: is the chain-of-thought structured and traceable? (0.50 = present but generic; 0.70 = clear steps + intermediate checks; 0.85 = explicit assumptions + dead-end documentation)\n- efficiency: is the approach reasonably economical? (0.50 = workable but unoptimized; 0.70 = good algorithmic choice; 0.85 = optimal or near-optimal w/ complexity stated)\n- novelty: does it bring something beyond the obvious? (0.50 = standard approach competently applied; 0.70 = a non-obvious technique or framing; 0.85 = a fresh angle or cross-domain insight)\n\n**Anti-rubber-stamp guard:** if you score all four >=0.80, justification MUST cite four distinct specific things from the trace. If you can\'t, drop one or more scores. **Anti-floor guard:** do NOT score below 0.40 just because the trace summary is generic — judge the FULL trace content.\n\n**Per-dimension rationales:** for EACH dimension write a rationale of AT LEAST 80 characters citing specific trace content (quote fragments, name the technique, reference concrete steps). Generic rationales ("the reasoning is solid") get rejected.\n\nOutput JSON only:\n{"correctnessScore":0.0-1.0,"reasoningScore":0.0-1.0,"efficiencyScore":0.0-1.0,"noveltyScore":0.0-1.0,"correctnessRationale":">=80 chars, trace-specific","reasoningEvaluation":">=80 chars, trace-specific","efficiencyAssessment":">=80 chars, trace-specific","noveltyAssessment":">=80 chars, trace-specific","justification":"50-500 chars referencing specific trace content","knowledgeInsight":"80-500 chars — a SPECIFIC pattern/correction/advice anchored to what you observed, NOT generic","knowledgeDomainTags":["tag1","tag2"]}\nIf the trace is empty/unscoreable: {"skip":"reason"}.';

interface CalibrationAuditFinding {
  missing: string[];
}

/**
 * Audit the calibration prompt for the structural elements that prevent
 * regression to either failure mode.
 *
 * The test calls this against `VERIFY_CALIBRATION_PROMPT` and asserts
 * `missing.length === 0`. If the prompt ever drifts back to a permissive
 * or one-sided shape, this will catch it.
 */
export function auditVerifyCalibrationPrompt(prompt: string): CalibrationAuditFinding {
  const required: Array<{ name: string; needle: RegExp }> = [
    // Anchor scale — needs both ends + a midpoint
    { name: "anchor 0.30", needle: /0\.30/ },
    { name: "anchor 0.50", needle: /0\.50/ },
    { name: "anchor 0.65", needle: /0\.65/ },
    { name: "anchor 0.80", needle: /0\.80/ },
    { name: "anchor 0.95", needle: /0\.95/ },
    // Per-dimension rubric coverage
    { name: "rubric: correctness", needle: /correctness/i },
    { name: "rubric: reasoning", needle: /reasoning/i },
    { name: "rubric: efficiency", needle: /efficiency/i },
    { name: "rubric: novelty", needle: /novelty/i },
    // Dual guards
    { name: "anti-rubber-stamp guard", needle: /anti-rubber-stamp|rubber.?stamp.*(?:guard|detection|penalty)/i },
    { name: "anti-floor guard", needle: /anti-floor|do NOT score below|don'?t score below/i },
    // Output format requirement
    { name: "output JSON only", needle: /output\s+json\s+only/i },
    // Structured per-dimension rationales (gateway format change 2026-06-05;
    // ≥80 chars each — see AGENTS.md fourteenth pass)
    { name: "rationale: correctnessRationale", needle: /correctnessRationale/ },
    { name: "rationale: reasoningEvaluation", needle: /reasoningEvaluation/ },
    { name: "rationale: efficiencyAssessment", needle: /efficiencyAssessment/ },
    { name: "rationale: noveltyAssessment", needle: /noveltyAssessment/ },
  ];
  const missing = required
    .filter((r) => !r.needle.test(prompt))
    .map((r) => r.name);
  return { missing };
}
