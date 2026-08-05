// task-pipeline/scripts/state-transitions.test.ts
//
// state-transitions.ts の宣言データ (語彙・遷移表) と実装・スキーマの整合を、
// 直接 import で検査する。3 つの層がある:
//
//   T-ALIGN  語彙の整合 — state.schema.json の enum と TS の語彙定数が一致する。
//            フェーズ・gate・status を片方だけ足すとここで落ちる。
//   T-MX     行列テスト — 全 verb × 全ライフサイクルノード (12) を実行し、
//            VERB_LIFECYCLE の from に無いノードからは conflict になり、from に
//            あるノードからは成功して to のノードに着地することを網羅で検査する。
//            フェーズを足すとノードが増え、この行列が新ノードの扱いを全 verb に問う。
//   T-FRAME  フレームテスト — 各 verb を代表フィクスチャで 1 回実行し、書き換わった
//            パスが宣言した許可パス (FRAME) の中に収まることを検査する。verb が
//            自分の管轄外のサブ機械 (review.watch / review.rebase / withdrawn) を
//            黙って壊す欠陥 (issue #13 の類型) はここで落ちる。
//
// state.test.ts (サブプロセス経由の CLI 検証) とは独立で、こちらは純粋関数を
// そのまま呼ぶ。実行: tests/state-cli.test.sh の deno test ステップに含まれる。

import {
  applyAnsweredSet,
  applyBlock,
  applyClaim,
  applyDequeue,
  applyFinalizeStart,
  applyFixDone,
  applyFixPending,
  applyFixStart,
  applyInReview,
  applyPhaseFail,
  applyPhasePass,
  applyRebaseDone,
  applyRebaseGiveUp,
  applyRebaseRecord,
  applyRebaseResolvePending,
  applyRebaseStart,
  applyRecoverDone,
  applyRestore,
  applyReviewOnly,
  applySetExecutor,
  applySetGate,
  applySetTakeover,
  applySetWorktree,
  applyTouchExecutor,
  applyWatchInit,
  applyWatchSet,
  applyWithdraw,
  applyWithdrawAsked,
  applyWithdrawRemove,
  assertItemInvariants,
  CI_VALUES,
  CliError,
  FINALIZE_FROM_PHASES,
  GATE_PHASE_SEQUENCES,
  GATE_VALUES,
  isPhasePassEdge,
  LIFECYCLE_NODES,
  type NodeKey,
  nodeKeyOf,
  PHASE_VALUES,
  REBASE_KIND_VALUES,
  REBASE_REASON_VALUES,
  STALLED_VALUES,
  STATUS_VALUES,
  VERB_LIFECYCLE,
  WATCH_STATE_VALUES,
} from "./state-transitions.ts";
import { collectSchemaNodes } from "./state-schema.ts";
import schemaJson from "./state.schema.json" with { type: "json" };

// ---------------------------------------------------------------------------
// 依存ゼロの assert (state.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

function assertSameSet(
  actual: readonly unknown[],
  expected: readonly unknown[],
  msg: string,
): void {
  const a = [...actual].map((v) => JSON.stringify(v)).sort();
  const e = [...expected].map((v) => JSON.stringify(v)).sort();
  assertEquals(a, e, msg);
}

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const BASE_ITEM: Record<string, unknown> = {
  id: "t-1",
  title: "t",
  status: "approved",
  gate: "full",
  phase: null,
  attempts: 1,
  session: "s0",
  executor: "agent-0",
  executor_last_event_at: "2026-08-01T00:00:00Z",
  takeover_at: null,
  blocked_reason: null,
  worktree: "/wt",
  base: "main",
  review: null,
};

function watchOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "watching",
    proc: null,
    proc_started_at: null,
    sig: null,
    head: null,
    ci: null,
    handled: ["c-old"],
    fix_pending: false,
    pending_ids: [],
    findings: null,
    fix_attempts: 1,
    errors: 0,
    checked_at: null,
    note: null,
    review_only: [],
    answered: [],
    ...overrides,
  };
}

function rebaseOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    blocked_onto: "sha-base",
    reason: "conflict",
    at: "2026-08-01T00:00:00Z",
    kind: "overlap",
    cause: "cause",
    report: "/report",
    from_tip: "sha-old",
    resolve_pending: false,
    ...overrides,
  };
}

function reviewOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: "https://example.com/pull/1",
    branch: "task-pipeline/t-1",
    tip: "sha-tip",
    base: "main",
    ...overrides,
  };
}

