# GitHub Issues アダプタ

`source` は対象リポジトリ (`owner/repo`) に任意のフィルタを付けたもの。**`source` 全体、またはそのリポジトリ部を省略すると、カレントリポジトリの origin から自動で解決する** (`/task-pipeline gh` だけで動く)。タスクは **1 issue 1 タスク**で、**id は `gh-<issue番号>`**。issue 番号は不変なので、タイトル・本文・ラベルが書き換わっても同じタスクのままである。

読み書きは GitHub MCP で行う。**最初に ToolSearch を 1 回だけ呼び、`query: "github issue list read write comment label"` / `max_results: 10` のようなキーワード検索で issue 系ツール (`search_issues` / `issue_read` / `issue_write` / `add_issue_comment` / `get_label` / `get_me`、`mark` では `pull_request_read` / `update_pull_request` も) をまとめてロードする。** MCP ツール名にはサーバごとのプレフィックスが付き環境によって変わるので、名前をベタ書きした `select:` は使わない。ロードできなければ `{"error": "GitHub MCP が利用できません"}` / `{"ok": false, "error": ...}` を返す。

## `source` の書式

```
[owner/repo | .][?label=<値>&label=<値>&milestone=<値>&review_label=<名前>&blocked_label=<名前>]
```

| 例 | 意味 |
|---|---|
| (空) | カレントリポジトリの open issue すべて |
| `owner/repo` | そのリポジトリの open issue すべて |
| `.` | カレントリポジトリの open issue すべて (空と同じ) |
| `?label=ready` | カレントリポジトリの `ready` ラベルが付いたもの |
| `.?label=ready` | 同上 |
| `.?label=ready&label=backend` | 両方のラベルが付いたもの (AND) |
| `owner/repo?milestone=v1.0%20release` | マイルストーン指定 (空白は `%20`) |
| `?blocked_label=on-hold` | blocked を表すラベルを `blocked` から変更 |

**`assignee` フィルタは無い。** 候補の定義が「assignee が付いていない」こと (下記「状態の表現」) なので、assignee で候補を絞る操作はそもそも成立しない (常に 0 件になる)。`?assignee=...` を渡すと未対応キーとして `{"error": "未対応のキー: assignee"}` になる。

パース規則:

1. 最初の `?` でリポジトリ部とクエリ部に分ける。`?` が無ければリポジトリ部のみ。
2. クエリ部を `&` で分割し、各要素を最初の `=` で key / value に分ける。value は**パーセントデコードする** (`source` は位置引数なので空白を含められない)。
3. key は次のみ。それ以外は `{"error": "未対応のキー: <key>"}`。
   - 候補の絞り込み: `label` (複数回書ける。AND) / `milestone`
   - 状態ラベルの上書き: `review_label` (既定 `in-review`) / `blocked_label` (既定 `blocked`)。それぞれ 1 回だけ。
4. リポジトリ部が `.` か空 (`source` 全体が空の場合を含む) なら、**state dir の親ディレクトリ**で `git remote get-url origin` を実行し、`github.com` の URL から `owner/repo` を取り出す。SSH 形式 (`git@github.com:owner/repo.git`) と HTTPS 形式 (`https://github.com/owner/repo.git`) の両方を受け付け、末尾の `.git` は落とす。起動プロンプトは対象プロジェクトのパスを渡してこないので、カレントディレクトリに依存させないこと。
   - リモートが無い / origin が GitHub でない / git リポジトリでない場合は `{"error": "カレントリポジトリを解決できません (<理由>)。source に owner/repo を指定してください"}`。
5. リポジトリ部が空でも `.` でもなく、`owner/repo` 形式でもなければ `{"error": ...}`。

## 状態の表現

パイプラインが使うラベルは **`in-review` と `blocked` の 2 つだけ** (名前は `review_label` / `blocked_label` で変更できる)。以下ではこの 2 つを **状態ラベル**と呼ぶ。

