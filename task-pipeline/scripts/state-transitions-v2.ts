// task-pipeline/scripts/state-transitions-v2.ts
//
// 状態モデル v2 (task-pipeline/docs/state-model-v2-2026-08.md 2節「遷移」) の
// apply 純関数群と、領域ごとの from/to を宣言する VERB_SPEC v2。
//
// - 依存は ./state-model-v2.ts (#34 が置いた語彙・ノード・不変条件) **だけ**。v1
//   (state.ts / state-transitions.ts / state-schema.ts / state.schema.json) には一切
//   依存しない (#34 が宣言した方針の維持)。エラー型もここで自己完結して定義する。
// - Deno API を呼ばない純粋関数群。現在時刻は呼び出し元が引数で渡す。
// - **CLI への配線は行わない** (issue #35 の明示的な範囲外。後続の切り替え issue)。
//   したがってこのモジュールの唯一の入口は公開 export の直接 import である。
// - `next` (設計5節) と帳簿系 state-level verb (init/get/validate/session-touch/
//   sessions-alive/history-append/candidates-*/promoted-*/relisted-*/stalled-set) は
//   範囲外。前者は後続 issue、後者は queue エントリの領域座標を持たず「領域ごとの
//   from/to を宣言する VERB_SPEC」の対象にならない (v1 でも VERB_SPEC の外)。
//
// #34 のレコード (makeFixAsk/makeRebaseAsk/makeProbe/makeFollow) はメソッドが生成時の
// 値を閉じ込めるため、apply の内部状態には**使わない**。item は素データとして持ち、
// 座標導出と不変条件検査の入口でだけ make* を通して導出ビューを組む。
//
// テスト: state-transitions-v2.test.ts (直接importで検査)。実行は
// tests/state-transitions-v2.test.sh 経由、または tests/run.sh の glob 自動検出。

import {
  type ArtifactState,
  type Attention,
  FINALIZE_PHASE,
  FIX_ASK_AXIS_VALUES,
  type FixAskAxis,
  type Gate,
  type HumanAttentionReason,
  INITIAL_GATE_PHASE_SEQUENCES,
  invariantGateNonNullIffKindInitial,
  invariantMergedImpliesResting,
  invariantPrFixImpliesOpenTaken,
  invariantProbeProcImpliesResting,
  invariantRunProgressConsistent,
  invariantTakenImpliesRunning,
  isLegalRunNode,
  listRunNodes,
  makeFixAsk,
  makeFollow,
  makeProbe,
  makeRebaseAsk,
  NON_RUNNING_P_NODE_KEYS,
  P_NODE_KEYS,
  type Progress,
  REBASE_ASK_AXIS_VALUES,
  REBASE_FIX_DETOUR_PHASE,
  type RebaseAskAxis,
  RUN_AXES,
  type RunKind,
} from "./state-model-v2.ts";

// ---------------------------------------------------------------------------
// エラー型 (v1 の CliError と同じ語彙を v2 側で自己完結して定義する)
// ---------------------------------------------------------------------------

export type ExitCodeName =
  | "usage"
  | "lock"
  | "schema"
  | "missing"
  | "permission"
  | "conflict";

export class CliErrorV2 extends Error {
  constructor(public readonly code: ExitCodeName, message: string) {
    super(message);
  }
}

function requirePrecondition(cond: boolean, message: string): void {
  if (!cond) throw new CliErrorV2("conflict", message);
}

// ---------------------------------------------------------------------------
// item の形 — 設計3.1b の「判別付き oneOf」を TypeScript の判別可能ユニオンで表す。
// ノードに存在しないフィールドはキーごと無い (null を許す平坦な形にしない)。
// ---------------------------------------------------------------------------

export interface V2Run {
  readonly kind: RunKind;
  readonly gate: Gate | null;
  readonly phase: string;
  readonly attempts: number;
  readonly executor: string | null;
  readonly executor_last_event_at: string | null;
  readonly takeover_at: string | null;
}

export interface V2FixAsk {
  readonly ids: readonly string[];
  readonly findings: string;
  readonly taken: boolean;
}

export interface V2RebaseAsk {
  readonly blocked_onto: string;
  readonly reason: string;
  readonly at: string;
  readonly kind: string | null;
  readonly cause: string | null;
  readonly report: string | null;
  readonly from_tip: string | null;
  readonly resolve: boolean;
  readonly taken: boolean;
}

export interface LedgerEntry {
  readonly id: string;
  readonly updated_at: string | null;
}

export interface V2Ledger {
  readonly handled: readonly string[];
  readonly fix_attempts: number;
  readonly review_only: readonly LedgerEntry[];
  readonly answered: readonly LedgerEntry[];
}

export interface V2Probe {
  readonly proc: string | null;
  readonly proc_started_at: string | null;
  readonly sig: string | null;
  readonly head: string | null;
  readonly ci: string | null;
  readonly checked_at: string | null;
  readonly errors: number;
  readonly note: string | null;
}

export interface V2Follow {
  readonly attention: Attention;
  readonly asks: {
    readonly fix: V2FixAsk | null;
    readonly rebase: V2RebaseAsk | null;
  };
  readonly ledger: V2Ledger;
  readonly probe: V2Probe;
}

export interface V2ArtifactNone {
  readonly state: "none";
}
export interface V2ArtifactOpen {
  readonly state: "open";
  readonly ref: string;
  readonly branch: string;
  readonly tip: string | null;
  readonly base: string;
  readonly follow: V2Follow | null;
}
export interface V2ArtifactMerged {
  readonly state: "merged";
  readonly ref: string;
  readonly branch: string;
  readonly tip: string | null;
  readonly base: string;
}
export interface V2ArtifactWithdrawn {
  readonly state: "withdrawn";
  readonly ref: string;
  readonly branch: string;
  readonly tip: string | null;
  readonly base: string;
  readonly asked: boolean;
  readonly note: string | null;
}

export type V2Artifact =
  | V2ArtifactNone
  | V2ArtifactOpen
  | V2ArtifactMerged
  | V2ArtifactWithdrawn;

export interface V2Item {
  readonly id: string;
  readonly title: string;
  readonly progress: Progress;
  readonly run: V2Run | null;
  readonly blocked_reason: string | null;
  readonly artifact: V2Artifact;
  readonly worktree: string | null;
  readonly base: string | null;
  readonly session: string | null;
}

export interface RelistedEntry {
  readonly id: string;
  readonly seen_at: string;
}
export interface CompletedEntry {
  readonly id: string;
  readonly done_at: string;
}
export interface WithdrawnBranchEntry {
  readonly id: string;
  readonly branch: string;
  readonly base: string;
  readonly worktree: string;
  readonly at: string;
  readonly reason: string;
}

export interface V2State {
  readonly tracker: string;
  readonly source: string;
  readonly updated_at: string;
  readonly queue: readonly V2Item[];
  readonly candidates: readonly unknown[];
  readonly relisted: readonly RelistedEntry[];
  readonly promoted: readonly string[];
  readonly completed: readonly CompletedEntry[];
  readonly withdrawn_branches: readonly WithdrawnBranchEntry[];
  readonly history: readonly string[];
  readonly schema_version: number;
}

// ---------------------------------------------------------------------------
// 形状宣言 — 設計3.1b の表を data 化したもの。
//
// v1 は state.schema.json の enum / properties を語彙・フィクスチャ突き合わせの相手に
// していた。v2 の JSON Schema 化は設計3節の範囲 (後続issue) なので、その役割をここの
// 宣言が担う: テストが「apply の出力キー集合が着地ノードの形と一致する」ことと
// 「フレームテストの最大フィクスチャが全プロパティを覆う」ことを強制する。
// ---------------------------------------------------------------------------

export const ITEM_SHAPE = [
  "id",
  "title",
  "progress",
  "run",
  "blocked_reason",
  "artifact",
  "worktree",
  "base",
  "session",
] as const;

export const RUN_SHAPE = [
  "kind",
  "gate",
  "phase",
  "attempts",
  "executor",
  "executor_last_event_at",
  "takeover_at",
] as const;

export const ARTIFACT_SHAPES: Readonly<
  Record<ArtifactState, readonly string[]>
> = {
  none: ["state"],
  open: ["state", "ref", "branch", "tip", "base", "follow"],
  merged: ["state", "ref", "branch", "tip", "base"],
  withdrawn: ["state", "ref", "branch", "tip", "base", "asked", "note"],
};

