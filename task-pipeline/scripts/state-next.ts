// task-pipeline/scripts/state-next.ts
//
// 読み取り専用 verb `next` の**導出本体** (設計 5 節「決定論」)。
//
// state.json (と state ディレクトリ内で読めるもの = `task_counts/<session>` の行数) と、
// 外から渡される 4 つの入力 (自分のセッション id / 生存セッション一覧 / 現在時刻 / 設定) だけから、
// **タスクごとの「due なアクション」と、パイプライン全体の判断**を計算する純関数群。
//
// ここに移ってくるのは、v1 まで SKILL.md の散文にしかなかった判断である:
//   1. 担当判定          … 生きている他セッションが持つタスクの除外
//   2. 追従の要否        … 追従対象の導出式 (設計 1.3) と probe リースの有効性
//   3. サイクルの分岐    … fix-start / rebase-start の due 判定 (両方保留なら rebase 優先)
//   4. ship の引数構成   … FINALIZED 後にどのフラグを渡すか
//   5. 実行の生存管理    … Status check / 引き継ぎ / 待機
//   6. 着手可否          … max_open / max_tasks / 併走の枠
//   7. 回収の後始末      … resting × merged → 片付けて retire
//   8. 観測依頼と停滞    … マージ証明・アダプタ list の依頼、stalled-set の値、24 時間の打ち切り
//
// **`next` は「次の 1 手」を決めない** — due なアクションを列挙するだけで、順序と実行は
// オーケストレータの手順書 (SKILL.md) が持つ。CLI は git もトラッカーも触れないので、
// それらが要る判断は**アクションではなく観測依頼**として返し、結果はイベント (verb) で戻る
// (設計 5.1 の最後・5.2 の表)。
//
// - Deno API を呼ばない純粋関数群。現在時刻・生存一覧・行数はすべて引数で受ける。
// - 何も書かない。lock も取らない (読み取り専用 verb の扱いは get / validate と同じ)。
// - 既にある導出関数を再実装しない: 追従対象は state-model-v2.ts の `isFollowTarget`、
//   所有権は state-ownership.ts の `classifySessionOwnership` / `isTouchable`、
//   status 導出は `deriveStatus` をそのまま呼ぶ。
//
// テスト: state-next.test.ts (直接importで検査)。実行は deno task test
// (リポジトリルートの deno.json が *.test.ts を自動検出する)。
// CLI 経路 (`state.ts next`) の観測は state.test.ts。

import {
  type ArtifactState,
  type Attention,
  type DerivedStatus,
  deriveStatus,
  type FollowRecord,
  isFollowTarget,
  makeFixAsk,
  makeFollow,
  makeProbe,
  makeRebaseAsk,
  type Progress,
  type RunKind,
} from "./state-model-v2.ts";
import {
  classifySessionOwnership,
  isTouchable,
  type OwnershipVerdict,
} from "./state-ownership.ts";
import {
  CliErrorV2,
  followOf,
  type V2ControllerLease,
  type V2Follow,
  type V2Item,
  type V2Run,
  type V2State,
} from "./state-transitions-v2.ts";

// ---------------------------------------------------------------------------
// 閾値 — SKILL.md から移した判定式の数値。**ここが唯一の所在**であり、
// docs/state-cli-contract.md の `next` 節がその転写である (SKILL.md には数値を置かない)。
//
// 不等号の向きは移す前の SKILL.md の文言をそのまま写している:
//   - 「90 分以内 → 稼働中」「90 分より古い → Status check」 … ちょうど 90 分は稼働中 (strict >)
//   - 「30 分以上経った → 引き継ぎ」                          … ちょうど 30 分は引き継ぎ (>=)
//   - 「7 時間以上経っている → 張り直し」                      … ちょうど 7 時間は失効 (>=)
//   - 「24 時間経っていたら打ち切り」                          … ちょうど 24 時間は打ち切り (>=)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** 実行エージェントが沈黙しているとみなす分数 (これ「より」古いと Status check)。 */
export const EXECUTOR_SILENT_MIN = 90;
/** 引き継ぎ待ちを打ち切って新しい実行エージェントを立てるまでの分数 (以上で発火)。 */
export const TAKEOVER_MIN = 30;
/** probe リースが失効したとみなす分数 (7 時間。以上で失効)。 */
export const PROBE_LEASE_MIN = 7 * 60;
/** 停滞したまま追従を打ち切るまでの分数 (24 時間。以上で打ち切り)。 */
export const STALLED_CUTOFF_MIN = 24 * 60;
/** 1 engagement あたりの押し直し上限 (これ以上で fix-start が上限ラッチになる)。 */
export const FIX_ATTEMPTS_LIMIT = 3;
/** gh-70: reuse_verifier を有効とみなす run.attempts の上限 (これ以上で無効=null)。 */
export const VERIFIER_REUSE_ATTEMPTS_LIMIT = 3;
/** プロジェクト全体で許す飛行中の新規タスク数 (これ以上なら着手しない)。 */
export const INFLIGHT_LIMIT = 2;
/** `max_open` の既定値。 */
export const DEFAULT_MAX_OPEN = 2;

