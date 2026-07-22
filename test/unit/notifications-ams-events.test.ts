import { describe, expect, it } from "vitest";
import {
  AMS_NOTIFICATION_EVENT_TYPES,
  buildAmsAttemptFailedEvent,
  buildAmsAttemptStartedEvent,
  buildAmsGovernorPausedEvent,
  buildAmsPrOutcomeEvent,
  isAmsNotificationEventType,
  normalizeAmsNotificationEventInput,
} from "../../src/notifications/ams-events";

// #7657: the AMS event builders + the ingest-side validator. These pin the dedupKey layouts (mirrored by hand
// in packages/loopover-miner/lib/ams-notifications.ts — the miner cannot import src/) and the ingest rule that
// recipient AND actor are always re-stamped from the authenticated login, never trusted from the payload.

describe("isAmsNotificationEventType (#7657)", () => {
  it("accepts exactly the four AMS kinds", () => {
    for (const eventType of AMS_NOTIFICATION_EVENT_TYPES) expect(isAmsNotificationEventType(eventType)).toBe(true);
  });

  it("rejects webhook kinds and non-strings — the ingest must not forge webhook notification types", () => {
    expect(isAmsNotificationEventType("pull_request_merged")).toBe(false);
    expect(isAmsNotificationEventType("pull_request_changes_requested")).toBe(false);
    expect(isAmsNotificationEventType("issue_watch_match")).toBe(false);
    expect(isAmsNotificationEventType(undefined)).toBe(false);
    expect(isAmsNotificationEventType(7)).toBe(false);
  });
});

