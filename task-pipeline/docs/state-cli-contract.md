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
  `--reset-attempts`/`--errors-inc`/`--errors-reset`/`--clear-session` は、フラグを渡すときは
  必ず値 `true` を伴う (`--bump true`)。それ以外の値は `usage` (`T-V-in-review-10`/
  `T-V-in-review-11` が `--clear-session false`/`--clear-session 1` を `usage`・state.json
  不変で固定している)。フラグを渡さなければ偽として扱う。
- **`--lock-retry-ms <n>`/`--lock-max-retries <n>`**: 全ての書き込み系 verb (下記すべて) が
  共通で受け付ける (既定はそれぞれ 10000/3、`init`/`history-append` と同じ)。
- 前提違反は `conflict` (対象は存在する) か `missing` (`--id` の指す対象が存在しない) のいずれか
  で失敗し、**state.json は一切書き換わらない** (エラー時共通の契約がそのまま適用される)。

## 遷移表 (機械 A: status/phase)

状態機械のノードは `(status, phase)` の合法な組だけで、**`phase` が非 null なのは
`status` が `in_progress` のとき、かつそのときに限る**。`in_progress` のノードは
`in_progress/<phase>` と表記する (現在 4 + 8 = 12 ノード)。この節は実装
(`state-transitions.ts` の `GATE_PHASE_SEQUENCES` / `VERB_LIFECYCLE`) の転写であり、
`state.test.ts` の T-D4 / T-D3 が一致を検査する (どちらかだけ直すとテストが落ちる)。

フェーズ列は gate ごとに 1 本で、`phase-pass` が通せるのは**この列の隣接ペアだけ**
(飛び越し・逆行・自己辺・gate 違いの辺・`finalize`/`pr_fix`/`rebase_fix` への出入りは
`conflict`。それらへの遷移は `finalize-start` / `fix-start` / `rebase-start` が担う):

| gate | フェーズ列 |
|---|---|
| `full` | `research → plan → implement → report` |
| `light` | `research+plan → implement → report` |

queue エントリを対象にする verb の (from ノード → to ノード)。`in_progress/*` は
in_progress の全フェーズノードを指す。to の「変更なし」はノードを動かさない verb、
「分岐」は引数・状態で行き先が分かれる verb、「削除」は queue からエントリが消える verb:

| verb | from | to |
|---|---|---|
| `approve` | (新規追加) | `approved` |
| `claim` | `approved` | `in_progress/research` |
| `set-gate` | `in_progress/research` | `in_progress/research+plan` |
| `set-worktree` | `in_progress/*` | (変更なし) |
| `set-executor` | `in_progress/*` | (変更なし) |
| `touch-executor` | `in_progress/*` | (変更なし) |
| `set-takeover` | `in_progress/*` | (変更なし) |
| `phase-pass` | `in_progress/research`, `in_progress/plan`, `in_progress/implement`, `in_progress/research+plan` | (分岐) |
| `phase-fail` | `in_progress/research`, `in_progress/plan`, `in_progress/implement`, `in_progress/report`, `in_progress/research+plan`, `in_progress/pr_fix`, `in_progress/rebase_fix` | (変更なし) |
| `block` | `in_progress/*` | `blocked` |
| `dequeue` | `in_progress/*` | (削除) |
| `finalize-start` | `in_progress/report`, `in_progress/pr_fix`, `in_progress/rebase_fix` | `in_progress/finalize` |
| `in-review` | `in_progress/finalize` | `in_review` |
| `watch-init` | `in_review` | (変更なし) |
| `watch-set` | `in_review` | (変更なし) |
| `fix-pending` | `in_review` | (変更なし) |
| `fix-start` | `in_review` | (分岐) |
| `fix-done` | `in_progress/finalize` | (変更なし) |
| `review-only` | `in_review` | (変更なし) |
| `answered-set` | `in_review` | (変更なし) |
| `rebase-record` | `in_review` | (変更なし) |
| `rebase-resolve-pending` | `in_review` | (変更なし) |
| `rebase-start` | `in_review`, `in_progress/finalize` | `in_progress/rebase_fix` |
| `rebase-done` | `in_review` | (変更なし) |
| `rebase-give-up` | `in_progress/rebase_fix` | `in_review` |
| `recover-done` | `in_review` | `done` |
| `withdraw` | `in_review` | (変更なし) |
| `withdraw-remove` | `in_review` | (削除) |
| `withdraw-asked` | `in_review` | (変更なし) |
| `restore` | `in_review`, `done`, `blocked` | `approved` |

