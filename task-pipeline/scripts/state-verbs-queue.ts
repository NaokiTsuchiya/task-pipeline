// task-pipeline/scripts/state-verbs-queue.ts
//
// state CLI の **層 3 — queue エントリを対象にする 33 verb の cmd 実装**。
// 領域 P × 領域 A の座標を持つ verb で、対応する純関数は state-transitions-v2.ts の
// VERB_SPEC に from/to が宣言されている (**帳簿系 15 verb は state-verbs-ledger.ts**)。
// 設計 2.1 の分類そのままの順に並べる: 進行系 / 完了系 / 要求系 / 仕上げ開始系 /
// 追従系 / 実行帳簿。層の一覧は state-io.ts の冒頭。
//
// 各 cmd は「flag 抽出・usage 検証 → withQueueLock 越しに apply 関数へ委譲 →
// 成功 JSON 組み立て」の薄い形で、前提チェックと書き換えは apply 側にある。

import {
  CI_VALUES,
  HUMAN_ATTENTION_REASON_VALUES,
  PHASE_VALUES,
  REBASE_KIND_VALUES,
  REBASE_REASON_VALUES,
  VERIFIED_PHASE_VALUES,
} from "./state-model-v2.ts";
import { isRecord } from "./state-ledger-v2.ts";
import {
  applyAdvance,
  applyAnsweredSet,
  applyApprove,
  applyAttentionSet,
  applyBlock,
  applyClaim,
  applyDequeue,
  applyFixRequest,
  applyFixRerunMark,
  applyFixStart,
  applyMerged,
  applyObserve,
  applyPhaseFail,
  applyProbeExit,
  applyProbeRun,
  applyRebaseApplied,
  applyRebaseForgo,
  applyRebaseGiveUp,
  applyRebaseRequest,
  applyRebaseStart,
  applyRelease,
  applyRestore,
  applyRetire,
  applyReviewOnly,
  applySetExecutor,
  applySetGate,
  applySetTakeover,
  applySetWorktree,
  applyShip,
  applyTouchExecutor,
  applyWithdraw,
  applyWithdrawAsked,
  applyWithdrawRemove,
  CliErrorV2,
  type LedgerEntry,
  type ObserveFields,
  type ProbeExitFields,
  type ProbeRunFields,
  type RebaseRequestArgs,
  type V2Run,
  type V2State,
} from "./state-transitions-v2.ts";
import { nowIso } from "./state-io.ts";
import {
  boolFlag,
  lockOpts,
  nullableFlag,
  optionalEnumFlag,
  parseCsv,
  requireEnumFlag,
  requireFlag,
  requireIntFlag,
} from "./state-flags.ts";
import { withExistingStateLock, withQueueLock } from "./state-store.ts";

function runOf(state: V2State, id: string): V2Run | null {
  return state.queue.find((it) => it.id === id)?.run ?? null;
}

function runFields(state: V2State, id: string): Record<string, unknown> {
  const run = runOf(state, id);
  return {
    kind: run?.kind ?? null,
    gate: run?.gate ?? null,
    phase: run?.phase ?? null,
  };
}

// --- 進行系 ---------------------------------------------------------------

export async function cmdApprove(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const title = requireFlag(flags, "title");
  await withExistingStateLock(
    stateDir,
    lockOpts(flags),
    (current) => applyApprove(current, id, title),
  );
  return { ok: true, id };
}

export async function cmdClaim(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyClaim(item, index, state, session),
  );
  return { ok: true, id, ...runFields(next, id), session };
}

export async function cmdSetGate(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applySetGate(item, index, state),
  );
  return { ok: true, id, ...runFields(next, id) };
}

export async function cmdAdvance(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const from = requireEnumFlag(flags, "from", PHASE_VALUES);
  const to = requireEnumFlag(flags, "to", PHASE_VALUES);
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyAdvance(item, index, state, from, to),
  );
  return { ok: true, id, phase: to };
}

