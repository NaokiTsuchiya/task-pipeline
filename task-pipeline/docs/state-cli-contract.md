# state.ts CLI 契約 (状態モデル v2)

`task-pipeline/scripts/state.ts` の呼び出し契約。**この CLI は状態モデル v2
(`task-pipeline/docs/state-model-v2-2026-08.md`) だけを話す。** v1 の語彙 (タスク直下の
`status`/`phase`/`gate`、`review.watch`/`review.rebase`) は受け付けない。

この文書は実装の転写であり、`state.test.ts` の T-D1〜T-D6 が機械照合している
(どちらかだけ直すとテストが落ちる)。

## 起動形

```
deno run --no-prompt \
  --allow-read=<state dir>[,<git common dir>/info] \
  --allow-write=<state dir>[,<git common dir>/info] \
  task-pipeline/scripts/state.ts <verb> --state-dir <dir> [verb固有フラグ...]
```

`--state-dir` は全 verb 必須。許可の外に触れると `permission` で落ち、**副作用は残らない**。

## 出力契約

stdout に必ず **1 行の JSON**。

- 成功時: exit 0、verb ごとの成功ペイロード (下記)。
- 失敗時: exit は下表のコード、`{"error": "<code>", "message": "<text>"}`。
- **エラー時は state.json を一切書き換えない** (バイト単位で不変。`updated_at` も動かない)。

## 終了コード

| 名前 | コード | 意味 |
|---|---|---|
| (success) | 0 | 成功 |
| `usage` | 10 | verb 不明・省略・必須フラグ欠落・未知フラグ・不正な値 (`--id` の形状違反、廃止 verb を含む) |
| `lock` | 11 | lock を既定回数再試行しても取得できなかった |
| `schema` | 12 | state.json が構文的に不正な JSON、または `checkStateV2` が invalid と判定した (読めない `schema_version` を含む) |
| `missing` | 13 | 対象 verb が要求する state.json (または state dir 自体)、あるいは `--id` が指す queue/candidates/promoted/relisted のエントリが存在しない |
| `permission` | 14 | Deno の許可境界外へのアクセス (`Deno.errors.NotCapable`/`PermissionDenied`) |
| `conflict` | 15 | 対象のエントリは存在するが、その verb が要求する現在のノード (領域 P × 領域 A の座標) やフィールドの前提を満たさない (例: `claim` を `queued` でないタスクに実行) |

## verb 固有フラグの共通規約

- **`--id`**: 対象 `queue[i]` の id (一部 verb は `candidates`/`promoted`/`relisted` の id)。
- **nullable なフラグ**: `--sig`/`--head`/`--ci`/`--checked-at`/`--note` など、対象フィールドが
  `null` を許容する verb では、値に文字列 `"null"` を渡すと JSON の `null` として書き込む
  (実際の proc id / sha / URL がリテラル文字列 `"null"` になることは運用上想定していない)。
  フラグ自体を省略すると、そのフィールドは書き換えない。
- **真偽フラグ**: `--bump`/`--clear`/`--drop-withdrawn-branch`/`--reset-attempts`/
  `--errors-inc`/`--errors-reset`/`--sig-clear`/`--resolve`/`--auto` は、渡すときは必ず値
  `true` を伴う (`--bump true`)。それ以外の値は `usage`。省略すれば偽。
- **`--lock-retry-ms <n>`/`--lock-max-retries <n>`**: 全ての書き込み系 verb が共通で受け付ける
  (既定はそれぞれ 10000/3)。
- 前提違反は `conflict` (対象は存在する) か `missing` (`--id` の指す対象が存在しない) のいずれかで
  失敗し、**state.json は一切書き換わらない**。

## ノードと遷移

状態は **領域 P (進行)** と **領域 A (成果物)** の 2 領域で持つ。verb ごとの遷移は
2 領域それぞれの from→to として `state-transitions-v2-spec.ts` の `VERB_SPEC` に宣言され、
前提チェックは両領域に掛かる。

### 領域 P のノード

`progress` と (running のときだけ存在する) `run` の座標 (kind, gate, phase) の合法な組。
`gate` は `kind == initial` のとき、かつそのときに限り非 null (`-` は gate 無しを表す)。

| ノード | 意味 |
|---|---|
| `queued` | 承認済みで着手待ち。`run` は無い |
| `resting` | 実行中の run が無く、成果物の状態だけが動く (レビュー待ち・取り下げ済み・マージ済み) |
| `blocked` | 人の入力待ちで停止。`blocked_reason` を持つ |
| `running(initial,full,research)` | 初回 engagement (full gate) の research |
| `running(initial,full,plan)` | 同 plan |
| `running(initial,full,implement)` | 同 implement |
| `running(initial,full,report)` | 同 report |
| `running(initial,full,finalize)` | 同 finalize (検証ゲート無し) |
| `running(initial,full,rebase_fix)` | 同 finalize からの迂回 (衝突解消) |
| `running(initial,light,research+plan)` | 初回 engagement (light gate) の統合フェーズ |
| `running(initial,light,implement)` | 同 implement |
| `running(initial,light,report)` | 同 report |
| `running(initial,light,finalize)` | 同 finalize |
| `running(initial,light,rebase_fix)` | 同 迂回 |
| `running(pr_fix,-,pr_fix)` | PR フィードバック対応の本体 |
| `running(pr_fix,-,finalize)` | 同 finalize |
| `running(pr_fix,-,rebase_fix)` | 同 迂回 |
| `running(rebase_fix,-,rebase_fix)` | 解決サイクル (背景の載せ直しが衝突した要求を消費した run) |
| `running(rebase_fix,-,finalize)` | 解決サイクルの finalize |

