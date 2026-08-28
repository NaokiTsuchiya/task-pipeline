// task-pipeline/scripts/state-schema-v2.test.ts
//
// state-schema-v2.ts (checkStateV2 / compileCheckerV2 / collectSchemaNodesV2) と
// state.schema.json のテスト。
//
//   deno task test    (リポジトリルートの deno.json。*.test.ts を自動検出して実行する)
//   単体で回すなら: deno test --allow-read=<repo> task-pipeline/scripts/state-schema-v2.test.ts
//
// 系統 (plan §3.2 の S-*):
//   S-META  — state.schema.json 自体の形式検査
//   S-ALIGN — state-model-v2.ts (#34) の宣言との突き合わせ
//   S-OK    — 合法な v2 state を誤って拒否しない
//   S-NG    — 到達不能な組 (受け入れ条件4を含む) を invalid にする
//   S-WALK  — walker のキーワード実装 (特に oneOf) の固定ケース
//   S-AJV   — ajv (draft 2020-12) との判定一致 (取得不能環境では ignored になる)
//   S-NONPM — state-schema-v2.ts / state-migrate-v2.ts / state-next.ts の実行時依存ゼロ

import {
  ALLOWED_KEYWORDS_V2,
  type CheckResult,
  checkStateV2,
  collectSchemaNodesV2,
  compileCheckerV2,
} from "./state-schema-v2.ts";
import schemaJsonRaw from "./state.schema.json" with { type: "json" };
import {
  ARTIFACT_STATE_VALUES,
  GATE_VALUES,
  HUMAN_ATTENTION_REASON_VALUES,
  PROGRESS_VALUES,
  RUN_AXES,
} from "./state-model-v2.ts";

const schemaJson: unknown = schemaJsonRaw;

// ---------------------------------------------------------------------------
// 依存ゼロの assert / 汎用ヘルパ
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: ${a} !== ${e}`);
}

function assertOk(result: CheckResult, label: string): void {
  if (!result.ok) {
    throw new Error(
      `${label}: expected ok, got fail at "${result.path}": ${result.message}`,
    );
  }
}

function assertFail(result: CheckResult, label: string): void {
  if (result.ok) throw new Error(`${label}: expected fail, got ok`);
}

function assertThrows(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${label}: expected throw`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defOf(name: string): Record<string, unknown> {
  const defs = isPlainRecord(schemaJson) ? schemaJson["$defs"] : undefined;
  if (!isPlainRecord(defs) || !isPlainRecord(defs[name])) {
    throw new Error(`$defs.${name} not found`);
  }
  return defs[name];
}

function enumOfProperty(def: string, property: string): unknown[] {
  const properties = defOf(def)["properties"];
  if (!isPlainRecord(properties) || !isPlainRecord(properties[property])) {
    throw new Error(`$defs.${def}.properties.${property} not found`);
  }
  const values = properties[property]["enum"];
  if (!Array.isArray(values)) {
    throw new Error(`$defs.${def}.properties.${property} has no enum`);
  }
  return values;
}

// ---------------------------------------------------------------------------
// v2 state のファクトリ (テストケースはこれらの override で書く)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const PROBE: Rec = {
  proc: null,
  proc_started_at: null,
  sig: null,
  head: null,
  ci: null,
  checked_at: null,
  errors: 0,
  note: null,
};

const LEDGER: Rec = {
  handled: [],
  fix_attempts: 0,
  review_only: [],
  answered: [],
  fix_cycle_tip: null,
  fix_rerun_tip: null,
};

function follow(over: Rec = {}): Rec {
  return {
    attention: "auto",
    asks: { fix: null, rebase: null },
    ledger: { ...LEDGER },
    probe: { ...PROBE },
    ...over,
  };
}

function openArtifact(over: Rec = {}): Rec {
  return {
    state: "open",
    ref: "https://github.com/o/r/pull/7",
    branch: "task-pipeline/t-1",
    tip: "abc123",
    base: "main",
    follow: follow(),
    ...over,
  };
}

