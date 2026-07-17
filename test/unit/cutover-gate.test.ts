import { describe, expect, it } from "vitest";
import { isConvergenceRepoAllowed, listConvergenceRepos } from "../../src/review/cutover-gate";

describe("listConvergenceRepos — the configured repo set (for proactive RAG indexing)", () => {
  it("parses, trims, and drops empty entries", () => {
    expect(listConvergenceRepos({ LOOPOVER_REVIEW_REPOS: " JSONbored/loopover , JSONbored/metagraphed ,, " })).toEqual(["JSONbored/loopover", "JSONbored/metagraphed"]);
  });
  it("returns [] when unset or empty", () => {
    expect(listConvergenceRepos({})).toEqual([]);
    expect(listConvergenceRepos({ LOOPOVER_REVIEW_REPOS: "" })).toEqual([]);
    expect(listConvergenceRepos({ LOOPOVER_REVIEW_REPOS: " , ,, " })).toEqual([]);
  });
  it("dedupes case-insensitively, preserving the first occurrence's original case", () => {
    expect(listConvergenceRepos({ LOOPOVER_REVIEW_REPOS: "JSONbored/Loopover, jsonbored/loopover, JSONbored/metagraphed" })).toEqual(["JSONbored/Loopover", "JSONbored/metagraphed"]);
  });
});

describe("isConvergenceRepoAllowed — per-repo review allowlist", () => {
  it("empty / unset / whitespace-only allowlist → false for every repo (the dormant default)", () => {
    expect(isConvergenceRepoAllowed({}, "JSONbored/loopover")).toBe(false);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: undefined }, "JSONbored/loopover")).toBe(false);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "" }, "JSONbored/loopover")).toBe(false);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "   " }, "JSONbored/loopover")).toBe(false);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: " , ,, " }, "JSONbored/loopover")).toBe(false);
  });

  it("activates a listed repo (exact owner/repo match)", () => {
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "JSONbored/loopover" }, "JSONbored/loopover")).toBe(true);
  });

  it("does NOT activate an unlisted repo", () => {
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "JSONbored/loopover" }, "JSONbored/awesome-claude")).toBe(false);
  });

  it("is case-insensitive (GitHub repo full-names are case-insensitive)", () => {
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "JSONbored/Loopover" }, "jsonbored/loopover")).toBe(true);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "jsonbored/loopover" }, "JSONbored/LOOPOVER")).toBe(true);
  });

  it("handles a multi-repo list with surrounding whitespace + stray commas", () => {
    const env = { LOOPOVER_REVIEW_REPOS: " JSONbored/loopover , JSONbored/awesome-claude ,, " };
    expect(isConvergenceRepoAllowed(env, "JSONbored/loopover")).toBe(true);
    expect(isConvergenceRepoAllowed(env, "JSONbored/awesome-claude")).toBe(true);
    expect(isConvergenceRepoAllowed(env, "JSONbored/metagraphed")).toBe(false);
  });

  it("an empty / whitespace `repoFullName` never matches", () => {
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "JSONbored/loopover" }, "")).toBe(false);
    expect(isConvergenceRepoAllowed({ LOOPOVER_REVIEW_REPOS: "JSONbored/loopover" }, "   ")).toBe(false);
  });

  it("requires a FULL owner/repo match (a bare owner or partial does not match)", () => {
    const env = { LOOPOVER_REVIEW_REPOS: "JSONbored/loopover" };
    expect(isConvergenceRepoAllowed(env, "JSONbored")).toBe(false);
    expect(isConvergenceRepoAllowed(env, "loopover")).toBe(false);
    expect(isConvergenceRepoAllowed(env, "JSONbored/loopover-ui")).toBe(false);
  });
});
