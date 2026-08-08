// task-pipeline/scripts/state-verdict-path.ts
//
// 読み取り専用 verb `verdict-path` の**導出本体**。
//
// 検証ゲートを起動する直前に「判定 JSON をどのパスへ書かせるか」を決める。v1 まで
// SKILL.md の散文 (「`runs/<id>/verdicts/<phase>-<attempt>.json` を組み立てる。`pr_fix` の
// ときは findings の連番を、`rebase_fix` のときは `rebase-fix-<n>.md` の連番を挟む」) に
// しか無かった規則で、毎イテレーション、オーケストレータの即興に委ねられていた。
// **ここが唯一の所在**であり、SKILL.md には組み立て規則を置かない (`next` verb と同じ形)。
//
// 連番の出所がフェーズで分かれることが、この導出の唯一の非自明な点である:
//
//   - `pr_fix`     … `asks.fix.findings` の basename。findings ファイルは
//                     `<run dir>/watch/<連番>.md` (references/pr-watcher.md) で、executor は
//                     成果物を `<run dir>/pr-fix-<findings と同じ連番>.md` に書く
//                     (references/executor.md)。よって state だけで決まる。
//   - `rebase_fix` … run dir の `rebase-fix-<n>.md` の最大。連番の定義そのものが
//                     「run dir の既存 `rebase-fix-*.md` から決める」(references/executor.md)
//                     であり、state には材料が無い — finalize からの迂回では `asks.rebase`
//                     自体が書かれないためである (SKILL.md の「finalize から入る経路」)。
//
// **`rebase_fix` で `findings` を見てはならない。** 迂回 (入口 b) は `run.phase` だけを
// `rebase_fix` に動かし `asks` に触れないので、`asks.fix` は `taken: true` のまま findings を
// 保持している。「連番を要するフェーズなら findings → run dir → 既定 1 の共通連鎖を回す」
// 実装にすると、この経路でだけ pr_fix 側の連番を拾い、別サイクルの判定を上書きしうる。
// 下の deriveVerdictPath はこの分岐を明示的に書いている (state-verdict-path.test.ts の
// T-VP-cross-* が固定する)。
//
// - Deno API を呼ばない純粋関数群。run dir の中身は呼び出し元が列挙して渡す。
// - 何も書かない。lock も取らない (読み取り専用 verb の扱いは get / validate / next と同じ)。
//
// テスト: state-verdict-path.test.ts (直接importで検査)。実行は deno task test
// (リポジトリルートの deno.json が *.test.ts を自動検出する)。
// CLI 経路 (`state.ts verdict-path`) の観測は state.test.ts。

import { joinPath } from "./state-io.ts";

// ---------------------------------------------------------------------------
// 語彙
// ---------------------------------------------------------------------------

/** state dir 直下の run dir 置き場 (SKILL.md の `runs/<id>/`)。 */
export const RUNS_DIR = "runs";
/** run dir の中の判定 JSON 置き場。 */
export const VERDICTS_DIR = "verdicts";

/**
 * 連番を要するフェーズと、その連番を run dir から拾うときの成果物の接頭辞。
 * **キーであることは「findings を見てよい」を意味しない** (冒頭の注記)。
 */
export const SEQUENCED_PHASE_ARTIFACT = {
  pr_fix: "pr-fix-",
  rebase_fix: "rebase-fix-",
} as const;

export type SequencedPhase = keyof typeof SEQUENCED_PHASE_ARTIFACT;

/** 連番の出所。`null` は連番を要さないフェーズ。 */
export type SeqSource = "findings" | "run-dir" | "default" | null;

/** 連番は 1 始まりである (findings ファイルは既存を数えて次の番号を採る)。 */
export const FIRST_SEQ = 1;

export interface VerdictPathInput {
  /** `--state-dir` に渡された値。正規化はしない (返すパスはこれを前置しただけの形)。 */
  readonly stateDir: string;
  readonly id: string;
  /** `run.phase`。検証ゲートを持つフェーズであることは呼び出し元が確かめる。 */
  readonly phase: string;
  /** `run.attempts` (0 始まり)。 */
  readonly attempt: number;
  /** `asks.fix.findings`。**`pr_fix` のときだけ参照される。** */
  readonly findings: string | null;
  /** `runs/<id>/` 直下のファイル名 (ディレクトリは含めない)。無ければ空配列。 */
  readonly runDirEntries: readonly string[];
}

