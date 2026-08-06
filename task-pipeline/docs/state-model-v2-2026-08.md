# 状態モデル v2 — 階層化された 2 領域機械 (2026-08 設計)

現行の状態機械 (3 軸直積: 機械 A `status`/`phase` × 機械 B `review.watch` × 機械 B'
`review.rebase`) を、理想形から設計し直した文書。実装は範囲外で、この文書が確定してから
別途計画する。現行の宣言・実装は `scripts/state-transitions.ts` (`VERB_SPEC`)、契約は
`docs/state-cli-contract.md`、手順は `SKILL.md` を指す。

## 0. 設計判断の要約

1. **状態はタスクごとに 2 つの直交領域の積で持つ**: 領域 P「進行」(いま実行の手がどこに
   あるか) と領域 A「成果物」(作った変更がどこにあるか)。現行の `status` は両領域からの
   導出値になる。
2. **watch は独立機械ではなく、成果物 `open` の子に入れ子にする**。さらに watch が束ねて
   いた 3 つの性質 (帳簿・要求ラッチ・追従プロセス) を `ledger` / `asks` / `probe` に分離
   する。「追従中かどうか」は保存せず導出する — 「watching と書いてあるが誰も追従して
   いない」という欠陥クラスを表現不能にする。
3. **フェーズ実行は `run` オブジェクト (kind × gate × phase) として領域 P の複合状態に
   する**。`finalize` の来歴 (report から / pr_fix から / rebase_fix から) は `run.kind` と
   して構造的に永続化され、`FINALIZED` 後の処理は状態から導出できる。
4. **復帰列の多段 verb (fix-done → in-review → watch-set 等) を単一イベント `ship` に
   畳む**。順序を守らないと壊れる継ぎ目そのものを消す。
5. **周回帳簿のリセット境界は `claim` に置く** (watch-init と `--preserve-handled` は廃止)。
6. **「次に何をするか」を返す読み取り専用 verb `next` を語彙に加える**。SKILL.md の散文に
   しかなかった判断の大半を、状態 + 明示された外部入力からの純関数にする。

## 1. モデル

### 1.1 タスクの 2 領域

queue の各エントリは、次の 2 領域の直積として状態を持つ。

**領域 P (進行)** — いま実行の手がどこにあるか。

| ノード | 意味 |
| --- | --- |
| `queued` | 着手待ち。`claim` で次の engagement (取り組み) が始まる。現行の `approved` |
| `running(run)` | 実行中。`run` は下記 1.2 の複合状態。現行の `in_progress` |
| `resting` | この engagement の実行は終わり、実行の手が離れている。現行の `in_review` に相当 |
| `blocked(reason)` | パイプラインが自力で進めない。現行の `blocked` |

**領域 A (成果物)** — 作った変更がどこにあるか。

| ノード | 意味 |
| --- | --- |
| `none` | まだ共有できる成果物が無い (未着手、または `finish=none` で working tree に残した) |
| `open{...}` | ブランチ/PR として出ている。複合状態 (下記 1.3)。マージ待ち |
| `merged{ref, branch, tip, base}` | ユーザーのマージが証明された。現行の `done` |
| `withdrawn{ref, branch, tip, base, asked, note}` | PR が未マージで閉じられた。現行の `review.withdrawn` |

`merged` と `withdrawn` はグループ欄 (ref / branch / tip / base) を保持し、`follow` の子
(asks / ledger / probe) を持たない — 追従・修正・載せ直しはすべて open の中でしか意味を
持たないからである (これが v1 の「done / withdrawn に watching が残る」欠陥クラスを
表現不能にする形そのもの)。なお `resting × none` (finish=none) から merged へ到達する
経路は無い — マージ証明は tip を要するためで、v1 (`recover-done` が `review.tip` を要求)
と同じ振る舞いである。

現行の `status` はこの 2 領域からの**導出値**である:

```
status(P, A) =
  queued          → approved
  running         → in_progress
  blocked         → blocked
  resting ∧ A==merged → done
  resting ∧ その他     → in_review
```

トラッカー・報告・既存の語彙 (`mark <id> in_review` など) はこの導出値を使い続ける。
逆に、現行モデルで表現できなかった組み合わせがいくつか表現可能になる:

- **`blocked ∧ open`** — PR を出したまま仕上げ (`pr_fix` / `rebase_fix`) が blocked に
  なった状態。現行は blocked にすると「PR が open のままである」事実が `review` の中の
  残骸としてしか残らなかった。成果物の所在は進行が止まっても変わらないので、これは
  表現可能であるべき組である (PR は実際に open のままだから)。追従が止まる心配は無い —
  追従対象は `resting ∧ open` から導出されるので (5 節)、blocked のタスクは定義から
  追従されない。
- **`running(initial) ∧ open`** — restore で復帰したタスクの再走。前周回の PR が open の
  まま新しい engagement が走る。現行は `review` を残すことで同じ実態を表現していたが、
  ノードとしては見えていなかった。

### 1.2 `run` — 領域 P の複合状態

`running` は `run` オブジェクトを 1 つ持つ。

```
run = {
  kind: "initial" | "pr_fix" | "rebase_fix",
  gate: "full" | "light" | null,   // kind==initial のとき、かつそのときに限り非 null
  phase: <kind ごとのフェーズ列の要素>,
  attempts: <この phase の検証試行回数>,
  executor, executor_last_event_at, takeover_at,   // 実行エージェントの帳簿
}
```

kind ごとのフェーズ列 (最後の `finalize` だけが検証ゲートを持たない):

| kind | gate | フェーズ列 |
| --- | --- | --- |
| `initial` | `full` | research → plan → implement → report → finalize |
| `initial` | `light` | research+plan → implement → report → finalize |
| `pr_fix` | — | pr_fix → finalize |
| `rebase_fix` | — | rebase_fix → finalize |

これに加えて、**どの kind の finalize にも `rebase_fix` フェーズへの迂回辺がある**
(executor が push 直前の載せ直しで `REBASE-CONFLICT` 停止したときの detour。2.4 節)。
迂回は kind を変えない — `running(initial, full, rebase_fix)` は「initial の engagement が
push 直前の衝突解消に寄り道している」状態であり、来歴 (kind) と gate は保たれる。
kind==`rebase_fix` は resting から入る解決サイクル専用である。

この形が解く現行の問題:

- **`finalize` の来歴が state に残る。** 現行は `finalize-start --from` の値が永続化されず、
  `FINALIZED` 後の処理 3 通り (最初の PR を出す / 押し直す / force push) の選択が
  オーケストレータの記憶に依存していた (2026-08-05 の実運用障害 2 件の原因)。v2 では
  finalize は 1 ノードではなく `running(initial, finalize)` / `running(pr_fix, finalize)` /
  `running(rebase_fix, finalize)` の 3 ノードであり、来歴は状態の座標そのものになる。
