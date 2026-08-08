// tests/verifier-verdict-contract-alignment.test.ts — verifier の判定 JSON を
// ファイル経由で受け渡す契約 (verifier-verdict-via-file タスク) が、次の 4 ファイル間で
// 食い違っていないことを固定する:
//   - task-pipeline/references/verifier.md   (verifier が verdict path に書く/最小 JSON を返す)
//   - agents/task-pipeline-verifier.md        (verifier サブエージェント定義)
//   - task-pipeline/SKILL.md                  (オーケストレータ: verdict path を組み立てて渡す)
//   - task-pipeline/references/executor.md    (実行エージェント: FAIL 時に verdict path を読む)
//
//   deno test --allow-read tests/verifier-verdict-contract-alignment.test.ts
//   deno task test                            # 自動検出でも走る
//
// 背景: verdict の reasons/required_fixes はオーケストレータのコンテキストを 2 回
// (verifier の戻り値として、オーケストレータがファイルに書くために) 通っていた。
// verifier が自分で verdict path に書き、戻り値を {phase, verdict}(+declaration) に絞ることで
// 1 往復分を削る。4 ファイルのどれか 1 つだけが旧契約に戻ると、往復が復活するか、
// executor が required_fixes を受け取れなくなる — これを構造的に検知する。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - ケース A: 現状の 4 ファイルが新契約で揃っていることを検証する。
//   A0-A2 は 3 ファイル (verifier.md / agent.md / SKILL.md) が起動時に渡す入力トークンの並び
//   (phase / task / run dir / target project / verdict path) を、行内の出現位置 (index) で
//   揃っている前提で比較する。宣言行そのものが取れないときは必ず失敗させる (早期 return しない)。
//   A3-A6 はファイルごとに旧契約の痕跡が残っていないことを見る。
//   A7 は SKILL.md と executor.md が FAIL 時のメッセージ文言 (パスを渡す形) で揃っていることを見る。
//   A8 は research+plan 統合ゲートの declaration が、最小化された返り値契約にも残っていることを見る。
// - ケース B: 4 ファイルそれぞれについて、**メモリ上の複製** でそのファイルだけを旧契約の該当行に
//   戻し、関連チェックが不一致を検知できることを確認する (`.sh` 版は mktemp サンドボックスへ
//   書き出していたが、注入済みテキストを文字列のまま検査すれば検出力は同じで書き込み権限が要らない)。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  grepOnlyFirst,
  substituteFirstPerLine,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);
const AGENT_MD = new URL("agents/task-pipeline-verifier.md", REPO_ROOT);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const EXECUTOR_MD = new URL("task-pipeline/references/executor.md", REPO_ROOT);

const verifierMd = Deno.readTextFileSync(VERIFIER_MD);
const agentMd = Deno.readTextFileSync(AGENT_MD);
const skillMd = Deno.readTextFileSync(SKILL_MD);
const executorMd = Deno.readTextFileSync(EXECUTOR_MD);

const TOKENS = ["phase", "task", "run dir", "target project", "verdict path"];

/**
 * 行内で各トークンが現れる位置 (1 始まり。awk の index() と同じで、無ければ 0) を取り、
 * phase < task < run dir < target project < verdict path の順で単調増加であることを確認する。
 * 1 つでもトークンが行から消えていれば index が 0 になり、比較が破綻して NG になる。
 */
function checkTokenOrder(line: string): string {
  const p = TOKENS.map((t) => line.indexOf(t) + 1);
  const ordered = p[0] > 0 && p[0] < p[1] && p[1] < p[2] && p[2] < p[3] &&
    p[3] < p[4];
  return ordered
    ? "OK"
    : `NG p1=${p[0]} p2=${p[1]} p3=${p[2]} p4=${p[3]} p5=${p[4]}`;
}

/** 宣言行を 1 行だけ抜き出し、順序を確認する。行が取れなければ「対象行が見つからない」で落とす。 */
function assertTokenOrder(text: string, needle: string): void {
  const line = grepFixedFirstLine(text, needle);
  assertOk(line !== null, "対象行が見つからない");
  const result = checkTokenOrder(line);
  assertOk(result === "OK", `${result} — line=${line}`);
}

Deno.test("A0 verifier.md の入力トークン列 (phase < task < run dir < target project < verdict path)", () => {
  assertTokenOrder(verifierMd, "入力: phase");
});

Deno.test("A1 agent.md の入力トークン列 (phase < task < run dir < target project < verdict path)", () => {
  assertTokenOrder(agentMd, "The launch prompt gives you:");
});

