// tests/comment-discipline-contract.test.ts — 実装コードのコメントの規律が、書く側
// (task-pipeline/references/executor.md の `### implement` 節) と判定する側
// (task-pipeline/references/verifier.md の `### implement` / `### pr_fix` 節) で
// 食い違わないことを固定する。
//
//   deno test --allow-read tests/comment-discipline-contract.test.ts
//   deno task test
//
// この規律は「4 類型は書かない / 列挙外は文体・分量を理由に FAIL にしない」という
// 限定列挙で成り立っている。列挙が痩せれば規律は黙って消え、閉じ込めの一文が落ちれば
// 主観的な指摘がリトライ上限を食い潰す — どちらも動かして気づける類の壊れ方ではないので、
// 文面の側で固定する。判定を下すのは LLM なので、テストで押さえられるのは規則の文面までである。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  grepOnly,
  sedRange,
  substituteFirstPerLine,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const EXECUTOR_MD = new URL("task-pipeline/references/executor.md", REPO_ROOT);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);

const executorMd = Deno.readTextFileSync(EXECUTOR_MD);
const verifierMd = Deno.readTextFileSync(VERIFIER_MD);

// 見出しの記号が 2 ファイルで違う (executor.md は `→`、verifier.md は `(`) ので、
// 同じパターンは使い回せない。
const executorImplement = sedRange(
  executorMd,
  /^### implement → /,
  /^### report → /,
);
const verifierImplement = sedRange(
  verifierMd,
  /^### implement \(/,
  /^### report \(/,
);
// `### pr_fix` は verifier.md の最終節で、sedRange の終了パターンは開始行の次から探すため、
// このパターンは一致せず範囲は EOF まで伸びる (節が後ろに増えたらそこで閉じる)。
const verifierPrFix = sedRange(verifierMd, /^### pr_fix \(/, /^### /);

const NUMBERED_ITEM = /^ *[0-9]+\. /;

function hasLineWith(range: string, needle: string): boolean {
  return grepFixedFirstLine(range, needle) !== null;
}

Deno.test("A0 3 つの範囲が期待どおり抽出できる", () => {
  const executorLines = executorImplement.split("\n");
  const verifierLines = verifierImplement.split("\n");
  assertOk(
    executorLines.length > 2 &&
      /^### report → /.test(executorLines[executorLines.length - 1]),
    `executor.md の implement 範囲が閉じていない — lines=${executorLines.length}`,
  );
  assertOk(
    verifierLines.length > 2 &&
      /^### report \(/.test(verifierLines[verifierLines.length - 1]),
    `verifier.md の implement 範囲が閉じていない — lines=${verifierLines.length}`,
  );
  assertOk(
    /^### pr_fix \(/.test(verifierPrFix.split("\n")[0]) &&
      verifierPrFix.split("\n").length > 2,
    "verifier.md の pr_fix 範囲が抽出できない",
  );
});

Deno.test("A1 executor.md の implement 節に書かない類型が 4 つ以上列挙されている", () => {
  const items = grepOnly(executorImplement, NUMBERED_ITEM);
  assertOk(items.length >= 4, `番号付き項目が ${items.length} 件しかない`);
});

Deno.test("A2 列挙が 4 類型 (転記 / 言い換え / 経緯 / バナー) を覆っている", () => {
  for (const kind of ["転記", "言い換え", "経緯", "バナー"]) {
    assertOk(containsFixed(executorImplement, kind), `類型 ${kind} が無い`);
  }
});

Deno.test("A3 書いてよいものの基準がコードから読み取れない情報になっている", () => {
  assertOk(
    containsFixed(executorImplement, "コードから読み取れない"),
    "見つからない",
  );
});

Deno.test("A4 verifier.md の implement 節に差分のコメントを確認する項目がある", () => {
  assertOk(hasLineWith(verifierImplement, "コメント"), "見つからない");
});

Deno.test("A5 判定が限定列挙に閉じ、文体を FAIL 理由にしない旨がある", () => {
  assertOk(containsFixed(verifierImplement, "限定列挙"), "限定列挙が無い");
  assertOk(containsFixed(verifierImplement, "文体"), "文体への言及が無い");
});

Deno.test("A6 verifier.md の pr_fix 節にも同等の確認が及んでいる", () => {
  assertOk(hasLineWith(verifierPrFix, "コメント"), "見つからない");
});

Deno.test("A7 verifier.md が列挙の正として executor.md を名指している", () => {
  assertOk(containsFixed(verifierImplement, "executor.md"), "見つからない");
});

// A8/A9 は A3・A4・A5 では代替できない。「書いてよいもの」を非自明な理由と外部制約だけに
// 絞った版は A3 を通過しつつ、SKILL.md が詳細の置き場として参照している watch-pr.sh の
// コメントを削らせる。同じく、判定対象が差分に閉じている保証を落とした版は A4/A5 を
// 通過しつつ、他タスクのついでに既存コメントの掃除を要求する判定を許す。
Deno.test("A8 他の手順書から参照されるコメントが書いてよい側に残っている", () => {
  assertOk(containsFixed(executorImplement, "watch-pr.sh"), "見つからない");
});

Deno.test("A9 判定対象が当該差分のコメントに閉じている", () => {
  assertOk(
    containsFixed(verifierImplement, "差分が触れていない"),
    "見つからない",
  );
});

const b0Regressed = substituteFirstPerLine(
  executorImplement,
  / {2}1\. \*\*成果物・設計文書の転記\*\*/,
  "  - **成果物・設計文書の転記**",
);

Deno.test("B0 executor.md の列挙への回帰注入が効いている", () => {
  assertOk(
    b0Regressed !== executorImplement,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B1 類型が 1 つ落ちた退行を A1 相当のチェックで検知できる", () => {
  assertOk(
    grepOnly(b0Regressed, NUMBERED_ITEM).length < 4,
    "退行後も番号付き項目が 4 件以上あった",
  );
});

const b2Regressed = substituteFirstPerLine(
  verifierImplement,
  /^- \*\*差分が新しく足した・書き換えたコメントを自分で読み.*$/,
  "",
);

Deno.test("B2 verifier.md のコメント確認項目への回帰注入が効いている", () => {
  assertOk(
    b2Regressed !== verifierImplement,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B3 コメント確認項目の消失を A4 相当のチェックで検知できる", () => {
  assertOk(
    !hasLineWith(b2Regressed, "コメント"),
    "退行後もコメントへの言及が残っていた",
  );
});

const b4Regressed = substituteFirstPerLine(
  verifierImplement,
  /\*\*列挙外のコメントは、文体・分量・粒度・言語を理由に FAIL にしない\*\*/,
  "",
);

Deno.test("B4 限定列挙への閉じ込めへの回帰注入が効いている", () => {
  assertOk(
    b4Regressed !== verifierImplement,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B5 文体を FAIL 理由にしない旨の消失を A5 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b4Regressed, "文体"),
    "退行後も文体への言及が残っていた",
  );
});

const b6Regressed = substituteFirstPerLine(
  verifierPrFix,
  /^- 対応で新しく足した・書き換えたコメントに.*$/,
  "",
);

Deno.test("B6 pr_fix 節への回帰注入が効いている", () => {
  assertOk(
    b6Regressed !== verifierPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B7 pr_fix 節からの脱落を A6 相当のチェックで検知できる", () => {
  assertOk(
    !hasLineWith(b6Regressed, "コメント"),
    "退行後もコメントへの言及が残っていた",
  );
});

const b8Regressed = substituteFirstPerLine(
  executorImplement,
  /\(例: `SKILL\.md` の PR 追従が `watch-pr\.sh` のコメントを詳細の置き場として参照している\)/,
  "",
);

Deno.test("B8 参照されるコメントの例示への回帰注入が効いている", () => {
  assertOk(
    b8Regressed !== executorImplement,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B9 例示の消失を A8 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b8Regressed, "watch-pr.sh"),
    "退行後も watch-pr.sh への言及が残っていた",
  );
});

const b10Regressed = substituteFirstPerLine(
  verifierImplement,
  /差分が触れていない既存のコメントも対象外である \(掃除は明示的なタスクとしてのみ行う\)。/,
  "",
);

Deno.test("B10 差分への閉じ込めへの回帰注入が効いている", () => {
  assertOk(
    b10Regressed !== verifierImplement,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B11 差分への閉じ込めの消失を A9 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b10Regressed, "差分が触れていない"),
    "退行後も差分への閉じ込めが残っていた",
  );
});