export const FOLLOW_SHAPE = ["attention", "asks", "ledger", "probe"] as const;
export const ASKS_SHAPE = ["fix", "rebase"] as const;
export const FIX_ASK_SHAPE = ["ids", "findings", "taken"] as const;
export const REBASE_ASK_SHAPE = [
  "blocked_onto",
  "reason",
  "at",
  "kind",
  "cause",
  "report",
  "from_tip",
  "resolve",
  "taken",
] as const;
export const LEDGER_SHAPE = [
  "handled",
  "fix_attempts",
  "review_only",
  "answered",
] as const;
export const PROBE_SHAPE = [
  "proc",
  "proc_started_at",
  "sig",
  "head",
  "ci",
  "checked_at",
  "errors",
  "note",
] as const;

// ---------------------------------------------------------------------------
// 領域 A のノードキー — 設計1.5「領域Aの詳細ノード」の 23 ノード。
// #34 は領域Pの19ノードだけを列挙しているので、A 側はここで新設する。
//
// キー文字列は実行時に組み立てない。23 件をリテラルとして書き下したこの節が唯一の定義で、
// 座標 (attention × fix ask × rebase ask) からの引き当ても、下の静的な表を引くだけである。
// 軸の語彙 (#34) が増えても表は勝手には広がらないので、両者の一致は T-V2T-ALIGN-3b が
// 検査する (直積を覆っているか・綴りが座標と合っているか・座標⇄キーが往復するか)。
// 表に無い座標を引いたら openNodeKey が例外を投げる (黙って未宣言のキーを作らない)。
// ---------------------------------------------------------------------------

export const ATTENTION_AXIS_VALUES = ["auto", "human"] as const;
export type AttentionAxis = (typeof ATTENTION_AXIS_VALUES)[number];

export const A_NODE_NONE = "none";
export const A_NODE_MERGED = "merged";
export const A_NODE_OPEN_NO_FOLLOW = "open(follow=null)";
export const A_NODE_WITHDRAWN_UNASKED = "withdrawn(asked=false)";
export const A_NODE_WITHDRAWN_ASKED = "withdrawn(asked=true)";

// follow を持つ open の 18 ノード。各行が「サブ軸の座標 ↔ ノードキー」の対応そのもの。
export interface AOpenFollowNode {
  readonly attention: AttentionAxis;
  readonly fix: FixAskAxis;
  readonly rebase: RebaseAskAxis;
  readonly key: string;
}

// [attention, fix ask, rebase ask, ノードキー] の 18 行。この表が唯一の定義で、
// キーは行に書かれたリテラルそのもの (座標から組み立てたものではない)。
type AOpenFollowRow = readonly [
  AttentionAxis,
  FixAskAxis,
  RebaseAskAxis,
  string,
];

const A_OPEN_FOLLOW_ROWS = [
  ["auto", "null", "quiet", "open(auto,null,quiet)"],
  ["auto", "null", "queued", "open(auto,null,queued)"],
  ["auto", "null", "taken", "open(auto,null,taken)"],
  ["auto", "pending", "quiet", "open(auto,pending,quiet)"],
  ["auto", "pending", "queued", "open(auto,pending,queued)"],
  ["auto", "pending", "taken", "open(auto,pending,taken)"],
  ["auto", "taken", "quiet", "open(auto,taken,quiet)"],
  ["auto", "taken", "queued", "open(auto,taken,queued)"],
  ["auto", "taken", "taken", "open(auto,taken,taken)"],
  ["human", "null", "quiet", "open(human,null,quiet)"],
  ["human", "null", "queued", "open(human,null,queued)"],
  ["human", "null", "taken", "open(human,null,taken)"],
  ["human", "pending", "quiet", "open(human,pending,quiet)"],
  ["human", "pending", "queued", "open(human,pending,queued)"],
  ["human", "pending", "taken", "open(human,pending,taken)"],
  ["human", "taken", "quiet", "open(human,taken,quiet)"],
  ["human", "taken", "queued", "open(human,taken,queued)"],
  ["human", "taken", "taken", "open(human,taken,taken)"],
] as const satisfies readonly AOpenFollowRow[];

export const A_OPEN_FOLLOW_NODES: readonly AOpenFollowNode[] =
  A_OPEN_FOLLOW_ROWS.map(([attention, fix, rebase, key]) => ({
    attention,
    fix,
    rebase,
    key,
  }));

// follow を持つ open の 18 ノード / follow の有無を問わない open の 19 ノード。
export const A_OPEN_FOLLOW_KEYS: readonly string[] = A_OPEN_FOLLOW_NODES.map((
  n,
) => n.key);
export const A_OPEN_KEYS: readonly string[] = [
  A_NODE_OPEN_NO_FOLLOW,
  ...A_OPEN_FOLLOW_KEYS,
];
export const A_WITHDRAWN_KEYS: readonly string[] = [
  A_NODE_WITHDRAWN_UNASKED,
  A_NODE_WITHDRAWN_ASKED,
];

export const A_NODE_KEYS: readonly string[] = [
  A_NODE_NONE,
  A_NODE_MERGED,
  ...A_WITHDRAWN_KEYS,
  ...A_OPEN_KEYS,
];

// merged を除いた 22 ノード (restore の from。merged は retire で queue を離脱する終端
// なので戻れない — 設計2.5)。キー文字列を篩に掛けず、部分集合を組み替えて宣言する。
// A_NODE_KEYS との整合 (merged だけの差) は T-V2T-ALIGN-3 が固定する。
export const A_NODE_KEYS_EXCEPT_MERGED: readonly string[] = [
  A_NODE_NONE,
  ...A_WITHDRAWN_KEYS,
  ...A_OPEN_KEYS,
];

export function withdrawnNodeKey(asked: boolean): string {
  return asked ? A_NODE_WITHDRAWN_ASKED : A_NODE_WITHDRAWN_UNASKED;
}

const A_OPEN_FOLLOW_NODE_BY_COORD: ReadonlyMap<string, AOpenFollowNode> =
  new Map(
    A_OPEN_FOLLOW_NODES.map((n) => [`${n.attention}|${n.fix}|${n.rebase}`, n]),
  );

export function openNodeKey(
  attention: AttentionAxis,
  fixAsk: FixAskAxis,
  rebaseAsk: RebaseAskAxis,
): string {
  const node = A_OPEN_FOLLOW_NODE_BY_COORD.get(
    `${attention}|${fixAsk}|${rebaseAsk}`,
  );
  if (node === undefined) {
    throw new Error(
      `BUG: undeclared open node ${attention}/${fixAsk}/${rebaseAsk}`,
    );
  }
  return node.key;
}

// キー → サブ軸座標 (キー文字列を解析せず、宣言表をそのまま引く)。
const A_OPEN_FOLLOW_NODE_BY_KEY: ReadonlyMap<string, AOpenFollowNode> = new Map(
  A_OPEN_FOLLOW_NODES.map((n) => [n.key, n]),
);

export function openNodeOf(aKey: string): AOpenFollowNode | null {
  return A_OPEN_FOLLOW_NODE_BY_KEY.get(aKey) ?? null;
}

// follow 付き open ノードのサブ軸での絞り込み (VERB_SPEC の from 宣言に使う)。
export function openNodesWhere(
  filter: {
    attention?: readonly AttentionAxis[];
    fix?: readonly FixAskAxis[];
    rebase?: readonly RebaseAskAxis[];
  },
): readonly string[] {
  return A_OPEN_FOLLOW_NODES.filter((n) =>
    (filter.attention ?? ATTENTION_AXIS_VALUES).includes(n.attention) &&
    (filter.fix ?? FIX_ASK_AXIS_VALUES).includes(n.fix) &&
    (filter.rebase ?? REBASE_ASK_AXIS_VALUES).includes(n.rebase)
  ).map((n) => n.key);
}

// ---------------------------------------------------------------------------
// 領域 P のノード集合 (#34 の listRunNodes からの導出)
// ---------------------------------------------------------------------------

const RUN_NODES = listRunNodes();

// (kind, gate, phase) → ノードキー。#34 の makeRunNode と同じ綴りを保証するために
// 自前で文字列を組まず、listRunNodes() の key() を引く。
const RUN_NODE_KEY_BY_COORD: ReadonlyMap<string, string> = new Map(
  RUN_NODES.map((n) => [`${n.kind}|${n.gate ?? "-"}|${n.phase}`, n.key()]),
);

export const P_RUNNING_KEYS: readonly string[] = RUN_NODES.map((n) => n.key());
export const P_VERIFIED_KEYS: readonly string[] = RUN_NODES.filter((n) =>
  n.phase !== FINALIZE_PHASE
).map((n) => n.key());
export const P_FINALIZE_KEYS: readonly string[] = RUN_NODES.filter((n) =>
  n.phase === FINALIZE_PHASE
).map((n) => n.key());
// 迂回フェーズ (kind を変えない寄り道)。kind==rebase_fix は解決サイクル専用なので除く。
export const P_DETOUR_KEYS: readonly string[] = RUN_NODES.filter((n) =>
  n.phase === REBASE_FIX_DETOUR_PHASE && n.kind !== "rebase_fix"
).map((n) => n.key());
// 解決サイクルの run (kind==rebase_fix の主フェーズ)。
export const P_CYCLE_REBASE_KEYS: readonly string[] = RUN_NODES.filter((n) =>
  n.kind === "rebase_fix" && n.phase === REBASE_FIX_DETOUR_PHASE
).map((n) => n.key());

