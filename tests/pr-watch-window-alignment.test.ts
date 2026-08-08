// tests/pr-watch-window-alignment.test.ts — task-pipeline/scripts/watch-pr.sh (署名クエリ) と
// task-pipeline/references/pr-watcher.md (観測クエリ) の reviewThreads 等のページング窓が
// 一致していることを固定する。
//
//   deno test --allow-read tests/pr-watch-window-alignment.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: 署名側 (watch-pr.sh) は reviewThreads(last:100) だが、観測側 (pr-watcher.md) が
// reviewThreads(first:100) のままドリフトしていたことがあった (pr-watch-window-alignment
// タスク)。スレッド総数が 100 を超える PR では、この2つが逆向きだと直近側スレッドの
// resolve/unresolve が署名を動かすのに観測には現れず、指摘が永久に失われる。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 判定は両ファイルの実クエリ本文からフィールド名+取得窓のペアを構造的に抽出し、
//   比較するだけ (詳細は extractWindows() のコメント)。
// - ケース B の「回帰注入」は `.sh` 版のサンドボックスコピーではなくメモリ上の複製に対して行う
//   (検査内容は同じで、書き込み権限とテンポラリの後始末が要らない)。

import {
  assertOk,
  containsFixed,
  grepOnly,
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

// 実クエリ中の「フィールド名(first|last:N){」だけを抜き出す。GraphQL のフィールド選択に
// 入る直前の "{" を伴う出現に限定することで、同じ語を使う地の文 (watch-pr.sh の
// コメント中の "reviewThreads(last:100) は直近に…" 等) を拾わない — その地の文には
// "{" が続かないため。両ファイルとも実クエリはこの形で 1 回ずつしか出現しない
// (comments が top-level と reviewThreads 内側の 2 回、reviews/reviewThreads が
// それぞれ 1 回で計 4 件)。
const WINDOW_RE = /(comments|reviews|reviewThreads)\((first|last):[0-9]+\)\{/g;

function extractWindows(text: string): string[] {
  return grepOnly(text, WINDOW_RE).sort();
}

/** `.sh` の flat() (改行を `|` に潰す) と同じ見え方の失敗メッセージを作る。 */
function flat(windows: string[]): string {
  return windows.join("|");
}

const sigWindows = extractWindows(watchSh);
const obsWindows = extractWindows(prWatcherMd);

// --- ケース A: 現状の 2 ファイルが一致していること ---------------------------------
Deno.test("A0 署名側から窓を抽出できる", () => {
  // 抽出結果は配列なので、`if (!windows)` ではなく件数で明示的に空を見る。
  assertOk(sigWindows.length !== 0, `抽出結果が空: ${WATCH_SH.pathname}`);
});

Deno.test("A1 観測側から窓を抽出できる", () => {
  assertOk(obsWindows.length !== 0, `抽出結果が空: ${PR_WATCHER_MD.pathname}`);
});

Deno.test("A2 署名側と観測側の取得窓が完全一致 (comments/reviews/reviewThreads)", () => {
  assertOk(
    flat(sigWindows) === flat(obsWindows),
    `sig=${flat(sigWindows)} obs=${flat(obsWindows)}`,
  );
});

Deno.test("A3 署名側の reviewThreads は last:100", () => {
  assertOk(
    flat(sigWindows).includes("reviewThreads(last:100){"),
    `got=${flat(sigWindows)}`,
  );
});

Deno.test("A4 観測側の reviewThreads は last:100", () => {
  // 署名側ではなく **観測側** の抽出結果を見る。ここが署名側を見てしまうと、
  // このスイートが守っている「観測側が first:100 のまま取り残される」ドリフトを取り逃す。
  assertOk(
    flat(obsWindows).includes("reviewThreads(last:100){"),
    `got=${flat(obsWindows)}`,
  );
});

// --- ケース B: 退行検知 (観測側を first:100 に戻すと不一致で検知できること) --------
const regressedMd = substituteFirstPerLine(
  prWatcherMd,
  /reviewThreads\(last:100\)\{nodes\{isResolved isOutdated/,
  "reviewThreads(first:100){nodes{isResolved isOutdated",
);

Deno.test("B0 サンドボックスコピーへの回帰注入が効いている (first:100 に戻せた)", () => {
  assertOk(
    containsFixed(
      regressedMd,
      "reviewThreads(first:100){nodes{isResolved isOutdated",
    ),
    "置換が効いていない",
  );
});

Deno.test("B1 観測側を first:100 に戻すと署名側との不一致を検知できる (このスイート自身の退行ガード)", () => {
  const regressedWindows = extractWindows(regressedMd);
  assertOk(
    flat(sigWindows) !== flat(regressedWindows),
    `退行を入れても一致してしまった: ${flat(regressedWindows)}`,
  );
});
