// task-pipeline/scripts/shell-check.test.ts
//
// shell-check.ts を **サブプロセスとして起動して** 検査する (state.test.ts と同じ流儀)。
// 接頭辞は T-SC-。チェックの実行は実バイナリ (`true` / `false` / `sleep` / 存在しないコマンド)
// で通すので、outcome の 4 値すべてが実際の spawn を経て観測される。
//
// 実行: deno task test
//   単体: deno test --allow-read --allow-write --allow-env --allow-run \
//           task-pipeline/scripts/shell-check.test.ts

const SCRIPT_URL = new URL("./shell-check.ts", import.meta.url);

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

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly json: Record<string, unknown>;
}

async function runCli(args: readonly string[]): Promise<RunResult> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      SCRIPT_URL.pathname,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  const out = decoder.decode(stdout).trim();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(out) as Record<string, unknown>;
  } catch {
    throw new Error(
      `stdout が JSON ではない: ${out}\nstderr: ${decoder.decode(stderr)}`,
    );
  }
  return { code, stdout: out, json };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} が exit ${code}: ${
        new TextDecoder().decode(
          stderr,
        )
      }`,
    );
  }
}

type Rec = Record<string, unknown>;

const ID = "gh-1";

function runNode(over: Rec = {}): Rec {
  return {
    kind: "initial",
    gate: "light",
    phase: "implement",
    attempts: 0,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    verifier: null,
    verifier_session: null,
    ...over,
  };
}

function stateOf(item: Rec): string {
  return JSON.stringify({
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: "2026-08-07T00:00:00Z",
    stalled: null,
    stalled_since: null,
    schema_version: 2,
    queue: [item],
    completed: [],
    candidates: [],
    relisted: [],
    promoted: [],
    withdrawn_branches: [],
    history: [],
  });
}

const MANIFEST_OK = JSON.stringify({
  version: 1,
  scope: { allow: ["docs/**"] },
  checks: [{ name: "ok", command: "true" }],
});

interface Fixture {
  readonly stateDir: string;
  readonly worktree: string;
  readonly verdictPath: string;
  readonly verdictsDir: string;
}

interface FixtureOpts {
  readonly manifest?: string | null;
  readonly taskFrontmatter?: string;
  readonly run?: Rec;
  readonly progress?: string;
  readonly worktreeRecorded?: boolean;
  readonly baseRecorded?: boolean;
}

/**
 * state dir と、base ブランチにマニフェストをコミットした実 git リポジトリ (worktree 役) を
 * 用意する。base は `main` 固定。
 */
async function withFixture(
  opts: FixtureOpts,
  body: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "shell-check-test-" });
  try {
    const stateDir = `${root}/.task-pipeline`;
    const worktree = `${root}/repo`;
    await Deno.mkdir(`${stateDir}/tasks`, { recursive: true });
    await Deno.mkdir(`${stateDir}/runs/${ID}/verdicts`, { recursive: true });
    await Deno.mkdir(`${worktree}/docs`, { recursive: true });

    await git(worktree, ["init", "-q", "-b", "main"]);
    await git(worktree, ["config", "user.email", "t@example.com"]);
    await git(worktree, ["config", "user.name", "t"]);
    const manifest = opts.manifest === undefined ? MANIFEST_OK : opts.manifest;
    if (manifest !== null) {
      await Deno.writeTextFile(
        `${worktree}/TASK_PIPELINE_CHECKS.json`,
        manifest,
      );
    }
    await Deno.writeTextFile(`${worktree}/docs/seed.md`, "seed\n");
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["commit", "-q", "-m", "seed"]);
    // 実運用の worktree は必ず自分のブランチに居る (`playbooks/worktree.md`)。base (`main`) を
    // 置いたまま分岐しておかないと、merge-base が自分の新しいコミットになって
    // 「コミット済みの変更が差分に出ない」という実運用に無い状態を測ってしまう。
    await git(worktree, ["checkout", "-q", "-b", `task-pipeline/${ID}`]);

    await Deno.writeTextFile(
      `${stateDir}/tasks/${ID}.md`,
      `---\nid: ${ID}\n${opts.taskFrontmatter ?? "gate: light"}\n---\n本文\n`,
    );
    await Deno.writeTextFile(
      `${stateDir}/state.json`,
      stateOf({
        id: ID,
        title: "タイトル",
        progress: opts.progress ?? "running",
        run: opts.progress !== undefined && opts.progress !== "running"
          ? null
          : runNode(opts.run ?? {}),
        blocked_reason: null,
        artifact: { state: "none" },
        worktree: opts.worktreeRecorded === false ? null : worktree,
        base: opts.baseRecorded === false ? null : "main",
        session: null,
      }),
    );

    await body({
      stateDir,
      worktree,
      verdictsDir: `${stateDir}/runs/${ID}/verdicts`,
      verdictPath: `${stateDir}/runs/${ID}/verdicts/implement-0.json`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function cliArgs(fx: Fixture, over: readonly string[] = []): string[] {
  return [
    "--state-dir",
    fx.stateDir,
    "--id",
    ID,
    "--verdict-path",
    fx.verdictPath,
    ...over,
  ];
}

async function readVerdict(path: string): Promise<Rec> {
  return JSON.parse(await Deno.readTextFile(path)) as Rec;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * マニフェストは **base (`main`) にコミットする** — シェル判定が読むのは base スナップショット
 * だけなので、作業ブランチに積んでも実行されるチェックは変わらない。
 */
async function writeManifest(
  fx: Fixture,
  manifest: unknown,
): Promise<void> {
  await git(fx.worktree, ["checkout", "-q", "main"]);
  await Deno.writeTextFile(
    `${fx.worktree}/TASK_PIPELINE_CHECKS.json`,
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  await git(fx.worktree, ["add", "-A"]);
  await git(fx.worktree, ["commit", "-q", "-m", "manifest"]);
  await git(fx.worktree, ["checkout", "-q", `task-pipeline/${ID}`]);
}

Deno.test("T-SC-pass-1: 全チェック exit 0・違反なしで PASS を書く", async () => {
  await withFixture({}, async (fx) => {
    const result = await runCli(cliArgs(fx));
    assertEquals(result.code, 0, result.stdout);
    assertEquals(result.json["route"], "shell");
    assertEquals(result.json["audit_mode"], "shell");
    assertEquals(result.json["verdict"], "PASS");
    assertEquals(result.json["verdict_path"], fx.verdictPath);

    const verdict = await readVerdict(fx.verdictPath);
    assertEquals(verdict["phase"], "implement");
    assertEquals(verdict["verdict"], "PASS");
    assertEquals(verdict["required_fixes"], []);
    const audit = verdict["audit"] as Rec;
    assertEquals(audit["mode"], "shell");
    assertEquals(
      (audit["manifest"] as Rec)["ref"],
      "main:TASK_PIPELINE_CHECKS.json",
    );
    const checks = audit["checks"] as Rec[];
    assertEquals(checks.length, 1);
    assertEquals(checks[0]["command"], "true");
    assertEquals(checks[0]["exit_code"], 0);
    assert(typeof checks[0]["duration_ms"] === "number", "duration_ms が無い");
    const log = String(checks[0]["log"]);
    assert(await exists(log), `ログが無い: ${log}`);
    assert(
      (await Deno.readTextFile(log)).includes("--- exit 0 ---"),
      "ログに終了コードが無い",
    );
  });
});

Deno.test("T-SC-fail-1: 非ゼロ終了で FAIL・required_fixes に出力が入る", async () => {
  await withFixture({}, async (fx) => {
    await writeManifest(fx, {
      version: 1,
      scope: { allow: ["docs/**", "TASK_PIPELINE_CHECKS.json"] },
      checks: [{
        name: "boom",
        command: "sh",
        args: ["-c", "echo out; echo err >&2; exit 7"],
      }],
    });
    const result = await runCli(cliArgs(fx));
    assertEquals(result.code, 0, result.stdout);
    assertEquals(result.json["verdict"], "FAIL");

    const verdict = await readVerdict(fx.verdictPath);
    const fixes = (verdict["required_fixes"] as string[]).join("\n");
    assert(fixes.includes("exit 7"), fixes);
    assert(fixes.includes("out"), fixes);
    const checks = (verdict["audit"] as Rec)["checks"] as Rec[];
    assertEquals(checks[0]["exit_code"], 7);
    assertEquals(checks[0]["outcome"], "failed");
  });
});

Deno.test("T-SC-fail-2: タイムアウトは FAIL (成功側に数えない)", async () => {
  await withFixture({}, async (fx) => {
    await writeManifest(fx, {
      version: 1,
      scope: { allow: ["docs/**", "TASK_PIPELINE_CHECKS.json"] },
      checks: [{
        name: "slow",
        command: "sleep",
        args: ["30"],
        timeout_sec: 1,
      }],
    });
    const result = await runCli(cliArgs(fx));
    assertEquals(result.json["verdict"], "FAIL");
    const checks =
      ((await readVerdict(fx.verdictPath))["audit"] as Rec)["checks"] as Rec[];
    assertEquals(checks[0]["outcome"], "timeout");
  });
});

Deno.test("T-SC-unavailable-1: spawn 失敗は UNAVAILABLE (PASS/FAIL にしない)", async () => {
  await withFixture({}, async (fx) => {
    await writeManifest(fx, {
      version: 1,
      scope: { allow: ["docs/**", "TASK_PIPELINE_CHECKS.json"] },
      checks: [{ name: "ghost", command: "definitely-not-a-real-binary-xyz" }],
    });
    const result = await runCli(cliArgs(fx));
    assertEquals(result.code, 0, result.stdout);
    assertEquals(result.json["verdict"], "UNAVAILABLE");
    const verdict = await readVerdict(fx.verdictPath);
    assertEquals(verdict["required_fixes"], []);
    const checks = (verdict["audit"] as Rec)["checks"] as Rec[];
    assertEquals(checks[0]["outcome"], "spawn-failed");
  });
});

Deno.test("T-SC-unavailable-2: git が非ゼロで落ちたら UNAVAILABLE (判定ファイルは残す)", async () => {
  await withFixture({}, async (fx) => {
    assertEquals(
      (await runCli(cliArgs(fx))).json["verdict"],
      "PASS",
      "前提: 通常は PASS",
    );

    // base を HEAD と共通祖先を持たない履歴にすると merge-base が非ゼロで落ちる
    // (マニフェストの読み出しは成功するので、シェル経路に入った後の故障になる)。
    await git(fx.worktree, ["checkout", "-q", "--orphan", "detached-base"]);
    await git(fx.worktree, ["add", "-A"]);
    await git(fx.worktree, ["commit", "-q", "-m", "orphan base"]);
    await git(fx.worktree, ["branch", "-q", "-f", "main", "detached-base"]);
    await git(fx.worktree, ["checkout", "-q", `task-pipeline/${ID}`]);

    const broken = await runCli(cliArgs(fx));
    assertEquals(broken.json["verdict"], "UNAVAILABLE", broken.stdout);
    const verdict = await readVerdict(fx.verdictPath);
    assertEquals(verdict["required_fixes"], []);
    assert(
      (verdict["reasons"] as string[]).some((r) => r.includes("merge-base")),
      JSON.stringify(verdict["reasons"]),
    );
  });
});

Deno.test("T-SC-unavailable-3: git 自体を起動できないときも UNAVAILABLE (昇格で吸収しない)", async () => {
  await withFixture({}, async (fx) => {
    const result = await runCli(
      cliArgs(fx, ["--git-bin", "definitely-not-a-real-git-xyz"]),
    );
    assertEquals(result.code, 0, result.stdout);
    assertEquals(result.json["route"], "shell", result.stdout);
    assertEquals(result.json["verdict"], "UNAVAILABLE", result.stdout);
    const verdict = await readVerdict(fx.verdictPath);
    assert(
      (verdict["reasons"] as string[]).some((r) =>
        r.includes("を起動できなかった")
      ),
      JSON.stringify(verdict["reasons"]),
    );
  });
});

Deno.test("T-SC-scope-1: 許可外の untracked ファイルで FAIL", async () => {
  await withFixture({}, async (fx) => {
    await Deno.writeTextFile(`${fx.worktree}/rogue.ts`, "x\n");
    const result = await runCli(cliArgs(fx));
    assertEquals(result.json["verdict"], "FAIL");
    assertEquals(result.json["violations"], 1);
    const verdict = await readVerdict(fx.verdictPath);
    assertEquals(
      ((verdict["audit"] as Rec)["scope"] as Rec)["violations"],
      ["rogue.ts"],
    );
  });
});

Deno.test("T-SC-scope-2: 許可外のコミット済み変更で FAIL (作業ツリー差分だけを見ない)", async () => {
  await withFixture({}, async (fx) => {
    await Deno.writeTextFile(`${fx.worktree}/rogue.ts`, "x\n");
    await git(fx.worktree, ["add", "-A"]);
    await git(fx.worktree, ["commit", "-q", "-m", "rogue"]);
    const result = await runCli(cliArgs(fx));
    assertEquals(result.json["verdict"], "FAIL", result.stdout);
    const scope =
      ((await readVerdict(fx.verdictPath))["audit"] as Rec)["scope"] as Rec;
    assertEquals(scope["violations"], ["rogue.ts"]);
  });
});

Deno.test("T-SC-scope-3: 許可内の変更は PASS", async () => {
  await withFixture({}, async (fx) => {
    await Deno.writeTextFile(`${fx.worktree}/docs/new.md`, "x\n");
    const result = await runCli(cliArgs(fx));
    assertEquals(result.json["verdict"], "PASS", result.stdout);
  });
});

Deno.test("T-SC-scope-4: タスク宣言の scope は許可範囲を狭める", async () => {
  await withFixture({
    taskFrontmatter: "gate: light\nscope: docs/keep/**",
  }, async (fx) => {
    await Deno.mkdir(`${fx.worktree}/docs/keep`, { recursive: true });
    await Deno.writeTextFile(`${fx.worktree}/docs/keep/a.md`, "x\n");
    await Deno.writeTextFile(`${fx.worktree}/docs/other.md`, "x\n");
    const result = await runCli(cliArgs(fx));
    assertEquals(result.json["verdict"], "FAIL", result.stdout);
    const scope =
      ((await readVerdict(fx.verdictPath))["audit"] as Rec)["scope"] as Rec;
    assertEquals(scope["violations"], ["docs/other.md"]);
  });
});

const ESCALATIONS: ReadonlyArray<readonly [string, FixtureOpts, string]> = [
  [
    "phase が research+plan (散文フェーズ)",
    { run: { phase: "research+plan" } },
    "single",
  ],
  ["phase が report", { run: { phase: "report" } }, "single"],
  [
    "class が standard (宣言なし)",
    { taskFrontmatter: "title: x" },
    "single",
  ],
  [
    "class が high (床が dual)",
    { taskFrontmatter: "gate: light\nrisk: high" },
    "dual",
  ],
  [
    "audit_mode: dual の宣言",
    { taskFrontmatter: "gate: light\naudit_mode: dual" },
    "dual",
  ],
  ["worktree が未記録", { worktreeRecorded: false }, "single"],
  ["base が未記録", { baseRecorded: false }, "single"],
  ["base にマニフェストが無い", { manifest: null }, "single"],
  ["マニフェストが壊れている", { manifest: "{" }, "single"],
  [
    "マニフェストの version が違う",
    {
      manifest: JSON.stringify({
        version: 2,
        scope: { allow: ["docs/**"] },
        checks: [{ name: "ok", command: "true" }],
      }),
    },
    "single",
  ],
];

for (const [label, opts, expectedMode] of ESCALATIONS) {
  Deno.test(`T-SC-llm: ${label} → route llm・判定ファイルを書かない`, async () => {
    await withFixture(opts, async (fx) => {
      const phase = String(opts.run?.["phase"] ?? "implement");
      const verdictPath = `${fx.verdictsDir}/${phase}-0.json`;
      const result = await runCli([
        "--state-dir",
        fx.stateDir,
        "--id",
        ID,
        "--verdict-path",
        verdictPath,
      ]);
      assertEquals(result.code, 0, result.stdout);
      assertEquals(result.json["route"], "llm", result.stdout);
      assertEquals(result.json["audit_mode"], expectedMode, result.stdout);
      assert(
        typeof result.json["reason"] === "string" &&
          result.json["reason"] !== "",
        `reason が空: ${result.stdout}`,
      );
      assert(
        !(await exists(verdictPath)),
        "route llm なのに判定ファイルを書いた",
      );
    });
  });
}

Deno.test("T-SC-trust-1: 作業ツリーのマニフェストではなく base のものを実行する", async () => {
  await withFixture({}, async (fx) => {
    // base (main) には exit 0 のチェックが載っている。作業ブランチ側に「必ず PASS する」
    // 別マニフェストを積んでも、base 側が読まれるので結果は変わらない。
    // 作業ブランチは fixture が既にチェックアウトしている。
    await Deno.writeTextFile(
      `${fx.worktree}/TASK_PIPELINE_CHECKS.json`,
      JSON.stringify({
        version: 1,
        scope: { allow: ["**"] },
        checks: [{ name: "hijack", command: "true" }],
      }),
    );
    await Deno.writeTextFile(`${fx.worktree}/rogue.ts`, "x\n");
    await git(fx.worktree, ["add", "-A"]);
    await git(fx.worktree, ["commit", "-q", "-m", "hijack"]);

    const result = await runCli(cliArgs(fx));
    const verdict = await readVerdict(fx.verdictPath);
    const audit = verdict["audit"] as Rec;
    const checks = audit["checks"] as Rec[];
    assertEquals(
      checks.map((c) => c["name"]),
      ["ok"],
      "base 側の checks でない",
    );
    assertEquals(result.json["verdict"], "FAIL", result.stdout);
    const violations = ((audit["scope"]) as Rec)["violations"] as string[];
    assert(
      violations.includes("rogue.ts") &&
        violations.includes("TASK_PIPELINE_CHECKS.json"),
      `base の allow が効いていない: ${JSON.stringify(violations)}`,
    );
  });
});

Deno.test("T-SC-usage-1: 未知のフラグは usage (10)", async () => {
  await withFixture({}, async (fx) => {
    const result = await runCli(cliArgs(fx, ["--bogus", "x"]));
    assertEquals(result.code, 10);
    assertEquals(result.json["error"], "usage");
  });
});

Deno.test("T-SC-usage-2: run dir 外の verdict path は usage で、そこへ書かない", async () => {
  await withFixture({}, async (fx) => {
    const outside = `${fx.stateDir}/outside.json`;
    const result = await runCli([
      "--state-dir",
      fx.stateDir,
      "--id",
      ID,
      "--verdict-path",
      outside,
    ]);
    assertEquals(result.code, 10, result.stdout);
    assertEquals(result.json["error"], "usage");
    assert(!(await exists(outside)), "run dir の外へ書いた");
  });
});

Deno.test("T-SC-usage-3: verdicts/ より深いパスは usage", async () => {
  await withFixture({}, async (fx) => {
    const deeper = `${fx.verdictsDir}/nested/implement-0.json`;
    const result = await runCli([
      "--state-dir",
      fx.stateDir,
      "--id",
      ID,
      "--verdict-path",
      deeper,
    ]);
    assertEquals(result.code, 10, result.stdout);
  });
});

Deno.test("T-SC-usage-4: 拡張子が .json でなければ usage", async () => {
  await withFixture({}, async (fx) => {
    const result = await runCli([
      "--state-dir",
      fx.stateDir,
      "--id",
      ID,
      "--verdict-path",
      `${fx.verdictsDir}/implement-0.txt`,
    ]);
    assertEquals(result.code, 10, result.stdout);
  });
});

Deno.test("T-SC-conflict-1: running でないタスクは conflict (15)", async () => {
  await withFixture({ progress: "queued" }, async (fx) => {
    const result = await runCli(cliArgs(fx));
    assertEquals(result.code, 15, result.stdout);
    assertEquals(result.json["error"], "conflict");
  });
});

Deno.test("T-SC-conflict-2: 検証ゲートを持たないフェーズは conflict (15)", async () => {
  await withFixture({ run: { phase: "finalize" } }, async (fx) => {
    const result = await runCli(cliArgs(fx));
    assertEquals(result.code, 15, result.stdout);
    assertEquals(result.json["error"], "conflict");
  });
});

Deno.test("T-SC-missing-1: queue に無い id は missing (13)", async () => {
  await withFixture({}, async (fx) => {
    const result = await runCli([
      "--state-dir",
      fx.stateDir,
      "--id",
      "gh-nope",
      "--verdict-path",
      `${fx.stateDir}/runs/gh-nope/verdicts/implement-0.json`,
    ]);
    assertEquals(result.code, 13, result.stdout);
    assertEquals(result.json["error"], "missing");
  });
});