export async function cmdPhaseFail(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  // 検証ゲートを持つフェーズだけを受ける (finalize は検証対象外なので usage)。
  const phase = requireEnumFlag(flags, "phase", VERIFIED_PHASE_VALUES);
  // gh-70: --verifier は省略可 (段階導入)。渡すときは、再開を要求できるセッションを
  // run.verifier_session に残すため --session も必須にする。
  const verifier = flags.get("verifier") ?? null;
  if (verifier !== null && !flags.has("session")) {
    throw new CliErrorV2(
      "usage",
      "--session is required when --verifier is given",
    );
  }
  const session = flags.get("session") ?? null;
  const expectAttempts = requireIntFlag(flags, "expect-attempts");
  let attempts = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyPhaseFail(
      item,
      index,
      state,
      phase,
      expectAttempts,
      verifier,
      session,
    );
    attempts = result.attempts;
    return result.state;
  });
  return { ok: true, id, attempts, verifier, verifier_session: session };
}

export async function cmdBlock(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const reason = requireFlag(flags, "reason");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyBlock(item, index, state, reason),
  );
  return { ok: true, id, progress: "blocked" };
}

export async function cmdDequeue(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyDequeue(item, index, state),
  );
  return { ok: true, id };
}

export async function cmdRestore(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRestore(item, index, state),
  );
  return { ok: true, id, progress: "queued" };
}

export async function cmdRetire(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRetire(item, index, state, nowIso()),
  );
  return { ok: true, id, completed: next.completed.length };
}

// --- 完了系 (設計2.2) -------------------------------------------------------

export async function cmdShip(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const commits = requireIntFlag(flags, "commits");
  const group = ["ref", "branch", "tip", "base"] as const;
  const given = group.filter((name) => flags.has(name));
  if (commits >= 1 && given.length !== group.length) {
    throw new CliErrorV2(
      "usage",
      "--ref/--branch/--tip/--base are all required when --commits >= 1",
    );
  }
  if (commits === 0 && given.length !== 0) {
    throw new CliErrorV2(
      "usage",
      "--ref/--branch/--tip/--base must all be omitted when --commits is 0",
    );
  }
  const args = {
    commits,
    ref: flags.get("ref"),
    branch: flags.get("branch"),
    tip: flags.get("tip"),
    base: flags.get("base"),
  };

  let notify = "none";
  let mark = false;
  let fixCount = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyShip(item, index, state, args);
    notify = result.notify;
    mark = result.mark;
    fixCount = result.fix_count;
    return result.state;
  });
  // 遷移から導出できる後続指示 (設計2.2)。呼び出し側はこれを見て通知テンプレートと
  // トラッカー更新の要否を決める — 経路の記憶を持たなくてよい。
  return { ok: true, id, notify, mark, fix_count: fixCount };
}

export async function cmdMerged(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyMerged(item, index, state),
  );
  return { ok: true, id, artifact: "merged" };
}

export async function cmdWithdraw(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const note = flags.get("note");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWithdraw(item, index, state, note),
  );
  return { ok: true, id, artifact: "withdrawn" };
}

export async function cmdWithdrawAsked(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyWithdrawAsked(item, index, state),
  );
  return { ok: true, id };
}

export async function cmdWithdrawRemove(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const reason = requireFlag(flags, "reason");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyWithdrawRemove(item, index, state, reason, nowIso()),
  );
  return { ok: true, id };
}

// --- 要求系 (設計2.1) -------------------------------------------------------

export async function cmdFixRequest(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const ids = parseCsv(requireFlag(flags, "ids"));
  const findings = requireFlag(flags, "findings");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyFixRequest(item, index, state, ids, findings),
  );
  return { ok: true, id, ids };
}

export async function cmdFixRerunMark(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  let tip: string | null = null;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyFixRerunMark(item, index, state);
    tip = result.tip;
    return result.state;
  });
  return { ok: true, id, tip };
}

export async function cmdRebaseRequest(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const args: RebaseRequestArgs = {
    blockedOnto: requireFlag(flags, "blocked-onto"),
    reason: requireEnumFlag(flags, "reason", REBASE_REASON_VALUES),
    kind: optionalEnumFlag(flags, "kind", REBASE_KIND_VALUES),
    cause: flags.get("cause"),
    report: flags.get("report"),
    fromTip: flags.get("from-tip"),
    // 省略時は既存の resolve を保つ (apply 側が undefined を「触れない」と読む)。
    resolve: flags.has("resolve") ? boolFlag(flags, "resolve") : undefined,
  };
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseRequest(item, index, state, args, nowIso()),
  );
  return { ok: true, id, resolve: args.resolve ?? null };
}

export async function cmdRebaseApplied(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const tip = requireFlag(flags, "tip");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseApplied(item, index, state, tip),
  );
  return { ok: true, id, tip };
}