| 状態 | GitHub 側の表現 |
|---|---|
| 未着手 (候補) | open で、状態ラベルがどちらも付いておらず、**assignee が付いておらず**、**PR も紐付いていない** |
| `in_progress` | 実行者を assignee に追加 (状態ラベルは付けない) |
| `in_review` (ref が PR URL) | **PR 本文に `Fixes #<番号>` を入れて issue に紐付ける。ラベルは付けない** |
| `in_review` (それ以外) | ラベル `in-review` + 参照をコメント |
| `blocked` | ラベル `blocked` + 理由をコメント |
| `done` | issue を close (`state_reason: completed`) + 状態ラベルを外す |

- **PR があるならラベルは要らない。** 紐付いた PR は issue のタイムラインに出るので `in-review` ラベルは同じことを二重に言っているだけになる。さらに紐付けておけば、**マージした瞬間に issue が自動 close されて done になる** (パイプラインのマージ回収と衝突しない。`mark done` は冪等)。ラベルを使うのは PR が無いとき (`finish=none` / `finish=commit`) だけ。
- **`in_progress` にはラベルではなく assignee を使う。** GitHub 側の issue 状態 (assignee) を正とすることで、同じ `source` に対して複数のセッション/エージェントが同時に `task-pipeline` を回しても、他のセッションが着手済みの issue を `list` の候補から除外できる (`list` の `no:assignee` フィルタ、下記)。トレードオフとして、セッションが落ちて `state.json` を失ったときの自動リカバリは無い — 着手途中だった issue は assignee が付いたままなので候補に戻らない。復帰は下記の通り手動 (assignee を外す) で行う。
- 2 つの状態ラベルは相互排他に保つ。`mark` は目的のラベルを入れ、もう一方を外す (`in_progress` と `done` は両方外す)。手で両方付いても次の `mark` で収束する。
- 復帰: 候補に戻すには **状態ラベルと assignee の両方**を外す必要がある (`in_progress` に一度でもなった issue は assignee が付いたままなので、ラベルだけ外しても `no:assignee` に引っかかって候補に戻らない)。close 済みなら reopen も要る。**PR で紐付いている場合は、PR を閉じるだけでは戻らない** — PR 本文の `Fixes #<番号>` を消す (または PR ごと消す) 必要がある (これに加えて assignee も外す)。
- assignee は `in_progress` で足す。**`list` の除外判定にも使われる** (誰かが assignee なら候補から外れる) ので、以降の `mark` では触らない — `in_review` / `blocked` に進んでも assignee は付いたままにする (誰が着手したかの記録であり、二度と未着手扱いにしないためのマーカーでもある)。他人が別の理由でその issue に自分自身を assignee にした場合も、パイプラインからは「着手済み」に見えて候補から外れる — これは意図した挙動 (GitHub 上で assignee が付いている = 誰かが着手中、という解釈をパイプラインもそのまま採用する)。
- 既定名 `in-review` / `blocked` は多くのリポジトリに既にあり、意味も揃っている (人が `blocked` を付けた issue をパイプラインが拾わないのは正しい)。**ただしパイプラインはこの 2 つを付け外しする。** チームが別の意味で運用しているラベルなら、`review_label` / `blocked_label` で衝突しない名前に逃がすこと。
- **ラベルは事前に作らなくてよい。** リポジトリに存在しないラベルを `issue_write` で付けると GitHub 側が自動生成する (色は既定のグレー `ededed`、説明なし。実測確認済み)。色や説明を付けたいときだけ手で作っておく。

## `list`

1. `source` をパースしてリポジトリと各フィルタを得る。
2. `label` フィルタがあれば、値ごとに `get_label` で存在を確認する。無ければ `{"error": "ラベルがありません: <名前>"}`。**存在しないラベルで絞ると GitHub はエラーではなく 0 件を返し、それはオーケストレーターに「全タスク完了」と解釈されてループが止まる。**
3. `search_issues(owner, repo, query: "is:open no:assignee -linked:pr -label:\"<review_label>\" -label:\"<blocked_label>\" <絞り込みフィルタ>", sort: "created", order: "asc", perPage: 100)` で取得する。**`no:assignee` は他セッション/他エージェントが `mark in_progress` 済み (assignee 追加済み) の issue を候補から除く役割。** 落とすと同じ issue を複数のパイプラインが同時に着手してしまう。
   - **`list_issues` は使わない。** 紐付いた PR の有無は `linked:pr` でしか判定できず (GraphQL 側にこのフィルタは無い)、これを落とすとレビュー中の issue が候補に再登場して二重実行になる。
   - 検索インデックスには遅延がある。**残った issue それぞれについて `issue_read(method: "get")` で現在のラベルと assignees を読み直し、状態ラベルが付いているか assignee が 1 人以上いれば落とす。** 読み直しは issue ごとに独立なので並列に呼ぶ。 ただし PR 紐付けの遅延はこれでは潰せないので、直前に `in_review` にした issue が 1 度だけ候補に現れることがある (オーケストレーター側が state.json で弾く)。同様に、直前に他セッションが `mark in_progress` した issue も検索インデックスの遅延で 1 度だけ現れうるが、この再読み込みで大半は潰せる。
