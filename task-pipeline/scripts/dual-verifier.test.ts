// task-pipeline/scripts/dual-verifier.test.ts
//
// dual-verifier.ts (異種モデル合議ゲートの機械部分) の検証。
//
// - U   純関数 (パス / spec の受理 / モデルファミリー / スロット解決 / 逐次 / 合成)
// - S   スナップショット (成果物の選別は実ファイル、git 成分はスタブと実 git の両方)
// - C   CLI (`main(argv)` を実際に通し、マニフェストと正典ファイルの実体を確かめる)
//
// 拒否側は「条件を緩めた誤実装」を 1 件ずつ落とす形で並べてある (例: provider だけを
// 比べる実装は「異 provider 同 family」で落ち、family だけを比べる実装は
// 「同 provider 異 family」で落ちる)。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)

import {
  combineSnapshot,
  computeSnapshot,
  EXIT_CODES,
  main,
  modelFamilyOf,
  nextSlot,
  parseAuditSpecs,
  parseSlotVerdict,
  resolveAuditSlots,
  type RoundManifest,
  type Slot,
  slotsManifestPath,
  type SlotVerdictDoc,
  slotVerdictPath,
  synthesizeVerdict,
} from "./dual-verifier.ts";
import type { CommandResult, CommandRunner } from "./command-runner.ts";
import type { OrchestrationPrefs } from "./provider-resolve.ts";

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

const CANONICAL = "/run/gh-1/verdicts/implement-0.json";

// U: スロット別パス

Deno.test("slotVerdictPath: 正典パスの末尾だけを差し替え、slots/ に置く", () => {
  assertEquals(
    slotVerdictPath(CANONICAL, "a"),
    "/run/gh-1/verdicts/slots/implement-0.a.json",
  );
  assertEquals(
    slotVerdictPath("/run/gh-1/verdicts/pr_fix-3-2.json", "b"),
    "/run/gh-1/verdicts/slots/pr_fix-3-2.b.json",
  );
  assertEquals(
    slotsManifestPath(CANONICAL),
    "/run/gh-1/verdicts/slots/implement-0.slots.json",
  );
});

Deno.test("slotVerdictPath: ディレクトリ名側の .json は差し替えの対象にしない", () => {
  assertEquals(
    slotVerdictPath("/run/x.json/verdicts/report-1.json", "a"),
    "/run/x.json/verdicts/slots/report-1.a.json",
  );
});

Deno.test("slotVerdictPath: .json で終わらない・ファイル名が無いパスは usage エラー", () => {
  for (const bad of ["/run/verdicts/report-1.txt", "", "/run/verdicts/.json"]) {
    let threw = false;
    try {
      slotVerdictPath(bad, "a");
    } catch {
      threw = true;
    }
    assert(threw, `受理してはいけない: ${JSON.stringify(bad)}`);
  }
});

// U: audit spec の受理

const SPEC_CASES: readonly [unknown, unknown, string][] = [
  ["claude/opus", { kind: "specs", specs: ["claude/opus"] }, "単一の文字列"],
  [
    "claude/opus,omp/openai/gpt-5",
    { kind: "specs", specs: ["claude/opus", "omp/openai/gpt-5"] },
    "カンマ区切りの文字列",
  ],
  [
    " claude/opus , omp/openai/gpt-5 ",
    { kind: "specs", specs: ["claude/opus", "omp/openai/gpt-5"] },
    "前後の空白は落とす",
  ],
  [
    ["claude/opus", "omp/openai/gpt-5"],
    { kind: "specs", specs: ["claude/opus", "omp/openai/gpt-5"] },
    "JSON 配列",
  ],
  [undefined, { kind: "absent" }, "キー不在"],
  [null, { kind: "absent" }, "null"],
  ["", { kind: "absent" }, "空文字"],
  ["   ", { kind: "absent" }, "空白だけ"],
  [[], { kind: "absent" }, "空配列"],
  ["claude/opus,,omp/x", { kind: "malformed" }, "空要素の混入"],
  ["claude/opus,", { kind: "malformed" }, "末尾のカンマ"],
  [["claude/opus", 7], { kind: "malformed" }, "非文字列の要素"],
  [["claude/opus", ""], { kind: "malformed" }, "空文字の要素"],
  [{ a: 1 }, { kind: "malformed" }, "オブジェクト"],
  [7, { kind: "malformed" }, "数値"],
];

for (const [value, expected, label] of SPEC_CASES) {
  Deno.test(`parseAuditSpecs: ${label}`, () => {
    assertEquals(parseAuditSpecs(value), expected);
  });
}

// U: モデルファミリー

