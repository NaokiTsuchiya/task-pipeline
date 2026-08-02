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
| `missing` | 13 | 対象 verb が要求する state.json (または state dir 自体)、あるいは `--id` が指す queue/candidates/promoted/relisted のエントリが存在しない |
| `permission` | 14 | Deno の許可境界外へのアクセス (`Deno.errors.NotCapable`/`PermissionDenied`) |
| `conflict` | 15 | 対象のエントリは存在するが、その verb が要求する現在の state (`status`/`phase`/`session`/`review.*` 等) の前提を満たさない (例: `claim` を `approved` でないタスクに実行) |

## verb 固有フラグの共通規約

- **`--id`**: 対象 `queue[i]` の id (一部 verb は `candidates`/`promoted`/`relisted` の id)。
- **nullable なフラグ**: `--proc`/`--sig`/`--head`/`--ci`/`--checked-at`/`--note` など、対象
  フィールドが `null` を許容する verb では、フラグの値に文字列 `"null"` を渡すと JSON の
  `null` として書き込む (実際の proc id / sha / URL がリテラル文字列 `"null"` になることは
  運用上想定していない)。フラグ自体を省略すると、そのフィールドは書き換えない。
- **真偽フラグ**: `--bump`/`--clear`/`--drop-withdrawn-branch`/`--preserve-handled`/
  `--reset-attempts`/`--errors-inc`/`--errors-reset` は、フラグを渡すときは必ず値
  `true` を伴う (`--bump true`)。それ以外の値は `usage`。フラグを渡さなければ偽として扱う。
- **`--lock-retry-ms <n>`/`--lock-max-retries <n>`**: 全ての書き込み系 verb (下記すべて) が
  共通で受け付ける (既定はそれぞれ 10000/3、`init`/`history-append` と同じ)。
- 前提違反は `conflict` (対象は存在する) か `missing` (`--id` の指す対象が存在しない) のいずれか
  で失敗し、**state.json は一切書き換わらない** (エラー時共通の契約がそのまま適用される)。

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

以下、`state-cli-verbs` タスクで追加した36 verb。**すべて lock を使う書き込み系**で、
共通の流れ (lock取得 → 読み直し → `checkState` → 前提検査 → フィールド書き換え →
`updated_at`/`schema_version` 正規化 → 事後スキーマ検証 → 原子的書き込み → lock 解放) は
共通なので、以下では verb ごとの**前提**と**効果**だけを記す。前提を満たさない場合は
`conflict` (対象は存在する) または `missing` (`--id` の対象が存在しない) で失敗し、
`state.json` は不変。

### タスク進行

### `approve`

```
state.ts approve --state-dir <dir> --id <id> --title <s> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `queue` に存在しない (`conflict`)。
効果: `queue` へ `{id, title, status:"approved", gate:"full", phase:null, attempts:0,
session:null, executor:null, executor_last_event_at:null, takeover_at:null,
blocked_reason:null, worktree:null, base:null, review:null}` を追加。
成功: `{"ok": true, "id": "<id>"}`。

### `claim`

```
state.ts claim --state-dir <dir> --id <id> --session <s> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: 対象の `status` が `approved` (`conflict`)。
効果: `status→"in_progress", phase→"research", attempts→0, session→<s>`。
成功: `{"ok": true, "id": "<id>", "status": "in_progress", "phase": "research", "session": "<s>"}`。

### `set-gate`

```
state.ts set-gate --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress" && phase=="research" && gate=="full"` (`conflict`)。
効果: `gate→"light", phase→"research+plan"`。
成功: `{"ok": true, "id": "<id>", "gate": "light", "phase": "research+plan"}`。

### `set-worktree`

```
state.ts set-worktree --state-dir <dir> --id <id> --worktree <path> --base <branch> \
  [--drop-withdrawn-branch true] [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress"` (`conflict`)。`--drop-withdrawn-branch true` を渡すときは
