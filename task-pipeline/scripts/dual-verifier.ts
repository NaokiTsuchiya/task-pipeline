// task-pipeline/scripts/dual-verifier.ts
//
// `audit_mode: dual` の検証ゲート (異種モデル合議 = Dual-Verifier) の機械部分。散文の正は
// `playbooks/dual-verifier.md` (手順) と `playbooks/agent-launch.md` (provider の解決と床) で、
// **判定を左右する計算はすべてここにある** — スロットの割り当て、スロット別判定ファイルのパス、
// 成果物スナップショットのダイジェスト、そして正典ファイルへの決定論的な合成である。
// LLM に任せるのは verdict の中身だけで、連結・比較・合否はこのスクリプトが行う。
//
// 合議に入るかどうかは `task-policy.ts` の `resolveAuditMode` (class の床 + frontmatter の宣言)
// が返す `audit_mode` で決まる。`risk: high` の床が `dual` なので High は常に合議になり、
// `audit_mode: dual` の宣言は class を問わず合議へ昇格する (強度は上げる方向にだけ動く)。
//
// 実行形 (verb は 4 つ):
//   deno run --no-prompt --allow-read --allow-write --allow-env --allow-run \
//     task-pipeline/scripts/dual-verifier.ts \
//     slots       --canonical <path> --task <tasks/<id>.md> --phase <phase> [--home <dir>] \
//                 [--verify-provider <spec[,spec]>] [--run-dir <dir>] [--target <path>]
//     next-slot   --canonical <path>
//     record-slot --canonical <path> --slot <a|b> --run-dir <dir> --target <path> [--agent <id>]
//     synthesize  --canonical <path>
//
// 終了コードは state.ts の `EXIT_CODES` と同じ番号を使う (10 usage / 13 missing / 15 conflict)。
// 合議の帰結 (pass / fail / discarded) はエラーではないので 0 で返し、`outcome` で分ける。
//
// 設計上の要点:
//   - **スロット別判定は `verdicts/slots/` に置く。** `verdicts/*.json` を非再帰に走査する
//     メトリクス (`docs/scripts/collect-task-metrics.py`, `count-carryover.py`) に、
//     同じ FAIL をスロットの数だけ重複して数えさせないため。
//   - **正典ファイルのパスは呼び出し元が `state.ts verdict-path` から受けたものを渡す。**
//     ここではその末尾を差し替えるだけで、フェーズ・試行回数・連番の規則は持たない。
//   - **スナップショットは `verdicts/` を含めない。** ラウンド中に書かれるスロット判定を
//     含めると、2 体目のスロットのダイジェストが必ず食い違ってラウンドが自己無効化する。
//
// テスト: dual-verifier.test.ts (純関数の直接 import + `main(argv)` 経由の CLI)。
//         実行は deno task test。

import { type CommandRunner, SubprocessRunner } from "./command-runner.ts";
import {
  type LaunchArgs,
  type OrchestrationPrefs,
  providerModeOf,
  type ProviderSource,
  readOrchestrationPrefs,
  resolveProviderModel,
  splitProviderModel,
} from "./provider-resolve.ts";
import {
  type AuditMode,
  readTaskDeclaration,
  resolveAuditMode,
  type TaskClass,
} from "./task-policy.ts";
import { parseFlags, requireFlag } from "./state-flags.ts";
import { CliErrorV2 } from "./state-transitions-v2.ts";

export const SLOTS = ["a", "b"] as const;
export type Slot = typeof SLOTS[number];

/** 正典ファイルの隣に置くスロット専用ディレクトリ (冒頭注記の理由でサブディレクトリにする)。 */
export const SLOTS_DIR = "slots";
export const MANIFEST_SCHEMA_VERSION = 1;

export type ExitCodeName = "usage" | "missing" | "conflict";

export const EXIT_CODES: Record<ExitCodeName, number> = {
  usage: 10,
  missing: 13,
  conflict: 15,
};

export class DualVerifierError extends Error {
  constructor(readonly code: ExitCodeName, message: string) {
    super(message);
  }
}

