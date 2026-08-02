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
// verb 一覧: init / get / validate / session-touch / sessions-alive / history-append
// 契約 (終了コード・JSON出力・verb別引数) の詳細は task-pipeline/docs/state-cli-contract.md。
//
// テストの回し方: sh tests/state-cli.test.sh (deno 不在なら SKIP + exit 0)
//   直接実行する場合: deno test --allow-read --allow-write --allow-env --allow-run
//     task-pipeline/scripts/state.test.ts
//
// 実行時の外部依存はゼロ (npm:/jsr: 参照なし)。state-schema.ts (別タスクで実装済み) の
// checkState だけを import し、スキーマの詳細はここで再実装しない。

import { checkState } from "./state-schema.ts";

// ---------------------------------------------------------------------------
// 終了コード契約 (docs/state-cli-contract.md と state.test.ts の T-D1 で突き合わせる
// ソース・オブ・トゥルース)
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  usage: 10,
  lock: 11,
  schema: 12,
  missing: 13,
  permission: 14,
} as const;

type ExitCodeName = keyof typeof EXIT_CODES;

class CliError extends Error {
  constructor(public readonly code: ExitCodeName, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_VERSION = 1;
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
  await Deno.remove(joinPath(stateDir, "lock"), { recursive: true });
}

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
): Record<string, unknown> {
  return {
    tracker,
    source,
    updated_at: nowIso(),
    queue: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    schema_version: DEFAULT_SCHEMA_VERSION,
  };
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

const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
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
    result = await applyStateChange(stateDir, (current) => {
      if (current === undefined) {
        return buildFreshState(tracker, source);
      }
      // 既存ファイルは --tracker/--source の値では書き換えない。schema_version が
      // 既に有れば (どんな値でも) 一切書き込まない真の no-op、無ければ末尾に付与する
      // 正規化だけを行う。
      if ("schema_version" in current) return undefined;
      return withSchemaVersion(current);
    });
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
  return await readState(stateDir);
}

async function cmdValidate(
  stateDir: string,
): Promise<Record<string, unknown>> {
  const parsed = await readState(stateDir);
  const check = checkState(parsed);
  if (!check.ok) {
    throw new CliError("schema", `${check.path}: ${check.message}`);
  }
  return { ok: true };
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
    const info = await Deno.stat(joinPath(sessionsDir, entry.name));
    const mtime = info.mtime;
    if (!mtime) continue;
    const ageMin = (nowMs() - mtime.getTime()) / 60_000;
    if (ageMin > cleanupStaleMin) {
      await Deno.remove(joinPath(sessionsDir, entry.name));
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
    const info = await Deno.stat(joinPath(sessionsDir, entry.name));
    const mtime = info.mtime;
    if (!mtime) continue;
    const ageMin = (nowMs() - mtime.getTime()) / 60_000;
    if (ageMin < aliveMaxMin) alive.push(entry.name);
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

  const result = await withStateLock(
    stateDir,
    { retryMs, maxRetries },
    (current) => {
      if (current === undefined) {
        throw new CliError("missing", `state.json not found in ${stateDir}`);
      }
      const existingHistory = Array.isArray(current.history)
        ? current.history
        : [];
      const history = [...existingHistory, line];
      const withHistory = { ...current, history, updated_at: nowIso() };
      return withSchemaVersion(withHistory);
    },
  );

  const history = result.value.history as unknown[];
  return { ok: true, history_length: history.length };
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
