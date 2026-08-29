// task-pipeline/scripts/provider-resolve.ts
//
// provider・model・mode の解決。**散文の正は `playbooks/agent-launch.md`
// 「provider・model・mode の解決手順」で、この実装がその唯一の写しである** (driver も
// 合議ゲートもここを通る)。class の導出は `task-policy.ts` が正で、ここはそれを引くだけである。
//
// 解決は 4 段 (起動引数 → providers_by_class → providers → 既定の組) で、class 行の床
// (`providers_by_class.<class>.audit` を書けるのは class `high` だけ) を守る。
//
// **配列値 (`["claude/...", "omp/..."]`) は合議ゲート専用の形で、ここでは spec として採らない**
// — 単一の verifier を解決する経路が配列の片方を黙って選ぶと、異種モデル合議が沈黙のうちに
// 単一検証へ降格する。合議側の解決は dual-verifier.ts の `resolveAuditSlots` が行う。
//
// テスト: provider-resolve.test.ts (直接 import)。実行は deno task test。

import type { TaskClass } from "./task-policy.ts";

/** prefs の値。文字列は単一 spec、配列は合議の spec 列 (`high.audit` だけが使う)。 */
export type ProviderSpecValue = string | readonly string[];

export type Role = "executor" | "verifier";

export interface OrchestrationPrefs {
  readonly providers?: Record<string, ProviderSpecValue>;
  readonly providers_by_class?: Record<
    string,
    Record<string, ProviderSpecValue>
  >;
}

export interface LaunchArgs {
  readonly impl_provider?: string;
  readonly verify_provider?: string;
}

export type ProviderSource =
  | "launch-args"
  | "providers_by_class"
  | "providers"
  | "default";

export interface ResolvedProvider {
  readonly provider: string;
  readonly model: string | null;
  readonly source: ProviderSource;
}

export const ROLE_CATEGORY: Record<Role, "impl" | "audit"> = {
  executor: "impl",
  verifier: "audit",
};

// 段4: 既定の組 (実装 = claude 系 / 検証 = omp)。
const DEFAULT_PROVIDER: Record<Role, string> = {
  executor: "claude",
  verifier: "omp",
};

/** `<provider>[/<model>]` を分ける。最初の `/` までが provider (omp のモデル id 自体が
 * `/` を含むため、残り全部が model)。 */
export function splitProviderModel(
  value: string,
): { provider: string; model: string | null } {
  const idx = value.indexOf("/");
  if (idx === -1) return { provider: value, model: null };
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

export function parseOrchestrationPrefs(
  raw: string,
): OrchestrationPrefs | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (data === null || typeof data !== "object") return null;
    return data as OrchestrationPrefs;
  } catch {
    return null;
  }
}

export async function readOrchestrationPrefs(
  homeDir: string,
): Promise<OrchestrationPrefs | null> {
  if (homeDir === "") return null;
  try {
    const text = await Deno.readTextFile(
      `${homeDir}/.paseo/orchestration-preferences.json`,
    );
    return parseOrchestrationPrefs(text);
  } catch {
    return null;
  }
}

/**
 * 4段解決: 起動引数 → providers_by_class → providers → 既定の組。
 * class 行の床 (`providers_by_class.<class>.audit` を書けるのは class `high` だけ) を守る
 * — `standard`/`trivial` の `audit` は無視して段3へ落とす。
 */
export function resolveProviderModel(
  role: Role,
  taskClass: TaskClass,
  launchArgs: LaunchArgs,
  prefs: OrchestrationPrefs | null,
): ResolvedProvider {
  const category = ROLE_CATEGORY[role];

  const launchValue = role === "executor"
    ? launchArgs.impl_provider
    : launchArgs.verify_provider;
  if (launchValue) {
    return { ...splitProviderModel(launchValue), source: "launch-args" };
  }

  // 単一 spec として採れるのは非空の文字列だけである (配列は合議専用)。
  const byClass = prefs?.providers_by_class?.[taskClass]?.[category];
  const byClassValue = typeof byClass === "string" && byClass !== ""
    ? byClass
    : null;
  if (byClassValue && (category === "impl" || taskClass === "high")) {
    return {
      ...splitProviderModel(byClassValue),
      source: "providers_by_class",
    };
  }

  const providers = prefs?.providers?.[category];
  const providersValue = typeof providers === "string" && providers !== ""
    ? providers
    : null;
  if (providersValue) {
    return { ...splitProviderModel(providersValue), source: "providers" };
  }

  return { provider: DEFAULT_PROVIDER[role], model: null, source: "default" };
}

// mode は provider ごとに決まる (agent-launch.md): claude は bypassPermissions、omp は
// full。未知の provider は指定しない (`providerModeOf` が `undefined` を返す =
// `--mode` を省略する)。
const PROVIDER_MODES: Record<string, string> = {
  claude: "bypassPermissions",
  omp: "full",
};

export function providerModeOf(provider: string): string | undefined {
  return PROVIDER_MODES[provider];
}