function splitCanonical(canonicalPath: string): {
  readonly dir: string;
  readonly stem: string;
} {
  if (!canonicalPath.endsWith(".json")) {
    throw new DualVerifierError(
      "usage",
      `canonical verdict path must end with .json: ${canonicalPath}`,
    );
  }
  const idx = canonicalPath.lastIndexOf("/");
  const dir = idx === -1 ? "." : canonicalPath.slice(0, idx);
  const base = idx === -1 ? canonicalPath : canonicalPath.slice(idx + 1);
  const stem = base.slice(0, -".json".length);
  if (stem === "") {
    throw new DualVerifierError(
      "usage",
      `canonical verdict path has no file name: ${canonicalPath}`,
    );
  }
  return { dir, stem };
}

export function slotVerdictPath(canonicalPath: string, slot: Slot): string {
  const { dir, stem } = splitCanonical(canonicalPath);
  return `${dir}/${SLOTS_DIR}/${stem}.${slot}.json`;
}

export function slotsManifestPath(canonicalPath: string): string {
  const { dir, stem } = splitCanonical(canonicalPath);
  return `${dir}/${SLOTS_DIR}/${stem}.slots.json`;
}

export type AuditSpecParse =
  | { readonly kind: "specs"; readonly specs: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" };

/**
 * prefs の値 (`providers_by_class.high.audit`) または起動引数 (`verify_provider=`) を
 * spec の列にする。文字列はカンマ区切り (provider・model id に `,` は現れない)。
 */
export function parseAuditSpecs(value: unknown): AuditSpecParse {
  if (value === undefined || value === null) return { kind: "absent" };

  let raw: readonly unknown[];
  if (typeof value === "string") {
    if (value.trim() === "") return { kind: "absent" };
    raw = value.split(",");
  } else if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "absent" };
    raw = value;
  } else {
    return { kind: "malformed" };
  }

  const specs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { kind: "malformed" };
    const spec = item.trim();
    if (spec === "") return { kind: "malformed" };
    specs.push(spec);
  }
  return { kind: "specs", specs };
}

// provider だけで系統が決まるもの。**omp / junie のように複数系統のモデルを載せる
// provider はここに置けない** ので、model 側から決める (下記)。
const PROVIDER_FAMILIES: Record<string, string> = {
  claude: "anthropic",
  gemini: "google",
  codex: "openai",
};

// model id が `<vendor>/<model>` 形でないときの手掛かり。**知らない綴りは推測しない** —
// 決められなければ null を返し、「同系統でないことを確かめられない」として不変条件違反にする。
const MODEL_PREFIX_FAMILIES: readonly (readonly [string, string])[] = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "google"],
  ["grok-", "xai"],
];

/**
 * spec のモデルファミリー。① model が `<vendor>/<model>` 形ならその vendor
 * (omp のモデル id がこの形) ② provider で決まるならそれ ③ model 名の既知の接頭辞
 * ④ どれでも決まらなければ null。比較は小文字で行う。
 */
export function modelFamilyOf(
  provider: string,
  model: string | null,
): string | null {
  const normalizedModel = model === null ? null : model.trim().toLowerCase();
  if (normalizedModel !== null) {
    const slash = normalizedModel.indexOf("/");
    if (slash > 0) return normalizedModel.slice(0, slash);
  }
  const byProvider = PROVIDER_FAMILIES[provider.trim().toLowerCase()];
  if (byProvider !== undefined) return byProvider;
  if (normalizedModel !== null) {
    for (const [prefix, family] of MODEL_PREFIX_FAMILIES) {
      if (normalizedModel.startsWith(prefix)) return family;
    }
  }
  return null;
}

export type InvariantReason =
  | "not-configured"
  | "single-spec"
  | "too-many-specs"
  | "duplicate-provider"
  | "same-family"
  | "unknown-family"
  | "malformed-spec";

export interface SlotAssignment {
  /** 合議のスロット。単一検証のときは null (スロットの概念が無い)。 */
  readonly slot: Slot | null;
  readonly provider: string;
  readonly model: string | null;
  readonly family: string | null;
  /** 無人実行 mode (未知の provider では null = `--mode` を渡さない)。 */
  readonly mode: string | null;
  readonly source: ProviderSource;
  readonly verdict_path: string;
}

export type AuditSlotsResolution =
  | { readonly mode: "single"; readonly slots: readonly SlotAssignment[] }
  | { readonly mode: "dual"; readonly slots: readonly SlotAssignment[] }
  | {
    readonly mode: "invalid";
    readonly reason: InvariantReason;
    readonly detail: {
      readonly specs: readonly string[];
      readonly families: readonly (string | null)[];
      readonly source: ProviderSource | null;
    };
  };