function itemAt(
  node: NodeKey,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const prefix = "in_progress/";
  const nodeFields = node.startsWith(prefix)
    ? { status: "in_progress", phase: node.slice(prefix.length) }
    : { status: node, phase: null };
  return { ...BASE_ITEM, ...nodeFields, ...overrides };
}

function stateOf(
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: "2026-08-01T00:00:00Z",
    queue: [item],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    schema_version: 1,
    ...extra,
  };
}

function queueItemOf(
  state: Record<string, unknown>,
  id = "t-1",
): Record<string, unknown> | undefined {
  const q = state.queue as Record<string, unknown>[];
  return q.find((it) => it.id === id);
}

const NOW = "2026-08-02T00:00:00Z";

// ---------------------------------------------------------------------------
// verb ケース定義 (matrix と frame が共有する)
// ---------------------------------------------------------------------------

interface VerbCase {
  verb: string;
  // ノード以外の補助前提を満たす item の overrides。ノード依存の前提 (phase-pass の
  // gate 整合など) は関数形で書く。
  overrides?:
    | Record<string, unknown>
    | ((node: NodeKey) => Record<string, unknown>);
  // state 側の補助前提 (relisted 等)
  stateExtra?: Record<string, unknown>;
  invoke: (
    item: Record<string, unknown>,
    index: number,
    state: Record<string, unknown>,
  ) => Record<string, unknown>;
  // frame テスト: 書き換えを許す item 内のパス (完全一致またはプレフィックス)。
  // ここに無いパスが変わったら、verb が管轄外の状態を壊している。
  frame: readonly string[];
  // frame テストの起点ノード (from の代表)
  frameNode: NodeKey;
}

const RICH_REVIEW = () =>
  reviewOf({
    watch: watchOf(),
    rebase: rebaseOf(),
    withdrawn: true,
    withdrawn_asked: true,
  });

