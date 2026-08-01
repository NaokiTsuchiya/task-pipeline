# 実行スクリプトのテストハーネスを作り、確定済みの 2 バグを直す

依存: install-agents-symlink-resolution

## 背景 / 現状

リポジトリの実行可能物 4 本 (install.sh、task-pipeline/scripts/watch-pr.sh、task-pipeline/docs/scripts/aggregate-orchestrator-usage.py、同 aggregate-session-usage.py) には挙動を固定するテストが 1 本も無い (構文チェックは全通過: sh -n / bash -n / py_compile、2026-08-02 に確認)。watch-pr.sh は 4 本中で変更頻度が最も高く、終了コード (0/2/3/4) が task-pipeline/SKILL.md の追従分岐を直接駆動する。加えて、確定済みのバグが 2 つある (行番号はコミット 3015e87 時点):

1. **署名の取得窓の外の変化を検知できない。** watch-pr.sh の署名 (45-66 行) は comments(last:50) / reviews(last:50) / reviewThreads(first:100, 内 comments last:20) の窓内の updatedAt の max と、totalCount・未解決スレッド数で構成される。窓外の変化 — PR 直下コメント 51 件以上での最古側コメントの本文編集、スレッド 101 件以上での窓外スレッドの resolve/unresolve — は署名のどの成分も動かさない。署名の jq をフィクスチャ JSON に対して実行し、窓外編集の 2 入力で署名が完全一致すること (対照: 窓内編集では変わること) を実測済み。GraphQL の並び順 (orderBy 無指定の comments は作成順昇順、reviewThreads に orderBy 引数なし) も実 API で確認済みで、窓外の編集が last 窓に入り込むことはない。スクリプト冒頭 14-16 行の「本文編集を取り落とさない (実測確認済み)」は窓内に限る。
2. **集計スクリプトが統合フェーズトークンを分類できない。** aggregate-session-usage.py の `re.search(r'phase:\s*(\w+)', p)` (32 行) と `re.search(r'PHASE\s+(\w+)\s+DONE', r)` (42 行) は `\w+` が `+` を含まないため、SKILL.md 90 行が規定する統合フェーズの 1 トークン `research+plan` を扱えない。実行して確認済み: `phase: research+plan` は `research` に誤分類され、`PHASE research+plan DONE` は不一致になる。light タスクを含むセッションを集計すると役割別・フェーズ別の内訳が静かに狂う。

## 要求

1. `tests/` (リポジトリ直下) に依存ゼロのテストハーネスを追加する。実行は 1 コマンド (例: `sh tests/run.sh`)。ネットワーク・実 gh・実 GitHub に依存せず、PATH 先頭に置くモック gh (呼び出し回数・引数に応じてフィクスチャ JSON や失敗を返す小さなスクリプト) で watch-pr.sh を駆動する。ハーネス自体は POSIX sh で書く (watch-pr.sh の実行に bash が要るのは前提としてよい)。
2. watch-pr.sh のケース: 4 つの終了コード (0 変化 / 2 timeout / 3 取得失敗 5 連続 / 4 引数不正)、changed 時の stdout 形式 `PR-WATCH <id> changed <旧> -> <新>`、第 5 引数 (前回署名) を渡すと起動直後の比較で changed になること、TASK_PIPELINE_HEARTBEAT のファイルが touch されること。interval を 1 秒等に絞り、ハーネス全体が数十秒で終わること。
3. install.sh のケース: 一時ディレクトリで、新規作成 / 冪等 skip / 異物 (他所向き symlink・実ディレクトリ) の warning + exit 1 / 依存タスク (install-agents-symlink-resolution) の受け入れ条件 1-3 の回帰。
4. 集計スクリプト 2 本のケース: 数行の .jsonl フィクスチャ (message.id 重複、cache_creation 内訳あり / なし、`research+plan` フェーズを含む) に対する出力の突き合わせ。
5. バグ 2 件を「ハーネスで FAIL するケースを先に書いてから直す」形で修正する:
   - watch-pr.sh: 窓外の変化も署名に載るようにする (例: reviewThreads の totalCount と resolve 済み数をクエリと署名に足す等 — GraphQL 1 回・署名 1 行の形は維持する)。完全に閉じられない残余 (例: 窓外コメントの本文編集そのもの) が残る場合は、スクリプト冒頭コメントの「実測確認済み」の主張を実態に合わせて限定し、残余をコメントに明記する。
   - aggregate-session-usage.py: `research+plan` を 1 トークンとして分類する (正規表現 2 箇所の修正)。
6. 既存の外部挙動 (SKILL.md が依存する終了コードと stdout 形式) は変えない。

## 受け入れ条件

1. ネットワークに出ない状態 (モック gh のみが PATH で解決される状態) で `sh tests/run.sh` を実行すると、全ケースの PASS / FAIL が表示されて exit 0。
2. watch-pr.sh の 4 終了コード・stdout 形式・heartbeat・第 5 引数引き継ぎの各ケースがハーネスに含まれ、PASS する。
3. 窓外変化のフィクスチャ対 (旧: コメント 51 件相当、新: 窓外の resolve 状態または件数だけが違う) で watch-pr.sh が exit 0 (changed) になるケースがあり、PASS する。修正前のスクリプトではこのケースが FAIL する (= timeout になる) ことを確認した記録が implementation の成果物にある。
4. `phase: research+plan` を含む起動プロンプトと `PHASE research+plan DONE` を含む結果行のフィクスチャで、aggregate-session-usage.py が `research+plan` として分類する。
5. 変異検査 1 件: watch-pr.sh の failures 閾値 (5) を 1 に変えるとハーネスの該当ケースが FAIL する (変えて戻す確認でよい)。
6. install.sh のケースが依存タスクの受け入れ条件 1-3 を回帰として含む。
