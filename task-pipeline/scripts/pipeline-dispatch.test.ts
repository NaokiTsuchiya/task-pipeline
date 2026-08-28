import { planOperation } from "./pipeline-dispatch.ts";
import {
  DEFAULT_NEXT_CONFIG,
  deriveNext,
  type NextAction,
  type NextInput,
  type NextResult,
  type NextTask,
} from "./state-next.ts";
import type {
  V2Artifact,
  V2Item,
  V2Run,
  V2State,
} from "./state-transitions-v2.ts";

function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

const SELF = "session-self";
const NOW = "2026-08-08T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function isoMinutesAgo(min: number): string {
  return new Date(NOW_MS - min * 60_000).toISOString();
}

const NONE_ARTIFACT: V2Artifact = { state: "none" };

function run(overrides: Partial<V2Run> = {}): V2Run {
  return {
    kind: "initial",
    gate: "full",
    phase: "implement",
    attempts: 0,
    executor: "agent-1",
    executor_last_event_at: isoMinutesAgo(1),
    takeover_at: null,
    verifier: null,
    verifier_session: null,
    ...overrides,
  };
}

function item(id: string, overrides: Partial<V2Item> = {}): V2Item {
  return {
    id,
    title: `title ${id}`,
    progress: "resting",
    run: null,
    blocked_reason: null,
    artifact: NONE_ARTIFACT,
    worktree: `/wt/${id}`,
    base: "main",
    session: SELF,
    ...overrides,
  };
}

function state(queue: V2Item[], overrides: Partial<V2State> = {}): V2State {
  return {
    tracker: "gh",
    source: "",
    updated_at: NOW,
    queue,
    candidates: [],
    relisted: [],
    promoted: [],
    completed: [],
    withdrawn_branches: [],
    cleanup_outbox: [],
    history: [],
    history_archived: 0,
    schema_version: 2,
    ...overrides,
  };
}

function input(overrides: Partial<NextInput> = {}): NextInput {
  return {
    session: SELF,
    alive: [SELF],
    now: NOW,
    config: DEFAULT_NEXT_CONFIG,
    tasksStarted: 0,
    deadEvidence: [],
    ...overrides,
  };
}