const INITIAL_FULL_FIRST_PHASE = INITIAL_GATE_PHASE_SEQUENCES.full[0];
const INITIAL_LIGHT_FIRST_PHASE = INITIAL_GATE_PHASE_SEQUENCES.light[0];

const AXIS_KEY_BY_COORD: ReadonlyMap<string, string> = new Map(
  RUN_AXES.map((a) => [`${a.kind}|${a.gate ?? "-"}`, a.axisKey()]),
);

function axisKeyOfRun(run: V2Run): string {
  const key = AXIS_KEY_BY_COORD.get(`${run.kind}|${run.gate ?? "-"}`);
  if (key === undefined) {
    throw new CliErrorV2(
      "conflict",
      `not a declared run axis: kind=${run.kind} gate=${String(run.gate)}`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// 座標導出
// ---------------------------------------------------------------------------

export function pNodeKeyOf(item: V2Item): string | null {
  if (!invariantRunProgressConsistent(item.progress, item.run)) return null;
  if (item.progress === "running") {
    const run = item.run as V2Run;
    if (
      !isLegalRunNode({ kind: run.kind, gate: run.gate, phase: run.phase })
    ) {
      return null;
    }
    return RUN_NODE_KEY_BY_COORD.get(
      `${run.kind}|${run.gate ?? "-"}|${run.phase}`,
    ) ?? null;
  }
  if (
    !(NON_RUNNING_P_NODE_KEYS as readonly string[]).includes(item.progress)
  ) {
    return null;
  }
  return item.progress;
}

function fixAskView(fix: V2FixAsk | null) {
  return fix === null ? null : makeFixAsk({
    ids: [...fix.ids],
    findings: fix.findings,
    taken: fix.taken,
  });
}

function rebaseAskView(rebase: V2RebaseAsk | null) {
  // 軸の判定に要るのは blocked_onto/reason/at/resolve/taken だけ。optional 欄
  // (kind/cause/report/from_tip) は #34 の型が `?: string` なので null を渡さず省く。
  return rebase === null ? null : makeRebaseAsk({
    blocked_onto: rebase.blocked_onto,
    reason: rebase.reason,
    at: rebase.at,
    resolve: rebase.resolve,
    taken: rebase.taken,
  });
}

export function followView(follow: V2Follow) {
  return makeFollow({
    attention: follow.attention,
    asks: {
      fix: fixAskView(follow.asks.fix),
      rebase: rebaseAskView(follow.asks.rebase),
    },
    probe: makeProbe({ proc: follow.probe.proc }),
  });
}

export function aNodeKeyOf(item: V2Item): string | null {
  const artifact = item.artifact;
  switch (artifact.state) {
    case "none":
      return A_NODE_NONE;
    case "merged":
      return A_NODE_MERGED;
    case "withdrawn":
      return withdrawnNodeKey(artifact.asked);
    case "open": {
      if (artifact.follow === null) return A_NODE_OPEN_NO_FOLLOW;
      const view = followView(artifact.follow);
      const sub = view.subAxes();
      return openNodeKey(sub.attention, sub.fixAsk, sub.rebaseAsk);
    }
    default:
      return null;
  }
}

export function productKeyOf(item: V2Item): string | null {
  const p = pNodeKeyOf(item);
  const a = aNodeKeyOf(item);
  if (p === null || a === null) return null;
  return productKey(p, a);
}

export function productKey(pNode: string, aNode: string): string {
  return `${pNode} × ${aNode}`;
}

export const PRODUCT_NODE_KEYS: readonly string[] = P_NODE_KEYS.flatMap((p) =>
  A_NODE_KEYS.map((a) => productKey(p, a))
);

// ---------------------------------------------------------------------------
// 不変条件 (設計1.5) の item 全体への適用
//
// #34 の述語関数をそのまま使う。1 か所だけ適用範囲を狭めている (下記 taken の scope) —
// 理由はその関数のコメントに書く。
// ---------------------------------------------------------------------------

function openArtifactOf(item: V2Item): V2ArtifactOpen | null {
  return item.artifact.state === "open" ? item.artifact : null;
}

export function followOf(item: V2Item): V2Follow | null {
  const open = openArtifactOf(item);
  return open === null ? null : open.follow;
}

// 不変条件5の残差 (#34 の invariantTakenImpliesRunning) の適用範囲。
//
// #34 は「taken は fix-start/rebase-start の消費開始から ship/give-up/claim の消費終了
// までの間だけ真になりうる」として `taken ⇒ progress == running` を残差に採った。実際の
// 遷移を並べるとこれは blocked と queued で成立しない:
//
//   - `block` は running(pr_fix|rebase_fix) から blocked へ動くが、asks には触れない
//     (不変条件5が taken に触れてよい verb を列挙しており block はその中に無い)。
//     設計1.1 は `blocked ∧ open` を「表現可能であるべき組」として明示している。
//     taken を落とすと設計1.3 の「run が中断されても要求の出自が失われないため」という
//     taken の存在理由そのものが壊れる。
//   - `restore` は blocked/resting から queued へ動くが、同じく asks に触れない。
//     設計5.3 は「queued に戻ったタスクの stale な asks は発火しない (claim が改めて
//     リセットする)」として、この持ち越しを明示的に許している。
//
// 受け入れ条件4が意図的到達不能の例として **`resting × fix-ask taken`** だけを名指しして
// いることも、正しい残差が `taken ⇒ progress != resting` であることの裏付けである。
// ここでは blocked/queued を適用外にしたうえで、残り (running/resting) には #34 の
// 関数をそのまま掛ける。
export function invariantTakenScope(item: V2Item): boolean {
  if (item.progress === "blocked" || item.progress === "queued") return true;
  const follow = followOf(item);
  return invariantTakenImpliesRunning(
    item.progress,
    follow === null ? null : fixAskView(follow.asks.fix),
    follow === null ? null : rebaseAskView(follow.asks.rebase),
  );
}

// 不変条件3の逆向き — v2 の遷移を並べて導いた派生不変条件。
//
// fix ask に taken を立てるのは fix-start だけで、その着地は running(pr_fix)。rebase ask
// に taken を立てるのは rebase-start 入口 (a) だけで、着地は running(rebase_fix)。迂回は
// kind を変えない (2.4) ので、**run が居る間**、taken の種類と run.kind は 1:1 に対応する。
// これが無いと「解決サイクルの run が消費済みの fix ask を抱えている」という組が
// 表現可能になり、その状態から rebase-give-up を掛けると taken を抱えたまま resting へ
// 戻れてしまう (不変条件5の残差の破れ)。
//
// blocked / queued は run を持たず、中断 (block) と復帰 (restore) で taken を持ち越すだけ
// なので対象外 — invariantTakenScope と同じ切り分けである。
export function invariantTakenKindMatchesRun(item: V2Item): boolean {
  if (item.progress !== "running" || item.run === null) return true;
  const follow = followOf(item);
  if (follow === null) return true;
  if (follow.asks.fix?.taken === true && item.run.kind !== "pr_fix") {
    return false;
  }
  if (follow.asks.rebase?.taken === true && item.run.kind !== "rebase_fix") {
    return false;
  }
  return true;
}

// blocked_reason は progress==blocked のとき、かつそのときに限り非 null (設計1.4/3.1b)。
export function invariantBlockedReasonIffBlocked(item: V2Item): boolean {
  return (item.blocked_reason !== null) === (item.progress === "blocked");
}

export function assertItemInvariantsV2(item: V2Item): void {
  const pNode = pNodeKeyOf(item);
  if (pNode === null) {
    throw new CliErrorV2(
      "schema",
      `refusing to write unreachable progress node: progress=${
        String(item.progress)
      } run=${JSON.stringify(item.run)}`,
    );
  }
  const aNode = aNodeKeyOf(item);
  if (aNode === null) {
    throw new CliErrorV2(
      "schema",
      `refusing to write unreachable artifact node: ${
        JSON.stringify(item.artifact)
      }`,
    );
  }
  const follow = followOf(item);
  const followRecord = follow === null ? null : followView(follow);
  if (!invariantMergedImpliesResting(item.artifact.state, item.progress)) {
    throw new CliErrorV2("schema", "merged implies resting (invariant 2)");
  }
  if (
    !invariantPrFixImpliesOpenTaken(
      item.progress,
      item.run,
      item.artifact.state,
      followRecord,
    )
  ) {
    throw new CliErrorV2(
      "schema",
      "running(pr_fix) implies open + follow + asks.fix.taken (invariant 3)",
    );
  }
  if (
    !invariantProbeProcImpliesResting(
      item.progress,
      follow === null ? null : makeProbe({ proc: follow.probe.proc }),
    )
  ) {
    throw new CliErrorV2(
      "schema",
      "probe.proc implies resting (invariant 4)",
    );
  }
  if (!invariantTakenScope(item)) {
    throw new CliErrorV2(
      "schema",
      "taken must not survive into resting (invariant 5 residual)",
    );
  }
  if (!invariantTakenKindMatchesRun(item)) {
    throw new CliErrorV2(
      "schema",
      "a taken ask must match the kind of the run that consumed it",
    );
  }
  if (item.run !== null && !invariantGateNonNullIffKindInitial(item.run)) {
    throw new CliErrorV2("schema", "gate is non-null iff kind == initial");
  }
  if (!invariantBlockedReasonIffBlocked(item)) {
    throw new CliErrorV2(
      "schema",
      "blocked_reason is non-null iff progress == blocked",
    );
  }
}

// ---------------------------------------------------------------------------
// `advance` の辺 — 設計1.2 のフェーズ列 + 2.4 の迂回復帰辺
//
// axis.phases() は末尾に迂回フェーズ rebase_fix を含む配列を返すので、その素の隣接ペアを
// 採ると `finalize → rebase_fix` という誤った辺が生える (その辺は rebase-start 入口 b の
// もの)。主列を切り出したうえで、迂回の復帰辺 rebase_fix → finalize を足す。
// ---------------------------------------------------------------------------

export interface AdvanceEdge {
  readonly axisKey: string;
  readonly from: string;
  readonly to: string;
}

function mainSequenceOf(axisKey: string): readonly string[] {
  const axis = RUN_AXES.find((a) => a.axisKey() === axisKey);
  if (axis === undefined) throw new Error(`BUG: unknown axis ${axisKey}`);
  const phases = axis.phases();
  // kind==rebase_fix は解決サイクル専用で、rebase_fix が主フェーズ (迂回ではない)。
  if (axis.kind === "rebase_fix") return phases;
  return phases.filter((p) => p !== REBASE_FIX_DETOUR_PHASE);
}

function buildAdvanceEdges(): readonly AdvanceEdge[] {
  const edges: AdvanceEdge[] = [];
  for (const axis of RUN_AXES) {
    const axisKey = axis.axisKey();
    const seq = mainSequenceOf(axisKey);
    for (let i = 0; i < seq.length - 1; i++) {
      edges.push({ axisKey, from: seq[i], to: seq[i + 1] });
    }
    if (axis.kind !== "rebase_fix") {
      // 迂回の復帰辺 (設計2.4「解けたら検証 PASS → advance で finalize へ戻る」)
      edges.push({
        axisKey,
        from: REBASE_FIX_DETOUR_PHASE,
        to: FINALIZE_PHASE,
      });
    }
  }
  return edges;
}

export const ADVANCE_EDGES: readonly AdvanceEdge[] = buildAdvanceEdges();

export function isAdvanceEdge(
  axisKey: string,
  from: string,
  to: string,
): boolean {
  return ADVANCE_EDGES.some((e) =>
    e.axisKey === axisKey && e.from === from && e.to === to
  );
}

export function advanceTargetsOf(run: V2Run): readonly string[] {
  const axisKey = axisKeyOfRun(run);
  return ADVANCE_EDGES.filter((e) =>
    e.axisKey === axisKey && e.from === run.phase
  ).map((e) => e.to);
}

// ---------------------------------------------------------------------------
// VERB_SPEC v2
// ---------------------------------------------------------------------------

export type ProgressEffect = string | "unchanged" | "dynamic" | "removed";

export type ArtifactEffect =
  // artifact オブジェクトが 1 バイトも変わらない (フレームテストも書き換えを禁じる)
  | "untouched"
  // 座標は動かないがフィールドは書きうる
  | "unchanged"
  // follow があれば (auto, null, quiet) へ戻す。無ければ artifact 不変 (設計2.3)
  | "cycle-reset"
  | "fix-pending"
  // follow があれば rebase 軸を quiet に。無ければ artifact 不変
  | "rebase-quiet"
  | "rebase-taken"
  | "merged"
  | "withdrawn(asked=false)"
  | "withdrawn(asked=true)"
  | "dynamic";

export interface ArtifactAxisSpec {
  readonly from: readonly string[];
  readonly to: ArtifactEffect;
}

export interface VerbSpecV2 {
  readonly p: {
    readonly from: readonly string[];
    readonly to: ProgressEffect;
  };
  // 入口 (P ノード) で A 側の前提が変わる verb (rebase-start) のため、v1 の
  // resolveRebaseAxis と同型のノード別指定を許す。
  readonly a: ArtifactAxisSpec | Readonly<Record<string, ArtifactAxisSpec>>;
}

export function resolveArtifactAxis(
  spec: VerbSpecV2["a"],
  pNode: string,
): ArtifactAxisSpec {
  if ("from" in spec && "to" in spec) return spec as ArtifactAxisSpec;
  const byNode = (spec as Readonly<Record<string, ArtifactAxisSpec>>)[pNode];
  if (byNode === undefined) {
    throw new Error(`BUG: no artifact axis for node ${pNode}`);
  }
  return byNode;
}

const A_UNTOUCHED: ArtifactAxisSpec = {
  from: A_NODE_KEYS,
  to: "untouched",
};

export const VERB_SPEC: Readonly<Record<string, VerbSpecV2>> = {
  // 新規エントリの追加なので from ノードを持たない (v1 の approve と同じ扱い)。
  "approve": {
    p: { from: [], to: "queued" },
    a: { from: [], to: "untouched" },
  },
  "claim": {
    p: {
      from: ["queued"],
      to: RUN_NODE_KEY_BY_COORD.get(
        `initial|full|${INITIAL_FULL_FIRST_PHASE}`,
      ) as string,
    },
    a: { from: A_NODE_KEYS, to: "cycle-reset" },
  },
  "set-gate": {
    p: {
      from: [
        RUN_NODE_KEY_BY_COORD.get(
          `initial|full|${INITIAL_FULL_FIRST_PHASE}`,
        ) as string,
      ],
      to: RUN_NODE_KEY_BY_COORD.get(
        `initial|light|${INITIAL_LIGHT_FIRST_PHASE}`,
      ) as string,
    },
    a: A_UNTOUCHED,
  },
  "advance": {
    p: { from: P_VERIFIED_KEYS, to: "dynamic" },
    a: A_UNTOUCHED,
  },
  "phase-fail": {
    p: { from: P_VERIFIED_KEYS, to: "unchanged" },
    a: A_UNTOUCHED,
  },
  "block": {
    p: { from: P_RUNNING_KEYS, to: "blocked" },
    a: A_UNTOUCHED,
  },
  "dequeue": {
    p: { from: P_RUNNING_KEYS, to: "removed" },
    a: A_UNTOUCHED,
  },
  // merged は retire で queue を離脱する終端なので from から外れる (設計2.5)。
  "restore": {
    p: { from: ["resting", "blocked"], to: "queued" },
    a: { from: A_NODE_KEYS_EXCEPT_MERGED, to: "unchanged" },
  },
  "retire": {
    p: { from: ["resting"], to: "removed" },
    a: { from: [A_NODE_MERGED], to: "untouched" },
  },
  "ship": {
    p: { from: P_FINALIZE_KEYS, to: "resting" },
    a: { from: A_NODE_KEYS, to: "dynamic" },
  },
  "merged": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_KEYS, to: "merged" },
  },
  "withdraw": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_KEYS, to: "withdrawn(asked=false)" },
  },
  "withdraw-asked": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_WITHDRAWN_KEYS, to: "withdrawn(asked=true)" },
  },
  "withdraw-remove": {
    p: { from: ["resting"], to: "removed" },
    a: { from: A_WITHDRAWN_KEYS, to: "untouched" },
  },
  "fix-request": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "fix-pending" },
  },
  "rebase-request": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "dynamic" },
  },
  "rebase-applied": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "rebase-quiet" },
  },
  "fix-start": {
    p: { from: ["resting"], to: "dynamic" },
    a: {
      from: openNodesWhere({ attention: ["auto"], fix: ["pending"] }),
      to: "dynamic",
    },
  },
  // 入口2つ: (a) resting からの解決サイクル、(b) finalize からの迂回 (設計2.4)。
  "rebase-start": {
    p: { from: ["resting", ...P_FINALIZE_KEYS], to: "dynamic" },
    a: Object.fromEntries([
      [
        "resting",
        {
          from: openNodesWhere({ attention: ["auto"], rebase: ["queued"] }),
          to: "rebase-taken",
        } as ArtifactAxisSpec,
      ],
      ...P_FINALIZE_KEYS.map((
        k,
      ) => [k, { from: A_NODE_KEYS, to: "untouched" } as ArtifactAxisSpec]),
    ]),
  },
  "rebase-give-up": {
    p: { from: P_CYCLE_REBASE_KEYS, to: "resting" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "rebase-quiet" },
  },
  "rebase-forgo": {
    p: { from: P_DETOUR_KEYS, to: "dynamic" },
    a: { from: A_NODE_KEYS, to: "rebase-quiet" },
  },
  // from 前提は設計1.3 の追従対象の導出式そのもの。
  "probe-run": {
    p: { from: ["resting"], to: "unchanged" },
    a: {
      from: openNodesWhere({
        attention: ["auto"],
        fix: ["null"],
        rebase: ["quiet"],
      }),
      to: "unchanged",
    },
  },
  "probe-exit": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "unchanged" },
  },
  "release": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_NODE_KEYS, to: "unchanged" },
  },
  "observe": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "dynamic" },
  },
  "attention-set": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "dynamic" },
  },
  "review-only": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "unchanged" },
  },
  "answered-set": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "unchanged" },
  },
  "set-worktree": {
    p: { from: P_RUNNING_KEYS, to: "unchanged" },
    a: A_UNTOUCHED,
  },
  "set-executor": {
    p: { from: P_RUNNING_KEYS, to: "unchanged" },
    a: A_UNTOUCHED,
  },
  "touch-executor": {
    p: { from: P_RUNNING_KEYS, to: "unchanged" },
    a: A_UNTOUCHED,
  },
  "set-takeover": {
    p: { from: P_RUNNING_KEYS, to: "unchanged" },
    a: A_UNTOUCHED,
  },
};

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

