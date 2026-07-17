import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import {
  effectiveIssueCapForAccountAge,
  isBelowAccountAgeThreshold,
  repoOwnerLoginFromFullName,
} from "../../src/queue/account-age-throttle";

function generatePrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

describe("account-age throttle helpers (#2561 issue path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("repoOwnerLoginFromFullName returns the owner segment for owner/repo names", () => {
    expect(repoOwnerLoginFromFullName("JSONbored/loopover")).toBe("JSONbored");
  });

  it("repoOwnerLoginFromFullName returns empty for a no-slash repo name", () => {
    expect(repoOwnerLoginFromFullName("noslash")).toBe("");
  });

  it("effectiveIssueCapForAccountAge halves and rounds up for new accounts", () => {
    expect(effectiveIssueCapForAccountAge(4, true)).toBe(2);
    expect(effectiveIssueCapForAccountAge(5, true)).toBe(3);
    expect(effectiveIssueCapForAccountAge(1, true)).toBe(1);
  });

  it("effectiveIssueCapForAccountAge preserves the full cap for established accounts", () => {
    expect(effectiveIssueCapForAccountAge(4, false)).toBe(4);
  });

  it("isBelowAccountAgeThreshold returns false when the threshold is off", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    let fetched = false;
    vi.stubGlobal("fetch", async () => { fetched = true; return Response.json({}); });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", null)).toBe(false);
    expect(fetched).toBe(false);
  });

  it("isBelowAccountAgeThreshold fail-opens when created_at is unavailable", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/users/")) return new Response("missing", { status: 404 });
      return Response.json({});
    });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30)).toBe(false);
  });

  it("isBelowAccountAgeThreshold returns true for a below-threshold account", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.includes("/users/")) {
        return Response.json({ login: "newbie", created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
      }
      return Response.json({});
    });
    expect(await isBelowAccountAgeThreshold(env, 123, "newbie", 30)).toBe(true);
  });
});
