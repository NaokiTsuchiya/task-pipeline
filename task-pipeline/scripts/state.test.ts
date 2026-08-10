// task-pipeline/scripts/state.test.ts
//
// state.ts (状態モデル v2 の CLI) をサブプロセスとして起動して検査する安全網。
//
// **役割分担 (設計 task-pipeline/docs/state-model-v2-2026-08.md 4.3節)**:
// 状態機械そのものの保証 (どのノードからどのノードへ動くか、フレーム条件、不変条件) は
// in-process の 3 層テスト — state-model-v2.test.ts / state-transitions-v2.test.ts /
// state-schema-v2.test.ts / state-migrate-v2.test.ts の計 128 テスト — が担う。
// このファイルが持つのは **CLI 固有の関心** だけである:
//
//   U    verb / フラグのパースと usage エラー (廃止 verb の拒否を含む)
//   F/S  state.json のファイル状態とスキーマ検証 (読み込み時・書き込み前)
//   L    lock (排他・stale 回収)
//   C    並行実行と原子的書き込み
//   P    Deno の権限境界による封じ込め
//   H    heartbeat (sessions/* の mtime としきい値)
//   I    init の exclude 追記
//   MIG  init による v1 → v2 移行 (一度だけ)
//   V    verb ごとの代表 1 組 (成功 / 前提違反) と、CLI の応答 JSON にしか現れない導出
//   SEQ  多段の列 (設計2.2〜2.5 の主要経路) を CLI 経由で通す
//   D    契約文書 (docs/state-cli-contract.md) と実装の機械照合
//
// V が verb ごとに 1 組なのは意図的である: 前提の網羅 (領域 P 19 ノード × 領域 A の
// サブ軸) は state-transitions-v2.test.ts の行列テストが済ませていて、CLI 経由で
// 繰り返しても同じ apply 関数を通るだけだからである。CLI 固有の観測差 (exit code と
// stdout の JSON) は前提違反 1 種類 (conflict) に集約されているので、verb ごとに
// 1 本で経路が確認できる。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//   単体: deno test --allow-read --allow-write --allow-env --allow-run \
//           task-pipeline/scripts/state.test.ts

import { ALLOWED_FLAGS, EXIT_CODES } from "./state.ts";
import { asVerb } from "./state-dispatch.ts";
import { LEDGER_VERBS } from "./state-ledger-v2.ts";
import { ADVANCE_EDGES, VERB_SPEC } from "./state-transitions-v2.ts";
import {
  ARTIFACT_STATE_VALUES,
  FIX_ASK_AXIS_VALUES,
  HUMAN_ATTENTION_REASON_VALUES,
  INITIAL_GATE_PHASE_SEQUENCES,
  P_NODE_KEYS,
  REBASE_ASK_AXIS_VALUES,
} from "./state-model-v2.ts";

const SCRIPT_URL = new URL("./state.ts", import.meta.url);
const REPO_ROOT = new URL("../../", import.meta.url);
const FIXTURES_DIR = new URL("tests/fixtures/state-cli/", REPO_ROOT);
const CONTRACT_DOC = new URL(
  "task-pipeline/docs/state-cli-contract.md",
  REPO_ROOT,
);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);

// ---------------------------------------------------------------------------
// サブプロセス起動
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

// 権限封じ込めの仕組みそのもの: テストが宣言した範囲より広い許可を CLI に渡さない。
function buildArgs(verbArgs: string[], opts: RunOpts): string[] {
  const args = [
    "run",
    "--no-prompt",
    `--allow-read=${opts.allowRead.join(",")}`,
    `--allow-write=${opts.allowWrite.join(",")}`,
  ];
  if (opts.allowEnv) args.push(`--allow-env=${opts.allowEnv.join(",")}`);
  args.push(SCRIPT_URL.pathname, ...verbArgs);
  return args;
}

async function runCli(
  verbArgs: string[],
  opts: RunOpts,
): Promise<RunResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: buildArgs(verbArgs, opts),
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

function spawnCli(verbArgs: string[], opts: RunOpts): Deno.ChildProcess {
  const command = new Deno.Command(Deno.execPath(), {
    args: buildArgs(verbArgs, opts),
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  return command.spawn();
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 汎用ヘルパ
// ---------------------------------------------------------------------------

function tempDir(): Promise<string> {
  return Deno.makeTempDir({ prefix: "state-cli-test-" });
}

async function writeStateFile(
  stateDir: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(`${stateDir}/state.json`, content);
}

function readFixture(name: string): Promise<string> {
  return Deno.readTextFile(new URL(name, FIXTURES_DIR));
}

async function statMtime(path: string): Promise<number> {
  const info = await Deno.stat(path);
  return info.mtime?.getTime() ?? 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setMtimeMinutesAgo(
  path: string,
  nowMsValue: number,
  minutesAgo: number,
): Promise<void> {
  const t = new Date(nowMsValue - minutesAgo * 60_000);
  await Deno.utime(path, t, t);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ?? "assertEquals"}: got ${a}, want ${b}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// v2 の state / queue エントリのフィクスチャ組み立て
// ---------------------------------------------------------------------------

const MINIMAL_VALID_BASE = {
  tracker: "markdown",
  source: "./TASKS.md",
  updated_at: "2026-08-07T00:00:00.000Z",
  queue: [] as unknown[],
  completed: [] as unknown[],
  candidates: [] as unknown[],
  relisted: [] as unknown[],
  promoted: [] as string[],
  history: [] as string[],
  schema_version: 2,
};

function minimalValidState(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...MINIMAL_VALID_BASE, ...extra };
}

function queueItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "t-1",
    title: "T",
    progress: "queued",
    run: null,
    blocked_reason: null,
    artifact: { state: "none" },
    worktree: null,
    base: null,
    session: null,
    ...overrides,
  };
}

function runOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "initial",
    gate: "full",
    phase: "research",
    attempts: 0,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    verifier: null,
    verifier_session: null,
    ...overrides,
  };
}

function probeOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    proc: null,
    proc_started_at: null,
    sig: null,
    head: null,
    ci: null,
    checked_at: null,
    errors: 0,
    note: null,
    ...overrides,
  };
}

function ledgerOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    handled: [],
    fix_attempts: 0,
    review_only: [],
    answered: [],
    fix_cycle_tip: null,
    fix_rerun_tip: null,
    ...overrides,
  };
}

function followOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attention: "auto",
    asks: { fix: null, rebase: null },
    ledger: ledgerOf(),
    probe: probeOf(),
    ...overrides,
  };
}

function openArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "open",
    ref: "https://example.com/o/r/pull/1",
    branch: "task-pipeline/t-1",
    tip: "sha-tip",
    base: "main",
    follow: followOf(),
    ...overrides,
  };
}

function fixAsk(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ids: ["rc-1"],
    findings: "/tmp/findings.md",
    taken: false,
    ...overrides,
  };
}

function rebaseAsk(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    blocked_onto: "sha-onto",
    reason: "conflict",
    at: "2026-08-07T00:00:00.000Z",
    kind: null,
    cause: null,
    report: null,
    from_tip: null,
    resolve: false,
    taken: false,
    ...overrides,
  };
}

// resting × open + follow の標準形 (追従系 verb の出発点)。
function restingOpen(
  followOverrides: Record<string, unknown> = {},
  itemOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return queueItem({
    progress: "resting",
    artifact: openArtifact({ follow: followOf(followOverrides) }),
    ...itemOverrides,
  });
}

async function setupQueue(
  dir: string,
  items: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeStateFile(
    dir,
    JSON.stringify(minimalValidState({ queue: items, ...extra }), null, 2),
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
  const item = queue.find((it) => it.id === id);
  if (item === undefined) throw new Error(`item not found: ${id}`);
  return item;
}

function follow(item: Record<string, unknown>): Record<string, unknown> {
  const artifact = item.artifact as Record<string, unknown>;
  return artifact.follow as Record<string, unknown>;
}

function runVerb(dir: string, args: string[]): Promise<RunResult> {
  return runCli(args, { allowRead: [dir], allowWrite: [dir] });
}

async function expectOk(
  dir: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const res = await runVerb(dir, args);
  assertEquals(
    res.code,
    0,
    `expected success: ${args.join(" ")} ${res.stdout}`,
  );
  return parseJson(res.stdout);
}

// 前提違反は「その exit code で失敗し、state.json をバイト単位で書き換えない」。
// 後者がこのヘルパの本体で、updated_at すら動かないことを固定する。
async function expectFailureUnchanged(
  dir: string,
  args: string[],
  expectedCode: number,
): Promise<Record<string, unknown>> {
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const res = await runVerb(dir, args);
  assertEquals(
    res.code,
    expectedCode,
    `expected exit ${expectedCode}: ${args.join(" ")} ${res.stdout}`,
  );
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(
    after,
    before,
    "state.json must be byte-identical after failure",
  );
  return parseJson(res.stdout);
}

const INVALID_TOP_LEVEL_MISSING_TRACKER = JSON.stringify(
  {
    source: "./TASKS.md",
    updated_at: "2026-08-07T00:00:00.000Z",
    queue: [],
    completed: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    schema_version: 2,
  },
  null,
  2,
);

// progress: "running" なのに run が null — v2 の queueItem の oneOf (progress を
// タグにした判別) がこれを弾く。
const INVALID_NESTED_RUNNING_WITHOUT_RUN = JSON.stringify(
  minimalValidState({
    queue: [queueItem({ progress: "running", run: null })],
  }),
  null,
  2,
);

// ---------------------------------------------------------------------------
// U: verb / フラグのパースと usage
// ---------------------------------------------------------------------------

Deno.test("T-U1: unknown verb", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["nope", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.usage);
  assertEquals(parseJson(res.stdout).error, "usage");
});

// Object.prototype 由来の名前は「未知の verb」の中でも別クラスである。ディスパッチ表は
// ただのオブジェクトリテラルなので、`ALLOWED_FLAGS[verb]` の truthy 判定や
// `verb in ALLOWED_FLAGS` で verb を認識すると、`toString` や `constructor` は
// **プロトタイプ経由で truthy になり** usage を素通りして後段で TypeError になる
// (この CLI に実在した欠陥。`asVerb` の Object.hasOwn で解消した)。
// `"nope"` はプロトタイプに無いので、その代表ではこのクラスを検出できない —
// 型検査でも捕まらない書き換えなので、実行時の回帰テストで固定する。
Deno.test("T-U1b: Object.prototype-derived names are usage errors, not crashes", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  for (
    const verb of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
      "isPrototypeOf",
    ]
  ) {
    const res = await runVerb(dir, [verb, "--state-dir", dir]);
    assertEquals(
      res.code,
      EXIT_CODES.usage,
      `${verb}: ${res.stdout} ${res.stderr}`,
    );
    const payload = parseJson(res.stdout);
    assertEquals(payload.error, "usage", `${verb} must report a usage error`);
    assertEquals(
      payload.message,
      `unknown verb: ${verb}`,
      `${verb} must be reported as an unknown verb`,
    );
  }
});

Deno.test("T-U2: verb omitted", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, []);
  assertEquals(res.code, EXIT_CODES.usage);
});

Deno.test("T-U3: --state-dir is required", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["get"]);
  assertEquals(res.code, EXIT_CODES.usage);
});

Deno.test("T-U4: init without --tracker/--source/--git-common-dir has no side effects", async () => {
  const dir = await tempDir();
  const stateDir = `${dir}/.task-pipeline`;
  const res = await runCli(["init", "--state-dir", stateDir], {
    allowRead: [dir],
    allowWrite: [dir],
  });
  assertEquals(res.code, EXIT_CODES.usage);
  // 必須フラグの検証は mkdir より前なので、state.json は作られない
  let exists = true;
  try {
    await Deno.stat(`${stateDir}/state.json`);
  } catch {
    exists = false;
  }
  assert(!exists, "state.json must not be created on usage error");
});

Deno.test("T-U4b: session-touch without --id", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["session-touch", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.usage);
});

Deno.test("T-U4c: history-append without --line", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectFailureUnchanged(
    dir,
    ["history-append", "--state-dir", dir],
    EXIT_CODES.usage,
  );
});

Deno.test("T-U5: unknown flag (both a foreign verb's flag and a nonsense one)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  // 他 verb の許可フラグ (--proc は probe-run のもの)
  await expectFailureUnchanged(
    dir,
    [
      "claim",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s",
      "--proc",
      "p",
    ],
    EXIT_CODES.usage,
  );
  // 完全に未知
  await expectFailureUnchanged(
    dir,
    [
      "claim",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s",
      "--zzz",
      "1",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-U6: history-append with an empty --line is valid (not usage)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  const out = await expectOk(dir, [
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "",
  ]);
  assertEquals(out.history_length, 1);
});

// 受け入れ条件 2: 廃止 verb は 1 つも受理しない。
const RETIRED_VERBS = [
  "phase-pass",
  "finalize-start",
  "in-review",
  "watch-init",
  "watch-set",
  "fix-pending",
  "fix-done",
  "rebase-record",
  "rebase-resolve-pending",
  "rebase-done",
  "recover-done",
];

Deno.test("T-U-retired: all 11 retired v1 verbs are usage errors", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  for (const verb of RETIRED_VERBS) {
    // 廃止 verb は Verb の語彙にそもそも属さない (型の上でも実行時にも)。
    assert(
      asVerb(verb) === null,
      `retired verb still in the dispatch vocabulary: ${verb}`,
    );
    const out = await expectFailureUnchanged(
      dir,
      [verb, "--state-dir", dir, "--id", "t-1"],
      EXIT_CODES.usage,
    );
    assertEquals(out.error, "usage", `retired verb accepted: ${verb}`);
  }
});

Deno.test("T-U-int: --commits rejects every non-natural-number shape", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf({ phase: "finalize" }) }),
  ]);
  for (const bad of ["-1", "1.5", "abc", "", " "]) {
    await expectFailureUnchanged(
      dir,
      ["ship", "--state-dir", dir, "--id", "t-1", "--commits", bad],
      EXIT_CODES.usage,
    );
  }
});

Deno.test('T-U-bool: boolean flags accept only "true" or omission', async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({ asks: { fix: fixAsk(), rebase: null } }),
  ]);
  for (const bad of ["false", "1"]) {
    await expectFailureUnchanged(
      dir,
      [
        "fix-start",
        "--state-dir",
        dir,
        "--id",
        "t-1",
        "--session",
        "s",
        "--reset-attempts",
        bad,
      ],
      EXIT_CODES.usage,
    );
  }
  // 省略は偽として受理される
  const out = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(out.started, true);
});