const VERB_CASES: readonly VerbCase[] = [
  {
    verb: "claim",
    invoke: (i, x, s) => applyClaim(i, x, s, "s1"),
    frame: ["status", "phase", "attempts", "session"],
    frameNode: "approved",
  },
  {
    verb: "set-gate",
    overrides: { gate: "full" },
    invoke: (i, x, s) => applySetGate(i, x, s),
    frame: ["gate", "phase", "attempts"],
    frameNode: "in_progress/research",
  },
  {
    verb: "set-worktree",
    invoke: (i, x, s) => applySetWorktree(i, x, s, "/wt2", "dev", false),
    frame: ["worktree", "base"],
    frameNode: "in_progress/implement",
  },
  {
    verb: "set-executor",
    invoke: (i, x, s) => applySetExecutor(i, x, s, "agent-1", "s1", NOW),
    frame: ["executor", "executor_last_event_at", "session"],
    frameNode: "in_progress/implement",
  },
  {
    verb: "touch-executor",
    overrides: { executor: "agent-0" },
    invoke: (i, x, s) => applyTouchExecutor(i, x, s, undefined, NOW),
    frame: ["executor_last_event_at", "session"],
    frameNode: "in_progress/implement",
  },
  {
    verb: "set-takeover",
    invoke: (i, x, s) => applySetTakeover(i, x, s, NOW),
    frame: ["takeover_at"],
    frameNode: "in_progress/implement",
  },
  {
    verb: "phase-pass",
    // フェーズ列は gate ごとなので、ノードのフェーズを含む列を持つ gate を選ぶ
    // (research+plan は light、それ以外は full で足りる)
    overrides: (node) => {
      const phase = node.startsWith("in_progress/")
        ? node.slice("in_progress/".length)
        : "";
      const gate =
        GATE_VALUES.find((g) =>
          (GATE_PHASE_SEQUENCES[g] as readonly string[]).includes(phase)
        ) ?? "full";
      return { gate };
    },
    // matrix では from ノードごとに合法な次フェーズを引く必要があるため、
    // invoke は現ノードのフェーズから隣接辺を選ぶ
    invoke: (i, x, s) => {
      const from = typeof i.phase === "string" ? i.phase : "research";
      const gate = i.gate === "light" ? "light" : "full";
      const seq: readonly string[] = GATE_PHASE_SEQUENCES[gate];
      const idx = seq.indexOf(from);
      const to = idx !== -1 && idx < seq.length - 1 ? seq[idx + 1] : seq[1];
      return applyPhasePass(i, x, s, from, to);
    },
    frame: ["phase", "attempts"],
    frameNode: "in_progress/research",
  },
  {
    verb: "phase-fail",
    invoke: (i, x, s) => {
      const phase = typeof i.phase === "string" ? i.phase : "research";
      return applyPhaseFail(i, x, s, phase).state;
    },
    frame: ["attempts"],
    frameNode: "in_progress/implement",
  },
  {
    verb: "block",
    overrides: { review: RICH_REVIEW() },
    invoke: (i, x, s) => applyBlock(i, x, s, "reason"),
    frame: [
      "status",
      "phase",
      "blocked_reason",
      "session",
      "review.watch.state",
      "review.watch.proc",
      "review.watch.proc_started_at",
    ],
    frameNode: "in_progress/pr_fix",
  },
  {
    verb: "dequeue",
    invoke: (i, x, s) => applyDequeue(i, x, s),
    frame: [],
    frameNode: "in_progress/implement",
  },
  {
    verb: "finalize-start",
    invoke: (i, x, s) => {
      const from = typeof i.phase === "string" ? i.phase : "report";
      return applyFinalizeStart(i, x, s, from);
    },
    frame: ["phase", "attempts"],
    frameNode: "in_progress/report",
  },
  {
    verb: "in-review",
    overrides: { review: RICH_REVIEW() },
    invoke: (i, x, s) =>
      applyInReview(i, x, s, {
        freshGroup: true,
        ref: "https://example.com/pull/1",
        branch: "task-pipeline/t-1",
        tip: "sha-new",
        base: "main",
        commits: 2,
        clearSession: false,
      }),
    frame: [
      "status",
      "phase",
      "attempts",
      "review.ref",
      "review.branch",
      "review.tip",
      "review.base",
    ],
    frameNode: "in_progress/finalize",
  },
  {
    verb: "watch-init",
    overrides: { review: reviewOf() },
    invoke: (i, x, s) => applyWatchInit(i, x, s, "s1", false),
    frame: ["review.watch", "session"],
    frameNode: "in_review",
  },
  {
    verb: "watch-set",
    overrides: { review: reviewOf({ watch: watchOf() }) },
    invoke: (i, x, s) =>
      applyWatchSet(
        i,
        x,
        s,
        { proc: "bg-1", errorsInc: false, errorsReset: false },
        NOW,
      ),
    frame: ["review.watch.proc", "review.watch.proc_started_at"],
    frameNode: "in_review",
  },
  {
    verb: "fix-pending",
    overrides: { review: reviewOf({ watch: watchOf() }) },
    invoke: (i, x, s) => applyFixPending(i, x, s, ["c1"], "/findings"),
    frame: [
      "review.watch.fix_pending",
      "review.watch.pending_ids",
      "review.watch.findings",
    ],
    frameNode: "in_review",
  },
  {
    verb: "fix-start",
    overrides: {
      review: reviewOf({
        watch: watchOf({ fix_pending: true, state: "watching" }),
      }),
    },
    invoke: (i, x, s) => applyFixStart(i, x, s, "s1", false).state,
    frame: [
      "status",
      "phase",
      "attempts",
      "session",
      "review.watch.fix_attempts",
      "review.watch.fix_pending",
    ],
    frameNode: "in_review",
  },
  {
    verb: "fix-done",
    overrides: {
      review: reviewOf({
        watch: watchOf({ pending_ids: ["c1", "c2"], findings: "/f" }),
      }),
    },
    invoke: (i, x, s) => applyFixDone(i, x, s),
    frame: [
      "review.watch.handled",
      "review.watch.pending_ids",
      "review.watch.findings",
    ],
    frameNode: "in_progress/finalize",
  },
  {
    verb: "review-only",
    overrides: { review: reviewOf({ watch: watchOf() }) },
    invoke: (i, x, s) =>
      applyReviewOnly(i, x, s, [{ id: "r1", updated_at: NOW }]).state,
    frame: ["review.watch.review_only"],
    frameNode: "in_review",
  },
  {
    verb: "answered-set",
    overrides: { review: reviewOf({ watch: watchOf() }) },
    invoke: (i, x, s) =>
      applyAnsweredSet(i, x, s, [{ id: "q1", updated_at: NOW }]).state,
    frame: ["review.watch.answered"],
    frameNode: "in_review",
  },
  {
    verb: "rebase-record",
    overrides: { review: reviewOf() },
    invoke: (i, x, s) =>
      applyRebaseRecord(
        i,
        x,
        s,
        "sha-onto",
        "conflict",
        "overlap",
        "cause",
        "/report",
        NOW,
      ),
    frame: ["review.rebase"],
    frameNode: "in_review",
  },
  {
    verb: "rebase-resolve-pending",
    overrides: { review: reviewOf({ rebase: rebaseOf() }) },
    invoke: (i, x, s) => applyRebaseResolvePending(i, x, s, "sha-from"),
    frame: ["review.rebase.resolve_pending", "review.rebase.from_tip"],
    frameNode: "in_review",
  },
  {
    verb: "rebase-start",
    overrides: {
      review: reviewOf({ rebase: rebaseOf({ resolve_pending: true }) }),
    },
    invoke: (i, x, s) => applyRebaseStart(i, x, s, "s1"),
    frame: [
      "status",
      "phase",
      "attempts",
      "session",
      "review.rebase.resolve_pending",
    ],
    frameNode: "in_review",
  },
  {
    verb: "rebase-done",
    overrides: { review: reviewOf({ rebase: rebaseOf() }) },
    invoke: (i, x, s) => applyRebaseDone(i, x, s, "sha-new"),
    frame: ["review.tip", "review.rebase"],
    frameNode: "in_review",
  },
  {
    verb: "rebase-give-up",
    overrides: {
      review: reviewOf({ rebase: rebaseOf({ resolve_pending: true }) }),
    },
    invoke: (i, x, s) => applyRebaseGiveUp(i, x, s, "sha-onto2"),
    frame: [
      "status",
      "phase",
      "attempts",
      "session",
      "review.rebase.reason",
      "review.rebase.blocked_onto",
      "review.rebase.resolve_pending",
    ],
    frameNode: "in_progress/rebase_fix",
  },
  {
    verb: "recover-done",
    overrides: {
      review: reviewOf({ watch: watchOf({ proc: "bg-1" }) }),
    },
    invoke: (i, x, s) => applyRecoverDone(i, x, s),
    frame: [
      "status",
      "phase",
      "session",
      "review.watch.state",
      "review.watch.proc",
      "review.watch.proc_started_at",
    ],
    frameNode: "in_review",
  },
  {
    verb: "withdraw",
    overrides: { review: reviewOf() },
    invoke: (i, x, s) => applyWithdraw(i, x, s),
    frame: ["review.withdrawn"],
    frameNode: "in_review",
  },
  {
    verb: "withdraw-remove",
    overrides: { review: reviewOf({ withdrawn: true }) },
    invoke: (i, x, s) => applyWithdrawRemove(i, x, s, "reason", NOW),
    frame: [],
    frameNode: "in_review",
  },
  {
    verb: "withdraw-asked",
    overrides: { review: reviewOf({ withdrawn: true }) },
    invoke: (i, x, s) => applyWithdrawAsked(i, x, s),
    frame: ["review.withdrawn_asked"],
    frameNode: "in_review",
  },
  {
    verb: "restore",
    overrides: { review: reviewOf({ watch: watchOf({ proc: "bg-1" }) }) },
    stateExtra: { relisted: [{ id: "t-1", seen_at: NOW }] },
    invoke: (i, x, s) => applyRestore(i, x, s),
    frame: [
      "status",
      "phase",
      "attempts",
      "session",
      "executor",
      "executor_last_event_at",
      "takeover_at",
      "blocked_reason",
      "review.watch.state",
      "review.watch.proc",
      "review.watch.proc_started_at",
    ],
    frameNode: "in_review",
  },
];