function requireVerbAxes(item: V2Item, verb: string): string {
  const spec = VERB_SPEC[verb];
  if (spec === undefined) {
    throw new Error(`BUG: no VERB_SPEC entry for verb: ${verb}`);
  }
  const pNode = pNodeKeyOf(item);
  if (pNode === null || !spec.p.from.includes(pNode)) {
    throw new CliErrorV2(
      "conflict",
      `${verb}: progress node must be one of [${spec.p.from.join(", ")}], ` +
        `got ${pNode ?? `progress=${String(item.progress)}`}`,
    );
  }
  const axis = resolveArtifactAxis(spec.a, pNode);
  const aNode = aNodeKeyOf(item);
  if (aNode === null || !axis.from.includes(aNode)) {
    throw new CliErrorV2(
      "conflict",
      `${verb}: artifact node must be one of [${axis.from.join(", ")}], ` +
        `got ${aNode ?? "invalid"}`,
    );
  }
  return pNode;
}

export function queueIndexOf(state: V2State, id: string): number {
  return state.queue.findIndex((it) => it.id === id);
}

export function requireQueueItem(
  state: V2State,
  id: string,
): { index: number; item: V2Item } {
  const index = queueIndexOf(state, id);
  if (index === -1) {
    throw new CliErrorV2("missing", `id not found in queue: ${id}`);
  }
  return { index, item: state.queue[index] };
}

