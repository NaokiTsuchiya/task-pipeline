// task-pipeline/scripts/pipeline-driver.ts
//
// gh-136 (Phase2 Task 2-1b): #135 の pipeline-dispatch.ts (`planOperation`) を実際に
// 実行する非LLM Deno プロセス。「`state.ts next` 呼び出し → due な1件の DriverOperation
// を実行 → 終了」の 1 サイクルだけを行う CLI である (常駐化・多重ポーリング・デッドマン
// スイッチは Task 2-2/2-3 の範囲。verifier 起動・PASS/FAIL 分岐・advance・
// pr-follow/merge-recovery/rebase 系の kind もこの issue の範囲外)。
//
// 実行する DriverOperation は 4 kind だけである (残りは "deferred" として素通りする):
//   - claim         … `state.ts claim --id <id> --session <self>`
//   - takeover      … `playbooks/agent-launch.md`「Paseo 経路の起動パラメータと読み取り」
//                      節どおりに `paseo run -d --json` を起動し、agentId を
//                      `state.ts set-executor` で記録する。worktree が無いタスクは
//                      `playbooks/worktree.md` の手順で新規に作る (`state.ts set-worktree`)。
//   - status-check / wait
//                    … `paseo wait <agentId> --timeout <n> --json` を呼び、同 playbook の
//                      鮮度規則 3 条件を満たすときだけ `state.ts touch-executor` を呼ぶ。
//                      (「Status check メッセージの送信」「set-takeover への降格」は
//                      inflight.md にあるが、検証ゲート駆動 (停止の扱い) を伴うため
//                      Task 2-2/2-3 に残す — ここでは鮮度判定と touch だけを行う。)
//
// provider・model の解決は `playbooks/agent-launch.md`「provider・model・mode の解決
// 手順」の 4 段 (起動引数 → providers_by_class → providers → 既定の組) をそのまま実装
// する (`docs/orchestration-preferences.md`)。**実在確認・junie 除外・現行ハーネス経路
// フォールバックは実装しない** (この issue は Paseo 経路の 1 サイクルを固めるのが目的)。
//
// 実行形:
//   deno run --allow-read --allow-write --allow-env --allow-run \
//     task-pipeline/scripts/pipeline-driver.ts --state-dir <dir> [--session <id>] \
//     [--alive <csv>] [--now <iso>] [--config <k=v,...>] [--dead-tasks <csv>] \
//     [--wait-timeout-sec <n>] [--paseo-bin <path>] \
//     [--impl-provider <provider>[/<model>]] [--verify-provider <provider>[/<model>]] \
//     [--paseo-new-workspace <local|worktree>] \
//     [--observe [--replay-next <path>] [--loop [--interval-sec <n>] [--max-cycles <n>]]]
//
// テスト: pipeline-driver.test.ts (state.ts / paseo / git をスタブ化した CommandRunner
// で 4 kind それぞれの組み立てを検証)。実行は deno task test
// (リポジトリルートの deno.json が *.test.ts を自動検出する)。

import { planOperation } from "./pipeline-dispatch.ts";
import type {
  DeferredKind,
  DeferredOperation,
  DriverOperation,
  TakeoverOperation,
} from "./pipeline-dispatch.ts";
import type { NextResult, NextTask } from "./state-next.ts";
import type { V2Item, V2State } from "./state-transitions-v2.ts";
import {
  boolFlag,
  intFlag,
  parseFlags,
  requireFlag,
  requireIntFlag,
} from "./state-flags.ts";

// ---------------------------------------------------------------------------
// タスクの class (agent-launch.md「タスクの class」)
// ---------------------------------------------------------------------------

export type TaskClass = "trivial" | "standard" | "high";

/**
 * frontmatter ブロック (`sed -n '2,/^---$/p'` に相当する行の並び) から class を導く。
 * 両方立っていたら `high` を採る (保守側)。**Deno API を呼ばない純粋関数**。
 */
export function deriveTaskClass(frontmatterBlock: string): TaskClass {
  const lines = frontmatterBlock.split("\n").map((line) => line.trim());
  const hasHigh = lines.includes("risk: high");
  const hasLight = lines.includes("gate: light");
  if (hasHigh) return "high";
  if (hasLight) return "trivial";
  return "standard";
}

/**
 * タスクファイルを読んで class を導く。frontmatter が読めない・閉じていないときは
 * `standard` に落とす (agent-launch.md「タスクの class」の規定どおり)。
 */
export async function readTaskClass(taskMdPath: string): Promise<TaskClass> {
  let text: string;
  try {
    text = await Deno.readTextFile(taskMdPath);
  } catch {
    return "standard";
  }
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return "standard";
  const closingOffset = lines.slice(1).findIndex((line) =>
    line.trim() === "---"
  );
  if (closingOffset === -1) return "standard";
  const block = lines.slice(1, 1 + closingOffset).join("\n");
  return deriveTaskClass(block);
}

// ---------------------------------------------------------------------------
// provider・model の解決 (agent-launch.md「provider・model・mode の解決手順」)
// ---------------------------------------------------------------------------

export type Role = "executor" | "verifier";

export interface OrchestrationPrefs {
  readonly providers?: Record<string, string>;
  readonly providers_by_class?: Record<string, Record<string, string>>;
}

export interface LaunchArgs {
  readonly impl_provider?: string;
  readonly verify_provider?: string;
}

export interface ResolvedProvider {
  readonly provider: string;
  readonly model: string | null;
  readonly source:
    | "launch-args"
    | "providers_by_class"
    | "providers"
    | "default";
}

const ROLE_CATEGORY: Record<Role, "impl" | "audit"> = {
  executor: "impl",
  verifier: "audit",
};

// 段4: 既定の組 (実装 = claude 系 / 検証 = omp)。
const DEFAULT_PROVIDER: Record<Role, string> = {
  executor: "claude",
  verifier: "omp",
};

/** `<provider>[/<model>]` を分ける。最初の `/` までが provider (omp のモデル id 自体が
 * `/` を含むため、残り全部が model)。 */
export function splitProviderModel(
  value: string,
): { provider: string; model: string | null } {
  const idx = value.indexOf("/");
  if (idx === -1) return { provider: value, model: null };
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

export function parseOrchestrationPrefs(
  raw: string,
): OrchestrationPrefs | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (data === null || typeof data !== "object") return null;
    return data as OrchestrationPrefs;
  } catch {
    return null;
  }
}

