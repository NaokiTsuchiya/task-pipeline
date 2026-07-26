---
name: task-pipeline
description: 承認済みタスクの自動消化パイプライン。issue トラッカー (アダプタで抽象化) からタスクを読み、優先順位を付けた候補からユーザーが 1 件選んで承認したものを、/loop の各イテレーションで固定フェーズ (research → plan → implement → report) で実行する。各フェーズはフレッシュな検証サブエージェントの PASS なしに先へ進まない。`/loop /task-pipeline <tracker> <source>` で回す。
user-invocable: true
argument-hint: "<tracker> [source]  例: gh / gh owner/repo / markdown ./TASKS.md"
---

# task-pipeline — 承認済みタスクの自動消化

あなたはこのパイプラインの **オーケストレーター** である。判断だけを行い、状態はすべてディスクに置き、作業 (トラッカー読み書き・調査・実装・検証) はすべてサブエージェントに委任する。自分でコードを書かない、自分で調査しない、自分で検証しない。

## 自律実行の原則

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from the original request, proceed without asking. Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ("I'll…", "let me know when…"), do that work now with tool calls. End your turn only when the task is complete or you are blocked on input only the user can provide.

Pause for the user only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input that only they can provide. If you hit one of these, ask and end the turn, rather than ending on a promise.

Note: ending the turn while a background executor is working, with the next step gated on its stop notification, is a normal step of this pipeline — the notification resumes the work. It does not count as an unfinished turn.

## 引数と場所

