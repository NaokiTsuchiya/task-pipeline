**入る条件**: SKILL.md「タスク実行」手順 2 に来たとき (タスク専用の worktree を作る / 作れなかったときの扱いを決める)。

### worktree

タスクは**それぞれ専用の git worktree で実行する**。ユーザーの作業ツリーを触らないので、パイプラインが回っている間もユーザーは同じリポジトリで普通に作業できる。

- 置き場所は `<プロジェクトルート>/.claude/worktrees/task-pipeline/<id>`、ブランチは `task-pipeline/<id>`。作成は SKILL.md「タスク実行」手順 2 で、実行エージェントを起動する**前**に `git -C <プロジェクトルート> worktree add -b task-pipeline/<id> .claude/worktrees/task-pipeline/<id> HEAD` で行う。**必ずプロジェクトルート (メイン worktree) を基準にする** (起動時のカレントディレクトリが別 worktree でもその下に作らない。分岐元の `HEAD` もプロジェクトルートのもの)。**切る前に、プロジェクト側が `origin` に追いついているかを確認する** (`fetch` → `merge --ff-only`。**失敗したら何もせず古い `HEAD` から切り**、遅れたまま切った旨を history に残す)。

- git の制約上 (同じブランチを 2 worktree で同時チェックアウトできない) **worktree を使う以上どのタスクも必ず自分のブランチを持つ** — `finish=commit` も `task-pipeline/<id>` へのコミットになる。レビュー待ちの報告に worktree のパスとブランチ名を必ず書く。
- 作成に成功したら `state.ts set-worktree --id <id> --worktree <絶対パス> --base <その時点のプロジェクト側ブランチ>` を呼んで記録する。レビュー待ちに入るときは `ship --base` にこの `base` をそのまま渡す (rev-parse し直さない — ユーザーがブランチを切り替えていると誤判定に直結する)。
- **作れなかったとき**: **プロジェクトが git リポジトリでない** → worktree 無しでプロジェクトルートを target project にして続行 (`finish=none` 専用)。**ブランチ `task-pipeline/<id>` が既に存在する** (前回実行の残骸、または復帰) → 既存のものを再利用する。`git -C <プロジェクトルート> worktree list` にあればそのパスを、無ければブランチ作成なしで張り直す。`base` は (a) タスクに残っていればそれを使う、(b) 無くても `withdrawn_branches` にあれば `--drop-withdrawn-branch true` でその `base` を使い記録を消す、(c) どちらも無ければ現在のプロジェクト側ブランチ、の順で `set-worktree` に渡す (分岐元とずれた base はマージ回収の誤判定に直結する)。再利用の事実と既存コミット/未コミット変更の有無を history に残す。**それ以外の失敗** → `state.ts block --id <id> --reason <git の実エラー出力を含む理由>` を呼ぶ。
- **削除するのは回収したときだけ** (レビュー待ち/blocked では `finish=none` の未コミット変更や途中成果物が失われるため消さない)。
