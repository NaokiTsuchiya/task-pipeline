// task-pipeline/scripts/state-transitions-v2.ts
//
// 状態モデル v2 (task-pipeline/docs/state-model-v2-2026-08.md 2節「遷移」) の
// **層 10 — apply 純関数群**と、このモジュール群の**公開面**。
//
// 層の構成 (依存は上から下への一方向。全体の一覧は
// state-transitions-v2-types.ts の冒頭):
//
//   層 0〜2  state-transitions-v2-types.ts … 基盤・データ型・形状宣言
//   層 3〜7  state-transitions-v2-nodes.ts … 語彙とノード宣言・導出ビュー・引き当て・
//                                            座標導出・不変条件
//   層 8〜9  state-transitions-v2-spec.ts  … 遷移辺 (advance) と遷移仕様 (VERB_SPEC)
//   層 10    このファイル                  … apply 群 (唯一の書き換え口)
//
// **外部 (後続 issue の CLI 配線) が import してよいのはこのファイルだけである。**
// 下の再 export ブロックが公開 API であり、そこに出ていないもの (導出ビュー・
// 引き当て・内部ヘルパ) は内部実装として扱う。テストは層を名指しして内部モジュールを
// 直接 import する — どの層を検査しているかが import 文に出る。
//
// - 依存は ./state-model-v2.ts (#34 が置いた語彙・ノード・不変条件) と上記の層だけ。
//   v1 (state.ts / state-transitions.ts / state-schema.ts / state.schema.json) には
//   一切依存しない (#34 が宣言した方針の維持)。エラー型も v2 側で自己完結している。
// - Deno API を呼ばない純粋関数群。現在時刻は呼び出し元が引数で渡す。
// - **CLI への配線は行わない** (issue #35 の明示的な範囲外。後続の切り替え issue)。
// - `next` (設計5節) と帳簿系 state-level verb (init/get/validate/session-touch/
//   sessions-alive/history-append/candidates-*/promoted-*/relisted-*/stalled-set) は
//   範囲外。前者は後続 issue、後者は queue エントリの領域座標を持たず「領域ごとの
//   from/to を宣言する VERB_SPEC」の対象にならない (v1 でも VERB_SPEC の外)。
//
// #34 のレコード (makeFixAsk/makeRebaseAsk/makeProbe/makeFollow) は座標と不変条件の
// 問い合わせ口 (導出ビュー) であって item の表現ではないので、apply の内部状態には
// **使わない**。item は素データ (V2Item) として持ち、座標導出と不変条件検査の入口でだけ
// make* を通して導出ビューを組む (層 6〜7)。
//
// テスト: state-transitions-v2.test.ts (直接importで検査)。実行は
// tests/state-transitions-v2.test.sh 経由、または tests/run.sh の glob 自動検出。

import {
  FINALIZE_PHASE,
  type HumanAttentionReason,
  type PNodeKey,
  REBASE_FIX_DETOUR_PHASE,
} from "./state-model-v2.ts";
import {
  CliErrorV2,
  type CompletedEntry,
  type LedgerEntry,
  requirePrecondition,
  type V2Artifact,
  type V2ArtifactOpen,
  type V2ArtifactWithdrawn,
  type V2FixAsk,
  type V2Follow,
  type V2Item,
  type V2Probe,
  type V2RebaseAsk,
  type V2Run,
  type V2State,
  type WithdrawnBranchEntry,
} from "./state-transitions-v2-types.ts";
import {
  aNodeKeyOf,
  axisKeyOfRun,
  INITIAL_FULL_FIRST_PHASE,
  INITIAL_LIGHT_FIRST_PHASE,
  openArtifactOf,
  pNodeKeyOf,
} from "./state-transitions-v2-nodes.ts";
import {
  isAdvanceEdge,
  resolveArtifactAxis,
  VERB_SPEC,
  type VerbName,
  type VerbSpecV2,
} from "./state-transitions-v2-spec.ts";

// ---------------------------------------------------------------------------
// 公開 API (再 export) — 外部が使ってよいのはここに挙げたものだけ。
//
//   - データ型 (層 1): JSON の形。CLI が読み書きする対象そのもの。
//   - 基盤 (層 0): エラー型。exit code の決定に要る。
//   - 宣言 (層 2・9): 読む価値のある単一の真実 (形状宣言と VERB_SPEC)。
//   - 座標と不変条件 (層 6・7): 書き込み前検査と表示のための入口。
//
// 導出ビュー (A_OPEN_FOLLOW_NODES / *_KEYS)・引き当て (openNodeKey / openNodesWhere)・
// 内部ヘルパは**公開しない** — 宣言 (A_OPEN_FOLLOW / VERB_SPEC) から機械的に導かれる
// ものであり、外から組み立てる必要が無い。必要な検査は内部モジュールを直接見る
// テストが行う。
// ---------------------------------------------------------------------------

export {
  CliErrorV2,
  type CompletedEntry,
  type ExitCodeName,
  type LedgerEntry,
  type RelistedEntry,
  type V2Artifact,
  type V2ArtifactMerged,
  type V2ArtifactNone,
  type V2ArtifactOpen,
  type V2ArtifactWithdrawn,
  type V2FixAsk,
  type V2Follow,
  type V2Item,
  type V2Ledger,
  type V2Probe,
  type V2RebaseAsk,
  type V2Run,
  type V2State,
  type WithdrawnBranchEntry,
} from "./state-transitions-v2-types.ts";
export {
  ARTIFACT_SHAPES,
  ASKS_SHAPE,
  FIX_ASK_SHAPE,
  FOLLOW_SHAPE,
  ITEM_SHAPE,
  LEDGER_SHAPE,
  PROBE_SHAPE,
  REBASE_ASK_SHAPE,
  RUN_SHAPE,
} from "./state-transitions-v2-types.ts";
export {
  aNodeKeyOf,
  assertItemInvariantsV2,
  followOf,
  pNodeKeyOf,
  productKey,
  productKeyOf,
} from "./state-transitions-v2-nodes.ts";
export {
  ADVANCE_EDGES,
  type AdvanceEdge,
  advanceTargetsOf,
  type ArtifactAxisByPNode,
  type ArtifactAxisSpec,
  type ArtifactEffect,
  isAdvanceEdge,
  type ProgressEffect,
  resolveArtifactAxis,
  VERB_SPEC,
  type VerbName,
  type VerbSpecV2,
} from "./state-transitions-v2-spec.ts";

// ---------------------------------------------------------------------------
// 層 10 (apply 群) — 共通ヘルパ (このファイル内だけで使う)
// ---------------------------------------------------------------------------

function requireVerbAxes(item: V2Item, verb: VerbName): PNodeKey {
  const spec: VerbSpecV2 = VERB_SPEC[verb];
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
// 層 10 (apply 群) — 進行系 (設計2.1)
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
// 層 10 (apply 群) — 完了系 (設計2.2)
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
// 層 10 (apply 群) — 要求系 (設計2.1「要求系」。前提 P==resting)
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
  verb: VerbName,
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
// 層 10 (apply 群) — 仕上げ開始系 (要求の消費。設計2.1・2.4)
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
// 層 10 (apply 群) — 追従系 (設計2.1「追従系」。前提 P==resting、follow != null)
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
// 層 10 (apply 群) — 実行帳簿 (対象が run の中のフィールドになるだけで起動形は v1 と同じ。設計2.6)
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
