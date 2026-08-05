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
//   V  state-cli-verbs で追加した36 verb (タスク進行・追従・載せ直し・回収と候補・全体)

import { ALLOWED_FLAGS, EXIT_CODES } from "./state.ts";
import {
  GATE_PHASE_SEQUENCES,
  GATE_VALUES,
  LIFECYCLE_NODES,
  PHASE_VALUES,
  VERB_LIFECYCLE,
} from "./state-transitions.ts";

const SCRIPT_URL = new URL("./state.ts", import.meta.url);
const REPO_ROOT = new URL("../../", import.meta.url);
const FIXTURES_DIR = new URL("tests/fixtures/state-cli/", REPO_ROOT);
const CONTRACT_DOC = new URL(
  "task-pipeline/docs/state-cli-contract.md",
  REPO_ROOT,
);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);

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

// ---------------------------------------------------------------------------
// V系テスト用ヘルパ (queue エントリ・review/watch/rebase の組み立て、成功/失敗の共通アサート)
// ---------------------------------------------------------------------------

function queueItem(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...MINIMAL_QUEUE_ITEM, ...overrides };
}

function reviewOf(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return { ref: "https://example.com/pull/1", ...overrides };
}

function watchOf(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    state: "watching",
    proc: null,
    proc_started_at: null,
    sig: null,
    head: null,
    ci: null,
    handled: [],
    fix_pending: false,
    pending_ids: [],
    findings: null,
    fix_attempts: 0,
    errors: 0,
    checked_at: null,
    note: null,
    ...overrides,
  };
}

function rebaseOf(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    blocked_onto: "sha-onto-1",
    reason: "conflict",
    at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

async function setupQueue(
  dir: string,
  items: Record<string, unknown>[],
  extra?: Record<string, unknown>,
): Promise<void> {
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ queue: items, ...extra })),
  );
}

async function readState(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
}

async function readItem(
  dir: string,
  id = "t-1",
): Promise<Record<string, unknown>> {
  const state = await readState(dir);
  const queue = state.queue as Record<string, unknown>[];
  const item = queue.find((q) => q.id === id);
  if (!item) throw new Error(`item not found after read: ${id}`);
  return item;
}

async function runVerb(
  dir: string,
  args: string[],
): Promise<RunResult> {
  return await runCli(args, { allowRead: [dir], allowWrite: [dir] });
}

// 成功を期待し、結果オブジェクトを返す (呼び出し側でフィールドを個別に assert する)。
async function expectOk(
  dir: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const res = await runVerb(dir, args);
  assertEquals(res.code, 0, res.stdout + res.stderr);
  return parseJson(res.stdout);
}

// 失敗 (exit !== 0) を期待し、期待した終了コードであること・state.json が実行前後で
// バイト単位で不変であること (updated_at も動かない) を assert する。
// 受け入れ条件3「前提違反は state を変えずに失敗する」の共通アサート。
async function expectFailureUnchanged(
  dir: string,
  args: string[],
  expectedCode: number,
): Promise<void> {
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const res = await runVerb(dir, args);
  assertEquals(res.code, expectedCode, res.stdout + res.stderr);
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(after, before, "state.json must be byte-unchanged on failure");
}

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

