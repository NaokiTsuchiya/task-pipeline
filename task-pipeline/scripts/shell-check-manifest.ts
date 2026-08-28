// task-pipeline/scripts/shell-check-manifest.ts
//
// Structured Check Manifest の検証、Scope Guard のパス判定、シェル判定の 3 分類。
// **Deno API を呼ばない純粋関数群である** — ファイルの読み出し・git・サブプロセスは
// shell-check.ts 側にある。
//
// マニフェストを構造化した形 (`command` + `args` 配列) に限るのは、コマンド文字列を組み立てて
// シェルに渡す経路を作らないためである。任意の Markdown コードブロックや作業ツリーの現物からは
// 何も採らない。余分なキーを全階層で拒否するのも同じ理由で、`shell: true` のような「別の実行の
// され方」を後から差し込める形を残さない。
//
// テスト: shell-check-manifest.test.ts。実行は deno task test。

/** リポジトリルート直下の信頼済み設定。読み出しは base スナップショットからのみ。 */
export const MANIFEST_PATH = "TASK_PIPELINE_CHECKS.json";
export const MANIFEST_VERSION = 1;
export const DEFAULT_CHECK_TIMEOUT_SEC = 900;

/** ログのファイル名に使うので、パス区切り・大文字・空白を許さない。 */
const CHECK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface CheckSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout_sec: number;
}

export interface CheckManifest {
  readonly version: number;
  readonly scope: { readonly allow: readonly string[] };
  readonly checks: readonly CheckSpec[];
}

export type ManifestParse =
  | { readonly ok: true; readonly manifest: CheckManifest }
  | { readonly ok: false; readonly error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeyOf(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function allowPatternError(patterns: unknown): string | null {
  if (!Array.isArray(patterns)) return "scope.allow must be an array";
  if (patterns.length === 0) return "scope.allow must not be empty";
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return `scope.allow entries must be non-empty strings: ${
        JSON.stringify(pattern)
      }`;
    }
    if (pattern.startsWith("/")) {
      return `scope.allow entries must be repository-relative: ${pattern}`;
    }
    if (pattern.split("/").includes("..")) {
      return `scope.allow entries must not escape the repository: ${pattern}`;
    }
  }
  return null;
}

function checkSpecOf(
  raw: unknown,
  index: number,
  seenNames: readonly string[],
): { spec: CheckSpec } | { error: string } {
  const at = `checks[${index}]`;
  if (!isPlainObject(raw)) return { error: `${at} must be an object` };
  const unknownKey = unknownKeyOf(raw, [
    "name",
    "command",
    "args",
    "timeout_sec",
  ]);
  if (unknownKey !== null) {
    return { error: `${at} has an unknown key: ${unknownKey}` };
  }

  const name = raw["name"];
  if (typeof name !== "string" || !CHECK_NAME_RE.test(name)) {
    return {
      error: `${at}.name must match ${CHECK_NAME_RE.source}: ${
        JSON.stringify(name)
      }`,
    };
  }
  if (seenNames.includes(name)) {
    return { error: `${at}.name is duplicated: ${name}` };
  }

  const command = raw["command"];
  if (typeof command !== "string" || command.trim() === "") {
    return {
      error: `${at}.command must be a non-empty string: ${
        JSON.stringify(command)
      }`,
    };
  }

  const rawArgs = raw["args"];
  let args: readonly string[] = [];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs)) {
      return { error: `${at}.args must be an array` };
    }
    for (const arg of rawArgs) {
      if (typeof arg !== "string") {
        return {
          error: `${at}.args entries must be strings: ${JSON.stringify(arg)}`,
        };
      }
    }
    args = rawArgs as readonly string[];
  }

  const rawTimeout = raw["timeout_sec"];
  let timeoutSec = DEFAULT_CHECK_TIMEOUT_SEC;
  if (rawTimeout !== undefined) {
    if (
      typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) ||
      rawTimeout <= 0
    ) {
      return {
        error: `${at}.timeout_sec must be a positive integer: ${
          JSON.stringify(rawTimeout)
        }`,
      };
    }
    timeoutSec = rawTimeout;
  }

  return { spec: { name, command, args, timeout_sec: timeoutSec } };
}