/**
 * 検証側のスロットを決める。合議に入るかどうかは **`audit_mode`** (`task-policy.ts` の
 * `resolveAuditMode` — class の床と frontmatter の宣言の強い方) で決まり、`dual` のときだけ
 * 2 スロットになる。
 *
 * **`dual` は異種 provider かつ異種モデルファミリーの 2 体でなければ `invalid` になり、単一の
 * verifier へは落ちない** — 落とせば異種モデル合議が沈黙のうちに単一検証へ降格し、誤 PASS が
 * どこにも現れなくなる (`agent-launch.md` の「class 行の床」と同じ非対称性の帰結)。`invalid` の
 * 扱いは検証エージェントを起こせないときと同じ終端 (block + 通知) で、呼び出し元が行う。
 *
 * 2 体の指定は段 1 (`verify_provider=`) と `providers_by_class.high.audit` の 2 箇所で受ける。
 * class が `high` でなくても (`audit_mode: dual` の宣言で昇格したとき) 引くのは同じ `high` の行で、
 * 検証側の指定を 1 箇所に閉じておくためである (`agent-launch.md`「class 行の床」)。
 */
export function resolveAuditSlots(
  canonicalPath: string,
  taskClass: TaskClass,
  auditMode: AuditMode,
  launchArgs: LaunchArgs,
  prefs: OrchestrationPrefs | null,
): AuditSlotsResolution {
  if (auditMode !== "dual") {
    const resolved = resolveProviderModel(
      "verifier",
      taskClass,
      launchArgs,
      prefs,
    );
    return {
      mode: "single",
      slots: [{
        slot: null,
        provider: resolved.provider,
        model: resolved.model,
        family: modelFamilyOf(resolved.provider, resolved.model),
        mode: providerModeOf(resolved.provider) ?? null,
        source: resolved.source,
        verdict_path: canonicalPath,
      }],
    };
  }

  // 段 1 (起動引数) に値があればそこで決まる — 単一値でも段 2 へは落ちない
  // (段の順序は agent-launch.md「上の段が決まればそこで止める」)。
  const fromLaunch = parseAuditSpecs(launchArgs.verify_provider);
  const source: ProviderSource = fromLaunch.kind === "absent"
    ? "providers_by_class"
    : "launch-args";
  const parsed = fromLaunch.kind === "absent"
    ? parseAuditSpecs(prefs?.providers_by_class?.high?.audit)
    : fromLaunch;

  const invalid = (
    reason: InvariantReason,
    specs: readonly string[],
    families: readonly (string | null)[],
  ): AuditSlotsResolution => ({
    mode: "invalid",
    reason,
    detail: {
      specs,
      families,
      source: parsed.kind === "specs" ? source : null,
    },
  });

  if (parsed.kind === "malformed") return invalid("malformed-spec", [], []);
  if (parsed.kind === "absent") return invalid("not-configured", [], []);

  const specs = parsed.specs;
  if (specs.length === 1) return invalid("single-spec", specs, []);
  if (specs.length > 2) return invalid("too-many-specs", specs, []);

  const split = specs.map((spec) => splitProviderModel(spec));
  if (split.some((s) => s.provider === "")) {
    return invalid("malformed-spec", specs, []);
  }
  const families = split.map((s) => modelFamilyOf(s.provider, s.model));

  if (split[0].provider.toLowerCase() === split[1].provider.toLowerCase()) {
    return invalid("duplicate-provider", specs, families);
  }
  if (families.some((family) => family === null)) {
    return invalid("unknown-family", specs, families);
  }
  if (families[0] === families[1]) {
    return invalid("same-family", specs, families);
  }

  return {
    mode: "dual",
    slots: SLOTS.map((slot, i) => ({
      slot,
      provider: split[i].provider,
      model: split[i].model,
      family: families[i],
      mode: providerModeOf(split[i].provider) ?? null,
      source,
      verdict_path: slotVerdictPath(canonicalPath, slot),
    })),
  };
}

