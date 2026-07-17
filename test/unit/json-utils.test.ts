import { describe, expect, it } from "vitest";
import { errorMessage, errorStack, jsonString, normalizeRepoFullName, nowIso, parseJson, repoParts, strippedErrorMessage } from "../../src/utils/json";

describe("JSON and string utility helpers", () => {
  it("keeps JSON parsing and stringification fallbacks explicit", () => {
    expect(parseJson<{ ok: boolean }>('{"ok":true}', { ok: false })).toEqual({ ok: true });
    expect(parseJson("{bad-json", { ok: false })).toEqual({ ok: false });
    expect(parseJson(null, { ok: false })).toEqual({ ok: false });
    expect(parseJson("", { ok: false })).toEqual({ ok: false });
    expect(parseJson(undefined, { ok: false })).toEqual({ ok: false });
    expect(jsonString(undefined)).toBe("null");
    expect(jsonString({ ok: true })).toBe('{"ok":true}');
  });

  it("emits ISO timestamps and empty error fallbacks", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(errorMessage(new Error(""))).toBe("unknown error");
  });

  it("normalizes repo names and error messages without leaking arbitrary thrown values", () => {
    expect(normalizeRepoFullName(" JSONbored/loopover ")).toBe("JSONbored/loopover");
    expect(repoParts("JSONbored/loopover")).toEqual({ owner: "JSONbored", name: "loopover" });
    expect(repoParts("")).toEqual({ owner: "", name: "" });
    expect(repoParts("owner/nested/name")).toEqual({ owner: "owner", name: "nested/name" });

    expect(errorMessage(new Error("specific failure"))).toBe("specific failure");
    expect(errorMessage("string failure", "fallback failure")).toBe("fallback failure");
    expect(strippedErrorMessage(new Error("Error: wrapped failure"), "fallback failure")).toBe("wrapped failure");
    expect(strippedErrorMessage("string failure", "fallback failure")).toBe("fallback failure");
  });

  it("errorStack extracts a real Error's stack, truncated, and returns undefined for anything else (#5010-observability)", () => {
    const err = new Error("boom");
    expect(errorStack(err)).toBe(err.stack?.slice(0, 500));
    expect(errorStack(err, 5)).toBe(err.stack?.slice(0, 5));
    expect(errorStack("string failure")).toBeUndefined();
    expect(errorStack(null)).toBeUndefined();
    expect(errorStack(undefined)).toBeUndefined();
    const noStack = new Error("no stack");
    (noStack as { stack?: string | undefined }).stack = undefined;
    expect(errorStack(noStack)).toBeUndefined();
  });

  it("repoParts trims outer whitespace before splitting, matching normalizeRepoFullName", () => {
    expect(repoParts(" JSONbored/loopover ")).toEqual({ owner: "JSONbored", name: "loopover" });
    expect(repoParts("  owner/nested/name  ")).toEqual({ owner: "owner", name: "nested/name" });
    expect(repoParts("   ")).toEqual({ owner: "", name: "" });
    expect(repoParts("\towner/repo\n")).toEqual({ owner: "owner", name: "repo" });
  });
});