4. 件数のガード。ヒット数が 200 を超えたら列挙せず `{"error": "候補が多すぎます (<N> 件)。source にフィルタを付けて絞ってください"}`。除外後の候補が **20 を超えた場合**も同じエラーを返す。`search_issues` のレスポンスは 1 件あたり数千トークンと冗長で、承認 UI も溢れるため。
5. 候補が 0 件で、かつ絞り込みフィルタが 1 つでも指定されていた場合は、**同じクエリから `is:open` / `no:assignee` / 状態ラベルの除外を外してもう一度検索する。それも 0 件ならフィルタの値が誤っている可能性が高いので `{"error": "フィルタに一致する issue がありません。label / milestone の値を確認してください"}` を返す。** 1 件以上あれば本当に枯渇しているので `{"tasks": []}` を返す。
6. 候補を issue 番号の昇順に並べる (= 実行順)。
7. 各候補について `<state dir>/tasks/gh-<番号>.md` を **スタブとして** 書く (候補ごとに独立なので並列に書いてよい)。**この時点では本文もコメントも書かない** (下記「タスク本文の書き出しを遅らせる理由」):

   ```markdown
   ---
   id: gh-<番号>
   title: "<タイトル>"
   repo: <owner/repo>
   issue: <番号>
   url: https://github.com/<owner>/<repo>/issues/<番号>
   ---
   (このタスクの本文とコメントは実行開始時に取得される。この行がまだ残っているなら、
   上記 url の issue を自分で読んで要求を把握すること。)
   ```

   - `title` は**ダブルクォートで囲む**。issue タイトルの `:` や `#` で YAML が壊れないようにするため。タイトル中の `"` は `\"`、`\` は `\\` にする。それ以外は書き換えず、**日本語などの非 ASCII 文字はそのまま書く** (`\u306e` のような Unicode エスケープにしない — このファイルは人と実行エージェントが読む)。**この引用規則は下記「タスク本文の書き出し」で書き直すときも同じ。**
   - スタブの最後の行は必ず入れる。`mark in_progress` が失敗しても executor / verifier が URL から自力で要求に到達できるようにするため (オーケストレーターは `mark` の失敗では止まらない)。
8. 応答: `{"tasks": [{"id": "gh-<番号>", "title": "..."}]}` のみ。本文や取得した生データを応答に含めない。
- MCP 呼び出しがエラーを返したら `{"error": "<エラー内容>"}`。**取得できない事情と「候補が 0 件」を決して取り違えない。**

## `mark <id> <status> [reason|ref]`

1. `source` を `list` と同じ規則でパースしてリポジトリを得る (フィルタ部は無視する。空なら同じくカレントリポジトリから解決する)。`id` から `gh-` を外して issue 番号を得る。`gh-<数字>` の形でなければ `{"ok": false, "error": "id の形式が不正です: <id>"}`。
2. `issue_read(method: "get")` で現在の labels と assignees を読む。ラベルは名前の配列で返ることもオブジェクトの配列で返ることもあるので、名前だけを取り出して使う。
3. 新しいラベル集合 = **現在のラベル − 状態ラベル 2 つ + 目的のラベル**。`in_progress` / `done` / **ref が PR URL の `in_review`** は足さない (2 つとも外すだけ)。
   - **既に目的の状態になっているなら書き込まない。** ラベル集合が現在と同じで、assignee の追加も不要で、`done` なら既に close 済み — この場合 `issue_write` を呼ばずに `{"ok": true}` を返す (コメント投稿など下記の追加操作も、既に行われているなら繰り返さない)。PR のマージで issue が自動 close された後の `mark done` がこれに当たる。**外部システムへの書き込みは、状態を実際に変えるときだけ行う。**
   - 状態を変える必要があるときだけ `issue_write(method: "update", owner, repo, issue_number, labels: <新しい集合>)` を呼ぶ。`labels` は**追加ではなく全置換**なので、必ず現在の集合から計算すること (計算を誤ると無関係なラベルが消える)。指定しなかったフィールドは変更されない。ラベル集合が現在と同じで別の変更だけがあるなら、`labels` は送らなくてよい。
4. status ごとの追加操作:
   - `in_progress`: `get_me` の `login` を現在の assignees に足して、同じ `issue_write` の `assignees` に渡す (これも全置換)。すでに入っていれば何もしない。アサインできない権限のリポジトリでは無視されるが、それで失敗扱いにしない。**加えて、下記「タスク本文の書き出し」を行う。**
   - `in_review` で **ref が PR URL のとき**: ラベルは付けず (状態ラベルは 2 つとも外したまま)、代わりに **PR を issue に紐付ける**。URL 末尾から PR 番号を取り、`pull_request_read(method: "get")` で本文を読み、`Fixes #<issue番号>` が無ければ本文の末尾に空行を挟んで足し、`update_pull_request(pullNumber, body: <新しい本文>)` で書き戻す。既に入っていれば何もしない。**コメントは投稿しない** — 紐付けが issue のタイムラインに出るので重複になる。
   - `in_review` で **ref が PR URL でないとき** (コミットハッシュ、または ref なし): `in-review` ラベルを付け、`add_issue_comment` で `パイプラインの作業が完了しました。レビューをお願いします: <ref>` を投稿する (ref が無ければ参照なしの文言で)。
   - `blocked`: `add_issue_comment` で `パイプラインがこのタスクを進められませんでした: <reason>` を投稿する。
   - `done`: `issue_write` に `state: "closed"`, `state_reason: "completed"` を併せて渡す。すでに close 済みでも実質 no-op なので、PR の `Fixes #n` による自動 close と衝突しない。
