// task-pipeline/scripts/state-ownership.ts
//
// タスクエントリの「session」フィールドが指す所有セッションを、呼び出し元が「触ってよいか
// 触らないか」に分類する純粋関数。task-pipeline/SKILL.md の「セッションの所有権」節が定める
// 判定 (自分 / null / 生存一覧に無い id / 生存している他セッション) をコードとして持つ —
// オーケストレーター (モデル) が id を突き合わせる手作業をしなくてよいようにするため
// (state-cli-verbs の要求4)。
//
// state-schema-v2.ts と同型の設計: ファイルI/O・排他・時刻取得を一切行わない純粋関数で、
// 呼び出し元 (オーケストレーター) が1回のイテレーション冒頭に取った生存セッション一覧
// (state.ts の `sessions-alive` verb が返す配列) をそのまま渡す想定。CLI verb 化はしない
// (判断の材料は呼び出し元が既に持っており、subprocess を挟む理由が無いため)。
//
// 公開API:
//   classifySessionOwnership(session, selfId, aliveSessionIds): OwnershipVerdict
//     4つの判定 (self/unowned/dead/alive-other) のいずれかを返す。
//   isTouchable(verdict): boolean
//     SKILL.md の規定どおり、alive-other だけが「触らない」対象であることを表す。
//
// テスト (state-ownership.test.ts): import 直呼びのユニットテスト。
//   deno test --allow-read task-pipeline/scripts/state-ownership.test.ts

export type OwnershipVerdict = "self" | "unowned" | "dead" | "alive-other";

/**
 * `session` (queue エントリの所有セッション id) を4パターンに分類する。
 *
 * - `session === null` → "unowned" (誰も所有していない。触ってよい)
 * - `session === selfId` → "self" (自分が所有している。触ってよい)
 * - `session` が `aliveSessionIds` に含まれない → "dead"
 *   (所有セッションの heartbeat が失効している。触ってよい — SKILL.md 「セッションの所有権」
 *   節: 所有者の不在は揮発資源が死んだことの証明にはならないが、所有権だけでは判断せず
 *   playbooks/inflight.md の追加判定と AND を取ることを呼び出し元に委ねる。ここが返すのはあくまで
 *   所有権の分類であって、引き取ってよいかの最終判断ではない)
 * - それ以外 (`session` が `aliveSessionIds` に含まれる、かつ自分ではない) → "alive-other"
 *   (生きている他セッションが所有している。触らない)
 */
export function classifySessionOwnership(
  session: string | null,
  selfId: string,
  aliveSessionIds: readonly string[],
): OwnershipVerdict {
  if (session === null) return "unowned";
  if (session === selfId) return "self";
  return aliveSessionIds.includes(session) ? "alive-other" : "dead";
}

/**
 * SKILL.md の規定 (「`session` が自分以外で、その id が生存一覧にあるタスクには触らない」)
 * をそのままコードにしたもの。`alive-other` だけが false になる。
 */
export function isTouchable(verdict: OwnershipVerdict): boolean {
  return verdict !== "alive-other";
}