// ---------------------------------------------------------------------------
// T-ALIGN: 語彙と state.schema.json の enum の整合
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
const defs = (schemaJson as any).$defs;

Deno.test("T-ALIGN-1: schema status enum matches STATUS_VALUES", () => {
  assertSameSet(
    defs.queueItem.properties.status.enum,
    STATUS_VALUES,
    "status enum",
  );
});

Deno.test("T-ALIGN-2: schema phase enum matches [null, ...PHASE_VALUES]", () => {
  assertSameSet(
    defs.queueItem.properties.phase.enum,
    [null, ...PHASE_VALUES],
    "phase enum",
  );
});

Deno.test("T-ALIGN-3: schema gate enum matches GATE_VALUES", () => {
  assertSameSet(defs.queueItem.properties.gate.enum, GATE_VALUES, "gate enum");
});

Deno.test("T-ALIGN-4: schema watch.state enum matches WATCH_STATE_VALUES", () => {
  assertSameSet(
    defs.reviewWatch.properties.state.enum,
    WATCH_STATE_VALUES,
    "watch.state enum",
  );
});

Deno.test("T-ALIGN-5: schema watch.ci enum matches [null, ...CI_VALUES]", () => {
  assertSameSet(
    defs.reviewWatch.properties.ci.enum,
    [null, ...CI_VALUES],
    "watch.ci enum",
  );
});

