// tests/dual-verifier-contract.test.ts — 異種モデル合議ゲート (gh-159) の散文契約を固定する。
//
//   deno test --allow-read tests/dual-verifier-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 機械部分 (スロットの割り当て・パス・スナップショット・合成) は
// task-pipeline/scripts/dual-verifier.test.ts が実物で覆う。ここで固定するのは、
// **オーケストレーターが読む側の記述が合議を要求したままであること**である。壊れ方は 3 通り:
//   (a) SKILL.md の検証ゲートが手順書を指さなくなり、high でも 1 体で回る
//   (b) 不変条件 (2 体 / 異 provider / 異 family / 降格禁止) の記述が痩せる
//   (c) 設定例が「provider は違うが同じ系統」に戻り、2 体で見た記録だけが残る
// (c) は文面の読みでは気付けない (どちらも provider 名が違う) ので、JSON をパースして系統で見る。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。
// - ケース A: 現状の記述が揃っていること。ケース B: **メモリ上の複製**に退行を注入し、A 群が検知できること。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOK = new URL(
  "task-pipeline/playbooks/dual-verifier.md",
  REPO_ROOT,
);
const AGENT_LAUNCH = new URL(
  "task-pipeline/playbooks/agent-launch.md",
  REPO_ROOT,
);
const VERIFIER_MD = new URL("task-pipeline/references/verifier.md", REPO_ROOT);
const PREFS_DOC = new URL(
  "task-pipeline/docs/orchestration-preferences.md",
  REPO_ROOT,
);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const playbook = Deno.readTextFileSync(PLAYBOOK);
const agentLaunch = Deno.readTextFileSync(AGENT_LAUNCH);
const verifierMd = Deno.readTextFileSync(VERIFIER_MD);
const prefsDoc = Deno.readTextFileSync(PREFS_DOC);

/** 合議の手順書を指す参照 (SKILL.md の手順 6 とディスパッチ表の両方に要る)。 */
const PLAYBOOK_REF = "`playbooks/dual-verifier.md`";

/** 手順書が持つべき規律。**どれも欠けると 1 体で通る余地が生まれる。** */
const PLAYBOOK_NEEDLES = [
  "両 PASS 必須",
  "単一への降格禁止",
  "逐次実行",
  "--verifier` を渡さない",
  "破棄",
  "state.ts block",
] as const;

/** 不変条件の 4 条件 (agent-launch.md の 1 行に揃っていること)。 */
const INVARIANT_NEEDLE = "合議の不変条件";
const INVARIANT_EXTRAS = [
  "ちょうど 2 件",
  "provider が互いに違う",
  "系統) が互いに違う",
  "単一の verifier へ落とすことはしない",
] as const;

/** 配列が合議専用であること (単一解決が片方を採らない)。 */
const ARRAY_SCOPE_NEEDLE = "配列は合議専用の形である";

/** シェル判定の応答で合議へ振り分ける行 (実際のディスパッチのトリガー)。 */
const ROUTE_DUAL_NEEDLE = '"audit_mode": "dual"';

/** verifier.md のスロット規則 (直前の判定は同じスロット / 相手を読まない)。 */
const SLOT_RULE_NEEDLE = "異種モデル合議の 1 スロットとして起動されている";
const SLOT_RULE_EXTRAS = [
  "同じスロットの同名ファイル",
  "他のスロットの判定ファイルは読まない",
] as const;

/** `<provider>/<model>` から系統を導く (dual-verifier.ts の `modelFamilyOf` と同じ規則の照合用)。 */
function familyOf(spec: string): string | null {
  const slash = spec.indexOf("/");
  const provider = (slash === -1 ? spec : spec.slice(0, slash)).toLowerCase();
  const model = slash === -1 ? null : spec.slice(slash + 1).toLowerCase();
  if (model !== null && model.includes("/")) {
    return model.slice(0, model.indexOf("/"));
  }
  if (provider === "claude") return "anthropic";
  if (provider === "gemini") return "google";
  if (model === null) return null;
  for (
    const [prefix, family] of [
      ["claude-", "anthropic"],
      ["gpt-", "openai"],
      ["gemini-", "google"],
      ["grok-", "xai"],
    ] as const
  ) {
    if (model.startsWith(prefix)) return family;
  }
  return null;
}

