import { chat } from "./venice.js";

import { pickModel } from "./models.js";

export async function refine(
  context: string,
  draft: string,
  opts: {
    critiqueMaxTokens?: number;
    reviseMaxTokens?: number;
    lensHint?: string;
    model?: string;
  } = {},
): Promise<{ revised: string; critique: string }> {
  const critiqueModel = opts.model ?? pickModel("bounty_critique");
  const reviseModel = opts.model ?? pickModel("bounty_revise");
  const critiqueRes = await chat(
    [
      {
        role: "system",
        content:
          `You are a tough editor. Critique the draft against the brief. Identify THREE concrete weaknesses — vague claims, missing specifics, generic phrasing, weak structure, fluff, anything that would let a competitor outshine us. ${opts.lensHint ?? ""} Output 3 numbered bullets, one weakness each, terse.`,
      },
      { role: "user", content: `Brief / context:\n${context.slice(0, 3000)}\n\nDraft:\n${draft.slice(0, 4000)}` },
    ],
    { max_tokens: opts.critiqueMaxTokens ?? 250, temperature: 0.4, model: critiqueModel, timeoutMs: 180_000 },
  );
  const critique = critiqueRes.content.trim();
  const reviseRes = await chat(
    [
      {
        role: "system",
        content:
          "Rewrite the draft to fix every weakness in the critique. Preserve voice and length budget. No greetings, no meta-commentary, no 'here's the revised version' — just the rewritten piece.",
      },
      {
        role: "user",
        content: `Brief / context:\n${context.slice(0, 3000)}\n\nOriginal draft:\n${draft.slice(0, 4000)}\n\nCritique:\n${critique}\n\nRewrite:`,
      },
    ],
    { max_tokens: opts.reviseMaxTokens ?? Math.ceil(draft.length / 3 + 200), temperature: 0.25, model: reviseModel, timeoutMs: 240_000 },
  );
  return { revised: reviseRes.content.trim(), critique };
}
