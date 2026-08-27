// task-pipeline/scripts/pipeline-driver.test.ts
//
// gh-136: pipeline-driver.ts (4 kind の DriverOperation を実行する非LLM Deno プロセス)
// の検証。state.ts / paseo / git はすべて `CommandRunner` を差し替えたスタブで置き換え、
// 実プロセスは一切起動しない (`pipeline-dispatch.test.ts` の検証パターンに合わせる —
// 生の assert / assertEquals、`Deno.test` 直書き)。
//
// - U   純粋関数 (class 導出・provider 解決・引数組み立て・応答パース・鮮度判定)
// - H   ハンドラ (`runCycle` を CommandRunner のスタブ越しに通し、4 kind それぞれが
//       正しいコマンド・引数を組み立てて実行することを検証)
// - E2E `paseo` が実環境に在れば実エージェントを 1 体起動する統合テスト。無ければ
//       スキップする (Deno.test の `ignore` はモジュール読み込み時に決まる)。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)

import {
  appendObserveRecord,
  buildClaimStateFlags,
  buildExecutorPrompt,
  buildGetStateFlags,
  buildGitCurrentBranchArgs,
  buildGitWorktreeAddArgs,
  buildNextStateFlags,
  buildPaseoDuplicateCheckArgs,
  buildPaseoInspectArgs,
  buildPaseoRunArgs,
  buildPaseoStopArgs,
  buildPaseoWaitArgs,
  buildPaseoWorkspaceArchiveArgs,
  buildSetExecutorStateFlags,
  buildSetWorktreeStateFlags,
  buildStateArgs,
  buildTouchExecutorStateFlags,
  type CommandResult,
  type CommandRunner,
  DEFAULT_DISPATCH_LOOP_INTERVAL_SEC,
  deriveTaskClass,
  type DispatchLoopParams,
  type DriverContext,
  extractAgentId,
  extractOwnedWorkspaceId,
  findActiveDuplicates,
  isExecutorFresh,
  main,
  matchesProtocolLine,
  normalizeMessageLines,
  type ObserveRecord,
  parentDir,
  parsePaseoLs,
  planObserveTasks,
  providerModeOf,
  resolveProviderModel,
  runCycle,
  runDispatchLoop,
  runObserveCycle,
  runObserveLoop,
  selectObserveOperation,
  splitProviderModel,
} from "./pipeline-driver.ts";
import type { TakeoverOperation } from "./pipeline-dispatch.ts";
import type { NextTask } from "./state-next.ts";

function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

// ---------------------------------------------------------------------------
// U: タスクの class
// ---------------------------------------------------------------------------

Deno.test("deriveTaskClass: gate: light -> trivial", () => {
  assertEquals(deriveTaskClass("id: gh-1\ngate: light\nrisk: low"), "trivial");
});

Deno.test("deriveTaskClass: risk: high -> high", () => {
  assertEquals(deriveTaskClass("id: gh-1\nrisk: high"), "high");
});

Deno.test("deriveTaskClass: no declaration -> standard", () => {
  assertEquals(deriveTaskClass("id: gh-1\ntitle: foo"), "standard");
});

Deno.test("deriveTaskClass: both declared -> high (保守側)", () => {
  assertEquals(deriveTaskClass("gate: light\nrisk: high"), "high");
});

// ---------------------------------------------------------------------------
// U: provider・model の 4段解決
// ---------------------------------------------------------------------------

Deno.test("resolveProviderModel: 段1 起動引数が最優先", () => {
  const resolved = resolveProviderModel(
    "executor",
    "standard",
    { impl_provider: "claude/claude-opus-4-1" },
    { providers: { impl: "omp/anthropic/claude-sonnet-5" } },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-opus-4-1",
    source: "launch-args",
  });
});

Deno.test("resolveProviderModel: 段2 providers_by_class[class].impl", () => {
  const resolved = resolveProviderModel(
    "executor",
    "high",
    {},
    {
      providers: { impl: "claude/claude-sonnet-4-5" },
      providers_by_class: { high: { impl: "claude/claude-opus-4-1" } },
    },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-opus-4-1",
    source: "providers_by_class",
  });
});

Deno.test("resolveProviderModel: class 行の床 — standard/trivial の audit は無視して段3へ", () => {
  const resolved = resolveProviderModel(
    "verifier",
    "standard",
    {},
    {
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      providers_by_class: {
        standard: { audit: "omp/anthropic/claude-opus-4-1" },
      },
    },
  );
  assertEquals(resolved, {
    provider: "omp",
    model: "anthropic/claude-haiku-4-5",
    source: "providers",
  });
});

Deno.test("resolveProviderModel: high の audit は providers_by_class を使ってよい", () => {
  const resolved = resolveProviderModel(
    "verifier",
    "high",
    {},
    {
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      providers_by_class: { high: { audit: "omp/anthropic/claude-sonnet-5" } },
    },
  );
  assertEquals(resolved, {
    provider: "omp",
    model: "anthropic/claude-sonnet-5",
    source: "providers_by_class",
  });
});

Deno.test("resolveProviderModel: 段3 providers[category]", () => {
  const resolved = resolveProviderModel(
    "executor",
    "standard",
    {},
    { providers: { impl: "claude/claude-sonnet-4-5" } },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-sonnet-4-5",
    source: "providers",
  });
});

Deno.test("resolveProviderModel: 段4 既定の組 (prefs 無し)", () => {
  assertEquals(resolveProviderModel("executor", "standard", {}, null), {
    provider: "claude",
    model: null,
    source: "default",
  });
  assertEquals(resolveProviderModel("verifier", "standard", {}, null), {
    provider: "omp",
    model: null,
    source: "default",
  });
});

Deno.test("splitProviderModel: 最初の / までが provider, 残り全部が model", () => {
  assertEquals(splitProviderModel("omp/anthropic/claude-haiku-4-5"), {
    provider: "omp",
    model: "anthropic/claude-haiku-4-5",
  });
  assertEquals(splitProviderModel("claude"), {
    provider: "claude",
    model: null,
  });
});

Deno.test("providerModeOf: claude -> bypassPermissions, omp -> full, 未知は undefined", () => {
  assertEquals(providerModeOf("claude"), "bypassPermissions");
  assertEquals(providerModeOf("omp"), "full");
  assertEquals(providerModeOf("junie"), undefined);
});

// ---------------------------------------------------------------------------
// U: 引数の組み立て (4 kind それぞれの「正しいコマンド・引数」)
// ---------------------------------------------------------------------------

Deno.test("buildStateArgs: claim の起動形", () => {
  const args = buildStateArgs(
    "/repo/task-pipeline/scripts/state.ts",
    "/repo/.task-pipeline",
    "claim",
    buildClaimStateFlags("/repo/.task-pipeline", "gh-42", "sess-1"),
  );
  assertEquals(args, [
    "run",
    "--no-prompt",
    "--allow-read=/repo/.task-pipeline",
    "--allow-write=/repo/.task-pipeline",
    "/repo/task-pipeline/scripts/state.ts",
    "claim",
    "--state-dir",
    "/repo/.task-pipeline",
    "--id",
    "gh-42",
    "--session",
    "sess-1",
  ]);
});

Deno.test("buildSetExecutorStateFlags: replaces が null なら --expect-executor を省略する", () => {
  assertEquals(
    buildSetExecutorStateFlags("/sd", "gh-1", "agent-new", "sess-1", null),
    [["state-dir", "/sd"], ["id", "gh-1"], ["executor", "agent-new"], [
      "session",
      "sess-1",
    ]],
  );
  assertEquals(
    buildSetExecutorStateFlags(
      "/sd",
      "gh-1",
      "agent-new",
      "sess-1",
      "agent-old",
    ),
    [
      ["state-dir", "/sd"],
      ["id", "gh-1"],
      ["executor", "agent-new"],
      ["session", "sess-1"],
      ["expect-executor", "agent-old"],
    ],
  );
});

Deno.test("buildTouchExecutorStateFlags: expect-executor は必須で渡す", () => {
  assertEquals(
    buildTouchExecutorStateFlags("/sd", "gh-1", "sess-1", "agent-1"),
    [
      ["state-dir", "/sd"],
      ["id", "gh-1"],
      ["session", "sess-1"],
      ["expect-executor", "agent-1"],
    ],
  );
});

Deno.test("buildSetWorktreeStateFlags", () => {
  assertEquals(buildSetWorktreeStateFlags("/sd", "gh-1", "/wt/gh-1", "main"), [
    ["state-dir", "/sd"],
    ["id", "gh-1"],
    ["worktree", "/wt/gh-1"],
    ["base", "main"],
  ]);
});