Deno.test("A2 SKILL.md の起動プロンプトの入力トークン列 (phase < task < run dir < target project < verdict path)", () => {
  assertTokenOrder(
    skillMd,
    "phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir:",
  );
});

// --- A3: verifier.md — 返り値が最小 JSON (reasons/required_fixes を含まない) ---------
Deno.test("A3 verifier.md に最小返り値リテラル {phase, verdict} がある", () => {
  assertOk(
    containsFixed(verifierMd, '"phase": "<phase>", "verdict": "PASS"}'),
    "見つからない",
  );
});

Deno.test("A3b verifier.md にファイル書き込み用の full JSON (reasons/required_fixes 付き) が残っている", () => {
  assertOk(
    containsFixed(
      verifierMd,
      '"phase": "<phase>", "verdict": "PASS", "reasons"',
    ),
    "見つからない",
  );
});

// --- A4: agent.md — 最小返り値へ言及し、旧来の無条件 'Return only the verdict JSON.' 単独行になっていない
Deno.test("A4 agent.md が verdict path への書き込みと最小返り値への言及を両方持つ", () => {
  assertOk(
    containsFixed(agentMd, "Write the full verdict JSON to verdict path") &&
      containsFixed(agentMd, "minimal verdict JSON"),
    "見つからない",
  );
});

// --- A5: SKILL.md — PASS 分岐がもう判定 JSON を書く記述を持たない -------------------
Deno.test("A5 SKILL.md の PASS 分岐がオーケストレータによる判定 JSON 書き込みを求めていない", () => {
  assertOk(
    !containsFixed(
      skillMd,
      "判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き",
    ),
    "旧文言が残っている",
  );
});

// --- A6: SKILL.md — FAIL 分岐が required_fixes の中身ではなくパスを送る -------------
Deno.test("A6 SKILL.md の FAIL 分岐が required_fixes の中身ではなくパスを送る", () => {
  assertOk(
    !containsFixed(skillMd, "required_fixes をそのまま送り"),
    "旧文言 (中身をそのまま送る) が残っている",
  );
});

// --- A7: SKILL.md と executor.md — FAIL 時のメッセージ文言が揃っている --------------
// バッククォートで囲んだ絶対パスの実値部分だけがファイルごとに違う (SKILL.md は組み立てた
// 絶対パス、executor.md は受け取ったプレースホルダ) ので、それを剥いだ骨格文字列で比較する。
function stripPlaceholders(s: string): string {
  return s.replace(/`<[^`]*`/g, "<X>").replace(/<[^>]*>/g, "<X>");
}

const SKILL_FAIL_MSG_RE =
  /Fix required\. Read required_fixes from.*and address them in phase[^」"]*/;
const EXECUTOR_FAIL_MSG_RE =
  /Fix required\. Read required_fixes from.*and address them in phase[^」`]*/;

Deno.test("A7 SKILL.md と executor.md の FAIL メッセージ文言が一致", () => {
  const skillRaw = grepOnlyFirst(skillMd, SKILL_FAIL_MSG_RE);
  const executorRaw = grepOnlyFirst(executorMd, EXECUTOR_FAIL_MSG_RE);
  // `.sh` は分岐ごとにラベルを変えていた。Deno.test 名は固定なので、どの分岐で落ちたかは
  // 失敗メッセージの先頭で見分けられるようにしておく。
  assertOk(
    skillRaw !== null && skillRaw !== "",
    "SKILL.md に FAIL 時のメッセージ文言がある — 抽出できない",
  );
  assertOk(
    executorRaw !== null && executorRaw !== "",
    "executor.md に FAIL 時のメッセージ文言がある — 抽出できない",
  );
  const skillFailMsg = stripPlaceholders(skillRaw);
  const executorFailMsg = stripPlaceholders(executorRaw);
  assertOk(
    skillFailMsg === executorFailMsg,
    `skill=${skillFailMsg} executor=${executorFailMsg}`,
  );
});

// --- A8: verifier.md — research+plan の declaration が最小返り値契約にも残っている ---
// 「返り値にも `"declaration"」という語彙は、既存の「判定 JSON (ファイル) には declaration を
// 含める」という記述 (research+plan 節) とは別の文で、返り値契約側の記述として一意に識別できる。
Deno.test("A8 verifier.md の最小返り値契約に declaration (research+plan のみ) が明記されている", () => {
  assertOk(
    containsFixed(verifierMd, '返り値にも `"declaration"'),
    "見つからない",
  );
});

