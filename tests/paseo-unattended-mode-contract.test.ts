// tests/paseo-unattended-mode-contract.test.ts — 無人実行できる mode を持たない provider
// (この環境では junie) を Paseo 経路に乗せない規則が、乗せる前の事前チェック・乗せた後に
// permission 待ちで止まったときの扱い・junie の実測記録の 3 点として書かれたままであることを
// 4 ファイル (playbooks/agent-launch.md / SKILL.md / docs/orchestration-preferences.md /
// docs/paseo-subagent-2026-08.md) にまたがって固定する (gh-116)。
//
//   deno test --allow-read tests/paseo-unattended-mode-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// この規則が痩せると実行時には**止まる**か**黙って別プロバイダ検証を失う**かのどちらかになる。
// (a) 事前チェックが消える → junie のような provider に当たった回は permission 待ちで永久に
// 止まる。(b) permission 待ちの扱いが消える → 「生まれた後は落ちない」の規則だけが残り、
// 同じく止まる。(c) 優先関係が消える → 規則どうしが矛盾したまま読めてしまい、実行時にどちらが
// 採られるかがその場の即興になる。(d) junie の記録が旧文 (「`default` のまま完走した」) に
// 戻る → 規則と記録が反対のことを言う。どれもモデルは「規定が無かった」とは言わずに進むので、
// 文面の側で機械照合する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - Paseo CLI は叩かない。実測値 (`paseo provider ls` の `modes`) は docs 側の記録が持ち、
//   ここが見るのは「規則がその実測を反映した形で書かれているか」までである (CI に Paseo は無い)。
// - 判定はすべて **節スコープ / 行スコープ / 表の本文行スコープ**で行う。全文 includes に
//   退化させると、語が別の場所に 1 つ残っているだけで通ってしまう (B 群がその退化を注入して確かめる)。
// - `lineWith` / `tableRowsWith` / `inOrder` は tests/contract-helpers.ts に無いので、
//   tests/agent-launch-contract.test.ts と同型の実装をここに置く (共有化はしない — 既存
//   テストのローカル関数を動かすと、そのファイルの退行検知にも影響が出る)。

import { assertOk, grepFixedFirstLine, sedRange } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const PLAYBOOK_MD = new URL(
  "task-pipeline/playbooks/agent-launch.md",
  REPO_ROOT,
);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PREFS_DOC = new URL(
  "task-pipeline/docs/orchestration-preferences.md",
  REPO_ROOT,
);
const SUBAGENT_DOC = new URL(
  "task-pipeline/docs/paseo-subagent-2026-08.md",
  REPO_ROOT,
);

const playbook = Deno.readTextFileSync(PLAYBOOK_MD);
const skillMd = Deno.readTextFileSync(SKILL_MD);
const prefsDoc = Deno.readTextFileSync(PREFS_DOC);
const subagentDoc = Deno.readTextFileSync(SUBAGENT_DOC);

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

const FALLBACK_HEADING = /^## 経路の選択とフォールバック$/;
const RESOLUTION_HEADING = /^## provider・model・mode の解決手順$/;
const GATE_HEADING = /^6\. \*\*検証ゲート\*\*/;

