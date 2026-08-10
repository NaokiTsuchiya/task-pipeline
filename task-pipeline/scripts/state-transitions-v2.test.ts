// task-pipeline/scripts/state-transitions-v2.test.ts
//
// 状態モデル v2 の遷移 (apply 群と VERB_SPEC) のテスト。直接importで純粋関数をそのまま
// 呼ぶ。import 先は検査対象の層を名指しする:
//
//   ./state-transitions-v2.ts        層 10 の apply 群と公開 API (再 export 済みのもの)
//   ./state-transitions-v2-nodes.ts  層 3〜6 の宣言・導出ビュー・引き当て (公開面には無い)
//
// 層の一覧は state-transitions-v2-types.ts の冒頭にある。
//
// テストの構成は v1 の 3 層テスト (T-ALIGN / T-MX / T-FRAME) に相当する層を、v2 の座標
// (領域P 19 × 領域A 23) の上で組み直したもの:
//
//   T-V2T-ALIGN  宣言と実装の整合 — VERB_SPEC・advance の辺・ノード集合・形状宣言と
//                実装の出力が食い違えば落ちる。フィクスチャ網羅のメタテストを含む。
//   T-V2T-MX     行列テスト — 積の全合法ノード × 全 verb。宣言した from でだけ発火し、
//                宣言した to に着地し、出力が不変条件1〜5 + gate iff を満たす。
//   T-V2T-FRAME  フレームテスト — 各 verb が宣言した書き換え許可パスの外を触らない。
//                自己テスト (T-V2T-FRAME-2) が検査自身の検出力を確かめる。
//   T-V2T-REACH  到達可能性 — 実辺を BFS で辿り、意図的到達不能リストと突き合わせる。
//
// 加えて、行列とフレームでは検出できない「座標を変えずに値を間違える」誤実装のための
// 専用ケース: T-V2T-SHIP / T-V2T-CLAIM / T-V2T-LEDGER / T-V2T-OPT。
//
//   deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//   単体: deno test task-pipeline/scripts/state-transitions-v2.test.ts

import {
  checkReachability,
  type HumanAttentionReason,
  INITIAL_GATE_PHASE_SEQUENCES,
  listRunNodes,
  P_NODE_KEYS,
  type PNodeKey,
  type Progress,
  type ReachabilityEdge,
  type RunNode,
  type RunNodeKey,
} from "./state-model-v2.ts";
// 層 10 (公開面) — apply 群と、そこから再 export されている公開 API。
import {
  ADVANCE_EDGES,
  advanceTargetsOf,
  aNodeKeyOf,
  applyAdvance,
  applyAnsweredSet,
  applyApprove,
  applyAttentionSet,
  applyBlock,
  applyClaim,
  applyDequeue,
  applyFixRequest,
  applyFixRerunMark,
  applyFixStart,
  applyMerged,
  applyObserve,
  applyPhaseFail,
  applyProbeExit,
  applyProbeRun,
  applyRebaseApplied,
  applyRebaseForgo,
  applyRebaseGiveUp,
  applyRebaseRequest,
  applyRebaseStart,
  applyRelease,
  applyRestore,
  applyRetire,
  applyReviewOnly,
  applySetExecutor,
  applySetGate,
  applySetTakeover,
  applySetWorktree,
  applyShip,
  applyTouchExecutor,
  applyWithdraw,
  applyWithdrawAsked,
  applyWithdrawRemove,
  ARTIFACT_SHAPES,
  type ArtifactAxisSpec,
  ASKS_SHAPE,
  assertItemInvariantsV2,
  CliErrorV2,
  FIX_ASK_SHAPE,
  FOLLOW_SHAPE,
  freshFollow,
  isAdvanceEdge,
  isPullRequestRef,
  ITEM_SHAPE,
  LEDGER_SHAPE,
  type LedgerEntry,
  pNodeKeyOf,
  PROBE_SHAPE,
  productKey,
  productKeyOf,
  REBASE_ASK_SHAPE,
  resolveArtifactAxis,
  RUN_SHAPE,
  type V2Artifact,
  type V2FixAsk,
  type V2Follow,
  type V2Item,
  type V2Ledger,
  type V2Probe,
  type V2RebaseAsk,
  type V2State,
  VERB_SPEC,
  type VerbName,
  type VerbSpecV2,
} from "./state-transitions-v2.ts";
// 層 3〜6 (内部) — 宣言・導出ビュー・引き当てを直接検査するため、層を名指しで import
// する (公開面には出ていないもの)。
import {
  A_NODE_KEYS,
  A_NODE_KEYS_EXCEPT_MERGED,
  A_NODE_MERGED,
  A_NODE_NONE,
  A_NODE_OPEN_NO_FOLLOW,
  A_OPEN_FOLLOW,
  A_OPEN_FOLLOW_KEYS,
  A_OPEN_FOLLOW_NODES,
  type ANodeKey,
  openNodeKey,
  openNodeOf,
  P_CYCLE_REBASE_KEYS,
  P_DETOUR_KEYS,
  P_FINALIZE_KEYS,
  P_RUNNING_KEYS,
  P_VERIFIED_KEYS,
  PRODUCT_NODE_KEYS,
} from "./state-transitions-v2-nodes.ts";

// ---------------------------------------------------------------------------
// 依存ゼロの assert (state-model-v2.test.ts / state-transitions.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertFalse(cond: boolean, msg?: string): void {
  if (cond) throw new Error(msg ?? "assertFalse failed");
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

const NOW0 = "2026-08-01T00:00:00Z";
const NOW = "2026-08-02T00:00:00Z";
const PR_REF = "https://example.com/o/r/pull/7";
const COMMIT_REF = "0123456789abcdef0123456789abcdef01234567";

function runKey(
  kind: string,
  gate: string | null,
  phase: string,
): RunNodeKey {
  const node = listRunNodes().find((n) =>
    n.kind === kind && n.gate === gate && n.phase === phase
  );
  if (node === undefined) {
    throw new Error(`no run node for ${kind}/${gate}/${phase}`);
  }
  return node.key();
}

const P_QUEUED = "queued";
const P_RESTING = "resting";
const P_BLOCKED = "blocked";
const P_FULL_RESEARCH = runKey("initial", "full", "research");
const P_FULL_IMPLEMENT = runKey("initial", "full", "implement");
const P_FULL_FINALIZE = runKey("initial", "full", "finalize");
const P_FULL_DETOUR = runKey("initial", "full", "rebase_fix");
const P_PRFIX_PRFIX = runKey("pr_fix", null, "pr_fix");
const P_PRFIX_FINALIZE = runKey("pr_fix", null, "finalize");
const P_CYCLE_REBASE = runKey("rebase_fix", null, "rebase_fix");

const A_OPEN_IDLE = openNodeKey("auto", "null", "quiet");
const A_OPEN_FIX_PENDING = openNodeKey("auto", "pending", "quiet");
const A_OPEN_FIX_TAKEN = openNodeKey("auto", "taken", "quiet");
const A_OPEN_REBASE_QUEUED = openNodeKey("auto", "null", "queued");
const A_OPEN_REBASE_TAKEN = openNodeKey("auto", "null", "taken");
// 綴りは実装から取らずテスト側にも独立して書く (キーの取り違えを検出するため)。
const A_WITHDRAWN_UNASKED = "withdrawn(asked=false)";
const A_WITHDRAWN_ASKED = "withdrawn(asked=true)";

function ledgerFixture(): V2Ledger {
  return {
    handled: ["c-old"],
    fix_attempts: 1,
    review_only: [{ id: "r1", updated_at: "t1" }],
    answered: [{ id: "q1", updated_at: "t1" }],
    fix_cycle_tip: null,
    fix_rerun_tip: null,
  };
}

function probeFixture(leased: boolean): V2Probe {
  return {
    proc: leased ? "bg-1" : null,
    proc_started_at: leased ? NOW0 : null,
    sig: "sig-0",
    head: "h0",
    ci: "passing",
    checked_at: NOW0,
    errors: 0,
    note: "n0",
  };
}

function fixAskFixture(axis: string): V2FixAsk | null {
  if (axis === "null") return null;
  return { ids: ["c1", "c2"], findings: "/findings", taken: axis === "taken" };
}

// quiet の代表は「ガードの控えだけがあるレコード」にする。設計1.5 は「記録なし」と
// 同じ座標だと明記しているが、記録がある側を代表にした方が upsert / 降格の誤りを
// 検出できる (記録なしだと rebase-quiet の to 検査が自明に通ってしまう)。
function rebaseAskFixture(axis: string): V2RebaseAsk | null {
  const base = {
    blocked_onto: "sha-base",
    reason: "conflict",
    at: NOW0,
    kind: "overlap",
    cause: "cause",
    report: "/report",
    from_tip: "sha-old",
  };
  if (axis === "quiet") return { ...base, resolve: false, taken: false };
  if (axis === "queued") return { ...base, resolve: true, taken: false };
  return { ...base, resolve: false, taken: true };
}

export interface OpenSubAxisTriple {
  attention: string;
  fix: string;
  rebase: string;
}

// キー文字列を解析せず、実装が静的に宣言している open ノード表をそのまま引く。
function parseOpenKey(aKey: string): OpenSubAxisTriple | null {
  return openNodeOf(aKey);
}

function followFixture(sub: OpenSubAxisTriple, leased: boolean): V2Follow {
  return {
    attention: sub.attention === "auto" ? "auto" : { human: "manual" },
    asks: {
      fix: fixAskFixture(sub.fix),
      rebase: rebaseAskFixture(sub.rebase),
    },
    ledger: ledgerFixture(),
    probe: probeFixture(leased),
  };
}

function artifactFixture(aKey: string, leased: boolean): V2Artifact {
  if (aKey === A_NODE_NONE) return { state: "none" };
  const group = {
    ref: PR_REF,
    branch: "task-pipeline/t-1",
    tip: "sha-tip",
    base: "main",
  };
  if (aKey === A_NODE_MERGED) return { state: "merged", ...group };
  if (aKey === A_WITHDRAWN_UNASKED) {
    return { state: "withdrawn", ...group, asked: false, note: null };
  }
  if (aKey === A_WITHDRAWN_ASKED) {
    return { state: "withdrawn", ...group, asked: true, note: "closed" };
  }
  if (aKey === A_NODE_OPEN_NO_FOLLOW) {
    return { state: "open", ...group, ref: COMMIT_REF, follow: null };
  }
  const sub = parseOpenKey(aKey);
  if (sub === null) throw new Error(`unknown artifact node key: ${aKey}`);
  return { state: "open", ...group, follow: followFixture(sub, leased) };
}

// 引くのは VERB_SPEC 由来の素の文字列 (宣言外のキーが来たら undefined を返してほしい)
// なので、キー型は #34 の RunNodeKey ではなく string で持つ。
const RUN_NODE_BY_KEY: ReadonlyMap<string, RunNode> = new Map(
  listRunNodes().map((n) => [n.key(), n]),
);

function buildItem(
  pKey: string,
  aKey: string,
  overrides: Partial<V2Item> = {},
): V2Item {
  const node = RUN_NODE_BY_KEY.get(pKey);
  const base: V2Item = {
    id: "t-1",
    title: "t",
    progress: node !== undefined ? "running" : (pKey as Progress),
    run: node !== undefined
      ? {
        kind: node.kind,
        gate: node.gate,
        phase: node.phase,
        attempts: 1,
        executor: "agent-0",
        executor_last_event_at: NOW0,
        takeover_at: null,
      }
      : null,
    blocked_reason: pKey === P_BLOCKED ? "reason" : null,
    // 追従リースは resting のときだけ張る (不変条件4)。
    artifact: artifactFixture(aKey, pKey === P_RESTING),
    worktree: "/wt",
    base: "main",
    session: "s0",
  };
  return { ...base, ...overrides };
}

function buildState(
  item: V2Item,
  extra: Partial<V2State> = {},
): V2State {
  return {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: NOW0,
    queue: [item],
    candidates: [],
    relisted: [],
    promoted: [],
    completed: [],
    withdrawn_branches: [],
    history: [],
    schema_version: 2,
    ...extra,
  };
}

function itemOf(state: V2State): V2Item | undefined {
  return state.queue.find((it) => it.id === "t-1");
}

// ---------------------------------------------------------------------------
// verb ケース (matrix / frame / align が共有する 1 つの表)
// ---------------------------------------------------------------------------

interface VerbCase {
  // 一意な名前。dynamic 分岐のために 1 verb に複数ケースを置けるようにする。
  name: string;
  // 宣言済み verb 名しか書けない (VERB_SPEC のキーの union)。
  verb: VerbName;
  overrides?: Partial<V2Item>;
  stateExtra?: Partial<V2State>;
  invoke: (item: V2Item, index: number, state: V2State) => V2State;
  // frame テストの起点 (P ノード, A ノード) と書き換え許可パス。
  frameNode: readonly [PNodeKey, ANodeKey];
  frame: readonly string[];
}

const RELISTED_EXTRA: Partial<V2State> = {
  relisted: [{ id: "t-1", seen_at: NOW0 }],
};

const SHIP_GROUP = {
  ref: PR_REF,
  branch: "task-pipeline/t-1",
  tip: "sha-new",
  base: "main",
};

// run が無い / 前進辺を持たないノードでも例外を投げずに "何か" を返す (行列テストが
// 宣言外ノードから呼ぶため)。実際の合法性判定は applyAdvance 側が行う。
function advanceTargetOf(item: V2Item): string {
  if (item.run === null) return "plan";
  try {
    return advanceTargetsOf(item.run)[0] ?? "finalize";
  } catch {
    return "finalize";
  }
}