const FAMILY_CASES: readonly [string, string | null, string | null, string][] =
  [
    [
      "omp",
      "anthropic/claude-haiku-4-5",
      "anthropic",
      "omp の vendor 付き model",
    ],
    ["omp", "openai/gpt-5", "openai", "omp の別 vendor"],
    ["claude", "claude-opus-4-1", "anthropic", "provider で決まる"],
    ["claude", null, "anthropic", "model 省略でも provider で決まる"],
    ["junie", "grok-4.5", "xai", "model 名の接頭辞で決まる"],
    ["gemini", "gemini-2.5-pro", "google", "provider で決まる (別系統)"],
    ["OMP", "Anthropic/Claude-X", "anthropic", "大文字でも同じ"],
    ["omp", null, null, "omp は model 無しでは決まらない"],
    ["mystery", "zzz-1", null, "未知の provider と未知の model"],
  ];

for (const [provider, model, expected, label] of FAMILY_CASES) {
  Deno.test(`modelFamilyOf: ${label}`, () => {
    assertEquals(modelFamilyOf(provider, model), expected);
  });
}

// U: スロットの解決 (class 不変条件)

function prefsWithHighAudit(value: unknown): OrchestrationPrefs {
  return {
    providers: { audit: "omp/anthropic/claude-haiku-4-5" },
    providers_by_class: {
      high: { audit: value as string | readonly string[] },
    },
  };
}

Deno.test("resolveAuditSlots: high + 配列 2 件 (異 provider 異 family) が合議になる", () => {
  const resolved = resolveAuditSlots(
    CANONICAL,
    "high",
    "dual",
    {},
    prefsWithHighAudit(["claude/claude-opus-4-1", "omp/openai/gpt-5"]),
  );
  assertEquals(resolved, {
    mode: "dual",
    slots: [
      {
        slot: "a",
        provider: "claude",
        model: "claude-opus-4-1",
        family: "anthropic",
        mode: "bypassPermissions",
        source: "providers_by_class",
        verdict_path: "/run/gh-1/verdicts/slots/implement-0.a.json",
      },
      {
        slot: "b",
        provider: "omp",
        model: "openai/gpt-5",
        family: "openai",
        mode: "full",
        source: "providers_by_class",
        verdict_path: "/run/gh-1/verdicts/slots/implement-0.b.json",
      },
    ],
  });
});

Deno.test("resolveAuditSlots: 段1 (verify_provider のカンマ区切り) が段2 より優先される", () => {
  const resolved = resolveAuditSlots(
    CANONICAL,
    "high",
    "dual",
    { verify_provider: "omp/openai/gpt-5,claude/claude-opus-4-1" },
    prefsWithHighAudit(["claude/claude-opus-4-1", "omp/openai/gpt-5"]),
  );
  assert(resolved.mode === "dual");
  assertEquals(
    resolved.slots.map((s) => [s.slot, s.provider, s.source]),
    [["a", "omp", "launch-args"], ["b", "claude", "launch-args"]],
  );
});

const INVARIANT_CASES: readonly [
  unknown,
  Record<string, unknown>,
  string,
  string,
][] = [
  [
    undefined,
    {},
    "not-configured",
    "high なのに audit が無い (providers.audit へ落として単一検証にしない)",
  ],
  [
    ["claude/claude-opus-4-1"],
    {},
    "single-spec",
    "1 体しか書かれていない",
  ],
  [
    ["claude/claude-opus-4-1", "omp/openai/gpt-5", "junie/grok-4.5"],
    {},
    "too-many-specs",
    "3 体以上を黙って 2 体に削らない",
  ],
  [
    ["omp/anthropic/claude-sonnet-5", "omp/openai/gpt-5"],
    {},
    "duplicate-provider",
    "同 provider (family は別) は合議にしない",
  ],
  [
    ["claude/claude-opus-4-1", "omp/anthropic/claude-sonnet-5"],
    {},
    "same-family",
    "異 provider でも同 family なら合議にしない",
  ],
  [
    ["claude/claude-opus-4-1", "omp"],
    {},
    "unknown-family",
    "family が決まらない spec は合議にしない",
  ],
  [
    ["claude/claude-opus-4-1", 7],
    {},
    "malformed-spec",
    "壊れた要素",
  ],
  [
    ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    { verify_provider: "claude/claude-opus-4-1" },
    "single-spec",
    "段1 が単一値なら段2 へは落ちない",
  ],
];

for (const [value, launchArgs, reason, label] of INVARIANT_CASES) {
  Deno.test(`resolveAuditSlots: 不変条件違反 — ${label}`, () => {
    const resolved = resolveAuditSlots(
      CANONICAL,
      "high",
      "dual",
      launchArgs,
      prefsWithHighAudit(value),
    );
    assert(
      resolved.mode === "invalid",
      `invalid になるべき: ${JSON.stringify(resolved)}`,
    );
    assertEquals(resolved.reason, reason);
  });
}

