// content-repo-spec, extracted to @loopover/engine (#4880). Thin re-export shim; the implementation lives at
// packages/loopover-engine/src/review/content-lane/content-repo-spec.ts (imported via relative source path, not
// the published package, to match this repo's existing engine-consumption convention — see
// src/signals/check-summary.ts).
export * from "../../../packages/loopover-engine/src/review/content-lane/content-repo-spec";