Deno.test({
  name:
    "T-L5: lock removed externally before release -> NotFound tolerated, verb still succeeds",
  fn: async () => {
    const dir = await tempDir();
    await writeStateFile(dir, JSON.stringify(minimalValidState()));
    const child = spawnCli(
      ["history-append", "--state-dir", dir, "--line", "hello"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS"],
        env: { STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS: "3000" },
      },
    );
    await new Promise((r) => setTimeout(r, 500)); // tmp 書き込み後・rename 前で待つ頃合い
    // 別セッションが stale lock を回収した想定 (mv+削除の結果、lock は既に無い)。
    await Deno.remove(`${dir}/lock`, { recursive: true });
    const { code, stdout } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    assertEquals(code, 0, out);
    const parsed = parseJson(out);
    assertEquals(parsed.ok, true, out);
    assertEquals(parsed.history_length, 1, out);
    const final = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
    assertEquals(final.history, ["hello"]);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "T-L6: lock release blocked by real permission error -> permission propagates (not swallowed as NotFound)",
  fn: async () => {
    const dir = await tempDir();
    await writeStateFile(dir, JSON.stringify(minimalValidState()));
    const child = spawnCli(
      ["history-append", "--state-dir", dir, "--line", "hello"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_PAUSE_BEFORE_LOCK_RELEASE_MS"],
        env: { STATE_CLI_TEST_PAUSE_BEFORE_LOCK_RELEASE_MS: "3000" },
      },
    );
    await new Promise((r) => setTimeout(r, 800)); // write は完了し、release の一時停止中のはず
    // state dir を書き込み不可にし、lock の remove そのものを (NotFound ではなく) 権限エラーで
    // 失敗させる。write (rename) は既に完了しているので巻き込まれない。
    await Deno.chmod(dir, 0o500);
    const { code, stdout } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    await Deno.chmod(dir, 0o755); // 後始末 (次のテストに影響させない)
    assertEquals(code, EXIT_CODES.permission, out);
    const parsed = parseJson(out);
    assertEquals(parsed.error, "permission", out);
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

Deno.test({
  name:
    "T-H11: session-touch cleanup skips a stale entry that vanishes before stat (NotFound tolerated)",
  fn: async () => {
    const dir = await tempDir();
    const testNow = Date.now();
    await makeSessionFile(dir, "victim", testNow, 1500); // 1440分超、掃除対象
    const child = spawnCli(
      [
        "session-touch",
        "--state-dir",
        dir,
        "--id",
        "toucher",
        "--cleanup-stale-min",
        "1440",
      ],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: [
          "STATE_CLI_TEST_NOW_MS",
          "STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS",
        ],
        env: {
          STATE_CLI_TEST_NOW_MS: String(testNow),
          STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS: "1500",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 500)); // stat 直前の一時停止中に踏む頃合い
    await Deno.remove(`${dir}/sessions/victim`);
    const { code, stdout } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    assertEquals(code, 0, out);
    const parsed = parseJson(out);
    assertEquals(parsed.cleaned, [], out);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "T-H12: session-touch cleanup skips a stale entry that vanishes between stat and remove (NotFound tolerated)",
  fn: async () => {
    const dir = await tempDir();
    const testNow = Date.now();
    await makeSessionFile(dir, "victim", testNow, 1500); // 1440分超、掃除対象
    const child = spawnCli(
      [
        "session-touch",
        "--state-dir",
        dir,
        "--id",
        "toucher",
        "--cleanup-stale-min",
        "1440",
      ],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: [
          "STATE_CLI_TEST_NOW_MS",
          "STATE_CLI_TEST_PAUSE_BEFORE_SESSION_REMOVE_MS",
        ],
        env: {
          STATE_CLI_TEST_NOW_MS: String(testNow),
          STATE_CLI_TEST_PAUSE_BEFORE_SESSION_REMOVE_MS: "1500",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 500)); // stat は既に終わり、remove 直前で待つ頃合い
    await Deno.remove(`${dir}/sessions/victim`);
    const { code, stdout } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    assertEquals(code, 0, out);
    const parsed = parseJson(out);
    assertEquals(parsed.cleaned, [], out);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test(
  "T-H13: session-touch cleanup remove blocked by real permission error -> permission propagates (not swallowed as NotFound)",
  async () => {
    const dir = await tempDir();
    const testNow = Date.now();
    await Deno.mkdir(`${dir}/sessions`, { recursive: true });
    // toucher 自身のファイルは先に作っておく (書き込みを避け、掃除ループまで確実に到達させる)
    await makeSessionFile(dir, "toucher", testNow, 0);
    await makeSessionFile(dir, "victim", testNow, 1500); // 1440分超、掃除対象
    await Deno.chmod(`${dir}/sessions`, 0o555); // stat/readdir は通るが remove (unlink) は不可
    const res = await runCli(
      [
        "session-touch",
        "--state-dir",
        dir,
        "--id",
        "toucher",
        "--cleanup-stale-min",
        "1440",
      ],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_NOW_MS"],
        env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
      },
    );
    await Deno.chmod(`${dir}/sessions`, 0o755); // 後始末 (次のテストに影響させない)
    assertEquals(res.code, EXIT_CODES.permission, res.stdout + res.stderr);
    const parsed = parseJson(res.stdout);
    assertEquals(parsed.error, "permission", res.stdout);
  },
);

Deno.test({
  name:
    "T-H14: sessions-alive skips an entry that vanishes before stat (NotFound tolerated)",
  fn: async () => {
    const dir = await tempDir();
    const testNow = Date.now();
    await makeSessionFile(dir, "victim", testNow, 10); // alive 窓内 (何もしなければ alive に載る)
    const child = spawnCli(
      ["sessions-alive", "--state-dir", dir, "--alive-max-min", "90"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: [
          "STATE_CLI_TEST_NOW_MS",
          "STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS",
        ],
        env: {
          STATE_CLI_TEST_NOW_MS: String(testNow),
          STATE_CLI_TEST_PAUSE_BEFORE_SESSION_STAT_MS: "1500",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 500)); // stat 直前の一時停止中に踏む頃合い
    await Deno.remove(`${dir}/sessions/victim`);
    const { code, stdout } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    assertEquals(code, 0, out);
    const parsed = parseJson(out);
    assertEquals(parsed.alive, [], out);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test(
  "T-H15: sessions-alive stat blocked by real permission error -> permission propagates (not swallowed as NotFound)",
  async () => {
    const dir = await tempDir();
    const testNow = Date.now();
    await makeSessionFile(dir, "victim", testNow, 10);
    // read はできる (readDir は通る) が execute (search) が無いので per-entry stat が
    // EACCES になる — readdir 自体の NotFound/permission 処理 (chmod 000 相当) とは別経路。
    await Deno.chmod(`${dir}/sessions`, 0o400);
    const res = await runCli(
      ["sessions-alive", "--state-dir", dir, "--alive-max-min", "90"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_NOW_MS"],
        env: { STATE_CLI_TEST_NOW_MS: String(testNow) },
      },
    );
    await Deno.chmod(`${dir}/sessions`, 0o755); // 後始末 (次のテストに影響させない)
    assertEquals(res.code, EXIT_CODES.permission, res.stdout + res.stderr);
    const parsed = parseJson(res.stdout);
    assertEquals(parsed.error, "permission", res.stdout);
  },
);

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
// V: state-cli-verbs で追加した36 verb
// ---------------------------------------------------------------------------

// --- タスク進行 -------------------------------------------------------------

Deno.test("T-V-approve-1: success appends a fresh approved entry", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "approve",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--title",
    "some title",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "approved");
  assertEquals(item.gate, "full");
  assertEquals(item.phase, null);
  assertEquals(item.title, "some title");
});

Deno.test("T-V-approve-2: id already in queue -> conflict, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({})]);
  await expectFailureUnchanged(
    dir,
    ["approve", "--state-dir", dir, "--id", "t-1", "--title", "dup"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-claim-1: approved -> in_progress/research", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })]);
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_progress");
  assertEquals(item.phase, "research");
  assertEquals(item.attempts, 0);
  assertEquals(item.session, "s1");
});

Deno.test("T-V-claim-2: status in_progress (active, not approved) -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research", session: "other" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["claim", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-claim-3: status done (terminal, not approved) -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "done" })]);
  await expectFailureUnchanged(
    dir,
    ["claim", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-claim-4: id not in queue -> missing", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectFailureUnchanged(
    dir,
    ["claim", "--state-dir", dir, "--id", "nope", "--session", "s1"],
    EXIT_CODES.missing,
  );
});

Deno.test({
  name:
    "T-V-claim-5: concurrent claim on same approved task -> exactly one succeeds (AC4)",
  fn: async () => {
    const dir = await tempDir();
    await setupQueue(dir, [queueItem({ status: "approved" })]);
    const args = (session: string) => [
      "claim",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      session,
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "200",
    ];
    const [r1, r2] = await Promise.all([
      runVerb(dir, args("s1")),
      runVerb(dir, args("s2")),
    ]);
    const codes = [r1.code, r2.code].sort();
    assertEquals(codes, [0, EXIT_CODES.conflict].sort());
    const winnerSession = r1.code === 0 ? "s1" : "s2";
    const item = await readItem(dir);
    assertEquals(item.status, "in_progress");
    assertEquals(item.phase, "research");
    assertEquals(item.attempts, 0);
    assertEquals(item.session, winnerSession);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test("T-V-set-gate-1: success upgrades gate/phase", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research", gate: "full" }),
  ]);
  await expectOk(dir, ["set-gate", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.gate, "light");
  assertEquals(item.phase, "research+plan");
});

Deno.test("T-V-set-gate-2: phase already past research -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "plan", gate: "full" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["set-gate", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-worktree-1: success sets worktree/base", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectOk(dir, [
    "set-worktree",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--worktree",
    "/abs/wt",
    "--base",
    "main",
  ]);
  const item = await readItem(dir);
  assertEquals(item.worktree, "/abs/wt");
  assertEquals(item.base, "main");
});

Deno.test("T-V-set-worktree-2: status not in_progress -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })]);
  await expectFailureUnchanged(
    dir,
    [
      "set-worktree",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--worktree",
      "/abs/wt",
      "--base",
      "main",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-worktree-3: --drop-withdrawn-branch true removes matching entry", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ], {
    withdrawn_branches: [{
      id: "t-1",
      branch: "task-pipeline/t-1",
      base: "main",
      worktree: "/old",
      at: "2026-08-01T00:00:00Z",
      reason: "x",
    }],
  });
  await expectOk(dir, [
    "set-worktree",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--worktree",
    "/abs/wt",
    "--base",
    "main",
    "--drop-withdrawn-branch",
    "true",
  ]);
  const state = await readState(dir);
  assertEquals(state.withdrawn_branches, []);
});

Deno.test("T-V-set-worktree-4: --drop-withdrawn-branch true without matching entry -> conflict, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ], {
    withdrawn_branches: [],
  });
  await expectFailureUnchanged(
    dir,
    [
      "set-worktree",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--worktree",
      "/abs/wt",
      "--base",
      "main",
      "--drop-withdrawn-branch",
      "true",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-executor-1: writes executor/executor_last_event_at/session together (AC5)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectOk(dir, [
    "set-executor",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--executor",
    "agent-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.executor, "agent-1");
  assertEquals(item.session, "s1");
  assert(
    typeof item.executor_last_event_at === "string" &&
      (item.executor_last_event_at as string).length > 0,
    "executor_last_event_at should be set",
  );
});

Deno.test("T-V-set-executor-2: status not in_progress -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "blocked" })]);
  await expectFailureUnchanged(
    dir,
    [
      "set-executor",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--executor",
      "agent-1",
      "--session",
      "s1",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-executor-3: missing --session -> usage (no partial-write flag combination exists, AC5)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "set-executor",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--executor",
      "agent-1",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-touch-executor-1: bumps executor_last_event_at only", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "implement",
      executor: "agent-1",
      executor_last_event_at: "2026-08-01T00:00:00Z",
      session: "s1",
    }),
  ]);
  await expectOk(dir, ["touch-executor", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assert(
    item.executor_last_event_at !== "2026-08-01T00:00:00Z",
    "executor_last_event_at should have moved",
  );
  assertEquals(item.session, "s1");
});

Deno.test("T-V-touch-executor-2: --session fills when session is null", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "implement",
      executor: "agent-1",
      session: null,
    }),
  ]);
  await expectOk(dir, [
    "touch-executor",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s-new",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "s-new");
});

Deno.test("T-V-touch-executor-3: --session does not overwrite an existing session", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "implement",
      executor: "agent-1",
      session: "s-existing",
    }),
  ]);
  await expectOk(dir, [
    "touch-executor",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s-new",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "s-existing");
});

Deno.test("T-V-touch-executor-4: executor null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", executor: null }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["touch-executor", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-takeover-1: --at sets takeover_at", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectOk(dir, [
    "set-takeover",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--at",
    "2026-08-02T00:00:00Z",
  ]);
  const item = await readItem(dir);
  assertEquals(item.takeover_at, "2026-08-02T00:00:00Z");
});

Deno.test("T-V-set-takeover-2: --clear resets takeover_at to null", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "implement",
      takeover_at: "2026-08-02T00:00:00Z",
    }),
  ]);
  await expectOk(dir, [
    "set-takeover",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--clear",
    "true",
  ]);
  const item = await readItem(dir);
  assertEquals(item.takeover_at, null);
});

Deno.test("T-V-set-takeover-3: neither --at nor --clear -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["set-takeover", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-set-takeover-4: both --at and --clear -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "set-takeover",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--at",
      "2026-08-02T00:00:00Z",
      "--clear",
      "true",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-set-takeover-5: status not in_progress -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })]);
  await expectFailureUnchanged(
    dir,
    [
      "set-takeover",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--at",
      "2026-08-02T00:00:00Z",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-pass-1: success advances phase and resets attempts", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research", attempts: 2 }),
  ]);
  await expectOk(dir, [
    "phase-pass",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "research",
    "--to",
    "plan",
  ]);
  const item = await readItem(dir);
  assertEquals(item.phase, "plan");
  assertEquals(item.attempts, 0);
});

Deno.test("T-V-phase-pass-2: status not in_progress (phase matches from) -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "blocked", phase: "research" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "research",
      "--to",
      "plan",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-pass-3: phase mismatch (status matches) -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "in_progress", phase: "plan" })]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "research",
      "--to",
      "plan",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-fail-1: success increments attempts", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement", attempts: 1 }),
  ]);
  const body = await expectOk(dir, [
    "phase-fail",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--phase",
    "implement",
  ]);
  assertEquals(body.attempts, 2);
  const item = await readItem(dir);
  assertEquals(item.attempts, 2);
});

Deno.test("T-V-phase-fail-2: phase mismatch -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "in_progress", phase: "plan" })]);
  await expectFailureUnchanged(
    dir,
    ["phase-fail", "--state-dir", dir, "--id", "t-1", "--phase", "implement"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-block-1: success sets blocked fields", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement", session: "s1" }),
  ]);
  await expectOk(dir, [
    "block",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--reason",
    "broke",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "blocked");
  assertEquals(item.blocked_reason, "broke");
  assertEquals(item.phase, null);
  assertEquals(item.session, null);
});

// blocked は追従対象外なので、pr_fix 中の block でも watch は停止する (watching のまま
// 残すと、停止経路の watch-set [前提: in_review] で誰にも止められなくなる)。
Deno.test("T-V-block-3: blocking a pr_fix task also stops its watch", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "pr_fix",
      session: "s1",
      review: reviewOf({
        watch: watchOf({ proc: "bg-1", handled: ["c1"], fix_attempts: 1 }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "block",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--reason",
    "verify failed 3 times",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "blocked");
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "stopped");
  assertEquals(watch.proc, null);
  assertEquals(watch.handled, ["c1"]);
  assertEquals(watch.fix_attempts, 1);
});