function taskOf(result: NextResult, id: string): NextTask {
  const found = result.tasks.find((t) => t.id === id);
  assert(found !== undefined, `task not found in result: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Unit tests: Target 4 kinds
// ---------------------------------------------------------------------------

Deno.test("dispatch: claim maps to claim verb and flags", () => {
  const action: NextAction = { kind: "claim" };
  const op = planOperation(action);
  assertEquals(op, {
    op: "claim",
    verb: "claim",
    flags: ["state-dir", "id", "session"],
  });
});

Deno.test("dispatch: takeover maps to set-executor with full payload", () => {
  const op1 = planOperation({
    kind: "takeover",
    reason: "takeover-elapsed",
    resume_phase: "implement",
    recheck_gate: false,
    needs_worktree: false,
    replaces: "agent-old",
  });
  assertEquals(op1, {
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: "takeover-elapsed",
    resume_phase: "implement",
    recheck_gate: false,
    needs_worktree: false,
    replaces: "agent-old",
  });

  const op2 = planOperation({
    kind: "takeover",
    reason: "no-executor",
    resume_phase: "research",
    recheck_gate: true,
    needs_worktree: true,
    replaces: null,
  });
  assertEquals(op2, {
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: "no-executor",
    resume_phase: "research",
    recheck_gate: true,
    needs_worktree: true,
    replaces: null,
  });

  const op3 = planOperation({
    kind: "takeover",
    reason: "strong-evidence",
    resume_phase: "report",
    recheck_gate: false,
    needs_worktree: false,
    replaces: "agent-orphaned",
  });
  assertEquals(op3, {
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: "strong-evidence",
    resume_phase: "report",
    recheck_gate: false,
    needs_worktree: false,
    replaces: "agent-orphaned",
  });
});

Deno.test("dispatch: status-check maps to touch-executor verb and flags", () => {
  const action: NextAction = { kind: "status-check" };
  const op = planOperation(action);
  assertEquals(op, {
    op: "status-check",
    verb: "touch-executor",
    flags: ["state-dir", "id", "session", "expect-executor"],
  });
});

Deno.test("dispatch: wait maps to null verb and preserves reason", () => {
  for (
    const reason of [
      "takeover-pending",
      "executor-alive",
      "own-slot-busy",
    ] as const
  ) {
    const action: NextAction = { kind: "wait", reason };
    const op = planOperation(action);
    assertEquals(op, {
      op: "wait",
      verb: null,
      flags: [],
      reason,
    });
  }
});

// ---------------------------------------------------------------------------
// Unit tests: Deferred 9 kinds
// ---------------------------------------------------------------------------

Deno.test("dispatch: 9 non-initial kinds map to deferred operation", () => {
  const actions: NextAction[] = [
    {
      kind: "probe-run",
      reason: "no-lease",
      catch_up: true,
      drop_foreign_proc: false,
    },
    {
      kind: "fix-start",
      findings: "/runs/x/findings.md",
      ids: ["c1"],
      fix_attempts: 1,
      at_limit: false,
      reset_attempts: false,
    },
    { kind: "fix-ci-rerun", tip: "abc123" },
    { kind: "fix-give-up", reason: "fix_stagnant" },
    {
      kind: "rebase-start",
      blocked_onto: "sha-base",
      from_tip: "sha-tip",
    },
    { kind: "release", reason: "finishing-busy", defer: "fix-start" },
    {
      kind: "retire",
      release_first: true,
      cleanup: { worktree: "/wt/1", branch: "b1" },
    },
    { kind: "clear-takeover" },
    { kind: "set-takeover", reason: "owner-dead-silent" },
  ];

  for (const action of actions) {
    const op = planOperation(action);
    assertEquals(op, {
      op: "deferred",
      kind: action.kind,
    });
  }
});

// ---------------------------------------------------------------------------
// Fixture integration tests (deriveNext -> planOperation)
// ---------------------------------------------------------------------------

Deno.test("dispatch/integration: queued task derives claim and plans claim operation", () => {
  const st = state([item("t-q", { progress: "queued", session: null })]);
  const result = deriveNext(st, input());
  const task = taskOf(result, "t-q");
  assert(task.actions.length === 1);
  assertEquals(task.actions[0].kind, "claim");

  const op = planOperation(task.actions[0]);
  assertEquals(op, {
    op: "claim",
    verb: "claim",
    flags: ["state-dir", "id", "session"],
  });
});

Deno.test("dispatch/integration: silent executor derives status-check and plans touch-executor operation", () => {
  const st = state([
    item("t-silent", {
      progress: "running",
      run: run({
        executor: "agent-silent",
        executor_last_event_at: isoMinutesAgo(91),
        takeover_at: null,
      }),
    }),
  ]);
  const result = deriveNext(st, input());
  const task = taskOf(result, "t-silent");
  assert(task.actions.length === 1);
  assertEquals(task.actions[0].kind, "status-check");

  const op = planOperation(task.actions[0]);
  assertEquals(op, {
    op: "status-check",
    verb: "touch-executor",
    flags: ["state-dir", "id", "session", "expect-executor"],
  });
});

Deno.test("dispatch/integration: elapsed takeover derives takeover and plans set-executor operation", () => {
  const st = state([
    item("t-takeover", {
      progress: "running",
      run: run({
        phase: "plan",
        gate: "full",
        executor: "agent-old",
        executor_last_event_at: isoMinutesAgo(125),
        takeover_at: isoMinutesAgo(31),
      }),
    }),
  ]);
  const result = deriveNext(st, input());
  const task = taskOf(result, "t-takeover");
  assert(task.actions.length === 1);
  assertEquals(task.actions[0].kind, "takeover");

  const op = planOperation(task.actions[0]);
  assertEquals(op, {
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: "takeover-elapsed",
    resume_phase: "plan",
    recheck_gate: false,
    needs_worktree: false,
    replaces: "agent-old",
  });
});

Deno.test("dispatch/integration: active executor derives wait(executor-alive) and plans wait operation", () => {
  const st = state([
    item("t-active", {
      progress: "running",
      run: run({
        executor: "agent-active",
        executor_last_event_at: isoMinutesAgo(5),
      }),
    }),
  ]);
  const result = deriveNext(st, input());
  const task = taskOf(result, "t-active");
  assert(task.actions.length === 1);
  assertEquals(task.actions[0].kind, "wait");

  const op = planOperation(task.actions[0]);
  assertEquals(op, {
    op: "wait",
    verb: null,
    flags: [],
    reason: "executor-alive",
  });
});

// ---------------------------------------------------------------------------
// Static integrity check
// ---------------------------------------------------------------------------
Deno.test("dispatch/integrity: pipeline-dispatch.ts does not use Deno APIs", async () => {
  let text: string;
  try {
    text = await Deno.readTextFile(
      new URL("./pipeline-dispatch.ts", import.meta.url),
    );
  } catch (e) {
    if (
      e instanceof Deno.errors.NotCapable ||
      e instanceof Deno.errors.PermissionDenied
    ) {
      return;
    }
    throw e;
  }
  const hits = text
    .split("\n")
    .map((line, idx) => ({ line: idx + 1, text: line }))
    .filter(({ text }) => /\bDeno\./.test(text));
  assertEquals(hits, []);
});