Deno.test("buildGetStateFlags / buildNextStateFlags: 未指定オプションはフラグごと省略", () => {
  assertEquals(buildGetStateFlags("/sd"), [["state-dir", "/sd"]]);
  assertEquals(buildNextStateFlags("/sd", { session: "sess-1" }), [
    ["state-dir", "/sd"],
    ["session", "sess-1"],
  ]);
  assertEquals(
    buildNextStateFlags("/sd", {
      session: "sess-1",
      alive: "sess-1,sess-2",
      now: "2026-08-20T00:00:00Z",
      config: "finish=pr",
      deadTasks: "gh-1",
    }),
    [
      ["state-dir", "/sd"],
      ["session", "sess-1"],
      ["alive", "sess-1,sess-2"],
      ["now", "2026-08-20T00:00:00Z"],
      ["config", "finish=pr"],
      ["dead-tasks", "gh-1"],
    ],
  );
});

Deno.test("buildPaseoRunArgs: agent-launch.md の起動パラメータ規則どおりの argv", () => {
  const args = buildPaseoRunArgs({
    id: "gh-42",
    worktree: "/wt/gh-42",
    provider: "claude",
    model: "claude-opus-4-1",
    mode: "bypassPermissions",
    prompt:
      'Resume from phase "research". Check existing artifacts in the run dir first.',
  });
  assertEquals(args, [
    "run",
    "-d",
    "--json",
    "--title",
    "task-pipeline executor gh-42",
    "--label",
    "task-pipeline=executor",
    "--label",
    "task-pipeline-task=gh-42",
    "--cwd",
    "/wt/gh-42",
    "--provider",
    "claude/claude-opus-4-1",
    "--new-workspace",
    "local",
    "--mode",
    "bypassPermissions",
    'Resume from phase "research". Check existing artifacts in the run dir first.',
  ]);
});

Deno.test("buildPaseoRunArgs: model が無ければ --provider は provider だけ、mode 無しなら --mode を省略", () => {
  const args = buildPaseoRunArgs({
    id: "gh-1",
    worktree: "/wt/gh-1",
    provider: "junie",
    model: null,
    mode: undefined,
    prompt: "go",
  });
  assert(!args.includes("--mode"));
  assertEquals(args[args.indexOf("--provider") + 1], "junie");
});

Deno.test("buildPaseoRunArgs: newWorkspace は既定で local、明示指定で上書き可能", () => {
  const defaultArgs = buildPaseoRunArgs({
    id: "gh-1",
    worktree: "/scratch",
    provider: "omp",
    model: null,
    mode: "full",
    prompt: "go",
  });
  assertEquals(
    defaultArgs[defaultArgs.indexOf("--new-workspace") + 1],
    "local",
  );
  const withCustomWorkspace = buildPaseoRunArgs({
    id: "gh-1",
    worktree: "/scratch",
    provider: "omp",
    model: null,
    mode: "full",
    prompt: "go",
    newWorkspace: "worktree",
  });
  assertEquals(
    withCustomWorkspace[withCustomWorkspace.indexOf("--new-workspace") + 1],
    "worktree",
  );
});

Deno.test("buildPaseoStopArgs", () => {
  assertEquals(buildPaseoStopArgs("agent-old"), [
    "stop",
    "agent-old",
    "--json",
  ]);
});

Deno.test("buildPaseoWorkspaceArchiveArgs", () => {
  assertEquals(buildPaseoWorkspaceArchiveArgs("wks_abc"), [
    "workspace",
    "archive",
    "wks_abc",
    "--json",
  ]);
});

Deno.test("extractOwnedWorkspaceId: Created workspace 行があれば workspace id を返す", () => {
  const stdout =
    'Created workspace wks_abc123 - myproj\n{"agentId":"agent-1","status":"running"}\n';
  assertEquals(extractOwnedWorkspaceId(stdout), "wks_abc123");
});

Deno.test("extractOwnedWorkspaceId: 通知行が無ければ null (非所有 = caller の workspace を継承)", () => {
  assertEquals(
    extractOwnedWorkspaceId('{"agentId":"agent-1","status":"running"}'),
    null,
  );
});

Deno.test("buildPaseoDuplicateCheckArgs: -a -g --label task-pipeline-task=<id>", () => {
  assertEquals(buildPaseoDuplicateCheckArgs("gh-42"), [
    "ls",
    "-a",
    "-g",
    "--label",
    "task-pipeline-task=gh-42",
    "--json",
  ]);
});

Deno.test("buildPaseoWaitArgs / buildPaseoInspectArgs", () => {
  assertEquals(buildPaseoWaitArgs("agent-1", 45), [
    "wait",
    "agent-1",
    "--timeout",
    "45",
    "--json",
  ]);
  assertEquals(buildPaseoInspectArgs("agent-1"), [
    "inspect",
    "agent-1",
    "--json",
  ]);
});

Deno.test("buildGitWorktreeAddArgs: 新規は -b、ブランチ残骸の再利用は -b を落とす", () => {
  assertEquals(
    buildGitWorktreeAddArgs(
      "/root",
      "/root/.claude/worktrees/task-pipeline/gh-1",
      "task-pipeline/gh-1",
      false,
    ),
    [
      "-C",
      "/root",
      "worktree",
      "add",
      "-b",
      "task-pipeline/gh-1",
      "/root/.claude/worktrees/task-pipeline/gh-1",
      "HEAD",
    ],
  );
  assertEquals(
    buildGitWorktreeAddArgs(
      "/root",
      "/root/.claude/worktrees/task-pipeline/gh-1",
      "task-pipeline/gh-1",
      true,
    ),
    [
      "-C",
      "/root",
      "worktree",
      "add",
      "/root/.claude/worktrees/task-pipeline/gh-1",
      "task-pipeline/gh-1",
    ],
  );
});

Deno.test("buildGitCurrentBranchArgs", () => {
  assertEquals(buildGitCurrentBranchArgs("/root"), [
    "-C",
    "/root",
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
});

Deno.test("buildExecutorPrompt: resume_phase を Begin 行に埋め込む", () => {
  const op: TakeoverOperation = {
    op: "takeover",
    verb: "set-executor",
    flags: ["state-dir", "id", "executor", "expect-executor", "session"],
    reason: "no-executor",
    resume_phase: "implement",
    recheck_gate: false,
    needs_worktree: false,
    replaces: null,
  };
  assertEquals(
    buildExecutorPrompt(op),
    'Resume from phase "implement". Check existing artifacts in the run dir first.',
  );
});

Deno.test("parentDir", () => {
  assertEquals(parentDir("/a/b/.git"), "/a/b");
  assertEquals(parentDir("/a/b/.git/"), "/a/b");
  assertEquals(parentDir("/a"), "/");
});

// ---------------------------------------------------------------------------
// U: paseo 応答のパース・鮮度判定
// ---------------------------------------------------------------------------

Deno.test("extractAgentId: 先頭の Created workspace 行を除いた最初の { から後ろを読む", () => {
  const stdout =
    'Created workspace wks_abc - myproj\n{"agentId":"agent-123","status":"running"}\n';
  assertEquals(extractAgentId(stdout), "agent-123");
});

Deno.test("extractAgentId: 通知行が無ければそのまま読む", () => {
  assertEquals(
    extractAgentId('{"agentId":"agent-xyz","status":"running"}'),
    "agent-xyz",
  );
});

Deno.test("extractAgentId: error 応答は投げる", () => {
  let threw = false;
  try {
    extractAgentId(
      '{"error":{"code":"OUTPUT_SCHEMA_FAILED","message":"waiting"}}',
    );
  } catch {
    threw = true;
  }
  assert(threw, "error 応答は例外を投げるべき");
});

Deno.test("parsePaseoLs: 各要素の id フィールドを読む (agentId ではない)", () => {
  const stdout = JSON.stringify([
    { id: "agent-1", status: "running" },
    { id: "agent-2", status: "closed" },
  ]);
  assertEquals(parsePaseoLs(stdout), [
    { id: "agent-1", status: "running" },
    { id: "agent-2", status: "closed" },
  ]);
});

Deno.test("findActiveDuplicates: closed/archived/errored は除外し、replaces も除外する", () => {
  const entries = [
    { id: "agent-old", status: "running" },
    { id: "agent-dead", status: "closed" },
    { id: "agent-other", status: "idle" },
  ];
  assertEquals(findActiveDuplicates(entries, "agent-old"), ["agent-other"]);
  assertEquals(findActiveDuplicates(entries, null), [
    "agent-old",
    "agent-other",
  ]);
});

Deno.test("normalizeMessageLines: 単一の複数行文字列を行配列にする (paseo wait 実測)", () => {
  const raw =
    "Agent is idle.\nLast 5 activity items:\n[User] hi\nPHASE research DONE — ok";
  assertEquals(normalizeMessageLines(raw), [
    "Agent is idle.",
    "Last 5 activity items:",
    "[User] hi",
    "PHASE research DONE — ok",
  ]);
});

Deno.test("matchesProtocolLine: PHASE <phase> DONE は phase が一致したときだけ真", () => {
  assert(
    matchesProtocolLine("research", ["[Assistant] PHASE research DONE — done"]),
  );
  assert(!matchesProtocolLine("plan", ["PHASE research DONE — done"]));
});

Deno.test("matchesProtocolLine: BLOCKED / REBASE-CONFLICT は phase を問わず真", () => {
  assert(matchesProtocolLine("implement", ["BLOCKED: waiting for input"]));
  assert(matchesProtocolLine("plan", ["REBASE-CONFLICT — onto origin/main"]));
});

Deno.test("matchesProtocolLine: FINALIZED は phase が finalize のときだけ真", () => {
  assert(matchesProtocolLine("finalize", ["FINALIZED — pr #1"]));
  assert(!matchesProtocolLine("implement", ["FINALIZED — pr #1"]));
});

Deno.test("isExecutorFresh: 3条件すべて満たすときだけ真", () => {
  const base = {
    waitStatus: "idle",
    waitMessageLines: ["PHASE research DONE — ok"],
    inspectUpdatedAt: "2026-08-20T10:00:00Z",
    runExecutorLastEventAt: "2026-08-20T09:00:00Z",
    runPhase: "research",
  };
  assert(isExecutorFresh(base));
  assert(!isExecutorFresh({ ...base, waitStatus: "running" }), "running は偽");
  assert(
    !isExecutorFresh({ ...base, inspectUpdatedAt: "2026-08-20T08:00:00Z" }),
    "UpdatedAt が古ければ偽",
  );
  assert(
    !isExecutorFresh({ ...base, waitMessageLines: ["[User] hi"] }),
    "protocol 行が無ければ偽",
  );
  assert(
    !isExecutorFresh({ ...base, inspectUpdatedAt: null }),
    "読めなければ消費済み側 (偽) に倒す",
  );
});

// ---------------------------------------------------------------------------
// H: runCycle — スタブ CommandRunner で 4 kind の組み立てを検証
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

class StubRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  constructor(
    private readonly handler: (
      cmd: string,
      args: readonly string[],
    ) => CommandResult | Promise<CommandResult>,
  ) {}
  run(cmd: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ cmd, args: [...args] });
    return Promise.resolve(this.handler(cmd, args));
  }
}

