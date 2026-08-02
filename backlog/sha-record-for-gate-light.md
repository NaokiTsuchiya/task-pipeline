# gate: light 宣言時に、裏取り時点の commit sha を issue 本文に記録する

## 背景

`gate-light-trust-issue-facts.md` (保留中) で、`gate: light` タスクの research フェーズが issue 本文とほぼ同じ内容を再調査しているだけ、という問題を確認した。将来的にこれを「issue本文の事実主張と現在のHEADの機械的diffで判定する」形に変えたいが、この機械判定には**裏取り時点のcommit shaがissue本文に記録されている**ことが前提になる。

本 issue はその前提だけを先に用意する。sha を実際に検証・判定に使う変更（verifier/executorの改訂、blocked化の分岐など）は対象外— `gate-light-trust-issue-facts.md` は構造的な欠陥が2回のレビューで見つかっており (declaration:overturned が verdict:PASS と両立してしまう、棚卸しの差し戻しループが閉じていない、diff対象が自己申告に戻る、後方互換が無い 等)、改めて設計し直す必要がある。まずsha記録だけを導入し、後方互換問題 (「導入時点で既存のgate:light issueが全部sha未記録になる」) を先に解消しておく。

## 要求

1. `~/.claude/skills/task-prep/SKILL.md` の「gate 宣言 (light)」節に、`gate: light` を付与する際、事実主張の裏取りに使った target project の commit sha (`git -C <target project> rev-parse HEAD` の値) を issue 本文に記録することを追加する。
2. `references/trackers/gh.md` に、gh issue 本文への記録形式を追記する: 専用の1行 (例 `裏取り時点: <sha>`) を本文に書く。gate 宣言そのものは既存どおり `gate-light` ラベルのままで変更しない (このsha行はラベルでは表現できない値なので本文に置く。`依存:` / `未確定:` と同じ「本文の専用行を機械的に走査する」慣習に従う)。
3. `references/trackers/markdown.md` に、markdown アイテムファイルへの記録形式を追記する: 専用の1行 (例 `<!-- task-pipeline:gate-verified-at=<sha> -->`)。
4. 記録するのは task-prep が裏取りのために target project を調べた時点の HEAD。task-prep がその場で `git rev-parse HEAD` を実行して埋める。
5. 既存の (sha未記録の) `gate: light` issue に遡って追記は求めない。今回追加するのは今後新規に `gate: light` を付与する issue に対する要求のみ。
6. 記録した sha は、この issue の範囲では task-pipeline 側で一切読まれない・使われない。将来 sha を使う機能を作るときのための準備。

## 受け入れ条件

1. `task-prep/SKILL.md` の「gate 宣言 (light)」節に、sha 記録の必須化が文言として存在する。
2. `references/trackers/gh.md` に、issue 本文への sha 記録の具体的な書式が追記されている。
3. `references/trackers/markdown.md` に、markdown アイテムファイルへの sha 記録の具体的な書式が追記されている。
4. 実際に `gate: light` 宣言を伴う issue (gh または markdown どちらでもよい) を1件新規作成し、本文に sha が記録されていることを確認する。
5. 既存の `gate: light` issue の本文が変更されていないこと (遡及追記していないことの確認)。
6. `task-pipeline/` 配下のファイル (`SKILL.md` / `references/executor.md` / `references/verifier.md`) は変更されていないこと (このissueの範囲外であることの確認)。

## 備考

- gate 宣言: 判定基準やコードの入力→帰結の割り当てを一切変えない、プロンプトへの記録項目追加のみだが、迷ったら付けない原則に従い今回は無指定 (full)。
- 優先度: 無指定。
- 依存: なし。