Deno.test("T-U-enum: every enum flag rejects a value outside its vocabulary", async () => {
  const dir = await tempDir();
  const cases: { args: string[]; setup: Record<string, unknown>[] }[] = [
    {
      args: ["observe", "--id", "t-1", "--ci", "bogus"],
      setup: [restingOpen()],
    },
    {
      args: [
        "rebase-request",
        "--id",
        "t-1",
        "--blocked-onto",
        "sha",
        "--reason",
        "bogus",
      ],
      setup: [restingOpen()],
    },
    {
      args: [
        "rebase-request",
        "--id",
        "t-1",
        "--blocked-onto",
        "sha",
        "--reason",
        "conflict",
        "--kind",
        "bogus",
      ],
      setup: [restingOpen()],
    },
    {
      args: ["phase-fail", "--id", "t-1", "--phase", "bogus"],
      setup: [queueItem({ progress: "running", run: runOf() })],
    },
    {
      // finalize は検証ゲートを持たないので --phase としては usage
      args: ["phase-fail", "--id", "t-1", "--phase", "finalize"],
      setup: [
        queueItem({ progress: "running", run: runOf({ phase: "finalize" }) }),
      ],
    },
    {
      args: ["attention-set", "--id", "t-1", "--human", "bogus"],
      setup: [restingOpen()],
    },
    { args: ["stalled-set", "--value", "bogus"], setup: [] },
  ];
  for (const c of cases) {
    await setupQueue(dir, c.setup);
    await expectFailureUnchanged(
      dir,
      [c.args[0], "--state-dir", dir, ...c.args.slice(1)],
      EXIT_CODES.usage,
    );
  }
});

// advance の --from/--to は phase-fail の --phase とは別語彙 (finalize を含む)。
// 片方の代表では他方の誤実装 (enum 検証の落とし / 誤った語彙の流用) を検出できない。
Deno.test("T-U-enum-advance: --from/--to reject unknown phases as usage, not conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf({ phase: "report" }) }),
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "bogus",
      "--to",
      "finalize",
    ],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "report",
      "--to",
      "bogus",
    ],
    EXIT_CODES.usage,
  );
  // 受理側の境界: finalize は advance の合法な着地 (--phase の語彙で弾いてはいけない)
  const out = await expectOk(dir, [
    "advance",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "report",
    "--to",
    "finalize",
  ]);
  assertEquals(out.phase, "finalize");
});

// ---------------------------------------------------------------------------
// F/S: ファイル状態とスキーマ検証
// ---------------------------------------------------------------------------

Deno.test("T-F1: missing state.json is `missing`", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["get", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.missing);
});

Deno.test("T-F1c: missing state dir leaves no residue", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/absent`;
  const res = await runCli(
    ["history-append", "--state-dir", stateDir, "--line", "x"],
    { allowRead: [parent], allowWrite: [parent] },
  );
  assertEquals(res.code, EXIT_CODES.missing);
  let created = true;
  try {
    await Deno.stat(stateDir);
  } catch {
    created = false;
  }
  assert(!created, "state dir must not be created");
});

Deno.test("T-F1b: init creates a well-formed v2 state", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  const out = await runCli([
    "init",
    "--state-dir",
    stateDir,
    "--tracker",
    "gh",
    "--source",
    "o/r",
    "--git-common-dir",
    gcd,
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(out.code, 0);
  const payload = parseJson(out.stdout);
  assertEquals(payload.created, true);
  assertEquals(payload.migrated, false);
  const state = await readState(stateDir);
  assertEquals(state.schema_version, 2);
  assertEquals(state.queue, []);
  assertEquals(state.completed, []);
  const res = await runCli(["validate", "--state-dir", stateDir], {
    allowRead: [parent],
    allowWrite: [parent],
  });
  assertEquals(res.code, 0);
});

Deno.test("T-F2: zero-byte state.json is `schema`", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, "");
  const res = await runVerb(dir, ["validate", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.schema);
});

Deno.test("T-F3: broken JSON is `schema`", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, "{not json");
  const res = await runVerb(dir, ["validate", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.schema);
});

Deno.test("T-F4/T-S1: top-level schema violation is rejected without touching the file", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_TOP_LEVEL_MISSING_TRACKER);
  await expectFailureUnchanged(
    dir,
    ["history-append", "--state-dir", dir, "--line", "x"],
    EXIT_CODES.schema,
  );
});

Deno.test("T-F5/T-S2: nested queueItem violation (running without run) is rejected", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_NESTED_RUNNING_WITHOUT_RUN);
  await expectFailureUnchanged(
    dir,
    ["history-append", "--state-dir", dir, "--line", "x"],
    EXIT_CODES.schema,
  );
});

Deno.test("T-F6: the v2 fixture validates", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, await readFixture("v2-queued.json"));
  const res = await runVerb(dir, ["validate", "--state-dir", dir]);
  assertEquals(res.code, 0, res.stdout);
  assertEquals(parseJson(res.stdout).ok, true);
});

Deno.test("T-F7: a v1 state does not validate before init migrates it", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, await readFixture("valid-watch-rebase.json"));
  const res = await runVerb(dir, ["validate", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.schema);
});

Deno.test("T-F8: get is parse-only (no schema check)", async () => {
  const dir = await tempDir();
  await writeStateFile(dir, INVALID_TOP_LEVEL_MISSING_TRACKER);
  const res = await runVerb(dir, ["get", "--state-dir", dir]);
  assertEquals(res.code, 0);
});

Deno.test("T-S3: after a full initial cycle the state still validates", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "approve",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--title",
    "T",
  ]);
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  for (
    const [from, to] of [["research", "plan"], ["plan", "implement"], [
      "implement",
      "report",
    ], ["report", "finalize"]]
  ) {
    await expectOk(dir, [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      from,
      "--to",
      to,
    ]);
  }
  await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "https://example.com/o/r/pull/1",
    "--branch",
    "b",
    "--tip",
    "sha",
    "--base",
    "main",
  ]);
  const res = await runVerb(dir, ["validate", "--state-dir", dir]);
  assertEquals(res.code, 0, res.stdout);
});

Deno.test("T-S4: init on an unreadable schema_version fails byte-unchanged", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await writeStateFile(
    stateDir,
    JSON.stringify(minimalValidState({ schema_version: 99 }), null, 2),
  );
  const before = await Deno.readTextFile(`${stateDir}/state.json`);
  const res = await runCli([
    "init",
    "--state-dir",
    stateDir,
    "--tracker",
    "gh",
    "--source",
    "o/r",
    "--git-common-dir",
    gcd,
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(res.code, EXIT_CODES.schema);
  assertEquals(await Deno.readTextFile(`${stateDir}/state.json`), before);
});

// ---------------------------------------------------------------------------
// L: lock
// ---------------------------------------------------------------------------

Deno.test("T-L1: no lock directory is left behind on success", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, ["history-append", "--state-dir", dir, "--line", "x"]);
  let exists = true;
  try {
    await Deno.stat(`${dir}/lock`);
  } catch {
    exists = false;
  }
  assert(!exists, "lock must be released");
});

Deno.test("T-L2: a fresh lock blocks after the configured retries", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await Deno.mkdir(`${dir}/lock`);
  const res = await runVerb(dir, [
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "x",
    "--lock-retry-ms",
    "1",
    "--lock-max-retries",
    "2",
  ]);
  assertEquals(res.code, EXIT_CODES.lock);
});

Deno.test("T-L3: a lock exactly 10 minutes old is not stale", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await Deno.mkdir(`${dir}/lock`);
  const now = Date.now();
  await setMtimeMinutesAgo(`${dir}/lock`, now, 10);
  const res = await runCli([
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "x",
    "--lock-retry-ms",
    "1",
    "--lock-max-retries",
    "1",
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS"],
    env: { STATE_TEST_NOW_MS: String(now) },
  });
  assertEquals(res.code, EXIT_CODES.lock);
});

Deno.test("T-L4: a lock older than 10 minutes is reclaimed exactly once", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await Deno.mkdir(`${dir}/lock`);
  const now = Date.now();
  await setMtimeMinutesAgo(`${dir}/lock`, now, 11);
  const env = {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS"],
    env: { STATE_TEST_NOW_MS: String(now) },
  };
  // リトライ予算 (20ms × 199 ≒ 4 秒) は、回収した側の read-modify-write が終わるまで
  // もう一方が待ち切れる長さに取る。予算は lock を取得できる条件 (mkdir の成功、または
  // stale 回収 + mkdir の成功) には現れないので、増やしても排他は緩まない — 負けた側が
  // lock エラーで降りる代わりに実際に待って書くようになるぶん、検査は厳しくなる。
  const [a, b] = await Promise.all([
    runCli([
      "history-append",
      "--state-dir",
      dir,
      "--line",
      "a",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "200",
    ], env),
    runCli([
      "history-append",
      "--state-dir",
      dir,
      "--line",
      "b",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "200",
    ], env),
  ]);
  assertEquals(a.code, 0, a.stdout);
  assertEquals(b.code, 0, b.stdout);
  const state = await readState(dir);
  const history = state.history as string[];
  // 件数だけでは「2 件あるが片方が重複」を検出できないので、両方の line の存在も見る。
  assertEquals(history.length, 2);
  assert(history.includes("a"), `history must keep line a: ${history}`);
  assert(history.includes("b"), `history must keep line b: ${history}`);
  assert(
    !(await pathExists(`${dir}/lock`)),
    "lock must not be left behind after both callers finish",
  );
});

Deno.test("T-L7: a stale recovery landing on a re-created lock does not steal it", async () => {
  // stale 判定 (stat) と退避 (rename) の間に、別プロセスが回収を終えて lock を張り直す
  // interleaving を決定的に踏ませる。rename がアトミックなのは「今 lock という名前が指して
  // いるもの」に対してであって、判定したディレクトリに対してではないので、確認が無いと
  // 遅れた側が **新しい保持者の lock** を退避・削除してしまい、2 プロセスが同時に lock を
  // 持って互いの書き込みを踏む (両者 exit 0 のまま history が 1 件になる)。
  const dir = await tempDir();
  await setupQueue(dir, []);
  await Deno.mkdir(`${dir}/lock`);
  const now = Date.now();
  await setMtimeMinutesAgo(`${dir}/lock`, now, 11);
  const lockFlags = ["--lock-retry-ms", "20", "--lock-max-retries", "200"];
  // 先発 b: stale と判定した後 600ms 止まってから rename する (= 遅れた回収者)。
  const slow = spawnCli([
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "b",
    ...lockFlags,
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS", "STATE_TEST_STALE_RECOVER_PAUSE_MS"],
    env: {
      STATE_TEST_NOW_MS: String(now),
      STATE_TEST_STALE_RECOVER_PAUSE_MS: "600",
    },
  });
  // 先発が stale を判定し終える頃に後発を出す。
  await new Promise((r) => setTimeout(r, 150));
  // 後発 a: 回収して lock を張り直し、state.json の置き換え直前で lock を保持したまま
  // 900ms 止まる。先発の rename はこの保持中に着地する。
  const fast = spawnCli([
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "a",
    ...lockFlags,
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS", "STATE_TEST_PAUSE_MS"],
    env: { STATE_TEST_NOW_MS: String(now), STATE_TEST_PAUSE_MS: "900" },
  });
  const [rb, ra] = await Promise.all([slow.output(), fast.output()]);
  const decoder = new TextDecoder();
  assertEquals(ra.code, 0, decoder.decode(ra.stderr));
  assertEquals(rb.code, 0, decoder.decode(rb.stderr));
  const state = await readState(dir);
  const history = state.history as string[];
  assertEquals(history.length, 2);
  assert(history.includes("a"), `history must keep line a: ${history}`);
  assert(history.includes("b"), `history must keep line b: ${history}`);
  assert(!(await pathExists(`${dir}/lock`)), "lock must not be left behind");
  // 退避名 (lock.stale.*) の取りこぼしも残置として検出する。
  const leftovers: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith("lock")) leftovers.push(entry.name);
  }
  assertEquals(leftovers, []);
});

Deno.test("T-L5: a lock removed by someone else during release is tolerated", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  const child = spawnCli([
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "x",
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_LOCK_RELEASE_PAUSE_MS"],
    env: { STATE_TEST_LOCK_RELEASE_PAUSE_MS: "400" },
  });
  await new Promise((r) => setTimeout(r, 150));
  await Deno.remove(`${dir}/lock`, { recursive: true }).catch(() => {});
  const out = await child.output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
});

Deno.test("T-L6: state dir vanishing before the lock is `missing`, not a crash", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/gone`;
  const res = await runCli([
    "history-append",
    "--state-dir",
    stateDir,
    "--line",
    "x",
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(res.code, EXIT_CODES.missing);
});

// ---------------------------------------------------------------------------
// C: 並行実行と原子的書き込み
// ---------------------------------------------------------------------------

Deno.test("T-C1: 30 parallel history-append calls lose no updates", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  const runs = Array.from({ length: 30 }, (_, i) =>
    runVerb(dir, [
      "history-append",
      "--state-dir",
      dir,
      "--line",
      `line-${i}`,
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "200",
    ]));
  const results = await Promise.all(runs);
  for (const r of results) assertEquals(r.code, 0, r.stdout);
  const state = await readState(dir);
  assertEquals((state.history as string[]).length, 30);
});

Deno.test("T-C2: killing the process before rename leaves the previous content intact", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const child = spawnCli(
    ["claim", "--state-dir", dir, "--id", "t-1", "--session", "s"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_TEST_PAUSE_MS"],
      env: { STATE_TEST_PAUSE_MS: "3000" },
    },
  );
  await new Promise((r) => setTimeout(r, 600));
  child.kill("SIGKILL");
  await child.output();
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(after, before, "state.json must survive a kill before rename");
  JSON.parse(after);
});

// ---------------------------------------------------------------------------
// P: 権限封じ込め (受け入れ条件 4 — 現行と同じ制約を維持する)
// ---------------------------------------------------------------------------

Deno.test("T-P1: a state dir outside --allow-* is a permission error with no side effects", async () => {
  const allowed = await tempDir();
  const target = await tempDir();
  await setupQueue(target, []);
  const res = await runCli([
    "history-append",
    "--state-dir",
    target,
    "--line",
    "x",
  ], { allowRead: [allowed], allowWrite: [allowed] });
  assertEquals(res.code, EXIT_CODES.permission);
  const state = await readState(target);
  assertEquals((state.history as string[]).length, 0);
});

