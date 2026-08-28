// task-pipeline/scripts/state-next.test.ts
//
// state-next.ts (読み取り専用 verb `next` の導出本体) のユニットテスト。
//
// テスト名は `next/<分類キー>: …` の形で、設計 5.1 の導出 8 分類に対応する 8 キー
// (ownership / follow / cycle / finalize / liveness / start / retire / observation) が
// すべて現れる。CLI 経路 (exit code・state.json のバイト列不変・lock 非取得) の観測は
// state.test.ts が持つ。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出して実行する)
//       単体なら deno test task-pipeline/scripts/state-next.test.ts (Deno API を呼ばないので
//       権限フラグは不要)。8 分類が揃っているかの検査は下の nextTest / DERIVATION_KEYS が持つ。

import {
  countTaskLines,
  DEFAULT_NEXT_CONFIG,
  deriveNext,
  type NextAction,
  type NextConfig,
  type NextInput,
  type NextResult,
  type NextTask,
  parseNextConfig,
} from "./state-next.ts";
import { CliErrorV2 } from "./state-transitions-v2.ts";
import type {
  V2Artifact,
  V2FixAsk,
  V2Follow,
  V2Item,
  V2Probe,
  V2RebaseAsk,
  V2Run,
  V2State,
} from "./state-transitions-v2.ts";

// ---------------------------------------------------------------------------
// テスト登録 — 設計 5.1 の導出 8 分類の網羅を固定する
//
// テスト名は `next/<分類キー>: …` の形。nextTest はキーを拾って集め、ファイル末尾で
// 8 分類が揃っていることを検査する (揃っていなければモジュール読み込み時に throw し、
// deno test はこのファイルごと失敗する)。
//
// この検査は旧 tests/state-next.test.sh:48-61 が `deno test` の出力を grep して行っていた
// もので、ラッパー削除 (#11 要求 6) の移設先がここになる。Deno.test や t.step を足すと
// 移行前後で件数が変わってしまうため、テストではなくモジュールの不変条件として置いている。
// ---------------------------------------------------------------------------

const DERIVATION_KEYS = [
  "ownership",
  "follow",
  "cycle",
  "finalize",
  "liveness",
  "start",
  "retire",
  "observation",
] as const;

const seenDerivationKeys = new Set<string>();

function nextTest(name: string, fn: () => void): void {
  const m = /^next\/([a-z_]+):/.exec(name);
  if (m) seenDerivationKeys.add(m[1]);
  Deno.test(name, fn);
}

// ---------------------------------------------------------------------------
// アサーション (外部依存を増やさないため自前。state-model-v2.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

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

// 投げたエラーを返す (コードの検査を呼び出し側で続けるため)。
function assertThrowsCli(fn: () => unknown, msg?: string): CliErrorV2 {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliErrorV2) return e;
    throw new Error(
      `${msg ?? "assertThrowsCli"}: expected CliErrorV2, got ${String(e)}`,
    );
  }
  throw new Error(`${msg ?? "assertThrowsCli"}: no error was thrown`);
}

// ---------------------------------------------------------------------------
// フィクスチャの組み立て
// ---------------------------------------------------------------------------

const SELF = "session-self";
const OTHER = "session-other";
const NOW = "2026-08-08T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function isoMinutesAgo(min: number): string {
  return new Date(NOW_MS - min * 60_000).toISOString();
}