/** prefs ドキュメントの JSON 例から `providers_by_class.high.audit` を取る。 */
function highAuditOf(text: string): unknown {
  for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    try {
      const parsed = JSON.parse(match[1]) as {
        providers_by_class?: { high?: { audit?: unknown } };
      };
      const audit = parsed.providers_by_class?.high?.audit;
      if (audit !== undefined) return audit;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** A5 相当の述語 — `high.audit` の例が 2 件・異 provider・異 family であるか。 */
function highAuditExampleHolds(text: string): boolean {
  const audit = highAuditOf(text);
  if (!Array.isArray(audit) || audit.length !== 2) return false;
  if (!audit.every((spec) => typeof spec === "string")) return false;
  const specs = audit as string[];
  const providers = specs.map((spec) => spec.split("/")[0].toLowerCase());
  if (providers[0] === providers[1]) return false;
  const families = specs.map(familyOf);
  if (families.some((family) => family === null)) return false;
  return families[0] !== families[1];
}

/** A2 相当の述語 — 不変条件の 4 条件が同じ行にある。 */
function invariantHolds(text: string): boolean {
  const line = grepFixedFirstLine(text, INVARIANT_NEEDLE);
  return line !== null &&
    INVARIANT_EXTRAS.every((needle) => line.includes(needle));
}

/** A4 相当の述語 — スロット規則とその 2 つの帰結が同じ行にある。 */
function slotRuleHolds(text: string): boolean {
  const line = grepFixedFirstLine(text, SLOT_RULE_NEEDLE);
  return line !== null &&
    SLOT_RULE_EXTRAS.every((needle) => line.includes(needle));
}

/** A0 相当の述語 — SKILL.md の手順 6 の節が合議の手順書を条件付きで指している。 */
function gateStepPointsToPlaybook(text: string): boolean {
  const from = text.indexOf("6. **検証ゲート**");
  if (from === -1) return false;
  const section = text.slice(from);
  const end = section.indexOf("\n### ");
  const gateStep = end === -1 ? section : section.slice(0, end);
  return containsFixed(gateStep, PLAYBOOK_REF) &&
    containsFixed(gateStep, "`audit_mode` が `dual`");
}

// A 群

Deno.test("A0 SKILL.md の検証ゲート (手順 6) が合議の手順書を指す", () => {
  assertOk(
    gateStepPointsToPlaybook(skillMd),
    `手順 6 が ${PLAYBOOK_REF} と audit_mode dual の条件を持っていない`,
  );
});

Deno.test("A1 合議の手順書が 6 つの規律を持つ", () => {
  for (const needle of PLAYBOOK_NEEDLES) {
    assertOk(
      containsFixed(playbook, needle),
      `手順書に見つからない: ${needle}`,
    );
  }
});

Deno.test("A2 agent-launch.md の不変条件が 4 条件を同じ行で述べる", () => {
  assertOk(
    invariantHolds(agentLaunch),
    `不変条件の条件が同じ行に揃っていない: ${
      JSON.stringify(grepFixedFirstLine(agentLaunch, INVARIANT_NEEDLE))
    }`,
  );
});

Deno.test("A3 配列が合議専用であること (単一解決は採らない) が書かれている", () => {
  assertOk(
    containsFixed(agentLaunch, ARRAY_SCOPE_NEEDLE),
    `見つからない: ${ARRAY_SCOPE_NEEDLE}`,
  );
});

Deno.test("A4 verifier.md がスロット付きパスの規則を持つ", () => {
  assertOk(
    slotRuleHolds(verifierMd),
    `スロット規則が同じ行に揃っていない: ${
      JSON.stringify(grepFixedFirstLine(verifierMd, SLOT_RULE_NEEDLE))
    }`,
  );
});

Deno.test("A5 prefs ドキュメントの high.audit の例が 2 件・異 provider・異 family である", () => {
  assertOk(
    highAuditExampleHolds(prefsDoc),
    `例が合議の条件を満たしていない: ${JSON.stringify(highAuditOf(prefsDoc))}`,
  );
});

Deno.test("A6 既存の class 行の床 (検証側は high だけ) が消えていない", () => {
  assertOk(
    containsFixed(
      agentLaunch,
      "検証側 (`audit`) を指定してよいのは `high` の class だけ",
    ),
    "床の記述が消えている (合議の追記で巻き込んだ疑い)",
  );
});

Deno.test("A7 シェル判定の節が audit_mode dual の行で合議の手順書へ振り分ける", () => {
  const line = grepFixedFirstLine(skillMd, ROUTE_DUAL_NEEDLE);
  assertOk(
    line !== null && line.includes(PLAYBOOK_REF),
    `route llm + audit_mode dual の行が手順書を指していない: ${
      JSON.stringify(line)
    }`,
  );
});

Deno.test("A8 class の床が dual であることが記述されている (task-policy.ts が正)", () => {
  assertOk(
    containsFixed(agentLaunch, "`risk: high` の床は `dual`"),
    "床が dual であることの参照が agent-launch.md から消えている",
  );
});

// B 群 (退行注入)

const B_CASES: readonly [string, string, (text: string) => boolean, string][] =
  [
    [
      "手順 6 から合議の手順書への参照が消える",
      skillMd.replaceAll(PLAYBOOK_REF, "`playbooks/agent-launch.md`"),
      (text) => gateStepPointsToPlaybook(text),
      "skill",
    ],
    [
      "不変条件から降格禁止が消える",
      agentLaunch.replace(
        "単一の verifier へ落とすことはしない",
        "単一の verifier で代替してよい",
      ),
      (text) => invariantHolds(text),
      "agent-launch",
    ],
    [
      "不変条件から family の条件が消える",
      agentLaunch.replace("系統) が互いに違う", "系統) は問わない"),
      (text) => invariantHolds(text),
      "agent-launch",
    ],
    [
      "verifier.md から相手スロットを読まない規律が消える",
      verifierMd.replace(
        "他のスロットの判定ファイルは読まない",
        "他のスロットの判定ファイルも読む",
      ),
      (text) => slotRuleHolds(text),
      "verifier",
    ],
    [
      "設定例が同じ系統の 2 体に戻る",
      prefsDoc.replace(
        '["claude/claude-opus-4-1", "omp/openai/gpt-5"]',
        '["claude/claude-opus-4-1", "omp/anthropic/claude-sonnet-4-5"]',
      ),
      (text) => highAuditExampleHolds(text),
      "prefs",
    ],
    [
      "設定例が 1 体だけに戻る",
      prefsDoc.replace(
        '["claude/claude-opus-4-1", "omp/openai/gpt-5"]',
        '"omp/openai/gpt-5"',
      ),
      (text) => highAuditExampleHolds(text),
      "prefs",
    ],
  ];

for (const [label, regressed, predicate, origin] of B_CASES) {
  const original = origin === "skill"
    ? skillMd
    : origin === "agent-launch"
    ? agentLaunch
    : origin === "verifier"
    ? verifierMd
    : prefsDoc;

  Deno.test(`B [${label}] への回帰注入が効いている`, () => {
    assertOk(regressed !== original, "置換が効かず元テキストと同一になった");
  });

  Deno.test(`B [${label}] を A 群相当のチェックで検知できる`, () => {
    assertOk(!predicate(regressed), "注入後も真と判定された");
  });
}
