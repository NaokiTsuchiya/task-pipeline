// tests/shell-check-gate-contract.test.ts — シェル判定ゲート (gh-158) の散文契約。
// オーケストレーター側の手順 (task-pipeline/SKILL.md「シェル判定 (Shell-Check ゲート)」と
// 「検証ゲートの絶対規則」) と、実装 (task-pipeline/scripts/shell-check.ts /
// shell-check-manifest.ts / task-policy.ts) が揃っていることを固定する。
//
//   deno test --allow-read tests/shell-check-gate-contract.test.ts
//   deno task test
//
// この節が痩せる壊れ方は動かしても気づけない。`--verifier` を渡す形に戻れば、居ない
// エージェントの再開を試み続ける。UNAVAILABLE を PASS 側か FAIL 側へ寄せる文面に戻れば、
// **実行されていないチェックが判定として通る** — シェル判定の意味そのものが失われる。
//
// 判定は節スコープで行い、B 群の回帰注入も同じ節に対してだけ行う。

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
  substituteFirstPerLine,
} from "./contract-helpers.ts";
import { SHELL_AUDITABLE_PHASE } from "../task-pipeline/scripts/task-policy.ts";
import { MANIFEST_PATH } from "../task-pipeline/scripts/shell-check-manifest.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const README_MD = new URL("README.md", REPO_ROOT);
const SHELL_CHECK_TS = new URL(
  "task-pipeline/scripts/shell-check.ts",
  REPO_ROOT,
);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const readmeMd = Deno.readTextFileSync(README_MD);
const shellCheckTs = Deno.readTextFileSync(SHELL_CHECK_TS);

const SECTION_HEADING = "### シェル判定 (Shell-Check ゲート)";

function shellSection(text: string): string {
  return sedRange(
    text,
    /^### シェル判定 \(Shell-Check ゲート\)/,
    /^### 検証ゲートの絶対規則/,
  );
}

