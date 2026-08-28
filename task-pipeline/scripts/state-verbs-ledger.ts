// task-pipeline/scripts/state-verbs-ledger.ts
//
// state CLI の **層 3 — 帳簿系 16 verb の cmd 実装**:
//
//   init / get / validate / next / verdict-path / session-touch /
//   sessions-alive / history-append / candidates-set / candidates-drop /
//   promoted-add / promoted-drop / relisted-add / relisted-drop /
//   stalled-set / controller-lease-set
//
// queue エントリの座標 (領域 P × 領域 A) を持たない verb だけがここに居る
// (対応する純関数は state-ledger-v2.ts の LEDGER_VERBS)。**queue エントリを対象にする
// 33 verb は state-verbs-queue.ts** にある。層の一覧は state-io.ts の冒頭。
//
// 各 cmd は「flag 抽出・usage 検証 → lock 越しに純関数へ委譲 → 成功 JSON 組み立て」の
// 薄い形で、判断そのものは持たない。

import { STALLED_VALUES, VERIFIED_PHASE_VALUES } from "./state-model-v2.ts";
import { countTaskLines, deriveNext, parseNextConfig } from "./state-next.ts";
import { deriveVerdictPath, runDirOf } from "./state-verdict-path.ts";
import { checkStateV2 } from "./state-schema-v2.ts";
import {
  applyCandidatesDropV2,
  applyCandidatesSetV2,
  applyCleanupResolveV2,
  applyControllerLeaseSetV2,
  applyHistoryAppendV2,
  applyInitV2,
  applyPromotedAddV2,
  applyPromotedDropV2,
  applyRelistedAddV2,
  applyRelistedDropV2,
  applyStalledSetV2,
  type ControllerLeaseArg,
  getV2,
  HISTORY_MAX_LINES,
  isRecord,
  isSessionAlive,
  isSessionStale,
  normalizeStateV2,
  type StalledArg,
  validateV2,
} from "./state-ledger-v2.ts";
import { CliErrorV2, followOf } from "./state-transitions-v2.ts";
import {
  acquireLock,
  atomicWriteText,
  basenameOf,
  joinPath,
  nowIso,
  nowMs,
  readSessionRemovePauseMs,
  readSessionStatPauseMs,
  readState,
  releaseLock,
  sleep,
} from "./state-io.ts";
import {
  boolFlag,
  DEFAULT_LOCK_MAX_RETRIES,
  DEFAULT_LOCK_RETRY_MS,
  intFlag,
  lockOpts,
  parseCsv,
  requireEnumFlag,
  requireFlag,
  requireIntFlag,
  validateSessionId,
} from "./state-flags.ts";
import {
  applyStateChange,
  type LockedApplyResult,
  withExistingStateLock,
} from "./state-store.ts";

const DEFAULT_CLEANUP_STALE_MIN = 1440;
const DEFAULT_ALIVE_MAX_MIN = 90;

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
// verb 実装
//
// 各 cmdXxx は「flag 抽出・usage 検証 → lock 越しに apply 関数へ委譲 → 成功 JSON 組み立て」
// の薄い形。事前条件チェックと状態オブジェクトの書き換え本体は state-transitions-v2.ts /
// state-ledger-v2.ts 側にある。
// ---------------------------------------------------------------------------

