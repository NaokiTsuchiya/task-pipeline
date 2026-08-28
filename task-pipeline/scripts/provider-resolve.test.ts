// task-pipeline/scripts/provider-resolve.test.ts
//
// provider-resolve.ts (class の導出と provider・model・mode の 4段解決) のユニットテスト。
// 元は pipeline-driver.test.ts の U 群にあり、解決本体が pipeline-driver.ts から
// provider-resolve.ts へ移ったのに合わせて実装の隣へ移した。class の導出 (deriveTaskClass) は
// task-policy.ts が正なので、そのテストは task-policy.test.ts にある。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//       単体なら deno test --allow-read task-pipeline/scripts/provider-resolve.test.ts

import {
  providerModeOf,
  resolveProviderModel,
  splitProviderModel,
} from "./provider-resolve.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

Deno.test("resolveProviderModel: 段1 起動引数が最優先", () => {
  const resolved = resolveProviderModel(
    "executor",
    "standard",
    { impl_provider: "claude/claude-opus-4-1" },
    { providers: { impl: "omp/anthropic/claude-sonnet-5" } },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-opus-4-1",
    source: "launch-args",
  });
});

Deno.test("resolveProviderModel: 段2 providers_by_class[class].impl", () => {
  const resolved = resolveProviderModel(
    "executor",
    "high",
    {},
    {
      providers: { impl: "claude/claude-sonnet-4-5" },
      providers_by_class: { high: { impl: "claude/claude-opus-4-1" } },
    },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-opus-4-1",
    source: "providers_by_class",
  });
});

Deno.test("resolveProviderModel: class 行の床 — standard/trivial の audit は無視して段3へ", () => {
  const resolved = resolveProviderModel(
    "verifier",
    "standard",
    {},
    {
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      providers_by_class: {
        standard: { audit: "omp/anthropic/claude-opus-4-1" },
      },
    },
  );
  assertEquals(resolved, {
    provider: "omp",
    model: "anthropic/claude-haiku-4-5",
    source: "providers",
  });
});

Deno.test("resolveProviderModel: high の audit は providers_by_class を使ってよい", () => {
  const resolved = resolveProviderModel(
    "verifier",
    "high",
    {},
    {
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      providers_by_class: { high: { audit: "omp/anthropic/claude-sonnet-5" } },
    },
  );
  assertEquals(resolved, {
    provider: "omp",
    model: "anthropic/claude-sonnet-5",
    source: "providers_by_class",
  });
});

Deno.test("resolveProviderModel: 段3 providers[category]", () => {
  const resolved = resolveProviderModel(
    "executor",
    "standard",
    {},
    { providers: { impl: "claude/claude-sonnet-4-5" } },
  );
  assertEquals(resolved, {
    provider: "claude",
    model: "claude-sonnet-4-5",
    source: "providers",
  });
});

Deno.test("resolveProviderModel: 段4 既定の組 (prefs 無し)", () => {
  assertEquals(resolveProviderModel("executor", "standard", {}, null), {
    provider: "claude",
    model: null,
    source: "default",
  });
  assertEquals(resolveProviderModel("verifier", "standard", {}, null), {
    provider: "omp",
    model: null,
    source: "default",
  });
});

// 配列値は合議ゲート専用の形である。単一解決がその片方を採ると、異種モデル合議が
// 沈黙のうちに単一検証へ降格する — 採らずに次の段へ落ちることを固定する。
Deno.test("resolveProviderModel: providers_by_class の配列値は採らず段3へ落ちる", () => {
  assertEquals(
    resolveProviderModel("verifier", "high", {}, {
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      providers_by_class: {
        high: { audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"] },
      },
    }),
    {
      provider: "omp",
      model: "anthropic/claude-haiku-4-5",
      source: "providers",
    },
  );
  assertEquals(
    resolveProviderModel("executor", "high", {}, {
      providers: { impl: "claude/claude-sonnet-4-5" },
      providers_by_class: { high: { impl: ["claude/a", "omp/b"] } },
    }),
    {
      provider: "claude",
      model: "claude-sonnet-4-5",
      source: "providers",
    },
  );
});

Deno.test("resolveProviderModel: providers の配列値・空文字も採らず段4へ落ちる", () => {
  assertEquals(
    resolveProviderModel("verifier", "high", {}, {
      providers: { audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"] },
    }),
    { provider: "omp", model: null, source: "default" },
  );
  assertEquals(
    resolveProviderModel("executor", "standard", {}, {
      providers: { impl: "" },
    }),
    { provider: "claude", model: null, source: "default" },
  );
});

Deno.test("splitProviderModel: 最初の / までが provider, 残り全部が model", () => {
  assertEquals(splitProviderModel("omp/anthropic/claude-haiku-4-5"), {
    provider: "omp",
    model: "anthropic/claude-haiku-4-5",
  });
  assertEquals(splitProviderModel("claude"), {
    provider: "claude",
    model: null,
  });
});

Deno.test("providerModeOf: claude -> bypassPermissions, omp -> full, 未知は undefined", () => {
  assertEquals(providerModeOf("claude"), "bypassPermissions");
  assertEquals(providerModeOf("omp"), "full");
  assertEquals(providerModeOf("junie"), undefined);
});
