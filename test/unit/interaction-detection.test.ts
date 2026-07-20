import { describe, expect, it } from "vitest";
import { detectAutoHoverInteractions } from "../../src/review/visual/interaction-detection";

describe("detectAutoHoverInteractions (#auto-interaction-detection)", () => {
  it("detects a newly-added :hover rule's selector from a .css file", () => {
    const patch = "@@ -1,3 +1,4 @@\n .foo {\n   color: red;\n }\n+.blocks-row:hover {\n+  background: blue;\n+}\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".blocks-row"]);
  });

  it("detects :focus-visible the same way as :hover", () => {
    const patch = "+button:focus-visible {\n+  outline: 2px solid blue;\n+}\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual(["button"]);
  });

  it("returns [] for a non-CSS file, even with an identical-looking patch", () => {
    const patch = "+.blocks-row:hover {\n+  background: blue;\n+}\n";
    expect(detectAutoHoverInteractions([{ path: "src/component.tsx", patch }])).toEqual([]);
  });

  it("returns [] when the file has no patch at all (binary file / GitHub omitted it)", () => {
    expect(detectAutoHoverInteractions([{ path: "src/styles.css" }])).toEqual([]);
  });

  it("ignores a REMOVED :hover rule (a '-'-prefixed line) — this PR didn't add it", () => {
    const patch = "-.old-hover:hover {\n-  color: red;\n-}\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([]);
  });

  it("ignores an unchanged context line (no +/- prefix)", () => {
    const patch = " .unchanged-hover:hover {\n   color: red;\n }\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([]);
  });

  it("does not mistake the '+++' unified-diff file-header line for an added line", () => {
    const patch = "+++ b/src/styles.css\n+.real-addition:hover {\n+  color: red;\n+}\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".real-addition"]);
  });

  it("dedupes the same selector seen twice, case-insensitively, keeping the first casing", () => {
    const patch = "+.Card:hover {\n+  color: red;\n+}\n+.card:hover {\n+  color: blue;\n+}\n";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".Card"]);
  });

  it("caps at 3 selectors even when a stylesheet diff adds more", () => {
    const patch = Array.from({ length: 5 }, (_, i) => `+.item-${i}:hover {\n+  color: red;\n+}`).join("\n");
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".item-0", ".item-1", ".item-2"]);
  });

  it("preserves file order, then line order within each file, up to the cap", () => {
    const files = [
      { path: "a.css", patch: "+.a:hover {\n+  color: red;\n+}" },
      { path: "b.css", patch: "+.b:hover {\n+  color: red;\n+}" },
    ];
    expect(detectAutoHoverInteractions(files)).toEqual([".a", ".b"]);
  });

  it("stops scanning FILES entirely (not just lines) once the cap is already reached by an earlier file", () => {
    const files = [
      { path: "a.css", patch: "+.a:hover {\n+  color: red;\n+}\n+.b:hover {\n+  color: red;\n+}\n+.c:hover {\n+  color: red;\n+}" },
      { path: "b.css", patch: "+.d:hover {\n+  color: red;\n+}" },
    ];
    expect(detectAutoHoverInteractions(files)).toEqual([".a", ".b", ".c"]);
  });

  it("drops a selector exceeding the length bound rather than including it", () => {
    const longSelector = `.${"x".repeat(400)}`;
    const patch = `+${longSelector}:hover {\n+  color: red;\n+}`;
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([]);
  });

  it("captures a compound selector chain (multiple classes/combinators) intact", () => {
    const patch = "+.nav-item > a.link:hover {\n+  color: red;\n+}";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".nav-item > a.link"]);
  });

  it("extracts only the LAST selector from a comma-separated hover rule, discarding the earlier ones cleanly", () => {
    const patch = "+.foo:hover, .bar:hover {\n+  color: red;\n+}";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".bar"]);
  });

  it("extracts the last selector from a THREE-entry comma-separated list", () => {
    const patch = "+.a:hover, .b:hover, .c:hover {\n+  color: red;\n+}";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".c"]);
  });

  it("recognizes .scss, .sass, and .less files the same way as .css", () => {
    for (const ext of [".scss", ".sass", ".less"]) {
      const patch = "+.hover-target:hover {\n+  color: red;\n+}";
      expect(detectAutoHoverInteractions([{ path: `src/styles${ext}`, patch }])).toEqual([".hover-target"]);
    }
  });

  it("is case-insensitive on the file extension itself", () => {
    const patch = "+.hover-target:hover {\n+  color: red;\n+}";
    expect(detectAutoHoverInteractions([{ path: "src/Styles.CSS", patch }])).toEqual([".hover-target"]);
  });

  it("matches an indented rule inside a nested block (e.g. a media query)", () => {
    const patch = "+@media (min-width: 768px) {\n+  .responsive-hover:hover {\n+    color: red;\n+  }\n+}";
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([".responsive-hover"]);
  });

  it("returns [] for an empty files list", () => {
    expect(detectAutoHoverInteractions([])).toEqual([]);
  });

  it("never throws on a patch with no matching rules at all", () => {
    const patch = "+.foo {\n+  color: red;\n+}\n-.bar {\n-  color: blue;\n-}";
    expect(() => detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).not.toThrow();
    expect(detectAutoHoverInteractions([{ path: "src/styles.css", patch }])).toEqual([]);
  });
});
