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
// 3 つ目の壊れ方が (c) 節の中で規定どうしが矛盾する — prefs が無いときの帰結が「既定の組を
// 適用する」と「無条件にセッション継承へ落ちる」の両方を主張する状態 (gh-112)。矛盾したまま
// でも文面は読めてしまい、実行時には静かに片方だけが採られる (実測では Paseo 経路と別プロバイダ
// 検証が黙って無効化された) ので、A3b〜A3f が同じ節の中で機械照合する。
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

/** セッション継承の主張に付いていなければならない条件語 (gh-112)。 */
const INHERITANCE_NEEDLE = "セッション継承";
const INHERITANCE_CONDITIONS = ["実在確認", "現行ハーネス経路"] as const;

/** 番号付きリストの n 段目の**本文行** (行頭が `<n>. ` の行。無ければ null)。 */
function numberedStep(text: string, n: number): string | null {
  const prefix = `${n}. `;
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) return line;
  }
  return null;
}

/**
 * `セッション継承` を条件なしで主張している行。
 * prefs 不在の帰結は「既定の組を適用する」が正で、セッション継承はその落ち先でしかない
 * (gh-112)。条件語を伴わない行が 1 本でもあれば、節は 2 通りに読める状態に戻っている。
 */
function unconditionalInheritanceLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) =>
      line.includes(INHERITANCE_NEEDLE) &&
      !INHERITANCE_CONDITIONS.some((condition) => line.includes(condition))
    );
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

/** prefs 不在の帰結 (解決手順の 3 段目) が名指すべきもの — 既定の組と、その両側の provider。 */
const DEFAULT_SET_NEEDLES = ["既定の組", "claude", "omp"] as const;

/** 実在確認の規定。手段と落ち先が**同じ行**になければ、落ち先だけが独り歩きする。 */
const EXISTENCE_CHECK_NEEDLE = "provider の実在を確かめる";
const EXISTENCE_CHECK_MEANS = "list_providers";

/** prefs 不在で残す history の 1 行。両方の帰結が**同じ規定**に無ければならない。 */
const HISTORY_RULE_NEEDLE = "prefs 不在で残す history の 1 行";
const HISTORY_ON_ROUTE = "Paseo 経路に乗る";
const HISTORY_OFF_ROUTE = "Paseo 経路に乗らない";

/** ユーザーへの一度だけの通知が伝えるべき 3 点 (既定の組 / 置き場所 / 落ち先での無効化)。 */
const NOTICE_RULE_NEEDLE = "一度だけの通知";
const NOTICE_NEEDLES = [
  "既定の組",
  "~/.paseo/orchestration-preferences.json",
  "別プロバイダ検証",
  "可観測性",
] as const;

/** prefs doc の実在確認の案内。実在するものだけを指していなければならない。 */
const PREFS_DOC_GUIDE_NEEDLE = "実在するものは";
const PREFS_DOC_GUIDE_TOOLS = ["list_providers", "list_models"] as const;
const PREFS_DOC_ABSENT_COMMAND = "paseo model ls";

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

const U_STEP_CASES: readonly [string, string | null, string][] = [
  ["3. 三段目\n", "3. 三段目", "行頭の番号なら拾う"],
  ["  3. 入れ子の三段目\n", null, "インデントされた番号は拾わない"],
  ["本文の途中に 3. がある行\n", null, "行の途中の番号は拾わない"],
  ["1. 一段目\n2. 二段目\n", null, "その番号が無ければ null"],
  [
    "3. 先の三段目\n3. 後の三段目\n",
    "3. 先の三段目",
    "同じ番号が複数あれば最初の 1 本",
  ],
  [
    "3. 三段目\n- 直後の箇条書き\n4. 四段目\n",
    "3. 三段目",
    "後続行 (箇条書き・次の段) を飲み込まない",
  ],
];

