/**
 * Who spent the Venice balance? (2026-10-12)
 *
 * The daemon polls the account balance every 30 min (venice-balance.jsonl)
 * and records every one of its own model calls with an estimated cost
 * (venice-costs.jsonl). When the bot is the only spender the two agree
 * closely: 10-12 02:05–04:05Z the balance fell 1.992 and the ledger recorded
 * $2.016; 04:05–07:45Z, 0.176 vs $0.171. Between 07:45 and 08:45Z it fell
 * 1.794 to zero with NO bot calls at all, and the key was refused until the
 * 00:00Z refill. That is spend by something else on the same Venice account,
 * which only the operator can see (Venice's usage-by-key page).
 *
 * This splits each interval between two balance polls into what the ledger
 * explains and what it doesn't, so the dashboard can say so every day.
 */

export interface BalanceRow { ts: string; diem?: number | null; usd?: number | null }
export interface CostRow { ts: string; estCost?: number | string | null }

export interface UnexplainedWindow { from: string; to: string; spent: number; bot: number; other: number }

export interface VeniceReconcile {
  /** Total the balance fell, refills excluded. */
  spent: number;
  /** What the bot's ledger recorded over the same intervals. */
  bot: number;
  /** Fell with no matching bot calls (never negative per interval). */
  other: number;
  /** Intervals where other > minOther, oldest first. */
  windows: UnexplainedWindow[];
}

const spendable = (r: BalanceRow) => (Number(r.diem) || 0) + (Number(r.usd) || 0);

/**
 * Pure. `balances` and `costs` may be in any order; only rows at or after
 * `sinceIso` count. A rise between polls is a refill and is skipped. The
 * ledger can run slightly ahead of or behind the balance, so an interval's
 * "other" is max(0, drop − bot), and small gaps (< minOther) aren't listed.
 */
export function reconcileVenice(balances: readonly BalanceRow[], costs: readonly CostRow[], sinceIso: string, minOther = 0.1): VeniceReconcile {
  const polls = balances.filter((r) => r.ts >= sinceIso).slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const cost = costs
    .filter((c) => c.ts >= sinceIso)
    .map((c) => ({ ts: c.ts, usd: Number(c.estCost) || 0 }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let spent = 0, bot = 0, other = 0;
  const windows: UnexplainedWindow[] = [];
  for (let i = 1; i < polls.length; i++) {
    const prev = polls[i - 1], cur = polls[i];
    const drop = spendable(prev) - spendable(cur);
    if (drop <= 0) continue; // refill, or nothing spent
    const botHere = cost.filter((c) => c.ts > prev.ts && c.ts <= cur.ts).reduce((a, c) => a + c.usd, 0);
    const otherHere = Math.max(0, drop - botHere);
    spent += drop;
    bot += Math.min(botHere, drop);
    other += otherHere;
    if (otherHere > minOther) windows.push({ from: prev.ts, to: cur.ts, spent: drop, bot: botHere, other: otherHere });
  }
  return { spent, bot, other, windows };
}

/** Pure: merge adjacent unexplained windows ("07:45–08:15" + "08:15–08:45" → one). */
export function mergeWindows(ws: readonly UnexplainedWindow[]): UnexplainedWindow[] {
  const out: UnexplainedWindow[] = [];
  for (const w of ws) {
    const last = out[out.length - 1];
    if (last && last.to === w.from) {
      out[out.length - 1] = { from: last.from, to: w.to, spent: last.spent + w.spent, bot: last.bot + w.bot, other: last.other + w.other };
    } else out.push({ ...w });
  }
  return out;
}