export async function readOrchestrationPrefs(
  homeDir: string,
): Promise<OrchestrationPrefs | null> {
  if (homeDir === "") return null;
  try {
    const text = await Deno.readTextFile(
      `${homeDir}/.paseo/orchestration-preferences.json`,
    );
    return parseOrchestrationPrefs(text);
  } catch {
    return null;
  }
}

/**
 * 4段解決: 起動引数 → providers_by_class → providers → 既定の組。
 * class 行の床 (`providers_by_class.<class>.audit` を書けるのは class `high` だけ) を守る
 * — `standard`/`trivial` の `audit` は無視して段3へ落とす。
 */
export function resolveProviderModel(
  role: Role,
  taskClass: TaskClass,
  launchArgs: LaunchArgs,
  prefs: OrchestrationPrefs | null,
): ResolvedProvider {
  const category = ROLE_CATEGORY[role];

  const launchValue = role === "executor"
    ? launchArgs.impl_provider
    : launchArgs.verify_provider;
  if (launchValue) {
    return { ...splitProviderModel(launchValue), source: "launch-args" };
  }

  const byClassValue = prefs?.providers_by_class?.[taskClass]?.[category];
  if (byClassValue && (category === "impl" || taskClass === "high")) {
    return {
      ...splitProviderModel(byClassValue),
      source: "providers_by_class",
    };
  }

  const providersValue = prefs?.providers?.[category];
  if (providersValue) {
    return { ...splitProviderModel(providersValue), source: "providers" };
  }

  return { provider: DEFAULT_PROVIDER[role], model: null, source: "default" };
}

// mode は provider ごとに決まる (agent-launch.md): claude は bypassPermissions、omp は
// full。未知の provider は指定しない (`providerModeOf` が `undefined` を返す =
// `--mode` を省略する)。
const PROVIDER_MODES: Record<string, string> = {
  claude: "bypassPermissions",
  omp: "full",
};

export function providerModeOf(provider: string): string | undefined {
  return PROVIDER_MODES[provider];
}

// ---------------------------------------------------------------------------
// CommandRunner — state.ts / paseo / git の実行境界 (テストではスタブ化する)
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): Promise<CommandResult>;
}