export interface ManifestSlot {
  readonly slot: Slot;
  readonly provider: string;
  readonly model: string | null;
  readonly family: string | null;
  readonly verdict_path: string;
  readonly agent_id: string | null;
  /** そのスロットの判定が終わった時点の成果物スナップショット (未記録なら null)。 */
  readonly snapshot: string | null;
  readonly recorded_at: string | null;
}

export interface RoundManifest {
  readonly schema_version: number;
  readonly canonical: string;
  readonly baseline_snapshot: string;
  readonly created_at: string;
  readonly slots: readonly ManifestSlot[];
}

export function parseManifest(text: string): RoundManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new DualVerifierError("conflict", `manifest is not JSON: ${e}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new DualVerifierError("conflict", "manifest is not an object");
  }
  const manifest = data as RoundManifest;
  if (
    manifest.schema_version !== MANIFEST_SCHEMA_VERSION ||
    typeof manifest.canonical !== "string" ||
    typeof manifest.baseline_snapshot !== "string" ||
    !Array.isArray(manifest.slots)
  ) {
    throw new DualVerifierError("conflict", "manifest shape is unexpected");
  }
  return manifest;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await Deno.mkdir(path.slice(0, idx), { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

async function readManifest(canonicalPath: string): Promise<RoundManifest> {
  const path = slotsManifestPath(canonicalPath);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new DualVerifierError("missing", `round manifest not found: ${path}`);
  }
  return parseManifest(text);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SnapshotSource {
  readonly label: string;
  readonly digest: string;
}

/** label の昇順に畳んで 1 つのダイジェストにする (列挙順に依存しない)。 */
export function combineSnapshot(
  sources: readonly SnapshotSource[],
): Promise<string> {
  const body = [...sources]
    .sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    .map((s) => `${s.label}\u0000${s.digest}`)
    .join("\n");
  return sha256Hex(body);
}

async function fileDigest(path: string): Promise<string> {
  try {
    return await sha256Hex(await Deno.readTextFile(path));
  } catch {
    return "unreadable";
  }
}

/** run dir の成果物 (`*.md` と `watch/*.md`) を名前順に集める。 */
async function artifactSources(
  runDir: string,
): Promise<SnapshotSource[]> {
  const sources: SnapshotSource[] = [];
  for (const [dir, prefix] of [[runDir, ""], [`${runDir}/watch`, "watch/"]]) {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      sources.push({
        label: `artifact:${prefix}${entry.name}`,
        digest: await fileDigest(`${dir}/${entry.name}`),
      });
    }
  }
  return sources;
}

/** target project の作業ツリーの状態 (コミット済み + 未コミット + 未追跡)。 */
async function worktreeSources(
  runner: CommandRunner,
  targetProject: string,
): Promise<SnapshotSource[]> {
  const sources: SnapshotSource[] = [];
  const commands: readonly (readonly [string, readonly string[]])[] = [
    ["head", ["rev-parse", "HEAD"]],
    ["status", ["status", "--porcelain=v1"]],
    ["diff", ["diff", "HEAD"]],
  ];
  for (const [label, args] of commands) {
    const result = await runner.run("git", ["-C", targetProject, ...args]);
    // 非ゼロ終了も状態の一部として畳む (git repo でない target でも安定した値になる)。
    sources.push({
      label: `git:${label}`,
      digest: await sha256Hex(`${result.code}\n${result.stdout}`),
    });
  }

  const untracked = await runner.run("git", [
    "-C",
    targetProject,
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  for (const name of untracked.stdout.split("\n")) {
    if (name === "") continue;
    sources.push({
      label: `untracked:${name}`,
      digest: await fileDigest(`${targetProject}/${name}`),
    });
  }
  return sources;
}

/**
 * 成果物 (run dir の `*.md`) と target project の作業ツリーからダイジェストを作る。
 * **`verdicts/` や `*.json` は含めない** — ラウンド中に書かれるスロット判定や workspace の
 * 控えを含めると、2 体目のスロットで必ず食い違ってラウンドが自己無効化する。
 */
export async function computeSnapshot(
  runner: CommandRunner,
  input: { readonly runDir: string; readonly targetProject: string },
): Promise<string> {
  const sources = [
    ...await artifactSources(input.runDir),
    ...await worktreeSources(runner, input.targetProject),
  ];
  return await combineSnapshot(sources);
}

export interface SlotProgress {
  readonly slot: Slot;
  readonly verdict_written: boolean;
  readonly snapshot_recorded: boolean;
}

/**
 * 次に起こしてよいスロット。**判定ファイルとスナップショットの両方が揃ったスロットだけを
 * 完了とみなす** — 判定ファイルの実在だけで次へ進めると、先行スロットのスナップショットが
 * 未記録のまま 2 体目が走り、同一スナップショットの担保が消える。
 */
export function nextSlot(progress: readonly SlotProgress[]): Slot | null {
  for (const slot of SLOTS) {
    const found = progress.find((p) => p.slot === slot);
    if (found === undefined) continue;
    if (!found.verdict_written || !found.snapshot_recorded) return slot;
  }
  return null;
}

export interface SlotVerdictDoc {
  readonly phase: string;
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: readonly string[];
  readonly required_fixes: readonly string[];
  readonly carryover?: unknown;
  readonly declaration?: unknown;
}

export function parseSlotVerdict(text: string): SlotVerdictDoc | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const doc = data as Record<string, unknown>;
  if (typeof doc.phase !== "string" || doc.phase === "") return null;
  if (doc.verdict !== "PASS" && doc.verdict !== "FAIL") return null;
  const stringList = (value: unknown): readonly string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    return value.every((v) => typeof v === "string") ? value as string[] : null;
  };
  const reasons = stringList(doc.reasons);
  const requiredFixes = stringList(doc.required_fixes);
  if (reasons === null || requiredFixes === null) return null;
  return {
    phase: doc.phase,
    verdict: doc.verdict,
    reasons,
    required_fixes: requiredFixes,
    carryover: doc.carryover,
    declaration: doc.declaration,
  };
}

