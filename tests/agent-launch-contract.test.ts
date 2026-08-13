// tests/agent-launch-contract.test.ts — サブエージェントの起動規則の正が
// task-pipeline/playbooks/agent-launch.md に 1 箇所だけあり、各起動箇所がそこを指したままである
// ことを固定する (gh-103)。
//
//   deno test --allow-read tests/agent-launch-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 集約の壊れ方は 2 通りある。(a) 手順書の側が痩せる — 役割の行が消える、解決の段が抜ける、
// フォールバックの出口が消える。(b) 参照の側が切れる — 起動箇所が手順書を指さなくなり、
// 起動パラメータの判断がその場の即興に戻る。どちらも実行時には静かに失敗する (モデルは
// 「規則が無かった」とは言わずに進む) ので、文面の側で機械照合する。
//
// 判定はすべて **行スコープ / 表の本文行スコープ / 節スコープ** で行う。全文 includes に
// 退化させると、規律の語が別の場所に 1 つ残っているだけで通ってしまい、この 2 通りの
// 壊れ方をどちらも見逃す (B 群がその退化を実際に注入して確かめる)。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 手順書の 1 行目の「入る条件」は tests/skill-dispatch-alignment.test.ts の A3 が
//   playbooks/ を列挙して自動で覆うので、ここでは重ねない。

