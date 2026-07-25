# GitHub Issues アダプタ

`source` は対象リポジトリ (`owner/repo`) に任意のフィルタを付けたもの。**`source` 全体、またはそのリポジトリ部を省略すると、カレントリポジトリの origin から自動で解決する** (`/task-pipeline gh` だけで動く)。タスクは **1 issue 1 タスク**で、**id は `gh-<issue番号>`**。issue 番号は不変なので、タイトル・本文・ラベルが書き換わっても同じタスクのままである。

読み書きは GitHub MCP で行う。**最初に ToolSearch を 1 回だけ呼び、`query: "github issue list read write comment label"` / `max_results: 10` のようなキーワード検索で issue 系ツール (`list_issues` / `search_issues` / `issue_read` / `issue_write` / `add_issue_comment` / `get_label` / `get_me`) をまとめてロードする。** MCP ツール名にはサーバごとのプレフィックスが付き環境によって変わるので、名前をベタ書きした `select:` は使わない。ロードできなければ `{"error": "GitHub MCP が利用できません"}` / `{"ok": false, "error": ...}` を返す。

## `source` の書式

```
[owner/repo | .][?label=<値>&label=<値>&assignee=<値>&milestone=<値>&review_label=<名前>&blocked_label=<名前>]
```

| 例 | 意味 |
|---|---|
| (空) | カレントリポジトリの open issue すべて |
| `owner/repo` | そのリポジトリの open issue すべて |
| `.` | カレントリポジトリの open issue すべて (空と同じ) |
| `?label=ready` | カレントリポジトリの `ready` ラベルが付いたもの |
| `.?label=ready` | 同上 |
| `.?label=ready&label=backend` | 両方のラベルが付いたもの (AND) |
| `owner/repo?assignee=@me` | 自分にアサインされたもの |
| `owner/repo?milestone=v1.0%20release` | マイルストーン指定 (空白は `%20`) |
| `?blocked_label=on-hold` | blocked を表すラベルを `blocked` から変更 |

パース規則:

1. 最初の `?` でリポジトリ部とクエリ部に分ける。`?` が無ければリポジトリ部のみ。
2. クエリ部を `&` で分割し、各要素を最初の `=` で key / value に分ける。value は**パーセントデコードする** (`source` は位置引数なので空白を含められない)。
3. key は次のみ。それ以外は `{"error": "未対応のキー: <key>"}`。
   - 候補の絞り込み: `label` (複数回書ける。AND) / `assignee` / `milestone`
   - 状態ラベルの上書き: `review_label` (既定 `in-review`) / `blocked_label` (既定 `blocked`)。それぞれ 1 回だけ。
4. リポジトリ部が `.` か空 (`source` 全体が空の場合を含む) なら、**state dir の親ディレクトリ**で `git remote get-url origin` を実行し、`github.com` の URL から `owner/repo` を取り出す。SSH 形式 (`git@github.com:owner/repo.git`) と HTTPS 形式 (`https://github.com/owner/repo.git`) の両方を受け付け、末尾の `.git` は落とす。起動プロンプトは対象プロジェクトのパスを渡してこないので、カレントディレクトリに依存させないこと。
   - リモートが無い / origin が GitHub でない / git リポジトリでない場合は `{"error": "カレントリポジトリを解決できません (<理由>)。source に owner/repo を指定してください"}`。
5. リポジトリ部が空でも `.` でもなく、`owner/repo` 形式でもなければ `{"error": ...}`。

## 状態の表現

パイプラインが使うラベルは **`in-review` と `blocked` の 2 つだけ** (名前は `review_label` / `blocked_label` で変更できる)。以下ではこの 2 つを **状態ラベル**と呼ぶ。

| 状態 | GitHub 側の表現 |
|---|---|
| 未着手 (候補) | open で、状態ラベルがどちらも付いていない |
| `in_progress` | 実行者を assignee に追加 (状態ラベルは付けない) |
| `in_review` | ラベル `in-review` + PR / コミットの参照をコメント |
| `blocked` | ラベル `blocked` + 理由をコメント |
| `done` | issue を close (`state_reason: completed`) + 状態ラベルを外す |

