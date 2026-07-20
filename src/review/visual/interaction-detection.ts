// Automatic hover-interaction detection from CSS diffs (#auto-interaction-detection). PURE, no DB/network —
// mirrors visual-findings.ts's own "pure decision logic only" convention. The whole point of
// review.visual.interactions (capture.ts / shot.ts) was originally a maintainer hand-authoring CSS selectors
// ahead of time; that still exists for a maintainer-curated demonstration, but requires foreknowledge of
// what's interactive and worth showing. This module is the zero-configuration alternative: read the PR's own
// diff for a newly ADDED `:hover`/`:focus-visible` CSS rule and capture ITS selector automatically — no
// maintainer selector-authoring step at all. Scoped to plain CSS/SCSS/SASS/LESS stylesheets (the only case a
// selector is syntactically explicit in the diff text); a Tailwind utility class or CSS-in-JS `:hover` state
// has no equivalent selector to extract this way and is out of scope here.

/** One changed file's path + unified-diff patch text — the same `file.payload?.patch` shape every other
 *  diff-reading module in this codebase already uses (review-diff.ts, grounding-wire.ts, ...). `patch`
 *  absent (a binary file, or a diff GitHub didn't include) ⇒ that file contributes no selectors. */
export type ChangedCssFile = { path: string; patch?: string | undefined };

const CSS_FILE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];

// Mirrors capture.ts's MAX_INTERACTIONS reasoning: bounds how many auto-detected selectors this module ever
// returns, independent of how many `:hover`/`:focus-visible` rules a large stylesheet diff actually touches.
const MAX_AUTO_DETECTED_INTERACTIONS = 3;
// A selector this long is either a hostile/malformed diff line or a compound rule not worth interacting with
// (e.g. an entire multi-selector block) — mirrors focus-manifest.ts's MAX_ITEM_LENGTH-style bound.
const MAX_SELECTOR_LENGTH = 300;

// Matches a unified-diff ADDED line (`+`-prefixed, not the `+++` file-header line) whose CSS rule selector
// ends in `:hover` or `:focus-visible`, immediately followed by optional whitespace and the rule's opening
// `{`. Capturing only ADDED lines is deliberate: an EXISTING :hover rule this PR never touched says nothing
// about what changed, and would fire this feature on every single PR that merely touches a stylesheet.
const HOVER_SELECTOR_LINE_PATTERN = /^\+(?!\+\+)\s*([^{}\n]+?):(?:hover|focus-visible)\s*\{/;

function isCssFile(path: string): boolean {
  const lower = path.toLowerCase();
  return CSS_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The regex's own capture group spans from the line start to the LAST `:hover`/`:focus-visible` it found
 *  (non-greedy backtracking) — for a comma-separated selector LIST (`.a:hover, .b:hover { ... }`), that
 *  swallows every earlier selector's OWN `:hover` mid-string too (`.a:hover, .b`), not just `.b`. Since the
 *  match only anchors on the FINAL `:hover`/`:focus-visible` in the list, the text after the last comma is
 *  always the one real selector that rule actually matched against — take that, discarding the earlier
 *  list entries this capture can't cleanly separate rather than returning a mangled, unusable string. */
function lastSelectorInList(capturedGroup: string): string {
  const lastCommaIndex = capturedGroup.lastIndexOf(",");
  return (lastCommaIndex === -1 ? capturedGroup : capturedGroup.slice(lastCommaIndex + 1)).trim();
}

/**
 * Detect newly-added `:hover`/`:focus-visible` CSS selectors across `files`' diff patches, capped at
 * {@link MAX_AUTO_DETECTED_INTERACTIONS} and deduped case-insensitively. Selectors are returned in
 * first-seen order (the order their files appear in `files`, then line order within each patch) — the
 * caller decides what page/theme to capture them against. An unparseable/absent patch, a non-CSS file, or a
 * selector exceeding {@link MAX_SELECTOR_LENGTH} contributes nothing; this NEVER throws.
 */
export function detectAutoHoverInteractions(files: readonly ChangedCssFile[]): string[] {
  const selectors: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (selectors.length >= MAX_AUTO_DETECTED_INTERACTIONS) break;
    if (!isCssFile(file.path) || !file.patch) continue;
    for (const line of file.patch.split("\n")) {
      if (selectors.length >= MAX_AUTO_DETECTED_INTERACTIONS) break;
      const match = HOVER_SELECTOR_LINE_PATTERN.exec(line);
      if (!match) continue;
      const selector = lastSelectorInList(match[1]!);
      if (!selector || selector.length > MAX_SELECTOR_LENGTH) continue;
      const key = selector.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selectors.push(selector);
    }
  }
  return selectors;
}
