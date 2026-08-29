// task-pipeline/scripts/task-policy.ts
//
// タスクファイルの frontmatter 宣言 (`gate: light` / `risk: high` / `audit_mode:` / `scope:`)
// からの導出と、そこから決まる **監査ポリシー** (そのフェーズのゲートを誰が判定するか) の解決。
//
// 導出値を state.json に持たせないのは、宣言の正がトラッカー側にあり frontmatter はその
// 転写である、という gate 判定の規律をそのまま引き継ぐためである
// (`playbooks/agent-launch.md`「タスクの class」)。**`state.schema.json` は変更しない。**
//
// トポロジ (フェーズ列・ゲートの回数 = `run.gate`) とポリシー (`audit_mode`) は別軸である:
// `audit_mode` は `run.gate` を書き換えず、宣言は検証強度を **上げる方向にだけ** 効く
// (`docs/next-gen-architecture-2026-08.md` §4 の Audit Floor)。
//
// テスト: task-policy.test.ts。実行は deno task test。
// Deno API を呼ぶのは readTaskDeclaration の readTextFile 1 本だけである。

import type { Phase } from "./state-model-v2.ts";

export type TaskClass = "trivial" | "standard" | "high";

export const AUDIT_MODE_VALUES = ["shell", "single", "dual"] as const;
export type AuditMode = (typeof AUDIT_MODE_VALUES)[number];

/** 強度の順序。大きいほど強い検証で、昇格 (上げる) だけが許される。 */
const AUDIT_MODE_STRENGTH: Record<AuditMode, number> = {
  shell: 0,
  single: 1,
  dual: 2,
};

/**
 * class ごとの検証強度の床。
 *
 * `high` が `dual` なのは、単一モデルの誤 PASS が沈黙する故障だからである — 公開 API・スキーマ
 * 移行・並行性のような取り返しの付かない変更で、盲点の重なりを 1 体分に留めない
 * (`docs/dual-verifier-2026-08.md`)。合議の 2 体を構成できない環境ではゲートが成立せず
 * blocked になる (単一へは降格しない)。
 */
export const CLASS_AUDIT_FLOOR: Record<TaskClass, AuditMode> = {
  trivial: "shell",
  standard: "single",
  high: "dual",
};

/**
 * フェーズごとに、そのゲートの判定対象を機械 (シェルチェック) で判定できるか。
 *
 * `implement` 以外が偽なのは、判定対象が target project の実変更ではなく散文の成果物だから
 * である。`research` / `plan` / `research+plan` の成果物は state dir 側の run dir にあって
 * worktree には無く、この時点の worktree には実装差分もまだ無い — チェックは無変更の木に対して
 * 必ず exit 0 になり、成果物を一切見ずに PASS する経路になる。`research+plan` はさらに
 * `references/verifier.md`「宣言の再判定」を行う唯一のゲートで、ここを機械判定に置き換えると
 * `gate: light` 宣言 (= trivial = shell の床) の正当性を誰も覆せなくなる。`report` は report.md
 * の忠実性、`pr_fix` / `rebase_fix` は対応表・理由・コミット粒度・相手側の変更の残存が判定対象で、
 * いずれも読解である。
 *
 * `satisfies Record<Phase, boolean>` なのが要点で、フェーズを増やしてここへの判断を書き忘れると
 * コンパイルエラーになる。辞書引きの `?? false` にはしない — 判断の欠落が黙って「不可」に倒れると、
 * なぜ shell に入らないのかを追えなくなる。`finalize` は検証ゲートを持たないので CLI からは
 * 到達しないが、網羅を成立させるために行を持つ。
 */
export const SHELL_AUDITABLE_PHASE = {
  "research": false,
  "plan": false,
  "research+plan": false,
  "implement": true,
  "report": false,
  "finalize": false,
  "pr_fix": false,
  "rebase_fix": false,
} as const satisfies Record<Phase, boolean>;

