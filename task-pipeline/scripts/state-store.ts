// task-pipeline/scripts/state-store.ts
//
// state CLI の **層 2 — lock 越しの適用 glue**。「lock を取る → 読み直す → スキーマ検証 →
// 純関数を適用する → 不変条件を検査する → 原子的に書き戻す」の 1 本道をここに閉じ込める。
//
// **前提チェックと状態の書き換えそのものは持たない** — それは state-transitions-v2.ts /
// state-ledger-v2.ts の純関数の仕事で、ここはその呼び出しを lock と検証で挟むだけである
// (前提違反は必ず CliErrorV2 で表され、書き込みは一切行われずに re-throw される)。
// 層の一覧は state-io.ts の冒頭。

import { checkStateV2 } from "./state-schema-v2.ts";
import {
  finalizeStateV2,
  isRecord,
  normalizeStateV2,
} from "./state-ledger-v2.ts";
import {
  assertItemInvariantsV2,
  CliErrorV2,
  requireQueueItem,
  type V2Item,
  type V2State,
} from "./state-transitions-v2.ts";
import {
  acquireLock,
  atomicWriteText,
  joinPath,
  nowIso,
  readState,
  releaseLock,
} from "./state-io.ts";

// ---------------------------------------------------------------------------
// 書き込み系 verb が共有する適用ロジック。
// lock は呼び出し側 (withStateLock、または init の手書きの try/finally) が既に持っている
// 前提で、読み直し・スキーマ検証・fn 適用・(必要なら) 原子的書き込みだけを行う。
//
// preCheck: 読み込んだ現在値に checkStateV2 を掛けるか。**init の移行経路だけが false** —
// 移行の入力は v1 の state.json であり、定義から v2 スキーマを満たさないためである
// (移行結果に対する事後検証は下の postCheck が行うので、検査が抜けるわけではない)。
// ---------------------------------------------------------------------------

export interface LockedApplyResult {
  wrote: boolean;
  wasMissing: boolean;
  value: Record<string, unknown>;
}

// fn は同期・非同期のどちらでもよい (history-append が退避ファイルへの書き込みを
// lock 保持中に行うために非同期を必要とする。gh-58)。同期の fn は
// `X | Promise<X>` の合併型を構造的に満たすので、既存の同期呼び出し元は無変更で通る。
export async function applyStateChange(
  stateDir: string,
  fn: (
    current: Record<string, unknown> | undefined,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>,
  preCheck = true,
): Promise<LockedApplyResult> {
  let current: Record<string, unknown> | undefined;
  let wasMissing = false;
  try {
    const parsed = await readState(stateDir);
    if (preCheck) {
      const check = checkStateV2(parsed);
      if (!check.ok) {
        throw new CliErrorV2("schema", `${check.path}: ${check.message}`);
      }
    } else if (!isRecord(parsed)) {
      throw new CliErrorV2("schema", "state.json must be a JSON object");
    }
    current = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof CliErrorV2 && e.code === "missing") {
      current = undefined;
      wasMissing = true;
    } else {
      throw e;
    }
  }

  const next = await fn(current);
  if (next === undefined) {
    return {
      wrote: false,
      wasMissing,
      value: current as Record<string, unknown>,
    };
  }
  // 書き込み前に next 自体もスキーマ検証する。実装ミスでスキーマ違反な next を書いて
  // しまう経路を塞ぐ安全網 (壊れた state.json を書く前に検出して schema エラーにする)。
  const postCheck = checkStateV2(next);
  if (!postCheck.ok) {
    throw new CliErrorV2(
      "schema",
      `refusing to write invalid state: ${postCheck.path}: ${postCheck.message}`,
    );
  }
  await atomicWriteText(
    joinPath(stateDir, "state.json"),
    JSON.stringify(next, null, 2) + "\n",
    true,
  );
  return { wrote: true, wasMissing, value: next };
}

async function withStateLock(
  stateDir: string,
  opts: { retryMs: number; maxRetries: number },
  fn: (
    current: Record<string, unknown> | undefined,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>,
): Promise<LockedApplyResult> {
  await acquireLock(stateDir, opts);
  try {
    return await applyStateChange(stateDir, fn);
  } finally {
    await releaseLock(stateDir);
  }
}

// ---------------------------------------------------------------------------
// queue エントリを対象にする verb (withQueueLock) と、それ以外のトップレベル配列・
// 新規エントリ追加を対象にする verb (withExistingStateLock) が共有するロック・書き込みの
// glue。前提チェックと状態オブジェクトの書き換え本体は state-transitions-v2.ts /
// state-ledger-v2.ts の対応関数に委譲する (前提違反は必ず CliErrorV2 で表され、
// withStateLock/applyStateChange は書き込みを一切行わずに re-throw する)。
// ---------------------------------------------------------------------------

export async function withQueueLock(
  stateDir: string,
  id: string,
  opts: { retryMs: number; maxRetries: number },
  mutate: (item: V2Item, index: number, state: V2State) => V2State,
): Promise<V2State> {
  const result = await withStateLock(stateDir, opts, (current) => {
    if (current === undefined) {
      throw new CliErrorV2("missing", `state.json not found in ${stateDir}`);
    }
    const state = normalizeStateV2(current);
    const { index, item } = requireQueueItem(state, id);
    const nextState = mutate(item, index, state);
    // 書き込み前の不変条件検査: 対象エントリが (残っていれば) 到達可能なノードで
    // あることを保証する。verb 実装のバグが壊れた組を書く前に schema エラーで止める
    // (applyStateChange の事後スキーマ検証と同じ安全網の、状態機械版)。
    const nextItem = nextState.queue.find((it) => it.id === id);
    if (nextItem !== undefined) assertItemInvariantsV2(nextItem);
    return finalizeStateV2(nextState, nowIso()) as unknown as Record<
      string,
      unknown
    >;
  });
  return result.value as unknown as V2State;
}

// withQueueLock と対になる、トップレベル (queue 以外) の配列・新規 queue エントリ追加を
// 対象にする verb 用のラッパ (approve/history-append/candidates-*/promoted-*/relisted-*/
// stalled-set が使う)。「state.json が無ければ missing」の共通チェックと finalizeStateV2 の
// 適用をここに集約する。
// mutate は同期・非同期のどちらでもよい (history-append が上限超過分を
// history-archive.ndjson へ退避するために非同期を必要とする。gh-58)。
export async function withExistingStateLock(
  stateDir: string,
  opts: { retryMs: number; maxRetries: number },
  mutate: (current: V2State) => V2State | Promise<V2State>,
): Promise<V2State> {
  const result = await withStateLock(stateDir, opts, async (current) => {
    if (current === undefined) {
      throw new CliErrorV2("missing", `state.json not found in ${stateDir}`);
    }
    const next = await mutate(normalizeStateV2(current));
    return finalizeStateV2(next, nowIso()) as unknown as Record<
      string,
      unknown
    >;
  });
  return result.value as unknown as V2State;
}
