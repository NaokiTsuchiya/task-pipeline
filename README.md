# skills

個人用 Claude Code skill 集。

## skills 一覧

| skill | 内容 |
|---|---|
| [task-pipeline](task-pipeline/SKILL.md) | issue トラッカーの承認済みタスクを `/loop` で自動消化するパイプライン |
| [task-prep](task-prep/SKILL.md) | 要望を task-pipeline が消化できる issue 群に変える準備 skill (分解・深掘り・依存整理) |

## インストール

skill ディレクトリを `~/.claude/skills/` に symlink する:

```sh
ln -s "$(pwd)/task-pipeline" ~/.claude/skills/task-pipeline
ln -s "$(pwd)/task-prep" ~/.claude/skills/task-prep
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

- **承認は 1 件ずつ**。パイプラインが候補に優先順位を付け、上位 4 件を推奨付きで提示するので、そこから 1 件選ぶだけでよい (一覧全体を眺めて優先順位を考える必要はない)。その 1 件が終わると次の 1 件を同じ形で聞かれる。
- 各タスクは 調査 → 計画 → 実装 → 報告 の固定フェーズで実行され、各フェーズはフレッシュな検証サブエージェントの PASS なしに先へ進まない。最後の report ゲートは、計画を経由せずタスク本文の要求を最終状態に直接照合する最終受け入れ検証を兼ねる。検証 3 回不合格のタスクは blocked としてトラッカーに書き戻し、次のタスクへ進む。
- タスク実行の成功終端は「レビュー待ち (in_review)」で、Done (マージ/受け入れ完了) にするのはユーザーの判断。コード変更の扱いは `finish` 引数で選ぶ。省略時 (`none`) は working tree に未コミットで残す。`commit` は report の検証 PASS 後にそのタスクの変更だけをコミット。`pr` はタスクごとの `task-pipeline/<id>` ブランチにコミットして push し PR を作る (リモートと `gh` 認証が前提。push/PR は権限プロンプトを通る)。
- ループが止まるのは**トラッカーの候補が尽きたとき**だけで、そこで実績の最終報告を出す。1 件終わっただけでは止まらない。
- 状態は作業対象プロジェクトの `.task-pipeline/` に置かれる (`state.json`、タスク本文、フェーズ成果物、検証判定)。

### gh (GitHub Issues)

**`source` は省略できる**。省略すると作業対象プロジェクトの `origin` から `owner/repo` を自動で解決するので、GitHub がリモートのリポジトリなら `/loop /task-pipeline gh` だけで動く。明示する場合は `owner/repo` に任意のフィルタを付けた形: `owner/repo?label=ready&label=backend&assignee=@me&milestone=v1.0%20release` (リポジトリ部を省いて `?label=ready` だけでもよい)。空白はパーセントエンコードする (`source` に空白は使えない)。`&` を含むのでシェルに直接打つときはクォートする。読み書きは GitHub MCP 経由。

使うラベルは **`in-review` と `blocked` の 2 つだけ**。リポジトリに無くても初回に自動生成されるので事前準備は要らない (色は既定のグレー)。色と説明を付けたいときだけ先に作っておく。チームが別の意味でこの名前を使っているなら `?review_label=needs-review&blocked_label=on-hold` のように逃がせる。

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

## task-prep の使い方

task-pipeline の**上流**。ぼんやりした要望を、実コードの調査に基づいて分解し、検証可能な受け入れ条件付きの issue 群にしてトラッカーへ書き込む。verifier の最終ゲートは issue 本文の要求を最終状態に直接照合するので、issue の書き方がパイプラインの成否をほぼ決める — その「書く仕事」を肩代わりするのがこの skill。

```
/task-prep gh 認証まわりを直したい            # 要望 → 調査 → 分解 → 承認 → issue 作成
/task-prep gh #42                             # 既存 issue 1 件を検証可能なところまで深掘り
/task-prep gh                                 # 入力なし: 依存が解決した issue の昇格と状況報告だけ
/task-prep markdown ./backlog/TASKS.md ログを整えたい
```

- **書き込む前に必ず承認を取る** (結果セットと書き込み先リポジトリを提示してから)。人間にしか答えられない不明点は勝手に埋めず、質問として上げるか `未確定:` として issue に残す (未確定が残る issue は候補にならない)。
- **依存関係**: issue 本文の `依存: #N` 行で表現する。task-pipeline は依存を知らないので、「依存が解けていない issue は候補に見えない」ことを準備側で保証する — 依存がすべて Done になるまで ready にしない。依存の解決 = 依存 issue が**完了として** close (Done) されること (「やらない」= not planned で閉じた依存は解決にならず、従属 issue の扱いを確認される)。`finish=pr` のマージ分は、次にパイプラインを起動したときのマージ回収で close される (手で close してもよい)。close 後に `/task-prep` を叩けば従属 issue が ready に昇格する。
- **接続**: gh は `ready` ラベルがゲート。パイプラインは **`/loop /task-pipeline gh ?label=ready`** で起動する (ready の付いた issue だけが候補になる)。フィルタなしの `/loop /task-pipeline gh` では未準備・依存待ちの issue も候補に入ってしまうので、task-prep で管理するリポジトリでは必ず `?label=ready` を付けること。markdown はリスト掲載がゲートなので `/loop /task-pipeline markdown <list>` のままでよい (ready でないタスクはそもそもリストに載らない)。task-pipeline 側に変更は不要。
- gh で使うラベルは `ready` (準備完了) と `pending-deps` (深掘り済み・依存待ち) の 2 つ。事前作成は不要 (最初の付与時に GitHub が生成する)。裏返すと ready を 1 件も付けたことがないうちは `?label=ready` 起動が「ラベルがありません」エラーで止まる — 準備が終わってから起動する。
