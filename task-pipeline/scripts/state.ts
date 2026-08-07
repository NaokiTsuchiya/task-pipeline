// task-pipeline/scripts/state.ts
//
// state.json への読み書きを、排他 (lock) / 原子的書き込み (tmp+rename) / heartbeat /
// スキーマ検証込みで CLI に閉じ込める。オーケストレーター (モデル) はこの CLI を呼ぶだけで、
// state.json の書き込み手順 (task-pipeline/SKILL.md の「state.json の書き込み手順 (排他)」
// 「セッションの所有権」節) を自分で守らなくてよい。
//
// **この CLI は状態モデル v2 (task-pipeline/docs/state-model-v2-2026-08.md) だけを話す。**
// v1 の語彙 (status / phase / gate をタスク直下に持つ形、review.watch / review.rebase) は
// 受け付けない。schema_version 1 の state.json は `init` が一度だけ移行する (設計3.2節)。
//
// 実行形:
//   deno run --no-prompt \
//     --allow-read=<state dir>[,<git common dir>/info] \
//     --allow-write=<state dir>[,<git common dir>/info] \
//     task-pipeline/scripts/state.ts <verb> --state-dir <dir> [verb固有フラグ...]
//
// verb は 46 個で、出所は 2 つある (どちらにも属さない verb は存在しない):
//   - 遷移 32 verb … state-transitions-v2-spec.ts の VERB_SPEC のキー。queue エントリの
//     領域 P × 領域 A の座標を持ち、from/to が宣言されている。
//   - 帳簿 14 verb … state-ledger-v2.ts の LEDGER_VERBS。座標を持たない
//     (init/get/validate/next/session-touch/sessions-alive/history-append/
//     candidates-*/promoted-*/relisted-*/stalled-set)。
// 契約 (終了コード・JSON出力・verb別引数・前提・不変条件) の詳細は
// task-pipeline/docs/state-cli-contract.md (ALLOWED_FLAGS のキー一覧と見出しの対応を
// state.test.ts の T-D2 が突き合わせている)。
//
// **このファイルはエントリポイントだけを持つ** (終了コード契約・エラー分類・main)。
// 実装は責務ごとに 6 ファイルへ分かれていて、**import 文がそのまま層の宣言**である:
//
//   層 0  state-io.ts        … Deno API (時刻・パス・原子的書き込み・読み取り・lock)
//   層 1  state-flags.ts     … 引数パース (純粋)
//   層 2  state-store.ts     … lock 越しの読み直し・検証・書き込みの glue
//   層 3  state-verbs-ledger.ts / state-verbs-queue.ts … 46 verb の cmd 実装
//   層 4  state-dispatch.ts  … ALLOWED_FLAGS と HANDLERS
//   層 5  このファイル       … 終了コード・エラー分類・main
//
// 依存は上から下への一方向で、逆向きの import は無い (各ファイルの冒頭コメント参照)。
// 起動パスは分割前と同じ `task-pipeline/scripts/state.ts` のままである。
//
// テストの回し方: sh tests/state-cli.test.sh (deno 不在なら SKIP + exit 0)
//   直接実行する場合: deno test --allow-read --allow-write --allow-env --allow-run
//     task-pipeline/scripts/state.test.ts
//
// 実行時の外部依存はゼロ (npm:/jsr: 参照なし)。

import {
  CliErrorV2,
  type ExitCodeName,
  VERB_SPEC,
} from "./state-transitions-v2.ts";
import { parseFlags, requireFlag } from "./state-flags.ts";
import {
  ALLOWED_FLAGS,
  asVerb,
  HANDLERS,
  isAllowedFlag,
  LEDGER_VERBS,
  type Verb,
} from "./state-dispatch.ts";

export { ALLOWED_FLAGS };

// ---------------------------------------------------------------------------
// 終了コード契約 (docs/state-cli-contract.md と state.test.ts の T-D1 で突き合わせる
// ソース・オブ・トゥルース)
// ---------------------------------------------------------------------------

export const EXIT_CODES: Record<ExitCodeName, number> = {
  usage: 10,
  lock: 11,
  schema: 12,
  missing: 13,
  permission: 14,
  // 対象 (queue/candidates/promoted/relisted のエントリ) 自体は存在するが、その verb が
  // 要求する現在のノード (領域 P × 領域 A の座標) やフィールドの前提を満たさない。
  // 「対象が無い」(missing) や「フラグの形状が変」(usage) とは別のビジネスルール違反で、
  // 「前提違反は state を変えずに失敗する」の主対象。
  conflict: 15,
};

// ---------------------------------------------------------------------------
// エラー分類 (main の catch 節がこれで exit code と JSON を決める)
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): { code: ExitCodeName; message: string } | null {
  if (e instanceof CliErrorV2) return { code: e.code, message: e.message };
  if (e instanceof Deno.errors.NotCapable) {
    return { code: "permission", message: e.message };
  }
  if (e instanceof Deno.errors.PermissionDenied) {
    return { code: "permission", message: e.message };
  }
  if (e instanceof Deno.errors.NotFound) {
    return { code: "missing", message: (e as Error).message };
  }
  return null;
}

// ---------------------------------------------------------------------------
// dispatch
//
// ディスパッチ表のキー集合は ALLOWED_FLAGS と一致し、その内訳は VERB_SPEC (遷移 32) と
// LEDGER_VERBS (帳簿 14) で尽きる。どちらにも属さない verb を足すと state.test.ts の
// 分類ネットが落ちる。
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  try {
    const [rawVerb, ...rest] = argv;
    if (!rawVerb) {
      throw new CliErrorV2("usage", "verb is required");
    }
    // argv は未検査の文字列なので、ここで 1 度だけ Verb に絞る (state-dispatch.ts の
    // 「境界」節)。絞った後は表の引き当てに型の逃げ道が要らない。
    const verb = asVerb(rawVerb);
    if (verb === null) {
      throw new CliErrorV2("usage", `unknown verb: ${rawVerb}`);
    }
    const handler = HANDLERS[verb];
    const flags = parseFlags(rest);
    for (const key of flags.keys()) {
      if (!isAllowedFlag(verb, key)) {
        throw new CliErrorV2("usage", `unknown flag for ${verb}: --${key}`);
      }
    }
    const stateDir = requireFlag(flags, "state-dir");

    const result = await handler(stateDir, flags);
    console.log(JSON.stringify(result));
    return 0;
  } catch (e) {
    const classified = classifyError(e);
    if (!classified) throw e;
    console.log(
      JSON.stringify({ error: classified.code, message: classified.message }),
    );
    return EXIT_CODES[classified.code];
  }
}

// ディスパッチ集合が VERB_SPEC ∪ LEDGER_VERBS で尽きることを、型の上でも表明する
// (実行時の検査は state.test.ts の分類ネット)。
export const DISPATCH_VERBS: readonly Verb[] = Object.keys(
  ALLOWED_FLAGS,
) as Verb[];
export const TRANSITION_VERBS: readonly string[] = Object.keys(VERB_SPEC);
export { LEDGER_VERBS };

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