5. `issue_write` が失敗したら `{"ok": false, "error": "<エラー内容>"}` を返す。ラベルが未作成であることは失敗理由にならない (GitHub が自動生成する)。権限不足などで直し方が分かる場合はそれを文言に含める。
6. ラベル更新に成功してコメント投稿に失敗した場合は `{"ok": false, "error": "..."}` を返す (GitHub 側は部分的に反映済みである旨を書く)。

### タスク本文の書き出し (`in_progress` のときだけ)

`issue_read(method: "get")` で読んだ本文と、コメントを使って `<state dir>/tasks/gh-<番号>.md` を**スタブから完全な形に書き直す**。frontmatter は `list` が書いたものをそのまま保つ (`title` はこの時点の issue タイトルで更新してよい)。

```markdown
---
id: gh-<番号>
title: "<タイトル>"
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

`list` は承認されるかどうか分からない候補を最大 20 件並べるが、実際に承認されて動くのはそのうち数件である。本文とコメントを `list` で取ると、捨てられる候補の分まで取得コストを払う。`mark in_progress` はタスク開始時にちょうど 1 回だけ呼ばれる (`SKILL.md` の「タスク実行」手順 1) ので、ここで取れば**実行されるタスクの分だけ・1 回だけ**で済む。承認時点ではなく実行開始時点の内容になるので鮮度も上がる。

逆に、タスクファイル自体を無くして URL だけを渡す形にはしない。タスクファイルのパスは executor と verifier の両方に渡り、4 フェーズ + 検証リトライを通じて 1 タスクにつき 8 回以上読まれる。その都度 issue を取得し直すと取得コストが 8 倍になり、フェーズの途中で issue が編集されると検証の基準まで動いてしまう。
7. 応答: `{"ok": true}` または `{"ok": false, "error": "..."}` のみ。