export interface TaskDeclaration {
  readonly taskClass: TaskClass;
  readonly declaredAuditMode: AuditMode | null;
  readonly declaredScope: readonly string[] | null;
}

/**
 * frontmatter ブロック (`sed -n '2,/^---$/p'` に相当する行の並び)。1 行目が `---` でない、
 * または閉じ `---` が無いときは null。
 */
export function frontmatterBlockOf(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const closingOffset = lines.slice(1).findIndex((line) =>
    line.trim() === "---"
  );
  if (closingOffset === -1) return null;
  return lines.slice(1, 1 + closingOffset).join("\n");
}

/** 両方立っていたら `high` を採る (保守側)。 */
export function deriveTaskClass(frontmatterBlock: string): TaskClass {
  const lines = frontmatterBlock.split("\n").map((line) => line.trim());
  const hasHigh = lines.includes("risk: high");
  const hasLight = lines.includes("gate: light");
  if (hasHigh) return "high";
  if (hasLight) return "trivial";
  return "standard";
}

function declaredValueOf(
  frontmatterBlock: string,
  key: string,
): string | null {
  const prefix = `${key}: `;
  for (const raw of frontmatterBlock.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

/** 未知の値は宣言が無いものとして扱う (綴り違いで検証を弱めないため)。 */
export function deriveDeclaredAuditMode(
  frontmatterBlock: string,
): AuditMode | null {
  const value = declaredValueOf(frontmatterBlock, "audit_mode");
  if (value === null) return null;
  return (AUDIT_MODE_VALUES as readonly string[]).includes(value)
    ? value as AuditMode
    : null;
}

export function deriveDeclaredScope(
  frontmatterBlock: string,
): readonly string[] | null {
  const value = declaredValueOf(frontmatterBlock, "scope");
  if (value === null) return null;
  const patterns = value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
  return patterns.length > 0 ? patterns : null;
}

export interface AuditModeInput {
  readonly taskClass: TaskClass;
  readonly declared: AuditMode | null;
  readonly phase: string;
}

/**
 * 床と宣言の強い方を採り、`shell` に落ち着いたフェーズが機械判定できないなら `single` へ
 * 昇格する。昇格は `shell` を上げる操作だけで、`dual` を下げることはない。
 */
export function resolveAuditMode(input: AuditModeInput): AuditMode {
  const floor = CLASS_AUDIT_FLOOR[input.taskClass];
  const declared = input.declared;
  const resolved = declared !== null &&
      AUDIT_MODE_STRENGTH[declared] > AUDIT_MODE_STRENGTH[floor]
    ? declared
    : floor;
  const shellAuditable = Object.hasOwn(SHELL_AUDITABLE_PHASE, input.phase) &&
    SHELL_AUDITABLE_PHASE[input.phase as Phase];
  return resolved === "shell" && !shellAuditable ? "single" : resolved;
}

const DEFAULT_DECLARATION: TaskDeclaration = {
  taskClass: "standard",
  declaredAuditMode: null,
  declaredScope: null,
};

/** 読めない・frontmatter が閉じていないときは宣言なし扱い (= 保守側の `standard`)。 */
export async function readTaskDeclaration(
  taskMdPath: string,
): Promise<TaskDeclaration> {
  let text: string;
  try {
    text = await Deno.readTextFile(taskMdPath);
  } catch {
    return DEFAULT_DECLARATION;
  }
  const block = frontmatterBlockOf(text);
  if (block === null) return DEFAULT_DECLARATION;
  return {
    taskClass: deriveTaskClass(block),
    declaredAuditMode: deriveDeclaredAuditMode(block),
    declaredScope: deriveDeclaredScope(block),
  };
}

/** `pipeline-driver.ts` の provider 解決が引く入口 (class だけを要る側の呼び口)。 */
export async function readTaskClass(taskMdPath: string): Promise<TaskClass> {
  return (await readTaskDeclaration(taskMdPath)).taskClass;
}
