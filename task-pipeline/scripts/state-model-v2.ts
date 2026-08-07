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
// - 「宣言と実装がずれたら型エラーになる」ことを優先する。軸キー・フェーズ名・ノード
//   キーは string ではなく宣言から導いたリテラルユニオンで持ち、宣言の取りこぼし
//   (kind/gate/phase を足したのに表を更新し忘れる) は実行時例外ではなくコンパイル
//   エラーで落ちる。
// - レコード (axis / ask / probe / follow) は素の値比較を外へ散らさず、意味のある名前の
//   メソッドで問い合わせる形にしてある。メソッドは生成時の値を閉じ込めず、常に自分自身の
//   フィールド (this) を読むので、`{...record, taken: true}` のようにスプレッドで一部を
//   差し替えたオブジェクトでも差し替え後の値で答える。
//
// テスト: state-model-v2.test.ts (直接importで検査)。実行は tests/state-model-v2.test.sh
// (deno fmt/lint/check/test を通しで回す) 経由、または tests/run.sh の glob 自動検出。

// ---------------------------------------------------------------------------
// 型レベルの補助 — 宣言どうしの一致をコンパイル時に表明する
// ---------------------------------------------------------------------------

// 2つのユニオンが完全一致することの表明。どちらかに過不足があると never になり、
// 代入側 (`= true`) がコンパイルエラーになる。
type MutuallyAssignable<A, B> = [A] extends [B]
  ? ([B] extends [A] ? true : never)
  : never;

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
// `satisfies Record<Gate, ...>` で gate の網羅を型に見せる — GATE_VALUES に値を足して
// ここを書き忘れるとコンパイルエラーになる。
export const INITIAL_GATE_PHASE_SEQUENCES = {
  full: ["research", "plan", "implement", "report"],
  light: ["research+plan", "implement", "report"],
} as const satisfies Record<Gate, readonly string[]>;

export const FINALIZE_PHASE = "finalize" as const;
// どの kind の finalize にも rebase_fix フェーズへの迂回辺がある (1.2節)。
export const REBASE_FIX_DETOUR_PHASE = "rebase_fix" as const;
// kind==pr_fix の主フェーズ (kind と同名だが別の語彙なので定数として分ける)。
export const PR_FIX_PHASE = "pr_fix" as const;

// initial は gate を必ず持ち、それ以外の kind は必ず持たない。この差を同じ型の
// `gate: Gate | null` で潰さず、判別可能ユニオンとして型を分ける — 「gate は
// kind==initial のとき、かつそのときに限り非null」(1.2節) が型の構造そのものになる。
export type FixRunKind = Exclude<RunKind, "initial">;

// 軸キーは「initial は gate ごとに1本、それ以外は kind ごとに1本」という 1.2節の表
// そのもの。string ではなくこのユニオンで持つので、綴り違い・組の取りこぼしは型で落ちる。
export type InitialAxisKey = `initial/${Gate}`;
export type AxisKey = InitialAxisKey | FixRunKind;

// axisKey → 迂回フェーズ込みの全フェーズ列 (検証フェーズ + finalize + 迂回rebase_fix)。
// rebase_fix kind 自身は既に rebase_fix を主フェーズとして持つため、末尾に別途足さない
// (research.mdの表: 6/5/3/2)。
//
// `as const satisfies Record<AxisKey, ...>` の2つが効いている:
//   - satisfies: 4軸の**取りこぼし・余計なキー**がコンパイルエラー (Gate や RunKind を
//     足してここを更新し忘れると落ちる)
//   - as const: 各列がリテラルのタプルとして残るので、下の PhaseOf がこの宣言から
//     「その軸に許されるフェーズ名」を導ける
const PHASES_BY_AXIS = {
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
  "pr_fix": [PR_FIX_PHASE, FINALIZE_PHASE, REBASE_FIX_DETOUR_PHASE],
  "rebase_fix": [REBASE_FIX_DETOUR_PHASE, FINALIZE_PHASE],
} as const satisfies Record<AxisKey, readonly string[]>;

// その軸に許されるフェーズ名 (上の宣言から導出。initial/light に "plan" は無い)。
export type PhaseOf<K extends AxisKey> = (typeof PHASES_BY_AXIS)[K][number];
// 全軸を通じたフェーズ名の全体。
export type Phase = PhaseOf<AxisKey>;

