// Watching for signs that Nookplot is coming back (2026-10-31): the gateway
// has been paused since 10-22; these rules decide when a sign has "moved".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillBaseline, newlySeen, nextRelaunchState, parseIssueRef, relaunchSignals, relaunchWatchMs, type RelaunchReading } from "../relaunch-watch.js";

// Synthetic values in the shape of a reading taken during the pause.
const base: RelaunchReading = {
  gatewayStatus: 503,
  gatewayPaused: true,
  siteApi: "pause",
  siteEpoch: 100,
  rootPublisher: "0x1111111111111111111111111111111111111111",
  publisherNonce: 0,
  merkleRoot: "0xaaaa000000000000000000000000000000000000000000000000000000000000",
  poolEpoch: 98,
  poolBalanceNook: 1_000_000,
  totalClaimedNook: 5_000_000,
  relayerEth: 0.00001,
  sdk: { "@nookplot/runtime": "1.0.0", "@nookplot/cli": "2.0.0", "@nookplot/mcp": "3.0.0" },
  issueRef: "owner/repo#7",
  issue: { ref: "owner/repo#7", comments: 0, state: "open" },
};
const T0 = "2026-11-01T00:00:00.000Z", T1 = "2026-11-01T01:00:00.000Z", T2 = "2026-11-01T02:00:00.000Z";
const start = nextRelaunchState(null, base, T0);
const movedKeys = (r: Partial<RelaunchReading>) => Object.keys(nextRelaunchState(start, { ...base, ...r }, T1).firstSeen).sort();