// --- ケース B: 退行検知 — 4 ファイルそれぞれを単独で旧契約に戻すと検知できること -----
// B0: verifier.md の返り値を旧 full JSON に戻す (最小 JSON リテラルを消す)
const b0Regressed = substituteFirstPerLine(
  verifierMd,
  /\{"phase": "<phase>", "verdict": "PASS"\}/,
  '{"phase": "<phase>", "verdict": "PASS", "reasons": ["..."], "required_fixes": []}',
);

Deno.test("B0 verifier.md への回帰注入が効いている", () => {
  assertOk(b0Regressed !== verifierMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B1 verifier.md の退行 (最小 JSON 消失) を A3 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b0Regressed, '"phase": "<phase>", "verdict": "PASS"}'),
    "退行後も最小 JSON リテラルが残っていた",
  );
});

// B2: agent.md を旧契約 (verdict path への言及なし) に戻す
const b2Regressed = substituteFirstPerLine(
  substituteFirstPerLine(
    agentMd,
    /^The launch prompt gives you: phase \/ task file \/ run dir \/ target project \/ verdict path\.$/,
    "The launch prompt gives you: phase / task file / run dir / target project.",
  ),
  /^Write the full verdict JSON to verdict path \(you have Bash but no Write tool\), then return only the minimal verdict JSON\.$/,
  "Return only the verdict JSON.",
);

Deno.test("B2 agent.md への回帰注入が効いている", () => {
  assertOk(b2Regressed !== agentMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B3 agent.md の退行 (verdict path 言及の消失) を A4 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(
      b2Regressed,
      "Write the full verdict JSON to verdict path",
    ) &&
      !containsFixed(b2Regressed, "minimal verdict JSON"),
    "退行後も新契約の文言が残っていた",
  );
});

// B4: SKILL.md の PASS 分岐を旧文言 (オーケストレータが判定 JSON を書く) に戻す
const b4Regressed = substituteFirstPerLine(
  skillMd,
  /\(判定 JSON は verifier が起動時に渡した verdict path へ既に書いている — オーケストレータは書かない\) `state\.ts advance/,
  "判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き、`state.ts advance",
);

Deno.test("B4 SKILL.md への回帰注入が効いている", () => {
  assertOk(b4Regressed !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B5 SKILL.md の退行 (PASS 分岐が判定 JSON を書く記述に戻る) を A5 相当のチェックで検知できる", () => {
  assertOk(
    containsFixed(
      b4Regressed,
      "判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き",
    ),
    "退行注入後も旧文言が見つからなかった",
  );
});

// B6: executor.md の修正指示メッセージを旧契約 (パスではなく中身をそのまま扱う) に戻す
const b6Regressed = substituteFirstPerLine(
  executorMd,
  // 先頭の 2 スペースは `{2}` で書く (連続スペースの直書きは deno lint の no-regex-spaces に触れる)。
  /^ {2}2\. `Fix required\. Read required_fixes from <verdict path> and address them in phase <phase>\.` \(修正指示\) → `<verdict path>` を読み、そこに書かれた判定 JSON の `required_fixes` を、同じフェーズの成果物と \(implement \/ pr_fix なら\) 実装に反映して修正し、同じ形式で停止する。$/,
  "  2. 修正指示 (required_fixes) → 同じフェーズの成果物と (implement / pr_fix なら) 実装を修正し、同じ形式で停止する。",
);

Deno.test("B6 executor.md への回帰注入が効いている", () => {
  assertOk(b6Regressed !== executorMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B7 executor.md の退行 (パスから読む手順の消失) を A7 相当のチェックで検知できる", () => {
  const b6Msg = grepOnlyFirst(b6Regressed, EXECUTOR_FAIL_MSG_RE);
  assertOk(
    b6Msg === null || b6Msg === "",
    "退行注入後もメッセージ文言が抽出できてしまった",
  );
});

// B8: verifier.md の declaration 継承の一文だけを削る
const b8Regressed = substituteFirstPerLine(
  verifierMd,
  /^phase が `research\+plan` のときだけ、返り値にも `"declaration": "upheld" \| "overturned"` を加える \(オーケストレータが history に記録するため\)。$/,
  "",
);

Deno.test("B8a verifier.md (declaration 文) への回帰注入が効いている", () => {
  assertOk(b8Regressed !== verifierMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B8b verifier.md の退行 (declaration 文の消失) を A8 相当のチェックで検知できる", () => {
  assertOk(
    !containsFixed(b8Regressed, '返り値にも `"declaration"'),
    "退行後も declaration 言及が残っていた",
  );
});
