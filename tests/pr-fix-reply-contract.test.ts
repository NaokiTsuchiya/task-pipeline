// tests/pr-fix-reply-contract.test.ts — レビュー指摘への対応を「指摘ごとのコミット」と
// 「当該スレッドへの返信」に 1 対 1 で対応づける規律が、書く側
// (task-pipeline/references/executor.md の pr_fix 節と finalize 節)、判定する側
// (task-pipeline/references/verifier.md の pr_fix 節)、投稿主体を決める側
// (task-pipeline/playbooks/pr-follow.md の修正サイクル) で食い違わないことを固定する。
//
//   deno test --allow-read tests/pr-fix-reply-contract.test.ts
//   deno task test
//
// この規律は 3 ファイルに分かれて成立している。返信の材料 (指摘 id → コミット sha の対応表) を
// 作るのは pr_fix、投稿するのは finalize、材料の完全性を見るのは verifier であり、どれか 1 つが
// 痩せても残りは矛盾なく読めてしまう — 返信が 1 件も出ない版も、返信の sha が PR 上に存在しない
// 版も、成果物の上では「対応済み」に見える。判定を下すのは LLM なので、テストで押さえられるのは
// 規則の文面までである。
//
// 不在で守る規律が 2 つあるので、そこは注入の向きが逆になる (A8 / A16): 置き換えを追記で済ませて
// 旧文が残った版は、新しい文面の存在だけを見るケースでは全部緑のまま通る。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
  substituteFirstPerLine,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const EXECUTOR_MD = new URL("task-pipeline/references/executor.md", REPO_ROOT);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);
const PR_WATCHER_MD = new URL(
  "task-pipeline/references/pr-watcher.md",
  REPO_ROOT,
);
const PR_FOLLOW_MD = new URL("task-pipeline/playbooks/pr-follow.md", REPO_ROOT);

const executorMd = Deno.readTextFileSync(EXECUTOR_MD);
const verifierMd = Deno.readTextFileSync(VERIFIER_MD);
const prWatcherMd = Deno.readTextFileSync(PR_WATCHER_MD);
const prFollowMd = Deno.readTextFileSync(PR_FOLLOW_MD);