const VERB_CASES: readonly VerbCase[] = [
  {
    name: "claim",
    verb: "claim",
    invoke: (i, x, s) => applyClaim(i, x, s, "s1"),
    frameNode: [P_QUEUED, openNodeKey("human", "pending", "queued")],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.follow.attention",
      "artifact.follow.asks",
      "artifact.follow.ledger.fix_attempts",
      "artifact.follow.ledger.review_only",
      "artifact.follow.ledger.answered",
      "artifact.follow.probe.sig",
    ],
  },
  {
    name: "set-gate",
    verb: "set-gate",
    invoke: (i, x, s) => applySetGate(i, x, s),
    frameNode: [P_FULL_RESEARCH, A_NODE_NONE],
    frame: ["run.gate", "run.phase", "run.attempts"],
  },
  {
    name: "advance",
    verb: "advance",
    // 行列は非 running のノードにも掛かるので、引数の組み立て自体は run 無しでも
    // 落ちないようにする (前提違反の判定は applyAdvance 側の requireVerbAxes に任せる)。
    invoke: (i, x, s) =>
      applyAdvance(i, x, s, i.run?.phase ?? "research", advanceTargetOf(i)),
    frameNode: [P_FULL_RESEARCH, A_NODE_NONE],
    frame: ["run.phase", "run.attempts"],
  },
  {
    name: "phase-fail",
    verb: "phase-fail",
    invoke: (i, x, s) =>
      applyPhaseFail(i, x, s, i.run?.phase ?? "research").state,
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: ["run.attempts"],
  },
  {
    name: "block",
    verb: "block",
    invoke: (i, x, s) => applyBlock(i, x, s, "reason"),
    frameNode: [P_FULL_IMPLEMENT, A_OPEN_IDLE],
    frame: ["progress", "run", "blocked_reason", "session"],
  },
  {
    name: "dequeue",
    verb: "dequeue",
    invoke: (i, x, s) => applyDequeue(i, x, s),
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: [],
  },
  {
    name: "restore",
    verb: "restore",
    stateExtra: RELISTED_EXTRA,
    invoke: (i, x, s) => applyRestore(i, x, s),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "progress",
      "run",
      "blocked_reason",
      "session",
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "retire",
    verb: "retire",
    overrides: { session: null },
    invoke: (i, x, s) => applyRetire(i, x, s, NOW),
    frameNode: [P_RESTING, A_NODE_MERGED],
    frame: [],
  },
  {
    // pr_fix 復帰 (既存 open への押し直し)。follow を保持する側の代表。
    name: "ship",
    verb: "ship",
    invoke: (i, x, s) =>
      applyShip(i, x, s, { commits: 2, ...SHIP_GROUP }).state,
    frameNode: [P_PRFIX_FINALIZE, A_OPEN_FIX_TAKEN],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.ref",
      "artifact.branch",
      "artifact.tip",
      "artifact.base",
      "artifact.follow.asks.fix",
      "artifact.follow.asks.rebase.resolve",
      "artifact.follow.ledger.handled",
      "artifact.follow.probe.sig",
    ],
  },
  {
    // 最初の PR を出す側 (none → open)。follow が生まれる分だけ frame が広い。
    name: "ship/new-open",
    verb: "ship",
    invoke: (i, x, s) =>
      applyShip(i, x, s, { commits: 1, ...SHIP_GROUP }).state,
    frameNode: [P_FULL_FINALIZE, A_NODE_NONE],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.state",
      "artifact.ref",
      "artifact.branch",
      "artifact.tip",
      "artifact.base",
      "artifact.follow",
    ],
  },
  {
    name: "merged",
    verb: "merged",
    invoke: (i, x, s) => applyMerged(i, x, s),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["session", "artifact.state", "artifact.follow"],
  },
  {
    name: "withdraw",
    verb: "withdraw",
    invoke: (i, x, s) => applyWithdraw(i, x, s, "closed"),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "session",
      "artifact.state",
      "artifact.follow",
      "artifact.asked",
      "artifact.note",
    ],
  },
  {
    name: "withdraw-asked",
    verb: "withdraw-asked",
    invoke: (i, x, s) => applyWithdrawAsked(i, x, s),
    frameNode: [P_RESTING, A_WITHDRAWN_UNASKED],
    frame: ["artifact.asked"],
  },
  {
    name: "withdraw-remove",
    verb: "withdraw-remove",
    invoke: (i, x, s) => applyWithdrawRemove(i, x, s, "reason", NOW),
    frameNode: [P_RESTING, A_WITHDRAWN_ASKED],
    frame: [],
  },
  {
    name: "fix-request",
    verb: "fix-request",
    invoke: (i, x, s) => applyFixRequest(i, x, s, ["c1"], "/findings"),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["artifact.follow.asks.fix"],
  },
  {
    name: "fix-rerun-mark",
    verb: "fix-rerun-mark",
    invoke: (i, x, s) => applyFixRerunMark(i, x, s).state,
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["artifact.follow.ledger.fix_rerun_tip"],
  },
  {
    name: "rebase-request",
    verb: "rebase-request",
    invoke: (i, x, s) =>
      applyRebaseRequest(
        i,
        x,
        s,
        { blockedOnto: "sha-onto", reason: "conflict", resolve: true },
        NOW,
      ),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["artifact.follow.asks.rebase"],
  },
  {
    name: "rebase-applied",
    verb: "rebase-applied",
    invoke: (i, x, s) => applyRebaseApplied(i, x, s, "sha-new"),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "artifact.tip",
      "artifact.follow.asks.rebase",
      "artifact.follow.probe.sig",
    ],
  },
  {
    name: "fix-start",
    verb: "fix-start",
    invoke: (i, x, s) => applyFixStart(i, x, s, "s1", false).state,
    frameNode: [P_RESTING, A_OPEN_FIX_PENDING],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.follow.attention",
      "artifact.follow.asks.fix.taken",
      "artifact.follow.ledger.fix_attempts",
      "artifact.follow.ledger.fix_cycle_tip",
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "rebase-start",
    verb: "rebase-start",
    invoke: (i, x, s) => applyRebaseStart(i, x, s, "s1"),
    frameNode: [P_RESTING, A_OPEN_REBASE_QUEUED],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.follow.asks.rebase.taken",
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "rebase-start/detour",
    verb: "rebase-start",
    invoke: (i, x, s) => applyRebaseStart(i, x, s, "s1"),
    frameNode: [P_FULL_FINALIZE, A_NODE_NONE],
    frame: ["run.phase", "run.attempts"],
  },
  {
    name: "rebase-give-up",
    verb: "rebase-give-up",
    invoke: (i, x, s) => applyRebaseGiveUp(i, x, s, "sha-onto2", NOW),
    frameNode: [P_CYCLE_REBASE, A_OPEN_REBASE_TAKEN],
    frame: [
      "progress",
      "run",
      "session",
      "artifact.follow.asks.rebase",
    ],
  },
  {
    name: "rebase-forgo",
    verb: "rebase-forgo",
    invoke: (i, x, s) => applyRebaseForgo(i, x, s, "sha-onto2", NOW),
    frameNode: [P_FULL_DETOUR, A_OPEN_IDLE],
    frame: ["run.phase", "run.attempts", "artifact.follow.asks.rebase"],
  },
  {
    name: "probe-run",
    verb: "probe-run",
    invoke: (i, x, s) => applyProbeRun(i, x, s, { proc: "bg-2" }, NOW),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "probe-exit",
    verb: "probe-exit",
    invoke: (i, x, s) => applyProbeExit(i, x, s, { sig: "sig-1" }),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
      "artifact.follow.probe.sig",
    ],
  },
  {
    name: "release",
    verb: "release",
    invoke: (i, x, s) => applyRelease(i, x, s),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "session",
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "observe",
    verb: "observe",
    invoke: (i, x, s) =>
      applyObserve(i, x, s, { head: "h1", ci: "failing" }).state,
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "session",
      "artifact.follow.attention",
      "artifact.follow.probe",
    ],
  },
  {
    name: "attention-set",
    verb: "attention-set",
    invoke: (i, x, s) => applyAttentionSet(i, x, s, "manual"),
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: [
      "session",
      "artifact.follow.attention",
      "artifact.follow.probe.errors",
      "artifact.follow.probe.proc",
      "artifact.follow.probe.proc_started_at",
    ],
  },
  {
    name: "review-only",
    verb: "review-only",
    invoke: (i, x, s) =>
      applyReviewOnly(i, x, s, [{ id: "r2", updated_at: "t2" }]).state,
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["artifact.follow.ledger.review_only"],
  },
  {
    name: "answered-set",
    verb: "answered-set",
    invoke: (i, x, s) =>
      applyAnsweredSet(i, x, s, [{ id: "q2", updated_at: "t2" }]).state,
    frameNode: [P_RESTING, A_OPEN_IDLE],
    frame: ["artifact.follow.ledger.answered"],
  },
  {
    name: "set-worktree",
    verb: "set-worktree",
    invoke: (i, x, s) => applySetWorktree(i, x, s, "/wt2", "dev", false),
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: ["worktree", "base"],
  },
  {
    name: "set-executor",
    verb: "set-executor",
    invoke: (i, x, s) => applySetExecutor(i, x, s, "agent-1", "s1", NOW),
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: ["run.executor", "run.executor_last_event_at", "session"],
  },
  {
    name: "touch-executor",
    verb: "touch-executor",
    invoke: (i, x, s) => applyTouchExecutor(i, x, s, undefined, NOW),
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: ["run.executor_last_event_at", "session"],
  },
  {
    name: "set-takeover",
    verb: "set-takeover",
    invoke: (i, x, s) => applySetTakeover(i, x, s, NOW),
    frameNode: [P_FULL_IMPLEMENT, A_NODE_NONE],
    frame: ["run.takeover_at"],
  },
];

// ---------------------------------------------------------------------------
// 形状検査 (設計3.1b の宣言と実装の突き合わせ)
// ---------------------------------------------------------------------------

// VerbSpecV2["a"] は「単一の軸」か「P ノードごとの軸の表」のどちらかなので、
// 全軸を平坦に取り出す小さなヘルパを置く。
function artifactAxesOf(spec: VerbSpecV2): ArtifactAxisSpec[] {
  const a = spec.a;
  return "byPNode" in a ? Object.values(a.byPNode) : [a];
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>);
}

