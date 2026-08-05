# max_tasks=N で揮発資源ゼロの地点にループを止め、人がコンテキストをクリアして再開できるようにする

## 背景 / 現状

行番号は commit 0498660 時点。ずれていたら引用文言で grep すること。

オーケストレータのコンテキストは長い `/loop` で単調増加する (実測: 8 タスクで 139,957 → 371,892 トークン、+29k/タスク、自動コンパクションは一度も発生せず)。**モデルは自分のコンテキストをクリアできない** — `/clear` も `/compact` もユーザーが打つコマンドで、モデルから呼べるツールは存在しない。`ScheduleWakeup` も `CronCreate` も同一セッションの継続なので、どちらもコンテキストをリセットしない。したがって「定期的にクリアする」を自動化する経路は無く、**人が `/clear` して再開する**のが唯一の手段である。

問題は、現状その再開が**安全な地点で行える保証が無い**ことである。ループが止まるのは枯渇時 (`task-pipeline/SKILL.md` 「枯渇時フロー」手順 2) と停滞 24 時間の打ち切りだけで、それ以外の任意の時点で人がセッションを切ると、走行中の executor が道連れになる。SKILL.md がその代償を明記している:

- `task-pipeline/SKILL.md:89`「**実行エージェントの agentId も watch のバックグラウンドプロセスも、それを起動したセッションの中でしか有効でない**」
- 引き取りまでの遅延: `executor_last_event_at` から 90 分の沈黙判定 (`task-pipeline/SKILL.md:262`) + `takeover_at` から 30 分 (同 `:257`) で最悪約 2 時間。加えてフェーズ途中の未書き出し作業は失われる

一方、**揮発資源がゼロになる地点は既に存在する**。`finish=commit` / `finish=none` では watch プロセスが一度も生成されない (`task-pipeline/SKILL.md:218` — `watch-init` を呼ぶのは `ref` が PR URL のときだけ) ため、揮発資源は executor だけであり、タスクが in_review / blocked / done になった時点で `session` は null に戻る (同 `:218` の `--clear-session true`、`:202` の block、`:337` の `recover-done`)。つまり**あるタスクを終えて次のタスクで `set-executor` を呼ぶまでの間は揮発資源ゼロ**である。

`finish=pr` では in_review の間 watch プロセスが張られ続けるが、**ループを止める手順自体は既に定義済み**で安全である (`task-pipeline/SKILL.md:472`「止める前に自分の watch プロセスを止め `state.ts watch-set --id <id> --proc null --session null` を呼ぶ」)。watch は state.json だけを見て任意のセッションが張り直せる設計になっており (同 `:277` の張り直し経路、`:278` の catch-up 観測)、喪失のコストは catch-up 観測 1 回で済む。

引数は `key=value` 形式でパースされる (`task-pipeline/SKILL.md:23-24`「tracker より後ろのトークンは、`finish=` / `approve=` / `max_open=` / `rebase=` で始まるものがそれぞれの設定、それ以外が `source`」) ので、新しい引数を足す場所は既にある。

## 要求

1. 引数 `max_tasks=<N>` を追加する。**省略時は無制限で、現行の挙動を一切変えない** (既存の呼び出し形が壊れないこと)。
2. このセッションで N 件のタスクを完了したら、**揮発資源ゼロの地点でループを止める**。「完了」の定義と「ゼロの地点」の判定は、少なくとも「自分が所有する in_progress タスクが 1 件も無い」ことを満たす地点であること。仕上げ (`pr_fix` / `rebase_fix`) が飛行中のときも止めない。
3. 止め方は**既存の停止手順をそのまま踏む** (枯渇時フロー手順 2 と同じ: 自分の watch プロセスを止め `state.ts watch-set --id <id> --proc null --session null` を呼んでから、dynamic なら ScheduleWakeup `stop: true`)。新しい停止経路を作らない。
4. 停止時の最終報告に、**再開のための具体的なコマンドと、その前に `/clear` する案内**を含める。報告には、残っている候補の件数と、レビュー待ち・追従中の PR があればその一覧も添える (人が再開前に状況を把握できるように)。
5. **カウント方法は機械判定可能で、コンテキストの記憶に依存しないこと** (`task-pipeline/SKILL.md:34`「**コンテキスト内の記憶を状態として使わない**」)。実現方法は research / plan で確定してよい。**state.json のスキーマ変更を伴う場合は `task-pipeline/scripts/state.ts` の実装・`task-pipeline/docs/state-cli-contract.md`・対応するテストも本 issue の範囲に含む**。state dir 配下の sidecar ファイル (`sessions/` の heartbeat と同階層) で済ませる選択肢もあり、どちらでもよい。
6. `max_tasks` の意味と使いどころ (コンテキスト肥大の抑制、人が `/clear` して再開する運用) を SKILL.md の引数の節に 1〜2 行で記す。

## 受け入れ条件

1. `grep -n "max_tasks" task-pipeline/SKILL.md` にヒットがあり、引数パースの節 (現行 :23-24 の `key=value` 列挙) に `max_tasks=<N>` が加わっている。
2. `max_tasks` を省略したときに挙動が変わらないことが SKILL.md に明記されている (既定は無制限)。
3. 停止判定が「自分が所有する in_progress タスクがゼロ」を満たす地点でのみ発火する旨が SKILL.md に明記されており、仕上げ (`pr_fix` / `rebase_fix`) 飛行中は止めないことも書かれている。
4. 停止手順が枯渇時フロー手順 2 と同じ手順 (watch を止め `--proc null --session null` → dynamic なら `stop: true`) を踏む形で記述されており、独自の停止経路になっていない。
5. 最終報告に含めるもの (再開コマンド、`/clear` の案内、残候補件数、レビュー待ち/追従中 PR の一覧) が SKILL.md に列挙されている。
6. カウント方法が、SKILL.md または参照先の記述だけから第三者が機械的に再現できる (何をどこに記録し、何と比べるかが具体的に書いてある)。コンテキストの記憶に依存する記述になっていない。
7. state.json スキーマを変更した場合は、`task-pipeline/docs/state-cli-contract.md` の該当節が更新され、`state.ts` に対応するテストが追加されている。変更しなかった場合はこの条件を「該当なし」として report.md に明記する。
8. `sh tests/run.sh` が全スイート PASS (failed: 0)。