- **`gate` がノード座標に入る。** 現行は gate が (status, phase) の座標外にあり、
  `(in_progress/research, gate: light)` という死に組が行列テストを素通りした
  (`docs/lessons/2026-08-06-orthogonal-dimension-escapes-node-matrix.md`)。v2 では gate は
  `run` の中にしか存在せず、`run` は `claim` が毎回 `gate: full` で作り直すので、死に組は
  構築の形として生まれない (restore は run を持たない `queued` へ戻るだけで、gate を
  「戻し忘れる」フィールド自体が無い)。
- **`executor` 系フィールドのスコープが正しくなる。** 現行は executor / takeover_at が
  タスク直下にあり、in_review や blocked でも残骸として残った。v2 では run の中にあるので
  run が終われば消える。「executor が居る」と主張できるのは running の間だけである。
- **phase-pass と finalize-start が 1 つの `advance` に統合できる。** どの kind でも
  「自分の列の隣接辺を 1 つ進む」だけであり、finalize への進入も列の最終辺にすぎない。

### 1.3 `open` — 領域 A の複合状態

```
open = {
  ref, branch, tip, base,          // グループ欄 (現行 review 直下と同じ)
  follow: null | {                 // ref が PR URL のときだけ存在 (finish=commit では null)
    attention: "auto" | {"human": "fix_limit" | "errors" | "manual"},
    asks: {
      fix:    null | { ids: [...], findings: <path>, taken: bool },
      rebase: null | { blocked_onto, reason, kind?, cause?, report?, at,
                       resolve: bool, from_tip?, taken: bool },
    },
    ledger: { handled: [], fix_attempts: 0, review_only: [], answered: [] },
    probe:  { proc, proc_started_at, sig, head, ci, checked_at, errors, note },
  },
}
```

現行 `review.watch` が束ねていた 3 つの性質を分離する:

- **`ledger` (レビュー周回の帳簿)** — 周回をまたいで累積するデータ。`handled` は
  PR の寿命全体で保持し、`fix_attempts` / `review_only` / `answered` は engagement
  (claim) 境界でリセットする (2.3 節)。
- **`asks` (要求ラッチ)** — 「直してほしい指摘が来ている」「載せ直しが要る」という
  未処理の要求。`taken` は「その要求を消費して仕上げ run が始まった」ことを表す
  (run が中断されても要求の出自が失われないため。2.4 節の割り込みで使う)。
- **`probe` (追従プロセスの観測キャッシュとリース)** — `proc` は watch プロセスの
  リース、残りは観測キャッシュ。**「追従中である」という状態は保存しない**。

**`attention` は現行 `watch.state` の置き換えだが、意味が違う。** `watch.state ==
"watching"` は「追従している」という主張だったが、実際に追従しているかとは同期して
おらず、そこに欠陥が集中した (recover-done / restore が watching を残す、pr_fix 中は
watching なのに誰も追従していない)。`attention` は「この PR の次アクションを機械に
委ねる (`auto`) か、人に委ねる (`human` + 理由)」という**耐久的な意図**だけを表す。
実際に追従すべきか・していることになっているかは保存せず、5 節の導出で決まる:

```
追従対象(タスク) ⇔ P==resting ∧ A==open ∧ follow≠null ∧ attention==auto
                    ∧ fix-ask が null ∧ rebase-ask が quiet (1.5 節の導出 3 値)
```

`human` の理由は 3 値: `fix_limit` (押し直し 3 往復の上限)、`errors` (観測 3 連続
エラー)、`manual` (人が止めた)。人が再開するときは attention を `auto` に戻す
(現行の「`watch.state` を `watching` に戻す」に対応する、唯一の手編集ポイント)。

### 1.4 タスク直下に残るフィールド

```
{
  id, title,
  progress: "queued" | "running" | "resting" | "blocked",
  run: null | { ... },             // progress==running のとき、かつそのときに限り非 null
  blocked_reason: null | string,   // progress==blocked のとき、かつそのときに限り非 null
  artifact: { state: "none" | "open" | "merged" | "withdrawn", ...open のフィールド, asked? },
  worktree, base,                  // engagement をまたいで生きる (done の回収まで消さない)
  session,                         // 揮発資源 (executor / probe.proc) の所有セッション
}
```

`gate` / `phase` / `attempts` / `executor` 系はタスク直下から消え、`run` の中へ移る。
`review` は `artifact` に置き換わる。`session` の意味と 4 契機は現行のまま。

### 1.5 合法ノードと不変条件

**領域 P の詳細ノード (19)**: `queued`, `resting`, `blocked`,
`running(initial, full, {research, plan, implement, report, finalize, rebase_fix})` の 6,
`running(initial, light, {research+plan, implement, report, finalize, rebase_fix})` の 5,
`running(pr_fix, {pr_fix, finalize, rebase_fix})` の 3,
`running(rebase_fix, {rebase_fix, finalize})` の 2 (各末尾の `rebase_fix` は迂回フェーズ。
1.2 節)。現行の 12 ノードとの違いは、gate と kind が座標に入ったことである。

**領域 A の詳細ノード**: `none`, `merged`, `withdrawn(asked: bool)`,
`open(follow==null)`, `open(follow: attention × fix-ask × rebase-ask)`。
follow の 3 サブ軸が現行の watch 軸 / rebase 軸に相当する行列テストの座標になる:

- attention 2 値: `auto` / `human`
- fix-ask 3 値: `null` / `pending` (taken=false) / `taken`
- rebase-ask 3 値 (導出。判定順: taken が真 → `taken`、resolve が真 → `queued`、
  それ以外 → `quiet`)。`quiet` は「記録なし (null)」と「載せ直しガードの控えだけがある
  (blocked_onto などのデータ)」の両方を含む — この 2 つはどの verb の発火可否も変えない
  純データ差であり、座標としては区別しない (「振る舞いを変えない次元は座標に入れない」
  の適用)。

**積の制約 (書き込み時に検査する不変条件)**。実行時検査は現行の教訓どおり
「その書き込みで触った item だけ」に掛け、より強い性質はテスト側 (行列テストの
出力不変条件) に置く:

1. `run ≠ null ⇔ progress == running` (現行の status/phase ペア制約の後継)
2. `artifact.state == merged ⇒ progress == resting` (done は実行の手が離れた後にだけ来る)
3. `progress == running(pr_fix) ⇒ artifact.state == open ∧ follow ≠ null ∧ asks.fix.taken`
4. `probe.proc ≠ null ⇒ progress == resting` (実行中に追従リースは張らない。
   `fix-start` / `rebase-start` は proc を null にしてから run を作る)