const executorPrFix = sedRange(
  executorMd,
  /^## PR フィードバック対応 \(pr_fix\)/,
  /^## /,
);
// finalize は executor.md の、pr_fix は verifier.md の最終節なので、終了パターンは一致せず
// 範囲は EOF まで伸びる (節が後ろに増えたらそこで閉じる)。
const executorFinalize = sedRange(
  executorMd,
  /^## タスク完了処理 \(finalize\)/,
  /^## /,
);
const verifierPrFix = sedRange(verifierMd, /^### pr_fix \(/, /^### /);
const prFollowFixCycle = sedRange(prFollowMd, /^### 修正サイクル/, /^### /);

/** 返信本文の末尾に付けるマーカー。`pr-watcher.md` が落とす接頭辞を共有する。 */
const REPLY_MARKER = "<!-- task-pipeline:pr-fix-reply -->";
/** `pr-watcher.md` の絞り込みが「パイプライン自身の投稿」と見なす接頭辞。 */
const PIPELINE_MARKER_PREFIX = "<!-- task-pipeline";
const WATCHER_DROP_RULE = "`<!-- task-pipeline` マーカーを含むコメントは落とす";

/** pr_fix 節の旧文 (コミットを finalize に回していた頃のもの)。残っていてはならない。 */
const OLD_NO_COMMIT = "この時点ではコミットも push もしない";
/** finalize 節の旧文 (まとめて 1 コミットにしていた頃のもの)。残っていてはならない。 */
const OLD_SQUASHED_COMMIT = "変更があるときのコミットメッセージは";

const ALL_RC_REPLY =
  "の指摘**すべて**に、そのコメントのスレッドへの返信を 1 件ずつ投稿する";
const EMPTY_ROUND_NEEDLE = "変更ファイル一覧が空";

function hasLineWith(range: string, needle: string): boolean {
  return grepFixedFirstLine(range, needle) !== null;
}

Deno.test("A0 4 つの範囲が期待どおり抽出できる", () => {
  const prFixLines = executorPrFix.split("\n");
  assertOk(
    prFixLines.length > 2 &&
      /^## コンフリクトの解消 /.test(prFixLines[prFixLines.length - 1]),
    `executor.md の pr_fix 範囲が閉じていない — lines=${prFixLines.length}`,
  );
  const fixCycleLines = prFollowFixCycle.split("\n");
  assertOk(
    fixCycleLines.length > 2 &&
      /^### 外部内容の扱い/.test(fixCycleLines[fixCycleLines.length - 1]),
    `pr-follow.md の修正サイクル範囲が閉じていない — lines=${fixCycleLines.length}`,
  );
  assertOk(
    /^## タスク完了処理 \(finalize\)/.test(executorFinalize.split("\n")[0]) &&
      executorFinalize.split("\n").length > 2,
    "executor.md の finalize 範囲が抽出できない",
  );
  assertOk(
    /^### pr_fix \(/.test(verifierPrFix.split("\n")[0]) &&
      verifierPrFix.split("\n").length > 2,
    "verifier.md の pr_fix 範囲が抽出できない",
  );
});

Deno.test("A1 pr_fix 節に 1 指摘 = 1 コミットの原則がある", () => {
  assertOk(containsFixed(executorPrFix, "1 指摘 = 1 コミット"), "見つからない");
});

Deno.test("A2 pr_fix 節に束ねてよい条件と、束ねた理由を書く義務がある", () => {
  assertOk(
    containsFixed(executorPrFix, "同一箇所を触る関連指摘"),
    "束ねてよい条件が無い",
  );
  assertOk(
    containsFixed(executorPrFix, "束ねた理由を成果物に書き"),
    "束ねた理由を書く義務が無い",
  );
});

Deno.test("A3 pr_fix 節に対応表を書く義務があり、rc- を漏らさない旨がある", () => {
  assertOk(
    containsFixed(executorPrFix, "指摘 id とコミットの対応表"),
    "対応表の義務が無い",
  );
  assertOk(
    containsFixed(executorPrFix, "1 件残らずこの表に載せる"),
    "rc- を漏らさない旨が無い",
  );
});

Deno.test("A4 pr_fix 節に required_fixes 対応を同じコミットへ畳み込む規律がある", () => {
  assertOk(
    containsFixed(executorPrFix, "対応する指摘のコミットへ畳み込む"),
    "畳み込みの規律が無い",
  );
  assertOk(
    containsFixed(executorPrFix, "git commit --amend"),
    "手段が示されていない",
  );
});

Deno.test("A5 finalize 節に rc- 全件へ返信する義務がある", () => {
  const line = grepFixedFirstLine(executorFinalize, ALL_RC_REPLY);
  assertOk(line !== null, `返信義務の行が無い: ${ALL_RC_REPLY}`);
  assertOk(line.includes("`rc-`"), `対象が rc- と書かれていない: ${line}`);
});

Deno.test("A6 返信本文の条件 (対応は sha / 非対応は理由) と sha の取り直しがある", () => {
  assertOk(
    containsFixed(executorFinalize, "対応した指摘の本文には該当コミットの sha"),
    "対応した指摘の本文の条件が無い",
  );
  assertOk(
    containsFixed(
      executorFinalize,
      "対応しないと決めた指摘の本文にはその理由を入れる",
    ),
    "非対応の指摘の本文の条件が無い",
  );
  assertOk(
    containsFixed(executorFinalize, "sha は push 後に `git log` から取り直す"),
    "push 後に sha を取り直す旨が無い",
  );
});

Deno.test("A7 finalize 節が pr_fix 後に新しいコミットを作らないと述べている", () => {
  assertOk(
    containsFixed(
      executorFinalize,
      "直前フェーズが `pr_fix` のときも、新しいコミットを作らない",
    ),
    "見つからない",
  );
});

Deno.test("A8 finalize 節にまとめ 1 コミットの旧指示が残っていない", () => {
  assertOk(
    !containsFixed(executorFinalize, OLD_SQUASHED_COMMIT),
    `旧指示が残っている: ${OLD_SQUASHED_COMMIT}`,
  );
});

Deno.test("A9 トップレベル要約の投稿が条件付きになっている", () => {
  assertOk(
    containsFixed(
      executorFinalize,
      "`rc-` 以外の指摘 (`ic-` / `rv-`) か CI 失敗があるときだけ",
    ),
    "投稿条件が無い",
  );
  assertOk(
    containsFixed(
      executorFinalize,
      "全指摘が `rc-` で CI 失敗も無ければ投稿しない",
    ),
    "投稿しない側の条件が無い",
  );
});

Deno.test("A10 返信の投稿手段 (in_reply_to と MCP フォールバック) がある", () => {
  assertOk(
    containsFixed(executorFinalize, "-F in_reply_to=<databaseId>"),
    "in_reply_to を付ける gh api 経路が無い",
  );
  assertOk(
    containsFixed(executorFinalize, "add_reply_to_pull_request_comment"),
    "MCP フォールバックが無い",
  );
});

Deno.test("A11 返信本文のマーカーが finalize 節にある", () => {
  assertOk(containsFixed(executorFinalize, REPLY_MARKER), "見つからない");
});

Deno.test("A12 マーカーが pr-watcher.md の落とす接頭辞を共有している", () => {
  assertOk(
    containsFixed(prWatcherMd, WATCHER_DROP_RULE),
    `観測側の絞り込み規則が無い: ${WATCHER_DROP_RULE}`,
  );
  assertOk(
    REPLY_MARKER.startsWith(PIPELINE_MARKER_PREFIX),
    `マーカーが接頭辞を外れている: ${REPLY_MARKER}`,
  );
});

Deno.test("A13 全件非対応の周回でも返信を投稿する旨がその経路に書かれている", () => {
  const line = grepFixedFirstLine(executorFinalize, EMPTY_ROUND_NEEDLE);
  assertOk(line !== null, `経路の記述が無い: ${EMPTY_ROUND_NEEDLE}`);
  assertOk(line.includes("返信"), `返信への言及が無い: ${line}`);
});

Deno.test("A14 verifier.md の pr_fix 節が対応表・粒度・前周回の返信を判定する", () => {
  assertOk(containsFixed(verifierPrFix, "対応表"), "対応表の判定が無い");
  assertOk(containsFixed(verifierPrFix, "1 件残らず"), "完全性の判定が無い");
  assertOk(containsFixed(verifierPrFix, "git log"), "粒度の照合手段が無い");
  assertOk(
    containsFixed(verifierPrFix, REPLY_MARKER),
    "前周回の返信を見分ける目印が無い",
  );
});

Deno.test("A15 pr-follow.md の修正サイクルが投稿主体を分けている", () => {
  assertOk(
    containsFixed(prFollowFixCycle, "pr-responder"),
    "質問側の主体が無い",
  );
  assertOk(
    containsFixed(prFollowFixCycle, "executor が"),
    "指摘側の主体が無い",
  );
  assertOk(containsFixed(prFollowFixCycle, "finalize"), "投稿の時点が無い");
});

Deno.test("A16 pr_fix 節にコミットを禁じる旧文が残っていない", () => {
  assertOk(
    !containsFixed(executorPrFix, OLD_NO_COMMIT),
    `旧文が残っている: ${OLD_NO_COMMIT}`,
  );
});

const b1Regressed = substituteFirstPerLine(
  executorPrFix,
  /1 指摘 = 1 コミット/,
  "",
);

Deno.test("B1a 1 指摘 = 1 コミットへの回帰注入が効いている", () => {
  assertOk(
    b1Regressed !== executorPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B1b 原則の消失を A1 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b1Regressed, "1 指摘 = 1 コミット"),
    "退行後も原則が残っていた",
  );
});

const b2Regressed = substituteFirstPerLine(
  executorPrFix,
  /束ねた理由を成果物に書き/,
  "",
);

Deno.test("B2a 束ねた理由の義務への回帰注入が効いている", () => {
  assertOk(
    b2Regressed !== executorPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B2b 義務の消失を A2 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b2Regressed, "束ねた理由を成果物に書き"),
    "退行後も義務が残っていた",
  );
});