function probe(overrides: Partial<V2Probe> = {}): V2Probe {
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

function fixAsk(overrides: Partial<V2FixAsk> = {}): V2FixAsk {
  return {
    ids: ["c1"],
    findings: "/runs/x/watch/findings-1.md",
    taken: false,
    ...overrides,
  };
}

function rebaseAsk(overrides: Partial<V2RebaseAsk> = {}): V2RebaseAsk {
  return {
    blocked_onto: "deadbeef",
    reason: "conflict",
    at: isoMinutesAgo(10),
    kind: null,
    cause: null,
    report: null,
    from_tip: null,
    resolve: false,
    taken: false,
    ...overrides,
  };
}

function follow(overrides: Partial<V2Follow> = {}): V2Follow {
  return {
    attention: "auto",
    asks: { fix: null, rebase: null },
    ledger: {
      handled: [],
      fix_attempts: 0,
      review_only: [],
      answered: [],
      fix_cycle_tip: null,
      fix_rerun_tip: null,
    },
    probe: probe(),
    ...overrides,
  };
}

function openArtifact(overrides: Partial<V2Artifact> = {}): V2Artifact {
  return {
    state: "open",
    ref: "https://github.com/o/r/pull/7",
    branch: "task-pipeline/t-1",
    tip: "abc123",
    base: "main",
    follow: follow(),
    ...overrides,
  } as V2Artifact;
}

const NONE_ARTIFACT: V2Artifact = { state: "none" };

function mergedArtifact(overrides: Record<string, unknown> = {}): V2Artifact {
  return {
    state: "merged",
    ref: "https://github.com/o/r/pull/7",
    branch: "task-pipeline/t-1",
    tip: "abc123",
    base: "main",
    ...overrides,
  } as V2Artifact;
}

function withdrawnArtifact(): V2Artifact {
  return {
    state: "withdrawn",
    ref: "https://github.com/o/r/pull/7",
    branch: "task-pipeline/t-1",
    tip: "abc123",
    base: "main",
    asked: false,
    note: null,
  };
}

function run(overrides: Partial<V2Run> = {}): V2Run {
  return {
    kind: "initial",
    gate: "full",
    phase: "implement",
    attempts: 0,
    executor: "agent-1",
    executor_last_event_at: isoMinutesAgo(1),
    takeover_at: null,
    verifier: null,
    verifier_session: null,
    ...overrides,
  };
}

function item(id: string, overrides: Partial<V2Item> = {}): V2Item {
  return {
    id,
    title: `title ${id}`,
    progress: "resting",
    run: null,
    blocked_reason: null,
    artifact: NONE_ARTIFACT,
    worktree: `/wt/${id}`,
    base: "main",
    session: SELF,
    ...overrides,
  };
}

function state(queue: V2Item[], overrides: Partial<V2State> = {}): V2State {
  return {
    tracker: "gh",
    source: "",
    updated_at: NOW,
    queue,
    candidates: [],
    relisted: [],
    promoted: [],
    completed: [],
    withdrawn_branches: [],
    history: [],
    history_archived: 0,
    schema_version: 2,
    ...overrides,
  };
}

function input(overrides: Partial<NextInput> = {}): NextInput {
  return {
    session: SELF,
    alive: [SELF],
    now: NOW,
    config: DEFAULT_NEXT_CONFIG,
    tasksStarted: 0,
    deadEvidence: [],
    ...overrides,
  };
}

function config(overrides: Partial<NextConfig>): NextConfig {
  return { ...DEFAULT_NEXT_CONFIG, ...overrides };
}

function taskOf(result: NextResult, id: string): NextTask {
  const found = result.tasks.find((t) => t.id === id);
  assert(found !== undefined, `task not found in result: ${id}`);
  return found;
}

function actionKinds(task: NextTask): string[] {
  return task.actions.map((a) => a.kind);
}

function actionOf<K extends NextAction["kind"]>(
  task: NextTask,
  kind: K,
): Extract<NextAction, { kind: K }> {
  const found = task.actions.find((a) => a.kind === kind);
  assert(
    found !== undefined,
    `action ${kind} not found; got [${actionKinds(task).join(", ")}]`,
  );
  return found as Extract<NextAction, { kind: K }>;
}

// ---------------------------------------------------------------------------
// 設定 (--config) のパース
// ---------------------------------------------------------------------------

nextTest("next/config: 省略・空文字は既定値", () => {
  assertEquals(parseNextConfig(undefined), DEFAULT_NEXT_CONFIG);
  assertEquals(parseNextConfig(""), DEFAULT_NEXT_CONFIG);
  assertEquals(DEFAULT_NEXT_CONFIG, {
    finish: "none",
    approve: "ask",
    rebase: "auto",
    max_open: 2,
    max_tasks: null,
  });
});

nextTest("next/config: 既知キーを受理する", () => {
  assertEquals(
    parseNextConfig("finish=pr,approve=auto,rebase=off,max_open=3,max_tasks=5"),
    {
      finish: "pr",
      approve: "auto",
      rebase: "off",
      max_open: 3,
      max_tasks: 5,
    },
  );
  // 0 は合法 (「常に上限」の意味を持つ境界値)
  assertEquals(parseNextConfig("max_open=0").max_open, 0);
  assertEquals(parseNextConfig("max_tasks=0").max_tasks, 0);
});

nextTest("next/config: 未知キー・= 無し・enum 外・整数でない値は usage", () => {
  for (
    const raw of [
      "foo=1",
      "finish",
      "=pr",
      "finish=x",
      "approve=maybe",
      "rebase=sometimes",
      "max_open=",
      "max_open=-1",
      "max_open=1e2",
      "max_tasks= 3",
    ]
  ) {
    const err = assertThrowsCli(
      () => parseNextConfig(raw),
      `--config ${JSON.stringify(raw)}`,
    );
    assertEquals(err.code, "usage", `for ${raw}`);
  }
});

nextTest("next/config: 同じキーは後勝ち", () => {
  assertEquals(parseNextConfig("max_open=1,max_open=4").max_open, 4);
  assertEquals(parseNextConfig("finish=pr,finish=commit").finish, "commit");
});

nextTest("next/config: --now がパースできなければ usage", () => {
  const err = assertThrowsCli(() =>
    deriveNext(state([]), input({ now: "not-a-time" }))
  );
  assertEquals(err.code, "usage");
});

// ---------------------------------------------------------------------------
// 1. 担当判定
// ---------------------------------------------------------------------------

nextTest(
  "next/ownership: session の 4 パターンを分類し alive-other だけ excluded",
  () => {
    const result = deriveNext(
      state([
        item("t-self", { session: SELF }),
        item("t-unowned", { session: null }),
        item("t-dead", { session: "session-gone" }),
        item("t-alive-other", { session: OTHER }),
      ]),
      input({ alive: [SELF, OTHER] }),
    );
    assertEquals(taskOf(result, "t-self").ownership, "self");
    assertEquals(taskOf(result, "t-unowned").ownership, "unowned");
    assertEquals(taskOf(result, "t-dead").ownership, "dead");
    assertEquals(taskOf(result, "t-alive-other").ownership, "alive-other");
    assertEquals(
      result.tasks.filter((t) => t.excluded).map((t) => t.id),
      ["t-alive-other"],
    );
    assertEquals(result.counts.excluded, 1);
  },
);

nextTest(
  "next/ownership: --session 省略なら非 null の session は他 id 扱い",
  () => {
    const result = deriveNext(
      state([item("t-1", { session: OTHER })]),
      input({ session: "", alive: [OTHER] }),
    );
    assertEquals(result.session, null);
    assertEquals(taskOf(result, "t-1").ownership, "alive-other");
    assertEquals(taskOf(result, "t-1").excluded, true);
  },
);

nextTest(
  "next/ownership: excluded なタスクには actions も observations も出さない",
  () => {
    // 除外が無ければ必ず action が出る 3 つの形を、すべて生きている他セッション所有にする。
    const result = deriveNext(
      state([
        // (i) 追従対象でリースが無い → 除外が無ければ probe-run
        item("t-probe", {
          progress: "resting",
          session: OTHER,
          artifact: openArtifact(),
        }),
        // (ii) 沈黙した実行 → 除外が無ければ status-check / set-takeover
        item("t-silent", {
          progress: "running",
          session: OTHER,
          run: run({ executor_last_event_at: isoMinutesAgo(300) }),
        }),
        // (iii) 回収済み → 除外が無ければ retire
        item("t-merged", {
          progress: "resting",
          session: OTHER,
          artifact: mergedArtifact(),
        }),
      ]),
      input({ alive: [SELF, OTHER] }),
    );

    for (const id of ["t-probe", "t-silent", "t-merged"]) {
      const task = taskOf(result, id);
      assertEquals(task.ownership, "alive-other", id);
      assertEquals(task.excluded, true, id);
      assertEquals(task.actions, [], `${id}: actions must be empty`);
      assertEquals(task.observations, [], `${id}: observations must be empty`);
    }
    assertEquals(result.counts.excluded, 3);
    // 非除外の集計にも入らない
    assertEquals(result.counts.resting, 0);
    assertEquals(result.counts.running, 0);
  },
);

// ---------------------------------------------------------------------------
// 2. 追従の要否と probe リース
// ---------------------------------------------------------------------------

nextTest("next/follow: 追従対象の導出式は連言項を 1 つ崩すと外れる", () => {
  const liveProbe = probe({
    proc: "bash-1",
    proc_started_at: isoMinutesAgo(1),
    sig: "sig-1",
  });
  const cases: Array<[string, V2Item, boolean]> = [
    [
      "all",
      item("t-all", { artifact: openArtifact({ follow: follow() }) }),
      true,
    ],
    [
      "progress",
      item("t-progress", {
        progress: "running",
        run: run(),
        artifact: openArtifact(),
      }),
      false,
    ],
    ["artifact", item("t-artifact", { artifact: mergedArtifact() }), false],
    [
      "follow-null",
      item("t-follow", { artifact: openArtifact({ follow: null }) }),
      false,
    ],
    [
      "attention",
      item("t-attention", {
        artifact: openArtifact({
          follow: follow({ attention: { human: "manual" }, probe: liveProbe }),
        }),
      }),
      false,
    ],
    [
      "fix-pending",
      item("t-fix", {
        artifact: openArtifact({
          follow: follow({
            asks: { fix: fixAsk(), rebase: null },
            probe: liveProbe,
          }),
        }),
      }),
      false,
    ],
    [
      "rebase-queued",
      item("t-rebase", {
        artifact: openArtifact({
          follow: follow({
            asks: { fix: null, rebase: rebaseAsk({ resolve: true }) },
            probe: liveProbe,
          }),
        }),
      }),
      false,
    ],
  ];
  for (const [label, fixture, expected] of cases) {
    const result = deriveNext(state([fixture]), input());
    assertEquals(taskOf(result, fixture.id).follow_target, expected, label);
  }
});

nextTest("next/follow: リースの失効理由と 7 時間の境界", () => {
  const build = (p: V2Probe, session: string | null = SELF) =>
    item("t-1", {
      session,
      artifact: openArtifact({ follow: follow({ probe: p }) }),
    });

  // proc が無い
  let result = deriveNext(state([build(probe())]), input());
  assertEquals(actionOf(taskOf(result, "t-1"), "probe-run").reason, "no-lease");

  // 所有者が生存一覧に無い
  result = deriveNext(
    state([
      build(
        probe({ proc: "bash-1", proc_started_at: isoMinutesAgo(1) }),
        "gone",
      ),
    ]),
    input(),
  );
  assertEquals(
    actionOf(taskOf(result, "t-1"), "probe-run").reason,
    "owner-dead",
  );

  // 7 時間ちょうど → 失効
  result = deriveNext(
    state([
      build(probe({ proc: "bash-1", proc_started_at: isoMinutesAgo(7 * 60) })),
    ]),
    input(),
  );
  assertEquals(actionOf(taskOf(result, "t-1"), "probe-run").reason, "expired");

  // 7 時間より前 → 有効 (action 無し)
  result = deriveNext(
    state([
      build(
        probe({ proc: "bash-1", proc_started_at: isoMinutesAgo(7 * 60 - 1) }),
      ),
    ]),
    input(),
  );
  assertEquals(actionKinds(taskOf(result, "t-1")), []);

  // proc はあるが開始時刻が無い → 失効扱い
  result = deriveNext(state([build(probe({ proc: "bash-1" }))]), input());
  assertEquals(actionOf(taskOf(result, "t-1"), "probe-run").reason, "expired");
});

nextTest(
  "next/follow: catch_up は sig が null のときだけ、drop_foreign_proc は他人の proc のとき",
  () => {
    const mk = (p: V2Probe, session: string | null) =>
      state([
        item("t-1", {
          session,
          artifact: openArtifact({ follow: follow({ probe: p }) }),
        }),
      ]);

    let action = actionOf(
      taskOf(deriveNext(mk(probe(), SELF), input()), "t-1"),
      "probe-run",
    );
    assertEquals(action.catch_up, true);
    assertEquals(action.drop_foreign_proc, false);

    action = actionOf(
      taskOf(deriveNext(mk(probe({ sig: "s" }), SELF), input()), "t-1"),
      "probe-run",
    );
    assertEquals(action.catch_up, false);

    // 他セッション由来の proc が残っている → 止めずに release で落とすだけ
    action = actionOf(
      taskOf(
        deriveNext(
          mk(
            probe({ proc: "bash-x", proc_started_at: isoMinutesAgo(1) }),
            "gone",
          ),
          input(),
        ),
        "t-1",
      ),
      "probe-run",
    );
    assertEquals(action.drop_foreign_proc, true);

    // 所有者が居ない (session null) のに proc が残っている → これも他人の proc
    action = actionOf(
      taskOf(
        deriveNext(
          mk(
            probe({ proc: "bash-x", proc_started_at: isoMinutesAgo(1) }),
            null,
          ),
          input(),
        ),
        "t-1",
      ),
      "probe-run",
    );
    assertEquals(action.drop_foreign_proc, true);
    assertEquals(action.reason, "owner-dead");
  },
);

// ---------------------------------------------------------------------------
// 3. サイクルの分岐
// ---------------------------------------------------------------------------

nextTest("next/cycle: rebase-ask queued が fix-ask pending に優先する", () => {
  const mk = (fix: V2FixAsk | null, rebase: V2RebaseAsk | null) =>
    state([
      item("t-1", {
        artifact: openArtifact({ follow: follow({ asks: { fix, rebase } }) }),
      }),
    ]);

  // fix だけ
  assertEquals(
    actionKinds(taskOf(deriveNext(mk(fixAsk(), null), input()), "t-1")),
    ["fix-start"],
  );
  // rebase だけ
  assertEquals(
    actionKinds(
      taskOf(
        deriveNext(mk(null, rebaseAsk({ resolve: true })), input()),
        "t-1",
      ),
    ),
    ["rebase-start"],
  );
  // 両方 → rebase 優先
  assertEquals(
    actionKinds(
      taskOf(
        deriveNext(mk(fixAsk(), rebaseAsk({ resolve: true })), input()),
        "t-1",
      ),
    ),
    ["rebase-start"],
  );
  // どちらも無い → 追従対象なので probe-run 側へ回る
  assertEquals(
    actionKinds(taskOf(deriveNext(mk(null, null), input()), "t-1")),
    ["probe-run"],
  );
  // quiet なガード控え (resolve=false) は発火しない
  assertEquals(
    actionKinds(
      taskOf(
        deriveNext(mk(null, rebaseAsk({ resolve: false })), input()),
        "t-1",
      ),
    ),
    ["probe-run"],
  );
});

nextTest(
  "next/cycle: rebase-start は控えの blocked_onto / from_tip を渡す",
  () => {
    const result = deriveNext(
      state([
        item("t-1", {
          artifact: openArtifact({
            follow: follow({
              asks: {
                fix: null,
                rebase: rebaseAsk({
                  resolve: true,
                  blocked_onto: "sha-onto",
                  from_tip: "sha-old",
                }),
              },
            }),
          }),
        }),
      ]),
      input(),
    );
    const action = actionOf(taskOf(result, "t-1"), "rebase-start");
    assertEquals(action.blocked_onto, "sha-onto");
    assertEquals(action.from_tip, "sha-old");
  },
);

nextTest("next/cycle: fix-start の at_limit と reset_attempts の境界", () => {
  const mk = (attempts: number, attention: V2Follow["attention"] = "auto") =>
    state([
      item("t-1", {
        artifact: openArtifact({
          follow: follow({
            attention,
            asks: { fix: fixAsk({ ids: ["c1", "c2"] }), rebase: null },
            ledger: {
              handled: [],
              fix_attempts: attempts,
              review_only: [],
              answered: [],
              fix_cycle_tip: null,
              fix_rerun_tip: null,
            },
          }),
        }),
      }),
    ]);

  const at = (attempts: number) =>
    actionOf(taskOf(deriveNext(mk(attempts), input()), "t-1"), "fix-start");

  assertEquals(at(0).at_limit, false);
  assertEquals(at(0).reset_attempts, false);
  assertEquals(at(0).ids, ["c1", "c2"]);
  assertEquals(at(0).findings, "/runs/x/watch/findings-1.md");
  assertEquals(at(2).at_limit, false);
  // 3 ちょうどで上限ラッチに達する
  assertEquals(at(3).at_limit, true);
  assertEquals(at(3).reset_attempts, false);
  // 3 を超えていて attention が auto = 人が手で戻した後 → リセットして呼ぶ
  assertEquals(at(4).reset_attempts, true);
  assertEquals(at(4).fix_attempts, 4);

  // attention が human ならそもそもサイクルに入らない
  const humanResult = deriveNext(mk(4, { human: "fix_limit" }), input());
  assertEquals(actionKinds(taskOf(humanResult, "t-1")), []);
});

// gh-18: pr_fix を1周して tip が変わらなければ次の周を始めない (空回りの検出)。
// artifact.tip は openArtifact() の既定値 "abc123" を使う。
nextTest(
  "next/cycle: gh-18 tip 不変 × CI failing で fix-start より先に fix-ci-rerun を返す",
  () => {
    const mk = (
      cycleTip: string | null,
      ci: V2Probe["ci"],
      rerunTip: string | null,
    ) =>
      state([
        item("t-1", {
          artifact: openArtifact({
            tip: "abc123",
            follow: follow({
              asks: { fix: fixAsk({ ids: ["c1"] }), rebase: null },
              ledger: {
                handled: [],
                fix_attempts: 1,
                review_only: [],
                answered: [],
                fix_cycle_tip: cycleTip,
                fix_rerun_tip: rerunTip,
              },
              probe: probe({ ci }),
            }),
          }),
        }),
      ]);

    const kindsOf = (
      cycleTip: string | null,
      ci: V2Probe["ci"],
      rerunTip: string | null,
    ) =>
      actionKinds(
        taskOf(deriveNext(mk(cycleTip, ci, rerunTip), input()), "t-1"),
      );

    // クラス A: 直前の周回の tip が現在の tip と違う (=前回 push があった) → 通常続行。
    assertEquals(kindsOf("old-tip", "failing", null), ["fix-start"]);
    // クラス B: tip は不変だが CI は failing でない (レビュー指摘だけの周回、または既に
    // 回復している) → CI 起因の空回りではないので通常続行。
    assertEquals(kindsOf("abc123", "passing", null), ["fix-start"]);
    assertEquals(kindsOf("abc123", "pending", null), ["fix-start"]);
    assertEquals(kindsOf("abc123", null, null), ["fix-start"]);
    // 境界: まだ一度も fix-start していない (fix_cycle_tip が null) → 不一致として扱う。
    assertEquals(kindsOf(null, "failing", null), ["fix-start"]);

    // クラス C: tip 不変 × CI failing × まだこの tip で再実行していない → 再実行 action。
    const rerun = actionOf(
      taskOf(deriveNext(mk("abc123", "failing", null), input()), "t-1"),
      "fix-ci-rerun",
    );
    assertEquals(rerun.tip, "abc123");
    assertEquals(kindsOf("abc123", "failing", null), ["fix-ci-rerun"]);
    // 別の tip で再実行済みなだけでは防げない (tip ごとの記録であることの確認)。
    assertEquals(kindsOf("abc123", "failing", "some-other-tip"), [
      "fix-ci-rerun",
    ]);

    // クラス D: 再実行後も CI が failing のまま tip 不変 → 人へ委ねる (fix-start は返さない)。
    const giveUp = actionOf(
      taskOf(deriveNext(mk("abc123", "failing", "abc123"), input()), "t-1"),
      "fix-give-up",
    );
    assertEquals(giveUp.reason, "fix_stagnant");
    assertEquals(kindsOf("abc123", "failing", "abc123"), ["fix-give-up"]);
  },
);

nextTest("next/cycle: 自分の仕上げが走っているときは release に落ちる", () => {
  const mkQueue = (finishingSession: string | null) => [
    item("t-open", {
      artifact: openArtifact({
        follow: follow({ asks: { fix: fixAsk(), rebase: null } }),
      }),
    }),
    item("t-finishing", {
      progress: "running",
      session: finishingSession,
      run: run({ kind: "pr_fix", gate: null, phase: "pr_fix" }),
      artifact: openArtifact({
        follow: follow({
          asks: { fix: fixAsk({ taken: true }), rebase: null },
        }),
      }),
    }),
  ];

  // 自分の仕上げが走っている → 預けて release
  let result = deriveNext(state(mkQueue(SELF)), input());
  const release = actionOf(taskOf(result, "t-open"), "release");
  assertEquals(release.reason, "finishing-busy");
  assertEquals(release.defer, "fix-start");
  assertEquals(result.counts.running_mine_finishing, 1);

  // 他セッションの仕上げなら自分の枠は空いている
  result = deriveNext(state(mkQueue("gone")), input());
  assertEquals(actionKinds(taskOf(result, "t-open")), ["fix-start"]);
  assertEquals(result.counts.running_mine_finishing, 0);

  // rebase 側も同じ扱い
  const rebaseQueue = mkQueue(SELF);
  rebaseQueue[0] = item("t-open", {
    artifact: openArtifact({
      follow: follow({
        asks: { fix: null, rebase: rebaseAsk({ resolve: true }) },
      }),
    }),
  });
  result = deriveNext(state(rebaseQueue), input());
  assertEquals(
    actionOf(taskOf(result, "t-open"), "release").defer,
    "rebase-start",
  );
});

// ---------------------------------------------------------------------------
// 4. FINALIZED 後の ship 引数構成
// ---------------------------------------------------------------------------

nextTest(
  "next/finalize: finalize フェーズでだけヒントを返し ref_kind は finish 由来",
  () => {
    const mk = (phase: string, kind: V2Run["kind"] = "initial") =>
      state([
        item("t-1", {
          progress: "running",
          run: run({
            kind,
            gate: kind === "initial" ? "full" : null,
            phase,
          }),
        }),
      ]);

    // finalize でないフェーズではヒントを返さない
    assertEquals(
      taskOf(deriveNext(mk("implement"), input()), "t-1").finalize,
      null,
    );

    for (
      const [finish, refKind] of [
        ["pr", "pr"],
        ["commit", "commit"],
        ["none", null],
      ] as const
    ) {
      const result = deriveNext(
        mk("finalize"),
        input({ config: config({ finish }) }),
      );
      const finalize = taskOf(result, "t-1").finalize;
      assert(finalize !== null, `finalize hint expected for finish=${finish}`);
      assertEquals(finalize.ship.ref_kind, refKind, finish);
      assertEquals(finalize.ship.group_flags, ["ref", "branch", "tip", "base"]);
      assertEquals(finalize.ship.branch, "task-pipeline/t-1");
      assertEquals(finalize.ship.base, "main");
      assertEquals(finalize.base, "main");
    }

    // run.kind はそのまま転記される (ship の mark/notify 導出の来歴)
    for (const kind of ["initial", "pr_fix", "rebase_fix"] as const) {
      const result = deriveNext(mk("finalize", kind), input());
      assertEquals(taskOf(result, "t-1").finalize?.run_kind, kind);
    }

    // artifact が open なら既存のブランチ名を使う (restore 再走で切り直さない)
    const openState = state([
      item("t-1", {
        progress: "running",
        run: run({ phase: "finalize" }),
        artifact: openArtifact({ branch: "task-pipeline/legacy" }),
      }),
    ]);
    assertEquals(
      deriveNext(openState, input()).tasks[0].finalize?.ship.branch,
      "task-pipeline/legacy",
    );
  },
);

nextTest("next/finalize: rebase_off は config.rebase だけから来る", () => {
  const mkState = (rebase: V2RebaseAsk | null) =>
    state([
      item("t-1", {
        progress: "running",
        run: run({ phase: "finalize" }),
        artifact: openArtifact({
          follow: follow({ asks: { fix: null, rebase } }),
        }),
      }),
    ]);

  assertEquals(
    deriveNext(mkState(null), input()).tasks[0].finalize?.rebase_off,
    false,
  );
  assertEquals(
    deriveNext(mkState(null), input({ config: config({ rebase: "auto" }) }))
      .tasks[0].finalize?.rebase_off,
    false,
  );
  assertEquals(
    deriveNext(mkState(null), input({ config: config({ rebase: "off" }) }))
      .tasks[0].finalize?.rebase_off,
    true,
  );
  // rebase-forgo が残す quiet なガード控えがあっても、config が auto なら偽のまま
  // (控えは rebase-request --reason dirty|diverged|push でも同じ形で残るため)
  assertEquals(
    deriveNext(
      mkState(rebaseAsk({ reason: "conflict", resolve: false, taken: false })),
      input({ config: config({ rebase: "auto" }) }),
    ).tasks[0].finalize?.rebase_off,
    false,
  );
});

// ---------------------------------------------------------------------------
// 5. 実行の生存管理
// ---------------------------------------------------------------------------

nextTest(
  "next/liveness: takeover_at 経路 (解除 / 30 分ちょうど / 未満)",
  () => {
    const mk = (overrides: Partial<V2Run>) =>
      state([item("t-1", { progress: "running", run: run(overrides) })]);

    // takeover_at より後に executor が動いた → 手を引く
    assertEquals(
      actionKinds(
        taskOf(
          deriveNext(
            mk({
              takeover_at: isoMinutesAgo(40),
              executor_last_event_at: isoMinutesAgo(5),
            }),
            input(),
          ),
          "t-1",
        ),
      ),
      ["clear-takeover"],
    );

    // 30 分ちょうど → 引き継ぐ
    assertEquals(
      actionKinds(
        taskOf(
          deriveNext(
            mk({
              takeover_at: isoMinutesAgo(30),
              executor_last_event_at: isoMinutesAgo(200),
            }),
            input(),
          ),
          "t-1",
        ),
      ),
      ["takeover"],
    );

    // 30 分未満 → 待つ
    const waiting = taskOf(
      deriveNext(
        mk({
          takeover_at: isoMinutesAgo(29),
          executor_last_event_at: isoMinutesAgo(200),
        }),
        input(),
      ),
      "t-1",
    );
    assertEquals(actionOf(waiting, "wait").reason, "takeover-pending");

    // executor_last_event_at が無い場合も前後比較は成立しない → 経過で判断
    assertEquals(
      actionKinds(
        taskOf(
          deriveNext(
            mk({
              takeover_at: isoMinutesAgo(31),
              executor_last_event_at: null,
            }),
            input(),
          ),
          "t-1",
        ),
      ),
      ["takeover"],
    );
  },
);

nextTest("next/liveness: executor が null なら 30 分を待たずに引き継ぐ", () => {
  for (const takeoverAt of [null, isoMinutesAgo(1)]) {
    const result = deriveNext(
      state([
        item("t-1", {
          progress: "running",
          run: run({
            executor: null,
            executor_last_event_at: isoMinutesAgo(1),
            takeover_at: takeoverAt,
          }),
        }),
      ]),
      input(),
    );
    const kinds = actionKinds(taskOf(result, "t-1"));
    // takeover_at が立っている経路では、その分岐が先に効く (待つ)
    assertEquals(
      kinds,
      takeoverAt === null ? ["takeover"] : ["wait"],
      `takeover_at=${takeoverAt}`,
    );
  }
  const action = actionOf(
    taskOf(
      deriveNext(
        state([
          item("t-1", { progress: "running", run: run({ executor: null }) }),
        ]),
        input(),
      ),
      "t-1",
    ),
    "takeover",
  );
  assertEquals(action.reason, "no-executor");
});

nextTest(
  "next/liveness: 90 分ちょうどは稼働中、超で status-check、dead 所有者は set-takeover",
  () => {
    const mk = (min: number | null, session: string | null) =>
      state([
        item("t-1", {
          progress: "running",
          session,
          run: run({
            executor_last_event_at: min === null ? null : isoMinutesAgo(min),
          }),
        }),
      ]);

    // 90 分ちょうど → 稼働中
    const alive = taskOf(deriveNext(mk(90, SELF), input()), "t-1");
    assertEquals(actionOf(alive, "wait").reason, "executor-alive");

    // 90 分より古い → Status check
    assertEquals(
      actionKinds(taskOf(deriveNext(mk(91, SELF), input()), "t-1")),
      ["status-check"],
    );

    // 所有者不明 (unowned) でも SendMessage は試す
    assertEquals(
      actionKinds(taskOf(deriveNext(mk(91, null), input()), "t-1")),
      ["status-check"],
    );

    // 所有セッションが死んでいる → 送らずに引き継ぎ待ちへ
    const dead = taskOf(deriveNext(mk(91, "gone"), input()), "t-1");
    assertEquals(actionOf(dead, "set-takeover").reason, "owner-dead-silent");

    // 時刻が無いのも沈黙扱い
    assertEquals(
      actionKinds(taskOf(deriveNext(mk(null, SELF), input()), "t-1")),
      ["status-check"],
    );
  },
);

nextTest(
  "next/liveness: 引き取りの枠は kind ごとに別で、埋まっていれば wait",
  () => {
    const target = (kind: V2Run["kind"]) =>
      item("t-target", {
        progress: "running",
        session: "gone",
        run: run({
          kind,
          gate: kind === "initial" ? "full" : null,
          phase: kind === "initial" ? "implement" : kind,
          executor: null,
        }),
        artifact: kind === "pr_fix"
          ? openArtifact({
            follow: follow({
              asks: { fix: fixAsk({ taken: true }), rebase: null },
            }),
          })
          : NONE_ARTIFACT,
      });
    const mine = (id: string, kind: V2Run["kind"]) =>
      item(id, {
        progress: "running",
        session: SELF,
        run: run({
          kind,
          gate: kind === "initial" ? "full" : null,
          phase: "implement",
        }),
      });

    // initial の引き取り × 自分の initial が別に居る → 見送る
    let result = deriveNext(
      state([target("initial"), mine("t-mine", "initial")]),
      input(),
    );
    assertEquals(
      actionOf(taskOf(result, "t-target"), "wait").reason,
      "own-slot-busy",
    );

    // initial の引き取り × 自分の仕上げだけ → 枠は別なので引き取る
    result = deriveNext(
      state([target("initial"), mine("t-mine", "pr_fix")]),
      input(),
    );
    assertEquals(actionKinds(taskOf(result, "t-target")), ["takeover"]);

    // 仕上げの引き取り × 自分の仕上げが別に居る → 見送る
    result = deriveNext(
      state([target("pr_fix"), mine("t-mine", "rebase_fix")]),
      input(),
    );
    assertEquals(
      actionOf(taskOf(result, "t-target"), "wait").reason,
      "own-slot-busy",
    );

    // 仕上げの引き取り × 自分の initial だけ → 引き取る
    result = deriveNext(
      state([target("pr_fix"), mine("t-mine", "initial")]),
      input(),
    );
    assertEquals(actionKinds(taskOf(result, "t-target")), ["takeover"]);

    // 自分が所有する同じタスク自身は枠を塞がない (起動し忘れの再起動)
    result = deriveNext(
      state([
        item("t-solo", {
          progress: "running",
          session: SELF,
          run: run({ executor: null }),
        }),
      ]),
      input(),
    );
    assertEquals(actionKinds(taskOf(result, "t-solo")), ["takeover"]);
  },
);

nextTest(
  "next/liveness: takeover は resume_phase / recheck_gate / needs_worktree を返す",
  () => {
    const mk = (
      phase: string,
      gate: V2Run["gate"],
      worktree: string | null,
    ) =>
      state([
        item("t-1", {
          progress: "running",
          worktree,
          run: run({ phase, gate, executor: null }),
        }),
      ]);

    const takeover = (
      phase: string,
      gate: V2Run["gate"],
      worktree: string | null,
    ) =>
      actionOf(
        taskOf(deriveNext(mk(phase, gate, worktree), input()), "t-1"),
        "takeover",
      );

    assertEquals(
      takeover("research", "full", "/wt/x").resume_phase,
      "research",
    );
    assertEquals(takeover("research", "full", "/wt/x").recheck_gate, true);
    assertEquals(takeover("implement", "full", "/wt/x").recheck_gate, false);
    // light は既に降格済みなので gate 判定をやり直す意味が無い
    assertEquals(
      takeover("research+plan", "light", "/wt/x").recheck_gate,
      false,
    );
    assertEquals(takeover("implement", "full", "/wt/x").needs_worktree, false);
    assertEquals(takeover("implement", "full", null).needs_worktree, true);
  },
);

// ---------------------------------------------------------------------------
// 6. 着手可否
// ---------------------------------------------------------------------------

const openWithFollow = (id: string, session: string | null) =>
  item(id, {
    progress: "resting",
    session,
    artifact: openArtifact({
      branch: `task-pipeline/${id}`,
      follow: follow({
        probe: probe({
          proc: "bash-1",
          proc_started_at: isoMinutesAgo(1),
          sig: "s",
        }),
      }),
    }),
  });

nextTest("next/start: open_prs に数えない集合 (拒否側)", () => {
  const rejected: Array<[string, V2Item]> = [
    // 生きている他セッション所有 (excluded)
    ["alive-other", openWithFollow("t-x", OTHER)],
    // finish=commit の open (ref がコミットハッシュ = follow が無い)
    [
      "follow-null",
      item("t-x", {
        progress: "resting",
        artifact: openArtifact({ ref: "abc123", follow: null }),
      }),
    ],
    // 実行中の open
    [
      "running-open",
      item("t-x", {
        progress: "running",
        run: run(),
        artifact: openArtifact(),
      }),
    ],
    // 回収済み
    [
      "merged",
      item("t-x", { progress: "resting", artifact: mergedArtifact() }),
    ],
    // 取り下げ済み
    [
      "withdrawn",
      item("t-x", { progress: "resting", artifact: withdrawnArtifact() }),
    ],
  ];
  for (const [label, fixture] of rejected) {
    const result = deriveNext(
      state([fixture, item("t-q", { progress: "queued", session: null })]),
      input({ alive: [SELF, OTHER], config: config({ max_open: 1 }) }),
    );
    assertEquals(result.counts.open_prs, 0, `${label}: open_prs`);
    assertEquals(
      result.start.blocked_by.includes("max_open"),
      false,
      `${label}: must not block on max_open`,
    );
  }
});

nextTest("next/start: open_prs に数える集合 (self / unowned / dead)", () => {
  for (
    const [label, session] of [
      ["self", SELF],
      ["unowned", null],
      ["dead", "session-gone"],
    ] as Array<[string, string | null]>
  ) {
    const result = deriveNext(
      state([
        openWithFollow("t-open", session),
        item("t-q", { progress: "queued", session: null }),
      ]),
      input({ alive: [SELF, OTHER], config: config({ max_open: 1 }) }),
    );
    assertEquals(result.counts.open_prs, 1, `${label}: open_prs`);
    assertEquals(
      result.start.blocked_by,
      ["max_open"],
      `${label}: must block on max_open`,
    );
  }
});

nextTest("next/start: 拒否側 5 種と受理側 3 種を混ぜても open_prs は 3", () => {
  const result = deriveNext(
    state([
      openWithFollow("t-other", OTHER),
      item("t-commit", {
        progress: "resting",
        artifact: openArtifact({ ref: "abc123", follow: null }),
      }),
      item("t-running", {
        progress: "running",
        run: run(),
        artifact: openArtifact(),
      }),
      item("t-merged", { progress: "resting", artifact: mergedArtifact() }),
      item("t-withdrawn", {
        progress: "resting",
        artifact: withdrawnArtifact(),
      }),
      openWithFollow("t-self", SELF),
      openWithFollow("t-unowned", null),
      openWithFollow("t-dead", "session-gone"),
    ]),
    input({ alive: [SELF, OTHER], config: config({ max_open: 4 }) }),
  );
  assertEquals(result.counts.open_prs, 3);
  assertEquals(result.start.blocked_by.includes("max_open"), false);
});

nextTest("next/start: 新規着手を塞ぐのは running(initial) だけ", () => {
  const queued = item("t-q", { progress: "queued", session: null });
  const mine = (kind: V2Run["kind"], session: string | null = SELF) =>
    item(`t-${kind}`, {
      progress: "running",
      session,
      run: run({ kind, gate: kind === "initial" ? "full" : null }),
    });

  // 自分の仕上げだけ → 着手できる
  for (const kind of ["pr_fix", "rebase_fix"] as const) {
    const result = deriveNext(state([queued, mine(kind)]), input());
    assertEquals(result.counts.running_attendable_initial, 0, kind);
    assertEquals(result.start.blocked_by, [], kind);
    assertEquals(result.start.allowed, true, kind);
    assertEquals(result.start.next_id, "t-q", kind);
    assertEquals(actionKinds(taskOf(result, "t-q")), ["claim"], kind);
  }

  // 自分の initial → 塞ぐ
  let result = deriveNext(state([queued, mine("initial")]), input());
  assertEquals(result.start.blocked_by, ["own_initial"]);
  assertEquals(result.start.next_id, null);
  assertEquals(actionKinds(taskOf(result, "t-q")), []);

  // unowned / dead の initial も引き取り候補なので塞ぐ
  for (const session of [null, "session-gone"]) {
    result = deriveNext(state([queued, mine("initial", session)]), input());
    assertEquals(result.start.blocked_by, ["own_initial"], String(session));
  }

  // 生きている他セッションの initial は塞がない (そちらは inflight_limit の分母)
  result = deriveNext(
    state([queued, mine("initial", OTHER)]),
    input({ alive: [SELF, OTHER] }),
  );
  assertEquals(result.counts.running_attendable_initial, 0);
  assertEquals(result.counts.running_excluded_initial, 1);
  assertEquals(result.start.blocked_by, []);
});

nextTest(
  "next/start: inflight_limit は excluded な initial だけを 2 件から数える",
  () => {
    const queued = item("t-q", { progress: "queued", session: null });
    const other = (id: string, kind: V2Run["kind"]) =>
      item(id, {
        progress: "running",
        session: OTHER,
        run: run({ kind, gate: kind === "initial" ? "full" : null }),
      });

    // 除外された running が 2 件でも、両方仕上げなら上限の対象外
    let result = deriveNext(
      state([queued, other("t-a", "pr_fix"), other("t-b", "rebase_fix")]),
      input({ alive: [SELF, OTHER] }),
    );
    assertEquals(result.counts.running_excluded_initial, 0);
    assertEquals(result.start.blocked_by, []);

    // initial 1 件 → 塞がない
    result = deriveNext(
      state([queued, other("t-a", "initial")]),
      input({ alive: [SELF, OTHER] }),
    );
    assertEquals(result.start.blocked_by, []);

    // initial 2 件ちょうど → 塞ぐ
    result = deriveNext(
      state([queued, other("t-a", "initial"), other("t-b", "initial")]),
      input({ alive: [SELF, OTHER] }),
    );
    assertEquals(result.counts.running_excluded_initial, 2);
    assertEquals(result.start.blocked_by, ["inflight_limit"]);
  },
);

nextTest("next/start: max_tasks / max_open の境界と blocked_by の順序", () => {
  const queued = item("t-q", { progress: "queued", session: null });

  // max_tasks 省略 = 無制限
  assertEquals(
    deriveNext(state([queued]), input({ tasksStarted: 99 })).start.blocked_by,
    [],
  );
  // 1 少ない → 塞がない
  assertEquals(
    deriveNext(
      state([queued]),
      input({ tasksStarted: 2, config: config({ max_tasks: 3 }) }),
    ).start.blocked_by,
    [],
  );
  // ちょうど → 塞ぐ
  assertEquals(
    deriveNext(
      state([queued]),
      input({ tasksStarted: 3, config: config({ max_tasks: 3 }) }),
    ).start.blocked_by,
    ["max_tasks"],
  );
  // max_open=0 は open_prs=0 でも塞ぐ
  assertEquals(
    deriveNext(state([queued]), input({ config: config({ max_open: 0 }) }))
      .start.blocked_by,
    ["max_open"],
  );

  // 複数同時ヒットは優先順に全部列挙する
  const result = deriveNext(
    state([
      queued,
      item("t-mine", {
        progress: "running",
        session: SELF,
        run: run(),
      }),
      openWithFollow("t-open", SELF),
    ]),
    input({
      tasksStarted: 5,
      config: config({ max_tasks: 5, max_open: 1 }),
    }),
  );
  assertEquals(result.start.blocked_by, [
    "max_tasks",
    "own_initial",
    "max_open",
  ]);
  assertEquals(result.start.allowed, false);
  assertEquals(result.start.detail, {
    tasks_started: 5,
    max_tasks: 5,
    running_attendable_initial: 1,
    running_excluded_initial: 0,
    open_prs: 1,
    max_open: 1,
  });
});

nextTest("next/start: countTaskLines は wc -l と同じ意味論", () => {
  assertEquals(countTaskLines(""), 0);
  assertEquals(countTaskLines("a\nb\n"), 2);
  // 末尾改行が無い最終行は数えない
  assertEquals(countTaskLines("a\nb"), 1);
  assertEquals(countTaskLines("\n"), 1);
});

// ---------------------------------------------------------------------------
// 7. 回収の後始末
// ---------------------------------------------------------------------------

nextTest(
  "next/retire: resting × merged に retire を出し release_first は session 由来",
  () => {
    const mk = (session: string | null, worktree: string | null) =>
      state([
        item("t-1", {
          progress: "resting",
          session,
          worktree,
          artifact: mergedArtifact({ branch: "task-pipeline/t-1" }),
        }),
      ]);

    let action = actionOf(
      taskOf(deriveNext(mk(null, "/wt/t-1"), input()), "t-1"),
      "retire",
    );
    assertEquals(action.release_first, false);
    assertEquals(action.cleanup, {
      worktree: "/wt/t-1",
      branch: "task-pipeline/t-1",
    });

    // 揮発資源が残っていれば先に release
    action = actionOf(
      taskOf(deriveNext(mk(SELF, "/wt/t-1"), input()), "t-1"),
      "retire",
    );
    assertEquals(action.release_first, true);

    // worktree が既に片付いていれば cleanup に載せない
    action = actionOf(
      taskOf(deriveNext(mk(null, null), input()), "t-1"),
      "retire",
    );
    assertEquals(action.cleanup.worktree, null);

    // merged は follow を持たないので追従対象ではない
    assertEquals(
      taskOf(deriveNext(mk(null, null), input()), "t-1").follow_target,
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// 8. 観測依頼と停滞
// ---------------------------------------------------------------------------

nextTest(
  "next/observation: merge-proof は open かつ tip 非 null のときだけ",
  () => {
    let result = deriveNext(
      state([
        item("t-1", {
          progress: "resting",
          artifact: openArtifact({
            tip: "sha-tip",
            branch: "task-pipeline/t-1",
          }),
        }),
      ]),
      input(),
    );
    assertEquals(taskOf(result, "t-1").observations, [{
      kind: "merge-proof",
      tip: "sha-tip",
      base: "main",
      branch: "task-pipeline/t-1",
      worktree: "/wt/t-1",
    }]);

    // tip が無い (finish=none でコミット 0 件) → 依頼しない
    result = deriveNext(
      state([
        item("t-1", {
          progress: "resting",
          artifact: openArtifact({ tip: null }),
        }),
      ]),
      input(),
    );
    assertEquals(taskOf(result, "t-1").observations, []);

    // 回収済みには依頼しない
    result = deriveNext(
      state([item("t-1", { progress: "resting", artifact: mergedArtifact() })]),
      input(),
    );
    assertEquals(taskOf(result, "t-1").observations, []);
  },
);

nextTest(
  "next/observation: tracker-list は非除外の queued も running も無いとき",
  () => {
    const listed = (queue: V2Item[]) =>
      deriveNext(state(queue), input({ alive: [SELF, OTHER] })).observations
        .some((o) => o.kind === "tracker-list");

    assertEquals(listed([]), true);
    assertEquals(listed([item("t-q", { progress: "queued" })]), false);
    assertEquals(
      listed([item("t-r", { progress: "running", run: run() })]),
      false,
    );
    assertEquals(
      listed([
        item("t-rest", { progress: "resting", artifact: openArtifact() }),
      ]),
      true,
    );
    // 除外されたタスクとしてだけ存在する場合は「実質無い」ので list を依頼する
    assertEquals(
      listed([
        item("t-q", { progress: "queued", session: OTHER }),
        item("t-r", { progress: "running", session: OTHER, run: run() }),
      ]),
      true,
    );
  },
);

nextTest("next/observation: stalled の set_to / defer / cutoff", () => {
  const queued = item("t-q", { progress: "queued", session: null });

  // 着手できる → null
  assertEquals(deriveNext(state([queued]), input()).stalled.set_to, "null");

  // 自分の飛行中タスクがある → null
  assertEquals(
    deriveNext(
      state([item("t-r", { progress: "running", run: run() })]),
      input(),
    ).stalled.set_to,
    "null",
  );

  // max_open で見送り (queued はある) → max_open
  assertEquals(
    deriveNext(
      state([queued, openWithFollow("t-open", SELF)]),
      input({ config: config({ max_open: 1 }) }),
    ).stalled.set_to,
    "max_open",
  );

  // queued も running も無い → list の結果次第
  let result = deriveNext(state([]), input());
  assertEquals(result.stalled.set_to, "defer");
  assertEquals(result.stalled.defer, {
    if_empty: "depleted",
    otherwise: "null",
  });

  // 同じく list を呼ぶが max_open にも達している
  result = deriveNext(
    state([openWithFollow("t-open", SELF)]),
    input({ config: config({ max_open: 1 }) }),
  );
  assertEquals(result.stalled.set_to, "defer");
  assertEquals(result.stalled.defer, {
    if_empty: "depleted",
    otherwise: "max_open",
  });

  // max_tasks の安全停止は停滞の 2 種類のどちらでもない → 書き換えない
  assertEquals(
    deriveNext(
      state([queued]),
      input({ tasksStarted: 1, config: config({ max_tasks: 1 }) }),
    ).stalled.set_to,
    "keep",
  );

  // cutoff: stalled キーが無い / null / 24 時間ちょうど / 未満
  assertEquals(deriveNext(state([queued]), input()).stalled.cutoff, false);
  assertEquals(deriveNext(state([queued]), input()).stalled.current, null);
  assertEquals(
    deriveNext(
      state([queued], { stalled: null, stalled_since: null }),
      input(),
    ).stalled.cutoff,
    false,
  );
  const cutoffResult = deriveNext(
    state([queued], {
      stalled: "max_open",
      stalled_since: isoMinutesAgo(24 * 60),
    }),
    input(),
  );
  assertEquals(cutoffResult.stalled.cutoff, true);
  assertEquals(cutoffResult.stalled.current, "max_open");
  assertEquals(cutoffResult.stalled.elapsed_min, 24 * 60);
  assertEquals(
    deriveNext(
      state([queued], {
        stalled: "max_open",
        stalled_since: isoMinutesAgo(24 * 60 - 1),
      }),
      input(),
    ).stalled.cutoff,
    false,
  );
  // since が無ければ計時できない
  assertEquals(
    deriveNext(
      state([queued], { stalled: "depleted", stalled_since: null }),
      input(),
    ).stalled.cutoff,
    false,
  );
});

nextTest(
  "next/observation: 応答の骨格 (now / session / config / counts) を返す",
  () => {
    const result = deriveNext(
      state([
        item("t-q", { progress: "queued", session: null }),
        item("t-run", { progress: "running", run: run() }),
        openWithFollow("t-open", SELF),
        item("t-blocked", {
          progress: "blocked",
          blocked_reason: "人待ち",
          session: null,
        }),
        openWithFollow("t-other", OTHER),
      ]),
      input({ alive: [SELF, OTHER], tasksStarted: 2 }),
    );
    assertEquals(result.ok, true);
    assertEquals(result.now, NOW);
    assertEquals(result.session, SELF);
    assertEquals(result.config, DEFAULT_NEXT_CONFIG);
    assertEquals(result.counts, {
      queued: 1,
      running: 1,
      resting: 1,
      blocked: 1,
      excluded: 1,
      open_prs: 1,
      running_attendable_initial: 1,
      running_excluded_initial: 0,
      running_mine_finishing: 0,
      tasks_started: 2,
    });
    // blocked は導出 status も blocked で、アクションは無い
    assertEquals(taskOf(result, "t-blocked").status, "blocked");
    assertEquals(actionKinds(taskOf(result, "t-blocked")), []);
    // 導出 status (設計 1.1)
    assertEquals(taskOf(result, "t-q").status, "approved");
    assertEquals(taskOf(result, "t-run").status, "in_progress");
    assertEquals(taskOf(result, "t-open").status, "in_review");
  },
);

// ---------------------------------------------------------------------------
// N-GATE — gh-70: tasks[].gate.reuse_verifier の4分岐
// ---------------------------------------------------------------------------

Deno.test("N-GATE-1: run.verifier が null → reuse_verifier は null", () => {
  const result = deriveNext(
    state([
      item("t-1", {
        progress: "running",
        run: run({ verifier: null, verifier_session: null }),
      }),
    ]),
    input(),
  );
  assertEquals(taskOf(result, "t-1").gate.reuse_verifier, null);
});

Deno.test("N-GATE-2: verifier 非null・session 一致・attempts<3 → agentId を返す", () => {
  const result = deriveNext(
    state([
      item("t-1", {
        progress: "running",
        run: run({ verifier: "agent-1", verifier_session: SELF, attempts: 1 }),
      }),
    ]),
    input({ session: SELF }),
  );
  assertEquals(taskOf(result, "t-1").gate.reuse_verifier, "agent-1");
});

Deno.test("N-GATE-3: verifier 非null・session 不一致 → reuse_verifier は null", () => {
  const result = deriveNext(
    state([
      item("t-1", {
        progress: "running",
        run: run({ verifier: "agent-1", verifier_session: OTHER, attempts: 1 }),
      }),
    ]),
    input({ session: SELF }),
  );
  assertEquals(taskOf(result, "t-1").gate.reuse_verifier, null);
});

Deno.test("N-GATE-4: verifier 非null・session 一致・attempts>=3 → reuse_verifier は null", () => {
  const result = deriveNext(
    state([
      item("t-1", {
        progress: "running",
        run: run({ verifier: "agent-1", verifier_session: SELF, attempts: 3 }),
      }),
    ]),
    input({ session: SELF }),
  );
  assertEquals(taskOf(result, "t-1").gate.reuse_verifier, null);
});

// ---------------------------------------------------------------------------
// N-CAS — gh-117: CAS の期待値を呼び出し側へ渡す 2 つの材料
// (`gate.attempts` と `takeover` の `replaces`)
// ---------------------------------------------------------------------------

Deno.test("N-CAS-1: gate.attempts は run.attempts をそのまま返し、run が無ければ null", () => {
  const result = deriveNext(
    state([
      item("t-1", { progress: "running", run: run({ attempts: 2 }) }),
      item("t-2", { progress: "queued", run: null, session: null }),
    ]),
    input(),
  );
  assertEquals(taskOf(result, "t-1").gate.attempts, 2);
  assertEquals(taskOf(result, "t-2").gate.attempts, null);
});

Deno.test("N-CAS-2: takeover.replaces は差し替え対象の executor (居なければ null)", () => {
  const withExecutor = deriveNext(
    state([
      item("t-1", {
        progress: "running",
        run: run({
          executor: "agent-1",
          takeover_at: isoMinutesAgo(30),
          executor_last_event_at: isoMinutesAgo(200),
        }),
      }),
    ]),
    input(),
  );
  assertEquals(
    actionOf(taskOf(withExecutor, "t-1"), "takeover").replaces,
    "agent-1",
  );

  const noExecutor = deriveNext(
    state([
      item("t-1", { progress: "running", run: run({ executor: null }) }),
    ]),
    input(),
  );
  const action = actionOf(taskOf(noExecutor, "t-1"), "takeover");
  assertEquals(action.reason, "no-executor");
  assertEquals(action.replaces, null);
});
// gh-114: 孤児の強い証拠 (deadEvidence) — 判定点(A) excluded の上書き / 判定点(B)
// livenessAction の即時 takeover バイパス

Deno.test("N-EVID-1: 孤児の強い証拠がある alive-other は excluded=false", () => {
  const result = deriveNext(
    state([item("t-1", { session: OTHER })]),
    input({ alive: [SELF, OTHER], deadEvidence: ["t-1"] }),
  );
  assertEquals(taskOf(result, "t-1").excluded, false);
});

Deno.test("N-EVID-2: 証拠が無い alive-other は従来どおり excluded=true (回帰)", () => {
  const result = deriveNext(
    state([item("t-1", { session: OTHER })]),
    input({ alive: [SELF, OTHER] }),
  );
  assertEquals(taskOf(result, "t-1").excluded, true);
});

Deno.test("N-EVID-3: self 所有に誤って証拠が付いても excluded は不変 (false)", () => {
  const result = deriveNext(
    state([item("t-1", { session: SELF })]),
    input({ deadEvidence: ["t-1"] }),
  );
  assertEquals(taskOf(result, "t-1").excluded, false);
});

Deno.test("N-EVID-4: 証拠は id が一致するタスクにしか効かない", () => {
  const result = deriveNext(
    state([
      item("t-1", { session: OTHER }),
      item("t-2", { session: OTHER }),
    ]),
    input({ alive: [SELF, OTHER], deadEvidence: ["t-2"] }),
  );
  assertEquals(taskOf(result, "t-1").excluded, true);
  assertEquals(taskOf(result, "t-2").excluded, false);
});

Deno.test(
  "N-EVID-5: alive-other でも証拠が揃えば沈黙未満で即座に takeover(strong-evidence)",
  () => {
    const result = deriveNext(
      state([
        item("t-1", {
          progress: "running",
          session: OTHER,
          run: run(), // executor_last_event_at は1分前 (通常なら wait{executor-alive})
        }),
      ]),
      input({ alive: [SELF, OTHER], deadEvidence: ["t-1"] }),
    );
    const task = taskOf(result, "t-1");
    assertEquals(task.excluded, false);
    assertEquals(actionOf(task, "takeover").reason, "strong-evidence");
  },
);

Deno.test(
  "N-EVID-6: 証拠があっても自分の枠が埋まっていれば own-slot-busy で待つ",
  () => {
    const result = deriveNext(
      state([
        item("t-1", { progress: "running", session: OTHER, run: run() }),
        item("t-mine", {
          progress: "running",
          session: SELF,
          run: run({ kind: "initial" }),
        }),
      ]),
      input({ alive: [SELF, OTHER], deadEvidence: ["t-1"] }),
    );
    assertEquals(
      actionOf(taskOf(result, "t-1"), "wait").reason,
      "own-slot-busy",
    );
  },
);

Deno.test(
  "N-EVID-7: self 所有に証拠が付いても strong-evidence では奪わない (ガード)",
  () => {
    const result = deriveNext(
      state([
        item("t-1", { progress: "running", session: SELF, run: run() }),
      ]),
      input({ deadEvidence: ["t-1"] }),
    );
    const task = taskOf(result, "t-1");
    assertEquals(actionKinds(task), ["wait"]);
    assertEquals(actionOf(task, "wait").reason, "executor-alive");
  },
);

Deno.test(
  "N-EVID-8: 引き継ぎ待ち中でも証拠があれば即座に takeover(strong-evidence)",
  () => {
    const result = deriveNext(
      state([
        item("t-1", {
          progress: "running",
          session: OTHER,
          // takeover_at は1分前 (30分未満なので通常なら wait{takeover-pending})
          run: run({ takeover_at: isoMinutesAgo(1) }),
        }),
      ]),
      input({ alive: [SELF, OTHER], deadEvidence: ["t-1"] }),
    );
    assertEquals(
      actionOf(taskOf(result, "t-1"), "takeover").reason,
      "strong-evidence",
    );
  },
);

Deno.test(
  "N-EVID-9: deadEvidence 空配列は省略時と同じ結果になる (回帰)",
  () => {
    const q = [item("t-1", { session: OTHER })];
    const withField = deriveNext(
      state(q),
      input({ alive: [SELF, OTHER], deadEvidence: [] }),
    );
    const withoutOverride = deriveNext(
      state(q),
      input({ alive: [SELF, OTHER] }),
    );
    assertEquals(
      taskOf(withField, "t-1").excluded,
      taskOf(withoutOverride, "t-1").excluded,
    );
    assertEquals(taskOf(withField, "t-1").excluded, true);
  },
);

Deno.test(
  "N-EVID-10: unowned でも証拠が揃えば即座に takeover(strong-evidence)",
  () => {
    const result = deriveNext(
      state([
        item("t-1", { progress: "running", session: null, run: run() }),
      ]),
      input({ deadEvidence: ["t-1"] }),
    );
    const task = taskOf(result, "t-1");
    assertEquals(task.excluded, false);
    assertEquals(actionOf(task, "takeover").reason, "strong-evidence");
  },
);

Deno.test(
  "N-EVID-11: dead 所有権でも証拠があれば沈黙未満で即座に takeover(strong-evidence)",
  () => {
    const result = deriveNext(
      state([
        item("t-1", {
          progress: "running",
          session: "session-gone",
          run: run(),
        }),
      ]),
      input({ alive: [SELF], deadEvidence: ["t-1"] }),
    );
    const task = taskOf(result, "t-1");
    assertEquals(task.excluded, false);
    assertEquals(actionOf(task, "takeover").reason, "strong-evidence");
  },
);

// N-LEASE — Controller Lease による実ディスパッチの抑制 (gh-156)
//
// 抑制するのは Driver が実際に実行する 3 種 (claim / takeover / status-check) だけである。
// 残りの 9 種と tracker-list を落とすと誰も実行しなくなるので、非抑制側のケースが
// 「抑制しすぎ」の退行を捕まえる本体になる。

const DRIVER = "driver-x";

function lease(
  overrides: Partial<{ session: string; epoch: number; acquired_at: string }> =
    {},
): { session: string; epoch: number; acquired_at: string } {
  return { session: DRIVER, epoch: 100, acquired_at: NOW, ...overrides };
}

/** Driver が生きている前提の入力 (台帳に driver が載っている)。 */
function underLease(overrides: Partial<NextInput> = {}): NextInput {
  return input({ alive: [SELF, DRIVER], ...overrides });
}

nextTest(
  "next/start: 有効な他人の Lease は claim を消して driver_lease を立てる",
  () => {
    const queue = [item("t-1", { progress: "queued", session: null })];
    const withLease = deriveNext(
      state(queue, { controller_lease: lease() }),
      underLease(),
    );
    assertEquals(withLease.start.allowed, false);
    assertEquals(withLease.start.blocked_by, ["driver_lease"]);
    assertEquals(withLease.start.next_id, null);
    assertEquals(actionKinds(taskOf(withLease, "t-1")), []);
    assertEquals(withLease.controller_lease, lease());

    // 回帰: Lease が無ければ従来どおり claim が出る。
    const without = deriveNext(state(queue), input());
    assertEquals(without.start.next_id, "t-1");
    assertEquals(actionKinds(taskOf(without, "t-1")), ["claim"]);
    assertEquals(without.controller_lease, null);
  },
);

nextTest(
  "next/start: driver_lease は max_tasks の後、他の理由より先に並ぶ",
  () => {
    const result = deriveNext(
      state([
        item("t-1", { progress: "queued", session: null }),
        item("t-2", {
          progress: "resting",
          artifact: openArtifact(),
        }),
      ], { controller_lease: lease() }),
      underLease({
        config: config({ max_open: 1, max_tasks: 1 }),
        tasksStarted: 1,
      }),
    );
    assertEquals(result.start.blocked_by, [
      "max_tasks",
      "driver_lease",
      "max_open",
    ]);
  },
);

nextTest(
  "next/liveness: Lease 中の running は理由を問わず wait{driver-lease} 1 件だけ",
  () => {
    // 沈黙超過 (本来 status-check) / 引き継ぎ待ち超過 (本来 takeover) / 強い証拠
    // (本来 takeover{strong-evidence}) の 3 経路すべてが同じ wait に潰れる。
    const cases: { label: string; queue: V2Item[]; input: NextInput }[] = [
      {
        label: "沈黙超過",
        queue: [item("t-1", {
          progress: "running",
          run: run({ executor_last_event_at: isoMinutesAgo(91) }),
        })],
        input: underLease(),
      },
      {
        label: "引き継ぎ待ち超過",
        queue: [item("t-1", {
          progress: "running",
          run: run({ takeover_at: isoMinutesAgo(31) }),
        })],
        input: underLease(),
      },
      {
        label: "孤児の強い証拠",
        queue: [item("t-1", {
          progress: "running",
          session: "session-gone",
          run: run(),
        })],
        input: underLease({ deadEvidence: ["t-1"] }),
      },
    ];
    for (const c of cases) {
      const task = taskOf(
        deriveNext(state(c.queue, { controller_lease: lease() }), c.input),
        "t-1",
      );
      assertEquals(actionKinds(task), ["wait"], c.label);
      assertEquals(actionOf(task, "wait").reason, "driver-lease", c.label);
    }
  },
);

nextTest(
  "next/liveness: Lease が有効でない 3 パターンでは抑制しない",
  () => {
    const queue = [item("t-1", {
      progress: "running",
      run: run({ executor_last_event_at: isoMinutesAgo(91) }),
    })];
    // 1. Lease が自分のもの (Driver 自身の next 呼び出し) — 抑制すると 1 件も実行できない
    const own = deriveNext(
      state(queue, { controller_lease: lease({ session: SELF }) }),
      underLease(),
    );
    assertEquals(
      actionKinds(taskOf(own, "t-1")),
      ["status-check"],
      "自分の Lease",
    );
    // 2. Lease の持ち主が生存一覧に居ない (クラッシュして解放できなかった)
    const dead = deriveNext(
      state(queue, { controller_lease: lease() }),
      input({ alive: [SELF] }),
    );
    assertEquals(actionKinds(taskOf(dead, "t-1")), ["status-check"], "失効");
    // 3. Lease が無い (キー欠落)
    const none = deriveNext(state(queue), input());
    assertEquals(
      actionKinds(taskOf(none, "t-1")),
      ["status-check"],
      "Lease 無し",
    );
  },
);

nextTest(
  "next/liveness: session を主張できない呼び出し側も抑制される",
  () => {
    // `--session` 空 = 所有を主張できない環境。Lease の持ち主とは一致しないので抑制側。
    const result = deriveNext(
      state([item("t-1", {
        progress: "running",
        session: null,
        run: run({ executor_last_event_at: isoMinutesAgo(91) }),
      })], { controller_lease: lease() }),
      input({ session: "", alive: [DRIVER] }),
    );
    assertEquals(
      actionOf(taskOf(result, "t-1"), "wait").reason,
      "driver-lease",
    );
  },
);

nextTest(
  "next/follow: Lease 中でも Driver が実行しない 9 種と tracker-list は残る",
  () => {
    // probe-run (追従) / fix-start (修正サイクル) / retire (回収) / set-takeover /
    // clear-takeover — どれも pipeline-dispatch.ts が deferred に分類する = Driver は
    // 実行しない。ここが空になったら、Lease 中は誰も追従・回収しなくなる。
    const result = deriveNext(
      state([
        item("t-probe", {
          progress: "resting",
          artifact: openArtifact({ follow: follow({ probe: probe() }) }),
        }),
        item("t-fix", {
          progress: "resting",
          artifact: openArtifact({
            follow: follow({ asks: { fix: fixAsk(), rebase: null } }),
          }),
        }),
        item("t-merged", { progress: "resting", artifact: mergedArtifact() }),
        item("t-dead", {
          progress: "running",
          session: "session-gone",
          run: run({ executor_last_event_at: isoMinutesAgo(91) }),
        }),
        item("t-clear", {
          progress: "running",
          run: run({ takeover_at: isoMinutesAgo(5) }),
        }),
      ], { controller_lease: lease() }),
      underLease(),
    );
    assertEquals(actionKinds(taskOf(result, "t-probe")), ["probe-run"]);
    assertEquals(actionKinds(taskOf(result, "t-fix")), ["fix-start"]);
    assertEquals(actionKinds(taskOf(result, "t-merged")), ["retire"]);
    // running のタスクは wait に潰れるが、set-takeover / clear-takeover の経路が
    // 消えるわけではない (Lease が解けた次のイテレーションでそのまま出る)。
    assertEquals(actionKinds(taskOf(result, "t-dead")), ["wait"]);
    assertEquals(actionKinds(taskOf(result, "t-clear")), ["wait"]);
  },
);

nextTest(
  "next/observation: Lease 中でも tracker-list (承認の入口) は出る",
  () => {
    const result = deriveNext(
      state([], { controller_lease: lease() }),
      underLease(),
    );
    assertEquals(result.observations.map((o) => o.kind), ["tracker-list"]);
    assertEquals(result.start.blocked_by, ["driver_lease"]);
  },
);

nextTest(
  "next/ownership: excluded なタスクは Lease 中でも actions が空のまま",
  () => {
    const result = deriveNext(
      state([item("t-1", {
        progress: "running",
        session: OTHER,
        run: run({ executor_last_event_at: isoMinutesAgo(91) }),
      })], { controller_lease: lease() }),
      underLease({ alive: [SELF, OTHER, DRIVER] }),
    );
    const task = taskOf(result, "t-1");
    assertEquals(task.excluded, true);
    assertEquals(task.actions, []);
  },
);

// ---------------------------------------------------------------------------
// 導出 8 分類の網羅 (モジュール読み込み時の不変条件。冒頭の nextTest を参照)
// ---------------------------------------------------------------------------

const missingDerivationKeys = DERIVATION_KEYS.filter(
  (k) => !seenDerivationKeys.has(k),
);
if (missingDerivationKeys.length > 0) {
  throw new Error(
    `state-next.test.ts: 導出 8 分類のうち ${
      missingDerivationKeys.map((k) => `next/${k}`).join(" / ")
    } のテストが無い`,
  );
}
