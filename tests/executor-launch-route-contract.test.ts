// tests/executor-launch-route-contract.test.ts — 実行エージェント (executor) の起動が
// Paseo 経路を第一候補にする 2 段のフォールバックであること、停止検知がポーリングであること、
// その受け皿と読み取り規則が 1 箇所に集約されていることを、4 ファイル
// (SKILL.md / playbooks/agent-launch.md / playbooks/inflight.md / playbooks/pr-follow.md +
// playbooks/merge-recovery.md) にまたがって固定する (gh-111)。
//
//   deno test --allow-read tests/executor-launch-route-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 壊れ方は 5 通りある。(a) 段が消える・順序が入れ替わる — 経路の優先順位が実行時の即興に
// 戻る。(b) 段は残るが history の 1 行が落ちる — どの経路で起動したかが後から辿れなくなる。
// (c) 5 行のプロンプトが変わる — executor 側の契約 (references/executor.md) と食い違う。
// (d) 停止検知の鮮度規則が痩せる — 消費済みの protocol 行を再検知して、同じ成果物に検証
// ゲートが二重に起動する (ポーリング経路にしか無い壊れ方で、通知経路には存在しなかった)。
// (e) 送信手段が SendMessage に固定されたまま残る — Paseo 経路の executor に指示が届かない。
// どれも実行時には静かに失敗する (モデルは「規定が無かった」とは言わずに進む) ので、
// 文面の側で機械照合する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 判定はすべて **節スコープ / 行スコープ / 表の本文行スコープ**で行う。全文 includes に
//   退化させると、語が別の場所に 1 つ残っているだけで通ってしまう (B 群がその退化を注入して確かめる)。
// - `inOrder` / `tableRowsWith` / `lineWith` / `swapLines` は tests/contract-helpers.ts に
//   無いので、tests/verifier-launch-route-contract.test.ts と同型の実装をここに置く
//   (共有化はしない — 既存テストのローカル関数を動かすと、そのファイルの退行検知にも影響が出る)。

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
const PR_FOLLOW_MD = new URL("pr-follow.md", PLAYBOOKS);
const MERGE_RECOVERY_MD = new URL("merge-recovery.md", PLAYBOOKS);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const launchMd = Deno.readTextFileSync(LAUNCH_MD);
const inflightMd = Deno.readTextFileSync(INFLIGHT_MD);
const prFollowMd = Deno.readTextFileSync(PR_FOLLOW_MD);
const mergeRecoveryMd = Deno.readTextFileSync(MERGE_RECOVERY_MD);

/** 行スコープの判定に使う。固定文字列を含む最初の行 (無ければ null)。 */
function lineWith(text: string, needle: string): string | null {
  return grepFixedFirstLine(text, needle);
}

/** 表の本文行か。`|` で始まる行のうち、区切り行 (`|---|---|`) を除いたもの。 */
function isTableBodyRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  return !/^\|[\s:|-]+\|$/.test(trimmed);
}

/** 固定文字列を含む**表の本文行**だけを返す (表の外の散文も区切り行も拾わない)。 */
function tableRowsWith(text: string, needle: string): string[] {
  return text
    .split("\n")
    .filter((line) => isTableBodyRow(line) && line.includes(needle));
}

/** 全 needle が現れ、かつ出現位置が狭義単調増加か (= 書かれた順序も見る)。 */
function inOrder(text: string, needles: readonly string[]): boolean {
  let prev = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    if (at <= prev) return false;
    prev = at;
  }
  return true;
}

/** 2 つの行を入れ替える (順序を見ているかを確かめる注入に使う)。 */
function swapLines(text: string, aNeedle: string, bNeedle: string): string {
  const lines = text.split("\n");
  const a = lines.findIndex((line) => line.includes(aNeedle));
  const b = lines.findIndex((line) => line.includes(bNeedle));
  if (a < 0 || b < 0) return text;
  const swapped = [...lines];
  swapped[a] = lines[b];
  swapped[b] = lines[a];
  return swapped.join("\n");
}