### 領域 A のノードとサブ軸

`artifact.state` が主ノードで、`open` のときだけ `follow` (追従の子オブジェクト) を持つ。
follow はさらに 3 つのサブ軸を持ち、追従対象かどうかはこの座標から導出される
(`attention == auto` ∧ `fix:null` ∧ `rebase:quiet` のときだけ追従する)。

| 座標 | 意味 |
|---|---|
| `none` | 共有された成果物がまだ無い |
| `open` | PR / ブランチが開いている。`follow` を持ちうる |
| `merged` | マージ済み。`follow` は持たない。出口は `retire` だけ |
| `withdrawn` | PR が未マージで閉じられた。`asked` / `note` を持つ |
| `auto` | 機械に委ねている (attention 軸) |
| `human(fix_limit)` | 押し直しの上限に達して人待ち |
| `human(errors)` | 観測エラーが上限に達して人待ち |
| `human(manual)` | 人が明示的に止めた |
| `fix:null` | 修正要求が無い |
| `fix:pending` | 修正要求が未消費 |
| `fix:taken` | 修正要求を run が消費済み |
| `rebase:quiet` | 載せ直しガードの控えだけ (記録なしも同じ座標) |
| `rebase:queued` | 解決サイクル行きが宣言され、未消費 |
| `rebase:taken` | 解決サイクル run が消費済み |

### 領域 P の from グループ

遷移表の from 列で使う略号。構成ノードはここが唯一の定義である。

| グループ | 構成ノード |
|---|---|
| `P_RUNNING` | `running(initial,full,research)` `running(initial,full,plan)` `running(initial,full,implement)` `running(initial,full,report)` `running(initial,full,finalize)` `running(initial,full,rebase_fix)` `running(initial,light,research+plan)` `running(initial,light,implement)` `running(initial,light,report)` `running(initial,light,finalize)` `running(initial,light,rebase_fix)` `running(pr_fix,-,pr_fix)` `running(pr_fix,-,finalize)` `running(pr_fix,-,rebase_fix)` `running(rebase_fix,-,rebase_fix)` `running(rebase_fix,-,finalize)` |
| `P_VERIFIED` | `running(initial,full,research)` `running(initial,full,plan)` `running(initial,full,implement)` `running(initial,full,report)` `running(initial,full,rebase_fix)` `running(initial,light,research+plan)` `running(initial,light,implement)` `running(initial,light,report)` `running(initial,light,rebase_fix)` `running(pr_fix,-,pr_fix)` `running(pr_fix,-,rebase_fix)` `running(rebase_fix,-,rebase_fix)` |
| `P_FINALIZE` | `running(initial,full,finalize)` `running(initial,light,finalize)` `running(pr_fix,-,finalize)` `running(rebase_fix,-,finalize)` |
| `P_DETOUR` | `running(initial,full,rebase_fix)` `running(initial,light,rebase_fix)` `running(pr_fix,-,rebase_fix)` |
| `P_CYCLE_REBASE` | `running(rebase_fix,-,rebase_fix)` |

### 遷移表

`P.to` / `A.to` の標語の意味: `unchanged` = 座標は動かないがフィールドは書きうる /
`untouched` = そのオブジェクトを 1 バイトも変えない / `dynamic` = 引数と現在値から分岐 /
`removed` = queue から外れる。領域 A の from (どのサブ軸から発火できるか) は各 verb 節の
「前提」に書く — サブ軸の積は 23 組あり表に展開すると読めなくなるため、ここでは to だけを
機械照合する (from の網羅は `state-transitions-v2.test.ts` の行列テストが持つ)。

