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
// - レコード (axis / ask / probe / follow) は素の値比較を外へ散らさず、意味のある名前の
//   メソッドで問い合わせる形にしてある。**生成は必ず対応する make* ファクトリを使うこと** —
//   メソッドは生成時の値を閉じ込めるので、既存レコードをスプレッドして一部フィールドだけ
//   差し替えると、メソッドが古い値のまま答える。差し替えたいときは make* で組み直す。
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

// initial は gate を必ず持ち、それ以外の kind は必ず持たない。この差を同じ型の
// `gate: Gate | null` で潰さず、判別可能ユニオンとして型を分ける — 「gate は
// kind==initial のとき、かつそのときに限り非null」(1.2節) が型の構造そのものになる。
export type FixRunKind = Exclude<RunKind, "initial">;

interface RunAxisMethods {
  // 自身のキー文字列 (PHASES_BY_AXIS の引き先であり、ノードキーの構成要素)。
  axisKey(): string;
  // 迂回フェーズ込みの、この axis の全フェーズ列。
  phases(): readonly string[];
}

export interface InitialRunAxis extends RunAxisMethods {
  readonly kind: "initial";
  readonly gate: Gate;
}

export interface FixRunAxis extends RunAxisMethods {
  readonly kind: FixRunKind;
  readonly gate: null;
}

export type RunAxis = InitialRunAxis | FixRunAxis;

// axisKey → 迂回フェーズ込みの全フェーズ列 (検証フェーズ + finalize + 迂回rebase_fix)。
// rebase_fix kind 自身は既に rebase_fix を主フェーズとして持つため、末尾に別途足さない
// (research.mdの表: 6/5/3/2)。
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

function phasesByAxisKey(axisKey: string): readonly string[] {
  const phases = PHASES_BY_AXIS[axisKey];
  if (phases === undefined) {
    throw new Error(`BUG: unknown run axis ${axisKey}`);
  }
  return phases;
}

export function makeInitialAxis(gate: Gate): InitialRunAxis {
  const axisKey = `initial/${gate}`;
  return {
    kind: "initial",
    gate,
    axisKey: () => axisKey,
    phases: () => phasesByAxisKey(axisKey),
  };
}

export function makeFixAxis(kind: FixRunKind): FixRunAxis {
  return {
    kind,
    gate: null,
    axisKey: () => kind,
    phases: () => phasesByAxisKey(kind),
  };
}

// kind×gate の4組 (1.2節の表そのもの)。
export const RUN_AXES: readonly RunAxis[] = [
  makeInitialAxis("full"),
  makeInitialAxis("light"),
  makeFixAxis("pr_fix"),
  makeFixAxis("rebase_fix"),
];

// RunAxis に phase を合成した形であることを型でも表す (RunAxis との交差型)。
// key() はノード自身のキー文字列を返すメソッド (axis 側の axisKey() とは別物)。
export type RunNode = RunAxis & {
  readonly phase: string;
  key(): string;
};

function makeRunNode(axis: RunAxis, phase: string): RunNode {
  const key = `running(${axis.kind},${axis.gate ?? "-"},${phase})`;
  return { ...axis, phase, key: () => key };
}

