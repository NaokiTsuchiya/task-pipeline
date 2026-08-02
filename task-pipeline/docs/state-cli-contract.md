# state.ts CLI 契約

`task-pipeline/scripts/state.ts` (Deno/TypeScript) の起動形・終了コード・JSON 出力の契約。
`task-pipeline/scripts/state.test.ts` の T-D1 が、この文書の終了コード表を
`task-pipeline/scripts/state.ts` の `EXIT_CODES` と突き合わせて一致を固定している
(この文書と実装が乖離すればテストが落ちる)。

## 起動形

```
deno run --no-prompt \
  --allow-read=<state dir>[,<git common dir>/info] \
  --allow-write=<state dir>[,<git common dir>/info] \
  task-pipeline/scripts/state.ts <verb> --state-dir <dir> [verb固有フラグ...]
```

- `--no-prompt` を必ず付ける (許可外アクセス時に TTY プロンプトで止まらないようにする)。
- state ディレクトリの外を一切読み書きしない設計なので、`--allow-read`/`--allow-write` は
  state dir (`init` はこれに加えて `<git common dir>/info`) だけに絞ってよい。
  `--allow-all` で動かす前提の書き方はしない。

## 出力契約

stdout に必ず **1 行の JSON**。

- 成功時: exit 0、verb ごとの成功ペイロード (下記)。
- 失敗時: exit は下表のコード、`{"error": "<code>", "message": "<text>"}`。
- **エラー時は state.json を一切書き換えない。**

## 終了コード

| 名前 | コード | 意味 |
|---|---|---|
| (success) | 0 | 成功 |
| `usage` | 10 | verb 不明・省略・必須フラグ欠落・未知フラグ・不正な値 (`--id` の形状違反含む) |
| `lock` | 11 | lock を既定回数再試行しても取得できなかった |
| `schema` | 12 | state.json が構文的に不正な JSON、または `checkState` が invalid と判定した |
| `missing` | 13 | 対象 verb が要求する state.json (または state dir 自体) が存在しない |
| `permission` | 14 | Deno の許可境界外へのアクセス (`Deno.errors.NotCapable`/`PermissionDenied`) |

## verb 一覧

### `init`

```
state.ts init --state-dir <dir> --tracker <s> --source <s> --git-common-dir <dir> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`.task-pipeline/` (state dir) と `state.json` を作り、`<git common dir>/info/exclude` に
`/<state dir のベース名>/` (通常 `/.task-pipeline/`) を未記載のときだけ追記する。追跡下の
`.gitignore` には一切触れない。

- state.json が既に無ければ新規作成 (`schema_version: 1`、他は空)。
- 既に有れば `checkState` で妥当性を確認するだけ (invalid なら `schema` で失敗)。
  **`--tracker`/`--source` の値では上書きしない。** `schema_version` が無ければ末尾に付与し、
  既に有ればどんな値でも変更しない。
- 成功: `{"ok": true, "created": <bool>, "state_dir": "<絶対パス>"}`
  (`created` は新規作成のときだけ `true`)。

### `get`

```
state.ts get --state-dir <dir>
```

state.json を読み `JSON.parse` するだけ (**スキーマ検証はしない**)。成功時、stdout は
parse した state オブジェクトそのもの (他 verb のような `{"ok":true,...}` の包みは無い)。
無ければ `missing`。空ファイル・構文的に壊れた JSON は `schema`。

### `validate`

```
state.ts validate --state-dir <dir>
```

`get` と同じ読み・parse をした上で `checkState` を呼ぶ。invalid なら `schema`
(message は `<path>: <message>`)。valid なら `{"ok": true}`。

### `session-touch`

```
state.ts session-touch --state-dir <dir> --id <id> [--cleanup-stale-min <n=1440>]
```

`<state dir>/sessions/<id>` を作成 (無ければ) または mtime を今に更新 (有れば)、続けて同じ
ディレクトリ内の `now - mtime > cleanup-stale-min 分` (strict) のファイルを削除する
(自分自身は対象外)。`--id` は空文字・`/` を含む・`.`・`..` のいずれでもないこと (usage)。
成功: `{"ok": true, "id": "<id>", "cleaned": ["<削除したid>", ...]}`。

### `sessions-alive`

```
state.ts sessions-alive --state-dir <dir> [--alive-max-min <n=90>]
```

`<state dir>/sessions/` 配下で `now - mtime < alive-max-min 分` (strict) のファイル名一覧を
返す。`sessions/` が無ければエラーにせず空配列。成功: `{"ok": true, "alive": ["<id>", ...]}`。

### `history-append`

```
state.ts history-append --state-dir <dir> --line <text> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

lock 取得 → 読み直し → `checkState` → `history` 配列へ `--line` の値を追記
(空文字列 `""` も許可される値) → `updated_at` を今に更新 → `schema_version` が無ければ付与 →
原子的書き込み → lock 解放。state.json が無ければ `missing`。invalid なら `schema`。
成功: `{"ok": true, "history_length": <n>}`。

## lock (排他) の契約

`<state dir>/lock` を `mkdir` で作る (既存なら `AlreadyExists`)。作成時刻が **10分より古い**
ときだけ stale とみなし、`mv` (rename) で退避してから削除する — 退避 (rename) に成功した
プロセスだけが除去者になるので、複数プロセスが同時に stale 判定しても排他は破れない。
`--lock-retry-ms` (既定 10000) 待って `--lock-max-retries` (既定 3) 回失敗したら `lock` で
諦める。書き込みは一時ファイルに全文を書いてから `rename` で置換する (部分書き込み防止)。
`init`/`history-append` だけがこの lock を使う (`get`/`validate` は読み専用で lock 不要。
`session-touch`/`sessions-alive` は自分のファイルと日次残骸しか触らないため lock 不要)。

## heartbeat の契約

`session-touch` が付ける・掃除するタイミングと `sessions-alive` が見る窓は、
`task-pipeline/SKILL.md` の「セッションの所有権」節の shell コマンド (`find -mmin +1440`
`/-mmin -90`) と同じ strict 境界: 生存判定は年齢 **< 90分**、掃除対象は年齢 **> 1440分**。