const b3Regressed = substituteFirstPerLine(
  executorPrFix,
  /1 件残らずこの表に載せる/,
  "",
);

Deno.test("B3a 対応表の完全性への回帰注入が効いている", () => {
  assertOk(
    b3Regressed !== executorPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B3b 書く側の完全性義務の消失を A3 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b3Regressed, "1 件残らずこの表に載せる"),
    "退行後も義務が残っていた",
  );
});

const b4Regressed = substituteFirstPerLine(
  executorPrFix,
  /対応する指摘のコミットへ畳み込む/,
  "",
);

Deno.test("B4a 畳み込みの規律への回帰注入が効いている", () => {
  assertOk(
    b4Regressed !== executorPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B4b 規律の消失を A4 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b4Regressed, "対応する指摘のコミットへ畳み込む"),
    "退行後も規律が残っていた",
  );
});

const b5Regressed = substituteFirstPerLine(
  executorFinalize,
  /の指摘\*\*すべて\*\*に、そのコメントのスレッドへの返信を 1 件ずつ投稿する/,
  "のうち対応した指摘に返信する",
);

Deno.test("B5a 全件返信義務への回帰注入が効いている", () => {
  assertOk(
    b5Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B5b 義務が痩せたことを A5 相当のチェックで検知できる", () => {
  assertOk(!hasLineWith(b5Regressed, ALL_RC_REPLY), "退行後も義務が残っていた");
});

const b6Regressed = substituteFirstPerLine(
  executorFinalize,
  /sha は push 後に `git log` から取り直す/,
  "",
);

Deno.test("B6a sha の取り直しへの回帰注入が効いている", () => {
  assertOk(
    b6Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B6b 取り直しの消失を A6 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b6Regressed, "sha は push 後に `git log` から取り直す"),
    "退行後も記述が残っていた",
  );
});

