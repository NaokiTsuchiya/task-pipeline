// task-pipeline/scripts/state-migrate-v2.test.ts
//
// state-migrate-v2.ts (migrateV1toV2) のテスト。設計 3.2節の対応表の行ごとに
// 入力 → 期待出力を固定し、出力が v2 スキーマ (checkStateV2) と #34 の不変条件述語を
// 満たすことまで見る。
//
//   deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//   単体: deno test task-pipeline/scripts/state-migrate-v2.test.ts
//
// 系統 (plan §3.2 の M-*):
//   M-STATUS / M-RUN / M-DROP / M-ARTIFACT / M-FOLLOW / M-ATTENTION / M-ASKS /
//   M-LEDGER-PROBE / M-TOP / M-PURE / M-FIXTURE / M-MATRIX

import { migrateV1toV2, V2_SCHEMA_VERSION } from "./state-migrate-v2.ts";
import { checkStateV2 } from "./state-schema-v2.ts";
import {
  type ArtifactState,
  type FixAsk,
  type FixAskFields,
  type FollowRecord,
  invariantGateNonNullIffKindInitial,
  invariantMergedImpliesResting,
  invariantPrFixImpliesOpenTaken,
  invariantProbeProcImpliesResting,
  invariantRunProgressConsistent,
  invariantTakenImpliesRunning,
  makeFixAsk,
  makeFollow,
  makeProbe,
  makeRebaseAsk,
  type Progress,
  type RebaseAsk,
  type RebaseAskFields,
  type RunKind,
} from "./state-model-v2.ts";

import validLegacyLiveRaw from "../../tests/fixtures/state-cli/valid-legacy-live.json" with {
  type: "json",
};
import validSkillExampleRaw from "../../tests/fixtures/state-cli/valid-skill-example.json" with {
  type: "json",
};
import validWatchRebaseRaw from "../../tests/fixtures/state-cli/valid-watch-rebase.json" with {
  type: "json",
};

const validLegacyLive: unknown = validLegacyLiveRaw;
const validSkillExample: unknown = validSkillExampleRaw;
const validWatchRebase: unknown = validWatchRebaseRaw;

type Rec = Record<string, unknown>;

const NOW = "2026-08-07T00:00:00Z";

// ---------------------------------------------------------------------------
// 依存ゼロの assert
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: ${a} !== ${e}`);
}

function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${msg}: expected throw`);
}

