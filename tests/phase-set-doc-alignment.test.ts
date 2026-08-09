// tests/phase-set-doc-alignment.test.ts — 状態機械の **フェーズ集合** と、エージェント指示書の
// **節見出し** が食い違っていないことを固定する:
//   - task-pipeline/scripts/state.schema.json      (フェーズ名の機械可読ソース。run の phase enum)
//   - task-pipeline/scripts/state-model-v2.ts      (どのフェーズが検証ゲートを持つか)
//   - task-pipeline/scripts/state-verdict-path.ts  (連番フェーズの成果物接頭辞)
//   - task-pipeline/references/verifier.md         (フェーズ別の合格条件)
//   - task-pipeline/references/executor.md         (フェーズ仕様と成果物規約)
//
//   deno test --allow-read tests/phase-set-doc-alignment.test.ts
//   deno task test                                 # 自動検出でも走る
//
// 背景: フェーズを 1 つ足しても、verifier.md の合格条件節と executor.md のフェーズ節が無いまま
// **黙って通る**。基準の無いフェーズを渡された executor / verifier は即興で動くことになる。
// フェーズ名は schema から読むので、schema にフェーズを足して 2 つの `.md` を更新しないと
// このスイートが落ちる。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - ケース U: 下の純関数 4 つ (境界判定・見出し抽出・節範囲・schema 抽出) の入力クラス。
// - ケース A: 現状の 5 ファイルが揃っていることの検証。フェーズごとにテストを分けて登録するので、
//   落ちたテスト名にフェーズ名が出る (schema にフェーズを足すと state-schema-v2.test.ts も落ちるため、
//   どちらが何を言っているのかを名前で見分けられるようにしてある)。
// - ケース B: **メモリ上の複製** に回帰を注入し、A 群の各チェックが不一致を検知できることを確認する。
//   注入は「当該節・当該見出しからのみ」除去する形にしてある — 接頭辞は他の節にも出現するので、
//   ファイル全体を見るだけの実装 (= 節スコープの判定が抜けた実装) を通してしまわないため。

import { assertOk, containsFixed } from "./contract-helpers.ts";
import {
  PHASE_VALUES,
  VERIFIED_PHASE_VALUES,
} from "../task-pipeline/scripts/state-model-v2.ts";
import { SEQUENCED_PHASE_ARTIFACT } from "../task-pipeline/scripts/state-verdict-path.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SCHEMA_JSON = new URL(
  "task-pipeline/scripts/state.schema.json",
  REPO_ROOT,
);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);
const EXECUTOR_MD = new URL("task-pipeline/references/executor.md", REPO_ROOT);

const schemaText = Deno.readTextFileSync(SCHEMA_JSON);
const verifierMd = Deno.readTextFileSync(VERIFIER_MD);
const executorMd = Deno.readTextFileSync(EXECUTOR_MD);

/** verifier.md でフェーズ別の合格条件をぶら下げている H2 の目印。 */
const GATE_SECTION_HEADING = "フェーズ別の合格条件";

