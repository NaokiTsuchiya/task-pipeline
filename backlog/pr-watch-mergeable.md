# マージできない PR (コンフリクト / 基点が古い) を watcher が検知して載せ直しに繋ぐ

## 背景 / 現状

行番号は commit 0498660 時点。ずれていたら引用文言で grep すること。

`finish=pr` の PR 追従は、PR の署名が変わったときだけ起きる設計になっている (`task-pipeline/SKILL.md` 「変化を待つ (バックグラウンド)」)。その署名は `task-pipeline/scripts/watch-pr.sh` の `jq_signature` が組み立てる 8 項目である:

```
state | headRefOid | statusCheckRollup | comments.totalCount | reviews.totalCount
     | reviewThreads.totalCount | 未解決スレッド数 | コメント最終更新時刻
```

**マージ可否を表す項目が 1 つも無い。** `grep -rn "mergeable\|mergeStateStatus\|CONFLICTING\|BEHIND"` はリポジトリ全体で 0 件 (backlog/ を除く)。

これは単なる項目の欠落ではなく、**原理的な取り落とし**である。PR がマージ不能になる典型は base ブランチが進んだときだが、そのとき PR 自身の `headRefOid` は変わらず、コメントもレビューも CI も動かない。**署名は 1 ビットも変化せず、watch-pr.sh は最後までブロックしたまま起きない。** 誰かが main を直接動かした場合や、パイプラインが枯渇して追従だけしている間、開いている PR が静かにマージ不能になっても気づく経路が無い。

一方で、**載せ直しの機構そのものは完成している** (`task-pipeline/SKILL.md:373`「残った PR を新しい基点へ載せ直す (rebase)」)。`merge-base --is-ancestor` で基点のずれを見て、rebase して force push し、衝突したらトリアージ (同節「コンフリクトのトリアージ」) を経て解決サイクル (`rebase_fix`、検証ゲートあり) に入る。`rebase=off` で切ることもできる (`task-pipeline/SKILL.md:29`)。

足りないのは**発火条件だけ**である。現在この節が走るのは「done を回収したときの後処理一式」の中だけ (`task-pipeline/SKILL.md:339`)、つまり**自分がマージを回収したときに限られる**。

### 裏取り済みの事実

- `mergeStateStatus` は **preview header 無しで `gh api graphql` から取得できる**。実 PR に対して実行し `{"data":{"repository":{"pullRequest":{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}}}}` が返ることを確認した。
- `mergeable` / `mergeStateStatus` は GitHub が**非同期に計算する**ため、push 直後や closed PR では `UNKNOWN` を返す (上の実測がまさに `UNKNOWN`)。素で署名に入れると push のたびに `MERGEABLE → UNKNOWN → MERGEABLE` の 2 回、余計に起きる。
- **同じ問題への先例が既にある**: `task-pipeline/scripts/watch-pr.sh:68-69` のコメント「CI がまだ登録されていない (null) 状態と PENDING を同じ扱いにする。分けると push 直後に「null -> PENDING」で 1 回無駄に起きる。」と、その実装 `(.commits.nodes[0].commit.statusCheckRollup.state // "PENDING")`。
- watcher の現在の verdict は `fix` / `wait` / `clean` / `merged` / `closed` / `error` の 6 つ (`task-pipeline/references/pr-watcher.md` の出力スキーマ `"verdict": "fix|wait|clean|merged|closed"` と、`error` の単独応答形)。
- テストは `tests/fixtures/mock-gh/gh` にモック `gh` を挿し、呼び出し回数に応じたフィクスチャ JSON を返す方式 (`tests/watch-pr.test.sh` の冒頭コメント)。署名の変化はフィクスチャで検証できる。
- 載せ直し節には再試行を止めるガードが既にある — 対象条件の 3 つ目「`review.rebase.blocked_onto` が現在の `origin/<base>` の sha と一致しない (同じ基点で前回落ちたものを試し直さない)」。

## 要求

