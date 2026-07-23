// Maintainer-recap CONFIG-DRIFT section (#8214, epic #8211 track A — content slice of the #1963 recap digest).
//
// Pure section builder over a plain source struct: surface each live knob's CURRENT drift verdict from the
// nightly config-drift sentinel (#8213) — the evaluateKnobDrift report the sentinel computes
// (services/loosening-knobs.ts:143) — so a STANDING drift episode is impossible to miss in the recap. Drift
// alerts are point-in-time; this section is the standing surface. Mirrors buildCalibrationRecapSection
// (maintainer-recap-calibration.ts): a pure section builder over a projection, aggregate numbers + knob ids
// only — the report's per-split BacktestComparisons are deliberately NOT part of the projection, so corpus
// content structurally cannot reach the digest.
//
// Direction semantics mirror KnobDriftReport.direction (loosening-knobs.ts:143): "tighter" = live config is
// likely stale (actionable), "looser" = informational duplicate of the loosening loop's own proposal,
// "shipped" = a drifted override should revert to the registry's shipped value.
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";
import type { ConfigDriftRecapSection } from "../types";

/** Projection of one knob's {@link KnobDriftReport} (loosening-knobs.ts:143) used by this section —
 *  aggregate numbers + the direction verdict only; structurally satisfied by a full KnobDriftReport. */
export type ConfigDriftReportProjection = {
  direction: "looser" | "tighter" | "shipped";
  liveValue: number;
  dominatingValue: number;
  visibleCases: number;
  heldOutCases: number;
};

/** One live knob's current sentinel status. `report: null` ⇒ clean (no alternative dominates live). */
export type ConfigDriftKnobStatus = {
  knobId: string;
  report: ConfigDriftReportProjection | null;
  /** The sentinel's episode fingerprint timestamp (ISO) — when THIS drift episode was first observed.
   *  Null/absent when clean, or when the sentinel has not stamped one yet. */
  episodeStartedAt?: string | null | undefined;
};

/** Plain source struct for the config-drift section — injected by the caller (the sentinel's recap plumbing),
 *  exactly like CalibrationRecapSource / MaintainerRecapInputs. No I/O here. */
export type ConfigDriftRecapSource = {
  /** The sentinel flag's resolved state. False renders the explicit disabled line — absence of DATA must
   *  never be mistaken for absence of DRIFT (#8214). */
  sentinelEnabled: boolean;
  /** Recap generation instant (ISO) — the "now" each episode's standing time is measured against. */
  generatedAt: string;
  knobs: ConfigDriftKnobStatus[];
};

const MS_PER_DAY = 86_400_000;

/** Public-safe scrub for free text pulled into the section (defense in depth — knob ids are the only
 *  free-text inputs today). Mirrors maintainer-recap-calibration.ts's sanitizeRecapText. */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

/** How long a drift episode has stood, measured fingerprint → generatedAt. "episode age unknown" when either
 *  timestamp is unparseable (absent fingerprint included); clock skew (a fingerprint AFTER generatedAt)
 *  clamps to 0 so a skewed sentinel never renders a negative age. */
function describeEpisodeStanding(episodeStartedAt: string | null | undefined, generatedAt: string): string {
  const started = Date.parse(episodeStartedAt ?? "");
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return "episode age unknown";
  const days = Math.floor(Math.max(0, now - started) / MS_PER_DAY);
  return days < 1 ? "standing <1 day" : `standing ${days} day(s)`;
}

/** Per-direction plain-English reading, mirroring the consumer guidance on KnobDriftReport.direction:
 *  "shipped" is checked first (a drifted override should revert), then tighter=actionable / looser=informational. */
function describeDirection(direction: ConfigDriftReportProjection["direction"]): string {
  if (direction === "shipped") return "drifted override should revert to shipped";
  return direction === "tighter"
    ? "stale-config warning — a tighter setting dominates live"
    : "informational — a looser setting dominates (duplicates the loosening loop's own proposal)";
}

/**
 * Pure config-drift section over the sentinel's per-knob drift reports (#8214).
 *
 * - Sentinel flag OFF ⇒ the single explicit "drift sentinel disabled" line — absence of data stays
 *   distinguishable from absence of drift.
 * - Each drifting knob renders direction, live vs dominating value, both corpus sizes, and episode standing
 *   time; clean knobs collapse into ONE summary line.
 * - Note arms: no-knobs-evaluated, drift-present, all-clean.
 */
export function buildConfigDriftRecapSection(source: ConfigDriftRecapSource): ConfigDriftRecapSection {
  const title = "Config drift";
  if (!source.sentinelEnabled) {
    // The issue-mandated explicit empty state (#8214): the section still renders, and says WHY it is empty.
    const note = "drift sentinel disabled — no drift data was collected for this window.";
    return { title, sentinelEnabled: false, driftingKnobs: 0, cleanKnobs: 0, note: sanitizeRecapText(note), lines: [sanitizeRecapText(note)] };
  }

  const drifting = source.knobs.flatMap((knob) => (knob.report ? [{ knob, report: knob.report }] : []));
  const cleanCount = source.knobs.length - drifting.length;

  const lines = drifting.map(
    ({ knob, report }) =>
      `${knob.knobId} — ${describeDirection(report.direction)}: live ${report.liveValue} vs dominating ${report.dominatingValue} (${report.visibleCases} visible / ${report.heldOutCases} held-out case(s)); ${describeEpisodeStanding(knob.episodeStartedAt, source.generatedAt)}`,
  );
  if (cleanCount > 0) {
    // The issue's "clean knobs as one summary line" — never one row per clean knob.
    lines.push(`${cleanCount} knob(s) clean — no alternative dominates the live value.`);
  }

  let note: string;
  if (source.knobs.length === 0) {
    // Enabled-but-empty is its own state: the sentinel ran and had nothing to evaluate.
    note = "Drift sentinel enabled, but no live knobs were evaluated this window.";
  } else if (drifting.length > 0) {
    note = `config drift: ${drifting.length} of ${source.knobs.length} live knob(s) have a dominating alternative on the trailing corpus.`;
  } else {
    note = `Config healthy: all ${source.knobs.length} live knob(s) clean — nothing dominates the live values.`;
  }
  lines.push(note);

  return {
    title,
    sentinelEnabled: true,
    driftingKnobs: drifting.length,
    cleanKnobs: cleanCount,
    note: sanitizeRecapText(note),
    lines: lines.map(sanitizeRecapText),
  };
}