// 軸キー → (kind, gate) 座標。判別可能ユニオンの各枝の形をここから導く。
type CoordOf<K extends AxisKey> = K extends `initial/${infer G extends Gate}`
  ? { readonly kind: "initial"; readonly gate: G }
  : { readonly kind: K & FixRunKind; readonly gate: null };

// 軸キー → ノードキーの "kind,gate" 部分 (gate が無い kind は "-")。
type CoordKeyOf<K extends AxisKey> = K extends `initial/${infer G extends Gate}`
  ? `initial,${G}`
  : `${K & FixRunKind},-`;

interface RunAxisMethods<K extends AxisKey> {
  // 自身のキー文字列 (PHASES_BY_AXIS の引き先であり、ノードキーの構成要素)。
  axisKey(): K;
  // 迂回フェーズ込みの、この axis の全フェーズ列。
  phases(): readonly PhaseOf<K>[];
}

export interface InitialRunAxis<G extends Gate = Gate>
  extends RunAxisMethods<`initial/${G}`> {
  readonly kind: "initial";
  readonly gate: G;
}

export interface FixRunAxis<K extends FixRunKind = FixRunKind>
  extends RunAxisMethods<K> {
  readonly kind: K;
  readonly gate: null;
}

export type RunAxis = InitialRunAxis | FixRunAxis;

// 軸キーから、その軸ちょうどの型を引く (RUN_AXIS_BY_KEY の整合検査に使う)。
type RunAxisFor<K extends AxisKey> = K extends `initial/${infer G extends Gate}`
  ? InitialRunAxis<G>
  : K extends FixRunKind ? FixRunAxis<K>
  : never;

// PHASES_BY_AXIS は「軸キー K → その軸のフェーズ列」という対応そのものだが、K が型変数の
// ままだと索引結果 (タプル) と `readonly PhaseOf<K>[]` の関係を検査器が追えない。
// 対応の正しさは PHASES_BY_AXIS の宣言 (satisfies + as const) 側で既に保証されているので、
// ここは1箇所に閉じた読み替えとして書く。
function phasesByAxisKey<K extends AxisKey>(axisKey: K): readonly PhaseOf<K>[] {
  return PHASES_BY_AXIS[axisKey] as readonly PhaseOf<K>[];
}

export function makeInitialAxis<G extends Gate>(gate: G): InitialRunAxis<G> {
  const axisKey: `initial/${G}` = `initial/${gate}`;
  return {
    kind: "initial",
    gate,
    axisKey: () => axisKey,
    phases: () => phasesByAxisKey(axisKey),
  };
}

export function makeFixAxis<K extends FixRunKind>(kind: K): FixRunAxis<K> {
  return {
    kind,
    gate: null,
    axisKey: () => kind,
    phases: () => phasesByAxisKey(kind),
  };
}

// kind×gate の4組 (1.2節の表そのもの)。値の型を RunAxisFor<K> にしてあるので、
// キーと中身が食い違う行 (例: "pr_fix" に makeFixAxis("rebase_fix") を置く) も、
// 軸の取りこぼしも、コンパイルエラーになる。
const RUN_AXIS_BY_KEY = {
  "initial/full": makeInitialAxis("full"),
  "initial/light": makeInitialAxis("light"),
  "pr_fix": makeFixAxis("pr_fix"),
  "rebase_fix": makeFixAxis("rebase_fix"),
} as const satisfies { readonly [K in AxisKey]: RunAxisFor<K> };

// 宣言順 = 上の Record の記述順。
export const RUN_AXES: readonly RunAxis[] = Object.values(RUN_AXIS_BY_KEY);

// (kind, gate) からその軸を引く。宣言の外の組 (rebase_fix×full 等) は undefined。
export function runAxisOf(
  kind: RunKind,
  gate: Gate | null,
): RunAxis | undefined {
  return RUN_AXES.find((a) => a.kind === kind && a.gate === gate);
}

// 領域Pの running ノードキー。軸ごとに (kind,gate) 部分と許されるフェーズが決まるので、
// 16個のキー文字列はすべてこのユニオンの要素として型に載る。
type RunKeyOf<C extends string, P extends string> = `running(${C},${P})`;
export type RunNodeKeyOf<K extends AxisKey> = RunKeyOf<
  CoordKeyOf<K>,
  PhaseOf<K>
