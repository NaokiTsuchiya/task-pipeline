// task-pipeline/scripts/state-ledger-v2.ts
//
// 状態モデル v2 の **帳簿系** — queue エントリの領域座標 (領域 P × 領域 A) を持たない
// verb の純関数群。state-transitions-v2.ts の apply 群 (VERB_SPEC を持つ 32 verb) と
// 対になる、もう一方の書き換え口である。
//
// ここに居るのは「どのノードから発火するか」を宣言できない verb だけ:
//
//   init / get / validate / next / session-touch / sessions-alive /
//   history-append / candidates-set / candidates-drop / promoted-add /
//   promoted-drop / relisted-add / relisted-drop / stalled-set        … 14 verb
//
// `next` (設計5節) もここに属する — 何も書かない読み取り専用 verb であり、from/to を
// 宣言できないためである。導出本体は state-next.ts (Deno API を呼ばない純関数)。
//
// 対象がトップレベルの配列 (candidates / promoted / relisted) やファイル
// (<state dir>/sessions/*) であり、queue エントリの座標を持たないため、
// state-transitions-v2-spec.ts の VERB_SPEC には載らない (v1 でも同じ扱いだった)。
// **ディスパッチ集合 = VERB_SPEC のキー ∪ LEDGER_VERBS** であり、この 2 つで
// CLI の全 verb を覆う (state.test.ts の分類ネット T-D6 がそれを検査する)。
//
// - Deno API を呼ばない純粋関数群。現在時刻は呼び出し元が引数で渡す。
//   session-touch / sessions-alive のファイル列挙・stat・utime は state.ts に残り、
//   ここにあるのは「しきい値との厳密不等号比較」だけ (in-process にテストできる形)。
// - エラーは CliErrorV2 (state-transitions-v2-types.ts) を使う。
// - init の移行は migrateV1toV2 (state-migrate-v2.ts) に委譲する。ここが持つのは
//   「いつ移行を掛けるか」の判定だけである。
//
// テスト: state-ledger-v2.test.ts (直接importで検査)。実行は deno task test
// (リポジトリルートの deno.json が *.test.ts を自動検出する)。

import { STALLED_VALUES } from "./state-model-v2.ts";
import {
  CliErrorV2,
  type RelistedEntry,
  requirePrecondition,
  type V2State,
} from "./state-transitions-v2-types.ts";
import { migrateV1toV2, V2_SCHEMA_VERSION } from "./state-migrate-v2.ts";
import { checkStateV2 } from "./state-schema-v2.ts";

// ---------------------------------------------------------------------------
// 帳簿系 verb の宣言 (ディスパッチ集合のもう半分)
// ---------------------------------------------------------------------------

export const LEDGER_VERBS = [
  "init",
  "get",
  "validate",
  "next",
  "session-touch",
  "sessions-alive",
  "history-append",
  "candidates-set",
  "candidates-drop",
  "promoted-add",
  "promoted-drop",
  "relisted-add",
  "relisted-drop",
  "stalled-set",
] as const;
export type LedgerVerb = (typeof LEDGER_VERBS)[number];

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// state.ts の withQueueLock / withExistingStateLock が、遷移関数の戻り値 (生の次状態) に
// 対して呼び出し後に適用する共通の正規化。v1 の finalizeState と同じ役割だが、
// schema_version は「無ければ付ける」ではなく **常に 2 に固定する** — v2 の
// スキーマは schema_version: 2 を required かつ enum [2] で要求しており、
// 書き込む値が 2 以外になる経路を残さない。
export function finalizeStateV2(state: V2State, nowIso: string): V2State {
  return { ...state, updated_at: nowIso, schema_version: V2_SCHEMA_VERSION };
}

// 読み込んだ生の JSON を V2State として扱う前の正規化。v2 スキーマ上 optional な
// withdrawn_branches (v1 に無かったので移行後も欠けうる) を空配列で埋める。
// **他のキーには触れない** — 検証は checkStateV2 が済ませている。
export function normalizeStateV2(parsed: Record<string, unknown>): V2State {
  if (Array.isArray(parsed.withdrawn_branches)) {
    return parsed as unknown as V2State;
  }
  return { ...parsed, withdrawn_branches: [] } as unknown as V2State;
}

// ---------------------------------------------------------------------------
// init — 新規作成 / 移行 / no-op の 3 分岐 (設計3.2節)
// ---------------------------------------------------------------------------

export function buildFreshStateV2(
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    tracker,
    source,
    updated_at: nowIso,
    queue: [],
    completed: [],
    candidates: [],
    relisted: [],
    promoted: [],
    withdrawn_branches: [],
    history: [],
    schema_version: V2_SCHEMA_VERSION,
  };
}