function withReplacedItem(
  state: V2State,
  index: number,
  item: V2Item,
): V2State {
  const queue = state.queue.slice();
  queue[index] = item;
  return { ...state, queue };
}

function withRemovedItem(state: V2State, index: number): V2State {
  const queue = state.queue.slice();
  queue.splice(index, 1);
  return { ...state, queue };
}

function unionAppend(
  existing: readonly string[],
  additions: readonly string[],
): string[] {
  const set = new Set(existing);
  for (const a of additions) set.add(a);
  return [...set];
}

// follow を持つ open であることが from 宣言で保証されている verb 用。
function requireFollow(item: V2Item, verb: string): {
  open: V2ArtifactOpen;
  follow: V2Follow;
} {
  const open = openArtifactOf(item);
  if (open === null || open.follow === null) {
    throw new Error(`BUG: ${verb} requires an open artifact with follow`);
  }
  return { open, follow: open.follow };
}

function withFollow(open: V2ArtifactOpen, follow: V2Follow): V2ArtifactOpen {
  return { ...open, follow };
}

function withProbe(follow: V2Follow, probe: V2Probe): V2Follow {
  return { ...follow, probe };
}

// 追従リースを外す (probe.proc と proc_started_at をまとめて null に)。
function withoutLease(artifact: V2Artifact): V2Artifact {
  if (artifact.state !== "open" || artifact.follow === null) return artifact;
  const follow = artifact.follow;
  if (follow.probe.proc === null && follow.probe.proc_started_at === null) {
    return artifact;
  }
  return withFollow(
    artifact,
    withProbe(follow, {
      ...follow.probe,
      proc: null,
      proc_started_at: null,
    }),
  );
}

// ---------------------------------------------------------------------------
// 進行系 (設計2.1)
// ---------------------------------------------------------------------------

export function applyApprove(
  state: V2State,
  id: string,
  title: string,
): V2State {
  requirePrecondition(
    queueIndexOf(state, id) === -1,
    `id already exists in queue: ${id}`,
  );
  const entry: V2Item = {
    id,
    title,
    progress: "queued",
    run: null,
    blocked_reason: null,
    artifact: { state: "none" },
    worktree: null,
    base: null,
    session: null,
  };
  return { ...state, queue: [...state.queue, entry] };
}

// 周回リセット (設計2.3)。handled だけは PR の寿命全体の記憶として保持する。
// probe.proc には触れない — queued へ来る唯一の経路 restore が既に外しており
// (不変条件4)、ここで触ると 2.3 の宣言を超える。
function cycleResetArtifact(artifact: V2Artifact): V2Artifact {
  if (artifact.state !== "open" || artifact.follow === null) return artifact;
  const follow = artifact.follow;
  return withFollow(artifact, {
    attention: "auto",
    asks: { fix: null, rebase: null },
    ledger: {
      handled: follow.ledger.handled,
      fix_attempts: 0,
      review_only: [],
      answered: [],
    },
    probe: { ...follow.probe, sig: null },
  });
}

