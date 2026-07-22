# トラッカーアダプタ プロトコル

アダプタは `references/adapters/<tracker>.md` の 1 ファイル。アダプタサブエージェントへの指示文であり、コードではない。オーケストレーターからの起動プロンプトは SKILL.md「アダプタの呼び方」の形に固定されている。

## アダプタが実装する 2 操作

### `list`

- トラッカーから「未着手 (open) で、blocked / in_review 扱いでない」タスクを列挙する。
- 各タスクの本文を `<state dir>/tasks/<id>.md` に書く。frontmatter に最低限 `id`、`title`、トラッカー側の参照 (行・issue 番号・URL 等、mark で使うもの) を含める。
- 応答は `{"tasks": [{"id": "...", "title": "..."}]}` の JSON のみ。本文や生データを応答に含めない (オーケストレーターのコンテキストを守るため)。
- タスクを取得できない事情 (source が無い、認証切れ、API エラー等) は、**空の一覧ではなく** `{"error": "..."}` で返す。
- `id` は安定かつ一覧内で一意であること: 同じタスクは何度 list しても同じ id になり、異なるタスクが同じ id を持たない。

### `mark <id> <status> [reason|ref]`

- `status` ∈ `in_progress` | `in_review` | `done` | `blocked`。トラッカー側に反映する。
  - `in_review`: パイプラインの作業が完了し、人のレビュー/マージ待ち。第 3 引数はレビュー対象の参照 (PR URL / コミットハッシュ、無い場合もある)。**パイプラインが自力で到達する成功終端はここまで。**
  - `done`: マージ/受け入れ完了。ユーザーの手・トラッカー側の自動遷移 (PR マージによる issue close 等) のほか、パイプラインのマージ回収 (ユーザーのマージが git 履歴で証明できたとき) が呼ぶ。
  - `blocked`: 第 3 引数は理由。
- トラッカーに対応する状態表現が無い場合の扱い (no-op を含む) はアダプタ内で定義する。
- `blocked` / `in_review` に使う表現は、`list` が安価に除外判定できるものにする (次の list で候補に再登場してはならない)。
- 応答は `{"ok": true}` または `{"ok": false, "error": "..."}` のみ。

## 新しいトラッカーの追加手順 (Jira / GitHub Issues / Notion)

1. `references/adapters/<name>.md` を 1 枚書く。内容は「そのトラッカーで list と mark をどう実現するか」だけ。
   - MCP のあるトラッカーでは、サブエージェント内で ToolSearch で該当 MCP ツールを load して呼ぶ、と書く。MCP のツールスキーマはアダプタサブエージェントのコンテキストにしか載らず、オーケストレーターには載らない — これがアダプタをサブエージェントで動かす理由でもある。
   - 例 (GitHub Issues): list = `search_issues` / `issue_read` で open issue を取得して `tasks/` に書く (id は `gh-<issue番号>`)。mark in_review = `in-review` ラベル付与 + PR URL をコメント (list のクエリでラベルを除外)。mark blocked = `blocked` ラベル付与 (コメントは理由の補足として任意)。mark done = `issue_write` で close (PR の `Fixes #n` による自動 close に任せてもよい)。
2. 以上。SKILL.md、状態スキーマ、executor/verifier に変更は不要。`/task-pipeline <name> <source>` で使える。
