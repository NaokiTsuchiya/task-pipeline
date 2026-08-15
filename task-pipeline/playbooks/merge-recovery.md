**入る条件**: `next` が `observations` に `merge-proof` を、`actions` に `retire` / `rebase-start` / `release {defer: "rebase-start"}` を返したとき、観測サブエージェントが verdict `merged` / `rebase` を返したとき、実行エージェントが `REBASE-CONFLICT` で停止したとき。

## マージの回収 (レビュー待ち → Done)

タスクブランチにコミットを積んでレビュー待ちにしたタスク (`finish=commit` / `finish=pr`) は、ユーザーがマージしたかをローカル git 履歴だけで判定できる (gh・リモート不要、マージの手段も問わない)。**対象は `next` が `observations` に `merge-proof` を返したタスク** (`tip` / `base` / `branch` / `worktree` がその中に入っている。CLI は git を触れないので、これは依頼であって実行ではない)。毎イテレーションの最初と、`playbooks/depleted.md` の集計前に、それぞれについて**プロジェクト側**で (worktree ではない):

1. `git merge-base --is-ancestor <tip> <base>` が真 → マージ済み (通常マージ / ff)。
2. 偽なら `git cherry <base> <tip>` を実行し、出力の全行が `-` → 取り込み済み (squash / rebase)。
3. どちらでもない → まだレビュー中。何もしない。
`finish=pr` のタスクは、これに加えて PR 追従の watcher が `merged` を返すことでも証明できる (リモートでマージされ、ユーザーがまだ手元に取り込んでいない段階で拾える)。どちらの経路でも done の処理は同じ。
マージ済みと**証明できた**タスクだけ、アダプタで `mark <id> done`、`state.ts merged --id <id>` を呼ぶ (効果は `docs/state-cli-contract.md` の `merged` 節。merged は follow を持たないので、追従対象の導出式から自動的に外れる — 静止処理は要らない)、history に追記する。`probe.proc` が**自分の起動したもので**生きていればここで止める。判定できないもの (squash 時にパッチが変わった等) はレビュー待ちに残る (ユーザーが手で Done へ移す)。**証明なしに merged へ落とすことは決してしない。**
**owned workspace の後始末**: worktree を消す前に、そのタスクの `.task-pipeline/runs/<id>/paseo-workspace.json` を読み、`owned: true` かつ未 archive (`archived_at` が null) のエントリがあれば `paseo workspace archive <workspace_id>` (`playbooks/agent-launch.md` の「所有 workspace の記録と安全な後始末」節の安全規則どおり、記録された exact な id だけを対象にする — `cwd` 一致では判定しない) を呼んでから `archived_at` を埋める。ファイルが無い/エントリが無い (Paseo 経路を使わなかったタスク) なら何もしない。
`merged` にしたタスクに `worktree` があれば、ここで片付ける (作業はマージ済みなので失うものが無い唯一の地点): `git -C <プロジェクトルート> worktree remove <worktree パス>` → `git -C <プロジェクトルート> branch -d task-pipeline/<id>`。**強制削除 (`--force`) はしない。**

**片付けが成功したら、最後に `state.ts retire --id <id>` を呼んで queue から外す** (効果は `docs/state-cli-contract.md` の `retire` 節。控えの保持期間の閾値もそちらにある)。**この後始末は `next` が action `retire` として返す** — `cleanup` に片付けるべき worktree とブランチが入り、**`release_first` が真なら先に `state.ts release --id <id>` を呼ぶ** (揮発資源が残ったままだと `retire` の前提 [`resting × merged` かつ `session` が null] を満たさず `conflict` になる)。**削除に失敗したら (未コミット変更が残っている等) `retire` は呼ばず `resting × merged` のまま残し**、パスを添えて報告する — 次のイテレーションで「片付けてから retire」を改めて行えばよい (片付けは冪等)。queue に残るのは未完了の作業だけになるので、承認手順 1 の除外計算も走査も未完了分だけを見ればよくなる。
**回収したときの後処理一式**とは、ここまでの回収処理 (`merged` → worktree 片付け → `retire`) に、**下の 4 つの節 — 「マージで解けた依存の昇格」「マージ後にプロジェクト側を origin へ追いつかせる」「残った PR を新しい基点へ載せ直す」「タスクメトリクスの収集」— を加えた全体**を指す。**どの経路から回収しても** (ローカル履歴による判定、PR 追従の `merged`、`playbooks/depleted.md` からの回収) この一式を最後まで行う (前半だけで止めると走れるタスクを見落としたり、次のタスクが古い木から始まったりする)。**最初の 3 つの節はこの順に行う** — 載せ直しは `origin` に追いついた後の `origin/<base>` を基点にするため。**「タスクメトリクスの収集」はこの 3 節と独立でベストエフォートなので、順序は問わない** (失敗しても他の節に影響しない)。

