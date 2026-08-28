// task-pipeline/scripts/task-policy.test.ts
//
// task-policy.ts の宣言導出と監査ポリシーの解決。接頭辞は T-TP-。
//
// 実行: deno task test
//   単体: deno test --allow-read --allow-write task-pipeline/scripts/task-policy.test.ts

import {
  AUDIT_MODE_VALUES,
  CLASS_AUDIT_FLOOR,
  deriveDeclaredAuditMode,
  deriveDeclaredScope,
  deriveTaskClass,
  frontmatterBlockOf,
  readTaskClass,
  readTaskDeclaration,
  resolveAuditMode,
  SHELL_AUDITABLE_PHASE,
  type TaskClass,
} from "./task-policy.ts";
import { PHASE_VALUES } from "./state-model-v2.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

Deno.test("T-TP-fm-1: 閉じた frontmatter はブロックを返す", () => {
  assertEquals(
    frontmatterBlockOf("---\nid: gh-1\ngate: light\n---\n本文\n"),
    "id: gh-1\ngate: light",
  );
});

Deno.test("T-TP-fm-2: 1 行目が --- でなければ null", () => {
  assertEquals(frontmatterBlockOf("id: gh-1\n---\n"), null);
});

Deno.test("T-TP-fm-3: 閉じ --- が無ければ null", () => {
  assertEquals(frontmatterBlockOf("---\nid: gh-1\n本文\n"), null);
});

Deno.test("T-TP-fm-4: 空の frontmatter は空文字 (null ではない)", () => {
  assertEquals(frontmatterBlockOf("---\n---\n"), "");
});

Deno.test("T-TP-class-1: gate: light -> trivial", () => {
  assertEquals(deriveTaskClass("id: gh-1\ngate: light\nrisk: low"), "trivial");
});

Deno.test("T-TP-class-2: risk: high -> high", () => {
  assertEquals(deriveTaskClass("id: gh-1\nrisk: high"), "high");
});

Deno.test("T-TP-class-3: 宣言なし -> standard", () => {
  assertEquals(deriveTaskClass("id: gh-1\ntitle: foo"), "standard");
});

Deno.test("T-TP-class-4: 両方宣言 -> high (保守側)", () => {
  assertEquals(deriveTaskClass("gate: light\nrisk: high"), "high");
});

Deno.test("T-TP-decl-1: 3 値はそのまま読む", () => {
  for (const mode of AUDIT_MODE_VALUES) {
    assertEquals(deriveDeclaredAuditMode(`audit_mode: ${mode}`), mode, mode);
  }
});

Deno.test("T-TP-decl-2: 未知値は宣言なし扱い", () => {
  assertEquals(deriveDeclaredAuditMode("audit_mode: bogus"), null);
});

Deno.test("T-TP-decl-3: 宣言が無ければ null", () => {
  assertEquals(deriveDeclaredAuditMode("id: gh-1"), null);
});

Deno.test("T-TP-decl-4: コロン後の空白が無い綴りは読まない", () => {
  assertEquals(deriveDeclaredAuditMode("audit_mode:shell"), null);
});

Deno.test("T-TP-decl-5: 行途中に現れても読まない (行頭のキーだけ)", () => {
  assertEquals(
    deriveDeclaredAuditMode("note: 検討中 audit_mode: dual と書いた"),
    null,
  );
});

Deno.test("T-TP-scope-1: CSV を trim して読む", () => {
  assertEquals(deriveDeclaredScope("scope: a/** , b/**"), ["a/**", "b/**"]);
});

Deno.test("T-TP-scope-2: 空の値は null", () => {
  assertEquals(deriveDeclaredScope("scope:  "), null);
});

Deno.test("T-TP-scope-3: 宣言が無ければ null", () => {
  assertEquals(deriveDeclaredScope("id: gh-1"), null);
});

Deno.test("T-TP-scope-4: 空要素は落とす", () => {
  assertEquals(deriveDeclaredScope("scope: a/**,,b/**,"), ["a/**", "b/**"]);
});

Deno.test("T-TP-floor-1: class × 宣言の 12 組 (implement フェーズ)", () => {
  const declared = [null, "shell", "single", "dual"] as const;
  const expected: Record<TaskClass, readonly string[]> = {
    trivial: ["shell", "shell", "single", "dual"],
    standard: ["single", "single", "single", "dual"],
    high: ["single", "single", "single", "dual"],
  };
  for (const taskClass of Object.keys(expected) as TaskClass[]) {
    for (let i = 0; i < declared.length; i++) {
      assertEquals(
        resolveAuditMode({
          taskClass,
          declared: declared[i],
          phase: "implement",
        }),
        expected[taskClass][i],
        `${taskClass} × ${declared[i]}`,
      );
    }
  }
});

Deno.test("T-TP-floor-2: 床の値", () => {
  assertEquals(CLASS_AUDIT_FLOOR, {
    trivial: "shell",
    standard: "single",
    high: "single",
  });
});

Deno.test("T-TP-phase-1: trivial + 宣言なしは implement だけ shell", () => {
  for (const phase of PHASE_VALUES) {
    assertEquals(
      resolveAuditMode({ taskClass: "trivial", declared: null, phase }),
      phase === "implement" ? "shell" : "single",
      phase,
    );
  }
});

Deno.test("T-TP-phase-2: 未知のフェーズ名も shell には入れない", () => {
  assertEquals(
    resolveAuditMode({ taskClass: "trivial", declared: null, phase: "bogus" }),
    "single",
  );
});

Deno.test("T-TP-phase-3: 昇格は shell を上げるだけで dual を下げない", () => {
  assertEquals(
    resolveAuditMode({
      taskClass: "trivial",
      declared: "dual",
      phase: "research+plan",
    }),
    "dual",
  );
});

Deno.test("T-TP-phase-4: SHELL_AUDITABLE_PHASE がフェーズ語彙を覆っている", () => {
  assertEquals(
    Object.keys(SHELL_AUDITABLE_PHASE).slice().sort(),
    PHASE_VALUES.slice().sort(),
  );
});

async function withTaskFile(
  content: string | null,
  body: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "task-policy-test-" });
  try {
    const path = `${dir}/gh-1.md`;
    if (content !== null) await Deno.writeTextFile(path, content);
    await body(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("T-TP-read-1: 宣言を読み出す", async () => {
  await withTaskFile(
    "---\nid: gh-1\ngate: light\naudit_mode: dual\nscope: a/**\n---\n本文\n",
    async (path) => {
      assertEquals(await readTaskDeclaration(path), {
        taskClass: "trivial",
        declaredAuditMode: "dual",
        declaredScope: ["a/**"],
      });
      assertEquals(await readTaskClass(path), "trivial");
    },
  );
});

Deno.test("T-TP-read-2: ファイルが無ければ standard・宣言なし", async () => {
  await withTaskFile(null, async (path) => {
    assertEquals(await readTaskDeclaration(path), {
      taskClass: "standard",
      declaredAuditMode: null,
      declaredScope: null,
    });
  });
});

Deno.test("T-TP-read-3: frontmatter が閉じていなければ standard・宣言なし", async () => {
  await withTaskFile(
    "---\ngate: light\naudit_mode: shell\n本文\n",
    async (path) => {
      assertEquals(await readTaskDeclaration(path), {
        taskClass: "standard",
        declaredAuditMode: null,
        declaredScope: null,
      });
    },
  );
});
