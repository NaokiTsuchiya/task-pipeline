// task-pipeline/scripts/state-transitions-v2-nodes.ts
//
// 状態モデル v2 の **層 3〜7** — 語彙とノード宣言 / 導出ビュー / 引き当て /
// item から座標への写像 / 不変条件。層の一覧と依存の向きは
// state-transitions-v2-types.ts の冒頭を参照 (このファイルは層 0〜2 にだけ依存する)。
//
// 公開面ではない (層 10 の state-transitions-v2.ts が必要な分だけ再 export する)。

import {
  ATTENTION_AXIS_VALUES,
  type AttentionAxis,
  FINALIZE_PHASE,
  FIX_ASK_AXIS_VALUES,
  type FixAskAxis,
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
  REBASE_ASK_AXIS_VALUES,
  REBASE_FIX_DETOUR_PHASE,
  type RebaseAskAxis,
  RUN_AXES,
} from "./state-model-v2.ts";
import {
  CliErrorV2,
  type V2ArtifactOpen,
  type V2FixAsk,
  type V2Follow,
  type V2Item,
  type V2RebaseAsk,
  type V2Run,
} from "./state-transitions-v2-types.ts";

// ---------------------------------------------------------------------------
// 層 3 (語彙とノード宣言) + 層 4 (導出ビュー) + 層 5 (引き当て) — 領域 A。
// 設計1.5「領域Aの詳細ノード」の 23 ノード。
// #34 は領域Pの19ノードだけを列挙しているので、A 側はここで新設する。
//
// キー文字列は実行時に組み立てない。23 件をリテラルとして書き下したこの節が唯一の定義で、
// 座標 (attention × fix ask × rebase ask) からの引き当ては、下の Record の添字アクセス。
//
// follow 付き open の 18 件は**座標でネストした Record** として宣言する。値の型を
// `` `open(${A},${F},${R})` `` の template literal type にしてあるので、
//
//   - キー文字列が座標と食い違う行 (綴り違い・座標の取り違え) は **型エラー**
//   - 18 件のどれかが欠けても mapped type が全キーを要求するので **型エラー**
//
// になる。「このキー文字列は 3 軸の座標から決まる」という関係が型に載っているので、
// テストで守る必要が無い (旧 T-V2T-ALIGN-3b の検査項目はこれに置き換わった)。
// ---------------------------------------------------------------------------

// attention の2値サブ軸は #34 の語彙 (follow.subAxes() が返す型と同一のものを使う —
// ここで別に宣言すると A_OPEN_FOLLOW の添字と導出ビューの戻り値がずれうる)。
export { ATTENTION_AXIS_VALUES };
export type { AttentionAxis };

export const A_NODE_NONE = "none" as const;
export const A_NODE_MERGED = "merged" as const;
export const A_NODE_OPEN_NO_FOLLOW = "open(follow=null)" as const;
export const A_NODE_WITHDRAWN_UNASKED = "withdrawn(asked=false)" as const;
export const A_NODE_WITHDRAWN_ASKED = "withdrawn(asked=true)" as const;

export const A_OPEN_FOLLOW: {
  readonly [A in AttentionAxis]: {
    readonly [F in FixAskAxis]: {
      readonly [R in RebaseAskAxis]: `open(${A},${F},${R})`;
    };
  };
} = {
  auto: {
    null: {
      quiet: "open(auto,null,quiet)",
      queued: "open(auto,null,queued)",
      taken: "open(auto,null,taken)",
    },
    pending: {
      quiet: "open(auto,pending,quiet)",
      queued: "open(auto,pending,queued)",
      taken: "open(auto,pending,taken)",
    },
    taken: {
      quiet: "open(auto,taken,quiet)",
      queued: "open(auto,taken,queued)",
      taken: "open(auto,taken,taken)",
    },
  },
  human: {
    null: {
      quiet: "open(human,null,quiet)",
      queued: "open(human,null,queued)",
      taken: "open(human,null,taken)",
    },
    pending: {
      quiet: "open(human,pending,quiet)",
      queued: "open(human,pending,queued)",
      taken: "open(human,pending,taken)",
    },
    taken: {
      quiet: "open(human,taken,quiet)",
      queued: "open(human,taken,queued)",
      taken: "open(human,taken,taken)",
    },
  },
};

// 領域 A のノードキーのリテラル union。VERB_SPEC の from やノード集合をこの型で受ける
// ことで、綴り違いのキーがコンパイル時に落ちる。
export type AOpenFollowKey =
  (typeof A_OPEN_FOLLOW)[AttentionAxis][FixAskAxis][RebaseAskAxis];
export type AWithdrawnKey =
  | typeof A_NODE_WITHDRAWN_UNASKED
  | typeof A_NODE_WITHDRAWN_ASKED;
export type ANodeKey =
  | typeof A_NODE_NONE
  | typeof A_NODE_MERGED
  | typeof A_NODE_OPEN_NO_FOLLOW
  | AWithdrawnKey
  | AOpenFollowKey;