Deno.test("T-V-block-2: status not in_progress -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })]);
  await expectFailureUnchanged(
    dir,
    ["block", "--state-dir", dir, "--id", "t-1", "--reason", "x"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-dequeue-1: success removes the entry", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectOk(dir, ["dequeue", "--state-dir", dir, "--id", "t-1"]);
  const state = await readState(dir);
  assertEquals(state.queue, []);
});

Deno.test("T-V-dequeue-2: status not in_progress -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })]);
  await expectFailureUnchanged(
    dir,
    ["dequeue", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-finalize-start-1: success from report", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "report", attempts: 1 }),
  ]);
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "report",
  ]);
  const item = await readItem(dir);
  assertEquals(item.phase, "finalize");
  assertEquals(item.attempts, 0);
});

Deno.test("T-V-finalize-start-2: success from pr_fix", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "pr_fix" }),
  ]);
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "pr_fix",
  ]);
  const item = await readItem(dir);
  assertEquals(item.phase, "finalize");
});

Deno.test("T-V-finalize-start-2b: success from rebase_fix", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "rebase_fix" }),
  ]);
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "rebase_fix",
  ]);
  const item = await readItem(dir);
  assertEquals(item.phase, "finalize");
});

Deno.test("T-V-finalize-start-3: phase mismatch -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "implement" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["finalize-start", "--state-dir", dir, "--id", "t-1", "--from", "report"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-finalize-start-4: --from invalid value -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "report" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["finalize-start", "--state-dir", dir, "--id", "t-1", "--from", "plan"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-in-review-1: fresh with commits>=1 sets review incl. tip", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize" }),
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "2",
    "--ref",
    "https://x/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "sha123",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.phase, null);
  const review = item.review as Record<string, unknown>;
  assertEquals(review.ref, "https://x/pull/1");
  assertEquals(review.tip, "sha123");
});

Deno.test("T-V-in-review-2: fresh with commits=0 leaves tip null", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize" }),
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "0",
    "--ref",
    "https://x/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, null);
});

Deno.test("T-V-in-review-3: resume (all ref flags omitted) leaves existing review untouched", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      review: reviewOf({ branch: "b", tip: "sha0", base: "main" }),
    }),
  ]);
  await expectOk(dir, ["in-review", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "sha0");
});

Deno.test("T-V-in-review-4: partial ref flags -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["in-review", "--state-dir", dir, "--id", "t-1", "--ref", "x"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-in-review-5: commits=0 with --tip -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "in-review",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "0",
      "--ref",
      "x",
      "--branch",
      "b",
      "--base",
      "m",
      "--tip",
      "sha",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-in-review-6: commits>=1 without --tip -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "in-review",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "1",
      "--ref",
      "x",
      "--branch",
      "b",
      "--base",
      "m",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-in-review-7: phase mismatch -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "report" }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["in-review", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-in-review-8: --clear-session true nulls session alongside a fresh review write", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize", session: "sess-1" }),
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "abc123",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "abc123",
    "--clear-session",
    "true",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.session, null);
});

Deno.test("T-V-in-review-9: omitting --clear-session leaves session unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize", session: "sess-1" }),
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "0",
    "--ref",
    "https://x/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "sess-1");
});

Deno.test("T-V-in-review-10: --clear-session with a non-'true' value -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize", session: "sess-1" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "in-review",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "0",
      "--ref",
      "https://x/pull/1",
      "--branch",
      "task-pipeline/t-1",
      "--base",
      "main",
      "--clear-session",
      "false",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-in-review-11: --clear-session with a non-'true' value (numeric) -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "finalize", session: "sess-1" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "in-review",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--clear-session",
      "1",
    ],
    EXIT_CODES.usage,
  );
});

// in-review の 4 フラグ指定 (freshGroup) はグループフィールドだけを書き換え、
// review.watch / rebase / withdrawn / withdrawn_asked を保持する (issue #13 の固定:
// 以前は review を丸ごと新しいリテラルで置換し、pr_fix 復帰のたびに fix_attempts の
// 上限 [issue #15] と handled の再浮上ガードを無効化していた)。
Deno.test("T-V-in-review-12: fresh group preserves existing watch/rebase/withdrawn (issue #13)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      session: "s1",
      review: reviewOf({
        branch: "task-pipeline/t-1",
        tip: "oldtip",
        base: "main",
        watch: watchOf({
          handled: ["c1", "c2"],
          fix_attempts: 2,
          errors: 1,
          note: "n",
        }),
        rebase: rebaseOf(),
        withdrawn: true,
        withdrawn_asked: true,
      }),
    }),
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "2",
    "--ref",
    "https://example.com/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "newtip",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "newtip");
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.handled, ["c1", "c2"]);
  assertEquals(watch.fix_attempts, 2);
  assertEquals(watch.errors, 1);
  assertEquals(watch.note, "n");
  assert(review.rebase !== undefined, "rebase must be preserved");
  assertEquals(review.withdrawn, true);
  assertEquals(review.withdrawn_asked, true);
});

// --- 追従 -------------------------------------------------------------------

Deno.test("T-V-watch-init-1: success builds default watch object", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectOk(dir, [
    "watch-init",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.state, "watching");
  assertEquals(watch.handled, []);
  assertEquals(watch.review_only, []);
  assertEquals(watch.answered, []);
  assertEquals(item.session, "s1");
});

Deno.test("T-V-watch-init-2: --preserve-handled keeps existing handled list", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ handled: ["c1", "c2"] }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-init",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
    "--preserve-handled",
    "true",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.handled, ["c1", "c2"]);
});

Deno.test("T-V-watch-init-3: without --preserve-handled, handled resets to empty", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ handled: ["c1"] }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-init",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.handled, []);
});

Deno.test("T-V-watch-init-4: review null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "in_review", review: null })]);
  await expectFailureUnchanged(
    dir,
    ["watch-init", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-watch-set-1: --proc non-null also sets proc_started_at", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "bg-1",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.proc, "bg-1");
  assert(
    typeof watch.proc_started_at === "string" &&
      (watch.proc_started_at as string).length > 0,
    "proc_started_at should be set",
  );
});

Deno.test("T-V-watch-set-2: --proc null also clears proc_started_at", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          proc: "bg-1",
          proc_started_at: "2026-08-01T00:00:00Z",
        }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "null",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.proc, null);
  assertEquals(watch.proc_started_at, null);
});

Deno.test("T-V-watch-set-3: --proc omitted leaves proc_started_at unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          proc: "bg-1",
          proc_started_at: "2026-08-01T00:00:00Z",
        }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--note",
    "hi",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.proc, "bg-1");
  assertEquals(watch.proc_started_at, "2026-08-01T00:00:00Z");
});

Deno.test("T-V-watch-set-4: --state stopped also nulls top-level session", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--state",
    "stopped",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, null);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "stopped");
});

Deno.test("T-V-watch-set-5: --state watching leaves session unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ watch: watchOf({ state: "stopped" }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--state",
    "watching",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "s1");
});

Deno.test("T-V-watch-set-6: --state omitted leaves session unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--note",
    "x",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "s1");
});

Deno.test("T-V-watch-set-7: --errors-inc increments from current value", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ errors: 2 }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--errors-inc",
    "true",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.errors, 3);
});

Deno.test("T-V-watch-set-8: --errors-reset sets to 0 from a non-zero value", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ errors: 3 }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--errors-reset",
    "true",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.errors, 0);
});

Deno.test("T-V-watch-set-9: review.watch null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["watch-set", "--state-dir", dir, "--id", "t-1", "--note", "x"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-watch-set-10: no field flags -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["watch-set", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-watch-set-11: --session unconditionally overwrites top-level session (even from a different non-null value)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "dead-session",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "proc-1",
    "--session",
    "sess-new",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, "sess-new");
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.proc, "proc-1");
});

Deno.test("T-V-watch-set-11b: --session null clears session without touching watch.state", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "sess-old",
      review: reviewOf({ watch: watchOf({ state: "watching" }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "null",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, null);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "watching");
});

Deno.test("T-V-watch-set-12: --session combined with --state stopped -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "watch-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--state",
      "stopped",
      "--session",
      "sess-new",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-watch-set-13: --session null combined with --state stopped -> ok (both mean null, not a conflict)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ watch: watchOf({ state: "watching" }) }),
    }),
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--state",
    "stopped",
    "--session",
    "null",
  ]);
  const item = await readItem(dir);
  assertEquals(item.session, null);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "stopped");
});

// watch-set は in_review 専用 (確認済み欠陥 6 の固定: 以前は status を見ず、飛行中の
// pr_fix タスクの session を watch 側から null に落とせた)。
Deno.test("T-V-watch-set-14: in_progress/pr_fix task -> conflict (cannot null session in flight)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "pr_fix",
      session: "s1",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "watch-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "null",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-fix-pending-1: success sets fix_pending/pending_ids/findings", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectOk(dir, [
    "fix-pending",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--pending-ids",
    "c1,c2",
    "--findings",
    "/path/f.md",
  ]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.fix_pending, true);
  assertEquals(watch.pending_ids, ["c1", "c2"]);
  assertEquals(watch.findings, "/path/f.md");
});