この表の from に無いノードから呼ぶと `conflict` になる。from にあっても、各 verb 固有の
補助前提 (`review.watch` の存在や `fix_pending` など。下記 verb 一覧) を満たさなければ
同じく `conflict`。書き込み後には全 verb 共通で「到達不能ノードを書かない」「`review.watch`
は `review.ref` なしに存在しない」の不変条件が検査され、違反は `schema` で拒否される。

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

以下、`state-cli-verbs` タスクで追加し、その後 `answered-set` (gh-6) を加えた 37 verb。**すべて lock を使う書き込み系**で、
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

`--from`/`--to` は `phase` の全トークンのいずれか (それ以外は `usage`)。
前提: `status=="in_progress" && phase==<from>`、かつ `<from> → <to>` が**そのタスクの
`gate` のフェーズ列 (上記「遷移表」) の隣接ペア**であること (どちらを欠いても `conflict`)。
飛び越し・自己辺・gate 違いの辺は通らない。`finalize`/`pr_fix`/`rebase_fix` への遷移は
この verb では行えない (`finalize-start`/`fix-start`/`rebase-start` を使う)。
効果: `phase→<to>, attempts→0`。
成功: `{"ok": true, "id": "<id>", "phase": "<to>"}`。

### `phase-fail`

```
state.ts phase-fail --state-dir <dir> --id <id> --phase <phase> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--phase` は検証ゲートを持つフェーズ (フェーズ列の各フェーズと `pr_fix`/`rebase_fix`)
のみ。`finalize` は検証対象外なので `usage`。
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
`review.watch` が存在すれば `watch.state→"stopped", watch.proc→null,
watch.proc_started_at→null` も同じ書き込みで行う (`pr_fix`/`rebase_fix` の途中で
blocked になる経路がある — blocked は追従対象外)。
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
state.ts finalize-start --state-dir <dir> --id <id> --from <report|pr_fix|rebase_fix> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--from` は `report`/`pr_fix`/`rebase_fix` のみ (それ以外は `usage`)。`rebase_fix` は
解決サイクル (載せ直しの衝突解消) が PASS したときに、report/pr_fix と同じく finalize を
経て in-review へ戻るために要る。
前提: `status=="in_progress" && phase==<from>` (`conflict`)。
効果: `phase→"finalize", attempts→0`。
成功: `{"ok": true, "id": "<id>", "phase": "finalize"}`。

### `in-review`

```
state.ts in-review --state-dir <dir> --id <id> \
  [--commits <n> --ref <s> --branch <s> --base <s> [--tip <sha>]] \
  [--clear-session true] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--commits`/`--ref`/`--branch`/`--base` は「4つとも指定」か「4つとも省略」のどちらかのみ
(片方だけの指定は `usage`)。`--commits 0` のとき `--tip` を渡すと `usage`。`--commits` が
1以上のとき `--tip` を省くと `usage`。
前提: `status=="in_progress" && phase=="finalize"` (`conflict`)。
効果: `status→"in_review", phase→null, attempts→0`。上記4フラグを指定したときは
`review` の**グループフィールドだけ**を `{ref, branch, tip: (commits>=1 ? tip : null),
base}` に書き換え、**既存の `review.watch` / `review.rebase` / `review.withdrawn` /
`review.withdrawn_asked` は保持する** (丸ごと置換しない — `pr_fix` 復帰は毎回ここを
通るため、置換すると `watch.fix_attempts` の上限と `watch.handled` の再浮上ガードが
周回のたびに無効化される)。4フラグ省略時は既存の `review` を一切変更しない。`--clear-session true`
を渡すと、同じ書き込みで `session→null` も行う (レビュー待ちにしたタスクに `watch-init` を
呼ばない経路 — `ref` が PR URL でないとき — で使う。揮発資源がもう無いタスクに `session` を
残すと、そのセッションが他の作業で生きている間、他セッションからは「所有中」に見えてマージの
回収が heartbeat 失効 [最大90分] まで遅れるため)。
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
checked_at:null, note:null, review_only:[], answered:[]}`)。`--preserve-handled true` の
ときは、既存 `review.watch.handled` があればそれを引き継ぐ (無ければ空配列のまま)。
**`--preserve-handled` の及ぶ範囲は `handled` だけ**で、`review_only`/`answered` は常に
`[]` から、`fix_attempts` は常に 0 から始まる (`pending_ids`/`findings` と同じく
watch-init は毎回まっさらにする)。この verb を呼ぶのは**新しいレビュー周回の開始時だけ**
(最初のレビュー待ち・restore 後の再走) で、`pr_fix`/`rebase_fix` からの復帰では呼ばない —
復帰は `in-review` が `watch` を保持するので、`fix_attempts`/`handled` が周回をまたいで
生き残る (SKILL.md の復帰列)。加えて `session→<s>`。
成功: `{"ok": true, "id": "<id>"}`。