5. 外部要求の受理 (`fix-request` / `rebase-request`) は `progress == resting` のときだけ。
   `taken` は「その要求を消費して run が始まった」ことの消費マーカーで、これに触れて
   よいのは消費の開始 (`fix-start` / `rebase-start` 入口 a)・終了 (`rebase-give-up` /
   `ship`)・周回リセット (`claim`)・ガード控えの upsert (`rebase-forgo`) に限る。
   resting で受理済みの未消費 ask (pending / quiet / queued) を保持したまま running に
   入ることは合法である — 仕上げ run が消費していない ask は、次の resting でそのまま
   生きている。解決サイクルと迂回の判別は `run.kind` が担う (2.4 節)

## 2. 遷移

### 2.1 イベント一覧 (queue エントリを対象にする verb)

1 遷移 = 1 verb に戻す。表の from/to は「領域 P × 領域 A (follow サブ軸)」で書く。
`—` はその領域に触れないことを表し、フレームテストの宣言になる。

**進行系 (領域 P):**

| verb | from (P) | to (P) | A への効果 |
| --- | --- | --- | --- |
| `claim` | queued | running(initial, full, 先頭 phase) | follow があれば周回リセット (2.3) |
| `set-gate` | running(initial, full, research) | running(initial, light, research+plan) | — |
| `advance --from --to` | running(k, p) | running(k, p') — k の列の隣接辺のみ | — |
| `phase-fail --phase` | running(k, 検証フェーズ) | 同ノード (attempts+1) | — |
| `block --reason` | running(*) | blocked | — (probe.proc は不変条件 4 で既に null)。session→null |
| `dequeue` | running(*) | (queue から削除) | — |
| `restore` | resting, blocked | queued | merged は artifact ごと破棄して none に戻す (マージ済み PR の情報は history とトラッカーに残り、次の engagement は新しい PR を作る)。open/withdrawn/none は不変。probe.proc→null、session→null |

**完了系 (P と A をまたぐ。多段列を 1 イベントに畳んだもの):**

| verb | from | to | 効果 |
| --- | --- | --- | --- |
| `ship --commits N [--ref --branch --tip --base]` | running(k, finalize) | resting | 2.2 節。kind とデータで分岐する単一の原子的書き込み |
| `merged` | resting × open(tip≠null) | resting × merged | status 導出が done になる。follow は破棄、session→null |
| `withdraw [--note]` | resting × open | resting × withdrawn(asked=false) | PR が未マージで閉じられた。follow は破棄 (merged と同じ)、閉じられた理由は withdrawn.note に、session→null |
| `withdraw-asked` | resting × withdrawn | asked=true | |
| `withdraw-remove --reason` | resting × withdrawn | (queue から削除) | `withdrawn_branches` へ base を控える |

**要求系 (領域 A のみ。前提 P==resting):**

| verb | 効果 |
| --- | --- |
| `fix-request --ids --findings` | asks.fix = {ids, findings, taken: false} (現行 fix-pending) |
| `rebase-request --blocked-onto --reason [--kind --cause --report] [--resolve] [--from-tip]` | asks.rebase を upsert (現行 rebase-record + rebase-resolve-pending の統合。`--resolve` が解決サイクル行きの宣言) |
| `rebase-applied --tip` | 載せ直し成功 (run 無しの force push)。tip 更新・asks.rebase→null・probe.sig→null (現行 rebase-done) |

**仕上げ開始系 (要求の消費。P と A をまたぐ):**

| verb | from | to | 効果 |
| --- | --- | --- | --- |
| `fix-start` | resting × open(attention=auto, asks.fix=pending) | 上限内: running(pr_fix, pr_fix) / 上限超: resting のまま attention→human(fix_limit) | 上限内: fix_attempts+1、asks.fix.taken=true、probe.proc→null、session=自分。上限超: fix_attempts+1 と attention の切り替えと probe.proc→null のみで **asks.fix には触れない** (pending のまま人の再開を待つ)、session→null。`--reset-attempts` は現行どおり |
| `rebase-start` | (a) resting × open(attention=auto, rebase-ask=queued) (b) running(k, finalize) — k は任意 | (a) running(rebase_fix, rebase_fix) (b) running(k, rebase_fix) — **kind・gate 不変の迂回** | (a) は taken=true、session=自分、probe.proc→null。(b) は phase だけを動かし (attempts→0)、asks にも kind にも触れない (2.4)。(b) の from に kind==rebase_fix 自身の finalize も含む — 解消成功後の push 直前に基点がさらに進んで再衝突する経路 (v1 では合法だった) |
| `rebase-give-up --blocked-onto` | running(rebase_fix, rebase_fix) — 解決サイクル専用 | resting | asks.rebase: taken→false, resolve=false, reason=conflict, blocked_onto 更新 (quiet = 載せ直しガードに戻る。PR は旧基点のまま生きていて、push の義務は無い)。session→null |
| `rebase-forgo --blocked-onto` | running(k, rebase_fix) — k ≠ rebase_fix (迂回専用) | running(k, finalize) | 解消を諦めて旧基点のまま push させる (迂回の失敗出口。検証ゲート無しで finalize へ進む唯一の辺 — 元の finalize が果たされておらず push の義務が残っている)。asks.rebase にガードの控え {blocked_onto, reason: conflict, resolve: false, taken: false} を upsert する |

**追従系 (領域 A の follow のみ。前提 P==resting、follow≠null):**

| verb | 効果 |
| --- | --- |
| `probe-run --proc [--session]` | probe.proc リースを張る (現行 watch-set --proc)。既存リースは上書きしてよい (死んだリースの張り替え。生きた自プロセスの有無はオーケストレータが session と生存一覧から判定する)。**from 前提は 1.3 節の追従対象の導出式そのもの** (attention=auto、fix-ask が null、rebase-ask が quiet) — 「asks 保留中は張らない」を散文規則から CLI 前提に格上げし、導出とガードを同一ソースにする |
| `probe-exit [--sig]` | リースを外し、観測済み署名を保存 (現行 watch-set --proc null --sig) |
| `release` | session→null、probe.proc→null。resting のタスクの揮発資源を手放す明示 verb (現行 watch-set --session null の後継)。使う場面は現行と同じ 3 つ: 別の仕上げ在中でサイクル着手を見送るとき・ループを止めるとき・他セッション由来の proc を無効化するとき |
| `observe [--head --ci --checked-at] [--errors-inc\|--errors-reset] [--note] [--sig-clear]` | 観測キャッシュ更新。**errors が 3 に達したら同じ書き込みで attention→human(errors)、session→null、probe.proc→null** (現行は散文の手順だった。session を残すと他セッションの回収が最大 90 分遅れる) |
| `attention-set --auto\|--human <reason>` | 意図の切り替え (現行 watch-set --state の置き換え)。--human は session→null と probe.proc→null も同じ書き込みで行う。--auto は人の再開で、probe.errors も 0 に戻す (戻さないと復帰後の最初の 1 エラーで即再ラッチする) |
| `review-only --items-json` / `answered-set --items-json` | ledger への upsert (現行どおり) |

**帳簿系 (変更なし)**: `init` / `get` / `validate` / `session-touch` / `sessions-alive` /
`history-append` / `approve` / `candidates-set` / `candidates-drop` / `promoted-add` /
`promoted-drop` / `relisted-add` / `relisted-drop` / `stalled-set` / `set-worktree` /
`set-executor` / `touch-executor` / `set-takeover` (executor 系 3 verb は対象が run の中の
フィールドになるだけで起動形は同じ)。

**新設**: `next` (5 節)。

### 2.2 `ship` — 復帰列の一本化

現行で最も壊れやすかったのは `FINALIZED` 後の多段列である (pr_fix 復帰:
fix-done → in-review → watch-set --state watching の 3 verb を正しい順で。rebase_fix
復帰: in-review → rebase-done → watch-set の 3 verb。最初のレビュー待ち: in-review →
watch-init → watch-set --proc)。順序を誤ると前提違反や指摘の再浮上が起きることが
SKILL.md に長文の警告として書かれていた。v2 ではこの列全体が `ship` 1 回になる:

```
ship(commits, ref?, branch?, tip?, base?):
  前提: progress == running(k, finalize)
  progress → resting
  if commits >= 1:
    artifact が none → open を作る (ref が PR URL なら follow も新規作成)
    artifact が open → グループ欄 {ref, branch, tip, base} を更新 (follow は保持)
  if commits == 0:
    artifact は不変 (finish=none。ref 系フラグは 4 つとも省略必須 — 現行の 4 フラグ規則)
  asks.fix.taken   → ids を ledger.handled へ合流し、asks.fix → null   (現行 fix-done)
  asks.rebase.taken → asks.rebase → null                                (現行 rebase-done の削除側)
  asks.rebase が未消費で残っていれば resolve→false に降格 (quiet 化)     (下記)
  probe.sig → null (push で head が変わった。次の張りが catch-up 観測になる)
  session: ship 後の artifact が open で follow を持つなら保持 (追従が続く)、
           そうでなければ null (現行 --clear-session。判定は遷移後の artifact で行い、
           引数の ref ではない — commits 0 で open が残る再走でも追従は続く)
```

消費されるのは `taken` の ask だけである。未消費の rebase-ask が ship を生き延びる
場合は resolve を false に降格して quiet (ガード控え) にする — ship に至った push は
必ず現在の基点への載せ直しを経ている (executor は push 直前に載せ直す。衝突すれば
迂回に入っている) ので、push 前に控えられた解決要求 (queued) は ship 時点で用済みで
ある。降格せずに残すと `next` が解決サイクルを 1 周冗長に走らせる。ガードのデータ
(blocked_onto) は残すが実害は無い — 載せ直しの手順は必ず「既に載っているか」の
祖先判定をガード判定より先に行うので、stale な blocked_onto は同じ sha への再試行を
1 回抑止する以上の効果を持たない (v1 の rebase-record の残置と同じ性質)。

artifact が `withdrawn` のときの ship (withdraw で残置したタスクの復帰再走が finalize に
到達した場合) は none と同じ扱いで宣言する: 新しい open を作り (follow も新規)、
`asked` / `note` は捨てる — 旧 PR は閉じており、新しい PR は新しい追従対象である。

`ship` の応答 JSON には遷移から導出できる**後続指示**を含める:
`{"notify": "initial" | "update" | "none", "mark": true | false, "fix_count": n}`。
`notify` は「この ship で artifact が open を新規作成したか (initial)、既存の open の
tip が動いたか (update)、open が無いか (none)」の導出で、現行 SKILL.md が「最初の
1 回か更新か」を state に無い経路記憶で判別していた問題 (PushNotification の
使い分け) を消す。restore 後の再走 (open のままの ship) は v1 では「最初の 1 回」の
テンプレートだったが v2 では update になる — 同じ PR への押し直しなので update が
実態に合う (意図した挙動変更)。`mark` は **`run.kind == initial` のときだけ真**:
トラッカーは claim のたびに in_progress へ落ちるので、initial の engagement の終端では
artifact の遷移によらず (finish=none の none→none でも、restore 再走の open→open でも)
`mark <id> in_review` が要る。pr_fix / rebase_fix ではトラッカーは in_review のままなので
偽 — 現行 SKILL.md の「復帰では mark を呼び直さない」規則と一致する。迂回 (2.4 節) は
kind を変えないので、initial の finalize が衝突解消に寄り道してから ship しても
この導出は正しく真になる — mark の導出座標が内部モデルではなく**トラッカー側の状態
機械** (mark in_progress を打ったのは誰か) に対応していることが、この安定性の根拠で
ある。

kind による分岐がすべてデータの有無に吸収されている点が要である。迂回 (2.4 節) が
`initial` の finalize に挟まった場合 (最初の PR を出す直前の衝突) でも ship は
kind==initial のまま呼ばれ、artifact が none なので「open を作る」に落ちる。`pr_fix` の
押し直しに迂回が挟まった場合は asks.fix.taken が残っているので handled への合流も
行われる。現行 SKILL.md の「rebase_fix からの復帰の 3 分岐」(SKILL.md の 239-241 行
相当) は ship の中のデータ分岐として消える。

### 2.3 周回リセットの境界は `claim`

現行は「fix_attempts / handled のリセット境界」を watch-init の呼び分け (+
`--preserve-handled`) に置いていた (`docs/lessons/2026-08-06-cycle-reset-boundary-is-watch-init.md`)。
v2 ではリセット境界を `claim` に移す:

```
claim: queued → running(initial, full, 先頭 phase)
  follow が存在すれば: ledger.fix_attempts → 0、review_only → []、answered → []、
                        asks → 両方 null、probe.sig → null、attention → auto
  ledger.handled は保持する (PR の寿命全体の記憶)
```

attention を auto に戻すのは意図的である (manual のラッチも解除される):
queued へ来る唯一の経路 restore はトラッカー上の再掲というユーザーの明示操作を
契機にしており、「人が改めて機械に委ねた」とみなす — v1 の watch-init が
`state: watching` で初期化していたのと同じ判断である。

根拠: fix_attempts は「1 つの engagement が生む押し直し往復」の上限であり、新しい
engagement は定義から新しい周回である。claim と最初のレビュー待ちの間に fix サイクルは
存在しない (asks は resting でしか書けない — 不変条件 5) ので、claim でのリセットは
watch-init でのリセットと観測上等価で、しかも呼び分けが不要になる。これにより
watch-init という verb 自体が消え、「watch-init を呼ぶべき経路で呼び忘れる /
呼んではいけない経路で呼ぶ」という誤りの余地が消える。

現行の教訓が退けた「finalize の from を state に持たせる」案との関係は 6.4 節。

### 2.4 `rebase_fix` — 解決サイクルと迂回

衝突解消には 2 つの形があり、v2 ではこの 2 つが**異なるノード**になる:

- **解決サイクル (kind == rebase_fix)** — resting からの入口 (a)。背景の載せ直しが
  衝突し、`rebase-request --resolve` で `queued` に控えた要求を、`rebase-start` が
  消費して (taken=true) 専用の run を作る。この run の目的は衝突解消そのもので、
  push の義務は無い (PR は旧基点のまま生きている)。**失敗出口は `rebase-give-up`**:
  resting へ戻り、ask を quiet のガード控えに戻す (taken→false)。
- **迂回 (kind はそのまま、phase だけ rebase_fix へ)** — finalize からの入口 (b)。
  executor が push 直前の載せ直しで `REBASE-CONFLICT` 停止したとき、`rebase-start` が
  **同じ run の phase を finalize → rebase_fix に動かすだけ**で、kind・gate・asks には
  触れない。迂回中も「これは initial (または pr_fix) の engagement である」という来歴が
  kind に残り続けるので、ship の mark / notify 導出 (2.2 節) は割り込みに対して安定で
  ある。解けたら検証 PASS → `advance` で finalize へ戻る。**失敗出口は `rebase-forgo`**:
  phase を finalize へ戻し、旧基点のまま push させる (元の finalize が果たされておらず、
  push の義務が残っている)。衝突の控えとトリアージ結果はイテレーション内の持ち回り
  (現行どおり — state の権限境界の中に置く必要が無いデータである)。

どちらの形かの判別は **`run.kind` そのもの**が担う: give-up は kind==rebase_fix 専用、
forgo は kind≠rebase_fix 専用で、from 前提が排他的に分かれる。未消費の ask (quiet の
ガード控えや queued) が併存していても対は崩れない。kind==rebase_fix の finalize で
再衝突した場合も同じ迂回規則が適用され (phase が rebase_fix に戻るだけ)、出口は
give-up のままである。現行 SKILL.md では「この経路では rebase-give-up は呼べない
(conflict になる)」という禁止事項の散文だったものが、from 前提の異なる 2 verb になる。

初版の設計はここを「kind の切り替え + taken による入口判別」としていたが、独立検証が
「割り込みが kind を破壊的に上書きすると、割り込まれた engagement の来歴 (v2 の中心
主張) が消え、mark 導出と gate の不変条件が壊れる」ことを示した。迂回を kind では
なく phase の往復にすることで、来歴の座標を壊さずに同じ遷移を表現している。

### 2.5 現行 43 verb からの対応表

| 現行 | v2 | 変化 |
| --- | --- | --- |
| `init` `get` `validate` `session-touch` `sessions-alive` `history-append` | 同名 | 変更なし |
| `approve` | `approve` | 変更なし |
| `claim` | `claim` | 周回リセット (2.3) が加わる |
| `set-gate` | `set-gate` | 対象が run.gate になる (起動形は同じ) |
| `set-worktree` `set-executor` `touch-executor` `set-takeover` | 同名 | executor 系は対象が run 内フィールドになる |
| `phase-pass` | `advance` | 全 kind の列に一般化 |
| `finalize-start` | (廃止) | `advance` の最終辺に吸収。来歴は run.kind |
| `phase-fail` | `phase-fail` | 変更なし |
| `block` | `block` | watch の静止処理が消える (静止すべき状態を保存しないため不要) |
| `dequeue` | `dequeue` | 変更なし |
| `in-review` | `ship` | fix-done / rebase-done / sig リセット / session 処理を吸収した単一イベント (2.2) |
| `watch-init` | (廃止) | open 新規作成 (ship) と周回リセット (claim) に分解 |
| `watch-set` | `probe-run` / `probe-exit` / `observe` / `attention-set` / `release` | 多重化の解消。errors 上限の自動ラッチが observe に入り、`--session null` の 3 用途 (見送り・ループ停止・他セッション proc の無効化) は `release` が担う |
| `fix-pending` | `fix-request` | asks.fix を書く。前提が resting に絞られる |
| `fix-start` | `fix-start` | 上限ラッチが attention→human(fix_limit) になる |
| `fix-done` | (廃止) | `ship` に吸収 |
| `review-only` `answered-set` | 同名 | 対象が ledger になる |
| `rebase-record` | `rebase-request` | resolve-pending と統合 |
| `rebase-resolve-pending` | `rebase-request --resolve` | 同上 |
| `rebase-start` | `rebase-start` | 解決サイクル (kind=rebase_fix) と迂回 (phase のみ) に構造化 (2.4) |
| `rebase-done` | `rebase-applied` | run 無しの載せ直し成功専用に意味が絞られる (tip 更新側は ship が担う) |
| `rebase-give-up` | `rebase-give-up` | from が解決サイクル (kind=rebase_fix) 専用になる。迂回の失敗出口として対になる `rebase-forgo` を新設 |
| `recover-done` | `merged` | open→merged。watch 静止処理が消える |
| `withdraw` `withdraw-asked` `withdraw-remove` | 同名 | withdrawn が領域 A のノードになる |
| `candidates-set` `candidates-drop` `promoted-add` `promoted-drop` `relisted-add` `relisted-drop` `stalled-set` | 同名 | 変更なし |
| `restore` | `restore` | gate 復元処理が消える (gate は run の中にしか無い)。merged→none を加える |
| — | `next` | 新設 (5 節) |

## 3. データ — state.json v2

### 3.1 queue エントリの形

```json
{
  "id": "gh-42",
  "title": "…",
  "progress": "resting",
  "run": null,
  "blocked_reason": null,
  "artifact": {
    "state": "open",
    "ref": "https://github.com/o/r/pull/7",
    "branch": "task-pipeline/gh-42",
    "tip": "abc123…",
    "base": "main",
    "follow": {
      "attention": "auto",
      "asks": { "fix": null, "rebase": null },
      "ledger": { "handled": [], "fix_attempts": 1, "review_only": [], "answered": [] },
      "probe": { "proc": null, "proc_started_at": null, "sig": "…", "head": "…",
                 "ci": "passing", "checked_at": "…", "errors": 0, "note": null }
    }
  },
  "worktree": "/…/.claude/worktrees/task-pipeline/gh-42",
  "base": "main",
  "session": "…"
}
```

`running` のとき:

```json
{
  "progress": "running",
  "run": {
    "kind": "pr_fix",
    "gate": null,
    "phase": "finalize",
    "attempts": 0,
    "executor": "agent-…",
    "executor_last_event_at": "…",
    "takeover_at": null
  }
}
```

トップレベル (tracker / source / queue / candidates / relisted / promoted /
withdrawn_branches / history / stalled / stalled_since) は変更しない。
`schema_version` を 2 に上げる。

### 3.2 移行

既存の state.json は実質このリポジトリと数プロジェクト分しかなく、queue も小さい。
CLI に純関数 `migrateV1toV2` を置き、`init` が `schema_version == 1` を見たときに
一度だけ適用する (v1 の読み書き互換は持たない — 移行後は v2 のみ)。対応:

| v1 | v2 |
| --- | --- |
| `status: approved` | `progress: queued` |
| `status: in_progress` + `phase`/`gate`/`attempts`/`executor` 系 | `progress: running`, `run: {kind: phase から導出, gate, phase, attempts, executor…}` — phase が `pr_fix` なら kind=pr_fix、`rebase_fix` なら review.rebase が有れば kind=rebase_fix (解決サイクル)・無ければ kind=initial の迂回とみなす、`finalize` なら **kind は判別不能なので `initial` とみなす** (v1 に来歴が無いこと自体が今回の欠陥。移行時に rebase_fix / finalize 中のタスクが居る場合だけ人が確認する) |
| `status: in_review` | `progress: resting` |
| `status: done` | `progress: resting`, `artifact.state: merged` |
| `status: blocked` + `blocked_reason` | `progress: blocked` |
| `review: null` | `artifact: {state: "none"}` |
| `review.{ref,branch,tip,base}` | `artifact.{ref,branch,tip,base}` (state: open。`withdrawn: true` なら withdrawn、status done なら merged) |
| `review.watch.state: watching` | `follow.attention: "auto"` |
| `review.watch.state: stopped` | `attention: {"human": …}` — `fix_attempts > 3` なら `fix_limit`、`errors >= 3` なら `errors`、それ以外 `manual` |
| `watch.{proc,proc_started_at,sig,head,ci,checked_at,errors,note}` | `probe.*` |
| `watch.{handled,fix_attempts,review_only,answered}` | `ledger.*` |
| `watch.{fix_pending,pending_ids,findings}` | `fix_pending` が真なら `asks.fix: {ids: pending_ids, findings, taken: false}`、偽で pending_ids が非空なら破棄 (fix-done 相当が済んだ残骸) |
| `review.rebase` | `asks.rebase` (`resolve_pending` → `resolve`。kind=rebase_fix と判定した running のタスクだけ `taken: true`、それ以外は `taken: false`) |
| `review.withdrawn` / `withdrawn_asked` | `artifact.state: withdrawn`, `asked` |
| `id` / `title` / `worktree` / `base` / `session` / `blocked_reason` | 恒等 (blocked_reason は progress==blocked のときだけ非 null に正規化) |
| 非 in_progress の item の `gate` / `attempts` / `executor` / `executor_last_event_at` / `takeover_at` | 破棄 (v2 では run の中にしか存在しない。v1 でもこれらは in_progress 以外では読まれない残骸だった) |
| `status: done` または `withdrawn: true` の item の `review.watch` 一式 | 破棄 (merged / withdrawn は follow を持たない — 1.1 節)。probe / ledger / asks は写さない |

## 4. 検証 — 確認済み欠陥 12 件と拡張の検出

### 4.1 欠陥 12 件は v2 でどうなるか

PR #28 で解消された確認済み欠陥 12 件 (番号 1・6〜12 はリポジトリ内の「確認済み欠陥 N」
言及と PR #28 本文から確定。2〜5 の 4 件は番号の記録が無く、0e82211 の修正内容からの
差集合で同定した — 内容は issue #13 / #15 とコミット・回帰テストで裏が取れている)。
判定の凡例: **表現不能** = その壊れ方が v2 では状態として書けない / **構築時に落ちる** =
宣言・型・行列テストの層で検出される / **実行時チェック** = 前提違反 conflict として落ちる。

| # | 欠陥 (v1) | v2 での扱い |
| --- | --- | --- |
| 1 | phase-pass がフェーズ列を無視して任意の辺 (飛び越し・逆行・gate 違い) を通した | **構築時に落ちる** (現行の解を踏襲): `advance` の辺は run kind ごとの宣言列の隣接ペアからの導出のみ。表に無い辺は書けず、行列テストが網羅する |
| 2* | `in-review` が `review` を丸ごと置換し `review.watch` を破壊した (issue #13) | **表現不能**: `ship` はグループ欄 {ref, branch, tip, base} だけを書き、follow は別の子オブジェクト。「グループを新規リテラルで置く」書き込み形が存在しない。follow の新規作成は open が生まれる遷移 (none→open / withdrawn→open) だけで、既存の open では常に保持される |
| 3* | 復帰のたびに `fix_attempts` が 0 に戻り上限 3 が効かなかった (issue #15) | **表現不能**: リセットを行う verb (watch-init) 自体が無い。リセットは `claim` (queued→running) にだけあり、レビュー周回の途中で発火できない (2.3 節) |
| 4* | `block` が watch を `watching` のまま残した | **表現不能**: 「watching」という主張を保存しない。追従対象は `resting ∧ open ∧ attention=auto` の導出 (1.3 節) なので、blocked のタスクは定義から追従対象外。静止処理そのものが不要になる |
| 5* | 到達不能な (status, phase) の組を書き込めた | **構築時に落ちる** (現行の解を踏襲): `run ≠ null ⇔ progress == running` の不変条件と型付きノードコンストラクタ。座標に gate / kind が加わった分、v1 より守備範囲が広い |
| 6 | `watch-set` が status を見ず、飛行中タスクの `session` を null に落とせた | **実行時チェック + 構築時**: probe / observe / attention 系 verb の from 軸が `P == resting` に宣言され、行列テストが全 P ノードから網羅検査する |
| 7 | `recover-done` が watch を `watching` のまま残した | **表現不能**: 欠陥 4 と同根。merged に follow の子は無く、「watching のまま残る」状態が書けない |
| 8 | `restore` が前周回の watch (`watching` / proc) を持ち越した | **表現不能**: 同上。queued は追従対象の導出式を満たさず、probe.proc は restore が (不変条件 4 により) 外す。周回データのリセットは次の `claim` が行う |
| 9 | `fix-start` の上限がラッチしなかった | **構築時に落ちる**: ラッチが `attention → human(fix_limit)` という耐久状態になり、`fix-start` の from 軸 (`attention == auto`) が行列テストの座標に入る |
| 10 | 飛行中の `rebase-done` が通り `review.rebase` を消せた (give-up の前提が永久に壊れる) | **実行時チェック + 構築時**: `rebase-applied` の from が `P == resting` に宣言され、running 中に ask を消せる verb が無い。give-up の from は `running(rebase_fix, rebase_fix)` 専用なので、「消して詰む」順序自体が組めない |
| 11 | `rebase-start` が 2 入口の片方 (finalize から) で呼べず、phase-pass 転用で回避されていた | **構築時に落ちる**: 2 入口が from 宣言に載る (現行の解を踏襲)。さらに解決サイクルか迂回かが `run.kind` から事後にも判別できる (2.4 節。v1 では事後判別不能だった) |
| 12 | 衝突なく成功した背景載せ直しで `rebase-done` が呼べなかった (tip 更新経路が詰まる) | **表現不能**: 「1 つの verb が 2 つの形を兼ねる」緊張が分解される。run 経由の tip 更新は `ship`、run 無しの載せ直し成功は `rebase-applied` (rebase-ask は無くてもよいと宣言) |

(*: 番号未記録のため通し番号は推定。内容と証拠は確定している)

**別掲 — `(in_progress/research, gate: light)` の死にノード** (4620c1f。12 件とは別の、
堅牢化作業自身が入れた隣接制約による回帰): **表現不能**。gate は run の中にしか存在せず、
`claim` が毎回 `gate: full` で run を作るので、「前周回の gate が漏れて死に組に着地する」
経路が構造として無い。加えて 4.2 節の全ノード到達可能性テストが、この類の死に組を
人力レビュー頼みから機械検査に変える。

### 4.2 拡張したときにどこで落ちるか

- **フェーズを足す** (例: full の列に 1 フェーズ追加): 宣言 (`GATE_PHASE_SEQUENCES`
  相当) を 1 箇所直すと、行列テストの P 軸ノードが自動で増える。TypeScript 側は
  `Phase` union の網羅 switch (executor プロンプト組み立て・verdict パス組み立て) が
  型エラーになる。文書照合 (T-D 系) が契約のノード表とのずれで落ちる。
- **gate を足す**: `GATE_PHASE_SEQUENCES` にキーを足すと `Gate` union が広がり、
  run(initial) の座標が自動で増える。フィクスチャの網羅はスキーマ突き合わせの
  メタテスト (T-ALIGN-13 の型) が強制する。gate が座標に入っているため、v1 で起きた
  「gate 違いの死に組が行列を素通りする」経路は塞がっている。加えて **全ノード
  到達可能性テスト** を新設する: 宣言された辺グラフを初期ノード (queued × none)
  から辿り、(a) 各領域の宣言ノードすべてに到達できること、(b) 積の組で到達できない
  ものは「意図的な到達不能」として明示リストに載っていること (例: `resting ×
  fix-ask taken` — 仕上げ run の出口がすべて taken を消費・解除するため作れない)、
  を機械検査する。リストに無い到達不能ノードの出現 = 死に組の混入としてテストが
  落ちる (v1 の死に組は外部レビューが人力で見つけた — これを機械の網に変える)。
  行列テストの出力不変条件は逆向きの保証を担い、明示リストのノードをどの verb も
  出力しないことを検査する。
- **run kind を足す** (仕上げの種類を増やす): `RunKind` union の網羅 switch
  (`advance` の列参照・`ship` の分岐・`next` の導出) がすべて型エラーになる。
- **asks の種類を足す**: asks レコード型の網羅チェック (`next` の導出と ship の消費
  処理) が型エラーになる。
- **follow にフィールドを足す**: スキーマ→フィクスチャのメタテストがフィクスチャ追従を
  強制し、フレームテストの保護が自動で新フィールドに及ぶ (現行の仕組みを踏襲)。

### 4.3 テスト資産の引き継ぎ

行列テスト (T-MX)・フレームテスト (T-FRAME)・整合テスト (T-ALIGN)・文書照合 (T-D)・
権限テスト (T-P) の**枠組みはそのまま**で、座標が変わる: P 軸は 19 ノード、A 軸は
state×attention×fix-ask×rebase-ask のサブ軸。CLI をサブプロセス起動する state.test.ts の
安全網は verb 対応表 (2.5) に沿って書き直す。

## 5. 決定論 — `next` が導出するもの

### 5.1 導出できるもの

`next --session <id> --alive <ids> --now <t> [--config finish=…,max_open=…,…]` は
state.json (と state ディレクトリ内で CLI が読めるもの: `task_counts/` の行数) だけから、
タスクごとの「due なアクション」を返す:

- **担当判定**: session が自分/null/死んだセッションのタスクの列挙 (現行 SKILL.md
  手順 1 の除外規則)
- **追従の要否**: 1.3 節の導出式。probe リースの有効性 (proc null / 所有セッション死 /
  proc_started_at から 7 時間) → 「watch を張れ (sig が null なら catch-up から)」
- **サイクルの分岐**: asks.fix=pending → 「fix-start せよ (fix_attempts が 3 超なら
  上限ラッチになる)」、rebase-ask=queued → 「rebase-start せよ」— 現行 SKILL.md の
  修正サイクル手順 0 / 解決サイクル手順 0 の拾い直し判断。**両方が保留のときは
  rebase を先にする** (古い基点の上で指摘を直しても、載せ直しでその作業の検証前提が
  崩れる。現行 SKILL.md でも watcher の `rebase` verdict が `fix` に優先する)
- **停滞の帳簿**: stalled / stalled_since は現行どおり明示 verb (`stalled-set`) の対象
  だが、`next` は now を受け取るので「打ち切り (24 時間) に達しているか」「このイテレー
  ションで stalled-set に渡すべき値」も導出に含める
- **FINALIZED 後の処理**: run.kind と artifact の組から ship の引数構成が一意に決まり、
  通知 (初回/更新/なし) と mark の要否は ship の応答が返す (2.2 節)。v1 で state に
  残っていなかった経路情報のうち、finalize の来歴・rebase_fix の入口・通知の初回判別の
  3 つはこれで構造的に解ける。残る 2 つ — catch-up 観測をこの起動で済ませたか、error の
  出所 (観測サブエージェントか watch スクリプトか) — はイテレーション内で完結する
  文脈なので state に持たず、後者は `observe --sig-clear` の呼び分けとして verb 引数に
  現れる
- **実行の生存管理**: executor_last_event_at / takeover_at と now から、Status check /
  引き継ぎ / 何もしない、の分岐 (現行「飛行中の扱い」)
- **着手可否**: max_open (resting×open×follow の件数)・max_tasks (task_counts の行数)・
  併走の枠 (running の kind 別件数) の判定
- **観測の依頼**: resting×open×tip≠null のタスクの「マージ証明を git で確認せよ」、
  approved が無いときの「アダプタ list を呼べ」— CLI は git を触れないので、これらは
  アクションではなく**観測依頼**として返し、結果はイベント (verb) として戻る

### 5.2 導出できない入力 (外部から渡すもの)

- トラッカーの list 結果・タスク本文・gate 宣言 (アダプタ経由)
- 実行エージェントの停止通知の行 (`PHASE … DONE` / `BLOCKED` / `FINALIZED` /
  `REBASE-CONFLICT`) と送り元 agentId
- watch プロセスの終了行 (`changed` / `timeout` / `error`) と観測サブエージェントの
  verdict JSON
- git の観測 (マージ証明・rebase の成否・worktree 操作の成否・origin の sha)
- 人の判断 (承認・withdraw の外す/残す・attention の手動復帰)
- 時刻・自分のセッション id・生存セッション一覧・ツールの有無

これらは今もオーケストレータが観測して verb 引数で渡しており、v2 でも変わらない
(CLI の権限封じ込めは緩めない)。変わるのは、**観測後に「どの verb をどの順で呼ぶか」の
計算が SKILL.md の散文から `next` (と ship への一本化) に移る**ことである。SKILL.md に
残るのはサブエージェントの起動形・プロンプト・通知・git 操作の手順 — 判断ではなく
作業の記述になる。

### 5.3 issue への影響

- **#30 (往復プロトコルの骨格 + finalize 来歴の永続化)**: 来歴問題はこの設計で構造的に
  解ける (run.kind)。#30 の範囲は「v2 モデルの上に `next` を実装する」に書き直す。
- **#31 / #32 (段階的移譲の続き)**: v2 実装に吸収して書き直し。段階の刻み方は実装計画で。
- **#23 (gate を親状態パラメータへ)**: この設計そのもの。v2 実装で閉じる。
- **#24 (restore で rebase も静止)**: 不要になる。asks は resting でしか書けず、消費は
  resting からしか始まらないので、queued に戻ったタスクの stale な asks は発火しない
  (claim が改めてリセットする)。
- **#21 (ALPS プロファイル生成)**: 残る。対象が v2 の遷移表になる。
- **#26 (多段列のテスト)**: 残るが縮む。多段列の多く (fix-done → in-review → watch-set)
  が ship 1 verb になるため、テスト対象は「イベント列」ではなく「イベントの前提と効果」
  に寄る。
- **#25 / #18**: 独立。#18 (CI 再実行の裁量) は人待ちのまま。
- **#22 (Be Framework 再実装の隔離実験)**: 評価対象が v2 モデルになる。2 領域 +
  入れ子という形は Be の Input/Semantic 分離と相性の検証に向く。
- **#11 / #14 / #20 / #12 / #4 / #2**: 状態機械と独立。変更なし。

## 6. 却下した案

### 6.1 3 軸直積の継続改良 (現状維持 + ガード追加)

PR #28 の方向をさらに進め、軸間の制約を前提チェックに足し続ける案。退けた理由:
欠陥 12 件が軸をまたぐ verb とその隣に集中したという事実が、「またぐ」こと自体が
構造の誤りであることを示している。watch が in_review スコープでしか意味を持たない
以上、直交機械として宣言し続ける限り、スコープ外で生き残る watch (欠陥 7・8 の類) を
verb ごとの手当てで塞ぎ続けることになる。

### 6.2 watch を丸ごと揮発化する (state.json から追い出す)

probe が実質セッションローカルなら、state.json に持たず sessions/ 側のファイルに
置く案。退けた理由: sig / head / ci の観測キャッシュはセッションを跨いで意味を持つ
(死んだセッションの署名を次のセッションが使えば catch-up より安い — 現行の error
時の扱いが既にこれに依存している)。リース (proc) だけを追い出す案は、リースと
キャッシュの整合を 2 ファイルにまたがせるので、原子的書き込みの保証を失う。

### 6.3 blocked を領域 A 側にも波及させる (blocked で open を閉じる)

blocked のとき成果物側も「凍結」ノードへ移す案。退けた理由: 成果物の所在は事実で
あり、進行が止まっても PR は open のままである。凍結ノードを作ると「解除時に元の
ノードへ戻す」という復元の継ぎ目が生まれ、restore が watch を持ち越した欠陥と同型の
問題を再生産する。blocked ∧ open は表現可能とし、追従されないことは導出 (5 節) が
保証する。

### 6.4 来歴を state に持たせない (現行教訓の維持)

`docs/lessons/2026-08-06-cycle-reset-boundary-is-watch-init.md` は「finalize の from を
state に持たせる」案を「判別のための状態を足すと、その状態自身が新しい継ぎ目になる」
として退けた。この教訓は**平坦な符号化を前提にすれば正しい** — status/phase と別に
from フィールドを置けば、それは同期を要する影のデータになる。v2 の run.kind は影では
なく状態の座標そのものであり (kind 抜きの phase はもはや状態を識別しない)、行列テストの
軸として検査され、ship の分岐はデータの有無に吸収される。「同期が要る余分な状態」は
生まれていない。教訓の一般形 —「判別用の影データを足さない」— は v2 でも維持している
(finalize 割り込みの表現に interrupted マーカーを足さず、迂回では kind を書き換えない
— 来歴の座標を壊さない — ことで解いたのがその適用である。2.4 節)。

### 6.5 イベントソーシング (履歴を正にして状態を導出)

遷移イベントの追記ログを正とし、現在状態をリプレイで導出する案。退けた理由:
このパイプラインの状態は小さく、必要なのは「今どこか」の合意だけである。リプレイは
スキーマ進化のたびに全履歴の互換を要求し、CLI の権限封じ込め (読み書き先を state
ディレクトリに絞る) の中で得るものがない。history 配列 (人が読む監査ログ) は現行の
まま残す。
