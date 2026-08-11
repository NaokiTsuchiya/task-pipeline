// tests/state-cli-boundary.test.ts — 手順書 (task-pipeline/SKILL.md + task-pipeline/playbooks/*.md)
// が、docs/state-cli-contract.md が既に持つ CLI 内部定数を数値として再掲していないことを固定する
// (gh-59 の受け入れ条件 1・2・5・7)。
//
//   deno test --allow-read tests/state-cli-boundary.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: 手順書は CLI 契約の内容 (heartbeat の 90 分/1440 分、retire が掃除する completed の
// 24 時間など) を数値として再掲していた箇所があり、片方だけが更新されて静かにずれていた
// (gh-59)。契約側に新設した `## SKILL.md との所有境界 (gh-59)` 節が「CLI 所有と決めた定数」を
// 表で列挙しており、このテストはその表を正規表現ソースとして読み、手順書側のテキストにその
// 表記が現れないことを機械照合する。表をハードコードせず契約から読むので、表の追加・変更に
// テストが自動で追従する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - 「手順書」の範囲は SKILL.md 自身の定義 (`playbooks/` 配下 = オーケストレーターが読む手順書)
//   に従い、`task-pipeline/SKILL.md` と `task-pipeline/playbooks/*.md` に限る。
//   `references/*.md` (サブエージェント向け指示ファイル) と `docs/*.md` (契約・設計文書) は
//   対象外 — 契約自身が同じ表記を持つのは重複ではなく定義そのものなので、そちらは対象にしない。
// - ケース A: 契約の表から抽出した各パターンが、実物の手順書テキストに現れないことの検証。
// - ケース B: メモリ上の複製に該当パターンの表記を書き戻す回帰注入が、A 相当のチェックで
//   検知できることの確認。`1440 分` はスペース有り・無しの両方の表記が実在した経緯があるため
//   (research: SKILL.md はスペース有り、playbooks/max-tasks.md はスペース無しで重複していた)、
//   この定数だけ両方の表記を回帰ケースにする。
// - ケース P: 手順書所有の数値 (ScheduleWakeup の秒数・検証リトライ上限・rebase タイムアウト・
//   PR 観測タイムアウト) が実物のテキストに残っていて、かつ A 群のチェックが誤検知しないこと
//   (受け入れ条件 7)。

import { assertOk, containsFixed } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const CONTRACT_MD = new URL(
  "task-pipeline/docs/state-cli-contract.md",
  REPO_ROOT,
);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOKS_DIR = new URL("task-pipeline/playbooks/", REPO_ROOT);

const contractText = Deno.readTextFileSync(CONTRACT_MD);
const skillText = Deno.readTextFileSync(SKILL_MD);

/** `task-pipeline/playbooks/*.md` を列挙し、ファイル名昇順で連結する (走査順を決定的にする)。 */
function readPlaybooksText(): string {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(PLAYBOOKS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) names.push(entry.name);
  }
  names.sort();
  return names
    .map((name) => Deno.readTextFileSync(new URL(name, PLAYBOOKS_DIR)))
    .join("\n");
}

const playbooksText = readPlaybooksText();
/** 「手順書」= SKILL.md + playbooks/*.md の全文 (references/*.md・docs/*.md は含めない)。 */
const proceduresText = `${skillText}\n${playbooksText}`;

interface OwnedConstant {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * 契約の `## SKILL.md との所有境界 (gh-59)` 節にある Markdown 表から、
 * `| 定数 | 照合パターン | 契約側の定義 |` の各行を読み、2 列目の `` `/…/` `` (正規表現ソース) を
 * 抽出する。表をハードコードしない — 表が変われば抽出結果もテストの機械照合の起点も追従する。
 */
function extractOwnedConstants(text: string): OwnedConstant[] {
  const headingIdx = text.indexOf("## SKILL.md との所有境界 (gh-59)");
  if (headingIdx === -1) {
    throw new Error(
      "契約に「## SKILL.md との所有境界 (gh-59)」の見出しが無い",
    );
  }
  const section = text.slice(headingIdx);
  const constants: OwnedConstant[] = [];
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) =>
      c.length > 0
    );
    if (cells.length < 2) continue;
    const patternMatch = /^`\/(.+)\/`$/.exec(cells[1]);
    if (patternMatch === null) continue; // ヘッダ行・区切り行はここで弾かれる
    constants.push({ label: cells[0], pattern: new RegExp(patternMatch[1]) });
  }
  if (constants.length === 0) {
    throw new Error("所有境界の表から定数を1件も抽出できない");
  }
  return constants;
}

const ownedConstants = extractOwnedConstants(contractText);