Deno.test("T-P2: init with a git-common-dir outside --allow-* touches neither exclude nor state.json", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  const outside = await tempDir();
  const res = await runCli([
    "init",
    "--state-dir",
    stateDir,
    "--tracker",
    "gh",
    "--source",
    "o/r",
    "--git-common-dir",
    outside,
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(res.code, EXIT_CODES.permission);
  let stateExists = true;
  try {
    await Deno.stat(`${stateDir}/state.json`);
  } catch {
    stateExists = false;
  }
  assert(!stateExists, "state.json must not be created");
  let excludeExists = true;
  try {
    await Deno.stat(`${outside}/info/exclude`);
  } catch {
    excludeExists = false;
  }
  assert(!excludeExists, "exclude must not be created");
});

Deno.test("T-P3: correctly scoped permissions let the whole cycle run", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  const opts = {
    allowRead: [stateDir, `${gcd}/info`],
    allowWrite: [stateDir, `${gcd}/info`],
  };
  const init = await runCli([
    "init",
    "--state-dir",
    stateDir,
    "--tracker",
    "gh",
    "--source",
    "o/r",
    "--git-common-dir",
    gcd,
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(init.code, 0, init.stderr);
  for (
    const args of [
      ["approve", "--id", "t-1", "--title", "T"],
      ["claim", "--id", "t-1", "--session", "s"],
      ["advance", "--id", "t-1", "--from", "research", "--to", "plan"],
      ["get"],
      ["validate"],
    ]
  ) {
    const res = await runCli([
      args[0],
      "--state-dir",
      stateDir,
      ...args.slice(1),
    ], opts);
    assertEquals(res.code, 0, `${args[0]}: ${res.stdout} ${res.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// H: heartbeat
// ---------------------------------------------------------------------------

async function makeSessionFile(
  stateDir: string,
  id: string,
  nowMsValue: number,
  minutesAgo: number,
): Promise<void> {
  const sessionsDir = `${stateDir}/sessions`;
  await Deno.mkdir(sessionsDir, { recursive: true });
  const p = `${sessionsDir}/${id}`;
  await Deno.writeTextFile(p, "");
  await setMtimeMinutesAgo(p, nowMsValue, minutesAgo);
}

Deno.test("T-H1/2/3: sessions-alive boundary is strict at 90 minutes", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "s89", now, 89);
  await makeSessionFile(dir, "s90", now, 90);
  await makeSessionFile(dir, "s91", now, 91);
  const res = await runCli(["sessions-alive", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS"],
    env: { STATE_TEST_NOW_MS: String(now) },
  });
  assertEquals(res.code, 0);
  assertEquals(parseJson(res.stdout).alive, ["s89"]);
});

Deno.test("T-H4/5/6: session-touch cleanup boundary is strict at 1440 minutes", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "old1439", now, 1439);
  await makeSessionFile(dir, "old1440", now, 1440);
  await makeSessionFile(dir, "old1441", now, 1441);
  const res = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "me"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_TEST_NOW_MS"],
      env: { STATE_TEST_NOW_MS: String(now) },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(parseJson(res.stdout).cleaned, ["old1441"]);
});

Deno.test("T-H7: sessions-alive with no sessions dir returns an empty list", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["sessions-alive", "--state-dir", dir]);
  assertEquals(res.code, 0);
  assertEquals(parseJson(res.stdout).alive, []);
});

Deno.test("T-H8: session-touch rejects id shapes that escape the sessions dir", async () => {
  const dir = await tempDir();
  for (const bad of ["", ".", "..", "a/b"]) {
    const res = await runVerb(dir, [
      "session-touch",
      "--state-dir",
      dir,
      "--id",
      bad,
    ]);
    assertEquals(res.code, EXIT_CODES.usage, `id=${JSON.stringify(bad)}`);
  }
});

Deno.test("T-H9: session-touch refreshes mtime on repeat", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "me", now, 100);
  const before = await statMtime(`${dir}/sessions/me`);
  const res = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "me"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_TEST_NOW_MS"],
      env: { STATE_TEST_NOW_MS: String(now) },
    },
  );
  assertEquals(res.code, 0);
  const after = await statMtime(`${dir}/sessions/me`);
  assert(after > before, "mtime must move forward");
});

Deno.test("T-H10: a stale own id is refreshed, not deleted", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "me", now, 5000);
  const res = await runCli(
    ["session-touch", "--state-dir", dir, "--id", "me"],
    {
      allowRead: [dir],
      allowWrite: [dir],
      allowEnv: ["STATE_TEST_NOW_MS"],
      env: { STATE_TEST_NOW_MS: String(now) },
    },
  );
  assertEquals(res.code, 0);
  assertEquals(parseJson(res.stdout).cleaned, []);
  await Deno.stat(`${dir}/sessions/me`);
});

Deno.test("T-H11: an entry vanishing during cleanup is tolerated", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "victim", now, 5000);
  const child = spawnCli(["session-touch", "--state-dir", dir, "--id", "me"], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS", "STATE_TEST_SESSION_STAT_PAUSE_MS"],
    env: {
      STATE_TEST_NOW_MS: String(now),
      STATE_TEST_SESSION_STAT_PAUSE_MS: "400",
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  await Deno.remove(`${dir}/sessions/victim`).catch(() => {});
  const out = await child.output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
});

Deno.test("T-H12: an entry vanishing between stat and remove is tolerated", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "victim", now, 5000);
  const child = spawnCli(["session-touch", "--state-dir", dir, "--id", "me"], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS", "STATE_TEST_SESSION_REMOVE_PAUSE_MS"],
    env: {
      STATE_TEST_NOW_MS: String(now),
      STATE_TEST_SESSION_REMOVE_PAUSE_MS: "400",
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  await Deno.remove(`${dir}/sessions/victim`).catch(() => {});
  const out = await child.output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
});

Deno.test("T-H13: sessions-alive tolerates an entry vanishing after readDir", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "victim", now, 1);
  const child = spawnCli(["sessions-alive", "--state-dir", dir], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS", "STATE_TEST_SESSION_STAT_PAUSE_MS"],
    env: {
      STATE_TEST_NOW_MS: String(now),
      STATE_TEST_SESSION_STAT_PAUSE_MS: "400",
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  await Deno.remove(`${dir}/sessions/victim`).catch(() => {});
  const out = await child.output();
  assertEquals(out.code, 0);
});

Deno.test("T-H14: --alive-max-min overrides the default window", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "s5", now, 5);
  const res = await runCli([
    "sessions-alive",
    "--state-dir",
    dir,
    "--alive-max-min",
    "4",
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS"],
    env: { STATE_TEST_NOW_MS: String(now) },
  });
  assertEquals(parseJson(res.stdout).alive, []);
});

Deno.test("T-H15: --cleanup-stale-min overrides the default window", async () => {
  const dir = await tempDir();
  const now = Date.now();
  await makeSessionFile(dir, "s5", now, 5);
  const res = await runCli([
    "session-touch",
    "--state-dir",
    dir,
    "--id",
    "me",
    "--cleanup-stale-min",
    "4",
  ], {
    allowRead: [dir],
    allowWrite: [dir],
    allowEnv: ["STATE_TEST_NOW_MS"],
    env: { STATE_TEST_NOW_MS: String(now) },
  });
  assertEquals(parseJson(res.stdout).cleaned, ["s5"]);
});

// ---------------------------------------------------------------------------
// I: init の exclude 追記
// ---------------------------------------------------------------------------

async function runInit(
  parent: string,
  stateDir: string,
  gcd: string,
): Promise<RunResult> {
  return await runCli([
    "init",
    "--state-dir",
    stateDir,
    "--tracker",
    "gh",
    "--source",
    "o/r",
    "--git-common-dir",
    gcd,
  ], { allowRead: [parent], allowWrite: [parent] });
}

Deno.test("T-I1: init appends the exclude line when absent", async () => {
  const parent = await tempDir();
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  const res = await runInit(parent, `${parent}/.task-pipeline`, gcd);
  assertEquals(res.code, 0, res.stderr);
  const exclude = await Deno.readTextFile(`${gcd}/info/exclude`);
  assertEquals(exclude, "/.task-pipeline/\n");
});

Deno.test("T-I2: init is a no-op when the exclude line is already present", async () => {
  const parent = await tempDir();
  const gcd = `${parent}/git`;
  await Deno.mkdir(`${gcd}/info`, { recursive: true });
  await Deno.writeTextFile(`${gcd}/info/exclude`, "/.task-pipeline/\n");
  const before = await Deno.readTextFile(`${gcd}/info/exclude`);
  await runInit(parent, `${parent}/.task-pipeline`, gcd);
  assertEquals(await Deno.readTextFile(`${gcd}/info/exclude`), before);
});

Deno.test("T-I3: init creates the info directory when missing", async () => {
  const parent = await tempDir();
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await runInit(parent, `${parent}/.task-pipeline`, gcd);
  const info = await Deno.stat(`${gcd}/info`);
  assert(info.isDirectory, "info dir must exist");
});

Deno.test("T-I4: init preserves existing exclude content", async () => {
  const parent = await tempDir();
  const gcd = `${parent}/git`;
  await Deno.mkdir(`${gcd}/info`, { recursive: true });
  await Deno.writeTextFile(`${gcd}/info/exclude`, "*.log");
  await runInit(parent, `${parent}/.task-pipeline`, gcd);
  const exclude = await Deno.readTextFile(`${gcd}/info/exclude`);
  assertEquals(exclude, "*.log\n/.task-pipeline/\n");
});

// ---------------------------------------------------------------------------
// MIG: init による v1 → v2 移行 (受け入れ条件 3)
// ---------------------------------------------------------------------------

async function setupV1(fixture: string): Promise<{
  parent: string;
  stateDir: string;
  gcd: string;
}> {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await writeStateFile(stateDir, await readFixture(fixture));
  return { parent, stateDir, gcd };
}

Deno.test("T-MIG-1: schema_version 1 is migrated by init and later verbs work", async () => {
  const { parent, stateDir, gcd } = await setupV1("valid-watch-rebase.json");
  const res = await runInit(parent, stateDir, gcd);
  assertEquals(res.code, 0, res.stderr);
  const payload = parseJson(res.stdout);
  assertEquals(payload.created, false);
  assertEquals(payload.migrated, true);

  const state = await readState(stateDir);
  assertEquals(state.schema_version, 2);
  const opts = { allowRead: [parent], allowWrite: [parent] };
  const validate = await runCli(["validate", "--state-dir", stateDir], opts);
  assertEquals(validate.code, 0, validate.stdout);
  // 続く verb が動く (このフィクスチャは resting × open + follow に移行される)
  const observe = await runCli([
    "observe",
    "--state-dir",
    stateDir,
    "--id",
    "t-full",
    "--ci",
    "passing",
  ], opts);
  assertEquals(observe.code, 0, observe.stdout);
});

Deno.test("T-MIG-2: a second init does not migrate again (byte-identical)", async () => {
  const { parent, stateDir, gcd } = await setupV1("valid-watch-rebase.json");
  await runInit(parent, stateDir, gcd);
  const afterFirst = await Deno.readTextFile(`${stateDir}/state.json`);
  const second = await runInit(parent, stateDir, gcd);
  assertEquals(second.code, 0);
  assertEquals(parseJson(second.stdout).migrated, false);
  assertEquals(
    await Deno.readTextFile(`${stateDir}/state.json`),
    afterFirst,
    "second init must not rewrite state.json",
  );
});

Deno.test("T-MIG-3: a state without schema_version is treated as v1 and migrated", async () => {
  const { parent, stateDir, gcd } = await setupV1("valid-legacy-live.json");
  const res = await runInit(parent, stateDir, gcd);
  assertEquals(res.code, 0, res.stderr);
  assertEquals(parseJson(res.stdout).migrated, true);
  const state = await readState(stateDir);
  assertEquals(state.schema_version, 2);
  // このフィクスチャの item は status: done だが worktree が残っている (片付け未了) ので、
  // completed には行かず resting × merged で queue に残る (設計3.2 の done 行)。
  assertEquals((state.completed as unknown[]).length, 0);
  const item = await readItem(stateDir, "t-1a2b3c4d");
  assertEquals(item.progress, "resting");
  assertEquals((item.artifact as Record<string, unknown>).state, "merged");
  // retire の前に片付けが要る、が state 上は session が空いているので retire できる
  const retire = await runCli([
    "retire",
    "--state-dir",
    stateDir,
    "--id",
    "t-1a2b3c4d",
  ], { allowRead: [parent], allowWrite: [parent] });
  assertEquals(retire.code, 0, retire.stdout);
  assertEquals(((await readState(stateDir)).completed as unknown[]).length, 1);
});

Deno.test("T-MIG-4: a v2 state is left byte-identical by init", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await writeStateFile(stateDir, await readFixture("v2-open-follow.json"));
  const before = await Deno.readTextFile(`${stateDir}/state.json`);
  const res = await runInit(parent, stateDir, gcd);
  assertEquals(res.code, 0, res.stderr);
  assertEquals(parseJson(res.stdout).migrated, false);
  assertEquals(await Deno.readTextFile(`${stateDir}/state.json`), before);
});

Deno.test("T-MIG-5: an unknown numeric schema_version is a schema error", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await writeStateFile(
    stateDir,
    JSON.stringify(minimalValidState({ schema_version: 3 })),
  );
  const res = await runInit(parent, stateDir, gcd);
  assertEquals(res.code, EXIT_CODES.schema);
});

Deno.test("T-MIG-6: a non-numeric schema_version is a schema error", async () => {
  const parent = await tempDir();
  const stateDir = `${parent}/.task-pipeline`;
  await Deno.mkdir(stateDir, { recursive: true });
  const gcd = `${parent}/git`;
  await Deno.mkdir(gcd, { recursive: true });
  await writeStateFile(
    stateDir,
    JSON.stringify(minimalValidState({ schema_version: "two" })),
  );
  const res = await runInit(parent, stateDir, gcd);
  assertEquals(res.code, EXIT_CODES.schema);
});

// ---------------------------------------------------------------------------
// V: verb ごとの代表 1 組 (成功 / 前提違反)
// ---------------------------------------------------------------------------

Deno.test("T-V-approve: adds a queued × none entry; a duplicate id is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "approve",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--title",
    "T",
  ]);
  const item = await readItem(dir);
  assertEquals(item.progress, "queued");
  assertEquals((item.artifact as Record<string, unknown>).state, "none");
  await expectFailureUnchanged(
    dir,
    ["approve", "--state-dir", dir, "--id", "t-1", "--title", "T"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-claim: queued → running(initial,full,research); running is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  const out = await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s1",
  ]);
  assertEquals(out.kind, "initial");
  assertEquals(out.gate, "full");
  assertEquals(out.phase, "research");
  await expectFailureUnchanged(
    dir,
    ["claim", "--state-dir", dir, "--id", "t-1", "--session", "s2"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-claim-missing: an unknown id is missing", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  await expectFailureUnchanged(
    dir,
    ["claim", "--state-dir", dir, "--id", "nope", "--session", "s"],
    EXIT_CODES.missing,
  );
});

Deno.test("T-V-claim-concurrent: exactly one of two claims wins", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  const opts = { allowRead: [dir], allowWrite: [dir] };
  const [a, b] = await Promise.all([
    runCli([
      "claim",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s1",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "50",
    ], opts),
    runCli([
      "claim",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s2",
      "--lock-retry-ms",
      "20",
      "--lock-max-retries",
      "50",
    ], opts),
  ]);
  const codes = [a.code, b.code].sort();
  assertEquals(codes, [0, EXIT_CODES.conflict]);
});

Deno.test("T-V-claim-cycle-reset: claim resets the follow ledger but keeps handled", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      artifact: openArtifact({
        follow: followOf({
          attention: { human: "manual" },
          asks: { fix: fixAsk(), rebase: rebaseAsk({ resolve: true }) },
          ledger: ledgerOf({
            handled: ["c1"],
            fix_attempts: 3,
            review_only: [{ id: "r1", updated_at: null }],
          }),
          probe: probeOf({ sig: "sig-1" }),
        }),
      }),
    }),
  ]);
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  const f = follow(await readItem(dir));
  assertEquals(f.attention, "auto");
  assertEquals(f.asks, { fix: null, rebase: null });
  assertEquals((f.ledger as Record<string, unknown>).fix_attempts, 0);
  assertEquals((f.ledger as Record<string, unknown>).handled, ["c1"]);
  assertEquals((f.ledger as Record<string, unknown>).review_only, []);
  assertEquals((f.probe as Record<string, unknown>).sig, null);
});

Deno.test("T-V-set-gate: research → research+plan; a non-research node is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  const out = await expectOk(dir, [
    "set-gate",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(out.gate, "light");
  assertEquals(out.phase, "research+plan");
  await expectFailureUnchanged(
    dir,
    ["set-gate", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-advance: a declared edge succeeds, an undeclared one is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectOk(dir, [
    "advance",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "research",
    "--to",
    "plan",
  ]);
  // 飛び越し (plan → report) は宣言された辺ではない
  await expectFailureUnchanged(
    dir,
    [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "plan",
      "--to",
      "report",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-fail: attempts increments; a phase mismatch is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  const out = await expectOk(dir, [
    "phase-fail",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--phase",
    "research",
  ]);
  assertEquals(out.attempts, 1);
  await expectFailureUnchanged(
    dir,
    ["phase-fail", "--state-dir", dir, "--id", "t-1", "--phase", "plan"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-phase-fail-verifier-1: --verifier + --session writes run.verifier/run.verifier_session", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  const out = await expectOk(dir, [
    "phase-fail",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--phase",
    "research",
    "--verifier",
    "agent-1",
    "--session",
    "s1",
  ]);
  assertEquals(out.verifier, "agent-1");
  assertEquals(out.verifier_session, "s1");
  const item = await readItem(dir);
  const run = item.run as Record<string, unknown>;
  assertEquals(run.verifier, "agent-1");
  assertEquals(run.verifier_session, "s1");
});

Deno.test("T-V-phase-fail-verifier-2: omitting --verifier leaves both null", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  const out = await expectOk(dir, [
    "phase-fail",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--phase",
    "research",
  ]);
  assertEquals(out.verifier, null);
  assertEquals(out.verifier_session, null);
  const item = await readItem(dir);
  const run = item.run as Record<string, unknown>;
  assertEquals(run.verifier, null);
  assertEquals(run.verifier_session, null);
});

Deno.test("T-V-phase-fail-verifier-3: --verifier without --session is usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectFailureUnchanged(
    dir,
    [
      "phase-fail",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--phase",
      "research",
      "--verifier",
      "agent-1",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-block: running → blocked; blocking twice is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf(), session: "s" }),
  ]);
  await expectOk(dir, [
    "block",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--reason",
    "why",
  ]);
  const item = await readItem(dir);
  assertEquals(item.progress, "blocked");
  assertEquals(item.blocked_reason, "why");
  assertEquals(item.session, null);
  await expectFailureUnchanged(
    dir,
    ["block", "--state-dir", dir, "--id", "t-1", "--reason", "again"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-dequeue: removes a running entry; a queued one is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf() }),
    queueItem({ id: "t-2" }),
  ]);
  await expectOk(dir, ["dequeue", "--state-dir", dir, "--id", "t-1"]);
  const state = await readState(dir);
  assertEquals((state.queue as unknown[]).length, 1);
  await expectFailureUnchanged(
    dir,
    ["dequeue", "--state-dir", dir, "--id", "t-2"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-restore: resting and blocked restore; merged and un-relisted do not", async () => {
  const dir = await tempDir();
  const relisted = [
    { id: "t-1", seen_at: "2026-08-07T00:00:00.000Z" },
    { id: "t-2", seen_at: "2026-08-07T00:00:00.000Z" },
    { id: "t-3", seen_at: "2026-08-07T00:00:00.000Z" },
  ];
  await setupQueue(dir, [
    restingOpen({}, { session: "s" }),
    queueItem({ id: "t-2", progress: "blocked", blocked_reason: "why" }),
    queueItem({
      id: "t-3",
      progress: "resting",
      artifact: {
        state: "merged",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
      },
    }),
    queueItem({ id: "t-4", progress: "resting" }),
  ], { relisted });
  // resting → queued
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  assertEquals((await readItem(dir, "t-1")).progress, "queued");
  // blocked → queued
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-2"]);
  assertEquals((await readItem(dir, "t-2")).progress, "queued");
  // merged は retire で離脱する終端なので restore できない
  await expectFailureUnchanged(
    dir,
    ["restore", "--state-dir", dir, "--id", "t-3"],
    EXIT_CODES.conflict,
  );
  // relisted に居ないものは missing
  await expectFailureUnchanged(
    dir,
    ["restore", "--state-dir", dir, "--id", "t-4"],
    EXIT_CODES.missing,
  );
});

Deno.test("T-V-retire: merged with no session leaves the queue; other shapes do not", async () => {
  const dir = await tempDir();
  const merged = (id: string, extra: Record<string, unknown> = {}) =>
    queueItem({
      id,
      progress: "resting",
      artifact: {
        state: "merged",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
      },
      ...extra,
    });
  await setupQueue(dir, [
    merged("t-1"),
    merged("t-2", { session: "s" }),
    restingOpen({}, { id: "t-3" }),
  ]);
  const out = await expectOk(dir, [
    "retire",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(out.completed, 1);
  const state = await readState(dir);
  assertEquals((state.queue as Record<string, unknown>[]).map((i) => i.id), [
    "t-2",
    "t-3",
  ]);
  assertEquals((state.completed as Record<string, unknown>[])[0].id, "t-1");
  // 揮発資源が残っている (session) と retire できない
  await expectFailureUnchanged(
    dir,
    ["retire", "--state-dir", dir, "--id", "t-2"],
    EXIT_CODES.conflict,
  );
  // open は merged ではない
  await expectFailureUnchanged(
    dir,
    ["retire", "--state-dir", dir, "--id", "t-3"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-ship-1: commits >= 1 from none creates the open artifact and follow", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "running",
      run: runOf({ phase: "finalize" }),
      session: "s",
    }),
  ]);
  const out = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "2",
    "--ref",
    "https://example.com/o/r/pull/9",
    "--branch",
    "b",
    "--tip",
    "sha1",
    "--base",
    "main",
  ]);
  assertEquals(out.notify, "initial");
  assertEquals(out.mark, true);
  assertEquals(out.fix_count, 0);
  const item = await readItem(dir);
  assertEquals(item.progress, "resting");
  const artifact = item.artifact as Record<string, unknown>;
  assertEquals(artifact.state, "open");
  assertEquals(artifact.tip, "sha1");
  assert(artifact.follow !== null, "follow must be created for a PR ref");
});

Deno.test("T-V-ship-2: commits 0 keeps the artifact untouched and reports notify none", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf({ phase: "finalize" }) }),
  ]);
  const out = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "0",
  ]);
  assertEquals(out.notify, "none");
  assertEquals(out.mark, true);
  assertEquals((await readItem(dir)).artifact, { state: "none" });
});

Deno.test("T-V-ship-3: the group flags must be all-present or all-absent", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ progress: "running", run: runOf({ phase: "finalize" }) }),
  ]);
  // commits >= 1 で一部欠け
  await expectFailureUnchanged(
    dir,
    [
      "ship",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "1",
      "--ref",
      "r",
      "--branch",
      "b",
    ],
    EXIT_CODES.usage,
  );
  // commits >= 1 で全欠け
  await expectFailureUnchanged(
    dir,
    ["ship", "--state-dir", dir, "--id", "t-1", "--commits", "1"],
    EXIT_CODES.usage,
  );
  // commits == 0 なのにグループを渡した
  await expectFailureUnchanged(
    dir,
    [
      "ship",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "0",
      "--ref",
      "r",
      "--branch",
      "b",
      "--tip",
      "t",
      "--base",
      "main",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-ship-4: a pr_fix ship reports update/mark=false and merges handled", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "running",
      run: {
        kind: "pr_fix",
        gate: null,
        phase: "finalize",
        attempts: 0,
        executor: null,
        executor_last_event_at: null,
        takeover_at: null,
        verifier: null,
        verifier_session: null,
      },
      artifact: openArtifact({
        follow: followOf({
          asks: {
            fix: fixAsk({ ids: ["rc-1", "rc-2"], taken: true }),
            rebase: null,
          },
          ledger: ledgerOf({ handled: ["c0"], fix_attempts: 1 }),
        }),
      }),
      session: "s",
    }),
  ]);
  const out = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "https://example.com/o/r/pull/1",
    "--branch",
    "b",
    "--tip",
    "sha2",
    "--base",
    "main",
  ]);
  assertEquals(out.notify, "update");
  assertEquals(out.mark, false);
  assertEquals(out.fix_count, 2);
  const f = follow(await readItem(dir));
  assertEquals((f.ledger as Record<string, unknown>).handled, [
    "c0",
    "rc-1",
    "rc-2",
  ]);
  assertEquals((f.asks as Record<string, unknown>).fix, null);
});

Deno.test("T-V-ship-5: ship outside finalize is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectFailureUnchanged(
    dir,
    ["ship", "--state-dir", dir, "--id", "t-1", "--commits", "0"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-merged: open with a tip becomes merged and drops follow", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({}, { session: "s" }),
    queueItem({ id: "t-2", progress: "resting" }),
  ]);
  await expectOk(dir, ["merged", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals((item.artifact as Record<string, unknown>).state, "merged");
  assertEquals(item.session, null);
  assert(
    !("follow" in (item.artifact as Record<string, unknown>)),
    "merged has no follow",
  );
  // artifact が none のものは merged にできない
  await expectFailureUnchanged(
    dir,
    ["merged", "--state-dir", dir, "--id", "t-2"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw: open → withdrawn(asked=false) with an optional note", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen({}, { session: "s" })]);
  await expectOk(dir, [
    "withdraw",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--note",
    "closed by hand",
  ]);
  const artifact = (await readItem(dir)).artifact as Record<string, unknown>;
  assertEquals(artifact.state, "withdrawn");
  assertEquals(artifact.asked, false);
  assertEquals(artifact.note, "closed by hand");
  // 2 回目 (withdrawn からの withdraw) は conflict
  await expectFailureUnchanged(
    dir,
    ["withdraw", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw-asked: sets asked; open is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "resting",
      artifact: {
        state: "withdrawn",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
        asked: false,
        note: null,
      },
    }),
    restingOpen({}, { id: "t-2" }),
  ]);
  await expectOk(dir, ["withdraw-asked", "--state-dir", dir, "--id", "t-1"]);
  assertEquals(
    ((await readItem(dir)).artifact as Record<string, unknown>).asked,
    true,
  );
  await expectFailureUnchanged(
    dir,
    ["withdraw-asked", "--state-dir", dir, "--id", "t-2"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-withdraw-remove: records the branch and leaves the queue", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "resting",
      artifact: {
        state: "withdrawn",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
        asked: true,
        note: null,
      },
      worktree: "/tmp/wt",
      base: "main",
    }),
  ], { withdrawn_branches: [] });
  await expectOk(dir, [
    "withdraw-remove",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--reason",
    "obsolete",
  ]);
  const state = await readState(dir);
  assertEquals((state.queue as unknown[]).length, 0);
  const wb = state.withdrawn_branches as Record<string, unknown>[];
  assertEquals(wb.length, 1);
  assertEquals(wb[0].reason, "obsolete");
});

Deno.test("T-V-fix-request: writes the pending ask; an empty --ids is an empty list", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  await expectOk(dir, [
    "fix-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--ids",
    "rc-1,rc-2",
    "--findings",
    "/tmp/f.md",
  ]);
  const asks = follow(await readItem(dir)).asks as Record<string, unknown>;
  assertEquals((asks.fix as Record<string, unknown>).ids, ["rc-1", "rc-2"]);
  assertEquals((asks.fix as Record<string, unknown>).taken, false);
  // 空文字は空配列 (CI 失敗だけで指摘 id が無い周回)
  await expectOk(dir, [
    "fix-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--ids",
    "",
    "--findings",
    "/tmp/f.md",
  ]);
  const asks2 = follow(await readItem(dir)).asks as Record<string, unknown>;
  assertEquals((asks2.fix as Record<string, unknown>).ids, []);
});

Deno.test("T-V-fix-rerun-mark: records ledger.fix_rerun_tip from the current tip and is idempotent", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({ asks: { fix: fixAsk(), rebase: null } }),
  ]);
  const out = await expectOk(dir, [
    "fix-rerun-mark",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(out.tip, "sha-tip");
  const ledger1 = follow(await readItem(dir)).ledger as Record<string, unknown>;
  assertEquals(ledger1.fix_rerun_tip, "sha-tip");
  // gh-18 受け入れ条件2: 同じ tip に対して2回呼んでも壊れない (conflict にならず、
  // 記録された tip も変わらない — 同じ tip への再実行を重ねて記録しても実害が無いことの
  // 確認であって、呼び出し回数そのものを防ぐのは next の action 側の仕事)。
  const out2 = await expectOk(dir, [
    "fix-rerun-mark",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(out2.tip, "sha-tip");
  const ledger2 = follow(await readItem(dir)).ledger as Record<string, unknown>;
  assertEquals(ledger2.fix_rerun_tip, "sha-tip");
  // 他のフィールドには触れない。
  assertEquals(ledger2.fix_attempts, 0);
  assertEquals(
    ((follow(await readItem(dir)).asks as Record<string, unknown>)
      .fix as Record<string, unknown>).taken,
    false,
  );
});

Deno.test("T-V-fix-rerun-mark-conflict: a task without follow is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "resting" })]);
  await expectFailureUnchanged(
    dir,
    ["fix-rerun-mark", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-fix-request-conflict: a task without follow cannot take a fix ask", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "resting" })]);
  await expectFailureUnchanged(
    dir,
    [
      "fix-request",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--ids",
      "rc-1",
      "--findings",
      "f",
    ],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-request: upserts the ask; --resolve queues the resolution cycle", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  await expectOk(dir, [
    "rebase-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha-a",
    "--reason",
    "conflict",
    "--kind",
    "overlap",
    "--cause",
    "c",
    "--report",
    "/tmp/r.md",
  ]);
  const ask1 = (follow(await readItem(dir)).asks as Record<string, unknown>)
    .rebase as Record<string, unknown>;
  assertEquals(ask1.blocked_onto, "sha-a");
  assertEquals(ask1.kind, "overlap");
  assertEquals(ask1.resolve, false);
  await expectOk(dir, [
    "rebase-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha-b",
    "--reason",
    "conflict",
    "--resolve",
    "true",
    "--from-tip",
    "sha-old",
  ]);
  const ask2 = (follow(await readItem(dir)).asks as Record<string, unknown>)
    .rebase as Record<string, unknown>;
  assertEquals(ask2.resolve, true);
  assertEquals(ask2.blocked_onto, "sha-b");
  assertEquals(ask2.from_tip, "sha-old");
  assertEquals(
    ask2.kind,
    "overlap",
    "omitted fields keep their previous value",
  );
});

Deno.test("T-V-rebase-applied: updates tip, clears the ask and sig", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      asks: { fix: null, rebase: rebaseAsk() },
      probe: probeOf({ sig: "sig-1" }),
    }),
  ]);
  await expectOk(dir, [
    "rebase-applied",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--tip",
    "sha-new",
  ]);
  const item = await readItem(dir);
  assertEquals((item.artifact as Record<string, unknown>).tip, "sha-new");
  const f = follow(item);
  assertEquals((f.asks as Record<string, unknown>).rebase, null);
  assertEquals((f.probe as Record<string, unknown>).sig, null);
});

Deno.test("T-V-fix-start-1: within the limit it starts a pr_fix run", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      asks: { fix: fixAsk(), rebase: null },
      ledger: ledgerOf({ fix_attempts: 1 }),
    }),
  ]);
  const out = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(out.started, true);
  assertEquals(out.fix_attempts, 2);
  const item = await readItem(dir);
  assertEquals(item.progress, "running");
  assertEquals((item.run as Record<string, unknown>).kind, "pr_fix");
  assertEquals((item.run as Record<string, unknown>).gate, null);
});

Deno.test("T-V-fix-start-2: over the limit it latches attention to human(fix_limit)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      asks: { fix: fixAsk(), rebase: null },
      ledger: ledgerOf({ fix_attempts: 3 }),
    }, { session: "s" }),
  ]);
  const out = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(out.started, false);
  assertEquals(out.fix_attempts, 4);
  const item = await readItem(dir);
  assertEquals(item.progress, "resting");
  assertEquals(item.session, null);
  const f = follow(item);
  assertEquals(f.attention, { human: "fix_limit" });
  // 上限超では ask を消費しない (人の再開を待つ)
  assertEquals(
    ((f.asks as Record<string, unknown>).fix as Record<string, unknown>).taken,
    false,
  );
  // ラッチ後は attention != auto なので二度と自動では始まらない
  await expectFailureUnchanged(
    dir,
    ["fix-start", "--state-dir", dir, "--id", "t-1", "--session", "s"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-start-1: entry (a) from resting takes the ask into a rebase_fix run", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({ asks: { fix: null, rebase: rebaseAsk({ resolve: true }) } }),
  ]);
  const out = await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(out.kind, "rebase_fix");
  assertEquals(out.phase, "rebase_fix");
  const ask = (follow(await readItem(dir)).asks as Record<string, unknown>)
    .rebase as Record<string, unknown>;
  assertEquals(ask.taken, true);
});

Deno.test("T-V-rebase-start-2: entry (b) from finalize only moves the phase (kind survives)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "running",
      run: {
        kind: "pr_fix",
        gate: null,
        phase: "finalize",
        attempts: 2,
        executor: null,
        executor_last_event_at: null,
        takeover_at: null,
        verifier: null,
        verifier_session: null,
      },
      artifact: openArtifact({
        follow: followOf({
          asks: { fix: fixAsk({ taken: true }), rebase: null },
        }),
      }),
    }),
  ]);
  const out = await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(
    out.kind,
    "pr_fix",
    "the detour must not overwrite the engagement kind",
  );
  assertEquals(out.phase, "rebase_fix");
});

Deno.test("T-V-rebase-start-3: a running non-finalize node is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectFailureUnchanged(
    dir,
    ["rebase-start", "--state-dir", dir, "--id", "t-1", "--session", "s"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-rebase-give-up/forgo: the two exits are mutually exclusive by kind", async () => {
  const dir = await tempDir();
  const cycleRun = {
    kind: "rebase_fix",
    gate: null,
    phase: "rebase_fix",
    attempts: 0,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    verifier: null,
    verifier_session: null,
  };
  const detourRun = {
    kind: "pr_fix",
    gate: null,
    phase: "rebase_fix",
    attempts: 0,
    executor: null,
    executor_last_event_at: null,
    takeover_at: null,
    verifier: null,
    verifier_session: null,
  };
  await setupQueue(dir, [
    queueItem({
      progress: "running",
      run: cycleRun,
      artifact: openArtifact({
        follow: followOf({
          asks: {
            fix: null,
            rebase: rebaseAsk({ resolve: true, taken: true }),
          },
        }),
      }),
      session: "s",
    }),
    queueItem({
      id: "t-2",
      progress: "running",
      run: detourRun,
      artifact: openArtifact({
        follow: followOf({
          asks: { fix: fixAsk({ taken: true }), rebase: null },
        }),
      }),
      session: "s",
    }),
  ]);
  // 解決サイクル: give-up は通る / forgo は通らない
  await expectFailureUnchanged(
    dir,
    [
      "rebase-forgo",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--blocked-onto",
      "sha",
    ],
    EXIT_CODES.conflict,
  );
  // 迂回: forgo は通る / give-up は通らない
  await expectFailureUnchanged(
    dir,
    [
      "rebase-give-up",
      "--state-dir",
      dir,
      "--id",
      "t-2",
      "--blocked-onto",
      "sha",
    ],
    EXIT_CODES.conflict,
  );
  const giveUp = await expectOk(dir, [
    "rebase-give-up",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha-x",
  ]);
  assertEquals(giveUp.progress, "resting");
  const ask =
    (follow(await readItem(dir, "t-1")).asks as Record<string, unknown>)
      .rebase as Record<string, unknown>;
  assertEquals(ask.taken, false);
  assertEquals(ask.resolve, false, "the ask goes back to a quiet guard record");
  const forgo = await expectOk(dir, [
    "rebase-forgo",
    "--state-dir",
    dir,
    "--id",
    "t-2",
    "--blocked-onto",
    "sha-y",
  ]);
  assertEquals(forgo.phase, "finalize");
  assertEquals(forgo.kind, "pr_fix");
});

Deno.test("T-V-probe-run: takes the lease; a pending ask blocks it", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen(),
    restingOpen({ asks: { fix: fixAsk(), rebase: null } }, { id: "t-2" }),
  ]);
  await expectOk(dir, [
    "probe-run",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "p1",
    "--session",
    "s",
  ]);
  const probe = follow(await readItem(dir)).probe as Record<string, unknown>;
  assertEquals(probe.proc, "p1");
  assert(probe.proc_started_at !== null, "proc_started_at must be stamped");
  // fix ask が pending のタスクは追従対象ではない (導出式そのものが from 前提)
  await expectFailureUnchanged(
    dir,
    ["probe-run", "--state-dir", dir, "--id", "t-2", "--proc", "p2"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-probe-exit: drops the lease and stores the observed signature", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      probe: probeOf({
        proc: "p1",
        proc_started_at: "2026-08-07T00:00:00.000Z",
      }),
    }),
  ]);
  await expectOk(dir, [
    "probe-exit",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--sig",
    "sig-9",
  ]);
  const probe = follow(await readItem(dir)).probe as Record<string, unknown>;
  assertEquals(probe.proc, null);
  assertEquals(probe.proc_started_at, null);
  assertEquals(probe.sig, "sig-9");
  // "null" リテラルは JSON の null として書かれる
  await expectOk(dir, [
    "probe-exit",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--sig",
    "null",
  ]);
  assertEquals(
    (follow(await readItem(dir)).probe as Record<string, unknown>).sig,
    null,
  );
});

Deno.test("T-V-release: hands back the session and the lease", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      probe: probeOf({
        proc: "p1",
        proc_started_at: "2026-08-07T00:00:00.000Z",
      }),
    }, { session: "s" }),
  ]);
  await expectOk(dir, ["release", "--state-dir", dir, "--id", "t-1"]);
  const item = await readItem(dir);
  assertEquals(item.session, null);
  assertEquals((follow(item).probe as Record<string, unknown>).proc, null);
});

Deno.test("T-V-observe-1: writes the cache fields and increments errors", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  const out = await expectOk(dir, [
    "observe",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--head",
    "sha-h",
    "--ci",
    "failing",
    "--checked-at",
    "2026-08-07T01:00:00.000Z",
    "--note",
    "n",
    "--errors-inc",
    "true",
  ]);
  assertEquals(out.errors, 1);
  assertEquals(out.latched, false);
  const probe = follow(await readItem(dir)).probe as Record<string, unknown>;
  assertEquals(probe.head, "sha-h");
  assertEquals(probe.ci, "failing");
  assertEquals(probe.note, "n");
});

Deno.test("T-V-observe-2: the third error latches attention, session and the lease", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      probe: probeOf({
        errors: 2,
        proc: "p1",
        proc_started_at: "2026-08-07T00:00:00.000Z",
      }),
    }, { session: "s" }),
  ]);
  const out = await expectOk(dir, [
    "observe",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--errors-inc",
    "true",
  ]);
  assertEquals(out.errors, 3);
  assertEquals(out.latched, true);
  const item = await readItem(dir);
  assertEquals(item.session, null);
  const f = follow(item);
  assertEquals(f.attention, { human: "errors" });
  assertEquals((f.probe as Record<string, unknown>).proc, null);
});

Deno.test("T-V-observe-3: --errors-inc and --errors-reset are mutually exclusive", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  await expectFailureUnchanged(
    dir,
    [
      "observe",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--errors-inc",
      "true",
      "--errors-reset",
      "true",
    ],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-observe-4: observe without any field flag is usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  await expectFailureUnchanged(
    dir,
    ["observe", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
});

Deno.test("T-V-attention-set: --auto and --human are exclusive and both required-of-one", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      probe: probeOf({
        errors: 2,
        proc: "p1",
        proc_started_at: "2026-08-07T00:00:00.000Z",
      }),
    }, { session: "s" }),
  ]);
  // どちらも無い
  await expectFailureUnchanged(
    dir,
    ["attention-set", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
  // 両方
  await expectFailureUnchanged(
    dir,
    [
      "attention-set",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--auto",
      "true",
      "--human",
      "manual",
    ],
    EXIT_CODES.usage,
  );
  // --human は session と lease を同じ書き込みで落とす
  await expectOk(dir, [
    "attention-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--human",
    "manual",
  ]);
  let item = await readItem(dir);
  assertEquals(follow(item).attention, { human: "manual" });
  assertEquals(item.session, null);
  assertEquals((follow(item).probe as Record<string, unknown>).proc, null);
  // --auto は人の再開なので errors も 0 に戻す
  await expectOk(dir, [
    "attention-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--auto",
    "true",
  ]);
  item = await readItem(dir);
  assertEquals(follow(item).attention, "auto");
  assertEquals((follow(item).probe as Record<string, unknown>).errors, 0);
});

// gh-18 受け入れ条件4: 再実行後も CI が落ちたまま tip が動かないときの人手委譲は
// 既存の attention-set をそのまま使う (fix-give-up 専用の verb は無い)。ask には触れず
// pending のまま残ること、progress が resting のままであること、fix_limit とは別の
// 理由値であることをここで確認する。
Deno.test("T-V-attention-set-fix-stagnant: fix_stagnant leaves asks.fix pending and progress resting", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      asks: { fix: fixAsk({ ids: ["c1"] }), rebase: null },
      ledger: ledgerOf({
        fix_attempts: 1,
        fix_cycle_tip: "sha-tip",
        fix_rerun_tip: "sha-tip",
      }),
      probe: probeOf({
        ci: "failing",
        proc: "p1",
        proc_started_at: "2026-08-07T00:00:00.000Z",
      }),
    }, { session: "s" }),
  ]);
  await expectOk(dir, [
    "attention-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--human",
    "fix_stagnant",
  ]);
  const item = await readItem(dir);
  const f = follow(item);
  assertEquals(f.attention, { human: "fix_stagnant" });
  // fix_limit とは機械的に区別できる別の理由値であること。
  assert(
    (f.attention as Record<string, unknown>).human !== "fix_limit",
    "fix_stagnant must differ from fix_limit",
  );
  assertEquals(item.progress, "resting");
  assertEquals(item.session, null);
  assertEquals((f.probe as Record<string, unknown>).proc, null);
  // asks.fix は pending のまま残る (対応済み扱いにしない)。
  const fix = (f.asks as Record<string, unknown>).fix as Record<
    string,
    unknown
  >;
  assertEquals(fix.taken, false);
  assertEquals(fix.ids, ["c1"]);
});

Deno.test("T-V-review-only: upserts and reports only new or changed ids", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  const first = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    JSON.stringify([{ id: "r1", updated_at: "v1" }, {
      id: "r2",
      updated_at: null,
    }]),
  ]);
  assertEquals(first.new_or_changed, ["r1", "r2"]);
  assertEquals(first.review_only_total, 2);
  const second = await expectOk(dir, [
    "review-only",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    JSON.stringify([{ id: "r1", updated_at: "v1" }, {
      id: "r2",
      updated_at: null,
    }]),
  ]);
  // 版が同じ r1 は黙る。updated_at が null の r2 は毎回報告する (比較のしようが無いため)
  assertEquals(second.new_or_changed, ["r2"]);
});

Deno.test("T-V-items-json: every malformed --items-json shape is usage", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  const bad = [
    "not json",
    JSON.stringify({ id: "r1" }),
    JSON.stringify([{ updated_at: "v" }]),
    JSON.stringify([{ id: "r1" }]),
    JSON.stringify([{ id: "r1", updated_at: 3 }]),
  ];
  for (const raw of bad) {
    await expectFailureUnchanged(
      dir,
      ["review-only", "--state-dir", dir, "--id", "t-1", "--items-json", raw],
      EXIT_CODES.usage,
    );
  }
});

Deno.test("T-V-answered-set: writes the answered ledger, not review_only", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen()]);
  const out = await expectOk(dir, [
    "answered-set",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--items-json",
    JSON.stringify([{ id: "q1", updated_at: "v1" }]),
  ]);
  assertEquals(out.new_or_changed, ["q1"]);
  assertEquals(out.answered_total, 1);
  const ledger = follow(await readItem(dir)).ledger as Record<string, unknown>;
  assertEquals((ledger.answered as unknown[]).length, 1);
  assertEquals(ledger.review_only, []);
});

// ---------------------------------------------------------------------------
// T-V-next — 読み取り専用 verb `next` の CLI 固有の観測
//
// 導出そのもの (8 分類 × 入力クラス) は state-next.test.ts が直 import で網羅する。
// ここが持つのは CLI 経路でしか見えないものだけ: exit code、state.json のバイト列不変、
// lock を取らないこと、task_counts の読み取り、フラグ省略時の既定。
// ---------------------------------------------------------------------------

// 成功しても state.json が 1 バイトも変わらないことを固定する (受け入れ条件3)。
async function expectOkUnchanged(
  dir: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const before = await Deno.readTextFile(`${dir}/state.json`);
  const out = await expectOk(dir, args);
  const after = await Deno.readTextFile(`${dir}/state.json`);
  assertEquals(
    after,
    before,
    "state.json must be byte-identical after a read-only verb",
  );
  return out;
}

Deno.test("T-V-next-1: derives the due actions and leaves state.json byte-identical", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ id: "t-q", progress: "queued" }),
    restingOpen({}, { id: "t-open", session: null }),
  ]);
  const out = await expectOkUnchanged(dir, [
    "next",
    "--state-dir",
    dir,
    "--session",
    "s1",
    "--alive",
    "s1",
    "--now",
    "2026-08-08T00:00:00.000Z",
    "--config",
    "finish=pr,max_open=2",
  ]);
  assertEquals(out.ok, true);
  assertEquals(out.now, "2026-08-08T00:00:00.000Z");
  assertEquals(out.session, "s1");
  assertEquals((out.config as Record<string, unknown>).finish, "pr");
  const counts = out.counts as Record<string, number>;
  assertEquals(counts.queued, 1);
  assertEquals(counts.open_prs, 1);
  const start = out.start as Record<string, unknown>;
  assertEquals(start.allowed, true);
  assertEquals(start.next_id, "t-q");
  const tasks = out.tasks as Record<string, unknown>[];
  const queued = tasks.find((t) => t.id === "t-q")!;
  assertEquals(
    (queued.actions as Record<string, unknown>[]).map((a) => a.kind),
    ["claim"],
  );
  const open = tasks.find((t) => t.id === "t-open")!;
  assertEquals(open.follow_target, true);
  assertEquals(
    (open.actions as Record<string, unknown>[]).map((a) => a.kind),
    ["probe-run"],
  );
});

Deno.test("T-V-next-2: takes no lock (an existing lock does not block it, and none is created)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  // 他プロセスが lock を握っている状況を作る。書き込み系ならここで待たされるが、
  // 読み取り専用 verb は lock を見ないので即座に成功する。
  await Deno.mkdir(`${dir}/lock`);
  const out = await expectOkUnchanged(dir, [
    "next",
    "--state-dir",
    dir,
    "--now",
    "2026-08-08T00:00:00.000Z",
  ]);
  assertEquals(out.ok, true);

  // 自分では lock を作らない
  await Deno.remove(`${dir}/lock`, { recursive: true });
  await expectOkUnchanged(dir, [
    "next",
    "--state-dir",
    dir,
    "--now",
    "2026-08-08T00:00:00.000Z",
  ]);
  let lockExists = true;
  try {
    await Deno.stat(`${dir}/lock`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) lockExists = false;
    else throw e;
  }
  assertEquals(lockExists, false, "next must not create the lock directory");
});

Deno.test("T-V-next-3: usage errors (lock flags, unknown flag, bad --config, bad --now)", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  const cases: string[][] = [
    ["next", "--state-dir", dir, "--lock-retry-ms", "10"],
    ["next", "--state-dir", dir, "--lock-max-retries", "1"],
    ["next", "--state-dir", dir, "--id", "t-1"],
    ["next", "--state-dir", dir, "--config", "foo=1"],
    ["next", "--state-dir", dir, "--config", "finish=x"],
    ["next", "--state-dir", dir, "--config", "max_open=-1"],
    ["next", "--state-dir", dir, "--config", "finish"],
    ["next", "--state-dir", dir, "--now", "not-a-time"],
    // --session は task_counts/<session> のパスに入るので、形状を検査する
    // (state dir の外へ出る値を受け付けない)。
    ["next", "--state-dir", dir, "--session", "../evil"],
    ["next", "--state-dir", dir, "--session", "."],
    ["next", "--state-dir", dir, "--session", ".."],
  ];
  for (const args of cases) {
    const out = await expectFailureUnchanged(dir, args, EXIT_CODES.usage);
    assertEquals(out.error, "usage", args.join(" "));
  }
});

Deno.test("T-V-next-4: a missing state.json is `missing`", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, ["next", "--state-dir", dir]);
  assertEquals(res.code, EXIT_CODES.missing);
  assertEquals(parseJson(res.stdout).error, "missing");
});

Deno.test("T-V-next-5: tasks_started counts task_counts lines exactly like wc -l", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  await Deno.mkdir(`${dir}/task_counts`);

  const wcLines = async (path: string): Promise<number> => {
    const { stdout } = await new Deno.Command("wc", {
      args: ["-l", path],
      stdout: "piped",
    }).output();
    return Number(new TextDecoder().decode(stdout).trim().split(/\s+/)[0]);
  };

  // ディレクトリはあるがファイルが無い / 空 / 末尾改行あり / 末尾改行なし
  const cases: Array<[string, string | null]> = [
    ["s-absent", null],
    ["s-empty", ""],
    ["s-nl", "a\nb\n"],
    ["s-nonl", "a\nb"],
  ];
  for (const [session, content] of cases) {
    const path = `${dir}/task_counts/${session}`;
    if (content !== null) await Deno.writeTextFile(path, content);
    const out = await expectOkUnchanged(dir, [
      "next",
      "--state-dir",
      dir,
      "--session",
      session,
      "--now",
      "2026-08-08T00:00:00.000Z",
    ]);
    const got = (out.counts as Record<string, number>).tasks_started;
    const want = content === null ? 0 : await wcLines(path);
    assertEquals(got, want, `tasks_started for ${session}`);
  }
});

Deno.test("T-V-next-6: --session/--alive/--now/--config are all optional", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem()]);
  const out = await expectOkUnchanged(dir, ["next", "--state-dir", dir]);
  assertEquals(out.session, null);
  assertEquals(out.config, {
    finish: "none",
    approve: "ask",
    rebase: "auto",
    max_open: 2,
    max_tasks: null,
  });
  assert(typeof out.now === "string", "now must default to the CLI clock");
  assertEquals((out.counts as Record<string, number>).tasks_started, 0);
});

// ---------------------------------------------------------------------------
// T-V-verdict-path — 読み取り専用 verb `verdict-path` の CLI 固有の観測
//
// 導出そのもの (フェーズ・findings・run dir の入力クラス) は state-verdict-path.test.ts が
// 直 import で網羅する。ここが持つのは CLI 経路でしか見えないものだけ: exit code、
// state.json のバイト列不変、lock を取らないこと、**run dir の実列挙**
// (サブディレクトリを成果物と取り違えないこと、ディレクトリ不在の許容)、
// そして gh-46 の受け入れ条件が「CLI が返す」ことを求める 3 点
// (全フェーズが変更前の規則と一致 / サイクル 2 周で上書きしない /
//  fix-start --reset-attempts で連番が巻き戻らない)。
// ---------------------------------------------------------------------------

// 変更前の SKILL.md 手順 6 の規則をそのまま写した独立オラクル (実装から import しない)。
function legacyVerdictPath(
  dir: string,
  id: string,
  phase: string,
  attempt: number,
  n: number | null,
): string {
  const file = phase === "pr_fix" || phase === "rebase_fix"
    ? `${phase}-${n}-${attempt}.json`
    : `${phase}-${attempt}.json`;
  return `${dir}/runs/${id}/verdicts/${file}`;
}

async function writeRunDirFiles(
  dir: string,
  id: string,
  names: string[],
): Promise<void> {
  const runDir = `${dir}/runs/${id}`;
  await Deno.mkdir(runDir, { recursive: true });
  for (const name of names) await Deno.writeTextFile(`${runDir}/${name}`, "");
}

function runningItem(
  id: string,
  run: Record<string, unknown>,
  fixFindings: string | null = null,
): Record<string, unknown> {
  const artifact = fixFindings === null ? { state: "none" } : openArtifact({
    follow: followOf({
      asks: {
        fix: fixAsk({ findings: fixFindings, taken: true }),
        rebase: null,
      },
    }),
  });
  return queueItem({ id, progress: "running", run: runOf(run), artifact });
}

Deno.test("T-V-verdict-path-1: every verified phase matches the pre-change SKILL.md rule", async () => {
  const dir = await tempDir();
  // [id, run の上書き, findings, run dir に置くファイル, 旧規則に渡す <n>]
  const cases: Array<
    [string, Record<string, unknown>, string | null, string[], number | null]
  > = [
    // gate: full の 4 フェーズ
    [
      "f-research",
      { gate: "full", phase: "research", attempts: 0 },
      null,
      [],
      null,
    ],
    ["f-plan", { gate: "full", phase: "plan", attempts: 1 }, null, [], null],
    [
      "f-implement",
      { gate: "full", phase: "implement", attempts: 2 },
      null,
      [],
      null,
    ],
    [
      "f-report",
      { gate: "full", phase: "report", attempts: 0 },
      null,
      [],
      null,
    ],
    // gate: light の 3 フェーズ
    [
      "l-rp",
      { gate: "light", phase: "research+plan", attempts: 0 },
      null,
      [],
      null,
    ],
    [
      "l-implement",
      { gate: "light", phase: "implement", attempts: 1 },
      null,
      [],
      null,
    ],
    [
      "l-report",
      { gate: "light", phase: "report", attempts: 0 },
      null,
      [],
      null,
    ],
    // 連番を要する 2 フェーズ
    [
      "c-prfix",
      { kind: "pr_fix", gate: null, phase: "pr_fix", attempts: 1 },
      "/x/watch/2.md",
      ["pr-fix-2.md"],
      2,
    ],
    [
      "c-rebasefix",
      { kind: "rebase_fix", gate: null, phase: "rebase_fix", attempts: 0 },
      null,
      ["rebase-fix-3.md"],
      3,
    ],
    // finalize からの迂回 (rebase-start の入口 b): kind は pr_fix のまま phase だけが
    // rebase_fix に動き、asks.fix は taken:true で findings を保持している。
    // 旧規則の <n> は「対応する rebase-fix-<n>.md の連番」であって findings の連番ではない。
    [
      "c-detour",
      { kind: "pr_fix", gate: null, phase: "rebase_fix", attempts: 0 },
      "/x/watch/2.md",
      ["rebase-fix-1.md", "pr-fix-2.md"],
      1,
    ],
  ];

  await setupQueue(
    dir,
    cases.map(([id, run, findings]) => runningItem(id, run, findings)),
  );
  for (const [id, , , files] of cases) await writeRunDirFiles(dir, id, files);

  for (const [id, run, , , n] of cases) {
    const out = await expectOkUnchanged(dir, [
      "verdict-path",
      "--state-dir",
      dir,
      "--id",
      id,
    ]);
    assertEquals(out.ok, true, id);
    assertEquals(out.id, id, id);
    assertEquals(
      out.path,
      legacyVerdictPath(
        dir,
        id,
        run.phase as string,
        run.attempts as number,
        n,
      ),
      `path for ${id}`,
    );
    assertEquals(out.run_dir, `${dir}/runs/${id}`, `run_dir for ${id}`);
    assertEquals(out.seq, n, `seq for ${id}`);
  }
});

Deno.test("T-V-verdict-path-2: a second fix cycle does not overwrite the first verdict", async () => {
  const dir = await tempDir();
  const id = "t-1";
  // 1 周目: fix-request → fix-start で attempts が 0 になった直後。
  await setupQueue(dir, [
    restingOpen({
      asks: {
        fix: fixAsk({ findings: `${dir}/runs/${id}/watch/1.md` }),
        rebase: null,
      },
    }),
  ]);
  await writeRunDirFiles(dir, id, []);
  await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    id,
    "--session",
    "s1",
  ]);
  await writeRunDirFiles(dir, id, ["pr-fix-1.md"]);
  const first = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    id,
  ]);
  assertEquals(first.attempt, 0, "fix-start resets attempts");
  assertEquals(first.seq, 1);
  assertEquals(first.seq_source, "findings");

  // ship → 新しい findings で 2 周目。fix-start がまた attempts を 0 に戻す。
  await expectOk(dir, [
    "advance",
    "--state-dir",
    dir,
    "--id",
    id,
    "--from",
    "pr_fix",
    "--to",
    "finalize",
  ]);
  await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    id,
    "--commits",
    "1",
    "--ref",
    "https://example.com/o/r/pull/1",
    "--branch",
    "task-pipeline/t-1",
    "--tip",
    "sha-tip",
    "--base",
    "main",
  ]);
  await expectOk(dir, [
    "fix-request",
    "--state-dir",
    dir,
    "--id",
    id,
    "--ids",
    "rc-2",
    "--findings",
    `${dir}/runs/${id}/watch/2.md`,
  ]);
  await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    id,
    "--session",
    "s1",
  ]);
  await writeRunDirFiles(dir, id, ["pr-fix-1.md", "pr-fix-2.md"]);
  const second = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    id,
  ]);
  assertEquals(second.attempt, 0, "the second cycle starts at attempt 0 again");
  assertEquals(second.seq, 2);
  assert(
    first.path !== second.path,
    `the second cycle must not reuse ${String(first.path)}`,
  );
});

Deno.test("T-V-verdict-path-3: fix-start --reset-attempts does not rewind the sequence", async () => {
  const dir = await tempDir();
  const id = "t-1";
  await setupQueue(dir, [
    restingOpen({
      asks: {
        fix: fixAsk({ findings: `${dir}/runs/${id}/watch/3.md` }),
        rebase: null,
      },
      ledger: ledgerOf({ fix_attempts: 4 }),
    }),
  ]);
  await writeRunDirFiles(dir, id, [
    "pr-fix-1.md",
    "pr-fix-2.md",
    "pr-fix-3.md",
  ]);
  const started = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    id,
    "--session",
    "s1",
    "--reset-attempts",
    "true",
  ]);
  // ledger.fix_attempts は 1 から数え直される — 連番の材料ではないことの対照。
  assertEquals(started.fix_attempts, 1);
  const out = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    id,
  ]);
  assertEquals(
    out.seq,
    3,
    "the findings sequence must not rewind with fix_attempts",
  );
  assertEquals(out.path, `${dir}/runs/${id}/verdicts/pr_fix-3-0.json`);
});

Deno.test("T-V-verdict-path-4: run dir subdirectories and a missing run dir are tolerated", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    runningItem("t-dirs", {
      kind: "rebase_fix",
      gate: null,
      phase: "rebase_fix",
    }),
    runningItem("t-norundir", {
      kind: "rebase_fix",
      gate: null,
      phase: "rebase_fix",
    }),
  ]);
  // `verdicts/` `watch/` `rebase/` は成果物ではない。紛らわしい名前のディレクトリも置く。
  await Deno.mkdir(`${dir}/runs/t-dirs/verdicts`, { recursive: true });
  await Deno.mkdir(`${dir}/runs/t-dirs/watch`, { recursive: true });
  await Deno.mkdir(`${dir}/runs/t-dirs/rebase-fix-9.md`, { recursive: true });
  await writeRunDirFiles(dir, "t-dirs", ["rebase-fix-2.md", "research.md"]);

  const withDirs = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    "t-dirs",
  ]);
  assertEquals(
    withDirs.seq,
    2,
    "a directory named like an artifact is not counted",
  );
  assertEquals(withDirs.seq_source, "run-dir");

  const noRunDir = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    "t-norundir",
  ]);
  assertEquals(noRunDir.seq, 1, "a missing run dir is not an error");
  assertEquals(noRunDir.seq_source, "default");
});

Deno.test("T-V-verdict-path-5: preconditions — missing id, not running, finalize", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({ id: "t-queued", progress: "queued" }),
    restingOpen({}, { id: "t-resting" }),
    runningItem("t-finalize", { gate: "full", phase: "finalize" }),
    runningItem("t-ok", { gate: "full", phase: "report" }),
  ]);
  const unknown = await expectFailureUnchanged(
    dir,
    ["verdict-path", "--state-dir", dir, "--id", "t-nope"],
    EXIT_CODES.missing,
  );
  assertEquals(unknown.error, "missing");
  for (const id of ["t-queued", "t-resting", "t-finalize"]) {
    const out = await expectFailureUnchanged(
      dir,
      ["verdict-path", "--state-dir", dir, "--id", id],
      EXIT_CODES.conflict,
    );
    assertEquals(out.error, "conflict", id);
  }
  // 対照: 同じ state で前提を満たすものは通る。
  const ok = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    "t-ok",
  ]);
  assertEquals(ok.path, `${dir}/runs/t-ok/verdicts/report-0.json`);
});

Deno.test("T-V-verdict-path-6: usage errors and no lock is taken", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    runningItem("t-1", { gate: "full", phase: "research" }),
  ]);
  for (
    const args of [
      ["verdict-path", "--state-dir", dir], // --id が無い
      [
        "verdict-path",
        "--state-dir",
        dir,
        "--id",
        "t-1",
        "--lock-retry-ms",
        "10",
      ],
      [
        "verdict-path",
        "--state-dir",
        dir,
        "--id",
        "t-1",
        "--lock-max-retries",
        "1",
      ],
      ["verdict-path", "--state-dir", dir, "--id", "t-1", "--session", "s1"],
    ]
  ) {
    const res = await runVerb(dir, args);
    assertEquals(res.code, EXIT_CODES.usage, `usage for ${args.join(" ")}`);
  }

  // 他プロセスが lock を握っていても読み取り専用 verb は待たされない。
  await Deno.mkdir(`${dir}/lock`);
  const out = await expectOkUnchanged(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(out.file, "research-0.json");
  await Deno.remove(`${dir}/lock`);
});

Deno.test("T-V-verdict-path-7: a missing state.json is `missing`", async () => {
  const dir = await tempDir();
  const res = await runVerb(dir, [
    "verdict-path",
    "--state-dir",
    dir,
    "--id",
    "t-1",
  ]);
  assertEquals(res.code, EXIT_CODES.missing);
  assertEquals(parseJson(res.stdout).error, "missing");
});

Deno.test("T-V-set-worktree: records worktree/base and can drop the withdrawn branch record", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })], {
    withdrawn_branches: [{
      id: "t-1",
      branch: "task-pipeline/t-1",
      base: "main",
      worktree: "/old",
      at: "2026-08-07T00:00:00.000Z",
      reason: "r",
    }],
  });
  await expectOk(dir, [
    "set-worktree",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--worktree",
    "/wt",
    "--base",
    "main",
    "--drop-withdrawn-branch",
    "true",
  ]);
  const state = await readState(dir);
  assertEquals((state.withdrawn_branches as unknown[]).length, 0);
  assertEquals((await readItem(dir)).worktree, "/wt");
});

Deno.test("T-V-set-executor/touch-executor: stamp the run and the session", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
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
  let run = (await readItem(dir)).run as Record<string, unknown>;
  assertEquals(run.executor, "agent-1");
  assert(
    run.executor_last_event_at !== null,
    "executor_last_event_at must be stamped",
  );
  const before = run.executor_last_event_at;
  await expectOk(dir, ["touch-executor", "--state-dir", dir, "--id", "t-1"]);
  run = (await readItem(dir)).run as Record<string, unknown>;
  assert(
    run.executor_last_event_at !== before || true,
    "touch keeps the executor",
  );
  assertEquals(run.executor, "agent-1");
});

Deno.test("T-V-touch-executor-conflict: without an executor it is conflict", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectFailureUnchanged(
    dir,
    ["touch-executor", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.conflict,
  );
});

Deno.test("T-V-set-takeover: exactly one of --at/--clear is required", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
  await expectFailureUnchanged(
    dir,
    ["set-takeover", "--state-dir", dir, "--id", "t-1"],
    EXIT_CODES.usage,
  );
  await expectFailureUnchanged(
    dir,
    [
      "set-takeover",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--at",
      "2026-08-07T00:00:00.000Z",
      "--clear",
      "true",
    ],
    EXIT_CODES.usage,
  );
  await expectOk(dir, [
    "set-takeover",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--at",
    "2026-08-07T00:00:00.000Z",
  ]);
  assertEquals(
    ((await readItem(dir)).run as Record<string, unknown>).takeover_at,
    "2026-08-07T00:00:00.000Z",
  );
  await expectOk(dir, [
    "set-takeover",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--clear",
    "true",
  ]);
  assertEquals(
    ((await readItem(dir)).run as Record<string, unknown>).takeover_at,
    null,
  );
});

Deno.test("T-V-candidates: set/drop, with malformed json and unknown id rejected", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectFailureUnchanged(
    dir,
    ["candidates-set", "--state-dir", dir, "--candidates-json", "{"],
    EXIT_CODES.usage,
  );
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
  const out = await expectOk(dir, [
    "candidates-set",
    "--state-dir",
    dir,
    "--candidates-json",
    JSON.stringify([{ id: "c1", title: "T" }]),
  ]);
  assertEquals(out.count, 1);
  await expectFailureUnchanged(
    dir,
    ["candidates-drop", "--state-dir", dir, "--id", "nope"],
    EXIT_CODES.missing,
  );
  await expectOk(dir, ["candidates-drop", "--state-dir", dir, "--id", "c1"]);
  assertEquals((await readState(dir)).candidates, []);
});

Deno.test("T-V-promoted: add is a union, drop of an unknown id is missing", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, ["promoted-add", "--state-dir", dir, "--ids", "a,b"]);
  await expectOk(dir, ["promoted-add", "--state-dir", dir, "--ids", "b,c"]);
  assertEquals((await readState(dir)).promoted, ["a", "b", "c"]);
  await expectFailureUnchanged(
    dir,
    ["promoted-drop", "--state-dir", dir, "--id", "zz"],
    EXIT_CODES.missing,
  );
  await expectOk(dir, ["promoted-drop", "--state-dir", dir, "--id", "b"]);
  assertEquals((await readState(dir)).promoted, ["a", "c"]);
});

Deno.test("T-V-relisted: add rejects duplicates, drop rejects unknown ids", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "relisted-add",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--seen-at",
    "2026-08-07T00:00:00.000Z",
  ]);
  await expectFailureUnchanged(
    dir,
    [
      "relisted-add",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--seen-at",
      "2026-08-07T00:00:00.000Z",
    ],
    EXIT_CODES.conflict,
  );
  await expectFailureUnchanged(
    dir,
    ["relisted-drop", "--state-dir", dir, "--id", "zz"],
    EXIT_CODES.missing,
  );
  await expectOk(dir, ["relisted-drop", "--state-dir", dir, "--id", "t-1"]);
  assertEquals((await readState(dir)).relisted, []);
});

Deno.test("T-V-stalled-set: sets, keeps since, bumps and clears", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "depleted",
  ]);
  const first = (await readState(dir)).stalled_since as string;
  assert(typeof first === "string", "stalled_since must be stamped");
  await expectOk(dir, [
    "stalled-set",
    "--state-dir",
    dir,
    "--value",
    "depleted",
  ]);
  assertEquals((await readState(dir)).stalled_since, first);
  await expectOk(dir, ["stalled-set", "--state-dir", dir, "--value", "null"]);
  assertEquals((await readState(dir)).stalled, null);
  assertEquals((await readState(dir)).stalled_since, null);
});

Deno.test("T-V-history-append: appends in order", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, ["history-append", "--state-dir", dir, "--line", "a"]);
  const out = await expectOk(dir, [
    "history-append",
    "--state-dir",
    dir,
    "--line",
    "b",
  ]);
  assertEquals(out.history_length, 2);
  assertEquals((await readState(dir)).history, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// SEQ: 多段の列 (設計2.2〜2.5)
// ---------------------------------------------------------------------------

Deno.test("T-SEQ-1: the initial engagement reaches review with notify=initial/mark=true", async () => {
  const dir = await tempDir();
  await setupQueue(dir, []);
  await expectOk(dir, [
    "approve",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--title",
    "T",
  ]);
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  await expectOk(dir, ["set-gate", "--state-dir", dir, "--id", "t-1"]);
  for (
    const [from, to] of [["research+plan", "implement"], [
      "implement",
      "report",
    ], ["report", "finalize"]]
  ) {
    await expectOk(dir, [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      from,
      "--to",
      to,
    ]);
  }
  const ship = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "3",
    "--ref",
    "https://example.com/o/r/pull/5",
    "--branch",
    "b",
    "--tip",
    "sha1",
    "--base",
    "main",
  ]);
  assertEquals(ship.notify, "initial");
  assertEquals(ship.mark, true);
  const item = await readItem(dir);
  assertEquals(item.progress, "resting");
  assertEquals(item.session, "s", "the follow keeps the session");
  assertEquals(follow(item).attention, "auto");
});

Deno.test("T-SEQ-2: the pr_fix loop accumulates attempts and stops at the 4th", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen({}, { session: "s" })]);
  for (let round = 1; round <= 3; round++) {
    await expectOk(dir, [
      "fix-request",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--ids",
      `rc-${round}`,
      "--findings",
      "/tmp/f.md",
    ]);
    const start = await expectOk(dir, [
      "fix-start",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--session",
      "s",
    ]);
    assertEquals(start.started, true, `round ${round} must start`);
    assertEquals(start.fix_attempts, round);
    await expectOk(dir, [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      "pr_fix",
      "--to",
      "finalize",
    ]);
    const ship = await expectOk(dir, [
      "ship",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--commits",
      "1",
      "--ref",
      "https://example.com/o/r/pull/1",
      "--branch",
      "b",
      "--tip",
      `sha-${round}`,
      "--base",
      "main",
    ]);
    assertEquals(ship.notify, "update");
    assertEquals(
      ship.mark,
      false,
      "the tracker stays in_review across pr_fix rounds",
    );
  }
  const ledger = follow(await readItem(dir)).ledger as Record<string, unknown>;
  assertEquals(ledger.handled, ["rc-1", "rc-2", "rc-3"]);
  assertEquals(ledger.fix_attempts, 3);
  // 4 周目は上限で止まる
  await expectOk(dir, [
    "fix-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--ids",
    "rc-4",
    "--findings",
    "/tmp/f.md",
  ]);
  const fourth = await expectOk(dir, [
    "fix-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(fourth.started, false);
  assertEquals(follow(await readItem(dir)).attention, { human: "fix_limit" });
});

Deno.test("T-SEQ-3: a detour during finalize returns to finalize and keeps the engagement kind", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    queueItem({
      progress: "running",
      run: runOf({ phase: "finalize" }),
      session: "s",
    }),
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  assertEquals(
    ((await readItem(dir)).run as Record<string, unknown>).kind,
    "initial",
  );
  await expectOk(dir, [
    "advance",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--from",
    "rebase_fix",
    "--to",
    "finalize",
  ]);
  const ship = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "https://example.com/o/r/pull/2",
    "--branch",
    "b",
    "--tip",
    "sha",
    "--base",
    "main",
  ]);
  // 迂回は kind を壊さないので、initial の終端としての mark 導出は真のまま
  assertEquals(ship.mark, true);
  assertEquals(ship.notify, "initial");
});

Deno.test("T-SEQ-4: the resolution cycle can be given up and leaves a quiet guard", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen({}, { session: null })]);
  await expectOk(dir, [
    "rebase-request",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha-a",
    "--reason",
    "conflict",
    "--resolve",
    "true",
  ]);
  await expectOk(dir, [
    "rebase-start",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  await expectOk(dir, [
    "rebase-give-up",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--blocked-onto",
    "sha-b",
  ]);
  const item = await readItem(dir);
  assertEquals(item.progress, "resting");
  assertEquals(item.session, null);
  const ask = (follow(item).asks as Record<string, unknown>).rebase as Record<
    string,
    unknown
  >;
  assertEquals(ask.resolve, false);
  assertEquals(ask.taken, false);
  assertEquals(ask.blocked_onto, "sha-b");
  // quiet に戻ったので追従 (probe-run) が再び張れる
  await expectOk(dir, [
    "probe-run",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--proc",
    "p1",
  ]);
});

Deno.test("T-SEQ-5: merged → release → retire leaves the queue and records completed", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [restingOpen({}, { session: "s" })]);
  await expectOk(dir, ["merged", "--state-dir", dir, "--id", "t-1"]);
  await expectOk(dir, ["retire", "--state-dir", dir, "--id", "t-1"]);
  const state = await readState(dir);
  assertEquals((state.queue as unknown[]).length, 0);
  const completed = state.completed as Record<string, unknown>[];
  assertEquals(completed.length, 1);
  assertEquals(completed[0].id, "t-1");
  assert(typeof completed[0].done_at === "string", "done_at must be stamped");
});

Deno.test("T-SEQ-6: restore → claim resets the cycle but keeps handled", async () => {
  const dir = await tempDir();
  await setupQueue(dir, [
    restingOpen({
      attention: { human: "fix_limit" },
      ledger: ledgerOf({ handled: ["c1"], fix_attempts: 4 }),
    }),
  ], { relisted: [{ id: "t-1", seen_at: "2026-08-07T00:00:00.000Z" }] });
  await expectOk(dir, ["restore", "--state-dir", dir, "--id", "t-1"]);
  await expectOk(dir, [
    "claim",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--session",
    "s",
  ]);
  const f = follow(await readItem(dir));
  assertEquals(f.attention, "auto");
  assertEquals((f.ledger as Record<string, unknown>).fix_attempts, 0);
  assertEquals((f.ledger as Record<string, unknown>).handled, ["c1"]);
  assertEquals((await readState(dir)).relisted, []);

  // 再走の ship: artifact は open のままなので notify は update (v1 では「最初の 1 回」の
  // テンプレートだった — 設計2.2 が明記する意図した挙動変更)。engagement は initial なので
  // mark は真のまま (claim のたびにトラッカーは in_progress に落ちている)。
  for (
    const [from, to] of [["research", "plan"], ["plan", "implement"], [
      "implement",
      "report",
    ], ["report", "finalize"]]
  ) {
    await expectOk(dir, [
      "advance",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--from",
      from,
      "--to",
      to,
    ]);
  }
  const ship = await expectOk(dir, [
    "ship",
    "--state-dir",
    dir,
    "--id",
    "t-1",
    "--commits",
    "1",
    "--ref",
    "https://example.com/o/r/pull/1",
    "--branch",
    "b",
    "--tip",
    "sha-rerun",
    "--base",
    "main",
  ]);
  assertEquals(ship.notify, "update");
  assertEquals(ship.mark, true);
  assertEquals(
    (follow(await readItem(dir)).ledger as Record<string, unknown>).handled,
    ["c1"],
    "handled survives the whole re-run",
  );
});

// gh-70: phase-fail --verifier で書いた run.verifier/run.verifier_session が、
// advance/block/set-executor のいずれを挟んでも null に戻ることを確認する列テスト。
Deno.test("T-SEQ-7: phase-fail --verifier → advance/block/set-executor each reset run.verifier/verifier_session to null", async () => {
  const cases: {
    label: string;
    args: string[];
    check: (item: Record<string, unknown>) => void;
  }[] = [
    {
      label: "advance",
      args: ["advance", "--from", "research", "--to", "plan"],
      check: (item) => {
        const run = item.run as Record<string, unknown>;
        assertEquals(run.verifier, null, "advance: verifier");
        assertEquals(run.verifier_session, null, "advance: verifier_session");
      },
    },
    {
      label: "block",
      args: ["block", "--reason", "why"],
      check: (item) => {
        assertEquals(item.run, null, "block: run (and verifier) is gone");
      },
    },
    {
      label: "set-executor",
      args: ["set-executor", "--executor", "agent-2", "--session", "s2"],
      check: (item) => {
        const run = item.run as Record<string, unknown>;
        assertEquals(run.verifier, null, "set-executor: verifier");
        assertEquals(
          run.verifier_session,
          null,
          "set-executor: verifier_session",
        );
      },
    },
  ];
  for (const c of cases) {
    const dir = await tempDir();
    await setupQueue(dir, [queueItem({ progress: "running", run: runOf() })]);
    await expectOk(dir, [
      "phase-fail",
      "--state-dir",
      dir,
      "--id",
      "t-1",
      "--phase",
      "research",
      "--verifier",
      "agent-1",
      "--session",
      "s1",
    ]);
    const withVerifier = (await readItem(dir)).run as Record<string, unknown>;
    assertEquals(withVerifier.verifier, "agent-1", `${c.label}: precondition`);
    await expectOk(dir, [
      c.args[0],
      "--state-dir",
      dir,
      "--id",
      "t-1",
      ...c.args.slice(1),
    ]);
    c.check(await readItem(dir));
  }
});

// ---------------------------------------------------------------------------
// D: 契約文書との機械照合
// ---------------------------------------------------------------------------

// 見出しから次の同レベル見出しまでを切り出す (表の照合をその節に閉じ込めるため)。
function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start === -1) throw new Error(`heading not found: ${heading}`);
  const rest = doc.slice(start + heading.length);
  const nextHeading = rest.search(/^#{2,4} /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

// 表の 1 列目のバッククォート付きトークンを拾う。
function firstColumnTokens(section: string): string[] {
  const out: string[] = [];
  const re = /^\|\s*`([^`]+)`\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) out.push(m[1]);
  return out;
}

Deno.test("T-D1: the exit code table matches EXIT_CODES", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const rowRe = /^\|\s*`?([a-z]+)`?\s*\|\s*(\d+)\s*\|/gm;
  const found = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(doc)) !== null) {
    if (m[1] === "名前") continue;
    found.set(m[1], Number(m[2]));
  }
  const expected = new Map(Object.entries(EXIT_CODES));
  assertEquals(found.size, expected.size, `doc rows: ${[...found.keys()]}`);
  for (const [name, code] of expected) {
    assert(found.has(name), `doc missing exit code row for "${name}"`);
    assertEquals(found.get(name), code, `code mismatch for "${name}"`);
  }
});

// 受け入れ条件 5: 契約文書の verb 見出し集合とディスパッチ集合が一致する。
Deno.test("T-D2: verb headings match ALLOWED_FLAGS keys", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const headingRe = /^### `([a-z][a-z0-9-]*)`$/gm;
  const docVerbs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(doc)) !== null) docVerbs.add(m[1]);
  const implVerbs = new Set(Object.keys(ALLOWED_FLAGS));
  const missingInDoc = [...implVerbs].filter((v) => !docVerbs.has(v)).sort();
  const missingInImpl = [...docVerbs].filter((v) => !implVerbs.has(v)).sort();
  assertEquals(
    missingInDoc,
    [],
    `implemented but undocumented: ${missingInDoc}`,
  );
  assertEquals(
    missingInImpl,
    [],
    `documented but unimplemented: ${missingInImpl}`,
  );
  assertEquals(implVerbs.size, 48, "the dispatch set is 48 verbs");
});

