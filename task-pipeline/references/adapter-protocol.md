# トラッカーアダプタ プロトコル

アダプタは `references/adapters/<tracker>.md` の 1 ファイル。アダプタサブエージェントへの指示文であり、コードではない。オーケストレーターからの起動プロンプトは SKILL.md「アダプタの呼び方」の形に固定されている。

## アダプタが実装する 2 操作

### `list`

- トラッカーから「未着手 (open) で、blocked / in_review 扱いでない」タスクを列挙する。
- 各タスクの本文を `<state dir>/tasks/<id>.md` に書く。frontmatter に最低限 `id`、`title`、トラッカー側の参照 (行・issue 番号・URL 等、mark で使うもの) を含める。**トラッカー側に gate 宣言の表現があるなら、gate 宣言を frontmatter の `gate: light` の 1 行に正規化する** (宣言があるときだけ入れる。無ければ行ごと省き、`gate: full` とは書かない。実例: [adapters/gh.md](adapters/gh.md) の `gate-light` ラベル、[adapters/markdown.md](adapters/markdown.md) の `<!-- task-pipeline:gate=light -->` マーカー)。オーケストレーターの gate 判定 (SKILL.md「タスク実行」手順 1) はこの 1 行だけを grep して見る — **この行を書かないトラッカーでは、宣言があっても常に `full` 扱いになり `gate: light` は一切効かない**。
- 本文の取得が高くつくトラッカーでは、`list` は frontmatter だけのスタブを書き、**本文の書き出しを `mark <id> in_progress` まで遅らせてよい** (タスク開始時に 1 回だけ呼ばれる)。承認されない候補の取得コストを払わずに済む。その場合スタブには、本文がまだ無いときに要求へ到達する手段 (issue の URL 等) を必ず書いておくこと — `mark` の失敗ではパイプラインは止まらないので、スタブのまま executor に渡ることがある。
- 応答は `{"tasks": [{"id": "...", "title": "...", "priority": "high|low", "labels": [...], "milestone": {...}, "updated_at": "..."}]}` の JSON のみ。本文や生データを応答に含めない (オーケストレーターのコンテキストを守るため)。**`id`/`title` 以外は省略可** — トラッカー側に対応する概念が無い項目は、そのキーごと応答から省く (例: [adapters/markdown.md](adapters/markdown.md) はリストの並び順が実行順そのものなので `priority`/`labels`/`milestone` を返さない)。省いたときの扱いは次のとおり:
  - `priority` (`"high"`/`"low"`) — オーケストレーターが承認候補を優先度で 3 段に分ける材料 (SKILL.md「承認」手順 2)。**省く、またはタスクの値が無い場合は常に中位として扱われる** (トラッカーが一切返さないなら、段分けは実質無効になる)。
  - `updated_at` (ISO 8601 UTC) — 承認候補の順位キャッシュを前回の並びのまま再利用してよいかの判定に使う (SKILL.md「承認」手順 2)。**省くと、一覧の id 集合が変わるまで前回の並びが固定される** (本文編集が順位の再計算のトリガーにならない)。
  - `labels`/`milestone` — 承認候補のトリアージへの参考情報として渡されるだけ (SKILL.md「承認」手順 2)。省いても承認フロー自体は通常どおり動く。
- タスクを取得できない事情 (source が無い、認証切れ、API エラー等) は、**空の一覧ではなく** `{"error": "..."}` で返す。
- `id` は安定かつ一覧内で一意であること: 同じタスクは何度 list しても同じ id になり、異なるタスクが同じ id を持たない。

### `mark <id> <status> [reason|ref]`

- `status` ∈ `in_progress` | `in_review` | `done` | `blocked`。トラッカー側に反映する。
  - `in_review`: パイプラインの作業が完了し、人のレビュー/マージ待ち。第 3 引数はレビュー対象の参照 (PR URL / コミットハッシュ、無い場合もある)。**パイプラインが自力で到達する成功終端はここまで。**
  - `done`: マージ/受け入れ完了。ユーザーの手・トラッカー側の自動遷移 (PR マージによる issue close 等) のほか、パイプラインのマージ回収 (ユーザーのマージが git 履歴で証明できたとき) が呼ぶ。
  - `blocked`: 第 3 引数は理由。
- トラッカーに対応する状態表現が無い場合の扱い (no-op を含む) はアダプタ内で定義する。
- `blocked` / `in_review` に使う表現は、`list` が安価に除外判定できるものにする (次の list で候補に再登場してはならない)。
- `in_progress` も、トラッカー側に安く除外判定できる表現があるなら `list` で使うとよい (例: [adapters/gh.md](adapters/gh.md) の assignee、[adapters/markdown.md](adapters/markdown.md) の `(wip)`)。同じ `source` に対して複数のセッション/エージェントが同時にパイプラインを回したときの二重着手を防げる。**加えて `mark in_progress` は、その表現が既に付いているのを見つけたら `{"ok": false}` で着手を止めること** — list と mark の間にはユーザーの承認待ちが挟まるため、list 時の除外だけでは同時着手の窓が残る。この拒否の `error` には着手済みと分かる文言 (`already in progress` 等) を含めること — オーケストレーターはそれを一般の `mark` 失敗と区別して着手を中止する (SKILL.md タスク実行手順 1)。なお確認と書き込みの間の短い窓は残る — state.json を共有しない別系統 (別マシン等) との交差はアダプタ単体では閉じ切れない。トレードオフとして、その表現がトラッカー側の状態を正とする以上、パイプライン側の `state.json` を失った場合の自動リカバリは失われる (復帰は手動でその表現を外す運用にする)。表現が無い/コストが見合わないトラッカーでは `state.json` だけで制御してよい (別セッションとの重複は防げない)。
- 応答は `{"ok": true}` または `{"ok": false, "error": "..."}` のみ。**ただし `status` が `in_progress` のときは、成功時の応答に `gate_declared: true|false` を加える** (`{"ok": true, "gate_declared": true}`) — トラッカー側に gate 宣言があったかどうかをそのまま返す。オーケストレーターは自分でも frontmatter を grep して gate を判定しており (SKILL.md「タスク実行」手順 1)、この値と食い違ったら両方の値を history に記録する (同手順。経緯は `docs/gate-declaration-2026-08.md`) — アダプタの書き出し処理が宣言を落としていないかを検知するための突き合わせに使う。`in_progress` 以外の status ではこのキーは不要 (含めても無視される)。

## 新しいトラッカーの追加手順 (Jira / Notion など)

1. `references/adapters/<name>.md` を 1 枚書く。内容は「そのトラッカーで list と mark をどう実現するか」だけ。
   - MCP のあるトラッカーでは、サブエージェント内で ToolSearch で該当 MCP ツールを load して呼ぶ、と書く。MCP のツールスキーマはアダプタサブエージェントのコンテキストにしか載らず、オーケストレーターには載らない — これがアダプタをサブエージェントで動かす理由でもある。
   - MCP を使うアダプタの実例は [adapters/gh.md](adapters/gh.md) (GitHub Issues)。ラベルで in_review / blocked を表し、list でそれを除外する形。「取得エラーを空の一覧と取り違えない」「状態の更新が全置換 API のときは read-modify-write する」など、API 経由のトラッカーで共通して要るものが揃っている。
2. 以上。SKILL.md、状態スキーマ、executor/verifier に変更は不要。`/task-pipeline <name> <source>` で使える。
