// tests/pr-watch-pending-draft-contract.test.ts — 下書き (state:PENDING) のレビュー・
// レビューコメントを PR 追従から外す規律が、署名側 (task-pipeline/scripts/watch-pr.sh) と
// 観測側 (task-pipeline/references/pr-watcher.md 手順 4) の両方に残っていることを固定する。
//
//   deno test --allow-read tests/pr-watch-pending-draft-contract.test.ts
//   deno task test
//
// 署名側の**挙動**は tests/watch-pr.test.sh がフィクスチャで固定しているが、そこで固定
// できるのは jq フィルタだけである — モック gh はクエリ本文を読まずにフィクスチャ JSON を
// 返すので、「クエリが `state` を取っていること」はどのケースでも赤くならない。`state` の
// 選択が落ちれば実 API の応答から `state` が消え、jq の除外は静かに無効化される (すべての
// コメントが送信済みに見える)。観測側は判定主体が LLM なので、そもそも固定できるのは文面
// だけである。この 2 つをここで押さえる。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
  substituteFirstPerLine,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const WATCH_SH = new URL("task-pipeline/scripts/watch-pr.sh", REPO_ROOT);
const PR_WATCHER_MD = new URL(
  "task-pipeline/references/pr-watcher.md",
  REPO_ROOT,
);

const watchSh = Deno.readTextFileSync(WATCH_SH);
const prWatcherMd = Deno.readTextFileSync(PR_WATCHER_MD);

const step4 = sedRange(prWatcherMd, /^4\. レビューと未解決スレッド/, /^5\. /);
const filterRules = sedRange(step4, /^ {3}絞り込み:/, /^5\. /);

const THREAD_COMMENTS_SELECTION =
  "comments(last:20){nodes{databaseId author{login} path line url body updatedAt state}}";
const REVIEWS_SELECTION = "reviews(last:50){nodes{databaseId state";
const SIG_THREAD_COMMENTS = "comments(last:20){nodes{updatedAt state}}";
const SIG_REVIEWS = "reviews(last:50){totalCount nodes{updatedAt state}}";
const PENDING_RULE_NEEDLE = "`state` が `PENDING` のコメント/レビューは落とす";

/** 絞り込みのうち下書きを落とす規則の 1 行 (無ければ null)。 */
function pendingRuleLine(rules: string): string | null {
  return grepFixedFirstLine(rules, PENDING_RULE_NEEDLE);
}

Deno.test("A0 pr-watcher.md の手順 4 と絞り込みの範囲が抽出できる", () => {
  const lines = step4.split("\n");
  assertOk(
    lines.length > 2 && /^5\. /.test(lines[lines.length - 1]),
    `手順 4 の範囲が閉じていない — lines=${lines.length}`,
  );
  assertOk(
    filterRules.split("\n").length > 2,
    `絞り込みの範囲が抽出できない — lines=${filterRules.split("\n").length}`,
  );
});

Deno.test("A1 観測クエリがスレッド内コメントに state を取っている", () => {
  assertOk(
    containsFixed(step4, THREAD_COMMENTS_SELECTION),
    `見つからない: ${THREAD_COMMENTS_SELECTION}`,
  );
});

Deno.test("A2 観測クエリがレビュー本文に state を取っている", () => {
  assertOk(
    containsFixed(step4, REVIEWS_SELECTION),
    `見つからない: ${REVIEWS_SELECTION}`,
  );
});

Deno.test("A3 絞り込みに PENDING を 3 分類のいずれにも入れない規則がある", () => {
  const rule = pendingRuleLine(filterRules);
  assertOk(rule !== null, `規則が無い: ${PENDING_RULE_NEEDLE}`);
  for (
    const kind of ["actionable", "`questions`", "「要確認」", "いずれにも"]
  ) {
    assertOk(rule.includes(kind), `規則に ${kind} が無い: ${rule}`);
  }
});

Deno.test("A4 規則がコメント単位であり、スレッドごと落とすのではないと述べている", () => {
  const rule = pendingRuleLine(filterRules);
  assertOk(rule !== null, `規則が無い: ${PENDING_RULE_NEEDLE}`);
  assertOk(
    rule.includes("スレッドごとではない"),
    `混在スレッドの扱いが書かれていない: ${rule}`,
  );
});

Deno.test("A5 署名側のクエリも state を取っている (2 ファイルのドリフト防止)", () => {
  assertOk(containsFixed(watchSh, SIG_THREAD_COMMENTS), "スレッド内コメント");
  assertOk(containsFixed(watchSh, SIG_REVIEWS), "レビュー");
});

// --- ケース B: 退行検知 (`state` の選択・規則を落とすと赤くなること) -----------------
const b0Regressed = substituteFirstPerLine(
  step4,
  /comments\(last:20\)\{nodes\{databaseId author\{login\} path line url body updatedAt state\}\}/,
  "comments(last:20){nodes{databaseId author{login} path line url body updatedAt}}",
);

Deno.test("B0 観測クエリへの回帰注入が効いている (state を落とせた)", () => {
  assertOk(b0Regressed !== step4, "置換が効かず元テキストと同一になった");
});

Deno.test("B1 観測クエリからの state 脱落を A1 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b0Regressed, THREAD_COMMENTS_SELECTION),
    "退行後も state を含む選択が残っていた",
  );
});

const b2Regressed = substituteFirstPerLine(
  filterRules,
  /^ {3}- \*\*`state` が `PENDING` のコメント\/レビューは落とす\*\*.*$/,
  "",
);

Deno.test("B2 絞り込み規則への回帰注入が効いている", () => {
  assertOk(b2Regressed !== filterRules, "置換が効かず元テキストと同一になった");
});

Deno.test("B3 規則の消失を A3 相当のチェックで検知できる", () => {
  assertOk(
    pendingRuleLine(b2Regressed) === null,
    "退行後も規則が残っていた",
  );
});

const b4Regressed = substituteFirstPerLine(
  watchSh,
  /comments\(last:20\)\{nodes\{updatedAt state\}\}/,
  "comments(last:20){nodes{updatedAt}}",
);

Deno.test("B4 署名側クエリへの回帰注入が効いている", () => {
  assertOk(b4Regressed !== watchSh, "置換が効かず元テキストと同一になった");
});

Deno.test("B5 署名側からの state 脱落を A5 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b4Regressed, SIG_THREAD_COMMENTS),
    "退行後も state を含む選択が残っていた",
  );
});
