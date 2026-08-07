// task-pipeline/scripts/state-model-v2.test.ts
//
// state-model-v2.ts (状態モデル v2 の語彙・ノード導出・不変条件・到達可能性テストの枠)
// のテスト。直接importで純粋関数をそのまま呼ぶ。
//
//   deno test task-pipeline/scripts/state-model-v2.test.ts
//   または: sh tests/state-model-v2.test.sh (deno 不在なら SKIP + exit 0)
//
// 命名は T-V2-<領域>-<連番> (state-transitions.test.ts の T-ALIGN/T-MX 系の命名を
// 踏襲しつつ、v2専用の名前空間にする)。

import {
  type Attention,
  checkReachability,
  deriveStatus,
  type FixAsk,
  fixAskAxisOf,
  type FollowRecord,
  GATE_VALUES,
  invariantGateNonNullIffKindInitial,
  invariantMergedImpliesResting,
  invariantPrFixImpliesOpenTaken,
  invariantProbeProcImpliesResting,
  invariantRunProgressConsistent,
  invariantTakenImpliesRunning,
  isFollowTarget,
  isLegalRunNode,
  listRunNodes,
  makeFixAsk,
  makeFollow,
  makeProbe,
  makeRebaseAsk,
  P_NODE_KEYS,
  PROGRESS_VALUES,
  type RebaseAsk,
  rebaseAskAxisOf,
  RUN_AXES,
  RUN_KIND_VALUES,
} from "./state-model-v2.ts";

// ---------------------------------------------------------------------------
// 依存ゼロの assert (state-transitions.test.ts / state.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertFalse(cond: boolean, msg?: string): void {
  if (cond) throw new Error(msg ?? "assertFalse failed");
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

// ---------------------------------------------------------------------------
// T-V2-VOCAB — 語彙の値集合 (領域P・領域A)
// ---------------------------------------------------------------------------

Deno.test("T-V2-VOCAB-1: PROGRESS_VALUES has exactly the 4 designed values", () => {
  assertEquals(PROGRESS_VALUES, ["queued", "running", "resting", "blocked"]);
});

Deno.test("T-V2-VOCAB-2: RUN_KIND_VALUES has exactly the 3 designed values", () => {
  assertEquals(RUN_KIND_VALUES, ["initial", "pr_fix", "rebase_fix"]);
});

Deno.test("T-V2-VOCAB-3: GATE_VALUES has exactly the 2 designed values", () => {
  assertEquals(GATE_VALUES, ["full", "light"]);
});

// ---------------------------------------------------------------------------
// T-V2-NODE — 領域Pの合法ノード列挙 (受け入れ条件2)
// ---------------------------------------------------------------------------

Deno.test("T-V2-NODE-1: legal P nodes are exactly the 19 nodes of design 1.5", () => {
  // 設計文書1.5節を手で書き起こした19組 (research.mdの表を展開したもの)。
  const expected = [
    "queued",
    "resting",
    "blocked",
    // running(initial, full, ...) の6
    "running(initial,full,research)",
    "running(initial,full,plan)",
    "running(initial,full,implement)",
    "running(initial,full,report)",
    "running(initial,full,finalize)",
    "running(initial,full,rebase_fix)",
    // running(initial, light, ...) の5
    "running(initial,light,research+plan)",
    "running(initial,light,implement)",
    "running(initial,light,report)",
    "running(initial,light,finalize)",
    "running(initial,light,rebase_fix)",
    // running(pr_fix, ...) の3
    "running(pr_fix,-,pr_fix)",
    "running(pr_fix,-,finalize)",
    "running(pr_fix,-,rebase_fix)",
    // running(rebase_fix, ...) の2
    "running(rebase_fix,-,rebase_fix)",
    "running(rebase_fix,-,finalize)",
  ];

  assertEquals(P_NODE_KEYS.length, 19);
  assertEquals(
    new Set(P_NODE_KEYS).size,
    19,
    "P_NODE_KEYS must have no duplicates",
  );
  assertEquals(
    [...P_NODE_KEYS].sort(),
    [...expected].sort(),
    "P_NODE_KEYS must match the 19 nodes of design 1.5 exactly (as a set)",
  );
});

