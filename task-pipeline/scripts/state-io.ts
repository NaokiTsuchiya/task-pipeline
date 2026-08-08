// task-pipeline/scripts/state-io.ts
//
// state CLI の **層 0 — Deno に触る基盤**。時刻・パス・原子的書き込み・state.json の
// 読み取り・lock (排他) だけを持ち、状態モデルの語彙を 1 つも知らない。
//
// 層の構成 (依存は上から下への一方向。import 文がそのまま層の宣言である):
//
//   層 0  state-io.ts       … このファイル。Deno API を触る唯一の場所 (+ verb 実装のファイル操作)
//   層 1  state-flags.ts    … 引数パース (純粋)
//   層 2  state-store.ts    … lock 越しの読み直し・検証・書き込みの glue
//   層 3  state-verbs-*.ts  … 47 verb の cmd 実装 (帳簿系 / queue エントリ系)
//   層 4  state-dispatch.ts … ALLOWED_FLAGS と HANDLERS (verb 名 → 実装の表)
//   層 5  state.ts          … エントリポイント (終了コード・エラー分類・main)
//
// このファイルが依存してよいのは CliErrorV2 (層外の共通エラー型) だけである。

import { CliErrorV2 } from "./state-transitions-v2.ts";

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

export function nowMs(): number {
  const override = tryReadEnv("STATE_TEST_NOW_MS");
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

function readTestPauseMs(): number {
  const raw = tryReadEnv("STATE_TEST_PAUSE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function readSessionStatPauseMs(): number {
  const raw = tryReadEnv("STATE_TEST_SESSION_STAT_PAUSE_MS");
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function readSessionRemovePauseMs(): number {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 小さなパスユーティリティ (外部依存を増やさないため node:path/@std/path を使わず自前で書く)
// ---------------------------------------------------------------------------

export function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// 原子的書き込み (tmp に書いて rename)
// ---------------------------------------------------------------------------

export async function atomicWriteText(
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

export async function readState(stateDir: string): Promise<unknown> {
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

export async function acquireLock(
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

export async function releaseLock(stateDir: string): Promise<void> {
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