export class SubprocessRunner implements CommandRunner {
  async run(
    cmd: string,
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): Promise<CommandResult> {
    const command = new Deno.Command(cmd, {
      args: [...args],
      cwd: opts?.cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }
}

export class DriverError extends Error {}

// ---------------------------------------------------------------------------
// 引数の組み立て (純粋関数 — subprocess は呼ばない)
// ---------------------------------------------------------------------------

const STATE_TS_PATH = new URL("./state.ts", import.meta.url).pathname;

export function buildStateArgs(
  stateTsPath: string,
  stateDir: string,
  verb: string,
  flags: readonly (readonly [string, string])[],
): string[] {
  const args = [
    "run",
    "--no-prompt",
    `--allow-read=${stateDir}`,
    `--allow-write=${stateDir}`,
    stateTsPath,
    verb,
  ];
  for (const [name, value] of flags) args.push(`--${name}`, value);
  return args;
}

export function buildClaimStateFlags(
  stateDir: string,
  id: string,
  session: string,
): [string, string][] {
  return [["state-dir", stateDir], ["id", id], ["session", session]];
}

export function buildGetStateFlags(stateDir: string): [string, string][] {
  return [["state-dir", stateDir]];
}

export interface NextStateOpts {
  readonly session?: string;
  readonly alive?: string;
  readonly now?: string;
  readonly config?: string;
  readonly deadTasks?: string;
}

export function buildNextStateFlags(
  stateDir: string,
  opts: NextStateOpts,
): [string, string][] {
  const flags: [string, string][] = [["state-dir", stateDir]];
  if (opts.session !== undefined) flags.push(["session", opts.session]);
  if (opts.alive !== undefined) flags.push(["alive", opts.alive]);
  if (opts.now !== undefined) flags.push(["now", opts.now]);
  if (opts.config !== undefined) flags.push(["config", opts.config]);
  if (opts.deadTasks !== undefined) flags.push(["dead-tasks", opts.deadTasks]);
  return flags;
}

export function buildSetWorktreeStateFlags(
  stateDir: string,
  id: string,
  worktree: string,
  base: string,
): [string, string][] {
  return [
    ["state-dir", stateDir],
    ["id", id],
    ["worktree", worktree],
    ["base", base],
  ];
}

/** `--expect-executor` の省略が「まだ誰も握っていない」の宣言 (docs/state-cli-contract.md
 * の `set-executor` 節) — `replaces` が null のときはフラグごと省略する。 */
export function buildSetExecutorStateFlags(
  stateDir: string,
  id: string,
  executor: string,
  session: string,
  expectExecutor: string | null,
): [string, string][] {
  const flags: [string, string][] = [
    ["state-dir", stateDir],
    ["id", id],
    ["executor", executor],
    ["session", session],
  ];
  if (expectExecutor !== null) flags.push(["expect-executor", expectExecutor]);
  return flags;
}

export function buildTouchExecutorStateFlags(
  stateDir: string,
  id: string,
  session: string,
  expectExecutor: string,
): [string, string][] {
  return [
    ["state-dir", stateDir],
    ["id", id],
    ["session", session],
    ["expect-executor", expectExecutor],
  ];
}

/** agent-launch.md「Paseo 経路の起動パラメータと読み取り」の起動パラメータ規則。
 * `executor` には `--output-schema` を付けない (background で複数回停止するため)。
 * `newWorkspace` は既定では省略する (top-level セッションからの `--cwd` は自動で owned
 * workspace を新規に持つ — 「所有 workspace の記録と安全な後始末」節)。agent-scoped の
 * 呼び出しから強制的に独立した workspace を切りたいときだけ明示する (テスト用途)。 */
export function buildPaseoRunArgs(params: {
  readonly id: string;
  readonly worktree: string;
  readonly provider: string;
  readonly model: string | null;
  readonly mode: string | undefined;
  readonly prompt: string;
  readonly newWorkspace?: string;
}): string[] {
  const args = [
    "run",
    "-d",
    "--json",
    "--title",
    `task-pipeline executor ${params.id}`,
    "--label",
    "task-pipeline=executor",
    "--label",
    `task-pipeline-task=${params.id}`,
    "--cwd",
    params.worktree,
    "--provider",
    params.model ? `${params.provider}/${params.model}` : params.provider,
  ];
  if (params.newWorkspace) args.push("--new-workspace", params.newWorkspace);
  if (params.mode) args.push("--mode", params.mode);
  args.push(params.prompt);
  return args;
}

/** agent-launch.md「takeover で差し替えるときの旧エージェント」— 旧 `run.executor` が
 * Paseo のエージェントなら 1 回だけ試す (同じ worktree に 2 体が書き込むのを止めるため。
 * idle なら no-op)。`archive` は使わない (LastUsage が null になり役割別コスト回収が
 * できなくなるため)。 */
export function buildPaseoStopArgs(agentId: string): string[] {
  return ["stop", agentId, "--json"];
}

/** 所有 workspace の後始末 (「所有 workspace の記録と安全な後始末」節) で使う。 */
export function buildPaseoWorkspaceArchiveArgs(workspaceId: string): string[] {
  return ["workspace", "archive", workspaceId, "--json"];
}

/** agent-launch.md「二重起動の防止」— `-g` を必ず付ける。 */
export function buildPaseoDuplicateCheckArgs(id: string): string[] {
  return ["ls", "-a", "-g", "--label", `task-pipeline-task=${id}`, "--json"];
}

export function buildPaseoWaitArgs(
  agentId: string,
  timeoutSec: number,
): string[] {
  return ["wait", agentId, "--timeout", String(timeoutSec), "--json"];
}

export function buildPaseoInspectArgs(agentId: string): string[] {
  return ["inspect", agentId, "--json"];
}

export function buildGitCommonDirArgs(): string[] {
  return ["rev-parse", "--path-format=absolute", "--git-common-dir"];
}

export function buildGitFetchArgs(projectRoot: string): string[] {
  return ["-C", projectRoot, "fetch"];
}

export function buildGitMergeFfOnlyArgs(projectRoot: string): string[] {
  return ["-C", projectRoot, "merge", "--ff-only"];
}

export function buildGitCurrentBranchArgs(projectRoot: string): string[] {
  return ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"];
}

/** worktree.md: 新規は `worktree add -b <branch> <path> HEAD`、ブランチの残骸が
 * あるときは (`reuseBranch: true`) `-b` を落として既存ブランチを張り直す。 */
export function buildGitWorktreeAddArgs(
  projectRoot: string,
  worktreePath: string,
  branch: string,
  reuseBranch: boolean,
): string[] {
  return reuseBranch
    ? ["-C", projectRoot, "worktree", "add", worktreePath, branch]
    : [
      "-C",
      projectRoot,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ];
}

/** `Resume from phase "<resume_phase>". Check existing artifacts in the run dir first.`
 * (inflight.md「takeover」)。pr_fix/rebase_fix/finalize 向けの補足行はこの issue の
 * 範囲外 (pr-follow/merge-recovery/rebase 系は非対応)。 */
export function buildExecutorPrompt(op: TakeoverOperation): string {
  return `Resume from phase "${op.resume_phase}". Check existing artifacts in the run dir first.`;
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

// ---------------------------------------------------------------------------
// paseo の応答パース
// ---------------------------------------------------------------------------

function parseJsonSafe(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * `paseo run -d --json` の stdout から agentId を取る。新規 workspace を作ったときは
 * 先頭に `Created workspace <id> - <name>` の通知行が混じるので、**最初の `{` から
 * 後ろ**を JSON として読む (agent-launch.md)。
 */
export function extractAgentId(stdout: string): string {
  const idx = stdout.indexOf("{");
  if (idx === -1) {
    throw new DriverError(
      `paseo run --json: no JSON object found in stdout: ${
        JSON.stringify(stdout)
      }`,
    );
  }
  const parsed = JSON.parse(stdout.slice(idx)) as Record<string, unknown>;
  if ("error" in parsed) {
    throw new DriverError(`paseo run failed: ${JSON.stringify(parsed.error)}`);
  }
  const agentId = parsed.agentId;
  if (typeof agentId !== "string" || agentId === "") {
    throw new DriverError(
      `paseo run --json: no agentId in response: ${JSON.stringify(parsed)}`,
    );
  }
  return agentId;
}

const CREATED_WORKSPACE_RE = /^Created workspace (\S+)/;

/**
 * `paseo run -d --json` の stdout の先頭に `Created workspace <id> - <name>` の行が
 * あれば、新規に owned workspace を作ったということ (無ければ非所有 = caller の
 * workspace を継承)。「所有 workspace の記録と安全な後始末」節。
 */
export function extractOwnedWorkspaceId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = trimmed.match(CREATED_WORKSPACE_RE);
    if (match) return match[1];
    if (trimmed.startsWith("{")) break;
  }
  return null;
}

export interface PaseoLsEntry {
  readonly id: string;
  readonly status: string;
}

/** `paseo ls --json` の各要素のエージェント id は `id` フィールド (`run`/`wait`/
 * `inspect`/`archive` の `agentId` とは異なる — 実測で確認済み)。 */
export function parsePaseoLs(stdout: string): readonly PaseoLsEntry[] {
  const parsed = parseJsonSafe(stdout);
  if (!Array.isArray(parsed)) return [];
  const out: PaseoLsEntry[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record.id === "string") {
        out.push({
          id: record.id,
          status: typeof record.status === "string" ? record.status : "unknown",
        });
      }
    }
  }
  return out;
}

// 停止済みのエージェントは二重起動の危険が無い (archive/close 済み)。
const INACTIVE_PASEO_STATUSES: Record<string, true> = {
  closed: true,
  archived: true,
  errored: true,
};

/** `excludeAgentId` (`takeover` の `replaces` — 差し替え対象の旧エージェント) は
 * 重複としてカウントしない。 */
export function findActiveDuplicates(
  entries: readonly PaseoLsEntry[],
  excludeAgentId: string | null,
): readonly string[] {
  return entries
    .filter((e) => e.id !== excludeAgentId)
    .filter((e) => !INACTIVE_PASEO_STATUSES[e.status])
    .map((e) => e.id);
}

/** `message` は単一の複数行文字列で返る (`paseo wait --json` 実測)。念のため配列
 * (要素が文字列 or `{message|text}` を持つオブジェクト) も受け付ける。 */