function run(over: Rec = {}): Rec {
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
    ...over,
  };
}

function item(over: Rec = {}): Rec {
  return {
    id: "t-1",
    title: "タイトル",
    progress: "queued",
    run: null,
    blocked_reason: null,
    artifact: { state: "none" },
    worktree: null,
    base: null,
    session: null,
    ...over,
  };
}

function stateOf(queue: Rec[], over: Rec = {}): Rec {
  return {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: "2026-08-07T00:00:00Z",
    schema_version: 2,
    queue,
    completed: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
    ...over,
  };
}

function oneItem(over: Rec): Rec {
  return stateOf([item(over)]);
}

// ---------------------------------------------------------------------------
// S-OK / S-NG のケース表 (S-AJV が同じ表を使う)
// ---------------------------------------------------------------------------

const VALID_CASES: { label: string; value: unknown }[] = [
  { label: "queued × none", value: oneItem({}) },
  {
    label: "resting × open + follow(auto)",
    value: oneItem({ progress: "resting", artifact: openArtifact() }),
  },
  {
    label: "resting × open + follow(null) — finish=commit",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({ ref: "abc123", follow: null }),
    }),
  },
  {
    label:
      "resting × open + follow(human fix_limit, fix ask, rebase ask 全キー)",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          attention: { human: "fix_limit" },
          asks: {
            fix: { ids: ["rc-1"], findings: "/abs/findings.md", taken: false },
            rebase: {
              blocked_onto: "def456",
              reason: "conflict",
              at: "2026-08-07T00:00:00Z",
              kind: "overlap",
              cause: "重複変更",
              report: "/abs/report.md",
              from_tip: "old-tip",
              resolve: true,
              taken: false,
            },
          },
          ledger: {
            handled: ["c1"],
            fix_attempts: 2,
            review_only: [{ id: "rc-9", updated_at: null }],
            answered: [{ id: "rc-8", updated_at: "2026-08-07T00:00:00Z" }],
            fix_cycle_tip: "abc123",
            fix_rerun_tip: null,
          },
          probe: {
            ...PROBE,
            proc: "bg-1",
            proc_started_at: "2026-08-07T00:00:00Z",
            sig: "sig-1",
            head: "abc123",
            ci: "passing",
            checked_at: "2026-08-07T00:01:00Z",
            errors: 1,
            note: "ノート",
          },
        }),
      }),
    }),
  },
  {
    label: "rebase ask が任意キーを持たない形",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          asks: {
            fix: null,
            rebase: {
              blocked_onto: "def456",
              reason: "dirty",
              at: "2026-08-07T00:00:00Z",
              resolve: false,
              taken: false,
            },
          },
        }),
      }),
    }),
  },
  {
    label: "running(initial, full, research) × none",
    value: oneItem({ progress: "running", run: run() }),
  },
  {
    label: "running(initial, light, research+plan) × none",
    value: oneItem({
      progress: "running",
      run: run({ gate: "light", phase: "research+plan" }),
    }),
  },
  {
    label: "running(pr_fix, pr_fix) × open + taken fix ask",
    value: oneItem({
      progress: "running",
      run: run({ kind: "pr_fix", gate: null, phase: "pr_fix" }),
      artifact: openArtifact({
        follow: follow({
          asks: {
            fix: { ids: ["rc-1"], findings: null, taken: true },
            rebase: null,
          },
        }),
      }),
    }),
  },
  {
    label: "running(rebase_fix, rebase_fix) × open",
    value: oneItem({
      progress: "running",
      run: run({ kind: "rebase_fix", gate: null, phase: "rebase_fix" }),
      artifact: openArtifact(),
    }),
  },
  {
    label: "running(initial, full, rebase_fix) — 迂回フェーズ",
    value: oneItem({ progress: "running", run: run({ phase: "rebase_fix" }) }),
  },
  {
    label: "resting × merged",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "merged",
        ref: "https://github.com/o/r/pull/7",
        branch: "task-pipeline/t-1",
        tip: "abc123",
        base: "main",
      },
    }),
  },
  {
    label: "resting × withdrawn",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "withdrawn",
        ref: "https://github.com/o/r/pull/7",
        branch: "task-pipeline/t-1",
        tip: "abc123",
        base: "main",
        asked: true,
        note: "取り下げ",
      },
    }),
  },
  {
    label: "blocked × open (v2 で新たに表現可能になった組)",
    value: oneItem({
      progress: "blocked",
      blocked_reason: "自力で進めない",
      artifact: openArtifact(),
    }),
  },
  {
    label: "gh-70: running + run.verifier/verifier_session が非null の文字列",
    value: oneItem({
      progress: "running",
      run: run({ verifier: "agent-1", verifier_session: "s1" }),
    }),
  },
  {
    label: "トップレベルの任意キーと completed",
    value: stateOf([], {
      stalled: "depleted",
      stalled_since: "2026-08-07T00:00:00Z",
      completed: [{ id: "gh-1", done_at: "2026-08-07T00:00:00Z" }],
      withdrawn_branches: [{
        id: "t-2",
        branch: "b",
        base: "main",
        worktree: "/w",
        at: "2026-08-07T00:00:00Z",
        reason: "取り下げ",
      }],
      candidates: [{ id: "c-1", title: "候補" }],
      relisted: [{ id: "t-3", seen_at: "2026-08-07T00:00:00Z" }],
      promoted: ["gh-9"],
      history: ["2026-08-07T00:00Z done t-1"],
      history_archived: 3,
    }),
  },
  {
    // gh-58: history_archived は任意キー。stateOf の既定値には含めていないので、
    // この case は「無くても合法」を明示的に確認する (直上の case が「あっても合法」)。
    label: "gh-58: history_archived が無い state も合法 (任意キー)",
    value: stateOf([]),
  },
  {
    // gh-156: controller_lease は任意キー。3 つ (欠落 / null / 正常オブジェクト) すべてが
    // 合法であることが「欠落は null と同義」の実装の前提になる。
    label: "gh-156: controller_lease が無い state も合法 (任意キー)",
    value: stateOf([]),
  },
  {
    label: "gh-156: controller_lease が null",
    value: stateOf([], { controller_lease: null }),
  },
  {
    label: "gh-156: controller_lease が 3 キーそろったオブジェクト",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        epoch: 1756339200000,
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の epoch は 0 でよい",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        epoch: 0,
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
];