Deno.test("resolveAuditSlots: standard / trivial は合議に入らず単一で解決する", () => {
  for (const taskClass of ["standard", "trivial"] as const) {
    const resolved = resolveAuditSlots(
      CANONICAL,
      taskClass,
      "single",
      {},
      prefsWithHighAudit(["claude/claude-opus-4-1", "omp/openai/gpt-5"]),
    );
    assert(resolved.mode === "single", taskClass);
    assertEquals(resolved.slots.length, 1, taskClass);
    assertEquals(resolved.slots[0].slot, null, taskClass);
    assertEquals(resolved.slots[0].provider, "omp", taskClass);
    assertEquals(
      resolved.slots[0].model,
      "anthropic/claude-haiku-4-5",
      taskClass,
    );
    // 単一検証の判定先は正典パスそのもの (スロットの概念が無い)。
    assertEquals(resolved.slots[0].verdict_path, CANONICAL, taskClass);
  }
});

Deno.test("resolveAuditSlots: standard は class 行の audit を無視して providers へ落ちる", () => {
  const resolved = resolveAuditSlots(CANONICAL, "standard", "single", {}, {
    providers: { audit: "omp/anthropic/claude-haiku-4-5" },
    providers_by_class: {
      standard: { audit: "omp/anthropic/claude-opus-4-1" },
    },
  });
  assert(resolved.mode === "single");
  assertEquals(resolved.slots[0].model, "anthropic/claude-haiku-4-5");
  assertEquals(resolved.slots[0].source, "providers");
});

// 合議に入るかどうかを決めるのは class ではなく `audit_mode` である (class の床は
// task-policy.ts 側)。`audit_mode: dual` の宣言で昇格したタスクも、2 体の指定は
// `providers_by_class.high.audit` の 1 箇所から引く。
Deno.test("resolveAuditSlots: audit_mode が dual なら class が high でなくても合議になる", () => {
  const resolved = resolveAuditSlots(
    CANONICAL,
    "trivial",
    "dual",
    {},
    prefsWithHighAudit(["claude/claude-opus-4-1", "omp/openai/gpt-5"]),
  );
  assert(resolved.mode === "dual", JSON.stringify(resolved));
  assertEquals(
    resolved.slots.map((s) => [s.slot, s.provider, s.family]),
    [["a", "claude", "anthropic"], ["b", "omp", "openai"]],
  );
});

Deno.test("resolveAuditSlots: audit_mode が single なら high でも 1 体で解決する", () => {
  const resolved = resolveAuditSlots(
    CANONICAL,
    "high",
    "single",
    {},
    prefsWithHighAudit("omp/anthropic/claude-sonnet-5"),
  );
  assert(resolved.mode === "single", JSON.stringify(resolved));
  assertEquals(resolved.slots[0].model, "anthropic/claude-sonnet-5");
  assertEquals(resolved.slots[0].source, "providers_by_class");
});

// U: 逐次実行

const NEXT_SLOT_CASES: readonly [
  readonly [boolean, boolean],
  readonly [boolean, boolean],
  Slot | null,
  string,
][] = [
  [[false, false], [false, false], "a", "何も無ければ a"],
  [
    [true, false],
    [false, false],
    "a",
    "a の判定だけで snapshot 未記録なら a のまま",
  ],
  [[true, true], [false, false], "b", "a が完了したら b"],
  [[true, true], [true, false], "b", "b の snapshot 未記録なら b のまま"],
  [[true, true], [true, true], null, "両方完了なら null (= 合成へ)"],
];

for (const [a, b, expected, label] of NEXT_SLOT_CASES) {
  Deno.test(`nextSlot: ${label}`, () => {
    assertEquals(
      nextSlot([
        { slot: "a", verdict_written: a[0], snapshot_recorded: a[1] },
        { slot: "b", verdict_written: b[0], snapshot_recorded: b[1] },
      ]),
      expected,
    );
  });
}

// U: 決定論的な合成

const BASELINE = "snapshot-baseline";

function manifestOf(
  slots: readonly Partial<RoundManifest["slots"][number]>[],
): RoundManifest {
  return {
    schema_version: 1,
    canonical: CANONICAL,
    baseline_snapshot: BASELINE,
    created_at: "2026-08-28T00:00:00.000Z",
    slots: slots.map((slot, i) => ({
      slot: (i === 0 ? "a" : "b") as Slot,
      provider: i === 0 ? "claude" : "omp",
      model: i === 0 ? "claude-opus-4-1" : "openai/gpt-5",
      family: i === 0 ? "anthropic" : "openai",
      verdict_path: slotVerdictPath(CANONICAL, (i === 0 ? "a" : "b") as Slot),
      agent_id: i === 0 ? "agent-a" : "agent-b",
      snapshot: BASELINE,
      recorded_at: "2026-08-28T00:01:00.000Z",
      ...slot,
    })),
  };
}

