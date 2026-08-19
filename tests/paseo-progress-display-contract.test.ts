// tests/paseo-progress-display-contract.test.ts — Paseo 経路のサブエージェント実行中に
// メインセッション側で進行状況を把握できる進捗表示 (Progress Banner) および verifier 開始表示の
// 出力規律が、3 ファイル (playbooks/inflight.md / playbooks/agent-launch.md / SKILL.md) に
// またがって固定されていることを検証する (gh-129)。
//
//   deno test --allow-read tests/paseo-progress-display-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 壊れ方は 4 通りある。(a) 進捗サマリーの書式や必須構成要素 (タスクID, phase, attempt, status,
// 経過時間, 直近活動) が痩せる。(b) paseo wait からの message 抽出・活用手順が落ちる。
// (c) verifier 起動・再開時の 1 行開始通知が落ちる。(d) 1 イテレーションあたり 1〜2 行制限などの
// コンテキスト肥大化防止規律が消えて冗長ログ出力に戻る。文面の側で機械照合する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 判定はすべて 行スコープ / 節スコープ で行う。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOKS = new URL("task-pipeline/playbooks/", REPO_ROOT);
const LAUNCH_MD = new URL("agent-launch.md", PLAYBOOKS);
const INFLIGHT_MD = new URL("inflight.md", PLAYBOOKS);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const launchMd = Deno.readTextFileSync(LAUNCH_MD);
const inflightMd = Deno.readTextFileSync(INFLIGHT_MD);

/** 行スコープの判定に使う。固定文字列を含む最初の行 (無ければ null)。 */
function lineWith(text: string, needle: string): string | null {
  return grepFixedFirstLine(text, needle);
}

/** 全 needle が現れ、かつ出現位置が狭義単調増加か (= 書かれた順序も見る)。 */
function inOrder(text: string, needles: readonly string[]): boolean {
  let lastIndex = -1;
  for (const needle of needles) {
    const idx = text.indexOf(needle, lastIndex + 1);
    if (idx === -1) return false;
    lastIndex = idx;
  }
  return true;
}

/** 2 つの行を入れ替える。 */
function swapLines(text: string, aNeedle: string, bNeedle: string): string {
  const aLine = lineWith(text, aNeedle);
  const bLine = lineWith(text, bNeedle);
  if (!aLine || !bLine) return text;
  return text.replace(aLine, "___TEMP___").replace(bLine, aLine).replace(
    "___TEMP___",
    bLine,
  );
}

/** 節の切り出し境界。 */
const INFLIGHT_WAIT_HEADING = /^- \*\*`wait`\*\*/;
const INFLIGHT_STATUS_CHECK_HEADING = /^- \*\*`status-check`\*\*/;
const LAUNCH_PARAM_HEADING = /^## Paseo 経路の起動パラメータと読み取り$/;
const LAUNCH_USAGE_HEADING = /^## Paseo invocation の usage 採取$/;
const LAUNCH_ROUTE_HEADING = /^## 経路の選択とフォールバック$/;
const STEP4_HEADING = /^4\. \*\*以降、このタスクの進行は/;
const STEP5_HEADING = /^5\. 実行エージェントはフェーズを 1 つ終えるごとに/;
const STEP6_HEADING = /^6\. \*\*検証ゲート\*\*/;