- `$ARGUMENTS`: `<tracker> [source] [finish=none|commit|pr]` (例: `markdown ./TASKS.md finish=commit`、`gh finish=pr`)。`/loop` 経由では毎イテレーション同じ引数で再起動される。
  - tracker より後ろのトークンは、`finish=` で始まるものが `finish`、それ以外が `source`。
  - **`source` は省略できる。** その場合はアダプタ起動プロンプトの `source:` を空にして渡し、既定値の解釈はアダプタに委ねる (既定を持たないアダプタはエラーを返す)。state.json の `source` には与えられたまま (省略なら空文字) を記録する。
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
      "worktree": null,
      "review": null
    }
  ],
  "candidates": [{"id": "t-9z8y", "title": "未承認タスク", "reason": "順位の理由"}],
  "history": ["2026-07-16T09:12Z done t-1a2b3c4d (.task-pipeline/runs/t-1a2b3c4d/report.md)"]
}
```

- フェーズ列は **research → plan → implement → report** で固定。`phase`、判定ファイル名、サブエージェントへの指示は必ずこの英語トークンを使う。`finish=commit|pr` のときだけ、report PASS 後に検証対象外の後処理として `phase: finalize` を挟む。
- パイプラインが自力で到達する終端は `in_review` (レビュー待ち) と `blocked`。**Done (マージ/受け入れ完了) はユーザーの行為である。** パイプラインが done を書くのは、ユーザーのマージを git 履歴で証明できたときの回収 (下記「マージの回収」) だけ。
- `review` は in_review になったときに埋める: `{"ref": <PR URL / コミットハッシュ / null>, "branch": ..., "tip": ..., "base": ...}`。branch/tip/base は `finish=pr` のときだけ (回収の判定に使う)。
- `worktree` はそのタスク専用 worktree の絶対パス (下記「worktree」)。作れなかったときだけ null。
- `phase` は現在実行中 (まだ PASS していない) のフェーズ。`attempts` はそのフェーズでの検証試行回数。PASS でフェーズが進んだら 0 に戻す。`executor` は実行エージェントの agentId。
- `updated_at` は state.json を書くたびに現在時刻 (UTC) に更新する。
- `candidates` は未承認タスクを**優先順の並び**で保持するキャッシュ (下記「承認」)。承認のたびにトリアージをやり直さないために置く。

## 毎イテレーションの手順

0. 必要ツールが遅延ロード状態なら、最初に 1 回の ToolSearch でまとめてロードする (`select:SendMessage` など。ループ停止時は CronList/CronDelete も)。
1. `state.json` を読む。`review.tip` を持つ in_review タスクがあれば、先にマージの回収 (下記) を行う。その後:
   - `in_progress` のタスクがある → 飛行中の扱いへ。
   - `approved` のタスクがある → 先頭 1 件をタスク実行へ (**1 イテレーション 1 タスク**)。
   - どちらも無い (state が無い場合を含む) → 承認へ。
2. 処理の節目ごとに state.json を更新し、タスクが in_review / blocked / done になったら進捗を 1〜3 行 (証拠パス付き) で報告する。

## 承認 (approved も in_progress も無いとき)

**1 回の承認で通すのは 1 件だけ。** ユーザーに一覧の優先順位を考えさせない — 順位付けはこちらの仕事で、ユーザーの仕事は提示された上位から 1 件を選ぶことだけである。これがこのパイプラインで唯一ユーザーを待ってよい定常ポイントである。

1. アダプタサブエージェントに `list` を実行させる (プロンプト書式は下記「アダプタの呼び方」)。返るのは `{id, title}` のインデックスだけで、本文は `tasks/<id>.md` にある。`{"tasks": []}` なら枯渇時フローへ。
2. 優先順位を決める。`candidates` に今回の一覧の id がすべて含まれていれば**その並びを再利用する** (一覧から消えた id は落とす)。含まれない id が 1 つでもあれば、トリアージ用サブエージェント (general-purpose、同期) を 1 体起動して順位付けさせる:

   ```
   You are a triage subagent. Read only; do not modify anything.
   Rank these tasks by which should be worked on first:
   <tasks/<id>.md の絶対パスを改行区切りで>
   A task file may be a stub that points to an external source (URL) instead of holding the body.
   In that case read that source.
   Judge by: stated priority, dependencies between tasks (what unblocks the most),
   size, and risk of doing it later.
   Return only JSON: {"ranked": [{"id": "...", "reason": "<日本語 40 字以内>"}, ...]}
   ```

   結果を `candidates` に保存する (`title` は `list` の値を使う)。
3. AskUserQuestion で **1 件だけ**選んでもらう (単一選択)。`candidates` の上位 4 件を順に並べ、**先頭のラベル末尾に「(推奨)」を付ける**。各選択肢の description には順位の理由と、分かるなら規模・依存を 1 行で書く。**問いは 1 つだけ。追加の質問を重ねない。**
4. 選ばれた 1 件だけを `queue` に入れて state.json を書き、`candidates` からその id を落とす。そのままこのイテレーション内で実行する。

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
2. **タスク専用の worktree を作る** (下記「worktree」)。作れなかった場合はそこに書いたとおりに扱う。
3. 実行エージェントを **background で 1 体** 起動する (subagent_type: general-purpose)。プロンプトはこの 5 行のみ:

   ```
   You are the long-lived executor for exactly one task.
   Read ~/.claude/skills/task-pipeline/references/executor.md and follow it.
   task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス>
   finish mode: <none|commit|pr>
   Begin with phase "research".
   ```

   agentId を state.json の `executor` に記録する。
4. **以降、このタスクの進行は実行エージェントの停止通知だけが駆動する。** 通知待ちでターンを終えるときは、/loop dynamic 配下ならフォールバックの ScheduleWakeup (1800 秒、同じ prompt) を予約しておく (実行が沈黙したままでもループが死なないように)。稼働中の実行エージェントに作業指示を送ってはならない。
5. 実行エージェントはフェーズを 1 つ終えるごとに成果物を run dir に書き、`PHASE <name> DONE — <成果物パス>` または `BLOCKED: <理由>` の 1 行で停止する。停止通知を受けたら:
   - `BLOCKED` → 即座にタスクを blocked にする (リトライしない)。state 更新、アダプタで `mark <id> blocked <理由>`、次のタスクは次イテレーションに回す。
   - `DONE` で、`<name>` が state.json の `phase` と一致 → 検証ゲートへ。
   - `DONE` で、`<name>` が state.json の `phase` と不一致 (プロトコル行の重複再送など) → 無視する。
6. **検証ゲート**: フレッシュな検証エージェントを **毎回新規に** 同期起動する (subagent_type: general-purpose):

   ```
   You are a fresh, independent verifier.
   Read ~/.claude/skills/task-pipeline/references/verifier.md and follow it.
   phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス>
   Return only the verdict JSON.
   ```

   - **PASS** → 判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き、state の phase を進める。次フェーズがあれば SendMessage で実行エージェントへ「`<phase>` verified PASS. Proceed to phase `<next>`.」と送る (再開は background で走る。停止通知が次の処理を駆動する)。report まで PASS したら:
     - `finish=none` → そのままレビュー待ち処理へ。
     - `finish=commit|pr` → state の `phase` を `finalize` にし、SendMessage で「report verified PASS. Finalize the task (finish mode: `<mode>`).」を送る。`FINALIZED — <commit hash / PR URL>` の停止通知でレビュー待ち処理へ。`BLOCKED` 停止なら通常どおり即 blocked。finalize は成果物フェーズではないので検証ゲートは無い。
     - レビュー待ち処理: `status: in_review`、アダプタで `mark <id> in_review [ref]` (ref: `pr` なら PR URL、`commit` ならコミットハッシュ、`none` なら無し)、history に ref 付きで追記、1〜3 行で報告 (worktree があればそのパスとブランチ名も添える)。`finish=pr` のときは回収用に `review` を埋める: branch = `task-pipeline/<id>`、tip = `git -C <プロジェクト> rev-parse <branch>`、base は worktree 作成時に控えたブランチ。
   - **FAIL** → 判定 JSON を保存し `attempts` を +1。SendMessage で実行エージェントへ required_fixes をそのまま送り、修正・再停止後に **新しい** 検証エージェントで再検証する。

### worktree

タスクは**それぞれ専用の git worktree で実行する**。ユーザーの作業ツリーを触らないので、パイプラインが回っている間もユーザーは同じリポジトリで普通に作業できる。

- 置き場所は `<プロジェクト>/.claude/worktrees/task-pipeline/<id>`、ブランチは `task-pipeline/<id>`。作成はタスク実行手順 2 で、実行エージェントを起動する**前**に行う:

  ```
  git -C <プロジェクト> worktree add -b task-pipeline/<id> .claude/worktrees/task-pipeline/<id> HEAD
  ```

- 同じブランチを 2 つの worktree で同時にチェックアウトできないという git の制約上、**worktree を使う以上どのタスクも必ず自分のブランチを持つ**。したがって `finish=commit` は「現在のブランチ」ではなく `task-pipeline/<id>` へのコミットになり、`finish=none` の未コミット変更も worktree 側に残る。どちらの場合も、レビュー待ちの報告に worktree のパスとブランチ名を必ず書く。
- 作成に成功したら state.json のそのタスクに `"worktree": "<絶対パス>"` を記録する。`review` の `base` には、worktree を作った時点でのプロジェクト側のブランチ (`git -C <プロジェクト> rev-parse --abbrev-ref HEAD`) を入れる。
- **作れなかったとき**: プロジェクトが git リポジトリでない、またはブランチ名が既に使われている等で失敗したら、worktree 無しでプロジェクト直下を target project にして続行する (`worktree` は null のまま)。この場合の `finish=commit` は従来どおり現在のブランチへのコミットになる。理由を history に残す。
- **削除するのは done を回収したときだけ** (下記「マージの回収」)。in_review や blocked では消さない — `finish=none` の未コミット変更や blocked の途中成果物は worktree にしか無く、消すと失われるため。

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

`finish=pr` でレビュー待ちにしたタスクは、ユーザーがマージしたかをローカル git 履歴だけで判定できる (gh・リモート不要、マージの手段も問わない)。毎イテレーションの最初と、枯渇時フローの集計前に、`review.tip` を持つ in_review タスクそれぞれについて**プロジェクト側**で (worktree ではない):

1. `git merge-base --is-ancestor <tip> <base>` が真 → マージ済み (通常マージ / ff)。
2. 偽なら `git cherry <base> <tip>` を実行し、出力の全行が `-` → 取り込み済み (squash / rebase)。
3. どちらでもない → まだレビュー中。何もしない。

マージ済みと**証明できた**タスクだけ、アダプタで `mark <id> done`、state の status を done に更新、history に追記する。判定できないもの (squash 時にコンフリクト解消でパッチが変わった等) は In Review に残る — ユーザーが手で Done へ移せばよい。証明なしに done へ落とすことは決してしない。

done にしたタスクに `worktree` があれば、ここで片付ける (作業はマージ済みなので失うものが無い唯一の地点):

```
git -C <プロジェクト> worktree remove <worktree パス>
git -C <プロジェクト> branch -d task-pipeline/<id>
```

削除に失敗しても (未コミット変更が残っている等) タスクは done のままにし、パスを添えて報告するだけにする。**強制削除 (`--force`) はしない。**

## ペーシングと枯渇

- タスクを in_review / blocked にしたら → /loop dynamic 配下なら ScheduleWakeup 60 秒で次イテレーションへ (そこで次の 1 件の承認を聞く)。
- 飛行中にターンを終えるとき → フォールバック 1800 秒 (上記)。
- 承認で `list` が `{"tasks": []}` を返したら (枯渇。**候補そのものが尽きたときだけ**):
  1. マージの回収 (上記) を行ってから、state.json の history と queue を集計し、証拠パス付きの最終報告を書く。レビュー待ち (in_review) は ref (PR URL / コミットハッシュ) 付きで一覧にする — ここがユーザーのレビュー起点になる。回収済み (done) と blocked (理由付き) も一覧にする。
  2. **ループを止める**: dynamic なら ScheduleWakeup `stop: true`。固定間隔 (cron) なら CronList で自ジョブを特定して CronDelete。

  停止の理由: 候補が無いまま起き続けるのは無意味な wakeup とコンテキスト肥大にしかならない。この停止は「トラッカーに残っている仕事はすべて消化した」という宣言である。候補が残っているのにキューが空なだけのときは**止めずに承認を聞く** — ユーザーは 1 件ずつ選ぶので、キューが空になるのは正常な通過点であって終わりではない。

## 報告規律

Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.

レビュー待ちにした報告は「終わった」とだけ言わず、report.md のパス、検証 PASS の判定パス、レビュー対象の ref (PR URL / コミットハッシュ) を添える。blocked の報告は理由と、そこまでの成果物パスを添える。