export function normalizeMessageLines(raw: unknown): readonly string[] {
  if (typeof raw === "string") {
    return raw.split("\n").map((line) => line.trim()).filter((line) =>
      line !== ""
    );
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      if (typeof entry === "string") return normalizeMessageLines(entry);
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const text = record.message ?? record.text;
        return typeof text === "string" ? normalizeMessageLines(text) : [];
      }
      return [];
    });
  }
  return [];
}

// protocol 行の形 (agent-launch.md「読み取り (ポーリング)」)。行頭に活動種別の
// プレフィックス ([Assistant] 等) が付くことがあるため、行頭アンカーは掛けない。
const PHASE_DONE_RE = /PHASE\s+(\S+)\s+DONE\s+—/;
const BLOCKED_RE = /BLOCKED:\s/;
const REBASE_CONFLICT_RE = /REBASE-CONFLICT\s+—/;
const FINALIZED_RE = /FINALIZED\s+—/;

/**
 * 直近の活動の中に、`phase` と一致する protocol 行があるか。`BLOCKED:` /
 * `REBASE-CONFLICT —` はどの phase でも起こりうるので phase を問わず一致とみなし、
 * `FINALIZED —` は phase が `finalize` のときだけ一致する。
 */
export function matchesProtocolLine(
  phase: string,
  lines: readonly string[],
): boolean {
  for (const line of lines) {
    const doneMatch = line.match(PHASE_DONE_RE);
    if (doneMatch) {
      if (doneMatch[1] === phase) return true;
      continue;
    }
    if (BLOCKED_RE.test(line)) return true;
    if (REBASE_CONFLICT_RE.test(line)) return true;
    if (FINALIZED_RE.test(line) && phase === "finalize") return true;
  }
  return false;
}

export interface FreshnessInputs {
  readonly waitStatus: string;
  readonly waitMessageLines: readonly string[];
  readonly inspectUpdatedAt: string | null;
  readonly runExecutorLastEventAt: string | null;
  readonly runPhase: string;
}

/**
 * agent-launch.md「読んだ行の鮮度」の 3 条件を **すべて** 満たすときだけ真。
 * 1 つでも読めない・判定できないときは消費済み側に倒す (= 偽)。
 */
export function isExecutorFresh(inputs: FreshnessInputs): boolean {
  if (inputs.waitStatus !== "idle") return false;
  if (
    inputs.inspectUpdatedAt === null || inputs.runExecutorLastEventAt === null
  ) {
    return false;
  }
  const updatedMs = Date.parse(inputs.inspectUpdatedAt);
  const lastEventMs = Date.parse(inputs.runExecutorLastEventAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(lastEventMs)) {
    return false;
  }
  if (!(updatedMs > lastEventMs)) return false;
  return matchesProtocolLine(inputs.runPhase, inputs.waitMessageLines);
}

// ---------------------------------------------------------------------------
// DriverContext と state.ts / paseo の呼び出し
// ---------------------------------------------------------------------------

export interface DriverContext {
  readonly runner: CommandRunner;
  readonly stateDir: string;
  readonly session: string;
  readonly waitTimeoutSec: number;
  readonly paseoBin: string;
  readonly launchArgs: LaunchArgs;
  readonly prefs: OrchestrationPrefs | null;
  readonly nextOpts: Omit<NextStateOpts, "session">;
  /** `paseo run` の `--new-workspace` に明示的に渡す値。既定 (undefined) は省略し、
   * top-level セッションの通常経路 (自動で owned workspace を作る) に任せる。
   * agent-scoped 呼び出しから独立した workspace を強制したいときだけ指定する
   * (テスト用途)。 */
  readonly paseoNewWorkspace?: string;
  /** git rev-parse で求めるプロジェクトルート。takeover が worktree を新規に作る
   * ときだけ呼ぶ (claim/status-check/wait では git を一切呼ばない)。 */
  readonly resolveProjectRoot: () => Promise<string>;
}

export function makeProjectRootResolver(
  runner: CommandRunner,
  stateDir: string,
): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (cached === null) {
      cached = (async () => {
        const result = await runner.run("git", buildGitCommonDirArgs(), {
          cwd: stateDir,
        });
        if (result.code === 0 && result.stdout.trim() !== "") {
          return parentDir(result.stdout.trim());
        }
        // git が使えない環境のフォールバック: state dir (`.task-pipeline`) の親。
        return parentDir(stateDir);
      })();
    }
    return cached;
  };
}

async function callStateCli(
  ctx: DriverContext,
  verb: string,
  flags: readonly (readonly [string, string])[],
): Promise<unknown> {
  const args = buildStateArgs(STATE_TS_PATH, ctx.stateDir, verb, flags);
  const result = await ctx.runner.run(Deno.execPath(), args);
  const json = parseJsonSafe(result.stdout);
  if (result.code !== 0) {
    const detail = json !== null ? JSON.stringify(json) : result.stderr.trim();
    throw new DriverError(
      `state.ts ${verb} failed (exit ${result.code}): ${detail}`,
    );
  }
  return json;
}

async function callPaseoCli(
  ctx: DriverContext,
  args: readonly string[],
): Promise<CommandResult> {
  return await ctx.runner.run(ctx.paseoBin, args);
}

/**
 * worktree.md の happy path: 既に `worktree`/`base` が記録されていればそのまま使う。
 * 無ければ (`needs_worktree: true`) origin への追随を試みてから
 * (失敗しても古い HEAD から切る) `git worktree add` し、`state.ts set-worktree` で
 * 記録する。ブランチの残骸があるとき (`already exists`) は既存ブランチを再利用する。
 */
async function resolveWorktree(
  ctx: DriverContext,
  id: string,
  item: V2Item,
): Promise<
  { worktree: string; base: string; recoveredFromRace: boolean }
