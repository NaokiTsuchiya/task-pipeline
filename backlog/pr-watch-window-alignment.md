# PR 追従の観測窓 (reviewThreads) を署名窓に揃える

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。

PR 追従は 2 つの GraphQL クエリを使う。変化検知用の署名を作る `task-pipeline/scripts/watch-pr.sh` と、指摘を読み取る観測サブエージェント用の `task-pipeline/references/pr-watcher.md` である。この 2 つのレビュースレッド取得窓が現在**逆向き**になっている:

- `task-pipeline/scripts/watch-pr.sh:63` — `reviewThreads(last:100)`
- `task-pipeline/references/pr-watcher.md:82` — `reviewThreads(first:100)`

`pr-watcher.md:89` 自身が「取得窓は署名側が変化を検知しうる範囲に合わせてある。狭めてはならない」「ここを狭めると署名は動いたのに観測に載らない変化が生まれ、`clean` 判定でその変化だけが消費される (署名は先に進むので、同じ指摘が再び検知されることはない)」という不変条件を宣言しているが、スレッド窓でこれが破れている。スレッド総数が 100 を超える PR では 2 つの窓が互いに素な集合になり、直近側スレッドの resolve/unresolve が署名を動かすのに観測 (古い側 100 本) には現れず、その指摘は永久に失われる。

**実装 (`last:100`) が正である。** commit 2aac9fc が「reviewThreads に totalCount を足し、窓を first:100 から last:100 (comments/reviews と同じ「直近側」) に変えることで、スレッド総数が 100 を超えたあとの新規スレッド投稿・直近スレッドの resolve/unresolve を署名に反映させる」と意図を明記しており、`watch-pr.sh:26-29` のコメントも `last:100` 前提で残余を説明している。ドキュメント側が追随しなかったのが原因である (先行する commit ea2f0f6 が pr-watcher.md を当時の `first:100` に合わせた後、2aac9fc がスクリプトだけを変えた)。

スレッド以外の窓は既に一致している (PR 直下コメント `last:50` / レビュー `last:50` / スレッド内コメント `last:20` — `pr-watcher.md:83-85` と `watch-pr.sh:61-63`)。ずれているのは `reviewThreads` の 1 箇所だけである。

同じ追随漏れが署名の内訳と残余の説明にも及んでいる:

- `README.md:59` — 署名の内訳から「スレッド総数」が抜けている (実際は `watch-pr.sh:76` で `reviewThreads.totalCount` が署名に入っている)。さらに「スレッド自体は**作成順の先頭** 100 本まで」「新規投稿と返信は、そのスレッドが 100 本目までなら常に窓に入る」は `first` 前提で、`last` では結論が反転する。「101 本目以降のスレッドへの投稿や返信は検知されない」も、新規スレッドの作成は totalCount で検知されるため不正確。
- `task-pipeline/SKILL.md:274` — 署名の内訳から同じく「スレッド総数」が抜けている。
- `task-pipeline/references/pr-watcher.md:91` — 残余を「101 本目以降のスレッドの変化 (新規スレッド・解決状態を含む)」と説明するが、新規スレッドは totalCount で検知される。`watch-pr.sh:26-29` によれば実際に残るのは「スレッド総数が 100 を超えるときの、最も古い側のスレッドの resolve/unresolve」だけである。
- `task-pipeline/references/pr-watcher.md:89` — 署名側への参照が「`watch-pr.sh` 48-50 行」だが、現在 48-50 行は PR URL の正規表現部で、クエリは 58-66 行 (窓の指定は 61-63 行)、署名を組む jq は 70-80 行。この裸の行番号参照が今回の追随漏れを見つけにくくした原因である。

なお `tests/` には 2 つの窓の一致を確かめるケースが無い (2026-08-03 に `grep -rn 'pr-watcher\|reviewThreads' tests/` で確認。ヒットするのは `tests/watch-pr.test.sh` のフィクスチャ JSON だけで、いずれもスクリプト単体の署名挙動を見るもの)。同種のドリフト検知の前例としては `scripts/sync-readme-skills.sh` と `tests/sync-readme-skills.test.sh` がある。

## 要求

1. `pr-watcher.md` の観測クエリのスレッド取得を `last:100` に変え、署名窓と一致させる。
2. 上に挙げた 4 箇所の記述を実装の実態に合わせる (署名の内訳への「スレッド総数」追加、残余の説明、README の窓の説明、行番号参照)。
3. **`watch-pr.sh` 自体は変更しない** — 実装が正である。
4. 2 つの窓の一致を機械的に確かめるケースを `tests/` に追加し、次に同じ追随漏れが起きたら赤くする。判定対象は `watch-pr.sh` の署名クエリと `pr-watcher.md` の観測クエリの取得窓で、少なくとも `reviewThreads` を覆うこと (他の 3 つの窓も併せて見るかは実装の判断でよい)。

## 受け入れ条件

1. `grep -n 'reviewThreads(' task-pipeline/scripts/watch-pr.sh task-pipeline/references/pr-watcher.md` が返す 2 ファイルの窓指定が、どちらも `last:100` で一致している。
2. `grep -rn '作成順の先頭' README.md task-pipeline/` が 0 件である。
3. `grep -n 'スレッド総数' README.md task-pipeline/SKILL.md` が両ファイルで 1 件以上ヒットし、いずれも署名の内訳の列挙の中にある。
4. `README.md` と `pr-watcher.md` の残余の説明が `watch-pr.sh:22-29` のコメントと矛盾しない — 具体的には (a) 新規スレッドの作成を「検知されない」側に含めていない、(b) 窓外として挙げるのが「最も古い側のスレッド」である。
5. `pr-watcher.md` の署名側への参照が、裸の行番号ではなく grep できる引用文言 (または行番号と併記した引用文言) になっている。参照先を実際に開いたとき、指している内容が説明と一致する。
6. `git diff` で `task-pipeline/scripts/watch-pr.sh` に変更が無い。
7. 要求 4 のケースが `tests/run.sh` から実行され、PASS する。
8. 要求 4 のケースを、`pr-watcher.md` の窓を `first:100` に戻した状態で実行すると FAIL することを確認した実出力が成果物にある (戻した変更は確認後に元へ戻すこと)。
9. `sh tests/run.sh` が全スイート PASS で exit 0。
