// task-pipeline/scripts/state-transitions-v2-types.ts
//
// 状態モデル v2 の **層 0〜2** — 基盤・データ型・形状宣言。
//
// このファイル群 (state-transitions-v2*.ts) は下から順に次の層で積まれており、
// import は必ず上の層から下の層への一方向である:
//
//   層 0  基盤            エラー型 (CliErrorV2 / ExitCodeName) と前提条件ヘルパ    ← ここ
//   層 1  データ型        V2Item / V2Artifact / V2State … JSON の形そのもの        ← ここ
//   層 2  形状宣言        ITEM_SHAPE ほか (設計3.1b の表を data 化したもの)        ← ここ
//   層 3  語彙とノード宣言 ATTENTION_AXIS_VALUES / A_OPEN_FOLLOW / ノードキーの型  (-nodes.ts)
//   層 4  導出ビュー      A_OPEN_FOLLOW_NODES / *_KEYS / P_*_KEYS                  (-nodes.ts)
//   層 5  引き当て        openNodeKey / openNodeOf / openNodesWhere                (-nodes.ts)
//   層 6  item → 座標     pNodeKeyOf / aNodeKeyOf / productKeyOf                    (-nodes.ts)
//   層 7  不変条件        invariant* / assertItemInvariantsV2                       (-nodes.ts)
//   層 8  遷移辺          ADVANCE_EDGES / advanceTargetsOf                          (-spec.ts)
//   層 9  遷移仕様        VERB_SPEC / resolveArtifactAxis                           (-spec.ts)
//   層 10 apply 群        applyClaim … applySetTakeover + 公開 API の再 export     (state-transitions-v2.ts)
//
// **公開面は層 10 の state-transitions-v2.ts だけ**である。このファイルを含む層 0〜9 の
// モジュールは実装内部であり、外部 (後続 issue の CLI 配線) は import しない。
// テストは層を意識して内部モジュールを直接 import してよい (どの層を検査しているかが
// import 文に出る)。
//
// Deno API を呼ばない純粋な宣言のみ。

import type { Attention, Gate, Progress, RunKind } from "./state-model-v2.ts";

// ---------------------------------------------------------------------------
// 層 0 (基盤) — エラー型 (v1 の CliError と同じ語彙を v2 側で自己完結して定義する)
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

export function requirePrecondition(cond: boolean, message: string): void {
  if (!cond) throw new CliErrorV2("conflict", message);
}

// ---------------------------------------------------------------------------
// 層 1 (データ型) — item の形。設計3.1b の「判別付き oneOf」を TypeScript の判別可能
// ユニオンで表す。
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
  // 停滞の記録 (スキーマ上は任意キー)。queue エントリの座標を持たない帳簿の値で、
  // 書き換えるのは stalled-set だけ (state-ledger-v2.ts)。
  readonly stalled?: string | null;
  readonly stalled_since?: string | null;
}

// ---------------------------------------------------------------------------
// 層 2 (形状宣言) — 設計3.1b の表を data 化したもの。
//
// v1 は state.schema.json の enum / properties を語彙・フィクスチャ突き合わせの相手に
// していた。v2 の JSON Schema 化は設計3節の範囲 (後続issue) なので、その役割をここの
// 宣言が担う: テストが「apply の出力キー集合が着地ノードの形と一致する」ことと
// 「フレームテストの最大フィクスチャが全プロパティを覆う」ことを強制する。
//
// 宣言そのものは型で対応する interface に縛る:
//   - `satisfies ShapeOf<T>` … 存在しないプロパティ名を書いたらコンパイルエラー
//   - `AssertShapeCovers<T, ...>` … プロパティを書き落としてもコンパイルエラー
// テストが見るのは「実際の値のキー集合がこの宣言と一致するか」だけになる。
// ---------------------------------------------------------------------------

