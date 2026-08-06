// task-pipeline/scripts/state-model-v2.ts
//
// 状態モデル v2 (task-pipeline/docs/state-model-v2-2026-08.md 1.1〜1.5節・4.2節) の
// 語彙・ノード導出・不変条件・到達可能性テストの枠を純関数として新設するファイル。
//
// - v1 (state-transitions.ts / state.ts / state.schema.json) には一切依存しない。
//   v1 の語彙 (STATUS_VALUES 等) は再利用せず、ここで自己完結して定義する。
// - 遷移 (verb) の実装・queueItem 全体のJSON Schema化 (設計3.1b節) は今回のスコープ外
//   (後続issue)。ここにあるのは領域P/Aの語彙・ノード導出・不変条件検査・到達可能性
//   テストの枠のみ — apply系のverb関数は1つも無い。
// - Deno API を呼ばない純粋関数群 (state-schema.ts / state-ownership.ts と同型)。
//
// テスト: state-model-v2.test.ts (直接importで検査)。実行は tests/state-model-v2.test.sh
// (deno fmt/lint/check/test を通しで回す) 経由、または tests/run.sh の glob 自動検出。

// ---------------------------------------------------------------------------
// 領域 P (進行) の語彙・ノード — 設計1.1・1.2・1.5節
// ---------------------------------------------------------------------------

export const PROGRESS_VALUES = [
  "queued",
  "running",
  "resting",
  "blocked",
] as const;
export type Progress = (typeof PROGRESS_VALUES)[number];

export const RUN_KIND_VALUES = ["initial", "pr_fix", "rebase_fix"] as const;
export type RunKind = (typeof RUN_KIND_VALUES)[number];

export const GATE_VALUES = ["full", "light"] as const;
export type Gate = (typeof GATE_VALUES)[number];

// kind==initial の gate ごとの検証フェーズ列 (finalize を含まない。1.2節の表)。
export const INITIAL_GATE_PHASE_SEQUENCES = {
  full: ["research", "plan", "implement", "report"],
  light: ["research+plan", "implement", "report"],
} as const;

export const FINALIZE_PHASE = "finalize" as const;
// どの kind の finalize にも rebase_fix フェーズへの迂回辺がある (1.2節)。
export const REBASE_FIX_DETOUR_PHASE = "rebase_fix" as const;

export interface RunAxis {
  readonly kind: RunKind;
  readonly gate: Gate | null; // kind=="initial" のとき、かつそのときに限り非null
}

// kind×gate の4組。initial だけが gate を持つ (full/light)。pr_fix / rebase_fix は
// gate=null (1.2節の表そのもの)。
export const RUN_AXES: readonly RunAxis[] = [
  { kind: "initial", gate: "full" },
  { kind: "initial", gate: "light" },
  { kind: "pr_fix", gate: null },
  { kind: "rebase_fix", gate: null },
];

function runAxisKey(axis: RunAxis): string {
  return axis.gate === null ? axis.kind : `${axis.kind}/${axis.gate}`;
}

// axisKey → 迂回フェーズ込みの全フェーズ列 (検証フェーズ + finalize + 迂回rebase_fix)。
// rebase_fix kind 自身は既に rebase_fix を主フェーズとして持つため、末尾に別途足さない
// (research.mdの表: 6/5/3/2)。「動的に末尾へ足すかどうかを毎回判定する」形ではなく、
// 各axisの確定した列として最初から宣言する (PRレビュー指摘: 動的合成に意味が無い)。
const PHASES_BY_AXIS: Readonly<Record<string, readonly string[]>> = {
  "initial/full": [
    ...INITIAL_GATE_PHASE_SEQUENCES.full,
    FINALIZE_PHASE,
    REBASE_FIX_DETOUR_PHASE,
  ],
  "initial/light": [
    ...INITIAL_GATE_PHASE_SEQUENCES.light,
    FINALIZE_PHASE,
    REBASE_FIX_DETOUR_PHASE,
  ],
  "pr_fix": ["pr_fix", FINALIZE_PHASE, REBASE_FIX_DETOUR_PHASE],
  "rebase_fix": [REBASE_FIX_DETOUR_PHASE, FINALIZE_PHASE],
};

