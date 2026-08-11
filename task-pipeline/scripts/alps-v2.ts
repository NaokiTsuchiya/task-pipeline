// task-pipeline/scripts/alps-v2.ts
//
// 状態モデル v2 の宣言 (P_NODE_KEYS / A_NODE_KEYS / VERB_SPEC / ADVANCE_EDGES) から
// ALPS (https://alps.io/) プロファイル2本 (領域P主図・領域A従図) を生成する。
// alps-asd/app-state-diagram (asd) がそのまま読める JSON 形式で書き出す。
// 依存は Deno 標準 API のみ (npm/jsr の参照は無い)。
//
// 生成物: task-pipeline/docs/alps/state-v2-progress.alps.json (領域P)
//         task-pipeline/docs/alps/state-v2-artifact.alps.json (領域A)
// 再生成: deno run --allow-write task-pipeline/scripts/alps-v2.ts
// 回帰テスト: alps-v2.test.ts (この2ファイルを再生成し、コミット済みの内容と
// バイト列一致することを検査する)。
//
// 辺を引く条件・除外理由の一覧は plan.md §2 参照。

import { P_NODE_KEYS, RUN_AXES } from "./state-model-v2.ts";
import {
  A_NODE_KEYS,
  A_NODE_MERGED,
  A_NODE_WITHDRAWN_ASKED,
  A_NODE_WITHDRAWN_UNASKED,
  requireRunNodeKey,
} from "./state-transitions-v2-nodes.ts";
import {
  ADVANCE_EDGES,
  VERB_SPEC,
  type VerbName,
} from "./state-transitions-v2.ts";

// ALPS プロファイルの最小型 (alps-asd/app-state-diagram の JSON 形式。
// tests/fake/main.json 等の実例で確認した形をそのまま表す — research.md §4)

interface AlpsDescriptorRef {
  readonly href: string;
}

interface AlpsStateDescriptor {
  readonly id: string;
  readonly type: "semantic";
  readonly title: string;
  readonly descriptor?: readonly AlpsDescriptorRef[];
}

interface AlpsTransitionDescriptor {
  readonly id: string;
  readonly type: "unsafe";
  readonly rt: string;
  readonly title: string;
  readonly doc: string;
}

type AlpsDescriptor = AlpsStateDescriptor | AlpsTransitionDescriptor;

export interface AlpsProfile {
  readonly alps: {
    readonly title: string;
    readonly doc: string;
    readonly descriptor: readonly AlpsDescriptor[];
  };
}

export const PROGRESS_PROFILE_PATH =
  "task-pipeline/docs/alps/state-v2-progress.alps.json";
export const ARTIFACT_PROFILE_PATH =
  "task-pipeline/docs/alps/state-v2-artifact.alps.json";

// id のサニタイズ — ノードキー ("running(initial,full,research)" 等) は
// ALPS/NCName が許す文字集合 ([A-Za-z0-9_] + 先頭は非数字) に収まらないので、
// 英数字とアンダースコア以外を単一の "_" に畳んで安全な id に変換する。
// P_NODE_KEYS ∪ A_NODE_KEYS の42件で単射であることは alps-v2.test.ts が検査する。

