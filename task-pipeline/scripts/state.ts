// task-pipeline/scripts/state.ts
//
// state.json への読み書きを、排他 (lock) / 原子的書き込み (tmp+rename) / heartbeat /
// スキーマ検証込みで CLI に閉じ込める。オーケストレーター (モデル) はこの CLI を呼ぶだけで、
// state.json の書き込み手順 (task-pipeline/SKILL.md の「state.json の書き込み手順 (排他)」
// 「セッションの所有権」節) を自分で守らなくてよい。
//
// 実行形:
//   deno run --no-prompt \
//     --allow-read=<state dir>[,<git common dir>/info] \
//     --allow-write=<state dir>[,<git common dir>/info] \
//     task-pipeline/scripts/state.ts <verb> --state-dir <dir> [verb固有フラグ...]
//
// verb 一覧 (foundation): init / get / validate / session-touch / sessions-alive /
//   history-append
// verb 一覧 (state-cli-verbs、SKILL.md の遷移を覆う): タスク進行 (approve/claim/set-gate/
//   set-worktree/set-executor/touch-executor/set-takeover/phase-pass/phase-fail/block/
//   dequeue/finalize-start/in-review)、追従 (watch-init/watch-set/fix-pending/fix-start/
//   fix-done/review-only)、載せ直し (rebase-record/rebase-resolve-pending/rebase-start/
//   rebase-done/rebase-give-up)、回収と候補 (recover-done/withdraw/withdraw-remove/
//   withdraw-asked/candidates-set/candidates-drop/promoted-add/promoted-drop/
//   relisted-add/relisted-drop/restore)、全体 (stalled-set)。
// 契約 (終了コード・JSON出力・verb別引数・前提・不変条件) の詳細は
// task-pipeline/docs/state-cli-contract.md (ALLOWED_FLAGS のキー一覧と見出しの対応を
// state.test.ts の T-D2 が突き合わせている)。
//
// テストの回し方: sh tests/state-cli.test.sh (deno 不在なら SKIP + exit 0)
//   直接実行する場合: deno test --allow-read --allow-write --allow-env --allow-run
//     task-pipeline/scripts/state.test.ts
//
// 実行時の外部依存はゼロ (npm:/jsr: 参照なし)。state-schema.ts の checkState と、
// state-transitions.ts (42 verb の事前条件チェック・状態オブジェクトの書き換えを持つ
// 純粋関数群 — Deno 由来の API を一切呼ばない) だけを import する。lock・原子的書き込み・
// heartbeat・権限・CLI dispatch・終了コードへの変換はこのファイルに残る。

import { checkState } from "./state-schema.ts";
import {
  applyApprove,
  applyBlock,
  applyCandidatesDrop,
  applyCandidatesSet,
  applyClaim,
  applyDequeue,
  applyFinalizeStart,
  applyFixDone,
  applyFixPending,
  applyFixStart,
  applyHistoryAppend,
  applyInit,
  applyInReview,
  applyPhaseFail,
  applyPhasePass,
  applyPromotedAdd,
  applyPromotedDrop,
  applyRebaseDone,
  applyRebaseGiveUp,
  applyRebaseRecord,
  applyRebaseResolvePending,
  applyRebaseStart,
  applyRecoverDone,
  applyRelistedAdd,
  applyRelistedDrop,
  applyRestore,
  applyReviewOnly,
  applySetExecutor,
  applySetGate,
  applySetTakeover,
  applySetWorktree,
  applyStalledSet,
  applyTouchExecutor,
  applyWatchInit,
  applyWatchSet,
  applyWithdraw,
  applyWithdrawAsked,
  applyWithdrawRemove,
  CliError,
  type ExitCodeName,
  finalizeState,
  get as transitionsGet,
  isRecord,
  isSessionAlive,
  isSessionStale,
  requireQueueItem,
  type ReviewOnlyEntry,
  validate as transitionsValidate,
  type WatchSetFields,
} from "./state-transitions.ts";

// ---------------------------------------------------------------------------
// 終了コード契約 (docs/state-cli-contract.md と state.test.ts の T-D1 で突き合わせる
// ソース・オブ・トゥルース)
// ---------------------------------------------------------------------------

export const EXIT_CODES: Record<ExitCodeName, number> = {
  usage: 10,
  lock: 11,
  schema: 12,
  missing: 13,
  permission: 14,
  // state-cli-verbs で追加: 対象 (queue/candidates/promoted/relisted のエントリ) 自体は
  // 存在するが、その verb が要求する現在の state (status/phase/session/review.* 等) の前提を
  // 満たさない。「対象が無い」(missing) や「フラグの形状が変」(usage) とは別のビジネスルール
  // 違反で、要求3「前提違反は state を変えずに失敗する」の主対象。
  conflict: 15,
};

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_RETRY_MS = 10_000;
const DEFAULT_LOCK_MAX_RETRIES = 3;
const DEFAULT_CLEANUP_STALE_MIN = 1440;
const DEFAULT_ALIVE_MAX_MIN = 90;
const STALE_LOCK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// テスト専用フック (--allow-env が無い本番実行では常に no-op)
//
// STATE_CLI_TEST_NOW_MS: 現在時刻(epoch ms)を固定する。lock の stale 判定・heartbeat の
//   年齢判定・updated_at の境界値テストを、実時間のブレ無く決定的に書くために使う。
// STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS: 原子的書き込みの rename 直前に指定 ms だけ待つ。
//   部分書き込みが起きないことのテストで、rename 前にプロセスを kill するための猶予を作る。
// STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS: session-touch の掃除ループ / sessions-alive の
//   両方で、要素ごとの stat 直前に指定 ms だけ待つ。stat 対象が「列挙後・stat 前」に外部から
//   消えるレースを、決定的に踏むための猶予を作る。
// STATE_CLI_TEST_PAUSE_BEFORE_SESSION_REMOVE_MS: session-touch の掃除ループで、stale と判定した
//   要素の remove 直前に指定 ms だけ待つ。remove 対象が「stat 後・remove 前」に外部から消える
//   レースを、決定的に踏むための猶予を作る。
// STATE_CLI_TEST_PAUSE_BEFORE_LOCK_RELEASE_MS: releaseLock の remove 直前に指定 ms だけ待つ。
//   lock 解放が state dir の権限エラーで失敗するケースを、書き込み成功後の解放段階だけに
//   絞って決定的に作るための猶予。
// ---------------------------------------------------------------------------

function tryReadEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function nowMs(): number {
  const override = tryReadEnv("STATE_CLI_TEST_NOW_MS");
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

function readTestPauseMs(): number {
  const raw = tryReadEnv("STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readSessionStatPauseMs(): number {
  const raw = tryReadEnv("STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readSessionRemovePauseMs(): number {
  const raw = tryReadEnv("STATE_CLI_TEST_PAUSE_BEFORE_SESSION_REMOVE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readLockReleasePauseMs(): number {
  const raw = tryReadEnv("STATE_CLI_TEST_PAUSE_BEFORE_LOCK_RELEASE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 小さなパスユーティリティ (外部依存を増やさないため node:path/@std/path を使わず自前で書く)
// ---------------------------------------------------------------------------

function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// 原子的書き込み (tmp に書いて rename)
// ---------------------------------------------------------------------------

async function atomicWriteText(
  path: string,
  content: string,
  withPauseHook: boolean,
): Promise<void> {
  const dir = path.slice(0, path.length - basenameOf(path).length - 1) ||
    "/";
  const tmpPath = joinPath(
    dir,
    `${basenameOf(path)}.tmp.${crypto.randomUUID()}`,
  );
  await Deno.writeTextFile(tmpPath, content);
  if (withPauseHook) {
    const pauseMs = readTestPauseMs();
    if (pauseMs > 0) await sleep(pauseMs);
  }
  await Deno.rename(tmpPath, path);
}

// ---------------------------------------------------------------------------
// state.json の読み取り (lock 不要な読み専用の入口。get/validate/applyStateChange が使う)
// ---------------------------------------------------------------------------

async function readState(stateDir: string): Promise<unknown> {
  const statePath = joinPath(stateDir, "state.json");
  let raw: string;
  try {
    raw = await Deno.readTextFile(statePath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new CliError("missing", `state.json not found: ${statePath}`);
    }
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "schema",
      `invalid JSON in state.json: ${(e as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// lock (mkdir 排他 + stale 回収)
// ---------------------------------------------------------------------------

async function tryMkdirLock(lockPath: string): Promise<boolean> {
  try {
    await Deno.mkdir(lockPath);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) return false;
    throw e;
  }
}

// stale (10分より古い) lock を単独性を保って回収する。回収に成功した (=自分が除去者になった)
// ときだけ true を返す。rename が失敗する (他所が同時に退避成功した) ときは false を返し、
// 呼び出し側は通常の待ちに戻る。
async function tryRecoverStaleLock(lockPath: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(lockPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
  const mtime = info.mtime;
  if (!mtime) return false;
  const age = nowMs() - mtime.getTime();
  if (age <= STALE_LOCK_MS) return false; // 10分「より」古いときだけ (strict)
  const stalePath = `${lockPath}.stale.${crypto.randomUUID()}`;
  try {
    await Deno.rename(lockPath, stalePath);
  } catch {
    return false;
  }
  await Deno.remove(stalePath, { recursive: true });
  return true;
}

async function acquireLock(
  stateDir: string,
  opts: { retryMs: number; maxRetries: number },
): Promise<void> {
  // state-dir 自体が無ければ mkdir(lockPath) は AlreadyExists ではなく NotFound を投げる
  // (親ディレクトリが無いため)。既存の stale 判定は AlreadyExists 前提なので、先に
  // 明示チェックして missing として弾く (history-append 経由で state-dir ごと無いケース)。
  try {
    await Deno.stat(stateDir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new CliError("missing", `state dir not found: ${stateDir}`);
    }
    throw e;
  }

  const lockPath = joinPath(stateDir, "lock");
  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    if (await tryMkdirLock(lockPath)) return;
    if (await tryRecoverStaleLock(lockPath)) {
      if (await tryMkdirLock(lockPath)) return;
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryMs);
    }
  }
  throw new CliError(
    "lock",
    `failed to acquire lock after ${opts.maxRetries} attempt(s): ${lockPath}`,
  );
}

async function releaseLock(stateDir: string): Promise<void> {
  const pauseMs = readLockReleasePauseMs();
  if (pauseMs > 0) await sleep(pauseMs);
  try {
    await Deno.remove(joinPath(stateDir, "lock"), { recursive: true });
  } catch (e) {
    // lock は「無くなっていればよい」操作: 別セッションの stale 回収 (mv して削除) が
    // 自分の release より先に完了していた場合、ここで NotFound になるのは正常。
    // 既に state.json への書き込みは完了しているので、これを失敗として伝播させてはならない。
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 書き込み系 verb (init / history-append) が共有する適用ロジック。
// lock は呼び出し側 (withStateLock、または init の手書きの try/finally) が既に持っている
// 前提で、読み直し・スキーマ検証・fn 適用・(必要なら) 原子的書き込みだけを行う。
// ---------------------------------------------------------------------------

interface LockedApplyResult {
  wrote: boolean;
  wasMissing: boolean;
  value: Record<string, unknown>;
}

async function applyStateChange(
  stateDir: string,
  fn: (
    current: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined,
): Promise<LockedApplyResult> {
  let current: Record<string, unknown> | undefined;
  let wasMissing = false;
  try {
    const parsed = await readState(stateDir);
    const check = checkState(parsed);
    if (!check.ok) {
      throw new CliError("schema", `${check.path}: ${check.message}`);
    }
    current = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof CliError && e.code === "missing") {
      current = undefined;
      wasMissing = true;
    } else {
      throw e;
    }
  }

  const next = fn(current);
  if (next === undefined) {
    return {
      wrote: false,
      wasMissing,
      value: current as Record<string, unknown>,
    };
  }
  // state-cli-verbs で追加: 書き込み前に next 自体もスキーマ検証する。既存 (init/
  // history-append) の fn は常に schema-valid な値を返す設計なので挙動は変わらないが、
  // 33個超の新規 verb が増える中で、実装ミスでスキーマ違反な next を書いてしまう経路を
  // 塞ぐ安全網として追加する (壊れた state.json を書く前に検出して schema エラーにする)。
  const postCheck = checkState(next);
  if (!postCheck.ok) {
    throw new CliError(
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
  ) => Record<string, unknown> | undefined,
): Promise<LockedApplyResult> {
  await acquireLock(stateDir, opts);
  try {
    return await applyStateChange(stateDir, fn);
  } finally {
    await releaseLock(stateDir);
  }
}

// ---------------------------------------------------------------------------
// state-cli-verbs: queue エントリを対象にする verb (withQueueLock) と、それ以外の
// トップレベル配列・新規エントリ追加を対象にする verb (withExistingStateLock) が共有する
// ロック・書き込みの glue。前提チェックと状態オブジェクトの書き換え本体は
// state-transitions.ts の対応関数に委譲する (要求3の本体: 前提違反は必ず CliError で
// 表され、withStateLock/applyStateChange は書き込みを一切行わずに re-throw する)。
// ---------------------------------------------------------------------------

async function withQueueLock(
  stateDir: string,
  id: string,
  opts: { retryMs: number; maxRetries: number },
  mutate: (
    item: Record<string, unknown>,
    index: number,
    state: Record<string, unknown>,
  ) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await withStateLock(stateDir, opts, (current) => {
    if (current === undefined) {
      throw new CliError("missing", `state.json not found in ${stateDir}`);
    }
    const { index, item } = requireQueueItem(current, id);
    const nextState = mutate(item, index, current);
    return finalizeState(nextState, nowIso());
  });
  return result.value;
}

// withQueueLock と対になる、トップレベル (queue 以外) の配列・新規 queue エントリ追加を
// 対象にする verb 用のラッパ (approve/history-append/candidates-*/promoted-*/relisted-*/
// stalled-set が使う)。「state.json が無ければ missing」の共通チェックと finalizeState の
// 適用をここに集約する — 元は9箇所が同一メッセージを手書きで繰り返していた。
async function withExistingStateLock(
  stateDir: string,
  opts: { retryMs: number; maxRetries: number },
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<LockedApplyResult> {
  return await withStateLock(stateDir, opts, (current) => {
    if (current === undefined) {
      throw new CliError("missing", `state.json not found in ${stateDir}`);
    }
    return finalizeState(mutate(current), nowIso());
  });
}

function parseCsv(raw: string): string[] {
  return raw === "" ? [] : raw.split(",");
}

function requireEnumFlag(
  flags: Map<string, string>,
  name: string,
  allowed: readonly string[],
): string {
  const value = requireFlag(flags, name);
  if (!allowed.includes(value)) {
    throw new CliError(
      "usage",
      `invalid --${name}: ${value} (expected one of ${allowed.join(", ")})`,
    );
  }
  return value;
}

function requireIntFlag(flags: Map<string, string>, name: string): number {
  const raw = requireFlag(flags, name);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CliError("usage", `invalid --${name}: ${raw}`);
  }
  return n;
}

// 値なしの真偽フラグ。parseFlags は全フラグに値を要求するので、真偽フラグは規約として
// 「省略 = false」「`--<name> true` = true」の2値だけを受け付ける (それ以外の値は usage)。
function boolFlag(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false;
  if (flags.get(name) !== "true") {
    throw new CliError(
      "usage",
      `invalid --${name}: expected "true" or omit the flag`,
    );
  }
  return true;
}

// "null" という文字列を JSON の null として扱う (nullable なフィールドを CLI フラグで
// 表現するための規約)。実際の値が文字列 "null" になることは運用上想定していない
// (proc/sig/head 等はすべて不透明な id・sha であり、その値そのものが "null" になることは無い)。
function nullableFlag(raw: string): string | null {
  return raw === "null" ? null : raw;
}

const PHASE_VALUES = [
  "research",
  "research+plan",
  "plan",
  "implement",
  "report",
  "finalize",
  "pr_fix",
  "rebase_fix",
] as const;

// ---------------------------------------------------------------------------
// init 専用: <git common dir>/info/exclude への冪等な追記
// ---------------------------------------------------------------------------

async function ensureExcludeLine(
  stateDir: string,
  gitCommonDir: string,
): Promise<void> {
  const infoDir = joinPath(gitCommonDir, "info");
  await Deno.mkdir(infoDir, { recursive: true });
  const excludePath = joinPath(infoDir, "exclude");
  const absStateDir = await Deno.realPath(stateDir);
  const excludeLine = `/${basenameOf(absStateDir)}/`;

  let existing = "";
  try {
    existing = await Deno.readTextFile(excludePath);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const alreadyPresent = existing.split("\n").some((line) =>
    line === excludeLine
  );
  if (alreadyPresent) return;

  let next = existing;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  next += `${excludeLine}\n`;
  await atomicWriteText(excludePath, next, false);
}

// ---------------------------------------------------------------------------
// 引数パース
// ---------------------------------------------------------------------------

// state-cli-verbs で追加した verb はすべて --lock-retry-ms/--lock-max-retries を受け付ける
// (書き込み系 verb の既存の慣習に揃える)。個々のエントリでは省略せず明記する — この一覧が
// state-cli-contract.md との突き合わせテスト (T-D2) の一方の入力になるため、実際に受理する
// フラグと過不足なく一致している必要がある。
const LOCK_FLAGS = ["lock-retry-ms", "lock-max-retries"];

// export するのは state.test.ts のドキュメント突き合わせテスト (state-cli-contract.md の
// verb 見出し一覧との差集合チェック) のためだけ。verb 名の一覧が要るだけなので
// `Object.keys(ALLOWED_FLAGS)` を使う想定。
export const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  "init": new Set([
    "state-dir",
    "tracker",
    "source",
    "git-common-dir",
    "lock-retry-ms",
    "lock-max-retries",
  ]),
  "get": new Set(["state-dir"]),
  "validate": new Set(["state-dir"]),
  "session-touch": new Set(["state-dir", "id", "cleanup-stale-min"]),
  "sessions-alive": new Set(["state-dir", "alive-max-min"]),
  "history-append": new Set([
    "state-dir",
    "line",
    "lock-retry-ms",
    "lock-max-retries",
  ]),
  // --- タスク進行 ---
  "approve": new Set(["state-dir", "id", "title", ...LOCK_FLAGS]),
  "claim": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "set-gate": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "set-worktree": new Set([
    "state-dir",
    "id",
    "worktree",
    "base",
    "drop-withdrawn-branch",
    ...LOCK_FLAGS,
  ]),
  "set-executor": new Set([
    "state-dir",
    "id",
    "executor",
    "session",
    ...LOCK_FLAGS,
  ]),
  "touch-executor": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "set-takeover": new Set(["state-dir", "id", "at", "clear", ...LOCK_FLAGS]),
  "phase-pass": new Set(["state-dir", "id", "from", "to", ...LOCK_FLAGS]),
  "phase-fail": new Set(["state-dir", "id", "phase", ...LOCK_FLAGS]),
  "block": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  "dequeue": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "finalize-start": new Set(["state-dir", "id", "from", ...LOCK_FLAGS]),
  "in-review": new Set([
    "state-dir",
    "id",
    "commits",
    "ref",
    "branch",
    "tip",
    "base",
    "clear-session",
    ...LOCK_FLAGS,
  ]),
  // --- 追従 ---
  "watch-init": new Set([
    "state-dir",
    "id",
    "session",
    "preserve-handled",
    ...LOCK_FLAGS,
  ]),
  "watch-set": new Set([
    "state-dir",
    "id",
    "proc",
    "sig",
    "head",
    "ci",
    "checked-at",
    "errors-inc",
    "errors-reset",
    "note",
    "state",
    "session",
    ...LOCK_FLAGS,
  ]),
  "fix-pending": new Set([
    "state-dir",
    "id",
    "pending-ids",
    "findings",
    ...LOCK_FLAGS,
  ]),
  "fix-start": new Set([
    "state-dir",
    "id",
    "session",
    "reset-attempts",
    ...LOCK_FLAGS,
  ]),
  "fix-done": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "review-only": new Set(["state-dir", "id", "items-json", ...LOCK_FLAGS]),
  // --- 載せ直し ---
  "rebase-record": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    "reason",
    "kind",
    "cause",
    "report",
    ...LOCK_FLAGS,
  ]),
  "rebase-resolve-pending": new Set([
    "state-dir",
    "id",
    "from-tip",
    ...LOCK_FLAGS,
  ]),
  "rebase-start": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "rebase-done": new Set(["state-dir", "id", "tip", ...LOCK_FLAGS]),
  "rebase-give-up": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    ...LOCK_FLAGS,
  ]),
  // --- 回収と候補 ---
  "recover-done": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw-remove": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  "withdraw-asked": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "candidates-set": new Set([
    "state-dir",
    "candidates-json",
    ...LOCK_FLAGS,
  ]),
  "candidates-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "promoted-add": new Set(["state-dir", "ids", ...LOCK_FLAGS]),
  "promoted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "relisted-add": new Set(["state-dir", "id", "seen-at", ...LOCK_FLAGS]),
  "relisted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "restore": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  // --- 全体 ---
  "stalled-set": new Set(["state-dir", "value", "bump", ...LOCK_FLAGS]),
};

function parseFlags(rest: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      throw new CliError("usage", `unexpected argument: ${tok}`);
    }
    const name = tok.slice(2);
    const value = rest[i + 1];
    if (value === undefined) {
      throw new CliError("usage", `flag --${name} requires a value`);
    }
    flags.set(name, value);
    i++;
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new CliError("usage", `missing required flag: --${name}`);
  }
  return value;
}

function intFlag(
  flags: Map<string, string>,
  name: string,
  defaultValue: number,
): number {
  if (!flags.has(name)) return defaultValue;
  const raw = flags.get(name)!;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CliError("usage", `invalid --${name}: ${raw}`);
  }
  return n;
}

function validateSessionId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/")) {
    throw new CliError("usage", `invalid --id: ${JSON.stringify(id)}`);
  }
}

// ---------------------------------------------------------------------------
// verb 実装
//
// 各 cmdXxx は「flag 抽出・usage 検証 → lock 越しに state-transitions.ts の対応関数へ
// 委譲 → 成功 JSON 組み立て」の薄い形。事前条件チェックと状態オブジェクトの書き換え本体は
// state-transitions.ts 側にある。
// ---------------------------------------------------------------------------

async function cmdInit(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const tracker = requireFlag(flags, "tracker");
  const source = requireFlag(flags, "source");
  const gitCommonDir = requireFlag(flags, "git-common-dir");
  const retryMs = intFlag(flags, "lock-retry-ms", DEFAULT_LOCK_RETRY_MS);
  const maxRetries = intFlag(
    flags,
    "lock-max-retries",
    DEFAULT_LOCK_MAX_RETRIES,
  );

  await Deno.mkdir(stateDir, { recursive: true });
  await acquireLock(stateDir, { retryMs, maxRetries });
  let result: LockedApplyResult;
  try {
    // exclude → state.json の順 (state.json より前に権限エラーで落ちれば state.json は
    // 一切触られない。単一の lock がこの2ステップ全体を覆うので、init の並行呼び出しでも
    // exclude と state.json の適用がインターリーブしない)。
    await ensureExcludeLine(stateDir, gitCommonDir);
    result = await applyStateChange(
      stateDir,
      (current) => applyInit(current, tracker, source, nowIso()),
    );
  } finally {
    await releaseLock(stateDir);
  }

  return {
    ok: true,
    created: result.wasMissing,
    state_dir: await Deno.realPath(stateDir),
  };
}

async function cmdGet(stateDir: string): Promise<unknown> {
  return transitionsGet(await readState(stateDir));
}

async function cmdValidate(
  stateDir: string,
): Promise<Record<string, unknown>> {
  const parsed = await readState(stateDir);
  return transitionsValidate(parsed);
}

async function cmdSessionTouch(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  validateSessionId(id);
  const cleanupStaleMin = intFlag(
    flags,
    "cleanup-stale-min",
    DEFAULT_CLEANUP_STALE_MIN,
  );

  const sessionsDir = joinPath(stateDir, "sessions");
  await Deno.mkdir(sessionsDir, { recursive: true });
  const targetPath = joinPath(sessionsDir, id);
  const now = new Date(nowMs());
  try {
    await Deno.stat(targetPath);
    await Deno.utime(targetPath, now, now);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(targetPath, "");
      await Deno.utime(targetPath, now, now);
    } else {
      throw e;
    }
  }

  const cleaned: string[] = [];
  for await (const entry of Deno.readDir(sessionsDir)) {
    if (!entry.isFile || entry.name === id) continue;
    const statPauseMs = readSessionStatPauseMs();
    if (statPauseMs > 0) await sleep(statPauseMs);
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(joinPath(sessionsDir, entry.name));
    } catch (e) {
      // 他セッションの同時掃除 (このループ自体、または stale 回収) が自分より先に
      // この要素を消していた: lock を取らない設計 (docs/state-cli-contract.md の lock
      // 契約節) の帰結として起こりうる TOCTOU なので、消えている == 目的達成として飛ばす。
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    const mtime = info.mtime;
    if (!mtime) continue;
    if (isSessionStale(nowMs(), mtime.getTime(), cleanupStaleMin)) {
      const removePauseMs = readSessionRemovePauseMs();
      if (removePauseMs > 0) await sleep(removePauseMs);
      try {
        await Deno.remove(joinPath(sessionsDir, entry.name));
      } catch (e) {
        // stat の後、remove の前に他セッションが同じ要素を消していた場合も同様に飛ばす。
        // 自分が消したわけではないので cleaned には積まない。
        if (e instanceof Deno.errors.NotFound) continue;
        throw e;
      }
      cleaned.push(entry.name);
    }
  }

  return { ok: true, id, cleaned };
}

async function cmdSessionsAlive(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const aliveMaxMin = intFlag(flags, "alive-max-min", DEFAULT_ALIVE_MAX_MIN);
  const sessionsDir = joinPath(stateDir, "sessions");

  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(sessionsDir)) entries.push(entry);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { ok: true, alive: [] };
    }
    throw e;
  }

  const alive: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const statPauseMs = readSessionStatPauseMs();
    if (statPauseMs > 0) await sleep(statPauseMs);
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(joinPath(sessionsDir, entry.name));
    } catch (e) {
      // readDir で列挙した後、他セッションの session-touch 掃除がこの要素を消していた:
      // sessions-alive は lock を取らない読み取り専用 verb なので、これは正常な TOCTOU。
      // 消えている == もう生存していないので、alive に含めず飛ばす。
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    const mtime = info.mtime;
    if (!mtime) continue;
    if (isSessionAlive(nowMs(), mtime.getTime(), aliveMaxMin)) {
      alive.push(entry.name);
    }
  }
  return { ok: true, alive };
}

async function cmdHistoryAppend(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  if (!flags.has("line")) {
    throw new CliError("usage", "missing required flag: --line");
  }
  const line = flags.get("line")!;
  const retryMs = intFlag(flags, "lock-retry-ms", DEFAULT_LOCK_RETRY_MS);
  const maxRetries = intFlag(
    flags,
    "lock-max-retries",
    DEFAULT_LOCK_MAX_RETRIES,
  );

  const result = await withExistingStateLock(
    stateDir,
    { retryMs, maxRetries },
    (current) => applyHistoryAppend(current, line),
  );

  const history = result.value.history as unknown[];
  return { ok: true, history_length: history.length };
}

// ---------------------------------------------------------------------------
// state-cli-verbs: 遷移 verb 群
//
// lock 系フラグの取り出しは共通なので、各 cmd 関数の先頭でこのヘルパを呼ぶ。
// ---------------------------------------------------------------------------

function lockOpts(
  flags: Map<string, string>,
): { retryMs: number; maxRetries: number } {
  return {
    retryMs: intFlag(flags, "lock-retry-ms", DEFAULT_LOCK_RETRY_MS),
    maxRetries: intFlag(flags, "lock-max-retries", DEFAULT_LOCK_MAX_RETRIES),
  };
}

// --- タスク進行 ---------------------------------------------------------

async function cmdApprove(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const title = requireFlag(flags, "title");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyApprove(current, id, title),
  );
  return { ok: true, id };
}

async function cmdClaim(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyClaim(item, index, state, session),
  );
  return { ok: true, id, status: "in_progress", phase: "research", session };
}

async function cmdSetGate(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applySetGate(item, index, state),
  );
  return { ok: true, id, gate: "light", phase: "research+plan" };
}

async function cmdSetWorktree(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const worktree = requireFlag(flags, "worktree");
  const base = requireFlag(flags, "base");
  const drop = boolFlag(flags, "drop-withdrawn-branch");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applySetWorktree(item, index, state, worktree, base, drop),
  );
  return { ok: true, id, worktree, base };
}

async function cmdSetExecutor(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const executor = requireFlag(flags, "executor");
  const session = requireFlag(flags, "session");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applySetExecutor(item, index, state, executor, session, nowIso()),
  );
  return { ok: true, id, executor, session };
}

async function cmdTouchExecutor(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const sessionIfUnowned = flags.get("session");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyTouchExecutor(item, index, state, sessionIfUnowned, nowIso()),
  );
  return { ok: true, id };
}

async function cmdSetTakeover(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const hasAt = flags.has("at");
  const clear = boolFlag(flags, "clear");
  if (hasAt === clear) {
    throw new CliError("usage", "exactly one of --at or --clear is required");
  }
  const atValue = hasAt ? flags.get("at")! : null;
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applySetTakeover(item, index, state, atValue),
  );
  return { ok: true, id, takeover_at: atValue };
}

async function cmdPhasePass(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const from = requireEnumFlag(flags, "from", PHASE_VALUES);
  const to = requireEnumFlag(flags, "to", PHASE_VALUES);
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyPhasePass(item, index, state, from, to),
  );
  return { ok: true, id, phase: to };
}

async function cmdPhaseFail(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const phase = requireEnumFlag(flags, "phase", PHASE_VALUES);
  let attempts = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyPhaseFail(item, index, state, phase);
    attempts = result.attempts;
    return result.state;
  });
  return { ok: true, id, attempts };
}

async function cmdBlock(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const reason = requireFlag(flags, "reason");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyBlock(item, index, state, reason),
  );
  return { ok: true, id, status: "blocked" };
}

async function cmdDequeue(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyDequeue(item, index, state),
  );
  return { ok: true, id };
}

async function cmdFinalizeStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  // "rebase_fix" は state-cli-verbs では対象外だったが、SKILL.md の設計 (rebase_fix PASS も
  // report/pr_fix と同じく finalize を経て in-review へ戻る) には含まれる。ここに含めないと、
  // 載せ直しの衝突解消 (解決サイクル) が PASS しても finalize へ進めなくなる。
  const from = requireEnumFlag(flags, "from", [
    "report",
    "pr_fix",
    "rebase_fix",
  ]);
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyFinalizeStart(item, index, state, from),
  );
  return { ok: true, id, phase: "finalize" };
}

async function cmdInReview(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const hasRef = flags.has("ref");
  const hasBranch = flags.has("branch");
  const hasBase = flags.has("base");
  const hasCommits = flags.has("commits");
  const hasTip = flags.has("tip");
  const freshGroup = hasRef || hasBranch || hasBase || hasCommits;
  if (freshGroup && !(hasRef && hasBranch && hasBase && hasCommits)) {
    throw new CliError(
      "usage",
      "--ref/--branch/--base/--commits must all be given together (or all omitted)",
    );
  }
  if (!freshGroup && hasTip) {
    throw new CliError(
      "usage",
      "--tip requires --ref/--branch/--base/--commits",
    );
  }
  let commits = 0;
  if (hasCommits) {
    commits = requireIntFlag(flags, "commits");
    if (commits === 0 && hasTip) {
      throw new CliError(
        "usage",
        "--tip must not be given when --commits is 0",
      );
    }
    if (commits >= 1 && !hasTip) {
      throw new CliError("usage", "--tip is required when --commits >= 1");
    }
  }
  const ref = flags.get("ref");
  const branch = flags.get("branch");
  const base = flags.get("base");
  const tip = flags.get("tip");
  const clearSession = boolFlag(flags, "clear-session");

  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyInReview(item, index, state, {
        freshGroup,
        ref,
        branch,
        tip,
        base,
        commits,
        clearSession,
      }),
  );
  return { ok: true, id, status: "in_review" };
}

// --- 追従 -----------------------------------------------------------------

async function cmdWatchInit(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const preserve = boolFlag(flags, "preserve-handled");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyWatchInit(item, index, state, session, preserve),
  );
  return { ok: true, id };
}

async function cmdWatchSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: WatchSetFields = { errorsInc: false, errorsReset: false };
  const hasProc = flags.has("proc");
  if (hasProc) fields.proc = nullableFlag(flags.get("proc")!);
  const hasSig = flags.has("sig");
  if (hasSig) fields.sig = nullableFlag(flags.get("sig")!);
  const hasHead = flags.has("head");
  if (hasHead) fields.head = nullableFlag(flags.get("head")!);
  const hasCi = flags.has("ci");
  if (hasCi) {
    const raw = flags.get("ci")!;
    if (
      raw !== "null" &&
      !["passing", "failing", "pending", "none"].includes(raw)
    ) {
      throw new CliError("usage", `invalid --ci: ${raw}`);
    }
    fields.ci = raw === "null" ? null : raw;
  }
  const hasCheckedAt = flags.has("checked-at");
  if (hasCheckedAt) fields.checkedAt = nullableFlag(flags.get("checked-at")!);
  const errorsInc = boolFlag(flags, "errors-inc");
  const errorsReset = boolFlag(flags, "errors-reset");
  if (errorsInc && errorsReset) {
    throw new CliError(
      "usage",
      "--errors-inc and --errors-reset are mutually exclusive",
    );
  }
  fields.errorsInc = errorsInc;
  fields.errorsReset = errorsReset;
  const hasNote = flags.has("note");
  if (hasNote) fields.note = nullableFlag(flags.get("note")!);
  const hasState = flags.has("state");
  if (hasState) {
    const stateVal = flags.get("state")!;
    if (!["watching", "stopped"].includes(stateVal)) {
      throw new CliError("usage", `invalid --state: ${stateVal}`);
    }
    fields.state = stateVal as "watching" | "stopped";
  }
  const hasSession = flags.has("session");
  if (hasSession) fields.session = nullableFlag(flags.get("session")!);
  if (
    hasSession && fields.session !== null && hasState &&
    fields.state === "stopped"
  ) {
    throw new CliError(
      "usage",
      "--session <non-null> cannot be combined with --state stopped (which already nulls session)",
    );
  }
  const anyGiven = hasProc || hasSig || hasHead || hasCi || hasCheckedAt ||
    errorsInc || errorsReset || hasNote || hasState || hasSession;
  if (!anyGiven) {
    throw new CliError("usage", "watch-set requires at least one field flag");
  }

  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWatchSet(item, index, state, fields, nowIso()),
  );
  return { ok: true, id };
}

async function cmdFixPending(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const pendingIds = parseCsv(requireFlag(flags, "pending-ids"));
  const findings = requireFlag(flags, "findings");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyFixPending(item, index, state, pendingIds, findings),
  );
  return { ok: true, id };
}

async function cmdFixStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const reset = boolFlag(flags, "reset-attempts");
  let started = false;
  let fixAttempts = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyFixStart(item, index, state, session, reset);
    started = result.started;
    fixAttempts = result.fixAttempts;
    return result.state;
  });
  return { ok: true, id, started, fix_attempts: fixAttempts };
}

async function cmdFixDone(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyFixDone(item, index, state),
  );
  return { ok: true, id };
}

// review_only の指摘は、ここでは watch.handled に一切触れず watch.review_only に
// id ごと upsert するだけにする。watch.handled は fix-done を経由して実際に
// 修正したものだけを表す。同じ版 (updated_at) のまま繰り返し観測された id を毎回
// 報告し直させないため、この verb は「今回新規に見えた、または前回記録した
// updated_at から版が進んだ id」を new_or_changed として返す — 呼び出し側 (SKILL.md)
// はこれだけを報告する。updated_at が null (版を取得できなかった) の id は比較の
// しようが無いので、安全側に倒して観測されるたびに毎回 new_or_changed に含める。
function parseReviewOnlyItems(raw: string): ReviewOnlyEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "usage",
      `invalid --items-json: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError("usage", "--items-json must be a JSON array");
  }
  const items: ReviewOnlyEntry[] = [];
  for (const it of parsed) {
    if (!isRecord(it) || typeof it.id !== "string") {
      throw new CliError("usage", "each item needs a string id");
    }
    if (
      !("updated_at" in it) ||
      (typeof it.updated_at !== "string" && it.updated_at !== null)
    ) {
      throw new CliError(
        "usage",
        "each item needs updated_at (string or null)",
      );
    }
    items.push({ id: it.id, updated_at: it.updated_at as string | null });
  }
  return items;
}

async function cmdReviewOnly(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const items = parseReviewOnlyItems(requireFlag(flags, "items-json"));
  let newOrChanged: string[] = [];
  let total = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyReviewOnly(item, index, state, items);
    newOrChanged = result.newOrChanged;
    total = result.total;
    return result.state;
  });
  return {
    ok: true,
    id,
    new_or_changed: newOrChanged,
    review_only_total: total,
  };
}

// --- 載せ直し ---------------------------------------------------------------

const REBASE_REASONS = ["dirty", "diverged", "conflict", "push"] as const;
const REBASE_KINDS = [
  "superseded",
  "overlap",
  "adjacent",
  "structural",
  "other",
] as const;

async function cmdRebaseRecord(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const blockedOnto = requireFlag(flags, "blocked-onto");
  const reason = requireEnumFlag(flags, "reason", REBASE_REASONS);
  const kind = flags.get("kind");
  if (
    kind !== undefined && !(REBASE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new CliError("usage", `invalid --kind: ${kind}`);
  }
  const cause = flags.get("cause");
  const report = flags.get("report");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseRecord(
        item,
        index,
        state,
        blockedOnto,
        reason,
        kind,
        cause,
        report,
        nowIso(),
      ),
  );
  return { ok: true, id };
}

async function cmdRebaseResolvePending(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fromTip = requireFlag(flags, "from-tip");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseResolvePending(item, index, state, fromTip),
  );
  return { ok: true, id };
}

async function cmdRebaseStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseStart(item, index, state, session),
  );
  return { ok: true, id, status: "in_progress", phase: "rebase_fix" };
}

async function cmdRebaseDone(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const tip = requireFlag(flags, "tip");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseDone(item, index, state, tip),
  );
  return { ok: true, id, tip };
}

