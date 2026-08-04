# gate:light の sha 引き継ぎと gh の復帰手順で、説明が実装と食い違う

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。いずれも 2026-08-03 に実ファイルで確認済み。

### (1) 「sha は読まれない」が実態と逆

`task-prep/SKILL.md:59` は gate:light の sha 記録について「**記録した sha は現時点では task-pipeline 側で一切読まれない (将来 sha を使う機能のための準備)**」と書く。実際には両方から読まれている:

- `task-pipeline/references/executor.md:52-59` — 「**引き継ぎ (gate: light + sha 記録があるときだけ)**」として `git -C <target project> cat-file -e <sha>` で解決を確かめ、`git diff <sha> HEAD -- <パス...>` が空なら事実主張の再検証を省略してよい、という手順を定義している。
- `task-pipeline/references/verifier.md:28` — 引き継ぎ根拠に sha diff が使われているとき、**verifier 自身が同じ diff を実行して**空であることを確かめる (research.md に転記された結果を信用しない)、と規定している。

由来は `backlog/sha-record-for-gate-light.md` の当時の受け入れ条件で、その後 `gate-light-research-carryover` (commit 6fb82b4) が引き継ぎを実装したときに task-prep 側が追随しなかった。設計の経緯は `task-pipeline/docs/gate-light-research-trust-2026-08.md:69-80` にあり、そこでは「信頼の置き場を明示的に task-prep へ移す判断」と書かれている。**sha の正確さが実際に executor の再検証省略を左右する**ので、「読まれない」という説明は task-prep に誤った安心を与える。

### (2) gh の blocked 復帰手順に assignee の除去が無い

- `task-prep/references/trackers/gh.md:16` — 「深掘りが `blocked` の理由を解消して ready 基準を満たしたときは、`blocked` を外す — 外さないと `?label=ready` でも候補に戻らない」。assignee への言及が無い。
- `README.md:92` — 「候補に戻したいときは、ラベルなら手で外す、PR 紐付けなら PR 本文の `Fixes #<番号>` を消す」。同じく assignee が無い。

`task-pipeline/references/adapters/gh.md:55` は「候補に戻すには **状態ラベルと assignee の両方**を外す必要がある (`in_progress` に一度でもなった issue は assignee が付いたままなので、ラベルだけ外しても `no:assignee` に引っかかって候補に戻らない)」と明記している。同 :56 も「以降の `mark` では触らない — `in_review` / `blocked` に進んでも assignee は付いたままにする」。したがって上記 2 箇所の手順どおりに操作しても候補に戻らない。

### (3) README.md:88 の理由付けが実態と逆

README.md:88 は「着手すると自分にアサインされる（**着手中のラベルは付けない — セッションが落ちたとき候補に戻れなくなるため**）」と書く。しかし `adapters/gh.md:53` は assignee 方式について「トレードオフとして、**セッションが落ちて `state.json` を失ったときの自動リカバリは無い** — 着手途中だった issue は assignee が付いたままなので候補に戻らない。復帰は下記の通り手動 (assignee を外す) で行う」と、**同じ問題が assignee 方式でも残ること**を明記している。つまり括弧内の理由は成立していない。ラベルではなく assignee を選んだ実際の理由は、同 :53 前段の「複数のセッション/エージェントが同時に回しても、他のセッションが着手済みの issue を `list` の候補から除外できる (`no:assignee` フィルタ)」である。

### (4) executor.md の参照がインストール後の配置で解決しない

`task-pipeline/references/executor.md:52` は sha 行の書式について「(書式は `backlog/sha-record-for-gate-light.md` に記録がある)」と参照する。`install.sh` は `SKILL.md` を持つディレクトリ (= `task-pipeline/`) だけを symlink するので、リポジトリ直下の `backlog/` はインストール先に存在しない。実測:

```
$ ls ~/.claude/skills/task-pipeline/
SKILL.md  docs  references  scripts
$ ls ~/.claude/skills/task-pipeline/backlog
ls: /Users/naoki/.claude/skills/task-pipeline/backlog: No such file or directory
```

さらに executor は target project を作業ディレクトリとして動くので、相対パス `backlog/...` は target project 側の無関係なパスとして解決されうる。`grep -rn 'backlog/' task-pipeline/` のヒットはこの 1 件だけである (同じ executor.md 内の他の参照、例えば `docs/gate-declaration-2026-08.md` は `task-pipeline/` 配下なので解決する)。

## 要求

1. `task-prep/SKILL.md` の「記録した sha は現時点では task-pipeline 側で一切読まれない」を実態に合わせて書き直す。executor が引き継ぎ判定に、verifier が再確認にそれぞれ使うこと、したがって sha の正確さが結果を左右することが読み取れる形にする。
2. `task-prep/references/trackers/gh.md` の blocked 復帰手順に assignee の除去を加える。
3. `README.md` の候補復帰の説明 (:92 相当) に assignee の除去を加える。
4. `README.md:88` 相当の括弧内の理由を実態に合わせる。assignee 方式でもセッション消失時に候補へ戻らないことは `adapters/gh.md:53` が明記しており、ラベルを避けた理由は複数セッションの `no:assignee` 排他である。
5. `executor.md:52` の `backlog/sha-record-for-gate-light.md` 参照を、インストール後の配置で解決する形に直す (書式をその場に書く、または `task-pipeline/` 配下の文書を指す)。
6. **task-pipeline 側の実装 (`scripts/` 配下、アダプタの手順そのもの、executor の引き継ぎ手順そのもの) は変更しない** — 食い違っているのは説明の側である。

## 受け入れ条件

1. `grep -rn '一切読まれない' task-prep/` が 0 件であり、`task-prep/SKILL.md` の該当箇所から「executor と verifier が sha を読む」ことが読み取れる。
2. `task-prep/references/trackers/gh.md` の blocked 復帰の記述に assignee の除去が含まれている。
3. `README.md` の候補復帰の説明に assignee の除去が含まれている。
4. `README.md` に「セッションが落ちたとき候補に戻れなくなるため」という理由付けが残っておらず、assignee を選んだ理由の記述が `adapters/gh.md:53` と矛盾しない。
5. `grep -rn 'backlog/' task-pipeline/` が 0 件であるか、残る参照がインストール後の配置で実在するパスを指している。後者の場合、`ls ~/.claude/skills/task-pipeline/<そのパス>` が成功する実出力が成果物にある。
6. `git diff` で `task-pipeline/scripts/` 配下に変更が無い。
7. `sh tests/run.sh` が全スイート PASS で exit 0。

## 備考

要望の元になった候補には markdown トラッカーの状態表 (`task-prep/references/trackers/markdown.md` に `(wip)` / `(blocked: ...)` / `## In Review` と「優先度を付けない」旨が無い) も含まれていたが、`markdown-inreview-blocked-return` (`adapters/markdown.md` の復帰経路そのものを変えうる) と重なるため、そちらへ移した。この issue は gh と sha に閉じる。
