# state.json の排他・原子的書き込み・heartbeat を CLI に移す (土台)

依存: state-cli-schema-validation

## 背景 / 現状

`task-pipeline/SKILL.md` (679 行、2026-08-02 時点) は、オーケストレーター (モデル) に **state の記帳そのものを手作業でやらせている**。散文で書かれた手順であり、テストもゲートも無い:

- **排他** (SKILL.md 108-115 行「state.json の書き込み手順 (排他)」): `.task-pipeline/lock` を `mkdir` で作る / 失敗したら 10 秒待って 3 回まで再試行 / 作成時刻が 10 分より古ければ stale とみなすが直接消さず `mv` で退避してから消す / lock 取得後に state.json を**読み直して**自分の変更を最新内容に再適用する。
- **原子的書き込み** (114 行): `state.json.tmp` に全文を書いてから `mv` で置き換える。
- **heartbeat と生存判定** (123-131 行): `sessions/<id>` を `touch`、`find "$d" -type f -mmin +1440 -delete`、`find "$d" -type f -mmin -90` で生存セッション一覧を得る。
- **時刻演算**: 90 分 (executor 沈黙判定) / 30 分 (takeover) / 10 分 (relisted・stale lock) / 24 時間 (追従の打ち切り) / 1440 分 (heartbeat 掃除) が散在する。

`grep -c 'state.json'` = 32 行、id 集合 (`handled` / `pending_ids` / `relisted` / `promoted` / `withdrawn_branches`) への言及は 31 行ある。**このリポジトリは同じ問題を一度解いている** — PR の変化検知を `task-pipeline/scripts/watch-pr.sh` に切り出したときの「安いブロッキング検出と高い分類を分ける」がそれで、状態遷移も同じく決定的で安い仕事である。

このアイテムは 3 分割の 1 件目 (土台) で、当初はスキーマ検証も含んでいたが、plan フェーズの検証で 6 回連続 FAIL したため **スキーマ検証部分を `state-cli-schema-validation` として切り出した** (経緯: `.task-pipeline/runs/state-cli-foundation/verdicts/` — lock/heartbeat/init/権限の範囲は3ラウンド目までに収束したが、4ラウンド目以降は手書きの `checkState` がフィールド・階層ごとに個別実装であるための取りこぼしが続いた)。本アイテムはそれに依存し、dispatch・lock・原子的書き込み・heartbeat・init・権限封じ込めに範囲を絞る。後続の verb 群は `state-cli-verbs`、SKILL.md の書き換えは `skill-state-cli-migration`。

## 実装言語を Deno にした理由 (2026-08-02 に実測して決定)

`deno 2.7.14` / `node 25.9.0` / `python3 3.14.4` はいずれも導入済みで、その中から Deno を選んだ:

- **`deno test` / `fmt` / `lint` / `check` が同梱**なので、テストの土台を別に用意しなくてよい (`test-harness-foundation` の `tests/run.sh` とは独立に走る)。
- **`--allow-read=<state dir> --allow-write=<state dir>` で、CLI が state ディレクトリの外を触れないことを機械的に保証できる。** このリポジトリが `agents/task-pipeline-verifier.md` で verifier の tools を絞っているのと同じ発想で、行動境界を宣言ではなく仕組みで裏づけられる。

Python を採らなかったのは、`jsonschema` が未インストールで追加依存になること (`python3 -c "import jsonschema"` が `ModuleNotFoundError`、2026-08-02 確認) と、テストランナーを自前で用意することになるためである。

## 要求

1. `task-pipeline/scripts/state.ts` (Deno / TypeScript) を追加する。**実行時の外部依存はゼロ** (`npm:` / `jsr:` の参照を持たない)。実行形は `deno run --allow-read=<state dir> --allow-write=<state dir> state.ts <verb> --state-dir <dir> [...]`。
   - 権限フラグで **state ディレクトリの外を読み書きできないことを機械的に保証する**のが要点なので、`--allow-all` で動かす前提の書き方をしない。
2. `state-cli-schema-validation` が実装する `task-pipeline/scripts/state-schema.ts` の `checkState` 関数を import し、書き込み系 verb (`init` の既存ファイル検査・`history-append`) はこれを呼んでスキーマ検証する。**state.ts 側でスキーマの詳細 (フィールド定義・enum値等) を再実装・再定義しない** — `checkState` の判定結果 (ok/path/message) だけを使う。
3. 土台の verb は次の 6 つ:
   - `init` — `.task-pipeline/` と `state.json` を作り、`<git common dir>/info/exclude` に `/.task-pipeline/` を追記する (未記載のときだけ。追跡下の `.gitignore` は触らない)
   - `get` — state.json 全文を stdout へ JSON で出す (parseのみ、スキーマ検証はしない)
   - `validate` — `checkState` を呼び、結果に応じて exit する
   - `session-touch` — `sessions/<id>` を打ち、1440 分より古い印を掃除する
   - `sessions-alive` — 90 分以内に打たれたセッション id の一覧を返す
   - `history-append` — `checkState` で検証しつつ `history` に追記する
