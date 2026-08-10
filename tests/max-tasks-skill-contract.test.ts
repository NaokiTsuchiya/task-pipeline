// tests/max-tasks-skill-contract.test.ts — task-pipeline/SKILL.md の `max_tasks` 引数
// (loop-safe-stop-max-tasks タスク) の記述を固定する。
//
//   deno test --allow-read tests/max-tasks-skill-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: `max_tasks` はこの skill のオーケストレーター (プロンプト駆動、実行系のコードが無い)
// が読む唯一の仕様書である SKILL.md に対する変更で、判定そのものをユニットテストする手段が
// 無い (repo 全体の既存方針 — tests/verifier-verdict-contract-alignment.test.ts /
// tests/sync-readme-skills.test.sh と同じ「prose の契約を grep で固定する」パターンを踏襲する)。
// このテストは、入力クラス A (省略=無制限) / B (未到達=続行) / C (到達=停止) それぞれの扱いが
// SKILL.md に具体的に書かれていること、停止手順が枯渇時フロー手順2を再利用していること、
// カウント方法とコンテキスト非依存性、最終報告の必須項目、既存呼び出し形の非破壊を固定する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。

import {
  assertOk,
  containsFixed,
  grepLineNumber,
  sedRange,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);

/** `sed -n '/^### \`max_tasks\` による安全停止$/,/^## /p'` — 安全停止節だけを切り出す。 */
const section = sedRange(
  skillMd,
  /^### `max_tasks` による安全停止$/,
  /^## /,
);

/** 節スコープ / 全文スコープの複数 needle を確認し、不足を `.sh` と同じ詳細文字列に積む。 */
function missing(text: string, checks: [string, string][]): string {
  let detail = "";
  for (const [needle, note] of checks) {
    if (!containsFixed(text, needle)) detail = `${detail} ${note}`;
  }
  return detail;
}

Deno.test("T1 $ARGUMENTS の行に [max_tasks=<N>] がある", () => {
  assertOk(containsFixed(skillMd, "[max_tasks=<N>]"), "見つからない");
});

Deno.test("T2 トークン内訳の列挙に max_tasks= が加わっている", () => {
  assertOk(containsFixed(skillMd, "`rebase=` / `max_tasks=`"), "見つからない");
});

Deno.test("T3a 引数説明の箇条書きに「省略時は現行の挙動を一切変えない」がある", () => {
  assertOk(
    containsFixed(skillMd, "既定: 無制限。省略時は現行の挙動を一切変えない"),
    "見つからない",
  );
});

Deno.test("T3b 安全停止節の冒頭に「省略時は無制限」の明記がある", () => {
  assertOk(
    containsFixed(
      skillMd,
      "省略時は無制限で、以下は一切発火せず現行の挙動を変えない",
    ),
    "見つからない",
  );
});

Deno.test("T4a クラスC (到達) — 上限以上なら止める旨がある", () => {
  assertOk(
    containsFixed(
      skillMd,
      "以上なら、新しい着手にも承認にも進まず、この節の手順で止める",
    ),
    "見つからない",
  );
});

Deno.test("T4b クラスB (未到達) — 上限未満なら通常どおり進む旨がある", () => {
  assertOk(
    containsFixed(skillMd, "未満なら、この節は何もせず通常どおり以下の判定"),
    "見つからない",
  );
});

const T5A_NEEDLE =
  "`own_initial` 不在 ∧ `running_mine_finishing == 0` の両方で明示的に確かめられている";
const T5B_NEEDLE =
  "`counts.running_mine_finishing` が 1 以上の間 (自分の仕上げ run が飛行中) は、`start.blocked_by` に `max_tasks` が含まれていてもこの節の手順に進まない";

Deno.test("T5a 判定は own_initial 不在 ∧ running_mine_finishing==0 の両方で明示的に発火する旨がある", () => {
  assertOk(containsFixed(skillMd, T5A_NEEDLE), "見つからない");
});

Deno.test("T5b 仕上げが飛行中の間は running_mine_finishing を見て停止を保留する旨がある", () => {
  assertOk(containsFixed(skillMd, T5B_NEEDLE), "見つからない");
});

Deno.test("T11 T5a への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(T5A_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T12 T5a の退行 (説明の消失) を T5a 相当のチェックで検知できる", () => {
  const injected = skillMd.replace(T5A_NEEDLE, "");
  assertOk(!containsFixed(injected, T5A_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T13 T5b への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(T5B_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T14 T5b の退行 (説明の消失) を T5b 相当のチェックで検知できる", () => {
  const injected = skillMd.replace(T5B_NEEDLE, "");
  assertOk(!containsFixed(injected, T5B_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T6a 枯渇時フロー手順2の再利用を明記している", () => {
  assertOk(
    containsFixed(skillMd, "枯渇時フロー手順2と**全く同じ手順**を踏む"),
    "見つからない",
  );
});

Deno.test("T6b 安全停止節が枯渇時フロー手順2と同じ停止呼び出し列を持つ", () => {
  const detail = missing(section, [
    ["state.ts release --id <id>", "release 呼び出しが無い"],
    ["ScheduleWakeup `stop: true`", "ScheduleWakeup stop:true が無い"],
    ["CronList", "CronList が無い"],
    ["CronDelete", "CronDelete が無い"],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T7 最終報告の4項目 (再開コマンド/clear案内/残候補件数/PR一覧) が揃っている", () => {
  const detail = missing(section, [
    ["再開コマンド", "再開コマンドが無い"],
    ["その前に `/clear` する案内", "/clear 案内が無い"],
    ["残っている候補の件数", "残候補件数が無い"],
    ["レビュー待ち・追従中の PR の一覧", "レビュー待ち/追従中PR一覧が無い"],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T8 カウント方法 (パス・トリガー・数え方) が具体的に書かれている", () => {
  const detail = missing(section, [
    ["task_counts", "task_counts パスが無い"],
    ["state.ts claim` が成功する", "claim 成功トリガーの記述が無い"],
    ["件数はこのファイルの行数", "行数で数える旨が無い"],
    ["wc -l", "wc -l の言及が無い"],
    ["sessions/` の中には置かない", "sessions/ に置かない旨が無い"],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T9 既存の呼び出し例がそのまま残っている (呼び出し形の非破壊)", () => {
  const detail = missing(skillMd, [
    [
      "markdown ./TASKS.md finish=commit",
      "既存例1 (markdown ./TASKS.md finish=commit) が無い",
    ],
    [
      "gh ?label=ready finish=pr approve=auto",
      "既存例2 (gh ?label=ready finish=pr approve=auto) が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T10 max_tasks の停止判定が「併走の枠」より前に置かれている", () => {
  const gateLine = grepLineNumber(skillMd, "`max_tasks` による停止判定");
  const concurrencyLine = grepLineNumber(skillMd, "**併走の枠**:");
  // 片方でも取れなければ (行が消えた) その時点で失敗させる — `.sh` の
  // `[ -n "$gate_line" ] && [ -n "$concurrency_line" ] && [ "$gate_line" -lt "$concurrency_line" ]` と同じ。
  assertOk(
    gateLine !== null && concurrencyLine !== null && gateLine < concurrencyLine,
    `gate_line=${gateLine ?? ""} concurrency_line=${concurrencyLine ?? ""}`,
  );
});