### マージで解けた依存の昇格

回収したら、**そのマージで依存が解けたタスクがあるかを見る** (マージした瞬間がそれを確定できる唯一の地点。放っておくと、走れるタスクがあるのに「候補が尽きた」と判断してループを止めることになる)。

- **判定と操作は task-prep の規則をそのまま使う。** ロジックをこちらへ書き写さない — 依存の表現も昇格の手順もトラッカーごとに違い、2 箇所に分けると片方だけ直る。サブエージェント (general-purpose、同期) を 1 体起動し、**task-prep の 2 ファイルのパスを渡して従わせる** (指示本文をプロンプトに書き写さない。起動パラメータと経路の正は `playbooks/agent-launch.md` の `依存昇格` の行)。プロンプトはこの形のみ:
  ```
  You are a dependency promotion subagent.
  Read ~/.claude/skills/task-prep/SKILL.md (the 「依存」 section) and
  ~/.claude/skills/task-prep/references/trackers/<tracker>.md and follow them.
  operation: 昇格スキャンのみ (分解・深掘り・棚卸しはしない)
  source: <source> / state dir: <プロジェクトルートの .task-pipeline 絶対パス>
  A relative source resolves against the parent directory of the state dir.
  why: <この操作に至った経緯を 1 行、事実だけ>
  Write nothing except the promotion itself, as the tracker file specifies
  (gh: the pending-deps -> ready label swap; markdown: appending "- [ ] <id>"
  lines to the backlog list file). Do not create, close, edit, delete, or
  reorder anything else.
  Return only JSON: {"promoted": [{"id": "...", "title": "..."}], "note": "<1 行。無ければ空>"}
  ```
- **`source` と state dir は必ず渡す** (昇格の対象を特定できるのはこれだけ。markdown は既定値が無く必須、gh は既定 origin があるが別リポジトリを回しているときは必須)。
- **書き込みを許すのは昇格そのものだけ**: gh は `pending-deps` → `ready` のラベル入れ替え (`gate-light`/`priority-*` を保った集合を渡す)、markdown はバックログのリストファイルへの `- [ ] <id>` 行の追加のみ (他の書き込みはしない)。
- **昇格に承認は要らない** (task-pipeline に 1 件ずつのゲートが既にある) が、**昇格は機械判定である** (`依存:`/`未確定:` 行だけを見る)。返った `promoted` の id を `state.ts promoted-add --ids <カンマ区切り>` で積み、SKILL.md の「承認」で着手するときに 1 行報告する。返った `note` があれば報告に添える。
- 上げた分は history に残す。トラッカーが依存を表現しない場合や task-prep が入っていない場合は**この手順ごと飛ばす**。

### マージ後にプロジェクト側を origin へ追いつかせる

回収したら、続けて**プロジェクト側のブランチを `origin` に追いつかせる**。次のタスクの worktree はプロジェクトルートの `HEAD` から切られるので、同期しないと**直前にマージした成果を含まない古い木から次のタスクが始まる** (実測: RayDiContext でマージ未反映の main から切りかけたことが複数回あった)。`git -C <プロジェクトルート> fetch origin` → `git -C <プロジェクトルート> merge --ff-only origin/<プロジェクト側のブランチ>`。

- **fast-forward だけ行う。** 失敗したら**何もせず**、理由を history に残して報告する。`--force`/`rebase`/`pull` もしない (**ユーザーのコミットと作業ツリーを書き換える権利はパイプラインに無い**)。
- プロジェクト側の現在のブランチが、いま回収したタスクの `base` と違うとき (ユーザーが切り替えた) は**触らない**。
- 同期できなくても回収は成立している (この同期はマージ回収の前提ではない)。次のタスクが古い基点から始まることになるので、その旨を worktree 作成時に history へ残す。remote が無いリポジトリでは `fetch` が失敗するだけで、回収はローカル履歴のみで動く。