Deno.test("T-V2-NODE-2: axis.phases() returns the designed phase counts and legality", () => {
  const byAxis = new Map(RUN_AXES.map((a) => [a.axisKey(), a]));

  // 正例: 各axisの列 (数と内容)
  assertEquals(
    byAxis.get("initial/full")!.phases(),
    ["research", "plan", "implement", "report", "finalize", "rebase_fix"],
  );
  assertEquals(
    byAxis.get("initial/light")!.phases(),
    ["research+plan", "implement", "report", "finalize", "rebase_fix"],
  );
  assertEquals(byAxis.get("pr_fix")!.phases(), [
    "pr_fix",
    "finalize",
    "rebase_fix",
  ]);
  assertEquals(byAxis.get("rebase_fix")!.phases(), [
    "rebase_fix",
    "finalize",
  ]);

  // 反例クラス (a): 直積の外にある (kind, gate) の組
  assertFalse(
    isLegalRunNode({ kind: "rebase_fix", gate: "full", phase: "rebase_fix" }),
  );

  // 反例クラス (b): (kind, gate) は正しいが、phaseがそのaxisの列に無い
  // (full専用フェーズ "plan" を light に付ける — orthogonal-dimension lesson の形そのもの)
  assertFalse(
    isLegalRunNode({ kind: "initial", gate: "light", phase: "plan" }),
  );

  // 反例クラス (c): 存在しないphase文字列
  assertFalse(
    isLegalRunNode({ kind: "initial", gate: "full", phase: "nonexistent" }),
  );

  // 正例の網羅性: listRunNodes() の全要素が isLegalRunNode を満たす
  for (const node of listRunNodes()) {
    assert(isLegalRunNode(node), `expected legal: ${node.key()}`);
  }
});

Deno.test("T-V2-NODE-3: RunNode.key() matches the standalone P_NODE_KEYS encoding", () => {
  // key() がノード自身のメソッドとして生成時に束ねられていること、かつその出力が
  // P_NODE_KEYS の構築に使ったものと同一であることを確認する。
  for (const node of listRunNodes()) {
    assertEquals(
      node.key(),
      `running(${node.kind},${node.gate ?? "-"},${node.phase})`,
    );
  }
  assertEquals(
    listRunNodes().map((n) => n.key()),
    P_NODE_KEYS.slice(3), // 先頭3件 (queued/resting/blocked) を除いた running(...) 分
  );
});

// ---------------------------------------------------------------------------
// T-V2-REBASE-ASK / T-V2-FIXASK — 領域Aのサブ軸導出 (受け入れ条件3)
// ---------------------------------------------------------------------------

// テスト用の rebase-ask (resolve/taken だけがこのテストの関心事)。
function rebaseAskOf(resolve: boolean, taken: boolean) {
  return makeRebaseAsk({
    blocked_onto: "abc",
    reason: "conflict",
    at: "2026-08-07T00:00:00Z",
    resolve,
    taken,
  });
}

Deno.test("T-V2-REBASE-ASK-1: derivation order is taken -> resolve -> quiet, total", () => {
  const cases: Array<[RebaseAsk, "taken" | "queued" | "quiet"]> = [
    [null, "quiet"],
    [rebaseAskOf(false, false), "quiet"],
    [rebaseAskOf(true, false), "queued"],
    // 受け入れ条件3の反例: taken=true かつ resolve=false でも taken に分類される
    // (taken が resolve より優先する)
    [rebaseAskOf(false, true), "taken"],
    // 優先順位の確認: resolve=true が同時に立っていても taken が勝つ
    [rebaseAskOf(true, true), "taken"],
  ];

  for (const [input, expected] of cases) {
    assertEquals(
      rebaseAskAxisOf(input),
      expected,
      `resolve/taken = ${input?.resolve}/${input?.taken}`,
    );
    // レコードが有るときは、レコード自身の axis() が同じ判定を返す
    if (input !== null) assertEquals(input.axis(), expected);
  }
});

// isResolveQueued() / isQuiet() は axis() の中からしか呼ばれない (isQuiet() に至っては
// 実装側の呼び出しが無い) ため、axis() の出力だけを見るテストでは誤実装を観測できない —
// axis() は isTaken() を先に見るので、taken=true の入力ではこれらの戻り値が結果に出ない。
// そこで両述語を直接呼ぶ代表ケースを (taken, resolve) の3クラスずつ置く。
Deno.test("T-V2-REBASE-ASK-2: isResolveQueued() is false unless resolve is declared and unconsumed", () => {
  // 未消費の解決要求だけが真
  assert(rebaseAskOf(true, false).isResolveQueued());
  // resolve が立っていない
  assertFalse(rebaseAskOf(false, false).isResolveQueued());
  // 消費済み (taken) は、resolve が立っていても queued ではない。
  // このクラスが `() => fields.resolve` (taken の連言落ち) を検出する。
  assertFalse(rebaseAskOf(true, true).isResolveQueued());
});

