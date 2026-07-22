import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDefaultGovernorState, openGovernorState } from "../../packages/loopover-miner/lib/governor-state.js";
import {
  parseGovernorPauseArgs,
  parseGovernorResumeArgs,
  runGovernorPause,
  runGovernorResume,
  runGovernorStatus,
} from "../../packages/loopover-miner/lib/governor-pause-cli.js";

const roots: string[] = [];
const states: Array<{ close(): void }> = [];

function tempGovernorState() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-cli-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  closeDefaultGovernorState();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseGovernorPauseArgs (#4851)", () => {
  it("defaults to no reason and non-JSON output", () => {
    expect(parseGovernorPauseArgs([])).toEqual({ json: false, dryRun: false, reason: null });
  });

  it("parses --reason, --dry-run, and --json together", () => {
    expect(parseGovernorPauseArgs(["--reason", "investigating a bad PR", "--dry-run", "--json"])).toEqual({
      json: true,
      dryRun: true,
      reason: "investigating a bad PR",
    });
  });

  it("rejects a --reason flag missing its value", () => {
    expect(parseGovernorPauseArgs(["--reason"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor pause"),
    });
    expect(parseGovernorPauseArgs(["--reason", "--json"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor pause"),
    });
  });

  it("rejects an unknown option", () => {
    expect(parseGovernorPauseArgs(["--verbose"])).toEqual({ error: "Unknown option: --verbose" });
  });
});

describe("parseGovernorResumeArgs (#4847)", () => {
  it("defaults to non-dry-run, non-JSON output", () => {
    expect(parseGovernorResumeArgs([])).toEqual({ json: false, dryRun: false });
  });

  it("parses --dry-run and --json together", () => {
    expect(parseGovernorResumeArgs(["--dry-run", "--json"])).toEqual({ json: true, dryRun: true });
  });

  it("rejects an unrecognized token", () => {
    expect(parseGovernorResumeArgs(["extra"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor resume"),
    });
  });
});

describe("loopover-miner governor pause/resume/status CLI (#4851)", () => {
  it("pauses with a reason, then resumes, using an injected governor state", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorPause(["--reason", "operator requested", "--json"], {
        openGovernorState: () => governorState,
      }),
    ).toBe(0);
    const paused = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(paused).toMatchObject({ paused: true, reason: "operator requested" });
    expect(governorState.loadPauseState()).toMatchObject({ paused: true, reason: "operator requested" });

    log.mockClear();
    expect(await runGovernorResume([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe("governor is not paused");
    expect(governorState.loadPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });

  it("pauses with no reason and renders the plain-text form", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorPause([], { openGovernorState: () => governorState })).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("governor is PAUSED since");
    expect(text).not.toContain("(");
  });

  it("status reports the current pause state without mutating it", async () => {
    const governorState = tempGovernorState();
    governorState.savePauseState({ paused: true, reason: "halting for review" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorStatus(["--json"], { openGovernorState: () => governorState })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      paused: true,
      reason: "halting for review",
    });
    expect(governorState.loadPauseState()).toMatchObject({ paused: true, reason: "halting for review" });
  });

  it("resume and status reject stray positional arguments", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorResume(["extra"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: loopover-miner governor resume");

    error.mockClear();
    expect(await runGovernorStatus(["extra"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: loopover-miner governor status");
  });

  it("#4847: --dry-run reports what pause/resume would do and returns 0 without opening the governor state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openGovernorStateSpy = vi.fn();

    expect(
      await runGovernorPause(["--reason", "operator requested", "--dry-run", "--json"], {
        openGovernorState: openGovernorStateSpy,
      }),
    ).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      paused: true,
      reason: "operator requested",
    });

    log.mockClear();
    expect(await runGovernorPause(["--dry-run"], { openGovernorState: openGovernorStateSpy })).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toBe("DRY RUN: would pause the governor. No governor-state write was made.");

    log.mockClear();
    expect(
      await runGovernorPause(["--reason", "operator requested", "--dry-run"], {
        openGovernorState: openGovernorStateSpy,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe(
      "DRY RUN: would pause the governor (operator requested). No governor-state write was made.",
    );

    log.mockClear();
    expect(
      await runGovernorResume(["--dry-run", "--json"], { openGovernorState: openGovernorStateSpy }),
    ).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ outcome: "dry_run", paused: false });

    log.mockClear();
    expect(await runGovernorResume(["--dry-run"], { openGovernorState: openGovernorStateSpy })).toBe(0);
    expect(openGovernorStateSpy).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toBe("DRY RUN: would resume the governor. No governor-state write was made.");
  });

  it("rejects an unknown pause option before opening any store", async () => {
    const openGovernorStateFn = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorPause(["--verbose"], { openGovernorState: openGovernorStateFn })).toBe(2);
    expect(openGovernorStateFn).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  it("closes an owned (non-injected) governor state and surfaces a real open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const openGovernorStateFn = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(await runGovernorStatus([], { openGovernorState: openGovernorStateFn })).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("disk full");
  });

  it("runGovernorStatus prints plain text by default and surfaces a non-Error thrown failure", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorStatus([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toBe("governor is not paused");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorStatus([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("runGovernorPause surfaces both an Error and a non-Error thrown open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorPause([], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("disk full");

    error.mockClear();
    expect(
      await runGovernorPause([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("runGovernorResume surfaces both an Error and a non-Error thrown open failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorResume([], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("disk full");

    error.mockClear();
    expect(
      await runGovernorResume([], {
        openGovernorState: () => {
          throw "boom";
        },
      }),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("boom");
  });

  it("opens and closes the default on-disk governor state when no override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-cli-default-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = dbPath;
    try {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runGovernorPause(["--reason", "default path"])).toBe(0);

      const reopened = openGovernorState(dbPath);
      states.push(reopened);
      expect(reopened.loadPauseState()).toMatchObject({ paused: true, reason: "default path" });
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
      else process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = previousDbPath;
    }
  });
});

describe("governor pause/resume/status --json error contract (#5914)", () => {
  it("runGovernorPause emits the JSON envelope on a parse error and never opens the store", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const openGovernorStateFn = vi.fn();

    expect(await runGovernorPause(["--verbose", "--json"], { openGovernorState: openGovernorStateFn })).toBe(2);
    expect(openGovernorStateFn).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: false, error: "Unknown option: --verbose" });
  });

  it("runGovernorPause emits the JSON envelope when the governor state throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorPause(["--json"], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: false, error: "disk full" });
  });

  it("runGovernorResume emits the JSON envelope on a parse error rejected before --json is reached", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // `extra` aborts the parse before the parser ever sees --json, so the envelope can only come from
    // argsWantJson(args) reading raw argv -- parsed.json would be unavailable here.
    expect(await runGovernorResume(["extra", "--json"])).toBe(2);
    const envelope = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("Usage: loopover-miner governor resume");
  });

  it("runGovernorResume emits the JSON envelope when the governor state throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorResume(["--json"], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: false, error: "disk full" });
  });

  it("runGovernorStatus emits the JSON envelope on a parse error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorStatus(["extra", "--json"])).toBe(2);
    const envelope = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("Usage: loopover-miner governor status");
  });

  it("runGovernorStatus emits the JSON envelope when the governor state throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorStatus(["--json"], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ ok: false, error: "disk full" });
  });

  it("keeps non-JSON error paths on stderr as plain text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runGovernorPause(["--verbose"])).toBe(2);
    expect(await runGovernorResume(["extra"])).toBe(2);
    expect(await runGovernorStatus(["extra"])).toBe(2);
    expect(
      await runGovernorStatus([], {
        openGovernorState: () => {
          throw new Error("disk full");
        },
      }),
    ).toBe(2);

    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
      "Unknown option: --verbose",
      expect.stringContaining("Usage: loopover-miner governor resume"),
      expect.stringContaining("Usage: loopover-miner governor status"),
      "disk full",
    ]);
  });

  // #7307: cover the paused-with-reason and paused-without-reason render arms after JS→TS migrate.
  // Also flips CI `backend=true` (test/** change) so Build engine package runs before typecheck.
  it("renders paused status with and without a reason (#7307)", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runGovernorPause(["--reason", "ops freeze"], {
        openGovernorState: () => governorState,
      }),
    ).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/PAUSED since .* \(ops freeze\)/);

    log.mockClear();
    expect(await runGovernorPause([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/PAUSED since /);
    expect(String(log.mock.calls.at(-1)?.[0])).not.toContain("(");
  });
});