Deno.test("T-ALIGN-6: schema rebase.reason enum matches REBASE_REASON_VALUES", () => {
  assertSameSet(
    defs.reviewRebase.properties.reason.enum,
    REBASE_REASON_VALUES,
    "rebase.reason enum",
  );
});

Deno.test("T-ALIGN-7: schema rebase.kind enum matches REBASE_KIND_VALUES", () => {
  assertSameSet(
    defs.reviewRebase.properties.kind.enum,
    REBASE_KIND_VALUES,
    "rebase.kind enum",
  );
});

Deno.test("T-ALIGN-8: schema stalled enum matches [null, ...STALLED_VALUES]", () => {
  assertSameSet(
    // deno-lint-ignore no-explicit-any
    (schemaJson as any).properties.stalled.enum,
    [null, ...STALLED_VALUES],
    "stalled enum",
  );
});

Deno.test("T-ALIGN-9: VERB_LIFECYCLE covers every queue verb case and only valid nodes", () => {
  const caseVerbs = VERB_CASES.map((c) => c.verb);
  const specVerbs = Object.keys(VERB_LIFECYCLE).filter((v) => v !== "approve");
  assertSameSet(caseVerbs, specVerbs, "verb cases vs VERB_LIFECYCLE keys");
  for (const [verb, spec] of Object.entries(VERB_LIFECYCLE)) {
    for (const n of spec.from) {
      assert(
        LIFECYCLE_NODES.includes(n),
        `${verb}: from node not in LIFECYCLE_NODES: ${n}`,
      );
    }
    if (
      spec.to !== "unchanged" && spec.to !== "dynamic" && spec.to !== "removed"
    ) {
      assert(
        LIFECYCLE_NODES.includes(spec.to),
        `${verb}: to node not in LIFECYCLE_NODES: ${spec.to}`,
      );
    }
  }
});

Deno.test("T-ALIGN-10: phase-pass edges are exactly the adjacent pairs of each gate sequence", () => {
  let count = 0;
  for (const gate of GATE_VALUES) {
    const seq: readonly string[] = GATE_PHASE_SEQUENCES[gate];
    for (const from of PHASE_VALUES) {
      for (const to of PHASE_VALUES) {
        const expected = seq.indexOf(from) !== -1 &&
          seq[seq.indexOf(from) + 1] === to;
        assertEquals(
          isPhasePassEdge(gate, from, to),
          expected,
          `edge ${gate}: ${from} -> ${to}`,
        );
        if (expected) count++;
      }
    }
  }
  // full: 3 辺 + light: 2 辺 (フェーズ列を伸ばすとこの数も上のループで自動的に伸びる)
  const expectedCount = GATE_VALUES.reduce(
    (acc, g) => acc + GATE_PHASE_SEQUENCES[g].length - 1,
    0,
  );
  assertEquals(count, expectedCount, "total edge count");
});

Deno.test("T-ALIGN-11: derived phase sets are coherent", () => {
  assertSameSet(
    FINALIZE_FROM_PHASES.filter((p) => !PHASE_VALUES.includes(p)),
    [],
    "FINALIZE_FROM_PHASES ⊆ PHASE_VALUES",
  );
  assert(
    !FINALIZE_FROM_PHASES.includes("finalize"),
    "finalize must not be a finalize-start source",
  );
  assertEquals(
    LIFECYCLE_NODES.length,
    STATUS_VALUES.length - 1 + PHASE_VALUES.length,
    "node count = (statuses - in_progress) + phases",
  );
  assertEquals(
    new Set(LIFECYCLE_NODES).size,
    LIFECYCLE_NODES.length,
    "nodes unique",
  );
});

// ---------------------------------------------------------------------------
// nodeKeyOf / assertItemInvariants の単体
// ---------------------------------------------------------------------------

