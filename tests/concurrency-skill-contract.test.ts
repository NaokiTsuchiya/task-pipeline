// tests/concurrency-skill-contract.test.ts — task-pipeline/SKILL.md の「毎イテレーションの手順」節が
// 仕上げ (pr_fix/rebase_fix) だけが飛行中のときに新しいタスクの着手 (claim) へ到達することを固定する
// (gh-60 の受け入れ条件1・2・5)。
//
//   deno test --allow-read tests/concurrency-skill-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: 手順書は元々「counts.running が1以上 → 飛行中の扱いへ」「start.next_id が非null → タスク実行へ」
// を排他的な分岐として書いており、仕上げ run が counts.running に数えられる (docs/state-cli-contract.md)
// ため、仕上げが飛行中の間は新しいタスクへの着手判定に手順書上どうやっても到達できなかった (gh-60)。
// CLI (state-next.ts) は元々「仕上げは新規着手を塞がない」を実装・テスト済みだったので、直したのは
// SKILL.md の分岐の書き方だけである。このテストはその書き換え後の文言を grep で固定する
// (tests/max-tasks-skill-contract.test.ts と同じ「prose の契約を grep で固定する」パターン)。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。

import { assertOk, containsFixed, sedRange } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);

/** `sed -n '/^## 毎イテレーションの手順$/,/^## /p'` — 手順1の分岐を含む節だけを切り出す。 */
const section = sedRange(
  skillMd,
  /^## 毎イテレーションの手順$/,
  /^## /,
);

const A1_NEEDLE =
  "**自分の仕上げ run だけが飛行中のときは `own_initial` は立たないので、`start.allowed` は真になりうる**";
const A2_NEEDLE =
  "自分の `initial` run が飛行中なら `start.blocked_by` に `own_initial` が立ち `start.allowed` は偽になるので、この箇条書きには来ない";
const A3_NEEDLE =
  "順序は**飛行中の扱いの action 処理が先、新しい着手が後**である";

Deno.test("A0 節が空でない (見出しが一致している)", () => {
  assertOk(section.length > 0, "節が空 — 見出しパターンが一致しない");
});

Deno.test("A1 仕上げ run だけが飛行中のとき新しい着手へ進める旨が明記されている (受け入れ条件1)", () => {
  assertOk(containsFixed(section, A1_NEEDLE), "見つからない");
});

Deno.test("A2 自分の initial run が飛行中なら新しい着手へ進まない旨が明記されている (受け入れ条件2)", () => {
  assertOk(containsFixed(section, A2_NEEDLE), "見つからない");
});

Deno.test("A3 飛行中の扱いの action 処理と新しい着手の同一イテレーション内の順序が明記されている (受け入れ条件5)", () => {
  assertOk(containsFixed(section, A3_NEEDLE), "見つからない");
});

Deno.test("B1 A1 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A1_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B2 A1 の退行 (説明の消失) を A1 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A1_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A1_NEEDLE),
    "除去後も見つかってしまった",
  );
});

Deno.test("B3 A2 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A2_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B4 A2 の退行 (ガード説明の消失) を A2 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A2_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A2_NEEDLE),
    "除去後も見つかってしまった",
  );
});

Deno.test("B5 A3 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A3_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B6 A3 の退行 (順序記述の消失) を A3 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A3_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A3_NEEDLE),
    "除去後も見つかってしまった",
  );
});