function doc(
  verdict: "PASS" | "FAIL",
  extra: Partial<SlotVerdictDoc> = {},
): SlotVerdictDoc {
  return {
    phase: "implement",
    verdict,
    reasons: [],
    required_fixes: [],
    ...extra,
  };
}

Deno.test("synthesizeVerdict: 両 PASS だけが PASS になる", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("PASS", { reasons: ["ok a"] }) },
    { slot: "b", doc: doc("PASS", { reasons: ["ok b"] }) },
  ]);
  assert(result.outcome === "pass", JSON.stringify(result));
  assertEquals(result.canonical.verdict, "PASS");
  assertEquals(result.canonical.reasons, ["[claude] ok a", "[omp] ok b"]);
  assertEquals(result.canonical.consensus.mode, "dual");
  assertEquals(result.canonical.consensus.snapshot, BASELINE);
  assertEquals(
    result.canonical.consensus.slots.map((
      s,
    ) => [s.slot, s.verdict, s.agent_id]),
    [["a", "PASS", "agent-a"], ["b", "PASS", "agent-b"]],
  );
});

Deno.test("synthesizeVerdict: 片方 FAIL でラウンド全体が FAIL になる", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("PASS") },
    {
      slot: "b",
      doc: doc("FAIL", {
        reasons: ["missing class"],
        required_fixes: ["add the rejection case"],
      }),
    },
  ]);
  assert(result.outcome === "fail", JSON.stringify(result));
  assertEquals(result.canonical.verdict, "FAIL");
  assertEquals(result.canonical.reasons, ["[omp] missing class"]);
  assertEquals(result.canonical.required_fixes, [
    "[omp] add the rejection case",
  ]);
});

Deno.test("synthesizeVerdict: 両 FAIL は両方の指摘を a→b の順で持つ", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("FAIL", { required_fixes: ["fix a1", "fix a2"] }) },
    { slot: "b", doc: doc("FAIL", { required_fixes: ["fix b1"] }) },
  ]);
  assert(result.outcome === "fail");
  assertEquals(result.canonical.required_fixes, [
    "[claude] fix a1",
    "[claude] fix a2",
    "[omp] fix b1",
  ]);
});

Deno.test("synthesizeVerdict: 入力の順序に依らずスロット文字順で連結する", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "b", doc: doc("FAIL", { required_fixes: ["fix b"] }) },
    { slot: "a", doc: doc("FAIL", { required_fixes: ["fix a"] }) },
  ]);
  assert(result.outcome === "fail");
  assertEquals(result.canonical.required_fixes, [
    "[claude] fix a",
    "[omp] fix b",
  ]);
});

Deno.test("synthesizeVerdict: 同文言でも重複を落とさず、文言も書き換えない", () => {
  const same = "[omp] を含む文言もそのまま";
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("FAIL", { required_fixes: [same] }) },
    { slot: "b", doc: doc("FAIL", { required_fixes: [same] }) },
  ]);
  assert(result.outcome === "fail");
  assertEquals(result.canonical.required_fixes, [
    `[claude] ${same}`,
    `[omp] ${same}`,
  ]);
});

Deno.test("synthesizeVerdict: snapshot が baseline と違えばラウンドを破棄する", () => {
  const result = synthesizeVerdict(
    manifestOf([{}, { snapshot: "snapshot-drifted" }]),
    [
      { slot: "a", doc: doc("PASS") },
      { slot: "b", doc: doc("PASS") },
    ],
  );
  assert(result.outcome === "discarded", JSON.stringify(result));
  assertEquals(result.reason, "snapshot-mismatch");
  assertEquals(result.detail.baseline, BASELINE);
});

const INCOMPLETE_CASES: readonly [
  readonly Partial<RoundManifest["slots"][number]>[],
  readonly { slot: Slot; doc: SlotVerdictDoc | null | undefined }[],
  string,
  string,
][] = [
  [
    [{}, {}],
    [{ slot: "a", doc: doc("PASS") }, { slot: "b", doc: undefined }],
    "slot-verdict-missing",
    "スロット判定が無い",
  ],
  [
    [{}, {}],
    [{ slot: "a", doc: doc("PASS") }, { slot: "b", doc: null }],
    "slot-verdict-malformed",
    "スロット判定が壊れている",
  ],
  [
    [{}, { snapshot: null }],
    [{ slot: "a", doc: doc("PASS") }, { slot: "b", doc: doc("PASS") }],
    "snapshot-unrecorded",
    "snapshot が未記録",
  ],
  [
    [{}, {}],
    [
      { slot: "a", doc: doc("PASS") },
      { slot: "b", doc: doc("PASS", { phase: "plan" }) },
    ],
    "phase-mismatch",
    "スロット間で phase が食い違う",
  ],
];