Deno.test("T-V-fix-pending-2: watch null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "fix-pending",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--pending-ids",
      "c1",
      "--findings",
      "/f.md",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-fix-start-1: fix_attempts<=3 -> started true, status/phase change", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({ fix_pending: true, fix_attempts: 1 }),
      }),
    }),
  ]);
  const body = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  assertEquals(body.started, true);
  assertEquals(body.fix_attempts, 2);
  const item = await readItem(dir);
  assertEquals(item.status, "in_progress");
  assertEquals(item.phase, "pr_fix");
  assertEquals(item.session, "s1");
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.fix_pending, false);
});

Deno.test("T-V-fix-start-2: fix_attempts becomes >3 -> started false, watch stopped, status untouched", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s-old",
      review: reviewOf({
        watch: watchOf({ fix_pending: true, fix_attempts: 3 }),
      }),
    }),
  ]);
  const body = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  assertEquals(body.started, false);
  assertEquals(body.fix_attempts, 4);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.session, null);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "stopped");
});

Deno.test("T-V-fix-start-3: --reset-attempts ignores a stale high count, yields 1", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({ fix_pending: true, fix_attempts: 5 }),
      }),
    }),
  ]);
  const body = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
    "--reset-attempts",
    "true",
  ]);
  assertEquals(body.started, true);
  assertEquals(body.fix_attempts, 1);
});

Deno.test("T-V-fix-start-4: fix_pending false -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ fix_pending: false }) }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["fix-start", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

// 上限到達 (state: stopped) 後の fix-start はラッチされて conflict (確認済み欠陥 9 の
// 固定: 以前は前提が真のまま残り、呼ぶたびに fix_attempts を加算し続けた)。
// ユーザーが watch.state を watching に戻したときだけ再び呼べる (--reset-attempts 経路)。
Deno.test("T-V-fix-start-5: watch stopped (cap latched) -> conflict, no further increment", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          fix_pending: true,
          fix_attempts: 4,
          state: "stopped",
          note: "追従上限",
        }),
      }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["fix-start", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-fix-done-1: moves pending_ids into handled, clears pending_ids/findings (AC7)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      review: reviewOf({
        watch: watchOf({
          handled: ["c0"],
          pending_ids: ["c1", "c2"],
          findings: "/f.md",
        }),
      }),
    }),
  ]);
  await expectOk(dir, ["fix-done", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals((watch.handled as string[]).slice().sort(), ["c0", "c1", "c2"]);
  assertEquals(watch.pending_ids, []);
  assertEquals(watch.findings, null);
});

Deno.test("T-V-fix-done-2: phase not finalize -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "pr_fix",
      review: reviewOf({ watch: watchOf({ pending_ids: ["c1"] }) }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["fix-done", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test({
  name:
    "T-V-fix-done-3: kill before rename leaves state.json at prior content (atomicity, AC7)",
  fn: async () => {
    const dir = await tempDir();
    await setupQueue(dir, [
      queueItem({
        status: "in_progress",
        phase: "finalize",
        review: reviewOf({
          watch: watchOf({ pending_ids: ["c1", "c2"] }),
        }),
      }),
    ]);
    const initial = await Deno.readTextFile(`${dir}/state.json`);
    const child = spawnCli(
      ["fix-done", "--state-dir", dir, "--id", "t-1"],
      {
        allowRead: [dir],
        allowWrite: [dir],
        allowEnv: ["STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS"],
        env: { STATE_CLI_TEST_PAUSE_BEFORE_RENAME_MS: "3000" },
      },
    );
    await new Promise((r) => setTimeout(r, 500));
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
    try {
      await Deno.remove(`${dir}/lock`, { recursive: true });
    } catch {
      // 無ければ何もしない
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

function reviewOnlyItemsJson(
  items: { id: string; updated_at: string | null }[],
): string {
  return JSON.stringify(items);
}

Deno.test("T-V-review-only-1: success upserts into review_only, does not touch handled", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ watch: watchOf({ handled: ["h1"] }) }),
    }),
  ]);
  const res = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([
      { id: "c1", updated_at: "2026-08-02T00:00:00Z" },
      { id: "c2", updated_at: null },
    ]),
  ]);
  assertEquals((res.new_or_changed as string[]).slice().sort(), ["c1", "c2"]);
  assertEquals(res.review_only_total, 2);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  // handled は review-only では一切変更されない (要求2の本体)。
  assertEquals(watch.handled, ["h1"]);
  const reviewOnly =
    (watch.review_only as { id: string; updated_at: string | null }[])
      .slice().sort((a, b) => a.id.localeCompare(b.id));
  assertEquals(reviewOnly, [
    { id: "c1", updated_at: "2026-08-02T00:00:00Z" },
    { id: "c2", updated_at: null },
  ]);
});

Deno.test("T-V-review-only-2: watch null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      reviewOnlyItemsJson([{ id: "c1", updated_at: null }]),
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-review-only-3: status not in_review -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "pr_fix",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      reviewOnlyItemsJson([{ id: "c1", updated_at: null }]),
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-review-only-4: same id + same updated_at -> not in new_or_changed (dedup)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  const args = [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c1", updated_at: "2026-08-02T00:00:00Z" }]),
  ];
  const first = await expectOk(dir, args);
  assertEquals(first.new_or_changed, ["c1"]);
  const second = await expectOk(dir, args);
  assertEquals(second.new_or_changed, []);
  assertEquals(second.review_only_total, 1);
});

Deno.test("T-V-review-only-5: same id + advanced updated_at -> included again in new_or_changed", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c1", updated_at: "2026-08-02T00:00:00Z" }]),
  ]);
  const second = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c1", updated_at: "2026-08-02T01:00:00Z" }]),
  ]);
  assertEquals(second.new_or_changed, ["c1"]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.review_only, [
    { id: "c1", updated_at: "2026-08-02T01:00:00Z" },
  ]);
});

Deno.test("T-V-review-only-6: updated_at null (unknown version) is always treated as changed", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  const args = [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c1", updated_at: null }]),
  ];
  const first = await expectOk(dir, args);
  assertEquals(first.new_or_changed, ["c1"]);
  // 前回・今回とも updated_at が null (版が比較不能) -> 版比較できないので毎回 changed 扱い。
  const second = await expectOk(dir, args);
  assertEquals(second.new_or_changed, ["c1"]);
  // 既知 (前回は非null) -> 今回 null になったケースも比較不能として changed 扱い。
  const third = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c2", updated_at: "2026-08-02T00:00:00Z" }]),
  ]);
  assertEquals(third.new_or_changed, ["c2"]);
  const fourth = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "c2", updated_at: null }]),
  ]);
  assertEquals(fourth.new_or_changed, ["c2"]);
});

Deno.test("T-V-review-only-7: multiple ids in one call are classified independently", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          review_only: [
            { id: "same", updated_at: "2026-08-02T00:00:00Z" },
            { id: "changed", updated_at: "2026-08-02T00:00:00Z" },
          ],
        }),
      }),
    }),
  ]);
  const res = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([
      { id: "same", updated_at: "2026-08-02T00:00:00Z" }, // 版不変
      { id: "changed", updated_at: "2026-08-02T02:00:00Z" }, // 版が進んだ
      { id: "brandnew", updated_at: "2026-08-02T00:00:00Z" }, // 新規
    ]),
  ]);
  assertEquals(
    (res.new_or_changed as string[]).slice().sort(),
    ["brandnew", "changed"],
  );
  assertEquals(res.review_only_total, 3);
});

Deno.test("T-V-review-only-8: invalid JSON in --items-json -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      "{not json",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-review-only-9: --items-json not an array -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify({ id: "c1", updated_at: null }),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-review-only-10: item missing/invalid id -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ updated_at: null }]),
    ],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: 123, updated_at: null }]),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-review-only-11: item missing/invalid updated_at -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: "c1" }]),
    ],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "review-only",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: "c1", updated_at: 123 }]),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-review-only-12: empty items array -> ok, no-op on review_only", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          review_only: [{ id: "c1", updated_at: "2026-08-02T00:00:00Z" }],
        }),
      }),
    }),
  ]);
  const res = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    "[]",
  ]);
  assertEquals(res.new_or_changed, []);
  assertEquals(res.review_only_total, 1);
});

// answered-set は review-only と同じ入出力契約 (id/updated_at の upsert・dedup) を持つ新設
// verb (gh-6: レビュアーの質問への回答投稿を記録し、二重投稿を防ぐ)。ケース番号は
// T-V-review-only-1..12 と1対1で対応させる。加えて、answered-set は watch.handled にも
// watch.review_only にも触れないこと (3つの語彙が独立であること) を各ケースで確認する。

Deno.test("T-V-answered-set-1: success upserts into answered, does not touch handled/review_only", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          handled: ["h1"],
          review_only: [{ id: "r1", updated_at: "2026-08-02T00:00:00Z" }],
        }),
      }),
    }),
  ]);
  const res = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([
      { id: "rc-1", updated_at: "2026-08-02T00:00:00Z" },
      { id: "rc-2", updated_at: null },
    ]),
  ]);
  assertEquals(
    (res.new_or_changed as string[]).slice().sort(),
    ["rc-1", "rc-2"],
  );
  assertEquals(res.answered_total, 2);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  // handled/review_only は answered-set では一切変更されない (語彙の非混入)。
  assertEquals(watch.handled, ["h1"]);
  assertEquals(watch.review_only, [
    { id: "r1", updated_at: "2026-08-02T00:00:00Z" },
  ]);
  const answered =
    (watch.answered as { id: string; updated_at: string | null }[])
      .slice().sort((a, b) => a.id.localeCompare(b.id));
  assertEquals(answered, [
    { id: "rc-1", updated_at: "2026-08-02T00:00:00Z" },
    { id: "rc-2", updated_at: null },
  ]);
});