interface Heading {
  readonly level: number;
  readonly text: string;
  /** 1 始まりの行番号。 */
  readonly line: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 行頭 ATX 見出しを拾う。コードフェンスの内側は見出しにしない。
 * **開始フェンスは info string 付き (```json) も受け、閉じは ``` だけの行とする** —
 * verifier.md の開始フェンスはすべて info string 付きで、完全一致で開閉を判定すると
 * 開始を取りこぼして閉じを開始と誤認する。
 */
function markdownHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  let insideFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (!insideFence) insideFence = true;
      else if (/^```\s*$/.test(line)) insideFence = false;
      continue;
    }
    if (insideFence) continue;
    const matched = /^(#{1,6}) (.*)$/.exec(line);
    if (matched !== null) {
      headings.push({
        level: matched[1].length,
        text: matched[2],
        line: i + 1,
      });
    }
  }
  return headings;
}

/**
 * 見出し行がフェーズ名を **トークンとして** 含むか。
 * フェーズ名には `+` (research+plan) と `_` (pr_fix) が入るので `\b` は使えない。
 * 前後の境界集合で判定し、フェーズ名は正規表現メタ文字をエスケープしてから埋め込む
 * (エスケープしないと `research+plan` の `h+` が量化子になり `researchplan` に当たる)。
 */
function declaresPhase(headingText: string, phase: string): boolean {
  const escaped = phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s(\`])${escaped}($|[\\s)\`,、。])`).test(
    headingText,
  );
}

/** 見出しから、同レベル以上の次の見出しの直前まで (無ければ EOF まで) の行範囲 (1 始まり、両端含む)。 */
function sectionLineRange(
  text: string,
  heading: Heading,
): { readonly start: number; readonly end: number } {
  const headings = markdownHeadings(text);
  const index = headings.findIndex((h) => h.line === heading.line);
  if (index === -1) {
    throw new Error(`見出し (L${heading.line}) がこのテキストに無い`);
  }
  const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
  return {
    start: heading.line,
    // 最終節 (後続見出し無し) は EOF まで。空文字を返さない。
    end: next === undefined ? text.split("\n").length : next.line - 1,
  };
}

function sectionBody(text: string, heading: Heading): string {
  const { start, end } = sectionLineRange(text, heading);
  return text.split("\n").slice(start - 1, end).join("\n");
}

/**
 * verifier.md の `## フェーズ別の合格条件` 配下の H3。
 * 起点 H2 が見つからなければ投げる (空配列を返して黙って通さない)。
 */
function gateSectionSubHeadings(text: string): Heading[] {
  const headings = markdownHeadings(text);
  const startIndex = headings.findIndex(
    (h) => h.level === 2 && h.text.includes(GATE_SECTION_HEADING),
  );
  if (startIndex === -1) {
    throw new Error(`起点 H2 "${GATE_SECTION_HEADING}" が見つからない`);
  }
  const subHeadings: Heading[] = [];
  for (const heading of headings.slice(startIndex + 1)) {
    if (heading.level <= 2) break;
    if (heading.level === 3) subHeadings.push(heading);
  }
  return subHeadings;
}

/**
 * `$defs` を走査し、`properties.phase.enum` を持つ定義からフェーズ名の和集合を取る
 * (宣言順・重複除去)。run のサブタイプ名は手書きしない — 枝が増えても追従する。
 */
function phasesFromSchemaText(text: string): string[] {
  const schema: unknown = JSON.parse(text);
  if (!isRecord(schema)) throw new Error("schema のルートがオブジェクトでない");
  const defs = schema["$defs"];
  if (!isRecord(defs)) throw new Error("schema に $defs が無い");
  const phases: string[] = [];
  for (const def of Object.values(defs)) {
    if (!isRecord(def)) continue;
    const properties = def["properties"];
    if (!isRecord(properties)) continue;
    const phase = properties["phase"];
    if (!isRecord(phase)) continue;
    const values = phase["enum"];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== "string") {
        throw new Error(
          `phase enum に非文字列がある: ${JSON.stringify(value)}`,
        );
      }
      if (!phases.includes(value)) phases.push(value);
    }
  }
  if (phases.length === 0) {
    throw new Error("phase enum を持つ $defs が 1 つも無い");
  }
  return phases;
}

// 以下 4 つは A 群と B 群の双方から呼ぶ。注入が A 群と同じ経路を通らないと、
// 注入が検知できても本番の判定は別物になる。
function verifierGateHeadingsFor(text: string, phase: string): Heading[] {
  return gateSectionSubHeadings(text).filter((h) =>
    declaresPhase(h.text, phase)
  );
}

function executorHeadingsFor(text: string, phase: string): Heading[] {
  return markdownHeadings(text).filter(
    (h) => (h.level === 2 || h.level === 3) && declaresPhase(h.text, phase),
  );
}

/** 成果物接頭辞が executor.md の **当該節の本文** にあるか (ファイル全体ではない)。 */
function executorSectionMentions(
  text: string,
  phase: string,
  needle: string,
): boolean {
  const headings = executorHeadingsFor(text, phase);
  if (headings.length !== 1) return false;
  return containsFixed(sectionBody(text, headings[0]), needle);
}

/** 成果物接頭辞が verifier.md の **当該 H3 見出し** にあるか (節本文ではない)。 */
function verifierHeadingMentions(
  text: string,
  phase: string,
  needle: string,
): boolean {
  const headings = verifierGateHeadingsFor(text, phase);
  if (headings.length !== 1) return false;
  return containsFixed(headings[0].text, needle);
}

function describe(headings: readonly Heading[]): string {
  return headings.length === 0
    ? "(無し)"
    : headings.map((h) => `L${h.line}(H${h.level}) ${h.text}`).join(" | ");
}

