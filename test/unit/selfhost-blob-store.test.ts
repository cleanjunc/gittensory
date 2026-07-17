import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsBlobStore } from "../../src/selfhost/blob-store";

describe("createFsBlobStore (#10 — self-host visual screenshot persistence)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gitt-blob-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a PNG: put then get streams the same bytes back (parent dirs created)", async () => {
    const store = createFsBlobStore(dir);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await store.put("loopover/shots/abc.png", png);
    const obj = await store.get("loopover/shots/abc.png");
    expect(obj).not.toBeNull();
    expect(Array.from(new Uint8Array(await new Response(obj!.body).arrayBuffer()))).toEqual(Array.from(png));
  });

  it("returns null on a miss", async () => {
    expect(await createFsBlobStore(dir).get("loopover/shots/missing.png")).toBeNull();
  });

  it("accepts a string value too (any R2 put body type)", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/s.png", "hello");
    expect(await new Response((await store.get("loopover/shots/s.png"))!.body).text()).toBe("hello");
  });

  it("accepts a null value (stores an empty object), satisfying the R2 put body type", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/empty.png", null);
    expect((await new Response((await store.get("loopover/shots/empty.png"))!.body).arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects a key that escapes the base dir — put throws, get is a safe miss (no traversal)", async () => {
    const store = createFsBlobStore(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(store.put("../escape.png", new Uint8Array([1]))).rejects.toThrow(/escapes base dir/);
      expect(await store.get("../../etc/passwd")).toBeNull(); // the pathFor throw is caught inside get → safe miss
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a path-traversal get distinctly from an ordinary miss (#6283)", async () => {
    const store = createFsBlobStore(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await store.get("loopover/shots/missing.png")).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      expect(await store.get("../../etc/passwd")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(warn.mock.calls[0]?.[0]));
      expect(payload).toMatchObject({
        level: "warn",
        event: "selfhost_blob_key_escapes_base_dir",
        key: "../../etc/passwd",
        message: expect.stringMatching(/escapes base dir/i),
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("delete removes a stored object — a subsequent get is a miss", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/gone.png", new Uint8Array([1, 2, 3]));
    expect(await store.get("loopover/shots/gone.png")).not.toBeNull();
    await store.delete("loopover/shots/gone.png");
    expect(await store.get("loopover/shots/gone.png")).toBeNull();
  });

  it("delete on a key that was never written does not throw (idempotent, matches R2)", async () => {
    await expect(createFsBlobStore(dir).delete("loopover/shots/never-existed.png")).resolves.toBeUndefined();
  });
});
