// AMS → badge notification bridge (#7657). Pure builders for the AMS-relevant DetectedNotificationEvent
// kinds (attempt start/fail, governor pause, the miner's own PR-outcome change) plus the ingest-side
// validator the session-authenticated route uses. Everything here feeds the EXISTING
// evaluateNotificationEvent → notify-deliver path (src/queue/job-dispatch.ts) — no parallel delivery store.
//
// The payload/dedupKey layout is mirrored in packages/loopover-miner/lib/ams-notifications.ts (the miner
// cannot import src/); change eventType strings or dedupKey layouts in BOTH places or not at all.

import type { DetectedNotificationEvent, NotificationEventType } from "../types";
import { nowIso } from "../utils/json";

export const AMS_NOTIFICATION_EVENT_TYPES = [
  "ams_attempt_started",
  "ams_attempt_failed",
  "ams_governor_paused",
  "ams_pr_outcome",
] as const satisfies readonly NotificationEventType[];

export type AmsNotificationEventType = (typeof AMS_NOTIFICATION_EVENT_TYPES)[number];

const AMS_EVENT_TYPE_SET = new Set<string>(AMS_NOTIFICATION_EVENT_TYPES);

export function isAmsNotificationEventType(value: unknown): value is AmsNotificationEventType {
  return typeof value === "string" && AMS_EVENT_TYPE_SET.has(value);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function issueDeeplink(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

function pullDeeplink(repoFullName: string, pullNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}

/** Attempt start — `pullNumber` carries the ISSUE number (the same overload issue_watch_match uses). */
export function buildAmsAttemptStartedEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  return {
    eventType: "ams_attempt_started",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_started:${input.repoFullName}#${input.issueNumber}:${input.attemptId}`,
    deeplink: issueDeeplink(input.repoFullName, input.issueNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/** Attempt fail — same issue-number overload as start; `reason` folds into the dedupKey so distinct failure
 *  modes of one attempt notify distinctly while a retried identical failure stays deduped. */
export function buildAmsAttemptFailedEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  reason?: string | null | undefined;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
  return {
    eventType: "ams_attempt_failed",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_failed:${input.repoFullName}#${input.issueNumber}:${input.attemptId}${reasonKey}`,
    deeplink: issueDeeplink(input.repoFullName, input.issueNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/** Governor pause — not repo/PR-scoped, so `repoFullName` is a stable synthetic scope and `pullNumber` 0
 *  (the same field-overload convention issue_watch_match set for non-PR events). */
export function buildAmsGovernorPausedEvent(input: {
  recipientLogin: string;
  reason?: string | null | undefined;
  pausedAt?: string | null | undefined;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const pausedAt = input.pausedAt ?? detectedAt;
  const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
  return {
    eventType: "ams_governor_paused",
    recipientLogin,
    repoFullName: "ams/governor",
    pullNumber: 0,
    dedupKey: `ams_governor_paused:${recipientLogin}:${pausedAt}${reasonKey}`,
    deeplink: "https://github.com/JSONbored/loopover",
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/** Miner-local PR outcome (merged or closed-without-merge). The decision sits right after the eventType in
 *  the dedupKey (ams_pr_outcome:{merged|closed}:{repo}#{n}:{closedAt}) so buildAmsPrOutcomeNotification can
 *  read it back without a payload column. */
export function buildAmsPrOutcomeEvent(input: {
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  decision: "merged" | "closed";
  closedAt?: string | null | undefined;
  detectedAt?: string;
}): DetectedNotificationEvent {
  const recipientLogin = normalizeLogin(input.recipientLogin);
  const detectedAt = input.detectedAt ?? nowIso();
  const closedAt = input.closedAt?.trim() || detectedAt;
  return {
    eventType: "ams_pr_outcome",
    recipientLogin,
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    dedupKey: `ams_pr_outcome:${input.decision}:${input.repoFullName}#${input.pullNumber}:${closedAt}`,
    deeplink: pullDeeplink(input.repoFullName, input.pullNumber),
    actorLogin: recipientLogin,
    detectedAt,
  };
}

/**
 * Validate one miner-posted AMS event and stamp the authenticated recipient onto it. Only AMS kinds pass —
 * the ingest route must not let a client forge webhook-detected notification types — and both recipient and
 * actor are forced to the authenticated login, never trusted from the payload.
 */
export function normalizeAmsNotificationEventInput(raw: unknown, recipientLogin: string): DetectedNotificationEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isAmsNotificationEventType(record.eventType)) return null;
  if (typeof record.repoFullName !== "string" || !record.repoFullName.trim()) return null;
  if (typeof record.dedupKey !== "string" || !record.dedupKey.trim()) return null;
  if (typeof record.deeplink !== "string" || !record.deeplink.trim()) return null;
  if (typeof record.detectedAt !== "string" || !record.detectedAt.trim()) return null;
  if (typeof record.pullNumber !== "number" || !Number.isInteger(record.pullNumber) || record.pullNumber < 0) return null;
  const login = normalizeLogin(recipientLogin);
  return {
    eventType: record.eventType,
    recipientLogin: login,
    repoFullName: record.repoFullName.trim(),
    pullNumber: record.pullNumber,
    dedupKey: record.dedupKey.trim(),
    deeplink: record.deeplink.trim(),
    actorLogin: login,
    detectedAt: record.detectedAt.trim(),
  };
}
