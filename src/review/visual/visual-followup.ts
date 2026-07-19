// PR-closed maintainer-notify follow-up comment (#7372, review.visual.bugAnalysisNotify) — PURE decision +
// message-shape logic ONLY, mirroring visual-findings.ts's own "no DB, no GitHub API" convention: a caller
// resolves the persisted advisory + repo owner + ADMIN_GITHUB_LOGINS, and posts the built comment itself.
//
// A `review.visual.bugAnalysis` finding with category "unrelated" (VISUAL_UNRELATED_ISSUE_FINDING_CODE) is
// advisory-only and easy to lose track of once the PR that surfaced it closes -- nothing about it is
// actionable, and nobody is notified once the PR itself is done. When a PR with at least one recorded
// unrelated finding is merged OR closed, this builds a STANDALONE follow-up comment (never folded into the
// unified sticky comment, which stops being useful once the PR is closed) that @-mentions a configurable
// maintainer list, describes each finding with its screenshot evidence, and is formatted so GitHub's own
// "..." -> "Reference in new issue" action can spin one off in a single click.

import type { AdvisoryFinding } from "../../types";
import { VISUAL_FOLLOWUP_COMMENT_MARKER } from "../../github/comments";
import { VISUAL_UNRELATED_ISSUE_FINDING_CODE } from "./visual-findings";

/** The subset of `findings` this follow-up comment cares about — `visual_unrelated_issue_finding` only. A
 *  `visual_regression_finding` is THIS PR's own fault and was already fully surfaced in the unified review
 *  comment while the PR was open; repeating it here after close would be redundant, not helpful. */
export function selectUnrelatedVisualFindings(findings: readonly AdvisoryFinding[]): AdvisoryFinding[] {
  return findings.filter((finding) => finding.code === VISUAL_UNRELATED_ISSUE_FINDING_CODE);
}

/** Resolve the GitHub logins to @-mention on the follow-up comment. A configured `review.visual.
 *  bugAnalysisNotify` list (global-default or per-repo, already parsed/lowercased/deduped by the manifest
 *  layer) always wins. Empty/absent — the manifest default, deliberately never a hardcoded username — falls
 *  back to this repo's owner plus the `ADMIN_GITHUB_LOGINS` fleet-operator allowlist, the SAME "maintainer"
 *  resolution `linked-issue-label-propagation-fetch.ts` already uses elsewhere in this codebase. */
export function resolveVisualFollowupNotifyLogins(configured: readonly string[], repoOwner: string, adminLogins: ReadonlySet<string>): string[] {
  if (configured.length > 0) return [...configured];
  const logins = new Set<string>(adminLogins);
  const owner = repoOwner.trim().toLowerCase();
  if (owner) logins.add(owner);
  return [...logins];
}

/** Build the standalone follow-up comment body, or null when there is nothing worth posting (no unrelated
 *  findings, or no login resolved to notify) — the caller must never post an empty/pointless comment. Each
 *  finding gets its own heading + description + a Before/After screenshot row (a dash when a side has no
 *  shot URL — a capture failure, not an error); multiple findings are separated by a rule. Plain markdown
 *  (not raw HTML) throughout, since `finding.detail`/`title` are already public-safe filtered text and GitHub
 *  natively renders `![alt](url)` — matches exactly what "Reference in new issue" quotes back into a draft. */
export function buildVisualFollowupComment(findings: readonly AdvisoryFinding[], notifyLogins: readonly string[]): string | null {
  const unrelated = selectUnrelatedVisualFindings(findings);
  if (unrelated.length === 0 || notifyLogins.length === 0) return null;
  const mentions = notifyLogins.map((login) => `@${login}`).join(" ");
  const sections = unrelated.map((finding) => {
    const lines = [`### ${finding.title}`, "", finding.detail];
    const evidence = finding.visualEvidence;
    if (evidence?.beforeUrl || evidence?.afterUrl) {
      lines.push(
        "",
        "| Before | After |",
        "| --- | --- |",
        `| ${evidence.beforeUrl ? `![before](${evidence.beforeUrl})` : "—"} | ${evidence.afterUrl ? `![after](${evidence.afterUrl})` : "—"} |`,
      );
    }
    return lines.join("\n");
  });
  return [
    `${mentions} — while reviewing this PR, LoopOver noticed the following visual issue(s) that don't look related to its stated change. Flagging these here now that the PR is closed, so they don't get lost.`,
    "",
    sections.join("\n\n---\n\n"),
    "",
    `Click the **⋯** menu above and choose **"Reference in new issue"** to track any of these separately.`,
    "",
    VISUAL_FOLLOWUP_COMMENT_MARKER,
  ].join("\n");
}
