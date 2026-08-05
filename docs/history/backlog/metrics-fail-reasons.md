# verdicts の FAIL 判定を metrics.jsonl の fail_reasons として統合する

依存: metrics-collect-scan-mode

## 背景 / 現状

行番号は commit 33ade02 時点。ずれていたら引用文言で grep すること。

`collect-task-metrics.py` は phase_counts (フェーズ名→出現回数) でリトライの**回数**は拾えるが、**なぜ FAIL したか**を運ばない (`grep -n -i "verdict\|fail_reason\|required_fixes" task-pipeline/docs/scripts/collect-task-metrics.py` はヒット 0 件)。2026-08-03〜04 の実測ではリトライ 4/8 件が research/plan の事実精度 (行番号ズレ・grep 主張の誤り) 起因という共通パターンがあったが、これは verdicts を 1 件ずつ手で読まないと見えない。横断分析できないため、改善レトロ (retro-loop-connection) の入力にならない。

FAIL の内容は task-pipeline のオーケストレーターが `<プロジェクトルート>/.task-pipeline/runs/<タスクslug>/verdicts/<phase>-<attempt>.json` に保存している。実ファイルの keys は `phase` / `verdict` / `reasons` / `required_fixes` (実測: `runs/state-init-bootstrap/verdicts/research-0.json` で確認。FAIL 時は `required_fixes` が非空、attempt はファイル名の 0 始まり連番)。`pr_fix` / `rebase_fix` は `<phase>-<n>-<attempt>.json` の 3 要素命名になる (task-pipeline/SKILL.md の検証ゲート節)。runs/ ディレクトリは done 回収後も削除されず残る (worktree 削除の対象外)。

collect は transcript の cwd から `repo_root_of()` (`task-pipeline/docs/scripts/collect-task-metrics.py:77-88`) でメインチェックアウトのルートを既に特定しており (worktree cwd → `<...>/github.com/<owner>/<repo>` を取り出す)、verdicts の所在特定にそのまま流用できる。タスク slug は既存フィールド `task` (runs/<slug>/ から抽出済み) にある。

## 要求

1. `collect-task-metrics.py` が各タスク実行の行を作るとき、`<repo_root>/.task-pipeline/runs/<task slug>/verdicts/` を走査し、`verdict == "FAIL"` の判定ファイルから `fail_reasons` フィールドを組み立てて行に載せる。形式は `[{"phase": "<phase>", "attempt": <n>, "required_fixes": ["...", ...]}, ...]` (ファイル名昇順)。
2. **分類はしない。** `required_fixes` の生テキストを運ぶだけにする (事実精度/網羅漏れ/実装ミスといった原因分類は LLM の判断であり、読む側 — レトロ観測 — の仕事。収集器は機械的な転記に徹する)。
3. FAIL が 1 件も無いタスクは `fail_reasons: []`。verdicts ディレクトリが無い・読めない・JSON が壊れている場合はエラーにせず `fail_reasons: null` とし、stderr に 1 行出して続行する (収集全体を落とさない)。
4. 既に metrics.jsonl に収集済みの行への遡及は要求しない (増分収集のスキップ対象のまま。必要になったときに別途判断する)。
5. `summarize-task-metrics.py` への集計表示の追加はこの issue の範囲外 (レトロ側が直接 fail_reasons を読む)。

## 受け入れ条件

1. フィクスチャで検証: verdicts に FAIL (required_fixes 非空) を含むタスクの行に、上記形式の `fail_reasons` が入ることをテストが検証している。
2. FAIL 無し (全 PASS) のタスクの行は `fail_reasons` が `[]` であることをテストが検証している。
3. verdicts ディレクトリ不在のタスクの行は `fail_reasons` が `null` で、収集自体は成功する (exit 0) ことをテストが検証している。
4. 壊れた JSON が verdicts に混ざっていても収集が exit 0 で完走することをテストが検証している。
5. `grep -n "fail_reasons" task-pipeline/docs/scripts/collect-task-metrics.py` にヒットがあり、ヘッダ docstring のフィールド一覧に `fail_reasons` の説明が追記されている。
6. `sh tests/run.sh` が全スイート PASS (failed: 0)。
