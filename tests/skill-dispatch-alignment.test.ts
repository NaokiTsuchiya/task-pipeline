// tests/skill-dispatch-alignment.test.ts — task-pipeline/SKILL.md の **ディスパッチ表** と、
// 分割先の手順書ディレクトリ task-pipeline/playbooks/ が食い違っていないことを固定する (gh-57)。
//
//   deno test --allow-read tests/skill-dispatch-alignment.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: SKILL.md はオーケストレーター (プロンプト駆動) が毎イテレーション読む唯一の骨格で、
// 分岐の手順は playbooks/ の手順書に外出ししてある。両者は 2 方向に壊れうる:
//   (a) 表のエントリが指すファイルが無い  → 分岐に入ったオーケストレーターが手順を読めない
//   (b) 表から参照されていない手順書がある → その手順書に入る条件が誰にも分からない (孤児)
// どちらも実行時には静かに失敗する (モデルは「無かった」と言わずに即興で進む) ので、
// ここで機械照合する。あわせて、手順書の冒頭 1 行の「入る条件」と、表が「必ず読んでから進む」
// と明記していることも見る — どちらも欠けると表は形だけ残って規律が消える。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - ケース U: 下の純関数 5 つの入力クラス (表の行の判別・パス抽出・不足/孤児・入る条件・明記)。
// - ケース A: 現状の SKILL.md と playbooks/ が揃っていることの検証。
// - ケース B: **メモリ上の複製** に回帰を注入し、A 群の各チェックが不一致を検知できることを確認する。

import { assertOk, containsFixed, sedRange } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOKS_DIR = new URL("task-pipeline/playbooks/", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);

/** ディスパッチ表の H2 (この 1 行が動いたら節が切り出せなくなる)。 */
const DISPATCH_HEADING = /^## 分岐の手順書 \(ディスパッチ表\)$/;

