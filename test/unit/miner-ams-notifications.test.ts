import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAmsAttemptFailedPayload,
  buildAmsAttemptStartedPayload,
  buildAmsGovernorPausedPayload,
  buildAmsPrOutcomePayload,
  DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS,
  publishAmsNotificationEvents,
  scheduleAmsNotificationEvents,
  type AmsNotificationEventPayload,
  type AmsNotificationFetch,
} from "../../packages/loopover-miner/lib/ams-notifications.js";

// #7657: the miner-side AMS notification client. Payload builders mirror src/notifications/ams-events.ts's
// dedupKey/deeplink layouts by hand (this package cannot import src/) — the builder assertions here pin that
// lockstep. publishAmsNotificationEvents is fail-soft by contract: every failure mode collapses to a
// structured { sent: 0, error } result and never throws into the miner's real work.

// Session posture mirrors miner-github-token-resolution.test.ts: a temp LOOPOVER_CONFIG_DIR (never this
// machine's real ~/.config) holding a loopover-mcp config.json with a session token.
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "loopover-miner-ams-notifications-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { default: { session: { token: "session-token-1" } } } }), { mode: 0o600 });
  return { LOOPOVER_CONFIG_DIR: dir, LOOPOVER_API_URL: "https://api.example.test", ...overrides };
}

function sessionlessEnv(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "loopover-miner-ams-notifications-nosession-"));
  dirs.push(dir);
  return { LOOPOVER_CONFIG_DIR: dir };
}

