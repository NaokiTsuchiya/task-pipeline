# テストハーネスの土台と watch-pr.sh の挙動固定

## 背景 / 現状

リポジトリの実行可能物は 4 本ある: `install.sh`、`task-pipeline/scripts/watch-pr.sh` (126 行)、`task-pipeline/docs/scripts/aggregate-orchestrator-usage.py`、同 `aggregate-session-usage.py`。このうち**テストがあるのは `install.sh` だけ**である (`tests/install-sh.test.sh`、236 行、C1〜C14。`install-agents-symlink-resolution` の実装コミット `6dba3eb` で入った)。

`watch-pr.sh` は 4 本中で変更頻度が最も高く、**終了コードが `task-pipeline/SKILL.md` の追従分岐を直接駆動する**:

- `exit 0` + `PR-WATCH <task> changed <旧> -> <新>` (126 行中の 120-121 行) → 観測サブエージェントの起動
- `exit 2` + `PR-WATCH <task> timeout <署名>` (125-126 行) → 観測せず張り直し、`stalled_since` は進めない
- `exit 3` (80-81 行 / 112-113 行) → 取得失敗。`watch.errors` を +1
- `exit 4` (33 行 / 41-42 行) → 引数不正

この対応が壊れると、パイプラインは「変化が無い」と「観測できない」を取り違える。それを固定するテストが 1 本も無い。

このアイテムは `scripts-test-harness` を分解した 3 件のうちの土台であり、**ハーネスと `watch-pr.sh` のケースだけ**を扱う (署名のバグ修正は `watch-pr-signature-window`、集計スクリプトは `aggregate-scripts-phase-token`)。

## 要求

1. `tests/run.sh` を追加する。**1 コマンド (`sh tests/run.sh`) で全テストが走り、全ケース PASS なら exit 0**。依存ゼロ・ネットワーク不要で、ハーネス自体は POSIX sh で書く (`watch-pr.sh` の実行に bash が要るのは前提としてよい)。
2. **既存の `tests/install-sh.test.sh` を `tests/run.sh` から束ねる。** 既存テストの内容は変更しない (C1〜C14 は `install.sh` と `install-agents-symlink-resolution` の受け入れ条件をすでに覆っている)。
3. **モック `gh`** を用意する。PATH の先頭に置き、呼び出し回数と引数に応じてフィクスチャ JSON を返す / 失敗する小さなスクリプトとする。実 `gh`・実 GitHub・ネットワークには一切依存しない。
4. `watch-pr.sh` のケースを書く。最低限:
   - 4 つの終了コード (0 / 2 / 3 / 4) それぞれ
   - `changed` 時の stdout 形式 `PR-WATCH <task> changed <旧> -> <新>`
   - 第 5 引数 (前回署名) を渡すと、起動直後の 1 回目の比較で `changed` になること
   - `TASK_PIPELINE_HEARTBEAT` に指定したファイルが 1 周ごとに touch されること
   - interval を 1 秒等に絞り、ハーネス全体が数十秒で終わること
5. **ハーネスが実際に失敗を検出できることを示す** (変異検査)。`watch-pr.sh` の失敗回数の閾値 (5 回連続で `exit 3`) を 1 に変えると、該当ケースが FAIL すること。確認は変えて戻すだけでよく、恒久的な変更は残さない。
6. `watch-pr.sh` の外部挙動 (終了コード・stdout の形式) は変更しない。このアイテムは**固定するだけ**である。
7. テストの追加が容易な形にしておく。今後 `state-cli-foundation` の `state.ts` (Deno) や集計スクリプトのテストが加わるので、**新しいテストファイルを置くだけで `tests/run.sh` が拾う**か、1 行の追記で済む構造にする (どちらを採ったかを README かハーネス冒頭のコメントに書く)。

## 受け入れ条件

1. モック `gh` だけが PATH で `gh` として解決される状態 (実 `gh` に到達できない状態) で `sh tests/run.sh` を実行すると、全ケースの PASS / FAIL が表示されて **exit 0** で終わる。
2. `sh tests/run.sh` の実行が既存の `tests/install-sh.test.sh` のケース (C1〜C14) を含み、それらが PASS する。`tests/install-sh.test.sh` 単体での実行 (`sh tests/install-sh.test.sh`) も引き続き exit 0 で通る。
3. `watch-pr.sh` の 4 つの終了コード (0 / 2 / 3 / 4) それぞれに対応するケースがあり、PASS する。`exit 3` のケースは 5 回連続の取得失敗で到達させる。
4. `changed` のケースの stdout が `PR-WATCH <task id> changed <旧署名> -> <新署名>` の形式であることを、文字列比較で判定している。
5. 第 5 引数に「現在の状態と異なる署名」を渡して起動すると、**待たずに** `exit 0` (`changed`) になるケースがあり、PASS する。
6. `TASK_PIPELINE_HEARTBEAT` に一時ファイルのパスを渡して起動すると、そのファイルの mtime が更新されることを確認するケースがあり、PASS する。
7. `sh tests/run.sh` 全体が 60 秒以内に終わる (実測値を成果物に載せる)。
8. **変異検査**: `watch-pr.sh` の失敗回数の閾値を 5 から 1 に変えると、`exit 3` に対応するケースが FAIL する。変更前後の実出力が成果物にあり、リポジトリには閾値 5 の状態が残っている。
9. `watch-pr.sh` に外部挙動の変更が無い (`git diff` で、終了コードと stdout を生成する箇所に差分が無いこと)。
10. `sh -n tests/run.sh` が exit 0 で、bash 拡張 (`[[`、配列等) を使っていない。
11. 新しいテストを追加する手順が README かハーネス冒頭のコメントに 1〜2 行で書かれている。
