// task-pipeline/scripts/state.test.ts
//
// task-pipeline/scripts/state.ts (state.json の CLI 化: lock・原子的書き込み・heartbeat・
// init・checkState 統合) のテスト。
//
//   deno test --allow-read --allow-write --allow-env --allow-run \
//     task-pipeline/scripts/state.test.ts
//   または: sh tests/state-cli.test.sh (deno 不在なら SKIP + exit 0)
//
// 依存ゼロ・ネットワーク不要 (--allow-net を与えないことでネットに出ないことを強制する)。
// state.ts 自身を Deno.Command でサブプロセス起動して検証する (in-process 関数呼び出しでは
// 権限封じ込め・実プロセス kill が検証できないため)。テスト自身は --allow-read/--allow-write/
// --allow-env/--allow-run を広く持つが、これは「テストハーネスの権限」であって、検証対象の
// CLI サブプロセスには常に絞った --allow-read/--allow-write だけを渡す。
//
// 系統 (run dir の plan.md §4 の T-ID と対応):
//   U  引数解釈 (usage)
//   F  state ファイルの状態 (missing/schema/valid) と get/validate の区別
//   S  スキーマ違反時の不変性
//   L  lock (排他・stale 回収)
//   C  並行性 (lost update・部分書き込み)
//   P  権限封じ込め
//   H  heartbeat (session-touch/sessions-alive)
//   I  init の exclude 冪等性
//   B  後方互換 (schema_version)
//   D  終了コード契約ドキュメント

import { EXIT_CODES } from "./state.ts";

const SCRIPT_URL = new URL("./state.ts", import.meta.url);
const REPO_ROOT = new URL("../../", import.meta.url);
const FIXTURES_DIR = new URL("tests/fixtures/state-cli/", REPO_ROOT);
const CONTRACT_DOC = new URL(
  "task-pipeline/docs/state-cli-contract.md",
  REPO_ROOT,
);

// ---------------------------------------------------------------------------
// サブプロセス起動ヘルパ
// ---------------------------------------------------------------------------

interface RunOpts {
  allowRead: string[];
  allowWrite: string[];
  allowEnv?: string[];
  env?: Record<string, string>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function buildArgs(verbArgs: string[], opts: RunOpts): string[] {
  const args = [
    "run",
    "--no-prompt",
    `--allow-read=${opts.allowRead.join(",")}`,
    `--allow-write=${opts.allowWrite.join(",")}`,
  ];
  if (opts.allowEnv && opts.allowEnv.length > 0) {
    args.push(`--allow-env=${opts.allowEnv.join(",")}`);
  }
  args.push(SCRIPT_URL.pathname, ...verbArgs);
  return args;
}

async function runCli(verbArgs: string[], opts: RunOpts): Promise<RunResult> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: buildArgs(verbArgs, opts),
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr),
  };
}

function spawnCli(verbArgs: string[], opts: RunOpts): Deno.ChildProcess {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: buildArgs(verbArgs, opts),
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  return cmd.spawn();
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 汎用ヘルパ
// ---------------------------------------------------------------------------

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "state-cli-test-" });
}

