// task-pipeline/scripts/state-dispatch.ts
//
// state CLI の **層 4 — verb 名から実装への表**。受理するフラグの一覧 (ALLOWED_FLAGS) と
// cmd 実装への割り当て (HANDLERS) の 2 つだけを持ち、**この 2 つのキー集合が
// ディスパッチ集合そのもの**である (48 verb = VERB_SPEC 33 + LEDGER_VERBS 15)。
//
// 分けてある理由: verb を 1 つ足す/消すときに触るのがこのファイルだけになり、
// 「フラグ表には有るのに実装が無い」「実装は有るのに契約文書に無い」というずれが
// state.test.ts の T-D2 / T-D6 で必ず落ちる形に閉じる。層の一覧は state-io.ts の冒頭。

import { LEDGER_VERBS, type LedgerVerb } from "./state-ledger-v2.ts";
import type { VerbName } from "./state-transitions-v2.ts";
import {
  cmdCandidatesDrop,
  cmdCandidatesSet,
  cmdGet,
  cmdHistoryAppend,
  cmdInit,
  cmdNext,
  cmdPromotedAdd,
  cmdPromotedDrop,
  cmdRelistedAdd,
  cmdRelistedDrop,
  cmdSessionsAlive,
  cmdSessionTouch,
  cmdStalledSet,
  cmdValidate,
  cmdVerdictPath,
} from "./state-verbs-ledger.ts";
import {
  cmdAdvance,
  cmdAnsweredSet,
  cmdApprove,
  cmdAttentionSet,
  cmdBlock,
  cmdClaim,
  cmdDequeue,
  cmdFixRequest,
  cmdFixRerunMark,
  cmdFixStart,
  cmdMerged,
  cmdObserve,
  cmdPhaseFail,
  cmdProbeExit,
  cmdProbeRun,
  cmdRebaseApplied,
  cmdRebaseForgo,
  cmdRebaseGiveUp,
  cmdRebaseRequest,
  cmdRebaseStart,
  cmdRelease,
  cmdRestore,
  cmdRetire,
  cmdReviewOnly,
  cmdSetExecutor,
  cmdSetGate,
  cmdSetTakeover,
  cmdSetWorktree,
  cmdShip,
  cmdTouchExecutor,
  cmdWithdraw,
  cmdWithdrawAsked,
  cmdWithdrawRemove,
} from "./state-verbs-queue.ts";

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 語彙 — verb 名とフラグ名を string ではなく宣言から導いたリテラルユニオンで持つ
//
// **`Verb` は新しい語彙ではなく、既にある 2 つの宣言の和である**:
// `VerbName` (= VERB_SPEC のキー 33 個) と `LedgerVerb` (= LEDGER_VERBS 13 個)。
// ディスパッチ集合の定義そのものを型にしているので、
//
//   - 下の 2 つの表を `Record<Verb, …>` で受けると、**verb の書き落としも綴り違いも
//     コンパイルエラー**になる (実行時テストを待たない)。
//   - ALLOWED_FLAGS と HANDLERS の**キー集合が一致することが型で保たれる** — 片方にだけ
//     verb を足すと、もう一方が「プロパティが足りない」で落ちる。
//   - VERB_SPEC / LEDGER_VERBS に verb を足すと、この 2 つの表が同時に赤くなる
//     (「宣言だけ足して配線を忘れる」が書けない)。
//
// state.test.ts の T-D2 / T-D6 (契約文書との照合・分類ネット) は引き続き必要である —
// 型が見るのは**このリポジトリのソース同士の一致**で、契約文書との一致は見ないため。
// ---------------------------------------------------------------------------

export type Verb = VerbName | LedgerVerb;

