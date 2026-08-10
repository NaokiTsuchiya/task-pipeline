// tests/metrics-reference-alignment.test.ts — 追跡下 Markdown から `docs/metrics/` 配下の
// **日付ファイル** (`docs/metrics/YYYY-MM-DD.md`) への参照が消えていることを固定する (gh-62)。
//
//   deno test --allow-read tests/metrics-reference-alignment.test.ts
//   deno task test                                                    # 自動検出でも走る
//
// 背景: `docs/metrics/` は .gitignore 対象で clone した側には存在しない。追跡下のファイルが
// 特定の日付ファイルを数字の根拠として引用すると、その引用は辿れなくなる (引用切れ)。
// 人が選んで `docs/history/metrics/` へ昇格させた写しを指すよう書き直すのが gh-62 の対応で、
// このテストは「昇格し忘れ・書き直し忘れ」を機械で検知する。
//
// - ディレクトリとしての `docs/metrics/` への言及 (書き込み先の仕様説明) は対象外 — 実際に
//   `references/retro.md` / `playbooks/retro-launch.md` / `docs/history/backlog/retro-loop-connection.md`
//   に現存し、意図して残す記述である。日付ファイル名 (`YYYY-MM-DD.md`、ゼロ埋め) と一致する文字列が
//   後続するときだけ違反として拾う。
// - 外部依存ゼロ・ネットワーク不要 (git 等の外部コマンドは呼ばない)。対象ファイルは
//   `Deno.readDirSync` で repo root から再帰的に集める。除外ディレクトリは `.gitignore` /
//   `deno.json` の exclude と同じ一覧。
// - ケース A: 現状の追跡下 Markdown 全体に違反が 0 件であることの検証。
// - ケース B: 実際に読み込んだファイルのテキストをメモリ上で複製し、行を追記する形で回帰を
//   注入する (`phase-set-doc-alignment.test.ts` の B 群と同じ形)。日付ファイル参照の注入は
//   検出件数を増やし、ディレクトリ言及の注入は増やさないことを確認する。

import { assertOk } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);

/** `.gitignore` / `deno.json` の `exclude` と同じ一覧 (名前一致で任意の深さを除外)。 */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".claude",
  ".task-pipeline",
  ".task-prep",
  ".task-scout",
  "node_modules",
  "__pycache__",
]);

interface MarkdownFile {
  readonly path: string;
  readonly text: string;
}

/** `relPath` (repo root からの相対パス、`/` 区切り) が走査対象から外れているか。 */
function isExcluded(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => EXCLUDED_DIR_NAMES.has(p))) return true;
  // docs/metrics/ 自体は .gitignore 対象 (未追跡) — 通常は disk 上に存在しないが、
  // 存在する環境で誤って「追跡下」扱いしないよう明示的に除外する。
  if (relPath === "docs/metrics" || relPath.startsWith("docs/metrics/")) {
    return true;
  }
  return false;
}

function collectMarkdownFiles(
  dir: URL,
  relPath: string,
  out: MarkdownFile[],
): void {
  for (const entry of Deno.readDirSync(dir)) {
    const entryRel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
    if (isExcluded(entryRel)) continue;
    if (entry.isDirectory) {
      const entryUrl = new URL(`${entry.name}/`, dir);
      collectMarkdownFiles(entryUrl, entryRel, out);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      const entryUrl = new URL(entry.name, dir);
      out.push({ path: entryRel, text: Deno.readTextFileSync(entryUrl) });
    }
  }
}

/** `docs/metrics/YYYY-MM-DD.md` (ゼロ埋め4-2-2桁の日付ファイル名) への参照。 */
const DATE_FILE_REFERENCE = /docs\/metrics\/\d{4}-\d{2}-\d{2}\.md/;

interface Reference {
  readonly path: string;
  readonly line: number;
  readonly match: string;
}

/** 各ファイルの各行を走査し、日付ファイル参照をすべて集める。 */
function findDateFileReferences(files: readonly MarkdownFile[]): Reference[] {
  const found: Reference[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const matched = DATE_FILE_REFERENCE.exec(lines[i]);
      if (matched !== null) {
        found.push({ path: file.path, line: i + 1, match: matched[0] });
      }
    }
  }
  return found;
}

function describe(refs: readonly Reference[]): string {
  return refs.length === 0
    ? "(無し)"
    : refs.map((r) => `${r.path}:${r.line} "${r.match}"`).join(" | ");
}

const allFiles: MarkdownFile[] = [];
collectMarkdownFiles(REPO_ROOT, "", allFiles);
const baseline = findDateFileReferences(allFiles);

Deno.test("A0 repo root から Markdown ファイルを収集できる", () => {
  assertOk(allFiles.length > 0, "Markdown が1件も見つからない");
});

Deno.test("A1 収集した Markdown に docs/history/metrics/ 自身が現れる (走査対象からの除外漏れが無い)", () => {
  assertOk(
    allFiles.some((f) => f.path.startsWith("docs/history/metrics/")),
    "docs/history/metrics/ 配下が収集されていない — 除外リストが広すぎる",
  );
});

