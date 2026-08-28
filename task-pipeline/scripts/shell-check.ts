// task-pipeline/scripts/shell-check.ts
//
// 検証ゲートの **シェル判定** (Structured Shell-Check)。LLM を一切起動せず、信頼済みの
// チェックマニフェストと Scope Guard の機械的な結果だけで PASS / FAIL / UNAVAILABLE を出す。
//
// 実行形:
//   deno run --no-prompt --allow-read=<state dir>,<worktree> --allow-write=<state dir> \
//     --allow-run task-pipeline/scripts/shell-check.ts \
//     --state-dir <dir> --id <id> --verdict-path <path> [--git-bin <path>]
//
// 応答は 1 行 JSON で、オーケストレーターは `route` で分岐する:
//   {"ok":true,"id":..,"phase":..,"route":"shell","audit_mode":"shell","verdict":"PASS|FAIL|
//    UNAVAILABLE","verdict_path":..,"checks":<n>,"violations":<n>}
//   {"ok":true,"id":..,"phase":..,"route":"llm","audit_mode":"single|dual","reason":..}
// 終了コードとエラー JSON の形は state.ts と同じ (`CliErrorV2` / `EXIT_CODES`)。
//
// **`route` の判断はこの CLI に閉じている** — どの class・どのフェーズがシェル判定の対象かを
// SKILL.md 側へ書き写さないためで、`state.ts verdict-path` (state-verdict-path.ts) と同じ流儀。
//
// 信頼境界: 実行するコマンドは `git show <base>:TASK_PIPELINE_CHECKS.json` で読んだ **base
// スナップショットの**マニフェストからのみ来る。作業ツリー側のマニフェストは読まない —
// 実行エージェントは自分のブランチにコミットできるので、作業ツリーを信頼するとチェックそのものを
// 差し替えられる。マニフェストが取れない・壊れているときは判定を弱めず LLM 経路へ昇格する。
//
// タイムアウトは `spawn()` + `kill("SIGKILL")` で実装する。`Deno.Command` の `signal` オプションは
// `output()` の待ちを中断しない (実測: `sleep 5` に 300ms で abort しても完走した)。
//
// テスト: shell-check.test.ts (CLI をサブプロセス起動) / tests/shell-check-e2e.test.sh
// (実 git リポジトリで base スナップショット・Scope Guard・advance まで通す)。

import { parseFlags, requireFlag } from "./state-flags.ts";
import { atomicWriteText, joinPath, readState } from "./state-io.ts";
import { checkStateV2 } from "./state-schema-v2.ts";
import { CliErrorV2 } from "./state-transitions-v2.ts";
import { normalizeStateV2 } from "./state-ledger-v2.ts";
import { VERIFIED_PHASE_VALUES } from "./state-model-v2.ts";
import { runDirOf, VERDICTS_DIR } from "./state-verdict-path.ts";
import { readTaskDeclaration, resolveAuditMode } from "./task-policy.ts";
import {
  buildVerdictDoc,
  type CheckOutcome,
  type CheckSpec,
  evaluateScope,
  MANIFEST_PATH,
  outputExcerpt,
  parseManifest,
  type ScopeResult,
} from "./shell-check-manifest.ts";

const ALLOWED_FLAGS = ["state-dir", "id", "verdict-path", "git-bin"];

const EXIT_CODES = {
  usage: 10,
  lock: 11,
  schema: 12,
  missing: 13,
  permission: 14,
  conflict: 15,
} as const;

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** git 自体を起動できなかった (実行基盤の故障)。非ゼロ終了とは区別する。 */
  readonly spawnFailed: boolean;
}

async function runGit(
  gitBin: string,
  args: readonly string[],
): Promise<GitResult> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(gitBin, {
      args: [...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: (e as Error).message,
      spawnFailed: true,
    };
  }
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr).trim(),
    spawnFailed: false,
  };
}

function linesOf(stdout: string): readonly string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
}