export function applyClaim(
  item: V2Item,
  index: number,
  state: V2State,
  session: string,
): V2State {
  requireVerbAxes(item, "claim");
  const next: V2Item = {
    ...item,
    progress: "running",
    run: {
      kind: "initial",
      gate: "full",
      phase: INITIAL_FULL_FIRST_PHASE,
      attempts: 0,
      executor: null,
      executor_last_event_at: null,
      takeover_at: null,
    },
    blocked_reason: null,
    artifact: cycleResetArtifact(item.artifact),
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applySetGate(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  requireVerbAxes(item, "set-gate");
  const run = item.run as V2Run;
  const next: V2Item = {
    ...item,
    run: {
      ...run,
      gate: "light",
      phase: INITIAL_LIGHT_FIRST_PHASE,
      attempts: 0,
    },
  };
  return withReplacedItem(state, index, next);
}

export function applyAdvance(
  item: V2Item,
  index: number,
  state: V2State,
  from: string,
  to: string,
): V2State {
  requireVerbAxes(item, "advance");
  const run = item.run as V2Run;
  requirePrecondition(
    run.phase === from,
    `phase must be ${from}, got ${String(run.phase)}`,
  );
  requirePrecondition(
    isAdvanceEdge(axisKeyOfRun(run), from, to),
    `not an advance edge for ${axisKeyOfRun(run)}: ${from} -> ${to}`,
  );
  const next: V2Item = { ...item, run: { ...run, phase: to, attempts: 0 } };
  return withReplacedItem(state, index, next);
}

export interface PhaseFailResult {
  state: V2State;
  attempts: number;
}

export function applyPhaseFail(
  item: V2Item,
  index: number,
  state: V2State,
  phase: string,
): PhaseFailResult {
  requireVerbAxes(item, "phase-fail");
  const run = item.run as V2Run;
  requirePrecondition(
    run.phase === phase,
    `phase must be ${phase}, got ${String(run.phase)}`,
  );
  const attempts = run.attempts + 1;
  const next: V2Item = { ...item, run: { ...run, attempts } };
  return { state: withReplacedItem(state, index, next), attempts };
}

// 追従の静止処理は無い (設計2.6「watch の静止処理が消える」): 追従対象は
// resting ∧ open からの導出なので、blocked のタスクは定義から追従されない。
// probe.proc は不変条件4により running の時点で既に null である。
export function applyBlock(
  item: V2Item,
  index: number,
  state: V2State,
  reason: string,
): V2State {
  requireVerbAxes(item, "block");
  const next: V2Item = {
    ...item,
    progress: "blocked",
    run: null,
    blocked_reason: reason,
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyDequeue(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  requireVerbAxes(item, "dequeue");
  return withRemovedItem(state, index);
}

export function applyRestore(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  const relistedIndex = state.relisted.findIndex((r) => r.id === item.id);
  if (relistedIndex === -1) {
    throw new CliErrorV2("missing", `id not found in relisted: ${item.id}`);
  }
  requireVerbAxes(item, "restore");
  // gate の復元処理は無い (設計2.6): gate は run の中にしか存在せず、queued は run を
  // 持たない。claim が毎回 gate: full で run を作り直すので、v1 の死に組
  // (in_progress/research, gate: light) は構造として生まれない。
  const next: V2Item = {
    ...item,
    progress: "queued",
    run: null,
    blocked_reason: null,
    artifact: withoutLease(item.artifact),
    session: null,
  };
  const relisted = state.relisted.slice();
  relisted.splice(relistedIndex, 1);
  return { ...withReplacedItem(state, index, next), relisted };
}

const COMPLETED_KEEP_MINUTES = 24 * 60;

// 24 時間超の控えを掃除する (設計2.5)。日時として解釈できない控えは残す
// (捨てる判断の根拠が無いため)。
function prunedCompleted(
  entries: readonly CompletedEntry[],
  nowMs: number,
): CompletedEntry[] {
  return entries.filter((e) => {
    const t = Date.parse(e.done_at);
    if (Number.isNaN(t)) return true;
    return (nowMs - t) / 60_000 <= COMPLETED_KEEP_MINUTES;
  });
}

export function applyRetire(
  item: V2Item,
  index: number,
  state: V2State,
  nowIso: string,
): V2State {
  requireVerbAxes(item, "retire");
  // 「揮発資源ゼロ」(設計2.1) の state 上の実体は session が空いていること。
  // merged は follow を持たないので probe のリースは存在しない。
  requirePrecondition(
    item.session === null,
    `session must be released before retire, got ${String(item.session)}`,
  );
  const nowMs = Date.parse(nowIso);
  const kept = prunedCompleted(
    state.completed,
    Number.isNaN(nowMs) ? Number.NEGATIVE_INFINITY : nowMs,
  );
  const completed = [...kept, { id: item.id, done_at: nowIso }];
  return { ...withRemovedItem(state, index), completed };
}

// ---------------------------------------------------------------------------
// 完了系 (設計2.2)
// ---------------------------------------------------------------------------

// ref が PR URL のときだけ follow が生まれる (設計1.3)。finish=commit のブランチ参照や
// コミット sha は follow を持たない。
const PULL_REQUEST_REF_PATTERN = /^https?:\/\/[^\s]+\/pull\/\d+$/;

export function isPullRequestRef(ref: string): boolean {
  return PULL_REQUEST_REF_PATTERN.test(ref);
}

// follow の初期値は固定 (設計1.3)。probe.sig: null が最初の watch 起動を catch-up
// 観測から始めさせる引き金である。
export function freshFollow(): V2Follow {
  return {
    attention: "auto",
    asks: { fix: null, rebase: null },
    ledger: { handled: [], fix_attempts: 0, review_only: [], answered: [] },
    probe: {
      proc: null,
      proc_started_at: null,
      sig: null,
      head: null,
      ci: null,
      checked_at: null,
      errors: 0,
      note: null,
    },
  };
}

export interface ShipArgs {
  readonly commits: number;
  readonly ref?: string;
  readonly branch?: string;
  readonly tip?: string;
  readonly base?: string;
}

export interface ShipResult {
  state: V2State;
  // 「この ship で artifact が open を新規作成したか (initial)、既存の open の tip が
  // 動いたか (update)、今回の push で共有された成果物が無いか (none)」の導出。
  notify: "initial" | "update" | "none";
  // トラッカーへ `mark <id> in_review` が要るか。initial の engagement の終端だけ真。
  mark: boolean;
  // この ship が消費した asks.fix.ids の件数 (handled の増分ではない)。
  fix_count: number;
}

export function applyShip(
  item: V2Item,
  index: number,
  state: V2State,
  args: ShipArgs,
): ShipResult {
  requireVerbAxes(item, "ship");
  const run = item.run as V2Run;
  const groupGiven =
    [args.ref, args.branch, args.tip, args.base].filter((v) => v !== undefined)
      .length;
  if (args.commits >= 1) {
    requirePrecondition(
      groupGiven === 4,
      "--ref/--branch/--tip/--base are all required when commits >= 1",
    );
  } else {
    requirePrecondition(
      groupGiven === 0,
      "--ref/--branch/--tip/--base must all be omitted when commits == 0",
    );
  }

  const before = item.artifact;
  let artifact: V2Artifact;
  if (args.commits === 0) {
    // finish=none。グループ欄は不変 (設計2.2)。asks の消費と sig のリセットは
    // 下で共通に行う — 2.2 の擬似コードがそれらを commits の分岐の外に置いている。
    artifact = before;
  } else if (before.state === "open") {
    // グループ欄だけを書き、follow は保持する。「グループを新規リテラルで置く」形が
    // 存在しないことが、v1 の issue #13 (in-review が watch を破壊した) を
    // 表現不能にしている。
    artifact = {
      ...before,
      ref: args.ref as string,
      branch: args.branch as string,
      tip: args.tip as string,
      base: args.base as string,
    };
  } else {
    // none / withdrawn からの新規 open。withdrawn の asked / note は捨てる —
    // 旧 PR は閉じており、新しい PR は新しい追従対象である (設計2.2)。
    const ref = args.ref as string;
    artifact = {
      state: "open",
      ref,
      branch: args.branch as string,
      tip: args.tip as string,
      base: args.base as string,
      follow: isPullRequestRef(ref) ? freshFollow() : null,
    };
  }

  let fixCount = 0;
  if (artifact.state === "open" && artifact.follow !== null) {
    const follow = artifact.follow;
    let ledger = follow.ledger;
    let fix = follow.asks.fix;
    if (fix !== null && fix.taken) {
      fixCount = fix.ids.length;
      ledger = { ...ledger, handled: unionAppend(ledger.handled, fix.ids) };
      fix = null;
    }
    let rebase = follow.asks.rebase;
    if (rebase !== null) {
      if (rebase.taken) {
        rebase = null;
      } else if (rebase.resolve) {
        // 未消費の解決要求は ship に至った push で用済み。ガード控え (quiet) に降格する。
        rebase = { ...rebase, resolve: false };
      }
    }
    artifact = withFollow(artifact, {
      ...follow,
      asks: { fix, rebase },
      ledger,
      probe: { ...follow.probe, sig: null },
    });
  }

  const keepSession = artifact.state === "open" && artifact.follow !== null;
  const next: V2Item = {
    ...item,
    progress: "resting",
    run: null,
    artifact,
    session: keepSession ? item.session : null,
  };
  const notify: ShipResult["notify"] = args.commits === 0
    ? "none"
    : before.state === "open"
    ? "update"
    : "initial";
  return {
    state: withReplacedItem(state, index, next),
    notify,
    mark: run.kind === "initial",
    fix_count: fixCount,
  };
}

export function applyMerged(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  requireVerbAxes(item, "merged");
  const open = openArtifactOf(item) as V2ArtifactOpen;
  requirePrecondition(open.tip !== null, "artifact.tip must be present");
  // follow は破棄される (merged は follow の子を持たない — 設計1.1)。これが v1 の
  // 「done に watching が残る」欠陥クラスを表現不能にしている形そのもの。
  const next: V2Item = {
    ...item,
    artifact: {
      state: "merged",
      ref: open.ref,
      branch: open.branch,
      tip: open.tip,
      base: open.base,
    },
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyWithdraw(
  item: V2Item,
  index: number,
  state: V2State,
  note?: string,
): V2State {
  requireVerbAxes(item, "withdraw");
  const open = openArtifactOf(item) as V2ArtifactOpen;
  const next: V2Item = {
    ...item,
    artifact: {
      state: "withdrawn",
      ref: open.ref,
      branch: open.branch,
      tip: open.tip,
      base: open.base,
      asked: false,
      note: note ?? null,
    },
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyWithdrawAsked(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  requireVerbAxes(item, "withdraw-asked");
  const withdrawn = item.artifact as V2ArtifactWithdrawn;
  const next: V2Item = {
    ...item,
    artifact: { ...withdrawn, asked: true },
  };
  return withReplacedItem(state, index, next);
}

export function applyWithdrawRemove(
  item: V2Item,
  index: number,
  state: V2State,
  reason: string,
  nowIso: string,
): V2State {
  requireVerbAxes(item, "withdraw-remove");
  requirePrecondition(
    item.worktree !== null && item.base !== null,
    "worktree/base must be set",
  );
  const entry: WithdrawnBranchEntry = {
    id: item.id,
    branch: `task-pipeline/${item.id}`,
    base: item.base as string,
    worktree: item.worktree as string,
    at: nowIso,
    reason,
  };
  const removed = withRemovedItem(state, index);
  return {
    ...removed,
    withdrawn_branches: [...state.withdrawn_branches, entry],
  };
}

// ---------------------------------------------------------------------------
// 要求系 (設計2.1「要求系」。前提 P==resting)
// ---------------------------------------------------------------------------

export function applyFixRequest(
  item: V2Item,
  index: number,
  state: V2State,
  ids: readonly string[],
  findings: string,
): V2State {
  const { open, follow } = requireFollowFor(item, "fix-request");
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, {
      ...follow,
      asks: { ...follow.asks, fix: { ids: [...ids], findings, taken: false } },
    }),
  };
  return withReplacedItem(state, index, next);
}

function requireFollowFor(
  item: V2Item,
  verb: string,
): { open: V2ArtifactOpen; follow: V2Follow } {
  requireVerbAxes(item, verb);
  return requireFollow(item, verb);
}

export interface RebaseRequestArgs {
  readonly blockedOnto: string;
  readonly reason: string;
  readonly kind?: string;
  readonly cause?: string;
  readonly report?: string;
  readonly fromTip?: string;
  // 解決サイクル行きの宣言 (v1 の rebase-resolve-pending)。省略時は既存の resolve を
  // そのまま保つ — v1 の rebase-record が resolve_pending に触れなかった挙動の維持。
  readonly resolve?: boolean;
}

export function applyRebaseRequest(
  item: V2Item,
  index: number,
  state: V2State,
  args: RebaseRequestArgs,
  nowIso: string,
): V2State {
  const { open, follow } = requireFollowFor(item, "rebase-request");
  const existing = follow.asks.rebase;
  const rebase: V2RebaseAsk = {
    blocked_onto: args.blockedOnto,
    reason: args.reason,
    at: existing?.at ?? nowIso,
    kind: args.kind ?? existing?.kind ?? null,
    cause: args.cause ?? existing?.cause ?? null,
    report: args.report ?? existing?.report ?? null,
    from_tip: args.fromTip ?? existing?.from_tip ?? null,
    resolve: args.resolve ?? existing?.resolve ?? false,
    // taken に触れてよい verb の列挙 (不変条件5) に rebase-request は入っていない。
    taken: existing?.taken ?? false,
  };
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, { ...follow, asks: { ...follow.asks, rebase } }),
  };
  return withReplacedItem(state, index, next);
}

// run 無しの載せ直し成功 (force push)。rebase-ask が無くても呼べる —
// 衝突なく成功した背景載せ直しには控えが無く、それでも tip の更新は要る (欠陥12)。
export function applyRebaseApplied(
  item: V2Item,
  index: number,
  state: V2State,
  tip: string,
): V2State {
  const { open, follow } = requireFollowFor(item, "rebase-applied");
  const next: V2Item = {
    ...item,
    artifact: withFollow({ ...open, tip }, {
      ...follow,
      asks: { ...follow.asks, rebase: null },
      probe: { ...follow.probe, sig: null },
    }),
  };
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 仕上げ開始系 (要求の消費。設計2.1・2.4)
// ---------------------------------------------------------------------------

export const FIX_ATTEMPT_LIMIT = 3;

export interface FixStartResult {
  state: V2State;
  started: boolean;
  fixAttempts: number;
}

export function applyFixStart(
  item: V2Item,
  index: number,
  state: V2State,
  session: string,
  resetAttempts: boolean,
): FixStartResult {
  const { open, follow } = requireFollowFor(item, "fix-start");
  const fix = follow.asks.fix as V2FixAsk;
  const fixAttempts = (resetAttempts ? 0 : follow.ledger.fix_attempts) + 1;
  const started = fixAttempts <= FIX_ATTEMPT_LIMIT;
  const ledger = { ...follow.ledger, fix_attempts: fixAttempts };
  const probe = { ...follow.probe, proc: null, proc_started_at: null };
  if (started) {
    const next: V2Item = {
      ...item,
      progress: "running",
      run: {
        kind: "pr_fix",
        gate: null,
        phase: "pr_fix",
        attempts: 0,
        executor: null,
        executor_last_event_at: null,
        takeover_at: null,
      },
      artifact: withFollow(open, {
        ...follow,
        asks: { ...follow.asks, fix: { ...fix, taken: true } },
        ledger,
        probe,
      }),
      session,
    };
    return {
      state: withReplacedItem(state, index, next),
      started,
      fixAttempts,
    };
  }
  // 上限超: asks.fix には触れない (pending のまま人の再開を待つ)。attention の
  // 切り替えがラッチになり、from 前提 (attention==auto) が偽になる。
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, {
      ...follow,
      attention: { human: "fix_limit" },
      ledger,
      probe,
    }),
    session: null,
  };
  return { state: withReplacedItem(state, index, next), started, fixAttempts };
}

export function applyRebaseStart(
  item: V2Item,
  index: number,
  state: V2State,
  session: string,
): V2State {
  requireVerbAxes(item, "rebase-start");
  if (item.progress === "resting") {
    // 入口 (a): 解決サイクル。要求を消費して専用の run を作る。
    const { open, follow } = requireFollow(item, "rebase-start");
    const rebase = follow.asks.rebase as V2RebaseAsk;
    const next: V2Item = {
      ...item,
      progress: "running",
      run: {
        kind: "rebase_fix",
        gate: null,
        phase: REBASE_FIX_DETOUR_PHASE,
        attempts: 0,
        executor: null,
        executor_last_event_at: null,
        takeover_at: null,
      },
      artifact: withFollow(open, {
        ...follow,
        asks: { ...follow.asks, rebase: { ...rebase, taken: true } },
        probe: { ...follow.probe, proc: null, proc_started_at: null },
      }),
      session,
    };
    return withReplacedItem(state, index, next);
  }
  // 入口 (b): 迂回。phase だけを動かし、kind・gate・asks には触れない (設計2.4)。
  // 来歴 (kind) が保たれることが ship の mark / notify 導出の安定性の根拠である。
  const run = item.run as V2Run;
  const next: V2Item = {
    ...item,
    run: { ...run, phase: REBASE_FIX_DETOUR_PHASE, attempts: 0 },
  };
  return withReplacedItem(state, index, next);
}

function rebaseGuardUpsert(
  existing: V2RebaseAsk | null,
  blockedOnto: string,
  nowIso: string,
): V2RebaseAsk {
  return {
    blocked_onto: blockedOnto,
    reason: "conflict",
    at: existing?.at ?? nowIso,
    kind: existing?.kind ?? null,
    cause: existing?.cause ?? null,
    report: existing?.report ?? null,
    from_tip: existing?.from_tip ?? null,
    resolve: false,
    taken: false,
  };
}

// 解決サイクルの失敗出口 (kind==rebase_fix 専用)。resting へ戻り、ask を quiet の
// ガード控えに戻す。PR は旧基点のまま生きていて push の義務は無い。
export function applyRebaseGiveUp(
  item: V2Item,
  index: number,
  state: V2State,
  blockedOnto: string,
  nowIso: string,
): V2State {
  const { open, follow } = requireFollowFor(item, "rebase-give-up");
  const next: V2Item = {
    ...item,
    progress: "resting",
    run: null,
    artifact: withFollow(open, {
      ...follow,
      asks: {
        ...follow.asks,
        rebase: rebaseGuardUpsert(follow.asks.rebase, blockedOnto, nowIso),
      },
    }),
    session: null,
  };
  return withReplacedItem(state, index, next);
}

// 迂回の失敗出口 (kind != rebase_fix 専用)。旧基点のまま push させるため finalize へ
// 戻す — 検証ゲート無しで finalize へ進む唯一の辺 (元の finalize が果たされておらず
// push の義務が残っている)。
export function applyRebaseForgo(
  item: V2Item,
  index: number,
  state: V2State,
  blockedOnto: string,
  nowIso: string,
): V2State {
  requireVerbAxes(item, "rebase-forgo");
  const run = item.run as V2Run;
  const open = openArtifactOf(item);
  const artifact = open === null || open.follow === null ? item.artifact : (
    withFollow(open, {
      ...open.follow,
      asks: {
        ...open.follow.asks,
        rebase: rebaseGuardUpsert(
          open.follow.asks.rebase,
          blockedOnto,
          nowIso,
        ),
      },
    })
  );
  const next: V2Item = {
    ...item,
    run: { ...run, phase: FINALIZE_PHASE, attempts: 0 },
    artifact,
  };
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 追従系 (設計2.1「追従系」。前提 P==resting、follow != null)
//
// 「省略した引数のフィールドは既存値を保つ」ため、引数はキーの存在で分岐する
// (v1 の applyWatchSet の `"head" in fields` と同じ流儀)。これにより「明示的に null を
// 書く」と「触れない」を取り違えない。
// ---------------------------------------------------------------------------

export interface ProbeRunFields {
  readonly proc: string;
  readonly session?: string;
}

export function applyProbeRun(
  item: V2Item,
  index: number,
  state: V2State,
  fields: ProbeRunFields,
  nowIso: string,
): V2State {
  const { open, follow } = requireFollowFor(item, "probe-run");
  const next: V2Item = {
    ...item,
    artifact: withFollow(
      open,
      withProbe(follow, {
        ...follow.probe,
        proc: fields.proc,
        proc_started_at: nowIso,
      }),
    ),
    session: "session" in fields ? (fields.session as string) : item.session,
  };
  return withReplacedItem(state, index, next);
}

export interface ProbeExitFields {
  readonly sig?: string | null;
}

export function applyProbeExit(
  item: V2Item,
  index: number,
  state: V2State,
  fields: ProbeExitFields,
): V2State {
  const { open, follow } = requireFollowFor(item, "probe-exit");
  const probe: V2Probe = {
    ...follow.probe,
    proc: null,
    proc_started_at: null,
    sig: "sig" in fields ? (fields.sig as string | null) : follow.probe.sig,
  };
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, withProbe(follow, probe)),
  };
  return withReplacedItem(state, index, next);
}

// resting のタスクの揮発資源を手放す明示 verb (v1 の watch-set --session null の後継)。
export function applyRelease(
  item: V2Item,
  index: number,
  state: V2State,
): V2State {
  requireVerbAxes(item, "release");
  const next: V2Item = {
    ...item,
    artifact: withoutLease(item.artifact),
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export const OBSERVE_ERROR_LIMIT = 3;

export interface ObserveFields {
  readonly head?: string | null;
  readonly ci?: string | null;
  readonly checked_at?: string | null;
  readonly note?: string | null;
  readonly errorsInc?: boolean;
  readonly errorsReset?: boolean;
  readonly sigClear?: boolean;
}

export interface ObserveResult {
  state: V2State;
  errors: number;
  // errors が上限に達して attention が human(errors) にラッチしたか。
  latched: boolean;
}

export function applyObserve(
  item: V2Item,
  index: number,
  state: V2State,
  fields: ObserveFields,
): ObserveResult {
  const { open, follow } = requireFollowFor(item, "observe");
  let probe: V2Probe = { ...follow.probe };
  if ("head" in fields) {
    probe = { ...probe, head: fields.head as string | null };
  }
  if ("ci" in fields) probe = { ...probe, ci: fields.ci as string | null };
  if ("checked_at" in fields) {
    probe = { ...probe, checked_at: fields.checked_at as string | null };
  }
  if ("note" in fields) {
    probe = { ...probe, note: fields.note as string | null };
  }
  if (fields.errorsInc) probe = { ...probe, errors: probe.errors + 1 };
  if (fields.errorsReset) probe = { ...probe, errors: 0 };
  if (fields.sigClear) probe = { ...probe, sig: null };

  let attention = follow.attention;
  let session = item.session;
  const latched = probe.errors >= OBSERVE_ERROR_LIMIT;
  if (latched) {
    // 上限到達は同じ書き込みで attention・session・リースをまとめて畳む (設計2.1)。
    // session を残すと他セッションの回収が最大 90 分遅れる。
    attention = { human: "errors" };
    session = null;
    probe = { ...probe, proc: null, proc_started_at: null };
  }
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, { ...follow, attention, probe }),
    session,
  };
  return {
    state: withReplacedItem(state, index, next),
    errors: probe.errors,
    latched,
  };
}

export function applyAttentionSet(
  item: V2Item,
  index: number,
  state: V2State,
  target: "auto" | HumanAttentionReason,
): V2State {
  const { open, follow } = requireFollowFor(item, "attention-set");
  if (target === "auto") {
    // 人の再開。errors も 0 に戻す (戻さないと復帰後の最初の 1 エラーで即再ラッチする)。
    const next: V2Item = {
      ...item,
      artifact: withFollow(open, {
        ...follow,
        attention: "auto",
        probe: { ...follow.probe, errors: 0 },
      }),
    };
    return withReplacedItem(state, index, next);
  }
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, {
      ...follow,
      attention: { human: target },
      probe: { ...follow.probe, proc: null, proc_started_at: null },
    }),
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export interface LedgerUpsertResult {
  state: V2State;
  newOrChanged: string[];
  total: number;
}

function upsertLedgerEntries(
  existing: readonly LedgerEntry[],
  items: readonly LedgerEntry[],
): { list: LedgerEntry[]; newOrChanged: string[] } {
  const byId = new Map(existing.map((e) => [e.id, e.updated_at]));
  const newOrChanged: string[] = [];
  for (const it of items) {
    const known = byId.has(it.id);
    const prev = byId.get(it.id) ?? null;
    const changed = !known || prev === null || it.updated_at === null ||
      prev !== it.updated_at;
    if (changed && !newOrChanged.includes(it.id)) newOrChanged.push(it.id);
    byId.set(it.id, it.updated_at);
  }
  const list = [...byId.entries()].map(([id, updated_at]) => ({
    id,
    updated_at,
  }));
  return { list, newOrChanged };
}

// ledger.review_only は「人の判断が要ると回した」ことの語彙。handled / answered には
// 触れない (v1 の語彙非混入の規律をそのまま引き継ぐ)。
export function applyReviewOnly(
  item: V2Item,
  index: number,
  state: V2State,
  items: readonly LedgerEntry[],
): LedgerUpsertResult {
  const { open, follow } = requireFollowFor(item, "review-only");
  const { list, newOrChanged } = upsertLedgerEntries(
    follow.ledger.review_only,
    items,
  );
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, {
      ...follow,
      ledger: { ...follow.ledger, review_only: list },
    }),
  };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total: list.length,
  };
}

