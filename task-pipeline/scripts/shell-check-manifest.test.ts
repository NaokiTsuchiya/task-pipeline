// task-pipeline/scripts/shell-check-manifest.test.ts
//
// shell-check-manifest.ts のマニフェスト検証・glob・スコープ判定・3 分類。接頭辞は T-SCM-。
//
// 実行: deno task test
//   単体: deno test task-pipeline/scripts/shell-check-manifest.test.ts

import {
  buildVerdictDoc,
  type CheckOutcome,
  type CheckOutcomeKind,
  classifyVerdict,
  DEFAULT_CHECK_TIMEOUT_SEC,
  evaluateScope,
  matchesGlob,
  parseManifest,
  pathAllowed,
} from "./shell-check-manifest.ts";

function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

const MINIMAL = {
  version: 1,
  scope: { allow: ["task-pipeline/**"] },
  checks: [{ name: "lint", command: "deno", args: ["lint"] }],
};

function parsed(value: unknown) {
  return parseManifest(JSON.stringify(value));
}

Deno.test("T-SCM-ok-1: 最小構成を受理し、args/timeout_sec に既定を入れる", () => {
  const result = parsed({
    version: 1,
    scope: { allow: ["docs/**"] },
    checks: [{ name: "t", command: "true" }],
  });
  assert(result.ok, "ok");
  assertEquals(result.manifest.checks, [{
    name: "t",
    command: "true",
    args: [],
    timeout_sec: DEFAULT_CHECK_TIMEOUT_SEC,
  }]);
});

Deno.test("T-SCM-ok-2: 複数チェック・明示 timeout_sec・混在 glob を受理", () => {
  const result = parsed({
    version: 1,
    scope: { allow: ["docs/**", "src/*", "README.md"] },
    checks: [
      { name: "fmt", command: "deno", args: ["fmt", "--check"] },
      { name: "test-1", command: "deno", args: ["test"], timeout_sec: 30 },
    ],
  });
  assert(result.ok, "ok");
  assertEquals(result.manifest.checks.length, 2);
  assertEquals(result.manifest.checks[1].timeout_sec, 30);
});

const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
  ["JSON でない", "{"],
  ["トップレベルが配列", []],
  ["トップレベルが数値", 3],
  ["version 欠落", { scope: MINIMAL.scope, checks: MINIMAL.checks }],
  ["version が 2", { ...MINIMAL, version: 2 }],
  ["未知のトップレベルキー", { ...MINIMAL, run: "sh -c 'rm -rf /'" }],
  ["scope 欠落", { version: 1, checks: MINIMAL.checks }],
  ["scope が配列", { ...MINIMAL, scope: [] }],
  ["未知の scope キー", { ...MINIMAL, scope: { allow: ["a/**"], deny: [] } }],
  ["allow 欠落", { ...MINIMAL, scope: {} }],
  ["allow が空", { ...MINIMAL, scope: { allow: [] } }],
  ["allow の要素が空文字", { ...MINIMAL, scope: { allow: [""] } }],
  ["allow の要素が非文字列", { ...MINIMAL, scope: { allow: [1] } }],
  ["allow が絶対パス", { ...MINIMAL, scope: { allow: ["/etc/**"] } }],
  ["allow が親を辿る", { ...MINIMAL, scope: { allow: ["../x/**"] } }],
  ["checks 欠落", { version: 1, scope: MINIMAL.scope }],
  ["checks が空", { ...MINIMAL, checks: [] }],
  ["checks の要素が文字列", { ...MINIMAL, checks: ["deno lint"] }],
  ["未知の check キー", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", shell: true }],
  }],
  ["name 欠落", { ...MINIMAL, checks: [{ command: "true" }] }],
  ["name が大文字", { ...MINIMAL, checks: [{ name: "T", command: "true" }] }],
  ["name にパス区切り", {
    ...MINIMAL,
    checks: [{ name: "../x", command: "true" }],
  }],
  ["name が空", { ...MINIMAL, checks: [{ name: "", command: "true" }] }],
  ["name が重複", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true" }, { name: "t", command: "true" }],
  }],
  ["command 欠落", { ...MINIMAL, checks: [{ name: "t" }] }],
  ["command が空文字", { ...MINIMAL, checks: [{ name: "t", command: "" }] }],
  ["command が空白のみ", {
    ...MINIMAL,
    checks: [{ name: "t", command: "   " }],
  }],
  ["command が数値", { ...MINIMAL, checks: [{ name: "t", command: 1 }] }],
  ["args が文字列", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", args: "x" }],
  }],
  ["args の要素が数値", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", args: [1] }],
  }],
  ["timeout_sec が 0", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", timeout_sec: 0 }],
  }],
  ["timeout_sec が負", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", timeout_sec: -1 }],
  }],
  ["timeout_sec が小数", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", timeout_sec: 1.5 }],
  }],
  ["timeout_sec が文字列", {
    ...MINIMAL,
    checks: [{ name: "t", command: "true", timeout_sec: "30" }],
  }],
];