function payload(overrides: Partial<AmsNotificationEventPayload> = {}): AmsNotificationEventPayload {
  return {
    eventType: "ams_attempt_started",
    recipientLogin: "miner1",
    repoFullName: "acme/widgets",
    pullNumber: 41,
    dedupKey: "ams_attempt_started:acme/widgets#41:attempt-9",
    deeplink: "https://github.com/acme/widgets/issues/41",
    detectedAt: "2026-07-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("AMS notification payload builders (#7657)", () => {
  it("mirrors the hosted attempt-started dedupKey/deeplink layout with the issue number in pullNumber", () => {
    expect(
      buildAmsAttemptStartedPayload({
        recipientLogin: " Miner1 ",
        repoFullName: "acme/widgets",
        issueNumber: 41,
        attemptId: "attempt-9",
        detectedAt: "2026-07-22T10:00:00.000Z",
      }),
    ).toEqual(payload());
  });

  it("folds a trimmed, 80-char-capped reason into the attempt-failed dedupKey and omits it when blank", () => {
    const withReason = buildAmsAttemptFailedPayload({
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      issueNumber: 41,
      attemptId: "attempt-9",
      reason: ` ${"r".repeat(120)} `,
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(withReason.dedupKey).toBe(`ams_attempt_failed:acme/widgets#41:attempt-9:${"r".repeat(80)}`);
    for (const reason of [undefined, null, " "]) {
      const bare = buildAmsAttemptFailedPayload({
        recipientLogin: "miner1",
        repoFullName: "acme/widgets",
        issueNumber: 41,
        attemptId: "attempt-9",
        reason,
        detectedAt: "2026-07-22T10:00:00.000Z",
      });
      expect(bare.dedupKey).toBe("ams_attempt_failed:acme/widgets#41:attempt-9");
    }
  });

  it("scopes a governor pause to ams/governor with pullNumber 0, defaulting pausedAt to detectedAt", () => {
    const explicit = buildAmsGovernorPausedPayload({
      recipientLogin: "Miner1",
      reason: "manual stop",
      pausedAt: "2026-07-22T09:00:00.000Z",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(explicit).toMatchObject({
      eventType: "ams_governor_paused",
      recipientLogin: "miner1",
      repoFullName: "ams/governor",
      pullNumber: 0,
      dedupKey: "ams_governor_paused:miner1:2026-07-22T09:00:00.000Z:manual stop",
    });
    const defaulted = buildAmsGovernorPausedPayload({ recipientLogin: "miner1", detectedAt: "2026-07-22T10:00:00.000Z" });
    expect(defaulted.dedupKey).toBe("ams_governor_paused:miner1:2026-07-22T10:00:00.000Z");
  });

  it("encodes the decision into the pr-outcome dedupKey and falls back to detectedAt when closedAt is blank", () => {
    const merged = buildAmsPrOutcomePayload({
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      pullNumber: 9,
      decision: "merged",
      closedAt: "2026-07-22T08:00:00.000Z",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(merged.dedupKey).toBe("ams_pr_outcome:merged:acme/widgets#9:2026-07-22T08:00:00.000Z");
    expect(merged.deeplink).toBe("https://github.com/acme/widgets/pull/9");
    for (const closedAt of [undefined, null, " "]) {
      const closed = buildAmsPrOutcomePayload({
        recipientLogin: "miner1",
        repoFullName: "acme/widgets",
        pullNumber: 9,
        decision: "closed",
        closedAt,
        detectedAt: "2026-07-22T10:00:00.000Z",
      });
      expect(closed.dedupKey).toBe("ams_pr_outcome:closed:acme/widgets#9:2026-07-22T10:00:00.000Z");
    }
  });

  it("defaults detectedAt to now in every builder when omitted", () => {
    const built = [
      buildAmsAttemptStartedPayload({ recipientLogin: "miner1", repoFullName: "acme/widgets", issueNumber: 41, attemptId: "a" }),
      buildAmsAttemptFailedPayload({ recipientLogin: "miner1", repoFullName: "acme/widgets", issueNumber: 41, attemptId: "a" }),
      buildAmsGovernorPausedPayload({ recipientLogin: "miner1" }),
      buildAmsPrOutcomePayload({ recipientLogin: "miner1", repoFullName: "acme/widgets", pullNumber: 9, decision: "merged" }),
    ];
    for (const payloadBuilt of built) expect(Number.isNaN(Date.parse(payloadBuilt.detectedAt))).toBe(false);
  });
});

describe("publishAmsNotificationEvents (#7657)", () => {
  it("POSTs the batch to the recipient's ams-notifications ingest with the session bearer token", async () => {
    const calls: Array<{ url: string; init?: Parameters<AmsNotificationFetch>[1] }> = [];
    const fetchFn: AmsNotificationFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ login: "miner1", accepted: 1, enqueued: 1 }), { status: 200 });
    };
    const result = await publishAmsNotificationEvents([payload()], { env: sessionEnv(), fetchFn });
    expect(result).toEqual({ sent: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/contributors/miner1/ams-notifications");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers?.authorization).toBe("Bearer session-token-1");
    const body = JSON.parse(calls[0]!.init?.body ?? "{}") as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(1);
    // recipientLogin rides the URL, never the wire payload — the server re-stamps recipient AND actor anyway.
    expect(body.events[0]!).toEqual({
      eventType: "ams_attempt_started",
      repoFullName: "acme/widgets",
      pullNumber: 41,
      dedupKey: "ams_attempt_started:acme/widgets#41:attempt-9",
      deeplink: "https://github.com/acme/widgets/issues/41",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("no-ops on an empty batch without touching the session or network", async () => {
    const fetchFn = vi.fn<AmsNotificationFetch>();
    expect(await publishAmsNotificationEvents([], { env: sessionEnv(), fetchFn })).toEqual({ sent: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips silently when no loopover session is on disk — notifications are a nicety, not infrastructure", async () => {
    const fetchFn = vi.fn<AmsNotificationFetch>();
    expect(await publishAmsNotificationEvents([payload()], { env: sessionlessEnv(), fetchFn })).toEqual({ sent: 0, error: "no_session" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a batch whose first recipient normalizes to empty", async () => {
    const fetchFn = vi.fn<AmsNotificationFetch>();
    expect(await publishAmsNotificationEvents([payload({ recipientLogin: "  " })], { env: sessionEnv(), fetchFn })).toEqual({
      sent: 0,
      error: "missing_recipient",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a mixed-recipient batch — the ingest is self-scoped per login", async () => {
    const fetchFn = vi.fn<AmsNotificationFetch>();
    const result = await publishAmsNotificationEvents([payload(), payload({ recipientLogin: "other" })], {
      env: sessionEnv(),
      fetchFn,
    });
    expect(result).toEqual({ sent: 0, error: "mixed_recipients" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats matching recipients that differ only in case/whitespace as one recipient", async () => {
    const fetchFn: AmsNotificationFetch = async () => new Response("{}", { status: 200 });
    const result = await publishAmsNotificationEvents([payload(), payload({ recipientLogin: " MINER1 " })], {
      env: sessionEnv(),
      fetchFn,
    });
    expect(result).toEqual({ sent: 2 });
  });

  it("reports a non-2xx response as http_<status> without throwing", async () => {
    const fetchFn: AmsNotificationFetch = async () => new Response("nope", { status: 403 });
    expect(await publishAmsNotificationEvents([payload()], { env: sessionEnv(), fetchFn })).toEqual({
      sent: 0,
      error: "http_403",
    });
  });

  it("collapses a thrown fetch (network blip / timeout) to a structured error without throwing", async () => {
    const fetchFn: AmsNotificationFetch = async () => {
      throw new Error(`boom ${"x".repeat(300)}`);
    };
    const result = await publishAmsNotificationEvents([payload()], { env: sessionEnv(), fetchFn });
    expect(result.sent).toBe(0);
    expect(result.error).toHaveLength(160);
    const nonError: AmsNotificationFetch = async () => {
      throw "string-throw";
    };
    expect(await publishAmsNotificationEvents([payload()], { env: sessionEnv(), fetchFn: nonError })).toEqual({
      sent: 0,
      error: "network_failed",
    });
  });

  it("defaults to process.env when no env option is given (stubbed to a sessionless dir — never this box's real config)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopover-miner-ams-notifications-procenv-"));
    dirs.push(dir);
    vi.stubEnv("LOOPOVER_CONFIG_DIR", dir);
    try {
      await expect(publishAmsNotificationEvents([payload()])).resolves.toEqual({ sent: 0, error: "no_session" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the global fetch and the injected timeout when no fetchFn is given", async () => {
    let capturedUrl: string | undefined;
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: { signal?: AbortSignal }) => {
      capturedUrl = url;
      capturedSignal = init?.signal;
      return new Response("{}", { status: 200 });
    });
    try {
      const result = await publishAmsNotificationEvents([payload()], { env: sessionEnv(), timeoutMs: 5_000 });
      expect(result).toEqual({ sent: 1 });
      expect(capturedUrl).toBe("https://api.example.test/v1/contributors/miner1/ams-notifications");
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS).toBe(10_000);
  });
});

describe("scheduleAmsNotificationEvents (#7657)", () => {
  it("fires publish without awaiting into the caller (fire-and-forget)", async () => {
    let resolved = false;
    const fetchFn: AmsNotificationFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      resolved = true;
      return new Response("{}", { status: 200 });
    };
    scheduleAmsNotificationEvents([payload()], { env: sessionEnv(), fetchFn });
    expect(resolved).toBe(false);
    await vi.waitFor(() => expect(resolved).toBe(true));
  });
});