// CLI が受理するフラグ名の全集合。値の集合の要素をこの型に締めることで、フラグ名の
// 綴り違い (`--sesion` 等) もコンパイルエラーになる。
export const FLAG_NAMES = [
  "state-dir",
  "alive",
  "alive-max-min",
  "at",
  "auto",
  "base",
  "blocked-onto",
  "branch",
  "bump",
  "candidates-json",
  "cause",
  "checked-at",
  "ci",
  "cleanup-stale-min",
  "clear",
  "commits",
  "config",
  "drop-withdrawn-branch",
  "errors-inc",
  "errors-reset",
  "executor",
  "expect-attempts",
  "expect-executor",
  "findings",
  "from",
  "from-tip",
  "git-common-dir",
  "head",
  "human",
  "id",
  "ids",
  "items-json",
  "kind",
  "line",
  "lock-max-retries",
  "lock-retry-ms",
  "note",
  "now",
  "phase",
  "proc",
  "reason",
  "ref",
  "report",
  "reset-attempts",
  "resolve",
  "seen-at",
  "session",
  "sig",
  "sig-clear",
  "source",
  "tip",
  "title",
  "to",
  "tracker",
  "value",
  "verifier",
  "worktree",
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

// 書き込み系 verb はすべて --lock-retry-ms/--lock-max-retries を受け付ける。個々の
// エントリでは省略せず明記する — この一覧が state-cli-contract.md との突き合わせテスト
// (T-D2) の一方の入力になるため、実際に受理するフラグと過不足なく一致している必要がある。
const LOCK_FLAGS = [
  "lock-retry-ms",
  "lock-max-retries",
] as const satisfies readonly FlagName[];

// export するのは state.test.ts のドキュメント突き合わせテスト (state-cli-contract.md の
// verb 見出し一覧との差集合チェック) と、分類ネット (どの verb も VERB_SPEC か
// LEDGER_VERBS のどちらかに属する) のため。
export const ALLOWED_FLAGS: Record<Verb, ReadonlySet<FlagName>> = {
  // --- 帳簿系 (LEDGER_VERBS) ---
  "init": new Set([
    "state-dir",
    "tracker",
    "source",
    "git-common-dir",
    "lock-retry-ms",
    "lock-max-retries",
  ]),
  "get": new Set(["state-dir"]),
  "validate": new Set(["state-dir"]),
  // 読み取り専用なので lock フラグを持たない (get / validate / sessions-alive と同じ)。
  "next": new Set(["state-dir", "session", "alive", "now", "config"]),
  // 同じく読み取り専用 (検証ゲートの直前に判定 JSON の書き込み先を問う)。
  "verdict-path": new Set(["state-dir", "id"]),
  "session-touch": new Set(["state-dir", "id", "cleanup-stale-min"]),
  "sessions-alive": new Set(["state-dir", "alive-max-min"]),
  "history-append": new Set([
    "state-dir",
    "line",
    "lock-retry-ms",
    "lock-max-retries",
  ]),
  "candidates-set": new Set(["state-dir", "candidates-json", ...LOCK_FLAGS]),
  "candidates-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "promoted-add": new Set(["state-dir", "ids", ...LOCK_FLAGS]),
  "promoted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "relisted-add": new Set(["state-dir", "id", "seen-at", ...LOCK_FLAGS]),
  "relisted-drop": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "stalled-set": new Set(["state-dir", "value", "bump", ...LOCK_FLAGS]),
  // --- 進行系 (設計2.1) ---
  "approve": new Set(["state-dir", "id", "title", ...LOCK_FLAGS]),
  "claim": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "set-gate": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "advance": new Set(["state-dir", "id", "from", "to", ...LOCK_FLAGS]),
  "phase-fail": new Set([
    "state-dir",
    "id",
    "phase",
    "expect-attempts",
    "verifier",
    "session",
    ...LOCK_FLAGS,
  ]),
  "block": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  "dequeue": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "restore": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "retire": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  // --- 完了系 (設計2.2) ---
  "ship": new Set([
    "state-dir",
    "id",
    "commits",
    "ref",
    "branch",
    "tip",
    "base",
    ...LOCK_FLAGS,
  ]),
  "merged": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw": new Set(["state-dir", "id", "note", ...LOCK_FLAGS]),
  "withdraw-asked": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "withdraw-remove": new Set(["state-dir", "id", "reason", ...LOCK_FLAGS]),
  // --- 要求系 (設計2.1) ---
  "fix-request": new Set(["state-dir", "id", "ids", "findings", ...LOCK_FLAGS]),
  "fix-rerun-mark": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "rebase-request": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    "reason",
    "kind",
    "cause",
    "report",
    "resolve",
    "from-tip",
    ...LOCK_FLAGS,
  ]),
  "rebase-applied": new Set(["state-dir", "id", "tip", ...LOCK_FLAGS]),
  // --- 仕上げ開始系 (設計2.1・2.4) ---
  "fix-start": new Set([
    "state-dir",
    "id",
    "session",
    "reset-attempts",
    ...LOCK_FLAGS,
  ]),
  "rebase-start": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "rebase-give-up": new Set([
    "state-dir",
    "id",
    "blocked-onto",
    ...LOCK_FLAGS,
  ]),
  "rebase-forgo": new Set(["state-dir", "id", "blocked-onto", ...LOCK_FLAGS]),
  // --- 追従系 (設計2.1) ---
  "probe-run": new Set(["state-dir", "id", "proc", "session", ...LOCK_FLAGS]),
  "probe-exit": new Set(["state-dir", "id", "sig", ...LOCK_FLAGS]),
  "release": new Set(["state-dir", "id", ...LOCK_FLAGS]),
  "observe": new Set([
    "state-dir",
    "id",
    "head",
    "ci",
    "checked-at",
    "errors-inc",
    "errors-reset",
    "note",
    "sig-clear",
    ...LOCK_FLAGS,
  ]),
  "attention-set": new Set([
    "state-dir",
    "id",
    "auto",
    "human",
    ...LOCK_FLAGS,
  ]),
  "review-only": new Set(["state-dir", "id", "items-json", ...LOCK_FLAGS]),
  "answered-set": new Set(["state-dir", "id", "items-json", ...LOCK_FLAGS]),
  // --- 実行帳簿 (対象が run の中のフィールドになるだけで起動形は v1 と同じ) ---
  "set-worktree": new Set([
    "state-dir",
    "id",
    "worktree",
    "base",
    "drop-withdrawn-branch",
    ...LOCK_FLAGS,
  ]),
  "set-executor": new Set([
    "state-dir",
    "id",
    "executor",
    "expect-executor",
    "session",
    ...LOCK_FLAGS,
  ]),
  "touch-executor": new Set([
    "state-dir",
    "id",
    "expect-executor",
    "session",
    ...LOCK_FLAGS,
  ]),
  "set-takeover": new Set(["state-dir", "id", "at", "clear", ...LOCK_FLAGS]),
};

