import { describe, expect, it } from "vitest";
import {
  buildConfigDriftRecapSection,
  type ConfigDriftKnobStatus,
  type ConfigDriftRecapSource,
} from "../../src/services/maintainer-recap-config-drift";

const GEN = "2026-07-08T00:00:00.000Z";

function source(knobs: ConfigDriftKnobStatus[], overrides: Partial<ConfigDriftRecapSource> = {}): ConfigDriftRecapSource {
  return { sentinelEnabled: true, generatedAt: GEN, knobs, ...overrides };
}

function driftingKnob(overrides: Partial<ConfigDriftKnobStatus> = {}): ConfigDriftKnobStatus {
  return {
    knobId: "ai_review_close_confidence",
    report: { direction: "tighter", liveValue: 0.9, dominatingValue: 0.95, visibleCases: 240, heldOutCases: 60 },
    episodeStartedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildConfigDriftRecapSection (#8214)", () => {
  it("renders the explicit disabled line when the sentinel flag is off (disabled arm)", () => {
    // #8214's mandated empty state: absence of DATA must be distinguishable from absence of DRIFT.
    const section = buildConfigDriftRecapSection(source([driftingKnob()], { sentinelEnabled: false }));
    expect(section.title).toBe("Config drift");
    expect(section.sentinelEnabled).toBe(false);
    expect(section.driftingKnobs).toBe(0);
    expect(section.cleanKnobs).toBe(0);
    expect(section.note).toMatch(/drift sentinel disabled/);
    expect(section.lines).toEqual([section.note]);
    // The supplied knob must NOT leak through the disabled arm.
    expect(section.lines.join("\n")).not.toContain("ai_review_close_confidence");
  });

  it("reports enabled-but-empty as its own state (no-knobs note arm)", () => {
    // The sentinel ran and had nothing to evaluate — distinct from disabled AND from all-clean.
    const section = buildConfigDriftRecapSection(source([]));
    expect(section.sentinelEnabled).toBe(true);
    expect(section.driftingKnobs).toBe(0);
    expect(section.cleanKnobs).toBe(0);
    expect(section.note).toMatch(/no live knobs were evaluated/);
    expect(section.note).not.toMatch(/drift sentinel disabled/);
    expect(section.lines).toEqual([section.note]);
  });

  it("collapses clean knobs into one summary line and takes the healthy note (all-clean arm)", () => {
    const section = buildConfigDriftRecapSection(
      source([driftingKnob({ knobId: "knob_a", report: null, episodeStartedAt: null }), driftingKnob({ knobId: "knob_b", report: null, episodeStartedAt: null })]),
    );
    expect(section.driftingKnobs).toBe(0);
    expect(section.cleanKnobs).toBe(2);
    expect(section.note).toMatch(/Config healthy: all 2 live knob\(s\) clean/);
    // ONE summary line for clean knobs (never one row per knob) + the note — nothing else.
    expect(section.lines).toEqual(["2 knob(s) clean — no alternative dominates the live value.", section.note]);
    expect(section.lines.join("\n")).not.toContain("knob_a");
  });

  it("renders a drifting knob with direction, live vs dominating, corpus sizes, and standing time beside a clean summary (mixed arm)", () => {
    // 2026-07-05 → 2026-07-08 ⇒ the episode has stood exactly 3 days (the days >= 1 ternary arm).
    const section = buildConfigDriftRecapSection(source([driftingKnob(), { knobId: "quiet_knob", report: null }]));
    expect(section.driftingKnobs).toBe(1);
    expect(section.cleanKnobs).toBe(1);
    const drift = section.lines[0];
    expect(drift).toContain("ai_review_close_confidence");
    expect(drift).toContain("stale-config warning — a tighter setting dominates live");
    expect(drift).toContain("live 0.9 vs dominating 0.95");
    expect(drift).toContain("(240 visible / 60 held-out case(s))");
    expect(drift).toContain("standing 3 day(s)");
    expect(section.lines[1]).toBe("1 knob(s) clean — no alternative dominates the live value.");
    expect(section.note).toMatch(/config drift: 1 of 2 live knob\(s\)/);
    expect(section.lines[2]).toBe(section.note);
  });

  it("omits the clean summary line when every knob drifts, and phrases looser/shipped directions distinctly (all-drifting arm)", () => {
    const shipped = driftingKnob({
      knobId: "override_knob",
      report: { direction: "shipped", liveValue: 0.8, dominatingValue: 0.7, visibleCases: 100, heldOutCases: 25 },
      episodeStartedAt: null,
    });
    const looser = driftingKnob({
      knobId: "looser_knob",
      report: { direction: "looser", liveValue: 0.9, dominatingValue: 0.85, visibleCases: 120, heldOutCases: 30 },
      episodeStartedAt: "2026-07-07T12:00:00.000Z",
    });
    const section = buildConfigDriftRecapSection(source([shipped, looser]));
    expect(section.driftingKnobs).toBe(2);
    expect(section.cleanKnobs).toBe(0);
    // "shipped" is checked before looser/tighter (mirrors KnobDriftReport.direction's own precedence).
    expect(section.lines[0]).toContain("drifted override should revert to shipped");
    // Absent fingerprint ⇒ the explicit unknown-age arm, never NaN.
    expect(section.lines[0]).toContain("episode age unknown");
    expect(section.lines[1]).toContain("informational — a looser setting dominates");
    // 12h-old episode ⇒ the days < 1 ternary arm.
    expect(section.lines[1]).toContain("standing <1 day");
    expect(section.lines.join("\n")).not.toContain("knob(s) clean");
    expect(section.note).toMatch(/config drift: 2 of 2 live knob\(s\)/);
  });

  it("reports episode age unknown when the recap's own generatedAt is unparseable (bad-now arm)", () => {
    // A valid fingerprint cannot rescue a broken "now" — both Date.parse arms must be guarded.
    const section = buildConfigDriftRecapSection(source([driftingKnob()], { generatedAt: "not-a-timestamp" }));
    expect(section.lines[0]).toContain("episode age unknown");
    expect(section.lines[0]).not.toContain("NaN");
  });

  it("clamps a future fingerprint (clock skew) to a <1 day standing, never a negative age", () => {
    const section = buildConfigDriftRecapSection(source([driftingKnob({ episodeStartedAt: "2026-07-09T00:00:00.000Z" })]));
    expect(section.lines[0]).toContain("standing <1 day");
    expect(section.lines[0]).not.toMatch(/standing -\d/);
  });

  it("never leaks corpus content: a FULL KnobDriftReport (with per-split comparisons) renders aggregates + ids only (invariant)", () => {
    // Structural-compatibility invariant: the sentinel will hand this section real KnobDriftReports
    // (loosening-knobs.ts:143). Their per-split BacktestComparison payloads and ruleId must never surface —
    // the projection renders aggregate numbers + the knob id, nothing else.
    const fullReport = {
      knobId: "ai_review_close_confidence",
      ruleId: "internal.rule.identifier",
      liveValue: 0.9,
      dominatingValue: 0.95,
      direction: "tighter" as const,
      visibleCases: 240,
      heldOutCases: 60,
      visible: { verdict: "improved", corpusExcerpt: "PR body text from the corpus /home/operator/loopover/case.json" },
      heldOut: { verdict: "unchanged", corpusExcerpt: "held-out corpus excerpt text" },
    };
    const section = buildConfigDriftRecapSection(source([{ knobId: fullReport.knobId, report: fullReport, episodeStartedAt: GEN }]));
    const body = section.lines.join("\n");
    expect(body).toContain("ai_review_close_confidence");
    expect(body).not.toContain("corpus excerpt");
    expect(body).not.toContain("PR body text");
    expect(body).not.toContain("/home/operator");
    expect(body).not.toContain("internal.rule.identifier");
  });

  it("scrubs a path-bearing knob id and caps line length (sanitizer pass)", () => {
    // Path FIRST so the scrub is provably applied before the 240-char cap truncates the padding tail.
    const section = buildConfigDriftRecapSection(
      source([driftingKnob({ knobId: `bad /root/secrets/config.json ${"x".repeat(300)}` })]),
    );
    expect(section.lines[0]).toContain("<redacted-path>");
    expect(section.lines[0]).not.toContain("/root/secrets/config.json");
    for (const line of section.lines) expect(line.length).toBeLessThanOrEqual(240);
  });
});