4. 上記のうち書き込みを伴うものは、**lock 取得 → 読み直し → `checkState` による検証 → 変更適用 → tmp + rename → lock 解放**を CLI の内側で行う。呼び出し側 (モデル) がこの手順を知らなくてよい状態にする。
5. `schema_version` を state.json に導入する。**既存の `.task-pipeline/state.json` (他プロジェクトで走行中のものを含む) はそのまま読め**、書くときに付与される (現行フィールドの意味は一切変えない。キー挿入順を保存して末尾に追加)。
6. 出力と終了コードの契約を決めてドキュメント化する。成功時は JSON を stdout、失敗時は `{"error": "<code>", "message": "..."}` を stdout に出し、終了コードで種別を分ける (最低限: 使い方の誤り / lock 取得失敗 / スキーマ違反 / state 不在 / 権限)。**エラーでも state.json を書き換えない。**
7. テストを `deno test` で書き、`tests/` から 1 コマンドで走る形にする (既存の `tests/install-sh.test.sh` と同じく依存ゼロ・ネットワーク不要・一時ディレクトリのみを触る)。`scripts-test-harness` が `tests/run.sh` を作るときにこのテストも束ねられるよう、実行コマンドを README かテスト冒頭のコメントに明記する。

## 受け入れ条件

1. `deno test` が全ケース PASS し、ネットワークに出ない。
2. **lost update が起きない**: 一時ディレクトリの state に対し、`history` 追記を行う CLI 呼び出しを 100 並列で実行すると、完了後の `history` に 100 件すべてが残る。
3. **部分書き込みが観測されない**: 書き込みの途中でプロセスを kill しても、`state.json` は直前の内容のまま妥当な JSON であり、`validate` が PASS する (残骸の `.tmp` があってもよい)。
4. **stale lock の回収が単独である**: 10 分より古い lock がある状態 (境界のちょうど 10 分・11 分の両方を含む) で 2 プロセスが同時に回収を試みると、除去に成功するのは 1 プロセスだけで、もう一方は通常の待ちに戻る (両方が `state.json` を書くことはない)。10 分未満の lock は回収されず、3 回の再試行後に lock 取得失敗の終了コードで終わる。
5. **スキーマ違反時に state が不変**: `checkState` が invalid を返す入力に対し、書き込みを伴う verb がスキーマ違反の終了コードで失敗し、**ファイルの内容が 1 バイトも変わらない** (スキーマ判定の網羅性自体は `state-cli-schema-validation` の受け入れ条件で担保する。本アイテムは「invalid 判定を受けて正しく exit し、ファイルに触れない」という統合の一点のみを検証する)。
6. **後方互換**: `schema_version` を持たない現行形式の state.json (`state-cli-schema-validation` の `valid-legacy-live.json` 相当のフィクスチャ) を `get` が読め、書き込み verb 実行後に `schema_version` が付与され、それ以外のフィールドが値も並びも意味も変わらない。
7. **heartbeat の等価性**: `session-touch` 実行後に `sessions/<id>` が存在し、1441 分前・1440 分前(境界)・1439 分前の mtime を持つ印でそれぞれ削除有無が正しく、89 分前・90 分前(境界)・91 分前の印で `sessions-alive` への出現有無が正しい (SKILL.md 123-131 行の 2 コマンドと同じ結果になる)。
8. **権限の封じ込め**: `--allow-read` / `--allow-write` を state ディレクトリに限定した状態で全 verb が動作し、state ディレクトリ外のパスを `--state-dir` に与えた場合、また `init` の `--git-common-dir` に allow 外のパスを与えた場合は権限エラーで失敗し、部分的な書き込みも残らない (CLI 自身が外を触らないことをテストで固定する)。
9. `init` を 2 回実行しても `info/exclude` の行が重複せず、既に `/.task-pipeline/` があるときは追記しない。追跡下の `.gitignore` は変更されない。
10. 終了コードと JSON 出力の契約が `task-pipeline/docs/` 配下か `state.ts` 冒頭のコメントに一覧化され、テストがその一覧を固定している。
11. `sh tests/run.sh` が本アイテムのテストスイート込みで PASS し、deno の無い環境では SKIP で他スイートを壊さない。
12. `deno fmt --check` / `deno lint` / `deno check` が `state.ts` に対し警告ゼロ。