type ShapeOf<T> = readonly (keyof T)[];
// S が T の全プロパティを覆っていなければ `never` になり、代入が型エラーになる。
type AssertShapeCovers<T, S extends ShapeOf<T>> = [
  Exclude<keyof T, S[number]>,
] extends [never] ? true : never;

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
] as const satisfies ShapeOf<V2Item>;

export const RUN_SHAPE = [
  "kind",
  "gate",
  "phase",
  "attempts",
  "executor",
  "executor_last_event_at",
  "takeover_at",
] as const satisfies ShapeOf<V2Run>;

export const ARTIFACT_SHAPES = {
  none: ["state"],
  open: ["state", "ref", "branch", "tip", "base", "follow"],
  merged: ["state", "ref", "branch", "tip", "base"],
  withdrawn: ["state", "ref", "branch", "tip", "base", "asked", "note"],
} as const satisfies {
  readonly none: ShapeOf<V2ArtifactNone>;
  readonly open: ShapeOf<V2ArtifactOpen>;
  readonly merged: ShapeOf<V2ArtifactMerged>;
  readonly withdrawn: ShapeOf<V2ArtifactWithdrawn>;
};

export const FOLLOW_SHAPE = [
  "attention",
  "asks",
  "ledger",
  "probe",
] as const satisfies ShapeOf<V2Follow>;
export const ASKS_SHAPE = [
  "fix",
  "rebase",
] as const satisfies ShapeOf<V2Follow["asks"]>;
export const FIX_ASK_SHAPE = [
  "ids",
  "findings",
  "taken",
] as const satisfies ShapeOf<V2FixAsk>;
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
] as const satisfies ShapeOf<V2RebaseAsk>;
export const LEDGER_SHAPE = [
  "handled",
  "fix_attempts",
  "review_only",
  "answered",
] as const satisfies ShapeOf<V2Ledger>;
export const PROBE_SHAPE = [
  "proc",
  "proc_started_at",
  "sig",
  "head",
  "ci",
  "checked_at",
  "errors",
  "note",
] as const satisfies ShapeOf<V2Probe>;

// 書き落としの検出 (値は使わない)。宣言が interface の全プロパティを覆っていなければ
// そのプロパティの型が never になり、`true` の代入がコンパイルエラーになる。
// **`as` ではなく代入で書くこと** — `true as never` は許されてしまい検査にならない。
const _SHAPES_ARE_COMPLETE: {
  item: AssertShapeCovers<V2Item, typeof ITEM_SHAPE>;
  run: AssertShapeCovers<V2Run, typeof RUN_SHAPE>;
  artifactNone: AssertShapeCovers<V2ArtifactNone, typeof ARTIFACT_SHAPES.none>;
  artifactOpen: AssertShapeCovers<V2ArtifactOpen, typeof ARTIFACT_SHAPES.open>;
  artifactMerged: AssertShapeCovers<
    V2ArtifactMerged,
    typeof ARTIFACT_SHAPES.merged
  >;
  artifactWithdrawn: AssertShapeCovers<
    V2ArtifactWithdrawn,
    typeof ARTIFACT_SHAPES.withdrawn
  >;
  follow: AssertShapeCovers<V2Follow, typeof FOLLOW_SHAPE>;
  asks: AssertShapeCovers<V2Follow["asks"], typeof ASKS_SHAPE>;
  fixAsk: AssertShapeCovers<V2FixAsk, typeof FIX_ASK_SHAPE>;
  rebaseAsk: AssertShapeCovers<V2RebaseAsk, typeof REBASE_ASK_SHAPE>;
  ledger: AssertShapeCovers<V2Ledger, typeof LEDGER_SHAPE>;
  probe: AssertShapeCovers<V2Probe, typeof PROBE_SHAPE>;
} = {
  item: true,
  run: true,
  artifactNone: true,
  artifactOpen: true,
  artifactMerged: true,
  artifactWithdrawn: true,
  follow: true,
  asks: true,
  fixAsk: true,
  rebaseAsk: true,
  ledger: true,
  probe: true,
};
