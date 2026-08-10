// task-pipeline/scripts/state-ledger-v2.test.ts
//
// state-ledger-v2.ts (帳簿系 15 verb の純関数群) の in-process テスト。
//
//   L-INIT   init の 4 分岐 (新規作成 / 移行 / no-op / 読めないバージョン)
//   L-NORM   読み込み時の正規化と finalizeStateV2
//   L-ARR    candidates / promoted / relisted の追加・除去と missing/conflict
//   L-STALL  stalled-set の since の扱い
//   L-SESS   heartbeat のしきい値 (厳密不等号)
//   L-DECL   LEDGER_VERBS の宣言
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//       単体: deno test task-pipeline/scripts/state-ledger-v2.test.ts

import {
  applyCandidatesDropV2,
  applyCandidatesSetV2,
  applyHistoryAppendV2,
  applyInitV2,
  applyPromotedAddV2,
  applyPromotedDropV2,
  applyRelistedAddV2,
  applyRelistedDropV2,
  applyStalledSetV2,
  buildFreshStateV2,
  finalizeStateV2,
  getV2,
  HISTORY_MAX_LINES,
  isRecord,
  isSessionAlive,
  isSessionStale,
  LEDGER_VERBS,
  normalizeStateV2,
  validateV2,
} from "./state-ledger-v2.ts";
import { CliErrorV2, type V2State } from "./state-transitions-v2.ts";
import { V2_SCHEMA_VERSION } from "./state-migrate-v2.ts";