### 残った PR を新しい基点へ載せ直す (rebase)

`origin` に追いついたら、続けて**まだレビュー待ちの自分の PR を新しい `origin/<base>` に載せ直す** (`rebase=off` ならこの節ごと飛ばす)。マージした瞬間に残っている open PR の基点は 1 つ古くなり、レビューの差分がずれて CI が古い基点でしか通らなくなりうる。これは PR の履歴を書き換える (force push する) 操作なので、**パイプラインが作った `task-pipeline/<id>` ブランチにだけ**行い、ガードを 1 つでも落としたら**触らずに記録して報告する** (`--continue`/`--force` は使わない)。**この節へは 2 つの経路から入る**: ここで説明する「回収時の後処理一式」として queue 全体を走査する経路と、`playbooks/pr-follow.md` の「観測」節が verdict `rebase` を受けたときにタスク 1 件に限って入る経路。どちらも以下の対象条件・手順 1〜5 は同じ 1 つの手順であり、複製はしない。
対象は、queue の **`resting`** タスクのうち次をすべて満たすもの (他セッション所有のタスクは除外済み。`running` で仕上げを回しているタスクも対象外 — 足元の履歴を書き換えると成果が壊れる):

- `artifact.state` が `open` で `ref` が PR URL、かつ **追従対象の導出式を満たす** (`attention: auto` — `human(...)` のものは触らない、既に人の手に渡っている)
- `worktree` が非 null
- `asks.rebase.blocked_onto` が現在の `origin/<base>` の sha (`git -C <プロジェクトルート> rev-parse origin/<base>`) と一致しない (同じ基点で前回落ちたものを試し直さない)
`<base>` はそのタスクの `artifact.base`。`origin/<base>` が無ければ何もしない。判定はプロジェクトルート、実行は worktree で行う (ブランチはそこにチェックアウトされているので、ルートからは rebase できない):

1. `git -C <プロジェクトルート> merge-base --is-ancestor origin/<base> task-pipeline/<id>` が真 → **既に載っている**。何もしない (通常はここで終わる)。
2. 次の 3 つを確かめ、1 つでも崩れていたら**触らない**: `state.ts rebase-request --id <id> --blocked-onto <現在の origin/<base> の sha> --reason <dirty|diverged>` を呼び、1 行報告する — `git -C <worktree> status --porcelain` が空か (あれば `dirty`)、`git -C <worktree> rev-parse --abbrev-ref HEAD` が `task-pipeline/<id>` か (違えば `dirty`)、`git -C <プロジェクトルート> rev-parse task-pipeline/<id>` と `origin/task-pipeline/<id>` が一致するか (違えば `diverged` — 誰かが直接 push したか、こちらの push がまだ済んでいない)。
3. 旧 tip を控えてから `git -C <worktree> rebase origin/<base>` (タイムアウト 120 秒。署名エージェントが認可切れで止まりうるため)。失敗は `git -C <worktree> rebase --abort` で戻し、2 と同じ `rebase-request` の呼び出しと報告で終わる。**コンフリクトのときだけ下記のトリアージを行う** (`--reason conflict`)。**解消は決してしない**。
4. `git -C <worktree> push --force-with-lease=task-pipeline/<id>:<旧 tip> origin task-pipeline/<id>` (lease は控えた旧 tip で明示 — 直前の `fetch` で remote-tracking 基準の保護は無効)。失敗したら `git -C <worktree> reset --hard <旧 tip>` で取り消してから `state.ts rebase-request --id <id> --blocked-onto <現在の origin/<base> の sha> --reason push` を呼んで記録と報告をする。
5. 成功したら `state.ts rebase-applied --id <id> --tip <新しい tip>` を呼び (`artifact.tip` を更新し、`asks.rebase` を消し、`probe.sig` を null にする、を単一の書き込みで行う。衝突なく一発で載った最頻パスには `rebase-request` の控えが無いが、その場合も呼ぶ — **マージの回収はこの tip を見る**。この verb は run を持たない載せ直し専用で、run 経由の tip 更新は `ship` が担う)、自分が起動した観測プロセスを止める (head が変わるので古い署名は `rebase-applied` が落としている。張り直しは次イテレーション)。`ledger.fix_attempts` には数えない。history に旧 tip → 新 tip と基点の sha を残し、1 行報告する。