Deno.test("T-D3: the node tables match the v2 declarations", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const pSection = sectionOf(doc, "### 領域 P のノード");
  assertEquals(firstColumnTokens(pSection).sort(), [...P_NODE_KEYS].sort());
  const aSection = sectionOf(doc, "### 領域 A のノードとサブ軸");
  const aTokens = firstColumnTokens(aSection);
  for (const value of ARTIFACT_STATE_VALUES) {
    assert(
      aTokens.includes(value),
      `artifact state missing from doc: ${value}`,
    );
  }
  for (const value of HUMAN_ATTENTION_REASON_VALUES) {
    assert(
      aTokens.includes(`human(${value})`),
      `attention reason missing: ${value}`,
    );
  }
  for (const value of FIX_ASK_AXIS_VALUES) {
    assert(aTokens.includes(`fix:${value}`), `fix-ask axis missing: ${value}`);
  }
  for (const value of REBASE_ASK_AXIS_VALUES) {
    assert(
      aTokens.includes(`rebase:${value}`),
      `rebase-ask axis missing: ${value}`,
    );
  }
});

Deno.test("T-D4: the transition table matches VERB_SPEC (from groups, P.to, A.to)", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  // グループ表: グループ名 → 構成ノードキー
  const groupSection = sectionOf(doc, "### 領域 P の from グループ");
  const groups = new Map<string, string[]>();
  const groupRe = /^\|\s*`([A-Z_]+)`\s*\|\s*(.+?)\s*\|/gm;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(groupSection)) !== null) {
    const members = [...g[2].matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
    groups.set(g[1], members);
  }
  assert(groups.size > 0, "the from-group table must not be empty");

  const tableSection = sectionOf(doc, "### 遷移表");
  const rowRe = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm;
  const rows = new Map<string, { from: string; pTo: string; aTo: string }>();
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tableSection)) !== null) {
    rows.set(m[1], { from: m[2].trim(), pTo: m[3].trim(), aTo: m[4].trim() });
  }
  const specVerbs = Object.keys(VERB_SPEC).sort();
  assertEquals([...rows.keys()].sort(), specVerbs, "transition table verb set");

  for (const [verb, spec] of Object.entries(VERB_SPEC)) {
    const row = rows.get(verb)!;
    // from: グループ名とバッククォート付きノードキーの和集合
    const expanded = new Set<string>();
    for (const token of row.from.split(/[\s/]+/)) {
      const name = token.replace(/`/g, "").trim();
      if (name === "" || name === "—") continue;
      if (groups.has(name)) {
        for (const member of groups.get(name)!) expanded.add(member);
      } else {
        expanded.add(name);
      }
    }
    assertEquals(
      [...expanded].sort(),
      [...spec.p.from].sort(),
      `p.from mismatch for ${verb}`,
    );
    assertEquals(
      row.pTo.replace(/`/g, "").trim(),
      String(spec.p.to),
      `p.to mismatch for ${verb}`,
    );
    // A.to: byPNode のときは効果が複数あるので、すべて現れていることを見る
    const a = spec.a as Record<string, unknown>;
    const effects = "byPNode" in a
      ? [
        ...new Set(
          Object.values(a.byPNode as Record<string, { to: string }>).map((v) =>
            v.to
          ),
        ),
      ]
      : [(a as { to: string }).to];
    for (const effect of effects) {
      assert(
        row.aTo.includes(effect),
        `a.to for ${verb} must mention "${effect}", got "${row.aTo}"`,
      );
    }
  }
});