function assertSchemaOk(state: unknown, label: string): void {
  const result = checkStateV2(state);
  if (!result.ok) {
    throw new Error(
      `${label}: migrated state is not v2-valid at "${result.path}": ${result.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// v1 の入力ファクトリ
// ---------------------------------------------------------------------------

function v1Item(over: Rec = {}): Rec {
  return {
    id: "t-1",
    title: "タイトル",
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
    ...over,
  };
}

function v1Watch(over: Rec = {}): Rec {
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
    ...over,
  };
}

function v1State(queue: Rec[], over: Rec = {}): Rec {
  return {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: "2026-07-16T09:12:00Z",
    queue,
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    ...over,
  };
}

// 1 件だけの v1 state を移行し、**出力が v2 スキーマを満たすことを毎回確認**してから
// state を返す (どのケースでも「合法な v2 になっている」ことが最低限の期待値)。
function migrateOne(over: Rec, label = "migrateOne"): Rec {
  const state = migrateV1toV2(v1State([v1Item(over)]), NOW);
  assertSchemaOk(state, label);
  return state;
}

function queueOf(state: Rec): Rec[] {
  return state.queue as Rec[];
}

function onlyItem(state: Rec): Rec {
  const q = queueOf(state);
  if (q.length !== 1) {
    throw new Error(`expected exactly 1 queue item, got ${q.length}`);
  }
  return q[0];
}

function artifactOf(state: Rec): Rec {
  return onlyItem(state).artifact as Rec;
}

function followOf(state: Rec): Rec {
  const follow = artifactOf(state).follow;
  if (follow === null || typeof follow !== "object") {
    throw new Error("expected follow to be an object");
  }
  return follow as Rec;
}

// ---------------------------------------------------------------------------
// M-STATUS — status の 5 分岐と queue 離脱 (設計 2.5・3.2節)
// ---------------------------------------------------------------------------

Deno.test("M-STATUS-1: approved → queued × none", () => {
  const item = onlyItem(migrateOne({ status: "approved" }));
  assertEquals(item.progress, "queued", "progress");
  assertEquals(item.run, null, "run");
  assertEquals(item.artifact, { state: "none" }, "artifact");
});

Deno.test("M-STATUS-2: in_review → resting", () => {
  const item = onlyItem(migrateOne({ status: "in_review" }));
  assertEquals(item.progress, "resting", "progress");
  assertEquals(item.run, null, "run");
});

Deno.test("M-STATUS-3: blocked + reason → blocked", () => {
  const item = onlyItem(
    migrateOne({ status: "blocked", blocked_reason: "自力で進めない" }),
  );
  assertEquals(item.progress, "blocked", "progress");
  assertEquals(item.blocked_reason, "自力で進めない", "blocked_reason");
});

Deno.test('M-STATUS-4: blocked + blocked_reason: null → ""', () => {
  // v1 スキーマの blocked_reason は ["string","null"] なので、blocked なのに記録が
  // 無い入力は v1-valid として実在しうる。そのまま写すと v2 の blocked ノード
  // (blocked_reason: string) を破るので "" で埋める (migrateOne が schema 検証もする)。
  const item = onlyItem(
    migrateOne({ status: "blocked", blocked_reason: null }),
  );
  assertEquals(item.progress, "blocked", "progress");
  assertEquals(item.blocked_reason, "", "blocked_reason");
});

Deno.test("M-STATUS-5: done かつ worktree null → queue から外れ completed へ", () => {
  const state = migrateV1toV2(
    v1State([
      v1Item({
        id: "gh-9",
        status: "done",
        worktree: null,
        review: { ref: "abc", branch: "b", tip: "abc", base: "main" },
      }),
    ]),
    NOW,
  );
  assertSchemaOk(state, "M-STATUS-5");
  assertEquals(queueOf(state).length, 0, "queue is empty");
  assertEquals(state.completed, [{ id: "gh-9", done_at: NOW }], "completed");
});

Deno.test("M-STATUS-6: done かつ worktree 残 → resting × merged (watch は破棄)", () => {
  const state = migrateOne({
    status: "done",
    worktree: "/abs/worktrees/t-1",
    review: {
      ref: "https://github.com/o/r/pull/7",
      branch: "task-pipeline/t-1",
      tip: "abc123",
      base: "main",
      // v1 の recover-done は watch を stopped で残していた (withStoppedWatch)。
      watch: v1Watch({ state: "stopped", note: "追従上限", fix_attempts: 4 }),
    },
  }, "M-STATUS-6");
  const item = onlyItem(state);
  assertEquals(item.progress, "resting", "progress");
  assertEquals(item.artifact, {
    state: "merged",
    ref: "https://github.com/o/r/pull/7",
    branch: "task-pipeline/t-1",
    tip: "abc123",
    base: "main",
  }, "artifact (follow キーごと無い)");
  assertEquals(state.completed, [], "completed は空");
});

Deno.test("M-STATUS-7: 未知 status は throw する", () => {
  assertThrows(
    () => migrateV1toV2(v1State([v1Item({ status: "archived" })]), NOW),
    "unknown status",
  );
});

// ---------------------------------------------------------------------------
// M-RUN — run の kind / gate / phase 導出 (設計 1.2・3.2節)
// ---------------------------------------------------------------------------

function runOf(over: Rec): Rec {
  const item = onlyItem(migrateOne({ status: "in_progress", ...over }));
  assertEquals(item.progress, "running", "progress");
  return item.run as Rec;
}

Deno.test("M-RUN-1: (gate full, phase research) → initial/full/research", () => {
  assertEquals(
    runOf({
      gate: "full",
      phase: "research",
      attempts: 2,
      executor: "agent-1",
      executor_last_event_at: "2026-08-06T00:00:00Z",
      takeover_at: null,
    }),
    {
      kind: "initial",
      gate: "full",
      phase: "research",
      attempts: 2,
      executor: "agent-1",
      executor_last_event_at: "2026-08-06T00:00:00Z",
      takeover_at: null,
      verifier: null,
      verifier_session: null,
    },
    "run",
  );
});

Deno.test("M-RUN-2: (gate light, phase research+plan) → initial/light", () => {
  const run = runOf({ gate: "light", phase: "research+plan" });
  assertEquals(run.kind, "initial", "kind");
  assertEquals(run.gate, "light", "gate");
  assertEquals(run.phase, "research+plan", "phase");
});

Deno.test("M-RUN-3: phase pr_fix → kind pr_fix・gate null", () => {
  const run = runOf({
    gate: "light",
    phase: "pr_fix",
    review: { ref: "https://x/pull/1", watch: v1Watch() },
  });
  assertEquals(run.kind, "pr_fix", "kind");
  assertEquals(run.gate, null, "gate は kind==initial のときだけ非 null");
  assertEquals(run.phase, "pr_fix", "phase");
});

Deno.test("M-RUN-4: phase rebase_fix + review.rebase 有 → kind rebase_fix (解決サイクル)", () => {
  const run = runOf({
    phase: "rebase_fix",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch(),
      rebase: { blocked_onto: "def", reason: "conflict", at: NOW },
    },
  });
  assertEquals(run.kind, "rebase_fix", "kind");
  assertEquals(run.gate, null, "gate");
  assertEquals(run.phase, "rebase_fix", "phase");
});

Deno.test("M-RUN-5: phase rebase_fix + review.rebase 無 → kind initial の迂回", () => {
  const run = runOf({
    gate: "light",
    phase: "rebase_fix",
    review: { ref: "https://x/pull/1", watch: v1Watch() },
  });
  assertEquals(run.kind, "initial", "kind");
  assertEquals(run.gate, "light", "gate は保たれる");
  assertEquals(run.phase, "rebase_fix", "phase (迂回フェーズ)");
});

Deno.test("M-RUN-6: phase finalize → kind initial (v1 に来歴が無く判別不能)", () => {
  const run = runOf({ gate: "full", phase: "finalize" });
  assertEquals(run.kind, "initial", "kind");
  assertEquals(run.gate, "full", "gate");
  assertEquals(run.phase, "finalize", "phase");
});

Deno.test("M-RUN-7: phase null → その軸のフェーズ列の先頭", () => {
  assertEquals(runOf({ gate: "full", phase: null }).phase, "research", "full");
  assertEquals(
    runOf({ gate: "light", phase: null }).phase,
    "research+plan",
    "light",
  );
});

Deno.test("M-RUN-8: (gate light, phase research) の死に組 → gate full に正規化", () => {
  const run = runOf({ gate: "light", phase: "research" });
  assertEquals(run.gate, "full", "gate は phase に合わせて直す");
  assertEquals(run.phase, "research", "phase は作業位置の真値なので保つ");
});

Deno.test("M-RUN-9: gate キー欠落 (または enum 外) → full にフォールバック", () => {
  // v1 スキーマでは gate は required かつ enum ["full","light"] なので v1-valid な
  // 入力からは来ない防御分岐。そのまま写すと run の 4 枝のどれにも適合しなくなる。
  const item = v1Item({ status: "in_progress", phase: "research" });
  delete item.gate;
  const missing = migrateV1toV2(v1State([item]), NOW);
  assertSchemaOk(missing, "M-RUN-9 (gate キー欠落)");
  assertEquals((onlyItem(missing).run as Rec).gate, "full", "gate (欠落)");

  const bogus = migrateOne({
    status: "in_progress",
    gate: "turbo",
    phase: "research",
  }, "M-RUN-9 (enum 外)");
  assertEquals((onlyItem(bogus).run as Rec).gate, "full", "gate (enum 外)");
});

Deno.test("M-RUN-10: 未知 phase → その軸の先頭にフォールバック", () => {
  assertEquals(
    runOf({ gate: "full", phase: "unknown-phase" }).phase,
    "research",
    "phase",
  );
});

Deno.test("M-RUN-11: phase pr_fix でも artifact が open でなければ kind initial", () => {
  // 不変条件 3 (running(pr_fix) ⇒ artifact.state==open ∧ follow≠null ∧ asks.fix.taken)
  // を移行直後に破らないための分岐。v1 でも fix-start は review.watch を要求するので、
  // この組は verb 経由では作れない。
  const noReview = runOf({ gate: "full", phase: "pr_fix", review: null });
  assertEquals(noReview.kind, "initial", "review 無し → kind");
  assertEquals(noReview.gate, "full", "review 無し → gate");
  assertEquals(noReview.phase, "research", "review 無し → 列の先頭に戻る");

  const withdrawn = runOf({
    gate: "light",
    phase: "pr_fix",
    review: { ref: "https://x/pull/1", withdrawn: true, watch: v1Watch() },
  });
  assertEquals(withdrawn.kind, "initial", "取り下げ済み → kind");
  assertEquals(
    withdrawn.phase,
    "research+plan",
    "取り下げ済み → 列の先頭に戻る",
  );
});

// ---------------------------------------------------------------------------
// M-DROP — 非 in_progress の executor 系フィールドの破棄 (3.2節)
// ---------------------------------------------------------------------------

Deno.test("M-DROP-1: 非 in_progress の item に gate/attempts/executor 系のキーが無い", () => {
  for (const status of ["approved", "in_review", "blocked"]) {
    const item = onlyItem(migrateOne({
      status,
      blocked_reason: status === "blocked" ? "理由" : null,
      gate: "light",
      attempts: 3,
      executor: "agent-1",
      executor_last_event_at: "2026-08-06T00:00:00Z",
      takeover_at: "2026-08-06T01:00:00Z",
    }, `M-DROP-1 ${status}`));
    assertEquals(
      Object.keys(item).sort(),
      [
        "artifact",
        "base",
        "blocked_reason",
        "id",
        "progress",
        "run",
        "session",
        "title",
        "worktree",
      ],
      `${status} のキー集合`,
    );
  }
});

Deno.test("M-DROP-2: in_progress では executor 系が run の中にだけ有る", () => {
  const item = onlyItem(migrateOne({
    status: "in_progress",
    phase: "implement",
    executor: "agent-1",
    takeover_at: "2026-08-06T01:00:00Z",
  }));
  assert(!("executor" in item), "item 直下に executor は無い");
  assert(!("gate" in item), "item 直下に gate は無い");
  const run = item.run as Rec;
  assertEquals(run.executor, "agent-1", "run.executor");
  assertEquals(run.takeover_at, "2026-08-06T01:00:00Z", "run.takeover_at");
});

Deno.test("M-DROP-3: 非 blocked の blocked_reason 残骸は null に正規化", () => {
  const item = onlyItem(
    migrateOne({ status: "in_review", blocked_reason: "古い理由" }),
  );
  assertEquals(item.blocked_reason, null, "blocked_reason");
});

// ---------------------------------------------------------------------------
// M-ARTIFACT — 領域 A の写しと優先順位
// ---------------------------------------------------------------------------

Deno.test("M-ARTIFACT-1: review: null → none", () => {
  assertEquals(
    artifactOf(migrateOne({ status: "in_review", review: null })),
    { state: "none" },
    "artifact",
  );
});

Deno.test("M-ARTIFACT-2: open のグループ欄写し", () => {
  const artifact = artifactOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://github.com/o/r/pull/7",
      branch: "task-pipeline/t-1",
      tip: "abc123",
      base: "main",
    },
  }));
  assertEquals(artifact.state, "open", "state");
  assertEquals(artifact.ref, "https://github.com/o/r/pull/7", "ref");
  assertEquals(artifact.branch, "task-pipeline/t-1", "branch");
  assertEquals(artifact.tip, "abc123", "tip");
  assertEquals(artifact.base, "main", "base");
});

Deno.test("M-ARTIFACT-3: review が {ref} だけ → branch/tip/base は null で埋まる", () => {
  // v1 の $defs.review は required が ["ref"] だけで branch/tip/base は任意キー。
  // v2 の open 枝は 4 キーすべて required なので、欠落は null で埋める必要がある。
  const artifact = artifactOf(
    migrateOne({ status: "in_review", review: { ref: "abc123" } }),
  );
  assertEquals(artifact.state, "open", "state");
  assertEquals(artifact.ref, "abc123", "ref");
  assertEquals(artifact.branch, null, "branch");
  assertEquals(artifact.tip, null, "tip");
  assertEquals(artifact.base, null, "base");
});

Deno.test("M-ARTIFACT-4: withdrawn: true → withdrawn + asked", () => {
  const artifact = artifactOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      branch: "b",
      tip: "t",
      base: "main",
      withdrawn: true,
      withdrawn_asked: true,
      watch: v1Watch({ state: "watching", proc: "bg-1" }),
    },
  }));
  assertEquals(artifact, {
    state: "withdrawn",
    ref: "https://x/pull/1",
    branch: "b",
    tip: "t",
    base: "main",
    asked: true,
    note: null,
  }, "artifact (follow キーごと無い)");
});

Deno.test("M-ARTIFACT-5: withdrawn_asked キー無し → asked: false", () => {
  const artifact = artifactOf(migrateOne({
    status: "in_review",
    review: { ref: "https://x/pull/1", withdrawn: true },
  }));
  assertEquals(artifact.state, "withdrawn", "state");
  assertEquals(artifact.asked, false, "asked");
});

Deno.test("M-ARTIFACT-6: done かつ withdrawn: true → merged が優先", () => {
  const artifact = artifactOf(migrateOne({
    status: "done",
    worktree: "/abs/w",
    review: {
      ref: "https://x/pull/1",
      branch: "b",
      tip: "t",
      base: "main",
      withdrawn: true,
      withdrawn_asked: true,
    },
  }));
  assertEquals(artifact.state, "merged", "state");
});

Deno.test("M-ARTIFACT-7: done かつ review: null → none (merged にはしない)", () => {
  // 設計 1.1節「resting × none から merged へ到達する経路は無い — マージ証明は tip を
  // 要する」に従い、グループ欄の無い merged は作らない。
  const state = migrateOne({
    status: "done",
    worktree: "/abs/w",
    review: null,
  });
  const item = onlyItem(state);
  assertEquals(item.progress, "resting", "progress");
  assertEquals(item.artifact, { state: "none" }, "artifact");
});

// ---------------------------------------------------------------------------
// M-FOLLOW — follow の生成条件
// ---------------------------------------------------------------------------

Deno.test("M-FOLLOW-1: watch 有 → follow が生まれる", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: { ref: "https://x/pull/1", watch: v1Watch() },
  }));
  assertEquals(
    Object.keys(follow).sort(),
    ["asks", "attention", "ledger", "probe"],
    "follow のキー",
  );
});

Deno.test("M-FOLLOW-2: watch 無・rebase 有 → follow を作って ask を残す", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      rebase: { blocked_onto: "def", reason: "diverged", at: NOW },
    },
  }));
  const asks = follow.asks as Rec;
  assertEquals(asks.fix, null, "asks.fix");
  assertEquals((asks.rebase as Rec).blocked_onto, "def", "asks.rebase");
  assertEquals(follow.attention, "auto", "attention");
});

Deno.test("M-FOLLOW-3: watch 無・rebase 無 (finish=commit) → follow: null", () => {
  const artifact = artifactOf(migrateOne({
    status: "in_review",
    review: { ref: "abc123", branch: "b", tip: "abc123", base: "main" },
  }));
  assertEquals(artifact.state, "open", "state");
  assertEquals(artifact.follow, null, "follow");
});

Deno.test("M-FOLLOW-4: kind pr_fix の item は watch が無くても follow を持つ", () => {
  // 不変条件 3 が follow≠null を要求するため、watch も rebase も無い open (v1 の
  // review が {ref} だけ) でも follow を作る。
  const follow = followOf(migrateOne({
    status: "in_progress",
    phase: "pr_fix",
    review: { ref: "https://x/pull/1" },
  }));
  assertEquals(
    (follow.asks as Rec).fix,
    { ids: [], findings: null, taken: true },
    "asks.fix",
  );
  assertEquals(follow.attention, "auto", "attention (既定値)");
  assertEquals((follow.probe as Rec).proc, null, "probe.proc");
});

// ---------------------------------------------------------------------------
// M-ATTENTION — watch.state → attention (3.2節の 3 分岐)
// ---------------------------------------------------------------------------

function attentionOf(watchOver: Rec): unknown {
  return followOf(migrateOne({
    status: "in_review",
    review: { ref: "https://x/pull/1", watch: v1Watch(watchOver) },
  })).attention;
}

Deno.test("M-ATTENTION-1: watching → auto", () => {
  assertEquals(attentionOf({ state: "watching" }), "auto", "attention");
});

Deno.test("M-ATTENTION-2: stopped × fix_attempts 4 → human fix_limit", () => {
  assertEquals(
    attentionOf({ state: "stopped", fix_attempts: 4 }),
    { human: "fix_limit" },
    "attention",
  );
});

Deno.test("M-ATTENTION-3: stopped × errors 3 → human errors", () => {
  assertEquals(
    attentionOf({ state: "stopped", errors: 3 }),
    { human: "errors" },
    "attention",
  );
});

Deno.test("M-ATTENTION-4: stopped × どちらも下 → human manual", () => {
  assertEquals(
    attentionOf({ state: "stopped", fix_attempts: 3, errors: 2 }),
    { human: "manual" },
    "attention",
  );
});

Deno.test("M-ATTENTION-5: stopped × 両方の閾値超え → fix_limit が優先", () => {
  assertEquals(
    attentionOf({ state: "stopped", fix_attempts: 4, errors: 5 }),
    { human: "fix_limit" },
    "attention",
  );
});

// ---------------------------------------------------------------------------
// M-ASKS — 要求ラッチ (3.2節 + 不変条件 3)
// ---------------------------------------------------------------------------

Deno.test("M-ASKS-1: fix_pending 真 → asks.fix (taken: false)", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch({
        fix_pending: true,
        pending_ids: ["rc-1", "rc-2"],
        findings: "/abs/findings.md",
      }),
    },
  }));
  assertEquals((follow.asks as Rec).fix, {
    ids: ["rc-1", "rc-2"],
    findings: "/abs/findings.md",
    taken: false,
  }, "asks.fix");
});

Deno.test("M-ASKS-2: fix_pending 偽 + pending_ids 非空 + 非 pr_fix → asks.fix: null", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch({ fix_pending: false, pending_ids: ["rc-1"] }),
    },
  }));
  assertEquals((follow.asks as Rec).fix, null, "asks.fix (残骸は破棄)");
});

Deno.test("M-ASKS-3: kind pr_fix と判定した item → asks.fix.taken: true", () => {
  // v1 の fix-start は fix_pending を false にして pending_ids を残したまま pr_fix へ
  // 進むので、飛行中の pr_fix も「偽 かつ pending_ids 非空」の形になる。破棄すると
  // 不変条件 3 (running(pr_fix) ⇒ … asks.fix.taken) が移行直後に破れる。
  const state = migrateOne({
    status: "in_progress",
    phase: "pr_fix",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch({
        fix_pending: false,
        pending_ids: ["rc-1"],
        findings: "/abs/findings.md",
        fix_attempts: 1,
      }),
    },
  });
  const follow = followOf(state);
  assertEquals((follow.asks as Rec).fix, {
    ids: ["rc-1"],
    findings: "/abs/findings.md",
    taken: true,
  }, "asks.fix");
  const item = onlyItem(state);
  assert(
    invariantPrFixImpliesOpenTaken(
      item.progress as Progress,
      item.run as { kind: RunKind },
      (item.artifact as Rec).state as ArtifactState,
      asFollowRecord(follow),
    ),
    "不変条件 3 を満たす",
  );
});

Deno.test("M-ASKS-4: resolve_pending 真 → asks.rebase.resolve 真・任意キー保持", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch(),
      rebase: {
        blocked_onto: "def456",
        reason: "conflict",
        at: "2026-08-02T08:30:00Z",
        kind: "overlap",
        cause: "同じファイルへの重複変更",
        report: "/abs/report.md",
        resolve_pending: true,
        from_tip: "old-tip",
      },
    },
  }));
  assertEquals((follow.asks as Rec).rebase, {
    blocked_onto: "def456",
    reason: "conflict",
    at: "2026-08-02T08:30:00Z",
    kind: "overlap",
    cause: "同じファイルへの重複変更",
    report: "/abs/report.md",
    from_tip: "old-tip",
    resolve: true,
    taken: false,
  }, "asks.rebase");
});

Deno.test("M-ASKS-5: resolve_pending 無し・任意キー無し → resolve false・キーごと無し", () => {
  const ask = (followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch(),
      rebase: { blocked_onto: "def456", reason: "dirty", at: NOW },
    },
  })).asks as Rec).rebase as Rec;
  assertEquals(ask, {
    blocked_onto: "def456",
    reason: "dirty",
    at: NOW,
    resolve: false,
    taken: false,
  }, "asks.rebase");
});

Deno.test("M-ASKS-6: kind rebase_fix と判定した item だけ asks.rebase.taken: true", () => {
  const rebase = {
    blocked_onto: "def456",
    reason: "conflict",
    at: NOW,
    resolve_pending: true,
  };
  const cycle = followOf(migrateOne({
    status: "in_progress",
    phase: "rebase_fix",
    review: { ref: "https://x/pull/1", watch: v1Watch(), rebase },
  }));
  assertEquals(
    ((cycle.asks as Rec).rebase as Rec).taken,
    true,
    "解決サイクル (kind=rebase_fix)",
  );

  const resting = followOf(migrateOne({
    status: "in_review",
    review: { ref: "https://x/pull/1", watch: v1Watch(), rebase },
  }));
  assertEquals(
    ((resting.asks as Rec).rebase as Rec).taken,
    false,
    "resting の未消費 ask",
  );
});

// ---------------------------------------------------------------------------
// M-LEDGER-PROBE — watch の分解先 (3.2節)
// ---------------------------------------------------------------------------

Deno.test("M-LEDGER-PROBE-1: watch.* が ledger.* / probe.* に写る", () => {
  const follow = followOf(migrateOne({
    status: "in_review",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch({
        proc: "bg-1",
        proc_started_at: "2026-08-02T08:00:00Z",
        sig: "sig-1",
        head: "abc123",
        ci: "pending",
        checked_at: "2026-08-02T08:59:00Z",
        errors: 2,
        note: "ノート",
        handled: ["c1", "c2"],
        fix_attempts: 1,
        review_only: [{ id: "rc-9", updated_at: "2026-08-02T08:10:00Z" }],
        answered: [{ id: "rc-8", updated_at: null }],
      }),
    },
  }));
  assertEquals(follow.ledger, {
    handled: ["c1", "c2"],
    fix_attempts: 1,
    review_only: [{ id: "rc-9", updated_at: "2026-08-02T08:10:00Z" }],
    answered: [{ id: "rc-8", updated_at: null }],
    fix_cycle_tip: null,
    fix_rerun_tip: null,
  }, "ledger");
  assertEquals(follow.probe, {
    proc: "bg-1",
    proc_started_at: "2026-08-02T08:00:00Z",
    sig: "sig-1",
    head: "abc123",
    ci: "pending",
    checked_at: "2026-08-02T08:59:00Z",
    errors: 2,
    note: "ノート",
  }, "probe");
});

Deno.test("M-LEDGER-PROBE-2: review_only / answered 欠落 → 空配列", () => {
  const watch = v1Watch();
  delete watch.review_only;
  delete watch.answered;
  const follow = followOf(migrateOne({
    status: "in_review",
    review: { ref: "https://x/pull/1", watch },
  }));
  assertEquals((follow.ledger as Rec).review_only, [], "review_only");
  assertEquals((follow.ledger as Rec).answered, [], "answered");
});

Deno.test("M-LEDGER-PROBE-3: progress != resting では probe のリースを外す", () => {
  // 不変条件 4 (probe.proc ≠ null ⇒ progress == resting)。v1 の確認済み欠陥 6 の
  // 残骸 (飛行中の item に proc が残る) をそのまま写さない。
  const state = migrateOne({
    status: "in_progress",
    phase: "implement",
    review: {
      ref: "https://x/pull/1",
      watch: v1Watch({ proc: "bg-1", proc_started_at: NOW, sig: "sig-1" }),
    },
  });
  const probe = followOf(state).probe as Rec;
  assertEquals(probe.proc, null, "proc");
  assertEquals(probe.proc_started_at, null, "proc_started_at");
  assertEquals(probe.sig, "sig-1", "sig は観測キャッシュなので残る");
  assert(
    invariantProbeProcImpliesResting(
      onlyItem(state).progress as Progress,
      makeProbe({ proc: probe.proc as string | null }),
    ),
    "不変条件 4 を満たす",
  );
});

// ---------------------------------------------------------------------------
// M-TOP — トップレベル (3.1b節)
// ---------------------------------------------------------------------------

Deno.test("M-TOP-1: schema_version 2 と completed が常に付く", () => {
  const state = migrateV1toV2(v1State([]), NOW);
  assertEquals(state.schema_version, V2_SCHEMA_VERSION, "schema_version");
  assertEquals(state.completed, [], "completed");
});

Deno.test("M-TOP-2: v1 で任意だったキーは有れば保持・無ければ付けない", () => {
  const withOptional = migrateV1toV2(
    v1State([], {
      stalled: "depleted",
      stalled_since: "2026-08-02T08:00:00Z",
      withdrawn_branches: [{
        id: "t-2",
        branch: "b",
        base: "main",
        worktree: "/w",
        at: NOW,
        reason: "取り下げ",
      }],
      schema_version: 1,
    }),
    NOW,
  );
  assertSchemaOk(withOptional, "M-TOP-2 (任意キー有り)");
  assertEquals(withOptional.stalled, "depleted", "stalled");
  assertEquals(
    withOptional.stalled_since,
    "2026-08-02T08:00:00Z",
    "stalled_since",
  );
  assertEquals(
    (withOptional.withdrawn_branches as Rec[]).length,
    1,
    "withdrawn_branches",
  );

  const without = migrateV1toV2(v1State([]), NOW);
  assertSchemaOk(without, "M-TOP-2 (任意キー無し)");
  assert(!("stalled" in without), "stalled キーは足さない");
  assert(!("stalled_since" in without), "stalled_since キーは足さない");
  assert(
    !("withdrawn_branches" in without),
    "withdrawn_branches キーは足さない",
  );
});

Deno.test("M-TOP-3: 他のトップレベルは内容が保存される", () => {
  const state = migrateV1toV2(
    v1State([], {
      candidates: [{ id: "c-1", title: "候補", priority: "high" }],
      relisted: [{ id: "t-3", seen_at: NOW }],
      promoted: ["gh-9"],
      history: ["2026-08-07T00:00Z done t-1"],
    }),
    NOW,
  );
  assertSchemaOk(state, "M-TOP-3");
  assertEquals(state.tracker, "markdown", "tracker");
  assertEquals(state.source, "./TASKS.md", "source");
  assertEquals(state.updated_at, "2026-07-16T09:12:00Z", "updated_at");
  assertEquals(state.candidates, [{
    id: "c-1",
    title: "候補",
    priority: "high",
  }], "candidates");
  assertEquals(state.relisted, [{ id: "t-3", seen_at: NOW }], "relisted");
  assertEquals(state.promoted, ["gh-9"], "promoted");
  assertEquals(state.history, ["2026-08-07T00:00Z done t-1"], "history");
});

Deno.test("M-TOP-4: history_archived is always 0 after migration, history is not trimmed (gh-58)", () => {
  const bigHistory = Array.from({ length: 350 }, (_, i) => `synthetic-${i}`);
  const state = migrateV1toV2(
    v1State([], { history: bigHistory }),
    NOW,
  );
  assertSchemaOk(state, "M-TOP-4");
  assertEquals(state.history_archived, 0, "history_archived");
  assertEquals(
    (state.history as string[]).length,
    350,
    "migration must not trim history — the cap applies only at history-append time",
  );
});

// ---------------------------------------------------------------------------
// M-PURE — 純関数であることの検査 (受け入れ条件 5)
// ---------------------------------------------------------------------------

function collectRefs(value: unknown, into: Set<object>): void {
  if (typeof value !== "object" || value === null) return;
  into.add(value);
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, into);
  } else {
    for (const v of Object.values(value)) collectRefs(v, into);
  }
}

function richV1State(): Rec {
  return v1State([
    v1Item({ id: "t-a", status: "approved" }),
    v1Item({
      id: "t-b",
      status: "in_progress",
      phase: "pr_fix",
      review: {
        ref: "https://x/pull/1",
        branch: "b",
        tip: "t",
        base: "main",
        watch: v1Watch({
          handled: ["c1"],
          pending_ids: ["rc-1"],
          review_only: [{ id: "rc-9", updated_at: NOW }],
          answered: [],
        }),
        rebase: { blocked_onto: "def", reason: "conflict", at: NOW },
      },
    }),
    v1Item({
      id: "t-c",
      status: "done",
      worktree: null,
      review: { ref: "abc" },
    }),
    v1Item({ id: "t-d", status: "blocked", blocked_reason: "理由" }),
  ], {
    stalled: "depleted",
    stalled_since: NOW,
    candidates: [{ id: "c-1", title: "候補" }],
    relisted: [{ id: "t-3", seen_at: NOW }],
    withdrawn_branches: [{
      id: "t-2",
      branch: "b",
      base: "main",
      worktree: "/w",
      at: NOW,
      reason: "r",
    }],
  });
}

Deno.test("M-PURE-1: 入力オブジェクトを破壊しない", () => {
  const input = richV1State();
  const before = JSON.stringify(input);
  migrateV1toV2(input, NOW);
  assertEquals(JSON.stringify(input), before, "入力は不変");
});

Deno.test("M-PURE-2: 出力が入力の参照を1つも共有しない", () => {
  const input = richV1State();
  const output = migrateV1toV2(input, NOW);
  const inputRefs = new Set<object>();
  collectRefs(input, inputRefs);
  const outputRefs = new Set<object>();
  collectRefs(output, outputRefs);
  const shared = [...outputRefs].filter((ref) => inputRefs.has(ref));
  assertEquals(shared.length, 0, `共有された参照: ${shared.length} 件`);
});

Deno.test("M-PURE-3: 同じ入力からは同じ出力 (決定性)", () => {
  const input = richV1State();
  assertEquals(
    JSON.stringify(migrateV1toV2(input, NOW)),
    JSON.stringify(migrateV1toV2(input, NOW)),
    "2 回の出力",
  );
});

Deno.test("M-PURE-4: オブジェクトでない入力は throw する", () => {
  for (const bad of [null, "state", 42, [], undefined]) {
    assertThrows(() => migrateV1toV2(bad, NOW), `bad input ${String(bad)}`);
  }
  assertThrows(
    () => migrateV1toV2(v1State(["not-an-object" as unknown as Rec]), NOW),
    "queue entry が非オブジェクト",
  );
});

// ---------------------------------------------------------------------------
// M-FIXTURE — 実フィクスチャの移行 (受け入れ条件 2)
// ---------------------------------------------------------------------------

Deno.test("M-FIXTURE-1: valid-skill-example → queued × none", () => {
  const state = migrateV1toV2(validSkillExample, NOW);
  assertSchemaOk(state, "valid-skill-example");
  const item = onlyItem(state);
  assertEquals(item.progress, "queued", "progress");
  assertEquals(item.artifact, { state: "none" }, "artifact");
});

Deno.test("M-FIXTURE-2: valid-legacy-live → resting × merged (follow 無し)", () => {
  const state = migrateV1toV2(validLegacyLive, NOW);
  assertSchemaOk(state, "valid-legacy-live");
  const item = onlyItem(state);
  assertEquals(item.progress, "resting", "progress");
  assertEquals((item.artifact as Rec).state, "merged", "artifact.state");
  assert(!("follow" in (item.artifact as Rec)), "merged に follow キーは無い");
  assertEquals(
    state.completed,
    [],
    "worktree が残るので completed には移さない",
  );
});

Deno.test("M-FIXTURE-3: valid-watch-rebase → resting × open + follow", () => {
  const state = migrateV1toV2(validWatchRebase, NOW);
  assertSchemaOk(state, "valid-watch-rebase");
  const item = onlyItem(state);
  assertEquals(item.progress, "resting", "progress");
  assert(!("gate" in item), "非 in_progress なので gate は破棄されている");
  const artifact = item.artifact as Rec;
  assertEquals(artifact.state, "open", "artifact.state");
  const follow = artifact.follow as Rec;
  assertEquals(follow.attention, "auto", "attention (watching → auto)");
  assertEquals((follow.asks as Rec).fix, null, "asks.fix (fix_pending 偽)");
  assertEquals(
    ((follow.asks as Rec).rebase as Rec).resolve,
    true,
    "asks.rebase.resolve (resolve_pending 真)",
  );
  assertEquals(
    (follow.probe as Rec).proc,
    "bg-1",
    "probe.proc (resting なので残る)",
  );
  assertEquals((follow.ledger as Rec).handled, ["c1", "c2"], "ledger.handled");
});

// ---------------------------------------------------------------------------
// M-MATRIX — 出力不変条件 (どの v1 の形からも合法な v2 が出る)
// ---------------------------------------------------------------------------

function asFixAsk(value: unknown): FixAsk {
  if (value === null || typeof value !== "object") return null;
  return makeFixAsk(value as FixAskFields);
}

function asRebaseAsk(value: unknown): RebaseAsk {
  if (value === null || typeof value !== "object") return null;
  return makeRebaseAsk(value as RebaseAskFields);
}

function asFollowRecord(follow: Rec): FollowRecord {
  const asks = follow.asks as Rec;
  const probe = follow.probe as Rec;
  return makeFollow({
    attention: follow.attention as FollowRecord["attention"],
    asks: { fix: asFixAsk(asks.fix), rebase: asRebaseAsk(asks.rebase) },
    probe: makeProbe({ proc: probe.proc as string | null }),
  });
}

const MATRIX_STATUSES = [
  "approved",
  "in_progress",
  "in_review",
  "done",
  "blocked",
];

const MATRIX_PHASES = [
  null,
  "research",
  "research+plan",
  "plan",
  "implement",
  "report",
  "finalize",
  "pr_fix",
  "rebase_fix",
  "unknown-phase",
];

const MATRIX_GATES: (string | null)[] = ["full", "light", null]; // null = キー欠落

const MATRIX_REVIEWS: { label: string; review: Rec | null }[] = [
  { label: "review: null", review: null },
  {
    label: "open × グループ欄 4 キー × watch 無し",
    review: { ref: "https://x/pull/1", branch: "b", tip: "t", base: "main" },
  },
  { label: "open × {ref} だけ", review: { ref: "https://x/pull/1" } },
  {
    label: "open × watching + rebase",
    review: {
      ref: "https://x/pull/1",
      branch: "b",
      tip: "t",
      base: "main",
      watch: v1Watch({
        state: "watching",
        proc: "bg-1",
        proc_started_at: NOW,
        fix_pending: true,
        pending_ids: ["rc-1"],
        findings: "/abs/f.md",
      }),
      rebase: {
        blocked_onto: "def",
        reason: "conflict",
        at: NOW,
        resolve_pending: true,
      },
    },
  },
  {
    label: "open × stopped",
    review: {
      ref: "https://x/pull/1",
      branch: "b",
      tip: "t",
      base: "main",
      watch: v1Watch({ state: "stopped", fix_attempts: 4, errors: 3 }),
    },
  },
  {
    label: "withdrawn × withdrawn_asked 有り",
    review: {
      ref: "https://x/pull/1",
      branch: "b",
      tip: "t",
      base: "main",
      withdrawn: true,
      withdrawn_asked: true,
      watch: v1Watch({ state: "stopped" }),
    },
  },
  {
    label: "withdrawn × withdrawn_asked 無し",
    review: { ref: "https://x/pull/1", withdrawn: true },
  },
];

Deno.test("M-MATRIX: 全組で v2 スキーマと不変条件を満たす", () => {
  let cases = 0;
  for (const status of MATRIX_STATUSES) {
    for (const phase of MATRIX_PHASES) {
      for (const gate of MATRIX_GATES) {
        for (const review of MATRIX_REVIEWS) {
          for (const worktree of [null, "/abs/worktrees/t-1"]) {
            for (const blockedReason of [null, "理由"]) {
              const item = v1Item({
                status,
                phase,
                blocked_reason: blockedReason,
                worktree,
                review: review.review === null
                  ? null
                  : structuredClone(review.review),
              });
              if (gate === null) {
                delete item.gate;
              } else {
                item.gate = gate;
              }
              const label =
                `${status}/${phase}/${gate}/${review.label}/${worktree}/${blockedReason}`;
              const state = migrateV1toV2(v1State([item]), NOW);
              assertSchemaOk(state, label);
              cases++;

              const queue = queueOf(state);
              if (queue.length === 0) continue;
              const migrated = queue[0];
              const progress = migrated.progress as Progress;
              const run = migrated.run as
                | { kind: RunKind; gate: "full" | "light" | null }
                | null;
              const artifact = migrated.artifact as Rec;
              const follow = artifact.follow;
              const followRecord = follow === null || follow === undefined
                ? null
                : asFollowRecord(follow as Rec);

              assert(
                invariantRunProgressConsistent(progress, run),
                `${label}: 不変条件 1`,
              );
              assert(
                invariantMergedImpliesResting(
                  artifact.state as ArtifactState,
                  progress,
                ),
                `${label}: 不変条件 2`,
              );
              assert(
                invariantPrFixImpliesOpenTaken(
                  progress,
                  run,
                  artifact.state as ArtifactState,
                  followRecord,
                ),
                `${label}: 不変条件 3`,
              );
              assert(
                invariantProbeProcImpliesResting(
                  progress,
                  followRecord === null ? null : followRecord.probe,
                ),
                `${label}: 不変条件 4`,
              );
              assert(
                invariantTakenImpliesRunning(
                  progress,
                  followRecord === null ? null : followRecord.asks.fix,
                  followRecord === null ? null : followRecord.asks.rebase,
                ),
                `${label}: 不変条件 5 の残差`,
              );
              if (run !== null) {
                assert(
                  invariantGateNonNullIffKindInitial(run),
                  `${label}: gate iff kind==initial`,
                );
              }
            }
          }
        }
      }
    }
  }
  assertEquals(cases, 5 * 10 * 3 * 7 * 2 * 2, "生成したケース数");
});
