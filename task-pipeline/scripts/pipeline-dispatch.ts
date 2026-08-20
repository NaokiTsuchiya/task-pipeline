import type { FlagName } from "./state-dispatch.ts";
import type { NextAction, TakeoverReason, WaitReason } from "./state-next.ts";

export type DeferredKind =
  | "probe-run"
  | "fix-start"
  | "fix-ci-rerun"
  | "fix-give-up"
  | "rebase-start"
  | "release"
  | "retire"
  | "clear-takeover"
  | "set-takeover";

export type ClaimOperation = {
  readonly op: "claim";
  readonly verb: "claim";
  readonly flags: readonly FlagName[];
};

export type TakeoverOperation = {
  readonly op: "takeover";
  readonly verb: "set-executor";
  readonly flags: readonly FlagName[];
  readonly reason: TakeoverReason;
  readonly resume_phase: string;
  readonly recheck_gate: boolean;
  readonly needs_worktree: boolean;
  readonly replaces: string | null;
};

export type StatusCheckOperation = {
  readonly op: "status-check";
  readonly verb: "touch-executor";
  readonly flags: readonly FlagName[];
};

export type WaitOperation = {
  readonly op: "wait";
  readonly verb: null;
  readonly flags: readonly [];
  readonly reason: WaitReason;
};

export type DeferredOperation = {
  readonly op: "deferred";
  readonly kind: DeferredKind;
};

export type DriverOperation =
  | ClaimOperation
  | TakeoverOperation
  | StatusCheckOperation
  | WaitOperation
  | DeferredOperation;

export type NextActionKind = NextAction["kind"];

const ACTION_PLANNERS: {
  readonly [K in NextActionKind]: (
    action: Extract<NextAction, { kind: K }>,
  ) => DriverOperation;
} = {
  "claim": (_action) => ({
    op: "claim",
    verb: "claim",
    flags: ["state-dir", "id", "session"],
  }),
  "takeover": (action) => ({
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: action.reason,
    resume_phase: action.resume_phase,
    recheck_gate: action.recheck_gate,
    needs_worktree: action.needs_worktree,
    replaces: action.replaces,
  }),
  "status-check": (_action) => ({
    op: "status-check",
    verb: "touch-executor",
    flags: ["state-dir", "id", "session", "expect-executor"],
  }),
  "wait": (action) => ({
    op: "wait",
    verb: null,
    flags: [],
    reason: action.reason,
  }),
  "probe-run": (action) => ({ op: "deferred", kind: action.kind }),
  "fix-start": (action) => ({ op: "deferred", kind: action.kind }),
  "fix-ci-rerun": (action) => ({ op: "deferred", kind: action.kind }),
  "fix-give-up": (action) => ({ op: "deferred", kind: action.kind }),
  "rebase-start": (action) => ({ op: "deferred", kind: action.kind }),
  "release": (action) => ({ op: "deferred", kind: action.kind }),
  "retire": (action) => ({ op: "deferred", kind: action.kind }),
  "clear-takeover": (action) => ({ op: "deferred", kind: action.kind }),
  "set-takeover": (action) => ({ op: "deferred", kind: action.kind }),
};

export function planOperation(action: NextAction): DriverOperation {
  const planner = ACTION_PLANNERS[action.kind];
  return planner(action as never);
}