> {
  if (item.worktree !== null && item.base !== null) {
    return {
      worktree: item.worktree,
      base: item.base,
      recoveredFromRace: false,
    };
  }

  const projectRoot = await ctx.resolveProjectRoot();

  try {
    await ctx.runner.run("git", buildGitFetchArgs(projectRoot));
    await ctx.runner.run("git", buildGitMergeFfOnlyArgs(projectRoot));
  } catch {
    // ベストエフォート: 追いつけなければ古い HEAD から切る (worktree.md)。
  }

  const branch = `task-pipeline/${id}`;
  const worktreePath = `${projectRoot}/.claude/worktrees/task-pipeline/${id}`;
  let addResult = await ctx.runner.run(
    "git",
    buildGitWorktreeAddArgs(projectRoot, worktreePath, branch, false),
  );
  if (addResult.code !== 0 && /already exists/.test(addResult.stderr)) {
    addResult = await ctx.runner.run(
      "git",
      buildGitWorktreeAddArgs(projectRoot, worktreePath, branch, true),
    );
  }
  if (addResult.code !== 0) {
    // 競合レース (gh-140 dogfood 実測): 2プロセスが同一 id へ同時に takeover し、
    // 先勝ちが `-b` 付きで worktree を作った直後に後発が `already exists` を踏んで
    // reuseBranch 再試行に落ちると、再試行は「ブランチは在るが path は空」を前提に
    // `-b` を落として `add <path> <branch>` するが、path も既に先勝ちの worktree で
    // 埋まっているため `fatal: '<path>' already exists` で二重に失敗する。この二重
    // 失敗は「自分が負けた」ことの証拠であって、先勝ちが `set-worktree` まで完了して
    // いれば `state.ts get` に worktree/base が現れているはずなので、それを採用して
    // 続行する (先勝ちの実行と衝突する新規 worktree 作成は行わない)。
    //
    // ただし先勝ちの `git worktree add` 成功と `state.ts set-worktree` 完了の間には
    // 実プロセスの遅延 (ブランチ名解決・state.ts の起動コスト) があり、負けた側が
    // その隙間で `get` を呼ぶと worktree がまだ null に見えることを実機のレースで
    // 確認した (gh-140 dogfood, 単発 get では再現的に失敗する)。短い間隔で有限回
    // ポーリングし、先勝ちの記録が追いつくのを待つ。
    const POLL_DELAYS_MS = [100, 200, 400, 800, 1500];
    let winner: V2Item | null = null;
    for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt++) {
      const stateJson = await callStateCli(
        ctx,
        "get",
        buildGetStateFlags(ctx.stateDir),
      ) as V2State;
      winner = stateJson.queue.find((i) => i.id === id) ?? null;
      if (winner !== null && winner.worktree !== null && winner.base !== null) {
        // 自分は worktree 作成で負けている — 先勝ちが既に takeover を進行中の証拠
        // なので、呼び出し元 (handleTakeover) はここで実際の paseo run へは進まず
        // 重複起動として扱う (`paseo ls` の TOCTOU では捕まらない。下記コメント参照)。
        return {
          worktree: winner.worktree,
          base: winner.base,
          recoveredFromRace: true,
        };
      }
      if (attempt < POLL_DELAYS_MS.length) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, POLL_DELAYS_MS[attempt]);
        await promise;
      }
    }
    throw new DriverError(
      `git worktree add failed for ${id}: ${
        addResult.stderr.trim() || addResult.stdout.trim()
      }`,
    );
  }

  const branchResult = await ctx.runner.run(
    "git",
    buildGitCurrentBranchArgs(projectRoot),
  );
  const base = branchResult.code === 0 && branchResult.stdout.trim() !== ""
    ? branchResult.stdout.trim()
    : "main";

  await callStateCli(
    ctx,
    "set-worktree",
    buildSetWorktreeStateFlags(ctx.stateDir, id, worktreePath, base),
  );
  return { worktree: worktreePath, base, recoveredFromRace: false };
}

// ---------------------------------------------------------------------------
// DriverOperation ハンドラ
// ---------------------------------------------------------------------------

export interface CycleResult {
  readonly op: string;
  readonly id: string | null;
  readonly outcome: string;
  readonly detail?: Record<string, unknown>;
}

async function handleClaim(
  ctx: DriverContext,
  id: string,
): Promise<CycleResult> {
  await callStateCli(
    ctx,
    "claim",
    buildClaimStateFlags(ctx.stateDir, id, ctx.session),
  );
  return { op: "claim", id, outcome: "claimed" };
}

async function handleTakeover(
  ctx: DriverContext,
  id: string,
  op: TakeoverOperation,
): Promise<CycleResult> {
  const stateJson = await callStateCli(
    ctx,
    "get",
    buildGetStateFlags(ctx.stateDir),
  ) as V2State;
  const item = stateJson.queue.find((i) => i.id === id) ?? null;
  if (item === null) {
    throw new DriverError(`takeover: task not found in state.json: ${id}`);
  }

  const { worktree, recoveredFromRace } = await resolveWorktree(ctx, id, item);

  if (recoveredFromRace) {
    // gh-140 dogfood 実測: worktree 作成のレースで負けた = 別プロセスが同じ id へ
    // 今まさに takeover 中である確定的な証拠。`paseo ls` の重複検知 (下記) は自分の
    // 起動と相手の記録の間に TOCTOU の隙間があり、両方が「重複なし」と誤認して
    // 実エージェントを二重起動しうることを実機で確認した (2体が同一 worktree に
    // 同時に書き込み得る)。ここで確定しているなら `paseo ls`/`paseo run` へ進まず
    // 即座に重複起動として扱う。
    return {
      op: "takeover",
      id,
      outcome: "skipped-duplicate",
      detail: { reason: "worktree-race" },
    };
  }

  const lsResult = await callPaseoCli(ctx, buildPaseoDuplicateCheckArgs(id));
  const duplicates = findActiveDuplicates(
    parsePaseoLs(lsResult.stdout),
    op.replaces,
  );
  if (duplicates.length > 0) {
    return {
      op: "takeover",
      id,
      outcome: "skipped-duplicate",
      detail: { duplicates },
    };
  }

  // agent-launch.md「takeover で差し替えるときの旧エージェント」— 旧 executor が Paseo
  // のエージェントなら 1 回だけ止める。落ちても続行してよい (`run.executor` と一致しない
  // 行を読み捨てる規則が吸収する)。
  if (op.replaces !== null) {
    try {
      await callPaseoCli(ctx, buildPaseoStopArgs(op.replaces));
    } catch {
      // 失敗は無視して続行する。
    }
  }

  const taskClass = await readTaskClass(`${ctx.stateDir}/tasks/${id}.md`);
  const resolved = resolveProviderModel(
    "executor",
    taskClass,
    ctx.launchArgs,
    ctx.prefs,
  );
  const mode = providerModeOf(resolved.provider);
  const prompt = buildExecutorPrompt(op);

  const runResult = await callPaseoCli(
    ctx,
    buildPaseoRunArgs({
      id,
      worktree,
      provider: resolved.provider,
      model: resolved.model,
      mode,
      prompt,
      newWorkspace: ctx.paseoNewWorkspace,
    }),
  );
  if (runResult.code !== 0) {
    throw new DriverError(
      `paseo run failed (exit ${runResult.code}): ${
        runResult.stderr.trim() || runResult.stdout.trim()
      }`,
    );
  }
  const agentId = extractAgentId(runResult.stdout);
  // 「Created workspace ...」通知行は agent-launch.md の記述では起動応答の先頭 (stdout)
  // だが、実測 (paseo 0.4.0) では stderr に出ることを確認した。両方の版に対応するため
  // 両ストリームを対象に探す。
  const workspaceId = extractOwnedWorkspaceId(
    `${runResult.stderr}\n${runResult.stdout}`,
  );

  await callStateCli(
    ctx,
    "set-executor",
    buildSetExecutorStateFlags(
      ctx.stateDir,
      id,
      agentId,
      ctx.session,
      op.replaces,
    ),
  );

  return {
    op: "takeover",
    id,
    outcome: "launched",
    detail: {
      agentId,
      provider: resolved.provider,
      model: resolved.model,
      providerSource: resolved.source,
      worktree,
      workspaceId,
    },
  };
}

