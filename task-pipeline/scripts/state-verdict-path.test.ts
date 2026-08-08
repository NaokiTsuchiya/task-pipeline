// task-pipeline/scripts/state-verdict-path.test.ts
//
// state-verdict-path.ts (読み取り専用 verb `verdict-path` の導出本体) のユニットテスト。
// CLI 経路 (exit code・前提違反・state.json のバイト列不変) の観測は state.test.ts が持つ。
//
// 実行: deno task test (リポジトリルートの deno.json。*.test.ts を自動検出して実行する)
//       単体なら deno test task-pipeline/scripts/state-verdict-path.test.ts
//       (Deno API を呼ばないので権限フラグは不要)。
//
// **T-VP-legacy-* が使うオラクル (legacyVerdictPath) は、この変更で消した SKILL.md の散文を
// 写した独立実装である。** 実装から import しないので、両側に同じ取り違えが入ることがない。

import {
  deriveVerdictPath,
  maxArtifactSeq,
  parseFindingsSeq,
  runDirOf,
  type VerdictPathInput,
} from "./state-verdict-path.ts";

// ---------------------------------------------------------------------------
// アサーション (外部依存を増やさないため自前。state-next.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const STATE_DIR = "/p/.task-pipeline";
const ID = "gh-46";
const RUN_DIR = `${STATE_DIR}/runs/${ID}`;

function input(overrides: Partial<VerdictPathInput> = {}): VerdictPathInput {
  return {
    stateDir: STATE_DIR,
    id: ID,
    phase: "research",
    attempt: 0,
    findings: null,
    runDirEntries: [],
    ...overrides,
  };
}

function pathOf(overrides: Partial<VerdictPathInput> = {}): string {
  return deriveVerdictPath(input(overrides)).path;
}

// ---------------------------------------------------------------------------
// 旧散文のオラクル — **変更前の SKILL.md の手順 6 の規則をそのまま写したもの**
//
//   「判定 JSON の書き込み先パスを組み立てる: `runs/<id>/verdicts/<phase>-<attempt>.json`
//     (attempt は `attempts` の現在値・0 始まり。`phase` が `pr_fix` のときは対応する
//     findings の連番 `<n>` を含めて `pr_fix-<n>-<attempt>.json`、`rebase_fix` のときは
//     対応する `rebase-fix-<n>.md` の連番で `rebase_fix-<n>-<attempt>.json`)」
//
// 連番の材料 (`<n>`) は散文が「対応する findings の連番」「対応する rebase-fix-<n>.md の
// 連番」と言うだけなので、オラクルには**値として**渡す (導出はテスト対象の仕事である)。
// ---------------------------------------------------------------------------

function legacyVerdictPath(
  stateDir: string,
  id: string,
  phase: string,
  attempt: number,
  n: number | null,
): string {
  const file = phase === "pr_fix" || phase === "rebase_fix"
    ? `${phase}-${n}-${attempt}.json`
    : `${phase}-${attempt}.json`;
  return `${stateDir}/runs/${id}/verdicts/${file}`;
}

// ---------------------------------------------------------------------------
// D1 — フェーズごとの形 (受け入れ条件1: gate:full の各フェーズ / gate:light の各フェーズ /
//      pr_fix / rebase_fix が、変更前の規則と同じパスになる)
// ---------------------------------------------------------------------------