- **`finish=commit` のタスクは対象外** (PR が無い)。**1 回のマージで対象が複数あれば全部処理する** (独立、1 本落ちても他は続ける)。
- **同じ載せ直しを、executor も push の直前に行う** (executor.md の finalize)。ここが拾うのは既に出た PR の基点が後から古くなった場合、あちらは押し直す瞬間に既に古い場合 — `pr_fix` 中のマージは worktree 作業中なのでこの節の対象外にし、push 直前の確認が受け止める。
- **衝突なく載せ直せた木は誰も検証していない。** 壊れていれば CI が落ち、通常の追従が `pr_fix` で直す。**衝突したときだけ**、解消は人の判断に近い変更なのでこの手順書の「解決サイクル」で検証ゲートを通す。
- **この経路 (素の force push による載せ直し) ではユーザーへの通知は送らない** — diff の意図は変わらず (基点が動くだけで、差分の内容自体はレビュー済みのものと同じ)、1 回のマージで複数の PR を載せ直すと、レビュアーが見直すべき内容が増えていないのに開いている PR の本数だけ通知が鳴ることになる。指摘や衝突への対応で内容そのものが変わる `pr_fix` / `rebase_fix` の更新時通知 (SKILL.md の「更新時の通知」) とはここが異なる。

#### コンフリクトのトリアージ

載せ直しがコンフリクトしたら、控えを取ってから読み取り専用のサブエージェントに任せる (**「コンフリクトした」とだけ報告して終わらない** — オーケストレーターは衝突の中身を読めないため):

1. **abort する前に控える**: `git -C <worktree> diff --diff-filter=U` の出力を `<runs/<id>>/rebase/conflict-<UTC 時刻>.diff` へ、`git -C <worktree> diff --name-only --diff-filter=U` の一覧、旧 tip と `origin/<base>` の sha (**控えた中身は読まない**)。
2. `git -C <worktree> rebase --abort` で戻す (衝突を残したままトリアージしない)。
3. read-only のトリアージサブエージェント (general-purpose、同期) を 1 体起動する (起動パラメータと経路の正は `playbooks/agent-launch.md` の `衝突トリアージ` の行)。プロンプトはこの形のみ:
   ```
   You are a read-only rebase conflict triage subagent.
   Do not modify the repository, the branch, the tracker, or any file except the report below.
   conflict capture: <.diff の絶対パス> / repo: <プロジェクトルートの絶対パス>
   branch: task-pipeline/<id> (tip <旧 tip>) / onto: origin/<base> (<sha>)
   task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス>
   Inspect both sides with read-only git (log / diff / show) and say what actually collides.
   Write a short report to <run dir>/rebase/conflict-<同じ時刻>.md.
   Return only JSON: {"kind": "superseded|overlap|adjacent|structural|other",
    "files": ["..."], "cause": "<日本語 60 字以内>", "next": "<推奨する解き方を日本語 60 字以内>",
    "report": "<書いたレポートの絶対パス>"}
   ```
   - `kind`: `superseded` = 相手側が同じ変更を既に含む / `overlap` = 同じ箇所を別意図で変更 / `adjacent` = 近接行の機械的衝突 / `structural` = ファイル移動・削除と編集の衝突 / `other`。**書き込みを許すのはレポート 1 本だけ** (解き方を書かせるが解かせない)。
4. 返った JSON を `state.ts rebase-request --id <id> --blocked-onto <現在の origin/<base> の sha> --reason conflict --kind <kind> --cause <cause> --report <report>` で `asks.rebase` に控え、**報告は 1〜2 行**にする (`<id>: origin/<base> へ載せ直せず (overlap: 同じ関数を両側が変更)。次: <next> — <report のパス>`)。
5. `kind` で分岐: **`superseded`** → 解決しない。その PR がもう不要かもしれないことを報告に明示して終える (パイプラインは PR を閉じない)。**それ以外** → `state.ts rebase-request --id <id> --blocked-onto <同じ sha> --reason conflict --resolve true --from-tip <旧 tip>` を呼んでこの手順書の「解決サイクル」へ (同じ verb の upsert で、`--resolve true` が「解決サイクル行き」の宣言。省略したフラグは手順 4 で書いた値をそのまま保つ)。