const ok = (json: unknown): CommandResult => ({
  code: 0,
  stdout: JSON.stringify(json),
  stderr: "",
});
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
});

function stateVerbOf(args: readonly string[]): string | null {
  const idx = args.findIndex((a) => a.endsWith("state.ts"));
  return idx === -1 ? null : args[idx + 1] ?? null;
}

function baseCtx(
  runner: CommandRunner,
  overrides: Partial<DriverContext> = {},
): DriverContext {
  return {
    runner,
    stateDir: "/fake/.task-pipeline",
    session: "sess-self",
    waitTimeoutSec: 30,
    paseoBin: "paseo",
    launchArgs: {},
    prefs: null,
    nextOpts: {},
    resolveProjectRoot: () => Promise.resolve("/fake/project"),
    ...overrides,
  };
}

Deno.test("runCycle/claim: due な claim 1件を state.ts claim で実行する", async () => {
  const runner = new StubRunner((cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({ tasks: [{ id: "gh-1", actions: [{ kind: "claim" }] }] });
    }
    if (verb === "claim") return ok({ ok: true, id: "gh-1" });
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });
  const result = await runCycle(baseCtx(runner));
  assertEquals(result, { op: "claim", id: "gh-1", outcome: "claimed" });

  const claimCall = runner.calls.find((c) => stateVerbOf(c.args) === "claim");
  assert(claimCall, "claim が呼ばれているべき");
  assert(claimCall!.args.includes("--session"));
  assertEquals(
    claimCall!.args[claimCall!.args.indexOf("--session") + 1],
    "sess-self",
  );
  assertEquals(claimCall!.args[claimCall!.args.indexOf("--id") + 1], "gh-1");
});

Deno.test("runCycle/takeover: worktree 済みタスクを paseo run で起動し set-executor する", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "run") {
        return ok({ agentId: "agent-new-1", status: "running" });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-2",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: false,
            replaces: null,
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-2",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-2",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-executor") {
      return ok({ ok: true, id: "gh-2", executor: "agent-new-1" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.op, "takeover");
  assertEquals(result.outcome, "launched");
  assertEquals(
    (result.detail as Record<string, unknown>).agentId,
    "agent-new-1",
  );

  const runCall = runner.calls.find((c) =>
    c.cmd === "paseo" && c.args[0] === "run"
  );
  assert(runCall, "paseo run が呼ばれているべき");
  assertEquals(
    runCall!.args.includes("--cwd") &&
      runCall!.args[runCall!.args.indexOf("--cwd") + 1],
    "/wt/gh-2",
  );
  assertEquals(
    runCall!.args.includes("--provider") &&
      runCall!.args[runCall!.args.indexOf("--provider") + 1],
    "claude",
  );
  assertEquals(
    runCall!.args.includes("--mode") &&
      runCall!.args[runCall!.args.indexOf("--mode") + 1],
    "bypassPermissions",
  );
  assertEquals(
    runCall!.args.includes("--new-workspace") &&
      runCall!.args[runCall!.args.indexOf("--new-workspace") + 1],
    "local",
  );

  const setExecCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "set-executor"
  );
  assert(setExecCall, "set-executor が呼ばれているべき");
  assert(
    !setExecCall!.args.includes("--expect-executor"),
    "replaces が null なら --expect-executor は省略",
  );
  assertEquals(
    setExecCall!.args[setExecCall!.args.indexOf("--executor") + 1],
    "agent-new-1",
  );
});
Deno.test("runCycle/takeover: ctx.paseoNewWorkspace で --new-workspace を上書きできる", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "run") {
        return ok({ agentId: "agent-custom-ws", status: "running" });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-30",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: false,
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-30",
          status: "in_progress",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-30",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-executor") {
      return ok({ ok: true, id: "gh-30", executor: "agent-custom-ws" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(
    baseCtx(runner, { paseoNewWorkspace: "worktree" }),
  );
  assertEquals(result.outcome, "launched");
  const runCall = runner.calls.find((c) =>
    c.cmd === "paseo" && c.args[0] === "run"
  );
  assert(runCall, "paseo run が呼ばれているべき");
  assertEquals(
    runCall!.args[runCall!.args.indexOf("--new-workspace") + 1],
    "worktree",
  );
});

Deno.test("runCycle/takeover: owned workspace id は stdout/stderr どちらの Created workspace 行からも拾う", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "run") {
        return {
          code: 0,
          stdout: JSON.stringify({
            agentId: "agent-new-owned",
            status: "running",
          }),
          // 実測 (paseo 0.4.0): Created workspace 通知は stderr に出る。
          stderr: "Created workspace wks_owned123 - proj\nTip: ...\n",
        };
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-14",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: false,
            replaces: null,
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-14",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-14",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-executor") {
      return ok({ ok: true, id: "gh-14", executor: "agent-new-owned" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.outcome, "launched");
  assertEquals(
    (result.detail as Record<string, unknown>).workspaceId,
    "wks_owned123",
  );
});

Deno.test("runCycle/takeover: worktree が無ければ git worktree add してから launch する", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "git") {
      if (args.includes("rev-parse") && args.includes("--git-common-dir")) {
        return ok(undefined); // unused: resolveProjectRoot はスタブ済み
      }
      if (args.includes("worktree")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("fetch") || args.includes("merge")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "run") {
        return ok({ agentId: "agent-new-2", status: "running" });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-3",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: true,
            replaces: null,
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-3",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: null,
          base: null,
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-worktree") {
      return ok({
        ok: true,
        id: "gh-3",
        worktree: "/fake/project/.claude/worktrees/task-pipeline/gh-3",
        base: "main",
      });
    }
    if (verb === "set-executor") {
      return ok({ ok: true, id: "gh-3", executor: "agent-new-2" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.outcome, "launched");

  const worktreeAddCall = runner.calls.find((c) =>
    c.cmd === "git" && c.args.includes("worktree")
  );
  assert(worktreeAddCall, "git worktree add が呼ばれているべき");
  assertEquals(worktreeAddCall!.args, [
    "-C",
    "/fake/project",
    "worktree",
    "add",
    "-b",
    "task-pipeline/gh-3",
    "/fake/project/.claude/worktrees/task-pipeline/gh-3",
    "HEAD",
  ]);

  const setWorktreeCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "set-worktree"
  );
  assert(setWorktreeCall, "set-worktree が呼ばれているべき");

  const runCall = runner.calls.find((c) =>
    c.cmd === "paseo" && c.args[0] === "run"
  );
  assertEquals(
    runCall!.args[runCall!.args.indexOf("--cwd") + 1],
    "/fake/project/.claude/worktrees/task-pipeline/gh-3",
  );
});

Deno.test("runCycle/takeover: worktree add が二重に競合したら重複起動せず skipped-duplicate で退く (gh-140 dogfood 実測)", async () => {
  let addAttempts = 0;
  let getCalls = 0;
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "git") {
      if (args.includes("rev-parse") && args.includes("--git-common-dir")) {
        return ok(undefined); // unused: resolveProjectRoot はスタブ済み
      }
      if (args.includes("worktree")) {
        addAttempts += 1;
        if (addAttempts === 1) {
          // 1回目 (-b 付き): 相手が同時に同じブランチ名で先勝ちした。
          return {
            code: 1,
            stdout: "",
            stderr: "fatal: a branch named 'task-pipeline/gh-4' already exists",
          };
        }
        // 2回目 (-b を落として再試行): 相手の worktree が既に path を占有している。
        return {
          code: 1,
          stdout: "",
          stderr:
            "fatal: '/fake/project/.claude/worktrees/task-pipeline/gh-4' already exists",
        };
      }
      if (args.includes("fetch") || args.includes("merge")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "run") {
        return ok({
          agentId: "agent-loser-should-not-launch",
          status: "running",
        });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-4",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: true,
            replaces: null,
          }],
        }],
      });
    }
    if (verb === "get") {
      getCalls += 1;
      // 1回目の get (handleTakeover 冒頭) は worktree 未確定のまま、レース後の
      // resolveWorktree からの2回目の get で初めて先勝ちの記録が見える。
      const winnerRecorded = getCalls >= 2;
      return ok({
        queue: [{
          id: "gh-4",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: winnerRecorded
            ? "/fake/project/.claude/worktrees/task-pipeline/gh-4"
            : null,
          base: winnerRecorded ? "main" : null,
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-executor") {
      return ok({
        ok: true,
        id: "gh-4",
        executor: "agent-loser-should-not-launch",
      });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.outcome, "skipped-duplicate");
  assertEquals(addAttempts, 2, "-b 付きと reuseBranch の2回とも試みているべき");

  const runCall = runner.calls.find((c) =>
    c.cmd === "paseo" && c.args[0] === "run"
  );
  assert(
    !runCall,
    "worktree レースに負けたと確定したら paseo run へは進まず、実エージェントを二重起動してはならない",
  );

  const setExecutorCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "set-executor"
  );
  assert(!setExecutorCall, "重複起動を諦めた側は set-executor も呼ばない");

  const setWorktreeCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "set-worktree"
  );
  assert(
    !setWorktreeCall,
    "先勝ちの記録を採用した側は set-worktree を呼び直してはならない (二重記録の防止)",
  );
});

