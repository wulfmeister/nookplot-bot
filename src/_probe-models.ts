/**
 * Probe all our Venice models × reasoning levels to find which combinations
 * actually return non-empty output. Run with:
 *   npx tsx src/_probe-models.ts
 */
import "dotenv/config";

const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";
const KEY = process.env.VENICE_API_KEY!;

const MODELS = [
  "claude-opus-4-8",
  "openai-gpt-55",
  "grok-4-3",
  "gemini-3-1-pro-preview",
  "deepseek-v4-pro",
];

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Minimal task: produces structured JSON, similar shape to what mining traces use
const PROMPT = `Output JSON only: {"reasoning":"50-200 char","answer":"the literal string PING"}. No prose around it.`;

interface Result {
  model: string;
  effort: string;
  http: number;
  ms: number;
  contentLen: number;
  reasoningLen: number;
  hasJson: boolean;
  err?: string;
}

async function probe(model: string, effort: string, maxTokens: number): Promise<Result> {
  const t0 = Date.now();
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: maxTokens,
      temperature: 0.1,
    };
    if (effort !== "none") body.reasoning_effort = effort;
    const r = await fetch(VENICE_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Date.now() - t0;
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 200);
      return { model, effort, http: r.status, ms, contentLen: 0, reasoningLen: 0, hasJson: false, err: errText };
    }
    const j = await r.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>; usage?: { reasoning_tokens?: number; total_tokens?: number } };
    const choice = j.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content ?? "";
    const hasJson = /\{[^}]*"answer"[^}]*\}/.test(content);
    return {
      model,
      effort,
      http: 200,
      ms,
      contentLen: content.length,
      reasoningLen: reasoning.length,
      hasJson,
    };
  } catch (err) {
    return { model, effort, http: 0, ms: Date.now() - t0, contentLen: 0, reasoningLen: 0, hasJson: false, err: (err as Error).message.slice(0, 150) };
  }
}

async function main() {
  console.log(`probing ${MODELS.length} models × ${EFFORTS.length} efforts = ${MODELS.length * EFFORTS.length} requests\n`);
  // Headers
  console.log("model".padEnd(26) + EFFORTS.map((e) => e.padStart(10)).join(""));
  for (const model of MODELS) {
    // Run all efforts for this model in parallel (5-7 concurrent calls is fine for Venice)
    const results = await Promise.all(EFFORTS.map((e) => probe(model, e, 2000)));
    const line =
      model.padEnd(26) +
      results
        .map((r) => {
          if (r.err) {
            if (r.http >= 400) return `[${r.http}]`.padStart(10);
            return "err".padStart(10);
          }
          // Format: contentLen/reasoningLen — green if hasJson, yellow if content but no JSON, red if 0
          const tag = r.hasJson ? `✓${r.contentLen}` : r.contentLen > 0 ? `?${r.contentLen}` : `∅`;
          return tag.padStart(10);
        })
        .join("");
    console.log(line);
  }
  console.log(`\nKey:  ✓N = ok with JSON (content len N)  ?N = content but no JSON match  ∅ = empty output  [HTTP] = http error  err = exception`);
  console.log(`\nReasoning effort that affects the 'no output' bug:`);
  console.log(`  If a model shows ∅ at high efforts but ✓N at lower, the high effort is consuming all of max_tokens on reasoning_tokens, leaving none for content output.`);
}

main().catch((err) => { console.error("✗ probe failed:", err); process.exit(1); });
