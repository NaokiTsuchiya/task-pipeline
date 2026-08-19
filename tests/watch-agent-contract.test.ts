// tests/watch-agent-contract.test.ts — バックグラウンド Watcher プロセス (watch-agent.sh)
// による Paseo executor 停止の 0 秒起床、責務分離、二重安全 (1800秒維持) の規律が、
// 3 ファイル (SKILL.md / playbooks/inflight.md / playbooks/agent-launch.md) に
// またがって固定されていることを検証する (gh-130)。
//
//   deno test --allow-read tests/watch-agent-contract.test.ts
//   deno task test

import {
  assertOk,
  containsFixed,
  grepFixedFirstLine,
  sedRange,
} from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);
const PLAYBOOKS = new URL("task-pipeline/playbooks/", REPO_ROOT);
const LAUNCH_MD = new URL("agent-launch.md", PLAYBOOKS);
const INFLIGHT_MD = new URL("inflight.md", PLAYBOOKS);

const skillMd = Deno.readTextFileSync(SKILL_MD);
const launchMd = Deno.readTextFileSync(LAUNCH_MD);
const inflightMd = Deno.readTextFileSync(INFLIGHT_MD);

/** 行スコープの判定に使う。固定文字列を含む最初の行 (無ければ null)。 */
function lineWith(text: string, needle: string): string | null {
  return grepFixedFirstLine(text, needle);
}

/** 節の切り出し境界。 */
const STEP4_HEADING = /^4\. \*\*以降、このタスクの進行は/;
const STEP5_HEADING = /^5\. 実行エージェントはフェーズを 1 つ終えるごとに/;
const INFLIGHT_WAIT_HEADING = /^- \*\*`wait`\*\*/;
const INFLIGHT_STATUS_CHECK_HEADING = /^- \*\*`status-check`\*\*/;
const LAUNCH_PARAM_HEADING = /^## Paseo 経路の起動パラメータと読み取り$/;
const LAUNCH_USAGE_HEADING = /^## Paseo invocation の usage 採取$/;

const skillStep4 = sedRange(skillMd, STEP4_HEADING, STEP5_HEADING);
const inflightWaitSection = sedRange(
  inflightMd,
  INFLIGHT_WAIT_HEADING,
  INFLIGHT_STATUS_CHECK_HEADING,
);
const launchParamSection = sedRange(
  launchMd,
  LAUNCH_PARAM_HEADING,
  LAUNCH_USAGE_HEADING,
);

// --- A 群: 現状が規定どおりであること -----------------------------------------------

Deno.test("A0 対象の 3 節が正しく切り出せる", () => {
  assertOk(skillStep4.length > 0, "SKILL.md 手順 4 の節が空");
  assertOk(inflightWaitSection.length > 0, "inflight.md wait 節が空");
  assertOk(
    launchParamSection.length > 0,
    "agent-launch.md 起動パラメータ節が空",
  );
});

Deno.test("A1 SKILL.md 手順 4 にバックグラウンド Watcher と 0 秒起床の規定がある", () => {
  assertOk(
    containsFixed(skillStep4, "watch-agent.sh"),
    "SKILL.md 手順 4 に watch-agent.sh への言及が無い",
  );
  assertOk(
    containsFixed(skillStep4, "0 秒で起床"),
    "SKILL.md 手順 4 に 0 秒で起床 の言及が無い",
  );
  assertOk(
    containsFixed(skillStep4, "TASK_PIPELINE_HEARTBEAT"),
    "SKILL.md 手順 4 に TASK_PIPELINE_HEARTBEAT の言及が無い",
  );
});

Deno.test("A2 SKILL.md 手順 4 に二重安全 (フォールバック 1800 秒) が明記されている", () => {
  assertOk(
    containsFixed(skillStep4, "二重安全"),
    "SKILL.md 手順 4 に二重安全の言及が無い",
  );
  assertOk(
    containsFixed(skillStep4, "1800 秒"),
    "SKILL.md 手順 4 に 1800 秒の言及が無い",
  );
});