さらに `withdrawn_branches` に同一 `id` のエントリが存在すること (`conflict`)。
効果: `worktree→<path>, base→<branch>`。`--drop-withdrawn-branch` 指定時は同じ書き込みで
`withdrawn_branches` から該当エントリを削除する。
成功: `{"ok": true, "id": "<id>", "worktree": "<path>", "base": "<branch>"}`。

### `set-executor`

```
state.ts set-executor --state-dir <dir> --id <id> --executor <agentId> --session <s> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress"` (`conflict`)。
効果: `executor→<agentId>, executor_last_event_at→now, session→<s>` の3つを**同時**に書く
(3つのうち1つだけを書けるフラグの組み合わせは存在しない — `--executor`/`--session` はどちらも
必須フラグ)。
成功: `{"ok": true, "id": "<id>", "executor": "<agentId>", "session": "<s>"}`。

### `touch-executor`

```
state.ts touch-executor --state-dir <dir> --id <id> [--session <s>] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress" && executor!=null` (`conflict`)。
効果: `executor_last_event_at→now`。`--session` を渡し、かつ現在 `session==null` のときだけ
`session→<s>` (現在 `session` が非null なら `--session` を渡しても上書きしない)。
成功: `{"ok": true, "id": "<id>"}`。

### `set-takeover`

```
state.ts set-takeover --state-dir <dir> --id <id> (--at <iso> | --clear true) \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--at`/`--clear` はどちらか一方だけを指定 (両方/どちらも無しは `usage`)。
前提: `status=="in_progress"` (`conflict`)。
効果: `takeover_at→<iso>` (`--at`) または `takeover_at→null` (`--clear`)。
成功: `{"ok": true, "id": "<id>", "takeover_at": <iso または null>}`。

### `phase-pass`

```
state.ts phase-pass --state-dir <dir> --id <id> --from <phase> --to <phase> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--from`/`--to` は `research`/`research+plan`/`plan`/`implement`/`report`/`finalize`/
`pr_fix`/`rebase_fix` のいずれか (それ以外は `usage`)。
前提: `status=="in_progress" && phase==<from>` (`conflict`)。
効果: `phase→<to>, attempts→0`。
成功: `{"ok": true, "id": "<id>", "phase": "<to>"}`。

### `phase-fail`

```
state.ts phase-fail --state-dir <dir> --id <id> --phase <phase> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress" && phase==<phase>` (`conflict`)。
効果: `attempts+=1`。
成功: `{"ok": true, "id": "<id>", "attempts": <n>}`。

### `block`

```
state.ts block --state-dir <dir> --id <id> --reason <text> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress"` (`conflict`)。
効果: `status→"blocked", blocked_reason→<text>, phase→null, session→null`。
(`executor`/`executor_last_event_at`/`takeover_at` は変更しない — 復帰時は `restore` が
初期化する。)
成功: `{"ok": true, "id": "<id>", "status": "blocked"}`。

### `dequeue`

```
state.ts dequeue --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress"` (`conflict`)。着手直後に「二重着手が発覚した」等で巻き戻す専用。
効果: `queue` から該当エントリを丸ごと削除。
成功: `{"ok": true, "id": "<id>"}`。

### `finalize-start`

```
state.ts finalize-start --state-dir <dir> --id <id> --from <report|pr_fix> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--from` は `report`/`pr_fix` のみ (それ以外は `usage`)。
前提: `status=="in_progress" && phase==<from>` (`conflict`)。
効果: `phase→"finalize", attempts→0`。
成功: `{"ok": true, "id": "<id>", "phase": "finalize"}`。

### `in-review`

```
state.ts in-review --state-dir <dir> --id <id> \
  [--commits <n> --ref <s> --branch <s> --base <s> [--tip <sha>]] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--commits`/`--ref`/`--branch`/`--base` は「4つとも指定」か「4つとも省略」のどちらかのみ
(片方だけの指定は `usage`)。`--commits 0` のとき `--tip` を渡すと `usage`。`--commits` が
1以上のとき `--tip` を省くと `usage`。
前提: `status=="in_progress" && phase=="finalize"` (`conflict`)。
効果: `status→"in_review", phase→null, attempts→0`。上記4フラグを指定したときだけ
`review→{ref, branch, tip: (commits>=1 ? tip : null), base}` を書く (省略時は既存の
`review` を一切変更しない — `pr_fix`/`rebase_fix` からの復帰専用)。
成功: `{"ok": true, "id": "<id>", "status": "in_review"}`。