// ---------------------------------------------------------------------------
// dispatch
//
// ディスパッチ表のキー集合は ALLOWED_FLAGS と一致し、その内訳は VERB_SPEC (遷移 33) と
// LEDGER_VERBS (帳簿 15) で尽きる。どちらにも属さない verb を足すと state.test.ts の
// 分類ネットが落ちる。
// ---------------------------------------------------------------------------

export type CmdHandler = (
  stateDir: string,
  flags: Map<string, string>,
) => Promise<unknown>;

export const HANDLERS: Record<Verb, CmdHandler> = {
  // 帳簿系
  "init": cmdInit,
  "get": (stateDir) => cmdGet(stateDir),
  "validate": (stateDir) => cmdValidate(stateDir),
  "next": cmdNext,
  "verdict-path": cmdVerdictPath,
  "session-touch": cmdSessionTouch,
  "sessions-alive": cmdSessionsAlive,
  "history-append": cmdHistoryAppend,
  "candidates-set": cmdCandidatesSet,
  "candidates-drop": cmdCandidatesDrop,
  "promoted-add": cmdPromotedAdd,
  "promoted-drop": cmdPromotedDrop,
  "relisted-add": cmdRelistedAdd,
  "relisted-drop": cmdRelistedDrop,
  "stalled-set": cmdStalledSet,
  // 進行系
  "approve": cmdApprove,
  "claim": cmdClaim,
  "set-gate": cmdSetGate,
  "advance": cmdAdvance,
  "phase-fail": cmdPhaseFail,
  "block": cmdBlock,
  "dequeue": cmdDequeue,
  "restore": cmdRestore,
  "retire": cmdRetire,
  // 完了系
  "ship": cmdShip,
  "merged": cmdMerged,
  "withdraw": cmdWithdraw,
  "withdraw-asked": cmdWithdrawAsked,
  "withdraw-remove": cmdWithdrawRemove,
  // 要求系
  "fix-request": cmdFixRequest,
  "fix-rerun-mark": cmdFixRerunMark,
  "rebase-request": cmdRebaseRequest,
  "rebase-applied": cmdRebaseApplied,
  // 仕上げ開始系
  "fix-start": cmdFixStart,
  "rebase-start": cmdRebaseStart,
  "rebase-give-up": cmdRebaseGiveUp,
  "rebase-forgo": cmdRebaseForgo,
  // 追従系
  "probe-run": cmdProbeRun,
  "probe-exit": cmdProbeExit,
  "release": cmdRelease,
  "observe": cmdObserve,
  "attention-set": cmdAttentionSet,
  "review-only": cmdReviewOnly,
  "answered-set": cmdAnsweredSet,
  // 実行帳簿
  "set-worktree": cmdSetWorktree,
  "set-executor": cmdSetExecutor,
  "touch-executor": cmdTouchExecutor,
  "set-takeover": cmdSetTakeover,
};

// ---------------------------------------------------------------------------
// 境界 — 外から来た未検査の文字列を Verb に絞る
//
// argv の verb は当然 string である。**型で守れるのは宣言同士の一致までで、外から
// 来る値は実行時に検査するしかない** ので、その 1 点をこの関数に閉じ込める
// (ここを通った後は Verb として扱えるので、表の引き当てに as が要らない)。
// ---------------------------------------------------------------------------

export function asVerb(candidate: string): Verb | null {
  return Object.hasOwn(ALLOWED_FLAGS, candidate) ? candidate as Verb : null;
}

// 同じく、未検査のフラグ名がその verb の許可集合に含まれるか。ReadonlySet<FlagName> の
// has() は FlagName しか受けないので、境界の widening をここだけに閉じ込める。
export function isAllowedFlag(verb: Verb, candidate: string): boolean {
  return (ALLOWED_FLAGS[verb] as ReadonlySet<string>).has(candidate);
}

// LEDGER_VERBS を再 export する (state.ts の分類の出所を 1 箇所にまとめるため)。
export { LEDGER_VERBS };