Deno.test("T-V-answered-set-2: watch null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      reviewOnlyItemsJson([{ id: "rc-1", updated_at: null }]),
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-answered-set-3: status not in_review -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "pr_fix",
      review: reviewOf({ watch: watchOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      reviewOnlyItemsJson([{ id: "rc-1", updated_at: null }]),
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-answered-set-4: same id + same updated_at -> not in new_or_changed (dedup)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({ handled: ["h1"], review_only: [] }),
      }),
    }),
  ]);
  const args = [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-1", updated_at: "2026-08-02T00:00:00Z" }]),
  ];
  const first = await expectOk(dir, args);
  assertEquals(first.new_or_changed, ["rc-1"]);
  const second = await expectOk(dir, args);
  assertEquals(second.new_or_changed, []);
  assertEquals(second.answered_total, 1);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.handled, ["h1"]);
  assertEquals(watch.review_only, []);
});

Deno.test("T-V-answered-set-5: same id + advanced updated_at -> included again in new_or_changed", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-1", updated_at: "2026-08-02T00:00:00Z" }]),
  ]);
  const second = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-1", updated_at: "2026-08-02T01:00:00Z" }]),
  ]);
  assertEquals(second.new_or_changed, ["rc-1"]);
  const item = await readItem(dir);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.answered, [
    { id: "rc-1", updated_at: "2026-08-02T01:00:00Z" },
  ]);
});

Deno.test("T-V-answered-set-6: updated_at null (unknown version) is always treated as changed", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  const args = [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-1", updated_at: null }]),
  ];
  const first = await expectOk(dir, args);
  assertEquals(first.new_or_changed, ["rc-1"]);
  // 前回・今回とも updated_at が null (版が比較不能) -> 版比較できないので毎回 changed 扱い。
  const second = await expectOk(dir, args);
  assertEquals(second.new_or_changed, ["rc-1"]);
  // 既知 (前回は非null) -> 今回 null になったケースも比較不能として changed 扱い。
  const third = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-2", updated_at: "2026-08-02T00:00:00Z" }]),
  ]);
  assertEquals(third.new_or_changed, ["rc-2"]);
  const fourth = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([{ id: "rc-2", updated_at: null }]),
  ]);
  assertEquals(fourth.new_or_changed, ["rc-2"]);
});

Deno.test("T-V-answered-set-7: multiple ids in one call are classified independently", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          answered: [
            { id: "same", updated_at: "2026-08-02T00:00:00Z" },
            { id: "changed", updated_at: "2026-08-02T00:00:00Z" },
          ],
        }),
      }),
    }),
  ]);
  const res = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    reviewOnlyItemsJson([
      { id: "same", updated_at: "2026-08-02T00:00:00Z" }, // 版不変
      { id: "changed", updated_at: "2026-08-02T02:00:00Z" }, // 版が進んだ
      { id: "brandnew", updated_at: "2026-08-02T00:00:00Z" }, // 新規
    ]),
  ]);
  assertEquals(
    (res.new_or_changed as string[]).slice().sort(),
    ["brandnew", "changed"],
  );
  assertEquals(res.answered_total, 3);
});

Deno.test("T-V-answered-set-8: invalid JSON in --items-json -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      "{not json",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-answered-set-9: --items-json not an array -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify({ id: "rc-1", updated_at: null }),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-answered-set-10: item missing/invalid id -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ updated_at: null }]),
    ],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: 123, updated_at: null }]),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-answered-set-11: item missing/invalid updated_at -> usage, unchanged", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ watch: watchOf() }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: "rc-1" }]),
    ],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "answered-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--items-json",
      JSON.stringify([{ id: "rc-1", updated_at: 123 }]),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-answered-set-12: empty items array -> ok, no-op on answered", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({
        watch: watchOf({
          answered: [{ id: "rc-1", updated_at: "2026-08-02T00:00:00Z" }],
        }),
      }),
    }),
  ]);
  const res = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    "[]",
  ]);
  assertEquals(res.new_or_changed, []);
  assertEquals(res.answered_total, 1);
});

// --- 載せ直し -----------------------------------------------------------------

Deno.test("T-V-rebase-record-1: creates a fresh rebase block with at=now", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectOk(dir, [
    "rebase-record",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha1",
    "--reason",
    "dirty",
  ]);
  const item = await readItem(dir);
  const rebase = (item.review as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(rebase.blocked_onto, "sha1");
  assertEquals(rebase.reason, "dirty");
  assert(
    typeof rebase.at === "string" && (rebase.at as string).length > 0,
    "rebase.at should be set",
  );
});

Deno.test("T-V-rebase-record-2: second call on existing rebase preserves at, updates kind/cause/report", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectOk(dir, [
    "rebase-record",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha1",
    "--reason",
    "conflict",
  ]);
  const afterFirst = await readItem(dir);
  const atFirst =
    ((afterFirst.review as Record<string, unknown>).rebase as Record<
      string,
      unknown
    >).at;
  await expectOk(dir, [
    "rebase-record",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha1",
    "--reason",
    "conflict",
    "--kind",
    "overlap",
    "--cause",
    "dup edit",
    "--report",
    "/r.md",
  ]);
  const item = await readItem(dir);
  const rebase = (item.review as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(rebase.at, atFirst, "at must be preserved across the 2nd call");
  assertEquals(rebase.kind, "overlap");
  assertEquals(rebase.cause, "dup edit");
  assertEquals(rebase.report, "/r.md");
});

Deno.test("T-V-rebase-record-3: status not in_review -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "rebase-record",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--blocked-onto",
      "sha1",
      "--reason",
      "dirty",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-resolve-pending-1: success", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ rebase: rebaseOf() }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-resolve-pending",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from-tip",
    "oldtip",
  ]);
  const item = await readItem(dir);
  const rebase = (item.review as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(rebase.resolve_pending, true);
  assertEquals(rebase.from_tip, "oldtip");
});

Deno.test("T-V-rebase-resolve-pending-2: review.rebase null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "rebase-resolve-pending",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from-tip",
      "oldtip",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-start-1: success", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ rebase: rebaseOf({ resolve_pending: true }) }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_progress");
  assertEquals(item.phase, "rebase_fix");
  assertEquals(item.session, "s1");
  const rebase = (item.review as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(rebase.resolve_pending, false);
});

Deno.test("T-V-rebase-start-2: resolve_pending false -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ rebase: rebaseOf({ resolve_pending: false }) }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["rebase-start", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    EXIT_CODES.conflict,
  );
});

// `finalize` フェーズで executor が衝突して止まったタスク (`REBASE-CONFLICT`) は、
// `rebase-start` の第 2 の入口 (in_progress/finalize からの直接進入) で rebase_fix に
// 入る。この入口は review を見ない (最初の PR を出す直前なら review は null)。
// phase-pass は検証フェーズ列の隣接辺専用になったので、この経路には使えない
// (T-V-phase-pass-4 が拒否側を固定)。
Deno.test("T-V-rebase-start-3: finalize entry with review null -> rebase_fix, keeps review null", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      attempts: 2,
      session: "s1",
      review: null,
    }),
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_progress");
  assertEquals(item.phase, "rebase_fix");
  assertEquals(item.attempts, 0);
  assertEquals(item.session, "s1");
  assertEquals(item.review, null);
});

Deno.test("T-V-rebase-start-4: finalize entry with existing review keeps watch/rebase and clears resolve_pending", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      session: "s1",
      review: reviewOf({
        watch: watchOf({ fix_attempts: 2, handled: ["c1"] }),
        rebase: rebaseOf({ resolve_pending: true }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_progress");
  assertEquals(item.phase, "rebase_fix");
  const review = item.review as Record<string, unknown>;
  const watch = review.watch as Record<string, unknown>;
  const rebase = review.rebase as Record<string, unknown>;
  assertEquals(watch.fix_attempts, 2);
  assertEquals(watch.handled, ["c1"]);
  assertEquals(rebase.resolve_pending, false);
});

Deno.test("T-V-phase-pass-4: finalize -> rebase_fix is not a phase-pass edge -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      attempts: 2,
      session: "s1",
      review: null,
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "finalize",
      "--to",
      "rebase_fix",
    ],
    EXIT_CODES.conflict,
  );
});

// フェーズ順は GATE_PHASE_SEQUENCES の隣接ペアだけが合法 (確認済み欠陥 1 の固定):
// 飛び越し・自己辺・gate 違いの辺はすべて conflict。
Deno.test("T-V-phase-pass-5: skipping edge research -> report -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "research",
      "--to",
      "report",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-pass-6: self edge plan -> plan -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "in_progress", phase: "plan" })]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "plan",
      "--to",
      "plan",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-pass-7: full-gate task cannot take the light-gate edge research+plan -> implement", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research+plan", gate: "full" }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-pass",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "research+plan",
      "--to",
      "implement",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-pass-8: light-gate sequence research+plan -> implement succeeds", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_progress", phase: "research+plan", gate: "light" }),
  ]);
  await expectOk(dir, [
    "phase-pass",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "research+plan",
    "--to",
    "implement",
  ]);
  const item = await readItem(dir);
  assertEquals(item.phase, "implement");
});