export interface VerdictPathDerivation {
  readonly phase: string;
  readonly attempt: number;
  readonly seq: number | null;
  readonly seq_source: SeqSource;
  readonly run_dir: string;
  readonly file: string;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// 小さな導出
// ---------------------------------------------------------------------------

/** `<state dir>/runs/<id>`。 */
export function runDirOf(stateDir: string, id: string): string {
  return joinPath(joinPath(stateDir, RUNS_DIR), id);
}

// basename は state-io.ts の basenameOf と同じ意味論だが、ここは純粋層なので
// 依存を joinPath 1 つに留め、末尾スラッシュの無いファイル名だけを相手にする。
function baseNameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// `<数字>` を安全に読む。先頭ゼロ (`01`) も 10 進として読むが、範囲外・非数字は null。
function parseSeqDigits(digits: string): number | null {
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < FIRST_SEQ) return null;
  return value;
}

/**
 * findings のパス (`<run dir>/watch/<連番>.md`) から連番を読む。
 * 取れなければ null (呼び出し側が run dir へ落ちる)。
 */
export function parseFindingsSeq(findings: string | null): number | null {
  if (findings === null || findings === "") return null;
  const base = baseNameOf(findings);
  const m = /^(\d+)\.md$/.exec(base);
  return m === null ? null : parseSeqDigits(m[1]);
}

/**
 * run dir の中の `<prefix><n>.md` の**数値としての**最大。1 件も無ければ null。
 *
 * 文字列比較にすると `rebase-fix-10.md` より `rebase-fix-2.md` が勝ってしまい、
 * 2 桁目以降のサイクルで前サイクルの判定を上書きする。
 */
export function maxArtifactSeq(
  entries: readonly string[],
  prefix: string,
): number | null {
  let max: number | null = null;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const rest = entry.slice(prefix.length);
    if (!rest.endsWith(".md")) continue;
    const seq = parseSeqDigits(rest.slice(0, -".md".length));
    if (seq === null) continue;
    if (max === null || seq > max) max = seq;
  }
  return max;
}

function isSequencedPhase(phase: string): phase is SequencedPhase {
  return Object.hasOwn(SEQUENCED_PHASE_ARTIFACT, phase);
}

// 連番と、それをどこから採ったか。**pr_fix だけが findings を見る** (冒頭の注記)。
function seqOf(
  phase: SequencedPhase,
  input: VerdictPathInput,
): { seq: number; source: Exclude<SeqSource, null> } {
  if (phase === "pr_fix") {
    const fromFindings = parseFindingsSeq(input.findings);
    if (fromFindings !== null) return { seq: fromFindings, source: "findings" };
  }
  const fromRunDir = maxArtifactSeq(
    input.runDirEntries,
    SEQUENCED_PHASE_ARTIFACT[phase],
  );
  if (fromRunDir !== null) return { seq: fromRunDir, source: "run-dir" };
  return { seq: FIRST_SEQ, source: "default" };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * フェーズ・試行回数・(必要なら) サイクルの連番から、判定 JSON の書き込み先を決める。
 * **何も読まない・書かない純関数**である。
 */
export function deriveVerdictPath(
  input: VerdictPathInput,
): VerdictPathDerivation {
  const runDir = runDirOf(input.stateDir, input.id);
  const { phase, attempt } = input;

  let seq: number | null = null;
  let seqSource: SeqSource = null;
  if (isSequencedPhase(phase)) {
    const resolved = seqOf(phase, input);
    seq = resolved.seq;
    seqSource = resolved.source;
  }

  const file = seq === null
    ? `${phase}-${attempt}.json`
    : `${phase}-${seq}-${attempt}.json`;

  return {
    phase,
    attempt,
    seq,
    seq_source: seqSource,
    run_dir: runDir,
    file,
    path: joinPath(joinPath(runDir, VERDICTS_DIR), file),
  };
}
