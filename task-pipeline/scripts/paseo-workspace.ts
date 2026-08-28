// task-pipeline/scripts/paseo-workspace.ts
//
// gh-157 (Phase3 Task 3-1): タスク 1 件が Paseo 経路で確保した workspace の記録
// (`<state dir>/runs/<id>/paseo-workspace.json`) の読み書き。形は
// `playbooks/agent-launch.md`「所有 workspace の記録と安全な後始末」節の JSON である。
//
// **archive の対象を決められるのはこのファイルだけ**である (`playbooks/agent-launch.md` の
// 安全規則): `paseo workspace ls` には cwd/ラベルの絞り込みが無く、同じ worktree に対して
// 複数のセッション・タスクが workspace を持ちうるので、記録に無い workspace_id を
// archive してはならない。`pendingArchives` がその唯一の入口である。
//
// 純関数 (upsert/markArchived/pendingArchives/parse) と I/O (read/write) を分けてあるのは、
// テストが判定だけを直に踏めるようにするため。テスト: pipeline-driver.test.ts。

/** `paseo-workspace.json` の 1 エントリ。`owned: false` は caller の workspace を継承した
 * ときの監査用の記録で、**archive の対象には決してならない**。 */
export interface WorkspaceEntry {
  readonly workspace_id: string;
  readonly owned: boolean;
  readonly agent_id: string | null;
  readonly role: string;
  readonly recorded_at: string;
  readonly archived_at: string | null;
}

export interface WorkspaceFile {
  readonly schema_version: number;
  readonly workspaces: readonly WorkspaceEntry[];
}

export const WORKSPACE_FILE_SCHEMA_VERSION = 1;

export function workspaceFilePathOf(stateDir: string, id: string): string {
  return `${stateDir}/runs/${id}/paseo-workspace.json`;
}

export class WorkspaceFileError extends Error {}

function entryOf(raw: unknown): WorkspaceEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkspaceFileError("workspaces[] entry is not an object");
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.workspace_id !== "string" || rec.workspace_id === "") {
    throw new WorkspaceFileError("workspaces[].workspace_id is not a string");
  }
  if (typeof rec.owned !== "boolean") {
    throw new WorkspaceFileError("workspaces[].owned is not a boolean");
  }
  return {
    workspace_id: rec.workspace_id,
    owned: rec.owned,
    agent_id: typeof rec.agent_id === "string" ? rec.agent_id : null,
    role: typeof rec.role === "string" ? rec.role : "executor",
    recorded_at: typeof rec.recorded_at === "string" ? rec.recorded_at : "",
    archived_at: typeof rec.archived_at === "string" ? rec.archived_at : null,
  };
}

/** 壊れた記録を「エントリ 0 件」に丸めない — 丸めるとスイープが「後始末するものは無い」と
 * 判断して intent を落とし、記録されたまま archive されない workspace が生まれる。 */
export function parseWorkspaceFile(text: string): WorkspaceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WorkspaceFileError(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceFileError("root is not an object");
  }
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.workspaces)) {
    throw new WorkspaceFileError("workspaces is not an array");
  }
  return {
    schema_version: typeof rec.schema_version === "number"
      ? rec.schema_version
      : WORKSPACE_FILE_SCHEMA_VERSION,
    workspaces: rec.workspaces.map(entryOf),
  };
}

export function emptyWorkspaceFile(): WorkspaceFile {
  return { schema_version: WORKSPACE_FILE_SCHEMA_VERSION, workspaces: [] };
}

/** 同じ `workspace_id` は 1 エントリに畳む (起動ごとに追記するが、同じ workspace を
 * 2 度記録はしない)。takeover は create 直後に `agent_id: null` で 1 回、`paseo run` の
 * 成功後に agentId 入りでもう 1 回呼ぶので、後勝ちの更新になる。 */
export function upsertWorkspaceEntry(
  file: WorkspaceFile,
  entry: WorkspaceEntry,
): WorkspaceFile {
  const index = file.workspaces.findIndex((w) =>
    w.workspace_id === entry.workspace_id
  );
  const workspaces = file.workspaces.slice();
  if (index === -1) {
    workspaces.push(entry);
  } else {
    const existing = workspaces[index];
    // recorded_at は最初に記録した時刻を残す (更新のたびに今へ動くと、記録が
    // いつからあるのかが読めなくなる)。
    workspaces[index] = {
      ...existing,
      ...entry,
      recorded_at: existing.recorded_at || entry.recorded_at,
    };
  }
  return { ...file, workspaces };
}

export function markArchived(
  file: WorkspaceFile,
  workspaceId: string,
  at: string,
): WorkspaceFile {
  const workspaces = file.workspaces.map((w) =>
    w.workspace_id === workspaceId ? { ...w, archived_at: at } : w
  );
  return { ...file, workspaces };
}

/** archive してよいエントリ = **所有していて、まだ畳んでいないもの**だけ。 */
export function pendingArchives(
  file: WorkspaceFile,
): readonly WorkspaceEntry[] {
  return file.workspaces.filter((w) => w.owned && w.archived_at === null);
}

/** 不在は `null` (Paseo 経路を使わなかったタスク)。壊れていれば `WorkspaceFileError`。 */
export async function readWorkspaceFile(
  path: string,
): Promise<WorkspaceFile | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  return parseWorkspaceFile(text);
}

/** tmp + rename の原子的書き込み (state.ts の書き込みと同じ流儀)。読み手が
 * 半分書かれた JSON を掴むと、そのタスクの owned workspace が読めなくなる。 */
export async function writeWorkspaceFile(
  path: string,
  file: WorkspaceFile,
): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await Deno.rename(tmp, path);
}