>;
export type RunNodeKey = { [K in AxisKey]: RunNodeKeyOf<K> }[AxisKey];

// ノードキーは実行時に組み立てず、16件をリテラルとして書き下す (領域A側の
// state-transitions-v2-nodes.ts の A_OPEN_FOLLOW と同じ流儀)。値の型を座標とフェーズから
// 決まる `RunKeyOf<CoordKeyOf<K>, P>` にしてあるので、
//   - 綴り違い・座標の取り違え (例: light の行に "running(initial,full,...)") は型エラー
//   - その軸のフェーズが1つでも欠ければ mapped type が全キーを要求するので型エラー
// になる。key() が返す文字列が型と食い違いようがない形。
const RUN_NODE_KEYS: {
  readonly [K in AxisKey]: {
    readonly [P in PhaseOf<K>]: RunKeyOf<CoordKeyOf<K>, P>;
  };
} = {
  "initial/full": {
    "research": "running(initial,full,research)",
    "plan": "running(initial,full,plan)",
    "implement": "running(initial,full,implement)",
    "report": "running(initial,full,report)",
    "finalize": "running(initial,full,finalize)",
    "rebase_fix": "running(initial,full,rebase_fix)",
  },
  "initial/light": {
    "research+plan": "running(initial,light,research+plan)",
    "implement": "running(initial,light,implement)",
    "report": "running(initial,light,report)",
    "finalize": "running(initial,light,finalize)",
    "rebase_fix": "running(initial,light,rebase_fix)",
  },
  "pr_fix": {
    "pr_fix": "running(pr_fix,-,pr_fix)",
    "finalize": "running(pr_fix,-,finalize)",
    "rebase_fix": "running(pr_fix,-,rebase_fix)",
  },
  "rebase_fix": {
    "rebase_fix": "running(rebase_fix,-,rebase_fix)",
    "finalize": "running(rebase_fix,-,finalize)",
  },
};

// RunAxis に phase を合成した形であることを型でも表す (RunAxis との交差型)。
// key() はノード自身のキー文字列を返すメソッド (axis 側の axisKey() とは別物)。
export type RunNode = RunAxis & {
  readonly phase: Phase;
  key(): RunNodeKey;
};

function makeRunNode(axis: RunAxis, phase: Phase, key: RunNodeKey): RunNode {
  return { ...axis, phase, key: () => key };
}

export function listRunNodes(): readonly RunNode[] {
  const nodes: RunNode[] = [];
  for (const axis of RUN_AXES) {
    // その軸のフェーズ名を鍵にした表。列と表のキー集合はどちらも PHASES_BY_AXIS 由来
    // なので、この索引が外れることは無い。
    const keys: Readonly<Record<string, RunNodeKey>> =
      RUN_NODE_KEYS[axis.axisKey()];
    for (const phase of axis.phases()) {
      nodes.push(makeRunNode(axis, phase, keys[phase]));
    }
  }
  return nodes;
}

export const NON_RUNNING_P_NODE_KEYS = [
  "queued",
  "resting",
  "blocked",
] as const satisfies readonly Exclude<Progress, "running">[];

export type NonRunningPNodeKey = (typeof NON_RUNNING_P_NODE_KEYS)[number];

// running 以外の領域Pノードは「running を除いた progress そのもの」であること
// (1.1節)。PROGRESS_VALUES 側だけを増やすと、ここで落ちる。
const _nonRunningPNodesAreProgressMinusRunning: MutuallyAssignable<
  NonRunningPNodeKey,
  Exclude<Progress, "running">
> = true;

// 領域Pの合法ノードキー全部 (queued/resting/blocked + running(...)の16) = 19。
export type PNodeKey = NonRunningPNodeKey | RunNodeKey;

export const P_NODE_KEYS: readonly PNodeKey[] = [
  ...NON_RUNNING_P_NODE_KEYS,
  ...listRunNodes().map((node) => node.key()),
];

// 外から来る素の (kind, gate, phase) 組 (型で守られていないデータ) の形。
export interface RunCoord {
  readonly kind: RunKind;
  readonly gate: Gate | null;
  readonly phase: string;
}