async function cmdRebaseGiveUp(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const blockedOnto = requireFlag(flags, "blocked-onto");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseGiveUp(item, index, state, blockedOnto),
  );
  return { ok: true, id, status: "in_review" };
}

// --- 回収と候補 -------------------------------------------------------------

async function cmdRecoverDone(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRecoverDone(item, index, state),
  );
  return { ok: true, id, status: "done" };
}

async function cmdWithdraw(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWithdraw(item, index, state),
  );
  return { ok: true, id };
}

async function cmdWithdrawRemove(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const reason = requireFlag(flags, "reason");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyWithdrawRemove(item, index, state, reason, nowIso()),
  );
  return { ok: true, id };
}

async function cmdWithdrawAsked(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWithdrawAsked(item, index, state),
  );
  return { ok: true, id };
}

async function cmdCandidatesSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const raw = requireFlag(flags, "candidates-json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "usage",
      `invalid --candidates-json: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError("usage", "--candidates-json must be a JSON array");
  }
  for (const c of parsed) {
    if (
      !isRecord(c) || typeof c.id !== "string" || typeof c.title !== "string"
    ) {
      throw new CliError(
        "usage",
        "each candidate needs at least string id and title",
      );
    }
  }
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyCandidatesSet(current, parsed as unknown[]),
  );
  return { ok: true, count: (parsed as unknown[]).length };
}

async function cmdCandidatesDrop(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyCandidatesDrop(current, id),
  );
  return { ok: true, id };
}

async function cmdPromotedAdd(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const ids = parseCsv(requireFlag(flags, "ids"));
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyPromotedAdd(current, ids),
  );
  return { ok: true, ids };
}

async function cmdPromotedDrop(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyPromotedDrop(current, id),
  );
  return { ok: true, id };
}

async function cmdRelistedAdd(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const seenAt = requireFlag(flags, "seen-at");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyRelistedAdd(current, id, seenAt),
  );
  return { ok: true, id };
}

async function cmdRelistedDrop(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyRelistedDrop(current, id),
  );
  return { ok: true, id };
}

async function cmdRestore(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRestore(item, index, state),
  );
  return { ok: true, id, status: "approved" };
}

// --- 全体 -------------------------------------------------------------------

async function cmdStalledSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const value = requireEnumFlag(flags, "value", [
    "depleted",
    "max_open",
    "null",
  ]);
  const bump = boolFlag(flags, "bump");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) =>
      applyStalledSet(
        current,
        value as "depleted" | "max_open" | "null",
        bump,
        nowIso(),
      ),
  );
  return { ok: true, value: value === "null" ? null : value };
}

// ---------------------------------------------------------------------------
// エラー分類 (main の catch 節がこれで exit code と JSON を決める)
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): { code: ExitCodeName; message: string } | null {
  if (e instanceof CliError) return { code: e.code, message: e.message };
  if (e instanceof Deno.errors.NotCapable) {
    return { code: "permission", message: e.message };
  }
  if (e instanceof Deno.errors.PermissionDenied) {
    return { code: "permission", message: e.message };
  }
  if (e instanceof Deno.errors.NotFound) {
    return { code: "missing", message: (e as Error).message };
  }
  return null;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  try {
    const [verb, ...rest] = argv;
    if (!verb) {
      throw new CliError("usage", "verb is required");
    }
    const allowed = ALLOWED_FLAGS[verb];
    if (!allowed) {
      throw new CliError("usage", `unknown verb: ${verb}`);
    }
    const flags = parseFlags(rest);
    for (const key of flags.keys()) {
      if (!allowed.has(key)) {
        throw new CliError("usage", `unknown flag for ${verb}: --${key}`);
      }
    }
    const stateDir = requireFlag(flags, "state-dir");

    let result: unknown;
    switch (verb) {
      case "init":
        result = await cmdInit(stateDir, flags);
        break;
      case "get":
        result = await cmdGet(stateDir);
        break;
      case "validate":
        result = await cmdValidate(stateDir);
        break;
      case "session-touch":
        result = await cmdSessionTouch(stateDir, flags);
        break;
      case "sessions-alive":
        result = await cmdSessionsAlive(stateDir, flags);
        break;
      case "history-append":
        result = await cmdHistoryAppend(stateDir, flags);
        break;
      case "approve":
        result = await cmdApprove(stateDir, flags);
        break;
      case "claim":
        result = await cmdClaim(stateDir, flags);
        break;
      case "set-gate":
        result = await cmdSetGate(stateDir, flags);
        break;
      case "set-worktree":
        result = await cmdSetWorktree(stateDir, flags);
        break;
      case "set-executor":
        result = await cmdSetExecutor(stateDir, flags);
        break;
      case "touch-executor":
        result = await cmdTouchExecutor(stateDir, flags);
        break;
      case "set-takeover":
        result = await cmdSetTakeover(stateDir, flags);
        break;
      case "phase-pass":
        result = await cmdPhasePass(stateDir, flags);
        break;
      case "phase-fail":
        result = await cmdPhaseFail(stateDir, flags);
        break;
      case "block":
        result = await cmdBlock(stateDir, flags);
        break;
      case "dequeue":
        result = await cmdDequeue(stateDir, flags);
        break;
      case "finalize-start":
        result = await cmdFinalizeStart(stateDir, flags);
        break;
      case "in-review":
        result = await cmdInReview(stateDir, flags);
        break;
      case "watch-init":
        result = await cmdWatchInit(stateDir, flags);
        break;
      case "watch-set":
        result = await cmdWatchSet(stateDir, flags);
        break;
      case "fix-pending":
        result = await cmdFixPending(stateDir, flags);
        break;
      case "fix-start":
        result = await cmdFixStart(stateDir, flags);
        break;
      case "fix-done":
        result = await cmdFixDone(stateDir, flags);
        break;
      case "review-only":
        result = await cmdReviewOnly(stateDir, flags);
        break;
      case "rebase-record":
        result = await cmdRebaseRecord(stateDir, flags);
        break;
      case "rebase-resolve-pending":
        result = await cmdRebaseResolvePending(stateDir, flags);
        break;
      case "rebase-start":
        result = await cmdRebaseStart(stateDir, flags);
        break;
      case "rebase-done":
        result = await cmdRebaseDone(stateDir, flags);
        break;
      case "rebase-give-up":
        result = await cmdRebaseGiveUp(stateDir, flags);
        break;
      case "recover-done":
        result = await cmdRecoverDone(stateDir, flags);
        break;
      case "withdraw":
        result = await cmdWithdraw(stateDir, flags);
        break;
      case "withdraw-remove":
        result = await cmdWithdrawRemove(stateDir, flags);
        break;
      case "withdraw-asked":
        result = await cmdWithdrawAsked(stateDir, flags);
        break;
      case "candidates-set":
        result = await cmdCandidatesSet(stateDir, flags);
        break;
      case "candidates-drop":
        result = await cmdCandidatesDrop(stateDir, flags);
        break;
      case "promoted-add":
        result = await cmdPromotedAdd(stateDir, flags);
        break;
      case "promoted-drop":
        result = await cmdPromotedDrop(stateDir, flags);
        break;
      case "relisted-add":
        result = await cmdRelistedAdd(stateDir, flags);
        break;
      case "relisted-drop":
        result = await cmdRelistedDrop(stateDir, flags);
        break;
      case "restore":
        result = await cmdRestore(stateDir, flags);
        break;
      case "stalled-set":
        result = await cmdStalledSet(stateDir, flags);
        break;
      default:
        throw new CliError("usage", `unknown verb: ${verb}`);
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (e) {
    const classified = classifyError(e);
    if (!classified) throw e;
    console.log(
      JSON.stringify({ error: classified.code, message: classified.message }),
    );
    return EXIT_CODES[classified.code];
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
