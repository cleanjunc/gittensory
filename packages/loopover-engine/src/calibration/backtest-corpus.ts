// Labeled backtest corpus builder (#8083, parent epic #8082) -- turns the calibration module's raw
// RuleFiredEvent/HumanOverrideEvent history into the per-case labeled records a backtest needs. Where
// computeRulePrecision (signal-tracking.ts) aggregates the SAME pairing into one precision number, this
// keeps each paired firing as an individual replayable case: "this rule fired against this target, and a
// human later said it was right/wrong."
//
// SELF-CONTAINED AND PURE, like everything in this module: no IO, no DB, no env -- only the existing
// event types from signal-tracking.ts. Additive-only; no existing consumer changes behavior.

import type { HumanOverrideEvent, RuleFiredEvent } from "./signal-tracking.js";

/** One labeled, replayable backtest case: a specific rule firing plus the human verdict it eventually got.
 *  `outcome` is the fired event's outcome; `label` is the override's verdict; `firedAt`/`decidedAt` carry the
 *  two events' own timestamps. `metadata` is the FIRED event's metadata, omitted entirely (not set to
 *  `undefined`) when the fired event has none -- the same optional-property discipline RuleFiredEvent uses. */
export type BacktestCase = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
};

/**
 * Build the labeled corpus for `ruleId` from its fired + override events. A fired event pairs with an
 * override when both carry the function's `ruleId` AND the same `targetKey`; a fired event with no matching
 * override is EXCLUDED (not emitted as an unlabeled case) -- mirrors computeRulePrecision's "only the
 * decided ones count" discipline (see that function's own doc comment in signal-tracking.ts).
 *
 * Pairing rule when a target has MULTIPLE overrides for the same rule (re-fired and re-judged more than
 * once): each fired event pairs with the override whose `occurredAt` is closest in time strictly AFTER that
 * specific fired event's `occurredAt`; when none strictly follows it, it falls back to the most recent
 * override by `occurredAt`. Each fired event produces at most one BacktestCase -- never duplicates.
 */
export function buildBacktestCorpus(
  ruleId: string,
  fired: readonly RuleFiredEvent[],
  overrides: readonly HumanOverrideEvent[],
): BacktestCase[] {
  // Mirrors overrideMatchesRule's one-line filter in signal-tracking.ts (kept private there; this module is
  // additive-only and must not modify that file to export it).
  const matchingOverrides = overrides.filter((event) => event.ruleId === ruleId);

  const cases: BacktestCase[] = [];
  for (const event of fired) {
    if (event.ruleId !== ruleId) continue;
    const candidates = matchingOverrides.filter((override) => override.targetKey === event.targetKey);
    if (candidates.length === 0) continue;

    const firedAtMs = Date.parse(event.occurredAt);
    let paired: HumanOverrideEvent | undefined;
    let pairedDeltaMs = Number.POSITIVE_INFINITY;
    for (const override of candidates) {
      const deltaMs = Date.parse(override.occurredAt) - firedAtMs;
      if (deltaMs > 0 && deltaMs < pairedDeltaMs) {
        paired = override;
        pairedDeltaMs = deltaMs;
      }
    }
    if (!paired) {
      // No override strictly follows this firing -- fall back to the most recent override by occurredAt.
      let latestMs = Number.NEGATIVE_INFINITY;
      for (const override of candidates) {
        const occurredMs = Date.parse(override.occurredAt);
        if (occurredMs > latestMs) {
          paired = override;
          latestMs = occurredMs;
        }
      }
    }

    // `paired` is always set here: candidates is non-empty and the fallback scans every candidate with a
    // strictly-greater-than comparison against -Infinity.
    const pairedOverride = paired as HumanOverrideEvent;
    cases.push({
      ruleId: event.ruleId,
      targetKey: event.targetKey,
      outcome: event.outcome,
      label: pairedOverride.verdict,
      firedAt: event.occurredAt,
      decidedAt: pairedOverride.occurredAt,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    });
  }
  return cases;
}
