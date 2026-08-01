# README を現行機能に同期する

## 背景 / 現状

README.md は 2026-08-01〜02 の機能追加に追随しておらず、以下が欠落・矛盾している (行番号はコミット 3015e87 時点。`grep -n "approve\|max_open\|priority-\|gate-light\|PushNotification" README.md` が 0 件であることを確認済み)。

欠落 (README に存在しない機能):

- `approve=ask|auto` 引数 (task-pipeline/SKILL.md 26-28 行)。特に auto は「トラッカー側の ready が人間ゲートとして機能しているときだけ安全 — `?label=ready` のような絞り込み無しで使ってはならない」(28 行) という安全条件付き。
- `max_open` 引数 (29 行。マージ待ち PR の上限、既定 2)
- priority ラベルによる順位操作 (`priority-high` / `priority-low` で候補を 3 段に分ける — SKILL.md 174 行、references/adapters/gh.md 88 行)
- gate 宣言 (`gate-light` ラベル / markdown のマーカー行で research+plan を統合 — SKILL.md 90 行、task-prep/SKILL.md 46-66 行)
- レビュー待ち・blocked 時の PushNotification (SKILL.md 157 行・280 行)
- 取り下げられた PR の queue からの出口 (SKILL.md 388-393 行)
- task-prep の棚卸し (入力なしの入口 — task-prep/SKILL.md 91 行)

矛盾 (現仕様と食い違う既存記述):

- README 61 行「使うラベルは `in-review` と `blocked` の 2 つだけ」 — 書くのは 2 つだが、読むだけのラベルが 3 つある (references/adapters/gh.md 41 行)
- README 68 行「実行順は issue 番号の昇順」 — 現在は priority 段 + トリアージ順位が承認順を決める (SKILL.md 174 行)。references/adapters/gh.md 70 行の「(= 実行順)」も同じ理由で古い
- README 95 行「入力なし: 依存が解決した issue の昇格と状況報告だけ」 — 現在は棚卸し (task-prep/SKILL.md 91 行)
- README 102 行「gh で使うラベルは `ready` と `pending-deps` の 2 つ」 — gate-light が 3 つ目 (task-prep/references/trackers/gh.md 21 行)

また prompts/ の 2 ファイル (build-loop-task-pipeline.md、build-task-prep.md) は過去の依頼文の記録だが、その印が無く、現状と矛盾する記述 (「いまはまだ空です」等) を現在形で含む。

## 要求

1. README.md に欠落 7 点を反映する (使い方の節に、それぞれ 1 段落〜数行で。approve=auto は安全条件込みで)。
2. 矛盾 4 箇所を現仕様に合わせて直す (references/adapters/gh.md 70 行の「(= 実行順)」も同時に直してよい)。
3. prompts/build-loop-task-pipeline.md と prompts/build-task-prep.md の冒頭に「YYYY-MM-DD 時点の依頼文の記録。現行仕様は task-pipeline/SKILL.md・task-prep/SKILL.md を見よ」相当の 1 行を足す (日付は git log で当該ファイルの追加コミットの日付を使う)。
4. skills 一覧表 (README の「## skills 一覧」の表) には触らない — 表の自動生成は既存タスク readme-list-sync の管轄。
5. README の説明は SKILL.md の記述と矛盾しない範囲の要約とし、SKILL.md の詳細を書き写しすぎない (README は使い方、SKILL.md が正)。

## 受け入れ条件

1. README.md に対する grep で `approve=auto`、`max_open`、`priority-high`、`gate-light` または `gate 宣言`、`棚卸し` がそれぞれ 1 箇所以上ヒットする。
2. README に approve=auto の安全条件 (ready 絞り込みの無いソースに向けない旨) が明記されている。
3. 矛盾 4 箇所 (旧 61・68・95・102 行) の記述が現仕様と一致している: ラベルの記述が「書く 2 つ + 読む 3 つ」と整合し、実行順の記述が priority 段とトリアージに触れ、task-prep の入力なしが棚卸しになっており、task-prep のラベルに gate-light が含まれる。
4. prompts/build-loop-task-pipeline.md と prompts/build-task-prep.md の先頭 5 行以内に、記録である旨と現行仕様への参照を含む行がある。
5. README の skills 一覧表に差分が無い (git diff で確認できる)。
6. 変更対象が README.md、prompts/build-*.md の 2 件、(任意で) task-pipeline/references/adapters/gh.md の当該 1 行に限られ、他のファイルに差分が無い。

<!-- task-pipeline:gate=light -->
