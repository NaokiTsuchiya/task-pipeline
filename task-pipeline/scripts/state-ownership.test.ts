// task-pipeline/scripts/state-ownership.test.ts
//
// state-ownership.ts (classifySessionOwnership/isTouchable) のテスト。ファイルI/O・
// サブプロセスを一切使わない直接 import 呼び出し (state-schema.test.ts と同型)。
//
//   deno test --allow-read task-pipeline/scripts/state-ownership.test.ts
//   または: sh tests/state-cli.test.sh (state.ts と一緒に fmt/lint/check/test される)

import { classifySessionOwnership, isTouchable } from "./state-ownership.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      `${msg ?? "assertEquals failed"}: expected ${b}, got ${a}`,
    );
  }
}

// 受け入れ条件10: 自分 / null / 生存一覧に無い id / 生存している他セッション の4パターン。

Deno.test("T-O1: session === selfId -> self (touchable)", () => {
  const v = classifySessionOwnership("sess-self", "sess-self", [
    "sess-self",
    "sess-other",
  ]);
  assertEquals(v, "self");
  assertEquals(isTouchable(v), true);
});

Deno.test("T-O2: session === null -> unowned (touchable)", () => {
  const v = classifySessionOwnership(null, "sess-self", []);
  assertEquals(v, "unowned");
  assertEquals(isTouchable(v), true);
});

Deno.test("T-O3: session set but not in alive list -> dead (touchable)", () => {
  const v = classifySessionOwnership("sess-dead", "sess-self", [
    "sess-other",
  ]);
  assertEquals(v, "dead");
  assertEquals(isTouchable(v), true);
});

Deno.test("T-O4: session set and in alive list (not self) -> alive-other (not touchable)", () => {
  const v = classifySessionOwnership("sess-other", "sess-self", [
    "sess-self",
    "sess-other",
  ]);
  assertEquals(v, "alive-other");
  assertEquals(isTouchable(v), false);
});

Deno.test("T-O5: empty alive list with non-null non-self session -> dead", () => {
  const v = classifySessionOwnership("sess-other", "sess-self", []);
  assertEquals(v, "dead");
  assertEquals(isTouchable(v), true);
});