import { assertOk, containsFixed, sedRange } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOK_MD = new URL(
  "task-pipeline/playbooks/agent-launch.md",
  REPO_ROOT,
);
const PREFS_DOC = new URL(
  "task-pipeline/docs/orchestration-preferences.md",
  REPO_ROOT,
);
const PLAYBOOKS_DIR = new URL("task-pipeline/playbooks/", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const playbook = Deno.readTextFileSync(PLAYBOOK_MD);
const prefsDoc = Deno.readTextFileSync(PREFS_DOC);

const DISPATCH_HEADING = /^## 分岐の手順書 \(ディスパッチ表\)$/;
const PLAYBOOK_REF = "`playbooks/agent-launch.md`";

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

/** 固定文字列を含む最初の行 (無ければ null)。行スコープの判定に使う。 */
function lineWith(text: string, needle: string): string | null {
  for (const line of text.split("\n")) {
    if (line.includes(needle)) return line;
  }
  return null;
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

/** 最初の ```json フェンスの中身 (無ければ null)。 */
function jsonBlock(text: string): string | null {
  const matched = /```json\n([\s\S]*?)\n```/.exec(text);
  return matched === null ? null : matched[1];
}

/** `<provider>/<model>` の provider 部分 (最初の `/` より前)。model 側の `/` は問わない。 */
function providerOf(value: string): string {
  return value.split("/")[0];
}

/** prefs 例の JSON から `providers` を取り出す (壊れていれば null)。 */
function providersOf(text: string): Record<string, string> | null {
  const block = jsonBlock(text);
  if (block === null) return null;
  try {
    const parsed = JSON.parse(block) as { providers?: Record<string, string> };
    return parsed.providers ?? null;
  } catch {
    return null;
  }
}

/** prefs 例で実装と検証が別プロバイダになっているか。 */
function implAuditDiffer(text: string): boolean {
  const providers = providersOf(text);
  if (providers === null) return false;
  const impl = providers["impl"];
  const audit = providers["audit"];
  if (typeof impl !== "string" || typeof audit !== "string") return false;
  return providerOf(impl) !== providerOf(audit);
}

/** 要求 2 の 11 役割。表の「役割」列の表記そのもの。 */
const ROLES = [
  "`executor`",
  "`verifier`",
  "`adapter-list`",
  "`adapter-mark`",
  "`triage`",
  "`survey`",
  "`retro`",
  "`pr-watcher`",
  "`pr-responder`",
  "`依存昇格`",
  "`衝突トリアージ`",
] as const;

/** 解決手順の 3 段。この順で現れなければならない。 */
const RESOLUTION_STEPS = [
  "**起動引数**",
  "`~/.paseo/orchestration-preferences.json` の `providers`",
  "**セッション継承**",
] as const;

const PREFS_MISSING_NEEDLE = "一度だけ伝える";

// フォールバックが持つべき 3 点。「落ちる」と「history に 1 行」は 1 つの規定なので、
// 節スコープではなく**同じ行**で見る — 節スコープにすると、ベストエフォートの役割の
// 「history に 1 行残して続行する」が代わりに満たしてしまい、規定が消えても通る。
const FALLBACK_RULE_NEEDLE = "失敗したら現行ハーネス経路";
const FALLBACK_HISTORY_NEEDLE = "history に 1 行";
const FALLBACK_EXHAUSTED_NEEDLE = "どちらの経路も使えないとき";

/** モデル指定の現行規律。役割の**行**に残っていなければならない。 */
const MODEL_DISCIPLINE: readonly [string, string][] = [
  ["`adapter-list`", "`haiku`"],
  ["`triage`", "指定しない"],
  ["`survey`", "指定しない"],
  ["`retro`", "指定しない"],
];

/** 新しい引数と、それが載るべき 2 箇所 (引数の並び / トークン内訳)。 */
const ARG_LINE_NEEDLE = "$ARGUMENTS";
const TOKEN_LINE_NEEDLE = "で始まるものがそれぞれの設定";
const NEW_ARGS = ["impl_provider", "verify_provider"] as const;

/** 要求 7 の起動箇所 (executor の再起動 3 箇所は「手順 3 と同じ形」経由で届くので対象外)。 */
const LAUNCH_SITES: readonly [string, URL, string][] = [
  [
    "SKILL.md triage",
    SKILL_MD,
    "トリアージ用サブエージェント (general-purpose、同期) を 1 体起動して",
  ],
  [
    "SKILL.md adapter",
    SKILL_MD,
    "アダプタ操作は毎回フレッシュなサブエージェント",
  ],
  [
    "SKILL.md executor",
    SKILL_MD,
    "実行エージェントを **background で 1 体** 起動する",
  ],
  ["SKILL.md verifier", SKILL_MD, "検証エージェントを同期起動する"],
  [
    "depleted.md survey",
    new URL("depleted.md", PLAYBOOKS_DIR),
    "内訳を作るのは read-only の調査サブエージェント",
  ],
  [
    "retro-launch.md retro",
    new URL("retro-launch.md", PLAYBOOKS_DIR),
    "read-only のレトロ観測サブエージェント",
  ],
  [
    "pr-follow.md pr-watcher",
    new URL("pr-follow.md", PLAYBOOKS_DIR),
    "フレッシュな観測サブエージェント",
  ],
  [
    "pr-follow.md pr-responder",
    new URL("pr-follow.md", PLAYBOOKS_DIR),
    "対象の `{id, updated_at}` の一覧を集め",
  ],
  [
    "merge-recovery.md 依存昇格",
    new URL("merge-recovery.md", PLAYBOOKS_DIR),
    "task-prep の 2 ファイルのパスを渡して従わせる",
  ],
  [
    "merge-recovery.md 衝突トリアージ",
    new URL("merge-recovery.md", PLAYBOOKS_DIR),
    "read-only のトリアージサブエージェント",
  ],
];

const resolutionSection = sedRange(
  playbook,
  /^## provider・model・mode の解決手順$/,
  /^## /,
);
const fallbackSection = sedRange(
  playbook,
  /^## 経路の選択とフォールバック$/,
  /^## /,
);
const dispatchSection = sedRange(skillMd, DISPATCH_HEADING, /^## /);

const U_ROW_CASES: readonly [string, number, string][] = [
  ["| `retro` | 同期 | 指定しない |", 1, "表の本文行なら拾う"],
  ["- 本文の `retro` は表の外", 0, "表の外の散文は拾わない"],
  ["|---|---|", 0, "区切り行は拾わない"],
  ["| :--- | ---: |", 0, "整列指定つきの区切り行も拾わない"],
];

for (const [line, expected, label] of U_ROW_CASES) {
  Deno.test(`U1 tableRowsWith: ${label}`, () => {
    const actual = tableRowsWith(line, "`retro`").length;
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

const U_PROVIDER_CASES: readonly [string, string, string][] = [
  ["claude/claude-sonnet-4-5", "claude", "provider/model"],
  ["omp/anthropic/claude-haiku-4-5", "omp", "model 側に / を含む形"],
  ["claude", "claude", "model 省略"],
];

for (const [value, expected, label] of U_PROVIDER_CASES) {
  Deno.test(`U3 providerOf: ${label}`, () => {
    assertOk(
      providerOf(value) === expected,
      `expected=${expected} actual=${providerOf(value)}`,
    );
  });
}

const U_PREFS_CASES: readonly [string, boolean, string][] = [
  [
    '```json\n{"providers":{"impl":"claude/o","audit":"omp/a"}}\n```',
    true,
    "別プロバイダ",
  ],
  [
    '```json\n{"providers":{"impl":"claude/opus","audit":"claude/haiku"}}\n```',
    false,
    "provider が同じで model だけ違う",
  ],
  [
    '```json\n{"providers":{"impl":"claude/o"}}\n```',
    false,
    "audit キーが無い",
  ],
  [
    '```json\n{"providers":{"impl":"claude/o",}\n```',
    false,
    "JSON が壊れている",
  ],
  ["設定例のフェンスが無い本文", false, "json フェンスが無い"],
];

for (const [text, expected, label] of U_PREFS_CASES) {
  Deno.test(`U4 implAuditDiffer: ${label}`, () => {
    assertOk(
      implAuditDiffer(text) === expected,
      `expected=${expected} actual=${implAuditDiffer(text)}`,
    );
  });
}

Deno.test("U5 lineWith: 行スコープで返す (別の行の一致を混ぜない)", () => {
  const found = lineWith("参照はこの行\n別の行に needle\n", "needle");
  assertOk(found === "別の行に needle", `found=${JSON.stringify(found)}`);
});

Deno.test("A0 手順書の 3 節が切り出せる", () => {
  assertOk(resolutionSection.length > 0, "解決手順の節が空");
  assertOk(fallbackSection.length > 0, "経路とフォールバックの節が空");
  assertOk(dispatchSection.length > 0, "SKILL.md のディスパッチ表の節が空");
});

for (const role of ROLES) {
  Deno.test(`A1 役割の表に ${role} の行がちょうど 1 本ある`, () => {
    const rows = tableRowsWith(playbook, role);
    assertOk(rows.length === 1, `件数=${rows.length}`);
  });
}

Deno.test("A2 解決手順が 3 段をこの順で持つ (引数 → prefs のカテゴリ → 既定)", () => {
  assertOk(
    inOrder(resolutionSection, RESOLUTION_STEPS),
    `段が欠けているか順序が違う: ${JSON.stringify(RESOLUTION_STEPS)}`,
  );
});

Deno.test("A3 prefs が無いときの扱いが解決手順の節にある", () => {
  assertOk(
    containsFixed(resolutionSection, PREFS_MISSING_NEEDLE),
    `見つからない: ${PREFS_MISSING_NEEDLE}`,
  );
});

Deno.test("A4 Paseo が失敗したら現行経路へ落ち、同じ規定で history に 1 行残す", () => {
  const line = lineWith(fallbackSection, FALLBACK_RULE_NEEDLE);
  assertOk(
    line !== null,
    `フォールバックの規定が見つからない: ${FALLBACK_RULE_NEEDLE}`,
  );
  assertOk(
    line.includes(FALLBACK_HISTORY_NEEDLE),
    `同じ規定に history の 1 行が無い: ${line}`,
  );
});

Deno.test("A4b フォールバックの節に、どちらの経路も使えないときの扱いがある", () => {
  assertOk(
    containsFixed(fallbackSection, FALLBACK_EXHAUSTED_NEEDLE),
    `見つからない: ${FALLBACK_EXHAUSTED_NEEDLE}`,
  );
});

for (const [role, needle] of MODEL_DISCIPLINE) {
  Deno.test(`A5 ${role} の行に現行のモデル規律 (${needle}) が残っている`, () => {
    const rows = tableRowsWith(playbook, role);
    assertOk(rows.length === 1, `行が一意でない: 件数=${rows.length}`);
    assertOk(rows[0].includes(needle), `行にない: ${rows[0]}`);
  });
}

for (const arg of NEW_ARGS) {
  Deno.test(`A6 SKILL.md の引数の並びに ${arg}= がある`, () => {
    const line = lineWith(skillMd, ARG_LINE_NEEDLE);
    assertOk(line !== null, "引数の並びの行が見つからない");
    assertOk(line.includes(`[${arg}=`), `並びにない: ${arg}`);
  });

  Deno.test(`A7 SKILL.md のトークン内訳に ${arg}= がある`, () => {
    const line = lineWith(skillMd, TOKEN_LINE_NEEDLE);
    assertOk(line !== null, "トークン内訳の行が見つからない");
    assertOk(line.includes(`\`${arg}=\``), `内訳にない: ${arg}`);
  });
}

Deno.test("A8 ディスパッチ表の本文行に agent-launch.md の行がある", () => {
  const rows = tableRowsWith(dispatchSection, PLAYBOOK_REF);
  assertOk(rows.length === 1, `件数=${rows.length}`);
});

for (const [label, url, needle] of LAUNCH_SITES) {
  Deno.test(`A9 起動箇所 [${label}] のその行が手順書を指している`, () => {
    const line = lineWith(Deno.readTextFileSync(url), needle);
    assertOk(line !== null, `起動箇所の行が見つからない: ${needle}`);
    assertOk(line.includes(PLAYBOOK_REF), `参照がその行にない: ${line}`);
  });
}

Deno.test("A10 設定例の実装 (impl) と検証 (audit) が別プロバイダである", () => {
  const providers = providersOf(prefsDoc);
  assertOk(providers !== null, "json フェンスを JSON として読めない");
  assertOk(
    implAuditDiffer(prefsDoc),
    `別プロバイダでない: impl=${providers["impl"]} audit=${providers["audit"]}`,
  );
});

interface Regression {
  readonly label: string;
  readonly original: string;
  readonly mutated: string;
  /** 変異後も真なら、その述語は退行を見逃している。 */
  readonly stillHolds: (text: string) => boolean;
}

const roleRow = tableRowsWith(playbook, "`retro`")[0];
const adapterRow = tableRowsWith(playbook, "`adapter-list`")[0];
const dispatchRow = tableRowsWith(dispatchSection, PLAYBOOK_REF)[0];
const watcherLine = lineWith(
  Deno.readTextFileSync(new URL("pr-follow.md", PLAYBOOKS_DIR)),
  "フレッシュな観測サブエージェント",
) as string;
const tokenLine = lineWith(skillMd, TOKEN_LINE_NEEDLE) as string;
const fallbackRuleLine = lineWith(
  fallbackSection,
  FALLBACK_RULE_NEEDLE,
) as string;
const prFollowMd = Deno.readTextFileSync(
  new URL("pr-follow.md", PLAYBOOKS_DIR),
);

const REGRESSIONS: readonly Regression[] = [
  {
    label: "役割の行が消える",
    original: playbook,
    mutated: playbook.replace(`${roleRow}\n`, ""),
    stillHolds: (t) => tableRowsWith(t, "`retro`").length === 1,
  },
  {
    label: "役割の行が表の外の散文へ退化する",
    original: playbook,
    mutated: playbook.replace(
      roleRow,
      roleRow.replace("| `retro` |", "`retro`:"),
    ),
    stillHolds: (t) => tableRowsWith(t, "`retro`").length === 1,
  },
  {
    label: "解決手順の段が入れ替わる",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      RESOLUTION_STEPS[0],
      RESOLUTION_STEPS[2],
    ),
    stillHolds: (t) => inOrder(t, RESOLUTION_STEPS),
  },
  {
    label: "prefs が無いときの扱いが消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(PREFS_MISSING_NEEDLE, ""),
    stillHolds: (t) => containsFixed(t, PREFS_MISSING_NEEDLE),
  },
  {
    label: "どちらの経路も使えないときの出口が消える",
    original: fallbackSection,
    mutated: fallbackSection.replace(FALLBACK_EXHAUSTED_NEEDLE, ""),
    stillHolds: (t) => containsFixed(t, FALLBACK_EXHAUSTED_NEEDLE),
  },
  {
    label:
      "フォールバックの規定から history の 1 行が消える (節の別の場所には残る)",
    original: fallbackSection,
    mutated: fallbackSection.replace(
      fallbackRuleLine,
      fallbackRuleLine.replace(FALLBACK_HISTORY_NEEDLE, ""),
    ),
    stillHolds: (t) =>
      (lineWith(t, FALLBACK_RULE_NEEDLE) as string).includes(
        FALLBACK_HISTORY_NEEDLE,
      ),
  },
  {
    label: "adapter-list の行からモデル固定が消える (節の別の場所には残る)",
    original: playbook,
    mutated: playbook.replace(adapterRow, adapterRow.replace("(`haiku`)", "")),
    stillHolds: (t) =>
      tableRowsWith(t, "`adapter-list`")[0].includes("`haiku`"),
  },
  {
    label: "トークン内訳からだけ新しい引数が消える (引数の並びには残る)",
    original: skillMd,
    mutated: skillMd.replace(
      tokenLine,
      tokenLine.replace(" / `impl_provider=` / `verify_provider=`", ""),
    ),
    stillHolds: (t) =>
      (lineWith(t, TOKEN_LINE_NEEDLE) as string).includes("`impl_provider=`"),
  },
  {
    label: "ディスパッチ表の行が表の外へ出る",
    original: dispatchSection,
    mutated: dispatchSection.replace(
      dispatchRow,
      dispatchRow.replaceAll("|", ""),
    ),
    stillHolds: (t) => tableRowsWith(t, PLAYBOOK_REF).length === 1,
  },
  {
    label: "起動箇所の行から参照が消える (ファイル内の他の行には残る)",
    original: prFollowMd,
    mutated: prFollowMd.replace(
      watcherLine,
      watcherLine.replace(
        ` (起動パラメータと経路の正は ${PLAYBOOK_REF} の \`pr-watcher\` の行)`,
        "",
      ),
    ),
    stillHolds: (t) =>
      (lineWith(t, "フレッシュな観測サブエージェント") as string).includes(
        PLAYBOOK_REF,
      ),
  },
  {
    label: "設定例の audit が impl と同じ provider になる (model だけ違う)",
    original: prefsDoc,
    mutated: prefsDoc.replace(
      /"audit": "[^"]+"/,
      '"audit": "claude/claude-haiku-4-5"',
    ),
    stillHolds: implAuditDiffer,
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
