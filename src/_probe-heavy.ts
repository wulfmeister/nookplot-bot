/**
 * Heavy probe — mimics our actual mining workload:
 *  - Realistic system prompt size (~1500 chars)
 *  - max_tokens 14000 (matches mining.ts solveStandardTrace)
 *  - reasoning_effort xhigh (our default for non-gpt55 models)
 *
 * Reports content/reasoning split so we can see if the model is burning
 * the whole budget on internal thinking.
 */
import "dotenv/config";

const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";
const KEY = process.env.VENICE_API_KEY!;

const MODELS = ["claude-opus-4-8", "openai-gpt-55", "grok-4-3", "gemini-3-1-pro-preview", "deepseek-v4-pro"];
// Just probe xhigh since that's where we suspect the timeout issue
const EFFORTS = ["xhigh"];

const SYSTEM = `You are an expert problem-solver producing a long-form reasoning trace for a mining challenge. The trace will be graded by 3 verifiers across correctness, reasoning quality, efficiency, and novelty.

OUTPUT FORMAT — JSON ONLY:
{
  "summary": "150-280 char concise description",
  "trace": "Long-form markdown — see structure below"
}

The trace markdown MUST use:
## Approach — brief framing
## Steps — numbered steps with work + sanity checks + dead ends
## Conclusion — final answer with units/precision
## Uncertainty — specific things you're less sure about
## Citations — numbered citations [1] Author Year — title

CONTENT REQUIREMENTS:
- 800-1500 words of substance
- Concrete numbers, not vague claims
- Cite specific papers/learnings by author + year
- Show your work — verifiers can re-derive steps
- When uncertain, say "uncertain because ..."`;

const USER = `# Challenge: Prove that the harmonic numbers H_n = 1 + 1/2 + ... + 1/n satisfy H_n = ln(n) + γ + 1/(2n) + O(1/n²) where γ ≈ 0.5772 is the Euler-Mascheroni constant.

Difficulty: hard
Domain: number-theory, analysis
Source type: agent-authored

## Full description
Provide a rigorous derivation using either:
(a) Euler-Maclaurin summation formula, OR
(b) The integral definition of γ + asymptotic expansion of the digamma function.

State the leading-order error term explicitly. Verify with n=10 (compute H_10 exactly vs the asymptotic estimate).

Produce the JSON now.`;

async function probe(model: string, effort: string, maxTokens: number) {
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
    max_tokens: maxTokens,
    temperature: 0.2,
    // Match our real mining call — web search enabled
    venice_parameters: { enable_web_search: "on" },
  };
  if (effort !== "none") body.reasoning_effort = effort;
  try {
    const r = await fetch(VENICE_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const ms = Date.now() - t0;
    if (!r.ok) {
      const e = (await r.text()).slice(0, 100);
      return { http: r.status, ms, err: e };
    }
    const j = await r.json() as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      usage?: { reasoning_tokens?: number; total_tokens?: number; completion_tokens?: number };
    };
    const content = j.choices?.[0]?.message?.content ?? "";
    const reasoning = j.choices?.[0]?.message?.reasoning_content ?? "";
    const fr = j.choices?.[0]?.finish_reason ?? "?";
    const usage = j.usage ?? {};
    const hasTrace = content.includes('"trace"') && content.includes('"summary"');
    return {
      http: 200,
      ms,
      contentLen: content.length,
      reasoningLen: reasoning.length,
      reasoningTokens: usage.reasoning_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      finishReason: fr,
      hasTrace,
    };
  } catch (err) {
    return { http: 0, ms: Date.now() - t0, err: (err as Error).message.slice(0, 100) };
  }
}

async function main() {
  console.log(`Heavy probe — ${MODELS.length} models × ${EFFORTS.length} efforts × max_tokens=14000\n`);
  console.log("model".padEnd(26) + "effort".padEnd(10) + "ms".padEnd(8) + "fr".padEnd(14) + "content".padEnd(10) + "reason_tok".padEnd(12) + "compl_tok".padEnd(12) + "trace?");
  for (const model of MODELS) {
    for (const effort of EFFORTS) {
      const r = await probe(model, effort, 14000) as Awaited<ReturnType<typeof probe>>;
      if ("err" in r) {
        console.log(model.padEnd(26) + effort.padEnd(10) + String(r.ms).padEnd(8) + `[${r.http}]`.padEnd(14) + ` ERR ${r.err}`);
        continue;
      }
      const traceOk = r.hasTrace ? "✓" : (r.contentLen > 0 ? "?" : "∅");
      console.log(
        model.padEnd(26) +
        effort.padEnd(10) +
        String(r.ms).padEnd(8) +
        String(r.finishReason).padEnd(14) +
        String(r.contentLen).padEnd(10) +
        String(r.reasoningTokens).padEnd(12) +
        String(r.completionTokens).padEnd(12) +
        traceOk,
      );
    }
  }
  console.log("\nfr (finish_reason): 'stop' = clean stop, 'length' = hit max_tokens budget");
  console.log("Look for: high reason_tok + low content + finish='length' = the 'no output' bug");
}

main().catch((e) => { console.error(e); process.exit(1); });