/** 節の切り出し境界 (SKILL.md タスク実行の手順 3 / 4 / 5)。 */
const STEP3_HEADING =
  /^3\. 実行エージェントを \*\*background で 1 体\*\* 起動する/;
const STEP4_HEADING = /^4\. \*\*以降、このタスクの進行は/;
const STEP5_HEADING = /^5\. 実行エージェントはフェーズを 1 つ終えるごとに/;
const STEP6_HEADING = /^6\. \*\*検証ゲート\*\*/;
const LAUNCH_SECTION_HEADING = /^## Paseo 経路の起動パラメータと読み取り$/;
const NEXT_H2 = /^## /;

const step3 = sedRange(skillMd, STEP3_HEADING, STEP4_HEADING);

/**
 * 手順 3 の経路の段だけ (行頭が `<n>. **` の番号付き行)。
 * 節ごと渡すと、節の散文にある「Paseo 経路」の言及が順序判定を通してしまう
 * (B 群の「入れ替え」「段の削除」がそれを実際に確かめる)。
 */
function ladderSteps(section: string): string {
  return section
    .split("\n")
    .filter((line) => /^ +\d+\. \*\*/.test(line))
    .join("\n");
}
const step4 = sedRange(skillMd, STEP4_HEADING, STEP5_HEADING);
const step5 = sedRange(skillMd, STEP5_HEADING, STEP6_HEADING);
const paramSection = sedRange(launchMd, LAUNCH_SECTION_HEADING, NEXT_H2);

/** 起動の 2 段。この順で現れなければならない。 */
const ROUTE_ORDER = ["Paseo 経路", "現行ハーネス経路"] as const;

/** 落ちる段の行が持つべきもの (逐語 + history)。 */
const PASEO_FAIL_NEEDLE = "paseo 経路が失敗";
const HISTORY_NEEDLE = "history";
const EXECUTOR_HISTORY_LINE = "現行経路で executor を起動";

/**
 * 5 行のプロンプト。**タスク本文の受け入れ条件が「実装前と逐語一致」を要求している**ので、
 * ここに現物を写して固定する (1 行でも変われば executor 側の契約と食い違う)。
 */
const PROMPT_LINES = [
  "   You are the long-lived executor for exactly one task.",
  "   Read ~/.claude/skills/task-pipeline/references/executor.md and follow it.",
  "   task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス> / review file: <レビュー観点ファイルの絶対パス>",
  "   finish mode: <none|commit|pr>",
  '   Begin with phase "<phase>".',
] as const;

/** プロンプトのコードフェンスの中身 (手順 3 の節から取り出す)。 */
function promptBlock(section: string): string[] {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.trim() === "```");
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "```");
  return end < 0 ? [] : rest.slice(0, end);
}

/** 停止検知 (ポーリング) の規定が手順 4 に持つべきもの。 */
const POLLING_NEEDLES = [
  "ポーリング",
  "`wait` (`reason: executor-alive`)",
  "inflight.md",
] as const;

/** 鮮度規則の項。3 条件 + 安全側の既定が**同じ項**に無ければならない。 */
const FRESHNESS_NEEDLE = "読んだ行の鮮度";
const FRESHNESS_PARTS = [
  "idle",
  "UpdatedAt",
  "run.executor_last_event_at",
  "読み捨てる",
] as const;

/** 起動パラメータの項 (要求 3)。 */
const PARAM_NEEDLE = "**起動パラメータ**";
const PARAM_PARTS = ["--title", "--label", "--cwd"] as const;
const NO_OUTPUT_SCHEMA = "`executor` には `--output-schema` を付けない";

/** 二重起動の防止と、差し替え時の旧エージェントの扱い (要求 6)。 */
const DUP_NEEDLE = "二重起動の防止";
const DUP_PARTS = ["-g", "--label"] as const;
const STOP_NEEDLE = "旧エージェント";
const STOP_PARTS = ["paseo stop", "archive"] as const;