**手順 4・5 は `resting` のタスク (この節を上から通ってきた載せ直し) 専用である。** `REBASE-CONFLICT` の停止通知から手順 3 だけを行った場合 (タスクは `running` の finalize)、`rebase-request` の前提は `progress==resting` なので **必ず `conflict` で失敗する** — `pr_fix` の押し直し直前で `artifact` が既に open でも、`progress` が `resting` でないため同じく失敗する。この場合は控える先 (`asks.rebase`) 自体に書けないので state には何も書かず、返った JSON と控え・レポートのパスを**そのイテレーション内で持ち回り**、報告 1〜2 行を出したうえでこの手順書の「解決サイクル」の**「finalize から入る経路」**へ入る (`kind` が `superseded` でも実行エージェントは停止したまま残るので、そこの諦め方と同じく **finalize を `rebase: off` 付きで送り直し**、この変更はもう不要かもしれないことを報告に明示する)。

#### 解決サイクル (rebase_fix)

衝突の解消もパイプラインがやるが、コードの変更なので他のフェーズと同じ扱い — **実行エージェントが解き、フレッシュな検証ゲートが通してからでなければ push しない** (オーケストレーターが自分で解くことはしない。相手側の変更を黙って捨てても差分上は「解決済み」に見えるため、検証は必須)。対象は `asks.rebase` が **queued** (`resolve` が真でまだ消費されていない) のタスクで、毎イテレーションの追従処理で拾う (`playbooks/pr-follow.md` の修正サイクルと同じ位置)。
**finalize から入る経路** (executor が `REBASE-CONFLICT` で停止した場合 — 最初の PR を出す直前、または `pr_fix` の押し直し直前に衝突): **そのイテレーション内でそのまま手順 1 に入る**。rebase は executor が既に abort 済みなので `asks.rebase` の控えは使わない。手順 0 は行わず (このタスクは既に飛行中で、預けられる要求も無い)、手順 1〜4 は同じである — `rebase-start` は **resting からの解決サイクル (入口 a) と finalize からの迂回 (入口 b) の両方を入口として受ける** (契約の遷移表)。**迂回では `run.kind` は変わらず `phase` だけが `rebase_fix` に動く** — 割り込まれた engagement の来歴が保たれるので、解消後の `ship` の `mark`/`notify` の導出は正しいままである。

- **この経路では `rebase-request` は呼べない** (前提が `progress==resting`)。衝突の控えとトリアージレポートのパスは state に置かず、そのイテレーション内で持ち回って手順 2 の送信に載せる。
- **諦めるときは `state.ts rebase-forgo --id <id> --blocked-onto <現在の origin/<base> の sha>` を呼ぶ** (迂回専用の失敗出口。`run.phase` を `finalize` に戻し、`asks.rebase` にガードの控えを upsert する)。そのうえで finalize を `rebase: off` 付きで送り直し、古い基点のまま PR を出させる (押し直させる) — 元の finalize が果たされておらず、push の義務が残っているためである。**この送り直しだけは `finalize.rebase_off` によらず必ず `rebase: off` を付ける** — 今この 1 回だけ載せ直しを切るという実行イベント直後の判断であって、`rebase` 設定でも state の控えでもないからである (`asks.rebase` の控えは `--reason dirty|diverged|push` でも同じ形で残るので、控えの有無からは判別できない)。
- 解消できて `finalize` → `FINALIZED` まで進んだときのレビュー待ち処理も**通常どおり `ship` 1 回**である (どの経路から来ても呼ぶ verb は同じ)。

