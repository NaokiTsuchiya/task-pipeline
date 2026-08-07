// task-pipeline/scripts/state-migrate-v2.ts
//
// state.json v1 → v2 の移行純関数 (設計 task-pipeline/docs/state-model-v2-2026-08.md 3.2節)。
//
// - 完全な純関数: 時刻は引数 (nowIso) で受け、Deno API もファイルI/Oも呼ばない。入力
//   オブジェクトを書き換えず、**出力は入力のオブジェクト/配列参照を1つも共有しない**。
// - 語彙とフェーズ列は state-model-v2.ts (#34) を単一の出所として使う。スキーマ側の
//   宣言 (state-v2.schema.json) との一致は state-schema-v2.test.ts の突き合わせが固定する。
// - CLI への配線 (init が schema_version==1 を見て呼ぶ) はこのタスクのスコープ外。v1 実装
//   (state.ts / state-transitions.ts / state.schema.json) には一切依存しない。
//
// **入力が壊れているときは throw する** (状態オブジェクトでない / queue 要素が
// オブジェクトでない / id が文字列でない / status が v1 の 5 値でない)。移行が黙って
// 別のノードへ丸めると、壊れ方が v2 の合法な状態として固定されてしまうため。
// 一方、v1 スキーマ上「任意キー」だったもの (review.branch/tip/base、withdrawn_asked、
// watch.review_only/answered など) は既定値で埋める — v2 では required だが、欠落は
// v1-valid な入力として実在するため (tests/fixtures/state-cli/valid-legacy-live.json)。
//
// テスト: state-migrate-v2.test.ts / 実行は sh tests/state-migrate-v2.test.sh

import {
  type Gate,
  GATE_VALUES,
  INITIAL_GATE_PHASE_SEQUENCES,
  isLegalRunNode,
  type RunKind,
} from "./state-model-v2.ts";

export const V2_SCHEMA_VERSION = 2;

const V1_STATUS_VALUES = [
  "approved",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;
type V1Status = (typeof V1_STATUS_VALUES)[number];

const CI_VALUES = ["passing", "failing", "pending", "none"] as const;
const STALLED_VALUES = ["depleted", "max_open"] as const;

// ---------------------------------------------------------------------------
// 素の JSON 値を読むための小さなヘルパ (v1 の値は型で守られていない)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 文字列ならその値、そうでなければ null (v2 の nullable フィールドの既定値)。
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function oneOfOrNull<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return allowed.find((a) => a === value) ?? null;
}

interface ReviewOnlyEntryV2 {
  id: string;
  updated_at: string | null;
}

