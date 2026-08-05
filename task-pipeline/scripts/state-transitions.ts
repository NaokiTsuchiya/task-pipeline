// task-pipeline/scripts/state-transitions.ts
//
// task-pipeline/docs/state-cli-contract.md が定める42 verb のうち、各 verb の
// 「事前条件チェックと状態オブジェクトの書き換え」だけを切り出した純粋関数群。
// ロック・原子的書き込み・heartbeat・権限・CLI dispatch・終了コードへの変換は
// state.ts に残る。ここは Deno 由来の API 呼び出しを一切行わない (state-ownership.ts /
// state-schema.ts と同型の設計) — 現在時刻が要る箇所は、呼び出し元 (state.ts) が
// nowIso()/nowMs() (STATE_CLI_TEST_NOW_MS によるテスト決定性込み) で計算した値を
// 引数として受け取る。ファイルI/O・排他は一切行わない。
//
// verb → 実装 (state-cli-contract.md の `### ` 見出しと対応。全43件):
//   `init`                     → applyInit
//   `get`                      → get (前提チェック・書き換え無し。読み取りは state.ts)
//   `validate`                 → validate (checkState を呼ぶだけ)
//   `session-touch`            → isSessionStale (年齢判定のみ。ファイルI/Oは state.ts)
//   `sessions-alive`           → isSessionAlive (年齢判定のみ。ファイルI/Oは state.ts)
//   `history-append`           → applyHistoryAppend
//   `approve`                  → applyApprove
//   `claim`                    → applyClaim
//   `set-gate`                 → applySetGate
//   `set-worktree`             → applySetWorktree
//   `set-executor`             → applySetExecutor
//   `touch-executor`           → applyTouchExecutor
//   `set-takeover`             → applySetTakeover
//   `phase-pass`               → applyPhasePass
//   `phase-fail`               → applyPhaseFail
//   `block`                    → applyBlock
//   `dequeue`                  → applyDequeue
//   `finalize-start`           → applyFinalizeStart
//   `in-review`                → applyInReview
//   `watch-init`               → applyWatchInit
//   `watch-set`                → applyWatchSet
//   `fix-pending`              → applyFixPending
//   `fix-start`                → applyFixStart
//   `fix-done`                 → applyFixDone
//   `review-only`              → applyReviewOnly
//   `answered-set`             → applyAnsweredSet
//   `rebase-record`            → applyRebaseRecord
//   `rebase-resolve-pending`   → applyRebaseResolvePending
//   `rebase-start`             → applyRebaseStart
//   `rebase-done`              → applyRebaseDone
//   `rebase-give-up`           → applyRebaseGiveUp
//   `recover-done`             → applyRecoverDone
//   `withdraw`                 → applyWithdraw
//   `withdraw-remove`          → applyWithdrawRemove
//   `withdraw-asked`           → applyWithdrawAsked
//   `candidates-set`           → applyCandidatesSet
//   `candidates-drop`          → applyCandidatesDrop
//   `promoted-add`             → applyPromotedAdd
//   `promoted-drop`            → applyPromotedDrop
//   `relisted-add`             → applyRelistedAdd
//   `relisted-drop`            → applyRelistedDrop
//   `restore`                  → applyRestore
//   `stalled-set`              → applyStalledSet
//
// テスト: state.test.ts / state-ownership.test.ts はサブプロセス経由で state.ts を検証する
// 既存の安全網のまま変更しない (このタスクの要求)。このファイル専用の直接importテストは
// 後続タスクの範囲。

import { checkState } from "./state-schema.ts";

// ---------------------------------------------------------------------------
// 終了コード名・エラー型
//
// usage/lock/schema/permission (主に state.ts 側の flag 解釈・lock・読み取りが使う) と、
// conflict/missing (ここでの前提チェックが使う) の両方の語彙を、循環importを避けるため
// ここで定義し state.ts が import する (state.ts → state-transitions.ts の一方向)。
// ---------------------------------------------------------------------------

export type ExitCodeName =
  | "usage"
  | "lock"
  | "schema"
  | "missing"
  | "permission"
  | "conflict";