function ruleSection(text: string): string {
  return sedRange(text, /^### 検証ゲートの絶対規則/, /^### リトライ上限/);
}

/** 手順 6 の 1 行目 (シェル判定を先に試す規定はこの行にある)。 */
function stepSixLine(text: string): string {
  return grepFixedFirstLine(text, "6. **検証ゲート**") ?? "";
}

function verdictLine(section: string, verdict: string): string {
  return grepFixedFirstLine(section, `"verdict": "${verdict}"`) ?? "";
}

Deno.test("A0 シェル判定の節が切り出せる", () => {
  const section = shellSection(skillMd);
  assertOk(
    section.startsWith(SECTION_HEADING),
    `節が無い: ${section.slice(0, 60)}`,
  );
  assertOk(section.split("\n").length > 8, "節が痩せている");
});

Deno.test("A1 手順 6 の冒頭でシェル判定を先に試し、route で分岐する", () => {
  const line = stepSixLine(skillMd);
  assertOk(
    containsFixed(line, "shell-check.ts"),
    `shell-check.ts が無い: ${line}`,
  );
  assertOk(containsFixed(line, "`route`"), `route での分岐が無い: ${line}`);
});

Deno.test("A2 節が route の 2 値と verdict の 3 値をすべて扱っている", () => {
  const section = shellSection(skillMd);
  for (const needle of ['"route": "llm"', '"route": "shell"']) {
    assertOk(containsFixed(section, needle), `${needle} が無い`);
  }
  for (const verdict of ["PASS", "FAIL", "UNAVAILABLE"]) {
    assertOk(
      containsFixed(section, `"verdict": "${verdict}"`),
      `verdict ${verdict} の分岐が無い`,
    );
  }
});

Deno.test("A3 FAIL 分岐の行が --verifier を渡さないことを求めている", () => {
  const line = verdictLine(shellSection(skillMd), "FAIL");
  assertOk(
    containsFixed(line, "--verifier"),
    `--verifier の言及が無い: ${line}`,
  );
  assertOk(
    containsFixed(line, "渡さない"),
    `渡さない旨が無い (行スコープ): ${line}`,
  );
  assertOk(
    containsFixed(line, "reuse_verifier"),
    `reuse_verifier を立てない理由が無い: ${line}`,
  );
});

Deno.test("A4 UNAVAILABLE 分岐の行が advance/phase-fail を呼ばず block へ回す", () => {
  const line = verdictLine(shellSection(skillMd), "UNAVAILABLE");
  for (
    const needle of ["advance", "phase-fail", "呼ばない", "state.ts block"]
  ) {
    assertOk(
      containsFixed(line, needle),
      `${needle} が無い (行スコープ): ${line}`,
    );
  }
});

Deno.test("A5 UNAVAILABLE 分岐の行が LLM 検証での代行を禁じている", () => {
  const line = verdictLine(shellSection(skillMd), "UNAVAILABLE");
  assertOk(
    containsFixed(line, "検証エージェントを起動して埋め合わせてはならない"),
    `代行の禁止が無い (行スコープ): ${line}`,
  );
});

Deno.test("A6 節が信頼済み設定のファイル名と base スナップショットからの読み出しを書いている", () => {
  const section = shellSection(skillMd);
  assertOk(containsFixed(section, MANIFEST_PATH), `${MANIFEST_PATH} が無い`);
  assertOk(
    containsFixed(section, "git show <base>:"),
    "base スナップショットからの読み出しが無い",
  );
});

Deno.test("A7 節が判定条件を SKILL.md へ書き写さない規律を持っている", () => {
  const section = shellSection(skillMd);
  assertOk(
    containsFixed(section, "書き写さない"),
    "導出の正が CLI 側にある規律が無い",
  );
});

Deno.test("A8 節が挙げるフラグが実装に実在する", () => {
  const section = shellSection(skillMd);
  for (const flag of ["--state-dir", "--id", "--verdict-path"]) {
    assertOk(containsFixed(section, flag), `${flag} が節に無い`);
    assertOk(
      containsFixed(shellCheckTs, `"${flag.slice(2)}"`),
      `${flag} が shell-check.ts の許可フラグに無い`,
    );
  }
});

Deno.test("A9 絶対規則の節がシェル判定の PASS を規則を満たす経路として扱っている", () => {
  const section = ruleSection(skillMd);
  assertOk(containsFixed(section, "シェル判定"), "シェル判定への言及が無い");
  assertOk(
    containsFixed(section, "UNAVAILABLE"),
    "UNAVAILABLE が PASS でない旨が無い",
  );
});

Deno.test("A10 README がシェル判定の適用範囲を書いている", () => {
  const line = grepFixedFirstLine(readmeMd, MANIFEST_PATH) ?? "";
  assertOk(line !== "", `README に ${MANIFEST_PATH} の説明が無い`);
  assertOk(containsFixed(line, "base"), `base からの読み出しが無い: ${line}`);
  assertOk(
    containsFixed(line, "実装フェーズ"),
    `適用範囲 (実装フェーズ) が無い: ${line}`,
  );
});

Deno.test("A11 シェル判定を許すフェーズは implement だけである", () => {
  const auditable = Object.entries(SHELL_AUDITABLE_PHASE)
    .filter(([, value]) => value)
    .map(([phase]) => phase);
  assertOk(
    auditable.length === 1 && auditable[0] === "implement",
    `implement 以外が機械判定の対象になっている: ${JSON.stringify(auditable)}`,
  );
});

interface Regression {
  readonly label: string;
  readonly inject: (text: string) => string;
  /** A 群と同じ主張。健全な本文では通り、注入後の本文では throw することを両方見る。 */
  readonly assertA: (text: string) => void;
}

const REGRESSIONS: readonly Regression[] = [
  {
    label: "手順 6 から shell-check.ts の呼び出しが消える",
    inject: (text) =>
      substituteFirstPerLine(text, /shell-check\.ts/, "verifier を起動する"),
    assertA: (text) => {
      const line = stepSixLine(text);
      assertOk(containsFixed(line, "shell-check.ts"), `A1: ${line}`);
    },
  },
  {
    label: "FAIL 分岐が --verifier を渡す形に戻る",
    inject: (text) =>
      substituteFirstPerLine(
        text,
        /`--verifier` と `--session` は渡さない/,
        "`--verifier` と `--session` も渡す",
      ),
    assertA: (text) => {
      const line = verdictLine(shellSection(text), "FAIL");
      assertOk(containsFixed(line, "渡さない"), `A3: ${line}`);
    },
  },
  {
    label: "UNAVAILABLE 分岐から block が消える",
    inject: (text) =>
      substituteFirstPerLine(
        text,
        /`state\.ts block --id <id> --reason <判定 JSON の reasons の 1 行>` を呼び/,
        "そのまま次フェーズへ進め",
      ),
    assertA: (text) => {
      const line = verdictLine(shellSection(text), "UNAVAILABLE");
      assertOk(containsFixed(line, "state.ts block"), `A4: ${line}`);
    },
  },
  {
    label: "UNAVAILABLE 分岐から代行の禁止が消える",
    inject: (text) =>
      substituteFirstPerLine(
        text,
        /\*\*代わりに検証エージェントを起動して埋め合わせてはならない\*\*/,
        "検証エージェントを起動して埋め合わせてよい",
      ),
    assertA: (text) => {
      const line = verdictLine(shellSection(text), "UNAVAILABLE");
      assertOk(
        containsFixed(line, "検証エージェントを起動して埋め合わせてはならない"),
        `A5: ${line}`,
      );
    },
  },
  {
    label: "節から base スナップショットの読み出しが消える",
    inject: (text) =>
      substituteFirstPerLine(text, /git show <base>:/, "作業ツリーの "),
    assertA: (text) => {
      assertOk(
        containsFixed(shellSection(text), "git show <base>:"),
        "A6: base スナップショットの読み出しが無い",
      );
    },
  },
];

function throwsOn(assertA: (text: string) => void, text: string): boolean {
  try {
    assertA(text);
    return false;
  } catch {
    return true;
  }
}

for (const regression of REGRESSIONS) {
  Deno.test(`B [${regression.label}] の回帰注入が効いている`, () => {
    const injected = regression.inject(skillMd);
    assertOk(injected !== skillMd, "注入が本文を変えていない");
    regression.assertA(skillMd);
  });

  Deno.test(`B [${regression.label}] を A 群相当のチェックで検知できる`, () => {
    assertOk(
      throwsOn(regression.assertA, regression.inject(skillMd)),
      "A 群相当のチェックが退行を見逃した",
    );
  });
}
