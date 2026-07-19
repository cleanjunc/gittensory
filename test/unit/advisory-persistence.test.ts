import { describe, expect, it } from "vitest";
import { getLatestAdvisoryForPullRequest, persistAdvisory } from "../../src/db/repositories";
import type { Advisory, AdvisoryFinding } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const finding = (code: string, detail: string): AdvisoryFinding => ({
  code,
  title: `Finding: ${code}`,
  severity: "warning",
  detail,
});

const advisory = (overrides: Partial<Advisory> = {}): Advisory => ({
  id: crypto.randomUUID(),
  targetType: "pull_request",
  targetKey: "owner/repo#42",
  repoFullName: "owner/repo",
  pullNumber: 42,
  headSha: "sha1",
  conclusion: "neutral",
  severity: "warning",
  title: "LoopOver advisory available",
  summary: "1 advisory finding generated.",
  findings: [finding("visual_unrelated_issue_finding", "The footer logo is stretched.")],
  generatedAt: "2026-07-19T00:00:00.000Z",
  ...overrides,
});

describe("getLatestAdvisoryForPullRequest (#7372)", () => {
  it("returns null when no advisory has ever been persisted for this PR", async () => {
    const env = createTestEnv();
    expect(await getLatestAdvisoryForPullRequest(env, "owner/repo", 42)).toBeNull();
  });

  it("returns the findings + headSha of the persisted advisory", async () => {
    const env = createTestEnv();
    await persistAdvisory(env, advisory());
    const result = await getLatestAdvisoryForPullRequest(env, "owner/repo", 42);
    expect(result?.headSha).toBe("sha1");
    expect(result?.findings).toEqual([finding("visual_unrelated_issue_finding", "The footer logo is stretched.")]);
  });

  it("returns the MOST RECENTLY persisted row when multiple review passes each wrote their own append-only row", async () => {
    const env = createTestEnv();
    await persistAdvisory(env, advisory({ headSha: "sha1", findings: [finding("visual_unrelated_issue_finding", "First pass finding.")] }));
    await persistAdvisory(env, advisory({ headSha: "sha2", findings: [finding("visual_unrelated_issue_finding", "Second pass finding.")] }));
    const result = await getLatestAdvisoryForPullRequest(env, "owner/repo", 42);
    expect(result?.headSha).toBe("sha2");
    expect(result?.findings).toEqual([finding("visual_unrelated_issue_finding", "Second pass finding.")]);
  });

  it("scopes strictly to the requested repo + pull number, ignoring a sibling PR's advisory", async () => {
    const env = createTestEnv();
    await persistAdvisory(env, advisory({ pullNumber: 43, targetKey: "owner/repo#43", findings: [finding("visual_unrelated_issue_finding", "Sibling PR's finding.")] }));
    expect(await getLatestAdvisoryForPullRequest(env, "owner/repo", 42)).toBeNull();
  });

  it("scopes strictly to the requested repo, ignoring a same-numbered PR in a different repo", async () => {
    const env = createTestEnv();
    await persistAdvisory(env, advisory({ repoFullName: "other/repo", targetKey: "other/repo#42", findings: [finding("visual_unrelated_issue_finding", "Other repo's finding.")] }));
    expect(await getLatestAdvisoryForPullRequest(env, "owner/repo", 42)).toBeNull();
  });

  it("ignores an issue-targeted advisory sharing the same repo/number space", async () => {
    const env = createTestEnv();
    const { pullNumber: _pullNumber, ...withoutPullNumber } = advisory();
    await persistAdvisory(env, { ...withoutPullNumber, targetType: "issue", targetKey: "owner/repo#42", issueNumber: 42 });
    expect(await getLatestAdvisoryForPullRequest(env, "owner/repo", 42)).toBeNull();
  });

  it("returns [] (not the whole advisory's findings) when the latest pass recorded no findings at all", async () => {
    const env = createTestEnv();
    await persistAdvisory(env, advisory({ findings: [], conclusion: "success", summary: "No advisory findings." }));
    const result = await getLatestAdvisoryForPullRequest(env, "owner/repo", 42);
    expect(result?.findings).toEqual([]);
  });
});