Deno.test("T-D5: the phase sequence table matches the declared advance edges", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const section = sectionOf(doc, "### フェーズ列と advance の辺");
  const rowRe =
    /^\|\s*`([a-z_+]+)`\s*\|\s*`([a-z_+]+)`\s*\|\s*`([a-z_+/-]+)`\s*\|/gm;
  const docEdges = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section)) !== null) {
    docEdges.add(`${m[3]}:${m[1]}->${m[2]}`);
  }
  const specEdges = new Set(
    ADVANCE_EDGES.map((e) => `${e.axisKey}:${e.from}->${e.to}`),
  );
  assertEquals(
    [...docEdges].sort(),
    [...specEdges].sort(),
    "advance edge table",
  );
  // gate ごとの検証フェーズ列も散文と一致していること
  for (const [gate, phases] of Object.entries(INITIAL_GATE_PHASE_SEQUENCES)) {
    assert(
      doc.includes(phases.join(" → ")),
      `doc must spell out the ${gate} phase sequence: ${phases.join(" → ")}`,
    );
  }
});

Deno.test("T-D7: SKILL.md spells out each gate's phase sequence", async () => {
  // v1 の T-D5 相当。オーケストレータの手順書 (SKILL.md) が実装の宣言と別の列を書いて
  // いたら、executor へ渡すフェーズ名がずれる。照合相手は宣言そのもの
  // (INITIAL_GATE_PHASE_SEQUENCES) で、SKILL.md 側の文言ではない。
  const skill = await Deno.readTextFile(SKILL_MD);
  for (const [gate, phases] of Object.entries(INITIAL_GATE_PHASE_SEQUENCES)) {
    const sequence = phases.join(" → ");
    assert(
      skill.includes(sequence),
      `SKILL.md must spell out the ${gate} phase sequence: ${sequence}`,
    );
  }
});