0. **`next` がこのタスクに `release {reason: "finishing-busy", defer: "rebase-start"}` を返したなら始めない** (`playbooks/pr-follow.md` の修正サイクル手順 0 と同じ — 仕上げの枠が既に埋まっている)。`asks.rebase` を queued のまま置き、`state.ts release --id <id>` を呼んで次のイテレーションで `next` の返す action から拾い直す (**finalize から入る経路ではこの手順を行わない** — 上記)。
1. `next` が `rebase-start` の action を返していれば (`blocked_onto` / `from_tip` がその控えの値)、`state.ts rebase-start --id <id> --session <自分の id>` を呼ぶ (効果は `docs/state-cli-contract.md` の `rebase-start` 節。入口 a [resting から] と入口 b [finalize からの迂回] で効果が異なる — 応答の `kind` を見ればどちらの入口だったかが事後にも分かる)。**トラッカーへの `mark` はしない。この着手は飛行中の上限の対象外**。
2. 実行エージェントへ送る (**手段は起こした経路で決まる** — `playbooks/agent-launch.md`):「Rebase conflict. Rebase the branch onto `origin/<base>` and resolve the conflicts as phase "rebase_fix". conflict capture: `<.diff の絶対パス>` / triage: `<report の絶対パス>`.」送信できなければ、SKILL.md「タスク実行」の手順 3 と同じ形で新しい実行エージェントを起動し、Begin 行を「Begin with phase "rebase_fix". Rebase onto `origin/<base>`. conflict capture: `<パス>` / triage: `<パス>`.」に変える (**rebase 自体を実行エージェントにやらせる** — 検証を通っていない変更が finalize に混ざらないように)。
3. `PHASE rebase_fix DONE` の停止通知 → フレッシュな検証ゲート (phase: `rebase_fix`。判定 JSON のパスは他のフェーズと同じく `state.ts verdict-path` が返す) → PASS なら通常どおり `advance --from rebase_fix --to finalize` → `FINALIZED` でレビュー待ち処理 (`ship`) へ戻る。
4. **`REBASE-CONFLICT — <パス>` で停止したら解消できなかったということ**。下の「諦め方」へ。FAIL は同じリトライ上限 (3 回)、**使い切っても blocked にしない** — 同じく「諦め方」へ。
**諦め方** (解決サイクル [`run.kind == rebase_fix`] 専用。**迂回では上記のとおり `rebase-forgo` を使う** — 2 つの出口は `run.kind` で排他に分かれており、取り違えれば `conflict` で弾かれる): `git -C <worktree> rebase --abort` (途中なら) の後 `git -C <worktree> reset --hard <asks.rebase.from_tip>` で載せ直しを取り消し、`state.ts rebase-give-up --id <id> --blocked-onto <現在の origin/<base> の sha>` を呼んで `resting` に戻し (`asks.rebase` は quiet のガード控えに戻る — `taken→false`, `resolve→false`, `reason→conflict`, `blocked_onto` を更新。`kind`/`cause`/`report`/`from_tip` は既存値のまま)、トリアージのレポートのパスを添えて報告する。**ここは SKILL.md の「リトライ上限」の唯一の例外である** — PR は古い基点のまま生きていてレビューできる状態は失われていない。

### タスクメトリクスの収集

回収したら、依存の昇格・origin 追いつき・PR 載せ直しと合わせて、**タスク単位メトリクスの収集を 1 回呼ぶ**: `python3 <リポジトリ>/task-pipeline/docs/scripts/collect-task-metrics.py --scan <プロジェクトルート> --no-diff-stats` 相当を 1 回 (`--out` を省略すれば既定の `~/.claude/task-pipeline/metrics.jsonl` に追記される)。増分・冪等なスクリプトなので、回収のたびに無条件で呼んでよい。

- **ベストエフォートである。収集は成果物ではない**: `python3` が無い、スクリプトが `<リポジトリ>/task-pipeline/docs/scripts/collect-task-metrics.py` に存在しない、実行が失敗する (非ゼロ終了) のいずれでも、**history に 1 行 (例: `metrics 収集スキップ: <理由>`) 残すだけで続行し、パイプラインを止めない** (state は変更しない、報告にも長く書かない)。
- **`--no-diff-stats` を既定にする** — 後処理の中で `gh pr view` / `git show` の追加コストを避けるため。
- 収集対象はプロジェクトルート単位であり、個々のタスクの `finish` モードを問わず 1 回呼べばよい (`--scan` が `~/.claude/projects/` 配下の該当セッション transcript を横断的に拾うため)。
- **続けて、レトロ観測のトリガー3 (done 10 件ごと。`playbooks/retro-launch.md`) を判定する** — `metrics.jsonl` はこの収集呼び出しでしか増えないので、ここが実質的な「done 回収のたび」の判定タイミングになる。