async function handleLiveness(
  ctx: DriverContext,
  id: string,
  opKind: "status-check" | "wait",
): Promise<CycleResult> {
  const stateJson = await callStateCli(
    ctx,
    "get",
    buildGetStateFlags(ctx.stateDir),
  ) as V2State;
  const item = stateJson.queue.find((i) => i.id === id) ?? null;
  const executor = item?.run?.executor ?? null;
  if (item === null || item.run === null || executor === null) {
    return { op: opKind, id, outcome: "no-executor" };
  }

  const waitResult = await callPaseoCli(
    ctx,
    buildPaseoWaitArgs(executor, ctx.waitTimeoutSec),
  );
  if (waitResult.code !== 0) {
    return {
      op: opKind,
      id,
      outcome: "wait-failed",
      detail: { code: waitResult.code, stderr: waitResult.stderr.trim() },
    };
  }
  const waitJson = parseJsonSafe(waitResult.stdout) as
    | { status?: unknown; message?: unknown }
    | null;
  const waitStatus = typeof waitJson?.status === "string"
    ? waitJson.status
    : "unknown";
  const messageLines = normalizeMessageLines(waitJson?.message);

  if (waitStatus !== "idle") {
    return {
      op: opKind,
      id,
      outcome: "not-idle",
      detail: { status: waitStatus },
    };
  }
  // protocol 行の有無は I/O を伴わないので、`paseo inspect` (追加のサブプロセス呼び出し)
  // より先に判定する — 一致しなければ鮮度は確定して偽であり、inspect は無駄になる。
  if (!matchesProtocolLine(item.run.phase, messageLines)) {
    return { op: opKind, id, outcome: "stale", detail: { status: waitStatus } };
  }

  const inspectResult = await callPaseoCli(
    ctx,
    buildPaseoInspectArgs(executor),
  );
  const inspectJson = inspectResult.code === 0
    ? (parseJsonSafe(inspectResult.stdout) as { UpdatedAt?: unknown } | null)
    : null;
  const inspectUpdatedAt = typeof inspectJson?.UpdatedAt === "string"
    ? inspectJson.UpdatedAt
    : null;

  const fresh = isExecutorFresh({
    waitStatus,
    waitMessageLines: messageLines,
    inspectUpdatedAt,
    runExecutorLastEventAt: item.run.executor_last_event_at,
    runPhase: item.run.phase,
  });
  if (!fresh) {
    return { op: opKind, id, outcome: "stale", detail: { status: waitStatus } };
  }

  await callStateCli(
    ctx,
    "touch-executor",
    buildTouchExecutorStateFlags(ctx.stateDir, id, ctx.session, executor),
  );
  return { op: opKind, id, outcome: "touched", detail: { executor } };
}

// ---------------------------------------------------------------------------
// observe モード (副作用ゼロの観測モード + next 応答リプレイ。gh-142 Phase2 Task 2-2a)
// ---------------------------------------------------------------------------

export type ObserveSource = "live" | "replay";

/** `NextTask.actions[]` の各要素に `planOperation` の分類結果をそのまま乗せたもの
 * (`actions[0]` だけを見る現行 `runCycle` と異なり全要素を対象にする)。 */
export type ObserveActionResult = { readonly index: number } & DriverOperation;

export interface ObserveTask {
  readonly id: string;
  readonly actions: readonly ObserveActionResult[];
}

/** 現行 `CycleResult` と同じ形だが、実行していないことが名前から分かるよう
 * `outcome` を `would-*`/`skipped-out-of-scope`/`idle` に限定する。 */
export interface ObserveSelected {
  readonly op: string;
  readonly id: string | null;
  readonly outcome: string;
  readonly detail?: Record<string, unknown>;
}

export interface ObserveRecord {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly observed_at: string;
  readonly source: ObserveSource;
  readonly next_now: string;
  readonly session: string;
  readonly alive: string | null;
  readonly config: string | null;
  readonly dead_tasks: string | null;
  readonly payload_digest: string;
  readonly tasks: readonly ObserveTask[];
  readonly selected: ObserveSelected;
}

export function planObserveTasks(
  tasks: readonly NextTask[],
): readonly ObserveTask[] {
  return tasks.map((task) => ({
    id: task.id,
    actions: task.actions.map((action, index) => ({
      index,
      ...planOperation(action),
    })),
  }));
}

type ExecutableOperation = Exclude<DriverOperation, DeferredOperation>;

/** 選択ロジック本体 — due の先頭が deferred (この issue の非目標の9 kind) でも、後続に
 * claim/takeover/status-check/wait があればそちらを優先する。deferred が先頭に居るという
 * だけで実行可能な後続タスクへ永久に到達できなくなってはならない。deferred しか無い
 * ときは、最初に見つけた deferred を報告する。`runCycle` (実行) と `selectObserveOperation`
 * (observe モードの記録) が同じ優先順位を共有するための唯一の実装。 */