async function runCheck(
  spec: CheckSpec,
  cwd: string,
  logPath: string,
): Promise<CheckOutcome> {
  const startedAt = performance.now();
  const base = {
    name: spec.name,
    command: spec.command,
    args: spec.args,
  };

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(spec.command, {
      args: [...spec.args],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    return {
      ...base,
      exit_code: null,
      duration_ms: Math.round(performance.now() - startedAt),
      log: null,
      outcome: "spawn-failed",
      error: (e as Error).message,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // 既に終了していた場合は kill が投げる。タイムアウト扱いのまま進めてよい。
    }
  }, spec.timeout_sec * 1000);
  let output: Deno.CommandOutput;
  try {
    output = await child.output();
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.round(performance.now() - startedAt);

  const decoder = new TextDecoder();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  await Deno.writeTextFile(
    logPath,
    `$ ${[spec.command, ...spec.args].join(" ")}\n(cwd: ${cwd})\n` +
      `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n` +
      `--- exit ${output.code}${
        timedOut ? " (killed after timeout)" : ""
      } ---\n`,
  );

  return {
    ...base,
    exit_code: output.code,
    duration_ms: durationMs,
    log: logPath,
    outcome: timedOut ? "timeout" : output.code === 0 ? "passed" : "failed",
    error: output.code === 0
      ? null
      : outputExcerpt(`${stdout}\n${stderr}`.trim()),
  };
}

interface Target {
  readonly id: string;
  readonly phase: string;
  readonly attempts: number;
  readonly worktree: string | null;
  readonly base: string | null;
}

async function readTarget(stateDir: string, id: string): Promise<Target> {
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
      `shell-check requires progress==running with a run: ${id} is ${item.progress}`,
    );
  }
  if (!(VERIFIED_PHASE_VALUES as readonly string[]).includes(run.phase)) {
    throw new CliErrorV2(
      "conflict",
      `phase has no verification gate: ${run.phase}`,
    );
  }
  return {
    id,
    phase: run.phase,
    attempts: run.attempts,
    worktree: item.worktree,
    base: item.base,
  };
}

/**
 * 判定ファイルの置き場は `state.ts verdict-path` が決める。ここで確かめるのは「渡された
 * パスがその run の `verdicts/` 直下の `*.json` である」ことだけで、外れたパスへは何も書かない
 * (ログもこのディレクトリに落ちるので、任意のパスを受けると書き込み先が run dir を出る)。
 */
function verdictsDirOf(stateDir: string, id: string): string {
  return joinPath(runDirOf(stateDir, id), VERDICTS_DIR);
}

function checkVerdictPath(stateDir: string, id: string, path: string): string {
  const dir = verdictsDirOf(stateDir, id);
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".json")) {
    throw new CliErrorV2(
      "usage",
      `--verdict-path must be a *.json file directly under ${dir}: ${path}`,
    );
  }
  const name = path.slice(prefix.length);
  if (name === "" || name.includes("/")) {
    throw new CliErrorV2(
      "usage",
      `--verdict-path must be directly under ${dir}: ${path}`,
    );
  }
  return name.slice(0, -".json".length);
}

interface ScopeGuard {
  readonly scope: ScopeResult;
  readonly infraErrors: readonly string[];
}