for (const [label, value] of REJECTED) {
  Deno.test(`T-SCM-ng: ${label}`, () => {
    const result = typeof value === "string"
      ? parseManifest(value)
      : parsed(value);
    assert(!result.ok, `受理してしまった: ${label}`);
    assert(result.ok === false && result.error !== "", "error 文が空");
  });
}

const GLOB_MATCH: ReadonlyArray<readonly [string, string]> = [
  ["README.md", "README.md"],
  ["docs/a.md", "docs/**"],
  ["docs/a/b.md", "docs/**"],
  ["a.ts", "**/*.ts"],
  ["x/y/a.ts", "**/*.ts"],
  ["dir/a.ts", "dir/*"],
  ["a.md", "*.md"],
  ["a/b", "a/**/b"],
  ["a/x/y/b", "a/**/b"],
];

for (const [path, pattern] of GLOB_MATCH) {
  Deno.test(`T-SCM-glob-ok: ${pattern} ← ${path}`, () => {
    assert(matchesGlob(path, pattern), "一致しなかった");
  });
}

const GLOB_NO_MATCH: ReadonlyArray<readonly [string, string]> = [
  ["dir/a/b.ts", "dir/*"],
  ["xdocs/a.md", "docs/**"],
  ["docs", "docs/**"],
  ["a.md.bak", "*.md"],
  ["x/a.md", "*.md"],
  ["dirx/a", "dir/**"],
  ["README.mdx", "README.md"],
  ["a.ts", "*.tsx"],
];

for (const [path, pattern] of GLOB_NO_MATCH) {
  Deno.test(`T-SCM-glob-ng: ${pattern} ← ${path}`, () => {
    assert(!matchesGlob(path, pattern), "一致してしまった");
  });
}

Deno.test("T-SCM-allow-1: 単一リストは or", () => {
  assert(pathAllowed("b/x", [["a/**", "b/**"]]));
});

Deno.test("T-SCM-allow-2: 複数リストは and (タスク宣言は狭めるだけ)", () => {
  assert(pathAllowed("a/x", [["a/**", "b/**"], ["a/**"]]));
  assert(!pathAllowed("b/x", [["a/**", "b/**"], ["a/**"]]), "積になっていない");
});

Deno.test("T-SCM-scope-1: 許可内なら violation 0", () => {
  const result = evaluateScope({
    changed: ["docs/a.md"],
    untracked: ["docs/b.md"],
    allowLists: [["docs/**"]],
  });
  assertEquals(result.violations, []);
});

Deno.test("T-SCM-scope-2: untracked も判定対象", () => {
  const result = evaluateScope({
    changed: ["docs/a.md"],
    untracked: ["src/x.ts"],
    allowLists: [["docs/**"]],
  });
  assertEquals(result.violations, ["src/x.ts"]);
});

Deno.test("T-SCM-scope-3: changed の違反を挙げ、重複は 1 回だけ数える", () => {
  const result = evaluateScope({
    changed: ["src/x.ts", "docs/a.md"],
    untracked: ["src/x.ts"],
    allowLists: [["docs/**"]],
  });
  assertEquals(result.violations, ["src/x.ts"]);
});

Deno.test("T-SCM-scope-4: 変更なしなら violation 0", () => {
  assertEquals(
    evaluateScope({ changed: [], untracked: [], allowLists: [["docs/**"]] })
      .violations,
    [],
  );
});

function outcome(
  name: string,
  kind: CheckOutcomeKind,
  exitCode: number | null = 0,
): CheckOutcome {
  return {
    name,
    command: "deno",
    args: ["test"],
    exit_code: exitCode,
    duration_ms: 12,
    log: `/tmp/${name}.log`,
    outcome: kind,
    error: kind === "passed" ? null : "boom",
  };
}

const CLASSIFY: ReadonlyArray<
  readonly [string, readonly CheckOutcome[], readonly string[], string]
