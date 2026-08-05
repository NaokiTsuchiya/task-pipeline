// task-pipeline/scripts/state-transitions.ts
//
// task-pipeline/docs/state-cli-contract.md が定める全43 verb のうち、各 verb の
// 「事前条件チェックと状態オブジェクトの書き換え」だけを切り出した純粋関数群。
// ロック・原子的書き込み・heartbeat・権限・CLI dispatch・終了コードへの変換は
// state.ts に残る。ここは Deno 由来の API 呼び出しを一切行わない (state-ownership.ts /
// state-schema.ts と同型の設計) — 現在時刻が要る箇所は、呼び出し元 (state.ts) が
// nowIso()/nowMs() (STATE_CLI_TEST_NOW_MS によるテスト決定性込み) で計算した値を
// 引数として受け取る。ファイルI/O・排他は一切行わない。
//
// 状態機械の語彙 (status/phase/gate のトークン集合)・フェーズ順・verb ごとの合法な
// (status, phase) 遷移は、このファイル冒頭の宣言データ (GATE_PHASE_SEQUENCES /
// VERB_LIFECYCLE) が唯一の真実である。散文 (SKILL.md / state-cli-contract.md) と
// スキーマ (state.schema.json) は、テスト (state-transitions.test.ts の整合テストと
// state.test.ts の T-D 系) がこの宣言データと突き合わせる。
//
// verb → 実装 (state-cli-contract.md の `### ` 見出しと対応。全43件):
//   `init`                     → applyInit
//   `get`                      → get (前提チェック・書き換え無し。読み取りは state.ts)
//   `validate`                 → validate (checkState を呼ぶだけ)
//   `session-touch`            → isSessionStale (年齢判定のみ。ファイルI/Oは state.ts)
//   `sessions-alive`           → isSessionAlive (年齢判定のみ。ファイルI/Oは state.ts)
//   `history-append`           → applyHistoryAppend
//   `approve`                  → applyApprove
//   `claim`                    → applyClaim
//   `set-gate`                 → applySetGate
//   `set-worktree`             → applySetWorktree
//   `set-executor`             → applySetExecutor
//   `touch-executor`           → applyTouchExecutor
//   `set-takeover`             → applySetTakeover
//   `phase-pass`               → applyPhasePass
//   `phase-fail`               → applyPhaseFail
//   `block`                    → applyBlock
//   `dequeue`                  → applyDequeue
//   `finalize-start`           → applyFinalizeStart
//   `in-review`                → applyInReview
//   `watch-init`               → applyWatchInit
//   `watch-set`                → applyWatchSet
//   `fix-pending`              → applyFixPending
//   `fix-start`                → applyFixStart
//   `fix-done`                 → applyFixDone
//   `review-only`              → applyReviewOnly
//   `answered-set`             → applyAnsweredSet
//   `rebase-record`            → applyRebaseRecord
//   `rebase-resolve-pending`   → applyRebaseResolvePending
//   `rebase-start`             → applyRebaseStart
//   `rebase-done`              → applyRebaseDone
//   `rebase-give-up`           → applyRebaseGiveUp
//   `recover-done`             → applyRecoverDone
//   `withdraw`                 → applyWithdraw
//   `withdraw-remove`          → applyWithdrawRemove
//   `withdraw-asked`           → applyWithdrawAsked
//   `candidates-set`           → applyCandidatesSet
//   `candidates-drop`          → applyCandidatesDrop
//   `promoted-add`             → applyPromotedAdd
//   `promoted-drop`            → applyPromotedDrop
//   `relisted-add`             → applyRelistedAdd
//   `relisted-drop`            → applyRelistedDrop
//   `restore`                  → applyRestore
//   `stalled-set`              → applyStalledSet
//
// テスト: state.test.ts / state-ownership.test.ts はサブプロセス経由で state.ts を検証する
// 既存の安全網。このファイルの宣言データと実装の整合は state-transitions.test.ts
// (T-ALIGN / T-MX / T-FRAME) が直接 import で検査する。

import { checkState } from "./state-schema.ts";

// ---------------------------------------------------------------------------
// 終了コード名・エラー型
//
// usage/lock/schema/permission (主に state.ts 側の flag 解釈・lock・読み取りが使う) と、
// conflict/missing (ここでの前提チェックが使う) の両方の語彙を、循環importを避けるため
// ここで定義し state.ts が import する (state.ts → state-transitions.ts の一方向)。
// ---------------------------------------------------------------------------

export type ExitCodeName =
  | "usage"
  | "lock"
  | "schema"
  | "missing"
  | "permission"
  | "conflict";