1. `watch-pr.sh` の GraphQL クエリに `mergeable` と `mergeStateStatus` を追加し、`jq_signature` の署名項目にも加える。
2. **`UNKNOWN` が余計な起床を生まないようにする。** 既存の `statusCheckRollup` と同じ考え方 (一過性の値を確定値と同じ扱いに畳む) を適用し、なぜそう畳むのかをコードのコメントに残す。畳み方の選択は plan で決めてよいが、**「push 直後の一過性の `UNKNOWN` では起きず、確定した `CONFLICTING` / `BEHIND` では起きる」**という結果を満たすこと。
3. `pr-watcher.md` に verdict **`rebase`** を追加する。名前を `rebase` にするのは、既存の節名 (「残った PR を新しい基点へ載せ直す (rebase)」) と引数 `rebase=auto|off` に一致させ、`fix` と同じく「パイプラインが次に何をするか」を指す命名に揃えるため。対象は open な PR で `mergeable` が衝突を示すか、`mergeStateStatus` が基点の遅れを示す状態。
4. **`rebase` は `fix` より優先する。** 載せ直し節は `pr_fix` を回しているタスクを明示的に対象外にしている (「`in_progress` で `pr_fix` を回しているタスクも対象外 — 足元の履歴を書き換えると成果が壊れる」) ので、両者は同時に成立しない。このとき**未対応の指摘を `handled` に入れてはならない** — force push 後に `watch.sig` が null に戻り catch-up 観測が走るので、そこで再浮上させる。`merged` / `closed` の判定 (`pr-watcher.md` 手順 1〜2) は従来どおり最優先のまま変えない。
5. **watcher は finish モードや `rebase` 引数を知らないままにする** (モード非依存)。`rebase=off` の切り分けはオーケストレータ側で行い、`off` のときは載せ直さずに報告する。
6. `SKILL.md` の「観測」節の verdict 表に `rebase` の扱いを追加し、**既存の「残った PR を新しい基点へ載せ直す」節へ入る**手順として書く (新しい載せ直し経路を作らない)。同じ基点で既に `blocked_onto` が記録されているときは、載せ直しも報告も繰り返さない。
7. 回帰テストを `tests/watch-pr.test.sh` (と `tests/fixtures/` 配下) に追加する。

## 受け入れ条件

1. `grep -n "mergeable" task-pipeline/scripts/watch-pr.sh` と `grep -n "mergeStateStatus" task-pipeline/scripts/watch-pr.sh` がいずれもヒットし、GraphQL クエリと `jq_signature` の両方に現れる。
2. フィクスチャで検証: `mergeable` が `CONFLICTING` のときと `MERGEABLE` のときで署名が異なることをテストが確認している。
3. フィクスチャで検証: `mergeStateStatus` が基点の遅れを示す値 (`BEHIND`) のときと `CLEAN` のときで署名が異なることをテストが確認している。
4. フィクスチャで検証: push 直後を模した `UNKNOWN` への一過性の遷移で署名が変わらない (= 余計に起きない) ことをテストが確認している。
5. `UNKNOWN` を畳む理由がコードのコメントとして `watch-pr.sh` に残っている。
6. `task-pipeline/references/pr-watcher.md` の出力スキーマの verdict 列挙に `rebase` が含まれ、判定順のどこで `rebase` を返すかが記述されている。
7. `pr-watcher.md` に、`rebase` が `fix` より優先されること、およびそのとき未対応の指摘を `handled` に入れない (次の catch-up で再浮上させる) ことが明記されている。
8. `pr-watcher.md` に、watcher が `rebase=off` などのモードを判断しないこと (報告するだけで、切り分けはオーケストレータ) が明記されている。
9. `grep -n "rebase" task-pipeline/SKILL.md` の「観測」節側に、verdict `rebase` を受けたときの扱いがあり、**既存の「残った PR を新しい基点へ載せ直す」節を参照する形**になっている (手順を複製した新しい載せ直し経路を作っていない)。
10. SKILL.md に、`rebase=off` のときは載せ直さず報告することと、同じ基点で `review.rebase.blocked_onto` が既に記録済みなら繰り返さないことが明記されている。
11. 署名の項目が増えることで、アップグレード直後に既存の `watch.sig` が 1 回だけ空振りする (catch-up 観測が 1 回入る) ことを許容する旨が、SKILL.md か watch-pr.sh のコメントに明記されている。
12. `sh tests/run.sh` が全スイート PASS (failed: 0)。