const DECLARES_PHASE_CASES: readonly [string, string, boolean, string][] = [
  ["plan → `<run dir>/plan.md`", "plan", true, "行頭 + 空白終端"],
  ["タスク完了処理 (finalize)", "finalize", true, "括弧で囲まれる"],
  ["フェーズ `pr_fix` の節", "pr_fix", true, "バッククォートで囲まれる"],
  ["フェーズ report", "report", true, "行末で終わる"],
  ["フェーズ report、および", "report", true, "読点で終わる"],
  ["research+plan → x", "research", false, "前境界が + (部分文字列)"],
  ["research+plan → x", "plan", false, "後境界が + (部分文字列)"],
  [
    "research+plan (`research.md` + `plan.md`)",
    "plan",
    false,
    "後境界が . (ファイル名の一部)",
  ],
  ["planning", "plan", false, "後境界が英字 (語の前方一致)"],
  ["preplan の話", "plan", false, "前境界が英字 (語の後方一致)"],
  ["何も無い節", "plan", false, "非出現"],
  [
    "成果物は <run dir>/plan に置く",
    "plan",
    false,
    "前境界が / (パス区切り)",
  ],
  [
    "researchplan",
    "research+plan",
    false,
    "メタ文字を含むフェーズ名がリテラル扱い (h+ が量化子に化けない)",
  ],
  [
    "research+plan → x",
    "research+plan",
    true,
    "メタ文字を含むフェーズ名の正マッチ",
  ],
];

for (const [heading, phase, expected, label] of DECLARES_PHASE_CASES) {
  Deno.test(`U1 declaresPhase: ${label}`, () => {
    const actual = declaresPhase(heading, phase);
    assertOk(
      actual === expected,
      `heading=${heading} phase=${phase} expected=${expected} actual=${actual}`,
    );
  });
}

const FENCED_MARKDOWN = [
  "# top",
  "```json",
  '{"##": "## fake-in-info-fence"}',
  "## fake",
  "```",
  "## real",
  "```",
  "## fake-in-bare-fence",
  "```",
  "### after",
  "#notheading",
  "",
  "本文",
  "#### deep",
].join("\n");

Deno.test("U2 markdownHeadings: レベルを取り、`#` 直後に空白の無い行と本文は拾わない", () => {
  const levels = markdownHeadings(FENCED_MARKDOWN).map((h) =>
    `${h.level}:${h.text}`
  );
  assertOk(
    levels.includes("1:top") && levels.includes("3:after") &&
      levels.includes("4:deep"),
    `H1/H3/H4 が採れていない: ${JSON.stringify(levels)}`,
  );
  assertOk(
    !levels.some((l) => l.includes("notheading")) &&
      !levels.some((l) => l.includes("本文")),
    `見出しでない行を拾った: ${JSON.stringify(levels)}`,
  );
});

Deno.test("U3 markdownHeadings: info string 付きの開始フェンスの内側を拾わず、閉じた後は拾う", () => {
  const texts = markdownHeadings(FENCED_MARKDOWN).map((h) => h.text);
  assertOk(
    !texts.includes("fake"),
    `info string 付き開始フェンスの内側を見出しにした: ${
      JSON.stringify(texts)
    }`,
  );
  assertOk(
    texts.includes("real"),
    `フェンスが閉じた後の見出しを落とした: ${JSON.stringify(texts)}`,
  );
});

Deno.test("U4 markdownHeadings: 裸の開始フェンスの内側も拾わない", () => {
  const texts = markdownHeadings(FENCED_MARKDOWN).map((h) => h.text);
  assertOk(
    !texts.includes("fake-in-bare-fence"),
    `裸フェンスの内側を見出しにした: ${JSON.stringify(texts)}`,
  );
});

const SECTION_SAMPLE = [
  `## ${GATE_SECTION_HEADING}`,
  "",
  "### alpha (`alpha.md`)",
  "alpha の本文",
  "#### alpha-detail",
  "",
  "### beta (`beta.md`)",
  "beta の本文",
  "",
  "## 別の H2",
  "",
  "### gamma (`gamma.md`)",
  "gamma の本文",
].join("\n");