export async function cmdInit(
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

export async function cmdGet(stateDir: string): Promise<unknown> {
  return getV2(await readState(stateDir));
}

export async function cmdValidate(
  stateDir: string,
): Promise<Record<string, unknown>> {
  return validateV2(await readState(stateDir));
}

// ---------------------------------------------------------------------------
// next — 読み取り専用の導出 (設計5節)
//
// **lock を取らない** (get / validate / sessions-alive と同じ扱い)。state.json は
// スキーマ検証してから読み、`task_counts/<session>` の行数だけを追加で読む
// (設計5.1 の「state.json と state ディレクトリ内で読めるもの」)。判断そのものは
// state-next.ts の純関数 deriveNext が持ち、ここは flag 抽出とファイル読みだけを行う。
// ---------------------------------------------------------------------------

// task_counts/<session> の行数。ファイルもディレクトリも無ければ 0 (playbooks/max-tasks.md
// の「無ければ0件」)。数え方は wc -l と同じ (countTaskLines のコメント)。
async function readTasksStarted(
  stateDir: string,
  session: string,
): Promise<number> {
  if (session === "") return 0;
  const path = joinPath(joinPath(stateDir, "task_counts"), session);
  try {
    return countTaskLines(await Deno.readTextFile(path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return 0;
    throw e;
  }
}

export async function cmdNext(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const session = flags.get("session") ?? "";
  if (session !== "") validateSessionId(session);
  const alive = flags.has("alive") ? parseCsv(flags.get("alive")!) : [];
  const now = flags.get("now") ?? nowIso();
  const config = parseNextConfig(flags.get("config"));
  // gh-114: --dead-tasks は空白を許容する (`"t-1, t-2"`) — trim してから空要素を落とす
  // (`"t-1,,t-2"` → 2件)。`--alive` の parseCsv とは異なり、人手/プロンプト経由で組み立てる
  // 値なので空白混入を素直に吸収する。
  const deadEvidence = flags.has("dead-tasks")
    ? parseCsv(flags.get("dead-tasks")!).map((s) => s.trim()).filter((s) =>
      s !== ""
    )
    : [];

  const parsed = await readState(stateDir);
  const check = checkStateV2(parsed);
  if (!check.ok) {
    throw new CliErrorV2("schema", `${check.path}: ${check.message}`);
  }
  const state = normalizeStateV2(parsed as Record<string, unknown>);

  return deriveNext(state, {
    session,
    alive,
    now,
    config,
    tasksStarted: await readTasksStarted(stateDir, session),
    deadEvidence,
  }) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// verdict-path 専用: run dir 直下のファイル名の列挙
//
// `runs/<id>/` は state dir 配下なので、既存の `--allow-read=<state dir>` の範囲で読める
// (権限の拡張は不要)。ディレクトリが無ければ空 — 連番の材料が無いだけで、エラーではない
// (最初のサイクルでは executor が成果物を書く前にここへ来ることもある)。
// **ファイルだけを数える** — `verdicts/` `watch/` `rebase/` といったサブディレクトリを
// 成果物と取り違えないため。
// ---------------------------------------------------------------------------

async function readRunDirEntries(
  stateDir: string,
  id: string,
): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(runDirOf(stateDir, id))) {
      if (entry.isFile) entries.push(entry.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return entries;
}

/**
 * 検証ゲートを起動する直前に、判定 JSON の書き込み先を返す (読み取り専用)。
 *
 * 前提は 3 つで、どれも `conflict`: そのタスクが飛行中であること (`progress == running`
 * かつ `run != null`)、その `run.phase` が検証ゲートを持つフェーズであること
 * (= `finalize` でない)。id が queue に無ければ `missing`。
 */
export async function cmdVerdictPath(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");

  const parsed = await readState(stateDir);
  const check = checkStateV2(parsed);
  if (!check.ok) {
    throw new CliErrorV2("schema", `${check.path}: ${check.message}`);
  }
  const state = normalizeStateV2(parsed as Record<string, unknown>);

  const item = state.queue.find((entry) => entry.id === id);
  if (item === undefined) {
    throw new CliErrorV2("missing", `id not found in queue: ${id}`);
  }
  const run = item.run;
  if (item.progress !== "running" || run === null) {
    throw new CliErrorV2(
      "conflict",
      `verdict-path requires progress==running with a run: ${id} is ${item.progress}`,
    );
  }
  if (!(VERIFIED_PHASE_VALUES as readonly string[]).includes(run.phase)) {
    throw new CliErrorV2(
      "conflict",
      `phase has no verification gate: ${run.phase}`,
    );
  }

  const derivation = deriveVerdictPath({
    stateDir,
    id,
    phase: run.phase,
    attempt: run.attempts,
    findings: followOf(item)?.asks.fix?.findings ?? null,
    runDirEntries: await readRunDirEntries(stateDir, id),
  });

  return { ok: true, id, ...derivation };
}

export async function cmdSessionTouch(
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

export async function cmdSessionsAlive(
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

// 上限超過で history から落ちた行を history-archive.ndjson へ追記する (gh-58)。
// 1行 = 元の history 文字列を JSON エンコードしたもの — --line の値に埋め込みの
// 改行が入っていても (CLI 引数として禁止されていないので、schema 上も許される)
// 1エントリ = 1行のまま保てる。state.json の原子的書き込みより**先に**呼ぶこと
// (cmdHistoryAppend 参照): 途中終了時に「行は残るが重複しうる」側に倒し、
// 「行を失う」側には倒さない。
async function appendHistoryArchive(
  stateDir: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) return;
  const path = joinPath(stateDir, "history-archive.ndjson");
  const content = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  await Deno.writeTextFile(path, content, { append: true, create: true });
}

export async function cmdHistoryAppend(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  if (!flags.has("line")) {
    throw new CliErrorV2("usage", "missing required flag: --line");
  }
  const line = flags.get("line")!;
  let archived = 0;
  const next = await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    async (current) => {
      const { state, dropped } = applyHistoryAppendV2(
        current,
        line,
        HISTORY_MAX_LINES,
      );
      if (dropped.length > 0) {
        await appendHistoryArchive(stateDir, dropped);
        archived = dropped.length;
      }
      return state;
    },
  );
  return { ok: true, history_length: next.history.length, archived };
}

// --- 候補・帳簿 -------------------------------------------------------------

export async function cmdCandidatesSet(
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

export async function cmdCandidatesDrop(
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

export async function cmdPromotedAdd(
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

export async function cmdPromotedDrop(
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

export async function cmdRelistedAdd(
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

export async function cmdRelistedDrop(
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

export async function cmdStalledSet(
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

// controller-lease-set — フラグの形状の誤り (取得なのに session/epoch が無い、id が使えない
// 形) は usage、リースの持ち主が想定と違うのは conflict、という切り分けをここで済ませてから
// applyControllerLeaseSetV2 に渡す。
export async function cmdControllerLeaseSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const clear = boolFlag(flags, "clear");
  const session = flags.get("session");
  if (session !== undefined) validateSessionId(session);
  const epoch = flags.has("epoch") ? requireIntFlag(flags, "epoch") : null;
  let arg: ControllerLeaseArg;
  if (clear) {
    arg = { clear: true, session: session ?? null, epoch };
  } else {
    if (session === undefined || epoch === null) {
      throw new CliErrorV2(
        "usage",
        "controller-lease-set requires --session and --epoch (or --clear true)",
      );
    }
    arg = { clear: false, session, epoch };
  }
  const next = await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyControllerLeaseSetV2(current, arg, nowIso()),
  );
  return { ok: true, controller_lease: next.controller_lease ?? null };
}

// cleanup-resolve — Driver のスイープが Cleanup Intent 1 件に決着をつける入口 (gh-157)。
// `--error` の有無だけが分岐で、付いていれば「まだ終わっていない」として残す。
export async function cmdCleanupResolve(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const error = flags.get("error") ?? null;
  const next = await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyCleanupResolveV2(current, id, error),
  );
  const remaining = next.cleanup_outbox.find((e) => e.id === id) ?? null;
  return {
    ok: true,
    id,
    resolved: remaining === null,
    attempts: remaining?.attempts ?? 0,
    cleanup_outbox: next.cleanup_outbox.length,
  };
}