Deno.test("runCycle/takeover: replaces が非null なら旧executorをpaseo stopしてから起動する (失敗しても続行)", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([]);
      if (args[0] === "stop") return fail("agent not reachable", 1);
      if (args[0] === "run") {
        return ok({ agentId: "agent-new-3", status: "running" });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-9",
          actions: [{
            kind: "takeover",
            reason: "takeover-elapsed",
            resume_phase: "implement",
            recheck_gate: false,
            needs_worktree: false,
            replaces: "agent-old",
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-9",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "implement",
            attempts: 0,
            executor: "agent-old",
            executor_last_event_at: "2026-08-20T08:00:00.000Z",
            takeover_at: "2026-08-20T08:30:00.000Z",
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-9",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    if (verb === "set-executor") {
      return ok({ ok: true, id: "gh-9", executor: "agent-new-3" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.outcome, "launched");

  const stopCall = runner.calls.find((c) =>
    c.cmd === "paseo" && c.args[0] === "stop"
  );
  assert(stopCall, "paseo stop が呼ばれているべき");
  assertEquals(stopCall!.args, ["stop", "agent-old", "--json"]);

  const setExecCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "set-executor"
  );
  assert(setExecCall, "stop が失敗しても set-executor は呼ばれるべき");
  assertEquals(
    setExecCall!.args[setExecCall!.args.indexOf("--expect-executor") + 1],
    "agent-old",
  );
});

Deno.test("runCycle/takeover: 生存中の重複エージェントが在れば launch せずに skip する", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "ls") return ok([{ id: "agent-dup", status: "running" }]);
      throw new Error(`paseo run は呼ばれてはならない: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-4",
          actions: [{
            kind: "takeover",
            reason: "no-executor",
            resume_phase: "research",
            recheck_gate: false,
            needs_worktree: false,
            replaces: null,
          }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-4",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "research",
            attempts: 0,
            executor: null,
            executor_last_event_at: null,
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-4",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    throw new Error(
      `set-executor は呼ばれてはならない: ${cmd} ${args.join(" ")}`,
    );
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.outcome, "skipped-duplicate");
  assert(!runner.calls.some((c) => stateVerbOf(c.args) === "set-executor"));
});

Deno.test("runCycle/status-check: 鮮度3条件を満たせば touch-executor を呼ぶ", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "wait") {
        return ok({
          agentId: "agent-live",
          status: "idle",
          message:
            "Agent is idle.\nLast 5 activity items:\nPHASE implement DONE — ok",
        });
      }
      if (args[0] === "inspect") {
        return ok({ Status: "idle", UpdatedAt: "2026-08-20T10:00:00.000Z" });
      }
      throw new Error(`unexpected paseo call: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{ id: "gh-5", actions: [{ kind: "status-check" }] }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-5",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "implement",
            attempts: 0,
            executor: "agent-live",
            executor_last_event_at: "2026-08-20T09:00:00.000Z",
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-5",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    if (verb === "touch-executor") return ok({ ok: true, id: "gh-5" });
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result, {
    op: "status-check",
    id: "gh-5",
    outcome: "touched",
    detail: { executor: "agent-live" },
  });

  const touchCall = runner.calls.find((c) =>
    stateVerbOf(c.args) === "touch-executor"
  );
  assert(touchCall);
  assertEquals(
    touchCall!.args[touchCall!.args.indexOf("--expect-executor") + 1],
    "agent-live",
  );
});

Deno.test("runCycle/wait: idle でも protocol 行が無ければ touch-executor を呼ばない", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo") {
      if (args[0] === "wait") {
        return ok({
          agentId: "agent-live",
          status: "idle",
          message: "[User] hi",
        });
      }
      throw new Error(`inspect は呼ばれるべきではない: ${args.join(" ")}`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-6",
          actions: [{ kind: "wait", reason: "executor-alive" }],
        }],
      });
    }
    if (verb === "get") {
      return ok({
        queue: [{
          id: "gh-6",
          title: "t",
          progress: "running",
          run: {
            kind: "initial",
            gate: "full",
            phase: "implement",
            attempts: 0,
            executor: "agent-live",
            executor_last_event_at: "2026-08-20T09:00:00.000Z",
            takeover_at: null,
            verifier: null,
            verifier_session: null,
          },
          blocked_reason: null,
          artifact: { state: "none" },
          worktree: "/wt/gh-6",
          base: "main",
          session: "sess-self",
        }],
      });
    }
    throw new Error(
      `touch-executor は呼ばれてはならない: ${cmd} ${args.join(" ")}`,
    );
  });

  const result = await runCycle(baseCtx(runner));
  assertEquals(result.op, "wait");
  assertEquals(result.outcome, "stale");
});

Deno.test("runCycle/deferred: 範囲外の9 kindは実行せず素通りする", async () => {
  const runner = new StubRunner((cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [{
          id: "gh-7",
          actions: [{ kind: "fix-give-up", reason: "fix_stagnant" }],
        }],
      });
    }
    throw new Error(`next 以外は呼ばれてはならない: ${cmd} ${args.join(" ")}`);
  });
  const result = await runCycle(baseCtx(runner));
  assertEquals(result, {
    op: "deferred",
    id: "gh-7",
    outcome: "skipped-out-of-scope",
    detail: { kind: "fix-give-up" },
  });
});

Deno.test("runCycle/deferred: 先頭が deferred でも後続の claim を実行する (deferred で永久に遮らない)", async () => {
  const runner = new StubRunner((cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [
          {
            id: "gh-10",
            actions: [{ kind: "fix-give-up", reason: "fix_stagnant" }],
          },
          { id: "gh-11", actions: [{ kind: "claim" }] },
        ],
      });
    }
    if (verb === "claim") return ok({ ok: true, id: "gh-11" });
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });
  const result = await runCycle(baseCtx(runner));
  assertEquals(result, { op: "claim", id: "gh-11", outcome: "claimed" });
});

Deno.test("runCycle/deferred: deferred しか無ければ最初の deferred を報告する", async () => {
  const runner = new StubRunner((cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        tasks: [
          { id: "gh-12", actions: [{ kind: "clear-takeover" }] },
          {
            id: "gh-13",
            actions: [{ kind: "set-takeover", reason: "owner-dead-silent" }],
          },
        ],
      });
    }
    throw new Error(`next 以外は呼ばれてはならない: ${cmd} ${args.join(" ")}`);
  });
  const result = await runCycle(baseCtx(runner));
  assertEquals(result, {
    op: "deferred",
    id: "gh-12",
    outcome: "skipped-out-of-scope",
    detail: { kind: "clear-takeover" },
  });
});

Deno.test("runCycle: due なタスクが無ければ idle で終える", async () => {
  const runner = new StubRunner((_cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") return ok({ tasks: [{ id: "gh-8", actions: [] }] });
    throw new Error("next 以外は呼ばれてはならない");
  });
  const result = await runCycle(baseCtx(runner));
  assertEquals(result, { op: "none", id: null, outcome: "idle" });
});

Deno.test("runCycle: state.ts の非ゼロ終了は DriverError として伝播する", async () => {
  const runner = new StubRunner((_cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") return fail("boom", 12);
    throw new Error("next 以外は呼ばれてはならない");
  });
  let threw = false;
  try {
    await runCycle(baseCtx(runner));
  } catch (e) {
    threw = true;
    assert(String((e as Error).message).includes("state.ts next failed"));
  }
  assert(threw);
});