Deno.test("U5 gateSectionSubHeadings: 配下の H3 だけを取り、H4 と次の H2 以降は含めない", () => {
  const texts = gateSectionSubHeadings(SECTION_SAMPLE).map((h) => h.text);
  assertOk(
    texts.length === 2 && texts[0].startsWith("alpha") &&
      texts[1].startsWith("beta"),
    `想定と違う: ${JSON.stringify(texts)}`,
  );
});

Deno.test("U6 gateSectionSubHeadings: 起点 H2 が無ければ投げる (空配列を返さない)", () => {
  let thrown = false;
  try {
    gateSectionSubHeadings("# 見出しだけ\n\n### alpha\n");
  } catch {
    thrown = true;
  }
  assertOk(thrown, "起点 H2 が無いのに投げなかった");
});

Deno.test("U7 sectionBody: 後続見出しのある節は次の同レベル以上の見出し直前まで", () => {
  const beta = gateSectionSubHeadings(SECTION_SAMPLE)[1];
  const body = sectionBody(SECTION_SAMPLE, beta);
  assertOk(
    containsFixed(body, "beta の本文") && !containsFixed(body, "gamma"),
    `節の範囲が漏れている: ${JSON.stringify(body)}`,
  );
});

Deno.test("U8 sectionBody: 後続見出しの無い最終節は EOF まで (空文字にしない)", () => {
  const lastHeading = markdownHeadings(executorMd).at(-1);
  assertOk(lastHeading !== undefined, "executor.md から見出しが取れない");
  const body = sectionBody(executorMd, lastHeading);
  assertOk(
    body.split("\n").length > 1,
    `最終節の本文が空になった: ${JSON.stringify(body)}`,
  );
});

Deno.test("U9 phasesFromSchemaText: 定義をまたぐ enum の和集合を重複無しで取る", () => {
  const phases = phasesFromSchemaText(schemaText);
  assertOk(phases.length > 0, "1 件も取れない");
  assertOk(
    new Set(phases).size === phases.length,
    `重複がある: ${JSON.stringify(phases)}`,
  );
  assertOk(
    phases.includes("finalize"),
    `4 定義すべてに出る finalize が無い: ${JSON.stringify(phases)}`,
  );
});

const SCHEMA_REJECT_CASES: readonly [string, string][] = [
  ['{"$defs":{}}', "phase enum を持つ定義が 0 件"],
  ["{}", "$defs 自体が無い"],
  ['{"$defs":{"x":{"properties":{"phase":{"enum":[1]}}}}}', "enum に非文字列"],
  ["{", "JSON として不正"],
];

for (const [text, label] of SCHEMA_REJECT_CASES) {
  Deno.test(`U10 phasesFromSchemaText: ${label} なら投げる`, () => {
    let thrown = false;
    try {
      phasesFromSchemaText(text);
    } catch {
      thrown = true;
    }
    assertOk(thrown, "投げずに値を返した");
  });
}

const phases = phasesFromSchemaText(schemaText);
// 「検証ゲートを持たないフェーズ」はモデルの差集合から導く (テストに "finalize" を直書きしない)。
const ungatedPhases: string[] = PHASE_VALUES.filter(
  (phase) => !(VERIFIED_PHASE_VALUES as readonly string[]).includes(phase),
);
const gatedPhases = phases.filter((phase) => !ungatedPhases.includes(phase));

Deno.test("A0 state.schema.json からフェーズ名を抽出できる", () => {
  assertOk(phases.length > 0, "1 件も取れない");
});

Deno.test("A1 schema のフェーズ集合が state-model-v2.ts の PHASE_VALUES と一致する", () => {
  const fromSchema = [...phases].sort();
  const fromModel = [...PHASE_VALUES].sort();
  assertOk(
    JSON.stringify(fromSchema) === JSON.stringify(fromModel),
    `schema=${JSON.stringify(fromSchema)} model=${JSON.stringify(fromModel)}`,
  );
});

Deno.test("A2 検証ゲートを持たないフェーズが導出でき、schema のフェーズ集合に含まれる", () => {
  assertOk(
    ungatedPhases.length > 0,
    "PHASE_VALUES と VERIFIED_PHASE_VALUES の差が空 — ゲート無しフェーズの導出が成り立たない",
  );
  const unknown = ungatedPhases.filter((phase) => !phases.includes(phase));
  assertOk(unknown.length === 0, `schema に無い: ${JSON.stringify(unknown)}`);
});