export function phasesForAxis(axis: RunAxis): readonly string[] {
  const phases = PHASES_BY_AXIS[runAxisKey(axis)];
  if (phases === undefined) {
    throw new Error(`BUG: unknown run axis ${runAxisKey(axis)}`);
  }
  return phases;
}

// RunAxis (kind×gate) に phase を合成した形であることを型でも表す (extends RunAxis)。
// key() は自身のキー文字列 ("queued"/"resting"/"blocked" と同じ語彙の
// `running(${kind},${gate|"-"},${phase})`) を返す — ノード自身がキーを返すメソッドを
// 持つ形にした (独立関数を都度呼ぶのではなく、生成時にノードへ束ねる)。
export interface RunNode extends RunAxis {
  readonly phase: string;
  key(): string;
}

function makeRunNode(axis: RunAxis, phase: string): RunNode {
  const { kind, gate } = axis;
  return {
    kind,
    gate,
    phase,
    key: () => `running(${kind},${gate ?? "-"},${phase})`,
  };
}

export function listRunNodes(): readonly RunNode[] {
  const nodes: RunNode[] = [];
  for (const axis of RUN_AXES) {
    for (const phase of phasesForAxis(axis)) {
      nodes.push(makeRunNode(axis, phase));
    }
  }
  return nodes;
}

export const NON_RUNNING_P_NODE_KEYS = [
  "queued",
  "resting",
  "blocked",
] as const;

// 領域Pの合法ノードキー全部 (queued/resting/blocked + running(...)の16) = 19。
export const P_NODE_KEYS: readonly string[] = [
  ...NON_RUNNING_P_NODE_KEYS,
  ...listRunNodes().map((node) => node.key()),
];

// 任意の (kind, gate, phase) 組が RUN_AXES × phasesForAxis の宣言に含まれるかを判定。
export function isLegalRunNode(
  node: {
    readonly kind: RunKind;
    readonly gate: Gate | null;
    readonly phase: string;
  },
): boolean {
  const axis = RUN_AXES.find((a) =>
    a.kind === node.kind && a.gate === node.gate
  );
  if (axis === undefined) return false;
  return phasesForAxis(axis).includes(node.phase);
}

// ---------------------------------------------------------------------------
// 領域 A (成果物) の語彙・サブ軸座標 — 設計1.1・1.3・1.5節
// ---------------------------------------------------------------------------

export const ARTIFACT_STATE_VALUES = [
  "none",
  "open",
  "merged",
  "withdrawn",
] as const;
export type ArtifactState = (typeof ARTIFACT_STATE_VALUES)[number];

export const HUMAN_ATTENTION_REASON_VALUES = [
  "fix_limit",
  "errors",
  "manual",
] as const;
export type HumanAttentionReason =
  (typeof HUMAN_ATTENTION_REASON_VALUES)[number];

export type Attention = "auto" | { readonly human: HumanAttentionReason };

export interface FixAskRecord {
  readonly ids: readonly string[];
  readonly findings: string;
  readonly taken: boolean;
}
export type FixAsk = FixAskRecord | null;

export const FIX_ASK_AXIS_VALUES = ["null", "pending", "taken"] as const;
export type FixAskAxis = (typeof FIX_ASK_AXIS_VALUES)[number];

export function fixAskAxisOf(fixAsk: FixAsk): FixAskAxis {
  if (fixAsk === null) return "null";
  return fixAsk.taken ? "taken" : "pending";
}

export interface RebaseAskRecord {
  readonly blocked_onto: string;
  readonly reason: string;
  readonly kind?: string;
  readonly cause?: string;
  readonly report?: string;
  readonly at: string;
  readonly resolve: boolean;
  readonly from_tip?: string;
  readonly taken: boolean;
}
export type RebaseAsk = RebaseAskRecord | null;

export const REBASE_ASK_AXIS_VALUES = ["taken", "queued", "quiet"] as const;
export type RebaseAskAxis = (typeof REBASE_ASK_AXIS_VALUES)[number];

// 判定順: taken が真 → "taken"、resolve が真 → "queued"、それ以外 → "quiet" (1.5節に明記)。
export function rebaseAskAxisOf(rebaseAsk: RebaseAsk): RebaseAskAxis {
  if (rebaseAsk === null) return "quiet";
  if (rebaseAsk.taken) return "taken";
  if (rebaseAsk.resolve) return "queued";
  return "quiet";
}

