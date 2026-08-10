// task-pipeline/scripts/state-transitions-v2-spec.ts
//
// 状態モデル v2 の **層 8〜9** — 遷移辺 (advance) と遷移仕様 (VERB_SPEC)。
// 層の一覧と依存の向きは state-transitions-v2-types.ts の冒頭を参照
// (このファイルは層 0〜7 にだけ依存する)。
//
// VERB_SPEC は「どのノードから発火し、どのノードへ着地するか」の宣言であり、
// 実際の書き換え (層 10 の apply 群) はこの宣言に従う。読む価値のある宣言なので
// 層 10 から再 export して公開する。

import {
  type AxisKey,
  FINALIZE_PHASE,
  type Phase,
  type PNodeKey,
  REBASE_FIX_DETOUR_PHASE,
  RUN_AXES,
} from "./state-model-v2.ts";
import type { V2Run } from "./state-transitions-v2-types.ts";
import {
  A_NODE_KEYS,
  A_NODE_KEYS_EXCEPT_MERGED,
  A_NODE_MERGED,
  A_NODE_WITHDRAWN_ASKED,
  A_NODE_WITHDRAWN_UNASKED,
  A_OPEN_FOLLOW_KEYS,
  A_OPEN_KEYS,
  A_WITHDRAWN_KEYS,
  type ANodeKey,
  axisKeyOfRun,
  INITIAL_FULL_FIRST_PHASE,
  INITIAL_LIGHT_FIRST_PHASE,
  openNodesWhere,
  P_CYCLE_REBASE_KEYS,
  P_DETOUR_KEYS,
  P_FINALIZE_KEYS,
  P_RUNNING_KEYS,
  P_VERIFIED_KEYS,
  requireRunNodeKey,
} from "./state-transitions-v2-nodes.ts";

// ---------------------------------------------------------------------------
// 層 8 (遷移辺) — `advance` の辺。設計1.2 のフェーズ列 + 2.4 の迂回復帰辺
//
// axis.phases() は末尾に迂回フェーズ rebase_fix を含む配列を返すので、その素の隣接ペアを
// 採ると `finalize → rebase_fix` という誤った辺が生える (その辺は rebase-start 入口 b の
// もの)。主列を切り出したうえで、迂回の復帰辺 rebase_fix → finalize を足す。
// ---------------------------------------------------------------------------

export interface AdvanceEdge {
  readonly axisKey: AxisKey;
  readonly from: Phase;
  readonly to: Phase;
}