/** 表のエントリの書式: バッククォートで囲んだ `playbooks/<name>.md`。 */
const ENTRY_RE = /`playbooks\/([^`/]+\.md)`/g;

/** タスク本文 要求 2 が明記を求めている一文 (太字の内側だけを見る)。 */
const MANDATORY_READ_NEEDLE =
  "分岐の入口に来たら、必ずその行のファイルを Read してから進む。";

const ENTRY_CONDITION_PREFIX = "**入る条件**: ";

/** ディスパッチ表の節 (見出しから次の H2 まで)。見出しが一致しなければ空文字。 */
function dispatchSection(text: string): string {
  return sedRange(text, DISPATCH_HEADING, /^## /);
}

/**
 * 表の本文行か。`|` で始まる行のうち、区切り行 (`|---|---|`) を除いたもの。
 * ヘッダ行は本文行として扱うが、パスを含まないので抽出結果には出ない。
 */
function isTableBodyRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  return !/^\|[\s:|-]+\|$/.test(trimmed);
}

/** 節の表本文行から手順書のファイル名を出現順で拾う (重複除去)。 */
function dispatchEntries(section: string): string[] {
  const found: string[] = [];
  for (const line of section.split("\n")) {
    if (!isTableBodyRow(line)) continue;
    for (const matched of line.matchAll(ENTRY_RE)) {
      if (!found.includes(matched[1])) found.push(matched[1]);
    }
  }
  return found;
}

/** 表にあるのに実在しないファイル。 */
function missingEntries(
  entries: readonly string[],
  files: readonly string[],
): string[] {
  return entries.filter((entry) => !files.includes(entry));
}

/** 実在するのに表から参照されていないファイル (孤児)。 */
function orphanFiles(
  entries: readonly string[],
  files: readonly string[],
): string[] {
  return files.filter((file) => !entries.includes(file));
}

/** 手順書の 1 行目が「入る条件」で、かつ中身が空でないか。 */
function hasEntryCondition(text: string): boolean {
  const first = text.split("\n")[0];
  if (!first.startsWith(ENTRY_CONDITION_PREFIX)) return false;
  return first.slice(ENTRY_CONDITION_PREFIX.length).trim().length > 0;
}

/** 「必ず読んでから進む」の明記が **節本文に** あるか (全文スコープにしない)。 */
function mandatoryReadDeclared(section: string): boolean {
  return containsFixed(section, MANDATORY_READ_NEEDLE);
}

function playbookFileNames(): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(PLAYBOOKS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) names.push(entry.name);
  }
  return names.sort();
}

const U_SECTION_SAMPLE = [
  "## 分岐の手順書 (ディスパッチ表)",
  "",
  `**${MANDATORY_READ_NEEDLE}**`,
  "",
  "| 到達条件 | 読むファイル |",
  "|---|---|",
  "| 条件 1 | `playbooks/alpha.md` |",
  "| 条件 2 | `playbooks/beta.md` |",
  "",
  "## 次の節",
  "",
  "本文の `playbooks/gamma.md` は表の外なので拾わない。",
].join("\n");

Deno.test("U1 dispatchSection: 見出しが一致すれば節を返し、次の H2 で閉じる", () => {
  const section = dispatchSection(U_SECTION_SAMPLE);
  assertOk(containsFixed(section, "`playbooks/alpha.md`"), "表が入っていない");
  assertOk(
    !containsFixed(section, "`playbooks/gamma.md`"),
    "次の節まで拾っている",
  );
});

Deno.test("U2 dispatchSection: 見出しが違えば空文字 (黙って通さない)", () => {
  const section = dispatchSection(U_SECTION_SAMPLE.replace(
    "## 分岐の手順書 (ディスパッチ表)",
    "## 分岐の手順書",
  ));
  assertOk(section === "", `空でない: ${JSON.stringify(section.slice(0, 40))}`);
});

Deno.test("U3 dispatchSection: 終端見出しが無い最終節は EOF まで", () => {
  const text = [
    "## 分岐の手順書 (ディスパッチ表)",
    "",
    "| a | `playbooks/x.md` |",
  ]
    .join("\n");
  assertOk(
    containsFixed(dispatchSection(text), "`playbooks/x.md`"),
    "最終節が切り出せていない",
  );
});

const U_ROW_CASES: readonly [string, boolean, string][] = [
  ["| 条件 | `playbooks/a.md` |", true, "表の本文行"],
  ["|---|---|", false, "区切り行"],
  ["| :--- | ---: |", false, "整列指定つきの区切り行"],
  ["本文に `playbooks/a.md` と書いただけの行", false, "表の外の行"],
];

for (const [line, expected, label] of U_ROW_CASES) {
  Deno.test(`U4 isTableBodyRow: ${label}`, () => {
    assertOk(
      isTableBodyRow(line) === expected,
      `expected=${expected} actual=${isTableBodyRow(line)}`,
    );
  });
}

const U_ENTRY_CASES: readonly [string, string[], string][] = [
  ["| 条件 | `playbooks/a.md` |", ["a.md"], "バッククォート付きは採る"],
  ["| 条件 | playbooks/a.md |", [], "バッククォート無しは採らない"],
  ["| 条件 | `references/a.md` |", [], "別ディレクトリは採らない"],
  ["| 条件 | `playbooks/a.txt` |", [], "拡張子違いは採らない"],
  [
    "| 条件 | `playbooks/a.md` と `playbooks/b.md` |",
    ["a.md", "b.md"],
    "1 行に 2 パスなら 2 件",
  ],
  [
    "|---|---|\n| 到達条件 | 読むファイル |",
    [],
    "区切り行とヘッダ行だけなら 0 件",
  ],
  [
    "| 条件 1 | `playbooks/a.md` |\n| 条件 2 | `playbooks/a.md` |",
    ["a.md"],
    "同じパスが 2 行なら重複除去して 1 件",
  ],
  [
    "| 条件 1 | `playbooks/a.md` |\n| 条件 2 | `playbooks/b.md` |",
    ["a.md", "b.md"],
    "別パス 2 行なら 2 件",
  ],
  ["本文の `playbooks/a.md`", [], "表の行でなければ採らない"],
];

for (const [section, expected, label] of U_ENTRY_CASES) {
  Deno.test(`U5 dispatchEntries: ${label}`, () => {
    const actual = dispatchEntries(section);
    assertOk(
      JSON.stringify(actual) === JSON.stringify(expected),
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  });
}

const U_MISSING_CASES: readonly [string[], string[], string[], string][] = [
  [["a.md", "b.md"], ["a.md", "b.md"], [], "全エントリが実在 → 空"],
  [["a.md", "z.md"], ["a.md"], ["z.md"], "1 件だけ実在しない → その 1 件"],
  [[], ["a.md"], [], "エントリが空 → 空"],
];

for (const [entries, files, expected, label] of U_MISSING_CASES) {
  Deno.test(`U6 missingEntries: ${label}`, () => {
    const actual = missingEntries(entries, files);
    assertOk(
      JSON.stringify(actual) === JSON.stringify(expected),
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  });
}

const U_ORPHAN_CASES: readonly [string[], string[], string[], string][] = [
  [["a.md", "b.md"], ["a.md", "b.md"], [], "全ファイルが参照済み → 空"],
  [["a.md"], ["a.md", "b.md"], ["b.md"], "1 件だけ未参照 → その 1 件"],
  [["a.md"], [], [], "ファイル集合が空 → 空"],
];

for (const [entries, files, expected, label] of U_ORPHAN_CASES) {
  Deno.test(`U7 orphanFiles: ${label}`, () => {
    const actual = orphanFiles(entries, files);
    assertOk(
      JSON.stringify(actual) === JSON.stringify(expected),
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  });
}

const U_CONDITION_CASES: readonly [string, boolean, string][] = [
  ["**入る条件**: 何かのとき。\n\n### 節\n", true, "1 行目に入る条件がある"],
  ["### 節\n\n本文\n", false, "1 行目が見出し (入る条件が無い)"],
  ["**入る条件**:   \n\n### 節\n", false, "コロンの後が空白だけ"],
  ["\n**入る条件**: 何かのとき。\n", false, "2 行目にある (1 行目ではない)"],
];

for (const [text, expected, label] of U_CONDITION_CASES) {
  Deno.test(`U8 hasEntryCondition: ${label}`, () => {
    assertOk(
      hasEntryCondition(text) === expected,
      `expected=${expected} actual=${hasEntryCondition(text)}`,
    );
  });
}

Deno.test("U9 mandatoryReadDeclared: 節本文にあれば真", () => {
  assertOk(
    mandatoryReadDeclared(dispatchSection(U_SECTION_SAMPLE)),
    "偽になった",
  );
});

Deno.test("U9b mandatoryReadDeclared: 節本文に無ければ偽", () => {
  const without = U_SECTION_SAMPLE.replace(`**${MANDATORY_READ_NEEDLE}**`, "");
  assertOk(!mandatoryReadDeclared(dispatchSection(without)), "真になった");
});

Deno.test("U9c mandatoryReadDeclared: 節の外にだけあるなら偽 (節スコープである)", () => {
  const moved = U_SECTION_SAMPLE
    .replace(`**${MANDATORY_READ_NEEDLE}**`, "")
    .replace("## 次の節", `## 次の節\n\n**${MANDATORY_READ_NEEDLE}**`);
  assertOk(
    !mandatoryReadDeclared(dispatchSection(moved)),
    "節の外の一文で真になった — 全文スコープに退化している",
  );
});