export function parseManifest(text: string): ManifestParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }
  const unknownKey = unknownKeyOf(parsed, ["version", "scope", "checks"]);
  if (unknownKey !== null) {
    return { ok: false, error: `unknown top-level key: ${unknownKey}` };
  }
  if (parsed["version"] !== MANIFEST_VERSION) {
    return {
      ok: false,
      error: `version must be ${MANIFEST_VERSION}: ${
        JSON.stringify(parsed["version"])
      }`,
    };
  }

  const scope = parsed["scope"];
  if (!isPlainObject(scope)) {
    return { ok: false, error: "scope must be an object" };
  }
  const unknownScopeKey = unknownKeyOf(scope, ["allow"]);
  if (unknownScopeKey !== null) {
    return { ok: false, error: `unknown scope key: ${unknownScopeKey}` };
  }
  const allowError = allowPatternError(scope["allow"]);
  if (allowError !== null) return { ok: false, error: allowError };
  const allow = scope["allow"] as readonly string[];

  const rawChecks = parsed["checks"];
  if (!Array.isArray(rawChecks)) {
    return { ok: false, error: "checks must be an array" };
  }
  if (rawChecks.length === 0) {
    return { ok: false, error: "checks must not be empty" };
  }
  const checks: CheckSpec[] = [];
  for (let i = 0; i < rawChecks.length; i++) {
    const result = checkSpecOf(rawChecks[i], i, checks.map((c) => c.name));
    if ("error" in result) return { ok: false, error: result.error };
    checks.push(result.spec);
  }

  return {
    ok: true,
    manifest: { version: MANIFEST_VERSION, scope: { allow }, checks },
  };
}

/**
 * 対応構文は 3 つだけ: `**` は 0 個以上のパスセグメント、`*` は 1 セグメント内の 0 文字以上
 * (`/` に一致しない)、それ以外は literal (`?` も literal)。両端アンカーで、部分一致はしない。
 * セグメント単位に組むので、`docs/**` は `docs/a` と `docs/a/b` に当たり `docs` 自身には
 * 当たらない (git の出力にディレクトリ名だけの行は現れない)。
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const segments = pattern.split("/");
  let source = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      source += isLast ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    source += segment
      .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    if (!isLast) source += "/";
  }
  return new RegExp(`^${source}$`).test(path);
}

/**
 * すべての許可リストがそれぞれ 1 つ以上一致したときだけ許可する (積)。タスク側の宣言は
 * プロジェクトの許可範囲を **狭める方向にだけ** 効く。
 */
export function pathAllowed(
  path: string,
  allowLists: readonly (readonly string[])[],
): boolean {
  return allowLists.every((patterns) =>
    patterns.some((pattern) => matchesGlob(path, pattern))
  );
}

export interface ScopeInput {
  readonly changed: readonly string[];
  readonly untracked: readonly string[];
  readonly allowLists: readonly (readonly string[])[];
}

export interface ScopeResult {
  readonly changed: readonly string[];
  readonly untracked: readonly string[];
  readonly violations: readonly string[];
}

export function evaluateScope(input: ScopeInput): ScopeResult {
  const seen: string[] = [];
  const violations: string[] = [];
  for (const path of [...input.changed, ...input.untracked]) {
    if (seen.includes(path)) continue;
    seen.push(path);
    if (!pathAllowed(path, input.allowLists)) violations.push(path);
  }
  return {
    changed: input.changed,
    untracked: input.untracked,
    violations,
  };
}

export type CheckOutcomeKind = "passed" | "failed" | "timeout" | "spawn-failed";

export interface CheckOutcome {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly log: string | null;
  readonly outcome: CheckOutcomeKind;
  readonly error: string | null;
}

export type ShellVerdict = "PASS" | "FAIL" | "UNAVAILABLE";

export interface VerdictInput {
  readonly outcomes: readonly CheckOutcome[];
  readonly violations: readonly string[];
  /** チェック以前の故障 (git が起動できない・非ゼロ終了した等)。 */
  readonly infraErrors: readonly string[];
}

