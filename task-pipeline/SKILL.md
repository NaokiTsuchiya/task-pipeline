---
name: task-pipeline
description: 承認済みタスクの自動消化パイプライン。issue トラッカー (アダプタで抽象化) からタスクを読み、ユーザーがまとめて承認したキューを /loop の各イテレーションで 1 件ずつ、固定フェーズ (research → plan → implement → report) で実行する。各フェーズはフレッシュな検証サブエージェントの PASS なしに先へ進まない。`/loop /task-pipeline <tracker> <source>` で回す。
user-invocable: true
argument-hint: "<tracker> <source>  例: markdown ./TASKS.md"
---

# task-pipeline — 承認済みタスクの自動消化

あなたはこのパイプラインの **オーケストレーター** である。判断だけを行い、状態はすべてディスクに置き、作業 (トラッカー読み書き・調査・実装・検証) はすべてサブエージェントに委任する。自分でコードを書かない、自分で調査しない、自分で検証しない。

## 自律実行の原則

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from the original request, proceed without asking. Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ("I'll…", "let me know when…"), do that work now with tool calls. End your turn only when the task is complete or you are blocked on input only the user can provide.

Pause for the user only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input that only they can provide. If you hit one of these, ask and end the turn, rather than ending on a promise.

Note: ending the turn while a background executor is working, with the next step gated on its stop notification, is a normal step of this pipeline — the notification resumes the work. It does not count as an unfinished turn.

## 引数と場所

- `$ARGUMENTS`: `<tracker> <source> [finish=none|commit|pr]` (例: `markdown ./TASKS.md finish=commit`)。`/loop` 経由では毎イテレーション同じ引数で再起動される。
  - `finish` はタスク完了時のコード変更の扱い。`none` (省略時): working tree に未コミットで残す。`commit`: タスクごとに現在のブランチへコミット。`pr`: タスクごとにブランチを切り、コミット・push して PR を作成。
- skill dir: `~/.claude/skills/task-pipeline/`
- アダプタ定義: `~/.claude/skills/task-pipeline/references/adapters/<tracker>.md`。存在しなければ adapters/ を Glob で列挙して提示し、**ループを止めて** (枯渇時フロー手順 2 と同じ) 終了する。
- 状態はカレントプロジェクトの `.task-pipeline/` 配下:
  - `state.json` — 唯一の状態源。**毎イテレーション必ず読み直す**。コンテキスト内の記憶を状態として使わない。
  - `tasks/<id>.md` — タスク本文 (アダプタサブエージェントが書く)
  - `runs/<id>/` — フェーズ成果物と検証判定

## コンテキスト規律 (最重要)

メインコンテキストに載せてよいのは、state.json、サブエージェントの短い構造化結果 (タスクインデックス・判定 JSON・停止通知)、承認のやり取りだけ。

- トラッカーの生データ、タスク本文、フェーズ成果物、references/ 配下を **メインで Read しない**。読むのはサブエージェントの仕事。
- サブエージェントには指示ファイルの **パスを渡して先方に読ませる**。指示本文をプロンプトに書き写さない。
- サブエージェントの最終応答は下記プロトコルの 1 行 / 小さな JSON に限られる。それ以上返してきても要点以外は捨てる。

## state.json スキーマ

```json
{
  "tracker": "markdown",
  "source": "./TASKS.md",
  "updated_at": "2026-07-16T09:12:00Z",
  "queue": [
    {
      "id": "t-1a2b3c4d",
      "title": "タスクのタイトル",
      "status": "approved | in_progress | in_review | done | blocked",
      "phase": null,
      "attempts": 0,
      "executor": null,
      "blocked_reason": null,
      "review": null
    }
  ],
  "history": ["2026-07-16T09:12Z done t-1a2b3c4d (.task-pipeline/runs/t-1a2b3c4d/report.md)"]
}
```

- フェーズ列は **research → plan → implement → report** で固定。`phase`、判定ファイル名、サブエージェントへの指示は必ずこの英語トークンを使う。`finish=commit|pr` のときだけ、report PASS 後に検証対象外の後処理として `phase: finalize` を挟む。
- パイプラインが自力で到達する終端は `in_review` (レビュー待ち) と `blocked`。**Done (マージ/受け入れ完了) はユーザーの行為である。** パイプラインが done を書くのは、ユーザーのマージを git 履歴で証明できたときの回収 (下記「マージの回収」) だけ。
- `review` は in_review になったときに埋める: `{"ref": <PR URL / コミットハッシュ / null>, "branch": ..., "tip": ..., "base": ...}`。branch/tip/base は `finish=pr` のときだけ (回収の判定に使う)。
- `phase` は現在実行中 (まだ PASS していない) のフェーズ。`attempts` はそのフェーズでの検証試行回数。PASS でフェーズが進んだら 0 に戻す。`executor` は実行エージェントの agentId。
- `updated_at` は state.json を書くたびに現在時刻 (UTC) に更新する。

## 毎イテレーションの手順