// ---------------------------------------------------------------------------
// CLI: main() の usage エラー経路 (実プロセスは spawn しない)
// ---------------------------------------------------------------------------

Deno.test("main: --state-dir が無ければ usage エラーで exit 1", async () => {
  const code = await main([]);
  assertEquals(code, 1);
});

Deno.test("main --replay-next without --observe: usage エラー (受け入れ条件7)", async () => {
  const lines = await captureConsoleLog(async () => {
    const code = await main(["--replay-next", "/tmp/whatever.json"]);
    assertEquals(code, 1);
  });
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { error: string };
  assert(
    typeof parsed.error === "string" && parsed.error.length > 0,
    "error メッセージが含まれるべき",
  );
});

// ---------------------------------------------------------------------------
// O: observe モード (gh-142 Phase2 Task 2-2a) — 副作用ゼロの観測と next 応答リプレイ
// ---------------------------------------------------------------------------

async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => {
    lines.push(String(msg));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const OBSERVE_NEXT_NOW = "2026-08-21T00:00:00.000Z";

Deno.test("runObserveCycle/live: state.ts の書き込み系 verb を一切呼ばない (受け入れ条件1)", async () => {
  const runner = new StubRunner((_cmd, args) => {
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        now: OBSERVE_NEXT_NOW,
        tasks: [
          { id: "gh-o1", actions: [{ kind: "claim" }] },
          {
            id: "gh-o2",
            actions: [{
              kind: "takeover",
              reason: "owner-dead-silent",
              resume_phase: "research",
              recheck_gate: false,
              needs_worktree: false,
              replaces: null,
            }],
          },
        ],
      });
    }
    throw new Error(
      `observe は next 以外を呼んではならない: ${args.join(" ")}`,
    );
  });
  const record = await runObserveCycle({
    runner,
    stateDir: "/fake/.task-pipeline",
    nextOpts: {},
    sequence: 0,
    observedAt: "2026-08-21T00:00:01.000Z",
  });
  assertEquals(record.source, "live");
  // 呼ばれた state.ts 呼び出しが `next` の1回だけであることを直接確認する
  // (= claim/set-executor/touch-executor/set-worktree のいずれも呼ばれていない)。
  assertEquals(runner.calls.length, 1);
  assertEquals(stateVerbOf(runner.calls[0].args), "next");
});

Deno.test("runObserveCycle/live: paseo/git サブプロセスを一切呼ばない (受け入れ条件2)", async () => {
  const runner = new StubRunner((cmd, args) => {
    if (cmd === "paseo" || cmd === "git") {
      throw new Error(`observe は ${cmd} を呼んではならない`);
    }
    const verb = stateVerbOf(args);
    if (verb === "next") {
      return ok({
        now: OBSERVE_NEXT_NOW,
        tasks: [{
          id: "gh-o3",
          actions: [{ kind: "wait", reason: "executor-alive" }],
        }],
      });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  });
  const record = await runObserveCycle({
    runner,
    stateDir: "/fake/.task-pipeline",
    nextOpts: {},
    sequence: 0,
    observedAt: "2026-08-21T00:00:01.000Z",
  });
  assertEquals(record.selected, {
    op: "wait",
    id: "gh-o3",
    outcome: "would-touch-executor",
    detail: { reason: "executor-alive" },
  });
  assert(runner.calls.every((c) => c.cmd !== "paseo" && c.cmd !== "git"));
});

Deno.test("runObserveCycle/replay: state.ts へのサブプロセス呼び出しが完全に0回になる (受け入れ条件3)", async () => {
  const runner = new StubRunner((cmd, args) => {
    throw new Error(
      `replay は subprocess を一切呼んではならない: ${cmd} ${args.join(" ")}`,
    );
  });
  const replayText = JSON.stringify({
    now: OBSERVE_NEXT_NOW,
    tasks: [{ id: "gh-o4", actions: [{ kind: "claim" }] }],
  });
  const record = await runObserveCycle({
    runner,
    stateDir: "/fake/.task-pipeline",
    nextOpts: {},
    sequence: 0,
    observedAt: "2026-08-21T00:00:01.000Z",
    replayNextText: replayText,
  });
  assertEquals(record.source, "replay");
  assertEquals(runner.calls.length, 0);
});

Deno.test("runObserveCycle/replay: 同じ入力を複数回渡すと payload_digest が毎回同一 (受け入れ条件3)", async () => {
  const runner = new StubRunner(() => {
    throw new Error("replay は subprocess を呼んではならない");
  });
  const replayText = JSON.stringify({
    now: OBSERVE_NEXT_NOW,
    tasks: [{ id: "gh-o5", actions: [] }],
  });
  const first = await runObserveCycle({
    runner,
    stateDir: "/fake",
    nextOpts: {},
    sequence: 0,
    observedAt: "t1",
    replayNextText: replayText,
  });
  const second = await runObserveCycle({
    runner,
    stateDir: "/fake",
    nextOpts: {},
    sequence: 1,
    observedAt: "t2",
    replayNextText: replayText,
  });
  assertEquals(first.payload_digest, second.payload_digest);
  assertEquals(first.payload_digest.length, 64, "sha256 hex は64文字");
});

Deno.test("planObserveTasks: actions[] の全要素 (actions[1] 以降も含む) を分類する (受け入れ条件4)", () => {
  const tasks = planObserveTasks([
    {
      id: "gh-o6",
      actions: [
        { kind: "wait", reason: "executor-alive" },
        { kind: "claim" },
        { kind: "fix-give-up", reason: "fix_stagnant" },
      ],
    },
  ] as unknown as NextTask[]);
  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].actions.length, 3);
  assertEquals(tasks[0].actions[0], {
    index: 0,
    op: "wait",
    verb: null,
    flags: [],
    reason: "executor-alive",
  });
  assertEquals(tasks[0].actions[1], {
    index: 1,
    op: "claim",
    verb: "claim",
    flags: ["state-dir", "id", "session"],
  });
  assertEquals(tasks[0].actions[2], {
    index: 2,
    op: "deferred",
    kind: "fix-give-up",
  });
});

Deno.test("selectObserveOperation: deferred を後回しにしつつ claim/takeover/status-check/wait から選ぶ (受け入れ条件5)", () => {
  const claimAfterDeferred = selectObserveOperation([
    { id: "gh-o7", actions: [{ kind: "clear-takeover" }] },
    { id: "gh-o8", actions: [{ kind: "claim" }] },
  ] as unknown as NextTask[]);
  assertEquals(claimAfterDeferred, {
    op: "claim",
    id: "gh-o8",
    outcome: "would-claim",
  });

  const onlyDeferred = selectObserveOperation(
    [{
      id: "gh-o9",
      actions: [{ kind: "clear-takeover" }],
    }] as unknown as NextTask[],
  );
  assertEquals(onlyDeferred, {
    op: "deferred",
    id: "gh-o9",
    outcome: "skipped-out-of-scope",
    detail: { kind: "clear-takeover" },
  });

  const idle = selectObserveOperation(
    [{ id: "gh-o10", actions: [] }] as unknown as NextTask[],
  );
  assertEquals(idle, { op: "none", id: null, outcome: "idle" });

  const takeover = selectObserveOperation([{
    id: "gh-o11",
    actions: [{
      kind: "takeover",
      reason: "owner-dead-silent",
      resume_phase: "research",
      recheck_gate: true,
      needs_worktree: false,
      replaces: "agent-old",
    }],
  }] as unknown as NextTask[]);
  assertEquals(takeover, {
    op: "takeover",
    id: "gh-o11",
    outcome: "would-set-executor",
    detail: {
      reason: "owner-dead-silent",
      resume_phase: "research",
      recheck_gate: true,
      needs_worktree: false,
      replaces: "agent-old",
    },
  });

  const statusCheck = selectObserveOperation(
    [{
      id: "gh-o13",
      actions: [{ kind: "status-check" }],
    }] as unknown as NextTask[],
  );
  assertEquals(statusCheck, {
    op: "status-check",
    id: "gh-o13",
    outcome: "would-touch-executor",
  });

  const wait = selectObserveOperation(
    [{
      id: "gh-o14",
      actions: [{ kind: "wait", reason: "executor-alive" }],
    }] as unknown as NextTask[],
  );
  assertEquals(wait, {
    op: "wait",
    id: "gh-o14",
    outcome: "would-touch-executor",
    detail: { reason: "executor-alive" },
  });
});