// probe レコードのうち不変条件4の検査に要る最小形 (proc の有無だけ。他フィールド
// (proc_started_at/sig/head/ci/checked_at/errors/note) はこのタスクでは扱わない)。
export interface ProbeRecord {
  readonly proc: string | null;
}

export interface FollowRecord {
  readonly attention: Attention;
  readonly asks: {
    readonly fix: FixAsk;
    readonly rebase: RebaseAsk;
  };
  readonly probe: ProbeRecord;
}

export interface OpenSubAxes {
  readonly attention: "auto" | "human";
  readonly fixAsk: FixAskAxis;
  readonly rebaseAsk: RebaseAskAxis;
}

// 領域Aのサブ軸座標 (attention 2値 × fix-ask 3値 × rebase-ask 3値。follow の3サブ軸)。
export function openSubAxesOf(follow: FollowRecord): OpenSubAxes {
  return {
    attention: follow.attention === "auto" ? "auto" : "human",
    fixAsk: fixAskAxisOf(follow.asks.fix),
    rebaseAsk: rebaseAskAxisOf(follow.asks.rebase),
  };
}

// ---------------------------------------------------------------------------
// 導出関数 — 設計1.1・1.3節
// ---------------------------------------------------------------------------

export const DERIVED_STATUS_VALUES = [
  "approved",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUS_VALUES)[number];

// 現行 status への導出式 (1.1節):
//   queued          → approved
//   running         → in_progress
//   blocked         → blocked
//   resting ∧ merged → done
//   resting ∧ その他 → in_review
export function deriveStatus(
  progress: Progress,
  artifactState: ArtifactState,
): DerivedStatus {
  switch (progress) {
    case "queued":
      return "approved";
    case "running":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "resting":
      return artifactState === "merged" ? "done" : "in_review";
  }
}

// 追従対象の導出式 (1.3節):
//   P==resting ∧ A==open ∧ follow≠null ∧ attention==auto
//   ∧ fix-ask が null ∧ rebase-ask が quiet
export function isFollowTarget(
  progress: Progress,
  artifactState: ArtifactState,
  follow: FollowRecord | null,
): boolean {
  if (progress !== "resting") return false;
  if (artifactState !== "open") return false;
  if (follow === null) return false;
  if (follow.attention !== "auto") return false;
  if (fixAskAxisOf(follow.asks.fix) !== "null") return false;
  if (rebaseAskAxisOf(follow.asks.rebase) !== "quiet") return false;
  return true;
}

// ---------------------------------------------------------------------------
// 不変条件検査関数 — 設計1.5節 (番号1〜5) + gate iffの専用関数
//
// すべて (...) => boolean の述語。「その書き込みで触った item だけに掛ける」方針
// (docs/lessons/2026-08-06-runtime-invariants-touched-item-only.md) どおり、1件分の
// データを引数に取る形にし、queue全体を走査する形にはしない。
// ---------------------------------------------------------------------------

// 不変条件1: run ≠ null ⇔ progress == running
export function invariantRunProgressConsistent(
  progress: Progress,
  run: unknown,
): boolean {
  const runIsPresent = run !== null && run !== undefined;
  return runIsPresent === (progress === "running");
}

// 不変条件2: artifact.state == merged ⇒ progress == resting
export function invariantMergedImpliesResting(
  artifactState: ArtifactState,
  progress: Progress,
): boolean {
  return artifactState !== "merged" || progress === "resting";
}

// 不変条件3: progress == running(pr_fix) ⇒
//            artifact.state == open ∧ follow ≠ null ∧ asks.fix.taken
export function invariantPrFixImpliesOpenTaken(
  progress: Progress,
  run: { readonly kind: RunKind } | null,
  artifactState: ArtifactState,
  follow: FollowRecord | null,
): boolean {
  const inPrFix = progress === "running" && run !== null &&
    run.kind === "pr_fix";
  if (!inPrFix) return true;
  return (
    artifactState === "open" &&
    follow !== null &&
    follow.asks.fix !== null &&
    follow.asks.fix.taken === true
  );
}