for (const [slots, docs, reason, label] of INCOMPLETE_CASES) {
  Deno.test(`synthesizeVerdict: ${label} は incomplete`, () => {
    const result = synthesizeVerdict(manifestOf(slots), docs);
    assert(result.outcome === "incomplete", JSON.stringify(result));
    assertEquals(result.reason, reason);
  });
}

Deno.test("synthesizeVerdict: declaration はいずれかが overturned なら overturned", () => {
  const both = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("PASS", { declaration: "upheld" }) },
    { slot: "b", doc: doc("PASS", { declaration: "overturned" }) },
  ]);
  assert(both.outcome === "pass");
  assertEquals(both.canonical.declaration, "overturned");

  const upheld = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("PASS", { declaration: "upheld" }) },
    { slot: "b", doc: doc("PASS", { declaration: "upheld" }) },
  ]);
  assert(upheld.outcome === "pass");
  assertEquals(upheld.canonical.declaration, "upheld");

  const none = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("PASS") },
    { slot: "b", doc: doc("PASS") },
  ]);
  assert(none.outcome === "pass");
  assertEquals("declaration" in none.canonical, false);
});

Deno.test("synthesizeVerdict: carryover は items を連結し status は重い側を採る", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    {
      slot: "a",
      doc: doc("FAIL", {
        carryover: {
          status: "explained",
          items: [{ fix: "fix a", class: "new-branch", why: "later" }],
        },
      }),
    },
    {
      slot: "b",
      doc: doc("FAIL", {
        carryover: {
          status: "unexplained",
          items: [{ fix: "fix b", class: "unexplained", why: "" }],
        },
      }),
    },
  ]);
  assert(result.outcome === "fail");
  assertEquals(result.canonical.carryover, {
    status: "unexplained",
    items: [
      { fix: "[claude] fix a", class: "new-branch", why: "later" },
      { fix: "[omp] fix b", class: "unexplained", why: "" },
    ],
  });
  // 元の carryover はスロットごとにそのまま残す (監査のため)。
  assertEquals(
    result.canonical.consensus.slots.map((s) => s.carryover !== undefined),
    [true, true],
  );
});

Deno.test("synthesizeVerdict: carryover がどちらにも無ければフィールドを付けない", () => {
  const result = synthesizeVerdict(manifestOf([{}, {}]), [
    { slot: "a", doc: doc("FAIL") },
    { slot: "b", doc: doc("FAIL") },
  ]);
  assert(result.outcome === "fail");
  assertEquals("carryover" in result.canonical, false);
});

// U: スロット判定のパース

Deno.test("parseSlotVerdict: 最小の判定 JSON を受け、壊れた形は null", () => {
  assertEquals(
    parseSlotVerdict('{"phase":"implement","verdict":"PASS"}'),
    {
      phase: "implement",
      verdict: "PASS",
      reasons: [],
      required_fixes: [],
      carryover: undefined,
      declaration: undefined,
    },
  );
  for (
    const bad of [
      "not json",
      "[]",
      '{"verdict":"PASS"}',
      '{"phase":"implement"}',
      '{"phase":"implement","verdict":"MAYBE"}',
      '{"phase":"implement","verdict":"PASS","reasons":"x"}',
      '{"phase":"implement","verdict":"PASS","required_fixes":[1]}',
    ]
  ) {
    assertEquals(parseSlotVerdict(bad), null, bad);
  }
});

// S: スナップショット

class StubRunner implements CommandRunner {
  readonly calls: { cmd: string; args: readonly string[] }[] = [];
  constructor(
    private readonly handler: (
      cmd: string,
      args: readonly string[],
    ) => CommandResult,
  ) {}
  run(cmd: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ cmd, args: [...args] });
    return Promise.resolve(this.handler(cmd, args));
  }
}

const gitStub = (overrides: Record<string, string> = {}) =>
  new StubRunner((_cmd, args) => {
    const verb = args[2];
    const stdout = overrides[verb] ??
      (verb === "rev-parse" ? "deadbeef\n" : "");
    return { code: 0, stdout, stderr: "" };
  });

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("combineSnapshot: label の列挙順に依らない", async () => {
  const forward = await combineSnapshot([
    { label: "a", digest: "1" },
    { label: "b", digest: "2" },
  ]);
  const reverse = await combineSnapshot([
    { label: "b", digest: "2" },
    { label: "a", digest: "1" },
  ]);
  assertEquals(forward, reverse);
  const different = await combineSnapshot([
    { label: "a", digest: "1" },
    { label: "b", digest: "3" },
  ]);
  assert(forward !== different, "内容が違えば別のダイジェストになるべき");
});