Deno.test("T-V2-REBASE-ASK-3: isQuiet() is true only for the guard-only record", () => {
  // ガードの控えだけ (発火可否を変えない)
  assert(rebaseAskOf(false, false).isQuiet());
  // 解決要求が queued に立っている
  assertFalse(rebaseAskOf(true, false).isQuiet());
  // 消費済み (taken)。このクラスが `() => !fields.resolve` (taken を見ない実装) を検出する。
  assertFalse(rebaseAskOf(false, true).isQuiet());
});

Deno.test("T-V2-FIXASK-1: null/pending/taken classes", () => {
  const cases: Array<[FixAsk, "null" | "pending" | "taken"]> = [
    [null, "null"],
    [makeFixAsk({ ids: ["gh-1"], findings: "f", taken: false }), "pending"],
    [makeFixAsk({ ids: ["gh-1"], findings: "f", taken: true }), "taken"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(fixAskAxisOf(input), expected, `taken = ${input?.taken}`);
    if (input !== null) {
      // レコード自身のメソッドが同じ判定を返す
      assertEquals(input.axis(), expected);
      assertEquals(input.isTaken(), expected === "taken");
      assertEquals(input.isPending(), expected === "pending");
    }
  }
});

// ---------------------------------------------------------------------------
// T-V2-GATE-INV — gate iff kind==initial (受け入れ条件4)
// ---------------------------------------------------------------------------

Deno.test("T-V2-GATE-INV-1: positive cases (gate non-null iff kind==initial)", () => {
  assert(invariantGateNonNullIffKindInitial({ kind: "initial", gate: "full" }));
  assert(
    invariantGateNonNullIffKindInitial({ kind: "initial", gate: "light" }),
  );
  assert(invariantGateNonNullIffKindInitial({ kind: "pr_fix", gate: null }));
  assert(
    invariantGateNonNullIffKindInitial({ kind: "rebase_fix", gate: null }),
  );
});

Deno.test("T-V2-GATE-INV-2: negative cases (gate non-null iff kind==initial)", () => {
  assertFalse(
    invariantGateNonNullIffKindInitial({ kind: "initial", gate: null }),
  );
  assertFalse(
    invariantGateNonNullIffKindInitial({ kind: "pr_fix", gate: "full" }),
  );
  assertFalse(
    invariantGateNonNullIffKindInitial({ kind: "rebase_fix", gate: "light" }),
  );
});

// ---------------------------------------------------------------------------
// T-V2-INV — 不変条件1〜5 (設計1.5節)
// ---------------------------------------------------------------------------

Deno.test("T-V2-INV-1: run != null iff progress == running", () => {
  assert(invariantRunProgressConsistent("running", { kind: "initial" }));
  assert(invariantRunProgressConsistent("queued", null));
  assertFalse(invariantRunProgressConsistent("running", null));
  assertFalse(invariantRunProgressConsistent("resting", { kind: "initial" }));
});

Deno.test("T-V2-INV-2: artifact.state==merged implies progress==resting", () => {
  assert(invariantMergedImpliesResting("merged", "resting"));
  assert(invariantMergedImpliesResting("open", "running")); // vacuous: not merged
  assertFalse(invariantMergedImpliesResting("merged", "running"));
  assertFalse(invariantMergedImpliesResting("merged", "queued"));
});

Deno.test("T-V2-INV-3: running(pr_fix) implies open + follow + asks.fix.taken", () => {
  const openFollowTaken: FollowRecord = makeFollow({
    attention: "auto",
    asks: {
      fix: makeFixAsk({ ids: ["gh-1"], findings: "f", taken: true }),
      rebase: null,
    },
    probe: makeProbe({ proc: null }),
  });
  assert(
    invariantPrFixImpliesOpenTaken(
      "running",
      { kind: "pr_fix" },
      "open",
      openFollowTaken,
    ),
  );

  // vacuous-true side: 他のkind / 他のprogressでは常にtrue
  assert(
    invariantPrFixImpliesOpenTaken(
      "running",
      { kind: "initial" },
      "none",
      null,
    ),
  );
  assert(invariantPrFixImpliesOpenTaken("queued", null, "none", null));
  assert(
    invariantPrFixImpliesOpenTaken("resting", null, "open", openFollowTaken),
  );

  // 反例: pr_fix実行中なのに artifact が open でない
  assertFalse(
    invariantPrFixImpliesOpenTaken("running", { kind: "pr_fix" }, "none", null),
  );

  // 反例: pr_fix実行中なのに follow が無い
  assertFalse(
    invariantPrFixImpliesOpenTaken("running", { kind: "pr_fix" }, "open", null),
  );

  // 反例: pr_fix実行中なのに asks.fix.taken が立っていない
  const openFollowNotTaken: FollowRecord = makeFollow({
    attention: "auto",
    asks: {
      fix: makeFixAsk({ ids: ["gh-1"], findings: "f", taken: false }),
      rebase: null,
    },
    probe: makeProbe({ proc: null }),
  });
  assertFalse(
    invariantPrFixImpliesOpenTaken(
      "running",
      { kind: "pr_fix" },
      "open",
      openFollowNotTaken,
    ),
  );
});

Deno.test("T-V2-INV-4: probe.proc != null implies progress == resting", () => {
  const leased = makeProbe({ proc: "watch-proc-1" });
  const idle = makeProbe({ proc: null });
  assert(leased.hasLease());
  assertFalse(idle.hasLease());

  assert(invariantProbeProcImpliesResting("resting", leased));
  assert(invariantProbeProcImpliesResting("running", idle)); // vacuous: no lease
  assert(invariantProbeProcImpliesResting("running", null)); // vacuous: no probe
  assertFalse(invariantProbeProcImpliesResting("running", leased));
  assertFalse(invariantProbeProcImpliesResting("queued", leased));
});

Deno.test("T-V2-INV-5: taken (fix or rebase) implies progress == running", () => {
  const fixTaken: FixAsk = makeFixAsk({
    ids: ["gh-1"],
    findings: "f",
    taken: true,
  });
  const fixPending: FixAsk = makeFixAsk({
    ids: ["gh-1"],
    findings: "f",
    taken: false,
  });
  const rebaseTaken: RebaseAsk = rebaseAskOf(false, true);
  const rebaseQuiet: RebaseAsk = rebaseAskOf(false, false);

  // 両方false: 無条件でtrue
  assert(invariantTakenImpliesRunning("resting", fixPending, rebaseQuiet));
  assert(invariantTakenImpliesRunning("queued", null, null));

  // fixAsk.taken のみtrue
  assert(invariantTakenImpliesRunning("running", fixTaken, null));
  assertFalse(invariantTakenImpliesRunning("resting", fixTaken, null));

  // rebaseAsk.taken のみtrue
  assert(invariantTakenImpliesRunning("running", null, rebaseTaken));
  assertFalse(invariantTakenImpliesRunning("resting", null, rebaseTaken));

  // 両方true
  assert(invariantTakenImpliesRunning("running", fixTaken, rebaseTaken));
  assertFalse(invariantTakenImpliesRunning("queued", fixTaken, rebaseTaken));
});

// ---------------------------------------------------------------------------
// T-V2-STATUS-DERIVE — 現行statusへの導出式 (1.1節)
// ---------------------------------------------------------------------------

Deno.test("T-V2-STATUS-DERIVE-1: status(P, A) formula", () => {
  assertEquals(deriveStatus("queued", "none"), "approved");
  assertEquals(deriveStatus("running", "open"), "in_progress");
  assertEquals(deriveStatus("blocked", "open"), "blocked");
  assertEquals(deriveStatus("resting", "merged"), "done");
  assertEquals(deriveStatus("resting", "open"), "in_review");
  assertEquals(deriveStatus("resting", "none"), "in_review");
  assertEquals(deriveStatus("resting", "withdrawn"), "in_review");
});

// ---------------------------------------------------------------------------
// T-V2-FOLLOW-TARGET — 追従対象の導出式 (1.3節)
// ---------------------------------------------------------------------------

// follow は必ず makeFollow で組む — メソッドは生成時の値を閉じ込めるので、
// 既存レコードのスプレッドで一部だけ差し替えると判定が古い値のまま残る。
function followOf(
  attention: Attention,
  fix: FixAsk,
  rebase: RebaseAsk,
): FollowRecord {
  return makeFollow({
    attention,
    asks: { fix, rebase },
    probe: makeProbe({ proc: null }),
  });
}

Deno.test("T-V2-FOLLOW-TARGET-1: derivation and its negated-condition counterexamples", () => {
  const targetFollow = followOf("auto", null, null);

  // 正例: 全条件を満たす最小の組
  assert(isFollowTarget("resting", "open", targetFollow));

  // 反例: progress != resting
  assertFalse(isFollowTarget("running", "open", targetFollow));

  // 反例: artifactState != open
  assertFalse(isFollowTarget("resting", "merged", targetFollow));

  // 反例: follow == null
  assertFalse(isFollowTarget("resting", "open", null));

  // 反例: attention != auto
  const humanAttention: Attention = { human: "manual" };
  assertFalse(
    isFollowTarget("resting", "open", followOf(humanAttention, null, null)),
  );

  // 反例: fix-ask != null (pending)
  assertFalse(
    isFollowTarget(
      "resting",
      "open",
      followOf(
        "auto",
        makeFixAsk({ ids: ["gh-1"], findings: "f", taken: false }),
        null,
      ),
    ),
  );

  // 反例: rebase-ask != quiet (queued)
  assertFalse(
    isFollowTarget(
      "resting",
      "open",
      followOf("auto", null, rebaseAskOf(true, false)),
    ),
  );
});

Deno.test("T-V2-FOLLOW-SUBAXES-1: follow.subAxes() reports the three sub-axis coordinates", () => {
  assertEquals(followOf("auto", null, null).subAxes(), {
    attention: "auto",
    fixAsk: "null",
    rebaseAsk: "quiet",
  });

  assertEquals(
    followOf(
      { human: "fix_limit" },
      makeFixAsk({ ids: ["gh-1"], findings: "f", taken: true }),
      rebaseAskOf(true, false),
    ).subAxes(),
    { attention: "human", fixAsk: "taken", rebaseAsk: "queued" },
  );

  // hasTakenFixAsk() は不変条件3が問うもの — 軸の taken と一致する
  assert(
    followOf(
      "auto",
      makeFixAsk({ ids: ["gh-1"], findings: "f", taken: true }),
      null,
    ).hasTakenFixAsk(),
  );
  assertFalse(
    followOf(
      "auto",
      makeFixAsk({ ids: ["gh-1"], findings: "f", taken: false }),
      null,
    ).hasTakenFixAsk(),
  );
  assertFalse(followOf("auto", null, null).hasTakenFixAsk());
});

// ---------------------------------------------------------------------------
// T-V2-REACH — 到達可能性テストの枠 (設計4.2節。小さなダミーグラフで枠自体を検査する)
// ---------------------------------------------------------------------------

Deno.test("T-V2-REACH-1: all declared nodes reachable", () => {
  const nodes = ["a", "b", "c"] as const;
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }] as const;
  const result = checkReachability(nodes, edges, "a", []);
  assertEquals(result.ok, true);
  assertEquals(result.unreached, []);
  assertEquals(result.unexpectedUnreachable, []);
});