export interface ConsensusSlot {
  readonly slot: Slot;
  readonly provider: string;
  readonly model: string | null;
  readonly verdict: "PASS" | "FAIL";
  readonly verdict_path: string;
  readonly agent_id: string | null;
  readonly snapshot: string | null;
  readonly carryover?: unknown;
}

export interface CanonicalVerdict {
  readonly phase: string;
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: readonly string[];
  readonly required_fixes: readonly string[];
  readonly carryover?: unknown;
  readonly declaration?: unknown;
  readonly consensus: {
    readonly mode: "dual";
    readonly snapshot: string;
    readonly slots: readonly ConsensusSlot[];
  };
}

export type IncompleteReason =
  | "slot-verdict-missing"
  | "slot-verdict-malformed"
  | "snapshot-unrecorded"
  | "phase-mismatch";

export type SynthesisResult =
  | {
    readonly outcome: "pass" | "fail";
    readonly canonical: CanonicalVerdict;
  }
  | {
    readonly outcome: "discarded";
    readonly reason: "snapshot-mismatch";
    readonly detail: {
      readonly baseline: string;
      readonly slots: readonly {
        readonly slot: Slot;
        readonly snapshot: string | null;
      }[];
    };
  }
  | {
    readonly outcome: "incomplete";
    readonly reason: IncompleteReason;
    readonly detail: { readonly slots: readonly Slot[] };
  };

/** `carryover.status` の重い順 (合成後の status はこの順で最初に現れたものを採る)。 */
const CARRYOVER_STATUS_ORDER = [
  "unexplained",
  "missed",
  "unknown",
  "explained",
  "none",
] as const;

const DECLARATION_ORDER = ["overturned", "upheld"] as const;

function tag(provider: string, item: string): string {
  return `[${provider}] ${item}`;
}

function mergeCarryover(
  entries: readonly {
    readonly provider: string;
    readonly carryover: unknown;
  }[],
): unknown {
  const objects = entries.filter((e) =>
    e.carryover !== null && typeof e.carryover === "object" &&
    !Array.isArray(e.carryover)
  ) as readonly { provider: string; carryover: Record<string, unknown> }[];
  if (objects.length === 0) return undefined;

  const items: unknown[] = [];
  const whys: string[] = [];
  const statuses: string[] = [];
  for (const { provider, carryover } of objects) {
    if (typeof carryover.status === "string") statuses.push(carryover.status);
    if (typeof carryover.why === "string" && carryover.why !== "") {
      whys.push(tag(provider, carryover.why));
    }
    if (!Array.isArray(carryover.items)) continue;
    for (const item of carryover.items) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const fix = record.fix;
        items.push({
          ...record,
          fix: typeof fix === "string" ? tag(provider, fix) : fix,
        });
        continue;
      }
      items.push(item);
    }
  }
  const status = CARRYOVER_STATUS_ORDER.find((s) => statuses.includes(s)) ??
    statuses[0] ?? "unknown";
  return whys.length === 0
    ? { status, items }
    : { status, items, why: whys.join(" / ") };
}