Deno.test("computeSnapshot: 成果物の .md だけを見て、verdicts/ と JSON は見ない", async () => {
  await withTemp(async (dir) => {
    const runDir = `${dir}/run`;
    await Deno.mkdir(`${runDir}/verdicts/slots`, { recursive: true });
    await Deno.mkdir(`${runDir}/watch`, { recursive: true });
    await Deno.writeTextFile(`${runDir}/plan.md`, "plan v1\n");
    await Deno.writeTextFile(`${runDir}/watch/1.md`, "findings\n");
    await Deno.writeTextFile(`${runDir}/paseo-workspace.json`, "{}");
    await Deno.writeTextFile(`${runDir}/notes.txt`, "scratch");

    const snap = () =>
      computeSnapshot(gitStub(), { runDir, targetProject: dir });
    const base = await snap();
    assertEquals(await snap(), base, "同じ状態なら同じ値 (冪等)");

    await Deno.writeTextFile(
      `${runDir}/verdicts/slots/implement-0.a.json`,
      '{"verdict":"PASS"}',
    );
    await Deno.writeTextFile(`${runDir}/paseo-workspace.json`, '{"x":1}');
    await Deno.writeTextFile(`${runDir}/notes.txt`, "scratch 2");
    assertEquals(
      await snap(),
      base,
      "判定ファイル・JSON・非 md の変更では変わらない",
    );

    await Deno.writeTextFile(`${runDir}/plan.md`, "plan v2\n");
    const afterPlan = await snap();
    assert(afterPlan !== base, "成果物 (plan.md) の変更で変わるべき");

    await Deno.writeTextFile(`${runDir}/watch/1.md`, "findings 2\n");
    assert(await snap() !== afterPlan, "watch/ の findings の変更で変わるべき");
  });
});

Deno.test("computeSnapshot: git の各成分 (HEAD / status / diff / 未追跡) が効く", async () => {
  await withTemp(async (dir) => {
    const runDir = `${dir}/run`;
    await Deno.mkdir(runDir, { recursive: true });
    await Deno.writeTextFile(`${dir}/untracked.ts`, "let x = 1;\n");

    const snap = (overrides: Record<string, string> = {}) =>
      computeSnapshot(gitStub(overrides), { runDir, targetProject: dir });
    const base = await snap();
    assert(
      await snap({ "rev-parse": "cafebabe\n" }) !== base,
      "HEAD が動けば変わる",
    );
    assert(
      await snap({ status: " M src/a.ts\n" }) !== base,
      "status が変われば変わる",
    );
    assert(await snap({ diff: "@@ -1 +1 @@\n" }) !== base, "diff で変わる");

    const withUntracked = await snap({ "ls-files": "untracked.ts\n" });
    assert(withUntracked !== base, "未追跡ファイルが増えれば変わる");
    await Deno.writeTextFile(`${dir}/untracked.ts`, "let x = 2;\n");
    assert(
      await snap({ "ls-files": "untracked.ts\n" }) !== withUntracked,
      "未追跡ファイルの内容が変われば変わる",
    );
  });
});

Deno.test("computeSnapshot: run dir が無くても計算できる", async () => {
  await withTemp(async (dir) => {
    const snap = await computeSnapshot(gitStub(), {
      runDir: `${dir}/absent`,
      targetProject: dir,
    });
    assertEquals(snap.length, 64);
  });
});

// C: CLI (main を実際に通す。git は実物、prefs と task ファイルは一時ディレクトリ)

async function git(dir: string, ...args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

interface Bed {
  readonly home: string;
  readonly runDir: string;
  readonly target: string;
  readonly canonical: string;
  readonly taskMd: string;
}

async function makeBed(
  dir: string,
  opts: { readonly frontmatter: string; readonly audit?: unknown },
): Promise<Bed> {
  const home = `${dir}/home`;
  const runDir = `${dir}/.task-pipeline/runs/gh-1`;
  const target = `${dir}/project`;
  await Deno.mkdir(`${home}/.paseo`, { recursive: true });
  await Deno.mkdir(`${runDir}/verdicts`, { recursive: true });
  await Deno.mkdir(`${dir}/.task-pipeline/tasks`, { recursive: true });
  await Deno.mkdir(target, { recursive: true });
  await Deno.writeTextFile(`${runDir}/implementation.md`, "done\n");
  await Deno.writeTextFile(
    `${home}/.paseo/orchestration-preferences.json`,
    JSON.stringify({
      providers: { audit: "omp/anthropic/claude-haiku-4-5" },
      ...(opts.audit === undefined
        ? {}
        : { providers_by_class: { high: { audit: opts.audit } } }),
    }),
  );
  const taskMd = `${dir}/.task-pipeline/tasks/gh-1.md`;
  await Deno.writeTextFile(
    taskMd,
    `---\nid: gh-1\n${opts.frontmatter}---\n\nbody\n`,
  );
  await git(target, "init", "-q", "-b", "main");
  await git(target, "config", "user.email", "t@example.com");
  await git(target, "config", "user.name", "t");
  await Deno.writeTextFile(`${target}/tracked.ts`, "export const a = 1;\n");
  await git(target, "add", "-A");
  await git(target, "commit", "-q", "-m", "init");
  return {
    home,
    runDir,
    target,
    canonical: `${runDir}/verdicts/implement-0.json`,
    taskMd,
  };
}

async function runCli(
  argv: string[],
): Promise<{ code: number; payload: Record<string, unknown> }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };
  try {
    const code = await main(argv);
    return { code, payload: JSON.parse(lines[lines.length - 1] ?? "{}") };
  } finally {
    console.log = original;
  }
}