const section = dispatchSection(skillMd);
const entries = dispatchEntries(section);
const files = playbookFileNames();

Deno.test("A0 ディスパッチ表の節が切り出せ、エントリが 1 件以上ある", () => {
  assertOk(section.length > 0, "節が空 — 見出しパターンが一致しない");
  assertOk(entries.length > 0, "エントリが 0 件");
});

Deno.test("A1 表の各エントリが指すファイルが実在する", () => {
  const missing = missingEntries(entries, files);
  assertOk(
    missing.length === 0,
    `実在しない: ${JSON.stringify(missing)} — playbooks/ にあるのは ${
      JSON.stringify(files)
    }`,
  );
});

Deno.test("A2 playbooks/ の各ファイルが表から参照されている (孤児が無い)", () => {
  const orphans = orphanFiles(entries, files);
  assertOk(
    orphans.length === 0,
    `表から参照されていない: ${JSON.stringify(orphans)}`,
  );
});

for (const name of playbookFileNames()) {
  Deno.test(`A3-${name} 冒頭 1 行に「入る条件」がある`, () => {
    const text = Deno.readTextFileSync(new URL(name, PLAYBOOKS_DIR));
    assertOk(
      hasEntryCondition(text),
      `1 行目: ${JSON.stringify(text.split("\n")[0].slice(0, 60))}`,
    );
  });
}

Deno.test("A4 ディスパッチ表の節に「必ず読んでから進む」の明記がある", () => {
  assertOk(
    mandatoryReadDeclared(section),
    `見つからない: ${MANDATORY_READ_NEEDLE}`,
  );
});

const brokenSection = section.replace(
  `\`playbooks/${entries[0]}\``,
  "`playbooks/does-not-exist.md`",
);

Deno.test("B0 エントリを壊す回帰注入が効いている", () => {
  assertOk(brokenSection !== section, "置換が効かず元テキストと同一になった");
});

Deno.test("B1 壊れたエントリを A1 相当のチェックで検知できる", () => {
  const missing = missingEntries(dispatchEntries(brokenSection), files);
  assertOk(
    missing.length === 1 && missing[0] === "does-not-exist.md",
    `検知できない: ${JSON.stringify(missing)}`,
  );
});

const filesWithOrphan = [...files, "orphan-not-referenced.md"];

Deno.test("B2 未参照ファイルを足す回帰注入が効いている", () => {
  assertOk(
    filesWithOrphan.length === files.length + 1,
    "ファイル集合が 1 件増えていない",
  );
});

Deno.test("B3 孤児ファイルを A2 相当のチェックで検知できる", () => {
  const orphans = orphanFiles(entries, filesWithOrphan);
  assertOk(
    orphans.length === 1 && orphans[0] === "orphan-not-referenced.md",
    `検知できない: ${JSON.stringify(orphans)}`,
  );
});

const firstPlaybook = Deno.readTextFileSync(new URL(files[0], PLAYBOOKS_DIR));
const withoutCondition = firstPlaybook.split("\n").slice(2).join("\n");

Deno.test("B4 入る条件を落とす回帰注入が効いている", () => {
  assertOk(
    withoutCondition !== firstPlaybook,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B5 入る条件の欠落を A3 相当のチェックで検知できる", () => {
  assertOk(!hasEntryCondition(withoutCondition), "除去後も真と判定された");
});

const withoutMandatoryRead = skillMd.replace(MANDATORY_READ_NEEDLE, "");

Deno.test("B6 「必ず読んでから進む」を落とす回帰注入が効いている", () => {
  assertOk(
    withoutMandatoryRead !== skillMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B7 明記の欠落を A4 相当のチェックで検知できる", () => {
  assertOk(
    !mandatoryReadDeclared(dispatchSection(withoutMandatoryRead)),
    "除去後も真と判定された",
  );
});