function reviewOnlyEntries(value: unknown): ReviewOnlyEntryV2[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewOnlyEntryV2[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    out.push({ id: str(raw.id) ?? "", updated_at: str(raw.updated_at) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// run — 領域P (設計1.2・3.2節)
// ---------------------------------------------------------------------------

function firstPhaseOf(kind: RunKind, gate: Gate | null): string {
  if (kind === "initial") {
    return INITIAL_GATE_PHASE_SEQUENCES[gate ?? "full"][0];
  }
  return kind;
}

// kind の判別 (3.2節):
//   phase==pr_fix          → pr_fix
//   phase==rebase_fix      → review.rebase が有れば rebase_fix (解決サイクル)、
//                            無ければ initial の迂回
//   phase==finalize / 他   → initial (v1 に来歴が無く判別不能。設計の明記)
//
// ただし pr_fix は **artifact が open のときだけ** 名乗れる: 不変条件3
// (running(pr_fix) ⇒ artifact.state==open ∧ follow≠null ∧ asks.fix.taken) があるため、
// review が無い / 取り下げ済みの item を pr_fix のまま写すと、移行直後に破れた状態が
// できる。この組は v1 でも verb 経由では作れない (fix-start は review.watch を要求する)
// ので、来歴を捨てて initial の先頭フェーズから復帰させる (phase の合法性チェックが
// 自動的にそうする)。
function deriveRunKind(
  phase: string | null,
  hasRebase: boolean,
  artifactIsOpen: boolean,
): RunKind {
  if (phase === "pr_fix") return artifactIsOpen ? "pr_fix" : "initial";
  if (phase === "rebase_fix") return hasRebase ? "rebase_fix" : "initial";
  return "initial";
}

// gate の選択: v1 の gate を第1候補にしつつ、**phase と整合する gate を優先する**。
// v1 では restore が gate を戻し損ねて (gate: light, phase: research) のような死に組が
// 作れた (設計4.1節の別掲) が、実際の作業位置を表しているのは phase の方なので、
// 食い違うときは phase に合わせて gate を直す。
function deriveGate(
  kind: RunKind,
  phase: string | null,
  rawGate: unknown,
): Gate | null {
  if (kind !== "initial") return null;
  const v1Gate = oneOfOrNull(rawGate, GATE_VALUES);
  const ordered: Gate[] = v1Gate === null
    ? [...GATE_VALUES]
    : [v1Gate, ...GATE_VALUES.filter((g) => g !== v1Gate)];
  const fitting = phase === null
    ? undefined
    : ordered.find((g) => isLegalRunNode({ kind, gate: g, phase }));
  return fitting ?? v1Gate ?? "full";
}

interface RunV2 {
  kind: RunKind;
  gate: Gate | null;
  phase: string;
  attempts: number;
  executor: string | null;
  executor_last_event_at: string | null;
  takeover_at: string | null;
}

function buildRun(
  item: Record<string, unknown>,
  review: Record<string, unknown> | null,
  artifactState: string,
): RunV2 {
  const rawPhase = str(item.phase);
  const kind = deriveRunKind(
    rawPhase,
    review !== null && isRecord(review.rebase),
    artifactState === "open",
  );
  const gate = deriveGate(kind, rawPhase, item.gate);
  const phase =
    rawPhase !== null && isLegalRunNode({ kind, gate, phase: rawPhase })
      ? rawPhase
      : firstPhaseOf(kind, gate);
  return {
    kind,
    gate,
    phase,
    attempts: nonNegativeInt(item.attempts, 0),
    executor: str(item.executor),
    executor_last_event_at: str(item.executor_last_event_at),
    takeover_at: str(item.takeover_at),
  };
}

// ---------------------------------------------------------------------------
// artifact / follow — 領域A (設計1.1・1.3・3.2節)
// ---------------------------------------------------------------------------

// watch.state=="stopped" の理由 3分岐 (3.2節): fix_attempts > 3 → fix_limit、
// errors >= 3 → errors、それ以外 → manual。
function deriveAttention(
  watch: Record<string, unknown> | null,
): "auto" | { human: string } {
  if (watch === null || watch.state !== "stopped") return "auto";
  if (nonNegativeInt(watch.fix_attempts, 0) > 3) return { human: "fix_limit" };
  if (nonNegativeInt(watch.errors, 0) >= 3) return { human: "errors" };
  return { human: "manual" };
}

// fix-ask (3.2節 + 不変条件3):
// 設計の表は「fix_pending 真 → taken:false / 偽 → 破棄」だが、v1 の fix-start は成功時に
// fix_pending を false にして pending_ids を残したまま in_progress/pr_fix へ進む
// (state-transitions.ts applyFixStart)。したがって飛行中の pr_fix も「偽 かつ pending_ids
// 非空」の形になり、そのまま破棄すると移行直後に不変条件3
// (running(pr_fix) ⇒ artifact.state==open ∧ follow≠null ∧ asks.fix.taken) が破れる。
// rebase 行の「kind=rebase_fix と判定した running のタスクだけ taken: true」と同じ規則を
// fix 側にも適用し、kind==pr_fix の item だけ taken: true で写す。
function deriveFixAsk(
  watch: Record<string, unknown> | null,
  runKind: RunKind | null,
): Record<string, unknown> | null {
  const ids = strArray(watch?.pending_ids);
  const findings = str(watch?.findings);
  if (runKind === "pr_fix") return { ids, findings, taken: true };
  if (watch !== null && watch.fix_pending === true) {
    return { ids, findings, taken: false };
  }
  return null;
}

function deriveRebaseAsk(
  rebase: Record<string, unknown> | null,
  runKind: RunKind | null,
): Record<string, unknown> | null {
  if (rebase === null) return null;
  const ask: Record<string, unknown> = {
    blocked_onto: str(rebase.blocked_onto) ?? "",
    reason: str(rebase.reason) ?? "",
    at: str(rebase.at) ?? "",
  };
  // v1 の任意キーは、有るときだけ写す (無いキーを null で埋めない — 1.3節の形)。
  for (const key of ["kind", "cause", "report", "from_tip"]) {
    const value = str(rebase[key]);
    if (value !== null) ask[key] = value;
  }
  ask.resolve = rebase.resolve_pending === true;
  ask.taken = runKind === "rebase_fix";
  return ask;
}

// follow を作るのは open のときで、v1 側に watch か rebase のどちらかが有るときだけ。
// 設計1.3の「ref が PR URL のときだけ存在」を v1 の実データから判定する代理として
// watch の有無を使う (v1 では watch-init が PR 経路でだけ張られ、finish=commit の review は
// watch を持たない)。rebase だけが記録された item の ask を落とさないため or 条件にする。
// kind==pr_fix の run を持つ item も必ず作る — 不変条件3 が follow≠null を要求するため
// (PR への追従が前提の run なので、follow が無い形はそもそも意味を持たない)。
function buildFollow(
  review: Record<string, unknown>,
  progress: string,
  runKind: RunKind | null,
): Record<string, unknown> | null {
  const watch = isRecord(review.watch) ? review.watch : null;
  const rebase = isRecord(review.rebase) ? review.rebase : null;
  if (watch === null && rebase === null && runKind !== "pr_fix") return null;

  // 不変条件4 (probe.proc ≠ null ⇒ progress == resting): 実行中の item に残っていた
  // リースは移行時に外す (v1 の確認済み欠陥6の残骸がここに来うる)。
  const holdsLease = progress === "resting";
  return {
    attention: deriveAttention(watch),
    asks: {
      fix: deriveFixAsk(watch, runKind),
      rebase: deriveRebaseAsk(rebase, runKind),
    },
    ledger: {
      handled: strArray(watch?.handled),
      fix_attempts: nonNegativeInt(watch?.fix_attempts, 0),
      review_only: reviewOnlyEntries(watch?.review_only),
      answered: reviewOnlyEntries(watch?.answered),
    },
    probe: {
      proc: holdsLease ? str(watch?.proc) : null,
      proc_started_at: holdsLease ? str(watch?.proc_started_at) : null,
      sig: str(watch?.sig),
      head: str(watch?.head),
      ci: oneOfOrNull(watch?.ci, CI_VALUES),
      checked_at: str(watch?.checked_at),
      errors: nonNegativeInt(watch?.errors, 0),
      note: str(watch?.note),
    },
  };
}

// artifact.state の優先順位 (設計の表に順序が無いので決める):
//   review==null → none / status==done → merged / withdrawn==true → withdrawn / 他 → open
// - review==null を最優先にするのは、設計1.1節が「resting × none から merged へ到達する
//   経路は無い — マージ証明は tip を要する」と明記しているため (グループ欄が全 null の
//   merged はモデル上意味を持たない)。
// - done を withdrawn より優先するのは、v1 では withdraw の後に recover-done できて
//   両方立ちうるからで、マージ証明の方が強い事実だから。
// v1 の review は ref 以外が任意キーなので、欠けているグループ欄は null で埋める。
// state だけを先に決める (run の kind 判別が「artifact が open か」を要るため。
// 逆向きの依存 — follow の中身が run.kind を要る — は buildArtifact 側で解決する)。
function deriveArtifactState(
  status: V1Status,
  review: Record<string, unknown> | null,
): string {
  if (review === null) return "none";
  if (status === "done") return "merged";
  if (review.withdrawn === true) return "withdrawn";
  return "open";
}

function buildArtifact(
  artifactState: string,
  review: Record<string, unknown> | null,
  progress: string,
  runKind: RunKind | null,
): Record<string, unknown> {
  if (artifactState === "none" || review === null) return { state: "none" };
  const group = {
    ref: str(review.ref),
    branch: str(review.branch),
    tip: str(review.tip),
    base: str(review.base),
  };
  if (artifactState === "merged") return { state: "merged", ...group };
  if (artifactState === "withdrawn") {
    return {
      state: "withdrawn",
      ...group,
      asked: review.withdrawn_asked === true,
      note: null,
    };
  }
  return {
    state: "open",
    ...group,
    follow: buildFollow(review, progress, runKind),
  };
}

// ---------------------------------------------------------------------------
// queue エントリ 1 件の移行
// ---------------------------------------------------------------------------

const PROGRESS_BY_STATUS: Readonly<Record<V1Status, string>> = {
  approved: "queued",
  in_progress: "running",
  in_review: "resting",
  done: "resting",
  blocked: "blocked",
};

type ItemResult =
  | { retired: true; entry: { id: string; done_at: string } }
  | { retired: false; item: Record<string, unknown> };

function migrateItem(
  raw: unknown,
  nowIso: string,
): ItemResult {
  if (!isRecord(raw)) {
    throw new Error("migrateV1toV2: queue entry must be an object");
  }
  const id = str(raw.id);
  if (id === null) {
    throw new Error("migrateV1toV2: queue entry must have a string id");
  }
  const status = oneOfOrNull(raw.status, V1_STATUS_VALUES);
  if (status === null) {
    throw new Error(
      `migrateV1toV2: unknown v1 status for ${id}: ${
        JSON.stringify(raw.status)
      }`,
    );
  }

  const worktree = str(raw.worktree);
  // 2.5節: done は queue を離れ completed に控える。片付けが未了 (worktree が残る)
  // item だけ resting × merged で queue に残す。
  if (status === "done" && worktree === null) {
    return { retired: true, entry: { id, done_at: nowIso } };
  }

  const review = isRecord(raw.review) ? raw.review : null;
  const progress = PROGRESS_BY_STATUS[status];
  const artifactState = deriveArtifactState(status, review);
  const run = progress === "running"
    ? buildRun(raw, review, artifactState)
    : null;
  const artifact = buildArtifact(
    artifactState,
    review,
    progress,
    run?.kind ?? null,
  );

  return {
    retired: false,
    item: {
      id,
      title: str(raw.title) ?? "",
      progress,
      run,
      // blocked_reason は progress==blocked のときだけ非 null に正規化する。
      // v1 では ["string","null"] なので、blocked なのに記録が無い入力が実在しうる
      // (v2 の blocked ノードは string を要求するので "" で埋める)。
      blocked_reason: progress === "blocked"
        ? str(raw.blocked_reason) ?? ""
        : null,
      artifact,
      worktree,
      base: str(raw.base),
      session: str(raw.session),
    },
  };
}

// ---------------------------------------------------------------------------
// トップレベル
// ---------------------------------------------------------------------------

export function migrateV1toV2(
  v1: unknown,
  nowIso: string,
): Record<string, unknown> {
  if (!isRecord(v1)) {
    throw new Error("migrateV1toV2: v1 state must be an object");
  }

  const queue: Record<string, unknown>[] = [];
  const completed: { id: string; done_at: string }[] = [];
  const rawQueue = Array.isArray(v1.queue) ? v1.queue : [];
  for (const raw of rawQueue) {
    const result = migrateItem(raw, nowIso);
    if (result.retired) {
      completed.push(result.entry);
    } else {
      queue.push(result.item);
    }
  }

  const out: Record<string, unknown> = {
    tracker: str(v1.tracker) ?? "",
    source: str(v1.source) ?? "",
    updated_at: str(v1.updated_at) ?? "",
  };
  // 3.1b節: トップレベルは completed を足す以外は変更しない。v1 で任意だったキーは
  // 有るときだけ写す (無いキーを足すと valid-legacy-live のような古い形が壊れる)。
  if ("stalled" in v1) out.stalled = oneOfOrNull(v1.stalled, STALLED_VALUES);
  if ("stalled_since" in v1) out.stalled_since = str(v1.stalled_since);
  out.schema_version = V2_SCHEMA_VERSION;
  out.queue = queue;
  out.completed = completed;
  out.candidates = structuredClone(
    Array.isArray(v1.candidates) ? v1.candidates : [],
  );
  out.relisted = structuredClone(
    Array.isArray(v1.relisted) ? v1.relisted : [],
  );
  out.promoted = strArray(v1.promoted);
  if ("withdrawn_branches" in v1) {
    out.withdrawn_branches = structuredClone(
      Array.isArray(v1.withdrawn_branches) ? v1.withdrawn_branches : [],
    );
  }
  out.history = strArray(v1.history);
  return out;
}