Deno.test("T-NODE-1: nodeKeyOf rejects unreachable combos", () => {
  assertEquals(nodeKeyOf({ status: "in_progress", phase: null }), null);
  assertEquals(nodeKeyOf({ status: "approved", phase: "research" }), null);
  assertEquals(nodeKeyOf({ status: "in_review", phase: "pr_fix" }), null);
  assertEquals(nodeKeyOf({ status: "bogus", phase: null }), null);
  assertEquals(nodeKeyOf({ status: "in_progress", phase: "bogus" }), null);
  assertEquals(
    nodeKeyOf({ status: "in_progress", phase: "research" }),
    "in_progress/research",
  );
  assertEquals(nodeKeyOf({ status: "done", phase: null }), "done");
});

Deno.test("T-NODE-2: assertItemInvariants throws schema on unreachable node", () => {
  let threw = false;
  try {
    assertItemInvariants(itemAt("approved", { phase: "research" }));
  } catch (e) {
    threw = true;
    assert(e instanceof CliError && e.code === "schema", "schema error");
  }
  assert(threw, "must throw");
});

Deno.test("T-NODE-3: assertItemInvariants throws schema on watch without ref", () => {
  let threw = false;
  try {
    assertItemInvariants(
      itemAt("in_review", {
        review: { ref: null, watch: watchOf() },
      }),
    );
  } catch (e) {
    threw = true;
    assert(e instanceof CliError && e.code === "schema", "schema error");
  }
  assert(threw, "must throw");
});

// ---------------------------------------------------------------------------
// T-MX: 行列テスト (全 verb × 全ノード)
// ---------------------------------------------------------------------------

// verb の出力が守るべき、ノード結合より強い性質 (テスト時のみ検査。verb の出力は
// すべてここを通る — 入力フィクスチャには課さない)。
function assertOutputInvariants(item: Record<string, unknown>): void {
  assertItemInvariants(item);
  const status = item.status;
  const review = item.review as Record<string, unknown> | null;
  const watch = review && typeof review === "object" && "watch" in review
    ? review.watch as Record<string, unknown>
    : null;
  if (status === "done") {
    assertEquals(item.session, null, "done implies session null");
    if (watch) {
      assertEquals(watch.proc, null, "done implies watch.proc null");
      assertEquals(watch.state, "stopped", "done implies watch stopped");
    }
  }
  if (status === "approved" || status === "blocked") {
    assertEquals(item.session, null, `${status} implies session null`);
    if (watch) {
      assertEquals(
        watch.state,
        "stopped",
        `${status} implies watch stopped`,
      );
    }
  }
}

Deno.test("T-MX-1: every verb succeeds exactly on its declared from-nodes and lands on its to-node", () => {
  for (const c of VERB_CASES) {
    const spec = VERB_LIFECYCLE[c.verb];
    assert(spec !== undefined, `missing VERB_LIFECYCLE for ${c.verb}`);
    for (const node of LIFECYCLE_NODES) {
      const overrides = typeof c.overrides === "function"
        ? c.overrides(node)
        : c.overrides;
      const item = itemAt(node, overrides);
      const state = stateOf(item, c.stateExtra);
      const expectedOk = spec.from.includes(node);
      let next: Record<string, unknown> | null = null;
      let err: unknown = null;
      try {
        next = c.invoke(item, 0, state);
      } catch (e) {
        err = e;
      }
      if (expectedOk) {
        assert(
          next !== null,
          `${c.verb} @ ${node}: expected success, got ${String(err)}`,
        );
        const nextItem = queueItemOf(next!);
        if (spec.to === "removed") {
          assert(
            nextItem === undefined,
            `${c.verb} @ ${node}: item should be removed`,
          );
        } else {
          assert(
            nextItem !== undefined,
            `${c.verb} @ ${node}: item disappeared`,
          );
          const landed = nodeKeyOf(nextItem!);
          assert(landed !== null, `${c.verb} @ ${node}: unreachable output`);
          if (spec.to === "unchanged") {
            assertEquals(landed, node, `${c.verb} @ ${node}: node changed`);
          } else if (spec.to !== "dynamic") {
            assertEquals(landed, spec.to, `${c.verb} @ ${node}: wrong to-node`);
          }
          assertOutputInvariants(nextItem!);
        }
      } else {
        assert(
          err !== null,
          `${c.verb} @ ${node}: expected conflict, got success`,
        );
        assert(
          err instanceof CliError && err.code === "conflict",
          `${c.verb} @ ${node}: expected conflict, got ${String(err)}`,
        );
      }
    }
  }
});