// --- 仕上げ開始系 (設計2.1・2.4) -------------------------------------------

export async function cmdFixStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const reset = boolFlag(flags, "reset-attempts");
  let started = false;
  let fixAttempts = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyFixStart(item, index, state, session, reset);
    started = result.started;
    fixAttempts = result.fixAttempts;
    return result.state;
  });
  return { ok: true, id, started, fix_attempts: fixAttempts };
}

export async function cmdRebaseStart(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const session = requireFlag(flags, "session");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRebaseStart(item, index, state, session),
  );
  // 入口 (a) 解決サイクル (kind=rebase_fix) と入口 (b) 迂回 (kind 不変) のどちらだったかは
  // 書き込んだ run から読み戻す (設計2.4 — 事後に判別できることが v2 の主張)。
  return { ok: true, id, ...runFields(next, id) };
}

export async function cmdRebaseGiveUp(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const blockedOnto = requireFlag(flags, "blocked-onto");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseGiveUp(item, index, state, blockedOnto, nowIso()),
  );
  return { ok: true, id, progress: "resting" };
}

export async function cmdRebaseForgo(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const blockedOnto = requireFlag(flags, "blocked-onto");
  const next = await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyRebaseForgo(item, index, state, blockedOnto, nowIso()),
  );
  return { ok: true, id, ...runFields(next, id) };
}

// --- 追従系 (設計2.1) -------------------------------------------------------

export async function cmdProbeRun(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: ProbeRunFields = flags.has("session")
    ? { proc: requireFlag(flags, "proc"), session: flags.get("session")! }
    : { proc: requireFlag(flags, "proc") };
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyProbeRun(item, index, state, fields, nowIso()),
  );
  return { ok: true, id, proc: fields.proc };
}

export async function cmdProbeExit(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: ProbeExitFields = flags.has("sig")
    ? { sig: nullableFlag(flags.get("sig")!) }
    : {};
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyProbeExit(item, index, state, fields),
  );
  return { ok: true, id };
}

export async function cmdRelease(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applyRelease(item, index, state),
  );
  return { ok: true, id };
}

export async function cmdObserve(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const fields: Record<string, unknown> = {};
  if (flags.has("head")) fields.head = nullableFlag(flags.get("head")!);
  if (flags.has("ci")) {
    const raw = flags.get("ci")!;
    if (raw !== "null" && !(CI_VALUES as readonly string[]).includes(raw)) {
      throw new CliErrorV2("usage", `invalid --ci: ${raw}`);
    }
    fields.ci = raw === "null" ? null : raw;
  }
  if (flags.has("checked-at")) {
    fields.checked_at = nullableFlag(flags.get("checked-at")!);
  }
  if (flags.has("note")) fields.note = nullableFlag(flags.get("note")!);
  const errorsInc = boolFlag(flags, "errors-inc");
  const errorsReset = boolFlag(flags, "errors-reset");
  if (errorsInc && errorsReset) {
    throw new CliErrorV2(
      "usage",
      "--errors-inc and --errors-reset are mutually exclusive",
    );
  }
  if (errorsInc) fields.errorsInc = true;
  if (errorsReset) fields.errorsReset = true;
  if (boolFlag(flags, "sig-clear")) fields.sigClear = true;
  if (Object.keys(fields).length === 0) {
    throw new CliErrorV2("usage", "observe requires at least one field flag");
  }

  let errors = 0;
  let latched = false;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyObserve(item, index, state, fields as ObserveFields);
    errors = result.errors;
    latched = result.latched;
    return result.state;
  });
  // latched は「errors が上限に達して attention→human(errors) に落ちた」ことの通知。
  // 呼び出し側はこれを見て追従を畳む (設計2.1)。
  return { ok: true, id, errors, latched };
}

export async function cmdAttentionSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const auto = boolFlag(flags, "auto");
  const hasHuman = flags.has("human");
  if (auto === hasHuman) {
    throw new CliErrorV2(
      "usage",
      "exactly one of --auto or --human <reason> is required",
    );
  }
  const target = auto ? "auto" : requireEnumFlag(
    flags,
    "human",
    HUMAN_ATTENTION_REASON_VALUES,
  );
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyAttentionSet(
        item,
        index,
        state,
        target as Parameters<typeof applyAttentionSet>[3],
      ),
  );
  return { ok: true, id, attention: target };
}