async function runScopeGuard(
  gitBin: string,
  worktree: string,
  base: string,
  allowLists: readonly (readonly string[])[],
): Promise<ScopeGuard> {
  const infraErrors: string[] = [];
  const empty: ScopeResult = { changed: [], untracked: [], violations: [] };

  const mergeBase = await runGit(gitBin, [
    "-C",
    worktree,
    "merge-base",
    base,
    "HEAD",
  ]);
  if (mergeBase.code !== 0) {
    infraErrors.push(
      `git merge-base ${base} HEAD が exit ${mergeBase.code}: ${mergeBase.stderr}`,
    );
    return { scope: empty, infraErrors };
  }
  const mergeBaseSha = mergeBase.stdout.trim();

  const changed = await runGit(gitBin, [
    "-C",
    worktree,
    "diff",
    "--name-only",
    mergeBaseSha,
  ]);
  if (changed.code !== 0) {
    infraErrors.push(
      `git diff --name-only ${mergeBaseSha} が exit ${changed.code}: ${changed.stderr}`,
    );
    return { scope: empty, infraErrors };
  }

  const untracked = await runGit(gitBin, [
    "-C",
    worktree,
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (untracked.code !== 0) {
    infraErrors.push(
      `git ls-files --others が exit ${untracked.code}: ${untracked.stderr}`,
    );
    return { scope: empty, infraErrors };
  }

  return {
    scope: evaluateScope({
      changed: linesOf(changed.stdout),
      untracked: linesOf(untracked.stdout),
      allowLists,
    }),
    infraErrors,
  };
}

interface ShellVerdictParams {
  readonly id: string;
  readonly phase: string;
  readonly verdictPath: string;
  readonly verdictsDir: string;
  readonly manifestRef: string;
  readonly outcomes: readonly CheckOutcome[];
  readonly scope: ScopeResult;
  readonly allowLists: readonly (readonly string[])[];
  readonly infraErrors: readonly string[];
}

/** UNAVAILABLE でも判定ファイルは書く (何が起きたかの監査証跡が残らないと追えない)。 */
async function writeShellVerdict(p: ShellVerdictParams): Promise<number> {
  const doc = buildVerdictDoc({
    phase: p.phase,
    manifestRef: p.manifestRef,
    outcomes: p.outcomes,
    violations: p.scope.violations,
    scope: p.scope,
    allowLists: p.allowLists,
    infraErrors: p.infraErrors,
  });
  await Deno.mkdir(p.verdictsDir, { recursive: true });
  await atomicWriteText(
    p.verdictPath,
    `${JSON.stringify(doc, null, 2)}\n`,
    false,
  );
  console.log(JSON.stringify({
    ok: true,
    id: p.id,
    phase: p.phase,
    route: "shell",
    audit_mode: "shell",
    verdict: doc.verdict,
    verdict_path: p.verdictPath,
    checks: p.outcomes.length,
    violations: p.scope.violations.length,
  }));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const flags = parseFlags(argv);
    for (const key of flags.keys()) {
      if (!ALLOWED_FLAGS.includes(key)) {
        throw new CliErrorV2("usage", `unknown flag: --${key}`);
      }
    }
    const stateDir = requireFlag(flags, "state-dir");
    const id = requireFlag(flags, "id");
    const verdictPath = requireFlag(flags, "verdict-path");
    const gitBin = flags.get("git-bin") ?? "git";

    const target = await readTarget(stateDir, id);
    const verdictStem = checkVerdictPath(stateDir, id, verdictPath);

    const declaration = await readTaskDeclaration(
      joinPath(joinPath(stateDir, "tasks"), `${id}.md`),
    );
    const auditMode = resolveAuditMode({
      taskClass: declaration.taskClass,
      declared: declaration.declaredAuditMode,
      phase: target.phase,
    });

    const escalate = (reason: string, mode = auditMode): number => {
      console.log(JSON.stringify({
        ok: true,
        id,
        phase: target.phase,
        route: "llm",
        audit_mode: mode,
        reason,
      }));
      return 0;
    };

    if (auditMode !== "shell") {
      return escalate(
        declaration.declaredAuditMode === null &&
          declaration.taskClass === "trivial"
          ? `phase ${target.phase} is not shell-auditable`
          : `audit_mode is ${auditMode}`,
      );
    }
    if (target.worktree === null) {
      return escalate("no worktree recorded for this task", "single");
    }
    if (target.base === null) {
      return escalate("no base recorded for this task", "single");
    }

    const manifestRef = `${target.base}:${MANIFEST_PATH}`;
    const verdictsDir = verdictsDirOf(stateDir, id);
    const emptyScope: ScopeResult = {
      changed: [],
      untracked: [],
      violations: [],
    };
    const shown = await runGit(gitBin, [
      "-C",
      target.worktree,
      "show",
      manifestRef,
    ]);
    // git が **起動できない** のは実行基盤の故障で、git が「そんなパスは無い」と答えるのとは
    // 別物である。前者を昇格 (LLM 経路) で吸収すると、故障がポリシーの選択として記録される。
    if (shown.spawnFailed) {
      return await writeShellVerdict({
        id,
        phase: target.phase,
        verdictPath,
        verdictsDir,
        manifestRef,
        outcomes: [],
        scope: emptyScope,
        allowLists: [],
        infraErrors: [`git (${gitBin}) を起動できなかった: ${shown.stderr}`],
      });
    }
    if (shown.code !== 0) {
      return escalate(
        `trusted manifest is unavailable (${manifestRef}): ${shown.stderr}`,
        "single",
      );
    }
    const parsedManifest = parseManifest(shown.stdout);
    if (!parsedManifest.ok) {
      return escalate(
        `trusted manifest is invalid (${manifestRef}): ${parsedManifest.error}`,
        "single",
      );
    }
    const manifest = parsedManifest.manifest;

    const allowLists = declaration.declaredScope === null
      ? [manifest.scope.allow]
      : [manifest.scope.allow, declaration.declaredScope];

    const guard = await runScopeGuard(
      gitBin,
      target.worktree,
      target.base,
      allowLists,
    );

    await Deno.mkdir(verdictsDir, { recursive: true });
    const outcomes: CheckOutcome[] = [];
    if (guard.infraErrors.length === 0) {
      for (const spec of manifest.checks) {
        outcomes.push(
          await runCheck(
            spec,
            target.worktree,
            joinPath(verdictsDir, `${verdictStem}-${spec.name}.log`),
          ),
        );
      }
    }

    return await writeShellVerdict({
      id,
      phase: target.phase,
      verdictPath,
      verdictsDir,
      manifestRef,
      outcomes,
      scope: guard.scope,
      allowLists,
      infraErrors: guard.infraErrors,
    });
  } catch (e) {
    if (e instanceof CliErrorV2) {
      console.log(JSON.stringify({ error: e.code, message: e.message }));
      return EXIT_CODES[e.code];
    }
    if (e instanceof Deno.errors.NotCapable) {
      console.log(JSON.stringify({ error: "permission", message: e.message }));
      return EXIT_CODES.permission;
    }
    throw e;
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
