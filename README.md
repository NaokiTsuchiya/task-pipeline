# skills

個人用 Claude Code skill 集。

## skills 一覧

| skill | 内容 |
|---|---|
| [task-pipeline](task-pipeline/SKILL.md) | issue トラッカーの承認済みタスクを `/loop` で自動消化するパイプライン |

## インストール

skill ディレクトリを `~/.claude/skills/` に symlink する:

```sh
ln -s "$(pwd)/task-pipeline" ~/.claude/skills/task-pipeline
```

## task-pipeline の使い方

作業対象プロジェクトで:

```
/loop /task-pipeline gh                                          # カレントリポジトリの GitHub issue
/loop /task-pipeline gh ?label=ready finish=pr                   # ready ラベルの付いた issue だけ
/loop /task-pipeline gh owner/repo                               # 別リポジトリの issue
/loop /task-pipeline markdown ./backlog/TASKS.md
/loop /task-pipeline markdown ./backlog/TASKS.md finish=commit   # タスクごとにコミット
/loop /task-pipeline markdown ./backlog/TASKS.md finish=pr       # タスクごとにブランチ + push + PR 作成
```

- 初回はトラッカーのタスク一覧から実行してよいものを選んで承認する。以降は承認済みキューを 1 イテレーション 1 タスクで黙って消化する。
- 各タスクは 調査 → 計画 → 実装 → 報告 の固定フェーズで実行され、各フェーズはフレッシュな検証サブエージェントの PASS なしに先へ進まない。最後の report ゲートは、計画を経由せずタスク本文の要求を最終状態に直接照合する最終受け入れ検証を兼ねる。検証 3 回不合格のタスクは blocked としてトラッカーに書き戻し、次のタスクへ進む。
- タスク実行の成功終端は「レビュー待ち (in_review)」で、Done (マージ/受け入れ完了) にするのはユーザーの判断。コード変更の扱いは `finish` 引数で選ぶ。省略時 (`none`) は working tree に未コミットで残す。`commit` は report の検証 PASS 後にそのタスクの変更だけをコミット。`pr` はタスクごとの `task-pipeline/<id>` ブランチにコミットして push し PR を作る (リモートと `gh` 認証が前提。push/PR は権限プロンプトを通る)。
- 承認済みキューが尽きるとループを止め、実績の最終報告と次の承認候補を提示する。
- 状態は作業対象プロジェクトの `.task-pipeline/` に置かれる (`state.json`、タスク本文、フェーズ成果物、検証判定)。

### gh (GitHub Issues)

**`source` は省略できる**。省略すると作業対象プロジェクトの `origin` から `owner/repo` を自動で解決するので、GitHub がリモートのリポジトリなら `/loop /task-pipeline gh` だけで動く。明示する場合は `owner/repo` に任意のフィルタを付けた形: `owner/repo?label=ready&label=backend&assignee=@me&milestone=v1.0%20release` (リポジトリ部を省いて `?label=ready` だけでもよい)。空白はパーセントエンコードする (`source` に空白は使えない)。`&` を含むのでシェルに直接打つときはクォートする。読み書きは GitHub MCP 経由。

使うラベルは **`in-review` と `blocked` の 2 つだけ**。多くのリポジトリには既にあるが、無ければ一度だけ作る (MCP にラベル作成ツールが無いため)。チームが別の意味でこの名前を使っているなら `?review_label=needs-review&blocked_label=on-hold` のように逃がせる。

```sh
gh label create in-review -c 1D76DB -d "レビュー待ち"
gh label create blocked   -c B60205 -d "進行不能"
```

候補になるのは「open で、この 2 ラベルのどちらも付いていない issue」で、実行順は issue 番号の昇順。着手すると自分にアサインされ（着手中のラベルは付けない — セッションが落ちたとき候補に戻れなくなるため）、作業を終えると `in-review` が付いて PR / コミットの参照がコメントされる。**Done はあなたが issue を close したとき** (`finish=pr` ならマージをローカル git 履歴から検知して自動で close する)。ラベルを手で外せば次の起動で候補に戻る。詳細は [adapters/gh.md](task-pipeline/references/adapters/gh.md)。

### markdown (ローカルバックログ)

markdown バックログは「リストファイル (順序と状態) + 1 タスク 1 アイテムファイル (ファイル名 = id)」の構成。リストは `- [ ] <id>` の並びで、パイプラインが実行を終えると PR / コミットの参照付きで `## In Review` セクションへ移る。**`## Done` はマージ/受け入れ完了の意味**で、あなたがマージすると次のパイプライン起動時にローカル git 履歴からマージを検知して自動で Done へ回収する (`finish=pr` のとき。gh・リモート不要。squash 等で検知できない場合は手で移す)。進められないタスクには `(blocked: 理由)` が付く (手で消せば候補に戻る)。詳細は [adapters/markdown.md](task-pipeline/references/adapters/markdown.md)。

### トラッカーの追加

[task-pipeline/references/adapter-protocol.md](task-pipeline/references/adapter-protocol.md) を参照。`references/adapters/<name>.md` を 1 枚書くだけで、skill 本体に変更は不要。

### 設計メモ

- `/loop` は同一セッションで prompt を毎回そのまま再送する (dynamic は ScheduleWakeup、固定間隔はセッションスコープ cron)。会話コンテキストはイテレーションごとに蓄積するため、状態は `.task-pipeline/state.json` に置いて毎回読み直し、メインコンテキストには判定 JSON などの小さな構造化結果しか載せない。skill 本文も毎回再注入されるので SKILL.md は薄く、詳細指示はサブエージェントが自分で references/ を読む。
- 実行サブエージェントはタスクにつき 1 体で、フェーズごとに停止 → オーケストレーターが検証 → SendMessage で再開、という形で全フェーズを同じコンテキストのまま通す (完了済みエージェントの SendMessage 再開で文脈が維持されることは実機確認済み)。
- 検証サブエージェントはフェーズごと・試行ごとに毎回新規。検証の起動と合否判定をオーケストレーター側に置くことで、実行エージェントが自分の検証を招集・採点できない構造にしている。