/** 役割の表の executor 行が持つべき値 (経路と、その理由)。 */
const EXECUTOR_ROW_PARTS = [
  "Paseo 優先",
  "ポーリング",
  "notifyOnFinish",
] as const;

/** 要求 1 後段の帰結 (agentId と session の意味) — 手順 3 に**同居**していること。 */
const CONSEQUENCE_PARTS = [
  "`run.executor` に入るのが Paseo の agentId",
  "`session` の意味",
  "撫でない",
] as const;

/** inflight.md の受け皿と、status-check 失敗時の結論。 */
const WAIT_RECEIVER_NEEDLE = "この action が停止検知の受け皿である";
const WAIT_RECEIVER_PARTS = ["idle", "鮮度規則", "手順 5"] as const;
const STATUS_CHECK_FAIL_NEEDLE =
  "送信エラーは executor が死んだことの証明にならない";
const IMMEDIATE_TAKEOVER_NEEDLE = "即引き取りへ進めてはならない";
const SET_TAKEOVER_NEEDLE = "state.ts set-takeover";

/** executor へ指示を送る箇所。手段を名指さず手順書を指していること。 */
const PLAYBOOK_REF = "`playbooks/agent-launch.md`";
const SEND_SITES: readonly [string, string, string][] = [
  ["SKILL.md PASS", skillMd, "verified PASS. Proceed to phase"],
  ["SKILL.md finalize", skillMd, "Finalize the task (finish mode:"],
  ["SKILL.md FAIL", skillMd, "Fix required. Read required_fixes from"],
  [
    "inflight.md status-check",
    inflightMd,
    "Status check: finish your current phase",
  ],
  ["pr-follow.md pr_fix", prFollowMd, "PR feedback. Address the findings in"],
  [
    "merge-recovery.md rebase_fix",
    mergeRecoveryMd,
    "Rebase conflict. Rebase the branch onto",
  ],
];

// --- 単体: 自前ヘルパが行・表・順序のスコープを保っているか -------------------------
const U_ROW_CASES: readonly [string, number, string][] = [
  ["| `executor` | background |", 1, "表の本文行なら拾う"],
  ["- 本文の `executor` は表の外", 0, "表の外の散文は拾わない"],
  ["|---|---|", 0, "区切り行は拾わない"],
  ["| :--- | ---: |", 0, "整列指定つきの区切り行も拾わない"],
];

for (const [line, expected, label] of U_ROW_CASES) {
  Deno.test(`U1 tableRowsWith: ${label}`, () => {
    const actual = tableRowsWith(line, "`executor`").length;
    assertOk(actual === expected, `expected=${expected} actual=${actual}`);
  });
}

Deno.test("U2 inOrder: 順序が入れ替われば偽", () => {
  assertOk(inOrder("a\nb\n", ["a", "b"]), "順序どおりで真にならない");
  assertOk(!inOrder("a\nb\n", ["b", "a"]), "入れ替えても真になった");
  assertOk(!inOrder("a\nb\n", ["a", "z"]), "欠けても真になった");
});

Deno.test("U3 promptBlock: フェンスの中身だけを返す", () => {
  const section = "見出し\n```\nX\nY\n```\n後書き\n";
  assertOk(
    promptBlock(section).join("|") === "X|Y",
    `フェンスの中身が取れない: ${JSON.stringify(promptBlock(section))}`,
  );
  assertOk(promptBlock("フェンス無し\n").length === 0, "無いのに返った");
});

Deno.test("U4 swapLines: 2 行を入れ替える", () => {
  assertOk(swapLines("x1\ny2\n", "x1", "y2") === "y2\nx1\n", "入れ替わらない");
});

// --- A 群: 現状が規定どおりであること -----------------------------------------------
Deno.test("A0 4 つの範囲 (手順 3 / 手順 4 / 手順 5 / 起動パラメータの節) が切り出せる", () => {
  assertOk(step3.length > 0, "手順 3 の節が空");
  assertOk(step4.length > 0, "手順 4 の節が空");
  assertOk(step5.length > 0, "手順 5 の節が空");
  assertOk(paramSection.length > 0, "起動パラメータの節が空");
});