- **`in_progress` にラベルを使わないのは、それが除外に使えないから。** セッションが落ちて `state.json` を失ったとき、着手途中だった issue は候補に戻れないと消えてしまう。除外に使わないラベルは assignee と同じことを二重に書いているだけなので置かない。
- 2 つの状態ラベルは相互排他に保つ。`mark` は目的のラベルを入れ、もう一方を外す (`in_progress` と `done` は両方外す)。手で両方付いても次の `mark` で収束する。
- 復帰: 状態ラベルを手で外せば次の `list` で候補に戻る。close 済みなら reopen すれば戻る。
- assignee は `in_progress` で足すだけで、以降の `mark` では触らない (誰が実行したかの記録として残す)。
- 既定名 `in-review` / `blocked` は多くのリポジトリに既にあり、意味も揃っている (人が `blocked` を付けた issue をパイプラインが拾わないのは正しい)。**ただしパイプラインはこの 2 つを付け外しする。** チームが別の意味で運用しているラベルなら、`review_label` / `blocked_label` で衝突しない名前に逃がすこと。
- **ラベルは MCP からは作成できない。** リポジトリに無ければ `mark` は失敗するので、無い場合は一度だけ手で作っておく。

## `list`

1. `source` をパースしてリポジトリと各フィルタを得る。
2. `label` フィルタがあれば、値ごとに `get_label` で存在を確認する。無ければ `{"error": "ラベルがありません: <名前>"}`。**存在しないラベルで絞ると GitHub はエラーではなく 0 件を返し、それはオーケストレーターに「全タスク完了」と解釈されてループが止まる。**
3. issue を取得する。`assignee` / `milestone` フィルタの有無で経路が変わる。
   - **無い場合 (既定)**: `list_issues(owner, repo, state: "OPEN", labels: [...], orderBy: "CREATED_AT", direction: "ASC", perPage: 100)`。`pageInfo.hasNextPage` が真なら `after` に `endCursor` を入れて続きを取る。この経路は `mark` の結果が即座に反映される。
   - **ある場合**: `search_issues(owner, repo, query: "is:open <フィルタ> -label:\"<review_label>\" -label:\"<blocked_label>\"", sort: "created", order: "asc", perPage: 100)`。ただし検索インデックスには遅延があるので、**残った issue それぞれについて `issue_read(method: "get_labels")` で現在のラベルを読み直し、状態ラベルが付いていれば落とす** (`mark` 直後の `list` で除外済みの issue が再登場しないように)。
4. 件数のガード。`totalCount` (検索経路ではヒット数) が 200 を超えたら列挙せず `{"error": "候補が多すぎます (<N> 件)。source にフィルタを付けて絞ってください"}`。除外後の候補が **既定経路では 30、検索経路では 10** を超えた場合も同じエラーを返す。承認 UI が溢れるうえ、取得レスポンス自体でコンテキストが膨らむため。検索経路の上限が低いのは、`search_issues` のレスポンスが 1 件あたり数千トークンと極端に冗長だから (`list_issues` は 1 件が数百トークン)。
5. 候補が 0 件で、かつ絞り込みフィルタが 1 つでも指定されていた場合は、**同じクエリから `is:open` と状態ラベルの除外を外してもう一度検索する。それも 0 件ならフィルタの値が誤っている可能性が高いので `{"error": "フィルタに一致する issue がありません。label / assignee / milestone の値を確認してください"}` を返す。** 1 件以上あれば本当に枯渇しているので `{"tasks": []}` を返す。
6. 候補を issue 番号の昇順に並べる (= 実行順)。
7. 各候補について `<state dir>/tasks/gh-<番号>.md` を **スタブとして** 書く。**この時点では本文もコメントも書かない** (下記「タスク本文の書き出しを遅らせる理由」):

   ```markdown
   ---
   id: gh-<番号>
   title: <タイトル>
   repo: <owner/repo>
   issue: <番号>
   url: https://github.com/<owner>/<repo>/issues/<番号>
   ---
   (このタスクの本文とコメントは実行開始時に取得される。この行がまだ残っているなら、
   上記 url の issue を自分で読んで要求を把握すること。)
   ```

   - `title` は **JSON 文字列として** (ダブルクォートで囲みエスケープして) 書く。issue タイトルの `:` や `#` で YAML が壊れないようにするため。
   - スタブの最後の行は必ず入れる。`mark in_progress` が失敗しても executor / verifier が URL から自力で要求に到達できるようにするため (オーケストレーターは `mark` の失敗では止まらない)。
8. 応答: `{"tasks": [{"id": "gh-<番号>", "title": "..."}]}` のみ。本文や取得した生データを応答に含めない。
- MCP 呼び出しがエラーを返したら `{"error": "<エラー内容>"}`。**取得できない事情と「候補が 0 件」を決して取り違えない。**

## `mark <id> <status> [reason|ref]`

