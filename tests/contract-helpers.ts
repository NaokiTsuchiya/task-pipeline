// tests/contract-helpers.ts — 散文契約テスト (Markdown / スクリプトの記述内容を突き合わせる
// スイート群) が共通で使う「grep 相当」「sed 相当」の文字列関数。
//
// - I/O もパス知識も持たない純粋なテキスト処理だけを置く。対象ファイルの読み出しと
//   パス解決は各 .test.ts が `import.meta.url` 起点で行う。
// - 外部依存ゼロ。`*.test.ts` ではないので `deno test` の収集対象にはならないが、
//   `deno check` / `deno lint` / `deno fmt` の対象にはなる。

/** `grep -qF <needle>` — 固定文字列を含むか。 */
export function containsFixed(text: string, needle: string): boolean {
  return text.includes(needle);
}

/** `grep -F <needle> | head -1` — 固定文字列を含む最初の行 (無ければ null)。 */
export function grepFixedFirstLine(
  text: string,
  needle: string,
): string | null {
  for (const line of text.split("\n")) {
    if (line.includes(needle)) return line;
  }
  return null;
}

/** `grep -n <needle> | head -1 | cut -d: -f1` — 固定文字列を含む最初の行の行番号 (1 始まり、無ければ null)。 */
export function grepLineNumber(text: string, needle: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}

/**
 * `grep -oE <re>` — 行ごとにグローバルマッチし、全マッチを出現順に返す。
 * 1 行に複数マッチがあれば全部拾う (grep -oE と同じ)。
 */
export function grepOnly(text: string, re: RegExp): string[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(new RegExp(re.source, flags))) out.push(m[0]);
  }
  return out;
}

/** `grep -oE <re> | head -1` — 最初のマッチ (無ければ null)。 */
export function grepOnlyFirst(text: string, re: RegExp): string | null {
  const all = grepOnly(text, re);
  return all.length > 0 ? all[0] : null;
}

/**
 * `sed -n '/<start>/,/<end>/p'` — 開始行から終了行までを (両端を含めて) 抜き出す。
 * 終了パターンは開始行の **次** の行から探す (開始行自身では範囲が閉じない)。
 * sed と同じく、範囲が閉じた後にもう一度開始パターンが現れれば次の範囲も拾う。
 */
export function sedRange(text: string, startRe: RegExp, endRe: RegExp): string {
  const out: string[] = [];
  let inRange = false;
  for (const line of text.split("\n")) {
    if (!inRange) {
      if (startRe.test(line)) {
        out.push(line);
        inRange = true;
      }
    } else {
      out.push(line);
      if (endRe.test(line)) inRange = false;
    }
  }
  return out.join("\n");
}

/**
 * `sed -E 's/<re>/<repl>/'` — 行ごとに最初の 1 マッチだけを置換する。
 * 置換文字列は関数リプレーサ経由で渡すので `$&` 等の特殊解釈は起きない (sed と同じ扱い)。
 */
export function substituteFirstPerLine(
  text: string,
  re: RegExp,
  repl: string,
): string {
  const flags = re.flags.replace("g", "");
  return text
    .split("\n")
    .map((line) => line.replace(new RegExp(re.source, flags), () => repl))
    .join("\n");
}

/** `.sh` 版の `ok` / `ng` に相当する分岐。偽なら `.sh` と同じ詳細文字列で失敗させる。 */
export function assertOk(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