export class CliError extends Error {
  constructor(public readonly code: ExitCodeName, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 状態機械の語彙 (単一ソース)
//
// status / phase / gate / watch.state / watch.ci / rebase.reason / rebase.kind /
// stalled のトークン集合はここだけで定義する。state.ts の CLI フラグ検証はここを
// import し、state.schema.json の enum とは state-transitions.test.ts の整合テストが
// 突き合わせる (どちらかだけ直すとテストが落ちる)。
// ---------------------------------------------------------------------------

export const STATUS_VALUES = [
  "approved",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;
export type Status = (typeof STATUS_VALUES)[number];

// gate ごとの検証フェーズ列。phase-pass が通せる辺は「この列の隣接ペア」だけで、
// フェーズ順の正はこの宣言 (SKILL.md の記述はこの転写で、T-D4 が突き合わせる)。
export const GATE_PHASE_SEQUENCES = {
  full: ["research", "plan", "implement", "report"],
  light: ["research+plan", "implement", "report"],
} as const;
export type Gate = keyof typeof GATE_PHASE_SEQUENCES;
export const GATE_VALUES = Object.keys(GATE_PHASE_SEQUENCES) as Gate[];

type SequencePhase = (typeof GATE_PHASE_SEQUENCES)[Gate][number];

// finalize は検証ゲートを持たない後処理フェーズ、pr_fix / rebase_fix は in_review から
// (rebase_fix は finalize からも) 入る仕上げフェーズ。フェーズ列への挿入位置は
// VERB_LIFECYCLE (fix-start / rebase-start / finalize-start) が定める。
export const FINALIZE_PHASE = "finalize" as const;
export const FIX_PHASES = ["pr_fix", "rebase_fix"] as const;
export type Phase =
  | SequencePhase
  | typeof FINALIZE_PHASE
  | (typeof FIX_PHASES)[number];

const ALL_SEQUENCES: ReadonlyArray<readonly SequencePhase[]> = Object.values(
  GATE_PHASE_SEQUENCES,
);

// 検証フェーズ列の全トークン (full → light の順で重複除去)。
export const SEQUENCE_PHASES: readonly SequencePhase[] = [
  ...new Set<SequencePhase>(ALL_SEQUENCES.flat()),
];

// phase の全トークン。schema の enum・CLI の受理値はこの導出値に追従する
// (フェーズを 1 つ足すときは GATE_PHASE_SEQUENCES か FIX_PHASES に足せば全部に伝わる)。
export const PHASE_VALUES: readonly Phase[] = [
  ...SEQUENCE_PHASES,
  FINALIZE_PHASE,
  ...FIX_PHASES,
];

// 検証ゲートを持つフェーズ (phase-fail --phase の受理値)。finalize だけが対象外。
export const VERIFIED_PHASES: readonly Phase[] = [
  ...SEQUENCE_PHASES,
  ...FIX_PHASES,
];

// finalize-start --from の受理値: 各フェーズ列の最終フェーズと仕上げフェーズ。
export const FINALIZE_FROM_PHASES: readonly Phase[] = [
  ...new Set<Phase>([
    ...ALL_SEQUENCES.map((seq) => seq[seq.length - 1]),
    ...FIX_PHASES,
  ]),
];

export const WATCH_STATE_VALUES = ["watching", "stopped"] as const;
export const CI_VALUES = ["passing", "failing", "pending", "none"] as const;
export const REBASE_REASON_VALUES = [
  "dirty",
  "diverged",
  "conflict",
  "push",
] as const;
export const REBASE_KIND_VALUES = [
  "superseded",
  "overlap",
  "adjacent",
  "structural",
  "other",
] as const;
export const STALLED_VALUES = ["depleted", "max_open"] as const;

// phase-pass が通せる辺か (gate のフェーズ列の隣接ペアのみ。自己辺・逆行・飛び越し・
// gate 違いの辺はすべて偽)。
export function isPhasePassEdge(
  gate: unknown,
  from: string,
  to: string,
): boolean {
  if (typeof gate !== "string" || !(gate in GATE_PHASE_SEQUENCES)) return false;
  const seq: readonly string[] = GATE_PHASE_SEQUENCES[gate as Gate];
  const i = seq.indexOf(from);
  return i !== -1 && seq[i + 1] === to;
}

// ---------------------------------------------------------------------------
// ライフサイクルノード (機械 A) と verb ごとの遷移表
//
// ノードは (status, phase) の合法な組だけ。phase が非 null なのは in_progress のとき、
// かつそのときに限る — スキーマ上表現可能な 45 通りのうち、この 12 通り以外は
// 「誰も作らない」ではなく「atNode では表現できない」。
// ---------------------------------------------------------------------------

export type NodeKey =
  | Exclude<Status, "in_progress">
  | `in_progress/${Phase}`;

export const IN_PROGRESS_NODES: readonly NodeKey[] = PHASE_VALUES.map(
  (p) => `in_progress/${p}` as NodeKey,
);

export const LIFECYCLE_NODES: readonly NodeKey[] = [
  "approved",
  "in_review",
  "done",
  "blocked",
  ...IN_PROGRESS_NODES,
];

// item の現在ノード。合法なノードでなければ null (前提チェックでは conflict に、
// 書き込み後アサーションでは schema エラーになる)。
export function nodeKeyOf(item: Record<string, unknown>): NodeKey | null {
  const status = item.status;
  const phase = item.phase;
  if (typeof status !== "string") return null;
  if (status === "in_progress") {
    if (typeof phase !== "string") return null;
    if (!(PHASE_VALUES as readonly string[]).includes(phase)) return null;
    return `in_progress/${phase as Phase}`;
  }
  if (!(STATUS_VALUES as readonly string[]).includes(status)) return null;
  if (phase !== null) return null;
  return status as NodeKey;
}

// status と phase を必ずペアで書く。片方だけ書き換えて到達不能な組を作る経路を
// 型の上で塞ぐ (NodeKey に無い組はここに渡せない)。
function atNode(
  item: Record<string, unknown>,
  node: NodeKey,
): Record<string, unknown> {
  const prefix = "in_progress/";
  if (node.startsWith(prefix)) {
    return { ...item, status: "in_progress", phase: node.slice(prefix.length) };
  }
  return { ...item, status: node, phase: null };
}

export interface VerbLifecycleSpec {
  // この verb が発火を許すノード集合 (requireVerbAxes が参照する唯一の前提)。
  from: readonly NodeKey[];
  // 機械 A 上の効果。"unchanged" = ノードを変えない。"dynamic" = 引数・状態で分岐
  // (phase-pass / finalize-start / fix-start)。"removed" = queue から消える。
  to: NodeKey | "unchanged" | "dynamic" | "removed";
}

// ---------------------------------------------------------------------------
// 機械 B (review.watch) と機械 B' (review.rebase) のノード
//
// 状態空間は実際には A × B × B' の直積で、「A のノードを動かさない verb」の多くは
// B / B' の軸を動かす辺である。verb ごとの遷移をこの 3 軸で宣言する (VERB_SPEC) —
// 見方 (直積機械) がそのまま表現になるように。
// ---------------------------------------------------------------------------

// watch の軸: absent = review.watch が無い / watching・stopped = watch.state の値
export const WATCH_NODES = ["absent", "watching", "stopped"] as const;
export type WatchNode = (typeof WATCH_NODES)[number];

// rebase の軸: absent = review.rebase が無い / recorded = 控えのみ /
// pending = resolve_pending が真 (解決サイクル待ち)
export const REBASE_NODES = ["absent", "recorded", "pending"] as const;
export type RebaseNode = (typeof REBASE_NODES)[number];

export function watchNodeOf(item: Record<string, unknown>): WatchNode | null {
  const watch = getWatch(item);
  if (watch === null) return "absent";
  if (watch.state === "watching" || watch.state === "stopped") {
    return watch.state;
  }
  return null;
}

export function rebaseNodeOf(item: Record<string, unknown>): RebaseNode {
  const rebase = getRebase(item);
  if (rebase === null) return "absent";
  return rebase.resolve_pending === true ? "pending" : "recorded";
}

// 軸の "absent" は「review 自体が無い」と「review はあるがサブレコードが無い」の
// 両方を指す。review グループ側の要件 (review の存在・ref・tip など) は軸の外の
// verb 固有前提として各 apply 関数に残る (契約の verb 一覧に明記)。
export interface WatchAxisSpec {
  // 発火を許す watch ノード集合
  from: readonly WatchNode[];
  // 効果: "untouched" = watch に一切触れない (フレームテストも書き換えを禁じる) /
  // "unchanged" = 内部フィールドは書くが state 軸は動かさない / "watching" = 初期化 /
  // "quiesce" = present なら stopped・absent なら absent (揮発資源の静止) /
  // "dynamic" = 分岐 (watch-set の --state、fix-start の上限分岐)
  to: "watching" | "unchanged" | "quiesce" | "dynamic" | "untouched";
}

export interface RebaseAxisSpec {
  // 発火を許す rebase ノード集合
  from: readonly RebaseNode[];
  // 効果: "untouched" = 一切触れない / "unchanged" = 記録の中身は書くが軸は不変 /
  // "ensure" = 無ければ作る (有れば軸は不変) / "pending" = resolve_pending を立てる /
  // "defuse" = 有れば resolve_pending を落とす (無ければ absent のまま。軸以外の
  //   記録フィールドを書くかは verb 次第 — rebase-give-up は reason/blocked_onto も
  //   上書きする。書いてよい集合はフレーム宣言が持つ) /
  // "absent" = 記録ごと削除
  to: "pending" | "absent" | "ensure" | "defuse" | "unchanged" | "untouched";
}

export interface VerbSpec {
  lifecycle: VerbLifecycleSpec;
  watch: WatchAxisSpec;
  // rebase の軸は入口 (機械 A の from ノード) で前提が変わる verb がある
  // (rebase-start)。その場合はノードごとの指定にする。
  rebase: RebaseAxisSpec | Readonly<Partial<Record<NodeKey, RebaseAxisSpec>>>;
}

const W_UNTOUCHED: WatchAxisSpec = { from: WATCH_NODES, to: "untouched" };
const W_PRESENT: readonly WatchNode[] = ["watching", "stopped"];
const R_UNTOUCHED: RebaseAxisSpec = { from: REBASE_NODES, to: "untouched" };

export function resolveRebaseAxis(
  spec: VerbSpec["rebase"],
  node: NodeKey,
): RebaseAxisSpec {
  if ("from" in spec && "to" in spec) return spec as RebaseAxisSpec;
  const byNode = (spec as Readonly<Partial<Record<NodeKey, RebaseAxisSpec>>>)[
    node
  ];
  if (!byNode) {
    throw new Error(`BUG: no rebase axis for node ${node}`);
  }
  return byNode;
}

// queue エントリを対象にする全 verb の遷移表 (3 軸)。
// lifecycle は機械 A (status/phase)、watch は機械 B (review.watch)、rebase は
// 機械 B' (review.rebase) の from→to。docs/state-cli-contract.md の「遷移表」節と
// state.test.ts の T-D3/T-D8/T-D9 が突き合わせ、state-transitions.test.ts の matrix
// テストが「表に無いノードからは conflict になる」ことを軸ごとに網羅で検査する。
// approve だけはノードを持たない (新規追加) ので lifecycle の from は空。
export const VERB_SPEC: Readonly<Record<string, VerbSpec>> = {
  "approve": {
    lifecycle: { from: [], to: "approved" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "claim": {
    lifecycle: { from: ["approved"], to: "in_progress/research" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "set-gate": {
    lifecycle: {
      from: ["in_progress/research"],
      to: "in_progress/research+plan",
    },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "set-worktree": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "set-executor": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "touch-executor": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "set-takeover": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "phase-pass": {
    lifecycle: {
      from: SEQUENCE_PHASES.filter((p) =>
        !Object.values(GATE_PHASE_SEQUENCES).some(
          (seq) => seq[seq.length - 1] === p,
        )
      ).map((p) => `in_progress/${p}` as NodeKey),
      to: "dynamic",
    },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "phase-fail": {
    lifecycle: {
      from: VERIFIED_PHASES.map((p) => `in_progress/${p}` as NodeKey),
      to: "unchanged",
    },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "block": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "blocked" },
    watch: { from: WATCH_NODES, to: "quiesce" },
    rebase: R_UNTOUCHED,
  },
  "dequeue": {
    lifecycle: { from: IN_PROGRESS_NODES, to: "removed" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "finalize-start": {
    lifecycle: {
      from: FINALIZE_FROM_PHASES.map((p) => `in_progress/${p}` as NodeKey),
      to: "in_progress/finalize",
    },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "in-review": {
    lifecycle: { from: ["in_progress/finalize"], to: "in_review" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "watch-init": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: { from: WATCH_NODES, to: "watching" },
    rebase: R_UNTOUCHED,
  },
  "watch-set": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: { from: W_PRESENT, to: "dynamic" },
    rebase: R_UNTOUCHED,
  },
  "fix-pending": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: { from: W_PRESENT, to: "unchanged" },
    rebase: R_UNTOUCHED,
  },
  // 前提 watching がラッチ: 上限分岐が stopped を書いた瞬間、自分の前提が偽になる。
  "fix-start": {
    lifecycle: { from: ["in_review"], to: "dynamic" },
    watch: { from: ["watching"], to: "dynamic" },
    rebase: R_UNTOUCHED,
  },
  "fix-done": {
    lifecycle: { from: ["in_progress/finalize"], to: "unchanged" },
    watch: { from: W_PRESENT, to: "unchanged" },
    rebase: R_UNTOUCHED,
  },
  "review-only": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: { from: W_PRESENT, to: "unchanged" },
    rebase: R_UNTOUCHED,
  },
  "answered-set": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: { from: W_PRESENT, to: "unchanged" },
    rebase: R_UNTOUCHED,
  },
  "rebase-record": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: { from: REBASE_NODES, to: "ensure" },
  },
  "rebase-resolve-pending": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: { from: ["recorded", "pending"], to: "pending" },
  },
  // rebase_fix への入口は 2 つで、rebase 軸の前提が入口で異なる:
  // in_review からの復帰は resolve_pending の消費 (pending 必須)、finalize からの
  // 直接進入 (executor の REBASE-CONFLICT 停止) は rebase 記録を持たないのが普通。
  "rebase-start": {
    lifecycle: {
      from: ["in_review", "in_progress/finalize"],
      to: "in_progress/rebase_fix",
    },
    watch: W_UNTOUCHED,
    rebase: {
      "in_review": { from: ["pending"], to: "defuse" },
      "in_progress/finalize": { from: REBASE_NODES, to: "defuse" },
    },
  },
  "rebase-done": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: { from: REBASE_NODES, to: "absent" },
  },
  "rebase-give-up": {
    lifecycle: { from: ["in_progress/rebase_fix"], to: "in_review" },
    watch: W_UNTOUCHED,
    rebase: { from: ["recorded", "pending"], to: "defuse" },
  },
  "recover-done": {
    lifecycle: { from: ["in_review"], to: "done" },
    watch: { from: WATCH_NODES, to: "quiesce" },
    rebase: R_UNTOUCHED,
  },
  "withdraw": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "withdraw-remove": {
    lifecycle: { from: ["in_review"], to: "removed" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "withdraw-asked": {
    lifecycle: { from: ["in_review"], to: "unchanged" },
    watch: W_UNTOUCHED,
    rebase: R_UNTOUCHED,
  },
  "restore": {
    lifecycle: { from: ["in_review", "done", "blocked"], to: "approved" },
    watch: { from: WATCH_NODES, to: "quiesce" },
    rebase: R_UNTOUCHED,
  },
};

// 機械 A だけのビュー (T-D3・T-D6 と行列テストの lifecycle 検査が使う)。
export const VERB_LIFECYCLE: Readonly<Record<string, VerbLifecycleSpec>> =
  Object.fromEntries(
    Object.entries(VERB_SPEC).map(([verb, spec]) => [verb, spec.lifecycle]),
  );

// verb の遷移表に基づく前提チェック (3 軸すべて)。表に無いノードからの呼び出しは
// 軸を問わず conflict。
function requireVerbAxes(
  item: Record<string, unknown>,
  verb: string,
): NodeKey {
  const spec = VERB_SPEC[verb];
  if (!spec) {
    throw new Error(`BUG: no VERB_SPEC entry for verb: ${verb}`);
  }
  const node = nodeKeyOf(item);
  if (node === null || !spec.lifecycle.from.includes(node)) {
    const got = node ??
      `status=${String(item.status)} phase=${String(item.phase)}`;
    throw new CliError(
      "conflict",
      `${verb}: node must be one of [${
        spec.lifecycle.from.join(", ")
      }], got ${got}`,
    );
  }
  const watchNode = watchNodeOf(item);
  if (watchNode === null || !spec.watch.from.includes(watchNode)) {
    throw new CliError(
      "conflict",
      `${verb}: watch must be one of [${spec.watch.from.join(", ")}], got ${
        watchNode ?? "invalid"
      }`,
    );
  }
  const rebaseAxis = resolveRebaseAxis(spec.rebase, node);
  const rebaseNode = rebaseNodeOf(item);
  if (!rebaseAxis.from.includes(rebaseNode)) {
    throw new CliError(
      "conflict",
      `${verb}: rebase must be one of [${
        rebaseAxis.from.join(", ")
      }], got ${rebaseNode}`,
    );
  }
  return node;
}

// 書き込み後の item 不変条件。verb 実装のバグで到達不能な組や継ぎ目の破壊が state に
// 書かれる前に止める (state.ts の withQueueLock / applyApprove が毎書き込みで呼ぶ)。
// 既存 state.json との互換のため、ここで検査するのは旧実装でも常に成立していた
// 2 条件だけに絞る (より強い性質は state-transitions.test.ts の frame / matrix テストが
// verb の出力に対して検査する)。
export function assertItemInvariants(item: Record<string, unknown>): void {
  if (nodeKeyOf(item) === null) {
    throw new CliError(
      "schema",
      `refusing to write unreachable node: status=${String(item.status)} ` +
        `phase=${String(item.phase)}`,
    );
  }
  const review = isRecord(item.review) ? item.review : null;
  const watch = review && isRecord(review.watch) ? review.watch : null;
  if (watch !== null && (review === null || review.ref == null)) {
    throw new CliError(
      "schema",
      "refusing to write review.watch without review.ref",
    );
  }
}

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// schema_version の正規化: 無ければ末尾に付与、有ればどんな値でも触らない
// (JS オブジェクトの文字列キーは挿入順を保つ仕様を使い、既存キーの順序・値を変えない)
// ---------------------------------------------------------------------------

function withSchemaVersion(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if ("schema_version" in obj) return obj;
  return { ...obj, schema_version: DEFAULT_SCHEMA_VERSION };
}

function buildFreshState(
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    tracker,
    source,
    updated_at: nowIso,
    queue: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    schema_version: DEFAULT_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// queue エントリを対象にする verb が共有するヘルパ群
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queueArray(
  state: Record<string, unknown>,
): Record<string, unknown>[] {
  return Array.isArray(state.queue)
    ? (state.queue as Record<string, unknown>[])
    : [];
}

function findQueueIndex(state: Record<string, unknown>, id: string): number {
  return queueArray(state).findIndex((it) => it.id === id);
}

export function requireQueueItem(
  state: Record<string, unknown>,
  id: string,
): { index: number; item: Record<string, unknown> } {
  const index = findQueueIndex(state, id);
  if (index === -1) {
    throw new CliError("missing", `id not found in queue: ${id}`);
  }
  return { index, item: queueArray(state)[index] };
}

function requirePrecondition(cond: boolean, message: string): void {
  if (!cond) throw new CliError("conflict", message);
}

function withReplacedItem(
  state: Record<string, unknown>,
  index: number,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const q = queueArray(state).slice();
  q[index] = item;
  return { ...state, queue: q };
}

// state.ts の withQueueLock/withExistingStateLock が、遷移関数の戻り値 (生の次状態) に
// 対して呼び出し後に適用する共通の正規化。nowIso は呼び出し元が計算した値。
export function finalizeState(
  next: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  return withSchemaVersion({ ...next, updated_at: nowIso });
}

function getReview(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(item.review) ? item.review : null;
}

function getWatch(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const review = getReview(item);
  if (!review) return null;
  return isRecord(review.watch) ? review.watch : null;
}

function getRebase(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const review = getReview(item);
  if (!review) return null;
  return isRecord(review.rebase) ? review.rebase : null;
}

// review のグループフィールド (ref/branch/tip/base) だけを書き換え、機械 B の
// サブフィールド (watch / rebase / withdrawn / withdrawn_asked) は既存値を保つ。
// in-review の freshGroup はこれを通ることで、pr_fix 復帰のたびに watch (fix_attempts /
// handled) を破壊していた経路 (issue #13 / #15) を構造的に塞ぐ。
function mergeReviewGroup(
  item: Record<string, unknown>,
  group: {
    ref: string;
    branch: string;
    tip: string | null;
    base: string;
  },
): Record<string, unknown> {
  const existing = getReview(item) ?? {};
  return { ...existing, ...group };
}

// watch を持つタスクの揮発資源を落とす (state→stopped, proc→null)。block / restore /
// recover-done が使う: これらの遷移後のノード (blocked / approved / done) は追従の
// 対象外なので、watching のまま残すと停止経路の watch-set (前提: in_review) が
// 詰まり、誰にも止められない watch 状態が残る。watch が無ければ何もしない。
function withStoppedWatch(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const review = getReview(item);
  const watch = getWatch(item);
  if (!review || !watch) return item;
  return {
    ...item,
    review: {
      ...review,
      watch: { ...watch, state: "stopped", proc: null, proc_started_at: null },
    },
  };
}

export interface ReviewOnlyEntry {
  id: string;
  updated_at: string | null;
}

// watch.review_only は review_only を watch.handled に入れず恒久的に沈黙させないための
// フィールドで、後方互換のためスキーマ上も optional。無ければ空配列として読む。
function getReviewOnlyList(
  watch: Record<string, unknown> | null,
): ReviewOnlyEntry[] {
  const raw = watch && Array.isArray(watch.review_only)
    ? watch.review_only
    : [];
  return raw as ReviewOnlyEntry[];
}

// watch.answered は gh-6 (レビュアーの質問に PR 上で返信する経路) で新設したフィールドで、
// review_only と同じく後方互換のため required には入れていない。無ければ空配列として読む。
function getAnsweredList(
  watch: Record<string, unknown> | null,
): ReviewOnlyEntry[] {
  const raw = watch && Array.isArray(watch.answered) ? watch.answered : [];
  return raw as ReviewOnlyEntry[];
}

function unionAppend(existing: unknown, additions: string[]): string[] {
  const base = Array.isArray(existing) ? (existing as string[]) : [];
  const set = new Set(base);
  for (const a of additions) set.add(a);
  return [...set];
}

// ---------------------------------------------------------------------------
// init / get / validate / session-touch / sessions-alive
// ---------------------------------------------------------------------------

// init: 無ければ新規作成、有れば --tracker/--source では上書きせず schema_version
// だけ正規化する (無ければ付与、有れば触らない)。
export function applyInit(
  current: Record<string, unknown> | undefined,
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> | undefined {
  if (current === undefined) return buildFreshState(tracker, source, nowIso);
  if ("schema_version" in current) return undefined;
  return withSchemaVersion(current);
}

// get: 状態オブジェクトをそのまま返すだけ。前提チェックも書き換えも無い
// (読み取り専用 verb、スキーマ検証すら行わない — state-cli-contract.md 「get」節)。
export function get(state: unknown): unknown {
  return state;
}

export function validate(state: unknown): { ok: true } {
  const check = checkState(state);
  if (!check.ok) {
    throw new CliError("schema", `${check.path}: ${check.message}`);
  }
  return { ok: true };
}

// session-touch/sessions-alive: 対象は state.json ではなく <state dir>/sessions/* の
// 個別ファイルの mtime なので「状態オブジェクトの書き換え」自体は無い。しきい値との
// 厳密不等号比較 (heartbeat 契約: 生存 <90分、掃除対象 >1440分、いずれも strict) だけが
// state.ts 内で唯一の判定ロジックなので、ここに切り出して in-process にテスト可能にする。
// ファイルの列挙・stat・remove・utime は state.ts に残る。
export function isSessionStale(
  nowMs: number,
  mtimeMs: number,
  cleanupStaleMin: number,
): boolean {
  return (nowMs - mtimeMs) / 60_000 > cleanupStaleMin;
}

export function isSessionAlive(
  nowMs: number,
  mtimeMs: number,
  aliveMaxMin: number,
): boolean {
  return (nowMs - mtimeMs) / 60_000 < aliveMaxMin;
}

// ---------------------------------------------------------------------------
// history-append
// ---------------------------------------------------------------------------

export function applyHistoryAppend(
  current: Record<string, unknown>,
  line: string,
): Record<string, unknown> {
  const existingHistory = Array.isArray(current.history) ? current.history : [];
  const history = [...existingHistory, line];
  return { ...current, history };
}

// ---------------------------------------------------------------------------
// タスク進行
// ---------------------------------------------------------------------------

export function applyApprove(
  current: Record<string, unknown>,
  id: string,
  title: string,
): Record<string, unknown> {
  requirePrecondition(
    findQueueIndex(current, id) === -1,
    `id already exists in queue: ${id}`,
  );
  const entry: Record<string, unknown> = {
    id,
    title,
    status: "approved",
    gate: "full",
    phase: null,
    attempts: 0,
    session: null,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    blocked_reason: null,
    worktree: null,
    base: null,
    review: null,
  };
  assertItemInvariants(entry);
  const q = queueArray(current).slice();
  q.push(entry);
  return { ...current, queue: q };
}

export function applyClaim(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
): Record<string, unknown> {
  requireVerbAxes(item, "claim");
  const next = {
    ...atNode(item, "in_progress/research"),
    attempts: 0,
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applySetGate(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "set-gate");
  requirePrecondition(
    item.gate === "full",
    `gate must be full, got ${String(item.gate)}`,
  );
  const next = {
    ...atNode(item, "in_progress/research+plan"),
    gate: "light",
  };
  return withReplacedItem(state, index, next);
}

export function applySetWorktree(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  worktree: string,
  base: string,
  drop: boolean,
): Record<string, unknown> {
  requireVerbAxes(item, "set-worktree");
  const next = { ...item, worktree, base };
  let nextState = withReplacedItem(state, index, next);
  if (drop) {
    const id = String(item.id);
    const wb = Array.isArray(state.withdrawn_branches)
      ? (state.withdrawn_branches as Record<string, unknown>[])
      : [];
    const wbIndex = wb.findIndex((e) => e.id === id);
    requirePrecondition(
      wbIndex !== -1,
      `no withdrawn_branches entry for id: ${id}`,
    );
    const nextWb = wb.slice();
    nextWb.splice(wbIndex, 1);
    nextState = { ...nextState, withdrawn_branches: nextWb };
  }
  return nextState;
}

export function applySetExecutor(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  executor: string,
  session: string,
  nowIso: string,
): Record<string, unknown> {
  requireVerbAxes(item, "set-executor");
  const next = {
    ...item,
    executor,
    executor_last_event_at: nowIso,
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applyTouchExecutor(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  sessionIfUnowned: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  requireVerbAxes(item, "touch-executor");
  requirePrecondition(item.executor != null, "executor must be set");
  let next: Record<string, unknown> = {
    ...item,
    executor_last_event_at: nowIso,
  };
  if (sessionIfUnowned !== undefined && next.session == null) {
    next = { ...next, session: sessionIfUnowned };
  }
  return withReplacedItem(state, index, next);
}

export function applySetTakeover(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  atValue: string | null,
): Record<string, unknown> {
  requireVerbAxes(item, "set-takeover");
  const next = { ...item, takeover_at: atValue };
  return withReplacedItem(state, index, next);
}

// phase-pass は gate の検証フェーズ列を 1 つ進める verb。合法な辺は
// GATE_PHASE_SEQUENCES の隣接ペアだけで、表に無い辺 (飛び越し・逆行・自己辺・
// gate 違い・finalize/pr_fix/rebase_fix への出入り) は conflict になる。
// finalize / rebase_fix への遷移は finalize-start / rebase-start が担う。
export function applyPhasePass(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  requireVerbAxes(item, "phase-pass");
  requirePrecondition(
    item.phase === from,
    `phase must be ${from}, got ${String(item.phase)}`,
  );
  requirePrecondition(
    isPhasePassEdge(item.gate, from, to),
    `not a phase-pass edge for gate ${String(item.gate)}: ${from} -> ${to}`,
  );
  const next = {
    ...atNode(item, `in_progress/${to as Phase}`),
    attempts: 0,
  };
  return withReplacedItem(state, index, next);
}

export interface PhaseFailResult {
  state: Record<string, unknown>;
  attempts: number;
}

export function applyPhaseFail(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  phase: string,
): PhaseFailResult {
  requireVerbAxes(item, "phase-fail");
  requirePrecondition(
    item.phase === phase,
    `phase must be ${phase}, got ${String(item.phase)}`,
  );
  const attempts = (typeof item.attempts === "number" ? item.attempts : 0) +
    1;
  const next = { ...item, attempts };
  return { state: withReplacedItem(state, index, next), attempts };
}

// blocked は追従の対象外なので、watch が生きたまま残らないよう withStoppedWatch で
// 揮発資源ごと落とす (pr_fix / rebase_fix の途中で blocked になる経路がある)。
export function applyBlock(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  reason: string,
): Record<string, unknown> {
  requireVerbAxes(item, "block");
  const next = {
    ...withStoppedWatch(atNode(item, "blocked")),
    blocked_reason: reason,
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyDequeue(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "dequeue");
  const q = queueArray(state).slice();
  q.splice(index, 1);
  return { ...state, queue: q };
}

export function applyFinalizeStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  from: string,
): Record<string, unknown> {
  requireVerbAxes(item, "finalize-start");
  requirePrecondition(
    item.phase === from,
    `phase must be ${from}, got ${String(item.phase)}`,
  );
  const next = {
    ...atNode(item, "in_progress/finalize"),
    attempts: 0,
  };
  return withReplacedItem(state, index, next);
}

export interface InReviewArgs {
  freshGroup: boolean;
  ref?: string;
  branch?: string;
  tip?: string;
  base?: string;
  commits: number;
  clearSession: boolean;
}

export function applyInReview(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  args: InReviewArgs,
): Record<string, unknown> {
  requireVerbAxes(item, "in-review");
  let next: Record<string, unknown> = {
    ...atNode(item, "in_review"),
    attempts: 0,
  };
  if (args.freshGroup) {
    // グループフィールドだけを書き換え、watch / rebase / withdrawn / withdrawn_asked は
    // 保つ (mergeReviewGroup)。pr_fix 復帰は毎回ここを通るので、丸ごと置換に戻すと
    // fix_attempts の上限と handled の再浮上ガードが毎周無効化される (issue #13 / #15)。
    next = {
      ...next,
      review: mergeReviewGroup(item, {
        ref: args.ref!,
        branch: args.branch!,
        tip: args.commits >= 1 ? args.tip! : null,
        base: args.base!,
      }),
    };
  }
  if (args.clearSession) {
    next = { ...next, session: null };
  }
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 追従
// ---------------------------------------------------------------------------

export function applyWatchInit(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
  preserve: boolean,
): Record<string, unknown> {
  requireVerbAxes(item, "watch-init");
  const review = getReview(item);
  requirePrecondition(
    review !== null && review.ref != null,
    "review.ref must be set",
  );
  const existingWatch = getWatch(item);
  const existingHandled = preserve && existingWatch &&
      Array.isArray(existingWatch.handled)
    ? (existingWatch.handled as string[])
    : [];
  const watch = {
    state: "watching",
    proc: null,
    proc_started_at: null,
    sig: null,
    head: null,
    ci: null,
    handled: existingHandled,
    fix_pending: false,
    pending_ids: [],
    findings: null,
    fix_attempts: 0,
    errors: 0,
    checked_at: null,
    note: null,
    // review_only/answered は --preserve-handled の対象外: pending_ids/findings と同じく
    // watch-init は常にまっさらから始める (引き継ぎを要求する受け入れ条件は無い)。
    review_only: [],
    answered: [],
  };
  const next = { ...item, review: { ...review, watch }, session };
  return withReplacedItem(state, index, next);
}

export interface WatchSetFields {
  proc?: string | null;
  sig?: string | null;
  head?: string | null;
  ci?: string | null;
  checkedAt?: string | null;
  errorsInc: boolean;
  errorsReset: boolean;
  note?: string | null;
  state?: "watching" | "stopped";
  session?: string | null;
}

export function applyWatchSet(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  fields: WatchSetFields,
  nowIso: string,
): Record<string, unknown> {
  // in_review に限る: 飛行中 (pr_fix / rebase_fix) のタスクの session を watch 側の
  // 機械が null に落とせてしまう継ぎ目を塞ぐ。approved / blocked / done の watch は
  // restore / block / recover-done がそれぞれ落とすので、ここに来る対象は無い。
  requireVerbAxes(item, "watch-set");
  const review = getReview(item);
  const watch = getWatch(item);
  const nextWatch: Record<string, unknown> = { ...watch! };
  if ("proc" in fields) {
    nextWatch.proc = fields.proc;
    nextWatch.proc_started_at = fields.proc === null ? null : nowIso;
  }
  if ("sig" in fields) nextWatch.sig = fields.sig;
  if ("head" in fields) nextWatch.head = fields.head;
  if ("ci" in fields) nextWatch.ci = fields.ci;
  if ("checkedAt" in fields) nextWatch.checked_at = fields.checkedAt;
  if (fields.errorsInc) {
    const cur = typeof watch!.errors === "number" ? watch!.errors : 0;
    nextWatch.errors = cur + 1;
  }
  if (fields.errorsReset) nextWatch.errors = 0;
  if ("note" in fields) nextWatch.note = fields.note;
  if ("state" in fields) nextWatch.state = fields.state;
  let next: Record<string, unknown> = {
    ...item,
    review: { ...review, watch: nextWatch },
  };
  if ("state" in fields && fields.state === "stopped") {
    next = { ...next, session: null };
  }
  if ("session" in fields) {
    next = { ...next, session: fields.session };
  }
  return withReplacedItem(state, index, next);
}

export function applyFixPending(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  pendingIds: string[],
  findings: string,
): Record<string, unknown> {
  requireVerbAxes(item, "fix-pending");
  const review = getReview(item);
  const watch = getWatch(item);
  const nextWatch = {
    ...watch,
    fix_pending: true,
    pending_ids: pendingIds,
    findings,
  };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return withReplacedItem(state, index, next);
}

export interface FixStartResult {
  state: Record<string, unknown>;
  started: boolean;
  fixAttempts: number;
}

// 前提に watch.state=="watching" を含める: 上限到達で stopped にした後は、この verb 自体が
// conflict になる (ラッチ)。前提が真のまま残って呼ぶたびに fix_attempts を加算し続ける
// 経路 (確認済み欠陥 9) を塞ぐ。ユーザーが手で watching に戻したときだけ再び呼べる。
export function applyFixStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
  reset: boolean,
): FixStartResult {
  requireVerbAxes(item, "fix-start");
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    watch!.fix_pending === true,
    "watch.fix_pending must be true",
  );
  const baseAttempts = reset
    ? 0
    : (typeof watch!.fix_attempts === "number" ? watch!.fix_attempts : 0);
  const fixAttempts = baseAttempts + 1;
  const started = fixAttempts <= 3;
  let nextWatch: Record<string, unknown>;
  let next: Record<string, unknown>;
  if (started) {
    nextWatch = { ...watch, fix_attempts: fixAttempts, fix_pending: false };
    next = {
      ...atNode(item, "in_progress/pr_fix"),
      attempts: 0,
      session,
      review: { ...review, watch: nextWatch },
    };
  } else {
    nextWatch = {
      ...watch,
      fix_attempts: fixAttempts,
      state: "stopped",
      note: "追従上限",
    };
    next = {
      ...item,
      session: null,
      review: { ...review, watch: nextWatch },
    };
  }
  return {
    state: withReplacedItem(state, index, next),
    started,
    fixAttempts,
  };
}

export function applyFixDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "fix-done");
  const review = getReview(item);
  const watch = getWatch(item);
  const pendingIds = Array.isArray(watch!.pending_ids)
    ? (watch!.pending_ids as string[])
    : [];
  const nextWatch = {
    ...watch,
    handled: unionAppend(watch!.handled, pendingIds),
    pending_ids: [],
    findings: null,
  };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return withReplacedItem(state, index, next);
}

export interface ReviewOnlyResult {
  state: Record<string, unknown>;
  newOrChanged: string[];
  total: number;
}

export function applyReviewOnly(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  items: ReviewOnlyEntry[],
): ReviewOnlyResult {
  requireVerbAxes(item, "review-only");
  const review = getReview(item);
  const watch = getWatch(item);
  const existing = getReviewOnlyList(watch);
  const byId = new Map(existing.map((e) => [e.id, e.updated_at]));
  const newOrChanged: string[] = [];
  for (const it of items) {
    const known = byId.has(it.id);
    const prev = byId.get(it.id);
    const changed = !known || prev === null || it.updated_at === null ||
      prev !== it.updated_at;
    if (changed) newOrChanged.push(it.id);
    byId.set(it.id, it.updated_at);
  }
  const nextList: ReviewOnlyEntry[] = [...byId.entries()].map((
    [rid, updatedAt],
  ) => ({ id: rid, updated_at: updatedAt }));
  const total = nextList.length;
  const nextWatch = { ...watch, review_only: nextList };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total,
  };
}

// watch.answered は review_only と同じ入出力契約 (id/updated_at の upsert・dedup) を持つが、
// 別フィールド・別語彙にする (gh-6)。watch.handled は「pr_fix で実際にコードを直した」ことを
// 表す語彙、watch.review_only は「人の判断が要ると回した」ことを表す語彙で、どちらとも意味が
// 違う「質問に回答・投稿済み」をこの2つに混ぜると、次に読む executor/verifier が誤読する。
// ReviewOnlyResult をそのまま再利用する (戻り値の形が同一のため)。
export function applyAnsweredSet(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  items: ReviewOnlyEntry[],
): ReviewOnlyResult {
  requireVerbAxes(item, "answered-set");
  const review = getReview(item);
  const watch = getWatch(item);
  const existing = getAnsweredList(watch);
  const byId = new Map(existing.map((e) => [e.id, e.updated_at]));
  const newOrChanged: string[] = [];
  for (const it of items) {
    const known = byId.has(it.id);
    const prev = byId.get(it.id);
    const changed = !known || prev === null || it.updated_at === null ||
      prev !== it.updated_at;
    if (changed) newOrChanged.push(it.id);
    byId.set(it.id, it.updated_at);
  }
  const nextList: ReviewOnlyEntry[] = [...byId.entries()].map((
    [rid, updatedAt],
  ) => ({ id: rid, updated_at: updatedAt }));
  const total = nextList.length;
  // answered-set は watch.handled にも watch.review_only にも触れない (語彙の非混入)。
  const nextWatch = { ...watch, answered: nextList };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total,
  };
}

// ---------------------------------------------------------------------------
// 載せ直し
// ---------------------------------------------------------------------------

export function applyRebaseRecord(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  blockedOnto: string,
  reason: string,
  kind: string | undefined,
  cause: string | undefined,
  report: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  requireVerbAxes(item, "rebase-record");
  const review = getReview(item);
  requirePrecondition(review !== null, "review must be present");
  const existingRebase = getRebase(item);
  const nextRebase: Record<string, unknown> = {
    ...(existingRebase ?? {}),
    blocked_onto: blockedOnto,
    reason,
    at: existingRebase?.at ?? nowIso,
  };
  if (kind !== undefined) nextRebase.kind = kind;
  if (cause !== undefined) nextRebase.cause = cause;
  if (report !== undefined) nextRebase.report = report;
  const next = { ...item, review: { ...review, rebase: nextRebase } };
  return withReplacedItem(state, index, next);
}

export function applyRebaseResolvePending(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  fromTip: string,
): Record<string, unknown> {
  requireVerbAxes(item, "rebase-resolve-pending");
  const review = getReview(item);
  const rebase = getRebase(item);
  const nextRebase = {
    ...rebase,
    resolve_pending: true,
    from_tip: fromTip,
  };
  const next = { ...item, review: { ...review, rebase: nextRebase } };
  return withReplacedItem(state, index, next);
}

// rebase_fix への入口は 2 つ (VERB_LIFECYCLE 参照):
// - in_review から: 背景の載せ直しが衝突し rebase-record / rebase-resolve-pending で
//   控えた復帰。resolve_pending が真であることを要求し、消費する。
// - in_progress/finalize から: executor が push 直前の載せ直しで REBASE-CONFLICT 停止
//   した直接進入。review が無いこともある (最初の PR を出す直前) ので review を見ない。
//   衝突の控えとトリアージ結果はオーケストレーターがイテレーション内で持ち回る。
export function applyRebaseStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
): Record<string, unknown> {
  requireVerbAxes(item, "rebase-start");
  const review = getReview(item);
  const rebase = getRebase(item);
  let next: Record<string, unknown> = {
    ...atNode(item, "in_progress/rebase_fix"),
    attempts: 0,
    session,
  };
  if (rebase !== null) {
    next = {
      ...next,
      review: { ...review, rebase: { ...rebase, resolve_pending: false } },
    };
  }
  return withReplacedItem(state, index, next);
}

// in_review に限る: 飛行中 (in_progress/rebase_fix) に呼ぶと review.rebase が消え、
// applyRebaseGiveUp の前提が永久に満たせなくなる (確認済み欠陥 10)。復帰列では
// in-review で in_review に戻した後に呼ぶ。review.rebase は要求しない — 背景の
// 載せ直しが初回の試行で衝突なく成功した最頻パスには rebase-record の控えが無く、
// それでも tip の更新 (マージ回収の鍵) はこの verb にしか無い (確認済み欠陥 12)。
export function applyRebaseDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  tip: string,
): Record<string, unknown> {
  requireVerbAxes(item, "rebase-done");
  const review = getReview(item);
  requirePrecondition(review !== null, "review must be present");
  const nextReview: Record<string, unknown> = { ...review, tip };
  delete nextReview.rebase;
  const next = { ...item, review: nextReview };
  return withReplacedItem(state, index, next);
}

export function applyRebaseGiveUp(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  blockedOnto: string,
): Record<string, unknown> {
  requireVerbAxes(item, "rebase-give-up");
  const review = getReview(item);
  const rebase = getRebase(item);
  const nextRebase = {
    ...rebase,
    reason: "conflict",
    blocked_onto: blockedOnto,
    resolve_pending: false,
  };
  const next = {
    ...atNode(item, "in_review"),
    attempts: 0,
    session: null,
    review: { ...review, rebase: nextRebase },
  };
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 回収と候補
// ---------------------------------------------------------------------------

// done は追従の対象外なので、watch を watching のまま残さない (確認済み欠陥 7:
// proc だけ null にして state を watching のまま残すと、停止経路が「自分の担当」として
// 数え続ける)。withStoppedWatch が state→stopped / proc→null / proc_started_at→null を
// まとめて行う。
export function applyRecoverDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "recover-done");
  const review = getReview(item);
  requirePrecondition(
    review !== null && review.tip != null,
    "review.tip must be present",
  );
  const next = {
    ...withStoppedWatch(atNode(item, "done")),
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyWithdraw(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "withdraw");
  const review = getReview(item);
  requirePrecondition(review !== null, "review must be present");
  const next = { ...item, review: { ...review, withdrawn: true } };
  return withReplacedItem(state, index, next);
}

export function applyWithdrawRemove(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  reason: string,
  nowIso: string,
): Record<string, unknown> {
  requireVerbAxes(item, "withdraw-remove");
  const review = getReview(item);
  requirePrecondition(
    review !== null && review.withdrawn === true && item.worktree != null &&
      item.base != null,
    "review.withdrawn must be true and worktree/base must be set",
  );
  const id = String(item.id);
  const entry = {
    id,
    branch: `task-pipeline/${id}`,
    base: item.base as string,
    worktree: item.worktree as string,
    at: nowIso,
    reason,
  };
  const wb = Array.isArray(state.withdrawn_branches)
    ? (state.withdrawn_branches as unknown[]).slice()
    : [];
  wb.push(entry);
  const q = queueArray(state).slice();
  q.splice(index, 1);
  return { ...state, queue: q, withdrawn_branches: wb };
}

export function applyWithdrawAsked(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requireVerbAxes(item, "withdraw-asked");
  const review = getReview(item);
  requirePrecondition(
    review !== null && review.withdrawn === true,
    "review.withdrawn must be true",
  );
  const next = { ...item, review: { ...review, withdrawn_asked: true } };
  return withReplacedItem(state, index, next);
}

export function applyCandidatesSet(
  current: Record<string, unknown>,
  candidates: unknown[],
): Record<string, unknown> {
  return { ...current, candidates };
}

export function applyCandidatesDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.candidates)
    ? (current.candidates as Record<string, unknown>[])
    : [];
  const idx = arr.findIndex((c) => c.id === id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in candidates: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, candidates: next };
}

export function applyPromotedAdd(
  current: Record<string, unknown>,
  ids: string[],
): Record<string, unknown> {
  const next = unionAppend(current.promoted, ids);
  return { ...current, promoted: next };
}

export function applyPromotedDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.promoted)
    ? (current.promoted as string[])
    : [];
  const idx = arr.indexOf(id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in promoted: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, promoted: next };
}

export function applyRelistedAdd(
  current: Record<string, unknown>,
  id: string,
  seenAt: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.relisted)
    ? (current.relisted as Record<string, unknown>[])
    : [];
  requirePrecondition(
    arr.findIndex((r) => r.id === id) === -1,
    `id already exists in relisted: ${id}`,
  );
  const next = [...arr, { id, seen_at: seenAt }];
  return { ...current, relisted: next };
}

