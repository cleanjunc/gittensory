import { describe, expect, it, vi } from "vitest";
import {
  MINER_PR_OUTCOME_DECISIONS,
  MINER_PR_OUTCOME_EVENT,
  normalizePrOutcomePayload,
  readPrOutcomes,
  recordPrOutcomeSnapshot,
} from "../../packages/loopover-miner/lib/pr-outcome.js";
import type { AppendEventInput, LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger.js";

// A minimal injected event ledger (the DI shape the writer/reader accept), so these stay pure unit tests with no
// SQLite file. `_events` is exposed so a test can inject crafted rows for the reader's defensive skip branches.
// Typed against the real EventLedger#appendEvent contract so this mock can't silently drift from it.
function mockLedger(): { appendEvent: (e: AppendEventInput) => LedgerEntry; readEvents: (filter?: { repoFullName?: string }) => unknown[]; _events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    appendEvent: (e) => {
      const entry = { id: ++seq, seq, type: e.type, repoFullName: e.repoFullName ?? null, payload: e.payload, createdAt: new Date().toISOString() };
      events.push(entry);
      return entry;
    },
    readEvents: (filter = {}) => events.filter((e) => filter.repoFullName === undefined || e.repoFullName === filter.repoFullName),
    _events: events,
  };
}

describe("normalizePrOutcomePayload (#4274)", () => {
  it("rejects a non-object, a bad prNumber, or an unknown decision", () => {
    for (const bad of [null, "x", [1], {}, { prNumber: 0, decision: "merged" }, { prNumber: 1.5, decision: "merged" }, { prNumber: 3, decision: "abandoned" }, { prNumber: 3 }]) {
      expect(normalizePrOutcomePayload(bad)).toBeNull();
    }
  });

  it("keeps a closed decision's reason only when it is a recognized rejection bucket", () => {
    expect(normalizePrOutcomePayload({ prNumber: 7, decision: "closed", reason: "gate_close", closedAt: "2026-07-09T00:00:00Z" })).toEqual({
      prNumber: 7,
      decision: "closed",
      closedAt: "2026-07-09T00:00:00Z",
      reason: "gate_close",
    });
    // unrecognized reason → dropped
    expect(normalizePrOutcomePayload({ prNumber: 7, decision: "closed", reason: "because" })?.reason).toBeNull();
    // no reason → null
    expect(normalizePrOutcomePayload({ prNumber: 7, decision: "closed" })?.reason).toBeNull();
  });

  it("drops any reason on a merged decision (a merged PR has no rejection reason)", () => {
    const merged = normalizePrOutcomePayload({ prNumber: 9, decision: "merged", reason: "gate_close" });
    expect(merged).toEqual({ prNumber: 9, decision: "merged", closedAt: null, reason: null });
  });

  it("coerces a null / non-string / whitespace closedAt to null", () => {
    expect(normalizePrOutcomePayload({ prNumber: 1, decision: "merged", closedAt: null })?.closedAt).toBeNull();
    expect(normalizePrOutcomePayload({ prNumber: 1, decision: "merged", closedAt: 42 })?.closedAt).toBeNull();
    expect(normalizePrOutcomePayload({ prNumber: 1, decision: "merged", closedAt: "   " })?.closedAt).toBeNull();
  });
});

describe("recordPrOutcomeSnapshot (#4274)", () => {
  it("throws only when the injected ledger is unusable", () => {
    expect(() => recordPrOutcomeSnapshot({ repoFullName: "a/b", prNumber: 1, decision: "merged" }, {})).toThrow("invalid_event_ledger");
    expect(() => recordPrOutcomeSnapshot({ repoFullName: "a/b", prNumber: 1, decision: "merged" }, { eventLedger: {} } as never)).toThrow("invalid_event_ledger");
  });

  it("fail-soft returns null for a missing repo or a malformed payload, without appending", () => {
    const ledger = mockLedger();
    expect(recordPrOutcomeSnapshot({ prNumber: 1, decision: "merged" }, { eventLedger: ledger })).toBeNull();
    expect(recordPrOutcomeSnapshot({ repoFullName: "   ", prNumber: 1, decision: "merged" }, { eventLedger: ledger })).toBeNull();
    expect(recordPrOutcomeSnapshot({ repoFullName: "a/b", prNumber: 0, decision: "merged" }, { eventLedger: ledger })).toBeNull();
    expect(ledger._events).toHaveLength(0);
  });

  it("appends one repo-scoped pr_outcome event for a valid snapshot", () => {
    const ledger = mockLedger();
    const entry = recordPrOutcomeSnapshot({ repoFullName: "  acme/widgets  ", prNumber: 12, decision: "closed", reason: "superseded_by_duplicate", closedAt: "t" }, { eventLedger: ledger }) as Record<string, unknown>;
    expect(entry.type).toBe(MINER_PR_OUTCOME_EVENT);
    expect(entry.repoFullName).toBe("acme/widgets");
    expect(entry.payload).toEqual({ prNumber: 12, decision: "closed", closedAt: "t", reason: "superseded_by_duplicate" });
    expect(MINER_PR_OUTCOME_DECISIONS).toEqual(["merged", "closed"]);
  });
});