// ---------------------------------------------------------------------------
// 設定 (`--config finish=…,max_open=…`)
// ---------------------------------------------------------------------------

export const FINISH_VALUES = ["none", "commit", "pr"] as const;
export type FinishMode = (typeof FINISH_VALUES)[number];

export const APPROVE_VALUES = ["ask", "auto"] as const;
export type ApproveMode = (typeof APPROVE_VALUES)[number];

export const REBASE_VALUES = ["auto", "off"] as const;
export type RebaseMode = (typeof REBASE_VALUES)[number];

export interface NextConfig {
  readonly finish: FinishMode;
  readonly approve: ApproveMode;
  readonly rebase: RebaseMode;
  readonly max_open: number;
  /** null は「無制限」(SKILL.md の `max_tasks` 省略時)。 */
  readonly max_tasks: number | null;
}

export const DEFAULT_NEXT_CONFIG: NextConfig = {
  finish: "none",
  approve: "ask",
  rebase: "auto",
  max_open: DEFAULT_MAX_OPEN,
  max_tasks: null,
};

function usage(message: string): CliErrorV2 {
  return new CliErrorV2("usage", message);
}

function configEnum<T extends string>(
  key: string,
  value: string,
  allowed: readonly T[],
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw usage(
    `invalid --config ${key}: ${value} (expected one of ${allowed.join(", ")})`,
  );
}