Deno.test("A3 inflight.md wait 節に Watcher 終了通知による停止検知受け皿フローがある", () => {
  assertOk(
    containsFixed(inflightWaitSection, "Watcher プロセスの終了通知"),
    "inflight.md に Watcher プロセスの終了通知の言及が無い",
  );
  assertOk(
    containsFixed(inflightWaitSection, "この action が停止検知の受け皿である"),
    "inflight.md に受け皿の言及が無い",
  );
  assertOk(
    containsFixed(inflightWaitSection, "鮮度規則"),
    "inflight.md に鮮度規則の言及が無い",
  );
});

Deno.test("A4 agent-launch.md 役割の表の executor 行に Watcher と 0 秒起床がある", () => {
  const row = lineWith(launchMd, "`executor`");
  assertOk(row !== null, "役割の表に executor 行が無い");
  assertOk(
    row.includes("watch-agent.sh"),
    "executor 行に watch-agent.sh が無い",
  );
  assertOk(row.includes("0 秒起床"), "executor 行に 0 秒起床が無い");
});

Deno.test("A5 agent-launch.md 起動パラメータ節に Watcher 起動と責務分離・二重安全がある", () => {
  assertOk(
    containsFixed(launchParamSection, "Watcher による 0 秒起床"),
    "起動パラメータ節に見出し項が無い",
  );
  assertOk(
    containsFixed(launchParamSection, "watch-agent.sh"),
    "起動パラメータ節に watch-agent.sh が無い",
  );
  assertOk(
    containsFixed(launchParamSection, "責務の分離"),
    "起動パラメータ節に責務の分離が無い",
  );
  assertOk(
    containsFixed(launchParamSection, "二重安全"),
    "起動パラメータ節に二重安全が無い",
  );
});

// --- B 群: 退行を注入して検知できること ---------------------------------------------

interface Regression {
  label: string;
  original: string;
  mutated: string;
  stillHolds: (mutated: string) => boolean;
}

const REGRESSIONS: readonly Regression[] = [
  {
    label: "SKILL.md 手順 4 から watch-agent.sh が消える",
    original: skillStep4,
    mutated: skillStep4.replaceAll("watch-agent.sh", "watch-legacy.sh"),
    stillHolds: (t) => containsFixed(t, "watch-agent.sh"),
  },
  {
    label: "SKILL.md 手順 4 から二重安全が消える",
    original: skillStep4,
    mutated: skillStep4.replace("二重安全", "単一安全"),
    stillHolds: (t) => containsFixed(t, "二重安全"),
  },
  {
    label: "inflight.md から Watcher 終了通知への言及が消える",
    original: inflightWaitSection,
    mutated: inflightWaitSection.replace(
      "Watcher プロセスの終了通知",
      "タイマーの満了",
    ),
    stillHolds: (t) => containsFixed(t, "Watcher プロセスの終了通知"),
  },
  {
    label: "agent-launch.md 役割の表から 0 秒起床が消える",
    original: launchMd,
    mutated: launchMd.replace("0 秒起床", "遅延起床"),
    stillHolds: (t) =>
      (lineWith(t, "`executor`") as string).includes("0 秒起床"),
  },
  {
    label: "agent-launch.md 起動パラメータ節から責務の分離が消える",
    original: launchParamSection,
    mutated: launchParamSection.replace("責務の分離", "責務の統合"),
    stillHolds: (t) => containsFixed(t, "責務の分離"),
  },
];

for (const regression of REGRESSIONS) {
  Deno.test(`B [${regression.label}] への回帰注入が効いている`, () => {
    assertOk(
      regression.mutated !== regression.original,
      "回帰注入の置換が効かず元と同一",
    );
  });

  Deno.test(
    `B [${regression.label}] を A 群相当のチェックで検知できる`,
    () => {
      assertOk(
        !regression.stillHolds(regression.mutated),
        "退行させたテキストがチェックを素通りした",
      );
    },
  );
}