export class CliError extends Error {
  constructor(public readonly code: ExitCodeName, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// schema_version の正規化: 無ければ末尾に付与、有ればどんな値でも触らない
// (JS オブジェクトの文字列キーは挿入順を保つ仕様を使い、既存キーの順序・値を変えない)
// ---------------------------------------------------------------------------

function withSchemaVersion(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if ("schema_version" in obj) return obj;
  return { ...obj, schema_version: DEFAULT_SCHEMA_VERSION };
}

function buildFreshState(
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    tracker,
    source,
    updated_at: nowIso,
    queue: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    schema_version: DEFAULT_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// queue エントリを対象にする verb が共有するヘルパ群
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queueArray(
  state: Record<string, unknown>,
): Record<string, unknown>[] {
  return Array.isArray(state.queue)
    ? (state.queue as Record<string, unknown>[])
    : [];
}

function findQueueIndex(state: Record<string, unknown>, id: string): number {
  return queueArray(state).findIndex((it) => it.id === id);
}

export function requireQueueItem(
  state: Record<string, unknown>,
  id: string,
): { index: number; item: Record<string, unknown> } {
  const index = findQueueIndex(state, id);
  if (index === -1) {
    throw new CliError("missing", `id not found in queue: ${id}`);
  }
  return { index, item: queueArray(state)[index] };
}

function requirePrecondition(cond: boolean, message: string): void {
  if (!cond) throw new CliError("conflict", message);
}

function withReplacedItem(
  state: Record<string, unknown>,
  index: number,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const q = queueArray(state).slice();
  q[index] = item;
  return { ...state, queue: q };
}

// state.ts の withQueueLock/withExistingStateLock が、遷移関数の戻り値 (生の次状態) に
// 対して呼び出し後に適用する共通の正規化。nowIso は呼び出し元が計算した値。
export function finalizeState(
  next: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  return withSchemaVersion({ ...next, updated_at: nowIso });
}

function getReview(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(item.review) ? item.review : null;
}

function getWatch(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const review = getReview(item);
  if (!review) return null;
  return isRecord(review.watch) ? review.watch : null;
}

function getRebase(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const review = getReview(item);
  if (!review) return null;
  return isRecord(review.rebase) ? review.rebase : null;
}

export interface ReviewOnlyEntry {
  id: string;
  updated_at: string | null;
}

// watch.review_only は review_only を watch.handled に入れず恒久的に沈黙させないための
// フィールドで、後方互換のためスキーマ上も optional。無ければ空配列として読む。
function getReviewOnlyList(
  watch: Record<string, unknown> | null,
): ReviewOnlyEntry[] {
  const raw = watch && Array.isArray(watch.review_only)
    ? watch.review_only
    : [];
  return raw as ReviewOnlyEntry[];
}

// watch.answered は gh-6 (レビュアーの質問に PR 上で返信する経路) で新設したフィールドで、
// review_only と同じく後方互換のため required には入れていない。無ければ空配列として読む。
function getAnsweredList(
  watch: Record<string, unknown> | null,
): ReviewOnlyEntry[] {
  const raw = watch && Array.isArray(watch.answered) ? watch.answered : [];
  return raw as ReviewOnlyEntry[];
}

function unionAppend(existing: unknown, additions: string[]): string[] {
  const base = Array.isArray(existing) ? (existing as string[]) : [];
  const set = new Set(base);
  for (const a of additions) set.add(a);
  return [...set];
}

// ---------------------------------------------------------------------------
// init / get / validate / session-touch / sessions-alive
// ---------------------------------------------------------------------------

// init: 無ければ新規作成、有れば --tracker/--source では上書きせず schema_version
// だけ正規化する (無ければ付与、有れば触らない)。
export function applyInit(
  current: Record<string, unknown> | undefined,
  tracker: string,
  source: string,
  nowIso: string,
): Record<string, unknown> | undefined {
  if (current === undefined) return buildFreshState(tracker, source, nowIso);
  if ("schema_version" in current) return undefined;
  return withSchemaVersion(current);
}

// get: 状態オブジェクトをそのまま返すだけ。前提チェックも書き換えも無い
// (読み取り専用 verb、スキーマ検証すら行わない — state-cli-contract.md 「get」節)。
export function get(state: unknown): unknown {
  return state;
}

export function validate(state: unknown): { ok: true } {
  const check = checkState(state);
  if (!check.ok) {
    throw new CliError("schema", `${check.path}: ${check.message}`);
  }
  return { ok: true };
}

// session-touch/sessions-alive: 対象は state.json ではなく <state dir>/sessions/* の
// 個別ファイルの mtime なので「状態オブジェクトの書き換え」自体は無い。しきい値との
// 厳密不等号比較 (heartbeat 契約: 生存 <90分、掃除対象 >1440分、いずれも strict) だけが
// state.ts 内で唯一の判定ロジックなので、ここに切り出して in-process にテスト可能にする。
// ファイルの列挙・stat・remove・utime は state.ts に残る。
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

export function applyHistoryAppend(
  current: Record<string, unknown>,
  line: string,
): Record<string, unknown> {
  const existingHistory = Array.isArray(current.history) ? current.history : [];
  const history = [...existingHistory, line];
  return { ...current, history };
}

// ---------------------------------------------------------------------------
// タスク進行
// ---------------------------------------------------------------------------

export function applyApprove(
  current: Record<string, unknown>,
  id: string,
  title: string,
): Record<string, unknown> {
  requirePrecondition(
    findQueueIndex(current, id) === -1,
    `id already exists in queue: ${id}`,
  );
  const entry: Record<string, unknown> = {
    id,
    title,
    status: "approved",
    gate: "full",
    phase: null,
    attempts: 0,
    session: null,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    blocked_reason: null,
    worktree: null,
    base: null,
    review: null,
  };
  const q = queueArray(current).slice();
  q.push(entry);
  return { ...current, queue: q };
}

export function applyClaim(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "approved",
    `status must be approved, got ${String(item.status)}`,
  );
  const next = {
    ...item,
    status: "in_progress",
    phase: "research",
    attempts: 0,
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applySetGate(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress" && item.phase === "research" &&
      item.gate === "full",
    "status must be in_progress, phase must be research, gate must be full",
  );
  const next = { ...item, gate: "light", phase: "research+plan" };
  return withReplacedItem(state, index, next);
}

export function applySetWorktree(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  worktree: string,
  base: string,
  drop: boolean,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress",
    `status must be in_progress, got ${String(item.status)}`,
  );
  const next = { ...item, worktree, base };
  let nextState = withReplacedItem(state, index, next);
  if (drop) {
    const id = String(item.id);
    const wb = Array.isArray(state.withdrawn_branches)
      ? (state.withdrawn_branches as Record<string, unknown>[])
      : [];
    const wbIndex = wb.findIndex((e) => e.id === id);
    requirePrecondition(
      wbIndex !== -1,
      `no withdrawn_branches entry for id: ${id}`,
    );
    const nextWb = wb.slice();
    nextWb.splice(wbIndex, 1);
    nextState = { ...nextState, withdrawn_branches: nextWb };
  }
  return nextState;
}

export function applySetExecutor(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  executor: string,
  session: string,
  nowIso: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress",
    `status must be in_progress, got ${String(item.status)}`,
  );
  const next = {
    ...item,
    executor,
    executor_last_event_at: nowIso,
    session,
  };
  return withReplacedItem(state, index, next);
}

export function applyTouchExecutor(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  sessionIfUnowned: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress" && item.executor != null,
    "status must be in_progress and executor must be set",
  );
  let next: Record<string, unknown> = {
    ...item,
    executor_last_event_at: nowIso,
  };
  if (sessionIfUnowned !== undefined && next.session == null) {
    next = { ...next, session: sessionIfUnowned };
  }
  return withReplacedItem(state, index, next);
}

