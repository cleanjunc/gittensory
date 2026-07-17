import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { persistRepoGithubTotalsSnapshot, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createCloudTestEnv, createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "registration-readiness-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("loopover_get_registration_readiness MCP tool (#5824)", () => {
  it("returns ready:true for a registered repo with clean config and a healthy queue", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/ready-repo": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false, maintainer_cut: 0 },
        },
        { kind: "raw-github", url: "fixture://registration-readiness-ready" },
        "2026-05-26T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "ready-repo", full_name: "owner/ready-repo", private: false, owner: { login: "owner" }, default_branch: "main" });

    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_registration_readiness", arguments: { owner: "owner", repo: "ready-repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: "owner/ready-repo",
      ready: true,
      recommendedRegistrationMode: "direct_pr",
      blockers: [],
    });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/ready \(preview-only, not a registration action\)/i) })]);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("returns ready:false with the outstanding blockers for a registered repo in bad shape", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "owner/gap-repo": { emission_share: 0, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: true, maintainer_cut: 0 },
        },
        { kind: "raw-github", url: "fixture://registration-readiness-gap" },
        "2026-05-26T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "gap-repo", full_name: "owner/gap-repo", private: false, owner: { login: "owner" }, default_branch: "main" });
    await persistRepoGithubTotalsSnapshot(env, {
      id: "gap-repo-totals",
      repoFullName: "owner/gap-repo",
      openIssuesTotal: 500,
      openPullRequestsTotal: 300,
      mergedPullRequestsTotal: 0,
      closedUnmergedPullRequestsTotal: 0,
      labelsTotal: 0,
      sourceKind: "github",
      fetchedAt: "2026-05-26T00:00:00.000Z",
      payload: {},
    });

    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_registration_readiness", arguments: { owner: "owner", repo: "gap-repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: "owner/gap-repo",
      ready: false,
      blockers: expect.arrayContaining(["Repository config quality is fragile.", "Contributor intake health is blocked."]),
    });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/not ready — 2 blocker\(s\)/i) })]);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("returns ready:false with a not-registered blocker for a repo LoopOver has never seen", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_registration_readiness", arguments: { owner: "unknown-owner", repo: "unknown-repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: "unknown-owner/unknown-repo",
      ready: false,
      recommendedRegistrationMode: "direct_pr",
      blockers: expect.arrayContaining(["Repository is not registered in the latest LoopOver registry snapshot."]),
    });
  });

  it("forbids a session that cannot access the repository", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertRepositoryFromGitHub(env, { name: "private-repo", full_name: "victim-org/private-repo", private: false, owner: { login: "victim-org" } });
    const { session } = await createSessionForGitHubUser(env, { login: "someone-else", id: 999 });
    const client = await connect(env, { kind: "session", actor: "someone-else", session });
    const result = await client.callTool({ name: "loopover_get_registration_readiness", arguments: { owner: "victim-org", repo: "private-repo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