| verb | P.from | P.to | A.to |
|---|---|---|---|
| `approve` | — | `queued` | `untouched` |
| `claim` | `queued` | `running(initial,full,research)` | `cycle-reset` |
| `set-gate` | `running(initial,full,research)` | `running(initial,light,research+plan)` | `untouched` |
| `advance` | `P_VERIFIED` | `dynamic` | `untouched` |
| `phase-fail` | `P_VERIFIED` | `unchanged` | `untouched` |
| `block` | `P_RUNNING` | `blocked` | `untouched` |
| `dequeue` | `P_RUNNING` | `removed` | `untouched` |
| `restore` | `resting` `blocked` | `queued` | `unchanged` |
| `retire` | `resting` | `removed` | `untouched` |
| `ship` | `P_FINALIZE` | `resting` | `dynamic` |
| `merged` | `resting` | `unchanged` | `merged` |
| `withdraw` | `resting` | `unchanged` | `withdrawn(asked=false)` |
| `withdraw-asked` | `resting` | `unchanged` | `withdrawn(asked=true)` |
| `withdraw-remove` | `resting` | `removed` | `untouched` |
| `fix-request` | `resting` | `unchanged` | `fix-pending` |
| `rebase-request` | `resting` | `unchanged` | `dynamic` |
| `rebase-applied` | `resting` | `unchanged` | `rebase-quiet` |
| `fix-start` | `resting` | `dynamic` | `dynamic` |
| `rebase-start` | `P_FINALIZE` `resting` | `dynamic` | `rebase-taken` / `untouched` |
| `rebase-give-up` | `P_CYCLE_REBASE` | `resting` | `rebase-quiet` |
| `rebase-forgo` | `P_DETOUR` | `dynamic` | `rebase-quiet` |
| `probe-run` | `resting` | `unchanged` | `unchanged` |
| `probe-exit` | `resting` | `unchanged` | `unchanged` |
| `release` | `resting` | `unchanged` | `unchanged` |
| `observe` | `resting` | `unchanged` | `dynamic` |
| `attention-set` | `resting` | `unchanged` | `dynamic` |
| `review-only` | `resting` | `unchanged` | `unchanged` |
| `answered-set` | `resting` | `unchanged` | `unchanged` |
| `set-worktree` | `P_RUNNING` | `unchanged` | `untouched` |
| `set-executor` | `P_RUNNING` | `unchanged` | `untouched` |
| `touch-executor` | `P_RUNNING` | `unchanged` | `untouched` |
| `set-takeover` | `P_RUNNING` | `unchanged` | `untouched` |

### フェーズ列と advance の辺

検証フェーズの列は gate ごとに固定で、full は research → plan → implement → report、
light は research+plan → implement → report。どちらもその後 `finalize` が続く。
`advance` が通せるのは下表の隣接辺だけで、飛び越し・逆行・列違いは `conflict` になる。
末尾の `rebase_fix → finalize` は迂回 (2.4 節) からの復帰辺である。

| from | to | 列 (kind/gate) |
|---|---|---|
| `research` | `plan` | `initial/full` |
| `plan` | `implement` | `initial/full` |
| `implement` | `report` | `initial/full` |
| `report` | `finalize` | `initial/full` |
| `rebase_fix` | `finalize` | `initial/full` |
| `research+plan` | `implement` | `initial/light` |
| `implement` | `report` | `initial/light` |
| `report` | `finalize` | `initial/light` |
| `rebase_fix` | `finalize` | `initial/light` |
| `pr_fix` | `finalize` | `pr_fix` |
| `rebase_fix` | `finalize` | `pr_fix` |
| `rebase_fix` | `finalize` | `rebase_fix` |

## verb 一覧

46 verb。出所は 2 つで、どちらにも属さない verb は存在しない (`state.test.ts` の T-D6):

- **遷移 32** — `VERB_SPEC` のキー。上の遷移表に載る。
- **帳簿 14** — `state-ledger-v2.ts` の `LEDGER_VERBS`。queue エントリの座標を持たない。

### 帳簿系

### `init`

```
state.ts init --state-dir <dir> --tracker <t> --source <s> --git-common-dir <gcd> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: なし (state dir を作る)。
効果: `<gcd>/info/exclude` に `/<state dir 名>/` を冪等に追記し、state.json を次の 3 分岐で扱う。

- 無い → v2 の空 state を作る (`schema_version: 2`, `queue: []`, `completed: []`)。
- `schema_version` が 2 → **何も書かない** (バイト単位の no-op)。
- `schema_version` が 1、またはキーごと無い → `migrateV1toV2` を**一度だけ**適用する
  (設計3.2節)。移行後は 2 になるので、次の `init` は no-op 分岐に落ちる。
- それ以外 (3 以上・非数値) → `schema` で失敗し、ファイルは不変。

成功: `{"ok": true, "created": <bool>, "migrated": <bool>, "state_dir": "<abs>"}`。

### `get`

```
state.ts get --state-dir <dir>
```

前提: state.json が存在する (`missing`)。
効果: 無し (読み取り専用)。**スキーマ検証も行わない** — 壊れた state を人が読むための入口。
成功: state.json の内容そのもの。

### `validate`

```
state.ts validate --state-dir <dir>
```

前提: state.json が存在する (`missing`)。
効果: 無し。`checkStateV2` を掛け、違反なら `schema`。
成功: `{"ok": true}`。

### `next`

```
state.ts next --state-dir <dir> [--session <id>] [--alive <csv>] [--now <iso>] \
  [--config <k=v,...>]
