# GitHub Issues — task-prep のトラッカー操作

`source` は対象リポジトリ (`owner/repo`)。省略時はカレントリポジトリの origin から解決する (task-pipeline の gh アダプタと同じ規則: SSH / HTTPS 両対応、末尾 `.git` は落とす)。`?` 以降のフィルタが付いていたらリポジトリ部だけを使う。

読み書きは **GitHub MCP** で行う。最初に ToolSearch を 1 回だけ呼び、`query: "github issue list read write search label comment"` のようなキーワード検索で必要ツール (`issue_write` / `issue_read` / `list_issues` / `search_issues` / `get_label` / `add_issue_comment`) をまとめてロードする。MCP ツール名のプレフィックスは環境で変わるので、名前をベタ書きした `select:` は使わない。**gh CLI は使わない** (この環境では認証が 1Password シェルプラグイン依存で、非対話実行がハングする)。

## 状態の表現

| 状態 | GitHub 側の表現 |
|---|---|
| 未準備・人待ち (`未確定:` が残る) — task-prep はまだ候補にしない | open で下記ラベルなし |
| 深掘り済み・依存待ち | ラベル `pending-deps` |
| 準備完了 (パイプライン候補) | ラベル `ready` |

- task-pipeline は **`/loop /task-pipeline gh ?label=ready`** で起動する。`ready` ラベルがそのまま依存ゲートになる。フィルタなしの起動ではラベルに関係なく open issue 全部が候補になってしまうので、接続コマンドの案内では `?label=ready` を必ず付ける。
- `ready` と `pending-deps` は相互排他。task-pipeline の状態ラベル (`in-review` / `blocked`) には**触らない**。例外は 1 つ: 深掘りが `blocked` の理由 (パイプラインの blocked コメント) を解消して ready 基準を満たしたときは、`blocked` を外す — 外さないと `?label=ready` でも候補に戻らない。外すことも承認時に提示する。
- `未確定:` が残る issue にはどちらのラベルも付けない (依存ではなく人を待っているので、昇格スキャンの対象にしない)。
- ラベルは事前作成不要 — 存在しないラベルを `issue_write` で付けると GitHub が自動生成する (色は既定グレー)。色や説明を付けたいときだけ手で作る。裏返すと、**`ready` を 1 件も付けたことがないリポジトリでは `?label=ready` 起動が「ラベルがありません」エラーで止まる** — ready 0 件で書き込みを終えた報告では接続コマンドを案内せず、昇格待ちである旨を伝える。
- `issue_write` の `labels` は**追加ではなく全置換**。必ず `issue_read (method: get_labels)` で現状を読み、このファイルのラベル以外を保った集合を計算して渡す。

## 操作

- **既存 issue の取得** (深掘りの入力): `issue_read (method: get)` で本文を、コメントがあれば `get_comments` も取り、`.task-prep/issue-gh-<番号>.md` に書き出す。
- **重複検索**: `search_issues` で `is:open` + 要望のキーワード。タイトルだけで判断せず、怪しいものは本文まで読む。
- **本文の表記**: `<branch>` のような山括弧プレースホルダを本文に書かない — GitHub MCP の読み出しで HTML タグと解釈され**中身ごと欠落する** (バッククォート内でも。実測)。executor / verifier は本文を MCP 経由で読むので、受け入れ条件が欠けたまま実行される。`BRANCH` / `OWNER/REPO` のような表記にする。
- **作成** (分解の書き込み): 承認済みドラフトを**依存される側から順に** `issue_write (method: create)` で作る。後続ドラフトの `依存:` 行は、依存先の issue 番号が確定してから実番号 (`#N`) に置換して作成する。ラベルは状態表のとおり 3 分岐: `未確定:` が残るならラベルなし、依存が残るなら `labels: ["pending-deps"]`、どちらも無ければ `labels: ["ready"]`。
- **本文更新** (深掘りの書き込み): `issue_write (method: update, body: ...)`。タイトルを変えるなら `title` も。ラベルは上記の全置換規則で。コメントの付いた issue では注意 — 実行時には task-pipeline の gh アダプタがコメントもタスクファイルに書き出すので、**コメント上の要求も executor / verifier に届く**。コメント由来の要求の採否 (取り込んだ / やらないと決めた) を本文に反映し、本文が要求の正であることを本文に明記する。
- **分解元の処置**: 既存 issue を分解で置き換えたときは、承認後に `add_issue_comment` で子 issue への参照を残し、`issue_write (method: update, state: "closed", state_reason: "not_planned")` で閉じる。元 issue を `依存: #元` に持つ open issue が残っていないかも確認し (`search_issues` で `"#元番号"` を検索)、あれば `依存:` 行を対応する子へ張り替える (張り替えも承認対象。漏らすと not_planned な依存としてエスカレートされ続ける)。
- **依存チェック**: 本文の `依存:` 行にある各 `#N` を `issue_read (method: get)` で読み、closed **かつ `state_reason` が `completed`** のときだけ解決済み。`not_planned` で閉じられた依存は解決ではない (SKILL.md の昇格の規則どおり、従属 issue ごとユーザーに上げる)。
- **昇格スキャン**: `list_issues (state: OPEN, labels: ["pending-deps"])` → 各 issue の本文から `依存:` を読み、全依存が解決済み (上記の判定) かつ本文に `未確定:` が無いものだけ、ラベルを `pending-deps` から `ready` に入れ替える (全置換規則で)。

ドラフトはカレントプロジェクトの `.task-prep/drafts/<slug>.md` に置く。issue 作成後はトラッカーが正であり、ドラフトは残骸 (コミットしない)。
