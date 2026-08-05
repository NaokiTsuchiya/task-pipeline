# collect-task-metrics.py に走査モードを追加し、done 回収の後処理に組み込む

## 背景 / 現状

行番号は commit 33ade02 時点。ずれていたら引用文言で grep すること。

タスク単位メトリクスの収集器 `task-pipeline/docs/scripts/collect-task-metrics.py` は、セッション transcript (jsonl) を**明示的に列挙して**渡す形でしか動かない (`task-pipeline/docs/scripts/collect-task-metrics.py:365` の `args = sys.argv[1:]`。glob/ディレクトリ走査は無い — `grep -n "glob\|isdir" で走査系のヒットは diff_stats の isdir 1 件のみ`)。増分収集 (同じ `(session, task_id)` はスキップ) と `--out` 既定値 `~/.claude/task-pipeline/metrics.jsonl` はヘッダ docstring に記載のとおり実装済み。

このため収集は「人が思い出して手で叩く」運用になっており、実際に 2026-08-04 のパイプライン実行 8 タスク分は回し忘れで未収集のまま残っていた (後から手動で追記した)。改善分析の元データに穴が空くのが現状の最大の問題である。

もう 1 つの実態: transcript は 1 リポジトリ 1 ディレクトリではない。`~/.claude/projects/` 配下のディレクトリ名は**セッション起動時 cwd のパスを `/` と `.` を `-` に置換したもの**で、worktree から起動したセッションは別ディレクトリになる。skills リポジトリの実測では `-Users-naoki-work-github-com-NaokiTsuchiya-skills` の完全一致 1 個 + `...-skills--claude-worktrees-*` など計 **11 ディレクトリ**に散らばっていた。単一ディレクトリ指定では worktree 経由のセッション (task-pipeline は常に worktree で回る) を取りこぼす。

組み込み先: `task-pipeline/SKILL.md` の「マージの回収」節が定義する**「done を回収したときの後処理一式」** (done 処理 + 「マージで解けた依存の昇格」「マージ後にプロジェクト側を origin へ追いつかせる」「残った PR を新しい基点へ載せ直す」の 3 節)。ここは done のたびに必ず通る唯一の地点で、収集は増分・冪等なので毎回無条件に呼んでよい。

## 要求

1. `collect-task-metrics.py` に走査モードを追加する: `--scan <プロジェクトルートの絶対パス>` を渡すと、そのパスを `~/.claude/projects/` のディレクトリ名規則 (パス中の `/` と `.` を `-` に置換) で変換し、**「変換名と完全一致」または「変換名 + `-` で始まる」**ディレクトリをすべて発見して、その中の `*.jsonl` を既存の増分収集にかける。前方一致を `-` 区切りに限定するのは、別リポジトリの変換名 (例: `...-skills2`) を誤って拾わないため。
2. 走査モードは既存の明示列挙モードと排他でよい (`--scan` があれば位置引数は不要)。既存の `--out` / `--dry-run` / `--no-diff-stats` は走査モードでも機能する。
3. `task-pipeline/SKILL.md` の「done を回収したときの後処理一式」に、収集の呼び出しを 4 番目の項目として追記する: `python3 <スクリプトパス> --scan <プロジェクトルート> --no-diff-stats` 相当を 1 回呼ぶ。**ベストエフォート**であること (python3 が無い・スクリプトが無い・失敗した場合は history に 1 行残して続行し、パイプラインを止めない。収集は成果物ではない) を明記する。`--no-diff-stats` を既定にするのは後処理の中で gh / git show の追加コストを避けるため。
4. 回帰テストを追加する: `tests/aggregate-scripts.test.sh` と同型の薄い sh ラッパー + Python 本体 (標準ライブラリのみ) の構成で、`tests/run.sh` の glob (`tests/*.test.sh`) から自動検出される場所に置く。

## 受け入れ条件

1. フィクスチャで検証: 一時ディレクトリに `projects/` を模した構造 (変換名完全一致のディレクトリ 1 つ + `<変換名>-worktree-x` 1 つ + **無関係な `<変換名>2` 1 つ**) を作り、それぞれに最小の transcript jsonl を置いて `--scan` を実行すると、前者 2 つだけが収集され、`<変換名>2` は収集されないことをテストが検証している (projects ルートの差し替え手段はテスト用環境変数などスクリプト側で用意してよい)。
2. 同じ `--scan` 実行を 2 回続けて行うと、2 回目の追記が 0 件であることをテストが検証している (増分・冪等)。
3. `grep -n "scan" task-pipeline/docs/scripts/collect-task-metrics.py` にヒットがあり、ヘッダ docstring の使い方に `--scan` が記載されている。
4. `task-pipeline/SKILL.md` の「done を回収したときの後処理一式」の定義に収集の項目が含まれ、`grep -n "collect-task-metrics" task-pipeline/SKILL.md` がヒットする。ベストエフォート (失敗してもパイプラインを止めない) の明記があること。
5. `sh tests/run.sh` が全スイート PASS (failed: 0)、追加したテストスイートが一覧に現れる。
6. 既存の明示列挙モード (`collect-task-metrics.py <session.jsonl>`) の挙動が変わらないこと (既存呼び出し形のテストケースを最低 1 つ含む)。