// ledger.review_only は「人の判断が要ると回した」ことを表す語彙で、ledger.handled
// (pr_fix で実際にコードを直した) とも ledger.answered (質問に回答・投稿済み) とも
// 意味が違う。同じ版 (updated_at) のまま繰り返し観測された id を毎回報告し直させない
// ため、この verb は「今回新規に見えた、または前回記録した updated_at から版が進んだ
// id」を new_or_changed として返す — 呼び出し側 (SKILL.md) はこれだけを報告する。
// updated_at が null (版を取得できなかった) の id は比較のしようが無いので、安全側に
// 倒して観測されるたびに毎回 new_or_changed に含める。
function parseLedgerItems(raw: string): LedgerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliErrorV2(
      "usage",
      `invalid --items-json: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliErrorV2("usage", "--items-json must be a JSON array");
  }
  const items: LedgerEntry[] = [];
  for (const it of parsed) {
    if (!isRecord(it) || typeof it.id !== "string") {
      throw new CliErrorV2("usage", "each item needs a string id");
    }
    if (
      !("updated_at" in it) ||
      (typeof it.updated_at !== "string" && it.updated_at !== null)
    ) {
      throw new CliErrorV2(
        "usage",
        "each item needs updated_at (string or null)",
      );
    }
    items.push({ id: it.id, updated_at: it.updated_at as string | null });
  }
  return items;
}

export async function cmdReviewOnly(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const items = parseLedgerItems(requireFlag(flags, "items-json"));
  let newOrChanged: string[] = [];
  let total = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyReviewOnly(item, index, state, items);
    newOrChanged = result.newOrChanged;
    total = result.total;
    return result.state;
  });
  return {
    ok: true,
    id,
    new_or_changed: newOrChanged,
    review_only_total: total,
  };
}

export async function cmdAnsweredSet(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const items = parseLedgerItems(requireFlag(flags, "items-json"));
  let newOrChanged: string[] = [];
  let total = 0;
  await withQueueLock(stateDir, id, lockOpts(flags), (item, index, state) => {
    const result = applyAnsweredSet(item, index, state, items);
    newOrChanged = result.newOrChanged;
    total = result.total;
    return result.state;
  });
  return {
    ok: true,
    id,
    new_or_changed: newOrChanged,
    answered_total: total,
  };
}

// --- 実行帳簿 ---------------------------------------------------------------

export async function cmdSetWorktree(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const worktree = requireFlag(flags, "worktree");
  const base = requireFlag(flags, "base");
  const drop = boolFlag(flags, "drop-withdrawn-branch");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applySetWorktree(item, index, state, worktree, base, drop),
  );
  return { ok: true, id, worktree, base };
}

export async function cmdSetExecutor(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const executor = requireFlag(flags, "executor");
  const session = requireFlag(flags, "session");
  // 省略は「まだ誰も握っていないはず」の宣言なので null 期待。`--expect-executor null` も同義。
  const expectExecutor = flags.has("expect-executor")
    ? nullableFlag(flags.get("expect-executor")!)
    : null;
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applySetExecutor(
        item,
        index,
        state,
        executor,
        session,
        nowIso(),
        expectExecutor,
      ),
  );
  return { ok: true, id, executor, session };
}

export async function cmdTouchExecutor(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const sessionIfUnowned = flags.get("session");
  const expectExecutor = flags.get("expect-executor");
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) =>
      applyTouchExecutor(
        item,
        index,
        state,
        sessionIfUnowned,
        nowIso(),
        expectExecutor,
      ),
  );
  return { ok: true, id };
}

export async function cmdSetTakeover(
  stateDir: string,
  flags: Map<string, string>,
): Promise<Record<string, unknown>> {
  const id = requireFlag(flags, "id");
  const hasAt = flags.has("at");
  const clear = boolFlag(flags, "clear");
  if (hasAt === clear) {
    throw new CliErrorV2(
      "usage",
      "exactly one of --at or --clear is required",
    );
  }
  const atValue = hasAt ? flags.get("at")! : null;
  await withQueueLock(
    stateDir,
    id,
    lockOpts(flags),
    (item, index, state) => applySetTakeover(item, index, state, atValue),
  );
  return { ok: true, id, takeover_at: atValue };
}
