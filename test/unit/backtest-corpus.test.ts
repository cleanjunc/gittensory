import { describe, expect, it } from "vitest";
import {
  buildBacktestCorpus,
  type BacktestCase,
} from "../../packages/loopover-engine/src/calibration/backtest-corpus.js";
import type { HumanOverrideEvent, RuleFiredEvent } from "../../packages/loopover-engine/src/calibration/signal-tracking.js";

// #8083: root-side coverage twin of packages/loopover-engine/test/backtest-corpus.test.ts. The engine
// package's own node:test suite runs against dist/ (not instrumented by the root vitest coverage that
// Codecov gates on), so this file exercises the SAME contract directly against the engine src — the same
// direct-src import pattern test/contract/*-parity.test.ts and test/integration/miner-*.test.ts already use.

function fired(ruleId: string, targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt: "2026-07-22T01:00:00.000Z", ...overrides };
}

describe("buildBacktestCorpus (#8083)", () => {
  it("pairs a single fired+override into one labeled case, carrying outcome, timestamps, and metadata", () => {
    const corpus = buildBacktestCorpus(
      "missing_linked_issue",
      [fired("missing_linked_issue", "a/r#1", { outcome: "exclude", metadata: { headSha: "abc" } })],
      [override("missing_linked_issue", "a/r#1", "reversed")],
    );
    expect(corpus).toEqual([
      {
        ruleId: "missing_linked_issue",
        targetKey: "a/r#1",
        outcome: "exclude",
        label: "reversed",
        firedAt: "2026-07-22T00:00:00.000Z",
        decidedAt: "2026-07-22T01:00:00.000Z",
        metadata: { headSha: "abc" },
      } satisfies BacktestCase,
    ]);
  });

  it("excludes fired events with no matching override — only the decided ones count", () => {
    const corpus = buildBacktestCorpus(
      "rule",
      [fired("rule", "a/r#1"), fired("rule", "a/r#2")],
      [override("rule", "a/r#2", "confirmed")],
    );
    expect(corpus.map((backtestCase) => backtestCase.targetKey)).toEqual(["a/r#2"]);
  });

  it("omits the metadata key entirely when the fired event has none", () => {
    const [backtestCase] = buildBacktestCorpus(
      "rule",
      [fired("rule", "a/r#1")],
      [override("rule", "a/r#1", "confirmed")],
    );
    expect(Object.hasOwn(backtestCase!, "metadata")).toBe(false);
  });

  it("pairs each firing with the nearest strictly-following override when a target was judged repeatedly", () => {
    const corpus = buildBacktestCorpus(
      "rule",
      [
        fired("rule", "a/r#1", { occurredAt: "2026-07-22T00:00:00.000Z" }),
        fired("rule", "a/r#1", { occurredAt: "2026-07-22T02:00:00.000Z" }),
      ],
      [
        override("rule", "a/r#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
        override("rule", "a/r#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
      ],
    );
    expect(corpus.map((backtestCase) => [backtestCase.label, backtestCase.decidedAt])).toEqual([
      ["reversed", "2026-07-22T01:00:00.000Z"],
      ["confirmed", "2026-07-22T03:00:00.000Z"],
    ]);
  });

  it("falls back to the most recent override when none strictly follows the firing (equal instants included)", () => {
    const late = buildBacktestCorpus(
      "rule",
      [fired("rule", "a/r#1", { occurredAt: "2026-07-22T05:00:00.000Z" })],
      [
        override("rule", "a/r#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
        override("rule", "a/r#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
      ],
    );
    expect(late.map((backtestCase) => backtestCase.decidedAt)).toEqual(["2026-07-22T03:00:00.000Z"]);

    const equalInstant = buildBacktestCorpus(
      "rule",
      [fired("rule", "a/r#1", { occurredAt: "2026-07-22T02:00:00.000Z" })],
      [
        override("rule", "a/r#1", "confirmed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
        override("rule", "a/r#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      ],
    );
    expect(equalInstant.map((backtestCase) => backtestCase.label)).toEqual(["confirmed"]);
  });

  it("ignores events for a different ruleId on both the fired and override sides", () => {
    const corpus = buildBacktestCorpus(
      "rule",
      [fired("other_rule", "a/r#1"), fired("rule", "a/r#2")],
      [override("rule", "a/r#1", "reversed"), override("other_rule", "a/r#2", "reversed"), override("rule", "a/r#2", "confirmed")],
    );
    expect(corpus.map((backtestCase) => [backtestCase.targetKey, backtestCase.label])).toEqual([["a/r#2", "confirmed"]]);
  });

  it("produces an empty corpus for empty inputs in every combination", () => {
    expect(buildBacktestCorpus("rule", [], [])).toEqual([]);
    expect(buildBacktestCorpus("rule", [fired("rule", "a/r#1")], [])).toEqual([]);
    expect(buildBacktestCorpus("rule", [], [override("rule", "a/r#1", "reversed")])).toEqual([]);
  });
});