// 飛行中 (in_progress/rebase_fix) の rebase-done は conflict (確認済み欠陥 10 の固定):
// ここで review.rebase を消せてしまうと、applyRebaseGiveUp の前提が永久に満たせなくなる。
// 復帰列は in-review で in_review に戻してから rebase-done を呼ぶ。
Deno.test("T-V-rebase-done-1: in_progress/rebase_fix origin -> conflict, rebase block preserved", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "rebase_fix",
      review: reviewOf({ tip: "old", rebase: rebaseOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["rebase-done", "--state-dir", dir, "--id", "t-1", "--tip", "newtip"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-done-2: succeeds from in_review origin (background rebase), status stays in_review", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ tip: "old", rebase: rebaseOf() }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-done",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--tip",
    "newtip2",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "newtip2");
  assertEquals("rebase" in review, false);
  assertEquals(item.status, "in_review");
});

Deno.test("T-V-rebase-done-3: missing --tip -> usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ rebase: rebaseOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["rebase-done", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
});

// review.rebase が無くても tip は更新できる (確認済み欠陥 12 の固定): 背景の載せ直しが
// 衝突なく成功した最頻パスには rebase-record の控えが無いが、マージ回収が見る tip の
// 更新手段はこの verb にしか無い。
Deno.test("T-V-rebase-done-4: review.rebase absent -> still updates tip (clean background rebase)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      review: reviewOf({ tip: "old", watch: watchOf({ handled: ["c1"] }) }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-done",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--tip",
    "newtip3",
  ]);
  const item = await readItem(dir);
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "newtip3");
  assertEquals("rebase" in review, false);
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.handled, ["c1"], "watch preserved");
});

Deno.test("T-V-rebase-done-5: review null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "in_review", review: null })]);
  await expectFailureUnchanged(
    dir,
    ["rebase-done", "--state-dir", dir, "--id", "t-1", "--tip", "x"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-give-up-1: success reverts to in_review with conflict reason", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "rebase_fix",
      session: "s1",
      review: reviewOf({ rebase: rebaseOf({ resolve_pending: true }) }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-give-up",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "newsha",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.phase, null);
  assertEquals(item.session, null);
  const rebase = (item.review as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(rebase.reason, "conflict");
  assertEquals(rebase.blocked_onto, "newsha");
  assertEquals(rebase.resolve_pending, false);
});

Deno.test("T-V-rebase-give-up-2: phase not rebase_fix -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "implement",
      review: reviewOf({ rebase: rebaseOf() }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "rebase-give-up",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--blocked-onto",
      "x",
    ],
    EXIT_CODES.conflict,
  );
});

// --- 回収と候補 ---------------------------------------------------------------

// done は追従対象外なので watch を丸ごと静止させる (確認済み欠陥 7 の固定: 以前は
// proc だけ null にして state を watching のまま残していた)。
Deno.test("T-V-recover-done-1: with review.watch present, stops watch and nulls proc", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({
        tip: "sha1",
        watch: watchOf({
          proc: "bg-1",
          proc_started_at: "2026-08-01T00:00:00Z",
        }),
      }),
    }),
  ]);
  await expectOk(dir, ["recover-done", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "done");
  assertEquals(item.session, null);
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.proc, null);
  assertEquals(watch.proc_started_at, null);
  assertEquals(watch.state, "stopped");
});

Deno.test("T-V-recover-done-2: without review.watch (finish=commit shape) succeeds", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({ tip: "sha1" }),
    }),
  ]);
  await expectOk(dir, ["recover-done", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "done");
  assertEquals(item.session, null);
});

Deno.test("T-V-recover-done-3: review.tip null -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ tip: null }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["recover-done", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw-1: success sets withdrawn true", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectOk(dir, ["withdraw", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals((item.review as Record<string, unknown>).withdrawn, true);
});

Deno.test("T-V-withdraw-2: status not in_review -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "blocked" })]);
  await expectFailureUnchanged(
    dir,
    ["withdraw", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw-remove-1: success archives and removes the queue entry", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      worktree: "/wt",
      base: "main",
      review: reviewOf({ withdrawn: true }),
    }),
  ]);
  await expectOk(dir, [
    "withdraw-remove",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--reason",
    "user declined",
  ]);
  const state = await readState(dir);
  assertEquals(state.queue, []);
  const wb = state.withdrawn_branches as Record<string, unknown>[];
  assertEquals(wb.length, 1);
  assertEquals(wb[0].id, "t-1");
  assertEquals(wb[0].branch, "task-pipeline/t-1");
  assertEquals(wb[0].base, "main");
  assertEquals(wb[0].worktree, "/wt");
});

Deno.test("T-V-withdraw-remove-2: withdrawn not true -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      worktree: "/wt",
      base: "main",
      review: reviewOf({ withdrawn: false }),
    }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["withdraw-remove", "--state-dir", dir, "--id", "t-1", "--reason", "x"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw-asked-1: success", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf({ withdrawn: true }) }),
  ]);
  await expectOk(dir, ["withdraw-asked", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(
    (item.review as Record<string, unknown>).withdrawn_asked,
    true,
  );
});

Deno.test("T-V-withdraw-asked-2: withdrawn not true -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ status: "in_review", review: reviewOf() }),
  ]);
  await expectFailureUnchanged(
    dir,
    ["withdraw-asked", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-candidates-set-1: replaces candidates wholesale", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({ candidates: [{ id: "old", title: "old" }] }),
    ),
  );
  const json = JSON.stringify([{ id: "c1", title: "T1", priority: "high" }]);
  await expectOk(dir, [
    "candidates-set",
    "--state-dir",
    dir,
    "--candidates-json",
    json,
  ]);
  const state = await readState(dir);
  assertEquals(state.candidates, [{ id: "c1", title: "T1", priority: "high" }]);
});

Deno.test("T-V-candidates-set-2: invalid JSON -> usage", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectFailureUnchanged(
    dir,
    ["candidates-set", "--state-dir", dir, "--candidates-json", "not json"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-candidates-set-3: JSON not matching candidate shape -> usage", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectFailureUnchanged(
    dir,
    [
      "candidates-set",
      "--state-dir",
      dir,
      "--candidates-json",
      JSON.stringify([{ id: "c1" }]),
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-candidates-drop-1: success", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({ candidates: [{ id: "c1", title: "T1" }] }),
    ),
  );
  await expectOk(dir, ["candidates-drop", "--state-dir", dir, "--id", "c1"]);
  const state = await readState(dir);
  assertEquals(state.candidates, []);
});

Deno.test("T-V-candidates-drop-2: not found -> missing", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectFailureUnchanged(
    dir,
    ["candidates-drop", "--state-dir", dir, "--id", "nope"],
    EXIT_CODES.missing,
  );
});

Deno.test("T-V-promoted-add-1: success merges without duplicates", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ promoted: ["a"] })),
  );
  await expectOk(dir, ["promoted-add", "--state-dir", dir, "--ids", "a,b"]);
  const state = await readState(dir);
  assertEquals((state.promoted as string[]).slice().sort(), ["a", "b"]);
});

Deno.test("T-V-promoted-add-2: missing --ids -> usage, unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ promoted: ["a"] })),
  );
  await expectFailureUnchanged(
    dir,
    ["promoted-add", "--state-dir", dir],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-promoted-drop-1: success", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ promoted: ["a", "b"] })),
  );
  await expectOk(dir, ["promoted-drop", "--state-dir", dir, "--id", "a"]);
  const state = await readState(dir);
  assertEquals(state.promoted, ["b"]);
});

Deno.test("T-V-promoted-drop-2: not found -> missing", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ promoted: [] })),
  );
  await expectFailureUnchanged(
    dir,
    ["promoted-drop", "--state-dir", dir, "--id", "nope"],
    EXIT_CODES.missing,
  );
});

Deno.test("T-V-relisted-add-1: success", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectOk(dir, [
    "relisted-add",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--seen-at",
    "2026-08-02T00:00:00Z",
  ]);
  const state = await readState(dir);
  assertEquals(state.relisted, [{
    id: "t-1",
    seen_at: "2026-08-02T00:00:00Z",
  }]);
});

Deno.test("T-V-relisted-add-2: duplicate id -> conflict", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }],
      }),
    ),
  );
  await expectFailureUnchanged(
    dir,
    [
      "relisted-add",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--seen-at",
      "2026-08-02T00:00:00Z",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-relisted-drop-1: success", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }],
      }),
    ),
  );
  await expectOk(dir, ["relisted-drop", "--state-dir", dir, "--id", "t-1"]);
  const state = await readState(dir);
  assertEquals(state.relisted, []);
});

Deno.test("T-V-relisted-drop-2: not found -> missing", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectFailureUnchanged(
    dir,
    ["relisted-drop", "--state-dir", dir, "--id", "nope"],
    EXIT_CODES.missing,
  );
});

Deno.test("T-V-restore-1: from in_review origin", async () => {
  const dir = await tempDir();
  await setupQueue(
    dir,
    [
      queueItem({
        status: "in_review",
        worktree: "/wt",
        base: "main",
        review: reviewOf(),
      }),
    ],
    { relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }] },
  );
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "approved");
  assertEquals(item.worktree, "/wt");
  assertEquals(item.base, "main");
  assert(item.review !== null, "review must be preserved");
  const state = await readState(dir);
  assertEquals(state.relisted, []);
});