```

前提: state.json が存在し (`missing`)、`checkStateV2` を満たす (`schema`)。
効果: **無し (読み取り専用)。lock を取らず、state.json をバイト単位で変更しない。**
読むのは state.json と `<state dir>/task_counts/<session>` の行数だけで、git もトラッカーも
触らない — それらが要る判断は**アクションではなく観測依頼**として返し、結果はイベント
(verb) として戻る (設計5.1・5.2)。

- `--session` 省略/空 = セッション id を主張できない環境。所有権判定で「自分」に一致する
  タスクが無くなる。
- `--alive` 省略 = 生存セッション 0 件 (`sessions-alive` の返り値をカンマ区切りで渡す)。
- `--now` 省略 = CLI の現在時刻。パースできなければ `usage`。
- `--config` は `key=value` のカンマ区切り。キーは
  `finish` (`none`\|`commit`\|`pr`、既定 `none`) / `approve` (`ask`\|`auto`、既定 `ask`) /
  `rebase` (`auto`\|`off`、既定 `auto`) / `max_open` (非負整数、既定 2) /
  `max_tasks` (非負整数、既定は無制限 = `null`)。未知キー・enum 外の値・整数でない値・
  `=` の無い断片は `usage`。同じキーが 2 度現れたら後勝ち。
- `task_counts/<session>` の行数は **`wc -l` と同じ意味論** (改行文字の数。末尾改行の無い
  最終行は数えない) — SKILL.md 側の記述と食い違わせないため。

**閾値** (実装は `state-next.ts` の定数。**SKILL.md には数値を置かない**):

| 判定 | 値 | 不等号 |
|---|---|---|
| 実行エージェントの沈黙 | 90 分 | これ**より**古いと `status-check` (ちょうどは稼働中) |
| 引き継ぎ待ちの打ち切り | 30 分 | 以上で `takeover` |
| probe リースの失効 | 7 時間 | 以上で `probe-run` (`reason: expired`) |
| 停滞の打ち切り | 24 時間 | 以上で `stalled.cutoff` が真 |
| 押し直しの上限 | 3 | 以上で `fix-start` が上限ラッチになる (`at_limit`) |
| 飛行中の上限 | 2 | 以上で `start.blocked_by` に `inflight_limit` |

成功 (1 行の JSON):

```json
{"ok": true, "now": "<iso>", "session": "<id>|null",
 "config": {"finish":"pr","approve":"ask","rebase":"auto","max_open":2,"max_tasks":null},
 "counts": {"queued":1,"running":1,"resting":2,"blocked":0,"excluded":1,"open_prs":2,
            "running_attendable_initial":1,"running_excluded_initial":1,
            "running_mine_finishing":0,"tasks_started":3},
 "tasks": [{"id":"gh-42","ownership":"self","excluded":false,"status":"in_review",
            "progress":"resting","artifact":"open","follow_target":true,
            "actions":[],"observations":[],"finalize":null}],
 "start": {"allowed":false,"blocked_by":["max_open"],"next_id":null,"detail":{}},
 "stalled": {"current":"max_open","since":"<iso>|null","elapsed_min":123,
             "set_to":"max_open","defer":null,"cutoff":false},
 "observations": [{"kind":"tracker-list","why":"..."}]}
```

- `counts.queued`/`running`/`resting`/`blocked` は**非除外**のタスクだけを数える
  (除外分は `excluded`)。
- `counts.open_prs` = 非除外 ∧ `resting` ∧ `artifact.state == open` ∧ `follow != null`。
  `follow` が生まれるのは `ref` が PR URL のときだけなので (設計1.3)、これが
  「マージ待ちの自分の PR」の集合そのものである。**`ref` の文字列は検査しない。**
- `counts.running_attendable_initial` = 非除外 ∧ `running` ∧ `run.kind == initial`
  (新規着手を塞ぐ集合)。`counts.running_excluded_initial` は除外側の同型 (飛行中の上限の
  分母)。**仕上げ (`pr_fix`/`rebase_fix`) はどちらにも入らない** — 新規着手とは別枠だから
  である。`counts.running_mine_finishing` は `session` が自分の仕上げの件数。
- `tasks[].actions` は**その時点で due なアクションの列挙**であって「次の 1 手」ではない。
  `kind` は `claim` / `probe-run` / `fix-start` / `rebase-start` / `release` / `retire` /
  `clear-takeover` / `takeover` / `status-check` / `set-takeover` / `wait`。
  **`excluded` が真のタスクでは `actions` も `observations` も必ず空**である
  (生きている他セッションのタスクには一切触らない)。
- `tasks[].observations` の `merge-proof` は `resting × open ∧ tip != null` に付く
  (git でマージ証明を確認せよ)。トップレベルの `observations` の `tracker-list` は
  非除外の `queued` も `running` も無いときに付く (アダプタの `list` を呼べ)。
- `tasks[].finalize` は `running` かつ `run.phase == "finalize"` のときだけ非 null。
  `ship` の引数構成 (`ref_kind` は `finish` 由来、`group_flags` は `--commits` が 1 以上の
  ときに 4 つまとめて付ける対象) と、finalize 指示に `, rebase: off` を足すかどうかの
  `rebase_off` (**出所は `config.rebase` だけ**) を返す。
- `start.blocked_by` は `["max_tasks","own_initial","inflight_limit","max_open"]` の
  優先順で、該当するものを**全部**列挙する。`allowed` が真のときだけ `next_id` に
  非除外の先頭 `queued` の id が入る。
- `stalled.set_to` は `stalled-set --value` に渡す値。`"null"` / `"max_open"` /
  `"defer"` (= `tracker-list` の結果次第。`defer` オブジェクトの `if_empty` /
  `otherwise` がその分岐) / `"keep"` (停滞の 2 種類のどちらでもないので書き換えない)。

### `session-touch`

```
state.ts session-touch --state-dir <dir> --id <session id> [--cleanup-stale-min <n>]
```

前提: なし。`--id` は空 / `.` / `..` / `/` を含むものを `usage` で弾く。
効果: `<dir>/sessions/<id>` を作成 (または mtime を現在時刻に更新) し、既定 1440 分**より**
古い他の session ファイルを削除する。lock は取らない。
成功: `{"ok": true, "id": "<id>", "cleaned": ["<id>", ...]}`。

### `sessions-alive`

```
state.ts sessions-alive --state-dir <dir> [--alive-max-min <n>]
```

前提: なし (sessions ディレクトリが無ければ空配列)。
効果: 無し (読み取り専用、lock 無し)。既定 90 分**未満**の mtime を持つものを生存とみなす。
成功: `{"ok": true, "alive": ["<id>", ...]}`。

### `history-append`

```
state.ts history-append --state-dir <dir> --line <s> \
  [--lock-retry-ms <n>] [--lock-max-retries <n>]