const fallbackSection = sedRange(playbook, FALLBACK_HEADING, /^## /);
const resolutionSection = sedRange(playbook, RESOLUTION_HEADING, /^## /);
const gateSection = sedRange(skillMd, GATE_HEADING, /^### /);

/** 事前チェックの項。手段・落ち先・history・実在確認との違いが**同じ項**に無ければならない。 */
const PRECHECK_NEEDLE = "無人実行できる mode を持つかを確かめる";
const PRECHECK_PARTS = [
  "list_providers",
  "modes",
  "現行ハーネス経路",
  "history",
  "実在確認",
] as const;

/** permission 待ちの項。要求 2 の 3 点 (落ちてよいか / 残ったエージェント / history)。 */
const PERMISSION_NEEDLE = "permission 待ちで停止したら";
const PERMISSION_PARTS = ["項 4", "archive", "ユーザー", "history"] as const;

/** 「生まれなかった失敗だけ」の項。permission 待ちを例外として名指していなければならない。 */
const BORN_RULE_NEEDLE = "エージェントが生まれなかった";
const BORN_RULE_PARTS = ["項 5", "permission"] as const;

/** 6 項の並び。順序が崩れると「乗せる前に確かめる」が事後の話に読める。 */
const FALLBACK_ORDER = [
  PRECHECK_NEEDLE,
  "Paseo 経路を第一候補にする",
  "失敗したら現行ハーネス経路",
  BORN_RULE_NEEDLE,
  PERMISSION_NEEDLE,
  "どちらの経路も使えないとき",
] as const;

/** 役割の表の verifier 行が持つべき値 (既存の 2 つ + junie)。 */
const VERIFIER_ROW_PARTS = ["bypassPermissions", "full", "junie"] as const;

/** 表の直下の根拠。junie の mode 不在を実測と扱いに繋いでいなければならない。 */
const MODE_BULLET_NEEDLE = "junie には無人実行できる mode が無い";
const MODE_BULLET_PARTS = ["paseo provider ls", "modes", "項 1"] as const;

/** もう 1 つの辿り口 (要求 3 の「または」の片側)。 */
const PREFS_NEEDLE = "無人で回せることは別である";
const PREFS_PARTS = ["junie", "modes", "agent-launch.md"] as const;

/** 実測記録。junie を無人実行できる側に数えた旧文が残っていてはならない。 */
const RECORD_NEEDLE = "**無人実行できる mode**";
const RECORD_PARTS = ["junie は持たない", "#116"] as const;
const RECORD_STALE = "junie は `default` のまま完走した";

/** SKILL.md の再掲側 (経路ラダー 1 段目)。playbook の規則と矛盾させない。 */
const LADDER_NEEDLE = "1. **Paseo 経路**";
const LADDER_PARTS = ["事前チェック", "permission 待ち"] as const;

/** A 群の述語 (B 群が同じものを変異テキストに適用する)。 */
function lineHasAll(
  text: string,
  needle: string,
  parts: readonly string[],
): boolean {
  const line = lineWith(text, needle);
  if (line === null) return false;
  return parts.every((part) => line.includes(part));
}

function verifierRowHasAll(text: string): boolean {
  const rows = tableRowsWith(text, "`verifier`");
  return rows.length === 1 &&
    VERIFIER_ROW_PARTS.every((part) => rows[0].includes(part));
}

function recordIsCorrected(text: string): boolean {
  const line = lineWith(text, RECORD_NEEDLE);
  if (line === null) return false;
  return RECORD_PARTS.every((part) => line.includes(part)) &&
    !line.includes(RECORD_STALE);
}

// --- 単体: 自前ヘルパが行・表・順序のスコープを保っているか -------------------------
const U_ROW_CASES: readonly [string, number, string][] = [
  ["| `verifier` | 同期 |", 1, "表の本文行なら拾う"],
  ["- 本文の `verifier` は表の外", 0, "表の外の散文は拾わない"],
  ["|---|---|", 0, "区切り行は拾わない"],
  ["| :--- | ---: |", 0, "整列指定つきの区切り行も拾わない"],
];

for (const [line, expected, label] of U_ROW_CASES) {
  Deno.test(`U1 tableRowsWith: ${label}`, () => {
    const actual = tableRowsWith(line, "`verifier`").length;
    assertOk(actual === expected, `expected=${expected} actual=${actual}`);
  });
}

const U_ORDER_CASES: readonly [string[], boolean, string][] = [
  [["a", "b", "c"], true, "順序どおりなら真"],
  [["a", "c", "b"], false, "順序が入れ替われば偽"],
  [["a", "z", "c"], false, "1 つでも欠ければ偽"],
];

for (const [needles, expected, label] of U_ORDER_CASES) {
  Deno.test(`U2 inOrder: ${label}`, () => {
    const actual = inOrder("a\nb\nc\n", needles);
    assertOk(actual === expected, `expected=${expected} actual=${actual}`);
  });
}

Deno.test("U3 lineWith: 行スコープで返す (別の行の一致を混ぜない)", () => {
  const found = lineWith("参照はこの行\n別の行に needle\n", "needle");
  assertOk(found === "別の行に needle", `found=${JSON.stringify(found)}`);
});

Deno.test("U4 lineHasAll: 要素が別の行に散っていれば偽", () => {
  const text = "見出し: 手段\n別の行に history\n";
  assertOk(lineHasAll(text, "見出し", ["手段"]), "同じ行の要素を見落とす");
  assertOk(
    !lineHasAll(text, "見出し", ["手段", "history"]),
    "別の行の要素で満たされた — 行スコープが効いていない",
  );
});

// --- A 群: 現状が規定どおりであること -----------------------------------------------
Deno.test("A0 対象の 3 節 (経路 / 解決手順 / SKILL.md 手順 6) が切り出せる", () => {
  assertOk(fallbackSection.length > 0, "経路とフォールバックの節が空");
  assertOk(resolutionSection.length > 0, "解決手順の節が空");
  assertOk(gateSection.length > 0, "SKILL.md 手順 6 の節が空");
});

Deno.test("A1 事前チェックの項に、確認の手段・落ち先・history・実在確認との違いがある", () => {
  const line = lineWith(fallbackSection, PRECHECK_NEEDLE);
  assertOk(line !== null, `事前チェックの項が見つからない: ${PRECHECK_NEEDLE}`);
  for (const part of PRECHECK_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A2 permission 待ちの項に、落ちてよいか・残ったエージェント・history の 3 点がある", () => {
  const line = lineWith(fallbackSection, PERMISSION_NEEDLE);
  assertOk(
    line !== null,
    `permission の項が見つからない: ${PERMISSION_NEEDLE}`,
  );
  for (const part of PERMISSION_PARTS) {
    assertOk(line.includes(part), `同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A3 「生まれなかった失敗だけ」の項が permission 待ちを例外として名指している", () => {
  const line = lineWith(fallbackSection, BORN_RULE_NEEDLE);
  assertOk(line !== null, `項が見つからない: ${BORN_RULE_NEEDLE}`);
  for (const part of BORN_RULE_PARTS) {
    assertOk(line.includes(part), `優先関係が同じ項にない (${part}): ${line}`);
  }
});

Deno.test("A4 経路節の 6 項がこの順で並んでいる (事前チェックが起動より前)", () => {
  assertOk(
    inOrder(fallbackSection, FALLBACK_ORDER),
    `項が欠けているか順序が違う: ${JSON.stringify(FALLBACK_ORDER)}`,
  );
});

Deno.test("A5 役割の表の verifier 行が 1 本で、junie の mode 不在まで持つ", () => {
  const rows = tableRowsWith(playbook, "`verifier`");
  assertOk(rows.length === 1, `件数=${rows.length}`);
  for (const part of VERIFIER_ROW_PARTS) {
    assertOk(rows[0].includes(part), `行にない (${part}): ${rows[0]}`);
  }
});

Deno.test("A6 mode の箇条書きが junie の mode 不在を実測と扱いに繋いでいる", () => {
  const line = lineWith(resolutionSection, MODE_BULLET_NEEDLE);
  assertOk(line !== null, `箇条書きが見つからない: ${MODE_BULLET_NEEDLE}`);
  for (const part of MODE_BULLET_PARTS) {
    assertOk(line.includes(part), `同じ行にない (${part}): ${line}`);
  }
});

Deno.test("A7 prefs doc からも junie の mode 不在と手順書の在処が辿れる", () => {
  const line = lineWith(prefsDoc, PREFS_NEEDLE);
  assertOk(line !== null, `記述が見つからない: ${PREFS_NEEDLE}`);
  for (const part of PREFS_PARTS) {
    assertOk(line.includes(part), `同じ行にない (${part}): ${line}`);
  }
});

Deno.test("A8 実測記録が junie を無人実行できる側に数えていない", () => {
  const line = lineWith(subagentDoc, RECORD_NEEDLE);
  assertOk(line !== null, `記録の行が見つからない: ${RECORD_NEEDLE}`);
  for (const part of RECORD_PARTS) {
    assertOk(line.includes(part), `同じ行にない (${part}): ${line}`);
  }
  assertOk(!line.includes(RECORD_STALE), `旧文が残っている: ${line}`);
});

Deno.test("A9 SKILL.md の経路ラダー 1 段目が事前チェックと例外を指している", () => {
  const line = lineWith(gateSection, LADDER_NEEDLE);
  assertOk(line !== null, `ラダー 1 段目が見つからない: ${LADDER_NEEDLE}`);
  for (const part of LADDER_PARTS) {
    assertOk(line.includes(part), `同じ行にない (${part}): ${line}`);
  }
});

// --- B 群: 退行を注入して、A 群相当の述語が検知できること ---------------------------
interface Regression {
  readonly label: string;
  readonly original: string;
  readonly mutated: string;
  /** 変異後も真なら、その述語は退行を見逃している。 */
  readonly stillHolds: (text: string) => boolean;
}

const precheckLine = lineWith(fallbackSection, PRECHECK_NEEDLE) as string;
const permissionLine = lineWith(fallbackSection, PERMISSION_NEEDLE) as string;
const bornRuleLine = lineWith(fallbackSection, BORN_RULE_NEEDLE) as string;
const verifierRow = tableRowsWith(playbook, "`verifier`")[0];
const modeBulletLine = lineWith(
  resolutionSection,
  MODE_BULLET_NEEDLE,
) as string;
const prefsLine = lineWith(prefsDoc, PREFS_NEEDLE) as string;
const recordLine = lineWith(subagentDoc, RECORD_NEEDLE) as string;
const ladderLine = lineWith(gateSection, LADDER_NEEDLE) as string;

const REGRESSIONS: readonly Regression[] = [
  {
    label: "事前チェックの項が丸ごと消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(`${precheckLine}\n`, ""),
    stillHolds: (t) => lineHasAll(t, PRECHECK_NEEDLE, PRECHECK_PARTS),
  },
  {
    label: "事前チェックの項から history だけが消える (節の別の項には残る)",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      precheckLine,
      precheckLine.replaceAll("history", "記録"),
    ),
    stillHolds: (t) => lineHasAll(t, PRECHECK_NEEDLE, PRECHECK_PARTS),
  },
  {
    label: "事前チェックの項から確認の手段 (list_providers) だけが消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      precheckLine,
      precheckLine.replace("MCP の `list_providers` (CLI なら ", "("),
    ),
    stillHolds: (t) => lineHasAll(t, PRECHECK_NEEDLE, PRECHECK_PARTS),
  },
  {
    label:
      "事前チェックの項から実在確認との違いが消える (status で足りることになる)",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      precheckLine,
      precheckLine.replace(
        "**`status: available` はこの判定の代わりにならない** — 解決手順の節の実在確認は在庫を見るだけで、承認を挟まずに走れるかは見ていない。",
        "",
      ),
    ),
    stillHolds: (t) => lineHasAll(t, PRECHECK_NEEDLE, PRECHECK_PARTS),
  },
  {
    label: "permission 待ちの項が丸ごと消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(`${permissionLine}\n`, ""),
    stillHolds: (t) => lineHasAll(t, PERMISSION_NEEDLE, PERMISSION_PARTS),
  },
  {
    label:
      "permission 待ちの項から残ったエージェントの扱い (archive) だけが消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      permissionLine,
      permissionLine
        .replace("`paseo archive <agentId>` (MCP なら `archive_agent`)", "掃除")
        .replace("archived", "掃除済み"),
    ),
    stillHolds: (t) => lineHasAll(t, PERMISSION_NEEDLE, PERMISSION_PARTS),
  },
  {
    label: "permission 待ちの項から項 4 との優先関係が消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      permissionLine,
      permissionLine.replaceAll("項 4", "前の項"),
    ),
    stillHolds: (t) => lineHasAll(t, PERMISSION_NEEDLE, PERMISSION_PARTS),
  },
  {
    label: "permission 待ちの history だけが別の行へ切り出される (節には残る)",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      permissionLine,
      `${
        permissionLine.replaceAll("history", "記録")
      }\n   - 残す行は history に 1 行。`,
    ),
    stillHolds: (t) => lineHasAll(t, PERMISSION_NEEDLE, PERMISSION_PARTS),
  },
  {
    label: "「生まれなかった失敗だけ」の項が旧文 (例外なし) に戻る",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      bornRuleLine,
      bornRuleLine.replace(
        "**例外は項 5 の permission 待ちだけで、そのときは項 5 が優先する。**",
        "",
      ),
    ),
    stillHolds: (t) => lineHasAll(t, BORN_RULE_NEEDLE, BORN_RULE_PARTS),
  },
  {
    label: "事前チェックの項が末尾へ移る (乗せた後の話に読める)",
    original: fallbackSection,
    mutated: `${
      fallbackSection.replace(`${precheckLine}\n`, "")
    }\n${precheckLine}\n`,
    stillHolds: (t) => inOrder(t, FALLBACK_ORDER),
  },
  {
    label: "経路節の見出しが変わって節が切り出せなくなる",
    original: playbook,
    mutated: playbook.replace(
      "## 経路の選択とフォールバック",
      "## 経路とフォールバック",
    ),
    stillHolds: (t) => sedRange(t, FALLBACK_HEADING, /^## /).length > 0,
  },
  {
    label:
      "verifier の行から junie の mode 不在だけが消える (節の別の場所には残る)",
    original: playbook,
    mutated: playbook.replace(
      verifierRow,
      verifierRow.replace(" / junie: **無し** (Paseo 経路に乗せない)", ""),
    ),
    stillHolds: verifierRowHasAll,
  },
  {
    label: "verifier の行が表の外の散文へ退化する",
    original: playbook,
    mutated: playbook.replace(
      verifierRow,
      verifierRow.replace("| `verifier` |", "`verifier`:"),
    ),
    stillHolds: verifierRowHasAll,
  },
  {
    label: "mode の箇条書きから扱いの指し先 (項 1) が消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      modeBulletLine,
      modeBulletLine.replace("下の経路節の項 1 にある", "下の経路節にある"),
    ),
    stillHolds: (t) => lineHasAll(t, MODE_BULLET_NEEDLE, MODE_BULLET_PARTS),
  },
  {
    label: "prefs doc の記述から手順書の在処が消える (doc の別の行には残る)",
    original: prefsDoc,
    mutated: prefsDoc.replace(
      prefsLine,
      prefsLine.replace(
        "`playbooks/agent-launch.md` の経路節にある",
        "手順書にある",
      ),
    ),
    stillHolds: (t) => lineHasAll(t, PREFS_NEEDLE, PREFS_PARTS),
  },
  {
    label: "実測記録が旧文 (junie は `default` のまま完走した) に戻る",
    original: subagentDoc,
    mutated: subagentDoc.replace(
      recordLine,
      "- **無人実行できる mode**: omp は `full`、claude は `bypassPermissions`、junie は `default` のまま完走した (`JUNIE-OK` を返した)。",
    ),
    stillHolds: recordIsCorrected,
  },
  {
    label: "実測記録が部分更新にとどまる (訂正を足したが旧文も残る)",
    original: subagentDoc,
    mutated: subagentDoc.replace(
      recordLine,
      `${recordLine.replace("**junie は持たない**", "junie は持たない")}`
        .replace(
          "ここで `JUNIE-OK` を返して完走したのは",
          "junie は `default` のまま完走した。これは",
        ),
    ),
    stillHolds: recordIsCorrected,
  },
  {
    label: "SKILL.md のラダー 1 段目から事前チェックへの言及が消える",
    original: gateSection,
    mutated: gateSection.replace(
      ladderLine,
      ladderLine.replace(
        "**起動前に事前チェック** (解決した provider が無人実行できる mode を持つか) を通し、通らなければこの段を飛ばして 2 へ。",
        "",
      ),
    ),
    stillHolds: (t) => lineHasAll(t, LADDER_NEEDLE, LADDER_PARTS),
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