export function applyRelistedDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.relisted)
    ? (current.relisted as Record<string, unknown>[])
    : [];
  const idx = arr.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in relisted: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, relisted: next };
}

// worktree / base / review は意図して残す (done の回収まで worktree もブランチも PR も
// 消さないため)。ただし watch は withStoppedWatch で落とす — approved に戻ったタスクは
// 追従の対象外で、前回周回の watching / proc を抱えたまま再入すると、停止経路の
// watch-set (前提: in_review) が詰まる (確認済み欠陥 8)。fix_attempts / handled の値は
// 残るが、次の周回のレビュー待ちで watch-init (--preserve-handled) が仕切り直す。
// relisted に無い場合は「対象が存在しない」なので missing (契約と揃える)。
export function applyRestore(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(item.id);
  const relisted = Array.isArray(state.relisted)
    ? (state.relisted as Record<string, unknown>[])
    : [];
  const rIndex = relisted.findIndex((r) => r.id === id);
  if (rIndex === -1) {
    throw new CliError("missing", `id not found in relisted: ${id}`);
  }
  requireVerbAxes(item, "restore");
  // gate も初期値 (full) に戻す — 残すと light のタスクが claim 後に
  // (in_progress/research, gate: light) という死にノードに着地する (light の
  // フェーズ列に research の辺が無く、set-gate も gate!=full で拒否するため)。
  // gate の正はトラッカー側の宣言で、再 claim 時のタスク実行手順 1 の機械判定が
  // 改めて light に切り替えるので、ここで落としても情報は失われない。
  const nextItem = {
    ...withStoppedWatch(atNode(item, "approved")),
    gate: "full",
    attempts: 0,
    session: null,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    blocked_reason: null,
  };
  const nextRelisted = relisted.slice();
  nextRelisted.splice(rIndex, 1);
  const withItem = withReplacedItem(state, index, nextItem);
  return { ...withItem, relisted: nextRelisted };
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

export function applyStalledSet(
  current: Record<string, unknown>,
  value: "depleted" | "max_open" | "null",
  bump: boolean,
  nowIso: string,
): Record<string, unknown> {
  if (value === "null") {
    return { ...current, stalled: null, stalled_since: null };
  }
  const wasNull = current.stalled == null;
  let stalledSince = current.stalled_since ?? null;
  if (wasNull || bump) stalledSince = nowIso;
  return { ...current, stalled: value, stalled_since: stalledSince };
}
