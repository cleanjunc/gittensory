import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacktestCorpus, type BacktestCase, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

// #8083: buildBacktestCorpus pairs each rule firing with its human verdict into a labeled, replayable
// BacktestCase. Mirrors signal-tracking.test.ts's fixture style; the pairing rule under test is the
// nearest-strictly-following override, falling back to the most recent when none follows.

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

test("barrel: the public entrypoint re-exports the backtest-corpus builder (#8083)", () => {
  assert.equal(typeof buildBacktestCorpus, "function");
});

test("a single fired+override pair produces one correctly-labeled case", () => {
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a/r#1", { metadata: { headSha: "abc" } })],
    [override("missing_linked_issue", "a/r#1", "reversed")],
  );
  assert.deepEqual(corpus, [
    {
      ruleId: "missing_linked_issue",
      targetKey: "a/r#1",
      outcome: "block",
      label: "reversed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T01:00:00.000Z",
      metadata: { headSha: "abc" },
    } satisfies BacktestCase,
  ]);
});

test("a fired event with no matching override is excluded, not emitted unlabeled", () => {
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a/r#1"), fired("missing_linked_issue", "a/r#2")],
    [override("missing_linked_issue", "a/r#2", "confirmed")],
  );
  assert.deepEqual(
    corpus.map((backtestCase) => backtestCase.targetKey),
    ["a/r#2"],
  );
});

test("metadata is omitted entirely (not set to undefined) when the fired event has none", () => {
  const [backtestCase] = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a/r#1")],
    [override("missing_linked_issue", "a/r#1", "confirmed")],
  );
  assert.equal(Object.hasOwn(backtestCase!, "metadata"), false);
});

test("multiple overrides for one target pair each firing with the nearest strictly-following override", () => {
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
  assert.deepEqual(
    corpus.map((backtestCase) => [backtestCase.label, backtestCase.decidedAt]),
    [
      ["reversed", "2026-07-22T01:00:00.000Z"],
      ["confirmed", "2026-07-22T03:00:00.000Z"],
    ],
  );
});

test("a firing with no strictly-following override falls back to the most recent override", () => {
  const corpus = buildBacktestCorpus(
    "rule",
    [fired("rule", "a/r#1", { occurredAt: "2026-07-22T05:00:00.000Z" })],
    [
      override("rule", "a/r#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      override("rule", "a/r#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
    ],
  );
  assert.deepEqual(
    corpus.map((backtestCase) => [backtestCase.label, backtestCase.decidedAt]),
    [["confirmed", "2026-07-22T03:00:00.000Z"]],
  );
});

test("an override at exactly the firing's own instant does not count as strictly following", () => {
  const corpus = buildBacktestCorpus(
    "rule",
    [fired("rule", "a/r#1", { occurredAt: "2026-07-22T02:00:00.000Z" })],
    [
      override("rule", "a/r#1", "confirmed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
      override("rule", "a/r#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
    ],
  );
  // Neither override strictly follows, so the most recent one (02:00, "confirmed") wins the fallback.
  assert.deepEqual(
    corpus.map((backtestCase) => [backtestCase.label, backtestCase.decidedAt]),
    [["confirmed", "2026-07-22T02:00:00.000Z"]],
  );
});

test("events for a different ruleId are ignored on both sides", () => {
  const corpus = buildBacktestCorpus(
    "rule",
    [fired("other_rule", "a/r#1"), fired("rule", "a/r#2")],
    [override("rule", "a/r#1", "reversed"), override("other_rule", "a/r#2", "reversed"), override("rule", "a/r#2", "confirmed")],
  );
  assert.deepEqual(
    corpus.map((backtestCase) => [backtestCase.targetKey, backtestCase.label]),
    [["a/r#2", "confirmed"]],
  );
});

test("empty input arrays produce an empty corpus", () => {
  assert.deepEqual(buildBacktestCorpus("rule", [], []), []);
  assert.deepEqual(buildBacktestCorpus("rule", [fired("rule", "a/r#1")], []), []);
  assert.deepEqual(buildBacktestCorpus("rule", [], [override("rule", "a/r#1", "reversed")]), []);
});