const b7Regressed = substituteFirstPerLine(
  executorFinalize,
  /直前フェーズが `pr_fix` のときも、新しいコミットを作らない/,
  "",
);

Deno.test("B7a finalize の非コミット指示への回帰注入が効いている", () => {
  assertOk(
    b7Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B7b 指示の消失を A7 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(
      b7Regressed,
      "直前フェーズが `pr_fix` のときも、新しいコミットを作らない",
    ),
    "退行後も指示が残っていた",
  );
});

// A8 と A16 は不在で守る規律なので、注入は逆向き (旧文を戻す) になる。
const b8Regressed = substituteFirstPerLine(
  executorFinalize,
  /返す URL は既存の PR URL。/,
  "返す URL は既存の PR URL。変更があるときのコミットメッセージは `PR フィードバック対応: <対応内容の要約>` とし、",
);

Deno.test("B8a まとめ 1 コミット指示の復活を注入できている", () => {
  assertOk(
    b8Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B8b 旧指示の復活を A8 相当のチェックで検知できる", () => {
  assertOk(
    containsFixed(b8Regressed, OLD_SQUASHED_COMMIT),
    "注入したはずの旧指示が見つからない",
  );
});

const b9Regressed = substituteFirstPerLine(
  executorFinalize,
  /か CI 失敗があるときだけ/,
  "の有無にかかわらず",
);

Deno.test("B9a 要約の投稿条件への回帰注入が効いている", () => {
  assertOk(
    b9Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B9b 無条件投稿への逆戻りを A9 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(
      b9Regressed,
      "`rc-` 以外の指摘 (`ic-` / `rv-`) か CI 失敗があるときだけ",
    ),
    "退行後も条件が残っていた",
  );
});

const b10Regressed = substituteFirstPerLine(
  executorFinalize,
  / -F in_reply_to=<databaseId>/,
  "",
);

Deno.test("B10a in_reply_to への回帰注入が効いている", () => {
  assertOk(
    b10Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B10b フラグの脱落を A10 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b10Regressed, "-F in_reply_to=<databaseId>"),
    "退行後もフラグが残っていた",
  );
});