function selectDriverAction(tasks: readonly NextTask[]): {
  readonly selected:
    | { readonly id: string; readonly op: ExecutableOperation }
    | null;
  readonly firstDeferred:
    | { readonly id: string; readonly kind: DeferredKind }
    | null;
} {
  let firstDeferred:
    | { readonly id: string; readonly kind: DeferredKind }
    | null = null;
  for (const task of tasks) {
    if (task.actions.length === 0) continue;
    const op = planOperation(task.actions[0]);
    if (op.op === "deferred") {
      if (firstDeferred === null) {
        firstDeferred = { id: task.id, kind: op.kind };
      }
      continue;
    }
    return { selected: { id: task.id, op }, firstDeferred };
  }
  return { selected: null, firstDeferred };
}

export function selectObserveOperation(
  tasks: readonly NextTask[],
): ObserveSelected {
  const { selected, firstDeferred } = selectDriverAction(tasks);
  if (selected !== null) {
    switch (selected.op.op) {
      case "claim":
        return { op: "claim", id: selected.id, outcome: "would-claim" };
      case "takeover":
        return {
          op: "takeover",
          id: selected.id,
          outcome: "would-set-executor",
          detail: {
            reason: selected.op.reason,
            resume_phase: selected.op.resume_phase,
            recheck_gate: selected.op.recheck_gate,
            needs_worktree: selected.op.needs_worktree,
            replaces: selected.op.replaces,
          },
        };
      case "status-check":
        return {
          op: "status-check",
          id: selected.id,
          outcome: "would-touch-executor",
        };
      case "wait":
        return {
          op: "wait",
          id: selected.id,
          outcome: "would-touch-executor",
          detail: { reason: selected.op.reason },
        };
    }
  }
  if (firstDeferred !== null) {
    return {
      op: "deferred",
      id: firstDeferred.id,
      outcome: "skipped-out-of-scope",
      detail: { kind: firstDeferred.kind },
    };
  }
  return { op: "none", id: null, outcome: "idle" };
}

/** `payload_digest` — 同じ `NextResult` 生 JSON テキストなら毎回同じ値になることだけが
 * 要件 (replay の再現性検証)。`SubtleCrypto` は Deno permission 不要。 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildObserveRecord(params: {
  readonly sequence: number;
  readonly observedAt: string;
  readonly source: ObserveSource;
  readonly nextResult: NextResult;
  readonly payloadDigest: string;
  readonly session: string;
  readonly alive: string | null;
  readonly config: string | null;
  readonly deadTasks: string | null;
}): ObserveRecord {
  return {
    schema_version: 1,
    sequence: params.sequence,
    observed_at: params.observedAt,
    source: params.source,
    next_now: params.nextResult.now,
    session: params.session,
    alive: params.alive,
    config: params.config,
    dead_tasks: params.deadTasks,
    payload_digest: params.payloadDigest,
    tasks: planObserveTasks(params.nextResult.tasks),
    selected: selectObserveOperation(params.nextResult.tasks),
  };
}

export interface ObserveCycleParams {
  /** live (`replayNextText` 省略) のときだけ使う — replay は `state.ts` へのサブプロセス
   * 呼び出しを完全に0回にするため、渡されていてもこのフィールドは参照しない。 */
  readonly runner: CommandRunner;
  readonly stateDir: string;
  readonly nextOpts: NextStateOpts;
  readonly sequence: number;
  readonly observedAt: string;
  /** 指定すると replay: `state.ts next` の代わりにこの生 JSON テキストをそのまま使う。 */
  readonly replayNextText?: string;
}

export async function runObserveCycle(
  params: ObserveCycleParams,
): Promise<ObserveRecord> {
  const source: ObserveSource = params.replayNextText === undefined
    ? "live"
    : "replay";
  let rawText: string;
  if (source === "replay") {
    rawText = params.replayNextText!;
  } else {
    const flags = buildNextStateFlags(params.stateDir, params.nextOpts);
    const args = buildStateArgs(STATE_TS_PATH, params.stateDir, "next", flags);
    const result = await params.runner.run(Deno.execPath(), args);
    const json = parseJsonSafe(result.stdout);
    if (result.code !== 0) {
      const detail = json !== null
        ? JSON.stringify(json)
        : result.stderr.trim();
      throw new DriverError(
        `state.ts next failed (exit ${result.code}): ${detail}`,
      );
    }
    rawText = result.stdout;
  }
  const nextResult = JSON.parse(rawText) as NextResult;
  const payloadDigest = await sha256Hex(rawText);
  return buildObserveRecord({
    sequence: params.sequence,
    observedAt: params.observedAt,
    source,
    nextResult,
    payloadDigest,
    session: params.nextOpts.session ?? "",
    alive: params.nextOpts.alive ?? null,
    config: params.nextOpts.config ?? null,
    deadTasks: params.nextOpts.deadTasks ?? null,
  });
}

/** live observe 1サイクル分を証跡として `.task-pipeline/driver/observe-<run-id>.jsonl`
 * に追記する。`runId` はプロセス起動ごとに1回だけ生成し、そのプロセスの全サイクルで
 * 固定するのが呼び出し側 (`main`) の責務。 */