> = [
  ["全 passed かつ違反なし", [outcome("a", "passed")], [], "PASS"],
  ["チェックが空・違反なし", [], [], "PASS"],
  ["1 件 failed", [outcome("a", "failed", 1)], [], "FAIL"],
  ["1 件 timeout", [outcome("a", "timeout", null)], [], "FAIL"],
  ["違反のみ", [outcome("a", "passed")], ["src/x.ts"], "FAIL"],
  ["failed + 違反", [outcome("a", "failed", 1)], ["src/x.ts"], "FAIL"],
  [
    "spawn-failed のみ",
    [outcome("a", "spawn-failed", null)],
    [],
    "UNAVAILABLE",
  ],
  [
    "spawn-failed + failed (spawn-failed が勝つ)",
    [outcome("a", "spawn-failed", null), outcome("b", "failed", 1)],
    [],
    "UNAVAILABLE",
  ],
  [
    "spawn-failed + 違反 (spawn-failed が勝つ)",
    [outcome("a", "spawn-failed", null)],
    ["src/x.ts"],
    "UNAVAILABLE",
  ],
  ["チェックが空 + 違反", [], ["src/x.ts"], "FAIL"],
];

for (const [label, outcomes, violations, expected] of CLASSIFY) {
  Deno.test(`T-SCM-verdict: ${label} → ${expected}`, () => {
    assertEquals(
      classifyVerdict({ outcomes, violations, infraErrors: [] }),
      expected,
    );
  });
}

Deno.test("T-SCM-verdict: インフラ異常は他の帰結に勝つ → UNAVAILABLE", () => {
  assertEquals(
    classifyVerdict({
      outcomes: [outcome("a", "failed", 1)],
      violations: ["src/x.ts"],
      infraErrors: ["git merge-base main HEAD が exit 1: "],
    }),
    "UNAVAILABLE",
  );
});

function doc(
  outcomes: readonly CheckOutcome[],
  violations: readonly string[],
  infraErrors: readonly string[] = [],
) {
  return buildVerdictDoc({
    phase: "implement",
    manifestRef: "main:TASK_PIPELINE_CHECKS.json",
    outcomes,
    violations,
    scope: { changed: ["docs/a.md"], untracked: [], violations },
    allowLists: [["docs/**"]],
    infraErrors,
  });
}

Deno.test("T-SCM-doc-1: PASS の形 (audit.mode がシェル判定の印)", () => {
  const result = doc([outcome("a", "passed")], []);
  assertEquals(result.verdict, "PASS");
  assertEquals(result.required_fixes, []);
  assertEquals(result.audit.mode, "shell");
  assertEquals(result.audit.manifest.path, "TASK_PIPELINE_CHECKS.json");
  assertEquals(result.audit.checks.length, 1);
  assert(result.reasons.length > 0, "reasons が空");
});

Deno.test("T-SCM-doc-2: FAIL の required_fixes にコマンド・exit code・ログパスが入る", () => {
  const result = doc([outcome("a", "failed", 3)], []);
  assertEquals(result.verdict, "FAIL");
  assertEquals(result.required_fixes.length, 1);
  const fix = result.required_fixes[0];
  assert(fix.includes("deno test"), `コマンドが無い: ${fix}`);
  assert(fix.includes("exit 3"), `exit code が無い: ${fix}`);
  assert(fix.includes("/tmp/a.log"), `ログパスが無い: ${fix}`);
});

Deno.test("T-SCM-doc-3: タイムアウトは required_fixes にタイムアウトと書く", () => {
  const fix = doc([outcome("a", "timeout", null)], []).required_fixes[0];
  assert(fix.includes("タイムアウト"), fix);
});

Deno.test("T-SCM-doc-4: スコープ違反は required_fixes に許可外パスと許可リストを載せる", () => {
  const result = doc([outcome("a", "passed")], ["src/x.ts"]);
  assertEquals(result.verdict, "FAIL");
  const fix = result.required_fixes.join("\n");
  assert(fix.includes("src/x.ts"), fix);
  assert(fix.includes("docs/**"), fix);
  assertEquals(result.audit.scope.violations, ["src/x.ts"]);
});

Deno.test("T-SCM-doc-5: UNAVAILABLE は required_fixes を空にし理由を reasons に置く", () => {
  const result = doc([outcome("a", "spawn-failed", null)], ["src/x.ts"]);
  assertEquals(result.verdict, "UNAVAILABLE");
  assertEquals(result.required_fixes, []);
  assert(
    result.reasons.some((r) => r.includes("起動できなかった")),
    JSON.stringify(result.reasons),
  );
});

Deno.test("T-SCM-doc-6: インフラ異常の実出力が reasons に入る", () => {
  const result = doc([], [], ["git merge-base main HEAD が exit 128: fatal"]);
  assert(
    result.reasons.some((r) => r.includes("exit 128")),
    JSON.stringify(result.reasons),
  );
});