// init の 3 分岐:
//   - state.json が無い          → 新規作成 (v2 の空 state)
//   - schema_version == 2        → undefined (書き込まない。バイト単位の no-op)
//   - schema_version 欠落 または 1 → migrateV1toV2 を **一度だけ** 適用
//   - それ以外 (3 以上・非数値)   → schema エラー
//
// 「欠落」を v1 とみなすのは、schema_version 導入前の state.json が実在するため
// (tests/fixtures/state-cli/valid-legacy-live.json)。移行後は schema_version が 2 に
// なるので、2 回目の init は no-op 分岐に落ちる (= 再移行しない)。
export function applyInitV2(
  current: Record<string, unknown> | undefined,
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> | undefined {
  if (current === undefined) return buildFreshStateV2(tracker, source, nowIso);

  const version = current.schema_version;
  if (version === V2_SCHEMA_VERSION) return undefined;
  if (version === undefined || version === 1) {
    return migrateV1toV2(current, nowIso);
  }
  throw new CliErrorV2(
    "schema",
    `unsupported schema_version: ${JSON.stringify(version)} ` +
      `(this CLI reads 1 (migrates) and ${V2_SCHEMA_VERSION})`,
  );
}

// ---------------------------------------------------------------------------
// get / validate
// ---------------------------------------------------------------------------

export function getV2(state: unknown): unknown {
  return state;
}

export function validateV2(state: unknown): { ok: true } {
  const check = checkStateV2(state);
  if (!check.ok) {
    throw new CliErrorV2("schema", `${check.path}: ${check.message}`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// session-touch / sessions-alive のしきい値判定
//
// 対象は state.json ではなく <state dir>/sessions/* の mtime なので状態オブジェクトの
// 書き換えは無い。しきい値との厳密不等号比較 (生存 <90分、掃除対象 >1440分。いずれも
// strict) だけをここに切り出して in-process にテスト可能にする。
// ---------------------------------------------------------------------------

export function isSessionStale(
  nowMs: number,
  mtimeMs: number,
  cleanupStaleMin: number,
): boolean {
  return (nowMs - mtimeMs) / 60_000 > cleanupStaleMin;
}

export function isSessionAlive(
  nowMs: number,
  mtimeMs: number,
  aliveMaxMin: number,
): boolean {
  return (nowMs - mtimeMs) / 60_000 < aliveMaxMin;
}

// ---------------------------------------------------------------------------
// history-append
// ---------------------------------------------------------------------------

export function applyHistoryAppendV2(state: V2State, line: string): V2State {
  return { ...state, history: [...state.history, line] };
}

// ---------------------------------------------------------------------------
// candidates / promoted / relisted
// ---------------------------------------------------------------------------

export function applyCandidatesSetV2(
  state: V2State,
  candidates: readonly unknown[],
): V2State {
  return { ...state, candidates: [...candidates] };
}

export function applyCandidatesDropV2(state: V2State, id: string): V2State {
  const arr = state.candidates as readonly Record<string, unknown>[];
  const index = arr.findIndex((c) => isRecord(c) && c.id === id);
  if (index === -1) {
    throw new CliErrorV2("missing", `id not found in candidates: ${id}`);
  }
  const next = arr.slice();
  next.splice(index, 1);
  return { ...state, candidates: next };
}

export function applyPromotedAddV2(
  state: V2State,
  ids: readonly string[],
): V2State {
  const set = new Set(state.promoted);
  for (const id of ids) set.add(id);
  return { ...state, promoted: [...set] };
}

export function applyPromotedDropV2(state: V2State, id: string): V2State {
  const index = state.promoted.indexOf(id);
  if (index === -1) {
    throw new CliErrorV2("missing", `id not found in promoted: ${id}`);
  }
  const next = state.promoted.slice();
  next.splice(index, 1);
  return { ...state, promoted: next };
}

export function applyRelistedAddV2(
  state: V2State,
  id: string,
  seenAt: string,
): V2State {
  requirePrecondition(
    state.relisted.findIndex((r) => r.id === id) === -1,
    `id already exists in relisted: ${id}`,
  );
  const entry: RelistedEntry = { id, seen_at: seenAt };
  return { ...state, relisted: [...state.relisted, entry] };
}

export function applyRelistedDropV2(state: V2State, id: string): V2State {
  const index = state.relisted.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new CliErrorV2("missing", `id not found in relisted: ${id}`);
  }
  const next = state.relisted.slice();
  next.splice(index, 1);
  return { ...state, relisted: next };
}

// ---------------------------------------------------------------------------
// stalled-set
// ---------------------------------------------------------------------------

export type StalledArg = (typeof STALLED_VALUES)[number] | "null";

// value が "null" なら停滞の記録を消す。そうでなければ値を立て、
// stalled_since は「今まで null だった」または --bump のときだけ現在時刻に更新する
// (同じ理由で停滞し続けている間は最初に気づいた時刻を保つ)。
export function applyStalledSetV2(
  state: V2State,
  value: StalledArg,
  bump: boolean,
  nowIso: string,
): V2State {
  if (value === "null") {
    return { ...state, stalled: null, stalled_since: null };
  }
  const wasNull = state.stalled == null;
  const stalledSince = wasNull || bump ? nowIso : (state.stalled_since ?? null);
  return { ...state, stalled: value, stalled_since: stalledSince };
}