### `watch-set`

```
state.ts watch-set --state-dir <dir> --id <id> \
  [--proc <id|null>] [--sig <s|null>] [--head <s|null>] \
  [--ci <passing|failing|pending|none|null>] [--checked-at <iso|null>] \
  [--errors-inc true] [--errors-reset true] [--note <s|null>] \
  [--state <watching|stopped>] [--session <s|null>] \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

最低1つのフィールドフラグが必須 (すべて省略は `usage`)。`--errors-inc`/`--errors-reset` は
排他 (両方指定は `usage`)。`--session <非null値>` と `--state stopped` の同時指定も `usage`
(`--state stopped` が既に `session→null` を行うため、両立し得ない値を同時に渡す形になる。
`T-V-watch-set-12` が固定)。`--session null` と `--state stopped` はどちらも null を意味する
ので同時指定してもよく、exit 0 で `session→null, review.watch.state→"stopped"` になる
(`T-V-watch-set-13` が受理側として固定)。
前提: `status=="in_review" && review.watch!=null` (`conflict`)。in_review に限るのは、
飛行中 (`pr_fix`/`rebase_fix`) のタスクの `session` を watch 側の機械から null に
落とせないようにするため。approved / blocked / done の watch は `restore`/`block`/
`recover-done` がそれぞれ静止させるので、この verb の対象にならない。
効果: 指定したフィールドだけ書く。**不変条件**: `--proc` に非null値を渡すと
`proc_started_at→now` も同時に、`--proc null` なら `proc_started_at→null` も同時に書く
(`--proc` 省略時は `proc_started_at` を変更しない)。`--state stopped` を渡すと、トップレベル
`session→null` も同じ書き込みで行う (`--state watching` または `--state` 省略では `--session`
を渡さない限り `session` を変更しない)。`--session <s>` (nullable フラグ) を渡すと、
トップレベル `session→<s>` (または `--session null` で `session→null`) を同じ書き込みで
無条件に上書きする。非null値での用途は watch プロセスを別セッションが張り直すとき (前の所有
セッションが死んでいても `session` は非null のままなので、`touch-executor` の条件付き代入では
上書きできない)。null での用途は、揮発資源を手放すが `review.watch.state` は `watching` の
まま変えたくないとき (`watch-init` 直後に修正サイクル手順0で拾い直す場合など。`--state stopped`
は `watch.state` も変えてしまうので使えない)。`--errors-inc` は現在の `errors` に+1、
`--errors-reset` は `errors→0`。
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

前提: `status=="in_review" && watch.fix_pending==true && watch.state=="watching"`
(`conflict`)。
効果 (lock内で計算): 現在の `fix_attempts` (`--reset-attempts true` なら0とみなす) に+1 した
値を `newAttempts` とする。`newAttempts<=3` なら
`status→"in_progress", phase→"pr_fix", attempts→0, session→<s>, watch.fix_pending→false,
watch.fix_attempts→newAttempts` (`started:true`)。`newAttempts>3` なら
`watch.fix_attempts→newAttempts, watch.state→"stopped", watch.note→"追従上限",
session→null` (`started:false`、`status`/`phase` は変更しない)。**どちらも exit 0** —
上限超過は「修正しない」という正常分岐であって前提違反ではない。上限で `stopped` に
なった後は前提 (`watch.state=="watching"`) が偽になるため、再度呼んでも `conflict` で
加算されない (ラッチ)。ユーザーが `watch.state` を `watching` に戻したときだけ
`--reset-attempts true` 付きで再開できる。
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
state.ts review-only --state-dir <dir> --id <id> --items-json <json> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--items-json` は `[{"id": "<s>", "updated_at": "<s>"|null}, ...]` 形の JSON 配列。各要素は
`id` (文字列) と `updated_at` (文字列または `null`) の両方を必須で持つ。JSON として parse
できない・配列でない・要素が上記の形を満たさない、のいずれも `usage`。
前提: `status=="in_review" && review.watch!=null` (`conflict`)。
効果: `watch.review_only` に `--items-json` の各要素を id ごとに upsert する (**`watch.handled`
は変更しない** — `watch.handled` は `fix-done` を経由して実際に修正したものだけを表す)。既存の
id と `updated_at` が完全一致していれば版は進んでいないとみなす。id が新規、または
`updated_at` が前回の記録と異なる (前回・今回のいずれかが `null` の場合を含む — 版が比較でき
ないので常に「進んだ」扱い) なら、その id を返り値の `new_or_changed` に含める。
成功: `{"ok": true, "id": "<id>", "new_or_changed": ["<id>", ...], "review_only_total": <n>}`
(`review_only_total` はこの呼び出し後の `watch.review_only` の件数)。