function assertItemShape(item: V2Item, ctx: string): void {
  assertSameSet(keysOf(item), ITEM_SHAPE, `${ctx}: item shape`);
  if (item.run !== null) {
    assertSameSet(keysOf(item.run), RUN_SHAPE, `${ctx}: run shape`);
  }
  const artifact = item.artifact;
  assertSameSet(
    keysOf(artifact),
    ARTIFACT_SHAPES[artifact.state],
    `${ctx}: artifact(${artifact.state}) shape`,
  );
  if (artifact.state === "open" && artifact.follow !== null) {
    const f = artifact.follow;
    assertSameSet(keysOf(f), FOLLOW_SHAPE, `${ctx}: follow shape`);
    assertSameSet(keysOf(f.asks), ASKS_SHAPE, `${ctx}: asks shape`);
    assertSameSet(keysOf(f.ledger), LEDGER_SHAPE, `${ctx}: ledger shape`);
    assertSameSet(keysOf(f.probe), PROBE_SHAPE, `${ctx}: probe shape`);
    if (f.asks.fix !== null) {
      assertSameSet(keysOf(f.asks.fix), FIX_ASK_SHAPE, `${ctx}: fix ask shape`);
    }
    if (f.asks.rebase !== null) {
      assertSameSet(
        keysOf(f.asks.rebase),
        REBASE_ASK_SHAPE,
        `${ctx}: rebase ask shape`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 積の合法ノード (行列テストの入力集合)
//
// 不変条件1〜5 + gate iff をすべて満たす積ノードだけを入力にする。入力が既に不変条件を
// 破っていると、出力不変条件の違反が「verb の誤り」か「入力の持ち込み」か区別できない。
// 積の穴 (書けない組) の検査は到達可能性テスト側 (全 437) が担う。
// ---------------------------------------------------------------------------

function isCoherent(pKey: string, aKey: string): boolean {
  try {
    assertItemInvariantsV2(buildItem(pKey, aKey));
    return true;
  } catch {
    return false;
  }
}

const COHERENT_PRODUCT_NODES: readonly (readonly [PNodeKey, ANodeKey])[] =
  P_NODE_KEYS.flatMap((p) =>
    A_NODE_KEYS.filter((a) => isCoherent(p, a)).map((a) =>
      [p, a] as readonly [PNodeKey, ANodeKey]
    )
  );

// ---------------------------------------------------------------------------
// T-V2T-ALIGN: 宣言と実装の整合
// ---------------------------------------------------------------------------

Deno.test("T-V2T-ALIGN-1: VERB_SPEC keys and verb cases agree", () => {
  const caseVerbs = [...new Set(VERB_CASES.map((c) => c.verb))];
  // approve は from ノードを持たない新規追加なので行列/フレームの対象外 (v1 と同じ扱い)。
  const specVerbs = Object.keys(VERB_SPEC).filter((v) => v !== "approve");
  assertSameSet(caseVerbs, specVerbs, "verb cases vs VERB_SPEC keys");
  assertEquals(Object.keys(VERB_SPEC).length, 33, "verb count");
  assertEquals(
    new Set(VERB_CASES.map((c) => c.name)).size,
    VERB_CASES.length,
    "case names unique",
  );
});

Deno.test("T-V2T-ALIGN-2: every declared from/to node is a real node key", () => {
  for (const [verb, spec] of Object.entries(VERB_SPEC)) {
    for (const p of spec.p.from) {
      assert(
        (P_NODE_KEYS as readonly string[]).includes(p),
        `${verb}: unknown P from node ${p}`,
      );
    }
    if (
      spec.p.to !== "unchanged" && spec.p.to !== "dynamic" &&
      spec.p.to !== "removed"
    ) {
      assert(
        (P_NODE_KEYS as readonly string[]).includes(spec.p.to),
        `${verb}: unknown P to node ${spec.p.to}`,
      );
    }
    const axes = artifactAxesOf(spec);
    for (const axis of axes) {
      for (const a of axis.from) {
        assert(A_NODE_KEYS.includes(a), `${verb}: unknown A from node ${a}`);
      }
    }
  }
});

Deno.test("T-V2T-ALIGN-3: A node keys are the 23 nodes of design 1.5", () => {
  assertEquals(A_NODE_KEYS.length, 23);
  assertEquals(new Set(A_NODE_KEYS).size, 23, "A node keys unique");
  // 内訳: none 1 + merged 1 + withdrawn 2 + open(follow=null) 1 + open 18
  assertEquals(A_OPEN_FOLLOW_KEYS.length, 18);
  assert(A_NODE_KEYS.includes(A_NODE_NONE));
  assert(A_NODE_KEYS.includes(A_NODE_MERGED));
  assert(A_NODE_KEYS.includes(A_NODE_OPEN_NO_FOLLOW));
  assert(A_NODE_KEYS.includes(A_WITHDRAWN_UNASKED));
  assert(A_NODE_KEYS.includes(A_WITHDRAWN_ASKED));
  assertEquals(PRODUCT_NODE_KEYS.length, 19 * 23, "product node count");
  // restore の from は「merged だけを欠いた 22 ノード」であること (別々に宣言した
  // 2 つの部分集合が食い違わないことの固定)。
  assertSameSet(
    A_NODE_KEYS_EXCEPT_MERGED,
    A_NODE_KEYS.filter((k) => k !== A_NODE_MERGED),
    "A_NODE_KEYS_EXCEPT_MERGED == A_NODE_KEYS - merged",
  );
  assertEquals(A_NODE_KEYS_EXCEPT_MERGED.length, 22);
});

// 型が保証する部分 (3 軸の直積を覆っているか・キー文字列が座標と一致しているか) は
// A_OPEN_FOLLOW の mapped type + template literal type が担うので、ここでは見ない
// (壊すと deno check が落ちる — pr-fix-3.md に確認手順)。ここに残すのは型が見ない
// 集合の整合 = 「導出したノードキー集合が Record の値と過不足なく一致するか」だけ。
Deno.test("T-V2T-ALIGN-3b: derived key sets agree with the declared Record", () => {
  const declaredOpen: string[] = [];
  for (const byFix of Object.values(A_OPEN_FOLLOW)) {
    for (const byRebase of Object.values(byFix)) {
      for (const key of Object.values(byRebase)) declaredOpen.push(String(key));
    }
  }
  assertEquals(declaredOpen.length, 18, "the Record declares 18 open nodes");
  assertSameSet(A_OPEN_FOLLOW_KEYS, declaredOpen, "open keys == Record values");
  assertSameSet(
    A_NODE_KEYS,
    [
      A_NODE_NONE,
      A_NODE_MERGED,
      A_WITHDRAWN_UNASKED,
      A_WITHDRAWN_ASKED,
      A_NODE_OPEN_NO_FOLLOW,
      ...declaredOpen,
    ],
    "A node keys == singletons + Record values",
  );
  // キー → 座標の逆引き (Map) が平坦化ビューと一致すること。
  for (const node of A_OPEN_FOLLOW_NODES) {
    assertEquals(openNodeOf(node.key), node);
  }
  assertEquals(openNodeOf(A_NODE_OPEN_NO_FOLLOW), null);
  assertEquals(openNodeOf(A_NODE_NONE), null);
});

Deno.test("T-V2T-ALIGN-4: advance edges are exactly the main sequences plus the detour return", () => {
  const expected = [
    { axisKey: "initial/full", from: "research", to: "plan" },
    { axisKey: "initial/full", from: "plan", to: "implement" },
    { axisKey: "initial/full", from: "implement", to: "report" },
    { axisKey: "initial/full", from: "report", to: "finalize" },
    { axisKey: "initial/full", from: "rebase_fix", to: "finalize" },
    { axisKey: "initial/light", from: "research+plan", to: "implement" },
    { axisKey: "initial/light", from: "implement", to: "report" },
    { axisKey: "initial/light", from: "report", to: "finalize" },
    { axisKey: "initial/light", from: "rebase_fix", to: "finalize" },
    { axisKey: "pr_fix", from: "pr_fix", to: "finalize" },
    { axisKey: "pr_fix", from: "rebase_fix", to: "finalize" },
    { axisKey: "rebase_fix", from: "rebase_fix", to: "finalize" },
  ];
  assertSameSet(ADVANCE_EDGES, expected, "advance edges");

  // 全 (axis, from, to) 組の総当たりで、辺判定の真偽が期待と一致すること。
  const axisKeys = ["initial/full", "initial/light", "pr_fix", "rebase_fix"];
  const phases = [
    "research",
    "plan",
    "implement",
    "report",
    "research+plan",
    "finalize",
    "pr_fix",
    "rebase_fix",
    "bogus",
  ];
  for (const axisKey of axisKeys) {
    for (const from of phases) {
      for (const to of phases) {
        const want = expected.some((e) =>
          e.axisKey === axisKey && e.from === from && e.to === to
        );
        assertEquals(
          isAdvanceEdge(axisKey, from, to),
          want,
          `edge ${axisKey}: ${from} -> ${to}`,
        );
      }
    }
  }
  // finalize からの前進辺は無い (finalize の出口は ship か rebase-start 入口 b だけ)。
  assertEquals(
    ADVANCE_EDGES.filter((e) => e.from === "finalize"),
    [],
    "finalize has no advance edge",
  );
});

Deno.test("T-V2T-ALIGN-5: derived P node sets are coherent", () => {
  assertEquals(P_NODE_KEYS.length, 19);
  assertEquals(P_RUNNING_KEYS.length, 16);
  assertEquals(P_FINALIZE_KEYS.length, 4, "one finalize per run axis");
  assertEquals(P_VERIFIED_KEYS.length, 12, "running minus finalize");
  assertEquals(P_DETOUR_KEYS.length, 3, "detour phases (kind != rebase_fix)");
  assertEquals(P_CYCLE_REBASE_KEYS.length, 1, "the resolution-cycle run");
  // phase-fail の from は「検証ゲートを持つフェーズ」= running から finalize を除いたもの
  assertSameSet(
    VERB_SPEC["phase-fail"].p.from,
    P_VERIFIED_KEYS,
    "phase-fail from",
  );
  assertSameSet(VERB_SPEC["advance"].p.from, P_VERIFIED_KEYS, "advance from");
  // give-up と forgo の from は排他 (設計2.4)
  assertEquals(
    P_CYCLE_REBASE_KEYS.filter((k) => P_DETOUR_KEYS.includes(k)),
    [],
    "give-up and forgo from-sets must be disjoint",
  );
});

Deno.test("T-V2T-ALIGN-6: coherent product nodes equal the conjunction of invariants 1-5", () => {
  // 独立に書き下した述語で同じ集合が出ることを確かめる (assertItemInvariantsV2 の
  // フィルタが実は何も落としていない、という縮退を検出する)。
  const expected: string[] = [];
  for (const p of P_NODE_KEYS) {
    for (const a of A_NODE_KEYS) {
      const node = RUN_NODE_BY_KEY.get(p);
      const sub = parseOpenKey(a);
      // 不変条件2: merged は resting とだけ組める
      if (a === A_NODE_MERGED && p !== P_RESTING) continue;
      // 不変条件3: running(pr_fix) は open + follow + fix taken とだけ組める
      if (node?.kind === "pr_fix" && (sub === null || sub.fix !== "taken")) {
        continue;
      }
      // 不変条件5 の残差: taken は resting では持てない
      if (
        p === P_RESTING && sub !== null &&
        (sub.fix === "taken" || sub.rebase === "taken")
      ) {
        continue;
      }
      // 派生不変条件: run が居る間、taken の種類と run.kind は 1:1
      if (node !== undefined && sub !== null) {
        if (sub.fix === "taken" && node.kind !== "pr_fix") continue;
        if (sub.rebase === "taken" && node.kind !== "rebase_fix") continue;
      }
      expected.push(productKey(p, a));
    }
  }
  assertSameSet(
    COHERENT_PRODUCT_NODES.map(([p, a]) => productKey(p, a)),
    expected,
    "coherent product nodes",
  );
  assertEquals(COHERENT_PRODUCT_NODES.length, 233, "coherent node count");
});

Deno.test("T-V2T-ALIGN-7: frames are consistent with declared axes", () => {
  for (const c of VERB_CASES) {
    const spec = VERB_SPEC[c.verb];
    const axes = artifactAxesOf(spec);
    // その verb ケースの起点で解決した軸が untouched なら artifact は 1 バイトも
    // 変わらないはずなので、frame に artifact パスがあってはならない。
    const axis = resolveArtifactAxis(spec.a, c.frameNode[0]);
    if (axis.to === "untouched") {
      assertEquals(
        c.frame.filter((p) => p === "artifact" || p.startsWith("artifact.")),
        [],
        `${c.name}: artifact untouched but frame allows artifact paths`,
      );
    }
    if (axes.every((x) => x.to === "untouched")) {
      assertEquals(
        c.frame.filter((p) => p === "artifact" || p.startsWith("artifact.")),
        [],
        `${c.name}: all artifact axes untouched but frame allows artifact paths`,
      );
    }
    if (spec.p.to === "unchanged") {
      assertEquals(
        c.frame.filter((p) => p === "progress"),
        [],
        `${c.name}: progress must not change when p.to is "unchanged"`,
      );
    }
  }
});

Deno.test("T-V2T-ALIGN-8: frame fixtures cover every declared property", () => {
  // 形状宣言 (設計3.1b の表を data 化したもの) の全プロパティを最大フィクスチャが
  // 覆う。フィールドを足したらフィクスチャ追従が強制される (v1 の T-ALIGN-13 と同型)。
  const item = buildItem(P_PRFIX_PRFIX, A_OPEN_FIX_TAKEN);
  assertSameSet(keysOf(item), ITEM_SHAPE, "item fixture covers ITEM_SHAPE");
  assertSameSet(keysOf(item.run!), RUN_SHAPE, "run fixture covers RUN_SHAPE");
  const open = item.artifact as Extract<V2Artifact, { state: "open" }>;
  assertSameSet(
    keysOf(open),
    ARTIFACT_SHAPES.open,
    "open fixture covers ARTIFACT_SHAPES.open",
  );
  const follow = open.follow!;
  assertSameSet(keysOf(follow), FOLLOW_SHAPE, "follow fixture");
  assertSameSet(keysOf(follow.asks), ASKS_SHAPE, "asks fixture");
  assertSameSet(keysOf(follow.ledger), LEDGER_SHAPE, "ledger fixture");
  assertSameSet(keysOf(follow.probe), PROBE_SHAPE, "probe fixture");
  assertSameSet(keysOf(follow.asks.fix!), FIX_ASK_SHAPE, "fix ask fixture");
  assertSameSet(
    keysOf(rebaseAskFixture("quiet")!),
    REBASE_ASK_SHAPE,
    "rebase ask fixture",
  );
  assertSameSet(
    keysOf(artifactFixture(A_NODE_MERGED, false)),
    ARTIFACT_SHAPES.merged,
    "merged fixture",
  );
  assertSameSet(
    keysOf(artifactFixture(A_WITHDRAWN_ASKED, false)),
    ARTIFACT_SHAPES.withdrawn,
    "withdrawn fixture",
  );
  assertSameSet(
    keysOf(artifactFixture(A_NODE_NONE, false)),
    ARTIFACT_SHAPES.none,
    "none fixture",
  );
  // 新規作成される follow も同じ形であること
  assertSameSet(keysOf(freshFollow()), FOLLOW_SHAPE, "freshFollow shape");
  assertSameSet(
    keysOf(freshFollow().probe),
    PROBE_SHAPE,
    "freshFollow probe shape",
  );
});

Deno.test("T-V2T-ALIGN-9: no export or verb name resembles a retired v1 verb", () => {
  const retired = [
    "inreview",
    "watchinit",
    "watchset",
    "phasepass",
    "finalizestart",
    "fixdone",
    "fixpending",
    "rebaserecord",
    "rebaseresolvepending",
    "rebasedone",
    "recoverdone",
  ];
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const verb of Object.keys(VERB_SPEC)) {
    for (const r of retired) {
      assertFalse(
        normalize(verb) === r,
        `VERB_SPEC key "${verb}" is a retired v1 verb`,
      );
    }
  }
  return import("./state-transitions-v2.ts").then((mod) => {
    const names = Object.keys(mod);
    assert(names.length > 0, "module must export something");
    for (const name of names) {
      const n = normalize(name);
      for (const r of retired) {
        assertFalse(
          n.includes(r),
          `export "${name}" resembles retired v1 verb "${r}"`,
        );
      }
    }
  });
});

Deno.test("T-V2T-ALIGN-10: no run node named initial/light/research exists", () => {
  // v1 の gate 死に組 (4620c1f) の構造的封じ。gate が座標に入ったので、light の列に
  // research は存在しない。
  // #34 の PNodeKey がリテラルユニオンになったので、この組は**型としても**存在しない
  // (下の includes は string へ広げないとコンパイルが通らない)。実行時の検査は、
  // 型の外から来るキー文字列にも同じことが言えることの確認として残す。
  assertFalse(
    (P_NODE_KEYS as readonly string[]).includes(
      "running(initial,light,research)",
    ),
    "initial x light x research must not be a declared node",
  );
  assertEquals(INITIAL_GATE_PHASE_SEQUENCES.light[0], "research+plan");
  assertFalse(
    (INITIAL_GATE_PHASE_SEQUENCES.light as readonly string[]).includes(
      "research",
    ),
    "light sequence must not contain research",
  );
});

// ---------------------------------------------------------------------------
// T-V2T-MX: 行列テスト
// ---------------------------------------------------------------------------

function assertOutputInvariants(item: V2Item, ctx: string): void {
  assertItemInvariantsV2(item);
  assertItemShape(item, ctx);
}

function subAxesOf(aKey: string): OpenSubAxisTriple | null {
  return parseOpenKey(aKey);
}

function assertArtifactEffect(
  ctx: string,
  effect: string,
  inItem: V2Item,
  outItem: V2Item,
): void {
  const inKey = aNodeKeyOf(inItem) as string;
  const outKey = aNodeKeyOf(outItem) as string;
  const inSub = subAxesOf(inKey);
  switch (effect) {
    case "untouched":
      assertEquals(outItem.artifact, inItem.artifact, `${ctx}: not untouched`);
      break;
    case "unchanged":
      assertEquals(outKey, inKey, `${ctx}: artifact node changed`);
      break;
    case "cycle-reset":
      if (inSub === null) {
        assertEquals(
          outItem.artifact,
          inItem.artifact,
          `${ctx}: no follow, artifact must be untouched`,
        );
      } else {
        assertEquals(outKey, A_OPEN_IDLE, `${ctx}: cycle reset target`);
      }
      break;
    case "fix-pending":
      assert(inSub !== null, `${ctx}: fix-pending requires follow`);
      assertEquals(subAxesOf(outKey)!.fix, "pending", `${ctx}: fix axis`);
      assertEquals(
        subAxesOf(outKey)!.attention,
        inSub!.attention,
        `${ctx}: attention axis untouched`,
      );
      assertEquals(
        subAxesOf(outKey)!.rebase,
        inSub!.rebase,
        `${ctx}: rebase axis untouched`,
      );
      break;
    case "rebase-quiet":
      if (inSub === null) {
        assertEquals(
          outItem.artifact,
          inItem.artifact,
          `${ctx}: no follow, artifact must be untouched`,
        );
      } else {
        assertEquals(subAxesOf(outKey)!.rebase, "quiet", `${ctx}: rebase axis`);
      }
      break;
    case "rebase-taken":
      assert(inSub !== null, `${ctx}: rebase-taken requires follow`);
      assertEquals(subAxesOf(outKey)!.rebase, "taken", `${ctx}: rebase axis`);
      break;
    case "dynamic":
      break;
    default:
      assertEquals(outKey, effect, `${ctx}: artifact to-node`);
  }
}

Deno.test("T-V2T-MX-1: every verb fires exactly on its declared from-product and lands on its declared to", () => {
  let checked = 0;
  for (const c of VERB_CASES) {
    const spec: VerbSpecV2 = VERB_SPEC[c.verb];
    for (const [p, a] of COHERENT_PRODUCT_NODES) {
      const item = buildItem(p, a, c.overrides);
      const state = buildState(item, c.stateExtra);
      // 軸はノード別指定 (rebase-start) がありうるので、P の from に入っているときだけ
      // 解決する。入っていなければその時点で発火しない。
      const inPFrom = spec.p.from.includes(p);
      const axis = inPFrom ? resolveArtifactAxis(spec.a, p) : null;
      const expectedOk = inPFrom && (axis as ArtifactAxisSpec).from.includes(a);
      const ctx = `${c.name} @ ${productKey(p, a)}`;
      let next: V2State | null = null;
      let err: unknown = null;
      try {
        next = c.invoke(item, 0, state);
      } catch (e) {
        err = e;
      }
      checked++;
      if (!expectedOk) {
        assert(
          err !== null && err instanceof CliErrorV2 && err.code === "conflict",
          `${ctx}: expected conflict, got ${
            err === null ? "success" : String(err)
          }`,
        );
        continue;
      }
      assert(next !== null, `${ctx}: expected success, got ${String(err)}`);
      const outItem = itemOf(next as V2State);
      if (spec.p.to === "removed") {
        assert(outItem === undefined, `${ctx}: item should be removed`);
        continue;
      }
      assert(outItem !== undefined, `${ctx}: item disappeared`);
      assertOutputInvariants(outItem as V2Item, ctx);
      const landed = pNodeKeyOf(outItem as V2Item);
      assert(landed !== null, `${ctx}: unreachable progress output`);
      if (spec.p.to === "unchanged") {
        assertEquals(landed, p, `${ctx}: progress node changed`);
      } else if (spec.p.to !== "dynamic") {
        assertEquals(landed, spec.p.to, `${ctx}: wrong progress to-node`);
      }
      assertArtifactEffect(
        ctx,
        (axis as ArtifactAxisSpec).to,
        item,
        outItem as V2Item,
      );
    }
  }
  // 走査件数を固定して縮退 (フィクスチャの取りこぼしで行列が痩せること) を防ぐ。
  assertEquals(checked, COHERENT_PRODUCT_NODES.length * VERB_CASES.length);
  assertEquals(checked, 233 * 34);
});

Deno.test("T-V2T-MX-2: advance walks every run axis main sequence end to end", () => {
  const walks: Array<[string, string | null, readonly string[]]> = [
    ["initial", "full", [
      "research",
      "plan",
      "implement",
      "report",
      "finalize",
    ]],
    ["initial", "light", ["research+plan", "implement", "report", "finalize"]],
    ["pr_fix", null, ["pr_fix", "finalize"]],
    ["rebase_fix", null, ["rebase_fix", "finalize"]],
  ];
  for (const [kind, gate, seq] of walks) {
    const aKey = kind === "pr_fix"
      ? A_OPEN_FIX_TAKEN
      : (kind === "rebase_fix" ? A_OPEN_REBASE_TAKEN : A_NODE_NONE);
    let item = buildItem(runKey(kind, gate, seq[0]), aKey);
    let state = buildState(item);
    for (let i = 0; i < seq.length - 1; i++) {
      state = applyAdvance(item, 0, state, seq[i], seq[i + 1]);
      item = itemOf(state) as V2Item;
      assertEquals(
        pNodeKeyOf(item),
        runKey(kind, gate, seq[i + 1]),
        `${kind}/${gate}: step ${i}`,
      );
      assertEquals(item.run!.attempts, 0, `${kind}: attempts reset`);
      assertEquals(item.run!.kind, kind, `${kind}: kind preserved`);
      assertEquals(item.run!.gate, gate, `${kind}: gate preserved`);
    }
  }
});

Deno.test("T-V2T-MX-3: advance rejects non-adjacent, backward, cross-axis and detour-entry edges", () => {
  const item = buildItem(P_FULL_IMPLEMENT, A_NODE_NONE);
  const state = buildState(item);
  const bad: Array<[string, string]> = [
    ["implement", "finalize"], // 飛び越し
    ["implement", "plan"], // 逆行
    ["implement", "implement"], // 自己辺
    ["implement", "research+plan"], // 別 gate の列
    ["implement", "rebase_fix"], // 迂回への進入 (rebase-start の辺)
    ["implement", "pr_fix"], // 別 kind の列
  ];
  for (const [from, to] of bad) {
    let threw = false;
    try {
      applyAdvance(item, 0, state, from, to);
    } catch (e) {
      threw = true;
      assert(
        e instanceof CliErrorV2 && e.code === "conflict",
        `${from}->${to}: expected conflict, got ${String(e)}`,
      );
    }
    assert(threw, `${from} -> ${to} must be rejected`);
  }
  // --from が現在の phase と食い違うケース
  let threw = false;
  try {
    applyAdvance(item, 0, state, "plan", "implement");
  } catch (e) {
    threw = true;
    assert(e instanceof CliErrorV2 && e.code === "conflict");
  }
  assert(threw, "--from mismatch must be rejected");
  // finalize からの迂回復帰辺は合法
  const detour = buildItem(P_FULL_DETOUR, A_NODE_NONE);
  const out = applyAdvance(
    detour,
    0,
    buildState(detour),
    "rebase_fix",
    "finalize",
  );
  assertEquals(pNodeKeyOf(itemOf(out) as V2Item), P_FULL_FINALIZE);
});

Deno.test("T-V2T-MX-4: fix-start branches on the attempt cap", () => {
  // 上限内 (0,1,2 → 1,2,3 はすべて started)
  for (const before of [0, 1, 2]) {
    const item = withFixAttempts(
      buildItem(P_RESTING, A_OPEN_FIX_PENDING),
      before,
    );
    const r = applyFixStart(item, 0, buildState(item), "s1", false);
    assertEquals(r.started, true, `fix_attempts ${before} must start`);
    assertEquals(r.fixAttempts, before + 1);
    const out = itemOf(r.state) as V2Item;
    assertEquals(pNodeKeyOf(out), P_PRFIX_PRFIX, "lands on pr_fix");
    assertEquals(aNodeKeyOf(out), A_OPEN_FIX_TAKEN, "fix ask consumed (taken)");
    assertEquals(out.session, "s1");
    assertEquals(followOfItem(out).probe.proc, null, "lease released");
    assertOutputInvariants(out, "fix-start under cap");
  }
  // 上限ちょうどを超える (3 → 4)
  const capItem = withFixAttempts(buildItem(P_RESTING, A_OPEN_FIX_PENDING), 3);
  const capped = applyFixStart(capItem, 0, buildState(capItem), "s1", false);
  assertEquals(capped.started, false, "cap reached");
  assertEquals(capped.fixAttempts, 4);
  const capOut = itemOf(capped.state) as V2Item;
  assertEquals(pNodeKeyOf(capOut), P_RESTING, "stays resting");
  assertEquals(
    aNodeKeyOf(capOut),
    openNodeKey("human", "pending", "quiet"),
    "attention latches to human, fix ask stays pending",
  );
  assertEquals(followOfItem(capOut).attention, { human: "fix_limit" });
  assertEquals(capOut.session, null, "session released at cap");
  assertEquals(followOfItem(capOut).ledger.fix_attempts, 4);
  assertOutputInvariants(capOut, "fix-start at cap");
  // ラッチ後は from 前提 (attention==auto) が偽になり、この verb 自体が撥ねられる
  let threw = false;
  try {
    applyFixStart(capOut, 0, capped.state, "s1", false);
  } catch (e) {
    threw = true;
    assert(e instanceof CliErrorV2 && e.code === "conflict");
  }
  assert(threw, "latched attention must block a second fix-start");
  // --reset-attempts で上限超の状態から上限内へ戻せる
  const reset = applyFixStart(capItem, 0, buildState(capItem), "s1", true);
  assertEquals(reset.started, true, "reset restarts the counter");
  assertEquals(reset.fixAttempts, 1);
});

Deno.test("T-V2T-MX-5: rebase-start has two entries with different effects", () => {
  // 入口 (a): resting からの解決サイクル
  const restingItem = buildItem(P_RESTING, A_OPEN_REBASE_QUEUED);
  const a = applyRebaseStart(restingItem, 0, buildState(restingItem), "s1");
  const aOut = itemOf(a) as V2Item;
  assertEquals(pNodeKeyOf(aOut), P_CYCLE_REBASE, "dedicated rebase_fix run");
  assertEquals(aOut.run!.kind, "rebase_fix");
  assertEquals(aOut.run!.gate, null);
  assertEquals(aNodeKeyOf(aOut), A_OPEN_REBASE_TAKEN, "ask consumed");
  assertEquals(followOfItem(aOut).probe.proc, null, "lease released");
  assertEquals(aOut.session, "s1");
  assertOutputInvariants(aOut, "rebase-start entry a");

  // 入口 (b): finalize からの迂回 — kind・gate 不変、asks に触れない
  for (const pKey of P_FINALIZE_KEYS) {
    const node = RUN_NODE_BY_KEY.get(pKey)!;
    const aKey = node.kind === "pr_fix"
      ? A_OPEN_FIX_TAKEN
      : (node.kind === "rebase_fix" ? A_OPEN_REBASE_TAKEN : A_OPEN_IDLE);
    const item = buildItem(pKey, aKey);
    const out = itemOf(
      applyRebaseStart(item, 0, buildState(item), "s1"),
    ) as V2Item;
    assertEquals(out.run!.kind, node.kind, `${pKey}: kind preserved`);
    assertEquals(out.run!.gate, node.gate, `${pKey}: gate preserved`);
    assertEquals(out.run!.phase, "rebase_fix", `${pKey}: phase moved`);
    assertEquals(out.run!.attempts, 0, `${pKey}: attempts reset`);
    assertEquals(out.artifact, item.artifact, `${pKey}: artifact untouched`);
    assertOutputInvariants(out, `rebase-start entry b @ ${pKey}`);
  }
});

Deno.test("T-V2T-MX-6: rebase-give-up and rebase-forgo have disjoint from-sets", () => {
  // give-up は解決サイクル (kind==rebase_fix) 専用
  const cycle = buildItem(P_CYCLE_REBASE, A_OPEN_REBASE_TAKEN);
  const gaveUp = itemOf(
    applyRebaseGiveUp(cycle, 0, buildState(cycle), "sha-onto2", NOW),
  ) as V2Item;
  assertEquals(pNodeKeyOf(gaveUp), P_RESTING);
  assertEquals(aNodeKeyOf(gaveUp), A_OPEN_IDLE, "ask back to quiet guard");
  assertEquals(followOfItem(gaveUp).asks.rebase!.blocked_onto, "sha-onto2");
  assertEquals(followOfItem(gaveUp).asks.rebase!.reason, "conflict");
  assertEquals(gaveUp.session, null);
  // 迂回ノードで give-up は撥ねられる
  assertConflict(
    () =>
      applyRebaseGiveUp(
        buildItem(P_FULL_DETOUR, A_OPEN_IDLE),
        0,
        buildState(buildItem(P_FULL_DETOUR, A_OPEN_IDLE)),
        "sha",
        NOW,
      ),
    "give-up must not fire on a detour node",
  );
  // forgo は迂回 (kind != rebase_fix) 専用で、finalize へ戻す
  const detour = buildItem(P_FULL_DETOUR, A_OPEN_IDLE);
  const forgone = itemOf(
    applyRebaseForgo(detour, 0, buildState(detour), "sha-onto3", NOW),
  ) as V2Item;
  assertEquals(pNodeKeyOf(forgone), P_FULL_FINALIZE, "back to finalize");
  assertEquals(forgone.run!.kind, "initial", "kind preserved");
  assertEquals(forgone.run!.gate, "full", "gate preserved");
  assertEquals(followOfItem(forgone).asks.rebase!.blocked_onto, "sha-onto3");
  assertEquals(followOfItem(forgone).asks.rebase!.resolve, false);
  assertEquals(followOfItem(forgone).asks.rebase!.taken, false);
  // 解決サイクルのノードで forgo は撥ねられる
  assertConflict(
    () => applyRebaseForgo(cycle, 0, buildState(cycle), "sha", NOW),
    "forgo must not fire on the resolution-cycle node",
  );
  // follow を持たない artifact でも forgo は通り、A は 1 バイトも変わらない
  const bare = buildItem(P_FULL_DETOUR, A_NODE_NONE);
  const bareOut = itemOf(
    applyRebaseForgo(bare, 0, buildState(bare), "sha", NOW),
  ) as V2Item;
  assertEquals(
    bareOut.artifact,
    bare.artifact,
    "no follow: artifact untouched",
  );
});

Deno.test("T-V2T-MX-7: observe latches attention at the error limit in one write", () => {
  // 0 -> 1 / 1 -> 2 はラッチしない
  for (const before of [0, 1]) {
    const item = withErrors(buildItem(P_RESTING, A_OPEN_IDLE), before);
    const r = applyObserve(item, 0, buildState(item), { errorsInc: true });
    assertEquals(r.errors, before + 1);
    assertEquals(r.latched, false, `errors ${before} -> ${before + 1}`);
    const out = itemOf(r.state) as V2Item;
    assertEquals(followOfItem(out).attention, "auto");
    assertEquals(out.session, "s0", "session kept below the limit");
    assertEquals(followOfItem(out).probe.proc, "bg-1", "lease kept");
  }
  // 2 -> 3 (境界ちょうど) で同じ書き込みに attention / session / lease が畳まれる
  const item = withErrors(buildItem(P_RESTING, A_OPEN_IDLE), 2);
  const r = applyObserve(item, 0, buildState(item), { errorsInc: true });
  assertEquals(r.errors, 3);
  assertEquals(r.latched, true);
  const out = itemOf(r.state) as V2Item;
  assertEquals(followOfItem(out).attention, { human: "errors" });
  assertEquals(out.session, null, "session released with the latch");
  assertEquals(followOfItem(out).probe.proc, null, "lease dropped");
  assertEquals(followOfItem(out).probe.proc_started_at, null);
  assertEquals(aNodeKeyOf(out), openNodeKey("human", "null", "quiet"));
  assertOutputInvariants(out, "observe latch");
  // 3 -> 4 (既にラッチ済み) でも同じ扱い (冪等)
  const again = applyObserve(
    withErrors(buildItem(P_RESTING, A_OPEN_IDLE), 3),
    0,
    buildState(withErrors(buildItem(P_RESTING, A_OPEN_IDLE), 3)),
    { errorsInc: true },
  );
  assertEquals(again.errors, 4);
  assertEquals(again.latched, true);
  // --errors-reset はラッチを起こさない
  const reset = applyObserve(
    withErrors(buildItem(P_RESTING, A_OPEN_IDLE), 2),
    0,
    buildState(withErrors(buildItem(P_RESTING, A_OPEN_IDLE), 2)),
    { errorsReset: true },
  );
  assertEquals(reset.errors, 0);
  assertEquals(reset.latched, false);
  // --sig-clear
  const cleared = applyObserve(
    buildItem(P_RESTING, A_OPEN_IDLE),
    0,
    buildState(buildItem(P_RESTING, A_OPEN_IDLE)),
    { sigClear: true },
  );
  assertEquals(followOfItem(itemOf(cleared.state) as V2Item).probe.sig, null);
});

Deno.test("T-V2T-MX-8: attention-set switches intent both ways", () => {
  const reasons: HumanAttentionReason[] = ["fix_limit", "errors", "manual"];
  for (const reason of reasons) {
    const item = buildItem(P_RESTING, A_OPEN_IDLE);
    const out = itemOf(
      applyAttentionSet(item, 0, buildState(item), reason),
    ) as V2Item;
    assertEquals(followOfItem(out).attention, { human: reason });
    assertEquals(out.session, null, `--human ${reason} releases session`);
    assertEquals(followOfItem(out).probe.proc, null, "lease dropped");
    assertOutputInvariants(out, `attention-set --human ${reason}`);
  }
  // --auto は errors も 0 に戻す (戻さないと復帰後の最初の 1 エラーで即再ラッチする)
  const human = withErrors(
    buildItem(P_RESTING, openNodeKey("human", "null", "quiet")),
    2,
  );
  const back = itemOf(
    applyAttentionSet(human, 0, buildState(human), "auto"),
  ) as V2Item;
  assertEquals(followOfItem(back).attention, "auto");
  assertEquals(followOfItem(back).probe.errors, 0, "errors reset on resume");
  assertEquals(aNodeKeyOf(back), A_OPEN_IDLE);
});

Deno.test("T-V2T-MX-9: rebase-request upserts and only --resolve queues the cycle", () => {
  const item = buildItem(P_RESTING, A_OPEN_IDLE);
  // --resolve 有り: 解決サイクル行きが立つ
  const queued = itemOf(
    applyRebaseRequest(item, 0, buildState(item), {
      blockedOnto: "sha-onto",
      reason: "diverged",
      resolve: true,
    }, NOW),
  ) as V2Item;
  assertEquals(aNodeKeyOf(queued), A_OPEN_REBASE_QUEUED);
  assertEquals(followOfItem(queued).asks.rebase!.at, NOW0, "existing at kept");
  assertEquals(followOfItem(queued).asks.rebase!.blocked_onto, "sha-onto");
  assertEquals(followOfItem(queued).asks.rebase!.reason, "diverged");
  // --resolve 省略: 既存の resolve をそのまま保つ (v1 の rebase-record の挙動)
  const kept = itemOf(
    applyRebaseRequest(queued, 0, buildState(queued), {
      blockedOnto: "sha-onto2",
      reason: "push",
    }, NOW),
  ) as V2Item;
  assertEquals(aNodeKeyOf(kept), A_OPEN_REBASE_QUEUED, "resolve preserved");
  // --resolve false: 明示的に降格できる
  const demoted = itemOf(
    applyRebaseRequest(queued, 0, buildState(queued), {
      blockedOnto: "sha-onto2",
      reason: "push",
      resolve: false,
    }, NOW),
  ) as V2Item;
  assertEquals(aNodeKeyOf(demoted), A_OPEN_IDLE, "demoted to quiet guard");
  // 新規レコード: at は now
  const bare = buildItem(P_RESTING, A_OPEN_IDLE);
  const bareFollow = followOfItem(bare);
  const noRecord: V2Item = {
    ...bare,
    artifact: {
      ...(bare.artifact as Extract<V2Artifact, { state: "open" }>),
      follow: {
        ...bareFollow,
        asks: { ...bareFollow.asks, rebase: null },
      },
    },
  };
  const fresh = itemOf(
    applyRebaseRequest(noRecord, 0, buildState(noRecord), {
      blockedOnto: "sha-onto",
      reason: "conflict",
      kind: "overlap",
      cause: "cause",
      report: "/report",
      fromTip: "sha-old",
    }, NOW),
  ) as V2Item;
  assertEquals(followOfItem(fresh).asks.rebase!.at, NOW, "new record uses now");
  assertEquals(followOfItem(fresh).asks.rebase!.kind, "overlap");
  assertEquals(followOfItem(fresh).asks.rebase!.taken, false);
});

Deno.test("T-V2T-MX-10: no verb outputs an intentionally unreachable product node", () => {
  // 4.2節が行列テストの責務としている逆向きの保証。
  const banned = new Set(INTENTIONALLY_UNREACHABLE);
  for (const c of VERB_CASES) {
    const spec: VerbSpecV2 = VERB_SPEC[c.verb];
    for (const [p, a] of COHERENT_PRODUCT_NODES) {
      if (!spec.p.from.includes(p)) continue;
      const axis = resolveArtifactAxis(spec.a, p);
      if (!axis.from.includes(a)) continue;
      // 起点そのものが到達不能なら、その出力が禁止ノードでも意味が無い
      // (「到達可能な状態からは禁止ノードを作れない」が 4.2 の求める保証)。
      if (banned.has(productKey(p, a))) continue;
      const item = buildItem(p, a, c.overrides);
      const out = itemOf(c.invoke(item, 0, buildState(item, c.stateExtra)));
      if (out === undefined) continue;
      const key = productKeyOf(out) as string;
      assertFalse(
        banned.has(key),
        `${c.name} @ ${productKey(p, a)} produced a banned node: ${key}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// T-V2T-FRAME: 書き換え許可パスの検査
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
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(prefix);
}

function frameAllows(frame: readonly string[], path: string): boolean {
  return frame.some((f) => path === f || path.startsWith(`${f}.`));
}

Deno.test("T-V2T-FRAME-1: each verb only changes paths inside its declared frame", () => {
  for (const c of VERB_CASES) {
    const spec = VERB_SPEC[c.verb];
    const item = buildItem(c.frameNode[0], c.frameNode[1], c.overrides);
    const state = buildState(item, c.stateExtra);
    const before = JSON.parse(JSON.stringify(item));
    const next = c.invoke(item, 0, state);
    const outItem = itemOf(next);
    if (spec.p.to === "removed") {
      assert(outItem === undefined, `${c.name}: expected removal`);
      continue;
    }
    assert(outItem !== undefined, `${c.name}: item disappeared`);
    const changed: string[] = [];
    diffPaths(before, outItem, "", changed);
    assertEquals(
      changed.filter((p) => !frameAllows(c.frame, p)),
      [],
      `${c.name}: changed paths outside frame`,
    );
    // フレームが空回りしていないこと (verb が何も書かないなら宣言も空のはず)
    if (c.frame.length > 0) {
      assert(
        changed.length > 0,
        `${c.name}: frame declared but nothing changed`,
      );
    }
  }
});

Deno.test("T-V2T-FRAME-2: the frame check detects a follow-dropping ship (self test)", () => {
  // v1 の T-FRAME-2 と同型の自己テスト: 「宣言していない領域のフィールドに触れた実装」を
  // フレーム検査が実際に落とせることを確かめる。ここでは ship がグループ欄を新規
  // リテラルで置いて follow を作り直す (= 旧 in-review 相当) 誤実装を与える。
  const c = VERB_CASES.find((v) => v.name === "ship") as VerbCase;
  const item = buildItem(c.frameNode[0], c.frameNode[1]);
  const before = JSON.parse(JSON.stringify(item));
  const broken: V2Item = {
    ...item,
    progress: "resting",
    run: null,
    artifact: {
      state: "open",
      ...SHIP_GROUP,
      follow: freshFollow(),
    },
  };
  const changed: string[] = [];
  diffPaths(before, broken, "", changed);
  const violations = changed.filter((p) => !frameAllows(c.frame, p));
  assert(
    violations.some((p) => p.startsWith("artifact.follow.")),
    `follow replacement must violate the frame, got: ${
      JSON.stringify(violations)
    }`,
  );
  // 具体的に、周回の記憶 (fix_attempts / review_only) の破壊が見えていること
  assert(
    violations.includes("artifact.follow.ledger.fix_attempts"),
    `fix_attempts loss must be visible, got: ${JSON.stringify(violations)}`,
  );
  // 正しい実装ではその違反が出ないこと (自己テストが常に真になっていない確認)
  const good = itemOf(c.invoke(item, 0, buildState(item))) as V2Item;
  const goodChanged: string[] = [];
  diffPaths(before, good, "", goodChanged);
  assertEquals(
    goodChanged.filter((p) => !frameAllows(c.frame, p)),
    [],
    "the real ship must stay inside its frame",
  );
});

// ---------------------------------------------------------------------------
// T-V2T-REACH: 到達可能性 (#34 の枠に実辺を接続する)
// ---------------------------------------------------------------------------

interface ReachVariant {
  label: string;
  // 座標を変えないフィクスチャ調整 (上限・エラー数など軸外のデータ)
  patch?: (item: V2Item) => V2Item;
  run: (item: V2Item, index: number, state: V2State) => V2State;
}

const REACH_VARIANTS: readonly ReachVariant[] = [
  { label: "claim", run: (i, x, s) => applyClaim(i, x, s, "s1") },
  { label: "set-gate", run: (i, x, s) => applySetGate(i, x, s) },
  {
    label: "advance",
    run: (i, x, s) =>
      applyAdvance(i, x, s, i.run!.phase, advanceTargetsOf(i.run!)[0]),
  },
  {
    label: "phase-fail",
    run: (i, x, s) => applyPhaseFail(i, x, s, i.run!.phase).state,
  },
  { label: "block", run: (i, x, s) => applyBlock(i, x, s, "reason") },
  { label: "restore", run: (i, x, s) => applyRestore(i, x, s) },
  {
    label: "ship/commits0",
    run: (i, x, s) => applyShip(i, x, s, { commits: 0 }).state,
  },
  {
    label: "ship/pr",
    run: (i, x, s) => applyShip(i, x, s, { commits: 1, ...SHIP_GROUP }).state,
  },
  {
    label: "ship/commit-ref",
    run: (i, x, s) =>
      applyShip(i, x, s, { commits: 1, ...SHIP_GROUP, ref: COMMIT_REF }).state,
  },
  { label: "merged", run: (i, x, s) => applyMerged(i, x, s) },
  { label: "withdraw", run: (i, x, s) => applyWithdraw(i, x, s) },
  { label: "withdraw-asked", run: (i, x, s) => applyWithdrawAsked(i, x, s) },
  {
    label: "fix-request",
    run: (i, x, s) => applyFixRequest(i, x, s, ["c9"], "/f"),
  },
  {
    label: "rebase-request/resolve",
    run: (i, x, s) =>
      applyRebaseRequest(i, x, s, {
        blockedOnto: "sha",
        reason: "conflict",
        resolve: true,
      }, NOW),
  },
  {
    label: "rebase-request/quiet",
    run: (i, x, s) =>
      applyRebaseRequest(i, x, s, {
        blockedOnto: "sha",
        reason: "conflict",
        resolve: false,
      }, NOW),
  },
  {
    label: "rebase-applied",
    run: (i, x, s) => applyRebaseApplied(i, x, s, "sha-new"),
  },
  {
    label: "fix-start",
    run: (i, x, s) => applyFixStart(i, x, s, "s1", false).state,
  },
  {
    label: "fix-start/cap",
    patch: (i) => withFixAttempts(i, 3),
    run: (i, x, s) => applyFixStart(i, x, s, "s1", false).state,
  },
  { label: "rebase-start", run: (i, x, s) => applyRebaseStart(i, x, s, "s1") },
  {
    label: "rebase-give-up",
    run: (i, x, s) => applyRebaseGiveUp(i, x, s, "sha", NOW),
  },
  {
    label: "rebase-forgo",
    run: (i, x, s) => applyRebaseForgo(i, x, s, "sha", NOW),
  },
  {
    label: "probe-run",
    run: (i, x, s) => applyProbeRun(i, x, s, { proc: "bg-9" }, NOW),
  },
  {
    label: "probe-run/session",
    run: (i, x, s) =>
      applyProbeRun(i, x, s, { proc: "bg-9", session: "s9" }, NOW),
  },
  { label: "probe-exit", run: (i, x, s) => applyProbeExit(i, x, s, {}) },
  {
    label: "probe-exit/sig",
    run: (i, x, s) => applyProbeExit(i, x, s, { sig: "sig-9" }),
  },
  { label: "release", run: (i, x, s) => applyRelease(i, x, s) },
  {
    label: "observe/inc",
    run: (i, x, s) => applyObserve(i, x, s, { errorsInc: true }).state,
  },
  {
    label: "observe/latch",
    patch: (i) => withErrors(i, 2),
    run: (i, x, s) => applyObserve(i, x, s, { errorsInc: true }).state,
  },
  {
    label: "observe/reset",
    run: (i, x, s) => applyObserve(i, x, s, { errorsReset: true }).state,
  },
  {
    label: "attention-set/auto",
    run: (i, x, s) => applyAttentionSet(i, x, s, "auto"),
  },
  {
    label: "attention-set/manual",
    run: (i, x, s) => applyAttentionSet(i, x, s, "manual"),
  },
  {
    label: "review-only",
    run: (i, x, s) =>
      applyReviewOnly(i, x, s, [{ id: "r9", updated_at: "t" }]).state,
  },
  {
    label: "answered-set",
    run: (i, x, s) =>
      applyAnsweredSet(i, x, s, [{ id: "q9", updated_at: "t" }]).state,
  },
  {
    label: "set-worktree",
    run: (i, x, s) => applySetWorktree(i, x, s, "/wt2", "dev", false),
  },
  {
    label: "set-executor",
    run: (i, x, s) => applySetExecutor(i, x, s, "agent-1", "s1", NOW),
  },
  {
    label: "touch-executor",
    run: (i, x, s) => applyTouchExecutor(i, x, s, undefined, NOW),
  },
  { label: "set-takeover", run: (i, x, s) => applySetTakeover(i, x, s, NOW) },
];

function splitProductKey(key: string): [string, string] {
  const i = key.indexOf(" × ");
  return [key.slice(0, i), key.slice(i + 3)];
}

interface ReachResult {
  edges: ReachabilityEdge<string>[];
  visited: Set<string>;
}

function exploreReachability(): ReachResult {
  const start = productKey(P_QUEUED, A_NODE_NONE);
  const visited = new Set<string>([start]);
  const edges: ReachabilityEdge<string>[] = [];
  const frontier: string[] = [start];
  while (frontier.length > 0) {
    const current = frontier.shift() as string;
    const [p, a] = splitProductKey(current);
    for (const v of REACH_VARIANTS) {
      const base = buildItem(p, a);
      const item = v.patch ? v.patch(base) : base;
      const state = buildState(item, RELISTED_EXTRA);
      let out: V2State;
      try {
        out = v.run(item, 0, state);
      } catch {
        continue;
      }
      const outItem = itemOf(out);
      if (outItem === undefined) continue;
      assertItemInvariantsV2(outItem);
      const to = productKeyOf(outItem) as string;
      edges.push({ from: current, to });
      if (!visited.has(to)) {
        visited.add(to);
        frontier.push(to);
      }
    }
  }
  return { edges, visited };
}

// ---------------------------------------------------------------------------
// 意図的到達不能ノード (設計4.2「明示リスト」)
//
// 規則ごとに根拠を書く。テストはこのリストと実測の unreached が**集合として一致**する
// ことを要求する (超集合ではなく一致) — 過度に広い規則が死に組を黙って飲み込むことを
// 防ぐためで、到達性が増減したら必ず落ちて理由の書き直しを強制する。
// ---------------------------------------------------------------------------

interface UnreachableRule {
  id: string;
  why: string;
  holds: (p: string, a: string) => boolean;
}

const UNREACHABLE_RULES: readonly UnreachableRule[] = [
  {
    id: "inv2",
    why: "不変条件2: merged は resting とだけ組める",
    holds: (p, a) => a === A_NODE_MERGED && p !== P_RESTING,
  },
  {
    id: "inv3",
    why: "不変条件3: running(pr_fix) は open + follow + fix taken とだけ組める",
    holds: (p, a) => {
      const node = RUN_NODE_BY_KEY.get(p);
      if (node?.kind !== "pr_fix") return false;
      const sub = parseOpenKey(a);
      return sub === null || sub.fix !== "taken";
    },
  },
  {
    id: "inv5",
    why:
      "不変条件5の残差: 仕上げ run の出口 (ship / rebase-give-up) がすべて taken を" +
      "消費・解除するので、resting に taken は残らない",
    holds: (p, a) => {
      if (p !== P_RESTING) return false;
      const sub = parseOpenKey(a);
      return sub !== null && (sub.fix === "taken" || sub.rebase === "taken");
    },
  },
  {
    id: "running-attention-auto",
    why:
      "attention を human にできる verb (attention-set / fix-start の上限ラッチ / " +
      "observe のエラーラッチ) はすべて from が resting 専用で、running への入口 " +
      "(claim は auto へ戻す・fix-start / rebase-start は auto を要求する) が auto を" +
      "保証する。したがって running 中に human は現れない",
    holds: (p, a) => {
      if (!RUN_NODE_BY_KEY.has(p)) return false;
      const sub = parseOpenKey(a);
      return sub !== null && sub.attention === "human";
    },
  },
  {
    id: "initial-run-asks-empty",
    why:
      "claim の周回リセット (2.3) が asks を両方 null に戻し、running 中に asks を" +
      "書ける verb が無い (不変条件5: 受理は resting 専用)。rebase-forgo が置く" +
      "ガード控えも quiet 座標なので、initial の run 中の open は (auto,null,quiet) だけ",
    holds: (p, a) => {
      const node = RUN_NODE_BY_KEY.get(p);
      if (node?.kind !== "initial") return false;
      const sub = parseOpenKey(a);
      return sub !== null && !(sub.fix === "null" && sub.rebase === "quiet");
    },
  },
  {
    id: "fix-taken-only-pr-fix",
    why:
      "fix ask に taken を立てるのは fix-start だけで、その着地は running(pr_fix)。" +
      "迂回は kind を変えない (2.4) ので、taken を持つ run の kind は pr_fix に限る",
    holds: (p, a) => {
      const node = RUN_NODE_BY_KEY.get(p);
      if (node === undefined) return false;
      const sub = parseOpenKey(a);
      return sub !== null && sub.fix === "taken" && node.kind !== "pr_fix";
    },
  },
  {
    id: "cycle-run-shape",
    why:
      "kind==rebase_fix の run に入る唯一の経路は rebase-start 入口 (a) で、その from は " +
      "resting × open(attention=auto, rebase=queued)。着地は rebase ask が taken の open " +
      "だけなので、それ以外の artifact とは組めない",
    holds: (p, a) => {
      const node = RUN_NODE_BY_KEY.get(p);
      if (node?.kind !== "rebase_fix") return false;
      const sub = parseOpenKey(a);
      return sub === null || sub.rebase !== "taken";
    },
  },
  {
    id: "rebase-taken-only-cycle",
    why:
      "rebase ask に taken を立てるのは rebase-start 入口 (a) だけで、その着地は " +
      "kind==rebase_fix の run。迂回は kind を変えない (2.4) ので、taken を持つ run の " +
      "kind は rebase_fix に限る (fix-taken-only-pr-fix の鏡像)",
    holds: (p, a) => {
      const node = RUN_NODE_BY_KEY.get(p);
      if (node === undefined) return false;
      const sub = parseOpenKey(a);
      return sub !== null && sub.rebase === "taken" &&
        node.kind !== "rebase_fix";
    },
  },
  {
    id: "blocked-inherits-running",
    why:
      "blocked へ入る唯一の経路は block (from は running) で、A には触れない。" +
      "したがって blocked の A は running で到達できる A に限られる",
    holds: (p, a) => {
      if (p !== P_BLOCKED) return false;
      const sub = parseOpenKey(a);
      if (sub === null) return false;
      return !REACHABLE_RUNNING_OPEN_SUBAXES.has(a);
    },
  },
  {
    id: "queued-inherits",
    why:
      "queued へ入る経路は approve (artifact=none) と restore (from は resting/blocked、" +
      "A に触れない) だけ。したがって queued の open 座標は resting か blocked で" +
      "到達できるものに限られる",
    holds: (p, a) => {
      if (p !== P_QUEUED) return false;
      const sub = parseOpenKey(a);
      if (sub === null) return false;
      return !RESTING_OPEN_SUBAXES.has(a) &&
        !REACHABLE_RUNNING_OPEN_SUBAXES.has(a);
    },
  },
];

// running 中に到達できる open 座標 (規則 blocked-inherits-running / queued-inherits が
// 参照する)。上の 4 規則 (running-attention-auto / initial-run-asks-empty /
// fix-taken-only-pr-fix / cycle-run-shape) の帰結を書き下したもの。
const REACHABLE_RUNNING_OPEN_SUBAXES: ReadonlySet<string> = new Set([
  // initial の run
  openNodeKey("auto", "null", "quiet"),
  // pr_fix の run (fix-start が rebase 軸に触れないので quiet / queued の両方)
  openNodeKey("auto", "taken", "quiet"),
  openNodeKey("auto", "taken", "queued"),
  // rebase_fix の run (rebase-start 入口 a が fix 軸に触れない)
  openNodeKey("auto", "null", "taken"),
  openNodeKey("auto", "pending", "taken"),
]);

// resting で到達できる open 座標 = taken を含まない 8 通り (不変条件5の残差)。
const RESTING_OPEN_SUBAXES: ReadonlySet<string> = new Set(
  A_OPEN_FOLLOW_NODES
    .filter((n) => n.fix !== "taken" && n.rebase !== "taken")
    .map((n) => n.key),
);

const INTENTIONALLY_UNREACHABLE: readonly string[] = PRODUCT_NODE_KEYS.filter(
  (key) => {
    const [p, a] = splitProductKey(key);
    return UNREACHABLE_RULES.some((r) => r.holds(p, a));
  },
);

const REACH = exploreReachability();

Deno.test("T-V2T-REACH-1: real edges reach everything outside the declared list", () => {
  const result = checkReachability(
    PRODUCT_NODE_KEYS,
    REACH.edges,
    productKey(P_QUEUED, A_NODE_NONE),
    INTENTIONALLY_UNREACHABLE,
  );
  assertEquals(
    result.unexpectedUnreachable,
    [],
    "unexpected unreachable product nodes (dead combos)",
  );
  assertEquals(result.ok, true);
  assert(REACH.edges.length > 0, "must have produced real edges");
  // 実測値を固定して縮退 (バリアントの取りこぼしで探索が痩せること) を防ぐ。
  assertEquals(REACH.visited.size, 103, "reachable product nodes");
  assertEquals(REACH.edges.length, 684, "real edges produced by the verbs");
  assertEquals(
    REACH.visited.size + INTENTIONALLY_UNREACHABLE.length,
    PRODUCT_NODE_KEYS.length,
    "reachable + declared-unreachable must partition the product",
  );
});

Deno.test("T-V2T-REACH-2: the declared list equals the measured unreachable set", () => {
  const result = checkReachability(
    PRODUCT_NODE_KEYS,
    REACH.edges,
    productKey(P_QUEUED, A_NODE_NONE),
    INTENTIONALLY_UNREACHABLE,
  );
  const measured = new Set(result.unreached);
  const declared = new Set(INTENTIONALLY_UNREACHABLE);
  assertEquals(
    [...declared].filter((k) => !measured.has(k)),
    [],
    "declared unreachable but actually reachable (rule too broad)",
  );
  assertEquals(
    [...measured].filter((k) => !declared.has(k)),
    [],
    "unreachable but not declared (possible dead combo)",
  );
  // 各規則が実際に何かを説明していること (死に規則を残さない)
  for (const rule of UNREACHABLE_RULES) {
    const hit = PRODUCT_NODE_KEYS.some((key) => {
      const [p, a] = splitProductKey(key);
      return rule.holds(p, a);
    });
    assert(hit, `rule ${rule.id} explains nothing: ${rule.why}`);
  }
});

// 領域 A の宣言ノードのうち、どの P と組んでも到達できない 5 つ。
//
// 設計1.5 は領域 A の詳細ノードを attention × fix-ask × rebase-ask の**自由な直積**
// (2×3×3=18) として書いているが、遷移を全部並べると attention==human と ask==taken は
// 併存できない:
//   - attention を human にする verb (attention-set / fix-start の上限ラッチ /
//     observe のエラーラッチ) の from はすべて P==resting。
//   - ask の taken は P==resting では持てない (不変条件5の残差)。
// したがって「human かつ taken」の 5 通りは領域 A の座標としても構築できない。
//
// もう 1 つ、fix と rebase が同時に taken の組も構築できない: fix の taken を立てるのは
// fix-start (着地は kind==pr_fix)、rebase の taken を立てるのは rebase-start 入口 (a)
// (着地は kind==rebase_fix) だけで、迂回は kind を変えない (2.4)。両方 taken の run は
// kind が 2 つ必要になる。blocked / queued はその run から継承するだけなので同じ。
//
// 合わせて 6 つ。設計1.5 の自由直積が実際より広いという指摘であって、実装の欠落ではない。
const UNREACHABLE_ARTIFACT_NODES: readonly ANodeKey[] = A_OPEN_FOLLOW_NODES
  .filter((n) => {
    const anyTaken = n.fix === "taken" || n.rebase === "taken";
    return (n.attention === "human" && anyTaken) ||
      (n.fix === "taken" && n.rebase === "taken");
  })
  .map((n) => n.key);

Deno.test("T-V2T-REACH-3: every declared node of each domain is reached", () => {
  const reachedP = new Set<string>();
  const reachedA = new Set<string>();
  for (const key of REACH.visited) {
    const [p, a] = splitProductKey(key);
    reachedP.add(p);
    reachedA.add(a);
  }
  assertSameSet([...reachedP], P_NODE_KEYS, "all 19 progress nodes reached");
  assertEquals(UNREACHABLE_ARTIFACT_NODES.length, 6, "structurally impossible");
  assertSameSet(
    [...reachedA],
    A_NODE_KEYS.filter((a) => !UNREACHABLE_ARTIFACT_NODES.includes(a)),
    "all artifact nodes reached except the declared human-x-taken combos",
  );
  // 上の 5 つは、どの P と組んでも到達不能リストに載っていること
  for (const a of UNREACHABLE_ARTIFACT_NODES) {
    for (const p of P_NODE_KEYS) {
      assert(
        INTENTIONALLY_UNREACHABLE.includes(productKey(p, a)),
        `${productKey(p, a)} must be declared intentionally unreachable`,
      );
    }
  }
});

Deno.test("T-V2T-REACH-4: resting x fix-ask taken is on the declared list", () => {
  // 受け入れ条件4が名指しする例。fix-ask が taken の resting は 6 ノードある。
  const restingFixTaken = A_OPEN_FOLLOW_NODES
    .filter((n) => n.fix === "taken")
    .map((n) => productKey(P_RESTING, n.key));
  assertEquals(restingFixTaken.length, 6);
  for (const key of restingFixTaken) {
    assert(
      INTENTIONALLY_UNREACHABLE.includes(key),
      `${key} must be declared intentionally unreachable`,
    );
    assertFalse(REACH.visited.has(key), `${key} must not be reachable`);
  }
});

// ---------------------------------------------------------------------------
// T-V2T-SHIP: ship 1 回で復帰列が畳まれていること (受け入れ条件3)
// ---------------------------------------------------------------------------

Deno.test("T-V2T-SHIP-1: one ship performs the whole pr_fix return in a single write", () => {
  // approve → claim → advance×4 → ship (初回 PR) → fix-request → fix-start
  //   → advance → ship (押し直し)
  let state = applyApprove(
    buildState(buildItem(P_QUEUED, A_NODE_NONE)),
    "t-2",
    "t",
  );
  // 上で作った queue には t-1 も居るので t-2 を対象にする
  let idx = state.queue.findIndex((i) => i.id === "t-2");
  state = applyClaim(state.queue[idx], idx, state, "s1");
  for (
    const [from, to] of [
      ["research", "plan"],
      ["plan", "implement"],
      ["implement", "report"],
      ["report", "finalize"],
    ]
  ) {
    idx = state.queue.findIndex((i) => i.id === "t-2");
    state = applyAdvance(state.queue[idx], idx, state, from, to);
  }
  idx = state.queue.findIndex((i) => i.id === "t-2");
  const first = applyShip(state.queue[idx], idx, state, {
    commits: 3,
    ref: PR_REF,
    branch: "task-pipeline/t-2",
    tip: "sha-1",
    base: "main",
  });
  state = first.state;
  assertEquals(first.notify, "initial", "first push is the initial notify");
  assertEquals(first.mark, true, "initial engagement needs mark in_review");
  assertEquals(first.fix_count, 0);
  let item = state.queue.find((i) => i.id === "t-2") as V2Item;
  assertEquals(pNodeKeyOf(item), P_RESTING);
  assertEquals(aNodeKeyOf(item), A_OPEN_IDLE, "fresh follow is idle");
  assertEquals(item.session, "s1", "session kept while following");

  // レビュー指摘が来て pr_fix へ
  idx = state.queue.findIndex((i) => i.id === "t-2");
  state = applyFixRequest(state.queue[idx], idx, state, ["c1", "c2"], "/f");
  idx = state.queue.findIndex((i) => i.id === "t-2");
  const started = applyFixStart(state.queue[idx], idx, state, "s1", false);
  state = started.state;
  assertEquals(started.started, true);
  assertEquals(started.fixAttempts, 1);
  idx = state.queue.findIndex((i) => i.id === "t-2");
  state = applyAdvance(state.queue[idx], idx, state, "pr_fix", "finalize");
  // 押し直し直前の観測キャッシュ (sig) を埋めておく — ship がこれを null にする
  state = withItemSig(state, "t-2", "sig-before");
  const beforeShip = state.queue.find((i) => i.id === "t-2") as V2Item;
  assertEquals(followOfItem(beforeShip).probe.sig, "sig-before");
  assertEquals(followOfItem(beforeShip).ledger.handled, []);
  assertEquals(followOfItem(beforeShip).asks.fix!.taken, true);

  // ★ ship 1 回の適用結果が 4 つの性質をすべて満たす (v1 の 3 verb 順序制約の消滅)
  idx = state.queue.findIndex((i) => i.id === "t-2");
  const second = applyShip(state.queue[idx], idx, state, {
    commits: 1,
    ref: PR_REF,
    branch: "task-pipeline/t-2",
    tip: "sha-2",
    base: "main",
  });
  item = second.state.queue.find((i) => i.id === "t-2") as V2Item;
  const follow = followOfItem(item);
  assertEquals(follow.ledger.handled, ["c1", "c2"], "pending ids merged");
  assertEquals(follow.asks.fix, null, "fix ask consumed");
  assertEquals(
    (item.artifact as Extract<V2Artifact, { state: "open" }>).tip,
    "sha-2",
    "tip updated",
  );
  assertEquals(follow.probe.sig, null, "probe.sig cleared");
  assertEquals(item.session, "s1", "session kept (following continues)");
  assertEquals(second.notify, "update", "a re-push is an update");
  assertEquals(second.mark, false, "pr_fix must not re-mark the tracker");
  assertEquals(second.fix_count, 2);
  assertEquals(
    follow.ledger.fix_attempts,
    1,
    "fix_attempts survives the return (issue #15 regression)",
  );
  assertEquals(pNodeKeyOf(item), P_RESTING);
  assertOutputInvariants(item, "ship after pr_fix");
});

Deno.test("T-V2T-SHIP-2: handled merge is a union and fix_count counts the consumed ids", () => {
  const cases: Array<[readonly string[], readonly string[], string[], number]> =
    [
      // 交差しない
      [["c-old"], ["c3"], ["c-old", "c3"], 1],
      // 一部交差
      [["c-old", "c1"], ["c1", "c2"], ["c-old", "c1", "c2"], 2],
      // 完全に含まれる (handled は増えないが fix_count は渡された件数)
      [["c-old", "c1"], ["c-old"], ["c-old", "c1"], 1],
    ];
  for (const [handled, ids, expectedHandled, expectedCount] of cases) {
    const item = withFixAsk(
      withHandled(buildItem(P_PRFIX_FINALIZE, A_OPEN_FIX_TAKEN), handled),
      { ids, findings: "/f", taken: true },
    );
    const r = applyShip(item, 0, buildState(item), {
      commits: 1,
      ...SHIP_GROUP,
    });
    const out = itemOf(r.state) as V2Item;
    assertEquals(
      followOfItem(out).ledger.handled,
      expectedHandled,
      `handled union for ids=${JSON.stringify(ids)}`,
    );
    assertEquals(
      followOfItem(out).ledger.handled.length,
      new Set(followOfItem(out).ledger.handled).size,
      "handled must not contain duplicates",
    );
    assertEquals(r.fix_count, expectedCount, "fix_count counts consumed ids");
  }
});

Deno.test("T-V2T-SHIP-3: commits, ref-shape and prior-artifact branches", () => {
  // commits==0: ref 系 4 フラグは省略必須で、グループ欄は不変
  const none = buildItem(P_FULL_FINALIZE, A_NODE_NONE);
  const zero = applyShip(none, 0, buildState(none), { commits: 0 });
  assertEquals(zero.notify, "none");
  assertEquals(zero.mark, true);
  assertEquals(
    (itemOf(zero.state) as V2Item).artifact,
    none.artifact,
    "artifact unchanged for commits 0",
  );
  assertEquals((itemOf(zero.state) as V2Item).session, null, "no follow");
  assertConflict(
    () => applyShip(none, 0, buildState(none), { commits: 0, ref: PR_REF }),
    "commits 0 with a ref flag must be rejected",
  );
  assertConflict(
    () => applyShip(none, 0, buildState(none), { commits: 1, ref: PR_REF }),
    "commits >= 1 with a partial group must be rejected",
  );

  // ref の形で follow の有無が決まる (設計1.3)
  assert(isPullRequestRef(PR_REF));
  assertFalse(isPullRequestRef(COMMIT_REF), "a commit sha is not a PR URL");
  assertFalse(isPullRequestRef("task-pipeline/gh-35"), "a branch is not a PR");
  assertFalse(isPullRequestRef(""), "empty ref is not a PR");
  const withPr = applyShip(none, 0, buildState(none), {
    commits: 1,
    ...SHIP_GROUP,
  });
  assertEquals(aNodeKeyOf(itemOf(withPr.state) as V2Item), A_OPEN_IDLE);
  assertEquals((itemOf(withPr.state) as V2Item).session, "s0", "kept");
  const withCommit = applyShip(none, 0, buildState(none), {
    commits: 1,
    ...SHIP_GROUP,
    ref: COMMIT_REF,
  });
  assertEquals(
    aNodeKeyOf(itemOf(withCommit.state) as V2Item),
    A_NODE_OPEN_NO_FOLLOW,
    "non-PR ref creates an open without follow",
  );
  assertEquals(
    (itemOf(withCommit.state) as V2Item).session,
    null,
    "no follow means nothing to follow: session released",
  );

  // withdrawn からの再走は新しい open を作り、asked / note を捨てる
  const wd = buildItem(P_FULL_FINALIZE, A_WITHDRAWN_ASKED);
  const reopened = applyShip(wd, 0, buildState(wd), {
    commits: 1,
    ...SHIP_GROUP,
  });
  assertEquals(reopened.notify, "initial", "a new PR is an initial notify");
  assertEquals(aNodeKeyOf(itemOf(reopened.state) as V2Item), A_OPEN_IDLE);

  // 未消費の rebase-ask は quiet に降格し、消費済みは消える
  const queued = buildItem(P_FULL_FINALIZE, A_OPEN_REBASE_QUEUED);
  const demoted = applyShip(queued, 0, buildState(queued), {
    commits: 1,
    ...SHIP_GROUP,
  });
  assertEquals(aNodeKeyOf(itemOf(demoted.state) as V2Item), A_OPEN_IDLE);
  assertEquals(
    followOfItem(itemOf(demoted.state) as V2Item).asks.rebase!.resolve,
    false,
    "queued resolve demoted to a quiet guard",
  );
  const takenRebase = buildItem(P_CYCLE_REBASE, A_OPEN_REBASE_TAKEN);
  const finalized = applyAdvance(
    takenRebase,
    0,
    buildState(takenRebase),
    "rebase_fix",
    "finalize",
  );
  const fi = itemOf(finalized) as V2Item;
  const shipped = applyShip(fi, 0, finalized, { commits: 1, ...SHIP_GROUP });
  assertEquals(
    followOfItem(itemOf(shipped.state) as V2Item).asks.rebase,
    null,
    "taken rebase ask removed",
  );
  assertEquals(shipped.mark, false, "rebase_fix must not re-mark the tracker");
});

// ---------------------------------------------------------------------------
// T-V2T-CLAIM: 周回リセットの「戻す側」と「保つ側」(設計2.3)
// ---------------------------------------------------------------------------

Deno.test("T-V2T-CLAIM-1: claim resets the cycle ledger but keeps handled", () => {
  const item = withFixAttempts(
    buildItem(P_QUEUED, openNodeKey("human", "pending", "queued")),
    2,
  );
  const before = followOfItem(item);
  assertEquals(before.ledger.handled, ["c-old"], "fixture has handled");
  assertEquals(before.ledger.review_only.length, 1);
  assertEquals(before.ledger.answered.length, 1);
  assert(before.probe.sig !== null, "fixture has a stale signature");

  const out = itemOf(applyClaim(item, 0, buildState(item), "s1")) as V2Item;
  const follow = followOfItem(out);
  // リセットされる側
  assertEquals(follow.ledger.fix_attempts, 0, "fix_attempts reset");
  assertEquals(follow.ledger.review_only, [], "review_only reset");
  assertEquals(follow.ledger.answered, [], "answered reset");
  assertEquals(follow.asks.fix, null, "fix ask cleared");
  assertEquals(follow.asks.rebase, null, "rebase ask cleared");
  assertEquals(follow.probe.sig, null, "signature cleared (catch-up next)");
  assertEquals(follow.attention, "auto", "attention returns to auto");
  // 保持される側 — ここが空になる実装は v1 の issue #13 / #15 の回帰そのもの
  assertEquals(
    follow.ledger.handled,
    ["c-old"],
    "handled is the memory of the PR's whole lifetime and must survive claim",
  );
  assertEquals(aNodeKeyOf(out), A_OPEN_IDLE);
  assertEquals(
    pNodeKeyOf(out),
    P_FULL_RESEARCH,
    "always initial/full/research",
  );
  assertEquals(out.run!.gate, "full", "claim always rebuilds gate: full");
  assertOutputInvariants(out, "claim reset");

  // follow を持たない artifact では 1 バイトも変わらない
  for (const aKey of [A_NODE_NONE, A_NODE_OPEN_NO_FOLLOW, A_WITHDRAWN_ASKED]) {
    const bare = buildItem(P_QUEUED, aKey);
    const bareOut = itemOf(
      applyClaim(bare, 0, buildState(bare), "s1"),
    ) as V2Item;
    assertEquals(
      bareOut.artifact,
      bare.artifact,
      `${aKey}: artifact untouched`,
    );
  }
});

// ---------------------------------------------------------------------------
// T-V2T-LEDGER: review-only / answered-set の upsert 契約
// ---------------------------------------------------------------------------

function ledgerCases(
  apply: (
    item: V2Item,
    index: number,
    state: V2State,
    items: readonly LedgerEntry[],
  ) => { state: V2State; newOrChanged: string[]; total: number },
  read: (f: V2Follow) => readonly LedgerEntry[],
  label: string,
): void {
  const seed: LedgerEntry[] = [
    { id: "r1", updated_at: "t1" },
    { id: "r2", updated_at: null },
  ];
  const base = withLedgerList(
    buildItem(P_RESTING, A_OPEN_IDLE),
    label,
    seed,
  );
  const run = (items: LedgerEntry[]) => apply(base, 0, buildState(base), items);

  // (a) 未知の id: 追加され newOrChanged に載る
  let r = run([{ id: "r3", updated_at: "t3" }]);
  assertEquals(r.newOrChanged, ["r3"], `${label}: unknown id`);
  assertEquals(r.total, 3);
  assertEquals(read(followOfItem(itemOf(r.state) as V2Item)).length, 3);

  // (b) 既知の id で updated_at が変化: 更新され newOrChanged に載る
  r = run([{ id: "r1", updated_at: "t9" }]);
  assertEquals(r.newOrChanged, ["r1"], `${label}: changed id`);
  assertEquals(r.total, 2);
  assertEquals(
    read(followOfItem(itemOf(r.state) as V2Item)).find((e) => e.id === "r1")
      ?.updated_at,
    "t9",
  );

  // (c) 既知の id で updated_at が同一: 更新も newOrChanged 入りもしない
  r = run([{ id: "r1", updated_at: "t1" }]);
  assertEquals(r.newOrChanged, [], `${label}: unchanged id must be silent`);
  assertEquals(r.total, 2);
  assertEquals(read(followOfItem(itemOf(r.state) as V2Item)), seed);

  // (d) 既存側が null: 変化扱い
  r = run([{ id: "r2", updated_at: "t2" }]);
  assertEquals(
    r.newOrChanged,
    ["r2"],
    `${label}: existing null counts changed`,
  );

  // (e) 入力側が null: 変化扱い
  r = run([{ id: "r1", updated_at: null }]);
  assertEquals(
    r.newOrChanged,
    ["r1"],
    `${label}: incoming null counts changed`,
  );

  // (f) 同じ id を 2 回渡す: total が二重に増えない
  r = run([{ id: "r3", updated_at: "t3" }, { id: "r3", updated_at: "t3" }]);
  assertEquals(r.total, 3, `${label}: duplicate ids must dedup`);
  assertEquals(r.newOrChanged, ["r3"], `${label}: duplicate ids reported once`);
}

Deno.test("T-V2T-LEDGER-1: review-only upsert contract", () => {
  ledgerCases(applyReviewOnly, (f) => f.ledger.review_only, "review_only");
});

Deno.test("T-V2T-LEDGER-2: answered-set upsert contract", () => {
  ledgerCases(applyAnsweredSet, (f) => f.ledger.answered, "answered");
});

Deno.test("T-V2T-LEDGER-3: the two ledgers never leak into each other or handled", () => {
  const item = buildItem(P_RESTING, A_OPEN_IDLE);
  const before = followOfItem(item);
  const afterAnswered = followOfItem(
    itemOf(
      applyAnsweredSet(item, 0, buildState(item), [{
        id: "q2",
        updated_at: "t2",
      }]).state,
    ) as V2Item,
  );
  assertEquals(afterAnswered.ledger.handled, before.ledger.handled);
  assertEquals(afterAnswered.ledger.review_only, before.ledger.review_only);
  const afterReviewOnly = followOfItem(
    itemOf(
      applyReviewOnly(item, 0, buildState(item), [{
        id: "r2",
        updated_at: "t2",
      }]).state,
    ) as V2Item,
  );
  assertEquals(afterReviewOnly.ledger.handled, before.ledger.handled);
  assertEquals(afterReviewOnly.ledger.answered, before.ledger.answered);
});

// ---------------------------------------------------------------------------
// T-V2T-OPT: 省略した引数のフィールドは既存値を保つ
// ---------------------------------------------------------------------------

Deno.test("T-V2T-OPT-1: omitted fields keep their value, explicit null writes null", () => {
  const item = buildItem(P_RESTING, A_OPEN_IDLE);
  const state = buildState(item);
  const probe0 = followOfItem(item).probe;
  assert(probe0.head !== null && probe0.ci !== null, "fixture has values");

  // observe: 省略 → 既存値保持
  const omitted = followOfItem(
    itemOf(applyObserve(item, 0, state, {}).state) as V2Item,
  ).probe;
  assertEquals(omitted.head, probe0.head, "head kept when omitted");
  assertEquals(omitted.ci, probe0.ci, "ci kept when omitted");
  assertEquals(omitted.checked_at, probe0.checked_at, "checked_at kept");
  assertEquals(omitted.note, probe0.note, "note kept when omitted");
  assertEquals(omitted.sig, probe0.sig, "sig kept without --sig-clear");

  // observe: 値を指定 → 上書き
  const written = followOfItem(
    itemOf(
      applyObserve(item, 0, state, {
        head: "h9",
        ci: "failing",
        checked_at: NOW,
        note: "n9",
      }).state,
    ) as V2Item,
  ).probe;
  assertEquals(written.head, "h9");
  assertEquals(written.ci, "failing");
  assertEquals(written.checked_at, NOW);
  assertEquals(written.note, "n9");

  // observe: 明示的な null → null が書かれる (省略と別クラス)
  const nulled = followOfItem(
    itemOf(
      applyObserve(item, 0, state, {
        head: null,
        ci: null,
        checked_at: null,
        note: null,
      }).state,
    ) as V2Item,
  ).probe;
  assertEquals(nulled.head, null);
  assertEquals(nulled.ci, null);
  assertEquals(nulled.checked_at, null);
  assertEquals(nulled.note, null);

  // probe-run: --session の有無
  const noSession = itemOf(
    applyProbeRun(item, 0, state, { proc: "bg-2" }, NOW),
  ) as V2Item;
  assertEquals(noSession.session, "s0", "session untouched when omitted");
  assertEquals(followOfItem(noSession).probe.proc, "bg-2");
  assertEquals(followOfItem(noSession).probe.proc_started_at, NOW);
  const withSession = itemOf(
    applyProbeRun(item, 0, state, { proc: "bg-2", session: "s9" }, NOW),
  ) as V2Item;
  assertEquals(withSession.session, "s9", "session assigned when given");

  // probe-exit: --sig の省略 / 指定 / 明示 null
  const keptSig = followOfItem(
    itemOf(applyProbeExit(item, 0, state, {})) as V2Item,
  ).probe;
  assertEquals(keptSig.sig, probe0.sig, "sig kept when omitted");
  assertEquals(keptSig.proc, null, "lease always released");
  assertEquals(keptSig.proc_started_at, null);
  assertEquals(
    followOfItem(
      itemOf(applyProbeExit(item, 0, state, { sig: "sig-9" })) as V2Item,
    )
      .probe.sig,
    "sig-9",
  );
  assertEquals(
    followOfItem(
      itemOf(applyProbeExit(item, 0, state, { sig: null })) as V2Item,
    )
      .probe.sig,
    null,
  );
});

// ---------------------------------------------------------------------------
// 軸の外の verb 固有前提 (行列テストは軸だけを見るので、ここで個別に固定する)
// ---------------------------------------------------------------------------

Deno.test("T-V2T-PRECOND-1: approve rejects duplicate ids and builds a queued x none entry", () => {
  const empty = buildState(buildItem(P_QUEUED, A_NODE_NONE));
  const added = applyApprove(empty, "t-9", "title");
  const entry = added.queue.find((i) => i.id === "t-9") as V2Item;
  assertEquals(productKeyOf(entry), productKey(P_QUEUED, A_NODE_NONE));
  assertItemShape(entry, "approve output");
  assertItemInvariantsV2(entry);
  assertConflict(
    () => applyApprove(added, "t-9", "title"),
    "duplicate id must be rejected",
  );
});

Deno.test("T-V2T-PRECOND-2: merged requires a tip, retire requires a released session", () => {
  const noTip = withTip(buildItem(P_RESTING, A_OPEN_IDLE), null);
  assertConflict(
    () => applyMerged(noTip, 0, buildState(noTip)),
    "merged without a tip must be rejected",
  );
  const merged = itemOf(
    applyMerged(
      buildItem(P_RESTING, A_OPEN_IDLE),
      0,
      buildState(buildItem(P_RESTING, A_OPEN_IDLE)),
    ),
  ) as V2Item;
  assertEquals(aNodeKeyOf(merged), A_NODE_MERGED);
  assertEquals(merged.session, null, "merged releases the session");
  assertFalse("follow" in merged.artifact, "merged has no follow key");

  // retire: session が残っていれば撥ねる
  const stillOwned = withSession(merged, "s0");
  assertConflict(
    () => applyRetire(stillOwned, 0, buildState(stillOwned), NOW),
    "retire with a live session must be rejected",
  );
  const retired = applyRetire(merged, 0, buildState(merged), NOW);
  assertEquals(retired.queue.length, 0, "retired item leaves the queue");
  assertEquals(retired.completed, [{ id: "t-1", done_at: NOW }]);
});

Deno.test("T-V2T-PRECOND-3: retire prunes completed entries older than 24h", () => {
  const merged = withSession(buildItem(P_RESTING, A_NODE_MERGED), null);
  const now = "2026-08-02T00:00:00Z";
  const state = buildState(merged, {
    completed: [
      { id: "old", done_at: "2026-07-31T23:59:00Z" }, // 24h + 1min → 掃除
      { id: "edge", done_at: "2026-08-01T00:00:00Z" }, // ちょうど 24h → 残す
      { id: "recent", done_at: "2026-08-01T23:00:00Z" }, // 1h → 残す
      { id: "bogus", done_at: "not-a-date" }, // 解釈不能 → 残す
    ],
  });
  const out = applyRetire(merged, 0, state, now);
  assertEquals(
    out.completed.map((e) => e.id),
    ["edge", "recent", "bogus", "t-1"],
  );
});

Deno.test("T-V2T-PRECOND-4: restore needs a relisted entry and drops it", () => {
  const item = buildItem(P_RESTING, A_OPEN_IDLE);
  let threw = false;
  try {
    applyRestore(item, 0, buildState(item));
  } catch (e) {
    threw = true;
    assert(
      e instanceof CliErrorV2 && e.code === "missing",
      `expected missing, got ${String(e)}`,
    );
  }
  assert(threw, "restore without a relisted entry must fail");
  const out = applyRestore(item, 0, buildState(item, RELISTED_EXTRA));
  assertEquals(out.relisted, [], "relisted entry consumed");
  const restored = itemOf(out) as V2Item;
  assertEquals(pNodeKeyOf(restored), P_QUEUED);
  assertEquals(restored.run, null, "no run, hence no gate to restore");
  assertEquals(followOfItem(restored).probe.proc, null, "lease released");
  assertEquals(restored.session, null);
  // merged からの復帰経路は無い (設計2.5)
  const mergedItem = buildItem(P_RESTING, A_NODE_MERGED);
  assertConflict(
    () => applyRestore(mergedItem, 0, buildState(mergedItem, RELISTED_EXTRA)),
    "restore must not fire on merged",
  );
});

Deno.test("T-V2T-PRECOND-5: touch-executor and withdraw-remove guard their extra preconditions", () => {
  const noExec = withExecutor(buildItem(P_FULL_IMPLEMENT, A_NODE_NONE), null);
  assertConflict(
    () => applyTouchExecutor(noExec, 0, buildState(noExec), undefined, NOW),
    "touch-executor without an executor must be rejected",
  );
  const unowned = withSession(buildItem(P_FULL_IMPLEMENT, A_NODE_NONE), null);
  const claimed = itemOf(
    applyTouchExecutor(unowned, 0, buildState(unowned), "s9", NOW),
  ) as V2Item;
  assertEquals(claimed.session, "s9", "unowned session is adopted");
  const owned = itemOf(
    applyTouchExecutor(
      buildItem(P_FULL_IMPLEMENT, A_NODE_NONE),
      0,
      buildState(buildItem(P_FULL_IMPLEMENT, A_NODE_NONE)),
      "s9",
      NOW,
    ),
  ) as V2Item;
  assertEquals(owned.session, "s0", "an owned session is not stolen");

  const noWorktree = {
    ...buildItem(P_RESTING, A_WITHDRAWN_ASKED),
    worktree: null,
  };
  assertConflict(
    () => applyWithdrawRemove(noWorktree, 0, buildState(noWorktree), "r", NOW),
    "withdraw-remove without a worktree must be rejected",
  );
  const wd = buildItem(P_RESTING, A_WITHDRAWN_ASKED);
  const out = applyWithdrawRemove(wd, 0, buildState(wd), "reason", NOW);
  assertEquals(out.queue.length, 0);
  assertEquals(out.withdrawn_branches.length, 1);
  assertEquals(out.withdrawn_branches[0].id, "t-1");
});

// ---------------------------------------------------------------------------
// フィクスチャ調整ヘルパ (座標を変えずに軸外のデータだけを差し替える)
// ---------------------------------------------------------------------------

function followOfItem(item: V2Item): V2Follow {
  const artifact = item.artifact as Extract<V2Artifact, { state: "open" }>;
  return artifact.follow as V2Follow;
}

function mapFollow(item: V2Item, f: (follow: V2Follow) => V2Follow): V2Item {
  const artifact = item.artifact;
  if (artifact.state !== "open" || artifact.follow === null) return item;
  return { ...item, artifact: { ...artifact, follow: f(artifact.follow) } };
}

function withFixAttempts(item: V2Item, n: number): V2Item {
  return mapFollow(item, (f) => ({
    ...f,
    ledger: { ...f.ledger, fix_attempts: n },
  }));
}

function withHandled(item: V2Item, handled: readonly string[]): V2Item {
  return mapFollow(item, (f) => ({
    ...f,
    ledger: { ...f.ledger, handled: [...handled] },
  }));
}

function withFixAsk(item: V2Item, fix: V2FixAsk): V2Item {
  return mapFollow(item, (f) => ({ ...f, asks: { ...f.asks, fix } }));
}

function withErrors(item: V2Item, n: number): V2Item {
  return mapFollow(item, (f) => ({ ...f, probe: { ...f.probe, errors: n } }));
}

function withLedgerList(
  item: V2Item,
  which: string,
  list: readonly LedgerEntry[],
): V2Item {
  return mapFollow(item, (f) => ({
    ...f,
    ledger: which === "answered"
      ? { ...f.ledger, answered: [...list] }
      : { ...f.ledger, review_only: [...list] },
  }));
}

function withItemSig(state: V2State, id: string, sig: string): V2State {
  const queue = state.queue.map((it) =>
    it.id === id
      ? mapFollow(it, (f) => ({ ...f, probe: { ...f.probe, sig } }))
      : it
  );
  return { ...state, queue };
}

function withTip(item: V2Item, tip: string | null): V2Item {
  const artifact = item.artifact as Extract<V2Artifact, { state: "open" }>;
  return { ...item, artifact: { ...artifact, tip } };
}

function withSession(item: V2Item, session: string | null): V2Item {
  return { ...item, session };
}

function withExecutor(item: V2Item, executor: string | null): V2Item {
  return {
    ...item,
    run: { ...(item.run as NonNullable<V2Item["run"]>), executor },
  };
}

function assertConflict(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert(
      e instanceof CliErrorV2 && e.code === "conflict",
      `${msg}: expected conflict, got ${String(e)}`,
    );
  }
  assert(threw, msg);
}