Deno.test("T-VP-legacy-1: every verified phase matches the pre-change SKILL.md rule", () => {
  // [phase, attempt, findings, runDirEntries, 旧規則に渡す <n>]
  const cases: [string, number, string | null, string[], number | null][] = [
    // gate: full の 4 フェーズ
    ["research", 0, null, [], null],
    ["plan", 1, null, [], null],
    ["implement", 2, null, [], null],
    ["report", 0, null, [], null],
    // gate: light の 3 フェーズ (research+plan は `+` を含む唯一のトークン)
    ["research+plan", 0, null, [], null],
    ["implement", 0, null, [], null],
    ["report", 1, null, [], null],
    // 連番を要する 2 フェーズ
    ["pr_fix", 0, `${RUN_DIR}/watch/2.md`, ["pr-fix-2.md"], 2],
    ["rebase_fix", 1, null, ["rebase-fix-3.md"], 3],
    // D1 × D2 の交差: finalize からの迂回 (入口 b) では asks.fix が findings を保持したまま
    // phase だけ rebase_fix になる。旧規則の <n> は「対応する rebase-fix-<n>.md の連番」で
    // あって findings の連番ではない。
    ["rebase_fix", 0, `${RUN_DIR}/watch/2.md`, [
      "rebase-fix-1.md",
      "pr-fix-2.md",
    ], 1],
  ];
  for (const [phase, attempt, findings, entries, n] of cases) {
    assertEquals(
      pathOf({ phase, attempt, findings, runDirEntries: entries }),
      legacyVerdictPath(STATE_DIR, ID, phase, attempt, n),
      `${phase}-${attempt}`,
    );
  }
});

Deno.test("T-VP-shape-1: phases without a cycle carry no sequence", () => {
  for (
    const phase of ["research", "plan", "implement", "report", "research+plan"]
  ) {
    const got = deriveVerdictPath(input({ phase, attempt: 1 }));
    assertEquals(got.seq, null, phase);
    assertEquals(got.seq_source, null, phase);
    assertEquals(got.file, `${phase}-1.json`, phase);
  }
});

Deno.test("T-VP-shape-2: run_dir and path are the state dir with runs/<id>/verdicts", () => {
  const got = deriveVerdictPath(input({ phase: "report", attempt: 0 }));
  assertEquals(got.run_dir, RUN_DIR);
  assertEquals(got.path, `${RUN_DIR}/verdicts/report-0.json`);
  assertEquals(runDirOf("/a/b/", "x"), "/a/b/runs/x");
});

Deno.test("T-VP-shape-3: attempt 0 is not treated specially", () => {
  for (const attempt of [0, 1, 2]) {
    assertEquals(
      pathOf({ phase: "implement", attempt }),
      `${RUN_DIR}/verdicts/implement-${attempt}.json`,
    );
    assertEquals(
      pathOf({
        phase: "pr_fix",
        attempt,
        findings: `${RUN_DIR}/watch/4.md`,
      }),
      `${RUN_DIR}/verdicts/pr_fix-4-${attempt}.json`,
    );
  }
});

// ---------------------------------------------------------------------------
// D2 — findings の形 (pr_fix の連番の主材料)
// ---------------------------------------------------------------------------

Deno.test("T-VP-findings-1: only <digits>.md basenames with a value >= 1 are taken", () => {
  assertEquals(parseFindingsSeq(null), null, "null");
  assertEquals(parseFindingsSeq(""), null, "empty");
  assertEquals(parseFindingsSeq(`${RUN_DIR}/watch/2.md`), 2, "single digit");
  assertEquals(parseFindingsSeq(`${RUN_DIR}/watch/12.md`), 12, "two digits");
  assertEquals(parseFindingsSeq(`${RUN_DIR}/watch/0.md`), null, "0 (1 始まり)");
  assertEquals(
    parseFindingsSeq(`${RUN_DIR}/watch/notes.md`),
    null,
    "non-numeric",
  );
  assertEquals(
    parseFindingsSeq(`${RUN_DIR}/watch/2.txt`),
    null,
    "wrong suffix",
  );
  assertEquals(parseFindingsSeq(`${RUN_DIR}/watch/v2.md`), null, "prefixed");
  assertEquals(parseFindingsSeq("2.md"), 2, "basename only");
});

Deno.test("T-VP-findings-2: 12 is not truncated to 1 (multi-digit sequences)", () => {
  assertEquals(
    pathOf({ phase: "pr_fix", findings: `${RUN_DIR}/watch/12.md` }),
    `${RUN_DIR}/verdicts/pr_fix-12-0.json`,
  );
});