Deno.test("A1 起動の経路が Paseo → 現行ハーネス の順である", () => {
  assertOk(
    inOrder(ladderSteps(step3), ROUTE_ORDER),
    `段が欠けているか順序が違う: ${JSON.stringify(ROUTE_ORDER)}`,
  );
});

Deno.test("A2 Paseo から現行経路へ落ちる段の行に history の 1 行規定がある", () => {
  const line = lineWith(step3, PASEO_FAIL_NEEDLE);
  assertOk(line !== null, `落ちる段が見つからない: ${PASEO_FAIL_NEEDLE}`);
  assertOk(line.includes(HISTORY_NEEDLE), `同じ行に history が無い: ${line}`);
  assertOk(
    line.includes(EXECUTOR_HISTORY_LINE),
    `history の文言が executor 向けでない: ${line}`,
  );
});

Deno.test("A3 5 行のプロンプトが逐語で保たれている", () => {
  const actual = promptBlock(step3);
  assertOk(
    actual.length === PROMPT_LINES.length,
    `行数が違う: expected=${PROMPT_LINES.length} actual=${actual.length}`,
  );
  for (let i = 0; i < PROMPT_LINES.length; i++) {
    assertOk(
      actual[i] === PROMPT_LINES[i],
      `${i + 1} 行目が違う:\n  expected=${PROMPT_LINES[i]}\n  actual  =${
        actual[i]
      }`,
    );
  }
});

Deno.test("A4 手順 3 に要求 1 後段の帰結 (agentId と session の意味) が同居している", () => {
  for (const part of CONSEQUENCE_PARTS) {
    assertOk(containsFixed(step3, part), `手順 3 に無い (${part})`);
  }
});

Deno.test("A5 手順 4 の駆動がポーリングと受け皿 (inflight の wait) を名指している", () => {
  for (const needle of POLLING_NEEDLES) {
    assertOk(containsFixed(step4, needle), `手順 4 に無い (${needle})`);
  }
});

Deno.test("A6 手順 5 が鮮度規則を参照し、行が無いときの扱いを持つ", () => {
  assertOk(containsFixed(step5, "鮮度規則"), "鮮度規則への参照が無い");
  assertOk(
    containsFixed(step5, "停止の検知として扱わない"),
    "protocol 行が無いときの扱いが無い",
  );
  assertOk(
    containsFixed(
      step5,
      "送り元の agentId が state.json の `run.executor` と一致しない通知は無視する",
    ),
    "放置された executor を吸収する既存規則が消えている",
  );
});