describe("relaunch watch", () => {
  it("the first reading is the baseline; nothing has moved", () => {
    assert.equal(start.baselineAt, T0);
    assert.deepEqual(start.firstSeen, {});
    assert.deepEqual(movedKeys({}), []);
    assert.equal(newlySeen(start, nextRelaunchState(start, base, T1)).length, 0);
  });

  it("each sign moves on its own rule, and only that sign", () => {
    const cases: Array<[string, Partial<RelaunchReading>]> = [
      ["gateway", { gatewayStatus: 200, gatewayPaused: false }],
      ["root", { merkleRoot: "0xbbbb000000000000000000000000000000000000000000000000000000000000", poolEpoch: 99 }],
      ["site", { siteEpoch: 101 }],
      ["site", { siteApi: "gone", siteEpoch: null }],
      ["pool", { poolBalanceNook: 1_000_100 }],
      ["publisher", { publisherNonce: 1 }],
      ["publisher", { rootPublisher: "0x2222222222222222222222222222222222222222" }],
      ["claims", { totalClaimedNook: 5_000_010 }],
      ["relayer", { relayerEth: 0.01 }],
      ["sdk", { sdk: { ...base.sdk, "@nookplot/runtime": "1.0.1" } }],
      ["issue", { issue: { ref: "owner/repo#7", comments: 1, state: "open" } }],
      ["issue", { issue: { ref: "owner/repo#7", comments: 0, state: "closed" } }],
    ];
    for (const [key, change] of cases) assert.deepEqual(movedKeys(change), [key], JSON.stringify(change));
  });

  it("noise and failed reads don't count as moves", () => {
    assert.deepEqual(movedKeys({ gatewayStatus: 502, gatewayPaused: null }), [], "another 5xx is not a return");
    assert.deepEqual(movedKeys({ poolBalanceNook: 999_000 }), [], "claims draining the pool are not a top-up");
    assert.deepEqual(movedKeys({ poolBalanceNook: 1_000_000.5 }), [], "rounding");
    assert.deepEqual(movedKeys({ relayerEth: 0.0001 }), [], "dust");
    assert.deepEqual(movedKeys({ siteApi: null, siteEpoch: null }), [], "site unreachable");
    const blank: Partial<RelaunchReading> = {
      gatewayStatus: null, gatewayPaused: null, siteApi: null, siteEpoch: null, rootPublisher: null, publisherNonce: null,
      merkleRoot: null, poolEpoch: null, poolBalanceNook: null, totalClaimedNook: null, relayerEth: null,
      sdk: { "@nookplot/runtime": null, "@nookplot/cli": null, "@nookplot/mcp": null }, issue: null,
    };
    assert.deepEqual(movedKeys(blank), [], "every read failed");
  });

  it("a gateway that was up at the first check never counts as a return", () => {
    const up = nextRelaunchState(null, { ...base, gatewayStatus: 200, gatewayPaused: false }, T0);
    assert.deepEqual(Object.keys(nextRelaunchState(up, { ...base, gatewayStatus: 200, gatewayPaused: false }, T1).firstSeen), []);
  });

  it("the first time a sign moved is kept, even if it moves back", () => {
    const moved = nextRelaunchState(start, { ...base, publisherNonce: 1 }, T1);
    assert.equal(moved.firstSeen.publisher, T1);
    assert.deepEqual(newlySeen(start, moved).map((s) => s.key), ["publisher"]);
    const later = nextRelaunchState(moved, { ...base, publisherNonce: 2 }, T2);
    assert.equal(later.firstSeen.publisher, T1, "not reset by a later change");
    assert.equal(newlySeen(moved, later).length, 0, "announced once");
    const back = nextRelaunchState(later, { ...base, rootPublisher: base.rootPublisher }, T2);
    assert.equal(relaunchSignals(back).find((s) => s.key === "publisher")?.firstSeen, T1);
  });

  it("a value missing from the baseline is filled in later without counting as a move", () => {
    const first = nextRelaunchState(null, { ...base, siteApi: null, siteEpoch: null }, T0);
    const second = nextRelaunchState(first, base, T1);
    assert.equal(second.baseline.siteEpoch, 100);
    assert.equal(second.firstSeen.site, undefined);
    assert.equal(nextRelaunchState(second, { ...base, siteEpoch: 101 }, T2).firstSeen.site, T2);
  });

  it("an issue named later starts from what it shows then; renaming it starts over", () => {
    const none = nextRelaunchState(null, { ...base, issueRef: null, issue: null }, T0);
    assert.equal(relaunchSignals(none).some((s) => s.key === "issue"), false, "no row without an issue");
    const named = nextRelaunchState(none, { ...base, issue: { ref: "owner/repo#7", comments: 3, state: "open" } }, T1);
    assert.equal(named.firstSeen.issue, undefined);
    assert.equal(named.baseline.issue?.comments, 3);
    const other = fillBaseline(named.baseline, { ...base, issueRef: "owner/repo#8", issue: { ref: "owner/repo#8", comments: 5, state: "open" } });
    assert.deepEqual(other.issue, { ref: "owner/repo#8", comments: 5, state: "open" });
  });

  it("rows say what each sign showed at the first check and now", () => {
    const rows = relaunchSignals(nextRelaunchState(start, { ...base, poolBalanceNook: 2_000_000 }, T1));
    const pool = rows.find((s) => s.key === "pool")!;
    assert.equal(pool.baseline, "1,000,000 NOOK");
    assert.equal(pool.now, "2,000,000 NOOK");
    assert.equal(pool.changed, true);
    assert.equal(rows.find((s) => s.key === "gateway")?.now, "paused (503)");
  });

  it("issue refs: owner/repo#n, /issues/n or the URL; dotenv's cut-off value is rejected", () => {
    for (const v of ["owner/repo#12", "owner/repo/issues/12", "https://github.com/owner/repo/issues/12", "https://github.com/owner/repo/issues/12/"]) {
      assert.deepEqual(parseIssueRef(v), { owner: "owner", repo: "repo", number: 12, text: "owner/repo#12" }, v);
    }
    // An unquoted "owner/repo#12" in .env reaches us as "owner/repo".
    for (const v of ["owner/repo", "", undefined, null, "https://example.com/owner/repo/issues/12", "owner/repo#x"]) {
      assert.equal(parseIssueRef(v), null, String(v));
    }
  });

  it("check interval: hourly by default, 0 turns it off, at least 5 minutes", () => {
    assert.equal(relaunchWatchMs({}), 3_600_000);
    assert.equal(relaunchWatchMs({ BOT_RELAUNCH_WATCH_MIN: "15" }), 900_000);
    assert.equal(relaunchWatchMs({ BOT_RELAUNCH_WATCH_MIN: "0" }), 0);
    assert.equal(relaunchWatchMs({ BOT_RELAUNCH_WATCH_MIN: "2" }), 300_000);
    assert.equal(relaunchWatchMs({ BOT_RELAUNCH_WATCH_MIN: "x" }), 3_600_000);
    assert.equal(relaunchWatchMs({ BOT_RELAUNCH_WATCH_MIN: "-3" }), 3_600_000);
  });
});