// ---------------------------------------------------------------------------
// D3 — run dir の中身 (rebase_fix の唯一の材料、pr_fix の予備)
// ---------------------------------------------------------------------------

Deno.test("T-VP-rundir-1: the maximum is numeric, not lexicographic", () => {
  assertEquals(maxArtifactSeq([], "rebase-fix-"), null, "empty");
  assertEquals(maxArtifactSeq(["rebase-fix-1.md"], "rebase-fix-"), 1, "one");
  // 文字列比較なら "rebase-fix-2.md" > "rebase-fix-10.md" になり 2 が勝ってしまう。
  assertEquals(
    maxArtifactSeq(["rebase-fix-2.md", "rebase-fix-10.md"], "rebase-fix-"),
    10,
    "numeric max",
  );
  assertEquals(
    maxArtifactSeq(
      ["research.md", "plan.md", "implementation.md"],
      "rebase-fix-",
    ),
    null,
    "unrelated artifacts",
  );
  assertEquals(
    maxArtifactSeq(["rebase-fix-x.md", "rebase-fix-.md"], "rebase-fix-"),
    null,
    "non-numeric suffix",
  );
  assertEquals(
    maxArtifactSeq(["rebase-fix-1.txt"], "rebase-fix-"),
    null,
    "wrong extension",
  );
});

Deno.test("T-VP-rundir-2: the two artifact prefixes do not read each other", () => {
  const entries = ["pr-fix-7.md", "rebase-fix-3.md"];
  assertEquals(maxArtifactSeq(entries, "rebase-fix-"), 3, "rebase side");
  assertEquals(maxArtifactSeq(entries, "pr-fix-"), 7, "pr side");
  assertEquals(
    pathOf({ phase: "rebase_fix", runDirEntries: entries }),
    `${RUN_DIR}/verdicts/rebase_fix-3-0.json`,
  );
  assertEquals(
    pathOf({ phase: "pr_fix", runDirEntries: entries }),
    `${RUN_DIR}/verdicts/pr_fix-7-0.json`,
  );
});

// ---------------------------------------------------------------------------
// D4 — pr_fix の fallback 連鎖 (findings → run dir → 既定 1)
// ---------------------------------------------------------------------------

Deno.test("T-VP-fallback-1: findings wins over the run dir for pr_fix", () => {
  const got = deriveVerdictPath(input({
    phase: "pr_fix",
    findings: `${RUN_DIR}/watch/2.md`,
    runDirEntries: ["pr-fix-9.md"],
  }));
  assertEquals(got.seq, 2);
  assertEquals(got.seq_source, "findings");
});

Deno.test("T-VP-fallback-2: an unusable findings falls back to the run dir", () => {
  const got = deriveVerdictPath(input({
    phase: "pr_fix",
    findings: `${RUN_DIR}/watch/notes.md`,
    runDirEntries: ["pr-fix-3.md"],
  }));
  assertEquals(got.seq, 3);
  assertEquals(got.seq_source, "run-dir");
});

Deno.test("T-VP-fallback-3: with no material at all the sequence defaults to 1", () => {
  for (const phase of ["pr_fix", "rebase_fix"]) {
    const got = deriveVerdictPath(input({ phase }));
    assertEquals(got.seq, 1, phase);
    assertEquals(got.seq_source, "default", phase);
    assertEquals(got.file, `${phase}-1-0.json`, phase);
  }
});

// ---------------------------------------------------------------------------
// D1 × D2 の交差 — **rebase_fix は findings を見ない**
//
// 実運用の主経路: pr_fix の run が finalize の押し直し直前に衝突すると、rebase-start の
// 入口 b が run.phase だけを rebase_fix に動かす (asks には触れない) ので、asks.fix は
// taken:true のまま findings を保持したままになる。「連番を要するフェーズなら findings →
// run dir → 既定 1 の共通連鎖を回す」実装は D2 / D4 の全ケースと下の findings=null の
// rebase ケースを通過しつつ、ここでだけ誤った連番を返す。
// ---------------------------------------------------------------------------