/**
 * スロット別判定を正典 1 本にまとめる。**両スロットが PASS のときだけ PASS** で、
 * `reasons` / `required_fixes` はスロット文字順に連結して各要素の先頭に `[<provider>] ` を
 * 前置するだけである — 文言を言い換えない、まとめない、重複を落とさない (意味の合成を
 * 機械が行えば、それは監査できない判定になる)。
 */
export function synthesizeVerdict(
  manifest: RoundManifest,
  slotDocs: readonly {
    readonly slot: Slot;
    readonly doc: SlotVerdictDoc | null | undefined;
  }[],
): SynthesisResult {
  const ordered = SLOTS
    .map((slot) => ({
      slot,
      entry: manifest.slots.find((s) => s.slot === slot),
      found: slotDocs.find((d) => d.slot === slot),
    }))
    .filter((row) => row.entry !== undefined);

  const missing = ordered.filter((row) => row.found?.doc === undefined);
  if (missing.length > 0) {
    return {
      outcome: "incomplete",
      reason: "slot-verdict-missing",
      detail: { slots: missing.map((row) => row.slot) },
    };
  }
  const malformed = ordered.filter((row) => row.found?.doc === null);
  if (malformed.length > 0) {
    return {
      outcome: "incomplete",
      reason: "slot-verdict-malformed",
      detail: { slots: malformed.map((row) => row.slot) },
    };
  }
  const unrecorded = ordered.filter((row) => row.entry?.snapshot === null);
  if (unrecorded.length > 0) {
    return {
      outcome: "incomplete",
      reason: "snapshot-unrecorded",
      detail: { slots: unrecorded.map((row) => row.slot) },
    };
  }

  const rows = ordered.map((row) => ({
    slot: row.slot,
    entry: row.entry as ManifestSlot,
    doc: row.found?.doc as SlotVerdictDoc,
  }));

  const phases = new Set(rows.map((row) => row.doc.phase));
  if (phases.size !== 1) {
    return {
      outcome: "incomplete",
      reason: "phase-mismatch",
      detail: { slots: rows.map((row) => row.slot) },
    };
  }

  const drifted = rows.filter((row) =>
    row.entry.snapshot !== manifest.baseline_snapshot
  );
  if (drifted.length > 0) {
    return {
      outcome: "discarded",
      reason: "snapshot-mismatch",
      detail: {
        baseline: manifest.baseline_snapshot,
        slots: rows.map((row) => ({
          slot: row.slot,
          snapshot: row.entry.snapshot,
        })),
      },
    };
  }

  const passed = rows.every((row) => row.doc.verdict === "PASS");
  const declarations = rows
    .map((row) => row.doc.declaration)
    .filter((value): value is string => typeof value === "string");
  const declaration = DECLARATION_ORDER.find((d) => declarations.includes(d)) ??
    declarations[0];
  const carryover = mergeCarryover(
    rows.map((row) => ({
      provider: row.entry.provider,
      carryover: row.doc.carryover,
    })),
  );

  const canonical: CanonicalVerdict = {
    phase: rows[0].doc.phase,
    verdict: passed ? "PASS" : "FAIL",
    reasons: rows.flatMap((row) =>
      row.doc.reasons.map((item) => tag(row.entry.provider, item))
    ),
    required_fixes: rows.flatMap((row) =>
      row.doc.required_fixes.map((item) => tag(row.entry.provider, item))
    ),
    ...(carryover === undefined ? {} : { carryover }),
    ...(declaration === undefined ? {} : { declaration }),
    consensus: {
      mode: "dual",
      snapshot: manifest.baseline_snapshot,
      slots: rows.map((row) => ({
        slot: row.slot,
        provider: row.entry.provider,
        model: row.entry.model,
        verdict: row.doc.verdict,
        verdict_path: row.entry.verdict_path,
        agent_id: row.entry.agent_id,
        snapshot: row.entry.snapshot,
        ...(row.doc.carryover === undefined
          ? {}
          : { carryover: row.doc.carryover }),
      })),
    },
  };
  return { outcome: passed ? "pass" : "fail", canonical };
}

