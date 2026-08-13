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
// - gh-57 の分割で、安全停止節は SKILL.md から task-pipeline/playbooks/max-tasks.md へ移った。
//   引数の宣言・呼び出し例・手順1の分岐順は SKILL.md に残るので、対象ファイルはチェックごとに分かれる。

import {
  assertOk,
  containsFixed,
  grepLineNumber,
  sedRange,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOK_MD = new URL("task-pipeline/playbooks/max-tasks.md", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const playbookMd = Deno.readTextFileSync(PLAYBOOK_MD);

/** 手順書から安全停止節だけを切り出す (終端見出しが無いので EOF まで)。 */
const section = sedRange(
  playbookMd,
  /^### `max_tasks` による安全停止$/,
  /^#### /,
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
      playbookMd,
      "省略時は無制限で、以下は一切発火せず現行の挙動を変えない",
    ),
    "見つからない",
  );
});

Deno.test("T4a クラスC (到達) — 上限以上なら止める旨がある", () => {
  assertOk(
    containsFixed(
      playbookMd,
      "以上なら、新しい着手にも承認にも進まず、この節の手順で止める",
    ),
    "見つからない",
  );
});

Deno.test("T4b クラスB (未到達) — 上限未満なら通常どおり進む旨がある", () => {
  assertOk(
    containsFixed(playbookMd, "未満なら、この節は何もせず通常どおり以下の判定"),
    "見つからない",
  );
});

const T5A_NEEDLE =
  "`own_initial` 不在 ∧ `running_mine_finishing == 0` の両方で明示的に確かめられている";
const T5B_NEEDLE =
  "`counts.running_mine_finishing` が 1 以上の間 (自分の仕上げ run が飛行中) は、`start.blocked_by` に `max_tasks` が含まれていてもこの節の手順に進まない";

Deno.test("T5a 判定は own_initial 不在 ∧ running_mine_finishing==0 の両方で明示的に発火する旨がある", () => {
  assertOk(containsFixed(playbookMd, T5A_NEEDLE), "見つからない");
});

Deno.test("T5b 仕上げが飛行中の間は running_mine_finishing を見て停止を保留する旨がある", () => {
  assertOk(containsFixed(playbookMd, T5B_NEEDLE), "見つからない");
});