// fix-start の dynamic 分岐: 上限内なら pr_fix へ、上限超過なら in_review のまま
// stopped になる (どちらも exit 0 側の正常分岐)。
Deno.test("T-MX-2: fix-start dynamic branches (start vs cap)", () => {
  const startItem = itemAt("in_review", {
    review: reviewOf({
      watch: watchOf({ fix_pending: true, fix_attempts: 0 }),
    }),
  });
  const r1 = applyFixStart(startItem, 0, stateOf(startItem), "s1", false);
  assertEquals(r1.started, true, "starts under cap");
  assertEquals(
    nodeKeyOf(queueItemOf(r1.state)!),
    "in_progress/pr_fix",
    "lands on pr_fix",
  );

  const capItem = itemAt("in_review", {
    review: reviewOf({
      watch: watchOf({ fix_pending: true, fix_attempts: 3 }),
    }),
  });
  const r2 = applyFixStart(capItem, 0, stateOf(capItem), "s1", false);
  assertEquals(r2.started, false, "cap reached");
  const capOut = queueItemOf(r2.state)!;
  assertEquals(nodeKeyOf(capOut), "in_review", "stays in_review");
  const capWatch = (capOut.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(capWatch.state, "stopped", "watch stopped at cap");
  assertEquals(capOut.session, null, "session released at cap");
});

// phase-pass の dynamic 着地: 各 gate のフェーズ列を先頭から最後まで実際に歩き切れる。
Deno.test("T-MX-3: phase-pass walks every gate sequence end to end", () => {
  for (const gate of GATE_VALUES) {
    const seq: readonly string[] = GATE_PHASE_SEQUENCES[gate];
    let item = itemAt(`in_progress/${seq[0]}` as NodeKey, { gate });
    let state = stateOf(item);
    for (let i = 0; i < seq.length - 1; i++) {
      state = applyPhasePass(item, 0, state, seq[i], seq[i + 1]);
      item = queueItemOf(state)!;
      assertEquals(
        nodeKeyOf(item),
        `in_progress/${seq[i + 1]}`,
        `${gate}: step ${i}`,
      );
      assertEquals(item.attempts, 0, `${gate}: attempts reset at step ${i}`);
    }
  }
});

// ---------------------------------------------------------------------------
// T-FRAME: 書き換え許可パスの検査
// ---------------------------------------------------------------------------

function diffPaths(
  before: unknown,
  after: unknown,
  prefix: string,
  out: string[],
): void {
  const bothRecords = typeof before === "object" && before !== null &&
    !Array.isArray(before) && typeof after === "object" && after !== null &&
    !Array.isArray(after);
  if (bothRecords) {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const k of keys) {
      diffPaths(b[k], a[k], prefix === "" ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push(prefix);
  }
}

function frameAllows(frame: readonly string[], path: string): boolean {
  return frame.some((f) => path === f || path.startsWith(`${f}.`));
}

Deno.test("T-FRAME-1: each verb only changes paths in its declared frame", () => {
  for (const c of VERB_CASES) {
    const spec = VERB_LIFECYCLE[c.verb];
    const overrides = typeof c.overrides === "function"
      ? c.overrides(c.frameNode)
      : c.overrides;
    const item = itemAt(c.frameNode, overrides);
    const state = stateOf(item, c.stateExtra);
    const before = JSON.parse(JSON.stringify(item));
    const next = c.invoke(item, 0, state);
    const nextItem = queueItemOf(next);
    if (spec.to === "removed") {
      assert(nextItem === undefined, `${c.verb}: expected removal`);
      continue;
    }
    assert(nextItem !== undefined, `${c.verb}: item disappeared`);
    const changed: string[] = [];
    diffPaths(before, nextItem, "", changed);
    const violations = changed.filter((p) => !frameAllows(c.frame, p));
    assertEquals(
      violations,
      [],
      `${c.verb}: changed paths outside frame`,
    );
  }
});

// フレームテスト自身の検出力の確認 (テストのテスト): in-review が watch を丸ごと
// 落とす旧実装相当の書き換えを与えると、frame 違反として検出される。
Deno.test("T-FRAME-2: frame check detects a watch-dropping in-review (self test)", () => {
  const c = VERB_CASES.find((v) => v.verb === "in-review")!;
  const overrides = typeof c.overrides === "function"
    ? c.overrides(c.frameNode)
    : c.overrides;
  const item = itemAt(c.frameNode, overrides);
  const before = JSON.parse(JSON.stringify(item));
  // 旧実装 (issue #13 以前) の丸ごと置換を再現
  const broken = {
    ...item,
    status: "in_review",
    phase: null,
    attempts: 0,
    review: {
      ref: "https://example.com/pull/1",
      branch: "task-pipeline/t-1",
      tip: "sha-new",
      base: "main",
    },
  };
  const changed: string[] = [];
  diffPaths(before, broken, "", changed);
  const violations = changed.filter((p) => !frameAllows(c.frame, p));
  assert(
    violations.some((p) => p.startsWith("review.watch")),
    `wholesale review replacement must violate the frame, got: ${
      JSON.stringify(violations)
    }`,
  );
});

// ---------------------------------------------------------------------------
// サブ機械を後から足す人への網 (3 つ目のサブ機械の追加実験で見つけたギャップの固定)
// ---------------------------------------------------------------------------

// スキーマに enum を持つ全ノードが、TS 側の語彙定数と 1:1 で対応していることを
// スキーマ走査 (collectSchemaNodes) で網羅検査する。T-ALIGN-1〜8 は既知の enum の
// 個別検査、こちらは「新しい enum を足したのに語彙定数を作らなかった」を落とす網。
Deno.test("T-ALIGN-12: every schema enum node has a matching TS vocabulary constant", () => {
  const registry: Record<string, readonly unknown[]> = {
    "$defs.queueItem.properties.status": STATUS_VALUES,
    "$defs.queueItem.properties.phase": [null, ...PHASE_VALUES],
    "$defs.queueItem.properties.gate": GATE_VALUES,
    "$defs.reviewWatch.properties.state": WATCH_STATE_VALUES,
    "$defs.reviewWatch.properties.ci": [null, ...CI_VALUES],
    "$defs.reviewRebase.properties.reason": REBASE_REASON_VALUES,
    "$defs.reviewRebase.properties.kind": REBASE_KIND_VALUES,
    "$root.properties.stalled": [null, ...STALLED_VALUES],
  };
  const enumNodes = collectSchemaNodes(schemaJson).filter(({ node }) =>
    Array.isArray(node.enum)
  );
  assert(enumNodes.length > 0, "schema must have enum nodes");
  for (const { schemaPath, node } of enumNodes) {
    const expected = registry[schemaPath];
    assert(
      expected !== undefined,
      `schema enum at ${schemaPath} has no TS vocabulary constant — ` +
        "新しい enum を足したら state-transitions.ts に語彙定数を作り、" +
        "このテストの registry に登録すること",
    );
    assertSameSet(
      node.enum as unknown[],
      expected,
      `enum mismatch at ${schemaPath}`,
    );
  }
  const paths = new Set(enumNodes.map((e) => e.schemaPath));
  for (const key of Object.keys(registry)) {
    assert(paths.has(key), `registry entry without schema enum: ${key}`);
  }
});

// frame テストの最大フィクスチャ (RICH_REVIEW / watchOf / rebaseOf) が、スキーマの
// review / reviewWatch / reviewRebase の全プロパティを含むことを強制する。これが
// 欠けると、新しいサブ機械のフィールドを既存 verb が黙って落としても frame テストが
// 検出できない (フィクスチャに無いフィールドの破壊は diff に現れないため)。
Deno.test("T-ALIGN-13: frame fixtures cover every schema property of review/watch/rebase", () => {
  // deno-lint-ignore no-explicit-any
  const d = (schemaJson as any).$defs;
  assertSameSet(
    Object.keys(BASE_ITEM),
    Object.keys(d.queueItem.properties),
    "BASE_ITEM must cover all queueItem properties",
  );
  assertSameSet(
    Object.keys(RICH_REVIEW()),
    Object.keys(d.review.properties),
    "RICH_REVIEW must cover all review properties",
  );
  assertSameSet(
    Object.keys(watchOf()),
    Object.keys(d.reviewWatch.properties),
    "watchOf() must cover all reviewWatch properties",
  );
  assertSameSet(
    Object.keys(rebaseOf()),
    Object.keys(d.reviewRebase.properties),
    "rebaseOf() must cover all reviewRebase properties",
  );
});