const NOW = "2026-08-07T12:00:00.000Z";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? "assertEquals"}: got ${a}, want ${b}`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function expectCliError(
  fn: () => unknown,
  code: string,
  msg: string,
): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliErrorV2) {
      assertEquals(e.code, code as typeof e.code, `${msg}: error code`);
      return;
    }
    throw e;
  }
  throw new Error(`${msg}: expected a CliErrorV2(${code})`);
}

function freshState(): V2State {
  return buildFreshStateV2("markdown", "./TASKS.md", NOW) as unknown as V2State;
}

// ---------------------------------------------------------------------------
// L-INIT
// ---------------------------------------------------------------------------

Deno.test("L-INIT-1: no state yet creates an empty v2 state", () => {
  const next = applyInitV2(undefined, "gh", "o/r", NOW)!;
  assertEquals(next.schema_version, V2_SCHEMA_VERSION);
  assertEquals(next.tracker, "gh");
  assertEquals(next.queue, []);
  assertEquals(next.completed, []);
  assertEquals(next.withdrawn_branches, []);
});

Deno.test("L-INIT-2: a v2 state is a no-op (undefined = do not write)", () => {
  const current = buildFreshStateV2("gh", "o/r", NOW);
  assertEquals(applyInitV2(current, "OTHER", "OTHER", NOW), undefined);
});

Deno.test("L-INIT-3: schema_version 1 is migrated once", () => {
  const v1 = {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: NOW,
    schema_version: 1,
    queue: [{
      id: "t-1",
      title: "T",
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
    }],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
  };
  const migrated = applyInitV2(v1, "OTHER", "OTHER", NOW)!;
  assertEquals(migrated.schema_version, V2_SCHEMA_VERSION);
  // --tracker/--source では上書きしない (既存の値を保つ)
  assertEquals(migrated.tracker, "markdown");
  const queue = migrated.queue as Record<string, unknown>[];
  assertEquals(queue[0].progress, "queued");
  // 2 回目は no-op
  assertEquals(applyInitV2(migrated, "OTHER", "OTHER", NOW), undefined);
});

Deno.test("L-INIT-4: a missing schema_version is treated as v1", () => {
  const legacy = {
    tracker: "markdown",
    source: "./TASKS.md",
    updated_at: NOW,
    queue: [],
    candidates: [],
    relisted: [],
    promoted: [],
    history: [],
  };
  const migrated = applyInitV2(legacy, "gh", "o/r", NOW)!;
  assertEquals(migrated.schema_version, V2_SCHEMA_VERSION);
});

Deno.test("L-INIT-5: an unreadable schema_version is a schema error", () => {
  for (const version of [3, 0, -1, "2", null, {}]) {
    expectCliError(
      () =>
        applyInitV2(
          { ...buildFreshStateV2("gh", "o/r", NOW), schema_version: version },
          "gh",
          "o/r",
          NOW,
        ),
      "schema",
      `schema_version=${JSON.stringify(version)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// L-NORM
// ---------------------------------------------------------------------------

Deno.test("L-NORM-1: normalizeStateV2 fills a missing withdrawn_branches only", () => {
  const raw = { ...buildFreshStateV2("gh", "o/r", NOW) };
  delete raw.withdrawn_branches;
  const normalized = normalizeStateV2(raw);
  assertEquals(normalized.withdrawn_branches, []);
  assertEquals(normalized.tracker, "gh");
  // 既に有るときは同一参照 (触らない)
  const withEntries = { ...raw, withdrawn_branches: [{ id: "x" }] };
  assert(
    normalizeStateV2(withEntries) as unknown === withEntries,
    "an existing withdrawn_branches must be left untouched",
  );
});

Deno.test("L-NORM-2: finalizeStateV2 stamps updated_at and pins schema_version to 2", () => {
  const state = { ...freshState(), schema_version: 1 } as unknown as V2State;
  const next = finalizeStateV2(state, "2026-08-08T00:00:00.000Z");
  assertEquals(next.updated_at, "2026-08-08T00:00:00.000Z");
  assertEquals(next.schema_version, V2_SCHEMA_VERSION);
});

Deno.test("L-NORM-3: getV2 returns the value as-is, validateV2 rejects invalid states", () => {
  const state = freshState();
  assert(getV2(state) === state, "get must not copy or check");
  assertEquals(validateV2(state), { ok: true });
  expectCliError(
    () => validateV2({ tracker: "gh" }),
    "schema",
    "an incomplete state must not validate",
  );
});

Deno.test("L-NORM-4: isRecord distinguishes objects from arrays and null", () => {
  assertEquals(isRecord({}), true);
  assertEquals(isRecord([]), false);
  assertEquals(isRecord(null), false);
  assertEquals(isRecord("s"), false);
});

Deno.test("L-NORM-5: normalizeStateV2 fills a missing/non-number history_archived only", () => {
  const raw = { ...buildFreshStateV2("gh", "o/r", NOW) };
  delete raw.history_archived;
  assertEquals(normalizeStateV2(raw).history_archived, 0);
  const wrongType = { ...raw, history_archived: "3" };
  assertEquals(normalizeStateV2(wrongType).history_archived, 0);
  // 既に number のときは同一参照 (触らない)
  const withCount = { ...raw, history_archived: 3 };
  assert(
    normalizeStateV2(withCount) as unknown === withCount,
    "an existing numeric history_archived must be left untouched",
  );
});

// ---------------------------------------------------------------------------
// L-ARR
// ---------------------------------------------------------------------------

Deno.test("L-ARR-1: history-append keeps order", () => {
  let state = freshState();
  state = applyHistoryAppendV2(state, "a", HISTORY_MAX_LINES).state;
  state = applyHistoryAppendV2(state, "b", HISTORY_MAX_LINES).state;
  assertEquals(state.history, ["a", "b"]);
});

// gh-58: history-append の上限クラス (空/上限未満/上限ちょうど/上限超え)。
// cap を小さく (3) 取ることで境界ケースを直接再現する。
Deno.test("L-ARR-1b: history-append の上限クラス", () => {
  const cap = 3;

  // 空 → 追記後1件、退避なし
  const empty = applyHistoryAppendV2(freshState(), "a", cap);
  assertEquals(empty.state.history, ["a"]);
  assertEquals(empty.dropped, []);
  assertEquals(empty.state.history_archived, 0);

  // 上限未満 (追記前1件、cap=3) → 追記後2件、退避なし
  const below = applyHistoryAppendV2(empty.state, "b", cap);
  assertEquals(below.state.history, ["a", "b"]);
  assertEquals(below.dropped, []);

  // 上限ちょうど (追記前2件 → 追記後3件 = cap) → 退避なし (境界: 超えていないので落とさない)
  const exact = applyHistoryAppendV2(below.state, "c", cap);
  assertEquals(exact.state.history, ["a", "b", "c"]);
  assertEquals(exact.dropped, []);
  assertEquals(exact.state.history_archived, 0);

  // 上限超え (追記前3件 = cap → 追記後4件) → 最も古い1件 ("a") を退避、history は cap 件のまま
  const over = applyHistoryAppendV2(exact.state, "d", cap);
  assertEquals(over.state.history, ["b", "c", "d"]);
  assertEquals(over.dropped, ["a"]);
  assertEquals(over.state.history_archived, 1);
});

Deno.test("L-ARR-2: candidates set replaces, drop removes, unknown id is missing", () => {
  let state = applyCandidatesSetV2(freshState(), [{ id: "c1", title: "T" }]);
  assertEquals((state.candidates as unknown[]).length, 1);
  expectCliError(
    () => applyCandidatesDropV2(state, "zz"),
    "missing",
    "dropping an unknown candidate",
  );
  state = applyCandidatesDropV2(state, "c1");
  assertEquals(state.candidates, []);
});

Deno.test("L-ARR-3: promoted-add is a union, drop of an unknown id is missing", () => {
  let state = applyPromotedAddV2(freshState(), ["a", "b"]);
  state = applyPromotedAddV2(state, ["b", "c"]);
  assertEquals(state.promoted, ["a", "b", "c"]);
  expectCliError(
    () => applyPromotedDropV2(state, "zz"),
    "missing",
    "dropping an unknown promoted id",
  );
  assertEquals(applyPromotedDropV2(state, "b").promoted, ["a", "c"]);
});

Deno.test("L-ARR-4: relisted-add rejects duplicates (conflict), drop rejects unknown (missing)", () => {
  const state = applyRelistedAddV2(freshState(), "t-1", NOW);
  assertEquals(state.relisted, [{ id: "t-1", seen_at: NOW }]);
  expectCliError(
    () => applyRelistedAddV2(state, "t-1", NOW),
    "conflict",
    "adding a duplicate relisted id",
  );
  expectCliError(
    () => applyRelistedDropV2(state, "zz"),
    "missing",
    "dropping an unknown relisted id",
  );
  assertEquals(applyRelistedDropV2(state, "t-1").relisted, []);
});

Deno.test("L-ARR-5: the input arrays are never mutated in place", () => {
  const state = freshState();
  const before = JSON.stringify(state);
  applyHistoryAppendV2(state, "x", HISTORY_MAX_LINES);
  applyPromotedAddV2(state, ["p"]);
  applyRelistedAddV2(state, "t-1", NOW);
  applyCandidatesSetV2(state, [{ id: "c", title: "T" }]);
  assertEquals(JSON.stringify(state), before, "apply must be pure");
});

// ---------------------------------------------------------------------------
// L-STALL
// ---------------------------------------------------------------------------

Deno.test("L-STALL-1: the first set stamps since, a repeat keeps it, --bump moves it", () => {
  let state = applyStalledSetV2(freshState(), "depleted", false, NOW);
  assertEquals(state.stalled, "depleted");
  assertEquals(state.stalled_since, NOW);
  const later = "2026-08-07T13:00:00.000Z";
  state = applyStalledSetV2(state, "max_open", false, later);
  assertEquals(state.stalled, "max_open");
  assertEquals(state.stalled_since, NOW, "since must survive a value change");
  state = applyStalledSetV2(state, "max_open", true, later);
  assertEquals(state.stalled_since, later, "--bump moves since");
});

Deno.test("L-STALL-2: null clears both fields", () => {
  const state = applyStalledSetV2(
    applyStalledSetV2(freshState(), "depleted", false, NOW),
    "null",
    false,
    NOW,
  );
  assertEquals(state.stalled, null);
  assertEquals(state.stalled_since, null);
});

// ---------------------------------------------------------------------------
// L-SESS
// ---------------------------------------------------------------------------

Deno.test("L-SESS-1: alive is strict (< max), stale is strict (> cleanup)", () => {
  const now = 1_000_000_000_000;
  const minutes = (m: number) => now - m * 60_000;
  assertEquals(isSessionAlive(now, minutes(89), 90), true);
  assertEquals(
    isSessionAlive(now, minutes(90), 90),
    false,
    "exactly 90 is not alive",
  );
  assertEquals(isSessionAlive(now, minutes(91), 90), false);
  assertEquals(isSessionStale(now, minutes(1439), 1440), false);
  assertEquals(
    isSessionStale(now, minutes(1440), 1440),
    false,
    "exactly 1440 is not stale",
  );
  assertEquals(isSessionStale(now, minutes(1441), 1440), true);
});

// ---------------------------------------------------------------------------
// L-DECL
// ---------------------------------------------------------------------------

Deno.test("L-DECL-1: LEDGER_VERBS lists exactly the 15 bookkeeping verbs", () => {
  assertEquals([...LEDGER_VERBS].sort(), [
    "candidates-drop",
    "candidates-set",
    "get",
    "history-append",
    "init",
    "next",
    "promoted-add",
    "promoted-drop",
    "relisted-add",
    "relisted-drop",
    "session-touch",
    "sessions-alive",
    "stalled-set",
    "validate",
    "verdict-path",
  ]);
});