Deno.test("appendObserveRecord: .task-pipeline/driver/observe-<run-id>.jsonl に追記する (受け入れ条件6)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record = {
      schema_version: 1,
      sequence: 0,
      observed_at: "2026-08-21T00:00:00.000Z",
      source: "live",
      next_now: OBSERVE_NEXT_NOW,
      session: "sess-1",
      alive: null,
      config: null,
      dead_tasks: null,
      payload_digest: "abc123",
      tasks: [],
      selected: { op: "none", id: null, outcome: "idle" },
    } as unknown as ObserveRecord;
    await appendObserveRecord(dir, "run-xyz", record);
    const filePath = `${dir}/driver/observe-run-xyz.jsonl`;
    const content = await Deno.readTextFile(filePath);
    assertEquals(content, `${JSON.stringify(record)}\n`);

    // 同一 run-id への2回目の呼び出しは追記になる (1プロセスの全サイクルで同じファイルへ書く)。
    await appendObserveRecord(dir, "run-xyz", { ...record, sequence: 1 });
    const appended = await Deno.readTextFile(filePath);
    assertEquals(appended.split("\n").filter((l) => l !== "").length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// L: runObserveLoop — observe の常駐ループ
// ---------------------------------------------------------------------------

Deno.test("runObserveLoop: --max-cycles 3 でちょうど3サイクル実行され、直列に完走する (受け入れ条件1,2)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        return ok({ now: OBSERVE_NEXT_NOW, tasks: [] });
      }
      throw new Error(
        `observe ループは next 以外を呼んではならない: ${args.join(" ")}`,
      );
    });
    const records = await runObserveLoop({
      runner,
      stateDir: dir,
      nextOpts: {},
      intervalSec: 0,
      maxCycles: 3,
      signal: new AbortController().signal,
    });
    assertEquals(nextCalls, 3);
    assertEquals(records.length, 3);
    // 各サイクルが直列に完走している証拠: sequence が重複せず 0,1,2 の連番になっている
    // (ループ本体は await で直列化されているので、2サイクルが同時に走ることは構造的に無い)。
    assertEquals(records.map((r) => r.sequence), [0, 1, 2]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runObserveLoop: --max-cycles 1 で1サイクルだけ実行される (境界)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        return ok({ now: OBSERVE_NEXT_NOW, tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    const records = await runObserveLoop({
      runner,
      stateDir: dir,
      nextOpts: {},
      intervalSec: 0,
      maxCycles: 1,
      signal: new AbortController().signal,
    });
    assertEquals(nextCalls, 1);
    assertEquals(records.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runObserveLoop: 2サイクル目で例外が起きるとそこで終了し3サイクル目は呼ばれない (受け入れ条件4)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        if (nextCalls === 2) return fail("boom", 7);
        return ok({ now: OBSERVE_NEXT_NOW, tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    let threw: unknown = null;
    try {
      await runObserveLoop({
        runner,
        stateDir: dir,
        nextOpts: {},
        intervalSec: 0,
        signal: new AbortController().signal,
      });
    } catch (e) {
      threw = e;
    }
    assert(
      threw instanceof Error,
      "2サイクル目の失敗が呼び出し元へ伝播するべき",
    );
    assertEquals(nextCalls, 2, "3サイクル目の next は呼ばれてはならない");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runObserveLoop: 1サイクル完走直後に abort されていれば次のサイクルへ入らない (受け入れ条件5 単体a)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const controller = new AbortController();
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        return ok({ now: OBSERVE_NEXT_NOW, tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    const records = await runObserveLoop({
      runner,
      stateDir: dir,
      nextOpts: {},
      intervalSec: 0,
      signal: controller.signal,
      onRecord: () => controller.abort(),
    });
    assertEquals(nextCalls, 1);
    assertEquals(records.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runObserveLoop: interval 待機中の abort は interval 満了を待たずに解決する (受け入れ条件5 単体b)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const controller = new AbortController();
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        return ok({ now: OBSERVE_NEXT_NOW, tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    const start = performance.now();
    const records = await runObserveLoop({
      runner,
      stateDir: dir,
      nextOpts: {},
      intervalSec: 3600, // 満了まで待てば1時間かかる長い interval
      signal: controller.signal,
      // 1回目の record を受け取った直後 (= sleepAbortable に入る直前) に abort を予約する。
      // 実際に発火するのは sleepAbortable が addEventListener した後 (マイクロタスク後)。
      onRecord: () => {
        queueMicrotask(() => controller.abort());
      },
    });
    const elapsedMs = performance.now() - start;
    assertEquals(nextCalls, 1);
    assertEquals(records.length, 1);
    assert(
      elapsedMs < 1000,
      `sleepAbortable が abort を待たずに interval 満了 (3600秒) まで待ってしまった (${elapsedMs}ms)`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDispatchLoop: --max-cycles 3 でちょうど3サイクル実行され、結果を通知する", async () => {
  let nextCalls = 0;
  const notified: unknown[] = [];
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") {
      nextCalls += 1;
      return ok({ tasks: [] });
    }
    throw new Error(`next 以外は呼ばれてはならない: ${args.join(" ")}`);
  });
  const params: DispatchLoopParams = {
    context: baseCtx(runner),
    intervalSec: 0,
    maxCycles: 3,
    signal: new AbortController().signal,
    onResult: (result) => notified.push(result),
  };
  const results = await runDispatchLoop(params);
  assertEquals(nextCalls, 3);
  assertEquals(results.length, 3);
  assertEquals(notified, results);
});

Deno.test("runDispatchLoop: --max-cycles 0 では0サイクルで即時終了する", async () => {
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") nextCalls += 1;
    return ok({ tasks: [] });
  });
  const results = await runDispatchLoop({
    context: baseCtx(runner),
    maxCycles: 0,
    signal: new AbortController().signal,
  });
  assertEquals(nextCalls, 0);
  assertEquals(results, []);
});

Deno.test("runDispatchLoop: --max-cycles 1 では1サイクルだけ実行される", async () => {
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") {
      nextCalls += 1;
      return ok({ tasks: [] });
    }
    throw new Error("next 以外は呼ばれてはならない");
  });
  const results = await runDispatchLoop({
    context: baseCtx(runner),
    intervalSec: 0,
    maxCycles: 1,
    signal: new AbortController().signal,
  });
  assertEquals(nextCalls, 1);
  assertEquals(results.length, 1);
});

Deno.test("runDispatchLoop: 前サイクル完了まで次サイクルを開始しない", async () => {
  let cycle = 0;
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) !== "next") {
      throw new Error("next 以外は呼ばれてはならない");
    }
    const current = cycle++;
    order.push(`start-${current}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<CommandResult>((resolve) => {
      queueMicrotask(() => {
        order.push(`end-${current}`);
        active -= 1;
        resolve(ok({ tasks: [] }));
      });
    });
  });
  await runDispatchLoop({
    context: baseCtx(runner),
    intervalSec: 0,
    maxCycles: 2,
    signal: new AbortController().signal,
  });
  assertEquals(order, ["start-0", "end-0", "start-1", "end-1"]);
  assertEquals(maxActive, 1);
});

Deno.test("runDispatchLoop: サイクルの例外を伝播させ後続サイクルを実行しない", async () => {
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) !== "next") {
      throw new Error("next 以外は呼ばれてはならない");
    }
    nextCalls += 1;
    return nextCalls === 2 ? fail("boom", 7) : ok({ tasks: [] });
  });
  let threw: unknown = null;
  try {
    await runDispatchLoop({
      context: baseCtx(runner),
      intervalSec: 0,
      signal: new AbortController().signal,
    });
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof Error);
  assertEquals(nextCalls, 2);
});

Deno.test("runDispatchLoop: 開始前から AbortSignal が aborted なら空の結果で終了する", async () => {
  const controller = new AbortController();
  controller.abort();
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") nextCalls += 1;
    return ok({ tasks: [] });
  });
  const results = await runDispatchLoop({
    context: baseCtx(runner),
    signal: controller.signal,
  });
  assertEquals(nextCalls, 0);
  assertEquals(results, []);
});

Deno.test("runDispatchLoop: サイクル完走後の signal.aborted で次サイクルを開始しない", async () => {
  const controller = new AbortController();
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") {
      nextCalls += 1;
      return ok({ tasks: [] });
    }
    throw new Error("next 以外は呼ばれてはならない");
  });
  const results = await runDispatchLoop({
    context: baseCtx(runner),
    signal: controller.signal,
    onResult: () => controller.abort(),
  });
  assertEquals(nextCalls, 1);
  assertEquals(results.length, 1);
});

Deno.test("runDispatchLoop: interval 待機中の abort は満了を待たずに解決する", async () => {
  const controller = new AbortController();
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") {
      nextCalls += 1;
      return ok({ tasks: [] });
    }
    throw new Error("next 以外は呼ばれてはならない");
  });
  const start = performance.now();
  const results = await runDispatchLoop({
    context: baseCtx(runner),
    intervalSec: 3600,
    signal: controller.signal,
    onResult: () => queueMicrotask(() => controller.abort()),
  });
  const elapsedMs = performance.now() - start;
  assertEquals(nextCalls, 1);
  assertEquals(results.length, 1);
  assert(elapsedMs < 1000, `abort 後も interval を待機した (${elapsedMs}ms)`);
});

Deno.test("runDispatchLoop: intervalSec 未指定でも既定の待機を適用する", async () => {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ) => {
    delays.push(timeout ?? 0);
    queueMicrotask(() => {
      if (typeof handler === "function") {
        (handler as (...callbackArgs: unknown[]) => void)(...args);
      }
    });
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    let nextCalls = 0;
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        nextCalls += 1;
        return ok({ tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    const results = await runDispatchLoop({
      context: baseCtx(runner),
      maxCycles: 2,
      signal: new AbortController().signal,
    });
    assertEquals(nextCalls, 2);
    assertEquals(results.length, 2);
    assertEquals(delays, [DEFAULT_DISPATCH_LOOP_INTERVAL_SEC * 1000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

Deno.test("runDispatchLoop: 明示的な正の interval を待機してから次サイクルへ進む", async () => {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ) => {
    delays.push(timeout ?? 0);
    queueMicrotask(() => {
      if (typeof handler === "function") {
        (handler as (...callbackArgs: unknown[]) => void)(...args);
      }
    });
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    const order: string[] = [];
    const runner = new StubRunner((_cmd, args) => {
      if (stateVerbOf(args) === "next") {
        order.push(`next-${order.length}`);
        return ok({ tasks: [] });
      }
      throw new Error("next 以外は呼ばれてはならない");
    });
    const results = await runDispatchLoop({
      context: baseCtx(runner),
      intervalSec: 1,
      maxCycles: 2,
      signal: new AbortController().signal,
    });
    assertEquals(results.length, 2);
    assertEquals(order, ["next-0", "next-1"]);
    assertEquals(delays, [1000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

Deno.test("runDispatchLoop: runner と stateDir の直接指定で動作する", async () => {
  let nextCalls = 0;
  const runner = new StubRunner((_cmd, args) => {
    if (stateVerbOf(args) === "next") {
      nextCalls += 1;
      return ok({ tasks: [] });
    }
    throw new Error("next 以外は呼ばれてはならない");
  });
  const results = await runDispatchLoop({
    runner,
    stateDir: "/fake/.task-pipeline",
    intervalSec: 0,
    maxCycles: 1,
    signal: new AbortController().signal,
  });
  assertEquals(nextCalls, 1);
  assertEquals(results.length, 1);
});

Deno.test("main: --loop 指定時でも --state-dir 欠落は usage エラーになる", async () => {
  const lines = await captureConsoleLog(async () => {
    const code = await main(["--loop", "true"]);
    assertEquals(code, 1);
  });
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { error: string };
  assert(
    typeof parsed.error === "string" && parsed.error.length > 0,
    "error メッセージが含まれるべき",
  );
});

Deno.test("main: loop && !observe で複数サイクルを実行し結果をストリーミングする", async () => {
  const dir = await Deno.makeTempDir();
  const stateDir = `${dir}/.task-pipeline`;
  try {
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(
      `${stateDir}/state.json`,
      JSON.stringify({
        tracker: "gh",
        source: "",
        updated_at: new Date().toISOString(),
        queue: [],
        candidates: [],
        relisted: [],
        promoted: [],
        completed: [],
        withdrawn_branches: [],
        history: [],
        history_archived: 0,
        schema_version: 2,
      }),
    );
    let code = -1;
    const lines = await captureConsoleLog(async () => {
      code = await main([
        "--loop",
        "true",
        "--interval-sec",
        "0",
        "--max-cycles",
        "2",
        "--state-dir",
        stateDir,
        "--session",
        "dispatch-test-session",
      ]);
    });
    assertEquals(code, 0);
    assertEquals(lines.length, 2);
    assertEquals(JSON.parse(lines[0]).outcome, "idle");
    assertEquals(JSON.parse(lines[1]).outcome, "idle");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main: loop && !observe で --max-cycles 0 は exit 0", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let code = -1;
    const lines = await captureConsoleLog(async () => {
      code = await main([
        "--loop",
        "true",
        "--max-cycles",
        "0",
        "--state-dir",
        `${dir}/.task-pipeline`,
      ]);
    });
    assertEquals(code, 0);
    assertEquals(lines, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main: loop && !observe で --max-cycles の非整数は usage エラー", async () => {
  const lines = await captureConsoleLog(async () => {
    const code = await main([
      "--loop",
      "true",
      "--max-cycles",
      "abc",
      "--state-dir",
      "/fake/.task-pipeline",
    ]);
    assertEquals(code, 1);
  });
  assertEquals(lines.length, 1);
  assert(JSON.parse(lines[0]).error.includes('invalid --max-cycles: "abc"'));
});

Deno.test("main: loop && !observe で --interval-sec の非整数は usage エラー", async () => {
  const lines = await captureConsoleLog(async () => {
    const code = await main([
      "--loop",
      "true",
      "--interval-sec",
      "abc",
      "--state-dir",
      "/fake/.task-pipeline",
    ]);
    assertEquals(code, 1);
  });
  assertEquals(lines.length, 1);
  assert(JSON.parse(lines[0]).error.includes('invalid --interval-sec: "abc"'));
});

Deno.test("main --observe --replay-next: 標準出力にのみ書き、.task-pipeline/driver/ を作らない (受け入れ条件3,6)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const replayFile = `${dir}/replay-next.json`;
    await Deno.writeTextFile(
      replayFile,
      JSON.stringify({
        now: OBSERVE_NEXT_NOW,
        tasks: [{ id: "gh-o12", actions: [{ kind: "claim" }] }],
      }),
    );
    const stateDir = `${dir}/.task-pipeline`;
    let code = -1;
    const lines = await captureConsoleLog(async () => {
      code = await main([
        "--observe",
        "true",
        "--replay-next",
        replayFile,
        "--state-dir",
        stateDir,
      ]);
    });
    assertEquals(code, 0);
    assertEquals(lines.length, 1);
    const record = JSON.parse(lines[0]) as ObserveRecord;
    assertEquals(record.source, "replay");
    assertEquals(record.selected, {
      op: "claim",
      id: "gh-o12",
      outcome: "would-claim",
    });
    let driverDirExists = true;
    try {
      await Deno.stat(`${stateDir}/driver`);
    } catch {
      driverDirExists = false;
    }
    assert(!driverDirExists, ".task-pipeline/driver/ は replay では作られない");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// E2E: 実 paseo で takeover サイクルを1回実行する統合テスト
//
// **既定では実行しない** — 実際に Paseo エージェントを1体起動する (課金・実行時間を伴い、
// daemon の認証状態にも依存する) ため、明示的に環境変数 `TASK_PIPELINE_E2E=1` を立てた
// ときだけ実行する。それ以外 (未設定 / paseo が無い / daemon 到達不能 / 無人実行できる
// provider が無い) では常にスキップする — このリポジトリの CI 環境には通常 paseo は
// 無いため、既定では常にスキップされる。
//
// 手元で明示して回す例:
//   TASK_PIPELINE_E2E=1 deno test --allow-all \
//     task-pipeline/scripts/pipeline-driver.test.ts
//
// 実行された場合は実際に `paseo run -d --json` でエージェントを起動し、
// `paseo inspect` で存在と Cwd を確認し、`run.executor` が state.json に記録された
// ことを検証してから、起動したエージェントと (作られていれば) owned workspace を
// archive で片付ける。
//
// pipeline-driver.ts の既定値は "local" (#148, #150 整合: agent-scoped 実行環境でも
// --cwd の隔離を確実に効かせるため)。この E2E テストでは明示指定の動作確認を兼ねて
// `--paseo-new-workspace local` を渡している。
// ---------------------------------------------------------------------------

interface PaseoAvailability {
  readonly available: boolean;
  readonly provider: string | null;
  readonly reason: string;
}

async function detectPaseoAvailability(): Promise<PaseoAvailability> {
  try {
    const version = new Deno.Command("paseo", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10_000),
    });
    const versionResult = await version.output();
    if (versionResult.code !== 0) {
      return {
        available: false,
        provider: null,
        reason: "paseo --version failed",
      };
    }
  } catch {
    return {
      available: false,
      provider: null,
      reason: "paseo binary not found",
    };
  }

  try {
    const listCmd = new Deno.Command("paseo", {
      args: ["provider", "ls", "--json"],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10_000),
    });
    const listResult = await listCmd.output();
    if (listResult.code !== 0) {
      return {
        available: false,
        provider: null,
        reason: "paseo daemon unreachable",
      };
    }
    const providers = JSON.parse(
      new TextDecoder().decode(listResult.stdout),
    ) as Array<
      { provider: string; status: string }
    >;
    // 無人実行できる mode を確実に持つ組 (agent-launch.md) だけを候補にする。
    const candidate = providers.find(
      (p) =>
        (p.provider === "omp" || p.provider === "claude") &&
        p.status === "available",
    );
    if (!candidate) {
      return {
        available: false,
        provider: null,
        reason: "no available claude/omp provider",
      };
    }
    return { available: true, provider: candidate.provider, reason: "ok" };
  } catch {
    return {
      available: false,
      provider: null,
      reason: "paseo provider ls failed",
    };
  }
}

const TASK_PIPELINE_E2E = Deno.env.get("TASK_PIPELINE_E2E") === "1";

const E2E_TEST_NAME =
  "e2e/smoke: 実 paseo で takeover サイクルを1回実行し、実エージェント起動・Cwd・run.executor 記録を確認する";

// `Deno.test({ ignore })` は使わない — CI の「ignored のあるテストは失敗扱い」ゲートに
// 引っかかるため。既定 (TASK_PIPELINE_E2E 未設定) では `Deno.test` を一切呼ばず、
// 明示的に opt-in したときだけ動的に登録する。
async function runE2eSmokeTest(provider: string): Promise<void> {
  const scratch = await Deno.makeTempDir({ prefix: "pipeline-driver-e2e-" });
  const stateDir = `${scratch}/.task-pipeline`;
  await Deno.mkdir(`${stateDir}/tasks`, { recursive: true });
  const taskId = "smoke-136";
  const worktree = scratch; // 実 git worktree 作成は unit 側で検証済みなので、ここでは
  // 既に worktree が割り当たっている状態から始めて takeover 本体 (paseo run 起動 /
  // set-executor 記録) だけを実プロセスで確認する。
  await Deno.writeTextFile(
    `${stateDir}/tasks/${taskId}.md`,
    "---\nid: smoke-136\n---\n\nsmoke test task body\n",
  );
  const nowIso = new Date().toISOString();
  const state = {
    tracker: "gh",
    source: "",
    updated_at: nowIso,
    queue: [{
      id: taskId,
      title: "smoke test",
      progress: "running",
      run: {
        kind: "initial",
        gate: "full",
        phase: "research",
        attempts: 0,
        executor: null,
        executor_last_event_at: null,
        takeover_at: null,
        verifier: null,
        verifier_session: null,
      },
      blocked_reason: null,
      artifact: { state: "none" },
      worktree,
      base: "main",
      session: null,
    }],
    candidates: [],
    relisted: [],
    promoted: [],
    completed: [],
    withdrawn_branches: [],
    history: [],
    history_archived: 0,
    schema_version: 2,
  };
  await Deno.writeTextFile(`${stateDir}/state.json`, JSON.stringify(state));

  let agentId: string | null = null;
  let workspaceId: string | null = null;
  try {
    const args = [
      new URL("./pipeline-driver.ts", import.meta.url).pathname,
      "--state-dir",
      stateDir,
      "--session",
      "e2e-smoke-session",
      "--impl-provider",
      provider,
      "--paseo-new-workspace",
      "local",
    ];
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const stdoutText = new TextDecoder().decode(stdout);
    assert(
      code === 0,
      `pipeline-driver.ts exited ${code}: ${
        new TextDecoder().decode(stderr)
      } / ${stdoutText}`,
    );
    const cycleResult = JSON.parse(stdoutText.trim().split("\n").pop()!);
    assertEquals(cycleResult.outcome, "launched");
    agentId = cycleResult.detail.agentId as string;
    workspaceId = (cycleResult.detail.workspaceId as string | null) ?? null;
    assert(typeof agentId === "string" && agentId.length > 0);

    // 実際に Paseo エージェントが起動され、指定した --cwd で走っていることを確認する
    // (agent-scoped 実行環境でも --paseo-new-workspace local が --cwd を確実に効かせる)。
    const inspectCmd = new Deno.Command("paseo", {
      args: ["inspect", agentId, "--json"],
      stdout: "piped",
      stderr: "piped",
    });
    const inspectResult = await inspectCmd.output();
    assert(
      inspectResult.code === 0,
      "paseo inspect が起動したエージェントを見つけられるべき",
    );
    const inspected = JSON.parse(
      new TextDecoder().decode(inspectResult.stdout),
    );
    assertEquals(inspected.Cwd, scratch);

    // run.executor が state.json に記録されたことを確認する。
    const written = JSON.parse(
      await Deno.readTextFile(`${stateDir}/state.json`),
    );
    const item = written.queue.find((i: { id: string }) => i.id === taskId);
    assertEquals(item.run.executor, agentId);
  } finally {
    if (agentId) {
      try {
        await new Deno.Command("paseo", { args: ["stop", agentId, "--json"] })
          .output();
      } catch {
        // 停止できなくても後続の archive に任せる。
      }
      try {
        await new Deno.Command("paseo", {
          args: ["archive", agentId, "--force", "--json"],
        })
          .output();
      } catch {
        // 片付けられなければ手動確認に委ねる (agentId をログに残す)。
        console.error(
          `e2e smoke: could not archive agent ${agentId}, please clean up manually`,
        );
      }
    }
    if (workspaceId) {
      try {
        await new Deno.Command("paseo", {
          args: ["workspace", "archive", workspaceId, "--json"],
        }).output();
      } catch {
        console.error(
          `e2e smoke: could not archive workspace ${workspaceId}, please clean up manually`,
        );
      }
    }
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// L: --observe --loop の SIGINT による安全な終了 (常時登録)
//
// `--observe` は `state.ts` のサブプロセス呼び出ししかしない (paseo 不要) ため、
// 既存 E2E 節 (実 paseo エージェントを起動する) と異なり TASK_PIPELINE_E2E のゲートは
// 付けない — Deno とこのリポジトリ自身の CLI だけで完結する。
// ---------------------------------------------------------------------------

Deno.test("main --observe --loop: SIGINT を送ると進行中のサイクル完了後に正常終了する (受け入れ条件5 統合)", async () => {
  const scratch = await Deno.makeTempDir({
    prefix: "pipeline-driver-sigint-",
  });
  const stateDir = `${scratch}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const state = {
    tracker: "gh",
    source: "",
    updated_at: new Date().toISOString(),
    queue: [],
    candidates: [],
    relisted: [],
    promoted: [],
    completed: [],
    withdrawn_branches: [],
    history: [],
    history_archived: 0,
    schema_version: 2,
  };
  await Deno.writeTextFile(`${stateDir}/state.json`, JSON.stringify(state));
  try {
    const args = [
      new URL("./pipeline-driver.ts", import.meta.url).pathname,
      "--state-dir",
      stateDir,
      "--session",
      "sigint-smoke-session",
      "--observe",
      "true",
      "--loop",
      "true",
      "--interval-sec",
      "5",
    ];
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();

    // 最初のサイクルが完走するまで待つ (--loop はサイクルが完走するたびに1行 console.log
    // する設計 — main() のストリーミング出力仕様どおり)。
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("最初のサイクル完了前に stdout が閉じた");
      buffered += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();

    child.kill("SIGINT");

    // 実プロセスの終了をハングせずに待つためのタイムアウト・ガードであり、
    // sleepAbortable 自体の時間制御はテストしていない (それは受け入れ条件5 単体b が
    // フェイク不要な形で検証済み)。実プロセス境界を跨ぐ以上フェイクタイマーは効かない
    // ので、実時間のタイムアウトを使う (上記ルールの「実タイマー挙動をテストする
    // 統合テスト」の例外に該当)。
    const { promise: timeoutPromise, reject: rejectTimeout } = Promise
      .withResolvers<never>();
    const timer = setTimeout(
      () =>
        rejectTimeout(
          new Error("SIGINT 後 3 秒以内にプロセスが終了しなかった"),
        ),
      3000,
    );
    try {
      const status = await Promise.race([child.status, timeoutPromise]);
      assertEquals(status.success, true);
      assertEquals(status.code, 0);
    } finally {
      clearTimeout(timer);
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

Deno.test("main --loop without --observe: SIGINT で進行中のサイクル完了後に正常終了する", async () => {
  const scratch = await Deno.makeTempDir({
    prefix: "pipeline-driver-dispatch-sigint-",
  });
  const stateDir = `${scratch}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.writeTextFile(
    `${stateDir}/state.json`,
    JSON.stringify({
      tracker: "gh",
      source: "",
      updated_at: new Date().toISOString(),
      queue: [],
      candidates: [],
      relisted: [],
      promoted: [],
      completed: [],
      withdrawn_branches: [],
      history: [],
      history_archived: 0,
      schema_version: 2,
    }),
  );
  try {
    const args = [
      new URL("./pipeline-driver.ts", import.meta.url).pathname,
      "--state-dir",
      stateDir,
      "--session",
      "dispatch-sigint-session",
      "--loop",
      "true",
      "--interval-sec",
      "5",
    ];
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("最初のサイクル完了前に stdout が閉じた");
      buffered += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    child.kill("SIGINT");

    const { promise: timeoutPromise, reject: rejectTimeout } = Promise
      .withResolvers<never>();
    const timer = setTimeout(
      () => rejectTimeout(new Error("SIGINT 後3秒以内に終了しなかった")),
      3000,
    );
    try {
      const status = await Promise.race([child.status, timeoutPromise]);
      assertEquals(status.success, true);
      assertEquals(status.code, 0);
    } finally {
      clearTimeout(timer);
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

if (TASK_PIPELINE_E2E) {
  const availability = await detectPaseoAvailability();
  if (availability.available) {
    Deno.test(E2E_TEST_NAME, () => runE2eSmokeTest(availability.provider!));
  } else {
    console.warn(
      `e2e smoke test not registered (TASK_PIPELINE_E2E=1 だが利用不可): ${availability.reason}`,
    );
  }
}