export function applySetTakeover(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  atValue: string | null,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress",
    `status must be in_progress, got ${String(item.status)}`,
  );
  const next = { ...item, takeover_at: atValue };
  return withReplacedItem(state, index, next);
}

export function applyPhasePass(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress" && item.phase === from,
    `status must be in_progress and phase must be ${from}, got status=${
      String(item.status)
    } phase=${String(item.phase)}`,
  );
  const next = { ...item, phase: to, attempts: 0 };
  return withReplacedItem(state, index, next);
}

export interface PhaseFailResult {
  state: Record<string, unknown>;
  attempts: number;
}

export function applyPhaseFail(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  phase: string,
): PhaseFailResult {
  requirePrecondition(
    item.status === "in_progress" && item.phase === phase,
    `status must be in_progress and phase must be ${phase}, got status=${
      String(item.status)
    } phase=${String(item.phase)}`,
  );
  const attempts = (typeof item.attempts === "number" ? item.attempts : 0) +
    1;
  const next = { ...item, attempts };
  return { state: withReplacedItem(state, index, next), attempts };
}

export function applyBlock(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  reason: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress",
    `status must be in_progress, got ${String(item.status)}`,
  );
  const next = {
    ...item,
    status: "blocked",
    blocked_reason: reason,
    phase: null,
    session: null,
  };
  return withReplacedItem(state, index, next);
}