export function sanitizeId(rawKey: string): string {
  const replaced = rawKey.replace(/[^A-Za-z0-9_]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
  return /^[0-9]/.test(replaced) ? `n_${replaced}` : replaced;
}

// verb 由来の transition id は "t-" を前置する — verb 名 (例: "merged") が
// ノードキーのリテラル (領域Aの "merged" ノード) と衝突することがあるため、
// 名前空間を分けて id の一意性を保証する。
function transitionId(verb: string, suffix?: number): string {
  return suffix === undefined ? `t-${verb}` : `t-${verb}-${suffix}`;
}

interface Edge<Node extends string> {
  readonly from: Node;
  readonly to: Node;
}

function buildStates<Node extends string>(
  nodeKeys: readonly Node[],
): AlpsStateDescriptor[] {
  return nodeKeys.map((key) => ({
    id: sanitizeId(key),
    type: "semantic",
    title: key,
  }));
}

// 状態群 (`buildStates` が作った配列を直接書き換える) に、辺の from 側から
// transition descriptor への href を積み、transition descriptor 自体の配列を返す。
function attachTransitions<Node extends string>(
  states: AlpsStateDescriptor[],
  stateIndexByKey: ReadonlyMap<Node, number>,
  transitions: readonly AlpsTransitionDescriptor[],
  edgesByTransitionId: ReadonlyMap<string, readonly Edge<Node>[]>,
): void {
  const hrefSeenByStateIndex = new Map<number, Set<string>>();
  for (const transition of transitions) {
    const edges = edgesByTransitionId.get(transition.id) ?? [];
    for (const edge of edges) {
      const stateIndex = stateIndexByKey.get(edge.from);
      if (stateIndex === undefined) {
        throw new Error(`BUG: unknown from-node "${edge.from}"`);
      }
      const seen = hrefSeenByStateIndex.get(stateIndex) ??
        new Set<string>();
      hrefSeenByStateIndex.set(stateIndex, seen);
      if (seen.has(transition.id)) continue;
      seen.add(transition.id);
      const state = states[stateIndex];
      const nextDescriptor = [
        ...(state.descriptor ?? []),
        { href: `#${transition.id}` },
      ];
      states[stateIndex] = { ...state, descriptor: nextDescriptor };
    }
  }
}

// 領域 P 主図

type PEdge = Edge<string>;

// advance の12辺を PNodeKey ペアへ展開する (ADVANCE_EDGES は axisKey×Phase なので、
// RUN_AXES で (kind,gate) に引き当ててから requireRunNodeKey で PNodeKey に直す)。
function advanceEdgesAsPNodeEdges(): PEdge[] {
  return ADVANCE_EDGES.map((edge) => {
    const axis = RUN_AXES.find((a) => a.axisKey() === edge.axisKey);
    if (axis === undefined) {
      throw new Error(`BUG: unknown advance axisKey "${edge.axisKey}"`);
    }
    return {
      from: requireRunNodeKey(axis.kind, axis.gate, edge.from),
      to: requireRunNodeKey(axis.kind, axis.gate, edge.to),
    };
  });
}

function buildProgressTransitions(): {
  transitions: AlpsTransitionDescriptor[];
  edgesByTransitionId: Map<string, PEdge[]>;
} {
  const pNodeSet = new Set<string>(P_NODE_KEYS as readonly string[]);
  const transitions: AlpsTransitionDescriptor[] = [];
  const edgesByTransitionId = new Map<string, PEdge[]>();

  for (
    const [verb, spec] of Object.entries(VERB_SPEC) as [
      VerbName,
      (typeof VERB_SPEC)[VerbName],
    ][]
  ) {
    const to = spec.p.to as string;
    if (verb === "advance") {
      const edges = advanceEdgesAsPNodeEdges();
      edges.forEach((edge, i) => {
        const id = transitionId(verb, i + 1);
        transitions.push({
          id,
          type: "unsafe",
          rt: `#${sanitizeId(edge.to)}`,
          title: verb,
          doc: `${edge.from} → ${edge.to}`,
        });
        edgesByTransitionId.set(id, [edge]);
      });
      continue;
    }
    if (!pNodeSet.has(to)) continue; // unchanged / removed / dynamic (非advance) は除外
    const edges: PEdge[] = spec.p.from.map((from) => ({ from, to }));
    if (edges.length === 0) continue; // approve (from空)
    const id = transitionId(verb);
    transitions.push({
      id,
      type: "unsafe",
      rt: `#${sanitizeId(to)}`,
      title: verb,
      doc: `${spec.p.from.join(", ")} → ${to}`,
    });
    edgesByTransitionId.set(id, edges);
  }

  return { transitions, edgesByTransitionId };
}

export function buildProgressAlpsProfile(): AlpsProfile {
  const states = buildStates(P_NODE_KEYS);
  const stateIndexByKey = new Map(
    P_NODE_KEYS.map((key, i) => [key, i] as const),
  );
  const { transitions, edgesByTransitionId } = buildProgressTransitions();
  attachTransitions(states, stateIndexByKey, transitions, edgesByTransitionId);
  return {
    alps: {
      title: "task-pipeline 状態モデル v2 — 領域 P (進行) 主図",
      doc:
        "生成元: P_NODE_KEYS (state-model-v2.ts) / VERB_SPEC.p, ADVANCE_EDGES " +
        "(state-transitions-v2-spec.ts)。手動編集禁止 — " +
        "`deno run --allow-write task-pipeline/scripts/alps-v2.ts` で再生成する " +
        "(task-pipeline/docs/alps-profiles-2026-08.md 参照)。",
      descriptor: [...states, ...transitions],
    },
  };
}

// 領域 A 従図

type AEdge = Edge<string>;

const A_LITERAL_TARGETS = new Set<string>([
  A_NODE_MERGED,
  A_NODE_WITHDRAWN_UNASKED,
  A_NODE_WITHDRAWN_ASKED,
]);

function buildArtifactTransitions(): {
  transitions: AlpsTransitionDescriptor[];
  edgesByTransitionId: Map<string, AEdge[]>;
} {
  const transitions: AlpsTransitionDescriptor[] = [];
  const edgesByTransitionId = new Map<string, AEdge[]>();

  for (
    const [verb, spec] of Object.entries(VERB_SPEC) as [
      VerbName,
      (typeof VERB_SPEC)[VerbName],
    ][]
  ) {
    const axisSpecs = "byPNode" in spec.a
      ? Object.values(spec.a.byPNode)
      : [spec.a];

    const edgeSet = new Map<string, AEdge>();
    let literalTo: string | undefined;
    for (const axisSpec of axisSpecs) {
      const to = axisSpec.to as string;
      if (!A_LITERAL_TARGETS.has(to)) continue; // 除外理由は plan.md §2 参照
      if (literalTo !== undefined && literalTo !== to) {
        throw new Error(
          `BUG: verb "${verb}" resolves to more than one literal A target ` +
            `(${literalTo} vs ${to})`,
        );
      }
      literalTo = to;
      for (const from of axisSpec.from) {
        edgeSet.set(`${from}->${to}`, { from, to });
      }
    }
    if (literalTo === undefined) continue;
    const edges = [...edgeSet.values()];
    if (edges.length === 0) continue;
    const id = transitionId(verb);
    transitions.push({
      id,
      type: "unsafe",
      rt: `#${sanitizeId(literalTo)}`,
      title: verb,
      doc: `${edges.length} 件の from → ${literalTo}`,
    });
    edgesByTransitionId.set(id, edges);
  }

  return { transitions, edgesByTransitionId };
}

export function buildArtifactAlpsProfile(): AlpsProfile {
  const states = buildStates(A_NODE_KEYS);
  const stateIndexByKey = new Map(
    A_NODE_KEYS.map((key, i) => [key, i] as const),
  );
  const { transitions, edgesByTransitionId } = buildArtifactTransitions();
  attachTransitions(states, stateIndexByKey, transitions, edgesByTransitionId);
  return {
    alps: {
      title: "task-pipeline 状態モデル v2 — 領域 A (成果物) 従図",
      doc:
        "生成元: A_NODE_KEYS (state-transitions-v2-nodes.ts) / VERB_SPEC.a " +
        "(state-transitions-v2-spec.ts)。手動編集禁止 — " +
        "`deno run --allow-write task-pipeline/scripts/alps-v2.ts` で再生成する。" +
        " fix-ask/rebase-ask/attention サブ軸内の遷移 (fix-request 等) は着地ノードが " +
        "VERB_SPEC からは一意に定まらないため辺を引いていない " +
        "(task-pipeline/docs/alps-profiles-2026-08.md 参照)。",
      descriptor: [...states, ...transitions],
    },
  };
}

// シリアライズ / CLI エントリ

export function serializeAlpsProfile(profile: AlpsProfile): string {
  return JSON.stringify(profile, null, 2) + "\n";
}

if (import.meta.main) {
  const repoRoot = new URL("../../", import.meta.url);
  const progressUrl = new URL(PROGRESS_PROFILE_PATH, repoRoot);
  const artifactUrl = new URL(ARTIFACT_PROFILE_PATH, repoRoot);
  await Deno.writeTextFile(
    progressUrl,
    serializeAlpsProfile(buildProgressAlpsProfile()),
  );
  await Deno.writeTextFile(
    artifactUrl,
    serializeAlpsProfile(buildArtifactAlpsProfile()),
  );
  console.log(`wrote ${progressUrl}`);
  console.log(`wrote ${artifactUrl}`);
}
