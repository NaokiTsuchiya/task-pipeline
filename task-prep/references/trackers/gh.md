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
- **優先度は `priority-high` / `priority-low` ラベル** (無指定が中位)。SKILL.md「優先度」の基準で判断し、**承認を得てから**付ける。`ready` / `pending-deps` / `gate-light` とは独立した軸なので、入れ替えではなく追加で、全置換規則の集合計算で他ラベルごと保つこと。**ユーザーが手で付けた段は無断で変えない** — 変更案は現在の値と併せて結果セットに出す。task-pipeline はこのラベルを読むだけで付け外ししないので、こちらが消せば誰も戻さない。
- **gate 宣言は `gate-light` ラベル**。SKILL.md「gate 宣言」の 2 軸 AND を満たす issue にだけ足す。`ready` / `pending-deps` とは**独立した軸なので入れ替えではなく追加**で、昇格スキャンで `pending-deps` → `ready` に入れ替えるときも保つこと (全置換規則で消しやすい筆頭。task-pipeline はこのラベルを読むだけで付け外ししないので、消えたら誰も戻さない)。2 軸を満たさなくなる方向に本文を深掘りしたときは、逆にこのラベルを外す。

## 操作

- **既存 issue の取得** (深掘りの入力): `issue_read (method: get)` は**メタ情報のためだけに呼ぶ** — labels / state / `created_at` / `updated_at`。**この応答の `body` を深掘りの基礎にしてはならない。** `>` `'` `"` がエンティティ化され、`<...>` 表記と `<!-- ... -->` 行は中身ごと落ちる (実測。`../../../task-pipeline/docs/gate-declaration-2026-08.md` §5)。深掘りは読んだ本文を `issue_write (method: update, body: ...)` で**全置換**するので、読めていない行は復元できず無警告で消える。本文は次の手順で取る:

  1. **raw 経路 (既定)** — `search_issues` が返す `body` はエスケープされず、`<!-- ... -->` 行も残る (実測。同 §5)。issue 番号で直接引く修飾子は GitHub の検索構文に無いので、上で読んだ `created_at` で 1 件に絞る:

     ```
     search_issues(owner, repo,
                   query: "is:issue created:<created_at>..<created_at>",
                   fields: ["number", "body", "updated_at"], perPage: 5)
     ```

     返った `items` から **`number` が一致するもの**を選び (同じ秒に作られた issue が複数ありうるので 1 件目を無条件に採らない)、**その `updated_at` が `issue_read` の `updated_at` と一致するときだけ** `body` を採用する。`search_issues` は検索インデックス越しなので、直前の編集が反映されていないことがある — **古い本文を書き戻して編集を巻き戻すのは、エスケープより悪い**。
  2. raw が取れたら `.task-prep/issue-gh-<番号>.md` に**逐語で**書き出す。これが深掘りと書き戻しの基礎になる。
  3. **raw が取れなかったとき** (0 件 / `number` の一致無し / `updated_at` 不一致 / 呼び出しエラー) の**保全規則**:
     - `.task-prep/issue-gh-<番号>.md` の冒頭に、エスケープ経路で取ったこと・`<...>` と `<!-- ... -->` が失われている恐れ・**その issue の URL** を明記する。
     - **この issue の本文更新を、そのまま承認提示に出さない。** 提示するのは「更新案 + issue URL + 原文との突き合わせ依頼」であり、ユーザーが原文を貼るか、原文に欠落対象が無いことを確認したときだけ `issue_write (method: update, body: ...)` に進む。深掘りを諦めるのではなく、**書き戻しの前に人を 1 回挟む**。
     - **欠落の検出に頼らない。** HTML コメント行は丸ごと消えて痕跡が残らないので、エスケープ本文に `&lt;` / `&gt;` / `&#34;` / `&#39;` が見えることは欠落の十分条件でしかない (見えなくても消えている)。raw が取れていない時点で、常にこの警告を出す。
     - ラベル更新 (`ready` / `pending-deps` / `gate-light` / `priority-*`) と `add_issue_comment` は本文を触らないので、この規則の対象外。**新規作成** (`issue_write method: create`) も既存本文が無いので影響しない。

  コメントがあれば `get_comments` も取り、同じファイルに書き出す。