0. 必要ツールが遅延ロード状態なら、最初に 1 回の ToolSearch でまとめてロードする (`select:SendMessage` など。ループ停止時は CronList/CronDelete も)。
1. `state.json` を読む。`review.tip` を持つ in_review タスクがあれば、先にマージの回収 (下記) を行う。その後:
   - state が無い → セットアップへ。
   - `in_progress` のタスクがある → 飛行中の扱いへ。
   - `approved` のタスクがある → 先頭 1 件をタスク実行へ (**1 イテレーション 1 タスク**)。
   - どちらも無い → 枯渇時フローへ。
2. 処理の節目ごとに state.json を更新し、タスクが in_review / blocked / done になったら進捗を 1〜3 行 (証拠パス付き) で報告する。

## セットアップ (state.json が無いとき)

1. アダプタサブエージェントに `list` を実行させる (プロンプト書式は下記「アダプタの呼び方」)。返るのは `{id, title}` のインデックスだけで、本文は `tasks/<id>.md` に書かれている。
2. AskUserQuestion (multiSelect、1 問 4 件まで、1 回 4 問まで。溢れたら繰り返す) で、実行してよいタスクを承認してもらう。これがこのパイプラインで唯一ユーザーを待ってよい定常ポイントである。
3. 承認されたタスクだけを `queue` に入れた state.json を書く。未承認タスクは記録しない (次の承認時に都度 `list` し直す)。
4. そのまま最初の 1 件をこのイテレーション内で実行する。

## アダプタの呼び方

アダプタ操作は毎回フレッシュなサブエージェント (general-purpose、同期) で行う。プロンプトはこの形のみ:

```
You are a tracker adapter subagent.
Read ~/.claude/skills/task-pipeline/references/adapters/<tracker>.md and follow it.
operation: list | mark <id> <status> [reason]
source: <source> / state dir: <カレントプロジェクトの .task-pipeline 絶対パス>
Return only what the adapter file specifies for this operation.
```

- `list` が `{"error": ...}` を返したら (トラッカー到達不能・認証切れ等)、**空の一覧と混同しない**。エラー内容を報告してループを止め (枯渇時フロー手順 2 と同じ)、終了する。
- `mark` が `{"ok": false}` を返したら history に記録して続行する (state.json が正。トラッカーとのずれは次の報告に含める)。

## タスク実行

1. state.json で対象タスクを `status: in_progress`, `phase: research`, `attempts: 0` に更新し、`runs/<id>/` を作る。アダプタで `mark <id> in_progress` する。
2. 実行エージェントを **background で 1 体** 起動する (subagent_type: general-purpose)。プロンプトはこの 5 行のみ:

   ```
   You are the long-lived executor for exactly one task.
   Read ~/.claude/skills/task-pipeline/references/executor.md and follow it.
   task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <cwd>
   finish mode: <none|commit|pr>
   Begin with phase "research".
   ```

   agentId を state.json の `executor` に記録する。
3. **以降、このタスクの進行は実行エージェントの停止通知だけが駆動する。** 通知待ちでターンを終えるときは、/loop dynamic 配下ならフォールバックの ScheduleWakeup (1800 秒、同じ prompt) を予約しておく (実行が沈黙したままでもループが死なないように)。稼働中の実行エージェントに作業指示を送ってはならない。
4. 実行エージェントはフェーズを 1 つ終えるごとに成果物を run dir に書き、`PHASE <name> DONE — <成果物パス>` または `BLOCKED: <理由>` の 1 行で停止する。停止通知を受けたら:
   - `BLOCKED` → 即座にタスクを blocked にする (リトライしない)。state 更新、アダプタで `mark <id> blocked <理由>`、次のタスクは次イテレーションに回す。
   - `DONE` で、`<name>` が state.json の `phase` と一致 → 検証ゲートへ。
   - `DONE` で、`<name>` が state.json の `phase` と不一致 (プロトコル行の重複再送など) → 無視する。
5. **検証ゲート**: フレッシュな検証エージェントを **毎回新規に** 同期起動する (subagent_type: general-purpose):

   ```
   You are a fresh, independent verifier.
   Read ~/.claude/skills/task-pipeline/references/verifier.md and follow it.
   phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <cwd>
   Return only the verdict JSON.
   ```

   - **PASS** → 判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き、state の phase を進める。次フェーズがあれば SendMessage で実行エージェントへ「`<phase>` verified PASS. Proceed to phase `<next>`.」と送る (再開は background で走る。停止通知が次の処理を駆動する)。report まで PASS したら:
     - `finish=none` → そのままレビュー待ち処理へ。
     - `finish=commit|pr` → state の `phase` を `finalize` にし、SendMessage で「report verified PASS. Finalize the task (finish mode: `<mode>`).」を送る。`FINALIZED — <commit hash / PR URL>` の停止通知でレビュー待ち処理へ。`BLOCKED` 停止なら通常どおり即 blocked。finalize は成果物フェーズではないので検証ゲートは無い。
     - レビュー待ち処理: `status: in_review`、アダプタで `mark <id> in_review [ref]` (ref: `pr` なら PR URL、`commit` ならコミットハッシュ、`none` なら無し)、history に ref 付きで追記、1〜3 行で報告。`finish=pr` のときは回収用に `review` を埋める: branch = `task-pipeline/<id>`、tip = `git rev-parse <branch>`、base = `git rev-parse --abbrev-ref HEAD` (finalize 後は元ブランチに戻っている)。
   - **FAIL** → 判定 JSON を保存し `attempts` を +1。SendMessage で実行エージェントへ required_fixes をそのまま送り、修正・再停止後に **新しい** 検証エージェントで再検証する。

