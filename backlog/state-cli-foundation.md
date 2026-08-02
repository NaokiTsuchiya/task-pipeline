# state.json の排他・原子的書き込み・スキーマ検証・heartbeat を CLI に移す (土台)

## 背景 / 現状

`task-pipeline/SKILL.md` (679 行、2026-08-02 時点) は、オーケストレーター (モデル) に **state の記帳そのものを手作業でやらせている**。散文で書かれた手順であり、テストもゲートも無い:

- **排他** (SKILL.md 108-115 行「state.json の書き込み手順 (排他)」): `.task-pipeline/lock` を `mkdir` で作る / 失敗したら 10 秒待って 3 回まで再試行 / 作成時刻が 10 分より古ければ stale とみなすが直接消さず `mv` で退避してから消す / lock 取得後に state.json を**読み直して**自分の変更を最新内容に再適用する。
- **原子的書き込み** (114 行): `state.json.tmp` に全文を書いてから `mv` で置き換える。
- **heartbeat と生存判定** (123-131 行): `sessions/<id>` を `touch`、`find "$d" -type f -mmin +1440 -delete`、`find "$d" -type f -mmin -90` で生存セッション一覧を得る。
- **時刻演算**: 90 分 (executor 沈黙判定) / 30 分 (takeover) / 10 分 (relisted・stale lock) / 24 時間 (追従の打ち切り) / 1440 分 (heartbeat 掃除) が散在する。`grep -c '90 分\|30 分\|10 分\|24 時間\|1440\|mmin'` = 20 行。
- **不変条件が散文の警告文でしか守られていない**: 「`executor` / `executor_last_event_at` / `session` の 3 つは必ず同時に書く」「`review.tip` の更新を落とすと `merge-base --is-ancestor` が二度と真にならない」「`pending_ids` を `handled` へ移し忘れると同じ指摘を毎回直しに行く」など。

`grep -c 'state.json'` = 32 行、id 集合 (`handled` / `pending_ids` / `relisted` / `promoted` / `withdrawn_branches`) への言及は 31 行ある。**このリポジトリは同じ問題を一度解いている** — PR の変化検知を `task-pipeline/scripts/watch-pr.sh` に切り出したときの「安いブロッキング検出と高い分類を分ける」がそれで、状態遷移も同じく決定的で安い仕事である。

このアイテムは 3 分割の 1 件目で、**遷移 verb を載せる土台だけ**を作る (verb 群は `state-cli-verbs`、SKILL.md の書き換えは `skill-state-cli-migration`)。

## 実装言語を Deno にした理由 (2026-08-02 に実測して決定)

`deno 2.7.14` / `node 25.9.0` / `python3 3.14.4` はいずれも導入済みで、その中から Deno を選んだ:

- **`deno test` / `fmt` / `lint` / `check` が同梱**なので、テストの土台を別に用意しなくてよい (`test-harness-foundation` の `tests/run.sh` とは独立に走る)。
- **`--allow-read=<state dir> --allow-write=<state dir>` で、CLI が state ディレクトリの外を触れないことを機械的に保証できる。** このリポジトリが `agents/task-pipeline-verifier.md` で verifier の tools を絞っているのと同じ発想で、行動境界を宣言ではなく仕組みで裏づけられる。
- **JSON Schema を第一級の成果物にしつつ、実行時の依存をゼロにできる。** スキーマは `state.schema.json` に置き、実行時は stdlib だけの構造チェック、`npm:ajv` はテスト専用にする (オフラインでも state 操作が止まらない)。

Python を採らなかったのは、`jsonschema` が未インストールで追加依存になること (`python3 -c "import jsonschema"` が `ModuleNotFoundError`、2026-08-02 確認) と、テストランナーを自前で用意することになるためである。

## 要求

1. `task-pipeline/scripts/state.ts` (Deno / TypeScript) を追加する。**実行時の外部依存はゼロ** (`npm:` / `jsr:` の参照を持たない)。実行形は `deno run --allow-read=<state dir> --allow-write=<state dir> state.ts <verb> --state-dir <dir> [...]`。
   - 権限フラグで **state ディレクトリの外を読み書きできないことを機械的に保証する**のが要点なので、`--allow-all` で動かす前提の書き方をしない。