async function writeSlotVerdict(
  bed: Bed,
  slot: Slot,
  body: unknown,
): Promise<void> {
  await Deno.mkdir(`${bed.runDir}/verdicts/slots`, { recursive: true });
  await Deno.writeTextFile(
    slotVerdictPath(bed.canonical, slot),
    JSON.stringify(body),
  );
}

Deno.test("CLI slots: high + 配列で合議になり、マニフェストが実体として書かれる", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "risk: high\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    const { code, payload } = await runCli([
      "slots",
      "--canonical",
      bed.canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ]);
    assertEquals(code, 0);
    assertEquals(payload.class, "high");
    assertEquals(payload.mode, "dual");
    assertEquals(payload.audit_mode, "dual");
    const manifest = JSON.parse(
      await Deno.readTextFile(slotsManifestPath(bed.canonical)),
    ) as RoundManifest;
    assertEquals(manifest.schema_version, 1);
    assertEquals(manifest.slots.map((s) => s.provider), ["claude", "omp"]);
    assertEquals(manifest.slots.map((s) => s.snapshot), [null, null]);
    assertEquals(manifest.baseline_snapshot, payload.baseline_snapshot);
  });
});

Deno.test("CLI slots: standard は単一で、マニフェストを作らない", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, { frontmatter: "" });
    const { code, payload } = await runCli([
      "slots",
      "--canonical",
      bed.canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
    ]);
    assertEquals(code, 0);
    assertEquals(payload.mode, "single");
    assertEquals(payload.audit_mode, "single");
    let exists = true;
    try {
      await Deno.stat(slotsManifestPath(bed.canonical));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "単一検証でマニフェストを作ってはいけない");
  });
});

Deno.test("CLI slots: audit_mode: dual の宣言は trivial でも合議になる", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "gate: light\naudit_mode: dual\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    const { code, payload } = await runCli([
      "slots",
      "--canonical",
      bed.canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ]);
    assertEquals(code, 0);
    assertEquals(payload.class, "trivial");
    assertEquals(payload.audit_mode, "dual");
    assertEquals(payload.mode, "dual");
  });
});

Deno.test("CLI slots: high は散文フェーズでも床が下がらない (research+plan でも合議)", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "risk: high\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    const canonical = `${bed.runDir}/verdicts/research+plan-0.json`;
    const { code, payload } = await runCli([
      "slots",
      "--canonical",
      canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "research+plan",
      "--home",
      bed.home,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ]);
    assertEquals(code, 0);
    assertEquals(payload.audit_mode, "dual");
    assertEquals(payload.mode, "dual");
  });
});

Deno.test("CLI slots: 不変条件違反は exit 15 と invariant の理由を返す", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, { frontmatter: "risk: high\n" });
    const { code, payload } = await runCli([
      "slots",
      "--canonical",
      bed.canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ]);
    assertEquals(code, EXIT_CODES.conflict);
    assertEquals(payload.error, "invariant");
    assertEquals(payload.reason, "not-configured");
  });
});