const INVALID_CASES: { label: string; value: unknown }[] = [
  // --- 進行タグ (受け入れ条件4: run 非 null かつ progress が running 以外) ---
  { label: "queued + run 非 null", value: oneItem({ run: run() }) },
  {
    label: "resting + run 非 null",
    value: oneItem({ progress: "resting", run: run() }),
  },
  {
    label: "blocked + run 非 null",
    value: oneItem({
      progress: "blocked",
      blocked_reason: "理由",
      run: run(),
    }),
  },
  { label: "running + run: null", value: oneItem({ progress: "running" }) },
  {
    label: "blocked + blocked_reason: null",
    value: oneItem({ progress: "blocked" }),
  },
  {
    label: "queued + blocked_reason 非 null",
    value: oneItem({ blocked_reason: "理由" }),
  },
  { label: "progress 未知値", value: oneItem({ progress: "in_review" }) },
  { label: "item に余分キー", value: oneItem({ gate: "full" }) },
  {
    label: "item の session キー欠落",
    value: stateOf([(() => {
      const i = item();
      delete i.session;
      return i;
    })()]),
  },
  {
    label: "gh-70: run の verifier キー欠落",
    value: oneItem({
      progress: "running",
      run: (() => {
        const r = run();
        delete r.verifier;
        return r;
      })(),
    }),
  },
  {
    label: "gh-70: run の verifier_session キー欠落",
    value: oneItem({
      progress: "running",
      run: (() => {
        const r = run();
        delete r.verifier_session;
        return r;
      })(),
    }),
  },
  // --- run タグ (受け入れ条件4: gate 非 null かつ kind が initial 以外) ---
  {
    label: "kind pr_fix + gate full",
    value: oneItem({
      progress: "running",
      run: run({ kind: "pr_fix", gate: "full", phase: "pr_fix" }),
    }),
  },
  {
    label: "kind rebase_fix + gate light",
    value: oneItem({
      progress: "running",
      run: run({ kind: "rebase_fix", gate: "light", phase: "rebase_fix" }),
    }),
  },
  {
    label: "kind initial + gate null",
    value: oneItem({ progress: "running", run: run({ gate: null }) }),
  },
  {
    label: "initial/light + phase research (死に組)",
    value: oneItem({
      progress: "running",
      run: run({ gate: "light", phase: "research" }),
    }),
  },
  {
    label: "initial/full + phase research+plan",
    value: oneItem({
      progress: "running",
      run: run({ phase: "research+plan" }),
    }),
  },
  {
    label: "pr_fix + phase implement",
    value: oneItem({
      progress: "running",
      run: run({ kind: "pr_fix", gate: null, phase: "implement" }),
    }),
  },
  {
    label: "rebase_fix + phase pr_fix",
    value: oneItem({
      progress: "running",
      run: run({ kind: "rebase_fix", gate: null, phase: "pr_fix" }),
    }),
  },
  {
    label: "run に余分キー",
    value: oneItem({ progress: "running", run: run({ session: "s" }) }),
  },
  {
    label: "attempts が負",
    value: oneItem({ progress: "running", run: run({ attempts: -1 }) }),
  },
  // --- artifact タグ (受け入れ条件4: merged に follow キー) ---
  {
    label: "merged に follow キー",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "merged",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
        follow: follow(),
      },
    }),
  },
  {
    label: "withdrawn に follow キー",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "withdrawn",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
        asked: false,
        note: null,
        follow: follow(),
      },
    }),
  },
  {
    label: "none に ref キー",
    value: oneItem({ artifact: { state: "none", ref: "r" } }),
  },
  {
    label: "open の follow キー欠落",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "open",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
      },
    }),
  },
  {
    label: "open の branch キー欠落",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "open",
        ref: "r",
        tip: "t",
        base: "main",
        follow: null,
      },
    }),
  },
  {
    label: "withdrawn の asked 欠落",
    value: oneItem({
      progress: "resting",
      artifact: {
        state: "withdrawn",
        ref: "r",
        branch: "b",
        tip: "t",
        base: "main",
        note: null,
      },
    }),
  },
  {
    label: "artifact.state 未知値",
    value: oneItem({ artifact: { state: "closed" } }),
  },
  // --- follow の中身 ---
  {
    label: 'attention が文字列 "human"',
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({ follow: follow({ attention: "human" }) }),
    }),
  },
  {
    label: "attention.human が enum 外",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({ attention: { human: "other" } }),
      }),
    }),
  },
  {
    label: "attention.human に余分キー",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({ attention: { human: "manual", extra: 1 } }),
      }),
    }),
  },
  {
    label: "asks.fix の taken 欠落",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          asks: { fix: { ids: [], findings: null }, rebase: null },
        }),
      }),
    }),
  },
  {
    label: "asks.fix.ids が非配列",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          asks: {
            fix: { ids: "rc-1", findings: null, taken: false },
            rebase: null,
          },
        }),
      }),
    }),
  },
  {
    label: "asks.rebase の resolve 欠落",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          asks: {
            fix: null,
            rebase: {
              blocked_onto: "d",
              reason: "dirty",
              at: "t",
              taken: false,
            },
          },
        }),
      }),
    }),
  },
  {
    label: "asks.rebase.reason が enum 外",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          asks: {
            fix: null,
            rebase: {
              blocked_onto: "d",
              reason: "unknown",
              at: "t",
              resolve: false,
              taken: false,
            },
          },
        }),
      }),
    }),
  },
  {
    label: "ledger.fix_attempts が負",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({ ledger: { ...LEDGER, fix_attempts: -1 } }),
      }),
    }),
  },
  {
    label: "probe.errors が負",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({ probe: { ...PROBE, errors: -1 } }),
      }),
    }),
  },
  {
    label: "probe.ci が enum 外",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({ probe: { ...PROBE, ci: "bogus" } }),
      }),
    }),
  },
  {
    label: "probe の sig キー欠落",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({
        follow: follow({
          probe: {
            proc: null,
            proc_started_at: null,
            head: null,
            ci: null,
            checked_at: null,
            errors: 0,
            note: null,
          },
        }),
      }),
    }),
  },
  {
    label: "follow に余分キー",
    value: oneItem({
      progress: "resting",
      artifact: openArtifact({ follow: follow({ state: "watching" }) }),
    }),
  },
  // --- トップレベル ---
  {
    label: "completed 欠落",
    value: (() => {
      const s = stateOf([]);
      delete s.completed;
      return s;
    })(),
  },
  {
    label: "completed 要素の done_at 欠落",
    value: stateOf([], { completed: [{ id: "gh-1" }] }),
  },
  { label: "schema_version が 1", value: stateOf([], { schema_version: 1 }) },
  {
    label: "schema_version 欠落",
    value: (() => {
      const s = stateOf([]);
      delete s.schema_version;
      return s;
    })(),
  },
  { label: "未知トップレベルキー", value: stateOf([], { review: null }) },
  { label: "queue が非配列", value: stateOf([], { queue: {} }) },
  {
    label: "gh-58: history_archived が負数",
    value: stateOf([], { history_archived: -1 }),
  },
  {
    label: "gh-58: history_archived が文字列",
    value: stateOf([], { history_archived: "3" }),
  },
  {
    label: "gh-156: controller_lease に余分なキー",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        epoch: 1,
        acquired_at: "2026-08-28T00:00:00Z",
        holder: "extra",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の session が数値",
    value: stateOf([], {
      controller_lease: {
        session: 1,
        epoch: 1,
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の epoch が文字列",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        epoch: "1",
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の epoch が負数",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        epoch: -1,
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の epoch 欠落",
    value: stateOf([], {
      controller_lease: {
        session: "driver-abc",
        acquired_at: "2026-08-28T00:00:00Z",
      },
    }),
  },
  {
    label: "gh-156: controller_lease の acquired_at 欠落",
    value: stateOf([], {
      controller_lease: { session: "driver-abc", epoch: 1 },
    }),
  },
  {
    label: "gh-156: controller_lease が配列",
    value: stateOf([], { controller_lease: [] }),
  },
];

// ---------------------------------------------------------------------------
// S-META — state.schema.json 自体の形式検査
// ---------------------------------------------------------------------------

Deno.test("S-META", async (t) => {
  const nodes = collectSchemaNodesV2(schemaJson);

  await t.step("oneOf ノードは oneOf 以外のキーワードを持たない", () => {
    for (const { schemaPath, node } of nodes) {
      if (!("oneOf" in node)) continue;
      const keys = Object.keys(node);
      if (keys.length !== 1) {
        throw new Error(
          `${schemaPath}: oneOf node must have only "oneOf", got ${
            keys.join(",")
          }`,
        );
      }
      if (!Array.isArray(node["oneOf"]) || node["oneOf"].length < 2) {
        throw new Error(`${schemaPath}: oneOf must have at least 2 branches`);
      }
    }
  });

  await t.step(
    "object ノードは properties + additionalProperties:false を持つ",
    () => {
      for (const { schemaPath, node } of nodes) {
        const type = node["type"];
        const types = Array.isArray(type) ? type.map(String) : [String(type)];
        if (!types.includes("object")) continue;
        if (!isPlainRecord(node["properties"])) {
          throw new Error(`${schemaPath}: object node missing "properties"`);
        }
        if (node["additionalProperties"] !== false) {
          throw new Error(
            `${schemaPath}: object node missing additionalProperties:false`,
          );
        }
      }
    },
  );

  await t.step("required のキーは properties に存在する", () => {
    for (const { schemaPath, node } of nodes) {
      const required = node["required"];
      if (!Array.isArray(required)) continue;
      const properties = isPlainRecord(node["properties"])
        ? node["properties"]
        : {};
      for (const key of required) {
        if (!(String(key) in properties)) {
          throw new Error(`${schemaPath}: required "${key}" not in properties`);
        }
      }
    }
  });

  await t.step("全 $ref が $defs に解決する", () => {
    const defs = isPlainRecord(schemaJson) && isPlainRecord(schemaJson["$defs"])
      ? schemaJson["$defs"]
      : {};
    for (const { schemaPath, node } of nodes) {
      const ref = node["$ref"];
      if (typeof ref !== "string") continue;
      if (!ref.startsWith("#/$defs/")) {
        throw new Error(`${schemaPath}: unsupported $ref form "${ref}"`);
      }
      if (!isPlainRecord(defs[ref.slice("#/$defs/".length)])) {
        throw new Error(`${schemaPath}: $ref does not resolve: "${ref}"`);
      }
    }
  });

  await t.step("使うキーワードは ALLOWED_KEYWORDS_V2 の中だけ", () => {
    for (const { schemaPath, node } of nodes) {
      for (const key of Object.keys(node)) {
        if (!ALLOWED_KEYWORDS_V2.has(key)) {
          throw new Error(`${schemaPath}: unsupported keyword "${key}"`);
        }
      }
    }
    // oneOf を足したこと自体の固定 (v1 の 8 個 + oneOf)。
    assertEquals(
      [...ALLOWED_KEYWORDS_V2].sort(),
      [
        "$ref",
        "additionalProperties",
        "enum",
        "items",
        "minimum",
        "oneOf",
        "properties",
        "required",
        "type",
      ],
      "ALLOWED_KEYWORDS_V2",
    );
  });
});

// ---------------------------------------------------------------------------
// S-ALIGN — state-model-v2.ts の宣言との突き合わせ
// ---------------------------------------------------------------------------

Deno.test("S-ALIGN", async (t) => {
  await t.step("progress のタグ集合 = PROGRESS_VALUES", () => {
    const declared = [
      ...enumOfProperty("itemAtRest", "progress"),
      ...enumOfProperty("itemRunning", "progress"),
      ...enumOfProperty("itemBlocked", "progress"),
    ].map(String).sort();
    assertEquals(declared, [...PROGRESS_VALUES].sort(), "progress tags");
  });

  await t.step("run の 4 枝 = RUN_AXES の (kind, gate) とフェーズ列", () => {
    const branchNames = [
      "runInitialFull",
      "runInitialLight",
      "runPrFix",
      "runRebaseFix",
    ];
    const branches = branchNames.map((name) => {
      const properties = defOf(name)["properties"] as Record<string, unknown>;
      const gateNode = properties["gate"] as Record<string, unknown>;
      const gate = Array.isArray(gateNode["enum"])
        ? String(gateNode["enum"][0])
        : null;
      return {
        kind: String(enumOfProperty(name, "kind")[0]),
        gate,
        phases: enumOfProperty(name, "phase").map(String),
      };
    });
    assertEquals(branches.length, RUN_AXES.length, "run branch count");
    for (const axis of RUN_AXES) {
      const branch = branches.find((b) =>
        b.kind === axis.kind && b.gate === axis.gate
      );
      if (branch === undefined) {
        throw new Error(`no run branch for axis ${axis.axisKey()}`);
      }
      assertEquals(
        branch.phases,
        [...axis.phases()],
        `phase enum for ${axis.axisKey()}`,
      );
    }
    // gate の値集合そのものも突き合わせる (initial の 2 枝が GATE_VALUES を覆う)。
    assertEquals(
      branches.map((b) => b.gate).filter((g) => g !== null).sort(),
      [...GATE_VALUES].sort(),
      "gate values",
    );
  });

  await t.step("artifact のタグ集合 = ARTIFACT_STATE_VALUES", () => {
    const declared = [
      "artifactNone",
      "artifactOpen",
      "artifactMerged",
      "artifactWithdrawn",
    ].map((name) => String(enumOfProperty(name, "state")[0])).sort();
    assertEquals(declared, [...ARTIFACT_STATE_VALUES].sort(), "artifact tags");
  });

  await t.step(
    "attention.human の enum = HUMAN_ATTENTION_REASON_VALUES",
    () => {
      assertEquals(
        enumOfProperty("attentionHuman", "human").map(String),
        [...HUMAN_ATTENTION_REASON_VALUES],
        "human reasons",
      );
    },
  );

  await t.step("schema_version は 2 に固定されている", () => {
    const properties = isPlainRecord(schemaJson)
      ? schemaJson["properties"]
      : undefined;
    if (
      !isPlainRecord(properties) || !isPlainRecord(properties["schema_version"])
    ) {
      throw new Error("root.properties.schema_version not found");
    }
    assertEquals(properties["schema_version"]["enum"], [2], "schema_version");
  });
});

// ---------------------------------------------------------------------------
// S-OK / S-NG
// ---------------------------------------------------------------------------

Deno.test("S-OK", async (t) => {
  for (const c of VALID_CASES) {
    await t.step(c.label, () => assertOk(checkStateV2(c.value), c.label));
  }
});

Deno.test("S-NG", async (t) => {
  for (const c of INVALID_CASES) {
    await t.step(c.label, () => assertFail(checkStateV2(c.value), c.label));
  }
});

// ---------------------------------------------------------------------------
// S-WALK — walker のキーワード実装 (特に oneOf) の固定ケース
// ---------------------------------------------------------------------------

Deno.test("S-WALK", async (t) => {
  await t.step("oneOf: 適合 1 枝 → ok", () => {
    const check = compileCheckerV2({
      oneOf: [{ type: "string" }, { type: "boolean" }],
    });
    assertOk(check("x"), "string branch");
    assertOk(check(true), "boolean branch");
  });

  await t.step("oneOf: 適合 0 枝 → fail", () => {
    const check = compileCheckerV2({
      oneOf: [{ type: "string" }, { type: "boolean" }],
    });
    const result = check(null);
    assertFail(result, "no branch");
    assert(
      !result.ok && result.message.includes("matched none of 2"),
      `message should name the branch count: ${JSON.stringify(result)}`,
    );
  });

  await t.step("oneOf: 適合 2 枝 → fail (判別が効いていない)", () => {
    const check = compileCheckerV2({
      oneOf: [{ type: "string" }, { type: "string", enum: ["a"] }],
    });
    const result = check("a");
    assertFail(result, "ambiguous branches");
    assert(
      !result.ok && result.message.includes("matched 2 of 2"),
      `message should report the match count: ${JSON.stringify(result)}`,
    );
  });

  await t.step("oneOf が items の下にある形", () => {
    const check = compileCheckerV2({
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "boolean" }] },
    });
    assertOk(check(["a", true]), "array of union");
    assertFail(check(["a", 1]), "array with non-matching element");
  });

  await t.step("collectSchemaNodesV2 が oneOf の枝を辿る", () => {
    const nodes = collectSchemaNodesV2({
      $defs: {
        u: { oneOf: [{ type: "string" }, { type: "boolean" }] },
      },
      type: "object",
      properties: { a: { $ref: "#/$defs/u" } },
      additionalProperties: false,
    });
    const paths = nodes.map((n) => n.schemaPath);
    assert(
      paths.includes("$defs.u.oneOf[0]") && paths.includes("$defs.u.oneOf[1]"),
      `oneOf branches must be collected: ${paths.join(",")}`,
    );
  });

  await t.step(
    "未知キーワードで compileCheckerV2 が throw (fail-closed)",
    () => {
      assertThrows(
        () =>
          compileCheckerV2({
            type: "object",
            properties: { a: { type: "string", pattern: ".*" } },
            additionalProperties: false,
          }),
        "unknown keyword",
      );
    },
  );

  await t.step("解決しない $ref は検査時に throw", () => {
    const check = compileCheckerV2({ $ref: "#/$defs/missing" });
    assertThrows(() => check({}), "unresolvable $ref");
  });

  await t.step("スキーマがオブジェクトでなければ throw", () => {
    assertThrows(() => compileCheckerV2("nope"), "non-object schema");
  });
});