// 不変条件4: probe.proc ≠ null ⇒ progress == resting
// (実行中に追従リースは張らない。fix-start/rebase-start は proc を null にしてから
// run を作る — 遷移側の責務。ここでは snapshot 上の帰結だけを検査する)
export function invariantProbeProcImpliesResting(
  progress: Progress,
  probeProc: string | null,
): boolean {
  return probeProc === null || progress === "resting";
}

// 不変条件5 (検査可能な残差): taken==true ⇒ progress == running。
//
// 設計1.5節の不変条件5本体は「外部要求(fix-request/rebase-request)の受理は
// progress==resting のときだけ」という **verb 前提** の記述であり、taken に触れてよい
// verb を列挙する規律込みで書かれている。これは書き込みイベントの検査であって、単一
// スナップショットからは「受理が正しい時点で起きたか」自体を判定できない (遷移の実装は
// このタスクのスコープ外。research.md「不変条件1〜5」節を参照)。
//
// ただし taken は fix-start/rebase-start の消費開始 (progress を running に進める) から
// ship/give-up/claim の消費終了 (progress を resting/queued に戻す) までの間だけ真になり
// うるので、「taken==true ならその瞬間 progress==running である」はどの時点の
// スナップショットでも成立する構造的帰結として検査できる。ここではその残差を実装する。
export function invariantTakenImpliesRunning(
  progress: Progress,
  fixAsk: FixAsk,
  rebaseAsk: RebaseAsk,
): boolean {
  const anyTaken = (fixAsk !== null && fixAsk.taken) ||
    (rebaseAsk !== null && rebaseAsk.taken);
  return !anyTaken || progress === "running";
}

// gate iff kind==initial (1.2節の run 定義、3.1b節のノードごとのスキーマ記述で明示)。
// 1.5節の番号付き不変条件1〜5とは別立て (受け入れ条件4)。
export function invariantGateNonNullIffKindInitial(
  run: { readonly kind: RunKind; readonly gate: Gate | null },
): boolean {
  return (run.gate !== null) === (run.kind === "initial");
}

// ---------------------------------------------------------------------------
// 到達可能性テストの枠 — 設計4.2節
//
// 「宣言された辺グラフを初期ノードから辿り、(a) 各領域の宣言ノードすべてに到達できる
// こと、(b) 積の組で到達できないものは『意図的な到達不能』として明示リストに載っている
// こと、を機械検査する」枠組み。実辺 (kind/phase/asksの実際の遷移) の接続は後続issue
// (遷移実装) の責務 — ここでは枠自体を小さなダミーグラフでテストする。
//
// 「意図的到達不能リストのノードが実は到達可能になっていないか」の逆方向検査は、設計
// 4.2節が明示的に行列テスト (T-MX、後続issue) の出力不変条件の責務としているため、
// ここでは実装しない (スコープの重複を避ける)。
// ---------------------------------------------------------------------------

export interface ReachabilityEdge<Node extends string> {
  readonly from: Node;
  readonly to: Node;
}

export interface ReachabilityCheckResult<Node extends string> {
  readonly ok: boolean;
  // 到達できなかった宣言ノード全部 (許可リストに載っているかは問わない)
  readonly unreached: readonly Node[];
  // 到達できず、かつ意図的到達不能リストにも無いもの (= 死に組の疑い。ok=falseの根拠)
  readonly unexpectedUnreachable: readonly Node[];
}

export function checkReachability<Node extends string>(
  nodes: readonly Node[],
  edges: readonly ReachabilityEdge<Node>[],
  start: Node,
  intentionallyUnreachable: readonly Node[],
): ReachabilityCheckResult<Node> {
  const adjacency = new Map<Node, Node[]>();
  for (const n of nodes) adjacency.set(n, []);
  for (const e of edges) {
    const bucket = adjacency.get(e.from);
    if (bucket === undefined) {
      adjacency.set(e.from, [e.to]);
    } else {
      bucket.push(e.to);
    }
  }

  const visited = new Set<Node>([start]);
  const queue: Node[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as Node;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const allowedUnreachable = new Set(intentionallyUnreachable);
  const unreached = nodes.filter((n) => !visited.has(n));
  const unexpectedUnreachable = unreached.filter((n) =>
    !allowedUnreachable.has(n)
  );

  return {
    ok: unexpectedUnreachable.length === 0,
    unreached,
    unexpectedUnreachable,
  };
}