export function applyDequeue(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress",
    `status must be in_progress, got ${String(item.status)}`,
  );
  const q = queueArray(state).slice();
  q.splice(index, 1);
  return { ...state, queue: q };
}

export function applyFinalizeStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  from: string,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress" && item.phase === from,
    `status must be in_progress and phase must be ${from}, got status=${
      String(item.status)
    } phase=${String(item.phase)}`,
  );
  const next = { ...item, phase: "finalize", attempts: 0 };
  return withReplacedItem(state, index, next);
}

export interface InReviewArgs {
  freshGroup: boolean;
  ref?: string;
  branch?: string;
  tip?: string;
  base?: string;
  commits: number;
  clearSession: boolean;
}

export function applyInReview(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  args: InReviewArgs,
): Record<string, unknown> {
  requirePrecondition(
    item.status === "in_progress" && item.phase === "finalize",
    `status must be in_progress and phase must be finalize, got status=${
      String(item.status)
    } phase=${String(item.phase)}`,
  );
  let next: Record<string, unknown> = {
    ...item,
    status: "in_review",
    phase: null,
    attempts: 0,
  };
  if (args.freshGroup) {
    next = {
      ...next,
      review: {
        ref: args.ref!,
        branch: args.branch!,
        tip: args.commits >= 1 ? args.tip! : null,
        base: args.base!,
      },
    };
  }
  if (args.clearSession) {
    next = { ...next, session: null };
  }
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 追従
// ---------------------------------------------------------------------------

export function applyWatchInit(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
  preserve: boolean,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null && review.ref != null,
    "status must be in_review and review.ref must be set",
  );
  const existingWatch = getWatch(item);
  const existingHandled = preserve && existingWatch &&
      Array.isArray(existingWatch.handled)
    ? (existingWatch.handled as string[])
    : [];
  const watch = {
    state: "watching",
    proc: null,
    proc_started_at: null,
    sig: null,
    head: null,
    ci: null,
    handled: existingHandled,
    fix_pending: false,
    pending_ids: [],
    findings: null,
    fix_attempts: 0,
    errors: 0,
    checked_at: null,
    note: null,
    // review_only/answered は --preserve-handled の対象外: pending_ids/findings と同じく
    // watch-init は常にまっさらから始める (引き継ぎを要求する受け入れ条件は無い)。
    review_only: [],
    answered: [],
  };
  const next = { ...item, review: { ...review, watch }, session };
  return withReplacedItem(state, index, next);
}

export interface WatchSetFields {
  proc?: string | null;
  sig?: string | null;
  head?: string | null;
  ci?: string | null;
  checkedAt?: string | null;
  errorsInc: boolean;
  errorsReset: boolean;
  note?: string | null;
  state?: "watching" | "stopped";
  session?: string | null;
}

export function applyWatchSet(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  fields: WatchSetFields,
  nowIso: string,
): Record<string, unknown> {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(watch !== null, "review.watch must be present");
  const nextWatch: Record<string, unknown> = { ...watch! };
  if ("proc" in fields) {
    nextWatch.proc = fields.proc;
    nextWatch.proc_started_at = fields.proc === null ? null : nowIso;
  }
  if ("sig" in fields) nextWatch.sig = fields.sig;
  if ("head" in fields) nextWatch.head = fields.head;
  if ("ci" in fields) nextWatch.ci = fields.ci;
  if ("checkedAt" in fields) nextWatch.checked_at = fields.checkedAt;
  if (fields.errorsInc) {
    const cur = typeof watch!.errors === "number" ? watch!.errors : 0;
    nextWatch.errors = cur + 1;
  }
  if (fields.errorsReset) nextWatch.errors = 0;
  if ("note" in fields) nextWatch.note = fields.note;
  if ("state" in fields) nextWatch.state = fields.state;
  let next: Record<string, unknown> = {
    ...item,
    review: { ...review, watch: nextWatch },
  };
  if ("state" in fields && fields.state === "stopped") {
    next = { ...next, session: null };
  }
  if ("session" in fields) {
    next = { ...next, session: fields.session };
  }
  return withReplacedItem(state, index, next);
}