describe("AMS event builders (#7657)", () => {
  it("builds an attempt-started event with the issue number in pullNumber and an issue deeplink", () => {
    const event = buildAmsAttemptStartedEvent({
      recipientLogin: " Miner1 ",
      repoFullName: "acme/widgets",
      issueNumber: 41,
      attemptId: "attempt-9",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(event).toEqual({
      eventType: "ams_attempt_started",
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      pullNumber: 41,
      dedupKey: "ams_attempt_started:acme/widgets#41:attempt-9",
      deeplink: "https://github.com/acme/widgets/issues/41",
      actorLogin: "miner1",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
  });

  it("defaults detectedAt to now in every builder when omitted", () => {
    const built = [
      buildAmsAttemptStartedEvent({ recipientLogin: "miner1", repoFullName: "acme/widgets", issueNumber: 41, attemptId: "a" }),
      buildAmsAttemptFailedEvent({ recipientLogin: "miner1", repoFullName: "acme/widgets", issueNumber: 41, attemptId: "a" }),
      buildAmsGovernorPausedEvent({ recipientLogin: "miner1" }),
      buildAmsPrOutcomeEvent({ recipientLogin: "miner1", repoFullName: "acme/widgets", pullNumber: 9, decision: "merged" }),
    ];
    for (const event of built) expect(Number.isNaN(Date.parse(event.detectedAt))).toBe(false);
  });

  it("folds a failure reason into the attempt-failed dedupKey, truncated to 80 chars", () => {
    const event = buildAmsAttemptFailedEvent({
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      issueNumber: 41,
      attemptId: "attempt-9",
      reason: ` ${"r".repeat(120)} `,
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(event.eventType).toBe("ams_attempt_failed");
    expect(event.dedupKey).toBe(`ams_attempt_failed:acme/widgets#41:attempt-9:${"r".repeat(80)}`);
    expect(event.deeplink).toBe("https://github.com/acme/widgets/issues/41");
  });

  it("omits the reason segment when the reason is absent or blank", () => {
    for (const reason of [undefined, null, "  "]) {
      const event = buildAmsAttemptFailedEvent({
        recipientLogin: "miner1",
        repoFullName: "acme/widgets",
        issueNumber: 41,
        attemptId: "attempt-9",
        reason,
        detectedAt: "2026-07-22T10:00:00.000Z",
      });
      expect(event.dedupKey).toBe("ams_attempt_failed:acme/widgets#41:attempt-9");
    }
  });

  it("scopes a governor pause to the synthetic ams/governor repo with pullNumber 0", () => {
    const event = buildAmsGovernorPausedEvent({
      recipientLogin: "Miner1",
      reason: "manual stop",
      pausedAt: "2026-07-22T09:00:00.000Z",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(event).toEqual({
      eventType: "ams_governor_paused",
      recipientLogin: "miner1",
      repoFullName: "ams/governor",
      pullNumber: 0,
      dedupKey: "ams_governor_paused:miner1:2026-07-22T09:00:00.000Z:manual stop",
      deeplink: "https://github.com/JSONbored/loopover",
      actorLogin: "miner1",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
  });

  it("defaults pausedAt to detectedAt and omits the reason segment when absent", () => {
    const event = buildAmsGovernorPausedEvent({ recipientLogin: "miner1", detectedAt: "2026-07-22T10:00:00.000Z" });
    expect(event.dedupKey).toBe("ams_governor_paused:miner1:2026-07-22T10:00:00.000Z");
  });

  it("puts the decision right after the eventType in the pr-outcome dedupKey (content builder reads it back)", () => {
    const merged = buildAmsPrOutcomeEvent({
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      pullNumber: 9,
      decision: "merged",
      closedAt: "2026-07-22T08:00:00.000Z",
      detectedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(merged.dedupKey).toBe("ams_pr_outcome:merged:acme/widgets#9:2026-07-22T08:00:00.000Z");
    expect(merged.deeplink).toBe("https://github.com/acme/widgets/pull/9");
    expect(merged.pullNumber).toBe(9);
  });

  it("falls back to detectedAt when closedAt is absent or blank", () => {
    for (const closedAt of [undefined, null, " "]) {
      const event = buildAmsPrOutcomeEvent({
        recipientLogin: "miner1",
        repoFullName: "acme/widgets",
        pullNumber: 9,
        decision: "closed",
        closedAt,
        detectedAt: "2026-07-22T10:00:00.000Z",
      });
      expect(event.dedupKey).toBe("ams_pr_outcome:closed:acme/widgets#9:2026-07-22T10:00:00.000Z");
    }
  });
});

describe("normalizeAmsNotificationEventInput (#7657)", () => {
  const valid = {
    eventType: "ams_attempt_started",
    repoFullName: "acme/widgets",
    pullNumber: 41,
    dedupKey: "ams_attempt_started:acme/widgets#41:attempt-9",
    deeplink: "https://github.com/acme/widgets/issues/41",
    detectedAt: "2026-07-22T10:00:00.000Z",
  };

  it("stamps recipient AND actor from the authenticated login, never the payload", () => {
    const event = normalizeAmsNotificationEventInput({ ...valid, actorLogin: "someone-else" }, " Miner1 ");
    expect(event).toEqual({
      eventType: "ams_attempt_started",
      recipientLogin: "miner1",
      repoFullName: "acme/widgets",
      pullNumber: 41,
      dedupKey: valid.dedupKey,
      deeplink: valid.deeplink,
      actorLogin: "miner1",
      detectedAt: valid.detectedAt,
    });
  });

  it("trims string fields", () => {
    const event = normalizeAmsNotificationEventInput(
      { ...valid, repoFullName: " acme/widgets ", dedupKey: ` ${valid.dedupKey} `, deeplink: ` ${valid.deeplink} `, detectedAt: ` ${valid.detectedAt} ` },
      "miner1",
    );
    expect(event?.repoFullName).toBe("acme/widgets");
    expect(event?.dedupKey).toBe(valid.dedupKey);
    expect(event?.deeplink).toBe(valid.deeplink);
    expect(event?.detectedAt).toBe(valid.detectedAt);
  });

  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["an array", [valid]],
    ["a webhook eventType", { ...valid, eventType: "pull_request_merged" }],
    ["a missing repoFullName", { ...valid, repoFullName: undefined }],
    ["a whitespace repoFullName", { ...valid, repoFullName: "  " }],
    ["a missing dedupKey", { ...valid, dedupKey: undefined }],
    ["a whitespace dedupKey", { ...valid, dedupKey: "  " }],
    ["a missing deeplink", { ...valid, deeplink: undefined }],
    ["a whitespace deeplink", { ...valid, deeplink: "  " }],
    ["a missing detectedAt", { ...valid, detectedAt: undefined }],
    ["a whitespace detectedAt", { ...valid, detectedAt: "  " }],
    ["a non-integer pullNumber", { ...valid, pullNumber: 4.5 }],
    ["a negative pullNumber", { ...valid, pullNumber: -1 }],
    ["a string pullNumber", { ...valid, pullNumber: "41" }],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeAmsNotificationEventInput(raw, "miner1")).toBeNull();
  });

  it("accepts pullNumber 0 (the governor-pause synthetic scope)", () => {
    const event = normalizeAmsNotificationEventInput(
      { ...valid, eventType: "ams_governor_paused", repoFullName: "ams/governor", pullNumber: 0, dedupKey: "ams_governor_paused:miner1:t" },
      "miner1",
    );
    expect(event?.pullNumber).toBe(0);
  });
});