const inflightWaitSection = sedRange(
  inflightMd,
  INFLIGHT_WAIT_HEADING,
  INFLIGHT_STATUS_CHECK_HEADING,
);
const launchParamSection = sedRange(
  launchMd,
  LAUNCH_PARAM_HEADING,
  LAUNCH_USAGE_HEADING,
);
const launchRouteSection = sedRange(
  launchMd,
  LAUNCH_ROUTE_HEADING,
  LAUNCH_PARAM_HEADING,
);
const skillStep4 = sedRange(skillMd, STEP4_HEADING, STEP5_HEADING);
const skillStep6 = sedRange(skillMd, STEP6_HEADING, /^### /);

/** 進捗サマリーの必須要素 (要求 1)。 */
const BANNER_FORMAT_NEEDLE = "**進捗サマリーの書式**";
const BANNER_PARTS = [
  "phase",
  "attempt",
  "status",
  "経過時間",
  "直近活動メッセージ",
] as const;

/** コンテキスト規律の記述。 */
const CONTEXT_DISCIPLINE_NEEDLE = "1〜2 行の簡潔なプレーンテキスト";
const VERBOSE_LOG_GUARD_NEEDLE = "冗長なログ全文を出力・保持しない";

/** agent-launch.md の message 抽出手順 (要求 2)。 */
const LAUNCH_MESSAGE_EXTRACTION_NEEDLE = "進捗サマリー表示";
const LAUNCH_POLLING_PARTS = [
  "status",
  "message",
  "最新 1 行",
] as const;

/** agent-launch.md の verifier 開始通知 (要求 3)。 */
const VERIFIER_NOTIFICATION_NEEDLE = "開始通知行";
const VERIFIER_NOTIFICATION_PARTS = [
  "タスク ID",
  "フェーズ",
  "試行回数",
  "provider/model",
] as const;

/** SKILL.md 手順 4 / 手順 6 の参照 (要求 1, 3)。 */
const SKILL_STEP4_NEEDLE = "メインセッションに進捗サマリーを 1 行出力する";
const SKILL_STEP6_NEEDLE =
  "Paseo 経路で起動・再開した際はメインセッションに開始通知を 1 行出力する";

// --- 単体: 自前ヘルパの動作確認 --------------------------------------------------

Deno.test("U1 lineWith: 固定文字列を含む行を返す", () => {
  assertOk(
    lineWith("abc\ndef\nghi", "de") === "def",
    "一致する行が返らない",
  );
  assertOk(lineWith("abc\ndef\nghi", "xyz") === null, "null が返らない");
});

Deno.test("U2 inOrder: 順序が狭義単調増加なら真、逆順なら偽", () => {
  assertOk(inOrder("first then second", ["first", "second"]), "正順で偽");
  assertOk(!inOrder("second then first", ["first", "second"]), "逆順で真");
});

Deno.test("U3 swapLines: 2 行を正しく入れ替える", () => {
  assertOk(
    swapLines("line1\nline2\n", "line1", "line2") === "line2\nline1\n",
    "入れ替わらない",
  );
});

// --- A 群: 規律・書式が正しく記載されていること -----------------------------------

Deno.test("A0 関連する各節が切り出せる", () => {
  assertOk(inflightWaitSection.length > 0, "inflight.md wait 節が空");
  assertOk(launchParamSection.length > 0, "agent-launch.md パラメータ節が空");
  assertOk(launchRouteSection.length > 0, "agent-launch.md 経路節が空");
  assertOk(skillStep4.length > 0, "SKILL.md 手順 4 が空");
  assertOk(skillStep6.length > 0, "SKILL.md 手順 6 が空");
});

Deno.test("A1 inflight.md wait 節に進捗サマリーの書式と全構成要素が含まれる", () => {
  assertOk(
    containsFixed(inflightWaitSection, BANNER_FORMAT_NEEDLE),
    `書式の見出しが無い: ${BANNER_FORMAT_NEEDLE}`,
  );
  for (const part of BANNER_PARTS) {
    assertOk(
      containsFixed(inflightWaitSection, part),
      `進捗サマリーの要素が無い (${part})`,
    );
  }
});

Deno.test("A1b inflight.md に 1〜2 行制限と冗長ログ抑止のコンテキスト規律がある", () => {
  assertOk(
    containsFixed(inflightWaitSection, CONTEXT_DISCIPLINE_NEEDLE),
    `行数制限の記述が無い: ${CONTEXT_DISCIPLINE_NEEDLE}`,
  );
  assertOk(
    containsFixed(inflightWaitSection, VERBOSE_LOG_GUARD_NEEDLE),
    `冗長ログ抑止の記述が無い: ${VERBOSE_LOG_GUARD_NEEDLE}`,
  );
});

Deno.test("A2 agent-launch.md 読み取り節に message 抽出と進捗サマリー活用手順がある", () => {
  assertOk(
    containsFixed(launchParamSection, LAUNCH_MESSAGE_EXTRACTION_NEEDLE),
    `進捗サマリーへの活用記述が無い: ${LAUNCH_MESSAGE_EXTRACTION_NEEDLE}`,
  );
  for (const part of LAUNCH_POLLING_PARTS) {
    assertOk(
      containsFixed(launchParamSection, part),
      `ポーリング読み取りの要素が無い (${part})`,
    );
  }
});

Deno.test("A3 agent-launch.md 経路節に verifier 起動・再開時の 1 行開始通知がある", () => {
  assertOk(
    containsFixed(launchRouteSection, VERIFIER_NOTIFICATION_NEEDLE),
    `verifier 開始通知の記述が無い: ${VERIFIER_NOTIFICATION_NEEDLE}`,
  );
  for (const part of VERIFIER_NOTIFICATION_PARTS) {
    assertOk(
      containsFixed(launchRouteSection, part),
      `開始通知の要素が無い (${part})`,
    );
  }
});

Deno.test("A4 SKILL.md 手順 4 にポーリング時の進捗サマリー出力への言及がある", () => {
  assertOk(
    containsFixed(skillStep4, SKILL_STEP4_NEEDLE),
    `手順 4 に進捗サマリー言及が無い: ${SKILL_STEP4_NEEDLE}`,
  );
});

Deno.test("A5 SKILL.md 手順 6 に verifier 起動・再開時の開始通知への言及がある", () => {
  assertOk(
    containsFixed(skillStep6, SKILL_STEP6_NEEDLE),
    `手順 6 に開始通知言及が無い: ${SKILL_STEP6_NEEDLE}`,
  );
});

// --- B 群: 退行を注入して A 群相当の述語が検知できること ---------------------------

interface Regression {
  label: string;
  original: string;
  mutated: string;
  predicate: (text: string) => boolean;
}

const REGRESSIONS: readonly Regression[] = [
  {
    label: "inflight.md から進捗サマリー書式が消える",
    original: inflightWaitSection,
    mutated: inflightWaitSection.replace(BANNER_FORMAT_NEEDLE, "概要"),
    predicate: (t) => containsFixed(t, BANNER_FORMAT_NEEDLE),
  },
  {
    label: "inflight.md から経過時間要素が消える",
    original: inflightWaitSection,
    mutated: inflightWaitSection.replaceAll("経過時間", "時刻"),
    predicate: (t) => BANNER_PARTS.every((p) => containsFixed(t, p)),
  },
  {
    label: "inflight.md から 1〜2 行制限が消える",
    original: inflightWaitSection,
    mutated: inflightWaitSection.replace(CONTEXT_DISCIPLINE_NEEDLE, "出力する"),
    predicate: (t) => containsFixed(t, CONTEXT_DISCIPLINE_NEEDLE),
  },
  {
    label: "agent-launch.md から message 抽出手順が消える",
    original: launchParamSection,
    mutated: launchParamSection.replace(
      LAUNCH_MESSAGE_EXTRACTION_NEEDLE,
      "何もしない",
    ),
    predicate: (t) => containsFixed(t, LAUNCH_MESSAGE_EXTRACTION_NEEDLE),
  },
  {
    label: "agent-launch.md から verifier 開始通知行が消える",
    original: launchRouteSection,
    mutated: launchRouteSection.replace(VERIFIER_NOTIFICATION_NEEDLE, "通知"),
    predicate: (t) => containsFixed(t, VERIFIER_NOTIFICATION_NEEDLE),
  },
  {
    label: "SKILL.md 手順 4 から進捗サマリー言及が消える",
    original: skillStep4,
    mutated: skillStep4.replace(SKILL_STEP4_NEEDLE, "従来どおり何もしない"),
    predicate: (t) => containsFixed(t, SKILL_STEP4_NEEDLE),
  },
  {
    label: "SKILL.md 手順 6 から verifier 開始通知言及が消える",
    original: skillStep6,
    mutated: skillStep6.replace(SKILL_STEP6_NEEDLE, "従来どおり起動する"),
    predicate: (t) => containsFixed(t, SKILL_STEP6_NEEDLE),
  },
];

for (const reg of REGRESSIONS) {
  Deno.test(`B [${reg.label}] の回帰注入が効いている`, () => {
    assertOk(
      reg.predicate(reg.original),
      `元のテキストで述語が真にならない (${reg.label})`,
    );
    assertOk(
      !reg.predicate(reg.mutated),
      `改変テキストで述語が偽にならない (${reg.label})`,
    );
  });
}