### `answered-set`

```
state.ts answered-set --state-dir <dir> --id <id> --items-json <json> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`review-only` と同じ入出力契約を、対象フィールドだけ `watch.answered` に変えて持つ (gh-6: レビュ
アーの質問に回答・投稿したことを記録し、二重投稿を防ぐ)。`--items-json` の形・バリデーション
(JSON として parse できない・配列でない・要素が `{id, updated_at}` の形を満たさない、のいずれも
`usage`) と dedup 規則 (id と `updated_at` が完全一致していれば版は進んでいないとみなす。id が
新規、または `updated_at` が前回の記録と異なる [前回・今回のいずれかが `null` の場合を含む] な
ら `new_or_changed` に含める) は `review-only` と同一。
前提: `status=="in_review" && review.watch!=null` (`conflict`)。
効果: `watch.answered` に `--items-json` の各要素を id ごとに upsert する (**`watch.handled` にも
`watch.review_only` にも触れない** — 「質問に回答・投稿済み」は「pr_fix でコードを直した」
[`handled`] とも「人の判断待ちに回した」[`review_only`] とも別の語彙であるため)。
成功: `{"ok": true, "id": "<id>", "new_or_changed": ["<id>", ...], "answered_total": <n>}`
(`answered_total` はこの呼び出し後の `watch.answered` の件数)。

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

`rebase_fix` への入口は 2 つあり、この verb が両方を受ける (遷移表の from):

- **`in_review` から** (背景の載せ直しが衝突し、`rebase-record`/`rebase-resolve-pending`
  で控えた復帰): 前提は `review.rebase!=null && review.rebase.resolve_pending==true`
  (`conflict`)。
- **`in_progress/finalize` から** (executor が push 直前の載せ直しで `REBASE-CONFLICT`
  停止した直接進入): `review` を一切見ない (最初の PR を出す直前なら `review` は null の
  まま)。衝突の控えとトリアージ結果は state に置かず、オーケストレーターがイテレーション
  内で持ち回る (SKILL.md の「解決サイクル」の「finalize から入る経路」)。

効果: `status→"in_progress", phase→"rebase_fix", attempts→0, session→<s>`。
`review.rebase` が存在すれば `resolve_pending→false` も同じ書き込みで行う。
成功: `{"ok": true, "id": "<id>", "status": "in_progress", "phase": "rebase_fix"}`。
(`T-V-rebase-start-3`/`T-V-rebase-start-4` が finalize 入口を、`T-V-phase-pass-4` が
`phase-pass` でこの遷移ができないことを固定。)

### `rebase-done`

```
state.ts rebase-done --state-dir <dir> --id <id> --tip <sha> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