describe("AMS badge notify on governor pause (#7657)", () => {
  it("publishes a governor-paused notification stamped with the persisted pause state", async () => {
    const state = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn().mockResolvedValue({ sent: 1 });

    const exitCode = await runGovernorPause(["--reason", "investigating", "--json"], {
      openGovernorState: () => state,
      env: { SOME_ENV: "x" },
      fetchSessionLogin: async () => "Miner1",
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [events, options] = publishSpy.mock.calls[0]!;
    const persisted = state.loadPauseState();
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "ams_governor_paused",
        recipientLogin: "miner1",
        repoFullName: "ams/governor",
        pullNumber: 0,
        dedupKey: `ams_governor_paused:miner1:${persisted.pausedAt}:investigating`,
      }),
    ]);
    expect(options).toEqual({ env: { SOME_ENV: "x" } });
    // The pause itself still printed its normal JSON result.
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ paused: true, reason: "investigating" });
  });

  it("skips the notification when no session login resolves, without failing the pause", async () => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn();

    const exitCode = await runGovernorPause([], {
      openGovernorState: () => state,
      fetchSessionLogin: async () => null,
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(state.loadPauseState().paused).toBe(true);
  });

  it("swallows a thrown notify (rejecting fetchSessionLogin) — the persisted pause still succeeds", async () => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runGovernorPause([], {
      openGovernorState: () => state,
      fetchSessionLogin: async () => {
        throw new Error("session backend down");
      },
    });

    expect(exitCode).toBe(0);
    expect(state.loadPauseState().paused).toBe(true);
  });

  it("does not notify on --dry-run (nothing was persisted)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn();
    const fetchSessionLoginSpy = vi.fn();

    const exitCode = await runGovernorPause(["--dry-run"], {
      fetchSessionLogin: fetchSessionLoginSpy,
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(fetchSessionLoginSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("resolves the login from the on-disk session by default — no session dir means skip, publish untouched", async () => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn();
    const dir = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-nosession-"));
    roots.push(dir);

    const exitCode = await runGovernorPause([], {
      openGovernorState: () => state,
      env: { LOOPOVER_CONFIG_DIR: dir },
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("publishes through the real client on the default path (session GET + ingest POST both stubbed)", async () => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-realpublish-"));
    roots.push(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { default: { session: { token: "session-token-1" } } } }), { mode: 0o600 });
    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      if (url.endsWith("/v1/auth/session")) return Response.json({ status: "authenticated", login: "miner1" });
      return Response.json({ login: "miner1", accepted: 1, enqueued: 1 });
    });

    const exitCode = await runGovernorPause(["--reason", "maintenance"], {
      openGovernorState: () => state,
      env: { LOOPOVER_CONFIG_DIR: dir, LOOPOVER_API_URL: "https://api.example.test" },
    });

    expect(exitCode).toBe(0);
    expect(fetchCalls).toEqual([
      "https://api.example.test/v1/auth/session",
      "https://api.example.test/v1/contributors/miner1/ams-notifications",
    ]);
    vi.unstubAllGlobals();
  });

  it("fetches the session login from GET /v1/auth/session on the default path", async () => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn().mockResolvedValue({ sent: 1 });
    const dir = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-session-"));
    roots.push(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { default: { session: { token: "session-token-1" } } } }), { mode: 0o600 });
    const fetchCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchCalls.push(url);
      expect(init?.headers?.authorization).toBe("Bearer session-token-1");
      return Response.json({ status: "authenticated", login: "Miner1" });
    });

    const exitCode = await runGovernorPause([], {
      openGovernorState: () => state,
      env: { LOOPOVER_CONFIG_DIR: dir, LOOPOVER_API_URL: "https://api.example.test" },
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(fetchCalls).toEqual(["https://api.example.test/v1/auth/session"]);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]![0]).toEqual([expect.objectContaining({ recipientLogin: "miner1" })]);
    vi.unstubAllGlobals();
  });

  it.each([
    ["a non-OK session response", async () => new Response("nope", { status: 401 })],
    ["a non-JSON session body", async () => new Response("not json", { status: 200 })],
    ["a blank login", async () => Response.json({ login: "  " })],
    ["a non-string login", async () => Response.json({ login: 42 })],
    [
      "a thrown fetch",
      async () => {
        throw new Error("network down");
      },
    ],
  ])("skips the notification on %s from the default session lookup", async (_label, fetchImpl) => {
    const state = tempGovernorState();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const publishSpy = vi.fn();
    const dir = mkdtempSync(join(tmpdir(), "loopover-miner-governor-pause-badsession-"));
    roots.push(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { default: { session: { token: "session-token-1" } } } }), { mode: 0o600 });
    vi.stubGlobal("fetch", fetchImpl);

    const exitCode = await runGovernorPause([], {
      openGovernorState: () => state,
      env: { LOOPOVER_CONFIG_DIR: dir },
      publishAmsNotifications: publishSpy,
    });

    expect(exitCode).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(state.loadPauseState().paused).toBe(true);
    vi.unstubAllGlobals();
  });
});