Deno.test(`A3 verifier.md に "${GATE_SECTION_HEADING}" の H2 があり、配下に H3 がある`, () => {
  const subHeadings = gateSectionSubHeadings(verifierMd);
  assertOk(subHeadings.length > 0, "配下の H3 が 1 本も無い");
});

for (const phase of gatedPhases) {
  Deno.test(`A4-${phase} verifier.md の合格条件節に "${phase}" の H3 がちょうど 1 本ある`, () => {
    const found = verifierGateHeadingsFor(verifierMd, phase);
    assertOk(
      found.length === 1,
      `${found.length} 本: ${
        describe(found)
      } — フェーズを足したら verifier.md に合格条件節を足すこと`,
    );
  });
}

Deno.test("A5 verifier.md の合格条件節の各 H3 が、既知フェーズをちょうど 1 つ宣言する", () => {
  for (const heading of gateSectionSubHeadings(verifierMd)) {
    const declared = phases.filter((phase) =>
      declaresPhase(heading.text, phase)
    );
    assertOk(
      declared.length === 1,
      `L${heading.line} "${heading.text}" が宣言するフェーズ: ${
        JSON.stringify(declared)
      }`,
    );
  }
});

Deno.test("A6 検証ゲートを持たないフェーズは verifier.md の合格条件節を持たない", () => {
  for (const phase of ungatedPhases) {
    const found = verifierGateHeadingsFor(verifierMd, phase);
    assertOk(
      found.length === 0,
      `${phase} はゲートを持たないのに合格条件節がある: ${describe(found)}`,
    );
  }
});

for (const phase of phases) {
  Deno.test(`A7-${phase} executor.md に "${phase}" の節見出し (H2/H3) がちょうど 1 本ある`, () => {
    const found = executorHeadingsFor(executorMd, phase);
    assertOk(
      found.length === 1,
      `${found.length} 本: ${
        describe(found)
      } — フェーズを足したら executor.md に節を足すこと`,
    );
  });
}

for (const [phase, prefix] of Object.entries(SEQUENCED_PHASE_ARTIFACT)) {
  Deno.test(`A8-${phase} 成果物接頭辞 "${prefix}" が executor.md の当該節本文と verifier.md の当該 H3 にある`, () => {
    assertOk(
      executorSectionMentions(executorMd, phase, prefix),
      `executor.md の ${phase} 節の本文に "${prefix}" が無い`,
    );
    assertOk(
      verifierHeadingMentions(verifierMd, phase, prefix),
      `verifier.md の ${phase} の H3 見出しに "${prefix}" が無い`,
    );
  });
}

function replaceInLineRange(
  text: string,
  start: number,
  end: number,
  pattern: RegExp,
  replacement: string,
): string {
  const lines = text.split("\n");
  for (let i = start - 1; i < end && i < lines.length; i++) {
    lines[i] = lines[i].replace(pattern, () => replacement);
  }
  return lines.join("\n");
}

function insertAfterLine(text: string, line: number, inserted: string): string {
  const lines = text.split("\n");
  lines.splice(line, 0, inserted);
  return lines.join("\n");
}

function onlyHeadingFor(
  text: string,
  phase: string,
  lookup: (text: string, phase: string) => Heading[],
): Heading {
  const found = lookup(text, phase);
  if (found.length !== 1) {
    throw new Error(`${phase} の見出しが 1 本でない: ${describe(found)}`);
  }
  return found[0];
}

