**入る条件**: 承認の手順 1 で `list` が `{"tasks": []}` を返したとき (候補そのものが尽きたとき)。停滞の追従打ち切り・アダプタ不通・`max_tasks` の安全停止も、止め方としてこの手順書の手順 2 を参照する。

### 枯渇時フロー (候補が尽きたとき)

承認で `list` が `{"tasks": []}` を返したら (枯渇。**候補そのものが尽きたときだけ**):

1. マージの回収 (`playbooks/merge-recovery.md`。**そこに含まれる依存の昇格まで済ませる** — 昇格で候補が出たならそれは枯渇ではないので、この手順を抜けて通常の承認に戻る) を行ってから、state.json の history と queue を集計し、証拠パス付きの最終報告を書く。`state.ts stalled-set --value depleted` を呼ぶ。**この最終報告を書くのは `stalled` が `null` から `"depleted"` に変わる最初の 1 回と、SKILL.md の「停滞」の打ち切りで止めるときだけ** (追従だけの周回で毎回出し直さない)。
   **最終報告には「なぜ候補が無いのか」の内訳を必ず入れる**。**内訳を作るのは read-only の調査サブエージェント 1 体** (general-purpose、同期。オーケストレーターがトラッカーを直接読むことはしない)。判定の規則をここへ書き写さず、**task-prep の棚卸しの規則をパスで渡して従わせる**。**モデルは指定しない** (判断そのものが成果物のため)。プロンプトはこの形のみ:
   ```
   You are a read-only tracker survey subagent.
   Do not write to the tracker, the repository, or any file. Do not modify anything.
   Read ~/.claude/skills/task-prep/SKILL.md (the 「ready 基準」, 「依存」 and 「棚卸し」 sections)
   and ~/.claude/skills/task-prep/references/trackers/<tracker>.md, and follow them for reading only.
   source: <source> / project root: <プロジェクトルートの絶対パス>
   exclude: <state.json の queue に載っている id をカンマ区切り、無ければ none>
   List the open issues that are NOT pipeline candidates (excluding the ids above),
   and for each say which ready criterion it is missing.
   Read issue bodies only if there are 30 or fewer such issues; otherwise return counts and ids
   only, with "truncated": true.
   Return only JSON:
   {"counts": {"deps": 0, "unanswered": 0, "underspecified": 0, "other": 0},
    "items": [{"id": "...", "state": "deps|unanswered|underspecified|other", "note": "<日本語 40 字以内>"}],
    "truncated": false}
   ```
   - 状態の意味: `deps` = 依存待ち、`unanswered` = 人の答え待ち、`underspecified` = 本文が要求として詰まっていない、`other` = それ以外。返った JSON をそのまま内訳にする。`truncated` が真なら (30 件超で件数と id しか見ていない) 絞ったことを報告に明示する。
   - **書き込ませない** (昇格はマージの回収で済んでいる)。**task-prep が入っていない環境では調査ごと飛ばす** (`test -f ~/.claude/skills/task-prep/SKILL.md` の終了コードで判定)。出口の案内を 1 行添える: `/task-prep` (棚卸し) か `/task-scout` (コードベースの実査)。
   - トラッカーが状態の表現を持たない場合は件数だけでよい。レビュー待ち (`resting × open`) は ref 付きで、回収済みと blocked (理由付き) も一覧にする。追従中の PR があれば CI 状態と `ledger.fix_attempts` も添える。
   - **同じ「最初の 1 回」に限り、レトロ観測のトリガー 1 も行う** (`playbooks/retro-launch.md`)。返った改善候補とサマリーファイルのパスを、この最終報告に追記する。
2. **自分の担当の PR が 1 本も無ければループを止める**: **止める前に、まずレトロ観測のトリガー 2 (`playbooks/retro-launch.md`) を行う。**続けて自分の観測プロセスを止め `state.ts release --id <id>` を呼び、dynamic なら ScheduleWakeup `stop: true`、固定間隔なら CronList で自ジョブを特定して CronDelete する。「自分の担当」は**追従対象**のタスクのうち**生きている他セッションが所有しているもの以外すべて** (cron 配下で前イテレーションが持っていた PR も含めて数える — 数えないと自分でジョブを消してから誰も追従しなくなる)。**この手順を参照する停止経路 (SKILL.md の「停滞」の追従打ち切り、SKILL.md の「アダプタの呼び方」のアダプタ不通) はすべてこのレトロ呼び出しを含めて実行したことになる** (`max_tasks` による安全停止だけは対象外。`playbooks/max-tasks.md`)。
3. **自分の担当**の PR が残っているなら**止めずに追従だけを続ける**: 最終報告を出したうえで、dynamic なら 3600 秒で次イテレーションへ (固定間隔なら CronDelete しない。この wakeup は 観測プロセスの生存確認だけの保険)。以降も `list` は毎回呼び、**新しい候補が現れたら通常どおり承認を聞く** (`state.ts stalled-set --value null` を呼ぶ)。打ち切り条件は SKILL.md の「停滞」のみ (別の計時規則は置かない)。
止める理由: 候補が無いまま起き続けるのは無意味な wakeup とコンテキスト肥大にしかならない (「トラッカーに残っている仕事はすべて消化した」という宣言)。候補が残っているのにキューが空なだけのときは**止めずに承認を聞く**。