const ALLOWED_FLAGS: Record<string, Record<string, true>> = {
  "slots": {
    canonical: true,
    task: true,
    phase: true,
    home: true,
    "verify-provider": true,
    "run-dir": true,
    target: true,
  },
  "next-slot": { canonical: true },
  "record-slot": {
    canonical: true,
    slot: true,
    "run-dir": true,
    target: true,
    agent: true,
  },
  "synthesize": { canonical: true },
};

function asSlot(raw: string): Slot {
  const slot = SLOTS.find((s) => s === raw);
  if (slot === undefined) {
    throw new DualVerifierError("usage", `unknown slot: ${raw}`);
  }
  return slot;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

async function slotProgressOf(
  manifest: RoundManifest,
): Promise<SlotProgress[]> {
  const progress: SlotProgress[] = [];
  for (const entry of manifest.slots) {
    progress.push({
      slot: entry.slot,
      verdict_written: await fileExists(entry.verdict_path),
      snapshot_recorded: entry.snapshot !== null,
    });
  }
  return progress;
}

interface CommandOutput {
  readonly payload: unknown;
  readonly code: number;
}

async function cmdSlots(
  runner: CommandRunner,
  flags: Map<string, string>,
): Promise<CommandOutput> {
  const canonical = requireFlag(flags, "canonical");
  const taskMd = requireFlag(flags, "task");
  const phase = requireFlag(flags, "phase");
  const home = flags.get("home") ?? Deno.env.get("HOME") ?? "";
  const launchArgs: LaunchArgs = {
    verify_provider: flags.get("verify-provider"),
  };
  const prefs = await readOrchestrationPrefs(home);
  const declaration = await readTaskDeclaration(taskMd);
  const taskClass = declaration.taskClass;
  const auditMode = resolveAuditMode({
    taskClass,
    declared: declaration.declaredAuditMode,
    phase,
  });
  const resolution = resolveAuditSlots(
    canonical,
    taskClass,
    auditMode,
    launchArgs,
    prefs,
  );

  if (resolution.mode === "invalid") {
    return {
      code: EXIT_CODES.conflict,
      payload: {
        error: "invariant",
        class: taskClass,
        audit_mode: auditMode,
        reason: resolution.reason,
        detail: resolution.detail,
      },
    };
  }
  if (resolution.mode === "single") {
    return {
      code: 0,
      payload: {
        ok: true,
        class: taskClass,
        audit_mode: auditMode,
        mode: "single",
        slots: resolution.slots,
      },
    };
  }

  const runDir = requireFlag(flags, "run-dir");
  const target = requireFlag(flags, "target");
  const baseline = await computeSnapshot(runner, {
    runDir,
    targetProject: target,
  });
  const manifest: RoundManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    canonical,
    baseline_snapshot: baseline,
    created_at: new Date().toISOString(),
    slots: resolution.slots.map((slot) => ({
      slot: slot.slot as Slot,
      provider: slot.provider,
      model: slot.model,
      family: slot.family,
      verdict_path: slot.verdict_path,
      agent_id: null,
      snapshot: null,
      recorded_at: null,
    })),
  };
  const manifestPath = slotsManifestPath(canonical);
  await writeJsonAtomic(manifestPath, manifest);
  return {
    code: 0,
    payload: {
      ok: true,
      class: taskClass,
      audit_mode: auditMode,
      mode: "dual",
      manifest_path: manifestPath,
      baseline_snapshot: baseline,
      slots: resolution.slots,
    },
  };
}

async function cmdNextSlot(flags: Map<string, string>): Promise<CommandOutput> {
  const canonical = requireFlag(flags, "canonical");
  const manifest = await readManifest(canonical);
  const progress = await slotProgressOf(manifest);
  const next = nextSlot(progress);
  return {
    code: 0,
    payload: {
      ok: true,
      next,
      ready: next === null,
      slots: progress,
      verdict_path: next === null
        ? null
        : manifest.slots.find((s) => s.slot === next)?.verdict_path ?? null,
    },
  };
}