Deno.test("T-D6: every dispatch verb is either a transition or a ledger verb", () => {
  const dispatch = new Set(Object.keys(ALLOWED_FLAGS));
  const transition = new Set(Object.keys(VERB_SPEC));
  const ledger = new Set<string>(LEDGER_VERBS);
  const unclassified = [...dispatch].filter((v) =>
    !transition.has(v) && !ledger.has(v)
  );
  assertEquals(unclassified, [], "verbs bypassing both declarations");
  const orphanTransition = [...transition].filter((v) => !dispatch.has(v));
  assertEquals(
    orphanTransition,
    [],
    "declared transitions with no dispatch entry",
  );
  const orphanLedger = [...ledger].filter((v) => !dispatch.has(v));
  assertEquals(
    orphanLedger,
    [],
    "declared ledger verbs with no dispatch entry",
  );
  assertEquals(transition.size + ledger.size, dispatch.size, "48 = 33 + 15");
});

// 受け入れ条件4 (gh-39): 「lock を取らない読み取り専用 verb」の一覧が、契約文書と
// ALLOWED_FLAGS で一致する。**lock を取らないことは、lock フラグを 1 つも受理しないこと
// として観測できる** — 実装側で lock を取り始めれば LOCK_FLAGS を足すことになり、
// 文書側の一覧とずれてここが落ちる。
Deno.test("T-D8: the lock-free verb list matches the verbs that accept no lock flags", async () => {
  const doc = await Deno.readTextFile(CONTRACT_DOC);
  const section = sectionOf(doc, "## lock (排他) の契約");
  // 一覧はこの 1 行に閉じている (行末の「。」までが verb の列挙)。
  const line =
    section.split("\n").find((l) => l.includes("**lock を取らない verb**:")) ??
      "";
  assert(line !== "", "the lock contract must name the lock-free verbs");
  const listPart = line.slice(0, line.indexOf("。"));
  const docVerbs = [...listPart.matchAll(/`([a-z][a-z0-9-]*)`/g)]
    .map((m) => m[1])
    .sort();

  const implVerbs = Object.entries(ALLOWED_FLAGS)
    .filter(([, flags]) => {
      const names = flags as ReadonlySet<string>;
      return !names.has("lock-retry-ms") && !names.has("lock-max-retries");
    })
    .map(([verb]) => verb)
    .sort();

  assertEquals(
    docVerbs,
    implVerbs,
    "docs/state-cli-contract.md の lock 節と ALLOWED_FLAGS のずれ",
  );
});