Deno.test("A7 鮮度規則の項に 3 条件と安全側の既定が同居している", () => {
  const line = lineWith(paramSection, FRESHNESS_NEEDLE);
  assertOk(line !== null, `鮮度規則の項が見つからない: ${FRESHNESS_NEEDLE}`);
  for (const part of FRESHNESS_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A8 起動パラメータの項に --title / --label / --cwd がある", () => {
  const line = lineWith(paramSection, PARAM_NEEDLE);
  assertOk(line !== null, `起動パラメータの項が見つからない: ${PARAM_NEEDLE}`);
  for (const part of PARAM_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A9 executor に --output-schema を使わない旨が同じ節にある", () => {
  assertOk(
    containsFixed(paramSection, NO_OUTPUT_SCHEMA),
    `見つからない: ${NO_OUTPUT_SCHEMA}`,
  );
});

Deno.test("A10 二重起動の防止の項が -g 付きの重複確認を持つ", () => {
  const line = lineWith(paramSection, DUP_NEEDLE);
  assertOk(line !== null, `項が見つからない: ${DUP_NEEDLE}`);
  for (const part of DUP_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A10b 手順書に -g の無い重複確認が 1 件も残っていない", () => {
  const texts: readonly [string, string][] = [
    ["SKILL.md", skillMd],
    ["agent-launch.md", launchMd],
    ["inflight.md", inflightMd],
    ["pr-follow.md", prFollowMd],
    ["merge-recovery.md", mergeRecoveryMd],
  ];
  for (const [name, text] of texts) {
    assertOk(
      !containsFixed(text, "paseo ls -a --label"),
      `${name} に非 global 形の重複確認が残っている`,
    );
  }
});

Deno.test("A11 差し替え時の旧エージェントの扱いが paseo stop で、archive を避ける理由を持つ", () => {
  const line = lineWith(paramSection, STOP_NEEDLE);
  assertOk(line !== null, `項が見つからない: ${STOP_NEEDLE}`);
  for (const part of STOP_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A12 役割の表の executor 行が 1 本で、経路と理由を持つ", () => {
  const rows = tableRowsWith(launchMd, "`executor`");
  assertOk(rows.length === 1, `件数=${rows.length}`);
  for (const part of EXECUTOR_ROW_PARTS) {
    assertOk(rows[0].includes(part), `行にない (${part}): ${rows[0]}`);
  }
});

Deno.test("A13 inflight の wait が停止検知の受け皿で、idle ゲートを持つ", () => {
  const line = lineWith(inflightMd, WAIT_RECEIVER_NEEDLE);
  assertOk(line !== null, `受け皿の記述が無い: ${WAIT_RECEIVER_NEEDLE}`);
  for (const part of WAIT_RECEIVER_PARTS) {
    assertOk(line.includes(part), `同じ行にない (${part}): ${line}`);
  }
});

Deno.test("A14 status-check の失敗が死の証明にならず、即引き取りへ進まない", () => {
  assertOk(
    containsFixed(inflightMd, STATUS_CHECK_FAIL_NEEDLE),
    `結論が見つからない: ${STATUS_CHECK_FAIL_NEEDLE}`,
  );
  assertOk(
    containsFixed(inflightMd, IMMEDIATE_TAKEOVER_NEEDLE),
    `即引き取りを禁じる記述が無い: ${IMMEDIATE_TAKEOVER_NEEDLE}`,
  );
  assertOk(
    containsFixed(inflightMd, SET_TAKEOVER_NEEDLE),
    "沈黙の判定 (set-takeover) を経由する記述が消えている",
  );
});

for (const [label, text, needle] of SEND_SITES) {
  Deno.test(`A15 executor への指示 [${label}] が手段を名指さず手順書を指す`, () => {
    const line = lineWith(text, needle);
    assertOk(line !== null, `送信箇所が見つからない: ${needle}`);
    assertOk(
      !line.includes("SendMessage"),
      `手段が SendMessage で固定されている: ${line}`,
    );
    assertOk(
      line.includes(PLAYBOOK_REF) || line.includes("手順 4"),
      `経路の正への参照がその行にない: ${line}`,
    );
  });
}

// --- B 群: 退行を注入して、A 群相当の述語が検知できること ---------------------------
interface Regression {
  readonly label: string;
  readonly original: string;
  readonly mutated: string;
  /** 変異後も真なら、その述語は退行を見逃している。 */
  readonly stillHolds: (text: string) => boolean;
}

const paseoFailLine = lineWith(step3, PASEO_FAIL_NEEDLE) as string;
const freshnessLine = lineWith(paramSection, FRESHNESS_NEEDLE) as string;
const paramLine = lineWith(paramSection, PARAM_NEEDLE) as string;
const dupLine = lineWith(paramSection, DUP_NEEDLE) as string;
const executorRow = tableRowsWith(launchMd, "`executor`")[0];
const waitLine = lineWith(inflightMd, WAIT_RECEIVER_NEEDLE) as string;
const passLine = lineWith(skillMd, "verified PASS. Proceed to phase") as string;

const REGRESSIONS: readonly Regression[] = [
  {
    label: "起動の 1 段目と 2 段目が入れ替わる",
    original: step3,
    mutated: swapLines(
      step3,
      "1. **Paseo 経路**",
      "2. **現行ハーネス経路**",
    ),
    stillHolds: (t) => inOrder(ladderSteps(t), ROUTE_ORDER),
  },
  {
    label: "起動の Paseo の段そのものが消える",
    original: step3,
    mutated: step3.replace(`${paseoFailLine}\n`, ""),
    stillHolds: (t) => inOrder(ladderSteps(t), ROUTE_ORDER),
  },
  {
    label: "落ちる段の行からだけ history が消える (節の別の場所には残る)",
    original: step3,
    mutated: step3.replace(
      paseoFailLine,
      paseoFailLine.replaceAll(HISTORY_NEEDLE, "記録"),
    ),
    stillHolds: (t) =>
      (lineWith(t, PASEO_FAIL_NEEDLE) as string).includes(HISTORY_NEEDLE),
  },
  {
    label: "5 行プロンプトの 1 行が言い換えられる",
    original: step3,
    mutated: step3.replace(
      "   finish mode: <none|commit|pr>",
      "   finish mode: <mode>",
    ),
    stillHolds: (t) =>
      promptBlock(t).length === PROMPT_LINES.length &&
      PROMPT_LINES.every((line, i) => promptBlock(t)[i] === line),
  },
  {
    label: "5 行プロンプトから 1 行が落ちる",
    original: step3,
    mutated: step3.replace("   finish mode: <none|commit|pr>\n", ""),
    stillHolds: (t) => promptBlock(t).length === PROMPT_LINES.length,
  },
  {
    label: "要求 1 後段の帰結のうち session の意味だけが別節へ移る",
    original: step3,
    mutated: step3.replaceAll("`session` の意味", "所有の話"),
    stillHolds: (t) => CONSEQUENCE_PARTS.every((p) => containsFixed(t, p)),
  },
  {
    label: "手順 4 の駆動から受け皿 (wait) の名指しだけが消える",
    original: step4,
    mutated: step4.replaceAll(
      "`wait` (`reason: executor-alive`)",
      "その action",
    ),
    stillHolds: (t) => POLLING_NEEDLES.every((n) => containsFixed(t, n)),
  },
  {
    label: "鮮度規則の項から idle ゲートだけが消える",
    original: paramSection,
    mutated: paramSection.replace(
      freshnessLine,
      freshnessLine.replaceAll("idle", "停止"),
    ),
    stillHolds: (t) =>
      FRESHNESS_PARTS.every((p) =>
        (lineWith(t, FRESHNESS_NEEDLE) as string).includes(p)
      ),
  },
  {
    label: "鮮度規則の項から安全側の既定 (読み捨てる) だけが消える",
    original: paramSection,
    mutated: paramSection.replace(
      freshnessLine,
      freshnessLine.replaceAll("読み捨てる", "扱う"),
    ),
    stillHolds: (t) =>
      FRESHNESS_PARTS.every((p) =>
        (lineWith(t, FRESHNESS_NEEDLE) as string).includes(p)
      ),
  },
  {
    label: "起動パラメータの項から --label だけが消える (節の別の場所には残る)",
    original: paramSection,
    mutated: paramSection.replace(
      paramLine,
      paramLine.replaceAll("--label", "ラベル"),
    ),
    stillHolds: (t) =>
      PARAM_PARTS.every((p) =>
        (lineWith(t, PARAM_NEEDLE) as string).includes(p)
      ),
  },
  {
    label: "executor に --output-schema を使わない旨が消える",
    original: paramSection,
    mutated: paramSection.replaceAll(NO_OUTPUT_SCHEMA, "スキーマは任意"),
    stillHolds: (t) => containsFixed(t, NO_OUTPUT_SCHEMA),
  },
  {
    label: "重複確認から -g が落ちる",
    original: paramSection,
    mutated: paramSection.replace(
      dupLine,
      dupLine.replaceAll("-g ", "").replaceAll("`-g`", "全体"),
    ),
    stillHolds: (t) =>
      DUP_PARTS.every((p) => (lineWith(t, DUP_NEEDLE) as string).includes(p)),
  },
  {
    label: "非 global 形の重複確認が書き戻される",
    original: launchMd,
    mutated: launchMd.replace(
      "`paseo ls -a -g --label` で重複が残っていないかを確かめる",
      "`paseo ls -a --label` で重複が残っていないかを確かめる",
    ),
    stillHolds: (t) => !containsFixed(t, "paseo ls -a --label"),
  },
  {
    label: "旧エージェントの扱いが archive に戻る",
    original: paramSection,
    mutated: paramSection.replaceAll("paseo stop", "paseo archive"),
    stillHolds: (t) =>
      STOP_PARTS.every((p) => (lineWith(t, STOP_NEEDLE) as string).includes(p)),
  },
  {
    label: "executor の行が表の外の散文へ退化する",
    original: launchMd,
    mutated: launchMd.replace(
      executorRow,
      executorRow.replace("| `executor` |", "`executor`:"),
    ),
    stillHolds: (t) => tableRowsWith(t, "`executor`").length === 1,
  },
  {
    label: "executor の行から経路だけが旧文言に戻る",
    original: launchMd,
    mutated: launchMd.replace(
      executorRow,
      executorRow.replace("Paseo 優先", "現行のみ"),
    ),
    stillHolds: (t) => {
      const rows = tableRowsWith(t, "`executor`");
      return rows.length === 1 &&
        EXECUTOR_ROW_PARTS.every((p) => rows[0].includes(p));
    },
  },
  {
    label: "inflight の wait から idle ゲートだけが消える",
    original: inflightMd,
    mutated: inflightMd.replace(
      waitLine,
      waitLine.replaceAll("idle", "停止"),
    ),
    stillHolds: (t) =>
      WAIT_RECEIVER_PARTS.every((p) =>
        (lineWith(t, WAIT_RECEIVER_NEEDLE) as string).includes(p)
      ),
  },
  {
    label: "status-check の失敗で即引き取りへ進む規定に戻る",
    original: inflightMd,
    mutated: inflightMd.replaceAll(
      IMMEDIATE_TAKEOVER_NEEDLE,
      "即引き取ってよい",
    ),
    stillHolds: (t) => containsFixed(t, IMMEDIATE_TAKEOVER_NEEDLE),
  },
  {
    label: "PASS の送信が SendMessage 固定に戻る",
    original: skillMd,
    mutated: skillMd.replace(
      passLine,
      passLine.replace(
        "実行エージェントへ「",
        "SendMessage で実行エージェントへ「",
      ),
    ),
    stillHolds: (t) =>
      !(lineWith(t, "verified PASS. Proceed to phase") as string).includes(
        "SendMessage",
      ),
  },
  {
    label: "手順 3 の見出しが変わって節が切り出せなくなる",
    original: skillMd,
    mutated: skillMd.replace(
      "3. 実行エージェントを **background で 1 体** 起動する",
      "3. 実行エージェントを起動する",
    ),
    stillHolds: (t) => sedRange(t, STEP3_HEADING, STEP4_HEADING).length > 0,
  },
  {
    label: "起動パラメータの節の見出しが変わる",
    original: launchMd,
    mutated: launchMd.replace(
      "## Paseo 経路の起動パラメータと読み取り",
      "## 起動パラメータ",
    ),
    stillHolds: (t) => sedRange(t, LAUNCH_SECTION_HEADING, NEXT_H2).length > 0,
  },
];

for (const regression of REGRESSIONS) {
  Deno.test(`B [${regression.label}] の回帰注入が効いている`, () => {
    assertOk(
      regression.mutated !== regression.original,
      "置換が効かず元テキストと同一になった",
    );
  });

  Deno.test(`B [${regression.label}] を A 群相当のチェックで検知できる`, () => {
    assertOk(
      !regression.stillHolds(regression.mutated),
      "退行後も真と判定された — 述語が全文スコープに退化している",
    );
  });
}