// 座標付きの平坦化ビュー (Record の値をそのまま集めたもので、文字列は組み立てない)。
// 外から手書きの mis-paired なノードを作れないよう、型は export しない
// (構築経路は下の A_OPEN_FOLLOW_NODES 1 つに閉じている)。
interface AOpenFollowNode {
  readonly attention: AttentionAxis;
  readonly fix: FixAskAxis;
  readonly rebase: RebaseAskAxis;
  readonly key: AOpenFollowKey;
}

export const A_OPEN_FOLLOW_NODES: readonly AOpenFollowNode[] =
  ATTENTION_AXIS_VALUES.flatMap((attention) =>
    FIX_ASK_AXIS_VALUES.flatMap((fix) =>
      REBASE_ASK_AXIS_VALUES.map((rebase) => ({
        attention,
        fix,
        rebase,
        key: A_OPEN_FOLLOW[attention][fix][rebase],
      }))
    )
  );

// follow を持つ open の 18 ノード / follow の有無を問わない open の 19 ノード。
export const A_OPEN_FOLLOW_KEYS: readonly AOpenFollowKey[] = A_OPEN_FOLLOW_NODES
  .map((n) => n.key);
export const A_OPEN_KEYS: readonly ANodeKey[] = [
  A_NODE_OPEN_NO_FOLLOW,
  ...A_OPEN_FOLLOW_KEYS,
];
export const A_WITHDRAWN_KEYS: readonly AWithdrawnKey[] = [
  A_NODE_WITHDRAWN_UNASKED,
  A_NODE_WITHDRAWN_ASKED,
];

export const A_NODE_KEYS: readonly ANodeKey[] = [
  A_NODE_NONE,
  A_NODE_MERGED,
  ...A_WITHDRAWN_KEYS,
  ...A_OPEN_KEYS,
];

// merged を除いた 22 ノード (restore の from。merged は retire で queue を離脱する終端
// なので戻れない — 設計2.5)。キー文字列を篩に掛けず、部分集合を組み替えて宣言する。
// A_NODE_KEYS との整合 (merged だけの差) は T-V2T-ALIGN-3 が固定する。
export const A_NODE_KEYS_EXCEPT_MERGED: readonly ANodeKey[] = [
  A_NODE_NONE,
  ...A_WITHDRAWN_KEYS,
  ...A_OPEN_KEYS,
];

export function withdrawnNodeKey(asked: boolean): AWithdrawnKey {
  return asked ? A_NODE_WITHDRAWN_ASKED : A_NODE_WITHDRAWN_UNASKED;
}

// 座標 → キー。Record が全域なので「表に無い座標」は型として存在せず、例外も要らない。
export function openNodeKey(
  attention: AttentionAxis,
  fixAsk: FixAskAxis,
  rebaseAsk: RebaseAskAxis,
): AOpenFollowKey {
  return A_OPEN_FOLLOW[attention][fixAsk][rebaseAsk];
}

// キー → サブ軸座標 (キー文字列を解析せず、平坦化ビューを引く)。
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
): readonly AOpenFollowKey[] {
  return A_OPEN_FOLLOW_NODES.filter((n) =>
    (filter.attention ?? ATTENTION_AXIS_VALUES).includes(n.attention) &&
    (filter.fix ?? FIX_ASK_AXIS_VALUES).includes(n.fix) &&
    (filter.rebase ?? REBASE_ASK_AXIS_VALUES).includes(n.rebase)
  ).map((n) => n.key);
}

// ---------------------------------------------------------------------------
// 層 4 (導出ビュー) — 領域 P のノード集合 (#34 の listRunNodes からの導出)
// ---------------------------------------------------------------------------

const RUN_NODES = listRunNodes();

// (kind, gate, phase) → ノードキー。#34 の makeRunNode と同じ綴りを保証するために
// 自前で文字列を組まず、listRunNodes() の key() を引く。
export const RUN_NODE_KEY_BY_COORD: ReadonlyMap<string, string> = new Map(
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

export const INITIAL_FULL_FIRST_PHASE = INITIAL_GATE_PHASE_SEQUENCES.full[0];
export const INITIAL_LIGHT_FIRST_PHASE = INITIAL_GATE_PHASE_SEQUENCES.light[0];

const AXIS_KEY_BY_COORD: ReadonlyMap<string, string> = new Map(
  RUN_AXES.map((a) => [`${a.kind}|${a.gate ?? "-"}`, a.axisKey()]),
);

export function axisKeyOfRun(run: V2Run): string {
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
// 層 6 (item → 座標) — item から領域 P / A のノードキーを導く
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

export function aNodeKeyOf(item: V2Item): ANodeKey | null {
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
// 層 7 (不変条件) — 設計1.5 の不変条件の item 全体への適用
//
// #34 の述語関数をそのまま使う。1 か所だけ適用範囲を狭めている (下記 taken の scope) —
// 理由はその関数のコメントに書く。
// ---------------------------------------------------------------------------

export function openArtifactOf(item: V2Item): V2ArtifactOpen | null {
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