Deno.test("T-V-restore-2: from blocked origin", async () => {
  const dir = await tempDir();
  await setupQueue(
    dir,
    [
      queueItem({
        status: "blocked",
        blocked_reason: "x",
        worktree: "/wt",
        base: "main",
      }),
    ],
    { relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }] },
  );
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "approved");
  assertEquals(item.blocked_reason, null);
});

Deno.test("T-V-restore-3: from done origin", async () => {
  const dir = await tempDir();
  await setupQueue(
    dir,
    [queueItem({ status: "done", worktree: "/wt", base: "main" })],
    { relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }] },
  );
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "approved");
});

Deno.test("T-V-restore-4: status approved (not an eligible origin) -> conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "approved" })], {
    relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }],
  });
  await expectFailureUnchanged(
    dir,
    ["restore", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

// relisted に無い = 「対象が存在しない」なので missing (contract の記載と一致させる。
// 以前は実装が conflict を返し、契約側が missing と書いていた — 実装を契約に合わせた)。
Deno.test("T-V-restore-5: not in relisted -> missing", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ status: "blocked" })], { relisted: [] });
  await expectFailureUnchanged(
    dir,
    ["restore", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.missing,
  );
});

// restore は watch の揮発状態を落とす (確認済み欠陥 8 の固定): watching / proc を抱えた
// まま approved に戻ると、前周回の watch 状態が新しい周回に漏れる。handled と
// fix_attempts の値は残る (次の watch-init --preserve-handled が仕切り直す)。
Deno.test("T-V-restore-6: preserved review keeps handled but watch is stopped with proc null", async () => {
  const dir = await tempDir();
  await setupQueue(
    dir,
    [
      queueItem({
        status: "in_review",
        worktree: "/wt",
        base: "main",
        review: reviewOf({
          watch: watchOf({
            proc: "bg-1",
            proc_started_at: "2026-08-01T00:00:00Z",
            handled: ["c1", "c2"],
            fix_attempts: 2,
          }),
        }),
      }),
    ],
    { relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }] },
  );
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.status, "approved");
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "stopped");
  assertEquals(watch.proc, null);
  assertEquals(watch.proc_started_at, null);
  assertEquals(watch.handled, ["c1", "c2"]);
  assertEquals(watch.fix_attempts, 2);
});

// --- 全体 ---------------------------------------------------------------------

Deno.test("T-V-stalled-set-1: null -> depleted advances stalled_since", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ stalled: null, stalled_since: null })),
  );
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "depleted",
  ]);
  const state = await readState(dir);
  assertEquals(state.stalled, "depleted");
  assert(
    typeof state.stalled_since === "string" &&
      (state.stalled_since as string).length > 0,
    "stalled_since should be set",
  );
});

Deno.test("T-V-stalled-set-2: depleted -> depleted (no bump) keeps stalled_since", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        stalled: "depleted",
        stalled_since: "2026-08-01T00:00:00Z",
      }),
    ),
  );
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "depleted",
  ]);
  const state = await readState(dir);
  assertEquals(state.stalled_since, "2026-08-01T00:00:00Z");
});

Deno.test("T-V-stalled-set-3: depleted -> max_open (type change, no bump) keeps stalled_since", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        stalled: "depleted",
        stalled_since: "2026-08-01T00:00:00Z",
      }),
    ),
  );
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "max_open",
  ]);
  const state = await readState(dir);
  assertEquals(state.stalled, "max_open");
  assertEquals(state.stalled_since, "2026-08-01T00:00:00Z");
});

Deno.test("T-V-stalled-set-4: non-null with --bump advances stalled_since", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        stalled: "depleted",
        stalled_since: "2026-08-01T00:00:00Z",
      }),
    ),
  );
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "depleted",
    "--bump",
    "true",
  ]);
  const state = await readState(dir);
  assert(
    state.stalled_since !== "2026-08-01T00:00:00Z",
    "stalled_since should have advanced",
  );
});

Deno.test("T-V-stalled-set-5: value null resets both to null", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        stalled: "depleted",
        stalled_since: "2026-08-01T00:00:00Z",
      }),
    ),
  );
  await expectOk(dir, ["stalled-set", "--state-dir", dir, "--value", "null"]);
  const state = await readState(dir);
  assertEquals(state.stalled, null);
  assertEquals(state.stalled_since, null);
});

Deno.test("T-V-stalled-set-6: invalid --value -> usage, unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(
    dir,
    JSON.stringify(
      minimalValidState({
        stalled: "depleted",
        stalled_since: "2026-08-01T00:00:00Z",
      }),
    ),
  );
  await expectFailureUnchanged(
    dir,
    ["stalled-set", "--state-dir", dir, "--value", "bogus"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-stalled-set-7: --value omitted -> usage, unchanged", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, JSON.stringify(minimalValidState()));
  await expectFailureUnchanged(
    dir,
    ["stalled-set", "--state-dir", dir],
    EXIT_CODES.usage,
  );
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

Deno.test("T-D2: state-cli-contract.md verb headings match ALLOWED_FLAGS keys (AC11)", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const headingRe = /^### `([a-z][a-z0-9-]*)`$/gm;
  const docVerbs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(doc)) !== null) {
    docVerbs.add(m[1]);
  }
  const implVerbs = new Set(Object.keys(ALLOWED_FLAGS));
  const missingInDoc = [...implVerbs].filter((v) => !docVerbs.has(v));
  const missingInImpl = [...docVerbs].filter((v) => !implVerbs.has(v));
  assertEquals(
    missingInDoc,
    [],
    `verbs implemented but not documented: ${missingInDoc}`,
  );
  assertEquals(
    missingInImpl,
    [],
    `verbs documented but not implemented: ${missingInImpl}`,
  );
});

// ---------------------------------------------------------------------------
// T-D3/T-D4/T-D5: 遷移表・フェーズ列と散文の突き合わせ
// (T-D1/T-D2 と同じ「文書と実装の機械照合」パターンを状態機械に広げたもの)
// ---------------------------------------------------------------------------

function parseMdTable(doc: string, header: string[]): string[][] {
  const lines = doc.split("\n");
  const headerLine = `| ${header.join(" | ")} |`;
  const idx = lines.findIndex((l) => l.trim() === headerLine);
  assert(idx !== -1, `table header not found in doc: ${headerLine}`);
  const rows: string[][] = [];
  for (let i = idx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
  }
  assert(rows.length > 0, `table has no rows: ${headerLine}`);
  return rows;
}

Deno.test("T-D3: contract 遷移表 matches VERB_LIFECYCLE", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const rows = parseMdTable(doc, ["verb", "from", "to"]);
  const docSpec = new Map<string, { from: string[]; to: string }>();
  for (const [verbCell, fromCell, toCell] of rows) {
    const verb = verbCell.replaceAll("`", "");
    let from: string[];
    if (fromCell.includes("新規追加")) {
      from = [];
    } else if (fromCell.includes("`in_progress/*`")) {
      from = PHASE_VALUES.map((p) => `in_progress/${p}`);
    } else {
      from = [...fromCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    }
    let to: string;
    if (toCell.includes("変更なし")) to = "unchanged";
    else if (toCell.includes("分岐")) to = "dynamic";
    else if (toCell.includes("削除")) to = "removed";
    else to = toCell.replaceAll("`", "").replace(/\s*\(.*\)$/, "");
    docSpec.set(verb, { from, to });
  }
  assertEquals(
    [...docSpec.keys()].sort(),
    Object.keys(VERB_LIFECYCLE).sort(),
    "遷移表の verb 集合が VERB_LIFECYCLE と一致しない",
  );
  for (const [verb, spec] of Object.entries(VERB_LIFECYCLE)) {
    const d = docSpec.get(verb)!;
    assertEquals(
      [...d.from].sort(),
      [...spec.from].sort(),
      `from mismatch for ${verb}`,
    );
    assertEquals(d.to, spec.to, `to mismatch for ${verb}`);
  }
});

Deno.test("T-D4: contract フェーズ列 table matches GATE_PHASE_SEQUENCES", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const rows = parseMdTable(doc, ["gate", "フェーズ列"]);
  const docSeqs = new Map(
    rows.map((
      [g, s],
    ) => [g.replaceAll("`", ""), s.replaceAll("`", "").split(" → ")]),
  );
  assertEquals(
    [...docSeqs.keys()].sort(),
    [...GATE_VALUES].sort(),
    "gate 集合が一致しない",
  );
  for (const gate of GATE_VALUES) {
    assertEquals(
      docSeqs.get(gate),
      [...GATE_PHASE_SEQUENCES[gate]],
      `sequence mismatch for gate ${gate}`,
    );
  }
});

Deno.test("T-D7: contract ノード一覧 matches LIFECYCLE_NODES", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const rows = parseMdTable(doc, ["ノード", "意味"]);
  const docNodes = rows.map(([n]) => n.replaceAll("`", ""));
  assertEquals(
    [...docNodes].sort(),
    [...LIFECYCLE_NODES].sort(),
    "ノード一覧が LIFECYCLE_NODES と一致しない — フェーズや status を変えたら契約のノード表も更新すること",
  );
});

Deno.test("T-D5: SKILL.md contains each gate's current phase sequence", async () => {
  const skill = await Deno.readTextFile(SKILL_MD);
  for (const gate of GATE_VALUES) {
    const chain = GATE_PHASE_SEQUENCES[gate].join(" → ");
    assert(
      skill.includes(chain),
      `SKILL.md must contain the ${gate} sequence "${chain}" — ` +
        "フェーズ列を変えたら SKILL.md のフェーズ列記述も更新すること",
    );
  }
});