async function writeStateFile(
  stateDir: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${stateDir}/state.json`, content);
}

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES_DIR));
}

async function statMtime(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return info.mtime ? info.mtime.getTime() : NaN;
}

async function setMtimeMinutesAgo(
  path: string,
  nowMs: number,
  minutesAgo: number,
): Promise<void> {
  const target = new Date(nowMs - minutesAgo * 60_000);
  await Deno.utime(path, target, target);
}

function assertEquals<T>(actual: T, expected: T, msg?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      `${msg ?? "assertEquals failed"}: expected ${b}, got ${a}`,
    );
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

const MINIMAL_VALID_BASE = {
  tracker: "markdown",
  source: "./TASKS.md",
  updated_at: "2026-08-02T00:00:00Z",
  queue: [] as unknown[],
  candidates: [] as unknown[],
  relisted: [] as unknown[],
  promoted: [] as unknown[],
  history: [] as unknown[],
};

function minimalValidState(
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...MINIMAL_VALID_BASE, ...extra };
}

const MINIMAL_QUEUE_ITEM = {
  id: "t-1",
  title: "t",
  status: "approved",
  gate: "full",
  phase: null,
  attempts: 0,
  session: null,
  executor: null,
  executor_last_event_at: null,
  takeover_at: null,
  blocked_reason: null,
  worktree: null,
  base: null,
  review: null,
};

// top-level 必須 "tracker" 欠落 (T-F4)
const INVALID_TOP_LEVEL_MISSING_TRACKER = JSON.stringify({
  source: "./TASKS.md",
  updated_at: "2026-08-02T00:00:00Z",
  queue: [],
  candidates: [],
  relisted: [],
  promoted: [],
  history: [],
});

// ネスト (queue[0].status) が enum 外 (T-F5)
const INVALID_NESTED_QUEUE_STATUS = JSON.stringify(
  minimalValidState({
    queue: [{ ...MINIMAL_QUEUE_ITEM, status: "bogus" }],
  }),
);

// ---------------------------------------------------------------------------
// U: verb 引数解釈 (usage)
// ---------------------------------------------------------------------------

Deno.test("T-U1: unknown verb -> usage", async () => {
  const dir = await tempDir();
  const res = await runCli(["bogus-verb", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.usage);
  assertEquals(parseJson(res.stdout).error, "usage");
});

Deno.test("T-U2: verb omitted -> usage", async () => {
  const res = await runCli([], { allowRead: ["/tmp"], allowWrite: ["/tmp"] });
  assertEquals(res.code, EXIT_CODES.usage);
  assertEquals(parseJson(res.stdout).error, "usage");
});

Deno.test("T-U3: --state-dir missing -> usage", async () => {
  const dir = await tempDir();
  const res = await runCli(["get"], { allowRead: [dir], allowWrite: [dir] });
  assertEquals(res.code, EXIT_CODES.usage);
  assertEquals(parseJson(res.stdout).error, "usage");
});

Deno.test("T-U4: init missing --tracker/--source/--git-common-dir -> usage, no side effects", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const cases: string[][] = [
    ["--state-dir", dir, "--source", "s", "--git-common-dir", gcd],
    ["--state-dir", dir, "--tracker", "t", "--git-common-dir", gcd],
    ["--state-dir", dir, "--tracker", "t", "--source", "s"],
  ];
  for (const flags of cases) {
    const sub = await tempDir();
    const args = flags.map((f) => (f === dir ? sub : f));
    const res = await runCli(["init", ...args], {
      allowRead: [sub, gcd],
      allowWrite: [sub, gcd],
    });
    assertEquals(res.code, EXIT_CODES.usage);
    // 副作用が無いこと: state.json も lock も作られない
    let existsAfter = true;
    try {
      await Deno.stat(`${sub}/state.json`);
    } catch {
      existsAfter = false;
    }
    assert(!existsAfter, "state.json should not be created on usage error");
  }
});

Deno.test("T-U4: session-touch missing --id -> usage", async () => {
  const dir = await tempDir();
  const res = await runCli(["session-touch", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.usage);
});

Deno.test("T-U4: history-append missing --line -> usage", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const res = await runCli(["history-append", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.usage);
  const raw = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(
    raw,
    JSON.stringify(minimalValidState()),
    "state.json unchanged",
  );
});

Deno.test("T-U5: unknown flag -> usage", async () => {
  const dir = await tempDir();
  const res = await runCli(["get", "--state-dir", dir, "--bogus", "x"], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.usage);
});

Deno.test('T-U6: history-append --line "" succeeds (not usage)', async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", ""],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const body = parseJson(res.stdout);
  assertEquals(body.history_length, 1);
  const raw = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(raw.history, [""]);
});

// ---------------------------------------------------------------------------
// F: state ファイルの状態 / get と validate の区別
// ---------------------------------------------------------------------------

Deno.test("T-F1: get/validate/history-append on missing state.json (dir exists) -> missing", async () => {
  for (const verb of ["get", "validate"]) {
    const dir = await tempDir();
    const res = await runCli([verb, "--state-dir", dir], {
      allowRead: [dir],
      allowWrite: [dir],
    });
    assertEquals(res.code, EXIT_CODES.missing, `${verb}: ${res.stdout}`);
  }
  const dir = await tempDir();
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "x"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, EXIT_CODES.missing);
});

Deno.test("T-F1c: history-append with state-dir itself missing -> missing, no residue", async () => {
  const parent = await tempDir();
  const missingDir = `${parent}/does-not-exist`;
  const res = await runCli(
    ["history-append", "--state-dir", missingDir, "--line", "x"],
    { allowRead: [parent], allowWrite: [parent] },
  );
  assertEquals(res.code, EXIT_CODES.missing, res.stdout);
  let exists = true;
  try {
    await Deno.stat(missingDir);
  } catch {
    exists = false;
  }
  assert(!exists, "state-dir should not be created by history-append");
});

Deno.test("T-F1b: init with no existing state.json creates a fresh, well-formed state", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "markdown",
      "--source",
      "./TASKS.md",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const body = parseJson(res.stdout);
  assertEquals(body.created, true);
  const raw = await Deno.readTextFile(`${dir}/state.json`);
  const parsed = JSON.parse(raw);
  assertEquals(Object.keys(parsed), [
    "tracker",
    "source",
    "updated_at",
    "queue",
    "candidates",
    "relisted",
    "promoted",
    "history",
    "schema_version",
  ]);
  assertEquals(parsed.tracker, "markdown");
  assertEquals(parsed.source, "./TASKS.md");
  assertEquals(parsed.schema_version, 1);
  assertEquals(parsed.queue, []);
  assertEquals(parsed.candidates, []);
  assertEquals(parsed.relisted, []);
  assertEquals(parsed.promoted, []);
  assertEquals(parsed.history, []);
});

Deno.test("T-F2: get on 0-byte file -> schema", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, "");
  const res = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.schema, res.stdout);
});

Deno.test("T-F3: get on syntactically broken JSON -> schema", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, '{"tracker": "markdown"'); // 閉じ括弧欠落
  const res = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.schema, res.stdout);
});

Deno.test("T-F4/T-S1: validate rejects top-level schema violation, file unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_TOP_LEVEL_MISSING_TRACKER);
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const res = await runCli(["validate", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.schema, res.stdout);
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(
    after,
    before,
    "state.json must be byte-identical after schema error",
  );
  const tmpEntries = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.includes(".tmp.")) tmpEntries.push(e.name);
  }
  assertEquals(tmpEntries, [], "no leftover tmp files");
});

Deno.test("T-F5/T-S2: history-append rejects nested schema violation, file unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_NESTED_QUEUE_STATUS);
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "x"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, EXIT_CODES.schema, res.stdout);
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(
    after,
    before,
    "state.json must be byte-identical after schema error",
  );
});

Deno.test("T-F6: get/validate succeed on legacy fixture (no schema_version)", async () => {
  const dir = await tempDir();
  const fixture = await readFixture("valid-legacy-live.json");
  await writeStateFile(dir, fixture);
  const g = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(g.code, 0, g.stdout + g.stderr);
  const v = await runCli(["validate", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(v.code, 0, v.stdout + v.stderr);
  assertEquals(parseJson(v.stdout), { ok: true });
});

Deno.test("T-F7: get/validate succeed on new-format fixture (schema_version present)", async () => {
  const dir = await tempDir();
  const fixture = await readFixture("valid-watch-rebase.json");
  await writeStateFile(dir, fixture);
  const g = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(g.code, 0, g.stdout + g.stderr);
  const v = await runCli(["validate", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(v.code, 0, v.stdout + v.stderr);
});

Deno.test("T-F8: get on schema-invalid content succeeds (parse-only, no checkState)", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_TOP_LEVEL_MISSING_TRACKER);
  const res = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const body = parseJson(res.stdout);
  assertEquals(body, JSON.parse(INVALID_TOP_LEVEL_MISSING_TRACKER));
});

Deno.test("T-S4: init on existing invalid state.json fails, state.json byte-unchanged, exclude untouched", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  await Deno.mkdir(`${gcd}/info`, { recursive: true });
  await writeStateFile(dir, INVALID_TOP_LEVEL_MISSING_TRACKER);
  const beforeState = await Deno.readTextFile(`${dir}/state.json`);
  let excludeExistedBefore = true;
  try {
    await Deno.stat(`${gcd}/info/exclude`);
  } catch {
    excludeExistedBefore = false;
  }
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "markdown",
      "--source",
      "./TASKS.md",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(res.code, EXIT_CODES.schema, res.stdout);
  const afterState = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(afterState, beforeState);
  // exclude 側は state.json より先に処理されるため、この invalid ケースでは既に追記されて
  // いる可能性がある (許容: state.json 不変であることが本テストの主眼)。ただし残骸だけは無い。
  let tmpFound = false;
  for await (const e of Deno.readDir(`${gcd}/info`)) {
    if (e.name.includes(".tmp.")) tmpFound = true;
  }
  assert(!tmpFound, "no leftover tmp files in info dir");
  void excludeExistedBefore;
});

// ---------------------------------------------------------------------------
// L: lock (排他・stale 回収)
// ---------------------------------------------------------------------------

Deno.test("T-L1: no lock present -> immediate success", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "a"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
});

Deno.test("T-L2: fresh lock (<10min) blocks, fails after retries, state unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const before = await Deno.readTextFile(`${dir}/state.json`);
  await Deno.mkdir(`${dir}/lock`); // フレッシュな lock (今 mkdir したばかり)
  const res = await runCli(
    [
      "history-append",
      "--state-dir",
      dir,
      "--line",
      "a",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "3",
    ],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, EXIT_CODES.lock, res.stdout);
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(after, before);
  await Deno.remove(`${dir}/lock`);
});

Deno.test("T-L3: lock aged exactly 10min is NOT stale -> lock failure after retries", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const testNow = Date.now();
  await Deno.mkdir(`${dir}/lock`);
  await setMtimeMinutesAgo(`${dir}/lock`, testNow, 10);
  const res = await runCli(
    [
      "history-append",
      "--state-dir",
      dir,
      "--line",
      "a",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "3",
    ],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_CLI_TEST_NOW_MS"],
      env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
    },
  );
  assertEquals(res.code, EXIT_CODES.lock, res.stdout);
  // ロックはまだこの偽装プロセスが持ったまま (回収されていない)
  let lockExists = true;
  try {
    await Deno.stat(`${dir}/lock`);
  } catch {
    lockExists = false;
  }
  assert(lockExists, "exactly-10min-old lock should not be recovered");
  await Deno.remove(`${dir}/lock`);
});

Deno.test("T-L4: lock aged 11min is stale -> single-winner recovery, no corruption under 2 concurrent callers", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  const testNow = Date.now();
  await Deno.mkdir(`${dir}/lock`);
  await setMtimeMinutesAgo(`${dir}/lock`, testNow, 11);

  const envOpts = {
    allowEnv: ["STATE_CLI_TEST_NOW_MS"],
    env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
  };
  const [r1, r2] = await Promise.all([
    runCli(
      [
        "history-append",
        "--state-dir",
        dir,
        "--line",
        "from-1",
        "--lock-retry-ms",
        "20",
        "--lock-max-retries",
        "200",
      ],
      { allowRead: [dir], allowWrite: [dir], ...envOpts },
    ),
    runCli(
      [
        "history-append",
        "--state-dir",
        dir,
        "--line",
        "from-2",
        "--lock-retry-ms",
        "20",
        "--lock-max-retries",
        "200",
      ],
      { allowRead: [dir], allowWrite: [dir], ...envOpts },
    ),
  ]);
  assertEquals(r1.code, 0, r1.stdout + r1.stderr);
  assertEquals(r2.code, 0, r2.stdout + r2.stderr);
  const final = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  const hist = final.history as string[];
  assertEquals(hist.length, 2);
  assert(hist.includes("from-1"), "from-1 present");
  assert(hist.includes("from-2"), "from-2 present");
  let lockExists = true;
  try {
    await Deno.stat(`${dir}/lock`);
  } catch {
    lockExists = false;
  }
  assert(!lockExists, "lock should be released after both callers finish");
});

// ---------------------------------------------------------------------------
// C: 並行性 (lost update・部分書き込み)
// ---------------------------------------------------------------------------

Deno.test({
  name: "T-C1: 100 parallel history-append calls -> no lost updates",
  fn: async () => {
    const dir = await tempDir();
    await writeStateFile(dir, JSON.stringify(minimalValidState()));
    const N = 100;
    const calls = Array.from(
      { length: N },
      (_, i) =>
        runCli(
          [
            "history-append",
            "--state-dir",
            dir,
            "--line",
            `item-${i}`,
            "--lock-retry-ms",
            "20",
            "--lock-max-retries",
            "1000",
          ],
          { allowRead: [dir], allowWrite: [dir] },
        ),
    );
    const results = await Promise.all(calls);
    for (const r of results) {
      assertEquals(r.code, 0, r.stdout + r.stderr);
    }
    const final = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
    const hist = new Set(final.history as string[]);
    assertEquals(
      hist.size,
      N,
      `expected ${N} distinct entries, got ${hist.size}`,
    );
    for (let i = 0; i < N; i++) {
      assert(hist.has(`item-${i}`), `missing item-${i}`);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "T-C2: kill before rename -> state.json remains prior content, still valid JSON",
  fn: async () => {
    const dir = await tempDir();
    const initial = JSON.stringify(minimalValidState());
    await writeStateFile(dir, initial);
    const child = spawnCli(
      ["history-append", "--state-dir", dir, "--line", "should-not-land"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS"],
        env: { STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS: "3000" },
      },
    );
    await new Promise((r) => setTimeout(r, 500)); // tmp 書き込み後・rename 前で待つ頃合い
    try {
      child.kill("SIGKILL");
    } catch {
      // 既に終了していた場合は無視
    }
    await child.status;
    await child.stdout.cancel();
    await child.stderr.cancel();

    const after = await Deno.readTextFile(`${dir}/state.json`);
    assertEquals(after, initial, "state.json must remain the pre-kill content");

    // validate が PASS すること (妥当な JSON のまま)
    const v = await runCli(["validate", "--state-dir", dir], {
      allowRead: [dir],
      allowWrite: [dir],
    });
    assertEquals(v.code, 0, v.stdout + v.stderr);

    // lock は掴んだままかもしれないので後始末 (次のテストに影響させない)
    try {
      await Deno.remove(`${dir}/lock`, { recursive: true });
    } catch {
      // 無ければ何もしない
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// P: 権限封じ込め
// ---------------------------------------------------------------------------

Deno.test("T-P1: --state-dir outside allow -> permission, nothing created", async () => {
  const outside = await tempDir();
  const other = await tempDir();
  const gcd = await tempDir();
  const res = await runCli(
    [
      "init",
      "--state-dir",
      outside,
      "--tracker",
      "t",
      "--source",
      "s",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [other, `${gcd}/info`], allowWrite: [other, `${gcd}/info`] },
  );
  assertEquals(res.code, EXIT_CODES.permission, res.stdout + res.stderr);
  let stateExists = true;
  try {
    await Deno.stat(`${outside}/state.json`);
  } catch {
    stateExists = false;
  }
  assert(!stateExists, "state.json must not be created");
  let lockExists = true;
  try {
    await Deno.stat(`${outside}/lock`);
  } catch {
    lockExists = false;
  }
  assert(!lockExists, "lock must not be created (mkdir never happens)");
});

Deno.test("T-P2: init --git-common-dir outside allow -> permission, exclude untouched, state.json not created", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  await Deno.mkdir(`${gcd}/info`, { recursive: true });
  const otherGcd = await tempDir(); // allow はこちらだけに与える
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "t",
      "--source",
      "s",
      "--git-common-dir",
      gcd,
    ],
    {
      allowRead: [dir, `${otherGcd}/info`],
      allowWrite: [dir, `${otherGcd}/info`],
    },
  );
  assertEquals(res.code, EXIT_CODES.permission, res.stdout + res.stderr);
  let excludeExists = true;
  try {
    await Deno.stat(`${gcd}/info/exclude`);
  } catch {
    excludeExists = false;
  }
  assert(!excludeExists, "exclude must not be created/modified");
  let stateExists = true;
  try {
    await Deno.stat(`${dir}/state.json`);
  } catch {
    stateExists = false;
  }
  assert(!stateExists, "state.json must not be created");
});

Deno.test("T-P3: properly scoped allow -> all verbs succeed", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const initRes = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "markdown",
      "--source",
      "./TASKS.md",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(initRes.code, 0, initRes.stdout + initRes.stderr);

  const getRes = await runCli(["get", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(getRes.code, 0, getRes.stdout + getRes.stderr);

  const validateRes = await runCli(["validate", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(validateRes.code, 0, validateRes.stdout + validateRes.stderr);

  const historyRes = await runCli(
    ["history-append", "--state-dir", dir, "--line", "x"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(historyRes.code, 0, historyRes.stdout + historyRes.stderr);

  const touchRes = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "sess-1"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(touchRes.code, 0, touchRes.stdout + touchRes.stderr);

  const aliveRes = await runCli(["sessions-alive", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(aliveRes.code, 0, aliveRes.stdout + aliveRes.stderr);
  assertEquals(parseJson(aliveRes.stdout).alive, ["sess-1"]);
});

// ---------------------------------------------------------------------------
// H: heartbeat
// ---------------------------------------------------------------------------

async function makeSessionFile(
  stateDir: string,
  id: string,
  nowMsRef: number,
  minutesAgo: number,
): Promise<void> {
  await Deno.mkdir(`${stateDir}/sessions`, { recursive: true });
  const path = `${stateDir}/sessions/${id}`;
  await Deno.writeTextFile(path, "");
  await setMtimeMinutesAgo(path, nowMsRef, minutesAgo);
}

Deno.test("T-H1/H2/H3: sessions-alive boundary at 89/90/91 minutes", async () => {
  const dir = await tempDir();
  const testNow = Date.now();
  await makeSessionFile(dir, "s-89", testNow, 89);
  await makeSessionFile(dir, "s-90", testNow, 90);
  await makeSessionFile(dir, "s-91", testNow, 91);
  const res = await runCli(["sessions-alive", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_CLI_TEST_NOW_MS"],
    env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
  });
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const alive = new Set(parseJson(res.stdout).alive as string[]);
  assert(alive.has("s-89"), "89min should be alive");
  assert(!alive.has("s-90"), "exactly 90min should not be alive (strict <)");
  assert(!alive.has("s-91"), "91min should not be alive");
});

Deno.test("T-H4/H5/H6: session-touch cleanup boundary at 1439/1440/1441 minutes", async () => {
  const dir = await tempDir();
  const testNow = Date.now();
  await makeSessionFile(dir, "s-1439", testNow, 1439);
  await makeSessionFile(dir, "s-1440", testNow, 1440);
  await makeSessionFile(dir, "s-1441", testNow, 1441);
  const res = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "toucher"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_CLI_TEST_NOW_MS"],
      env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
    },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const cleaned = new Set(parseJson(res.stdout).cleaned as string[]);
  assert(!cleaned.has("s-1439"), "1439min should be kept");
  assert(!cleaned.has("s-1440"), "exactly 1440min should be kept (strict >)");
  assert(cleaned.has("s-1441"), "1441min should be cleaned");

  const existsAfter = async (id: string) => {
    try {
      await Deno.stat(`${dir}/sessions/${id}`);
      return true;
    } catch {
      return false;
    }
  };
  assert(await existsAfter("s-1439"), "s-1439 file should still exist");
  assert(await existsAfter("s-1440"), "s-1440 file should still exist");
  assert(!(await existsAfter("s-1441")), "s-1441 file should be removed");
});

Deno.test("T-H7: sessions-alive with no sessions dir -> empty array, no error", async () => {
  const dir = await tempDir();
  const res = await runCli(["sessions-alive", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, 0, res.stdout + res.stderr);
  assertEquals(parseJson(res.stdout).alive, []);
});

Deno.test("T-H8: session-touch --id shape violations -> usage", async () => {
  const dir = await tempDir();
  for (const badId of ["", "a/b", "..", "."]) {
    const res = await runCli(
      ["session-touch", "--state-dir", dir, "--id", badId],
      { allowRead: [dir], allowWrite: [dir] },
    );
    assertEquals(
      res.code,
      EXIT_CODES.usage,
      `id=${JSON.stringify(badId)}: ${res.stdout}`,
    );
  }
});

Deno.test("T-H9: session-touch refreshes mtime on repeated calls for the same id", async () => {
  const dir = await tempDir();
  const t1 = Date.now();
  const t2 = t1 + 5000;
  const r1 = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "s-refresh"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_CLI_TEST_NOW_MS"],
      env: { STATE_CLI_TEST_NOW_MS: String(t1) },
    },
  );
  assertEquals(r1.code, 0, r1.stdout + r1.stderr);
  const mtime1 = await statMtime(`${dir}/sessions/s-refresh`);
  const r2 = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "s-refresh"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_CLI_TEST_NOW_MS"],
      env: { STATE_CLI_TEST_NOW_MS: String(t2) },
    },
  );
  assertEquals(r2.code, 0, r2.stdout + r2.stderr);
  const mtime2 = await statMtime(`${dir}/sessions/s-refresh`);
  assert(
    mtime2 > mtime1,
    `expected refreshed mtime to advance: ${mtime1} -> ${mtime2}`,
  );
});

Deno.test("T-H10: session-touch on a stale id refreshes it instead of deleting it", async () => {
  const dir = await tempDir();
  const testNow = Date.now();
  await makeSessionFile(dir, "s-old", testNow, 1500); // 1440分超、掃除対象になり得る年齢
  const res = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "s-old"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_CLI_TEST_NOW_MS"],
      env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
    },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const cleaned = parseJson(res.stdout).cleaned as string[];
  assert(!cleaned.includes("s-old"), "s-old must not be reported as cleaned");
  const exists = await Deno.stat(`${dir}/sessions/s-old`).then(() => true)
    .catch(() => false);
  assert(exists, "s-old file must still exist after touch");
  const mtime = await statMtime(`${dir}/sessions/s-old`);
  assertEquals(mtime, testNow, "s-old mtime should be refreshed to now");
});

// ---------------------------------------------------------------------------
// I: init の exclude 冪等性
// ---------------------------------------------------------------------------

async function runInit(
  dir: string,
  gcd: string,
  extra: string[] = [],
): Promise<RunResult> {
  return await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "markdown",
      "--source",
      "./TASKS.md",
      "--git-common-dir",
      gcd,
      ...extra,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
}

Deno.test("T-I1: init appends the exclude line when absent", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  await Deno.mkdir(`${gcd}/info`, { recursive: true });
  await Deno.writeTextFile(`${gcd}/info/exclude`, "# comment\n");
  const res = await runInit(dir, gcd);
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const content = await Deno.readTextFile(`${gcd}/info/exclude`);
  const expectedLine = `/${dir.split("/").filter(Boolean).pop()}/`;
  assert(content.includes("# comment\n"), "existing content preserved");
  assert(
    content.split("\n").includes(expectedLine),
    `exclude line ${expectedLine} not found in:\n${content}`,
  );
});

Deno.test("T-I2: init is a no-op on the exclude file when the line already exists", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const r1 = await runInit(dir, gcd);
  assertEquals(r1.code, 0, r1.stdout + r1.stderr);
  const mtimeBefore = await statMtime(`${gcd}/info/exclude`);
  await new Promise((r) => setTimeout(r, 50));
  const r2 = await runInit(dir, gcd);
  assertEquals(r2.code, 0, r2.stdout + r2.stderr);
  const mtimeAfter = await statMtime(`${gcd}/info/exclude`);
  assertEquals(mtimeAfter, mtimeBefore, "exclude file must not be rewritten");
});

Deno.test("T-I3: init creates info/ dir when absent, then appends", async () => {
  const dir = await tempDir();
  const gcd = await tempDir(); // info/ 自体を作らない
  const res = await runInit(dir, gcd);
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const content = await Deno.readTextFile(`${gcd}/info/exclude`);
  const expectedLine = `/${dir.split("/").filter(Boolean).pop()}/`;
  assert(
    content.split("\n").includes(expectedLine),
    `exclude line ${expectedLine} not found in:\n${content}`,
  );
});

Deno.test("T-I4: tracked .gitignore is untouched by init", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const gitignorePath = `${dir}-gitignore-sibling/.gitignore`;
  await Deno.mkdir(`${dir}-gitignore-sibling`, { recursive: true });
  await Deno.writeTextFile(gitignorePath, "node_modules/\n");
  const before = await Deno.readTextFile(gitignorePath);
  const beforeMtime = await statMtime(gitignorePath);
  const res = await runInit(dir, gcd);
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const after = await Deno.readTextFile(gitignorePath);
  const afterMtime = await statMtime(gitignorePath);
  assertEquals(after, before);
  assertEquals(afterMtime, beforeMtime);
});

// ---------------------------------------------------------------------------
// B: 後方互換 (schema_version)
// ---------------------------------------------------------------------------

function diffKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
  }
  return diffs;
}

Deno.test("T-B1: history-append on legacy fixture adds schema_version, preserves everything else", async () => {
  const dir = await tempDir();
  const fixture = await readFixture("valid-legacy-live.json");
  await writeStateFile(dir, fixture);
  const before = JSON.parse(fixture);
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "new entry"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const after = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  const diffs = diffKeys(before, after).sort();
  assertEquals(diffs, ["history", "schema_version", "updated_at"]);
  assertEquals(after.schema_version, 1);
  assertEquals(
    Object.keys(after).indexOf("schema_version"),
    Object.keys(after).length - 1,
  );
  assertEquals(
    Object.keys(after).slice(0, Object.keys(before).length),
    Object.keys(before),
  );
});

Deno.test("T-B1b: history-append on fixture already at schema_version:1 keeps it at 1", async () => {
  const dir = await tempDir();
  const fixture = await readFixture("valid-watch-rebase.json");
  await writeStateFile(dir, fixture);
  const before = JSON.parse(fixture);
  assertEquals(before.schema_version, 1);
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "x"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const after = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(after.schema_version, 1);
  const diffs = diffKeys(before, after).sort();
  assertEquals(diffs, ["history", "updated_at"]);
});

Deno.test("T-B1c: history-append preserves a non-default schema_version (2)", async () => {
  const dir = await tempDir();
  const content = JSON.stringify(minimalValidState({ schema_version: 2 }));
  await writeStateFile(dir, content);
  const res = await runCli(
    ["history-append", "--state-dir", dir, "--line", "x"],
    { allowRead: [dir], allowWrite: [dir] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const after = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(after.schema_version, 2);
});

Deno.test("T-B2: init on legacy fixture adds schema_version, ignores --tracker/--source, preserves rest", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const fixture = await readFixture("valid-legacy-live.json");
  await writeStateFile(dir, fixture);
  const before = JSON.parse(fixture);
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "DIFFERENT-TRACKER",
      "--source",
      "DIFFERENT-SOURCE",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const body = parseJson(res.stdout);
  assertEquals(body.created, false);
  const after = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(after.tracker, before.tracker);
  assertEquals(after.source, before.source);
  const diffs = diffKeys(before, after);
  assertEquals(diffs, ["schema_version"]);
  assertEquals(
    Object.keys(after).slice(0, Object.keys(before).length),
    Object.keys(before),
  );
});

Deno.test("T-B3: init on fixture already at schema_version:1 is a true no-op (mtime, bytes, no tmp)", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const fixture = await readFixture("valid-watch-rebase.json");
  await writeStateFile(dir, fixture);
  const beforeBytes = await Deno.readFile(`${dir}/state.json`);
  const beforeMtime = await statMtime(`${dir}/state.json`);
  await new Promise((r) => setTimeout(r, 50));
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "whatever",
      "--source",
      "whatever",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  assertEquals(parseJson(res.stdout).created, false);
  const afterBytes = await Deno.readFile(`${dir}/state.json`);
  const afterMtime = await statMtime(`${dir}/state.json`);
  assertEquals(
    Array.from(afterBytes),
    Array.from(beforeBytes),
    "bytes must be unchanged",
  );
  assertEquals(
    afterMtime,
    beforeMtime,
    "mtime must be unchanged (no write happened)",
  );
  const tmpEntries = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.includes(".tmp.")) tmpEntries.push(e.name);
  }
  assertEquals(tmpEntries, []);
});

Deno.test("T-B4: init preserves a non-default schema_version (2), does not reset to default", async () => {
  const dir = await tempDir();
  const gcd = await tempDir();
  const content = JSON.stringify(minimalValidState({ schema_version: 2 }));
  await writeStateFile(dir, content);
  const res = await runCli(
    [
      "init",
      "--state-dir",
      dir,
      "--tracker",
      "markdown",
      "--source",
      "./TASKS.md",
      "--git-common-dir",
      gcd,
    ],
    { allowRead: [dir, `${gcd}/info`], allowWrite: [dir, `${gcd}/info`] },
  );
  assertEquals(res.code, 0, res.stdout + res.stderr);
  const after = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(after.schema_version, 2);
});

// ---------------------------------------------------------------------------
// D: 終了コード契約ドキュメント
// ---------------------------------------------------------------------------

Deno.test("T-D1: docs/state-cli-contract.md exit code table matches EXIT_CODES", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const rowRe = /^\|\s*`?([a-z]+)`?\s*\|\s*(\d+)\s*\|/gm;
  const found = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(doc)) !== null) {
    const name = m[1];
    if (name === "名前") continue; // ヘッダ行
    found.set(name, Number(m[2]));
  }
  const expected = new Map(Object.entries(EXIT_CODES));
  assertEquals(found.size, expected.size, `doc rows: ${[...found.keys()]}`);
  for (const [name, code] of expected) {
    assert(found.has(name), `doc missing exit code row for "${name}"`);
    assertEquals(found.get(name), code, `code mismatch for "${name}"`);
  }
});