// ---------------------------------------------------------------------------
// S-AJV — ajv (draft 2020-12) との判定一致
// ---------------------------------------------------------------------------

interface AjvValidateFn {
  (data: unknown): boolean;
}
interface AjvInstance {
  compile(schema: unknown): AjvValidateFn;
}
interface AjvConstructor {
  new (options: { strict: boolean }): AjvInstance;
}

// ajv の取得可否をテスト登録より前に確定させる。取得できなければ Deno.test の `ignore` を
// 立てて、deno test の集計に **ignored** として現れるようにする (以前は fn の中で
// console.log + 早期 return していたが、それだと集計上は PASS と区別が付かず、ajv が
// 取れない環境でスキーマ判定の突き合わせが行われていないことに気づけなかった)。
// CI は ignored が 1 件でもあれば失敗する (.github/workflows/tests.yml)。
//
// npm: の直書きはこのテストファイルだけの例外。実装側 (S-NONPM が見る 3 ファイル) は
// 実行時依存ゼロを保つ。動的 import なので、取得できない環境でも catch できる。
let AjvCtor: AjvConstructor | undefined;
try {
  // deno-lint-ignore no-import-prefix
  const mod = await import("npm:ajv@8.17.1/dist/2020.js");
  AjvCtor = mod.default as unknown as AjvConstructor;
} catch {
  AjvCtor = undefined;
}

