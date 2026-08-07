// task-pipeline/scripts/state-verbs-ledger.ts
//
// state CLI の **層 3 — 帳簿系 13 verb の cmd 実装**:
//
//   init / get / validate / session-touch / sessions-alive / history-append /
//   candidates-set / candidates-drop / promoted-add / promoted-drop /
//   relisted-add / relisted-drop / stalled-set
//
// queue エントリの座標 (領域 P × 領域 A) を持たない verb だけがここに居る
// (対応する純関数は state-ledger-v2.ts の LEDGER_VERBS)。**queue エントリを対象にする
// 32 verb は state-verbs-queue.ts** にある。層の一覧は state-io.ts の冒頭。
//
// 各 cmd は「flag 抽出・usage 検証 → lock 越しに純関数へ委譲 → 成功 JSON 組み立て」の
// 薄い形で、判断そのものは持たない。

import { STALLED_VALUES } from "./state-model-v2.ts";
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
  getV2,
  isRecord,
  isSessionAlive,
  isSessionStale,
  type StalledArg,
  validateV2,
} from "./state-ledger-v2.ts";
import { CliErrorV2 } from "./state-transitions-v2.ts";
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

export async function cmdHistoryAppend(
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