Deno.test("CLI: slots → next-slot → record-slot → synthesize で正典が書かれる", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "risk: high\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    const common = [
      "--canonical",
      bed.canonical,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ];
    await runCli([
      "slots",
      ...common,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
    ]);

    const first = await runCli(["next-slot", "--canonical", bed.canonical]);
    assertEquals(first.payload.next, "a");
    assertEquals(first.payload.ready, false);

    // 判定が書かれる前の record-slot は前提違反 (conflict)。
    const early = await runCli(["record-slot", ...common, "--slot", "a"]);
    assertEquals(early.code, EXIT_CODES.conflict);

    await writeSlotVerdict(bed, "a", {
      phase: "implement",
      verdict: "PASS",
      reasons: ["a ok"],
      required_fixes: [],
    });
    // 判定だけ在って snapshot 未記録のあいだは、次スロットへ進まない。
    const stillA = await runCli(["next-slot", "--canonical", bed.canonical]);
    assertEquals(stillA.payload.next, "a");

    const recordedA = await runCli([
      "record-slot",
      ...common,
      "--slot",
      "a",
      "--agent",
      "agent-a",
    ]);
    assertEquals(recordedA.code, 0);
    assertEquals(recordedA.payload.matches_baseline, true);

    const second = await runCli(["next-slot", "--canonical", bed.canonical]);
    assertEquals(second.payload.next, "b");

    await writeSlotVerdict(bed, "b", {
      phase: "implement",
      verdict: "FAIL",
      reasons: ["b found a hole"],
      required_fixes: ["cover the rejection class"],
    });
    await runCli([
      "record-slot",
      ...common,
      "--slot",
      "b",
      "--agent",
      "agent-b",
    ]);

    const ready = await runCli(["next-slot", "--canonical", bed.canonical]);
    assertEquals(ready.payload.next, null);
    assertEquals(ready.payload.ready, true);

    const synth = await runCli(["synthesize", "--canonical", bed.canonical]);
    assertEquals(synth.code, 0);
    assertEquals(synth.payload.outcome, "fail");
    assertEquals(synth.payload.verdict, "FAIL");

    const canonical = JSON.parse(await Deno.readTextFile(bed.canonical)) as {
      phase: string;
      verdict: string;
      reasons: string[];
      required_fixes: string[];
      consensus: { slots: { slot: string; agent_id: string | null }[] };
    };
    assertEquals(canonical.phase, "implement");
    assertEquals(canonical.verdict, "FAIL");
    assertEquals(canonical.reasons, ["[claude] a ok", "[omp] b found a hole"]);
    assertEquals(canonical.required_fixes, [
      "[omp] cover the rejection class",
    ]);
    assertEquals(
      canonical.consensus.slots.map((s) => [s.slot, s.agent_id]),
      [["a", "agent-a"], ["b", "agent-b"]],
    );
  });
});

Deno.test("CLI synthesize: スロット間で成果物が動いていればラウンドを破棄し、正典を書かない", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "risk: high\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    const common = [
      "--canonical",
      bed.canonical,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ];
    await runCli([
      "slots",
      ...common,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
    ]);
    for (const slot of ["a", "b"] as const) {
      await writeSlotVerdict(bed, slot, {
        phase: "implement",
        verdict: "PASS",
        reasons: [],
        required_fixes: [],
      });
      if (slot === "b") {
        // 2 体目の判定の前に実装が動いた (= 同じスナップショットに対する判定ではない)。
        await Deno.writeTextFile(
          `${bed.target}/tracked.ts`,
          "export const a = 2;\n",
        );
      }
      await runCli(["record-slot", ...common, "--slot", slot]);
    }
    const synth = await runCli(["synthesize", "--canonical", bed.canonical]);
    assertEquals(synth.code, 0);
    assertEquals(synth.payload.outcome, "discarded");
    assertEquals(synth.payload.reason, "snapshot-mismatch");

    let wrote = true;
    try {
      await Deno.stat(bed.canonical);
    } catch {
      wrote = false;
    }
    assertEquals(wrote, false, "破棄したラウンドで正典を書いてはいけない");
  });
});

Deno.test("CLI synthesize: スロット判定が欠けていれば incomplete (exit 15)", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, {
      frontmatter: "risk: high\n",
      audit: ["claude/claude-opus-4-1", "omp/openai/gpt-5"],
    });
    await runCli([
      "slots",
      "--canonical",
      bed.canonical,
      "--task",
      bed.taskMd,
      "--phase",
      "implement",
      "--home",
      bed.home,
      "--run-dir",
      bed.runDir,
      "--target",
      bed.target,
    ]);
    const synth = await runCli(["synthesize", "--canonical", bed.canonical]);
    assertEquals(synth.code, EXIT_CODES.conflict);
    assertEquals(synth.payload.outcome, "incomplete");
    assertEquals(synth.payload.reason, "slot-verdict-missing");
  });
});

Deno.test("CLI: 引数と対象の不備は usage / missing で落ちる", async () => {
  await withTemp(async (dir) => {
    const bed = await makeBed(dir, { frontmatter: "risk: high\n" });
    const noCanonical = await runCli(["next-slot"]);
    assertEquals(noCanonical.code, EXIT_CODES.usage);

    const unknownVerb = await runCli(["merge", "--canonical", bed.canonical]);
    assertEquals(unknownVerb.code, EXIT_CODES.usage);

    const unknownFlag = await runCli([
      "next-slot",
      "--canonical",
      bed.canonical,
      "--slot",
      "a",
    ]);
    assertEquals(unknownFlag.code, EXIT_CODES.usage);

    const noManifest = await runCli([
      "synthesize",
      "--canonical",
      bed.canonical,
    ]);
    assertEquals(noManifest.code, EXIT_CODES.missing);
    assertEquals(noManifest.payload.error, "missing");
  });
});