/**
 * インフラ異常と `spawn-failed` は他の帰結に負けない。チェックが走っていないのに FAIL や PASS を
 * 名乗ると、機械が見ていないものを判定したことになる。
 */
export function classifyVerdict(input: VerdictInput): ShellVerdict {
  if (
    input.infraErrors.length > 0 ||
    input.outcomes.some((o) => o.outcome === "spawn-failed")
  ) {
    return "UNAVAILABLE";
  }
  if (
    input.outcomes.some((o) =>
      o.outcome === "failed" || o.outcome === "timeout"
    )
  ) {
    return "FAIL";
  }
  return input.violations.length > 0 ? "FAIL" : "PASS";
}

/** ログに載せる出力の上限 (required_fixes が判定ファイルを埋め尽くさないため)。 */
export const OUTPUT_EXCERPT_LIMIT = 2000;

export function outputExcerpt(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= OUTPUT_EXCERPT_LIMIT
    ? trimmed
    : `…(先頭を省略)…${trimmed.slice(-OUTPUT_EXCERPT_LIMIT)}`;
}

export interface VerdictDocInput extends VerdictInput {
  readonly phase: string;
  readonly manifestRef: string;
  readonly scope: ScopeResult;
  readonly allowLists: readonly (readonly string[])[];
}

export interface VerdictDoc {
  readonly phase: string;
  readonly verdict: ShellVerdict;
  readonly reasons: readonly string[];
  readonly required_fixes: readonly string[];
  readonly audit: {
    readonly mode: "shell";
    readonly manifest: { readonly ref: string; readonly path: string };
    readonly checks: readonly CheckOutcome[];
    readonly scope: {
      readonly allow: readonly (readonly string[])[];
      readonly changed: readonly string[];
      readonly untracked: readonly string[];
      readonly violations: readonly string[];
    };
  };
}

function commandLineOf(outcome: CheckOutcome): string {
  return [outcome.command, ...outcome.args].join(" ");
}

/**
 * 判定 JSON。`audit.mode` がシェル判定であることの機械的な印で、`count-carryover.py` は
 * これを見て carryover 集計の分母から外す。
 */
export function buildVerdictDoc(input: VerdictDocInput): VerdictDoc {
  const verdict = classifyVerdict(input);
  const reasons: string[] = [];
  const requiredFixes: string[] = [];

  for (const outcome of input.outcomes) {
    const line = `${outcome.name}: ${commandLineOf(outcome)}`;
    if (outcome.outcome === "passed") continue;
    if (outcome.outcome === "spawn-failed") {
      reasons.push(`${line} を起動できなかった: ${outcome.error ?? "unknown"}`);
      continue;
    }
    if (outcome.outcome === "timeout") {
      requiredFixes.push(
        `${line} が ${outcome.duration_ms}ms でタイムアウトした (log: ${
          outcome.log ?? "-"
        })`,
      );
      continue;
    }
    requiredFixes.push(
      `${line} が exit ${outcome.exit_code} で終了した (log: ${
        outcome.log ?? "-"
      })${outcome.error === null ? "" : `\n${outcome.error}`}`,
    );
  }

  for (const error of input.infraErrors) reasons.push(error);

  if (input.violations.length > 0) {
    requiredFixes.push(
      `承認済みスコープの外を変更している: ${
        input.violations.join(", ")
      } (許可: ${input.allowLists.map((l) => l.join(", ")).join(" ∧ ")})`,
    );
  }

  if (verdict === "PASS") {
    reasons.push(
      `${input.outcomes.length} 件のチェックがすべて exit 0、スコープ違反なし`,
    );
  }
  if (verdict === "UNAVAILABLE") {
    // 実行できなかったものを executor に直させる対象にはしない。
    requiredFixes.length = 0;
  }

  return {
    phase: input.phase,
    verdict,
    reasons,
    required_fixes: requiredFixes,
    audit: {
      mode: "shell",
      manifest: { ref: input.manifestRef, path: MANIFEST_PATH },
      checks: input.outcomes,
      scope: {
        allow: input.allowLists,
        changed: input.scope.changed,
        untracked: input.scope.untracked,
        violations: input.scope.violations,
      },
    },
  };
}