// 実在しうるフェーズ名を避けた合成名にしてある。実ファイルへ同じ名前のフェーズを足す
// 実験をすると、この注入が巻き添えで落ちて「節が無いから落ちた」という信号が濁る。
const INJECTED_PHASE = "injected_fake_phase";
const schemaWithInjectedPhase = schemaText.replace(
  /("phase": \{ "type": "string", "enum": \[)/,
  (_matched, opening: string) => `${opening}"${INJECTED_PHASE}", `,
);

Deno.test("B0 schema への回帰注入 (架空フェーズ) が効いている", () => {
  assertOk(
    schemaWithInjectedPhase !== schemaText,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B1 注入した架空フェーズが抽出結果に現れる (schema がフェーズ名の出所である)", () => {
  const injected = phasesFromSchemaText(schemaWithInjectedPhase);
  assertOk(
    injected.includes(INJECTED_PHASE),
    `抽出結果に現れない: ${JSON.stringify(injected)}`,
  );
  assertOk(
    injected.length === phases.length + 1,
    `件数が 1 件増えていない: ${injected.length} vs ${phases.length}`,
  );
});

Deno.test("B2 架空フェーズを足すと A1 相当 (schema ↔ モデルの一致) が不一致を検知する", () => {
  const injected = phasesFromSchemaText(schemaWithInjectedPhase);
  assertOk(
    JSON.stringify([...injected].sort()) !==
      JSON.stringify([...PHASE_VALUES].sort()),
    "注入後も schema とモデルが一致してしまった",
  );
});

Deno.test("B3 架空フェーズを足すと A4 相当 (verifier.md の節) が欠落を検知する", () => {
  assertOk(
    verifierGateHeadingsFor(verifierMd, INJECTED_PHASE).length === 0,
    "節が無いのに見つかってしまった",
  );
});

Deno.test("B4 架空フェーズを足すと A7 相当 (executor.md の節) が欠落を検知する", () => {
  assertOk(
    executorHeadingsFor(executorMd, INJECTED_PHASE).length === 0,
    "節が無いのに見つかってしまった",
  );
});

const verifierWithoutReport = verifierMd.replace(
  /^### report \(`report\.md`\)$/m,
  () => "",
);

Deno.test("B5 verifier.md (report 節の削除) への回帰注入が効いている", () => {
  assertOk(
    verifierWithoutReport !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B6 verifier.md の節削除を A4 相当のチェックで検知できる", () => {
  assertOk(
    verifierGateHeadingsFor(verifierWithoutReport, "report").length === 0,
    "削除後も report の H3 が見つかった",
  );
});

const executorWithoutFinalize = executorMd.replace(
  /^## タスク完了処理 \(finalize\)$/m,
  () => "",
);

Deno.test("B7 executor.md (finalize 節の削除) への回帰注入が効いている", () => {
  assertOk(
    executorWithoutFinalize !== executorMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B8 executor.md の節削除を A7 相当のチェックで検知できる", () => {
  assertOk(
    executorHeadingsFor(executorWithoutFinalize, "finalize").length === 0,
    "削除後も finalize の見出しが見つかった",
  );
});

const verifierWithUnknownPhase = verifierMd.replace(
  /^### report \(`report\.md`\)$/m,
  () => `### ${INJECTED_PHASE} (\`${INJECTED_PHASE}.md\`)`,
);

Deno.test("B9 verifier.md (未知フェーズ名への差し替え) への回帰注入が効いている", () => {
  assertOk(
    verifierWithUnknownPhase !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B10 未知フェーズ名の節を A5 相当のチェックで検知できる", () => {
  const orphan = gateSectionSubHeadings(verifierWithUnknownPhase).filter(
    (heading) => phases.every((phase) => !declaresPhase(heading.text, phase)),
  );
  assertOk(
    orphan.length === 1,
    `既知フェーズを 1 つも宣言しない H3 を検知できない: ${describe(orphan)}`,
  );
});

// 接頭辞は他の節 (進め方・finalize) にも出るので、全文から消す注入ではファイル全体を
// 見るだけの実装を通してしまう。節スコープの判定が抜けている実装をここで落とす。
const executorPrFixRange = sectionLineRange(
  executorMd,
  onlyHeadingFor(executorMd, "pr_fix", executorHeadingsFor),
);
const executorWithoutPrFixPrefix = replaceInLineRange(
  executorMd,
  executorPrFixRange.start + 1,
  executorPrFixRange.end,
  /pr-fix-/g,
  "成果物-",
);

Deno.test("B11 executor.md (pr_fix 節の本文からのみ接頭辞を除去) への回帰注入が効いている", () => {
  assertOk(
    executorWithoutPrFixPrefix !== executorMd,
    "置換が効かず元テキストと同一になった",
  );
  assertOk(
    containsFixed(executorWithoutPrFixPrefix, "pr-fix-"),
    "他の節の出現まで消えている — 節スコープの検出力が落ちる注入になっている",
  );
});

Deno.test("B12 executor.md 側の接頭辞欠落を A8 相当のチェックで検知できる", () => {
  assertOk(
    !executorSectionMentions(executorWithoutPrFixPrefix, "pr_fix", "pr-fix-"),
    "除去後も当該節の本文に接頭辞があると判定された",
  );
});

// 消すのは当該 H3 の行だけにする。接頭辞は verifier.md の他の節の本文にも出るので、
// 全文から消すと、見出しではなくファイル全体を見る実装まで通ってしまう。
function verifierWithoutHeadingPrefix(phase: string, prefix: string): string {
  const heading = onlyHeadingFor(verifierMd, phase, verifierGateHeadingsFor);
  return replaceInLineRange(
    verifierMd,
    heading.line,
    heading.line,
    new RegExp(prefix, "g"),
    "成果物-",
  );
}

const verifierWithoutPrFixHeadingPrefix = verifierWithoutHeadingPrefix(
  "pr_fix",
  "pr-fix-",
);
const verifierWithoutRebaseFixHeadingPrefix = verifierWithoutHeadingPrefix(
  "rebase_fix",
  "rebase-fix-",
);

Deno.test("B13 verifier.md (pr_fix の H3 見出しからのみ接頭辞を除去) への回帰注入が効いている", () => {
  assertOk(
    verifierWithoutPrFixHeadingPrefix !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
  assertOk(
    containsFixed(verifierWithoutPrFixHeadingPrefix, "pr-fix-"),
    "他の節の本文の出現まで消えている — 見出しスコープの検出力が落ちる注入になっている",
  );
});

Deno.test("B14 verifier.md 側 (pr_fix) の接頭辞欠落を A8 相当のチェックで検知できる", () => {
  assertOk(
    !verifierHeadingMentions(
      verifierWithoutPrFixHeadingPrefix,
      "pr_fix",
      "pr-fix-",
    ),
    "除去後も当該 H3 見出しに接頭辞があると判定された",
  );
});

Deno.test("B15 verifier.md (rebase_fix の H3 見出しからの除去) への回帰注入が効き、A8 相当が検知する", () => {
  assertOk(
    verifierWithoutRebaseFixHeadingPrefix !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
  assertOk(
    !verifierHeadingMentions(
      verifierWithoutRebaseFixHeadingPrefix,
      "rebase_fix",
      "rebase-fix-",
    ),
    "除去後も当該 H3 見出しに接頭辞があると判定された",
  );
});

const gateSectionHeading = markdownHeadings(verifierMd).find(
  (h) => h.level === 2 && h.text.includes(GATE_SECTION_HEADING),
);
if (gateSectionHeading === undefined) {
  throw new Error(`verifier.md に "${GATE_SECTION_HEADING}" の H2 が無い`);
}
const ungatedSample = ungatedPhases[0];
const verifierWithUngatedSection = insertAfterLine(
  verifierMd,
  gateSectionHeading.line,
  `\n### ${ungatedSample} (\`${ungatedSample}.md\`)\n\n- 注入されたダミー節。`,
);

Deno.test("B16 verifier.md (ゲート無しフェーズの節を挿入) への回帰注入が効いている", () => {
  assertOk(
    verifierWithUngatedSection !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B17 ゲートを持たないフェーズの合格条件節を A6 相当のチェックで検知できる", () => {
  const found = verifierGateHeadingsFor(
    verifierWithUngatedSection,
    ungatedSample,
  );
  assertOk(found.length === 1, `検知できない: ${describe(found)}`);
});

const executorWithDuplicateReport =
  `${executorMd}\n\n### report → \`<run dir>/report.md\` (複製)\n`;
const verifierWithDuplicateReport = insertAfterLine(
  verifierMd,
  gateSectionHeading.line,
  "\n### report (`report.md`) (複製)\n\n- 注入されたダミー節。",
);

Deno.test("B18 executor.md (同じフェーズの見出しを 2 本にする) への回帰注入が効いている", () => {
  assertOk(
    executorWithDuplicateReport !== executorMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B19 executor.md の重複見出しを A7 相当の「ちょうど 1 本」で検知できる", () => {
  const found = executorHeadingsFor(executorWithDuplicateReport, "report");
  assertOk(found.length === 2, `2 本として数えられない: ${describe(found)}`);
});

Deno.test("B20 verifier.md (同じフェーズの H3 を 2 本にする) への回帰注入が効いている", () => {
  assertOk(
    verifierWithDuplicateReport !== verifierMd,
    "置換が効かず元テキストと同一になった",
  );
});

Deno.test("B21 verifier.md の重複 H3 を A4 相当の「ちょうど 1 本」で検知できる", () => {
  const found = verifierGateHeadingsFor(verifierWithDuplicateReport, "report");
  assertOk(found.length === 2, `2 本として数えられない: ${describe(found)}`);
});