Deno.test({
  name: "S-AJV",
  ignore: AjvCtor === undefined,
  fn: async (t) => {
    const ajv = new AjvCtor!({ strict: true });
    const validate = ajv.compile(schemaJson);

    for (const c of [...VALID_CASES, ...INVALID_CASES]) {
      await t.step(c.label, () => {
        const ajvOk = validate(c.value);
        const ourOk = checkStateV2(c.value).ok;
        if (ajvOk !== ourOk) {
          throw new Error(`disagreement: ajv=${ajvOk} checkStateV2=${ourOk}`);
        }
      });
    }
  },
});

// ---------------------------------------------------------------------------
// S-NONPM — 実行時依存ゼロを grep で固定
// ---------------------------------------------------------------------------

// state-next.ts が入っているのは、旧 tests/state-next.test.sh が `deno check --no-remote` /
// `deno test --no-remote` で強制していた「外部モジュールを一切呼ばない」を、ラッパー削除後も
// 残すため (deno task check/test は --no-remote を付けない)。
Deno.test("S-NONPM", async () => {
  for (
    const name of [
      "state-schema-v2.ts",
      "state-migrate-v2.ts",
      "state-next.ts",
    ]
  ) {
    const src = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
    if (/\bnpm:|\bjsr:/.test(src)) {
      throw new Error(`${name} must not reference npm: or jsr: specifiers`);
    }
  }
});