`--tip` は必須 (省略は `usage`)。
前提: `status=="in_review" && review!=null` (`conflict`)。in_review に限るのは、飛行中
(`in_progress/rebase_fix`) に `review.rebase` を消せると `rebase-give-up` の前提が永久に
満たせなくなるため。`rebase_fix` からの復帰列では、`in-review` で `in_review` に戻した
**後**にこの verb を呼ぶ (SKILL.md のレビュー待ち処理)。**`review.rebase` の存在は要求
しない** — 背景の載せ直しが初回の試行で衝突なく成功した最頻パスには `rebase-record` の
控えが無く、それでも tip の更新 (マージ回収の鍵) はこの verb にしか無い。
効果: `review.tip→<sha>`。`review.rebase` プロパティが存在すれば削除する (`null` では
なく削除 — スキーマの `reviewRebase` は type:"object" のみで null を許さないため。
無ければ tip の更新だけを行う)。
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
効果: `status→"done", session→null`。`review.watch` が存在すれば
`watch.state→"stopped", watch.proc→null, watch.proc_started_at→null` も同じ書き込みで
行う (done は追従対象外 — `watching` のまま残すと停止経路が「自分の担当」として数え
続ける。存在しなければ何もしない — `finish=commit` のタスクは `review.watch` を持たない)。
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
効果: `queue` エントリを `status→"approved", gate→"full", phase→null, attempts→0,
session→null, executor→null, executor_last_event_at→null, takeover_at→null,
blocked_reason→null` に (`worktree`/`base`/`review` は変更しない)。`gate` を初期値に
戻すのは、`light` のまま `claim` すると `(in_progress/research, gate: light)` という
どの verb でも進めないノードに着地するため — gate の正はトラッカー側の宣言で、
再 claim 時の gate 判定 (SKILL.md タスク実行手順 1) が改めて復元する。ただし `review.watch` が存在すれば
`watch.state→"stopped", watch.proc→null, watch.proc_started_at→null` にする (前回周回の
watching / proc を抱えたまま approved に再入させない。`handled`/`fix_attempts` の値は残り、
次の周回の `watch-init --preserve-handled` が仕切り直す)。同じ書き込みで `relisted` から
該当エントリを削除。
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
`init`/`history-append`、および `approve` 〜 `stalled-set` の
37 verb がこの lock を使う (`get`/`validate` は読み専用で lock 不要。
`session-touch`/`sessions-alive` は自分のファイルと日次残骸しか触らないため lock 不要)。

## heartbeat の契約

`session-touch` が付ける・掃除するタイミングと `sessions-alive` が見る窓は、
`task-pipeline/SKILL.md` の「セッションの所有権」節の shell コマンド (`find -mmin +1440`
`/-mmin -90`) と同じ strict 境界: 生存判定は年齢 **< 90分**、掃除対象は年齢 **> 1440分**。