2. `task-pipeline/scripts/state.schema.json` を JSON Schema として置き、**これを state.json の形の正とする**。実行時の検証は Deno stdlib だけの構造チェックで行い、`npm:ajv` を使うのは**テストのみ** (スキーマと実装の一致を確かめる用途)。
3. 土台の verb は次の 5 つ:
   - `init` — `.task-pipeline/` と `state.json` を作り、`<git common dir>/info/exclude` に `/.task-pipeline/` を追記する (未記載のときだけ。追跡下の `.gitignore` は触らない)
   - `get` — state.json 全文を stdout へ JSON で出す
   - `validate` — スキーマ検証のみ行う
   - `session-touch` — `sessions/<id>` を打ち、1440 分より古い印を掃除する
   - `sessions-alive` — 90 分以内に打たれたセッション id の一覧を返す
4. 上記のうち書き込みを伴うものは、**lock 取得 → 読み直し → 変更適用 → tmp + rename → lock 解放**を CLI の内側で行う。呼び出し側 (モデル) がこの手順を知らなくてよい状態にする。
5. `schema_version` を state.json に導入する。**既存の `.task-pipeline/state.json` (他プロジェクトで走行中のものを含む) はそのまま読め**、書くときに付与される (現行フィールドの意味は一切変えない)。
6. 出力と終了コードの契約を決めてドキュメント化する。成功時は JSON を stdout、失敗時は `{"error": "<code>", "message": "..."}` を stdout に出し、終了コードで種別を分ける (最低限: 使い方の誤り / lock 取得失敗 / スキーマ違反 / state 不在)。**エラーでも state.json を書き換えない。**
7. テストを `deno test` で書き、`tests/` から 1 コマンドで走る形にする (既存の `tests/install-sh.test.sh` と同じく依存ゼロ・ネットワーク不要・一時ディレクトリのみを触る)。`scripts-test-harness` が `tests/run.sh` を作るときにこのテストも束ねられるよう、実行コマンドを README かテスト冒頭のコメントに明記する。

## 受け入れ条件

1. `deno test` が全ケース PASS し、ネットワークに出ない (テスト時の `npm:ajv` 取得を除く。取得できない環境ではそのケースだけスキップし、他は PASS すること)。
2. **lost update が起きない**: 一時ディレクトリの state に対し、`history` 追記を行う CLI 呼び出しを 100 並列で実行すると、完了後の `history` に 100 件すべてが残る。
3. **部分書き込みが観測されない**: 書き込みの途中でプロセスを kill しても、`state.json` は直前の内容のまま妥当な JSON であり、`validate` が PASS する (残骸の `.tmp` があってもよい)。
4. **stale lock の回収が単独である**: 10 分より古い lock がある状態で 2 プロセスが同時に回収を試みると、除去に成功するのは 1 プロセスだけで、もう一方は通常の待ちに戻る (両方が `state.json` を書くことはない)。10 分未満の lock は回収されず、3 回の再試行後に lock 取得失敗の終了コードで終わる。
5. **スキーマ違反を弾く**: 手で壊した state.json (必須フィールド欠落 / 型違い / 未知のフィールド) に対し、書き込みを伴う verb がスキーマ違反の終了コードで失敗し、**ファイルの内容が 1 バイトも変わらない**。
6. **後方互換**: `schema_version` を持たない現行形式の state.json (このリポジトリの `.task-pipeline/state.json` を模したフィクスチャ) を `get` が読め、書き込み verb 実行後に `schema_version` が付与され、それ以外のフィールドが値も並びも意味も変わらない。
7. **heartbeat の等価性**: `session-touch` 実行後に `sessions/<id>` が存在し、1441 分前の mtime を持つ印は削除され、89 分前の印は `sessions-alive` に現れ、91 分前の印は現れない (SKILL.md 123-131 行の 2 コマンドと同じ結果になる)。
8. **権限の封じ込め**: `--allow-read` / `--allow-write` を state ディレクトリに限定した状態で全 verb が動作し、state ディレクトリ外のパスを `--state-dir` に与えた場合は権限エラーで失敗する (CLI 自身が外を触らないことをテストで固定する)。
9. `init` を 2 回実行しても `info/exclude` の行が重複せず、既に `/.task-pipeline/` があるときは追記しない。追跡下の `.gitignore` は変更されない。
10. 終了コードと JSON 出力の契約が `task-pipeline/docs/` 配下か `state.ts` 冒頭のコメントに一覧化され、テストがその一覧を固定している。
11. `state.schema.json` と実装の構造チェックが一致することを確かめるテストがある (ajv が使える環境では、同じフィクスチャ群に対して両者の判定が一致する)。
