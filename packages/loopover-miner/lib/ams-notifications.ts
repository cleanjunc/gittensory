// AMS → hosted badge notifications (#7657). Builds the AMS notification-event payloads and POSTs them to
// POST /v1/contributors/:login/ams-notifications, where they run through the hosted
// evaluateNotificationEvent → notify-deliver path (the same handoff src/queue/job-dispatch.ts uses for
// webhook-detected kinds). Fail-soft by design: a missing session, a slow backend, or a network blip must
// never fail or slow the miner's real work — every failure collapses to a structured no-op result.
//
// dedupKey/deeplink layouts are mirrored from src/notifications/ams-events.ts (the hosted twin — this
// package cannot import src/); change eventType strings or dedupKey layouts in BOTH places or not at all.

import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

export type AmsNotificationEventPayload = {
  eventType: "ams_attempt_started" | "ams_attempt_failed" | "ams_governor_paused" | "ams_pr_outcome";
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  dedupKey: string;
  deeplink: string;
  detectedAt: string;
};

export type AmsNotificationPublishResult = { sent: number; error?: string };

export type AmsNotificationFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export type PublishAmsNotificationEventsOptions = {
  env?: Record<string, string | undefined>;
  fetchFn?: AmsNotificationFetch;
  timeoutMs?: number;
};

export const DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS = 10_000;

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function issueDeeplink(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

function pullDeeplink(repoFullName: string, pullNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}

/** Attempt start — `pullNumber` carries the ISSUE number (hosted-twin convention). */
export function buildAmsAttemptStartedPayload(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  detectedAt?: string;
}): AmsNotificationEventPayload {
  const detectedAt = input.detectedAt ?? nowIso();
  return {
    eventType: "ams_attempt_started",
    recipientLogin: normalizeLogin(input.recipientLogin),
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_started:${input.repoFullName}#${input.issueNumber}:${input.attemptId}`,
    deeplink: issueDeeplink(input.repoFullName, input.issueNumber),
    detectedAt,
  };
}

/** Attempt fail — the failure reason folds into the dedupKey so distinct failure modes of one attempt
 *  notify distinctly while a redelivered identical failure stays deduped. */
export function buildAmsAttemptFailedPayload(input: {
  recipientLogin: string;
  repoFullName: string;
  issueNumber: number;
  attemptId: string;
  reason?: string | null | undefined;
  detectedAt?: string;
}): AmsNotificationEventPayload {
  const detectedAt = input.detectedAt ?? nowIso();
  const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
  return {
    eventType: "ams_attempt_failed",
    recipientLogin: normalizeLogin(input.recipientLogin),
    repoFullName: input.repoFullName,
    pullNumber: input.issueNumber,
    dedupKey: `ams_attempt_failed:${input.repoFullName}#${input.issueNumber}:${input.attemptId}${reasonKey}`,
    deeplink: issueDeeplink(input.repoFullName, input.issueNumber),
    detectedAt,
  };
}

/** Governor pause — miner-global, not repo-scoped: synthetic `ams/governor` scope, `pullNumber` 0. */
export function buildAmsGovernorPausedPayload(input: {
  recipientLogin: string;
  reason?: string | null | undefined;
  pausedAt?: string | null | undefined;
  detectedAt?: string;
}): AmsNotificationEventPayload {
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
    detectedAt,
  };
}

/** Miner-local PR outcome. dedupKey layout: ams_pr_outcome:{merged|closed}:{repo}#{n}:{closedAt} — the
 *  hosted content builder reads the decision back out of it. */
export function buildAmsPrOutcomePayload(input: {
  recipientLogin: string;
  repoFullName: string;
  pullNumber: number;
  decision: "merged" | "closed";
  closedAt?: string | null | undefined;
  detectedAt?: string;
}): AmsNotificationEventPayload {
  const detectedAt = input.detectedAt ?? nowIso();
  const closedAt = input.closedAt?.trim() || detectedAt;
  return {
    eventType: "ams_pr_outcome",
    recipientLogin: normalizeLogin(input.recipientLogin),
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    dedupKey: `ams_pr_outcome:${input.decision}:${input.repoFullName}#${input.pullNumber}:${closedAt}`,
    deeplink: pullDeeplink(input.repoFullName, input.pullNumber),
    detectedAt,
  };
}

/**
 * POST a batch of AMS notification events to the hosted ingest for their (single, shared) recipient.
 * Requires a loopover-mcp session on disk (resolveLoopoverBackendSession); without one this is a silent
 * no-op — badge notifications are an opt-in nicety, not miner infrastructure. Never throws.
 */
export async function publishAmsNotificationEvents(
  events: AmsNotificationEventPayload[],
  options: PublishAmsNotificationEventsOptions = {},
): Promise<AmsNotificationPublishResult> {
  if (events.length === 0) return { sent: 0 };
  const env = options.env ?? process.env;
  const session = resolveLoopoverBackendSession(env as NodeJS.ProcessEnv);
  if (!session) return { sent: 0, error: "no_session" };

  const recipientLogin = normalizeLogin(events[0]!.recipientLogin);
  if (!recipientLogin) return { sent: 0, error: "missing_recipient" };
  // The ingest is self-scoped per login; a mixed batch would silently re-stamp someone else's event.
  if (events.some((event) => normalizeLogin(event.recipientLogin) !== recipientLogin)) {
    return { sent: 0, error: "mixed_recipients" };
  }

  const fetchFn = options.fetchFn ?? (fetch as AmsNotificationFetch);
  const url = `${session.apiUrl}/v1/contributors/${encodeURIComponent(recipientLogin)}/ams-notifications`;
  const body = JSON.stringify({
    // recipientLogin stays out of the wire payload (it's the URL); the server re-stamps recipient AND actor
    // from the authenticated session either way.
    events: events.map(({ eventType, repoFullName, pullNumber, dedupKey, deeplink, detectedAt }) => ({
      eventType,
      repoFullName,
      pullNumber,
      dedupKey,
      deeplink,
      detectedAt,
    })),
  });

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS),
    });
    if (!response.ok) return { sent: 0, error: `http_${response.status}` };
    return { sent: events.length };
  } catch (error) {
    return { sent: 0, error: error instanceof Error ? error.message.slice(0, 160) : "network_failed" };
  }
}

/** Fire-and-forget wrapper for call sites that must never await into their critical path. */
export function scheduleAmsNotificationEvents(
  events: AmsNotificationEventPayload[],
  options: PublishAmsNotificationEventsOptions = {},
): void {
  // publishAmsNotificationEvents never rejects; void just detaches the promise from the caller.
  void publishAmsNotificationEvents(events, options);
}
