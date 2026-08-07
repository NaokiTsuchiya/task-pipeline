// task-pipeline/scripts/state.ts
//
// state.json への読み書きを、排他 (lock) / 原子的書き込み (tmp+rename) / heartbeat /
// スキーマ検証込みで CLI に閉じ込める。オーケストレーター (モデル) はこの CLI を呼ぶだけで、
// state.json の書き込み手順 (task-pipeline/SKILL.md の「state.json の書き込み手順 (排他)」
// 「セッションの所有権」節) を自分で守らなくてよい。
//
// **この CLI は状態モデル v2 (task-pipeline/docs/state-model-v2-2026-08.md) だけを話す。**
// v1 の語彙 (status / phase / gate をタスク直下に持つ形、review.watch / review.rebase) は
// 受け付けない。schema_version 1 の state.json は `init` が一度だけ移行する (設計3.2節)。
//
// 実行形:
//   deno run --no-prompt \
//     --allow-read=<state dir>[,<git common dir>/info] \
//     --allow-write=<state dir>[,<git common dir>/info] \
//     task-pipeline/scripts/state.ts <verb> --state-dir <dir> [verb固有フラグ...]
//
// verb は 45 個で、出所は 2 つある (どちらにも属さない verb は存在しない):
//   - 遷移 32 verb … state-transitions-v2-spec.ts の VERB_SPEC のキー。queue エントリの
//     領域 P × 領域 A の座標を持ち、from/to が宣言されている。
//   - 帳簿 13 verb … state-ledger-v2.ts の LEDGER_VERBS。座標を持たない
//     (init/get/validate/session-touch/sessions-alive/history-append/candidates-*/
//     promoted-*/relisted-*/stalled-set)。
// 契約 (終了コード・JSON出力・verb別引数・前提・不変条件) の詳細は
// task-pipeline/docs/state-cli-contract.md (ALLOWED_FLAGS のキー一覧と見出しの対応を
// state.test.ts の T-D2 が突き合わせている)。
//
// テストの回し方: sh tests/state-cli.test.sh (deno 不在なら SKIP + exit 0)
//   直接実行する場合: deno test --allow-read --allow-write --allow-env --allow-run
//     task-pipeline/scripts/state.test.ts
//
// 実行時の外部依存はゼロ (npm:/jsr: 参照なし)。import するのは v2 のモジュール群
// (state-transitions-v2.ts の apply 群と VERB_SPEC、state-ledger-v2.ts の帳簿系、
// state-model-v2.ts の語彙、state-schema-v2.ts の checkStateV2) だけで、いずれも
// Deno 由来の API を呼ばない純粋関数である。lock・原子的書き込み・heartbeat・権限・
// CLI dispatch・終了コードへの変換はこのファイルに残る。

import { checkStateV2 } from "./state-schema-v2.ts";
import {
  CI_VALUES,
  HUMAN_ATTENTION_REASON_VALUES,
  PHASE_VALUES,
  REBASE_KIND_VALUES,
  REBASE_REASON_VALUES,
  STALLED_VALUES,
  VERIFIED_PHASE_VALUES,
} from "./state-model-v2.ts";
import {
  applyCandidatesDropV2,
  applyCandidatesSetV2,
  applyHistoryAppendV2,
  applyInitV2,
  applyPromotedAddV2,
  applyPromotedDropV2,
  applyRelistedAddV2,
  applyRelistedDropV2,
  applyStalledSetV2,
  finalizeStateV2,
  getV2,
  isRecord,
  isSessionAlive,
  isSessionStale,
  LEDGER_VERBS,
  normalizeStateV2,
  type StalledArg,
  validateV2,
} from "./state-ledger-v2.ts";
import {
  applyAdvance,
  applyAnsweredSet,
  applyApprove,
  applyAttentionSet,
  applyBlock,
  applyClaim,
  applyDequeue,
  applyFixRequest,
  applyFixStart,
  applyMerged,
  applyObserve,
  applyPhaseFail,
  applyProbeExit,
  applyProbeRun,
  applyRebaseApplied,
  applyRebaseForgo,
  applyRebaseGiveUp,
  applyRebaseRequest,
  applyRebaseStart,
  applyRelease,
  applyRestore,
  applyRetire,
  applyReviewOnly,
  applySetExecutor,
  applySetGate,
  applySetTakeover,
  applySetWorktree,
  applyShip,
  applyTouchExecutor,
  applyWithdraw,
  applyWithdrawAsked,
  applyWithdrawRemove,
  assertItemInvariantsV2,
  CliErrorV2,
  type ExitCodeName,
  type LedgerEntry,
  type ObserveFields,
  type ProbeExitFields,
  type ProbeRunFields,
  type RebaseRequestArgs,
  requireQueueItem,
  type V2Item,
  type V2Run,
  type V2State,
  VERB_SPEC,
} from "./state-transitions-v2.ts";

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
  // 対象 (queue/candidates/promoted/relisted のエントリ) 自体は存在するが、その verb が
  // 要求する現在のノード (領域 P × 領域 A の座標) やフィールドの前提を満たさない。
  // 「対象が無い」(missing) や「フラグの形状が変」(usage) とは別のビジネスルール違反で、
  // 「前提違反は state を変えずに失敗する」の主対象。
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
// Deno.env.get は --allow-env が無いと NotCapable を投げるので、必ず try で包んで
// undefined に落とす。本番の起動形 (--no-prompt かつ --allow-env 無し) では
// これらのフックは存在しないのと同じ扱いになる。
// ---------------------------------------------------------------------------

function tryReadEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function nowMs(): number {
  const override = tryReadEnv("STATE_TEST_NOW_MS");
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
  const raw = tryReadEnv("STATE_TEST_PAUSE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readSessionStatPauseMs(): number {
  const raw = tryReadEnv("STATE_TEST_SESSION_STAT_PAUSE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readSessionRemovePauseMs(): number {
  const raw = tryReadEnv("STATE_TEST_SESSION_REMOVE_PAUSE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readLockReleasePauseMs(): number {
  const raw = tryReadEnv("STATE_TEST_LOCK_RELEASE_PAUSE_MS");
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
      throw new CliErrorV2("missing", `state.json not found: ${statePath}`);
    }
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliErrorV2(
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
      throw new CliErrorV2("missing", `state dir not found: ${stateDir}`);
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
  throw new CliErrorV2(
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
// 書き込み系 verb が共有する適用ロジック。
// lock は呼び出し側 (withStateLock、または init の手書きの try/finally) が既に持っている
// 前提で、読み直し・スキーマ検証・fn 適用・(必要なら) 原子的書き込みだけを行う。
//
// preCheck: 読み込んだ現在値に checkStateV2 を掛けるか。**init の移行経路だけが false** —
// 移行の入力は v1 の state.json であり、定義から v2 スキーマを満たさないためである
// (移行結果に対する事後検証は下の postCheck が行うので、検査が抜けるわけではない)。
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

  const next = fn(current);
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
// queue エントリを対象にする verb (withQueueLock) と、それ以外のトップレベル配列・
// 新規エントリ追加を対象にする verb (withExistingStateLock) が共有するロック・書き込みの
// glue。前提チェックと状態オブジェクトの書き換え本体は state-transitions-v2.ts /
// state-ledger-v2.ts の対応関数に委譲する (前提違反は必ず CliErrorV2 で表され、
// withStateLock/applyStateChange は書き込みを一切行わずに re-throw する)。
// ---------------------------------------------------------------------------

async function withQueueLock(
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
async function withExistingStateLock(
  stateDir: string,
  opts: { retryMs: number; maxRetries: number },
  mutate: (current: V2State) => V2State,
): Promise<V2State> {
  const result = await withStateLock(stateDir, opts, (current) => {
    if (current === undefined) {
      throw new CliErrorV2("missing", `state.json not found in ${stateDir}`);
    }
    const next = mutate(normalizeStateV2(current));
    return finalizeStateV2(next, nowIso()) as unknown as Record<
      string,
      unknown
    >;
  });
  return result.value as unknown as V2State;
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
    throw new CliErrorV2(
      "usage",
      `invalid --${name}: ${value} (expected one of ${allowed.join(", ")})`,
    );
  }
  return value;
}

function optionalEnumFlag(
  flags: Map<string, string>,
  name: string,
  allowed: readonly string[],
): string | undefined {
  if (!flags.has(name)) return undefined;
  return requireEnumFlag(flags, name, allowed);
}

// 非負整数フラグの唯一の解釈。`Number("")` と `Number(" ")` が 0 になる JS の規則に
// 引きずられないよう、**十進数字だけの文字列**を要求する (空文字・空白・符号付き・
// 指数表記・16 進はすべて usage)。空の値は書き手のバグであって 0 の意図ではない。
function parseIntFlag(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliErrorV2("usage", `invalid --${name}: ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function requireIntFlag(flags: Map<string, string>, name: string): number {
  return parseIntFlag(name, requireFlag(flags, name));
}

// 値なしの真偽フラグ。parseFlags は全フラグに値を要求するので、真偽フラグは規約として
// 「省略 = false」「`--<name> true` = true」の2値だけを受け付ける (それ以外の値は usage)。
function boolFlag(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false;
  if (flags.get(name) !== "true") {
    throw new CliErrorV2(
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

// 書き込み系 verb はすべて --lock-retry-ms/--lock-max-retries を受け付ける。個々の
// エントリでは省略せず明記する — この一覧が state-cli-contract.md との突き合わせテスト
// (T-D2) の一方の入力になるため、実際に受理するフラグと過不足なく一致している必要がある。
const LOCK_FLAGS = ["lock-retry-ms", "lock-max-retries"];

// export するのは state.test.ts のドキュメント突き合わせテスト (state-cli-contract.md の
// verb 見出し一覧との差集合チェック) と、分類ネット (どの verb も VERB_SPEC か
// LEDGER_VERBS のどちらかに属する) のため。
export const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  // --- 帳簿系 (LEDGER_VERBS) ---
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
  "candidates-set": new Set(["state-dir", "candidates-json", ...LOCK_FLAGS]),
  "candidates-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "promoted-add": new Set(["state-dir", "ids", ...LOCK_FLAGS]),
  "promoted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "relisted-add": new Set(["state-dir", "id", "seen-at", ...LOCK_FLAGS]),
  "relisted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "stalled-set": new Set(["state-dir", "value", "bump", ...LOCK_FLAGS]),
  // --- 進行系 (設計2.1) ---
  "approve": new Set(["state-dir", "id", "title", ...LOCK_FLAGS]),
  "claim": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "set-gate": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "advance": new Set(["state-dir", "id", "from", "to", ...LOCK_FLAGS]),
  "phase-fail": new Set(["state-dir", "id", "phase", ...LOCK_FLAGS]),
  "block": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  "dequeue": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "restore": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "retire": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  // --- 完了系 (設計2.2) ---
  "ship": new Set([
    "state-dir",
    "id",
    "commits",
    "ref",
    "branch",
    "tip",
    "base",
    ...LOCK_FLAGS,
  ]),
  "merged": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw": new Set(["state-dir", "id", "note", ...LOCK_FLAGS]),
  "withdraw-asked": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw-remove": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  // --- 要求系 (設計2.1) ---
  "fix-request": new Set(["state-dir", "id", "ids", "findings", ...LOCK_FLAGS]),
  "rebase-request": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    "reason",
    "kind",
    "cause",
    "report",
    "resolve",
    "from-tip",
    ...LOCK_FLAGS,
  ]),
  "rebase-applied": new Set(["state-dir", "id", "tip", ...LOCK_FLAGS]),
  // --- 仕上げ開始系 (設計2.1・2.4) ---
  "fix-start": new Set([
    "state-dir",
    "id",
    "session",
    "reset-attempts",
    ...LOCK_FLAGS,
  ]),
  "rebase-start": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "rebase-give-up": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    ...LOCK_FLAGS,
  ]),
  "rebase-forgo": new Set(["state-dir", "id", "blocked-onto", ...LOCK_FLAGS]),
  // --- 追従系 (設計2.1) ---
  "probe-run": new Set(["state-dir", "id", "proc", "session", ...LOCK_FLAGS]),
  "probe-exit": new Set(["state-dir", "id", "sig", ...LOCK_FLAGS]),
  "release": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "observe": new Set([
    "state-dir",
    "id",
    "head",
    "ci",
    "checked-at",
    "errors-inc",
    "errors-reset",
    "note",
    "sig-clear",
    ...LOCK_FLAGS,
  ]),
  "attention-set": new Set([
    "state-dir",
    "id",
    "auto",
    "human",
    ...LOCK_FLAGS,
  ]),
  "review-only": new Set(["state-dir", "id", "items-json", ...LOCK_FLAGS]),
  "answered-set": new Set(["state-dir", "id", "items-json", ...LOCK_FLAGS]),
  // --- 実行帳簿 (対象が run の中のフィールドになるだけで起動形は v1 と同じ) ---
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
};

function parseFlags(rest: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      throw new CliErrorV2("usage", `unexpected argument: ${tok}`);
    }
    const name = tok.slice(2);
    const value = rest[i + 1];
    if (value === undefined) {
      throw new CliErrorV2("usage", `flag --${name} requires a value`);
    }
    flags.set(name, value);
    i++;
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new CliErrorV2("usage", `missing required flag: --${name}`);
  }
  return value;
}

function intFlag(
  flags: Map<string, string>,
  name: string,
  defaultValue: number,
): number {
  if (!flags.has(name)) return defaultValue;
  return parseIntFlag(name, flags.get(name)!);
}

function validateSessionId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/")) {
    throw new CliErrorV2("usage", `invalid --id: ${JSON.stringify(id)}`);
  }
}

// ---------------------------------------------------------------------------
// verb 実装
//
// 各 cmdXxx は「flag 抽出・usage 検証 → lock 越しに apply 関数へ委譲 → 成功 JSON 組み立て」
// の薄い形。事前条件チェックと状態オブジェクトの書き換え本体は state-transitions-v2.ts /
// state-ledger-v2.ts 側にある。
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
    // preCheck=false: 移行の入力 (schema_version 1 の state.json) は v2 スキーマを
    // 満たさない。移行後の値は applyStateChange の事後検証が必ず見る。
    result = await applyStateChange(
      stateDir,
      (current) => applyInitV2(current, tracker, source, nowIso()),
      false,
    );
  } finally {
    await releaseLock(stateDir);
  }

  return {
    ok: true,
    created: result.wasMissing,
    // 既存の state.json を v2 へ移行したか (2 回目以降の init は false)。
    migrated: !result.wasMissing && result.wrote,
    state_dir: await Deno.realPath(stateDir),
  };
}

async function cmdGet(stateDir: string): Promise<unknown> {
  return getV2(await readState(stateDir));
}

async function cmdValidate(
  stateDir: string,
): Promise<Record<string, unknown>> {
  return validateV2(await readState(stateDir));
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
    throw new CliErrorV2("usage", "missing required flag: --line");
  }
  const line = flags.get("line")!;
  const next = await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyHistoryAppendV2(current, line),
  );
  return { ok: true, history_length: next.history.length };
}

// ---------------------------------------------------------------------------
// 遷移 verb 群
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

// 成功ペイロードに載せる run の値は、書き込んだ state から読み戻す (リテラルの複製を
// 持たない — 初期フェーズや統合フェーズ名を変えたとき、ここが古いまま残る経路を消す)。
function runOf(state: V2State, id: string): V2Run | null {
  return state.queue.find((it) => it.id === id)?.run ?? null;
}

function runFields(state: V2State, id: string): Record<string, unknown> {
  const run = runOf(state, id);
  return {
    kind: run?.kind ?? null,
    gate: run?.gate ?? null,
    phase: run?.phase ?? null,
  };
}

// --- 進行系 ---------------------------------------------------------------

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
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyClaim(item, index, state, session),
  );
  return { ok: true, id, ...runFields(next, id), session };
}

async function cmdSetGate(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applySetGate(item, index, state),
  );
  return { ok: true, id, ...runFields(next, id) };
}

async function cmdAdvance(
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
    (item, index, state) => applyAdvance(item, index, state, from, to),
  );
  return { ok: true, id, phase: to };
}

async function cmdPhaseFail(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  // 検証ゲートを持つフェーズだけを受ける (finalize は検証対象外なので usage)。
  const phase = requireEnumFlag(flags, "phase", VERIFIED_PHASE_VALUES);
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
  return { ok: true, id, progress: "blocked" };
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
  return { ok: true, id, progress: "queued" };
}

async function cmdRetire(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRetire(item, index, state, nowIso()),
  );
  return { ok: true, id, completed: next.completed.length };
}

// --- 完了系 (設計2.2) -------------------------------------------------------

async function cmdShip(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const commits = requireIntFlag(flags, "commits");
  const group = ["ref", "branch", "tip", "base"] as const;
  const given = group.filter((name) => flags.has(name));
  if (commits >= 1 && given.length !== group.length) {
    throw new CliErrorV2(
      "usage",
      "--ref/--branch/--tip/--base are all required when --commits >= 1",
    );
  }
  if (commits === 0 && given.length !== 0) {
    throw new CliErrorV2(
      "usage",
      "--ref/--branch/--tip/--base must all be omitted when --commits is 0",
    );
  }
  const args = {
    commits,
    ref: flags.get("ref"),
    branch: flags.get("branch"),
    tip: flags.get("tip"),
    base: flags.get("base"),
  };

  let notify = "none";
  let mark = false;
  let fixCount = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyShip(item, index, state, args);
    notify = result.notify;
    mark = result.mark;
    fixCount = result.fix_count;
    return result.state;
  });
  // 遷移から導出できる後続指示 (設計2.2)。呼び出し側はこれを見て通知テンプレートと
  // トラッカー更新の要否を決める — 経路の記憶を持たなくてよい。
  return { ok: true, id, notify, mark, fix_count: fixCount };
}

async function cmdMerged(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyMerged(item, index, state),
  );
  return { ok: true, id, artifact: "merged" };
}

async function cmdWithdraw(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const note = flags.get("note");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWithdraw(item, index, state, note),
  );
  return { ok: true, id, artifact: "withdrawn" };
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

// --- 要求系 (設計2.1) -------------------------------------------------------

async function cmdFixRequest(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const ids = parseCsv(requireFlag(flags, "ids"));
  const findings = requireFlag(flags, "findings");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyFixRequest(item, index, state, ids, findings),
  );
  return { ok: true, id, ids };
}

async function cmdRebaseRequest(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const args: RebaseRequestArgs = {
    blockedOnto: requireFlag(flags, "blocked-onto"),
    reason: requireEnumFlag(flags, "reason", REBASE_REASON_VALUES),
    kind: optionalEnumFlag(flags, "kind", REBASE_KIND_VALUES),
    cause: flags.get("cause"),
    report: flags.get("report"),
    fromTip: flags.get("from-tip"),
    // 省略時は既存の resolve を保つ (apply 側が undefined を「触れない」と読む)。
    resolve: flags.has("resolve") ? boolFlag(flags, "resolve") : undefined,
  };
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseRequest(item, index, state, args, nowIso()),
  );
  return { ok: true, id, resolve: args.resolve ?? null };
}

async function cmdRebaseApplied(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const tip = requireFlag(flags, "tip");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseApplied(item, index, state, tip),
  );
  return { ok: true, id, tip };
}

// --- 仕上げ開始系 (設計2.1・2.4) -------------------------------------------

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

async function cmdRebaseStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseStart(item, index, state, session),
  );
  // 入口 (a) 解決サイクル (kind=rebase_fix) と入口 (b) 迂回 (kind 不変) のどちらだったかは
  // 書き込んだ run から読み戻す (設計2.4 — 事後に判別できることが v2 の主張)。
  return { ok: true, id, ...runFields(next, id) };
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
    (item, index, state) =>
      applyRebaseGiveUp(item, index, state, blockedOnto, nowIso()),
  );
  return { ok: true, id, progress: "resting" };
}

async function cmdRebaseForgo(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const blockedOnto = requireFlag(flags, "blocked-onto");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseForgo(item, index, state, blockedOnto, nowIso()),
  );
  return { ok: true, id, ...runFields(next, id) };
}

// --- 追従系 (設計2.1) -------------------------------------------------------

async function cmdProbeRun(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: ProbeRunFields = flags.has("session")
    ? { proc: requireFlag(flags, "proc"), session: flags.get("session")! }
    : { proc: requireFlag(flags, "proc") };
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyProbeRun(item, index, state, fields, nowIso()),
  );
  return { ok: true, id, proc: fields.proc };
}

async function cmdProbeExit(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: ProbeExitFields = flags.has("sig")
    ? { sig: nullableFlag(flags.get("sig")!) }
    : {};
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyProbeExit(item, index, state, fields),
  );
  return { ok: true, id };
}

async function cmdRelease(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRelease(item, index, state),
  );
  return { ok: true, id };
}

async function cmdObserve(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: Record<string, unknown> = {};
  if (flags.has("head")) fields.head = nullableFlag(flags.get("head")!);
  if (flags.has("ci")) {
    const raw = flags.get("ci")!;
    if (raw !== "null" && !(CI_VALUES as readonly string[]).includes(raw)) {
      throw new CliErrorV2("usage", `invalid --ci: ${raw}`);
    }
    fields.ci = raw === "null" ? null : raw;
  }
  if (flags.has("checked-at")) {
    fields.checked_at = nullableFlag(flags.get("checked-at")!);
  }
  if (flags.has("note")) fields.note = nullableFlag(flags.get("note")!);
  const errorsInc = boolFlag(flags, "errors-inc");
  const errorsReset = boolFlag(flags, "errors-reset");
  if (errorsInc && errorsReset) {
    throw new CliErrorV2(
      "usage",
      "--errors-inc and --errors-reset are mutually exclusive",
    );
  }
  if (errorsInc) fields.errorsInc = true;
  if (errorsReset) fields.errorsReset = true;
  if (boolFlag(flags, "sig-clear")) fields.sigClear = true;
  if (Object.keys(fields).length === 0) {
    throw new CliErrorV2("usage", "observe requires at least one field flag");
  }

  let errors = 0;
  let latched = false;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyObserve(item, index, state, fields as ObserveFields);
    errors = result.errors;
    latched = result.latched;
    return result.state;
  });
  // latched は「errors が上限に達して attention→human(errors) に落ちた」ことの通知。
  // 呼び出し側はこれを見て追従を畳む (設計2.1)。
  return { ok: true, id, errors, latched };
}

async function cmdAttentionSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const auto = boolFlag(flags, "auto");
  const hasHuman = flags.has("human");
  if (auto === hasHuman) {
    throw new CliErrorV2(
      "usage",
      "exactly one of --auto or --human <reason> is required",
    );
  }
  const target = auto ? "auto" : requireEnumFlag(
    flags,
    "human",
    HUMAN_ATTENTION_REASON_VALUES,
  );
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyAttentionSet(
        item,
        index,
        state,
        target as Parameters<typeof applyAttentionSet>[3],
      ),
  );
  return { ok: true, id, attention: target };
}

// ledger.review_only は「人の判断が要ると回した」ことを表す語彙で、ledger.handled
// (pr_fix で実際にコードを直した) とも ledger.answered (質問に回答・投稿済み) とも
// 意味が違う。同じ版 (updated_at) のまま繰り返し観測された id を毎回報告し直させない
// ため、この verb は「今回新規に見えた、または前回記録した updated_at から版が進んだ
// id」を new_or_changed として返す — 呼び出し側 (SKILL.md) はこれだけを報告する。
// updated_at が null (版を取得できなかった) の id は比較のしようが無いので、安全側に
// 倒して観測されるたびに毎回 new_or_changed に含める。
function parseLedgerItems(raw: string): LedgerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliErrorV2(
      "usage",
      `invalid --items-json: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliErrorV2("usage", "--items-json must be a JSON array");
  }
  const items: LedgerEntry[] = [];
  for (const it of parsed) {
    if (!isRecord(it) || typeof it.id !== "string") {
      throw new CliErrorV2("usage", "each item needs a string id");
    }
    if (
      !("updated_at" in it) ||
      (typeof it.updated_at !== "string" && it.updated_at !== null)
    ) {
      throw new CliErrorV2(
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
  const items = parseLedgerItems(requireFlag(flags, "items-json"));
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

async function cmdAnsweredSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const items = parseLedgerItems(requireFlag(flags, "items-json"));
  let newOrChanged: string[] = [];
  let total = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyAnsweredSet(item, index, state, items);
    newOrChanged = result.newOrChanged;
    total = result.total;
    return result.state;
  });
  return {
    ok: true,
    id,
    new_or_changed: newOrChanged,
    answered_total: total,
  };
}

// --- 実行帳簿 ---------------------------------------------------------------

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
    throw new CliErrorV2(
      "usage",
      "exactly one of --at or --clear is required",
    );
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

// --- 候補・帳簿 -------------------------------------------------------------

async function cmdCandidatesSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const raw = requireFlag(flags, "candidates-json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliErrorV2(
      "usage",
      `invalid --candidates-json: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliErrorV2("usage", "--candidates-json must be a JSON array");
  }
  for (const c of parsed) {
    if (
      !isRecord(c) || typeof c.id !== "string" || typeof c.title !== "string"
    ) {
      throw new CliErrorV2(
        "usage",
        "each candidate needs at least string id and title",
      );
    }
  }
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyCandidatesSetV2(current, parsed as unknown[]),
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
    (current) => applyCandidatesDropV2(current, id),
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
    (current) => applyPromotedAddV2(current, ids),
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
    (current) => applyPromotedDropV2(current, id),
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
    (current) => applyRelistedAddV2(current, id, seenAt),
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
    (current) => applyRelistedDropV2(current, id),
  );
  return { ok: true, id };
}

async function cmdStalledSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const value = requireEnumFlag(flags, "value", [...STALLED_VALUES, "null"]);
  const bump = boolFlag(flags, "bump");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) =>
      applyStalledSetV2(current, value as StalledArg, bump, nowIso()),
  );
  return { ok: true, value: value === "null" ? null : value };
}

// ---------------------------------------------------------------------------
// エラー分類 (main の catch 節がこれで exit code と JSON を決める)
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): { code: ExitCodeName; message: string } | null {
  if (e instanceof CliErrorV2) return { code: e.code, message: e.message };
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
//
// ディスパッチ表のキー集合は ALLOWED_FLAGS と一致し、その内訳は VERB_SPEC (遷移 32) と
// LEDGER_VERBS (帳簿 13) で尽きる。どちらにも属さない verb を足すと state.test.ts の
// 分類ネットが落ちる。
// ---------------------------------------------------------------------------

type CmdHandler = (
  stateDir: string,
  flags: Map<string, string>,
) => Promise<unknown>;

const HANDLERS: Record<string, CmdHandler> = {
  // 帳簿系
  "init": cmdInit,
  "get": (stateDir) => cmdGet(stateDir),
  "validate": (stateDir) => cmdValidate(stateDir),
  "session-touch": cmdSessionTouch,
  "sessions-alive": cmdSessionsAlive,
  "history-append": cmdHistoryAppend,
  "candidates-set": cmdCandidatesSet,
  "candidates-drop": cmdCandidatesDrop,
  "promoted-add": cmdPromotedAdd,
  "promoted-drop": cmdPromotedDrop,
  "relisted-add": cmdRelistedAdd,
  "relisted-drop": cmdRelistedDrop,
  "stalled-set": cmdStalledSet,
  // 進行系
  "approve": cmdApprove,
  "claim": cmdClaim,
  "set-gate": cmdSetGate,
  "advance": cmdAdvance,
  "phase-fail": cmdPhaseFail,
  "block": cmdBlock,
  "dequeue": cmdDequeue,
  "restore": cmdRestore,
  "retire": cmdRetire,
  // 完了系
  "ship": cmdShip,
  "merged": cmdMerged,
  "withdraw": cmdWithdraw,
  "withdraw-asked": cmdWithdrawAsked,
  "withdraw-remove": cmdWithdrawRemove,
  // 要求系
  "fix-request": cmdFixRequest,
  "rebase-request": cmdRebaseRequest,
  "rebase-applied": cmdRebaseApplied,
  // 仕上げ開始系
  "fix-start": cmdFixStart,
  "rebase-start": cmdRebaseStart,
  "rebase-give-up": cmdRebaseGiveUp,
  "rebase-forgo": cmdRebaseForgo,
  // 追従系
  "probe-run": cmdProbeRun,
  "probe-exit": cmdProbeExit,
  "release": cmdRelease,
  "observe": cmdObserve,
  "attention-set": cmdAttentionSet,
  "review-only": cmdReviewOnly,
  "answered-set": cmdAnsweredSet,
  // 実行帳簿
  "set-worktree": cmdSetWorktree,
  "set-executor": cmdSetExecutor,
  "touch-executor": cmdTouchExecutor,
  "set-takeover": cmdSetTakeover,
};

export async function main(argv: string[]): Promise<number> {
  try {
    const [verb, ...rest] = argv;
    if (!verb) {
      throw new CliErrorV2("usage", "verb is required");
    }
    const allowed = ALLOWED_FLAGS[verb];
    const handler = HANDLERS[verb];
    if (!allowed || !handler) {
      throw new CliErrorV2("usage", `unknown verb: ${verb}`);
    }
    const flags = parseFlags(rest);
    for (const key of flags.keys()) {
      if (!allowed.has(key)) {
        throw new CliErrorV2("usage", `unknown flag for ${verb}: --${key}`);
      }
    }
    const stateDir = requireFlag(flags, "state-dir");

    const result = await handler(stateDir, flags);
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

// ディスパッチ集合が VERB_SPEC ∪ LEDGER_VERBS で尽きることを、型の上でも表明する
// (実行時の検査は state.test.ts の分類ネット)。
export const DISPATCH_VERBS: readonly string[] = Object.keys(ALLOWED_FLAGS);
export const TRANSITION_VERBS: readonly string[] = Object.keys(VERB_SPEC);
export { LEDGER_VERBS };

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