export async function appendObserveRecord(
  stateDir: string,
  runId: string,
  record: ObserveRecord,
): Promise<void> {
  const dir = `${stateDir}/driver`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/observe-${runId}.jsonl`,
    `${JSON.stringify(record)}\n`,
    { append: true, create: true },
  );
}

// ---------------------------------------------------------------------------
// observe の常駐ループ
// ---------------------------------------------------------------------------

/** `ms` 経過 or `signal` の abort のどちらか早い方で解決する。abort 側は setTimeout を
 * 確実に片付けてから解決し、タイマーが残ってプロセス終了を妨げないようにする
 * (`SIGINT`/`SIGTERM` 到達時に `--interval-sec` の満了を待たずに中断できるのはこの race のため)。 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** observe 常駐ループの既定間隔 (`watch-agent.sh` の 0 秒起床監視と同じ 5 秒 —
 * observe サイクルは `state.ts next` を 1 回呼ぶだけの軽いポーリングなので、
 * `watch-pr.sh` の 60 秒 (GitHub API を伴う重い監視向け) ではなくこちら側に揃える)。 */
export const DEFAULT_OBSERVE_LOOP_INTERVAL_SEC = 5;

export interface ObserveLoopParams {
  readonly runner: CommandRunner;
  readonly stateDir: string;
  readonly nextOpts: NextStateOpts;
  /** 省略時は DEFAULT_OBSERVE_LOOP_INTERVAL_SEC。 */
  readonly intervalSec?: number;
  /** 省略時は無期限。 */
  readonly maxCycles?: number;
  /** abort されたら、進行中のサイクル完了後にループを終了する (interval 待機中でも即座に)。 */
  readonly signal: AbortSignal;
  /** 1 サイクル完走するたびに呼ばれる (`main` はここで console.log してストリーミング出力する)。 */
  readonly onRecord?: (record: ObserveRecord) => void;
  /** テストで固定するための注入点。省略時は crypto.randomUUID()。 */
  readonly runId?: string;
  /** テストで固定するための注入点。省略時は Date.now ベースで進める。 */
  readonly now?: () => Date;
}

/** #142 の observe サイクルを、single-flight (前サイクル完走後にだけ次を始める) で
 * 繰り返す常駐ループ。1サイクルの例外はここで捕まえず呼び出し元 (`main`) の
 * `try/catch` へそのまま伝播させる — 後続サイクルを実行せずにループごと終了する。 */
export async function runObserveLoop(
  params: ObserveLoopParams,
): Promise<readonly ObserveRecord[]> {
  const runId = params.runId ?? crypto.randomUUID();
  const intervalMs = (params.intervalSec ?? DEFAULT_OBSERVE_LOOP_INTERVAL_SEC) *
    1000;
  const records: ObserveRecord[] = [];
  let sequence = 0;
  while (true) {
    const observedAt = (params.now?.() ?? new Date()).toISOString();
    const record = await runObserveCycle({
      runner: params.runner,
      stateDir: params.stateDir,
      nextOpts: params.nextOpts,
      sequence,
      observedAt,
    });
    await appendObserveRecord(params.stateDir, runId, record);
    records.push(record);
    params.onRecord?.(record);
    sequence += 1;
    if (params.maxCycles !== undefined && sequence >= params.maxCycles) {
      break;
    }
    if (params.signal.aborted) break;
    await sleepAbortable(intervalMs, params.signal);
    if (params.signal.aborted) break;
  }
  return records;
}

// ---------------------------------------------------------------------------
// 1 サイクル: next → due な1件を実行 → 終了
// ---------------------------------------------------------------------------

export async function runCycle(ctx: DriverContext): Promise<CycleResult> {
  const nextFlags = buildNextStateFlags(ctx.stateDir, {
    session: ctx.session,
    ...ctx.nextOpts,
  });
  const nextResult = await callStateCli(ctx, "next", nextFlags) as NextResult;

  const { selected, firstDeferred } = selectDriverAction(nextResult.tasks);
  if (selected !== null) {
    switch (selected.op.op) {
      case "claim":
        return await handleClaim(ctx, selected.id);
      case "takeover":
        return await handleTakeover(ctx, selected.id, selected.op);
      case "status-check":
        return await handleLiveness(ctx, selected.id, "status-check");
      case "wait":
        return await handleLiveness(ctx, selected.id, "wait");
    }
  }
  if (firstDeferred !== null) {
    return {
      op: "deferred",
      id: firstDeferred.id,
      outcome: "skipped-out-of-scope",
      detail: { kind: firstDeferred.kind },
    };
  }
  return { op: "none", id: null, outcome: "idle" };
}

// ---------------------------------------------------------------------------
// CLI エントリポイント
// ---------------------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT_SEC = 30;

export async function main(argv: string[]): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const observe = boolFlag(flags, "observe");
    const replayNextPath = flags.get("replay-next");
    if (replayNextPath !== undefined && !observe) {
      throw new DriverError("--replay-next requires --observe");
    }
    const loop = boolFlag(flags, "loop");
    if (loop && !observe) {
      throw new DriverError("--loop requires --observe");
    }

    const stateDir = requireFlag(flags, "state-dir");
    const session = flags.get("session") ??
      Deno.env.get("CLAUDE_CODE_SESSION_ID") ?? "";
    const nextStateOpts: NextStateOpts = {
      session,
      alive: flags.get("alive"),
      now: flags.get("now"),
      config: flags.get("config"),
      deadTasks: flags.get("dead-tasks"),
    };

    if (observe && loop) {
      const intervalSec = intFlag(
        flags,
        "interval-sec",
        DEFAULT_OBSERVE_LOOP_INTERVAL_SEC,
      );
      const maxCycles = flags.has("max-cycles")
        ? requireIntFlag(flags, "max-cycles")
        : undefined;
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      Deno.addSignalListener("SIGINT", onSignal);
      Deno.addSignalListener("SIGTERM", onSignal);
      try {
        await runObserveLoop({
          runner: new SubprocessRunner(),
          stateDir,
          nextOpts: nextStateOpts,
          intervalSec,
          maxCycles,
          signal: controller.signal,
          onRecord: (record) => console.log(JSON.stringify(record)),
        });
      } finally {
        Deno.removeSignalListener("SIGINT", onSignal);
        Deno.removeSignalListener("SIGTERM", onSignal);
      }
      return 0;
    }

    if (observe) {
      const replayNextText = replayNextPath !== undefined
        ? await Deno.readTextFile(replayNextPath)
        : undefined;
      const record = await runObserveCycle({
        runner: new SubprocessRunner(),
        stateDir,
        nextOpts: nextStateOpts,
        sequence: 0,
        observedAt: new Date().toISOString(),
        replayNextText,
      });
      console.log(JSON.stringify(record));
      if (record.source === "live") {
        await appendObserveRecord(stateDir, crypto.randomUUID(), record);
      }
      return 0;
    }

    const waitTimeoutSec = intFlag(
      flags,
      "wait-timeout-sec",
      DEFAULT_WAIT_TIMEOUT_SEC,
    );
    const paseoBin = flags.get("paseo-bin") ?? "paseo";

    const runner = new SubprocessRunner();
    const prefs = await readOrchestrationPrefs(Deno.env.get("HOME") ?? "");

    const ctx: DriverContext = {
      runner,
      stateDir,
      session,
      waitTimeoutSec,
      paseoBin,
      launchArgs: {
        impl_provider: flags.get("impl-provider"),
        verify_provider: flags.get("verify-provider"),
      },
      prefs,
      nextOpts: {
        alive: nextStateOpts.alive,
        now: nextStateOpts.now,
        config: nextStateOpts.config,
        deadTasks: nextStateOpts.deadTasks,
      },
      paseoNewWorkspace: flags.get("paseo-new-workspace"),
      resolveProjectRoot: makeProjectRootResolver(runner, stateDir),
    };

    const result = await runCycle(ctx);
    console.log(JSON.stringify(result));
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ error: message }));
    return 1;
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