async function cmdRecordSlot(
  runner: CommandRunner,
  flags: Map<string, string>,
): Promise<CommandOutput> {
  const canonical = requireFlag(flags, "canonical");
  const slot = asSlot(requireFlag(flags, "slot"));
  const runDir = requireFlag(flags, "run-dir");
  const target = requireFlag(flags, "target");
  const manifest = await readManifest(canonical);
  const entry = manifest.slots.find((s) => s.slot === slot);
  if (entry === undefined) {
    throw new DualVerifierError(
      "usage",
      `slot ${slot} is not in the round manifest`,
    );
  }
  if (!await fileExists(entry.verdict_path)) {
    throw new DualVerifierError(
      "conflict",
      `slot ${slot} has no verdict yet: ${entry.verdict_path}`,
    );
  }
  const snapshot = await computeSnapshot(runner, {
    runDir,
    targetProject: target,
  });
  const updated: RoundManifest = {
    ...manifest,
    slots: manifest.slots.map((s) =>
      s.slot === slot
        ? {
          ...s,
          agent_id: flags.get("agent") ?? s.agent_id,
          snapshot,
          recorded_at: new Date().toISOString(),
        }
        : s
    ),
  };
  await writeJsonAtomic(slotsManifestPath(canonical), updated);
  return {
    code: 0,
    payload: {
      ok: true,
      slot,
      snapshot,
      matches_baseline: snapshot === manifest.baseline_snapshot,
    },
  };
}

async function cmdSynthesize(
  flags: Map<string, string>,
): Promise<CommandOutput> {
  const canonical = requireFlag(flags, "canonical");
  const manifest = await readManifest(canonical);
  const slotDocs: {
    slot: Slot;
    doc: SlotVerdictDoc | null | undefined;
  }[] = [];
  for (const entry of manifest.slots) {
    let text: string | undefined;
    try {
      text = await Deno.readTextFile(entry.verdict_path);
    } catch {
      text = undefined;
    }
    slotDocs.push({
      slot: entry.slot,
      doc: text === undefined ? undefined : parseSlotVerdict(text),
    });
  }

  const result = synthesizeVerdict(manifest, slotDocs);
  if (result.outcome === "incomplete") {
    return { code: EXIT_CODES.conflict, payload: result };
  }
  if (result.outcome === "discarded") {
    return { code: 0, payload: result };
  }
  await writeJsonAtomic(canonical, result.canonical);
  return {
    code: 0,
    payload: {
      ok: true,
      outcome: result.outcome,
      verdict: result.canonical.verdict,
      canonical_path: canonical,
      slots: result.canonical.consensus.slots.map((s) => ({
        slot: s.slot,
        provider: s.provider,
        verdict: s.verdict,
      })),
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [verb, ...rest] = argv;
    if (!verb) throw new DualVerifierError("usage", "verb is required");
    const allowed = ALLOWED_FLAGS[verb];
    if (allowed === undefined) {
      throw new DualVerifierError("usage", `unknown verb: ${verb}`);
    }
    const flags = parseFlags(rest);
    for (const key of flags.keys()) {
      if (allowed[key] !== true) {
        throw new DualVerifierError(
          "usage",
          `unknown flag for ${verb}: --${key}`,
        );
      }
    }
    const runner = new SubprocessRunner();
    const output = verb === "slots"
      ? await cmdSlots(runner, flags)
      : verb === "next-slot"
      ? await cmdNextSlot(flags)
      : verb === "record-slot"
      ? await cmdRecordSlot(runner, flags)
      : await cmdSynthesize(flags);
    console.log(JSON.stringify(output.payload));
    return output.code;
  } catch (e) {
    // 引数のパースは state-flags.ts を共有しているので、そちらの `CliErrorV2` も
    // 同じ終了コードへ写す (番号は state.ts の EXIT_CODES と共通)。
    const code = e instanceof DualVerifierError
      ? e.code
      : e instanceof CliErrorV2 && e.code in EXIT_CODES
      ? e.code as ExitCodeName
      : null;
    if (code === null) throw e;
    console.log(
      JSON.stringify({ error: code, message: (e as Error).message }),
    );
    return EXIT_CODES[code];
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  if (code !== 0) Deno.exit(code);
}