### 追従

### `watch-init`

```
state.ts watch-init --state-dir <dir> --id <id> --session <s> \
  [--preserve-handled true] [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null && review.ref!=null` (`conflict`)。
効果: `review.watch` を既定値一式で作る
(`{state:"watching", proc:null, proc_started_at:null, sig:null, head:null, ci:null,
handled:[], fix_pending:false, pending_ids:[], findings:null, fix_attempts:0, errors:0,
checked_at:null, note:null}`)。`--preserve-handled true` のときは、既存
`review.watch.handled` があればそれを引き継ぐ (無ければ空配列のまま)。加えて `session→<s>`。
成功: `{"ok": true, "id": "<id>"}`。

### `watch-set`

```
state.ts watch-set --state-dir <dir> --id <id> \
  [--proc <id|null>] [--sig <s|null>] [--head <s|null>] \
  [--ci <passing|failing|pending|none|null>] [--checked-at <iso|null>] \
  [--errors-inc true] [--errors-reset true] [--note <s|null>] \
  [--state <watching|stopped>] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

最低1つのフィールドフラグが必須 (すべて省略は `usage`)。`--errors-inc`/`--errors-reset` は
排他 (両方指定は `usage`)。
前提: `review.watch!=null` (`conflict`)。
効果: 指定したフィールドだけ書く。**不変条件**: `--proc` に非null値を渡すと
`proc_started_at→now` も同時に、`--proc null` なら `proc_started_at→null` も同時に書く
(`--proc` 省略時は `proc_started_at` を変更しない)。`--state stopped` を渡すと、トップレベル
`session→null` も同じ書き込みで行う (`--state watching` または `--state` 省略では `session`
を変更しない)。`--errors-inc` は現在の `errors` に+1、`--errors-reset` は `errors→0`。
成功: `{"ok": true, "id": "<id>"}`。

### `fix-pending`

```
state.ts fix-pending --state-dir <dir> --id <id> --pending-ids <csv> --findings <path> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review.watch!=null` (`conflict`)。
効果: `watch.fix_pending→true, watch.pending_ids→<csvを分割した配列>, watch.findings→<path>`。
`--pending-ids ""` は空配列。
成功: `{"ok": true, "id": "<id>"}`。

### `fix-start`

```
state.ts fix-start --state-dir <dir> --id <id> --session <s> \
  [--reset-attempts true] [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && watch.fix_pending==true` (`conflict`)。
効果 (lock内で計算): 現在の `fix_attempts` (`--reset-attempts true` なら0とみなす) に+1 した
値を `newAttempts` とする。`newAttempts<=3` なら
`status→"in_progress", phase→"pr_fix", attempts→0, session→<s>, watch.fix_pending→false,
watch.fix_attempts→newAttempts` (`started:true`)。`newAttempts>3` なら
`watch.fix_attempts→newAttempts, watch.state→"stopped", watch.note→"追従上限",
session→null` (`started:false`、`status`/`phase` は変更しない)。**どちらも exit 0** —
上限超過は「修正しない」という正常分岐であって前提違反ではない。
成功: `{"ok": true, "id": "<id>", "started": <bool>, "fix_attempts": <n>}`。

### `fix-done`

```
state.ts fix-done --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress" && phase=="finalize" && review.watch!=null` (`conflict`)。
効果: `watch.handled` に `watch.pending_ids` を重複無しで合流、`watch.pending_ids→[]`,
`watch.findings→null` を単一の原子的書き込みで行う (分割不能 — kill しても実行前か実行後の
どちらかの state しか観測されない)。
成功: `{"ok": true, "id": "<id>"}`。

### `review-only`

```
state.ts review-only --state-dir <dir> --id <id> --ids <csv> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review.watch!=null` (`conflict`)。
効果: `watch.handled` に `--ids` を重複無しで合流。
成功: `{"ok": true, "id": "<id>"}`。

### 載せ直し

### `rebase-record`

```
state.ts rebase-record --state-dir <dir> --id <id> \
  --blocked-onto <sha> --reason <dirty|diverged|conflict|push> \
  [--kind <superseded|overlap|adjacent|structural|other>] [--cause <text>] [--report <path>] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null` (`conflict`)。
効果: `review.rebase` が未存在なら新規作成 (`at→now`)。既存なら `at` は既存値のまま保持し、
`blocked_onto`/`reason`/指定された `kind`/`cause`/`report` だけ上書きする (2段階の呼び出しで
トリアージ結果を後から足せる)。
成功: `{"ok": true, "id": "<id>"}`。

### `rebase-resolve-pending`

```
state.ts rebase-resolve-pending --state-dir <dir> --id <id> --from-tip <sha> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review.rebase!=null` (`conflict`)。
効果: `review.rebase.resolve_pending→true, review.rebase.from_tip→<sha>`。
成功: `{"ok": true, "id": "<id>"}`。

### `rebase-start`

```
state.ts rebase-start --state-dir <dir> --id <id> --session <s> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review.rebase!=null && review.rebase.resolve_pending==true`
(`conflict`)。
効果: `status→"in_progress", phase→"rebase_fix", attempts→0, session→<s>,
review.rebase.resolve_pending→false`。
成功: `{"ok": true, "id": "<id>", "status": "in_progress", "phase": "rebase_fix"}`。

### `rebase-done`

```
state.ts rebase-done --state-dir <dir> --id <id> --tip <sha> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--tip` は必須 (省略は `usage`)。
前提: `review!=null && review.rebase!=null` (`status` は問わない — `in_progress`/
`rebase_fix` からの復帰、`in_review` のままの背景載せ直しの両方から呼ばれる)。
効果: `review.tip→<sha>`。`review.rebase` プロパティを削除する (`null` ではなく削除 —
スキーマの `reviewRebase` は type:"object" のみで null を許さないため)。
成功: `{"ok": true, "id": "<id>", "tip": "<sha>"}`。

### `rebase-give-up`

```
state.ts rebase-give-up --state-dir <dir> --id <id> --blocked-onto <sha> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_progress" && phase=="rebase_fix" && review!=null && review.rebase!=null`
(`conflict`)。
効果: `status→"in_review", phase→null, attempts→0, session→null,
review.rebase.reason→"conflict", review.rebase.blocked_onto→<sha>,
review.rebase.resolve_pending→false` (`kind`/`cause`/`report`/`from_tip` は既存値を保持)。
成功: `{"ok": true, "id": "<id>", "status": "in_review"}`。

### 回収と候補

### `recover-done`

```
state.ts recover-done --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null && review.tip!=null` (`conflict`)。
効果: `status→"done", session→null`。`review.watch` が存在すれば `watch.proc→null`
(存在しなければ何もしない — `finish=commit` のタスクは `review.watch` を持たない)。
成功: `{"ok": true, "id": "<id>", "status": "done"}`。

### `withdraw`

```
state.ts withdraw --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null` (`conflict`)。
効果: `review.withdrawn→true`。
成功: `{"ok": true, "id": "<id>"}`。

### `withdraw-remove`

```
state.ts withdraw-remove --state-dir <dir> --id <id> --reason <text> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null && review.withdrawn==true && worktree!=null &&
base!=null` (`conflict`)。
効果: `branch="task-pipeline/<id>"` を導出し、`withdrawn_branches` へ
`{id, branch, base, worktree, at:now, reason}` を追加**かつ** `queue` から該当エントリを
削除する、単一の原子的書き込み。
成功: `{"ok": true, "id": "<id>"}`。

### `withdraw-asked`

```
state.ts withdraw-asked --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `status=="in_review" && review!=null && review.withdrawn==true` (`conflict`)。
効果: `review.withdrawn_asked→true`。
成功: `{"ok": true, "id": "<id>"}`。

### `candidates-set`

```
state.ts candidates-set --state-dir <dir> --candidates-json <json> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--candidates-json` は候補オブジェクト (最低 `id`/`title` の string を持つ) の JSON 配列
文字列。形状が違えば `usage`。`--id` による対象指定は無い (トップレベル配列の丸ごと置換)。
効果: `candidates` を丸ごと置換する。
成功: `{"ok": true, "count": <n>}`。

### `candidates-drop`

```
state.ts candidates-drop --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `candidates` に存在する (`missing`)。
効果: `candidates` から該当エントリを削除。
成功: `{"ok": true, "id": "<id>"}`。

### `promoted-add`

```
state.ts promoted-add --state-dir <dir> --ids <csv> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提なし。
効果: `promoted` へ `--ids` を重複無しで合流。
成功: `{"ok": true, "ids": ["<id>", ...]}`。

### `promoted-drop`

```
state.ts promoted-drop --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `promoted` に存在する (`missing`)。
効果: `promoted` から該当id削除。
成功: `{"ok": true, "id": "<id>"}`。

### `relisted-add`

```
state.ts relisted-add --state-dir <dir> --id <id> --seen-at <iso> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `relisted` に存在しない (`conflict`)。
効果: `relisted` へ `{id, seen_at}` を追加。
成功: `{"ok": true, "id": "<id>"}`。

### `relisted-drop`

```
state.ts relisted-drop --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `relisted` に存在する (`missing`)。
効果: `relisted` から該当id削除。
成功: `{"ok": true, "id": "<id>"}`。

### `restore`

```
state.ts restore --state-dir <dir> --id <id> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: `id` が `relisted` に存在する (`missing`) **かつ** 対応する `queue` エントリの
`status` が `in_review`/`blocked`/`done` のいずれか (`conflict`)。
効果: `queue` エントリを `status→"approved", phase→null, attempts→0, session→null,
executor→null, executor_last_event_at→null, takeover_at→null, blocked_reason→null` に
(`worktree`/`base`/`review` は変更しない)。同じ書き込みで `relisted` から該当エントリを削除。
成功: `{"ok": true, "id": "<id>", "status": "approved"}`。

### 全体

### `stalled-set`

```
state.ts stalled-set --state-dir <dir> --value <depleted|max_open|null> \
  [--bump true] [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--id` は無い (トップレベルフィールド)。
効果: `--value null` は `stalled→null, stalled_since→null` を無条件に行う。`--value` が
`depleted`/`max_open` のときは `stalled→<value>`。`stalled_since` は、現在 `stalled` が
`null` から非nullへ変わるときだけ現在時刻に進む。すでに非nullが継続する場合 (種別が
変わる場合を含む) は `--bump true` を渡したときだけ現在時刻に進み、無ければ不変。
成功: `{"ok": true, "value": <"depleted"|"max_open"|null>}`。

## lock (排他) の契約

`<state dir>/lock` を `mkdir` で作る (既存なら `AlreadyExists`)。作成時刻が **10分より古い**
ときだけ stale とみなし、`mv` (rename) で退避してから削除する — 退避 (rename) に成功した
プロセスだけが除去者になるので、複数プロセスが同時に stale 判定しても排他は破れない。
`--lock-retry-ms` (既定 10000) 待って `--lock-max-retries` (既定 3) 回失敗したら `lock` で
諦める。書き込みは一時ファイルに全文を書いてから `rename` で置換する (部分書き込み防止)。
`init`/`history-append`、および `state-cli-verbs` で追加した36 verb (`approve` 〜
`stalled-set`) がこの lock を使う (`get`/`validate` は読み専用で lock 不要。
`session-touch`/`sessions-alive` は自分のファイルと日次残骸しか触らないため lock 不要)。

## heartbeat の契約

`session-touch` が付ける・掃除するタイミングと `sessions-alive` が見る窓は、
`task-pipeline/SKILL.md` の「セッションの所有権」節の shell コマンド (`find -mmin +1440`
`/-mmin -90`) と同じ strict 境界: 生存判定は年齢 **< 90分**、掃除対象は年齢 **> 1440分**。