export function applyFixPending(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  pendingIds: string[],
  findings: string,
): Record<string, unknown> {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    item.status === "in_review" && watch !== null,
    "status must be in_review and review.watch must be present",
  );
  const nextWatch = {
    ...watch,
    fix_pending: true,
    pending_ids: pendingIds,
    findings,
  };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return withReplacedItem(state, index, next);
}

export interface FixStartResult {
  state: Record<string, unknown>;
  started: boolean;
  fixAttempts: number;
}

export function applyFixStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
  reset: boolean,
): FixStartResult {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    item.status === "in_review" && watch !== null &&
      watch.fix_pending === true,
    "status must be in_review and watch.fix_pending must be true",
  );
  const baseAttempts = reset
    ? 0
    : (typeof watch!.fix_attempts === "number" ? watch!.fix_attempts : 0);
  const fixAttempts = baseAttempts + 1;
  const started = fixAttempts <= 3;
  let nextWatch: Record<string, unknown>;
  let next: Record<string, unknown>;
  if (started) {
    nextWatch = { ...watch, fix_attempts: fixAttempts, fix_pending: false };
    next = {
      ...item,
      status: "in_progress",
      phase: "pr_fix",
      attempts: 0,
      session,
      review: { ...review, watch: nextWatch },
    };
  } else {
    nextWatch = {
      ...watch,
      fix_attempts: fixAttempts,
      state: "stopped",
      note: "追従上限",
    };
    next = {
      ...item,
      session: null,
      review: { ...review, watch: nextWatch },
    };
  }
  return {
    state: withReplacedItem(state, index, next),
    started,
    fixAttempts,
  };
}

export function applyFixDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    item.status === "in_progress" && item.phase === "finalize" &&
      watch !== null,
    "status must be in_progress, phase must be finalize, and review.watch must be present",
  );
  const pendingIds = Array.isArray(watch!.pending_ids)
    ? (watch!.pending_ids as string[])
    : [];
  const nextWatch = {
    ...watch,
    handled: unionAppend(watch!.handled, pendingIds),
    pending_ids: [],
    findings: null,
  };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return withReplacedItem(state, index, next);
}

export interface ReviewOnlyResult {
  state: Record<string, unknown>;
  newOrChanged: string[];
  total: number;
}

export function applyReviewOnly(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  items: ReviewOnlyEntry[],
): ReviewOnlyResult {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    item.status === "in_review" && watch !== null,
    "status must be in_review and review.watch must be present",
  );
  const existing = getReviewOnlyList(watch);
  const byId = new Map(existing.map((e) => [e.id, e.updated_at]));
  const newOrChanged: string[] = [];
  for (const it of items) {
    const known = byId.has(it.id);
    const prev = byId.get(it.id);
    const changed = !known || prev === null || it.updated_at === null ||
      prev !== it.updated_at;
    if (changed) newOrChanged.push(it.id);
    byId.set(it.id, it.updated_at);
  }
  const nextList: ReviewOnlyEntry[] = [...byId.entries()].map((
    [rid, updatedAt],
  ) => ({ id: rid, updated_at: updatedAt }));
  const total = nextList.length;
  const nextWatch = { ...watch, review_only: nextList };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total,
  };
}

// watch.answered は review_only と同じ入出力契約 (id/updated_at の upsert・dedup) を持つが、
// 別フィールド・別語彙にする (gh-6)。watch.handled は「pr_fix で実際にコードを直した」ことを
// 表す語彙、watch.review_only は「人の判断が要ると回した」ことを表す語彙で、どちらとも意味が
// 違う「質問に回答・投稿済み」をこの2つに混ぜると、次に読む executor/verifier が誤読する。
// ReviewOnlyResult をそのまま再利用する (戻り値の形が同一のため)。
export function applyAnsweredSet(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  items: ReviewOnlyEntry[],
): ReviewOnlyResult {
  const review = getReview(item);
  const watch = getWatch(item);
  requirePrecondition(
    item.status === "in_review" && watch !== null,
    "status must be in_review and review.watch must be present",
  );
  const existing = getAnsweredList(watch);
  const byId = new Map(existing.map((e) => [e.id, e.updated_at]));
  const newOrChanged: string[] = [];
  for (const it of items) {
    const known = byId.has(it.id);
    const prev = byId.get(it.id);
    const changed = !known || prev === null || it.updated_at === null ||
      prev !== it.updated_at;
    if (changed) newOrChanged.push(it.id);
    byId.set(it.id, it.updated_at);
  }
  const nextList: ReviewOnlyEntry[] = [...byId.entries()].map((
    [rid, updatedAt],
  ) => ({ id: rid, updated_at: updatedAt }));
  const total = nextList.length;
  // answered-set は watch.handled にも watch.review_only にも触れない (語彙の非混入)。
  const nextWatch = { ...watch, answered: nextList };
  const next = { ...item, review: { ...review, watch: nextWatch } };
  return {
    state: withReplacedItem(state, index, next),
    newOrChanged,
    total,
  };
}

