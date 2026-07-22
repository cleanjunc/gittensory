import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { listNotificationDeliveriesForRecipient } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #7657: POST /v1/contributors/:login/ams-notifications — the AMS miner's ingest for its own notification
// events. These pin the route contract: the requireContributorAccess guard, the zod body gate, the
// normalize re-stamp (recipient/actor forced to the path login), and that accepted events run through the
// SAME evaluateNotificationEvent → notify-deliver handoff as webhook kinds (deliveries + queued jobs).

const jsonHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

function amsEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    eventType: "ams_attempt_started",
    repoFullName: "acme/widgets",
    pullNumber: 41,
    dedupKey: "ams_attempt_started:acme/widgets#41:attempt-9",
    deeplink: "https://github.com/acme/widgets/issues/41",
    detectedAt: "2026-07-22T10:00:00.000Z",
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, env: Env, body: unknown, login = "miner1") {
  return app.request(
    `/v1/contributors/${login}/ams-notifications`,
    { method: "POST", headers: jsonHeaders(env), body: JSON.stringify(body) },
    env,
  );
}

describe("POST /v1/contributors/:login/ams-notifications (#7657)", () => {
  it("accepts AMS events, creates pending badge deliveries, and enqueues one notify-deliver per delivery", async () => {
    const app = createApp();
    const sent: Array<Record<string, unknown>> = [];
    const env = createTestEnv({
      JOBS: { send: async (message: Record<string, unknown>) => void sent.push(message) } as unknown as Queue,
    });

    const response = await post(app, env, {
      events: [amsEvent(), amsEvent({ eventType: "ams_pr_outcome", dedupKey: "ams_pr_outcome:merged:acme/widgets#9:t", pullNumber: 9 })],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ login: "miner1", accepted: 2, enqueued: 2 });

    const rows = await listNotificationDeliveriesForRecipient(env, "miner1");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.recipientLogin).toBe("miner1");
      expect(row.status).toBe("pending");
    }
    expect(sent).toHaveLength(2);
    for (const message of sent) expect(message).toMatchObject({ type: "notify-deliver", requestedBy: "notify-evaluate" });
  });

  it("re-stamps recipient and actor from the path login even when the payload claims someone else", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await post(app, env, { events: [amsEvent({ actorLogin: "mallory" })] }, "Miner1");
    expect(response.status).toBe(200);
    const rows = await listNotificationDeliveriesForRecipient(env, "miner1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorLogin).toBe("miner1");
    expect(rows[0]!.recipientLogin).toBe("miner1");
  });

  it("is idempotent on a redelivered batch (dedupKey), reporting zero newly-enqueued deliveries", async () => {
    const app = createApp();
    const env = createTestEnv();
    await post(app, env, { events: [amsEvent()] });
    const again = await post(app, env, { events: [amsEvent()] });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ login: "miner1", accepted: 1, enqueued: 0 });
    expect(await listNotificationDeliveriesForRecipient(env, "miner1")).toHaveLength(1);
  });

  it("400s a malformed body: not JSON, empty batch, unknown eventType, oversized batch", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const body of ["not json", { events: [] }, { events: [amsEvent({ eventType: "pull_request_merged" })] }]) {
      const response = await app.request(
        "/v1/contributors/miner1/ams-notifications",
        { method: "POST", headers: jsonHeaders(env), body: typeof body === "string" ? body : JSON.stringify(body) },
        env,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_ams_notifications" });
    }
    const oversized = await post(app, env, { events: Array.from({ length: 21 }, (_, index) => amsEvent({ pullNumber: index })) });
    expect(oversized.status).toBe(400);
  });

  it("400s no_valid_events when every event passes zod but fails normalize (whitespace-only repoFullName)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await post(app, env, { events: [amsEvent({ repoFullName: "  " })] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_ams_notifications", detail: "no_valid_events" });
    expect(await listNotificationDeliveriesForRecipient(env, "miner1")).toHaveLength(0);
  });

  it("accepts the miner's OWN session — the real loopover-mcp session posture the miner-side client uses", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { createSessionForGitHubUser } = await import("../../src/auth/security");
    const session = await createSessionForGitHubUser(env, { login: "Miner1", id: 42 });
    const response = await app.request(
      "/v1/contributors/miner1/ams-notifications",
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [amsEvent()] }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ login: "miner1", accepted: 1, enqueued: 1 });
  });

  it("403s a session for a different login — the ingest is strictly self-scoped", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { createSessionForGitHubUser } = await import("../../src/auth/security");
    const session = await createSessionForGitHubUser(env, { login: "someone-else", id: 77 });
    const response = await app.request(
      "/v1/contributors/miner1/ams-notifications",
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [amsEvent()] }),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });

  it("403s the shared mcp token unless fully unscoped (#2455 parity with the other contributor surfaces)", async () => {
    const app = createApp();
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" });
    const response = await app.request(
      "/v1/contributors/miner1/ams-notifications",
      { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ events: [amsEvent()] }) },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_contributor" });
  });
});
