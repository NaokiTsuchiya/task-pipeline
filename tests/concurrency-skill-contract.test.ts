// tests/concurrency-skill-contract.test.ts — 複数の実行主体が並行するときの手順書の契約を固定する。
// (1) task-pipeline/SKILL.md の「毎イテレーションの手順」節が、仕上げ (pr_fix/rebase_fix) だけが
// 飛行中のときに新しいタスクの着手 (claim) へ到達すること (gh-60 の受け入れ条件1・2・5)。
// (2) 同一 session id の並行インスタンスに対する揮発資源の楽観ロック (CAS) を、SKILL.md と
// playbooks/inflight.md が実際に使うこと (gh-117。後半の C 系)。
//
//   deno test --allow-read tests/concurrency-skill-contract.test.ts
//   deno task test                          # 自動検出でも走る
//
// 背景: 手順書は元々「counts.running が1以上 → 飛行中の扱いへ」「start.next_id が非null → タスク実行へ」
// を排他的な分岐として書いており、仕上げ run が counts.running に数えられる (docs/state-cli-contract.md)
// ため、仕上げが飛行中の間は新しいタスクへの着手判定に手順書上どうやっても到達できなかった (gh-60)。
// CLI (state-next.ts) は元々「仕上げは新規着手を塞がない」を実装・テスト済みだったので、直したのは
// SKILL.md の分岐の書き方だけである。このテストはその書き換え後の文言を grep で固定する
// (tests/max-tasks-skill-contract.test.ts と同じ「prose の契約を grep で固定する」パターン)。
//
// - 外部依存ゼロ・ネットワーク不要。対象ファイルは CWD ではなく `import.meta.url` 起点で解決する。

import { assertOk, containsFixed, sedRange } from "./contract-helpers.ts";

const REPO_ROOT = new URL("../", import.meta.url);
const SKILL_MD = new URL("task-pipeline/SKILL.md", REPO_ROOT);

const skillMd = Deno.readTextFileSync(SKILL_MD);

/** `sed -n '/^## 毎イテレーションの手順$/,/^## /p'` — 手順1の分岐を含む節だけを切り出す。 */
const section = sedRange(
  skillMd,
  /^## 毎イテレーションの手順$/,
  /^## /,
);

const A1_NEEDLE =
  "**自分の仕上げ run だけが飛行中のときは `own_initial` は立たないので、`start.allowed` は真になりうる**";
const A2_NEEDLE =
  "自分の `initial` run が飛行中なら `start.blocked_by` に `own_initial` が立ち `start.allowed` は偽になるので、この箇条書きには来ない";
const A3_NEEDLE =
  "順序は**飛行中の扱いの action 処理が先、新しい着手が後**である";

Deno.test("A0 節が空でない (見出しが一致している)", () => {
  assertOk(section.length > 0, "節が空 — 見出しパターンが一致しない");
});

Deno.test("A1 仕上げ run だけが飛行中のとき新しい着手へ進める旨が明記されている (受け入れ条件1)", () => {
  assertOk(containsFixed(section, A1_NEEDLE), "見つからない");
});

Deno.test("A2 自分の initial run が飛行中なら新しい着手へ進まない旨が明記されている (受け入れ条件2)", () => {
  assertOk(containsFixed(section, A2_NEEDLE), "見つからない");
});

Deno.test("A3 飛行中の扱いの action 処理と新しい着手の同一イテレーション内の順序が明記されている (受け入れ条件5)", () => {
  assertOk(containsFixed(section, A3_NEEDLE), "見つからない");
});

Deno.test("B1 A1 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A1_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B2 A1 の退行 (説明の消失) を A1 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A1_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A1_NEEDLE),
    "除去後も見つかってしまった",
  );
});

Deno.test("B3 A2 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A2_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B4 A2 の退行 (ガード説明の消失) を A2 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A2_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A2_NEEDLE),
    "除去後も見つかってしまった",
  );
});

Deno.test("B5 A3 への回帰注入 (メモリ上の複製から該当記述を除去) が効いている", () => {
  const injected = skillMd.replace(A3_NEEDLE, "");
  assertOk(injected !== skillMd, "置換が効かず元テキストと同一になった");
});