// 宣言された16ノードの座標。判別可能ユニオンなので、gate と phase が kind と食い違う組
// (rebase_fix×full、initial/light×plan 等) はそもそもこの型に居ない。
export type LegalRunCoord = {
  [K in AxisKey]: CoordOf<K> & { readonly phase: PhaseOf<K> };
}[AxisKey];

// 任意の (kind, gate, phase) 組が RUN_AXES × axis.phases() の宣言に含まれるかを判定。
// 真のときは呼び出し側で LegalRunCoord に絞り込める (型述語)。
export function isLegalRunNode(
  node: RunCoord,
): node is RunCoord & LegalRunCoord {
  const axis = runAxisOf(node.kind, node.gate);
  if (axis === undefined) return false;
  return (axis.phases() as readonly string[]).includes(node.phase);
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

// attention を2値のサブ軸に落としたもの (human の理由は座標に入らない)。
export const ATTENTION_AXIS_VALUES = ["auto", "human"] as const;
export type AttentionAxis = (typeof ATTENTION_AXIS_VALUES)[number];

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

// メソッドは生成時の値を閉じ込めず this を読む — スプレッドで一部を差し替えた
// オブジェクトでも、差し替え後の値で答える。
const FIX_ASK_METHODS = {
  isTaken(this: FixAskFields): boolean {
    return this.taken;
  },
  isPending(this: FixAskFields): boolean {
    return !this.taken;
  },
  axis(this: FixAskFields): PresentFixAskAxis {
    return this.taken ? "taken" : "pending";
  },
} as const;

export function makeFixAsk(fields: FixAskFields): FixAskRecord {
  return { ...fields, ...FIX_ASK_METHODS };
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

const REBASE_ASK_METHODS = {
  isTaken(this: RebaseAskFields): boolean {
    return this.taken;
  },
  isResolveQueued(this: RebaseAskFields): boolean {
    return !this.taken && this.resolve;
  },
  isQuiet(this: RebaseAskRecord): boolean {
    return this.axis() === "quiet";
  },
  axis(this: RebaseAskFields): RebaseAskAxis {
    if (this.taken) return "taken";
    if (this.resolve) return "queued";
    return "quiet";
  },
} as const;

export function makeRebaseAsk(fields: RebaseAskFields): RebaseAskRecord {
  return { ...fields, ...REBASE_ASK_METHODS };
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

const PROBE_METHODS = {
  hasLease(this: ProbeFields): boolean {
    return this.proc !== null;
  },
} as const;

export function makeProbe(fields: ProbeFields): ProbeRecord {
  return { ...fields, ...PROBE_METHODS };
}

export interface OpenSubAxes {
  readonly attention: AttentionAxis;
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

const FOLLOW_METHODS = {
  isAuto(this: FollowFields): boolean {
    return this.attention === "auto";
  },
  fixAxis(this: FollowFields): FixAskAxis {
    return fixAskAxisOf(this.asks.fix);
  },
  rebaseAxis(this: FollowFields): RebaseAskAxis {
    return rebaseAskAxisOf(this.asks.rebase);
  },
  hasTakenFixAsk(this: FollowFields): boolean {
    return this.asks.fix !== null && this.asks.fix.isTaken();
  },
  subAxes(this: FollowRecord): OpenSubAxes {
    return {
      attention: this.isAuto() ? "auto" : "human",
      fixAsk: this.fixAxis(),
      rebaseAsk: this.rebaseAxis(),
    };
  },
} as const;

export function makeFollow(fields: FollowFields): FollowRecord {
  return { ...fields, ...FOLLOW_METHODS };
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

// 不変条件が run に問うのは kind (と gate) だけなので、item 全体ではなくこの最小形で
// 受ける。unknown で受けると「run 以外の値を渡した」呼び違いが検査されないため、
// 存在検査 (不変条件1) もこの型で受ける。
export interface RunKindLike {
  readonly kind: RunKind;
}

export interface RunGateLike extends RunKindLike {
  readonly gate: Gate | null;
}

// 不変条件1: run ≠ null ⇔ progress == running
export function invariantRunProgressConsistent(
  progress: Progress,
  run: RunKindLike | null | undefined,
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
  run: RunKindLike | null,
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
export function invariantGateNonNullIffKindInitial(run: RunGateLike): boolean {
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
  // 先頭から読み進める幅優先 (shift の戻り値を型で絞る必要が無いよう添字で辿る)。
  const queue: Node[] = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
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