// 非負十進整数だけを受ける (state-flags.ts の parseIntFlag と同じ規律 —
// `Number("")` が 0 になる JS の規則に引きずられない)。
function configInt(key: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw usage(`invalid --config ${key}: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * `--config` の値 (`finish=pr,max_open=3` 形) を設定へ落とす。
 *
 * - 省略・空文字はすべて既定値。
 * - 未知キー・enum 外の値・整数でない値・`=` の無い断片は `usage`。
 * - 同じキーが 2 度現れたら**後勝ち** (CLI のフラグと同じ規約)。
 */
export function parseNextConfig(raw: string | undefined): NextConfig {
  if (raw === undefined || raw === "") return DEFAULT_NEXT_CONFIG;
  let config = DEFAULT_NEXT_CONFIG;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw usage(
        `invalid --config entry: ${JSON.stringify(part)} (expected key=value)`,
      );
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case "finish":
        config = { ...config, finish: configEnum(key, value, FINISH_VALUES) };
        break;
      case "approve":
        config = { ...config, approve: configEnum(key, value, APPROVE_VALUES) };
        break;
      case "rebase":
        config = { ...config, rebase: configEnum(key, value, REBASE_VALUES) };
        break;
      case "max_open":
        config = { ...config, max_open: configInt(key, value) };
        break;
      case "max_tasks":
        config = { ...config, max_tasks: configInt(key, value) };
        break;
      default:
        throw usage(`unknown --config key: ${key}`);
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// 入力と出力の形
// ---------------------------------------------------------------------------

export interface NextInput {
  /** 自分のセッション id。空文字 = 主張できない環境 (`CLAUDE_CODE_SESSION_ID` が空)。 */
  readonly session: string;
  /** 生存セッション一覧 (`sessions-alive` の返り値)。 */
  readonly alive: readonly string[];
  /** 現在時刻 (ISO)。パースできなければ `usage`。 */
  readonly now: string;
  readonly config: NextConfig;
  /** `task_counts/<session>` の行数 (無ければ 0)。`max_tasks` の判定に使う。 */
  readonly tasksStarted: number;
  /**
   * 孤児の強い証拠 (gh-114) が揃ったタスク id の列。既定は空配列。呼び出し側
   * (オーケストレーター) が `playbooks/inflight.md` の「孤児の強い証拠」の手順で
   * 読み取り専用の照会 (`paseo inspect`・run dir・worktree の git 差分) を済ませてから
   * 渡す — このモジュールはその真偽を検証しない (`--session`/`--alive` と同じ、外部で
   * 確定した値を信頼する設計)。
   */
  readonly deadEvidence: readonly string[];
}

export type ProbeRestartReason = "no-lease" | "owner-dead" | "expired";
export type TakeoverReason =
  | "takeover-elapsed"
  | "no-executor"
  | "strong-evidence";
export type WaitReason =
  | "takeover-pending"
  | "executor-alive"
  | "own-slot-busy"
  | "driver-lease";

export type NextAction =
  /** 新しいタスクの着手 (`claim`)。`start.allowed` の先頭 1 件にだけ付く。 */
  | { readonly kind: "claim" }
  /** 観測プロセスの張り直し (`probe-run`)。`catch_up` が真なら張る前に catch-up 観測。 */
  | {
    readonly kind: "probe-run";
    readonly reason: ProbeRestartReason;
    readonly catch_up: boolean;
    readonly drop_foreign_proc: boolean;
  }
  /** 修正サイクルの着手 (`fix-start`)。 */
  | {
    readonly kind: "fix-start";
    readonly findings: string;
    readonly ids: readonly string[];
    readonly fix_attempts: number;
    readonly at_limit: boolean;
    readonly reset_attempts: boolean;
  }
  /**
   * gh-18: 直前の周回で `artifact.tip` が動かず CI も落ちたままなので、`fix-start` の
   * 前に CI の失敗ジョブを1回だけ再実行する (`fix-rerun-mark` で記録してから再観測する)。
   */
  | { readonly kind: "fix-ci-rerun"; readonly tip: string }
  /**
   * gh-18: 再実行後も CI が落ちたまま tip が動いていないので、次の周を始めずに人へ
   * 委ねる (`state.ts attention-set --human <reason>` を呼ぶ)。
   */
  | { readonly kind: "fix-give-up"; readonly reason: "fix_stagnant" }
  /** 解決サイクルの着手 (`rebase-start` 入口 a)。 */
  | {
    readonly kind: "rebase-start";
    readonly blocked_onto: string;
    readonly from_tip: string | null;
  }
  /** 仕上げが併走できないので要求を預けたまま揮発資源を手放す (`release`)。 */
  | {
    readonly kind: "release";
    readonly reason: "finishing-busy";
    readonly defer: "fix-start" | "rebase-start";
  }
  /** 回収の後始末 (`retire`)。`release_first` が真なら先に `release`。 */
  | {
    readonly kind: "retire";
    readonly release_first: boolean;
    readonly cleanup: {
      readonly worktree: string | null;
      readonly branch: string | null;
    };
  }
  /** 引き継ぎ待ちの解除 (`set-takeover --clear true`)。 */
  | { readonly kind: "clear-takeover" }
  /** 新しい実行エージェントの起動 (+ `set-executor`)。 */
  | {
    readonly kind: "takeover";
    readonly reason: TakeoverReason;
    readonly resume_phase: string;
    readonly recheck_gate: boolean;
    readonly needs_worktree: boolean;
    /**
     * gh-117: 差し替え対象の `run.executor` (走っている実行エージェントが無ければ null)。
     * `set-executor --expect-executor` にそのまま渡す値で、これが古ければ CAS が弾く。
     */
    readonly replaces: string | null;
  }
  /** 沈黙した実行エージェントへの Status check (SendMessage)。 */
  | { readonly kind: "status-check" }
  /** 所有セッションが死んでいるので SendMessage を試さず引き継ぎ待ちに入る。 */
  | { readonly kind: "set-takeover"; readonly reason: "owner-dead-silent" }
  /** 何もしない (理由付き)。 */
  | { readonly kind: "wait"; readonly reason: WaitReason };

export type NextObservation =
  /** git でマージ証明を確認せよ (CLI は git を触れない)。 */
  | {
    readonly kind: "merge-proof";
    readonly tip: string;
    readonly base: string | null;
    readonly branch: string;
    readonly worktree: string | null;
  }
  /** アダプタの `list` を呼べ。 */
  | { readonly kind: "tracker-list"; readonly why: string };

export interface NextShipHint {
  /** `--ref` に何を渡すか。`none` (finish=none) では null で、4 フラグとも省略する。 */
  readonly ref_kind: "pr" | "commit" | null;
  readonly branch: string;
  readonly base: string | null;
  /** `--commits` が 1 以上のときに**まとめて**付けるフラグ (0 なら 4 つとも省略)。 */
  readonly group_flags: readonly string[];
}

export interface NextFinalize {
  readonly run_kind: RunKind;
  /** finalize 指示に `, rebase: off` を足すか。**出所は `config.rebase` だけ** (下記)。 */
  readonly rebase_off: boolean;
  readonly base: string | null;
  readonly ship: NextShipHint;
}

/** gh-70: FAIL 後の再検証を同じ verifier の再開にできるかの判定結果。 */
export interface NextGate {
  /** 再開先の agentId。再開できないとき (null / 別セッション / attempts 上限) は null。 */
  readonly reuse_verifier: string | null;
  /**
   * gh-117: `phase-fail --expect-attempts` に渡す値 (現在の `run.attempts`)。run が無ければ
   * null。並行インスタンスが先に同じラウンドを落としていれば、この値は既に古く conflict になる。
   */
  readonly attempts: number | null;
}

export interface NextTask {
  readonly id: string;
  readonly ownership: OwnershipVerdict;
  /** 生きている他セッションが所有している = このセッションは一切触らない。 */
  readonly excluded: boolean;
  readonly status: DerivedStatus;
  readonly progress: Progress;
  readonly artifact: ArtifactState;
  readonly follow_target: boolean;
  readonly gate: NextGate;
  readonly actions: readonly NextAction[];
  readonly observations: readonly NextObservation[];
  readonly finalize: NextFinalize | null;
}

export type StartBlocker =
  | "max_tasks"
  | "driver_lease"
  | "own_initial"
  | "inflight_limit"
  | "max_open";

export interface NextStart {
  readonly allowed: boolean;
  /** 該当するものを**全部**、この優先順で列挙する (最初の 1 つで打ち切らない)。 */
  readonly blocked_by: readonly StartBlocker[];
  readonly next_id: string | null;
  readonly detail: {
    readonly tasks_started: number;
    readonly max_tasks: number | null;
    readonly running_attendable_initial: number;
    readonly running_excluded_initial: number;
    readonly open_prs: number;
    readonly max_open: number;
  };
}

export type StalledSetTo = "null" | "max_open" | "defer" | "keep";

export interface NextStalled {
  readonly current: string | null;
  readonly since: string | null;
  readonly elapsed_min: number | null;
  /** `stalled-set --value` に渡す値。`defer` は `tracker-list` の結果で決まる。 */
  readonly set_to: StalledSetTo;
  readonly defer:
    | null
    | {
      readonly if_empty: "depleted";
      readonly otherwise: "null" | "max_open";
    };
  readonly cutoff: boolean;
}

export interface NextCounts {
  /** 以下 4 つは**非除外**のタスクだけを数える (除外分は `excluded`)。 */
  readonly queued: number;
  readonly running: number;
  readonly resting: number;
  readonly blocked: number;
  readonly excluded: number;
  /** `max_open` の分母 (下記 `countsOf` のコメント)。 */
  readonly open_prs: number;
  /** 新規着手を塞ぐ集合。 */
  readonly running_attendable_initial: number;
  /** 飛行中の上限 (2) の分母。 */
  readonly running_excluded_initial: number;
  /** 仕上げの併走枠 (自分のものだけ)。 */
  readonly running_mine_finishing: number;
  readonly tasks_started: number;
}

export interface NextResult {
  readonly ok: true;
  readonly now: string;
  readonly session: string | null;
  readonly config: NextConfig;
  readonly counts: NextCounts;
  readonly tasks: readonly NextTask[];
  readonly start: NextStart;
  readonly stalled: NextStalled;
  readonly observations: readonly NextObservation[];
  /**
   * `state.json` の `controller_lease` の生値 (無ければ null)。抑制が起きたかどうかは
   * `start.blocked_by` の `driver_lease` と `wait{reason: "driver-lease"}` が語るので、
   * ここには加工した派生値を置かない。
   */
  readonly controller_lease: V2ControllerLease | null;
}

// ---------------------------------------------------------------------------
// 小さな導出ヘルパ
// ---------------------------------------------------------------------------

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// 経過分。相手が null か壊れていれば null (呼び出し側が「情報が無い」として扱う)。
function elapsedMin(nowMs: number, at: string | null): number | null {
  const at0 = parseIso(at);
  return at0 === null ? null : (nowMs - at0) / MINUTE_MS;
}

// V2Follow (素データ) から導出ビュー (FollowRecord) を組む。isFollowTarget が
// 問い合わせメソッドを要求するため。使うのは軸の導出だけなので、任意フィールド
// (kind/cause/report/from_tip) は写さない。
function followRecordOf(follow: V2Follow | null): FollowRecord | null {
  if (follow === null) return null;
  const fix = follow.asks.fix;
  const rebase = follow.asks.rebase;
  return makeFollow({
    attention: follow.attention as Attention,
    asks: {
      fix: fix === null ? null : makeFixAsk({
        ids: fix.ids,
        findings: fix.findings,
        taken: fix.taken,
      }),
      rebase: rebase === null ? null : makeRebaseAsk({
        blocked_onto: rebase.blocked_onto,
        reason: rebase.reason,
        at: rebase.at,
        resolve: rebase.resolve,
        taken: rebase.taken,
      }),
    },
    probe: makeProbe({ proc: follow.probe.proc }),
  });
}

function isFinishingKind(kind: RunKind): boolean {
  return kind !== "initial";
}

// ---------------------------------------------------------------------------
// 数える集合 (設計 5.1 の「着手可否」の分母)
//
// **`open_prs` の 4 条件**: 非除外 / progress==resting / artifact.state==open /
// follow≠null。設計 5.1 の「resting×open×follow の件数」と SKILL.md の「自分の・
// artifact.state が open で ref が PR URL・まだ回収していないもの」は同じ集合である —
// follow が生まれるのは ship が open を作るときで、しかも ref が PR URL のときに限る
// (設計 1.3) ので `follow ≠ null` ⇔ `ref` が PR URL であり、「まだ回収していない」は
// `open` (回収済みは merged、取り下げは withdrawn)、「自分の」は非除外に対応する。
// **`ref` の文字列は検査しない** — トラッカーごとの URL 形式という知識を CLI に入れないため。
//
// 「自分の」を `session === self` と読まないのは、設計 5.1 の担当判定が
// 自分 / null / 死んだセッションを同じ扱い (= 触ってよい) にしているためである。
// `session === self` だけを数えると、所有セッションが死んだ PR が max_open に
// 数えられなくなる。
// ---------------------------------------------------------------------------

interface Classified {
  readonly item: V2Item;
  readonly ownership: OwnershipVerdict;
  readonly excluded: boolean;
}

function countsOf(
  classified: readonly Classified[],
  selfSession: string,
  tasksStarted: number,
): NextCounts {
  let queued = 0, running = 0, resting = 0, blocked = 0, excluded = 0;
  let openPrs = 0;
  let attendableInitial = 0, excludedInitial = 0, mineFinishing = 0;

  for (const c of classified) {
    const { item } = c;
    if (c.excluded) {
      excluded++;
      if (item.progress === "running" && item.run !== null) {
        if (!isFinishingKind(item.run.kind)) excludedInitial++;
      }
      continue;
    }
    switch (item.progress) {
      case "queued":
        queued++;
        break;
      case "running":
        running++;
        break;
      case "resting":
        resting++;
        break;
      case "blocked":
        blocked++;
        break;
    }
    if (item.progress === "resting" && item.artifact.state === "open") {
      if (item.artifact.follow !== null) openPrs++;
    }
    if (item.progress === "running" && item.run !== null) {
      if (isFinishingKind(item.run.kind)) {
        if (item.session !== null && item.session === selfSession) {
          mineFinishing++;
        }
      } else {
        attendableInitial++;
      }
    }
  }

  return {
    queued,
    running,
    resting,
    blocked,
    excluded,
    open_prs: openPrs,
    running_attendable_initial: attendableInitial,
    running_excluded_initial: excludedInitial,
    running_mine_finishing: mineFinishing,
    tasks_started: tasksStarted,
  };
}

// ---------------------------------------------------------------------------
// 実行の生存管理 (現行 playbooks/inflight.md 「飛行中の扱い」)
// ---------------------------------------------------------------------------

// 引き取りの枠。新しいタスク (kind==initial) と仕上げ (pr_fix/rebase_fix) は別枠で、
// 互いを塞がない (SKILL.md 「併走の枠」)。自分が既に同じ種類の run を**他に**持って
// いるなら引き取らない。
function takeoverSlotBusy(
  target: Classified,
  classified: readonly Classified[],
  selfSession: string,
): boolean {
  const run = target.item.run;
  if (run === null) return false;
  const wantFinishing = isFinishingKind(run.kind);
  for (const c of classified) {
    if (c.item.id === target.item.id) continue;
    if (c.excluded) continue;
    if (c.item.progress !== "running" || c.item.run === null) continue;
    if (c.item.session === null || c.item.session !== selfSession) continue;
    if (isFinishingKind(c.item.run.kind) === wantFinishing) return true;
  }
  return false;
}

function livenessAction(
  target: Classified,
  classified: readonly Classified[],
  input: NextInput,
  nowMs: number,
  driverLeaseHeld: boolean,
): NextAction {
  // Driver が制御権を握っている間、飛行中のタスクに触るアクション (takeover /
  // status-check) は Driver が実行する。ここで返しても実行するのは LLM 側なので、
  // 二重ディスパッチになる (gh-156)。
  if (driverLeaseHeld) return { kind: "wait", reason: "driver-lease" };

  const run = target.item.run;
  // progress==running のとき run は非 null (不変条件 1)。型の上の残差だけを埋める。
  if (run === null) return { kind: "wait", reason: "executor-alive" };

  const takeover = (reason: TakeoverReason): NextAction =>
    takeoverSlotBusy(target, classified, input.session)
      ? { kind: "wait", reason: "own-slot-busy" }
      : {
        kind: "takeover",
        reason,
        resume_phase: run.phase,
        // gate 判定をやり直す意味があるのは full の先頭フェーズだけである
        // (light は既に降格済みで、やり直しても同じ light に落ちる)。
        recheck_gate: run.kind === "initial" && run.gate === "full" &&
          run.phase === "research",
        needs_worktree: target.item.worktree === null,
        replaces: run.executor,
      };

  // gh-114: 孤児の強い証拠 (呼び出し側が読み取り専用の照会で確定させた値) があれば、
  // 沈黙 90 分 / 引き継ぎ待ち 30 分のどちらも待たずに即座に引き取る。自分が現に所有する
  // タスク (`self`) だけは対象から外す — 自分の生きている作業を誤って奪わないため。
  if (
    target.ownership !== "self" && input.deadEvidence.includes(target.item.id)
  ) {
    return takeover("strong-evidence");
  }

  if (run.takeover_at !== null) {
    const lastMs = parseIso(run.executor_last_event_at);
    const takeoverMs = parseIso(run.takeover_at);
    if (lastMs !== null && takeoverMs !== null && lastMs > takeoverMs) {
      return { kind: "clear-takeover" };
    }
    const waited = elapsedMin(nowMs, run.takeover_at);
    if (waited !== null && waited >= TAKEOVER_MIN) {
      return takeover("takeover-elapsed");
    }
    return { kind: "wait", reason: "takeover-pending" };
  }

  if (run.executor === null) return takeover("no-executor");

  const silent = elapsedMin(nowMs, run.executor_last_event_at);
  if (silent !== null && silent <= EXECUTOR_SILENT_MIN) {
    return { kind: "wait", reason: "executor-alive" };
  }
  // 沈黙 (時刻が無い場合を含む)。所有セッションが死んでいるなら SendMessage は届かない
  // ので試さず、失敗と同じ扱い (引き継ぎ待ちの開始) に直行する。
  return target.ownership === "dead"
    ? { kind: "set-takeover", reason: "owner-dead-silent" }
    : { kind: "status-check" };
}

// ---------------------------------------------------------------------------
// タスク 1 件の導出
// ---------------------------------------------------------------------------

function shipHintOf(item: V2Item, config: NextConfig): NextShipHint {
  const refKind = config.finish === "pr"
    ? "pr"
    : config.finish === "commit"
    ? "commit"
    : null;
  const branch = item.artifact.state === "open"
    ? item.artifact.branch
    : `task-pipeline/${item.id}`;
  return {
    ref_kind: refKind,
    branch,
    base: item.base,
    group_flags: ["ref", "branch", "tip", "base"],
  };
}

function finalizeOf(item: V2Item, config: NextConfig): NextFinalize | null {
  if (item.progress !== "running" || item.run === null) return null;
  if (item.run.phase !== "finalize") return null;
  return {
    run_kind: item.run.kind,
    // **出所は config.rebase だけ** (SKILL.md の「`rebase=off` のときだけ末尾に
    // `, rebase: off` を足す」の転写)。`asks.rebase` の控えからは導出しない —
    // `rebase-forgo` 直後の 1 回だけ切る指示は実行イベント直後の文脈であり、quiet な
    // ガード控えは `rebase-request --reason dirty|diverged|push` でも同じ形で残るので、
    // 控えの有無からは判別できない (設計 5.2 の「実行イベント」行)。
    rebase_off: config.rebase === "off",
    base: item.base,
    ship: shipHintOf(item, config),
  };
}

function probeAction(
  item: V2Item,
  input: NextInput,
  nowMs: number,
): NextAction | null {
  if (item.artifact.state !== "open") return null;
  const follow = item.artifact.follow;
  if (follow === null) return null;
  const probe = follow.probe;
  const foreign = probe.proc !== null && item.session !== input.session;

  const ownerAlive = item.session !== null &&
    (item.session === input.session || input.alive.includes(item.session));

  let reason: ProbeRestartReason | null = null;
  if (probe.proc === null) {
    reason = "no-lease";
  } else if (!ownerAlive) {
    reason = "owner-dead";
  } else {
    const age = elapsedMin(nowMs, probe.proc_started_at);
    if (age === null || age >= PROBE_LEASE_MIN) reason = "expired";
  }
  if (reason === null) return null;

  return {
    kind: "probe-run",
    reason,
    // sig が null のまま張る起動は、張る前に catch-up 観測を 1 回挟む (設計 1.3)。
    catch_up: probe.sig === null,
    drop_foreign_proc: foreign,
  };
}

function cycleAction(
  follow: V2Follow,
  finishingBusy: boolean,
  tip: string | null,
): NextAction | null {
  if (follow.attention !== "auto") return null;
  const rebase = follow.asks.rebase;
  const fix = follow.asks.fix;

  // 両方保留なら rebase を先にする (古い基点の上で指摘を直しても、載せ直しで検証前提が
  // 崩れるため。設計 5.1)。
  if (rebase !== null && !rebase.taken && rebase.resolve) {
    return finishingBusy
      ? { kind: "release", reason: "finishing-busy", defer: "rebase-start" }
      : {
        kind: "rebase-start",
        blocked_onto: rebase.blocked_onto,
        from_tip: rebase.from_tip,
      };
  }
  if (fix !== null && !fix.taken) {
    if (finishingBusy) {
      return { kind: "release", reason: "finishing-busy", defer: "fix-start" };
    }
    // gh-18: 直前に着手した周回が向き合った tip (`fix-start` が記録した
    // `ledger.fix_cycle_tip`) が現在の tip とまだ同じなら、その周回は push を
    // 生まなかった (空回り)。CI がまだ落ちているときだけこのガードの対象にする —
    // レビュー指摘だけの周回や、再実行で CI が回復した後は通常どおり続行する
    // (`rebase_fix` はこの分岐に来ない — `rebase-applied` は run を持たず
    // `fix_cycle_tip` にも触れないので対象外)。
    const stagnant = tip !== null && follow.ledger.fix_cycle_tip === tip;
    if (stagnant && follow.probe.ci === "failing") {
      if (follow.ledger.fix_rerun_tip !== tip) {
        return { kind: "fix-ci-rerun", tip };
      }
      return { kind: "fix-give-up", reason: "fix_stagnant" };
    }
    const attempts = follow.ledger.fix_attempts;
    return {
      kind: "fix-start",
      findings: fix.findings,
      ids: fix.ids,
      fix_attempts: attempts,
      // 呼べば上限ラッチに達する回数か。reset_attempts が真のときは
      // `--reset-attempts true` を添えるのでラッチしない (SKILL.md の手動復帰経路)。
      at_limit: attempts >= FIX_ATTEMPTS_LIMIT,
      reset_attempts: attempts > FIX_ATTEMPTS_LIMIT,
    };
  }
  return null;
}

// gh-70: FAIL 後の再検証を同じ verifier の再開にできるか。セッション不一致を無条件で
// null に落とすのは、起動経路に依存しない次の 2 つの理由による。Paseo 経路では agentId
// さえあれば別セッションからでも `send` が届くので (docs/paseo-subagent-2026-08.md の
// 実測 4)、「届かないから」はもう理由ではない:
//   - 二重再開を止められるのがここだけだから。Paseo 側は送信元を問わないので、同じ
//     verifier を 2 セッションが同時に再開するのを防げるのは state.json の所有権しかない。
//   - 再開先で解決される provider/model が前回と同じであることの担保だから。state.json は
//     解決結果も起動経路も持たないので、同一セッション = 同一起動引数、以外に根拠が無い。
function reuseVerifierOf(run: V2Run | null, session: string): string | null {
  if (run === null) return null;
  if (run.verifier === null) return null;
  if (run.verifier_session !== session) return null;
  if (run.attempts >= VERIFIER_REUSE_ATTEMPTS_LIMIT) return null;
  return run.verifier;
}

function deriveTask(
  c: Classified,
  classified: readonly Classified[],
  input: NextInput,
  counts: NextCounts,
  nowMs: number,
  claimId: string | null,
  driverLeaseHeld: boolean,
): NextTask {
  const { item } = c;
  const follow = followOf(item);
  const followTarget = isFollowTarget(
    item.progress,
    item.artifact.state,
    followRecordOf(follow),
  );

  const base = {
    id: item.id,
    ownership: c.ownership,
    excluded: c.excluded,
    status: deriveStatus(item.progress, item.artifact.state),
    progress: item.progress,
    artifact: item.artifact.state,
    follow_target: followTarget,
    gate: {
      reuse_verifier: reuseVerifierOf(item.run, input.session),
      attempts: item.run?.attempts ?? null,
    },
  };

  // **生きている他セッションが所有するタスクには一切触らない** — 座標だけを報告し、
  // アクションも観測依頼も出さない (SKILL.md 「セッションの所有権」)。
  if (c.excluded) {
    return { ...base, actions: [], observations: [], finalize: null };
  }

  const actions: NextAction[] = [];
  const observations: NextObservation[] = [];

  if (item.progress === "queued" && item.id === claimId) {
    actions.push({ kind: "claim" });
  }

  if (item.progress === "running") {
    actions.push(livenessAction(c, classified, input, nowMs, driverLeaseHeld));
  }

  if (item.progress === "resting") {
    if (followTarget) {
      const probe = probeAction(item, input, nowMs);
      if (probe !== null) actions.push(probe);
    } else if (follow !== null) {
      const tip = item.artifact.state === "open" ? item.artifact.tip : null;
      const cycle = cycleAction(
        follow,
        counts.running_mine_finishing >= 1,
        tip,
      );
      if (cycle !== null) actions.push(cycle);
    }
    if (item.artifact.state === "merged") {
      actions.push({
        kind: "retire",
        release_first: item.session !== null,
        cleanup: { worktree: item.worktree, branch: item.artifact.branch },
      });
    }
    if (item.artifact.state === "open" && item.artifact.tip !== null) {
      observations.push({
        kind: "merge-proof",
        tip: item.artifact.tip,
        base: item.artifact.base,
        branch: item.artifact.branch,
        worktree: item.worktree,
      });
    }
  }

  return {
    ...base,
    actions,
    observations,
    finalize: finalizeOf(item, input.config),
  };
}

// ---------------------------------------------------------------------------
// 着手可否・停滞
// ---------------------------------------------------------------------------

function startOf(
  counts: NextCounts,
  config: NextConfig,
  headQueuedId: string | null,
  driverLeaseHeld: boolean,
): NextStart {
  const blocked: StartBlocker[] = [];
  if (config.max_tasks !== null && counts.tasks_started >= config.max_tasks) {
    blocked.push("max_tasks");
  }
  // 新しいタスクの着手 (`claim`) は Driver が実行する。`next_id` を null に落とすことで
  // `claim` アクションそのものが出なくなる (deriveTask の押し込み条件が claimId 一致)。
  if (driverLeaseHeld) blocked.push("driver_lease");
  if (counts.running_attendable_initial >= 1) blocked.push("own_initial");
  if (counts.running_excluded_initial >= INFLIGHT_LIMIT) {
    blocked.push("inflight_limit");
  }
  if (counts.open_prs >= config.max_open) blocked.push("max_open");

  const allowed = blocked.length === 0;
  return {
    allowed,
    blocked_by: blocked,
    next_id: allowed ? headQueuedId : null,
    detail: {
      tasks_started: counts.tasks_started,
      max_tasks: config.max_tasks,
      running_attendable_initial: counts.running_attendable_initial,
      running_excluded_initial: counts.running_excluded_initial,
      open_prs: counts.open_prs,
      max_open: config.max_open,
    },
  };
}

function stalledOf(
  state: V2State,
  counts: NextCounts,
  start: NextStart,
  listRequested: boolean,
  nowMs: number,
): NextStalled {
  const current = state.stalled ?? null;
  const since = state.stalled_since ?? null;
  const elapsed = elapsedMin(nowMs, since);
  const cutoff = current !== null && elapsed !== null &&
    elapsed >= STALLED_CUTOFF_MIN;
  const blockedByMaxOpen = start.blocked_by.includes("max_open");

  // SKILL.md 「停滞」の記録規則の転写:
  //   自分の飛行中タスクがある / 着手する / 承認へ進む → null
  //   list を呼ぶ回は list の結果で決まる (空なら depleted、候補があれば max_open か null)
  //   max_open で見送った → max_open
  //   それ以外 (max_tasks の安全停止・飛行中の上限) は停滞の 2 種類のどちらでもないので
  //   書き換えない (keep)
  let setTo: StalledSetTo;
  let defer: NextStalled["defer"] = null;
  if (counts.running >= 1) {
    setTo = "null";
  } else if (listRequested) {
    setTo = "defer";
    defer = {
      if_empty: "depleted",
      otherwise: blockedByMaxOpen ? "max_open" : "null",
    };
  } else if (start.allowed) {
    setTo = "null";
  } else if (blockedByMaxOpen) {
    setTo = "max_open";
  } else {
    setTo = "keep";
  }

  return {
    current,
    since,
    elapsed_min: elapsed,
    set_to: setTo,
    defer,
    cutoff,
  };
}

// Controller Lease (gh-156) — Driver が実ディスパッチを握っているかの判定

/**
 * **他人の**有効な Controller Lease を返す (無ければ null)。3 条件すべてを満たすときだけ
 * 非 null になる:
 *
 *   1. `state.controller_lease` が非 null (キー欠落は null と同義)
 *   2. その `session` が呼び出し側の `--session` と**違う** — Driver 自身の `next` 呼び出しを
 *      自分の Lease で抑制してしまうと、Driver が 1 件もディスパッチできなくなる
 *   3. その `session` が生存セッション一覧に**居る** — リースの寿命はセッション台帳
 *      (`sessions/<id>` の mtime) が決める。Driver がクラッシュして release できなかった
 *      ときは、台帳が失効した時点で抑制も自然に解ける (新しい時計を持たない理由)
 */
export function activeForeignLeaseOf(
  state: V2State,
  input: NextInput,
): V2ControllerLease | null {
  const lease = state.controller_lease ?? null;
  if (lease === null) return null;
  if (lease.session === input.session) return null;
  if (!input.alive.includes(lease.session)) return null;
  return lease;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * state.json と外部入力から、タスクごとの due なアクションとパイプライン全体の判断を導く。
 * **何も書かない純関数**である (呼び出し元も lock を取らない)。
 */
export function deriveNext(state: V2State, input: NextInput): NextResult {
  const nowMs = parseIso(input.now);
  if (nowMs === null) {
    throw usage(`invalid --now: ${JSON.stringify(input.now)}`);
  }

  const driverLeaseHeld = activeForeignLeaseOf(state, input) !== null;

  const classified: Classified[] = state.queue.map((item) => {
    const ownership = classifySessionOwnership(
      item.session,
      input.session,
      input.alive,
    );
    // gh-114: 孤児の強い証拠がある非self所有のタスクは、生存一覧にまだ heartbeat が
    // 残っていても (`alive-other`) 除外しない — `livenessAction` 側の即時引き取りに進ませる。
    const evidenced = ownership !== "self" &&
      input.deadEvidence.includes(item.id);
    return { item, ownership, excluded: !isTouchable(ownership) && !evidenced };
  });

  const counts = countsOf(classified, input.session, input.tasksStarted);
  const headQueued = classified.find((c) =>
    !c.excluded && c.item.progress === "queued"
  );
  const start = startOf(
    counts,
    input.config,
    headQueued?.item.id ?? null,
    driverLeaseHeld,
  );

  // 承認へ進むのは、非除外の queued も running も無いときだけ (SKILL.md 手順 1)。
  // 着手可否 (max_open 等) とは独立で、上限に達していても list は呼ぶ。
  const listRequested = counts.queued === 0 && counts.running === 0;
  const observations: NextObservation[] = listRequested
    ? [{
      kind: "tracker-list",
      why: "no attendable queued or running task",
    }]
    : [];

  const tasks = classified.map((c) =>
    deriveTask(
      c,
      classified,
      input,
      counts,
      nowMs,
      start.next_id,
      driverLeaseHeld,
    )
  );

  return {
    ok: true,
    now: input.now,
    session: input.session === "" ? null : input.session,
    config: input.config,
    counts,
    tasks,
    start,
    stalled: stalledOf(state, counts, start, listRequested, nowMs),
    observations,
    controller_lease: state.controller_lease ?? null,
  };
}

/**
 * `task_counts/<session>` の中身から件数を数える。**`wc -l` と同じ意味論** =
 * 改行文字の数 (末尾改行の無い最終行は数えない)。playbooks/max-tasks.md が `wc -l` と書いているので、
 * CLI と手順書の数え方が食い違わないようにここを合わせる。
 */
export function countTaskLines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") count++;
  }
  return count;
}