Deno.test("B6 A3 の退行 (順序記述の消失) を A3 相当のチェックで検知できる", () => {
  const injectedSection = section.replace(A3_NEEDLE, "");
  assertOk(
    !containsFixed(injectedSection, A3_NEEDLE),
    "除去後も見つかってしまった",
  );
});

// ---------------------------------------------------------------------------
// gh-117: 揮発資源の楽観ロック (CAS) を手順書が実際に使うことの固定。
//
// CLI 側の守り (state.ts の --expect-executor / --expect-attempts) は、手順書がその値を
// 渡さなくなった瞬間に無効になる — 省略は `set-executor` では「null 期待」に倒れるので
// 気づけるが、`touch-executor` では従来どおり通ってしまう。呼び出し形と conflict の扱いを
// ここで固定する (契約は task-pipeline/docs/state-cli-contract.md の
// 「揮発資源の楽観ロック (gh-117)」節)。
// ---------------------------------------------------------------------------

const INFLIGHT_MD = new URL("task-pipeline/playbooks/inflight.md", REPO_ROOT);
const inflightMd = Deno.readTextFileSync(INFLIGHT_MD);

const CAS_NEEDLES: { label: string; text: string; needle: string }[] = [
  {
    label:
      "C1 SKILL.md: 初回起動の set-executor は --expect-executor を省略する",
    text: skillMd,
    needle: "**この呼び出しは `--expect-executor` を省略する**",
  },
  {
    label:
      "C2 SKILL.md: 停止通知の touch-executor が送り元の agentId を宣言する",
    text: skillMd,
    needle:
      "`state.ts touch-executor --id <id> --expect-executor <送り元の agentId>",
  },
  {
    label:
      "C3 SKILL.md: phase-fail が gate.attempts を --expect-attempts に渡す",
    text: skillMd,
    needle:
      "--expect-attempts <イテレーション冒頭の `next` が返した `tasks[].gate.attempts`>",
  },
  {
    label:
      "C4 SKILL.md: set-executor の conflict は別インスタンスの先行を意味する",
    text: skillMd,
    needle:
      "**`conflict` が返ったら、同じ session id の別インスタンスが先に実行エージェントを立てている**",
  },
  {
    label: "C5 SKILL.md: phase-fail の conflict では自分の判定を捨てる",
    text: skillMd,
    needle: "二重加算しないよう自分の判定は捨て",
  },
  {
    label:
      "C6 SKILL.md: 所有権では同一 session id の並行インスタンスを区別できない",
    text: skillMd,
    needle:
      "**heartbeat は session id 単位なので、同じ id を共有する 2 つの並行インスタンス",
  },
  {
    label:
      "C7 inflight.md: takeover の set-executor が action の replaces を渡す",
    text: inflightMd,
    needle: "--expect-executor <action の `replaces`>",
  },
  {
    label:
      "C8 inflight.md: status-check 成功後の touch-executor が送信先を宣言する",
    text: inflightMd,
    needle:
      "`state.ts touch-executor --id <id> --expect-executor <送信先の agentId>`",
  },
];

for (const c of CAS_NEEDLES) {
  Deno.test(`${c.label}`, () => {
    assertOk(containsFixed(c.text, c.needle), `見つからない: ${c.needle}`);
  });
  Deno.test(`${c.label} — 回帰注入`, () => {
    const injected = c.text.replace(c.needle, "");
    assertOk(injected !== c.text, "置換が効かず元テキストと同一になった");
    assertOk(
      !containsFixed(injected, c.needle),
      "除去後も見つかってしまった",
    );
  });
}

// conflict の扱いは、実在が確かめられていない停止手段に依存してはならない
// (`TaskStop` はこのリポジトリのどこにも記述が無い)。放置された executor は
// SKILL.md の既存規則「送り元の agentId が `run.executor` と一致しない通知は無視する」が
// 吸収する。
Deno.test("C9 手順書が未検証の停止手段 (TaskStop) に依存していない", () => {
  for (
    const [name, text] of [["SKILL.md", skillMd], ["inflight.md", inflightMd]]
  ) {
    assertOk(
      !/TaskStop/i.test(text),
      `${name} に TaskStop への依存が入っている`,
    );
  }
  assertOk(
    containsFixed(
      skillMd,
      "送り元の agentId が state.json の `run.executor` と一致しない通知は無視する",
    ),
    "放置された executor を吸収する既存規則が消えている",
  );
});