const b11Regressed = substituteFirstPerLine(
  executorFinalize,
  /<!-- task-pipeline:pr-fix-reply -->/,
  "",
);

Deno.test("B11a マーカーへの回帰注入が効いている", () => {
  assertOk(
    b11Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B11b マーカーの消失を A11 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b11Regressed, REPLY_MARKER),
    "退行後もマーカーが残っていた",
  );
});

Deno.test("B12 接頭辞を外れたマーカーを A12 相当のチェックで検知できる", () => {
  assertOk(
    !"<!--task-pipeline:pr-fix-reply-->".startsWith(PIPELINE_MARKER_PREFIX),
    "接頭辞の照合が表記の違いを見分けられていない",
  );
});

const b13Regressed = substituteFirstPerLine(
  executorFinalize,
  /^- `pr` で \*\*このブランチに既に PR がある場合\*\*.*$/,
  "- `pr` で **このブランチに既に PR がある場合** (pr_fix 後の finalize) は、`gh pr create` を呼ばない。直前フェーズの変更ファイル一覧が空なら commit / push は行わず `gh pr comment` の投稿だけをして FINALIZED する。",
);

Deno.test("B13a 全件非対応の経路への回帰注入が効いている", () => {
  assertOk(
    b13Regressed !== executorFinalize,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B13b 経路から返信が落ちたことを A13 相当のチェックで検知できる", () => {
  const line = grepFixedFirstLine(b13Regressed, EMPTY_ROUND_NEEDLE);
  assertOk(line !== null, "退行後に経路の記述そのものが消えた (注入が過剰)");
  assertOk(!line.includes("返信"), "退行後も返信への言及が残っていた");
});

const b14Regressed = substituteFirstPerLine(verifierPrFix, /対応表/, "");

Deno.test("B14a verifier の対応表判定への回帰注入が効いている", () => {
  assertOk(
    b14Regressed !== verifierPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B14b 判定側の脱落を A14 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b14Regressed, "対応表"),
    "退行後も対応表の判定が残っていた",
  );
});

const b15Regressed = substituteFirstPerLine(
  prFollowFixCycle,
  /pr-responder/,
  "",
);

Deno.test("B15a 投稿主体の切り分けへの回帰注入が効いている", () => {
  assertOk(
    b15Regressed !== prFollowFixCycle,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B15b 切り分けの消失を A15 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b15Regressed, "pr-responder"),
    "退行後も質問側の主体が残っていた",
  );
});

const b16Regressed = substituteFirstPerLine(
  executorPrFix,
  /\*\*コミットは作るが push はしない\*\*/,
  "**この時点ではコミットも push もしない**",
);

Deno.test("B16a コミット禁止の旧文の復活を注入できている", () => {
  assertOk(
    b16Regressed !== executorPrFix,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B16b 旧文の復活を A16 相当のチェックで検知できる", () => {
  assertOk(
    containsFixed(b16Regressed, OLD_NO_COMMIT),
    "注入したはずの旧文が見つからない",
  );
});
