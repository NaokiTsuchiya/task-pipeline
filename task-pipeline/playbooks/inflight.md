**入る条件**: `next` が非除外の `running` タスクに `wait` / `status-check` / `set-takeover` / `clear-takeover` / `takeover` の action を返したとき (SKILL.md「毎イテレーションの手順」1)。

## 飛行中の扱い (`running` のタスクがあるとき)

wakeup がタスクの飛行中に来るのは正常である (フォールバック、または固定間隔 cron)。仕事は停止通知が運んでくるので、原則することは無い。

**何をするかは `next` が返す** — 沈黙の判定も、引き継ぎ待ちの計時も、引き取ってよいかの枠の判定も、すべて `tasks[].actions` に畳まれている (判定式と閾値はこの節に書かない。一覧は `docs/state-cli-contract.md` の `next` 節)。ここに残るのは **action ごとに何をするか** だけである:

- **`wait`** → 何もしない。/loop dynamic 配下ならフォールバック (1800 秒) を予約し直してターンを終える。固定間隔 cron 配下なら何も予約せず終える。`reason` は `executor-alive` (実行エージェントは稼働中とみなす) / `takeover-pending` (引き継ぎ待ちの計時が続いている) / `own-slot-busy` (自分の枠が埋まっているので引き取りを次のイテレーションに回す)。
- **`status-check`** → 実行エージェントに SendMessage で「Status check: finish your current phase per protocol and stop with your protocol line. Do not advance phases without an explicit verified-PASS message.」を送る。
  - 送信が成功した → `state.ts touch-executor --id <id>` を呼んで `run.executor_last_event_at` を現在時刻に更新する (ping の繰り返しを防ぐ)。その後の停止通知が通常どおり検証ゲートを駆動する。
  - 送信がエラーになった → **`touch-executor` は呼ばず、即座に再起動もしない。** agentId はセッション内でしか有効でないため、送信エラーは executor が死んだことの証明にならない — 別セッションが起動した executor が生きている可能性がある。`state.ts set-takeover --id <id> --at <現在時刻>` を呼んでこのイテレーションを終える (次の判定は `next` が行う)。
- **`set-takeover`** (`reason: "owner-dead-silent"`) → 所有セッションが失効しているので SendMessage は**試さずに失敗と同じ扱いにする** (他セッションの agentId には届かない)。`state.ts set-takeover --id <id> --at <現在時刻>` を呼んでこのイテレーションを終える。**沈黙の判定を飛ばして即引き取ることはしない** — 生存一覧から落ちていることは死んだ証明にならないためで、実行エージェント自身が作業の区切りごとに `sessions/<id>` を touch する以上、**動いている限り所有セッションは生存一覧に残る** (二重起動を最後に食い止めているのはこの heartbeat)。
- **`clear-takeover`** → 引き継ぎ待ちの間に所有セッションが生きて処理した。`state.ts set-takeover --id <id> --clear true` を呼んで手を引く (Status check の再送も `takeover_at` の再記録もしない)。
- **`takeover`** → 新しい実行エージェントを立てる。`state.ts set-takeover --id <id> --clear true` (`takeover_at` が立っていれば) の後、タスク実行の手順 3 の形式で起動し、`state.ts set-executor --id <id> --executor <agentId> --session <自分の id>` で `executor` / `executor_last_event_at` / `session` を自分のものに書き換える。action のフィールドがそのまま起動の材料になる:
  - **`needs_worktree` が真なら、先にタスク実行の手順 2 (worktree 作成) をやり直す。** `running` にしてから worktree を作るまでの間にセッションが落ちるとこの状態が残る — 気づかずに起動すると、target project がプロジェクトルート (ユーザーの作業ツリー) になってしまう。
  - **`recheck_gate` が真で、run dir に成果物が 1 つも無ければ**、タスク実行の手順 1 の gate 判定をやり直す (gate 判定とその反映の間でセッションが死ぬと、宣言のあるタスクが full のまま固まるため。判定はマーカー行の機械照合なので、何度やっても同じ結果になる)。
  - Begin 行は「Resume from phase "`<resume_phase>`". Check existing artifacts in the run dir first.」に変える (`resume_phase` が `pr_fix` のときは対応する findings ファイルのパスを、`rebase_fix` のときは衝突の控えとトリアージレポートのパスと `onto: origin/<base>` を、`finalize` のときは `finish mode: <mode>, base: <タスクの base>` を添える — finalize の再開でも base が渡らないと PR が既定ブランチに向く)。
  - `reason` は `takeover-elapsed` (引き継ぎ待ちが満了した) / `no-executor` (**走っている実行エージェントが存在しない** — 起動前にセッションが死んだか、自分で起動し忘れた。待っても新しい情報は増えないのでその場で立てる)。
- **1 セッション 1 タスクの枠は `next` が守る**: 自分が既に同じ種類の run (新しいタスク / 仕上げ) を持っているときの引き取りは `takeover` ではなく `wait {reason: "own-slot-busy"}` になる。新しいタスクと仕上げは互いの枠を塞がない (SKILL.md の「併走の枠」)。
- **生きている他セッションが所有する `running` タスクは `excluded` が真**で、`actions` は空である (判断対象に入らない)。自分の飛行中タスクが他に無ければ、`start` の判定に従って `queued` / 承認へ進んでよい。