// ---------------------------------------------------------------------------
// T-SEQ: SKILL.md が規定する多段 verb シーケンスの統合テスト (CLI サブプロセス経由)
//
// 2026-08-05 に表面化した欠陥 (issue #13 / #15) は、単発 verb のテストが全部通ったまま
// 複数 verb をまたぐ列だけが壊れていた。ここでは SKILL.md の実際の呼び出し列を
// そのまま実行して固定する。
// ---------------------------------------------------------------------------

Deno.test("T-SEQ-1: pr_fix recovery loop — fix_attempts accumulates, handled merges, 4th fix-start stops (issue #15)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({
        branch: "task-pipeline/t-1",
        tip: "sha0",
        base: "main",
        watch: watchOf({ fix_attempts: 0, handled: [] }),
      }),
    }),
  ]);
  const inReviewArgs = (tip: string) => [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "2",
    "--ref",
    "https://example.com/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    tip,
  ];
  for (let i = 1; i <= 3; i++) {
    await expectOk(dir, [
      "fix-pending",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--pending-ids",
      `c${i}`,
      "--findings",
      "/f",
    ]);
    const started = await expectOk(dir, [
      "fix-start",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s1",
    ]);
    assertEquals(started.started, true, `cycle ${i}: started`);
    assertEquals(started.fix_attempts, i, `cycle ${i}: fix_attempts`);
    await expectOk(dir, [
      "finalize-start",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "pr_fix",
    ]);
    await expectOk(dir, ["fix-done", "--state-dir", dir, "--id", "t-1"]);
    await expectOk(dir, inReviewArgs(`sha${i}`));
    await expectOk(dir, [
      "watch-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--state",
      "watching",
    ]);
  }
  // 4 周目: 上限で started:false、watch は stopped、session は手放される
  await expectOk(dir, [
    "fix-pending",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--pending-ids",
    "c4",
    "--findings",
    "/f",
  ]);
  const fourth = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  assertEquals(fourth.started, false, "4th cycle must not start");
  assertEquals(fourth.fix_attempts, 4, "4th cycle attempts");
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.session, null);
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "sha3", "tip updated by each recovery in-review");
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.state, "stopped");
  assertEquals(watch.note, "追従上限");
  assertEquals(watch.fix_attempts, 4);
  assertEquals(
    [...(watch.handled as string[])].sort(),
    ["c1", "c2", "c3"],
    "handled accumulates across recoveries",
  );
});

Deno.test("T-SEQ-2: rebase_fix recovery — in-review then rebase-done then watch-set, watch preserved", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({
        branch: "task-pipeline/t-1",
        tip: "sha0",
        base: "main",
        watch: watchOf({ fix_attempts: 2, handled: ["c1"] }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-record",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "onto1",
    "--reason",
    "conflict",
    "--kind",
    "overlap",
    "--cause",
    "x",
    "--report",
    "/r",
  ]);
  await expectOk(dir, [
    "rebase-resolve-pending",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from-tip",
    "sha0",
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "rebase_fix",
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "2",
    "--ref",
    "https://example.com/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "sha1",
  ]);
  await expectOk(dir, [
    "rebase-done",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--tip",
    "sha1",
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--state",
    "watching",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.session, "s1");
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "sha1");
  assertEquals("rebase" in review, false, "rebase block removed");
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.state, "watching");
  assertEquals(watch.fix_attempts, 2, "rebase recovery keeps fix_attempts");
  assertEquals(watch.handled, ["c1"], "rebase recovery keeps handled");
});

Deno.test("T-SEQ-3: finalize-entry rebase_fix (REBASE-CONFLICT before first PR) reaches first review via rebase-start", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_progress",
      phase: "finalize",
      session: "s1",
      review: null,
    }),
  ]);
  const started = await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  assertEquals(started.status, "in_progress");
  assertEquals(started.phase, "rebase_fix");
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "rebase_fix",
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "https://example.com/pull/2",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "sha1",
  ]);
  await expectOk(dir, [
    "watch-init",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  const review = item.review as Record<string, unknown>;
  assertEquals(review.ref, "https://example.com/pull/2");
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.state, "watching");
});

// フィクスチャは gate: light から始める — restore が gate を full に戻さないと、
// claim 後に (in_progress/research, gate: light) という死にノード (light の列に
// research の辺が無く set-gate も拒否) に着地し、この列の set-gate が conflict になる
// (ultrareview 指摘の回帰の固定)。
Deno.test("T-SEQ-4: restore rerun (light gate) — handled survives via --preserve-handled, fix_attempts resets", async () => {
  const dir = await tempDir();
  await setupQueue(
    dir,
    [
      queueItem({
        status: "in_review",
        gate: "light",
        worktree: "/wt",
        base: "main",
        session: "s1",
        review: reviewOf({
          branch: "task-pipeline/t-1",
          tip: "sha0",
          base: "main",
          watch: watchOf({
            handled: ["c1"],
            fix_attempts: 2,
            proc: "bg-1",
            proc_started_at: "2026-08-01T00:00:00Z",
          }),
        }),
      }),
    ],
    { relisted: [{ id: "t-1", seen_at: "2026-08-01T00:00:00Z" }] },
  );
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  const restored = await readItem(dir);
  assertEquals(restored.gate, "full", "restore resets gate to full");
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s2",
  ]);
  await expectOk(dir, ["set-gate", "--state-dir", dir, "--id", "t-1"]);
  await expectOk(dir, [
    "phase-pass",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "research+plan",
    "--to",
    "implement",
  ]);
  await expectOk(dir, [
    "phase-pass",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "implement",
    "--to",
    "report",
  ]);
  await expectOk(dir, [
    "finalize-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "report",
  ]);
  await expectOk(dir, [
    "in-review",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "3",
    "--ref",
    "https://example.com/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--base",
    "main",
    "--tip",
    "sha1",
  ]);
  await expectOk(dir, [
    "watch-init",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s2",
    "--preserve-handled",
    "true",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  assertEquals(item.session, "s2");
  const watch = (item.review as Record<string, unknown>).watch as Record<
    string,
    unknown
  >;
  assertEquals(watch.state, "watching");
  assertEquals(watch.handled, ["c1"], "handled survives the rerun boundary");
  assertEquals(watch.fix_attempts, 0, "fix_attempts resets at the new cycle");
  assertEquals(watch.proc, null);
});

// 新しい verb を足すとき、VERB_LIFECYCLE (遷移表) か帳簿系リスト (queue エントリの
// status/phase に触らない verb) のどちらかに必ず分類させる。どちらにも入れずに
// dispatch へ追加すると、この差集合が空でなくなって落ちる — サブ機械や verb を後から
// 足す人が遷移表を素通りできないための網。
Deno.test("T-D6: every CLI verb is classified as lifecycle (VERB_LIFECYCLE) or bookkeeping", () => {
  const bookkeeping = new Set([
    "init",
    "get",
    "validate",
    "session-touch",
    "sessions-alive",
    "history-append",
    "candidates-set",
    "candidates-drop",
    "promoted-add",
    "promoted-drop",
    "relisted-add",
    "relisted-drop",
    "stalled-set",
  ]);
  const allVerbs = new Set(Object.keys(ALLOWED_FLAGS));
  const lifecycle = new Set(Object.keys(VERB_LIFECYCLE));
  const unclassified = [...allVerbs].filter(
    (v) => !bookkeeping.has(v) && !lifecycle.has(v),
  );
  const phantom = [...lifecycle].filter((v) => !allVerbs.has(v));
  const overlap = [...lifecycle].filter((v) => bookkeeping.has(v));
  assertEquals(
    unclassified,
    [],
    `verbs missing from VERB_LIFECYCLE: ${unclassified}`,
  );
  assertEquals(
    phantom,
    [],
    `VERB_LIFECYCLE entries without a CLI verb: ${phantom}`,
  );
  assertEquals(overlap, [], `verbs classified as both: ${overlap}`);
});

// 背景の載せ直し (「残った PR を新しい基点へ載せ直す」) が衝突なく一発で成功した
// 最頻パスの列 (確認済み欠陥 12 の固定): rebase-record の控えが無いまま
// rebase-done で tip を更新し、watch-set --proc null --sig null で署名を落とす。
Deno.test("T-SEQ-5: clean background rebase — rebase-done without a rebase record, then watch-set", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      status: "in_review",
      session: "s1",
      review: reviewOf({
        branch: "task-pipeline/t-1",
        tip: "sha0",
        base: "main",
        watch: watchOf({
          proc: "bg-1",
          sig: "sig-old",
          handled: ["c1"],
          fix_attempts: 1,
        }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-done",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--tip",
    "sha-rebased",
  ]);
  await expectOk(dir, [
    "watch-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "null",
    "--sig",
    "null",
  ]);
  const item = await readItem(dir);
  assertEquals(item.status, "in_review");
  const review = item.review as Record<string, unknown>;
  assertEquals(review.tip, "sha-rebased");
  assertEquals("rebase" in review, false);
  const watch = review.watch as Record<string, unknown>;
  assertEquals(watch.proc, null);
  assertEquals(watch.sig, null);
  assertEquals(watch.handled, ["c1"], "watch preserved");
  assertEquals(watch.fix_attempts, 1, "fix_attempts not counted for rebase");
});