Deno.test("A0 所有境界の表から CLI 所有定数を抽出できる (4件)", () => {
  assertOk(
    ownedConstants.length === 4,
    `想定と件数が違う: ${ownedConstants.length} 件 (${
      ownedConstants.map((c) => c.label).join(", ")
    })`,
  );
});

Deno.test("A0b 抽出した照合パターンのソースが想定どおり (\\s? で空白の有無を許容する)", () => {
  const sources = ownedConstants.map((c) => c.pattern.source).sort();
  const expected = ["90\\s?分", "1440\\s?分", "24\\s?時間", "7\\s?時間"]
    .sort();
  assertOk(
    JSON.stringify(sources) === JSON.stringify(expected),
    `sources=${JSON.stringify(sources)} expected=${JSON.stringify(expected)}`,
  );
});

for (const constant of ownedConstants) {
  Deno.test(
    `A1 [${constant.label}] の照合パターン ${constant.pattern.source} が手順書側に現れない`,
    () => {
      assertOk(
        !constant.pattern.test(proceduresText),
        `手順書 (SKILL.md + playbooks/*.md) に "${constant.pattern.source}" に一致する再掲がある`,
      );
    },
  );
}

// ---- ケース B: 回帰注入 ----

function findConstant(labelSubstring: string): OwnedConstant {
  const found = ownedConstants.find((c) => c.label.includes(labelSubstring));
  if (found === undefined) {
    throw new Error(`定数が見つからない: ${labelSubstring}`);
  }
  return found;
}

const heartbeatAlive = findConstant("生存判定");
const heartbeatSweep = findConstant("掃除閾値");
const retireRetention = findConstant("completed 保持期間");
const probeLease = findConstant("probe リース失効");

const B_INJECTION_CASES: readonly [string, OwnedConstant, string][] = [
  [
    "B1",
    heartbeatAlive,
    "heartbeat は 90 分 で判定する (回帰注入テスト用の文)",
  ],
  [
    "B2",
    heartbeatSweep,
    "heartbeat は 1440 分 で掃除する (回帰注入テスト用の文)",
  ],
  [
    "B2c",
    heartbeatSweep,
    "heartbeatは1440分で掃除する(スペース無し表記の回帰注入テスト用の文)",
  ],
  [
    "B3",
    retireRetention,
    "completed の控えは 24 時間 で掃除する (回帰注入テスト用の文)",
  ],
  [
    "B4",
    probeLease,
    "probe リースは 7 時間 で失効する (回帰注入テスト用の文)",
  ],
];

for (const [id, constant, injected] of B_INJECTION_CASES) {
  Deno.test(
    `${id} [${constant.label}] への回帰注入 (メモリ上の複製に表記を書き戻す) が効いている`,
    () => {
      const mutated = `${proceduresText}\n${injected}\n`;
      assertOk(
        mutated !== proceduresText,
        "注入が効かず元テキストと同一になった",
      );
    },
  );

  Deno.test(
    `${id}b [${constant.label}] の回帰 (再掲の書き戻し) を A1 相当のチェックで検知できる`,
    () => {
      const mutated = `${proceduresText}\n${injected}\n`;
      assertOk(
        constant.pattern.test(mutated),
        `注入した表記 "${injected}" をパターン ${constant.pattern.source} が検知できない`,
      );
    },
  );
}

// ---- ケース P: 手順書所有の保護 (受け入れ条件 7) ----

const PROTECTED_PHRASES: readonly string[] = [
  "ScheduleWakeup 60 秒",
  "ScheduleWakeup 1800 秒",
  "ScheduleWakeup (3600 秒",
  "最大 3 回",
  "タイムアウト 120 秒",
  "6 時間",
];

for (const phrase of PROTECTED_PHRASES) {
  Deno.test(`P1 手順書所有の表記 "${phrase}" が実物の手順書に残っている`, () => {
    assertOk(
      containsFixed(proceduresText, phrase),
      `見つからない — 手順書所有の記述を誤って削っていないか確認する`,
    );
  });
}

Deno.test("P2 手順書所有の保護フレーズが揃った実物テキストで、CLI 所有パターンが1件も誤検知しない", () => {
  for (const phrase of PROTECTED_PHRASES) {
    assertOk(
      containsFixed(proceduresText, phrase),
      `前提が崩れている (P1で検知すべき): ${phrase}`,
    );
  }
  for (const constant of ownedConstants) {
    assertOk(
      !constant.pattern.test(proceduresText),
      `手順書所有の保護フレーズが揃った状態で "${constant.pattern.source}" が誤検知した`,
    );
  }
});