Deno.test("T-VP-cross-1: rebase_fix takes the run dir even when findings has a number", () => {
  const got = deriveVerdictPath(input({
    phase: "rebase_fix",
    attempt: 0,
    findings: `${RUN_DIR}/watch/2.md`,
    runDirEntries: ["rebase-fix-1.md", "pr-fix-2.md"],
  }));
  assertEquals(got.seq, 1, "the findings sequence (2) must not be used");
  assertEquals(got.seq_source, "run-dir");
  assertEquals(got.path, `${RUN_DIR}/verdicts/rebase_fix-1-0.json`);
});

Deno.test("T-VP-cross-2: rebase_fix with findings but no artifact defaults to 1, not the findings number", () => {
  const got = deriveVerdictPath(input({
    phase: "rebase_fix",
    findings: `${RUN_DIR}/watch/5.md`,
    runDirEntries: ["pr-fix-5.md"],
  }));
  assertEquals(got.seq, 1);
  assertEquals(got.seq_source, "default");
});

// ---------------------------------------------------------------------------
// 受け入れ条件2・3 — サイクルを 2 周しても判定が上書きされない
// ---------------------------------------------------------------------------

Deno.test("T-VP-cycle-1: a second fix cycle writes a different path even when attempts is 0 again", () => {
  // 1 周目: findings は watch/1.md、attempts は fix-start 直後で 0。
  const first = pathOf({
    phase: "pr_fix",
    attempt: 0,
    findings: `${RUN_DIR}/watch/1.md`,
    runDirEntries: ["pr-fix-1.md"],
  });
  // 2 周目: 新しい findings (watch/2.md)。fix-start がまた attempts を 0 に戻している。
  const second = pathOf({
    phase: "pr_fix",
    attempt: 0,
    findings: `${RUN_DIR}/watch/2.md`,
    runDirEntries: ["pr-fix-1.md", "pr-fix-2.md"],
  });
  assertEquals(first, `${RUN_DIR}/verdicts/pr_fix-1-0.json`);
  assertEquals(second, `${RUN_DIR}/verdicts/pr_fix-2-0.json`);
  if (first === second) {
    throw new Error("the second cycle must not overwrite the first verdict");
  }
});

Deno.test("T-VP-cycle-2: a second resolution cycle writes a different path too", () => {
  const first = pathOf({
    phase: "rebase_fix",
    attempt: 0,
    runDirEntries: ["rebase-fix-1.md"],
  });
  const second = pathOf({
    phase: "rebase_fix",
    attempt: 0,
    runDirEntries: ["rebase-fix-1.md", "rebase-fix-2.md"],
  });
  assertEquals(first, `${RUN_DIR}/verdicts/rebase_fix-1-0.json`);
  assertEquals(second, `${RUN_DIR}/verdicts/rebase_fix-2-0.json`);
  if (first === second) {
    throw new Error("the second cycle must not overwrite the first verdict");
  }
});

Deno.test("T-VP-cycle-3: retries within one cycle keep the sequence and move the attempt", () => {
  const shared = {
    phase: "pr_fix",
    findings: `${RUN_DIR}/watch/2.md`,
    runDirEntries: ["pr-fix-2.md"],
  };
  assertEquals(
    pathOf({ ...shared, attempt: 0 }),
    `${RUN_DIR}/verdicts/pr_fix-2-0.json`,
  );
  assertEquals(
    pathOf({ ...shared, attempt: 1 }),
    `${RUN_DIR}/verdicts/pr_fix-2-1.json`,
  );
  assertEquals(
    pathOf({ ...shared, attempt: 2 }),
    `${RUN_DIR}/verdicts/pr_fix-2-2.json`,
  );
});