describe("readPrOutcomes (#4274)", () => {
  it("reduces the append-only stream to the latest outcome per repo/PR", () => {
    const ledger = mockLedger();
    recordPrOutcomeSnapshot({ repoFullName: "acme/widgets", prNumber: 1, decision: "closed", reason: "gate_close" }, { eventLedger: ledger });
    recordPrOutcomeSnapshot({ repoFullName: "acme/widgets", prNumber: 1, decision: "merged" }, { eventLedger: ledger }); // supersedes
    recordPrOutcomeSnapshot({ repoFullName: "acme/other", prNumber: 2, decision: "closed" }, { eventLedger: ledger });
    const latest = readPrOutcomes(ledger, { repoFullName: "acme/widgets" });
    expect(latest.get("acme/widgets:1")).toEqual({ repoFullName: "acme/widgets", prNumber: 1, decision: "merged", closedAt: null, reason: null });
    expect(latest.has("acme/other:2")).toBe(false); // filtered out by the repo filter
  });

  it("skips foreign event types, missing repos, and malformed payloads; empty when the ledger can't read", () => {
    const ledger = mockLedger();
    ledger._events.push(
      { type: "manage_pr_update", repoFullName: "acme/widgets", payload: { prNumber: 1 } }, // foreign type
      { type: MINER_PR_OUTCOME_EVENT, repoFullName: "   ", payload: { prNumber: 1, decision: "merged" } }, // blank repo
      { type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 0, decision: "merged" } }, // bad payload
      { type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 5, decision: "merged" } }, // kept
    );
    expect([...readPrOutcomes(ledger).keys()]).toEqual(["acme/widgets:5"]);
    // a ledger without readEvents, and one whose readEvents returns a non-array, both reduce to an empty map
    expect(readPrOutcomes({} as never).size).toBe(0);
    expect(readPrOutcomes({ readEvents: () => null } as never).size).toBe(0);
  });

  it("skips non-object events in the stream without throwing (#7313 TypeScript conversion)", () => {
    const ledger = mockLedger();
    ledger._events.push(
      null as never,
      "noise" as never,
      42 as never,
      { type: MINER_PR_OUTCOME_EVENT, repoFullName: "acme/widgets", payload: { prNumber: 8, decision: "merged" } },
    );
    expect([...readPrOutcomes(ledger).keys()]).toEqual(["acme/widgets:8"]);
  });
});

describe("AMS badge notify from recordPrOutcomeSnapshot (#7657)", () => {
  it("schedules one pr-outcome notification after a successful ledger write when a recipient is known", () => {
    const ledger = mockLedger();
    const scheduleSpy = vi.fn();
    const entry = recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 9, decision: "merged", closedAt: "2026-07-22T08:00:00Z" },
      { eventLedger: ledger, recipientLogin: " Miner1 ", env: { SOME_ENV: "x" }, scheduleAmsNotifications: scheduleSpy },
    );
    expect(entry).not.toBeNull();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const [events, options] = scheduleSpy.mock.calls[0]!;
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "ams_pr_outcome",
        recipientLogin: "miner1",
        repoFullName: "acme/widgets",
        pullNumber: 9,
        dedupKey: "ams_pr_outcome:merged:acme/widgets#9:2026-07-22T08:00:00Z",
      }),
    ]);
    expect(options).toEqual({ env: { SOME_ENV: "x" } });
  });

  it("skips the notification when no recipient (or a whitespace one) is given — the ledger write still happens", () => {
    const ledger = mockLedger();
    const scheduleSpy = vi.fn();
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 9, decision: "closed", closedAt: "2026-07-22T08:00:00Z" },
      { eventLedger: ledger, scheduleAmsNotifications: scheduleSpy },
    );
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 10, decision: "closed", closedAt: "2026-07-22T08:00:00Z" },
      { eventLedger: ledger, recipientLogin: "   ", scheduleAmsNotifications: scheduleSpy },
    );
    expect(ledger._events).toHaveLength(2);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("never notifies for a snapshot the normalizer rejected (nothing was recorded)", () => {
    const ledger = mockLedger();
    const scheduleSpy = vi.fn();
    const entry = recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 0, decision: "merged" },
      { eventLedger: ledger, recipientLogin: "miner1", scheduleAmsNotifications: scheduleSpy },
    );
    expect(entry).toBeNull();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("falls back to the real fire-and-forget scheduler (a session-less no-op here) when none is injected", () => {
    const ledger = mockLedger();
    // No scheduleAmsNotifications injected → the real scheduleAmsNotificationEvents runs. The env points at
    // an empty config dir, so the underlying publish resolves no_session and never touches the network.
    const entry = recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 9, decision: "merged", closedAt: "2026-07-22T08:00:00Z" },
      { eventLedger: ledger, recipientLogin: "miner1", env: { LOOPOVER_CONFIG_DIR: "/nonexistent-loopover-config" } },
    );
    expect(entry).not.toBeNull();
    expect(ledger._events).toHaveLength(1);
  });

  it("defaults env to process.env in the scheduled options when none is injected", () => {
    const ledger = mockLedger();
    const scheduleSpy = vi.fn();
    recordPrOutcomeSnapshot(
      { repoFullName: "acme/widgets", prNumber: 9, decision: "merged", closedAt: "2026-07-22T08:00:00Z" },
      { eventLedger: ledger, recipientLogin: "miner1", scheduleAmsNotifications: scheduleSpy },
    );
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy.mock.calls[0]![1]).toEqual({ env: process.env });
  });
});
