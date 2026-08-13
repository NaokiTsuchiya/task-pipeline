// tests/verifier-launch-route-contract.test.ts — 検証ゲートの起動・再開が Paseo 経路を
// 第一候補にする 3 段 / 2 段のフォールバックであること、その各段に history の 1 行が
// 付いていること、行動境界の担保が mode ではなく references/verifier.md 側にあることを
// 4 ファイル (SKILL.md / playbooks/agent-launch.md / references/verifier.md / README.md)
// にまたがって固定する (gh-104)。
//
//   deno test --allow-read tests/verifier-launch-route-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 壊れ方は 3 通りある。(a) 段が消える・順序が入れ替わる — 経路の優先順位が実行時の即興に
// 戻る。(b) 段は残るが history の 1 行が落ちる — どの経路で検証したかが後から辿れなくなる。
// (c) 担保の指し先だけが残って実体が消える — playbook が「担保は verifier.md にある」と
// 書いているのに、verifier.md 側の記述が無い状態になる。どれも実行時には静かに失敗する
// (モデルは「規定が無かった」とは言わずに進む) ので、文面の側で機械照合する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 判定はすべて **節スコープ / 行スコープ / 表の本文行スコープ**で行う。全文 includes に
//   退化させると、語が別の場所に 1 つ残っているだけで通ってしまう (B 群がその退化を注入して確かめる)。
// - `inOrder` / `tableRowsWith` / `lineWith` は tests/contract-helpers.ts に無いので、
//   tests/agent-launch-contract.test.ts と同型の実装をここに置く (共有化はしない — 既存
//   テストのローカル関数を動かすと、そのファイルの退行検知にも影響が出る)。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOK_MD = new URL(
  "task-pipeline/playbooks/agent-launch.md",
  REPO_ROOT,
);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);
const README_MD = new URL("README.md", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const playbook = Deno.readTextFileSync(PLAYBOOK_MD);
const verifierMd = Deno.readTextFileSync(VERIFIER_MD);
const readmeMd = Deno.readTextFileSync(README_MD);

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

const GATE_HEADING = /^6\. \*\*検証ゲート\*\*/;
const RESUME_PROMPT_HEADING = /^ *- \*\*再開時のプロンプト\*\*/;
const PASS_BRANCH_HEADING = /^ *- \*\*PASS\*\*/;
const LAUNCH_ROUTE_HEADING = /^ *- \*\*起動の経路は 3 段で、上から順に試す\*\*/;
const UNINSTALLED_HEADING = /^ *- \*\*未インストール環境のフォールバック\*\*/;

/** SKILL.md 手順 6 の全体 / 起動節 / 再開節 / 起動の 3 段の並び。 */
const gateSection = sedRange(skillMd, GATE_HEADING, /^### /);
const launchSection = sedRange(
  gateSection,
  GATE_HEADING,
  RESUME_PROMPT_HEADING,
);
const resumeSection = sedRange(
  gateSection,
  RESUME_PROMPT_HEADING,
  PASS_BRANCH_HEADING,
);
const launchSteps = sedRange(
  launchSection,
  LAUNCH_ROUTE_HEADING,
  UNINSTALLED_HEADING,
);

const ROUTE_ORDER = [
  "Paseo 経路",
  "task-pipeline-verifier",
  "general-purpose",
] as const;
const RESUME_ORDER = ["paseo send", "SendMessage", "フレッシュ起動"] as const;

const PASEO_FAIL_NEEDLE = "paseo 経路が失敗";
const UNKNOWN_AGENT_NEEDLE = "unknown agent type";
const HISTORY_NEEDLE = "history";
const RESUME_FALLBACK_NEEDLE = "verifier 再開失敗 — フレッシュ起動";
const SESSION_GUARANTEE_NEEDLE = "`run.verifier_session` の一致である";
const PREFS_CAVEAT_NEEDLE = "保証の外";
const BOUNDARY_NEEDLE = "行動境界: あなたは評価者である";
const BOUNDARY_MODE_CLAUSE =
  "書き込みが許された環境で起動されていても同じである";
const GUARANTEE_LINE_NEEDLE = "mode は担保にならない";
const OUTPUT_LINE_NEEDLE = "- 出力:";
const HARNESS_TOOL_NAMES = ["Write tool", "Bash"] as const;
const README_ROUTE_NEEDLE = "検証ゲートは";

// --- 単体: 自前ヘルパが行・表・順序のスコープを保っているか -------------------------
const U_ROW_CASES: readonly [string, number, string][] = [
  ["| `verifier` | 同期 |", 1, "表の本文行なら拾う"],
  ["- 本文の `verifier` は表の外", 0, "表の外の散文は拾わない"],
  ["|---|---|", 0, "区切り行は拾わない"],
];

for (const [line, expected, label] of U_ROW_CASES) {
  Deno.test(`U1 tableRowsWith: ${label}`, () => {
    const actual = tableRowsWith(line, "`verifier`").length;
    assertOk(actual === expected, `expected=${expected} actual=${actual}`);
  });
}

Deno.test("U2 inOrder: 順序が入れ替われば偽", () => {
  assertOk(inOrder("a\nb\nc\n", ["a", "b", "c"]), "順序どおりで真にならない");
  assertOk(!inOrder("a\nb\nc\n", ["a", "c", "b"]), "入れ替えても真になった");
  assertOk(!inOrder("a\nb\nc\n", ["a", "z"]), "欠けても真になった");
});

Deno.test("U3 swapLines: 2 行を入れ替える", () => {
  assertOk(swapLines("x1\ny2\n", "x1", "y2") === "y2\nx1\n", "入れ替わらない");
});

// --- A 群: 現状が規定どおりであること -----------------------------------------------
Deno.test("A0 4 つの範囲 (手順 6 / 起動節 / 再開節 / 起動の 3 段) が切り出せる", () => {
  assertOk(gateSection.length > 0, "手順 6 の節が空");
  assertOk(launchSection.length > 0, "起動節が空");
  assertOk(resumeSection.length > 0, "再開節が空");
  assertOk(launchSteps.length > 0, "起動の 3 段の並びが空");
});

Deno.test("A1 起動の経路が Paseo → task-pipeline-verifier → general-purpose の順である", () => {
  assertOk(
    inOrder(launchSteps, ROUTE_ORDER),
    `段が欠けているか順序が違う: ${JSON.stringify(ROUTE_ORDER)}`,
  );
});

Deno.test("A2 Paseo から現行経路へ落ちる段の行に history の 1 行規定がある", () => {
  const line = lineWith(launchSection, PASEO_FAIL_NEEDLE);
  assertOk(line !== null, `落ちる段が見つからない: ${PASEO_FAIL_NEEDLE}`);
  assertOk(line.includes(HISTORY_NEEDLE), `同じ行に history が無い: ${line}`);
});

Deno.test("A2b 現行経路から general-purpose へ落ちる段の行に history の 1 行規定がある", () => {
  const line = lineWith(launchSection, UNKNOWN_AGENT_NEEDLE);
  assertOk(line !== null, `落ちる段が見つからない: ${UNKNOWN_AGENT_NEEDLE}`);
  assertOk(line.includes(HISTORY_NEEDLE), `同じ行に history が無い: ${line}`);
});

Deno.test("A3 再開の経路が paseo send → SendMessage → フレッシュ起動の順である", () => {
  assertOk(
    inOrder(resumeSection, RESUME_ORDER),
    `段が欠けているか順序が違う: ${JSON.stringify(RESUME_ORDER)}`,
  );
});

Deno.test("A3b 再開で Paseo から現行経路へ落ちる段の行に history の 1 行規定がある", () => {
  const line = lineWith(resumeSection, PASEO_FAIL_NEEDLE);
  assertOk(line !== null, `落ちる段が見つからない: ${PASEO_FAIL_NEEDLE}`);
  assertOk(line.includes(HISTORY_NEEDLE), `同じ行に history が無い: ${line}`);
});

Deno.test("A4 再開に失敗したらフレッシュ起動へ落ちる既存規定が残っている", () => {
  assertOk(
    containsFixed(resumeSection, RESUME_FALLBACK_NEEDLE),
    `見つからない: ${RESUME_FALLBACK_NEEDLE}`,
  );
});

Deno.test("A5 役割の表の verifier 行が 1 本で、無人実行できる mode の値を持つ", () => {
  const rows = tableRowsWith(playbook, "`verifier`");
  assertOk(rows.length === 1, `件数=${rows.length}`);
  assertOk(
    rows[0].includes("bypassPermissions") && rows[0].includes("full"),
    `mode の値が行にない: ${rows[0]}`,
  );
});

Deno.test("A6 担保が mode ではなく verifier.md 側にあることが同じ 1 行に書かれている", () => {
  const line = lineWith(playbook, GUARANTEE_LINE_NEEDLE);
  assertOk(line !== null, `担保の所在が見つからない: ${GUARANTEE_LINE_NEEDLE}`);
  assertOk(
    line.includes("verifier.md"),
    `指し先が同じ行にない: ${line}`,
  );
});

Deno.test("A6b verifier.md の行動境界の行に、書き込みを許す環境でも変更しない旨がある", () => {
  const line = lineWith(verifierMd, BOUNDARY_NEEDLE);
  assertOk(line !== null, `行動境界の行が見つからない: ${BOUNDARY_NEEDLE}`);
  assertOk(
    line.includes(BOUNDARY_MODE_CLAUSE),
    `担保の実体が同じ行にない: ${line}`,
  );
});

Deno.test("A7 verifier.md の出力節にハーネス固有のツール名が無く、verdict path は残る", () => {
  const line = lineWith(verifierMd, OUTPUT_LINE_NEEDLE);
  assertOk(line !== null, `出力節の行が見つからない: ${OUTPUT_LINE_NEEDLE}`);
  for (const name of HARNESS_TOOL_NAMES) {
    assertOk(!line.includes(name), `ツール名が残っている (${name}): ${line}`);
  }
  assertOk(line.includes("verdict path"), `要求が消えている: ${line}`);
});

Deno.test("A7b verifier.md 全域にハーネス固有のツール名が無い", () => {
  for (const name of HARNESS_TOOL_NAMES) {
    assertOk(!containsFixed(verifierMd, name), `残っている: ${name}`);
  }
});

Deno.test("A8 README の検証ゲートの行が新しい経路順で書かれている", () => {
  const line = lineWith(readmeMd, README_ROUTE_NEEDLE);
  assertOk(line !== null, `検証ゲートの記述が見つからない`);
  assertOk(
    inOrder(line, ROUTE_ORDER),
    `経路順が違うか欠けている: ${line}`,
  );
});

Deno.test("A9 再開時の provider/model 同一性の担保と、prefs 書き換え時の但し書きがある", () => {
  assertOk(
    containsFixed(gateSection, SESSION_GUARANTEE_NEEDLE),
    `担保の記述が見つからない: ${SESSION_GUARANTEE_NEEDLE}`,
  );
  assertOk(
    containsFixed(gateSection, PREFS_CAVEAT_NEEDLE),
    `但し書きが見つからない: ${PREFS_CAVEAT_NEEDLE}`,
  );
});

// --- B 群: 退行を注入して、A 群相当の述語が検知できること ---------------------------
interface Regression {
  readonly label: string;
  readonly original: string;
  readonly mutated: string;
  /** 変異後も真なら、その述語は退行を見逃している。 */
  readonly stillHolds: (text: string) => boolean;
}

const paseoLaunchLine = lineWith(launchSection, PASEO_FAIL_NEEDLE) as string;
const uninstalledLine = lineWith(launchSection, UNKNOWN_AGENT_NEEDLE) as string;
const paseoResumeLine = lineWith(resumeSection, PASEO_FAIL_NEEDLE) as string;
const verifierRow = tableRowsWith(playbook, "`verifier`")[0];
const guaranteeLine = lineWith(playbook, GUARANTEE_LINE_NEEDLE) as string;
const boundaryLine = lineWith(verifierMd, BOUNDARY_NEEDLE) as string;
const outputLine = lineWith(verifierMd, OUTPUT_LINE_NEEDLE) as string;
const readmeRouteLine = lineWith(readmeMd, README_ROUTE_NEEDLE) as string;

const REGRESSIONS: readonly Regression[] = [
  {
    label: "起動の 1 段目と 3 段目が入れ替わる",
    original: launchSteps,
    mutated: swapLines(
      launchSteps,
      "1. **Paseo 経路**",
      "3. **`general-purpose`**",
    ),
    stillHolds: (t) => inOrder(t, ROUTE_ORDER),
  },
  {
    label: "起動の Paseo の段そのものが消える",
    original: launchSteps,
    mutated: launchSteps.replace(`${paseoLaunchLine}\n`, ""),
    stillHolds: (t) => inOrder(t, ROUTE_ORDER),
  },
  {
    label: "起動 1 段目の行からだけ history が消える (節の別の場所には残る)",
    original: launchSection,
    mutated: launchSection.replace(
      paseoLaunchLine,
      paseoLaunchLine.replaceAll(HISTORY_NEEDLE, "記録"),
    ),
    stillHolds: (t) =>
      (lineWith(t, PASEO_FAIL_NEEDLE) as string).includes(HISTORY_NEEDLE),
  },
  {
    label: "起動 2 段目の行からだけ history が消える (節の別の場所には残る)",
    original: launchSection,
    mutated: launchSection.replace(
      uninstalledLine,
      uninstalledLine.replaceAll(HISTORY_NEEDLE, "記録"),
    ),
    stillHolds: (t) =>
      (lineWith(t, UNKNOWN_AGENT_NEEDLE) as string).includes(HISTORY_NEEDLE),
  },
  {
    label: "再開の 1 段目と 2 段目が入れ替わる",
    original: resumeSection,
    mutated: swapLines(
      resumeSection,
      "1. **Paseo 経路**",
      "2. **現行ハーネス経路** — `SendMessage`",
    ),
    stillHolds: (t) => inOrder(t, RESUME_ORDER),
  },
  {
    label: "再開 1 段目の行からだけ history が消える (節の別の場所には残る)",
    original: resumeSection,
    mutated: resumeSection.replace(
      paseoResumeLine,
      paseoResumeLine.replaceAll(HISTORY_NEEDLE, "記録"),
    ),
    stillHolds: (t) =>
      (lineWith(t, PASEO_FAIL_NEEDLE) as string).includes(HISTORY_NEEDLE),
  },
  {
    label: "再開失敗時のフレッシュ起動の逐語が言い換えられる",
    original: resumeSection,
    mutated: resumeSection.replace(RESUME_FALLBACK_NEEDLE, "再開できなかった"),
    stillHolds: (t) => containsFixed(t, RESUME_FALLBACK_NEEDLE),
  },
  {
    label: "verifier の行が表の外の散文へ退化する",
    original: playbook,
    mutated: playbook.replace(
      verifierRow,
      verifierRow.replace("| `verifier` |", "`verifier`:"),
    ),
    stillHolds: (t) => tableRowsWith(t, "`verifier`").length === 1,
  },
  {
    label: "verifier の行から mode の値が消える (節の別の場所には残る)",
    original: playbook,
    mutated: playbook.replace(
      verifierRow,
      verifierRow.replace("claude: `bypassPermissions` / omp: `full`", "—"),
    ),
    stillHolds: (t) => {
      const rows = tableRowsWith(t, "`verifier`");
      return rows.length === 1 && rows[0].includes("bypassPermissions") &&
        rows[0].includes("full");
    },
  },
  {
    label: "担保の行から指し先 (verifier.md) が消える (節の別の場所には残る)",
    original: playbook,
    mutated: playbook.replace(
      guaranteeLine,
      guaranteeLine.replaceAll(
        "`references/verifier.md` の行動境界の記述",
        "指示文",
      ),
    ),
    stillHolds: (t) =>
      (lineWith(t, GUARANTEE_LINE_NEEDLE) as string).includes("verifier.md"),
  },
  {
    label: "verifier.md の行動境界から、書き込みを許す環境の句だけが消える",
    original: verifierMd,
    mutated: verifierMd.replace(
      boundaryLine,
      boundaryLine.replace(
        `**${BOUNDARY_MODE_CLAUSE}** — 変更しないことを守るのはこの指示であって、環境側の制限ではない。`,
        "",
      ),
    ),
    stillHolds: (t) =>
      (lineWith(t, BOUNDARY_NEEDLE) as string).includes(BOUNDARY_MODE_CLAUSE),
  },
  {
    label: "出力節が旧文言 (Write tool は無いので Bash で書く) に戻る",
    original: verifierMd,
    mutated: verifierMd.replace(
      outputLine,
      outputLine.replace(
        "書き込みの手段はその環境で使えるものでよい",
        "Write tool は無いので Bash で書く",
      ),
    ),
    stillHolds: (t) =>
      HARNESS_TOOL_NAMES.every((name) =>
        !(lineWith(t, OUTPUT_LINE_NEEDLE) as string).includes(name)
      ),
  },
  {
    label: "出力節を部分的にだけ直す (Write tool は消すが Bash で書くが残る)",
    original: verifierMd,
    mutated: verifierMd.replace(
      outputLine,
      outputLine.replace(
        "書き込みの手段はその環境で使えるものでよい",
        "Bash で書く",
      ),
    ),
    stillHolds: (t) =>
      HARNESS_TOOL_NAMES.every((name) =>
        !(lineWith(t, OUTPUT_LINE_NEEDLE) as string).includes(name)
      ),
  },
  {
    label: "README だけが旧い経路順 (general-purpose だけ) に戻る",
    original: readmeMd,
    mutated: readmeMd.replace(
      readmeRouteLine,
      "`agents/` を入れなくても skill は動く (task-pipeline の検証ゲートは general-purpose にフォールバックする)。",
    ),
    stillHolds: (t) =>
      inOrder(lineWith(t, README_ROUTE_NEEDLE) as string, ROUTE_ORDER),
  },
  {
    label: "再開時の provider/model 同一性の担保が消える",
    original: gateSection,
    mutated: gateSection.replace(
      SESSION_GUARANTEE_NEEDLE,
      "セッションの都合である",
    ),
    stillHolds: (t) => containsFixed(t, SESSION_GUARANTEE_NEEDLE),
  },
  {
    label: "手順 6 の見出しが変わって節が切り出せなくなる",
    original: skillMd,
    mutated: skillMd.replace("6. **検証ゲート**", "6. 検証ゲート"),
    stillHolds: (t) => sedRange(t, GATE_HEADING, /^### /).length > 0,
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
