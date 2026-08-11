// task-pipeline/scripts/alps-v2.test.ts
//
// alps-v2.ts のテスト。核は「再生成 (buildProgressAlpsProfile /
// buildArtifactAlpsProfile) した内容が、コミット済みの task-pipeline/docs/alps/
// 配下2ファイルとバイト列一致する」こと (受け入れ条件2) — 宣言側
// (P_NODE_KEYS/A_NODE_KEYS/VERB_SPEC/ADVANCE_EDGES) を変えてプロファイルを
// 更新し忘れると、このテストが落ちる (受け入れ条件3。回帰注入での確認は
// implementation.md 参照)。
//
//   deno task test (リポジトリルートの deno.json。*.test.ts を自動検出)
//   単体: deno test --allow-read task-pipeline/scripts/alps-v2.test.ts
//   tests/run.sh からは tests/alps-v2.test.sh 経由で実行される。

import {
  type AlpsProfile,
  buildArtifactAlpsProfile,
  buildProgressAlpsProfile,
  sanitizeId,
  serializeAlpsProfile,
} from "./alps-v2.ts";
import { P_NODE_KEYS } from "./state-model-v2.ts";
import {
  A_NODE_KEYS,
  A_OPEN_KEYS,
  A_WITHDRAWN_KEYS,
} from "./state-transitions-v2-nodes.ts";

// 依存ゼロの assert (state-model-v2.test.ts と同じ流儀)

function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assert failed");
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}: ${a} !== ${e}`);
  }
}

const REPO_ROOT = new URL("../../", import.meta.url);
const PROGRESS_FILE = new URL(
  "task-pipeline/docs/alps/state-v2-progress.alps.json",
  REPO_ROOT,
);
const ARTIFACT_FILE = new URL(
  "task-pipeline/docs/alps/state-v2-artifact.alps.json",
  REPO_ROOT,
);

function statesOf(profile: AlpsProfile) {
  return profile.alps.descriptor.filter((d) => d.type === "semantic");
}

function transitionsOf(profile: AlpsProfile) {
  return profile.alps.descriptor.filter((d) => d.type === "unsafe");
}

function hrefCountOf(profile: AlpsProfile): number {
  return statesOf(profile).reduce(
    (sum, s) => sum + (s.descriptor?.length ?? 0),
    0,
  );
}

// 核: 再生成結果とコミット済みファイルのバイト列一致 (受け入れ条件2)

Deno.test("T-ALPS-1: regenerated progress profile matches the committed file byte-for-byte", async () => {
  const got = serializeAlpsProfile(buildProgressAlpsProfile());
  const want = await Deno.readTextFile(PROGRESS_FILE);
  assert(
    got === want,
    "committed state-v2-progress.alps.json is stale — run " +
      "`deno run --allow-write task-pipeline/scripts/alps-v2.ts` and commit the result",
  );
});

Deno.test("T-ALPS-2: regenerated artifact profile matches the committed file byte-for-byte", async () => {
  const got = serializeAlpsProfile(buildArtifactAlpsProfile());
  const want = await Deno.readTextFile(ARTIFACT_FILE);
  assert(
    got === want,
    "committed state-v2-artifact.alps.json is stale — run " +
      "`deno run --allow-write task-pipeline/scripts/alps-v2.ts` and commit the result",
  );
});

// 補助アサーション (バイト列比較が壊れたときの一次診断用。plan.md §1)

Deno.test("T-ALPS-3: sanitizeId is injective over P_NODE_KEYS ∪ A_NODE_KEYS (42 keys)", () => {
  const all = [...P_NODE_KEYS, ...A_NODE_KEYS];
  const ids = all.map(sanitizeId);
  assertEquals(all.length, 42, "P_NODE_KEYS ∪ A_NODE_KEYS must be 42 keys");
  assertEquals(
    new Set(ids).size,
    42,
    "sanitizeId must be injective over the 42 keys",
  );
});

Deno.test("T-ALPS-4: progress profile state id set equals sanitized P_NODE_KEYS (19)", () => {
  const profile = buildProgressAlpsProfile();
  const gotIds = statesOf(profile).map((s) => s.id).sort();
  const wantIds = P_NODE_KEYS.map(sanitizeId).sort();
  assertEquals(gotIds, wantIds);
  assertEquals(gotIds.length, 19);
});

Deno.test("T-ALPS-5: artifact profile state id set equals sanitized A_NODE_KEYS (23)", () => {
  const profile = buildArtifactAlpsProfile();
  const gotIds = statesOf(profile).map((s) => s.id).sort();
  const wantIds = A_NODE_KEYS.map(sanitizeId).sort();
  assertEquals(gotIds, wantIds);
  assertEquals(gotIds.length, 23);
});

Deno.test("T-ALPS-6: progress profile has 18 transition descriptors and 37 href references", () => {
  const profile = buildProgressAlpsProfile();
  assertEquals(transitionsOf(profile).length, 18);
  assertEquals(hrefCountOf(profile), 37);
});

Deno.test("T-ALPS-7: artifact profile has 3 transition descriptors and 40 href references", () => {
  const profile = buildArtifactAlpsProfile();
  assertEquals(transitionsOf(profile).length, 3);
  assertEquals(hrefCountOf(profile), 40);
});

Deno.test("T-ALPS-8: descriptor ids are unique within each profile", () => {
  for (
    const profile of [buildProgressAlpsProfile(), buildArtifactAlpsProfile()]
  ) {
    const ids = profile.alps.descriptor.map((d) => d.id);
    assertEquals(
      new Set(ids).size,
      ids.length,
      `duplicate descriptor id in "${profile.alps.title}"`,
    );
  }
});

// 変異割り当ての根拠は plan.md §2 参照。t-withdraw-asked の from は
// withdrawn(asked=false)・withdrawn(asked=true) の両方 (VERB_SPEC の
// a.from: A_WITHDRAWN_KEYS がそう宣言している — 単一ノードだと誤読しないこと)。
Deno.test("T-ALPS-9: withdraw/withdraw-asked from-sets match A_OPEN_KEYS/A_WITHDRAWN_KEYS", () => {
  const profile = buildArtifactAlpsProfile();
  const wantWithdrawFroms = A_OPEN_KEYS.map(sanitizeId).sort();
  const wantWithdrawAskedFroms = A_WITHDRAWN_KEYS.map(sanitizeId).sort();

  const withdrawFroms = statesOf(profile)
    .filter((s) => (s.descriptor ?? []).some((d) => d.href === "#t-withdraw"))
    .map((s) => s.id)
    .sort();
  assertEquals(withdrawFroms, wantWithdrawFroms);

  const withdrawAskedFroms = statesOf(profile)
    .filter((s) =>
      (s.descriptor ?? []).some((d) => d.href === "#t-withdraw-asked")
    )
    .map((s) => s.id)
    .sort();
  assertEquals(withdrawAskedFroms, wantWithdrawAskedFroms);

  assert(
    withdrawFroms.every((id) => !wantWithdrawAskedFroms.includes(id)),
    "t-withdraw's from-set must not overlap A_WITHDRAWN_KEYS",
  );
});