for (const [text, expected, label] of U_STEP_CASES) {
  Deno.test(`U6 numberedStep: ${label}`, () => {
    const actual = numberedStep(text, 3);
    assertOk(
      actual === expected,
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  });
}

const U_INHERITANCE_CASES: readonly [string, number, string][] = [
  [
    "3. それも無ければ**セッション継承** (現行どおり)。\n",
    1,
    "条件語が無い行は矛盾として拾う",
  ],
  [
    "実在確認に通らなかったときだけセッション継承で起動する。\n",
    0,
    "実在確認が同じ行にあれば拾わない",
  ],
  [
    "現行ハーネス経路ではセッション継承に落とす。\n",
    0,
    "現行ハーネス経路が同じ行にあれば拾わない",
  ],
  ["実在確認をしてから使う。\n", 0, "セッション継承を含まない行は対象外"],
  [
    "実在確認をしてから使う。\nそれも無ければセッション継承。\n",
    1,
    "条件語が別の行にあるだけなら拾う (行スコープ)",
  ],
];

for (const [text, expected, label] of U_INHERITANCE_CASES) {
  Deno.test(`U7 unconditionalInheritanceLines: ${label}`, () => {
    const actual = unconditionalInheritanceLines(text).length;
    assertOk(actual === expected, `expected=${expected} actual=${actual}`);
  });
}

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

Deno.test("A3b 解決手順の 3 段目が既定の組 (実装 = claude / 検証 = omp) に解決する", () => {
  const step = numberedStep(resolutionSection, 3);
  assertOk(step !== null, "3 段目の本文行が見つからない");
  for (const needle of DEFAULT_SET_NEEDLES) {
    assertOk(step.includes(needle), `3 段目にない (${needle}): ${step}`);
  }
});

Deno.test("A3c 解決手順の節に、セッション継承を条件なしで主張する行が無い", () => {
  const lines = unconditionalInheritanceLines(resolutionSection);
  assertOk(
    lines.length === 0,
    `無条件のセッション継承が残っている: ${JSON.stringify(lines)}`,
  );
});

Deno.test("A3d 実在確認の規定に、確認の手段と失敗したときの落ち先が同じ行である", () => {
  const line = lineWith(resolutionSection, EXISTENCE_CHECK_NEEDLE);
  assertOk(
    line !== null,
    `実在確認の規定が見つからない: ${EXISTENCE_CHECK_NEEDLE}`,
  );
  assertOk(
    line.includes(EXISTENCE_CHECK_MEANS),
    `確認の手段が同じ行にない: ${line}`,
  );
  assertOk(
    line.includes(INHERITANCE_NEEDLE),
    `確認に失敗したときの落ち先が同じ行にない: ${line}`,
  );
});

Deno.test("A3e prefs 不在の history 規定の 1 行に、両方の経路の帰結がある", () => {
  const line = lineWith(resolutionSection, HISTORY_RULE_NEEDLE);
  assertOk(
    line !== null,
    `history の規定が見つからない: ${HISTORY_RULE_NEEDLE}`,
  );
  assertOk(
    line.includes(HISTORY_ON_ROUTE),
    `既定の組を適用できたときの帰結が同じ行にない: ${line}`,
  );
  assertOk(
    line.includes(HISTORY_OFF_ROUTE),
    `落ち先に落ちたときの帰結が同じ行にない: ${line}`,
  );
});

Deno.test("A3f 一度だけの通知の規定に、既定の組・置き場所・無効化されるものがある", () => {
  const line = lineWith(resolutionSection, NOTICE_RULE_NEEDLE);
  assertOk(line !== null, `通知の規定が見つからない: ${NOTICE_RULE_NEEDLE}`);
  for (const needle of NOTICE_NEEDLES) {
    assertOk(line.includes(needle), `通知の規定にない (${needle}): ${line}`);
  }
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

Deno.test("A11 prefs doc の実在確認の案内が、実在するツールだけを指している", () => {
  const line = lineWith(prefsDoc, PREFS_DOC_GUIDE_NEEDLE);
  assertOk(
    line !== null,
    `実在確認の案内が見つからない: ${PREFS_DOC_GUIDE_NEEDLE}`,
  );
  for (const tool of PREFS_DOC_GUIDE_TOOLS) {
    assertOk(line.includes(tool), `案内にない (${tool}): ${line}`);
  }
  assertOk(
    !line.includes(PREFS_DOC_ABSENT_COMMAND),
    `実在しないコマンドが残っている (${PREFS_DOC_ABSENT_COMMAND}): ${line}`,
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
const stepThreeLine = numberedStep(resolutionSection, 3) as string;
const existenceLine = lineWith(
  resolutionSection,
  EXISTENCE_CHECK_NEEDLE,
) as string;
const historyRuleLine = lineWith(
  resolutionSection,
  HISTORY_RULE_NEEDLE,
) as string;
const noticeRuleLine = lineWith(
  resolutionSection,
  NOTICE_RULE_NEEDLE,
) as string;
const prefsGuideLine = lineWith(prefsDoc, PREFS_DOC_GUIDE_NEEDLE) as string;

/** A11 相当の述語 (包含側と非包含側の両方)。 */
function prefsGuidePointsToRealTools(text: string): boolean {
  const line = lineWith(text, PREFS_DOC_GUIDE_NEEDLE);
  if (line === null) return false;
  return PREFS_DOC_GUIDE_TOOLS.every((tool) => line.includes(tool)) &&
    !line.includes(PREFS_DOC_ABSENT_COMMAND);
}

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
  {
    label: "3 段目が旧文 (無条件のセッション継承) に戻る",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      stepThreeLine,
      "3. それも無ければ**セッション継承** (現行どおり。Agent tool に `model` を渡さない)。",
    ),
    stillHolds: (t) => unconditionalInheritanceLines(t).length === 0,
  },
  {
    label: "3 段目から検証側の provider (omp) だけが消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      stepThreeLine,
      stepThreeLine.replace(" / 検証 = `omp`", ""),
    ),
    stillHolds: (t) => {
      const step = numberedStep(t, 3);
      return step !== null &&
        DEFAULT_SET_NEEDLES.every((needle) => step.includes(needle));
    },
  },
  {
    label: "3 段目が番号付きリストから散文へ退化する",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      stepThreeLine,
      stepThreeLine.replace("3. ", ""),
    ),
    stillHolds: (t) => {
      const step = numberedStep(t, 3);
      return step !== null &&
        DEFAULT_SET_NEEDLES.every((needle) => step.includes(needle));
    },
  },
  {
    label: "セッション継承の行から条件語だけが消える (節の別の行には残る)",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      stepThreeLine,
      stepThreeLine.replace(
        "下記の**実在確認**に通らなかったときだけ",
        "それでも駄目なら",
      ),
    ),
    stillHolds: (t) => unconditionalInheritanceLines(t).length === 0,
  },
  {
    label: "実在確認の行から確認の手段 (list_providers) が消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      existenceLine,
      existenceLine.replace("MCP の `list_providers` を引き", "MCP を引き"),
    ),
    stillHolds: (t) =>
      (lineWith(t, EXISTENCE_CHECK_NEEDLE) as string).includes(
        EXISTENCE_CHECK_MEANS,
      ),
  },
  {
    label:
      "実在確認の行から落ち先 (セッション継承) が消える (節の別の行には残る)",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      existenceLine,
      existenceLine.replace(
        "その役割をセッション継承で起動する",
        "その役割を現行どおり起動する",
      ),
    ),
    stillHolds: (t) =>
      (lineWith(t, EXISTENCE_CHECK_NEEDLE) as string).includes(
        INHERITANCE_NEEDLE,
      ),
  },
  {
    label: "history の規定から落ち先側の帰結が消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      historyRuleLine,
      historyRuleLine.replace(HISTORY_OFF_ROUTE, "セッション継承で起動する"),
    ),
    stillHolds: (t) =>
      (lineWith(t, HISTORY_RULE_NEEDLE) as string).includes(HISTORY_OFF_ROUTE),
  },
  {
    label:
      "history の規定の落ち先側の帰結が別の行へ移る (節には残るが 1 行ではなくなる)",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      historyRuleLine,
      `${
        historyRuleLine.replace(HISTORY_OFF_ROUTE, "セッション継承で起動する")
      }\n- 落ち先では verifier は ${HISTORY_OFF_ROUTE}。`,
    ),
    stillHolds: (t) =>
      (lineWith(t, HISTORY_RULE_NEEDLE) as string).includes(HISTORY_OFF_ROUTE),
  },
  {
    label: "通知の規定から、落ち先で無効化されるものが消える",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      noticeRuleLine,
      noticeRuleLine.replace(
        "、(c) 落ち先に落ちた回は、別プロバイダ検証と Paseo 側の可観測性が効かないこと",
        "",
      ),
    ),
    stillHolds: (t) => {
      const line = lineWith(t, NOTICE_RULE_NEEDLE) as string;
      return NOTICE_NEEDLES.every((needle) => line.includes(needle));
    },
  },
  {
    label: "通知の規定から prefs の置き場所が消える (節の別の行には残る)",
    original: resolutionSection,
    mutated: resolutionSection.replace(
      noticeRuleLine,
      noticeRuleLine.replace(
        "`~/.paseo/orchestration-preferences.json` を置けば",
        "設定ファイルを置けば",
      ),
    ),
    stillHolds: (t) => {
      const line = lineWith(t, NOTICE_RULE_NEEDLE) as string;
      return NOTICE_NEEDLES.every((needle) => line.includes(needle));
    },
  },
  {
    label: "prefs doc の実在確認の案内が旧文 (実在しない CLI) に戻る",
    original: prefsDoc,
    mutated: prefsDoc.replace(
      prefsGuideLine,
      "- **provider 名とモデル id は環境ごとに違う。** 実在するものは `paseo provider ls` / `paseo model ls` で確かめる (この例の値をそのまま信じない)。",
    ),
    stillHolds: prefsGuidePointsToRealTools,
  },
  {
    label:
      "prefs doc の案内が部分更新にとどまる (MCP を足したが `paseo model ls` も残る)",
    original: prefsDoc,
    mutated: prefsDoc.replace(
      prefsGuideLine,
      prefsGuideLine.replace(
        "CLI では `paseo provider ls` が provider の在庫と `status` を返す。",
        "CLI では `paseo provider ls` / `paseo model ls` で確かめる。",
      ),
    ),
    stillHolds: prefsGuidePointsToRealTools,
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