Deno.test("T-V2-REACH-2: unreachable node present but allow-listed", () => {
  const nodes = ["a", "b", "isolated"] as const;
  const edges = [{ from: "a", to: "b" }] as const;
  const result = checkReachability(nodes, edges, "a", ["isolated"]);
  assertEquals(result.ok, true);
  assertEquals(result.unreached, ["isolated"]);
  assertEquals(result.unexpectedUnreachable, []);
});

Deno.test("T-V2-REACH-3: unreachable node not allow-listed is reported", () => {
  const nodes = ["a", "b", "orphan"] as const;
  const edges = [{ from: "a", to: "b" }] as const;
  const result = checkReachability(nodes, edges, "a", []);
  assertEquals(result.ok, false);
  assertEquals(result.unreached, ["orphan"]);
  assertEquals(result.unexpectedUnreachable, ["orphan"]);
});

// ---------------------------------------------------------------------------
// T-V2-NOLEGACY — v1廃止予定語彙の非export (受け入れ条件6)
// ---------------------------------------------------------------------------

Deno.test("T-V2-NOLEGACY-1: no export name resembles the retired v1 verbs", () => {
  const legacyPatterns = [
    "watchinit",
    "finalizestart",
    "fixdone",
    "rebasedone",
  ];
  return import("./state-model-v2.ts").then((mod) => {
    const exportNames = Object.keys(mod);
    assert(exportNames.length > 0, "module must export something to check");
    for (const name of exportNames) {
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const pattern of legacyPatterns) {
        assert(
          !normalized.includes(pattern),
          `export "${name}" resembles retired v1 verb pattern "${pattern}"`,
        );
      }
    }
  });
});