Deno.test("A2 追跡下 Markdown に docs/metrics/ 配下の日付ファイルへの参照が無い", () => {
  assertOk(
    baseline.length === 0,
    `日付ファイルへの参照が残っている: ${describe(baseline)}`,
  );
});

// --- ケース B: 実ファイルのテキストを複製し、行を追記する形で回帰を注入する ---

const TARGET_PATH = "docs/history/backlog/retro-loop-connection.md";
const targetIndex = allFiles.findIndex((f) => f.path === TARGET_PATH);

Deno.test("B0 回帰注入の対象ファイルが実在する", () => {
  assertOk(targetIndex !== -1, `${TARGET_PATH} が収集結果に無い`);
});

function withAppendedLine(index: number, line: string): MarkdownFile[] {
  return allFiles.map((f, i) =>
    i === index ? { path: f.path, text: `${f.text}\n${line}` } : f
  );
}

// R1: 実際に問題になっていた表記そのもの (実在の引用切れ行と同じ書式)。
const injectedR1 = withAppendedLine(
  targetIndex,
  "回帰注入 (テスト用): `docs/metrics/2026-08-05.md` を参照。",
);

Deno.test("B1 回帰注入 (実表記の日付ファイル参照) が複製に効いている", () => {
  assertOk(
    injectedR1[targetIndex].text !== allFiles[targetIndex].text,
    "追記で複製が変わらなかった",
  );
});

Deno.test("B2 実表記の日付ファイル参照の注入を検知できる", () => {
  const found = findDateFileReferences(injectedR1);
  assertOk(
    found.length === baseline.length + 1,
    `検知件数が想定と違う: ${found.length} vs ${baseline.length + 1} — ${
      describe(found)
    }`,
  );
});

// R2: 決め打ちの1日付だけを拾う実装・ファイル冒頭行しか見ない実装の両方を検出する
// (追記なので既存ファイルの最終行より後になり、かつ実在しない日付を使う)。
const injectedR2 = withAppendedLine(
  targetIndex,
  "回帰注入 (テスト用): docs/metrics/2099-01-01.md に別の日付の記録がある。",
);

Deno.test("B3 別日付・ファイル末尾への注入を検知できる (決め打ち日付/先頭行だけを見る実装を検出)", () => {
  const found = findDateFileReferences(injectedR2);
  assertOk(
    found.length === baseline.length + 1,
    `検知件数が想定と違う: ${found.length} vs ${baseline.length + 1} — ${
      describe(found)
    }`,
  );
});

// C1: ディレクトリ言及 (実在する retro-loop-connection.md 自身の記法: 末尾スラッシュ + 和文)。
// 「docs/metrics/ という接頭辞さえあれば拾う」実装 (日付部分を見ない実装) を検出する。
const injectedC1 = withAppendedLine(
  targetIndex,
  "回帰注入 (テスト用): `docs/metrics/` 配下のファイルは対象外。",
);

Deno.test("C1 ディレクトリ言及 (末尾スラッシュ + 和文) を追記しても検知件数が変わらない", () => {
  const found = findDateFileReferences(injectedC1);
  assertOk(
    found.length === baseline.length,
    `誤検知した: ${found.length} vs baseline ${baseline.length} — ${
      describe(found)
    }`,
  );
});

// C2: ディレクトリ言及・末尾スラッシュ無し (実在する retro-launch.md の記法:
// シェル変数展開内の `$proj/docs/metrics`)。末尾スラッシュの有無に依存する実装漏れを検出する。
const injectedC2 = withAppendedLine(
  targetIndex,
  '回帰注入 (テスト用): find "$proj/docs/metrics" のように参照する。',
);

Deno.test("C2 ディレクトリ言及 (末尾スラッシュ無し) を追記しても検知件数が変わらない", () => {
  const found = findDateFileReferences(injectedC2);
  assertOk(
    found.length === baseline.length,
    `誤検知した: ${found.length} vs baseline ${baseline.length} — ${
      describe(found)
    }`,
  );
});

// C3: プレースホルダの日付表記 (実在する retro.md の記法)。数字判定を緩めて
// `\d` → `\S` (任意の非空白文字) にする変異を検出する — プレースホルダ内の
// "YYYY-MM-DD" がハイフン区切り4-2-2の形をしているため、\S 緩和だと誤検出される。
const injectedC3 = withAppendedLine(
  targetIndex,
  "回帰注入 (テスト用): `<project root>/docs/metrics/<UTC 日付 YYYY-MM-DD>.md` に書く。",
);

Deno.test("C3 プレースホルダの日付表記を追記しても検知件数が変わらない", () => {
  const found = findDateFileReferences(injectedC3);
  assertOk(
    found.length === baseline.length,
    `誤検知した: ${found.length} vs baseline ${baseline.length} — ${
      describe(found)
    }`,
  );
});