```

前提: state.json が存在する (`missing`)。
効果: `history` に 1 行追加。空文字も有効な値。
成功: `{"ok": true, "history_length": <n>}`。

### `candidates-set`

```
state.ts candidates-set --state-dir <dir> --candidates-json <json> [lock flags]
```

前提: `--candidates-json` が JSON 配列で、各要素が文字列の `id` と `title` を持つ (`usage`)。
効果: `candidates` を置換。
成功: `{"ok": true, "count": <n>}`。

### `candidates-drop`

```
state.ts candidates-drop --state-dir <dir> --id <id> [lock flags]
```

前提: `id` が `candidates` に存在する (`missing`)。
効果: 該当要素を除去。
成功: `{"ok": true, "id": "<id>"}`。

### `promoted-add`

```
state.ts promoted-add --state-dir <dir> --ids <csv> [lock flags]
```

前提: なし。
効果: `promoted` に和集合で追加。
成功: `{"ok": true, "ids": ["<id>", ...]}`。

### `promoted-drop`

```
state.ts promoted-drop --state-dir <dir> --id <id> [lock flags]
```

前提: `id` が `promoted` に存在する (`missing`)。
効果: 該当要素を除去。
成功: `{"ok": true, "id": "<id>"}`。

### `relisted-add`

```
state.ts relisted-add --state-dir <dir> --id <id> --seen-at <iso> [lock flags]
```

前提: `id` が `relisted` にまだ無い (`conflict`)。
効果: `{id, seen_at}` を追加。
成功: `{"ok": true, "id": "<id>"}`。

### `relisted-drop`

```
state.ts relisted-drop --state-dir <dir> --id <id> [lock flags]
```

前提: `id` が `relisted` に存在する (`missing`)。
効果: 該当要素を除去。
成功: `{"ok": true, "id": "<id>"}`。

### `stalled-set`

```
state.ts stalled-set --state-dir <dir> --value depleted|max_open|null [--bump true] [lock flags]
```

前提: なし。
効果: `stalled` を設定 (または `null` で解除)。`stalled_since` は「今まで null だった」か
`--bump` のときだけ現在時刻に更新する。
成功: `{"ok": true, "value": "<value>"|null}`。

### 進行系

### `approve`

```
state.ts approve --state-dir <dir> --id <id> --title <s> [lock flags]
```

前提: `id` が `queue` に存在しない (`conflict`)。
効果: `queued × none` のエントリを追加する。
成功: `{"ok": true, "id": "<id>"}`。

### `claim`

```
state.ts claim --state-dir <dir> --id <id> --session <s> [lock flags]
```

前提: P が `queued`。
効果: `running(initial, full, research)` にし、`session` を立てる。**follow があれば周回リセット**
(設計2.3): `attention → auto`、`asks` 両方 null、`ledger.fix_attempts → 0`、
`review_only`/`answered → []`、`probe.sig → null`。`ledger.handled` は保持する。
成功: `{"ok": true, "id": "<id>", "kind": "initial", "gate": "full", "phase": "research", "session": "<s>"}`。

### `set-gate`

```
state.ts set-gate --state-dir <dir> --id <id> [lock flags]
```

前提: P が `running(initial,full,research)`。
効果: `gate → light`、`phase → research+plan`、`attempts → 0`。
成功: `{"ok": true, "id": "<id>", "kind": "initial", "gate": "light", "phase": "research+plan"}`。

### `advance`

```
state.ts advance --state-dir <dir> --id <id> --from <phase> --to <phase> [lock flags]
```

前提: P が `P_VERIFIED` のいずれか、`run.phase == <from>`、`<from> → <to>` が現在の列の
隣接辺 (上のフェーズ列表)。`--from`/`--to` は全フェーズ名 (finalize を含む) を受ける。
効果: `phase → <to>`、`attempts → 0`。
成功: `{"ok": true, "id": "<id>", "phase": "<to>"}`。

### `phase-fail`

```
state.ts phase-fail --state-dir <dir> --id <id> --phase <phase> [lock flags]
```

前提: P が `P_VERIFIED` のいずれかで `run.phase == <phase>`。`--phase` は**検証ゲートを持つ
フェーズだけ**を受ける (`finalize` は `usage`)。
効果: `attempts` を 1 増やす (ノードは動かない)。
成功: `{"ok": true, "id": "<id>", "attempts": <n>}`。

### `block`

```
state.ts block --state-dir <dir> --id <id> --reason <s> [lock flags]
```

前提: P が `P_RUNNING` のいずれか。
効果: `blocked` にし、`run → null`、`blocked_reason → <s>`、`session → null`。
追従の静止処理は無い (blocked は定義から追従対象外)。
成功: `{"ok": true, "id": "<id>", "progress": "blocked"}`。

### `dequeue`

```
state.ts dequeue --state-dir <dir> --id <id> [lock flags]
```

前提: P が `P_RUNNING` のいずれか。
効果: queue からエントリを除去。
成功: `{"ok": true, "id": "<id>"}`。

### `restore`

```
state.ts restore --state-dir <dir> --id <id> [lock flags]
```

前提: P が `resting` または `blocked`、A が `merged` **以外**、かつ `id` が `relisted` に居る
(`missing`)。
効果: `queued` に戻し、`run → null`、`blocked_reason → null`、`session → null`、
`probe` のリースを外す。`relisted` から当該エントリを外す。周回データのリセットは次の
`claim` が行う。
成功: `{"ok": true, "id": "<id>", "progress": "queued"}`。

### `retire`

```
state.ts retire --state-dir <dir> --id <id> [lock flags]
```

前提: P が `resting`、A が `merged`、`session` が null (揮発資源ゼロ)。
効果: queue からエントリを外し、`completed` に `{id, done_at}` を控える。同じ書き込みで
24 時間超の控えを掃除する (設計2.5)。
成功: `{"ok": true, "id": "<id>", "completed": <n>}`。

### 完了系

### `ship`

```
state.ts ship --state-dir <dir> --id <id> --commits <n> \
  [--ref <url> --branch <b> --tip <sha> --base <b>] [lock flags]
