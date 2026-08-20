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
  deriveTaskClass,
  type DriverContext,
  extractAgentId,
  extractOwnedWorkspaceId,
  findActiveDuplicates,
  isExecutorFresh,
  main,
  matchesProtocolLine,
  normalizeMessageLines,
  parentDir,
  parsePaseoLs,
  providerModeOf,
  resolveProviderModel,
  runCycle,
  splitProviderModel,
} from "./pipeline-driver.ts";
import type { TakeoverOperation } from "./pipeline-dispatch.ts";

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

Deno.test("buildPaseoRunArgs: newWorkspace が指定されたときだけ --new-workspace を付ける", () => {
  const withNewWorkspace = buildPaseoRunArgs({
    id: "gh-1",
    worktree: "/scratch",
    provider: "omp",
    model: null,
    mode: "full",
    prompt: "go",
    newWorkspace: "local",
  });
  assertEquals(
    withNewWorkspace[withNewWorkspace.indexOf("--new-workspace") + 1],
    "local",
  );
  const withoutNewWorkspace = buildPaseoRunArgs({
    id: "gh-1",
    worktree: "/scratch",
    provider: "omp",
    model: null,
    mode: "full",
    prompt: "go",
  });
  assert(!withoutNewWorkspace.includes("--new-workspace"));
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
    ) => CommandResult,
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
// `--paseo-new-workspace local` を明示しているのは、このテストの実行環境自体が
// Paseo エージェントの中 (agent-scoped) であることがあり、その場合 `--new-workspace`
// を指定しない `--cwd` は caller の workspace を継承してしまい `--cwd` の値が無視される
// ことを実機で確認したため (Cwd の検証ができなくなる)。pipeline-driver.ts の既定
// (`paseoNewWorkspace` 省略) はそのまま — 本来の経路 (top-level セッションからの
// `--cwd` は毎回 owned workspace を自動生成する。agent-launch.md「所有 workspace の
// 記録と安全な後始末」) を変えない。`--paseo-new-workspace` はこのテストが実行環境の
// 制約を吸収するためだけに使う。
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
const PASEO_AVAILABILITY: PaseoAvailability = TASK_PIPELINE_E2E
  ? await detectPaseoAvailability()
  : { available: false, provider: null, reason: "TASK_PIPELINE_E2E is not 1" };

Deno.test({
  name:
    "e2e/smoke: 実 paseo で takeover サイクルを1回実行し、実エージェント起動・Cwd・run.executor 記録を確認する",
  ignore: !PASEO_AVAILABILITY.available,
  fn: async () => {
    const provider = PASEO_AVAILABILITY.provider!;
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
  },
});