// ledger.answered は「質問に回答・投稿済み」の語彙。handled / review_only には触れない。
export function applyAnsweredSet(
  item: V2Item,
  index: number,
  state: V2State,
  items: readonly LedgerEntry[],
): LedgerUpsertResult {
  const { open, follow } = requireFollowFor(item, "answered-set");
  const { list, newOrChanged } = upsertLedgerEntries(
    follow.ledger.answered,
    items,
  );
  const next: V2Item = {
    ...item,
    artifact: withFollow(open, {
      ...follow,
      ledger: { ...follow.ledger, answered: list },
    }),
  };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total: list.length,
  };
}

// ---------------------------------------------------------------------------
// 実行帳簿 (対象が run の中のフィールドになるだけで起動形は v1 と同じ。設計2.6)
// ---------------------------------------------------------------------------

export function applySetWorktree(
  item: V2Item,
  index: number,
  state: V2State,
  worktree: string,
  base: string,
  drop: boolean,
): V2State {
  requireVerbAxes(item, "set-worktree");
  const next: V2Item = { ...item, worktree, base };
  const replaced = withReplacedItem(state, index, next);
  if (!drop) return replaced;
  const wbIndex = state.withdrawn_branches.findIndex((e) => e.id === item.id);
  requirePrecondition(
    wbIndex !== -1,
    `no withdrawn_branches entry for id: ${item.id}`,
  );
  const withdrawn_branches = state.withdrawn_branches.slice();
  withdrawn_branches.splice(wbIndex, 1);
  return { ...replaced, withdrawn_branches };
}

export function applySetExecutor(
  item: V2Item,
  index: number,
  state: V2State,
  executor: string,
  session: string,
  nowIso: string,
): V2State {
  requireVerbAxes(item, "set-executor");
  const run = item.run as V2Run;
  const next: V2Item = {
    ...item,
    run: { ...run, executor, executor_last_event_at: nowIso },
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applyTouchExecutor(
  item: V2Item,
  index: number,
  state: V2State,
  sessionIfUnowned: string | undefined,
  nowIso: string,
): V2State {
  requireVerbAxes(item, "touch-executor");
  const run = item.run as V2Run;
  requirePrecondition(run.executor !== null, "run.executor must be set");
  const next: V2Item = {
    ...item,
    run: { ...run, executor_last_event_at: nowIso },
    session: sessionIfUnowned !== undefined && item.session === null
      ? sessionIfUnowned
      : item.session,
  };
  return withReplacedItem(state, index, next);
}

export function applySetTakeover(
  item: V2Item,
  index: number,
  state: V2State,
  at: string | null,
): V2State {
  requireVerbAxes(item, "set-takeover");
  const run = item.run as V2Run;
  const next: V2Item = { ...item, run: { ...run, takeover_at: at } };
  return withReplacedItem(state, index, next);
}