### 検証ゲートの絶対規則

フェーズ成果物は、このイテレーションでオーケストレーターが起動したフレッシュな検証エージェントの PASS なしには、**どんな理由があっても** 次フェーズへ進めない。実行エージェントの self-check、過去の PASS、成果物への自分の印象は代替にならない。

### リトライ上限

1 フェーズにつき検証は最大 3 回 (初回 + リトライ 2 回)。3 回目も FAIL ならタスクを blocked にする: state 更新 (`blocked_reason` に最後の FAIL 理由)、アダプタで `mark <id> blocked <理由>`、成果物と判定はそのまま残す。**ループは止めず**、次のタスクを次イテレーションで進める。

## 飛行中の扱い (in_progress タスクがあるとき)

wakeup がタスクの飛行中に来るのは正常である (フォールバック、または固定間隔 cron)。仕事は停止通知が運んでくるので、原則することは無い:

- `updated_at` が 90 分以内 → 実行エージェントは稼働中とみなす。**何も送らない**。/loop dynamic 配下ならフォールバック (1800 秒) を予約し直してターンを終える。固定間隔 cron 配下なら何も予約せず終える。
- `updated_at` が 90 分より古い → 実行エージェントに SendMessage で「Status check: finish your current phase per protocol and stop with your protocol line. Do not advance phases without an explicit verified-PASS message.」を送り、state.json を書いて `updated_at` を更新する (ping の繰り返しを防ぐ)。
  - 送信がエラーになる (エージェントが存在しない = セッションが変わった) → タスク実行の手順 2 の形式で新しい実行エージェントを起動する。Begin 行は「Resume from phase "<phase>". Check existing artifacts in the run dir first.」に変える。
  - 送信できたら、その後の停止通知が通常どおり検証ゲートを駆動する。

## マージの回収 (レビュー待ち → Done)

`finish=pr` でレビュー待ちにしたタスクは、ユーザーがマージしたかをローカル git 履歴だけで判定できる (gh・リモート不要、マージの手段も問わない)。毎イテレーションの最初と、枯渇時フローの集計前に、`review.tip` を持つ in_review タスクそれぞれについて target project で:

1. `git merge-base --is-ancestor <tip> <base>` が真 → マージ済み (通常マージ / ff)。
2. 偽なら `git cherry <base> <tip>` を実行し、出力の全行が `-` → 取り込み済み (squash / rebase)。
3. どちらでもない → まだレビュー中。何もしない。

マージ済みと**証明できた**タスクだけ、アダプタで `mark <id> done`、state の status を done に更新、history に追記する。判定できないもの (squash 時にコンフリクト解消でパッチが変わった等) は In Review に残る — ユーザーが手で Done へ移せばよい。証明なしに done へ落とすことは決してしない。

## ペーシングと枯渇

- タスクを in_review / blocked にした時点で `approved` が残っている → /loop dynamic 配下なら ScheduleWakeup 60 秒で次イテレーションへ。
- 飛行中にターンを終えるとき → フォールバック 1800 秒 (上記)。
- `approved` も `in_progress` も無くなったら (枯渇):
  1. マージの回収 (上記) を行ってから、state.json の history と queue を集計し、証拠パス付きの最終報告を書く。レビュー待ち (in_review) は ref (PR URL / コミットハッシュ) 付きで一覧にする — ここがユーザーのレビュー起点になる。回収済み (done) と blocked (理由付き) も一覧にする。
  2. **ループを止める**: dynamic なら ScheduleWakeup `stop: true`。固定間隔 (cron) なら CronList で自ジョブを特定して CronDelete。
  3. アダプタ `list` で未承認の残タスクを取得し、あれば AskUserQuestion で次の承認を求めてターンを終える。承認されたら queue に追記して `/loop /task-pipeline <同じ引数>` の再実行を案内する。残タスクが無ければ全完了を告げて終わる。

  停止の理由: 承認は対話でしか進まないので、承認済みが無いまま起き続けるのは無意味な wakeup とコンテキスト肥大にしかならない。この停止は「認可された仕事はすべて消化した」という宣言であり、承認の質問で終わることで、戻ってきたユーザーがその場で次を再武装できる。

## 報告規律

Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.

レビュー待ちにした報告は「終わった」とだけ言わず、report.md のパス、検証 PASS の判定パス、レビュー対象の ref (PR URL / コミットハッシュ) を添える。blocked の報告は理由と、そこまでの成果物パスを添える。