// ---------------------------------------------------------------------------
// 載せ直し
// ---------------------------------------------------------------------------

export function applyRebaseRecord(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  blockedOnto: string,
  reason: string,
  kind: string | undefined,
  cause: string | undefined,
  report: string | undefined,
  nowIso: string,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null,
    "status must be in_review and review must be present",
  );
  const existingRebase = getRebase(item);
  const nextRebase: Record<string, unknown> = {
    ...(existingRebase ?? {}),
    blocked_onto: blockedOnto,
    reason,
    at: existingRebase?.at ?? nowIso,
  };
  if (kind !== undefined) nextRebase.kind = kind;
  if (cause !== undefined) nextRebase.cause = cause;
  if (report !== undefined) nextRebase.report = report;
  const next = { ...item, review: { ...review, rebase: nextRebase } };
  return withReplacedItem(state, index, next);
}

export function applyRebaseResolvePending(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  fromTip: string,
): Record<string, unknown> {
  const review = getReview(item);
  const rebase = getRebase(item);
  requirePrecondition(
    item.status === "in_review" && rebase !== null,
    "status must be in_review and review.rebase must be present",
  );
  const nextRebase = {
    ...rebase,
    resolve_pending: true,
    from_tip: fromTip,
  };
  const next = { ...item, review: { ...review, rebase: nextRebase } };
  return withReplacedItem(state, index, next);
}

export function applyRebaseStart(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  session: string,
): Record<string, unknown> {
  const review = getReview(item);
  const rebase = getRebase(item);
  requirePrecondition(
    item.status === "in_review" && rebase !== null &&
      rebase.resolve_pending === true,
    "status must be in_review and review.rebase.resolve_pending must be true",
  );
  const nextRebase = { ...rebase, resolve_pending: false };
  const next = {
    ...item,
    status: "in_progress",
    phase: "rebase_fix",
    attempts: 0,
    session,
    review: { ...review, rebase: nextRebase },
  };
  return withReplacedItem(state, index, next);
}

export function applyRebaseDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  tip: string,
): Record<string, unknown> {
  const review = getReview(item);
  const rebase = getRebase(item);
  requirePrecondition(
    review !== null && rebase !== null,
    "review.rebase must be present",
  );
  const nextReview: Record<string, unknown> = { ...review, tip };
  delete nextReview.rebase;
  const next = { ...item, review: nextReview };
  return withReplacedItem(state, index, next);
}

export function applyRebaseGiveUp(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  blockedOnto: string,
): Record<string, unknown> {
  const review = getReview(item);
  const rebase = getRebase(item);
  requirePrecondition(
    item.status === "in_progress" && item.phase === "rebase_fix" &&
      review !== null && rebase !== null,
    "status must be in_progress, phase must be rebase_fix, and review.rebase must be present",
  );
  const nextRebase = {
    ...rebase,
    reason: "conflict",
    blocked_onto: blockedOnto,
    resolve_pending: false,
  };
  const next = {
    ...item,
    status: "in_review",
    phase: null,
    attempts: 0,
    session: null,
    review: { ...review, rebase: nextRebase },
  };
  return withReplacedItem(state, index, next);
}

// ---------------------------------------------------------------------------
// 回収と候補
// ---------------------------------------------------------------------------

export function applyRecoverDone(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null && review.tip != null,
    "status must be in_review and review.tip must be present",
  );
  const watch = getWatch(item);
  let nextReview = review!;
  if (watch !== null) {
    nextReview = { ...review, watch: { ...watch, proc: null } };
  }
  const next = {
    ...item,
    status: "done",
    session: null,
    review: nextReview,
  };
  return withReplacedItem(state, index, next);
}