Deno.test("T11 T5a への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = playbookMd.replace(T5A_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T12 T5a の退行 (説明の消失) を T5a 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T5A_NEEDLE, "");
  assertOk(!containsFixed(injected, T5A_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T13 T5b への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = playbookMd.replace(T5B_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T14 T5b の退行 (説明の消失) を T5b 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T5B_NEEDLE, "");
  assertOk(!containsFixed(injected, T5B_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T6a 枯渇時フロー手順2の再利用を明記している", () => {
  assertOk(
    containsFixed(playbookMd, "枯渇時フロー手順2と**全く同じ手順**を踏む"),
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

const T17A_NEEDLE = "ロードできなければツール未接続なので、予約はせず";
const T19_NEEDLE = "**自動再開の予約** (scheduled task を作れる環境でのみ)";
/** 手順 5 (iv) の起動先。probe の実測 (gh-100) で `loop` に確定したもの。 */
const LAUNCH_TARGET_NEEDLE =
  "**起動先は `loop` skill 1 つだけ。その引数として `/task-pipeline <tracker> <source> ...` を渡せ**";
const T25_NEEDLE = "**再開後のイテレーション継続**";
const T26_NEEDLE =
  "**平文の (iv) を読んだ新セッションが実際に `loop` skill を起動し、2 イテレーション目以降へ進むところまでは未実測である**";

Deno.test("T15 ワンショット予約の作成手順 (fireAt・時刻の作り方・通知の扱い) がある", () => {
  const detail = missing(section, [
    ["fireAt", "fireAt の言及が無い"],
    ["date -Iseconds -v+5M", "fireAt の作り方 (date コマンド) が無い"],
    [
      "`notifyOnCompletion` は `false` にする",
      "notifyOnCompletion の指定が無い",
    ],
    [
      "ベタ書きした `select:` は使わない",
      "ツールのロード方法 (キーワード検索) が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T16 既存の有無で create と update を呼び分ける旨がある", () => {
  const detail = missing(section, [
    ["一覧の verb を 1 回呼び", "一覧で既存を確かめる手順が無い"],
    ["既にあれば update", "既存ありのときの update が無い"],
    ["無ければ create", "既存なしのときの create が無い"],
    [
      "create が「already exists」で失敗したら update に切り替える",
      "create 失敗時の update フォールバックが無い",
    ],
    [
      "2 回目以降の再開は必ずこの経路を通る",
      "連鎖再開が既存経路を通ることの明記が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T17a ツール未接続なら予約せず手動再開の案内に落ちる旨がある", () => {
  assertOk(containsFixed(section, T17A_NEEDLE), "見つからない");
});

Deno.test("T17b 呼び出しが失敗しても停止そのものは正常に完了させる旨がある", () => {
  const detail = missing(section, [
    [
      "**呼び出しが失敗したとき**も、自動再開は諦めて",
      "呼び出し失敗側の扱いが無い",
    ],
    ["停止そのものは正常に完了させる", "停止を成功させる旨が無い"],
    [
      "自動再開の失敗を理由にパイプラインを止められない状態にしてはならない",
      "自動再開の失敗が停止を巻き添えにしない旨が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T18 固定 taskId で累積せず、プロジェクトごとに分ける理由も書かれている", () => {
  const detail = missing(section, [
    [
      "`task-pipeline-resume-<プロジェクトルートの basename>`",
      "固定 taskId の具体形が無い",
    ],
    ["再開が連鎖しても scheduled task は増えない", "累積しない旨が無い"],
    [
      "別プロジェクトの予約を上書きしてしまう",
      "プロジェクトごとに分ける理由が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T19 予約の手順が停止アクション (release) より後に置かれている", () => {
  const releaseLine = grepLineNumber(playbookMd, "state.ts release --id <id>");
  const reserveLine = grepLineNumber(playbookMd, T19_NEEDLE);
  assertOk(
    releaseLine !== null && reserveLine !== null && releaseLine < reserveLine,
    `release_line=${releaseLine ?? ""} reserve_line=${reserveLine ?? ""}`,
  );
});

Deno.test("T20a history に予約の id と発火予定時刻 (失敗時は理由) を残す旨がある", () => {
  const detail = missing(section, [
    ["結果を history に残す", "history へ残す手順が無い"],
    [
      "max_tasks 停止 — 自動再開を予約: <taskId> fireAt <ISO>",
      "成功時の history 行の形が無い",
    ],
    ["自動再開なし (<理由>)", "失敗時の history 行の形が無い"],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T20b 最終報告にも予約の id と発火予定時刻が載る旨がある", () => {
  assertOk(
    containsFixed(
      section,
      "**自動再開の予約**: 作成または更新した `taskId` と発火予定時刻 (ISO)",
    ),
    "見つからない",
  );
});

Deno.test("T21 アプリが閉じていれば次回起動時に発火する旨が既知の限界として書かれている", () => {
  const detail = missing(section, [
    ["アプリが開いている間だけ", "アプリが開いている間だけ走る旨が無い"],
    ["次回起動時に発火する", "次回起動時に発火する旨が無い"],
    [
      "手動再開の案内は自動再開の成否によらず必ず出す",
      "自動再開が成功しても手動案内を出す旨が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T22 prompt の自己完結要件 4 点が書かれている", () => {
  const detail = missing(section, [
    [
      "新しいセッションはこの会話を一切知らない",
      "前の会話を知らない前提が無い",
    ],
    [
      "プロジェクトルートの絶対パス",
      "プロジェクトルートの絶対パスの要求が無い",
    ],
    [
      LAUNCH_TARGET_NEEDLE,
      "skill を平文で起動させる指示が無い",
    ],
    [
      "prompt の中のスラッシュコマンドは**展開されない**",
      "スラッシュコマンドが展開されないという実測が無い",
    ],
    [
      "同じ文字列**の `/loop /task-pipeline",
      "起動引数そのままの再開コマンドを含める要求が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T23a T17a への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = playbookMd.replace(T17A_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T23b T17a の退行 (未接続時の扱いの消失) を T17a 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T17A_NEEDLE, "");
  assertOk(!containsFixed(injected, T17A_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T24a T19 への回帰注入 (予約ブロックの見出しを除去) が効いている", () => {
  const injected = playbookMd.replace(T19_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T24b T19 の退行 (予約ブロックの消失) を T19 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T19_NEEDLE, "");
  assertOk(
    grepLineNumber(injected, T19_NEEDLE) === null,
    "除去後も行番号が取れてしまった",
  );
});

Deno.test("T25 再開後のイテレーション継続の扱い (駆動元・継続しない場合の帰結) がある", () => {
  const detail = missing(section, [
    [T25_NEEDLE, "継続の扱いを書いた段落が無い"],
    [
      "(iv) で起動させる `loop` skill が持っている",
      "継続を駆動するのが何かの明示が無い",
    ],
    [
      "`ScheduleWakeup` が (skill を起動する前の時点で既に) ツール一覧にある",
      "新セッション側の材料を実測したことの記載が無い",
    ],
    [
      "**1 イテレーションで止まる**",
      "`loop` を経由しない起動で止まることの記載が無い",
    ],
    [
      "**実質 1 件ずつ進む**",
      "止まった場合の帰結 (1 件ずつ進む) の記載が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T26 実走までは未実測であることが既知の限界として書かれている", () => {
  const detail = missing(section, [
    ["**既知の限界**", "既知の限界の段落が無い"],
    [T26_NEEDLE, "実走が未実測である旨が無い"],
    [
      "probe は実在の issue に本物のパイプラインが走ってしまうのを避けるため skill の起動を禁じた",
      "未実測の理由 (probe が起動を禁じた読み取り専用の観測であること) が無い",
    ],
  ]);
  assertOk(detail === "", detail);
});

Deno.test("T27a LAUNCH_TARGET への回帰注入 (起動先の記述を除去) が効いている", () => {
  const injected = playbookMd.replace(LAUNCH_TARGET_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T27b 起動先の退行 (手順 5 (iv) の起動先の消失・書き換え) を検知できる", () => {
  const injected = playbookMd.replace(LAUNCH_TARGET_NEEDLE, "");
  assertOk(
    !containsFixed(injected, LAUNCH_TARGET_NEEDLE),
    "除去後も見つかってしまった",
  );
});

Deno.test("T28a T25 への回帰注入 (継続の扱いの見出しを除去) が効いている", () => {
  const injected = playbookMd.replace(T25_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T28b T25 の退行 (継続の扱いの消失) を T25 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T25_NEEDLE, "");
  assertOk(!containsFixed(injected, T25_NEEDLE), "除去後も見つかってしまった");
});

Deno.test("T29a T26 への回帰注入 (未実測の記述を除去) が効いている", () => {
  const injected = playbookMd.replace(T26_NEEDLE, "");
  assertOk(injected !== playbookMd, "置換が効かず元テキストと同一になった");
});

Deno.test("T29b T26 の退行 (未実測の記述の消失) を T26 相当のチェックで検知できる", () => {
  const injected = playbookMd.replace(T26_NEEDLE, "");
  assertOk(!containsFixed(injected, T26_NEEDLE), "除去後も見つかってしまった");
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