- **重複検索**: `search_issues` で `is:open` + 要望のキーワード。タイトルだけで判断せず、怪しいものは本文まで読む。
- **本文の表記**: `<branch>` のような山括弧プレースホルダを本文に書かない — `issue_read` / `list_issues` の読み出しで HTML タグと解釈され**中身ごと欠落する** (バッククォート内でも。実測)。上記の raw 経路 (`search_issues`) は無傷だが、**そのフォールバックと `list_issues` (昇格スキャン) は依然として落とす**ので、この規則は残す。`BRANCH` / `OWNER/REPO` のような表記にすること。
- **作成** (分解の書き込み): 承認済みドラフトを**依存される側から順に** `issue_write (method: create)` で作る。後続ドラフトの `依存:` 行は、依存先の issue 番号が確定してから実番号 (`#N`) に置換して作成する。ラベルは状態表のとおり 3 分岐: `未確定:` が残るならラベルなし、依存が残るなら `labels: ["pending-deps"]`、どちらも無ければ `labels: ["ready"]`。gate 宣言を付けるドラフトでは、この集合に `"gate-light"` を足す。優先度の段を付けるなら `"priority-high"` / `"priority-low"` も同様に足す。
- **本文更新** (深掘りの書き込み): `issue_write (method: update, body: ...)`。タイトルを変えるなら `title` も。ラベルは上記の全置換規則で。コメントの付いた issue では注意 — 実行時には task-pipeline の gh アダプタがコメントもタスクファイルに書き出すので、**コメント上の要求も executor / verifier に届く**。コメント由来の要求の採否 (取り込んだ / やらないと決めた) を本文に反映し、本文が要求の正であることを本文に明記する。
- **分解元の処置**: 既存 issue を分解で置き換えたときは、承認後に `add_issue_comment` で子 issue への参照を残し、`issue_write (method: update, state: "closed", state_reason: "not_planned")` で閉じる。元 issue を `依存: #元` に持つ open issue が残っていないかも確認し (`search_issues` で `"#元番号"` を検索)、あれば `依存:` 行を対応する子へ張り替える (張り替えも承認対象。漏らすと not_planned な依存としてエスカレートされ続ける)。
- **依存チェック**: 本文の `依存:` 行にある各 `#N` を `issue_read (method: get)` で読み、closed **かつ `state_reason` が `completed`** のときだけ解決済み。`not_planned` で閉じられた依存は解決ではない (SKILL.md の昇格の規則どおり、従属 issue ごとユーザーに上げる)。
- **昇格スキャン**: `list_issues (state: OPEN, labels: ["pending-deps"])` → 各 issue の本文から `依存:` を読み、全依存が解決済み (上記の判定) かつ本文に `未確定:` が無いものだけ、ラベルを `pending-deps` から `ready` に入れ替える (全置換規則で。`gate-light` と `priority-*` が付いていれば残す)。**候補に出るのはこの瞬間からなので、優先度の段はここで判断する** (SKILL.md「優先度」)。`list_issues` の本文も `issue_read` と同じくエスケープされるが、ここで見るのは `依存:` 行と `未確定:` の有無だけで、**本文を書き戻さない**ので破損源にはならない。

## 依存はネイティブ機能を使わない

**依存の正は本文の `依存:` 行だけである。GitHub ネイティブの依存関係 (issue の "Mark as blocked by" / blocking) は task-prep も task-pipeline も読まない。** 人が GitHub の UI でネイティブ依存だけを張っても `ready` ラベルは外れないので、パイプラインはその issue をそのまま着手する。依存は必ず `依存:` 行で書くこと (ネイティブ側にも張るのは自由だが、それは人が見るための表示であって、機械はそちらを見ない)。

読まない理由 (2026-08 時点):

- **GitHub MCP に読み書きの口が無い。** `issue_read` の method は `get` / `get_comments` / `get_sub_issues` / `get_parent` / `get_labels` のみで、依存関係を返さない。REST (`/issues/{n}/dependencies/blocked_by`) と gh CLI (`--blocked-by`) にはあるが、gh CLI はこの環境では使えない (上記「読み書きは GitHub MCP で行う」)。
- **検索修飾子が無い。** 公式の検索/フィルタ docs に `is:blocked` 系は無く、`search_issues` に投げても素通りする (エラーにならず 0 件)。task-pipeline の `list` は 1 回の検索クエリで候補を確定させる設計なので、依存はゲートに使えない — ゲートに使えるのは `ready` ラベルだけである。
- **`not_planned` を区別できない。** ネイティブ依存は「閉じたら解けた」であり、上記「依存チェック」の `state_reason: completed` だけを解決とみなす規則を表現できない。

なお **sub-issue (`sub_issue_write` / `get_sub_issues` / `get_parent`) は MCP で使える**が、これは分解の親子関係であって依存 (順序) ではない。依存の表現には使わない。

ドラフトはカレントプロジェクトの `.task-prep/drafts/<slug>.md` に置く。issue 作成後はトラッカーが正であり、ドラフトは残骸 (コミットしない)。