function mainSequenceOf(axisKey: AxisKey): readonly Phase[] {
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

// 辺の**宣言**は上の AdvanceEdge (AxisKey × Phase) で型が付いているが、この問い合わせは
// item から来る素の値 (V2Run.phase は string) を受ける口なので string で受ける。
// 宣言は列挙子・境界の問い合わせは string、という切り分け。
export function isAdvanceEdge(
  axisKey: string,
  from: string,
  to: string,
): boolean {
  return ADVANCE_EDGES.some((e) =>
    e.axisKey === axisKey && e.from === from && e.to === to
  );
}

export function advanceTargetsOf(run: V2Run): readonly Phase[] {
  const axisKey = axisKeyOfRun(run);
  return ADVANCE_EDGES.filter((e) =>
    e.axisKey === axisKey && e.from === run.phase
  ).map((e) => e.to);
}

// ---------------------------------------------------------------------------
// 層 9 (遷移仕様) — VERB_SPEC v2
// ---------------------------------------------------------------------------

// 領域 P の着地は「ノードキーか、3 つの標語か」の union。#34 の RunNode.key() が
// リテラル union (PNodeKey) を返すようになったので、ノードキーの綴り違いも標語の
// 綴り違いも、ここでコンパイル時に落ちる (以前は string に潰れ、行列テスト
// T-V2T-MX-1 が実行時に見るしかなかった)。
export type ProgressEffect = PNodeKey | "unchanged" | "dynamic" | "removed";

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
  // 着地ノードそのものを指す標語は、ノードキーの定数から型を取る (綴りの二重管理を防ぐ)
  | typeof A_NODE_WITHDRAWN_UNASKED
  | typeof A_NODE_WITHDRAWN_ASKED
  | "dynamic";

export interface ArtifactAxisSpec {
  // 宣言済みノードキーの部分集合しか書けない (綴り違いはコンパイル時に落ちる)。
  readonly from: readonly ANodeKey[];
  readonly to: ArtifactEffect;
}

// 入口 (P ノード) で A 側の前提が変わる verb (rebase-start) のノード別指定。素の
// Record を「from/to を持たないほう」として構造で見分けるのではなく、byPNode という
// タグで判別する (判別可能 union にしたので下の解決関数から as が消える)。
export interface ArtifactAxisByPNode {
  // 全 P ノードを並べる必要は無い (その verb の入口だけ) ので Partial。宣言済みノード
  // キー以外を書けない点は from と同じ。
  readonly byPNode: Readonly<Partial<Record<PNodeKey, ArtifactAxisSpec>>>;
}

export interface VerbSpecV2 {
  readonly p: {
    // 宣言済みノードキーの部分集合しか書けない (領域 A 側の from と揃えた)。
    readonly from: readonly PNodeKey[];
    readonly to: ProgressEffect;
  };
  readonly a: ArtifactAxisSpec | ArtifactAxisByPNode;
}

export function resolveArtifactAxis(
  spec: VerbSpecV2["a"],
  pNode: PNodeKey,
): ArtifactAxisSpec {
  if (!("byPNode" in spec)) return spec;
  const byNode = spec.byPNode[pNode];
  if (byNode === undefined) {
    throw new Error(`BUG: no artifact axis for node ${pNode}`);
  }
  return byNode;
}

const A_UNTOUCHED: ArtifactAxisSpec = {
  from: A_NODE_KEYS,
  to: "untouched",
};

// `satisfies` で制約だけを課し、キーのリテラル型 (= verb 名の集合) は推論に残す。
// これにより VerbName が宣言そのものから決まり、apply 側の verb 名の綴り違いが
// コンパイル時に落ちる (VERB_SPEC[verb] の undefined 分岐が不要になる)。
export const VERB_SPEC = {
  // 新規エントリの追加なので from ノードを持たない (v1 の approve と同じ扱い)。
  "approve": {
    p: { from: [], to: "queued" },
    a: { from: [], to: "untouched" },
  },
  "claim": {
    p: {
      from: ["queued"],
      to: requireRunNodeKey("initial", "full", INITIAL_FULL_FIRST_PHASE),
    },
    a: { from: A_NODE_KEYS, to: "cycle-reset" },
  },
  "set-gate": {
    p: {
      from: [requireRunNodeKey("initial", "full", INITIAL_FULL_FIRST_PHASE)],
      to: requireRunNodeKey("initial", "light", INITIAL_LIGHT_FIRST_PHASE),
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
  // gh-18: 「この tip では CI 再実行を既に行った」の記録専用。座標は変えない。
  "fix-rerun-mark": {
    p: { from: ["resting"], to: "unchanged" },
    a: { from: A_OPEN_FOLLOW_KEYS, to: "unchanged" },
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
    a: {
      byPNode: {
        "resting": {
          from: openNodesWhere({ attention: ["auto"], rebase: ["queued"] }),
          to: "rebase-taken",
        },
        // 迂回入口 (b): finalize の各ノードでは A に触れない。
        ...Object.fromEntries(
          P_FINALIZE_KEYS.map((k): [PNodeKey, ArtifactAxisSpec] => [
            k,
            A_UNTOUCHED,
          ]),
        ),
      },
    },
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
} satisfies Readonly<Record<string, VerbSpecV2>>;

// 宣言済み verb 名の集合。apply 群はこの型で verb を受ける。
export type VerbName = keyof typeof VERB_SPEC;
