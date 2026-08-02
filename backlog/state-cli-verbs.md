# state の遷移 verb 群を CLI に持たせ、不変条件を内側で守る

依存: state-cli-foundation

## 背景 / 現状

`state-cli-foundation` で lock・原子的書き込み・スキーマ検証の土台ができても、**遷移そのものがモデルの手作業のままでは、静かな破損の経路は閉じない**。`task-pipeline/SKILL.md` (679 行、2026-08-02 時点) が散文で規定している遷移と、それを守らせるための警告文は次のようなものである:

- 着手 (承認 → `in_progress`): `status` / `phase` / `attempts` / `session` を同時に書き、`runs/<id>/` を作る。gate 判定の結果で `phase` が `research` か `research+plan` に分かれる。
- 実行エージェントの記録: 「`executor` / `executor_last_event_at` / `session` の**3 つは必ず同時に書く**」(`session` の無い `executor` は他セッションから引き継ぎ可否を判定できない)。
- `executor_last_event_at` を動かしてよいのは 3 箇所だけ (起動時 / SendMessage 成功時 / 停止通知の処理時)。失敗した送信で動かすと、他セッションから死んだ executor が生きて見える。
- レビュー待ち化: コミットがあるときだけ `review.tip` を入れる。**コミットが 0 件のときに tip を入れると、`merge-base --is-ancestor` が真になって未コミットの作業ごと worktree が消される。**
- 修正サイクル: 「`pending_ids` を `handled` へ移す。**これを忘れると同じ指摘を毎回直しに行く。**」
- 載せ直し: 成功したら `review.tip` を更新する。「**更新を落とすと `merge-base --is-ancestor` が二度と真にならない。**」
- 停滞: `stalled` / `stalled_since` は毎イテレーション書き直し、停滞が続く間は `stalled_since` を進めない。PR が動いたときだけ現在時刻へ進める。

いずれも「忘れると壊れる」形で書かれており、**忘れたことは次のイテレーション以降に、静かに現れる**。オーケストレーターの記帳はこのパイプラインで唯一、検証ゲートの無い出力である。

## 要求

1. `state-cli-foundation` で作った `task-pipeline/scripts/state.ts` に、**SKILL.md が規定する state 更新点をすべて覆う verb 群**を実装する。着手前に SKILL.md を走査して更新点を列挙し、verb との対応表を成果物に残すこと (取りこぼしがないことを人が確認できるようにするため)。少なくとも次を含む:
   - タスク進行: `claim` (approved → in_progress) / `set-gate` / `set-worktree` / `set-executor` / `touch-executor` / `set-takeover` / `phase-pass` / `phase-fail` / `block` / `in-review` / `finalize-start`
   - 追従: `watch-init` / `watch-set` (proc / sig / head / ci / checked_at / errors / note / state) / `fix-pending` / `fix-start` / `fix-done` / `review-only`
   - 載せ直し: `rebase-record` (blocked_onto / reason / kind / cause / report) / `rebase-resolve-pending` / `rebase-done` / `rebase-give-up`
   - 回収と候補: `recover-done` / `withdraw` / `withdraw-asked` / `candidates-set` / `candidates-drop` / `promoted-add` / `promoted-drop` / `relisted-add` / `relisted-drop` / `restore` (relisted からの復帰)
   - 全体: `stalled-set` / `history-append`
2. **不変条件を verb の内側で強制する。** 呼び出し側が「同時に書く」「移し忘れない」を意識しなくてよい状態にする。最低限:
   - `executor` を書く verb は `executor_last_event_at` と `session` を必ず同時に書く (片方だけ書く API を提供しない)
   - `in-review` はコミット数を引数に取り、0 件のときは `tip` を受け付けず、1 件以上のときは `tip` を必須にする
   - `fix-done` は `pending_ids` を `handled` へ移し、`pending_ids` を空にし、`findings` を null にする操作を**分割不能に**行う
   - `rebase-done` は `review.tip` の更新を必須にする
   - `stalled-set` は、同じ状態が続くときに `stalled_since` を進めない (進めるのは明示的な引数があるときだけ)
3. **前提違反は state を変えずに失敗する。** 各 verb は現在の state に対する前提 (status / phase / 所有セッション) を検査し、満たさなければエラー終了する。とくに `claim` は、他セッションが既に着手しているタスクに対して失敗しなければならない。
4. 所有権の判定 (`session` が自分か / null か / 生存一覧に無いか) を CLI 側の関数として提供し、モデルが id を突き合わせる手作業をしなくてよいようにする。
5. 判断は CLI に持たせない。候補の順位付け、verdict の解釈、fix か報告か、コンフリクトの分類は引き続きモデルの仕事で、CLI は**その結果を書き留めるだけ**である。
6. 各 verb の意味・引数・前提・不変条件を一覧化したドキュメントを `task-pipeline/docs/` に置く (SKILL.md からはこれを参照する。実際の書き換えは `skill-state-cli-migration`)。

## 受け入れ条件

1. SKILL.md の state 更新点と verb の対応表が成果物にあり、**対応する verb の無い更新点が 0 件**であること (表に列挙された更新点それぞれについて、SKILL.md の該当箇所を指せる)。
2. `deno test` が全ケース PASS する。各 verb に、成功ケースと前提違反ケースが最低 1 つずつある。
3. **前提違反で state が変わらない**: 各 verb について、前提を満たさない state に対して実行すると exit≠0 になり、実行前後の `state.json` がバイト単位で一致する (`updated_at` も動かない)。
4. **二重着手が起きない**: 同じ `approved` タスクに対して 2 プロセスが同時に `claim` すると、成功は 1 つだけで、もう一方は前提違反のエラーになる。成功した側の `session` / `status` / `phase` / `attempts` が期待値になっている。
5. **3 点同時書き込み**: `set-executor` を実行すると `executor` / `executor_last_event_at` / `session` の 3 つが同時に入る。3 つのうち 1 つだけを書く経路が CLI に存在しない (verb 一覧とテストで示す)。
6. **tip の取り違えを弾く**: コミット 0 件で `in-review` に `tip` を渡すと失敗する。コミット 1 件以上で `tip` を省くと失敗する。どちらの場合も state は変わらない。
7. **`fix-done` の分割不能性**: `pending_ids` に 2 件ある状態で `fix-done` を実行すると、`handled` に 2 件が加わり `pending_ids` が空・`findings` が null になる。この 3 つのうち一部だけが適用された中間状態が観測される経路が無い (`fix-done` の途中で kill しても、state は実行前か実行後のどちらかである)。
8. **`rebase-done` が tip 更新を強制する**: `tip` を渡さずに `rebase-done` を実行すると失敗し、state は変わらない。
9. **`stalled_since` の進み方**: 同じ `stalled` 種別で `stalled-set` を続けて実行しても `stalled_since` は動かず、`--bump` (PR が動いたことを表す明示的な引数) を付けたときだけ現在時刻に進む。`stalled: null` にすると `stalled_since` も null に戻る。
10. **所有権判定**: 自分 / null / 生存一覧に無い id / 生存している他セッションの 4 パターンに対して、判定関数が SKILL.md の規定と同じ結論 (触ってよい / 触らない) を返すテストがある。
11. verb 一覧のドキュメントが `task-pipeline/docs/` にあり、実装との齟齬が無いことをテストが確かめている (ドキュメントに載っていない verb、または実装に無い verb があれば FAIL)。