export function applyWithdraw(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null,
    "status must be in_review and review must be present",
  );
  const next = { ...item, review: { ...review, withdrawn: true } };
  return withReplacedItem(state, index, next);
}

export function applyWithdrawRemove(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
  reason: string,
  nowIso: string,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null &&
      review.withdrawn === true && item.worktree != null &&
      item.base != null,
    "status must be in_review, review.withdrawn must be true, and worktree/base must be set",
  );
  const id = String(item.id);
  const entry = {
    id,
    branch: `task-pipeline/${id}`,
    base: item.base as string,
    worktree: item.worktree as string,
    at: nowIso,
    reason,
  };
  const wb = Array.isArray(state.withdrawn_branches)
    ? (state.withdrawn_branches as unknown[]).slice()
    : [];
  wb.push(entry);
  const q = queueArray(state).slice();
  q.splice(index, 1);
  return { ...state, queue: q, withdrawn_branches: wb };
}

export function applyWithdrawAsked(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const review = getReview(item);
  requirePrecondition(
    item.status === "in_review" && review !== null &&
      review.withdrawn === true,
    "status must be in_review and review.withdrawn must be true",
  );
  const next = { ...item, review: { ...review, withdrawn_asked: true } };
  return withReplacedItem(state, index, next);
}

export function applyCandidatesSet(
  current: Record<string, unknown>,
  candidates: unknown[],
): Record<string, unknown> {
  return { ...current, candidates };
}

export function applyCandidatesDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.candidates)
    ? (current.candidates as Record<string, unknown>[])
    : [];
  const idx = arr.findIndex((c) => c.id === id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in candidates: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, candidates: next };
}

export function applyPromotedAdd(
  current: Record<string, unknown>,
  ids: string[],
): Record<string, unknown> {
  const next = unionAppend(current.promoted, ids);
  return { ...current, promoted: next };
}

export function applyPromotedDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.promoted)
    ? (current.promoted as string[])
    : [];
  const idx = arr.indexOf(id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in promoted: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, promoted: next };
}

export function applyRelistedAdd(
  current: Record<string, unknown>,
  id: string,
  seenAt: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.relisted)
    ? (current.relisted as Record<string, unknown>[])
    : [];
  requirePrecondition(
    arr.findIndex((r) => r.id === id) === -1,
    `id already exists in relisted: ${id}`,
  );
  const next = [...arr, { id, seen_at: seenAt }];
  return { ...current, relisted: next };
}

export function applyRelistedDrop(
  current: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const arr = Array.isArray(current.relisted)
    ? (current.relisted as Record<string, unknown>[])
    : [];
  const idx = arr.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new CliError("missing", `id not found in relisted: ${id}`);
  }
  const next = arr.slice();
  next.splice(idx, 1);
  return { ...current, relisted: next };
}

export function applyRestore(
  item: Record<string, unknown>,
  index: number,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(item.id);
  const relisted = Array.isArray(state.relisted)
    ? (state.relisted as Record<string, unknown>[])
    : [];
  const rIndex = relisted.findIndex((r) => r.id === id);
  requirePrecondition(rIndex !== -1, `id not found in relisted: ${id}`);
  requirePrecondition(
    item.status === "in_review" || item.status === "blocked" ||
      item.status === "done",
    `status must be in_review/blocked/done, got ${String(item.status)}`,
  );
  const nextItem = {
    ...item,
    status: "approved",
    phase: null,
    attempts: 0,
    session: null,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    blocked_reason: null,
  };
  const nextRelisted = relisted.slice();
  nextRelisted.splice(rIndex, 1);
  const withItem = withReplacedItem(state, index, nextItem);
  return { ...withItem, relisted: nextRelisted };
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

export function applyStalledSet(
  current: Record<string, unknown>,
  value: "depleted" | "max_open" | "null",
  bump: boolean,
  nowIso: string,
): Record<string, unknown> {
  if (value === "null") {
    return { ...current, stalled: null, stalled_since: null };
  }
  const wasNull = current.stalled == null;
  let stalledSince = current.stalled_since ?? null;
  if (wasNull || bump) stalledSince = nowIso;
  return { ...current, stalled: value, stalled_since: stalledSince };
}