```

前提: P が `P_FINALIZE` のいずれか。`--commits >= 1` なら 4 つのグループフラグが**全部必要**、
`--commits 0` なら**全部省略必須** (どちらも違反は `usage`)。
効果 (設計2.2 — 復帰列を 1 イベントに畳んだもの): P → `resting`。`commits >= 1` なら
A が `none`/`withdrawn` のとき open を新規作成 (ref が PR URL なら follow も新規)、
既に `open` ならグループ欄だけ更新して follow は保持。`commits 0` なら A は不変。
`asks.fix.taken` の ids は `ledger.handled` へ合流して ask を消し、`asks.rebase.taken` も消す。
未消費の rebase-ask は `resolve → false` に降格。`probe.sig → null`。`session` は遷移後の
artifact が follow を持つときだけ保持し、そうでなければ null。
成功: `{"ok": true, "id": "<id>", "notify": "initial"|"update"|"none", "mark": <bool>, "fix_count": <n>}`
— `notify` は通知テンプレートの選択、`mark` はトラッカーへ `mark <id> in_review` が要るか
(`run.kind == initial` のときだけ真)。

### `merged`

```
state.ts merged --state-dir <dir> --id <id> [lock flags]
```

前提: P が `resting`、A が `open` で `tip` が非 null。
効果: A → `merged` (follow は破棄)、`session → null`。
成功: `{"ok": true, "id": "<id>", "artifact": "merged"}`。

### `withdraw`

```
state.ts withdraw --state-dir <dir> --id <id> [--note <s>] [lock flags]
```

前提: P が `resting`、A が `open`。
効果: A → `withdrawn(asked=false)` (follow は破棄、`note` を控える)、`session → null`。
成功: `{"ok": true, "id": "<id>", "artifact": "withdrawn"}`。

### `withdraw-asked`

```
state.ts withdraw-asked --state-dir <dir> --id <id> [lock flags]
```

前提: P が `resting`、A が `withdrawn`。
効果: `asked → true`。
成功: `{"ok": true, "id": "<id>"}`。

### `withdraw-remove`

```
state.ts withdraw-remove --state-dir <dir> --id <id> --reason <s> [lock flags]
```

前提: P が `resting`、A が `withdrawn`、`worktree`/`base` が非 null。
効果: queue からエントリを外し、`withdrawn_branches` に控えを追加。
成功: `{"ok": true, "id": "<id>"}`。

### 要求系

### `fix-request`

```
state.ts fix-request --state-dir <dir> --id <id> --ids <csv> --findings <path> [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。
効果: `asks.fix = {ids, findings, taken: false}`。`--ids` が空文字なら空配列 (CI 失敗だけで
指摘 id が無い周回)。
成功: `{"ok": true, "id": "<id>", "ids": [...]}`。

### `rebase-request`

```
state.ts rebase-request --state-dir <dir> --id <id> --blocked-onto <sha> \
  --reason dirty|diverged|conflict|push \
  [--kind superseded|overlap|adjacent|structural|other] [--cause <s>] [--report <path>] \
  [--resolve true] [--from-tip <sha>] [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。
効果: `asks.rebase` を upsert する。**省略したフラグは既存値を保つ** (`at` も初回の値を保つ)。
`--resolve true` が解決サイクル行きの宣言 (座標が `rebase:queued` になる)。`taken` には触れない。
成功: `{"ok": true, "id": "<id>", "resolve": <bool>|null}`。

### `rebase-applied`

```
state.ts rebase-applied --state-dir <dir> --id <id> --tip <sha> [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ (rebase-ask は無くてもよい — 衝突なく
成功した背景載せ直しには控えが無い)。
効果: `tip` を更新し、`asks.rebase → null`、`probe.sig → null`。
成功: `{"ok": true, "id": "<id>", "tip": "<sha>"}`。

### 仕上げ開始系

### `fix-start`

```
state.ts fix-start --state-dir <dir> --id <id> --session <s> [--reset-attempts true] [lock flags]
```

前提: P が `resting`、A が `open` ∧ `auto` ∧ `fix:pending`。
効果: `ledger.fix_attempts` を 1 増やし、上限 3 以内なら `running(pr_fix,-,pr_fix)` にして
ask を `taken` にし `session` を立てる。上限超なら **P は `resting` のまま**
`attention → human(fix_limit)`、`session → null`、リース解除だけを行い、**ask には触れない**
(pending のまま人の再開を待つ)。どちらの分岐でも `probe.proc → null`。
成功: `{"ok": true, "id": "<id>", "started": <bool>, "fix_attempts": <n>}`。

### `rebase-start`

```
state.ts rebase-start --state-dir <dir> --id <id> --session <s> [lock flags]
```

前提: 入口が 2 つある (設計2.4)。

- (a) 解決サイクル: P が `resting`、A が `open` ∧ `auto` ∧ `rebase:queued`。
- (b) 迂回: P が `P_FINALIZE` のいずれか (A には触れない)。

効果: (a) は `running(rebase_fix,-,rebase_fix)` を作り ask を `taken` に、`session` を立て、
リースを外す。(b) は **phase だけ**を `rebase_fix` に動かす (`kind`・`gate`・`asks` は不変) —
来歴が保たれることが `ship` の `mark`/`notify` 導出の安定性の根拠である。
成功: `{"ok": true, "id": "<id>", "kind": "<kind>", "gate": <gate>, "phase": "rebase_fix"}`。

### `rebase-give-up`

```
state.ts rebase-give-up --state-dir <dir> --id <id> --blocked-onto <sha> [lock flags]
```

前提: P が `P_CYCLE_REBASE` (解決サイクル専用)。
効果: `resting` へ戻し、rebase-ask を quiet のガード控えに戻す (`taken → false`,
`resolve → false`, `reason → conflict`, `blocked_onto` 更新)、`session → null`。
成功: `{"ok": true, "id": "<id>", "progress": "resting"}`。

### `rebase-forgo`

```
state.ts rebase-forgo --state-dir <dir> --id <id> --blocked-onto <sha> [lock flags]
```

前提: P が `P_DETOUR` (迂回専用 — `kind != rebase_fix`)。
効果: `phase → finalize` (旧基点のまま push させる)。rebase-ask にガードの控えを upsert する。
成功: `{"ok": true, "id": "<id>", "kind": "<kind>", "gate": <gate>, "phase": "finalize"}`。

### 追従系

### `probe-run`

```
state.ts probe-run --state-dir <dir> --id <id> --proc <id> [--session <s>] [lock flags]
```

前提: P が `resting`、A が `open` ∧ `auto` ∧ `fix:null` ∧ `rebase:quiet`
(= 1.3 節の追従対象の導出式そのもの)。
効果: `probe.proc` と `probe.proc_started_at` を立てる。既存リースは上書きしてよい
(死んだリースの張り替え)。`--session` があれば `session` も立てる。
成功: `{"ok": true, "id": "<id>", "proc": "<id>"}`。

### `probe-exit`

```
state.ts probe-exit --state-dir <dir> --id <id> [--sig <s>|null] [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。
効果: リースを外し (`proc`/`proc_started_at → null`)、`--sig` があれば観測済み署名を保存。
成功: `{"ok": true, "id": "<id>"}`。

### `release`

```
state.ts release --state-dir <dir> --id <id> [lock flags]
```

前提: P が `resting`。
効果: `session → null`、リースを外す。resting のタスクの揮発資源を手放す明示 verb。
成功: `{"ok": true, "id": "<id>"}`。

### `observe`

```
state.ts observe --state-dir <dir> --id <id> \
  [--head <sha>|null] [--ci passing|failing|pending|none|null] [--checked-at <iso>|null] \
  [--errors-inc true|--errors-reset true] [--note <s>|null] [--sig-clear true] [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。フィールドフラグが 1 つも無ければ `usage`。
`--errors-inc` と `--errors-reset` は同時に渡せない (`usage`)。
効果: 観測キャッシュを更新する。**`errors` が 3 に達したら同じ書き込みで
`attention → human(errors)`、`session → null`、リース解除**を行う。
成功: `{"ok": true, "id": "<id>", "errors": <n>, "latched": <bool>}`。

### `attention-set`

```
state.ts attention-set --state-dir <dir> --id <id> (--auto true | --human fix_limit|errors|manual) [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。`--auto` と `--human` は**ちょうど一方**
(両方・どちらも無しは `usage`)。
効果: `--human` は `attention → human(<reason>)` にし、`session → null` とリース解除も同じ
書き込みで行う。`--auto` は人の再開なので `probe.errors` も 0 に戻す。
成功: `{"ok": true, "id": "<id>", "attention": "auto"|"<reason>"}`。

### `review-only`

```
state.ts review-only --state-dir <dir> --id <id> --items-json <json> [lock flags]
```

前提: P が `resting`、A が `open` で follow を持つ。`--items-json` は `{id, updated_at}` の
JSON 配列 (形状違反は `usage`)。
効果: `ledger.review_only` に upsert する (`handled`/`answered` には触れない)。
成功: `{"ok": true, "id": "<id>", "new_or_changed": [...], "review_only_total": <n>}` —
`new_or_changed` は「今回新規、または前回記録した `updated_at` から版が進んだ」id だけ。
`updated_at` が null の id は比較のしようが無いので毎回含める。

### `answered-set`

```
state.ts answered-set --state-dir <dir> --id <id> --items-json <json> [lock flags]
```

前提・入出力は `review-only` と同じ形。書き込み先が `ledger.answered` になる
(「質問に回答・投稿済み」の語彙で、`handled`/`review_only` とは混ぜない)。
成功: `{"ok": true, "id": "<id>", "new_or_changed": [...], "answered_total": <n>}`。

### 実行帳簿

### `set-worktree`

```
state.ts set-worktree --state-dir <dir> --id <id> --worktree <path> --base <b> \
  [--drop-withdrawn-branch true] [lock flags]
```

前提: P が `P_RUNNING` のいずれか。`--drop-withdrawn-branch` を渡すときは
`withdrawn_branches` に当該 id の控えがある (`conflict`)。
効果: `worktree`/`base` を設定し、指示があれば控えを外す。
成功: `{"ok": true, "id": "<id>", "worktree": "<path>", "base": "<b>"}`。

### `set-executor`

```
state.ts set-executor --state-dir <dir> --id <id> --executor <s> --session <s> [lock flags]
```

前提: P が `P_RUNNING` のいずれか。
効果: `run.executor` と `run.executor_last_event_at` を設定し、`session` を立てる。
成功: `{"ok": true, "id": "<id>", "executor": "<s>", "session": "<s>"}`。

### `touch-executor`

```
state.ts touch-executor --state-dir <dir> --id <id> [--session <s>] [lock flags]
```

前提: P が `P_RUNNING` のいずれかで `run.executor` が非 null (`conflict`)。
効果: `run.executor_last_event_at` を現在時刻に。`--session` は `session` が null のときだけ
立てる (他セッションの所有権は奪わない)。
成功: `{"ok": true, "id": "<id>"}`。

### `set-takeover`

```
state.ts set-takeover --state-dir <dir> --id <id> (--at <iso> | --clear true) [lock flags]
```

前提: P が `P_RUNNING` のいずれか。`--at` と `--clear` は**ちょうど一方** (`usage`)。
効果: `run.takeover_at` を設定 / 解除。
成功: `{"ok": true, "id": "<id>", "takeover_at": "<iso>"|null}`。

## lock (排他) の契約

- 書き込み系 verb は `<state dir>/lock` を `mkdir` で取り、`--lock-max-retries` 回まで
  `--lock-retry-ms` 間隔で再試行する。取れなければ `lock` (exit 11)。
- **10 分より古い** lock は stale とみなして回収する (ちょうど 10 分は回収しない)。回収は
  rename → 削除で行い、同時に複数のプロセスが回収を試みても 1 つだけが成功する。
- 書き込みは tmp ファイル + rename で原子的に行う。途中で落ちても state.json は前の内容の
  まま残る。
- **lock を取らない verb**: `get` / `validate` / `next` / `sessions-alive` / `session-touch`。
  内訳は 2 種類で、前の 4 つは**読み取り専用** (state.json を読むだけで書き換えない)、
  `session-touch` は対象が state.json ではなく `sessions/*` の個別ファイルであり、列挙中に
  他セッションが要素を消す TOCTOU は「消えている == 目的達成」として飛ばす。
  この 5 つは lock フラグ (`--lock-retry-ms` / `--lock-max-retries`) も受け付けず、渡すと
  usage になる — 「lock を取らない」が `ALLOWED_FLAGS` の形として観測でき、
  `state.test.ts` の T-D8 が上の一覧と突き合わせる。

## heartbeat の契約

- `session-touch` は `<state dir>/sessions/<id>` の mtime を現在時刻に更新し、同時に
  **1440 分より古い**他の session ファイルを掃除する (ちょうど 1440 分は残す)。
- `sessions-alive` は **90 分未満**の mtime を持つものを生存として返す (ちょうど 90 分は
  生存に含めない)。
- どちらのしきい値も厳密不等号で、境界値は `state.test.ts` の T-H 系が固定している。