1. `source` を `list` と同じ規則でパースしてリポジトリを得る (フィルタ部は無視する。空なら同じくカレントリポジトリから解決する)。`id` から `gh-` を外して issue 番号を得る。`gh-<数字>` の形でなければ `{"ok": false, "error": "id の形式が不正です: <id>"}`。
2. `issue_read(method: "get")` で現在の labels と assignees を読む。ラベルは名前の配列で返ることもオブジェクトの配列で返ることもあるので、名前だけを取り出して使う。
3. 新しいラベル集合 = **現在のラベル − 状態ラベル 2 つ + 目的のラベル** (`in_progress` と `done` は足さない = 2 つとも外すだけ)。`issue_write(method: "update", owner, repo, issue_number, labels: <新しい集合>)` を呼ぶ。`labels` は**追加ではなく全置換**なので、必ず現在の集合から計算すること。指定しなかったフィールドは変更されない。集合が現在と同じなら `labels` は送らなくてよい。
4. status ごとの追加操作:
   - `in_progress`: `get_me` の `login` を現在の assignees に足して、同じ `issue_write` の `assignees` に渡す (これも全置換)。すでに入っていれば何もしない。アサインできない権限のリポジトリでは無視されるが、それで失敗扱いにしない。**加えて、下記「タスク本文の書き出し」を行う。**
   - `in_review`: `add_issue_comment` で `パイプラインの作業が完了しました。レビューをお願いします: <ref>` を投稿する。ref が無ければ参照なしの文言で投稿する。
   - `blocked`: `add_issue_comment` で `パイプラインがこのタスクを進められませんでした: <reason>` を投稿する。
   - `done`: `issue_write` に `state: "closed"`, `state_reason: "completed"` を併せて渡す。すでに close 済みでも実質 no-op なので、PR の `Fixes #n` による自動 close と衝突しない。
5. ラベルが存在しないことが原因で失敗したら、直し方を含めて返す: `{"ok": false, "error": "ラベル in-review がリポジトリにありません。作成するか、source の review_label で既存のラベル名を指定してください"}`。
6. ラベル更新に成功してコメント投稿に失敗した場合は `{"ok": false, "error": "..."}` を返す (GitHub 側は部分的に反映済みである旨を書く)。

### タスク本文の書き出し (`in_progress` のときだけ)

`issue_read(method: "get")` で読んだ本文と、コメントを使って `<state dir>/tasks/gh-<番号>.md` を**スタブから完全な形に書き直す**。frontmatter は `list` が書いたものをそのまま保つ (`title` はこの時点の issue タイトルで更新してよい)。

```markdown
---
id: gh-<番号>
title: <タイトル>
repo: <owner/repo>
issue: <番号>
url: https://github.com/<owner>/<repo>/issues/<番号>
---
<issue 本文>

## コメント

### <author> (<created_at>)
<コメント本文>
```

- 本文が空なら `(issue 本文は空です。要求は URL とコメントを参照)` と書く。
- コメントは `comments` の件数が 1 以上のときだけ `issue_read(method: "get_comments")` で取得する。**コメントは古い順に返るので、件数から逆算して新しい方のページだけを取る**: `perPage: 10` として最終ページ (`ceil(件数 / 10)`) を取得し、必要な数に満たなければ 1 つ前のページも取る。
- **bot (`login` が `[bot]` で終わるもの) のコメントは捨てる**。残りのうち**新しい方から 20 件まで**を、**1 コメント 1500 字まで**で書き出す。省いた分は `(古いコメント <N> 件は省略。全文は上記 URL)` / `…(以下省略。全文は上記 URL)` と示す。
- 書き出しに失敗しても**ラベル更新が成功していれば `{"ok": true}` を返す**。スタブの案内文が残っているので、executor は URL から要求に到達できる。

### タスク本文の書き出しを遅らせる理由

`list` は承認されるかどうか分からない候補を最大 30 件並べるが、実際に承認されて動くのはそのうち数件である。本文とコメントを `list` で取ると、捨てられる候補の分まで取得コストを払う。`mark in_progress` はタスク開始時にちょうど 1 回だけ呼ばれる (`SKILL.md` の「タスク実行」手順 1) ので、ここで取れば**実行されるタスクの分だけ・1 回だけ**で済む。承認時点ではなく実行開始時点の内容になるので鮮度も上がる。

逆に、タスクファイル自体を無くして URL だけを渡す形にはしない。タスクファイルのパスは executor と verifier の両方に渡り、4 フェーズ + 検証リトライを通じて 1 タスクにつき 8 回以上読まれる。その都度 issue を取得し直すと取得コストが 8 倍になり、フェーズの途中で issue が編集されると検証の基準まで動いてしまう。
7. 応答: `{"ok": true}` または `{"ok": false, "error": "..."}` のみ。
