// task-pipeline/scripts/state-dispatch.ts
//
// state CLI の **層 4 — verb 名から実装への表**。受理するフラグの一覧 (ALLOWED_FLAGS) と
// cmd 実装への割り当て (HANDLERS) の 2 つだけを持ち、**この 2 つのキー集合が
// ディスパッチ集合そのもの**である (45 verb = VERB_SPEC 32 + LEDGER_VERBS 13)。
//
// 分けてある理由: verb を 1 つ足す/消すときに触るのがこのファイルだけになり、
// 「フラグ表には有るのに実装が無い」「実装は有るのに契約文書に無い」というずれが
// state.test.ts の T-D2 / T-D6 で必ず落ちる形に閉じる。層の一覧は state-io.ts の冒頭。

import {
  cmdCandidatesDrop,
  cmdCandidatesSet,
  cmdGet,
  cmdHistoryAppend,
  cmdInit,
  cmdPromotedAdd,
  cmdPromotedDrop,
  cmdRelistedAdd,
  cmdRelistedDrop,
  cmdSessionsAlive,
  cmdSessionTouch,
  cmdStalledSet,
  cmdValidate,
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

// 書き込み系 verb はすべて --lock-retry-ms/--lock-max-retries を受け付ける。個々の
// エントリでは省略せず明記する — この一覧が state-cli-contract.md との突き合わせテスト
// (T-D2) の一方の入力になるため、実際に受理するフラグと過不足なく一致している必要がある。
const LOCK_FLAGS = ["lock-retry-ms", "lock-max-retries"];

// export するのは state.test.ts のドキュメント突き合わせテスト (state-cli-contract.md の
// verb 見出し一覧との差集合チェック) と、分類ネット (どの verb も VERB_SPEC か
// LEDGER_VERBS のどちらかに属する) のため。
export const ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
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
  "phase-fail": new Set(["state-dir", "id", "phase", ...LOCK_FLAGS]),
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
    "session",
    ...LOCK_FLAGS,
  ]),
  "touch-executor": new Set(["state-dir", "id", "session", ...LOCK_FLAGS]),
  "set-takeover": new Set(["state-dir", "id", "at", "clear", ...LOCK_FLAGS]),
};

// ---------------------------------------------------------------------------
// dispatch
//
// ディスパッチ表のキー集合は ALLOWED_FLAGS と一致し、その内訳は VERB_SPEC (遷移 32) と
// LEDGER_VERBS (帳簿 13) で尽きる。どちらにも属さない verb を足すと state.test.ts の
// 分類ネットが落ちる。
// ---------------------------------------------------------------------------

export type CmdHandler = (
  stateDir: string,
  flags: Map<string, string>,
) => Promise<unknown>;

export const HANDLERS: Record<string, CmdHandler> = {
  // 帳簿系
  "init": cmdInit,
  "get": (stateDir) => cmdGet(stateDir),
  "validate": (stateDir) => cmdValidate(stateDir),
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