export function listRunNodes(): readonly RunNode[] {
  const nodes: RunNode[] = [];
  for (const axis of RUN_AXES) {
    for (const phase of axis.phases()) {
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

// 任意の (kind, gate, phase) 組が RUN_AXES × axis.phases() の宣言に含まれるかを判定。
// 引数は外から来る素の形 (型で守られていないデータ) を受けるため、判別可能ユニオンの
// RunAxis ではなく平坦な形で受ける。
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
  return axis.phases().includes(node.phase);
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

export const FIX_ASK_AXIS_VALUES = ["null", "pending", "taken"] as const;
export type FixAskAxis = (typeof FIX_ASK_AXIS_VALUES)[number];

// レコードが存在するときに取りうる軸 ("null" は「レコードが無い」の意味なので除く)。
export type PresentFixAskAxis = Exclude<FixAskAxis, "null">;

export interface FixAskFields {
  readonly ids: readonly string[];
  readonly findings: string;
  readonly taken: boolean;
}

// 値の素の比較 (`fix.taken === true` 等) を外に散らさず、意味のある名前のメソッドで
// 与える (レビュー指摘 rv-4876745244)。
export interface FixAskRecord extends FixAskFields {
  // 要求が仕上げ run に消費済みか (fix-start が taken を立てた後か)。
  isTaken(): boolean;
  // 未消費の要求として保留中か。
  isPending(): boolean;
  axis(): PresentFixAskAxis;
}

export function makeFixAsk(fields: FixAskFields): FixAskRecord {
  const { ids, findings, taken } = fields;
  return {
    ids,
    findings,
    taken,
    isTaken: () => taken,
    isPending: () => !taken,
    axis: () => (taken ? "taken" : "pending"),
  };
}

export type FixAsk = FixAskRecord | null;

// null (レコード自体が無い) を含めた3値への導出。レコードが有るときの判定は
// レコード自身の axis() が持ち、ここは null の場合だけを足す薄い包み。
export function fixAskAxisOf(fixAsk: FixAsk): FixAskAxis {
  return fixAsk === null ? "null" : fixAsk.axis();
}

export const REBASE_ASK_AXIS_VALUES = ["taken", "queued", "quiet"] as const;
export type RebaseAskAxis = (typeof REBASE_ASK_AXIS_VALUES)[number];

export interface RebaseAskFields {
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

export interface RebaseAskRecord extends RebaseAskFields {
  // 要求が解決サイクル run に消費済みか。
  isTaken(): boolean;
  // 解決サイクル行きが宣言されていて、まだ消費されていないか。
  isResolveQueued(): boolean;
  // 発火可否を変えない、載せ直しガードの控えだけの状態か。
  isQuiet(): boolean;
  // 判定順: taken が真 → "taken"、resolve が真 → "queued"、それ以外 → "quiet" (1.5節)。
  axis(): RebaseAskAxis;
}

export function makeRebaseAsk(fields: RebaseAskFields): RebaseAskRecord {
  const isTaken = () => fields.taken;
  const isResolveQueued = () => !fields.taken && fields.resolve;
  const axis = (): RebaseAskAxis => {
    if (isTaken()) return "taken";
    if (isResolveQueued()) return "queued";
    return "quiet";
  };
  return {
    ...fields,
    isTaken,
    isResolveQueued,
    isQuiet: () => axis() === "quiet",
    axis,
  };
}

export type RebaseAsk = RebaseAskRecord | null;

// null (レコード自体が無い) も "quiet" に落ちる — 1.5節が「記録なし」と「ガードの控え
// だけがある」を同じ座標として扱うと明記しているため。
export function rebaseAskAxisOf(rebaseAsk: RebaseAsk): RebaseAskAxis {
  return rebaseAsk === null ? "quiet" : rebaseAsk.axis();
}

// probe レコードのうち不変条件4の検査に要る最小形 (proc の有無だけ。他フィールド
// (proc_started_at/sig/head/ci/checked_at/errors/note) はこのタスクでは扱わない)。
export interface ProbeFields {
  readonly proc: string | null;
}

export interface ProbeRecord extends ProbeFields {
  // 追従プロセスのリースが張られているか。
  hasLease(): boolean;
}

export function makeProbe(fields: ProbeFields): ProbeRecord {
  const { proc } = fields;
  return { proc, hasLease: () => proc !== null };
}

export interface OpenSubAxes {
  readonly attention: "auto" | "human";
  readonly fixAsk: FixAskAxis;
  readonly rebaseAsk: RebaseAskAxis;
}

export interface FollowFields {
  readonly attention: Attention;
  readonly asks: {
    readonly fix: FixAsk;
    readonly rebase: RebaseAsk;
  };
  readonly probe: ProbeRecord;
}

export interface FollowRecord extends FollowFields {
  // 次アクションを機械に委ねる意図か (人に委ねる human の対)。
  isAuto(): boolean;
  fixAxis(): FixAskAxis;
  rebaseAxis(): RebaseAskAxis;
  // 消費済みの fix 要求を抱えているか (不変条件3が問うもの)。
  hasTakenFixAsk(): boolean;
  // 領域Aのサブ軸座標 (attention 2値 × fix-ask 3値 × rebase-ask 3値)。
  subAxes(): OpenSubAxes;
}

export function makeFollow(fields: FollowFields): FollowRecord {
  const { attention, asks } = fields;
  const isAuto = () => attention === "auto";
  const fixAxis = () => fixAskAxisOf(asks.fix);
  const rebaseAxis = () => rebaseAskAxisOf(asks.rebase);
  return {
    ...fields,
    isAuto,
    fixAxis,
    rebaseAxis,
    hasTakenFixAsk: () => asks.fix !== null && asks.fix.isTaken(),
    subAxes: () => ({
      attention: isAuto() ? "auto" : "human",
      fixAsk: fixAxis(),
      rebaseAsk: rebaseAxis(),
    }),
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
  if (!follow.isAuto()) return false;
  if (follow.fixAxis() !== "null") return false;
  if (follow.rebaseAxis() !== "quiet") return false;
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
    follow.hasTakenFixAsk()
  );
}

// 不変条件4: probe.proc ≠ null ⇒ progress == resting
// (実行中に追従リースは張らない。fix-start/rebase-start は proc を null にしてから
// run を作る — 遷移側の責務。ここでは snapshot 上の帰結だけを検査する)
export function invariantProbeProcImpliesResting(
  progress: Progress,
  probe: ProbeRecord | null,
): boolean {
  if (probe === null || !probe.hasLease()) return true;
  return progress === "resting";
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
  const anyTaken = (fixAsk !== null && fixAsk.isTaken()) ||
    (rebaseAsk !== null && rebaseAsk.isTaken());
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
