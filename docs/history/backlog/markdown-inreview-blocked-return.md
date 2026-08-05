# markdown アダプタで In Review 中に blocked になったタスクが候補に戻れない

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。

`task-pipeline/references/adapters/markdown.md:37` は状態の意味をこう書く:

> `(blocked: ...)` = 進められない (**suffix を手で消せば候補に復帰**)

この復帰の主張は無条件だが、成立するのは行がバックログ本体にあるときだけである。同ファイル :36 の `list` は「`## In Review` / `## Done` セクションより前 (バックログ本体) にある行頭の `- [ ] <id>` 行だけ」を拾う。

一方 `mark` の各状態はこうなっている:

- :74 `in_review` — 行を元の位置から削除し、`## In Review` セクションの末尾に追加する
- :76 `blocked` — ` (wip)` が付いていれば外し、行末に ` (blocked: <reason>)` を追記する (**行は元の位置のまま**)

したがって、既に `## In Review` にある行が blocked になると、`(blocked: ...)` 付きの行が `## In Review` セクションの中に残る。この行は `list` の読み取り範囲の外なので、**suffix を手で消しても候補に戻らない**。:37 の復帰手順はこのケースで誤りである。

この経路は実在する。`task-pipeline/SKILL.md:322` により `pr_fix` は通常フェーズと同じ検証ゲートを通り、`task-pipeline/SKILL.md:247` は「1 フェーズにつき検証は最大 3 回 (初回 + リトライ 2 回)。3 回目も FAIL ならタスクを blocked にする: `state.ts block --id <id> --reason <最後の FAIL 理由>` を呼び (`session` は null に戻る)、アダプタで `mark <id> blocked <理由>`」と規定する。`pr_fix` は in_review になった後に走るフェーズなので、対象行は既に `## In Review` にある。(`rebase_fix` は `SKILL.md:425` が「使い切っても blocked にしない」と規定しているので該当しない。)

同ファイル :38 は In Review からの差し戻しについて「In Review の行をバックログ本体に戻せば list に再登場して候補に復帰する (パイプライン側の反映遅延ガードにより、復帰は 2 回目の list からになる)」と書いているが、これは blocked のケースを扱っていない (suffix も消す必要がある、という記述が無い)。gh アダプタ側は同種の復帰手順を `adapters/gh.md:55` に明記している (状態ラベルと assignee の両方を外す、close 済みなら reopen も要る) ので、markdown だけが取り残されている。

## 併せて直す: task-prep 側の状態表が現行のアダプタ仕様と揃っていない

`task-prep/references/trackers/markdown.md:7-13` の状態表は 3 状態 (リスト掲載 / 未掲載+`依存:` / 未掲載) しか持たず、パイプラインが書く `(wip)` / `(blocked: ...)` / `## In Review` がどこにも出てこない。同 :13 は「task-pipeline の markdown アダプタは**リストに載っていないアイテムファイルを無視する**」「リスト掲載がそのまま ready 兼依存ゲートになる」と書くが、`adapters/markdown.md:36` はリスト掲載行のうち `(blocked: ...)` / `(wip)` 付きを除外するので、「リスト掲載 = ready」は不正確である。task-prep の棚卸し (`task-prep/SKILL.md:115`) は実行中タスクの除外条件を gh の語彙 (状態ラベル・assignee・PR 紐付け) だけで書いており、markdown で棚卸しすると走行中タスクの本文を書き換えうる。

同じファイルには優先度の記述も無い。`task-prep/SKILL.md:72` は「表現はトラッカー別 (references/trackers/)」と言うが、`adapters/markdown.md:66` は「**`priority` は返さない** — このトラッカーではリストの並び順がそのまま実行順の表明なので、優先度を別の軸で二重に持たない」と明記しており、markdown では優先度を付けないことが正しい。その旨が trackers/markdown.md に無いため、task-prep 側から見て空白になっている。

## 要求

1. `adapters/markdown.md` に、`## In Review` にある行が blocked になった場合の復帰手順を定義する。:37 の無条件の復帰主張を、行の位置で場合分けした正しい記述にすること。
2. 復帰手順の実現方法は実装で選んでよい。例: `mark blocked` が `## In Review` の行を扱うときはバックログ本体へ戻す、あるいは行は動かさず :37/:38 に「suffix を消したうえでバックログ本体へ戻す」と書く。**アダプタの挙動を変える場合は :74/:76 の記述も揃えること。**
3. `task-prep/references/trackers/markdown.md` の状態表に、パイプラインが書く 3 表現 (`(wip)` / `(blocked: ...)` / `## In Review`) を加え、`adapters/markdown.md:36-38` と矛盾しない形にする。「リスト掲載 = ready」という記述も、除外される表現があることを踏まえた形に直す。
4. 同ファイルに、markdown では優先度を付けない旨を書く (`adapters/markdown.md:66` が `priority` を返さないため)。
5. `task-prep/SKILL.md` の棚卸しの除外条件 (:115 相当) が markdown でも機能するようにする — gh の語彙だけで書かれている現状を、トラッカー別の表現を参照する形にするか、markdown の表現を併記する。
6. **`task-pipeline/scripts/` 配下は変更しない。**

## 受け入れ条件

1. `adapters/markdown.md` を読んだ第三者が、「`## In Review` にある行に `(blocked: ...)` が付いた状態から候補に戻す手順」を一意に実行できる。手順が :37 の一般記述と矛盾していない。
2. `adapters/markdown.md` に、`(blocked: ...)` の復帰について「suffix を消すだけでよい場合」と「それでは戻らない場合」の区別が書かれている。
3. 要求 2 でアダプタの挙動 (`mark blocked` の行の扱い) を変えた場合、:74 / :76 の記述がその挙動と一致している。
4. `task-prep/references/trackers/markdown.md` の状態表に `(wip)` / `(blocked: ...)` / `## In Review` が現れ、それぞれの意味が `adapters/markdown.md:36-38` と一致している。
5. 同ファイルに、markdown トラッカーでは優先度を付けない旨が書かれている。
6. `task-prep/SKILL.md` の棚卸しの除外条件が、markdown トラッカーで棚卸しした場合にも実行中タスクを除外できる形になっている。
7. 実際の `backlog/TASKS.md` を模したフィクスチャ (`## In Review` 内に `(blocked: ...)` 付きの行がある状態) に対して、要求 1 の手順を実行した後にその id が `list` の対象になることを、手順どおりの操作の実出力で示す。
8. `git diff` で `task-pipeline/scripts/` 配下に変更が無い。
9. `sh tests/run.sh` が全スイート PASS で exit 0。
