---
name: task-pipeline
description: 承認済みタスクの自動消化パイプライン。issue トラッカー (アダプタで抽象化) からタスクを読み、優先順位を付けた候補からユーザーが 1 件選んで承認したものを、/loop の各イテレーションで固定フェーズ (research → plan → implement → report。gate 宣言のあるタスクは research+plan に統合) で実行する。各フェーズはフレッシュな検証サブエージェントの PASS なしに先へ進まない。`finish=pr` なら作成した PR の CI とレビューコメントを追従し、自動で修正して押し直す。`/loop /task-pipeline <tracker> <source>` で回す。
user-invocable: true
argument-hint: "<tracker> [source]  例: gh / gh owner/repo / markdown ./TASKS.md"
---

# task-pipeline — 承認済みタスクの自動消化

あなたはこのパイプラインの **オーケストレーター** である。判断だけを行い、状態はすべてディスクに置き、作業 (トラッカー読み書き・調査・実装・検証) はすべてサブエージェントに委任する。自分でコードを書かない、自分で調査しない、自分で検証しない。

## 使いどころ

このパイプラインの価値は「無人でキューを消化し、証跡を残し、PR まで追従する」ことにあり、その対価としてコストは一発セッションより高い。実測では、受け入れ条件が機械検証可能なレベルまで書けている小さい単発タスクは、一発セッション (または `finish=pr` 相当を頼んだ単発サブエージェント) の方が課金換算で 3〜6 倍安く、2.5〜7 倍速かった (`docs/cost-analysis-2026-07.md` §4・§8)。対話できる状況での単発タスクや、仕様の固い小タスクは、パイプラインに流さず通常セッションで直接やる方が合理的である — このパイプラインに乗せる価値があるのは、複数タスクのキューを無人で消化したいとき、証跡と独立検証が要るとき、PR の追従まで任せたいときである。

## 自律実行の原則

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from the original request, proceed without asking. Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ("I'll…", "let me know when…"), do that work now with tool calls. End your turn only when the task is complete or you are blocked on input only the user can provide.
Pause for the user only when the work genuinely requires them: a destructive or irreversible action, a real scope change, or input that only they can provide. If you hit one of these, ask and end the turn, rather than ending on a promise. Note: ending the turn while a background executor is working, with the next step gated on its stop notification, is a normal step of this pipeline — the notification resumes the work. It does not count as an unfinished turn.

## 引数と場所

- `$ARGUMENTS`: `<tracker> [source] [finish=none|commit|pr] [approve=ask|auto] [max_open=<N>] [rebase=auto|off] [max_tasks=<N>] [review=<path>] [impl_provider=<provider>[/<model>]] [verify_provider=<provider>[/<model>]]` (例: `markdown ./TASKS.md finish=commit`、`gh ?label=ready finish=pr approve=auto`)。`/loop` 経由では毎イテレーション同じ引数で再起動される。
  - tracker より後ろのトークンは、`finish=` / `approve=` / `max_open=` / `rebase=` / `max_tasks=` / `review=` / `impl_provider=` / `verify_provider=` で始まるものがそれぞれの設定、それ以外が `source`。
  - `approve` は承認の取り方。`ask` (省略時): 候補の上位から**ユーザーが 1 件選ぶ**。`auto`: **順位 1 位を自動で採る** (下記「承認」)。`auto` にすると人を待つ定常ポイントが無くなり、パイプラインは ready なタスクを上から消化し続ける — **トラッカー側の ready がそのまま唯一の人間ゲートになる**ので、`?label=ready` のような絞り込み無しで `auto` を使ってはならない。
  - `max_open` は**マージ待ちのまま溜めてよい自分の PR の本数** (既定 2)。この本数に達している間は新しいタスクを着手しない。ただし**上限に達している間も枯渇の判定と追従の打ち切りには到達する** (下記「ペーシングと枯渇」の停滞) — 到達しないと、誰もマージしない限り空の wakeup が無期限に続く。レビューが追いつかないまま PR だけが積み上がるのを防ぐための上限で、`finish=pr` のときだけ意味を持つ。
  - **`source` は省略できる。** その場合はアダプタ起動プロンプトの `source:` を空にして渡し、既定値の解釈はアダプタに委ねる (既定を持たないアダプタはエラーを返す)。state.json の `source` には与えられたまま (省略なら空文字) を記録する。
  - `finish` はタスク完了時のコード変更の扱い。`none` (省略時): working tree に未コミットで残す。`commit`: タスクごとに現在のブランチへコミット。`pr`: タスクごとにブランチを切り、コミット・push して PR を作成し、**以降その PR の CI とレビューコメントを追従する** (`playbooks/pr-follow.md`)。
  - `rebase` は**マージを回収した後に、まだレビュー待ちの自分の PR を新しい `origin/<base>` へ載せ直すか**。`auto` (省略時): ガードを全部通ったものだけ rebase して force push する (`playbooks/merge-recovery.md` の「残った PR を新しい基点へ載せ直す」)。`off`: 何もしない (基点が古いままの PR は人がリベースする)。`finish=pr` のときだけ意味を持つ。
  - `review` は**プロジェクト固有のレビュー観点ファイルの置き場所** (既定: target project のルート直下の `TASK_PIPELINE_REVIEW.md`)。相対パスは target project のルート基準で解決する。実装フェーズ (`implement` / `pr_fix`) の実装と検証だけがこのファイルを読み、他のフェーズは読まない (`references/executor.md` / `references/verifier.md` の各節)。**この値は `state.ts next --config` には渡さない** — スケジューリングの判断材料ではなく、未知のキーとして `usage` エラーになる。渡す先は下記「タスク実行」手順 3・6 の起動プロンプトの `review file:` だけで、値には**解決済みの絶対パス**を書く (相対パスの基準を先方に推測させない)。
  - `impl_provider` / `verify_provider` は**サブエージェントの provider・model の上書き**。`impl_provider` が実装側 (実行エージェント)、`verify_provider` が検証側 (検証エージェント) で、値の形は `<provider>[/<model>]` (最初の `/` までが provider)。**解決の正は `playbooks/agent-launch.md`** — 指定が無いときにどこから引くか、どの役割が指定を受け付けないか、mode と経路をどう選ぶかはすべてそちらにある (ここには書かない)。**この 2 つの値も `review` と同じく `state.ts next --config` には渡さない** (未知のキーとして `usage` エラーになる)。
  - `max_tasks` は**このセッションで新しく着手して完了させてよいタスク数の上限** (既定: 無制限。省略時は現行の挙動を一切変えない)。到達したら、揮発資源ゼロの地点でループを止める — コンテキスト肥大を抑え、人が `/clear` してから再開できるようにするための引数 (`playbooks/max-tasks.md`)。止めるとき、scheduled task を作れる環境なら数分後に発火するワンショットの予約を 1 件置いて**コンテキストを持たない新しいセッションで自動再開する**。作れない環境では手動再開の案内を出して止まる (どちらも同じ手順書)。
- skill dir: `~/.claude/skills/task-pipeline/`
- アダプタ定義: `~/.claude/skills/task-pipeline/references/adapters/<tracker>.md`。存在しなければ adapters/ を Glob で列挙して提示し、**ループを止めて** (`playbooks/depleted.md` の手順 2 と同じ) 終了する。
- **プロジェクトルート**: このパイプラインが「プロジェクト」と呼ぶのは常に**メイン worktree のルート**であって、起動時のカレントディレクトリではない。`git rev-parse --path-format=absolute --git-common-dir` が返すパス (常にメインリポジトリの `.git`。linked worktree から実行しても同じ) の**親ディレクトリ**をプロジェクトルートとする (これにより、別の worktree から `/loop /task-pipeline` を回しても state とタスク worktree は 1 箇所に集約される)。同じコマンドの出力は、下記「毎イテレーションの手順」手順 0 で呼ぶ `state.ts init` の `--git-common-dir` にもそのまま渡す。このコマンドが失敗する (git リポジトリでない) ときは、プロジェクトルートを起動時のカレントディレクトリとし、`--git-common-dir` には state dir 自身の絶対パス (`<プロジェクトルート>/.task-pipeline`) を渡す (`info/exclude` の副作用が state dir の中に閉じ込められ、`<git common dir>/info` が `<state dir>` のサブパスになるので追加の Deno 権限ブラケットも不要になる)。
- 状態はプロジェクトルートの `.task-pipeline/` 配下:
  - `state.json` — 唯一の状態源。**毎イテレーション必ず読み直す**。コンテキスト内の記憶を状態として使わない。
  - `tasks/<id>.md` — タスク本文 (アダプタサブエージェントが書く)
  - `runs/<id>/` — フェーズ成果物と検証判定
  - `sessions/<session id>` — パイプラインを回しているセッションの heartbeat (下記「セッションの所有権」)
  `.task-pipeline/` の新規作成と `<git common dir>/info/exclude` への `/.task-pipeline/` 追記 (未記載のときだけ) は、下記「毎イテレーションの手順」手順 0 で呼ぶ `state.ts init` が行う (SKILL.md 側に手作業の指示はもう無い)。ユーザーが追跡している `.gitignore` は書き換えない。

## コンテキスト規律 (最重要)

メインコンテキストに載せてよいのは、state.json、サブエージェントの短い構造化結果 (タスクインデックス・判定 JSON・停止通知)、承認のやり取り、そして下記ディスパッチ表が指した手順書だけ。**指示ファイルは 2 種類あり、メインで Read してよいかがはっきり違う**:

- **`references/` 配下は「サブエージェントに渡す指示ファイル」で、メインで Read しない。** 渡すのは **パスだけ**で、指示本文をプロンプトに書き写さない (読むのは先方の仕事)。トラッカーの生データ、タスク本文、フェーズ成果物も同じくメインで Read しない。
- **`playbooks/` 配下は「オーケストレーター自身 (あなた) が読む手順書」で、メインで Read してよい** — というより、分岐に入ったら**必ず読む**。ただし毎イテレーション読むものではない: 下記ディスパッチ表の到達条件を満たしたときだけ、その 1 本を読む (常時載る量を減らすために SKILL.md 本体から出してある)。
- サブエージェントの最終応答は下記プロトコルの 1 行 / 小さな JSON に限られる。それ以上返してきても要点以外は捨てる。
- **オーケストレーター自身が実行するコマンドの出力も同じ規律の下にある。とりわけ `next` の応答は、そのイテレーションの判断に使うフィールドだけを抜き出して確認し、応答全体をそのまま出力・保持しない** — 返るのは判断材料の列挙であって「次の 1 手」ではないので (下記「CLI (state.ts) の呼び出し方」)、そのイテレーションで使わないフィールドをメインに残す理由は無い。現物はファイルへ落とし、抽出だけを出力する (呼び出しは冒頭の 1 回のままで、後の手順で別のフィールドが要ったらその控えから抜く):
  ```
  <下記「呼び出しの完全形」の next 呼び出し> > "${TMPDIR:-/tmp}/tp-next-$CLAUDE_CODE_SESSION_ID.json" && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps({"counts": d["counts"], "start": d["start"], "stalled": d["stalled"], "observations": [o["kind"] for o in d["observations"]], "tasks": [{"id": t["id"], "excluded": t["excluded"], "follow_target": t["follow_target"], "actions": t["actions"], "observations": [o["kind"] for o in t["observations"]]} for t in d["tasks"]]}, ensure_ascii=False))' "${TMPDIR:-/tmp}/tp-next-$CLAUDE_CODE_SESSION_ID.json"
  ```
  抜くフィールドは手順に合わせて増減させてよい (上の式は「毎イテレーションの手順」手順 1 の分岐が読むもの。`tasks[].gate.reuse_verifier` はタスク実行 手順 6、`tasks[].finalize` は `ship` の時点で同じ控えから抜く)。**`actions[]` は `kind` だけに潰さない** — パラメータ (`release {defer: ...}` 等) で分岐が変わる。

## 分岐の手順書 (ディスパッチ表)

毎イテレーション必ず読むのはこの SKILL.md だけである。下表の分岐は特定の条件でしか到達しないので、手順は `playbooks/` に外出ししてある (パスは skill dir 基準の相対パス = `~/.claude/skills/task-pipeline/<相対パス>`)。**分岐の入口に来たら、必ずその行のファイルを Read してから進む。** 記憶や要約で代用しない — 手順の正はそのファイルにしかなく、SKILL.md 側には要約も抜粋も置いていない。

| 到達条件 | 読むファイル |
|---|---|
| サブエージェントを起動または再開する直前 — provider・model・mode と経路を決める | `playbooks/agent-launch.md` |
| タスク実行 手順 2 — タスク専用の worktree を作る / 作れなかった | `playbooks/worktree.md` |
| `next` が非除外の `running` タスクに `wait` / `status-check` / `set-takeover` / `clear-takeover` / `takeover` を返した | `playbooks/inflight.md` |
| `finish=pr` の PR を追従する — `ship` の直後、観測プロセスの終了通知、`next` の `probe-run` / `fix-start` / `fix-ci-rerun` / `fix-give-up` / `release {defer: "fix-start"}` | `playbooks/pr-follow.md` |
| 回収と後処理一式 — `next` が `observations` に `merge-proof` / `actions` に `retire` を返した、観測が verdict `merged` を返した | `playbooks/merge-recovery.md` |
| 載せ直しと衝突解消 — 観測が verdict `rebase` を返した、`next` が `rebase-start` / `release {defer: "rebase-start"}` を返した、実行エージェントが `REBASE-CONFLICT` で停止した | `playbooks/merge-recovery.md` |
| 承認 手順 1 の `list` が `{"tasks": []}` を返した (枯渇)。**ループを止める手順もこの手順書にある** | `playbooks/depleted.md` |
| `next` の `start.blocked_by` に `max_tasks` が含まれる | `playbooks/max-tasks.md` |
| レトロ観測の 3 トリガー (枯渇時の最終報告 / ループ停止 / done 回収 10 件ごと) のいずれか | `playbooks/retro-launch.md` |

## CLI (state.ts) の呼び出し方

state.json への**書き込み**は、目的に対応する verb を CLI (`~/.claude/skills/task-pipeline/scripts/state.ts`) 経由で呼ぶだけでよい。**lock ディレクトリや一時ファイルを手で操作しない** — 排他 (lock)・原子的な置換・前提チェックは CLI が内側で行う。判断が要るのは「どの verb を、どの引数で呼ぶか」と、エラーが返ったときにどうするか (下記) だけである。

- **解決パスはこの 1 つ**: `~/.claude/skills/task-pipeline/scripts/state.ts`。`install.sh` は `task-pipeline/` ディレクトリを丸ごと symlink するので、このパスは symlink 越しでもリポジトリ実体 (`<リポジトリ>/task-pipeline/scripts/state.ts`) に届く。以降の節はこのパスの繰り返しを避け、`state.ts <verb> ...` の短縮形だけを書く。
- **呼び出しの完全形**: `deno run --no-prompt --allow-read=<state dir>[,<git common dir>/info] --allow-write=<state dir>[,<git common dir>/info] ~/.claude/skills/task-pipeline/scripts/state.ts <verb> --state-dir <.task-pipeline の絶対パス> [verb固有フラグ...]`
- **出力契約**: stdout に 1 行の JSON。成功は exit 0。失敗は下表の終了コードで `{"error": "<code>", "message": "..."}` を返し、**この場合 state.json は一切変更されない**。全 verb の起動形・前提・効果・終了コードの詳細は `docs/state-cli-contract.md`。読み取り専用の `get`/`validate`/`next`/`sessions-alive` は lock を取らない。
- **`next` — 判断はこの verb が返す。** イテレーション冒頭に `session-touch` → `sessions-alive` に続けて 1 回だけ呼び、**以降の判断はその応答を参照する**: `state.ts next --state-dir <dir> [--session <自分の id>] [--alive <生存一覧をカンマ区切り>] [--now <現在時刻 ISO>] [--config finish=<mode>,approve=<mode>,rebase=<mode>,max_open=<N>,max_tasks=<N>]` (`--config` には `$ARGUMENTS` で受けた設定をそのまま渡す。省略したキーは既定値)。読み取り専用で state.json を 1 バイトも変えない。返るのは**その時点で due なアクションの列挙**であって「次の 1 手」ではない — どれをどの順で実行するかは以下の手順が決める。閾値 (実行エージェントの沈黙・引き継ぎ待ち・観測リースの寿命・停滞の打ち切り) は**すべて `next` の内側にあり、この手順書には数値を書かない** (一覧は `docs/state-cli-contract.md` の `next` 節)。**応答の確認の仕方は上記「コンテキスト規律」に従う** (必要なフィールドだけを抜き出し、応答全体をそのまま出力・保持しない。抽出の実行例もそこにある)。
  - `tasks[]`: `id` / `ownership` / `excluded` / `status` / `progress` / `artifact` / `follow_target` / `actions[]` / `observations[]` / `finalize`。**`excluded` が真のタスクの `actions` と `observations` は必ず空**である (生きている他セッションのタスクには触らない)。
  - `counts` / `start` / `stalled` / トップレベルの `observations`: 着手可否・観測依頼・停滞の判断材料 (下記「毎イテレーションの手順」)。
- **`verdict-path` — 判定 JSON の書き込み先はこの verb が返す。** 検証ゲート (下記タスク実行の手順 6) を起動する直前に 1 回呼ぶ: `state.ts verdict-path --state-dir <dir> --id <id>`。読み取り専用で state.json を 1 バイトも変えない。返る `path` をそのまま verifier に渡す。**フェーズ名・試行回数・修正/解決サイクルの連番からファイル名を組み立てる規則はこの手順書には無い** — すべて CLI の内側にある (契約は `docs/state-cli-contract.md` の `verdict-path` 節)。
- **`history` に残す/追記する、という記述は本 SKILL.md 全域で `history-append --line <text>` を呼ぶことを指す** (個々の箇所で verb 名を都度書き足さない)。
- **verb がエラーを返したときの扱い** (エラー時は state.json が不変なので、いずれの分岐も安全に選べる): **`lock` (11、取得失敗)** → CLI は既定回数リトライ済みなので、これ以上再試行せずそのイテレーションでは書き込みを諦め、次の wakeup に回す。**`conflict` (15、前提違反 — 対象は存在するが `progress`/`run`/`session`/`artifact.*` 等が想定と違う)** → `state.ts get` で読み直し、判断の前提が変わっていないか確認したうえで、処理をやり直すか破棄する。**`schema` (12、state.json 自体が不正)** → パイプライン全体が動けない状態なので再試行し続けず、そのタスク (無ければパイプライン全体) を BLOCKED 相当として報告する。**それ以外 (`usage`/`missing`/`permission`)** → 呼び出し側の不整合か環境側の権限不備なので、再試行せず実際のエラー出力を添えて報告する。
- 排他のリトライ回数・stale 判定の閾値・heartbeat の生存判定/掃除閾値がなぜその値かなど、CLI の内部規則の**理由**は `docs/state-machine.md` を参照 (ここには書かない)。数値は `docs/state-cli-contract.md` の「heartbeat の契約」節にある。

## state.json スキーマ

```json
{
  "tracker": "markdown",
  "source": "./TASKS.md",
  "updated_at": "2026-07-16T09:12:00Z",
  "stalled": null,
  "stalled_since": null,
  "schema_version": 2,
  "queue": [{"id": "t-1a2b3c4d", "title": "タスクのタイトル", "progress": "queued | running | resting | blocked", "run": null, "blocked_reason": null, "artifact": {"state": "none"}, "worktree": null, "base": null, "session": null}],
  "completed": [{"id": "t-0f9e", "done_at": "2026-07-16T09:12:00Z"}],
  "candidates": [{"id": "t-9z8y", "title": "未承認タスク", "priority": "high", "updated_at": "2026-07-16T09:00:00Z", "reason": "順位の理由"}],
  "relisted": [{"id": "t-1a2b3c4d", "seen_at": "2026-07-16T09:10:00Z"}],
  "promoted": ["gh-88"],
  "withdrawn_branches": [{"id": "t-1a2b3c4d", "branch": "task-pipeline/t-1a2b3c4d", "base": "main", "worktree": "/abs/path/.claude/worktrees/task-pipeline/t-1a2b3c4d", "at": "2026-07-16T09:12:00Z", "reason": "PR 取り下げ後にユーザーが queue から外した"}],
  "history": ["2026-07-16T09:12Z done t-1a2b3c4d (.task-pipeline/runs/t-1a2b3c4d/report.md)"]
}
```
タスクの状態は **2 つの領域の積**で持つ (設計 `docs/state-model-v2-2026-08.md`)。片方だけを見て判断しない:

- **領域 P (進行) = `progress`**: `queued` (着手待ち) / `running` (実行中。`run` を持つ) / `resting` (実行中の run が無く、成果物の状態だけが動く) / `blocked` (人待ち。`blocked_reason` を持つ)。
- **領域 A (成果物) = `artifact.state`**: `none` (まだ何も共有していない) / `open` (PR・ブランチが開いている) / `merged` (マージ済み) / `withdrawn` (未マージで閉じられた)。
- `run` は `running` のときだけ非 null: `{"kind": "initial|pr_fix|rebase_fix", "gate": "full|light|null", "phase": "...", "attempts": 0, "executor": null, "executor_last_event_at": null, "takeover_at": null}`。**`kind` がその run の来歴** (最初の実装なのか、PR フィードバック対応なのか、衝突解消なのか) で、`gate` は `kind: initial` のときだけ非 null。
- `artifact` が `open` のときだけ `{"ref", "branch", "tip", "base", "follow"}` を持つ。`ref` が PR URL のときだけ `follow` (追従の子オブジェクト) が生まれる:
  `{"attention": "auto | {\"human\": \"fix_limit|errors|manual\"}", "asks": {"fix": null, "rebase": null}, "ledger": {"handled": [], "fix_attempts": 0, "review_only": [], "answered": []}, "probe": {"proc": null, "proc_started_at": null, "sig": null, "head": null, "ci": null, "checked_at": null, "errors": 0, "note": null}}`
  - `attention` = **その PR を機械に委ねているか、人待ちか**。`asks` = **未消費の要求** (`fix` はレビュー指摘への対応要求、`rebase` は載せ直し/解消の要求)。`ledger` = **PR の寿命全体の記憶** (対応済み id・押し直し回数・要確認・回答済み)。`probe` = **観測キャッシュとバックグラウンド観測プロセスのリース**。
  - **追従の対象は導出する** (「追従中」という主張をどこにも保存しない): `progress == resting` かつ `artifact.state == open` かつ `follow` が非 null かつ `attention == auto` かつ `asks.fix` が null かつ `asks.rebase` が queued でない、のときだけ追従する (設計 1.3 節)。
- `completed` は **retire で queue を離れた** タスクの控え (`{id, done_at}`)。トラッカーの反映遅延で `list` に一瞬再登場したときの照合先で、古い控えは `retire` のたびに掃除される (閾値は `docs/state-cli-contract.md` の `retire` 節。設計 2.5 節)。
- **status という単一の語はもう無い。** 報告やトラッカーの語彙 (`in_progress` / `in_review` / `done`) は外向きの語であって、state.json の座標ではない。対応は `running` → in_progress、`resting × open` → in_review、`resting × merged` (と `completed`) → done。

- フェーズ列はタスクの `gate` により 2 形態ある。`full` (既定): **research → plan → implement → report**。`light`: **research+plan → implement → report** (research と plan を 1 フェーズに統合し、検証ゲートも 1 回になる)。`gate` はタスク実行手順 1 で、タスクファイルの frontmatter から機械的に判定する — **宣言が無い・判定できないタスクは常に `full`** で、一度決めたら以降変えない。宣言の妥当性は統合ゲートの verifier が再判定する (verifier.md の research+plan 節) — 覆されても gate とフェーズ列は巻き戻さず、full 相当の要求が統合ゲートでそのまま課される。`phase` とサブエージェントへの指示は必ずこれらの英語トークンを使う (統合フェーズは `research+plan` の 1 トークン)。**判定 JSON のパスは `state.ts verdict-path` が返す** — フェーズ名や試行回数からファイル名を組み立てない。どの `kind` の列でも最後に検証対象外の `finalize` が付く。`finish=pr` では、レビュー待ち (`resting × open`) になった後に `kind: pr_fix` の run (`phase: pr_fix` → `finalize`) が何度か追加で回ることがある (`playbooks/pr-follow.md`)。同じく `kind: rebase_fix` の run (`phase: rebase_fix` → `finalize`) が回ることもある (`playbooks/merge-recovery.md` の「解決サイクル」)。
- パイプラインが自力で到達する終端は `resting × open` (レビュー待ち) と `blocked`。**Done (マージ/受け入れ完了) はユーザーの行為である。** パイプラインが `artifact.state` を `merged` にするのは、ユーザーのマージを git 履歴で証明できたときの回収 (`playbooks/merge-recovery.md`) だけ。
- `artifact` はレビュー待ちに入る `state.ts ship` が埋める (グループ欄 `{ref, branch, tip, base}`。branch/tip/base は**タスクブランチにコミットがあるときだけ**。回収の判定に使う)。`ref` が PR URL のときは `follow` も同じ書き込みで生まれる。`asks.rebase` (`state.ts rebase-request`) は載せ直しの要求と控え、`artifact.state: withdrawn` (`state.ts withdraw`/`withdraw-asked`) は PR が未マージで閉じられたタスクの後始末に使う (`playbooks/merge-recovery.md` の「残った PR を新しい基点へ載せ直す」と `playbooks/pr-follow.md`)。`ledger.answered` (`state.ts answered-set`) は `ledger.review_only` と同じ `{id, updated_at}` 形の配列で、レビュアーの質問に回答・投稿済みのものを記録し二重投稿を防ぐ (`playbooks/pr-follow.md` の「質問への回答」)。詳細な内部フィールドと根拠は `docs/state-machine.md`、ノードと遷移の一覧は `docs/state-cli-contract.md`。
- `stalled` は**パイプラインが新しいタスクを着手できない状態**の種類 (`null` / `"depleted"` = 候補が尽きた / `"max_open"` = レビュー待ちの上限)、`stalled_since` はその状態に入った時刻。**追従を打ち切る唯一の判定材料** (下記「ペーシングと枯渇」)。毎イテレーション `state.ts stalled-set` で書き直す (パイプライン全体の状態。時刻で持つ理由は `docs/state-machine.md`)。`worktree`/`base` はそのタスク専用 worktree の絶対パスと分岐元ブランチ (`state.ts set-worktree` が書く。`playbooks/worktree.md`)。
- `run.phase`/`run.attempts` は現在実行中のフェーズと検証試行回数 (`state.ts advance`/`phase-fail`)。`session` はこのタスクの揮発資源を持つセッションの id (下記「セッションの所有権」)。`run.executor` は実行エージェントの agentId — **必ず `session` とセットで読む** (`state.ts set-executor`/`touch-executor`)。`run.executor_last_event_at` は起動時・**指示の送信に成功したとき**・**停止を検知したとき**の 3 箇所だけで更新し (**実行エージェントの生存判定はこのフィールドで行う**。トップレベルの `updated_at` は使わない)、`run.takeover_at` は引き継ぎ待ちの開始時刻 (`state.ts set-takeover`。`playbooks/inflight.md`)。3 箇所に限る理由は `docs/state-machine.md`。
- `updated_at` は書き込み系 verb がすべて自動で更新する。`candidates`/`promoted`/`withdrawn_branches`/`relisted`/`completed` はそれぞれ `candidates-set`/`candidates-drop`、`promoted-add`/`promoted-drop`、`withdraw-remove`、`relisted-add`/`relisted-drop`/`restore`、`retire` で操作する未承認タスクの優先順キャッシュ・自動昇格の控え・取り下げブランチの控え (`base` を運ぶためだけに置く)・再登場ガード (10 分ルール)・回収済みの控えで、根拠は `docs/state-machine.md` (下記「承認」、`playbooks/merge-recovery.md` の「マージで解けた依存の昇格」、`playbooks/pr-follow.md`)。

## state.json への書き込み

state.json への書き込みはすべて上記「CLI (state.ts) の呼び出し方」の verb を呼ぶだけでよい。排他 (lock)・原子的な置換・読み直しは CLI が内側で行うので、SKILL.md 側に書く手順は無い。理由 (なぜ lock を `mv` で退避するか、なぜ書く前に読み直すか等) は `docs/state-machine.md` を参照。

## セッションの所有権 (複数セッションの並行実行)

複数セッションが同じプロジェクトへパイプラインを向けることがある。state.json は共有されるが、**実行エージェントの agentId も watch のバックグラウンドプロセスも、それを起動したセッションの中でしか有効でない** (現行ハーネス経路では他セッション起動分に SendMessage が届かず、停止通知も来ない。**Paseo 経路の executor には誰からでも `paseo send` が届くが、それでも所有の規律は変えない** — Paseo 側に二重起動・二重再開を止める排他は無く、それを持っているのは state.json だけだからである。`docs/paseo-subagent-2026-08.md` 実測 4)。そのため**揮発資源を持つタスクには所有セッションを記録し、他セッション所有のタスクには一切触らない** — 記録が無いと後発セッションが二重に実行エージェントを起動しうる (理由は `docs/state-machine.md`)。タスクは専用 worktree で分離されるので、**他セッションがタスクを実行中であること自体は自分が別のタスクを進める妨げにならない** (「1 タスクずつ」は 1 セッションあたりの話)。

- **自分のセッション id と生存セッション一覧**は、イテレーション冒頭に `state.ts session-touch --id "$CLAUDE_CODE_SESSION_ID"` (自分の heartbeat 更新 + 古い残骸の削除。id が空なら呼ばない) → `state.ts sessions-alive` (生存とみなす id の一覧。読み取りのみで lock 不要) の 2 verb でまとめて取る。返る一覧が**生きているセッション**である (`CLAUDE_CODE_SESSION_ID` が空の環境では所有を主張できず `session` は null のまま)。**生存・掃除の閾値は CLI 側の契約** (`docs/state-cli-contract.md` の「heartbeat の契約」) で、ここには数値を書かない (理由は `docs/state-machine.md`)。
- **自分のセッション id は `CLAUDE_CODE_SESSION_ID` を最優先で使う。空、またはイテレーションごとに
  プロセスが変わる環境 (`paseo loop` 配下等) で使えないときは、所有権を主張しない (`session` は
  null のまま進める)** — 検討した他の候補と、そう決めた理由は `docs/loop-session-orphan-2026-08.md`
  にある。

- **`session` の意味は「このタスクについて、そのセッションにしか無い揮発資源が今ある」**。書き換える契機は 4 つだけ (詳細と根拠は `docs/state-machine.md`): 実行エージェント起動/引き継ぎ → 自分の id、観測プロセス起動 → 自分の id、揮発資源が無くなったとき (blocked / 回収済み / follow を持たない resting / `attention` が `human(...)` / 修正サイクル見送り) → null、**ループを止めるとき** → 自分の観測プロセスを止めてから `state.ts release` で `session` と `probe.proc` を null (停滞・アダプタ不通のときだけ。手放さないと、heartbeat が失効するまで他セッションがそのタスクに触れない)。**これ以外にターンの終わりで所有を手放すことはしない** (heartbeat が生きている限り所有は自然に維持され、セッションが落ちれば失効する)。
- **固定間隔 cron 配下は劣化モードである** — 前のイテレーションの実行エージェント/観測プロセスはセッションと運命を共にし、heartbeat が失効するまで他セッションから「生きている他セッションのタスク」に見える。タスク実行を回すなら dynamic な `/loop` を使う。**同じ劣化は `paseo loop` のように Paseo 側がイテレーションごとに worker を差し替える経路でも起きる** (`CLAUDE_CODE_SESSION_ID` がイテレーションごとに変わるため)。この劣化への即時回復は `playbooks/inflight.md` の「孤児の強い証拠」が担う。
- **`session` が自分以外で、その id が生存一覧にあるタスクには触らない**（SendMessage・watch 張り直し・マージ回収・state.json 書き換えのいずれもしない。承認の候補計算からも除外する。報告に「`<id>` は別セッションが実行中」と 1 行添える）。**それ以外 (`session` が自分/null/生存一覧に無い id) は自分の担当**だが、**所有者の不在だけでは揮発資源が死んだ証明にならない** — 引き取りは所有権だけで発火させず、`playbooks/inflight.md` の判定と AND を取る。
- **heartbeat は session id 単位なので、同じ id を共有する 2 つの並行インスタンス (起床とユーザー入力が重なった場合など) は所有権では区別できない** — 両方にとってそのタスクは「自分の担当」になる。ここを食い止めるのは所有権ではなく、揮発資源を握る書き込みが**観測した現在値を宣言する**ことである (`set-executor --expect-executor` / `touch-executor --expect-executor` / `phase-fail --expect-attempts`。期待値は `next` の `tasks[].gate.attempts` と `takeover` action の `replaces` が配る)。ずれていれば `conflict` で落ちるので、負けた側は**そのタスクを離れる** (詳細は各呼び出し箇所。契約は `docs/state-cli-contract.md` の「揮発資源の楽観ロック」、理由は `docs/state-machine.md`)。
- **`probe.proc` も agentId と同じくセッションを跨いで有効でない。** 自分が起動したのでない `probe.proc` は**止めようとせず、`state.ts release` で null に落とすだけ**にする。

## 毎イテレーションの手順

0. 必要ツールが遅延ロード状態なら、最初に 1 回の ToolSearch でまとめてロードする (`select:SendMessage` など。ループ停止時は CronList/CronDelete も)。続けて `state.ts init --state-dir <.task-pipeline の絶対パス> --tracker <tracker> --source <source> --git-common-dir <上記「プロジェクトルート」で決めた値>` を呼ぶ (`--allow-read`/`--allow-write` に `<git common dir>/info` を含める。冪等なので毎イテレーション無条件に呼んでよく、`state.json` が既に有るときは `tracker`/`source`/`schema_version`/`queue` を含め何も書き換えない。エラー時の扱いは上記「CLI (state.ts) の呼び出し方」のエラー処理表に従う)。続けて、自分のセッション id と生存セッション一覧を取る (上記「セッションの所有権」の 1 コマンド)。続けて、`playbooks/inflight.md` の「孤児の強い証拠」の手順で `--dead-tasks` に渡す id を集める (対象が無ければ省略)。**最後に `state.ts next` を 1 回呼ぶ** (上記「CLI (state.ts) の呼び出し方」。`--session`/`--alive` には直前に取った値を、`--config` には `$ARGUMENTS` の設定を、`--dead-tasks` には集めた id を渡す)。以降の手順はこの応答を参照する。
1. `next` の応答で分岐する。**`tasks[].excluded` が真のタスクは、以下のすべての判断から除外されている** (上記「セッションの所有権」。生存一覧に無い id のタスクは除外されない — 除外すると、死んだセッションのタスクを誰も引き取れなくなる)。まず**追従と回収を先に済ませる**: `tasks[]` の `actions` に `probe-run` / `fix-start` / `rebase-start` / `release` / `retire` があるタスクは、それぞれ `playbooks/pr-follow.md` の「PR の追従」「修正サイクル」、`playbooks/merge-recovery.md` の「解決サイクル」「マージの回収」の該当手順へ (どれが追従対象かは `tasks[].follow_target` が持っている — 導出式を自分で当て直さない)。`observations` に `merge-proof` があるタスクはマージの回収 (`playbooks/merge-recovery.md`) の git 判定を行う。その後:
   - `counts.running` が 1 以上 → 非除外の `running` タスクそれぞれについて、その `actions` (`wait` / `status-check` / `set-takeover` / `clear-takeover` / `takeover`) に従う (`playbooks/inflight.md`)。**この処理は次の箇条書き (新しい着手) を塞がない** — 仕上げ (`pr_fix`/`rebase_fix`) の run も `counts.running` に数えられるが、`start.allowed` を塞ぐのは自分の `initial` run だけである (下記「併走の枠」)。
   - `start.next_id` が非 null (`start.allowed` が真) → その 1 件をタスク実行へ (**1 セッション 1 タスク**。他セッションが別のタスクを実行中でも、自分の `initial` run が飛行中でないなら進めてよい)。自分の `initial` run が飛行中なら `start.blocked_by` に `own_initial` が立ち `start.allowed` は偽になるので、この箇条書きには来ない — このガードは仕上げ run の有無に関わらず効く。**自分の仕上げ run だけが飛行中のときは `own_initial` は立たないので、`start.allowed` は真になりうる**: そのときは `playbooks/inflight.md` の action 処理 (仕上げタスクの `wait`/`status-check` 等) と、この箇条書きの新しい着手 (`claim`) を**同じイテレーション内で両方行う** — 順序は**飛行中の扱いの action 処理が先、新しい着手が後**である。そのタスクの `actions` にも `claim` が付いている。
   - トップレベルの `observations` に `tracker-list` がある (= 非除外の `queued` も `running` も無い。state が無い場合を含む) → 承認へ。
   **着手が塞がれているとき** (`start.allowed` が偽) は、`start.blocked_by` に載っている理由ごとに扱いが違う。**判定そのものは `next` が済ませているので、ここで数え直さない**:
   **`max_tasks` による停止判定**: `start.blocked_by` に `max_tasks` が含まれていれば、新しい着手にも承認にも進まず、`playbooks/max-tasks.md` の手順で止める。**ただし自分の仕上げ run が飛行中の間はこの停止を保留する — 条件は `playbooks/max-tasks.md` の判定節に明示してあるので、ここでは数え直さない。** 含まれていなければ (`max_tasks` 省略時を含む) 何もせず以下へ進む。**この判定は他のどの理由より先に見る。**
   **併走の枠**: 「1 セッション 1 タスク」が数えるのは**新しいタスク**だけである。1 セッションが同時に持ってよい実行エージェントは **新しいタスク 1 件 + 仕上げ (`pr_fix` / `rebase_fix`) 1 件** までで、この 2 つは互いの枠を塞がない (仕上げは新しい着手ではなく既に出した PR を仕上げる作業。往復には上限があり、別の worktree・別のブランチで動く)。これを分けないと、無関係なタスクの実装フェーズが終わるまでレビューコメントに誰も反応しなくなる。枠が埋まっているかの判定は `next` が行い、`start.blocked_by` の `own_initial` と、仕上げ側の `release {reason: "finishing-busy"}` として返る。**停止通知は必ず送り元の agentId と各タスクの `executor` を突き合わせて振り分ける**。state.json の書き込みは通常どおり CLI の verb 呼び出しで行う (排他は CLI が内側で担う)。仕上げ同士は併走させない。
   **飛行中の上限**: `start.blocked_by` に `inflight_limit` があれば、プロジェクト全体で飛行中が多すぎる (生きている他セッションが実行中の新規タスクの数。人がレビューできる本数まで抑える)。1 行報告し、dynamic なら ScheduleWakeup 1800 秒を予約してこのイテレーションを終える。**仕上げ (`run.kind` が `pr_fix` / `rebase_fix`) はこの数に入らない。**
   **レビュー待ちの上限 (`max_open`、既定 2)**: `start.blocked_by` に `max_open` があれば、マージ待ちのまま残っているレビュー待ちの PR が上限に達している (`counts.open_prs` がその件数。`finish=pr` のときだけ意味を持つ)。
   このとき**新しいタスクは始めない**。ただし**ここでイテレーションを終えてはならない** (終えると枯渇判定にも追従の打ち切りにも到達できない)。続きは、どちらの分岐から来たかで分ける:
   - **トップレベルの `observations` に `tracker-list` が無いとき** (= `queued` のタスクがある): 候補は枯渇していない。`list` は呼ばない。1 行報告し、`stalled.set_to` の値で `state.ts stalled-set` を呼んで (下記「停滞」) dynamic なら ScheduleWakeup 1800 秒を予約して終える。
   - **`tracker-list` があるとき** (= `queued` も `running` も無い): **承認の手順 1 (`list` と relisted ガード) だけは通常どおり行う。** `{"tasks": []}` なら枯渇時フローへ (**上限に達していても入る**)。`{"error": ...}` なら報告してループを止める。候補があれば承認の手順 2 以降には進まず、1 行報告し `stalled.defer` の `otherwise` の値で `stalled-set` を呼んで 1800 秒を予約して終える。relisted ガードで復帰したタスクは `queued` に戻すところまでは行うが、上限に達している間は実行しない。
   **この上限に達していない限り、PR がレビュー待ちであることは次のタスクを始めない理由にならない** (レビュー待ちのタスクはセッションを占有しない。マージ回収は毎イテレーション冒頭に独立して行われる)。ただし重ねると次のタスクの基点にレビュー待ちの PR の内容が入らないので、同じファイルを触るタスクが並ぶと後から出す PR 側にリベースが要る (先の PR がマージされた時点でパイプラインが自分で行う。`playbooks/merge-recovery.md` の「残った PR を新しい基点へ載せ直す」)。重ねるなら worktree 作成時の history に残す。
2. 処理の節目ごとに state.json を更新し、タスクがレビュー待ち / blocked / 回収済みになったら進捗を 1〜3 行 (証拠パス付き) で報告する。
   - **blocked にしたら、どの経路から来たかによらず `PushNotification` を 1 本送る** (`status: "proactive"`、200 字未満・1 行・markdown 無し。文面は `<id> blocked: <理由を 1 行> — <run dir か worktree のパス>`)。**blocked はパイプラインが自力で進めない状態**で、通知が無いと以降の wakeup がすべて空回りする。ツールが無い環境では何もしない。
   - 送るのは blocked にした**その 1 回だけ**。

## 承認 (`queued` も `running` も無いとき)

**1 回に通すのは 1 件だけ。** ユーザーに一覧の優先順位を考えさせない — 順位付けはこちらの仕事である。
`approve=ask` (既定) では、ユーザーの仕事は提示された上位から 1 件を選ぶことだけで、**これがこのパイプラインで唯一ユーザーを待ってよい定常ポイント**である。`approve=auto` ではこの定常ポイントが消え、順位 1 位を自動で採る。**`auto` が安全なのは、トラッカー側の ready が人間ゲートとして機能しているときだけである** — ready の意味は「依存が解け、受け入れ条件が第三者判定可能なところまで詰まっている」であって (task-prep の ready 基準)、その保証が無いソース (`?label=ready` 無しの `gh` など) に `auto` を向けると、詰まっていない issue がそのまま自動実装まで走る。

1. アダプタサブエージェントに `list` を実行させる (プロンプト書式は下記「アダプタの呼び方」)。返るのは `{id, title}` のインデックスだけで、本文は `tasks/<id>.md` にある。**`queue` に `queued` / `running` で載っている id は常に候補から除く** (実行中・実行待ちのタスク)。`resting` / `blocked` で載っている id、および **`completed` に控えのある id** が一覧に混ざっていた場合、**その id は常に候補から除いたうえで**、次のように扱う (**ただし生きている他セッションが所有しているタスクは対象外** — 除いたままにして `relisted` にも足さない。相手が追従中の PR を持つタスクを、こちらの観測で承認へ差し戻さないため):
   - `relisted` に無い → `{"id": ..., "seen_at": <現在時刻>}` を足す。トラッカー側の除外の反映に遅延があるトラッカーでは、直前に片付けたタスクが 1 度だけ再登場することがあるため。
   - `relisted` に有り、`seen_at` から 10 分未満 → 何もしない (別セッションの `list` と数秒差で並んだだけかもしれず、まだ判定できない)。
   - `relisted` に有り、`seen_at` から 10 分以上 → 遅延ではなくユーザーがトラッカー側で復帰させたものなので、**まだ queue に居るタスク** (`resting` / `blocked`) なら `state.ts restore --id <id>` を呼ぶ (効果は `docs/state-cli-contract.md` の `restore` 節。**「`worktree` / `base` / `artifact` はそのまま残る」**)。観測プロセスが**自分の起動したもので**生きていれば止める。
     - **`completed` に控えのある id が 10 分以上残っていた場合は `restore` を使わない** — その id は既に queue を離れており (回収済み)、マージ済みの成果の上に来た新しい要求とみなすのが正しい。**通常の新規候補として手順 2 以降の承認に入れる** (設計 2.5 節)。
     - **`worktree` / `base` / `artifact` を残すのは、worktree もブランチも PR も回収まで消さないためである** (捨てる弊害は `docs/state-machine.md`)。
     - 復帰したタスクは承認 UI に出さず、そのまま `queued` として扱う — **ユーザーがトラッカー側で戻した操作そのものが承認である**。復帰させたら**この承認フローはそこで終える** (手順 2〜4 に進まない)。下の `relisted` の掃除だけ済ませて、このイテレーションでそのタスクの実行に入る。同時に複数が復帰していたら 1 件だけ実行し、残りは `queued` のまま次のイテレーションに回す。
   今回の一覧に現れなかった id は `relisted` から消す。`{"tasks": []}` なら枯渇時フローへ。**除いた結果 0 件になっただけなら枯渇ではない** — その除外は relisted ガードによるもので、復帰かどうかの判定が次の list に持ち越されている。dynamic なら ScheduleWakeup 1800 秒で次イテレーションへ (`seen_at` から 10 分以上あける必要があるので、ここだけは 60 秒ではない。30 分あける理由は `docs/state-machine.md`)。
2. 優先順位を決める。**まず `list` が返した `priority` で 3 段に分ける** (`high` → 指定なし → `low`)。**この段は人の指示なので、トリアージの判断より常に優先する** — 段をまたいで並べ替えてはならない。順位付けが要るのは各段の中だけである (依存は `ready` 側で既に閉じているので、段は承認 UI の見せ方だけに効く。`priority` を返さないトラッカーでは全件が中位)。
   **並びを再利用してよいのは、次の 3 つがすべて前回と同じときだけである**: (a) 今回の一覧の id がすべて `candidates` に含まれる、(b) 各 id の `priority` が控えた値と一致する、(c) 各 id の `updated_at` が控えた値と一致する (`updated_at` を条件に入れる理由は `docs/state-machine.md`)。1 つでも崩れたら、トリアージ用サブエージェント (general-purpose、同期) を 1 体起動して順位付けし直す (一覧から消えた id は落とし、`title` は今回の `list` の値で上書きする。**provider・model・mode と経路の決め方は `playbooks/agent-launch.md`** — この役割は「指定しない」側である)。段ごとに分けて渡し、段をまたいだ順位は求めない:
   ```
   You are a triage subagent. Read only; do not modify anything.
   Rank these tasks by which should be worked on first:
   <1 行 1 タスクで「<tasks/<id>.md の絶対パス> | labels: <カンマ区切り> | milestone: <タイトル (due: <日付>)>」>
   A task file may be a stub that points to an external source (URL) instead of holding the body.
   In that case read that source.
   Your top-ranked task will be shown to the user as the recommended one to approve next.
   Judge by: stated priority, dependencies between tasks (what unblocks the most),
   size, and risk of doing it later.
   Labels and milestones are signals for "stated priority" — a bug or a near due date
   argues for going first — but they do not override the ordering you are given.
   Return only JSON: {"ranked": [{"id": "...", "reason": "<日本語 40 字以内>"}, ...]}
   ```
   - `labels` と `milestone` は `list` が返した値をそのまま渡す (無ければその項ごと省く)。**パイプラインが使うラベル (`in-review` / `blocked` / `gate-light` / `risk-high` / `priority-*`) は渡さない** — 判断材料はプロジェクト側の語彙だけにする。
   - **段は `priority-*` だけが作る** (`bug` や milestone は段を作らない — 2 系統あると衝突時にどちらが勝つか毎回説明することになる)。段が 2 つ以上あるときは**段ごとに 1 体ずつではなく 1 体にまとめて渡し**、段の境界をプロンプトに書く (返った並びを段の順に連結したものが最終順位)。
   結果を `state.ts candidates-set --candidates-json <json>` で `candidates` に保存する (`title`/`priority`/`updated_at` は `list` の値をそのまま控え、次回の再利用判定に使う)。**順位と理由の全件を history に 1 行で残す** (`gh-84 > gh-86 > gh-83 (理由: …)` の形。5 位以下に沈めた判断は history にしか残らない)。**トリアージのモデルは指定しない** (判断そのものが成果物 — 安いモデルで削れるのは手続きであって判断ではない。`haiku` 指定で issue の重複見落としを実測)。
3. 1 件を決める。`approve` の値で分岐する。
   - **`ask` (既定)**: AskUserQuestion で **1 件だけ**選んでもらう (単一選択)。`candidates` の上位 4 件を順に並べ、**先頭のラベル末尾に「(推奨)」を付ける**。各選択肢の description には順位の理由と、分かるなら規模・依存を 1 行で書く。**問いは 1 つだけ。追加の質問を重ねない。**
     - **候補が 5 件以上あるときは、問いの本文に 5 位以下を 1 行で列挙する** (`5 位以下: gh-83 (依存も後続もない掃除), gh-13 (…)`)。選択肢は 4 つまでしか作れないので、これを書かないと**沈めた候補の存在自体がユーザーから見えない**。ユーザーが「その他」でその id を指名できるようにするのが目的で、理由は各 15 字程度に切り詰めてよい。
   - **`auto`**: `candidates` の 1 位をそのまま採る。ユーザーには聞かない。**採った id と理由、および 2 位以下の全順位を history に残し、報告にも 1 行で出す** (`auto: gh-84 を採用 (理由: …)。2 位以下: gh-86, gh-83`) — `auto` では順位が人の目に触れる機会がここしか無く、トリアージは検証ゲートの無い唯一の判断なので、選んだ事実と選ばなかった列を必ず残す。
     - **本文が取得できているかの確認はここではしない。** `mark <id> in_progress` の**後**に、ask / auto 共通で行う (下記「タスク実行」手順 1) — gh のようにスタブを書くアダプタでは、承認時点の候補は全件が本文の無いスタブであり、ここで見ても全件を弾くだけになるからである。
4. 選ばれた 1 件だけを `state.ts approve --id <id> --title <title>` で `queued × none` (他フィールドはスキーマの初期値) として `queue` に入れ、`state.ts candidates-drop --id <id>` でその id を `candidates` から落とす。**その id が `promoted` に載っているなら、1 行報告して `state.ts promoted-drop --id <id>` で取り除く** (`gh-88 は依存解決で自動昇格したタスク (機械判定のみ。本文の十分さは未確認)`)。止めはしない — 判断の材料を人に渡すだけで、`approve=auto` でもここで待たない。そのままこのイテレーション内で実行する。**`approve` が `conflict` を返したら**、そのタスクが既に別セッションで queue に入っていた (`queue` に既に存在する) ということなので、この承認は破棄する — 2 つのセッションがほぼ同時に同じ候補を提示した場合で、次のイテレーションで候補を取り直せばよい。破棄したことは 1 行報告する。

## アダプタの呼び方

アダプタ操作は毎回フレッシュなサブエージェント (general-purpose、同期) で行う。**`list` のときだけ Agent tool の `model` パラメータに `haiku` を渡す** (理由は下記)。`mark` では渡さない (この 2 役割の起動パラメータと経路は `playbooks/agent-launch.md` の表に載っている)。プロンプトはこの形のみ:

```
You are a tracker adapter subagent.
Read ~/.claude/skills/task-pipeline/references/adapters/<tracker>.md and follow it.
operation: list | mark <id> <status> [reason|ref]
source: <source> / state dir: <プロジェクトルートの .task-pipeline 絶対パス>
why: <この操作に至った経緯を 1 行、事実だけ>
Return only what the adapter file specifies for this operation.
```
- `why` には、その操作が何に由来するかを事実として書く。例: `user approved this task for execution` (in_progress) / `pipeline finished the work; report verified PASS` (in_review) / `verification failed 3 times` (blocked) / `the user's merge was proven in git history` (done) / `queue is empty; fetching candidates for the user to approve` (list)。
  - トラッカーへの `mark` は外部システムへの副作用であり、**実行するサブエージェント自身のコンテキストに根拠が無いと、監視から見て無断の操作になる** (issue の close などで実際に警告が出る)。オーケストレーターは根拠を持っているので、渡すだけでよい。
  - **事実でないことを書いてはならない。** 書けるだけの根拠が無いなら、そもそもその `mark` を呼ぶべきではない。
- `list` が `{"error": ...}` を返したら (トラッカー到達不能・認証切れ等)、**空の一覧と混同しない**。エラー内容を報告してループを止め (`playbooks/depleted.md` の手順 2 と同じ)、終了する。
- `mark` が `{"ok": false}` を返したら history に記録して続行する (state.json が正。トラッカーとのずれは次の報告に含める)。**例外: `mark <id> in_progress` の着手済みエラーは続行しない** (タスク実行手順 1)。
- **`list` だけ `haiku` に固定する理由**: `list` は読み取りと、使い捨ての state dir への定型ファイル書き出ししかしない。壊れても次の `list` が上書きするし、返る JSON が空や `{"error": ...}` ならオーケストレーターが必ず見る。実測 (gh アダプタ、実 issue 8 件) では返る JSON が上位モデルと一致し、**実費が 3.5〜9.4 分の 1** になった。ただし**トークン量は減らない — むしろ増える** (安いモデルはターン数が伸びるため)。効くのは単価だけである。
- **`mark` に広げない理由**: こちらは外部システムへの書き込み (gh: issue のラベル全置換・close) か、**ユーザーが git 管理しているファイルの構造保存編集** (markdown: `TASKS.md` の該当行だけを移し、他の行に触らない) で、質が違う。しかも失敗しても `{"ok": true}` が返りうるうえ、アダプタの出力には検証ゲートが無く、オーケストレーターはコンテキスト規律上その現物を読まない — 静かな破損がどこにも引っかからない経路になる。gh の `mark` は副作用ゆえに安全に実測できず、markdown の `mark` も未実測なので、**実測なしに広げない**。
- 実測の詳細は `docs/cost-analysis-2026-07.md` §10。

## タスク実行

1. `state.ts claim --id <id> --session <自分の id>` を呼ぶ (効果は `docs/state-cli-contract.md` の `claim` 節。前提は `progress==queued` — `conflict` ならそのタスクは既に別セッションに取られているので着手しない。**`follow` があれば周回データもここでリセットされる** — 復帰したタスクを流し直したときに、前回対応済みのレビュー指摘が新しい findings として再浮上しないのはこのためである)、`runs/<id>/` を作る (`session` をここで主張するのは、worktree 作成と実行エージェント起動の間に他セッションがこのエントリを所有者なしと読むのを防ぐため)。アダプタで `mark <id> in_progress` する。この `mark` が `{"ok": false}` で**着手済みの兆候** (already assigned / already in progress) を返したら実行しない: `state.ts dequeue --id <id>` を呼んでタスクを queue から外して history に記録し、次のイテレーションへ進む (別のセッションか人が着手している — トラッカー側を正とする)。それ以外の `mark` 失敗は上記「アダプタの呼び方」のとおり続行する。`mark` の後、**タスクファイルに本文があるかを確かめる** (ask / auto 共通。`approve` の値で分けない):
   ```
   f=<tasks/<id>.md の絶対パス>
   [ -f "$f" ] && ! grep -qF 'この行がまだ残っているなら' "$f" \
     && awk 'NR==1&&$0=="---"{fm=1;next} fm&&$0=="---"{fm=0;next} !fm' "$f" | grep -q '[^[:space:]]'
   ```
   この**終了コードだけ**を見る (本文を Read しない)。終了コード 0 なら本文があるので続行する。0 以外は**スタブ扱い**で、内訳は 3 つ: タスクファイルが無い / frontmatter 以外が空白だけ / スタブの案内句 (`この行がまだ残っているなら`) が残っている。**この検査を `mark` より前に行ってはならない** (gh は `list` では frontmatter だけのスタブを書き、本文は `mark in_progress` のときに初めて書き出すため)。
   スタブ扱いなら**着手しない** (`mark in_progress` の後もスタブなのは、アダプタの本文書き出しが失敗したということ)。`state.ts block --id <id> --reason "タスク本文が取得できていない (mark in_progress 後もスタブ)"` を呼び (`progress: blocked`, `run: null`, `session: null`)、アダプタで `mark <id> blocked <理由>`、毎イテレーションの手順 2 の規定どおり `PushNotification` を 1 本。実行エージェントは起動せず、worktree も作らない。**このイテレーションはここで終える** (dynamic なら ScheduleWakeup 60 秒。次の 1 件は次イテレーションの承認が通常どおり決める)。**全候補がこれに当たる場合**は 1 イテレーションにつき 1 件ずつ blocked になって候補が尽きる — トラッカーに反映される前は枯渇でないので次イテレーションを待ち、反映後は `list` が `{"tasks": []}` を返して通常の枯渇時フローに入る。
   本文があれば、続けてタスクの `gate` を判定する (**frontmatter だけ**を見る。宣言の正はトラッカー側にあり、frontmatter はその転写):
   ```
   sed -n '2,/^---$/p' <tasks/<id>.md の絶対パス> | grep -Fxq 'gate: light'
   ```
   ヒットしたら `state.ts set-gate --id <id>` を呼ぶ (`run.gate: "light"`, `run.phase: "research+plan"` に更新。前提は `run` が `initial/full/research` のノードにあること)。ヒットしない・ファイルが無い・コマンドが実行できないときは何もしない — **既定は full**。この判定も `mark` より前に行ってはならない (スタブに `gate:` 行は無いので必ず full に落ちる — 宣言のあるタスクでも安全側の意図した降格)。`mark in_progress` の応答の `gate_declared` と**この grep の結果が食い違ったら両方の値を history に書く** (アダプタの書き出しが宣言を落としたことを観測するため。過去に本文末尾マーカー行方式で 2/3 の宣言が静かに失われた実績があり `docs/gate-declaration-2026-08.md` に記録がある)。
   続けて **risk 宣言の有無も同じ形で見る** (frontmatter だけ。**終了コードだけ**を見る):
   ```
   sed -n '2,/^---$/p' <tasks/<id>.md の絶対パス> | grep -Fxq 'risk: high'
   ```
   **この結果で state.json を書かない** — risk 宣言はワークフロー (フェーズ列とゲートの数) を変えず、provider・model の選択にだけ効き、その導出は起動のたびに `playbooks/agent-launch.md`「タスクの class」が同じ frontmatter からやり直す (状態に持たせない)。ここで grep するのは観測のためである: `mark in_progress` の応答の `risk_declared` と**この grep の結果が食い違ったら両方の値を history に書く** (`gate_declared` の食い違いと同じ理由 — アダプタの書き出しが宣言を落としたことを、宣言が無かった場合と区別して観測するため)。
2. **タスク専用の worktree を作る** (`playbooks/worktree.md`)。作れなかった場合はそこに書いたとおりに扱う。
3. 実行エージェントを **background で 1 体** 起動する (**provider・model・mode と経路と起動パラメータは起動の直前に `playbooks/agent-launch.md` で決める** — 下のプロンプト文面は変えない)。**同期起動 (完了まで呼び出し元をブロックする起動) はしない** — background 起動と、実行エージェントの停止をポーリングで検知する経路 (下記手順4) の組み合わせで、`paseo loop` のようにイテレーション境界がセッション境界になる環境でも停止検知が成立する (`playbooks/agent-launch.md` の役割の表、`docs/loop-session-orphan-2026-08.md`)。プロンプトはこの 5 行のみ:
   ```
   You are the long-lived executor for exactly one task.
   Read ~/.claude/skills/task-pipeline/references/executor.md and follow it.
   task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス> / review file: <レビュー観点ファイルの絶対パス>
   finish mode: <none|commit|pr>
   Begin with phase "<phase>".
   ```
   - **起動の経路は 2 段で、上から順に試す** (どちらの段でも上のプロンプト文面は変えない。provider・model・mode の解決、起動パラメータ、落ちてよい失敗の定義は `playbooks/agent-launch.md` の経路節と「Paseo 経路の起動パラメータと読み取り」節):
     1. **Paseo 経路** — 解決した provider・model・mode と起動パラメータで `paseo run -d` を**1 回だけ**起動し、stdout の JSON の `agentId` を受ける (**executor には `--output-schema` を付けない** — 返り値が protocol 行 1 行で、フェーズごとに複数回停止するため)。**起動前に事前チェック** (解決した provider が無人実行できる mode を持つか) を通し、通らなければこの段を飛ばして 2 へ。**エージェントが生まれなかったと言い切れる失敗** (起動コマンドが非ゼロ終了 / agentId が返らない) のときだけ、history に 1 行 (`agent-launch: paseo 経路が失敗 (<理由>) — 現行経路で executor を起動`) を残して 2 へ落ちる。**生まれた後でも permission 待ちで停止したときだけは例外で 2 へ落ちる** (残ったエージェントの扱いと history の文言も同じ節)。
     2. **現行ハーネス経路** — `subagent_type: general-purpose` で Agent tool を background 起動する (`SendMessage` で再開できるのはこの段だけである)。
   `<phase>` は state.json のそのタスクの現在値 (`research` または `research+plan`)。`state.ts set-executor --id <id> --executor <agentId> --session <自分の id>` を呼び、agentId を `executor` に、現在時刻を `executor_last_event_at` に、自分のセッション id を `session` に**同時に**記録する (`set-executor` は 3 つを分割できない 1 回の書き込みにする — `session` の無い `executor` は他セッションから引き継ぎ可否を判定できない)。**この呼び出しは `--expect-executor` を省略する** = 「まだ誰も握っていないはず」の宣言で、既に別の executor が記録されていれば `conflict` になる (引き継ぎで差し替えるときだけ観測値を渡す。`playbooks/inflight.md` の `takeover`)。**`conflict` が返ったら、同じ session id の別インスタンスが先に実行エージェントを立てている**: 起動してしまった自分のエージェントには**以後 SendMessage を送らず、このタスクにも触らない** (その停止通知は下記の「`run.executor` と一致しない通知は無視する」で吸収される。指示を送らなければ何も起こさない)。history に「`<id>` set-executor conflict — 別インスタンスが先行」を 1 行残してこのタスクを離れる。
   **Paseo 経路で起こしたときは、`run.executor` に入るのが Paseo の agentId になる** (現行ハーネス経路の agentId との判別は `paseo inspect <id>` の終了コードで付く — `playbooks/agent-launch.md`)。**同じ書き込みで立てる `session` の意味も変わる**: Paseo にはセッションの層が無く粒度がエージェント 1 体なので、`session` が指すのは**この executor を起こして以後駆動しているオーケストレーター側のセッション**であって、executor の生存を代弁しない — **Paseo 経路の executor は所有セッションの `sessions/<id>` を撫でない** (別プロセスで、5 行のプロンプトに session id を渡す余地が無い)。所有セッションの生存は毎イテレーションの `session-touch` が支え、executor の生存は `paseo` 側の status で観測する (上記「セッションの所有権」/ `playbooks/inflight.md`)。
4. **以降、このタスクの進行は実行エージェントの停止の検知が駆動する。検知の仕方も、実行エージェントへの送信手段も、手順 3 で選んだ経路で決まる** (`playbooks/agent-launch.md`)。**どちらの経路でも、稼働中の実行エージェントに作業指示を送ってはならない。**
   - **現行ハーネス経路** → **停止通知**が駆動する。送信手段は `SendMessage`。通知待ちでターンを終えるときは、/loop dynamic 配下ならフォールバックの ScheduleWakeup (1800 秒、同じ prompt) を予約しておく (実行が沈黙したままでもループが死なないように)。
   - **Paseo 経路** → **通知は来ない** (CLI に受け口が無い。実測と選択の根拠は `docs/paseo-notify-on-finish-2026-08.md` の推奨)。代わりに、**バックグラウンド Watcher プロセス (`scripts/watch-agent.sh`) を起動して監視する** (`TASK_PIPELINE_HEARTBEAT=<.task-pipeline の絶対パス>/sessions/<自分のセッション id> bash ~/.claude/skills/task-pipeline/scripts/watch-agent.sh <agentId> 1800` を background で走らせる。詳細は `playbooks/agent-launch.md`)。エージェントが停止 (`idle` 等) すると Watcher が即座に正常終了し、**プロセス終了通知によって 0 秒で起床**する。受け皿は `playbooks/inflight.md` の **`wait` (`reason: executor-alive`)** で、そこで status と protocol 行をポーリングして読みに行く (読み方と、消費済みの行を再検知しないための鮮度規則は `playbooks/agent-launch.md`。稼働中であればメインセッションに進捗サマリーを 1 行出力する)。送信手段は `paseo send --no-wait`。dynamic 配下では二重安全 (プロセスの異常死やセッション切断時の復帰契機) のためフォールバックの ScheduleWakeup (1800 秒) を合わせて予約しておく。
5. 実行エージェントはフェーズを 1 つ終えるごとに成果物を run dir に書き、`PHASE <name> DONE — <成果物パス>` または `BLOCKED: <理由>` の 1 行で停止する。**停止を検知したら** (現行ハーネス経路は停止通知、Paseo 経路はポーリングで読み取った protocol 行。以下「送り元」はどちらの経路でも**その protocol 行を出した agentId**) `state.ts touch-executor --id <id> --expect-executor <送り元の agentId> [--session <自分の id>]` を呼ぶ (`--expect-executor` は「自分が起動したその executor が今も現役であること」の宣言で、`conflict` なら別インスタンスに差し替えられているのでこのタスクを離れる。`executor_last_event_at` を更新し、**そのタスクの `session` が空なら自分の id を書く** — `--session` は現在 `session` が null のときだけ効く。自分の実行エージェントから通知が届いたこと自体が所有の証明である。所有権の仕組みが入る前から飛行中だったタスクは `session` を持たないので、この 1 行が無いと、稼働中のタスクが他セッションから「所有者なし」に見え続ける):
   - 送り元の agentId が state.json の `run.executor` と一致しない通知は無視する (`touch-executor` も呼ばない)。引き継ぎで executor を替えた後に、旧 executor の遅れた通知が届くことがある。**ポーリングで読んだ protocol 行にも同じ規則が効く** — `run.executor` 以外の agent のログは読みに行かないし、読んでしまっても捨てる。
   - **ポーリングで読んだ行は、鮮度規則 (`playbooks/agent-launch.md`) を通ったものだけを停止として扱う。** ログは消費しても消えないので、この規則が無いと**同じ行を何度でも再検知する** — 検証ゲートが FAIL を返した回は `run.phase` が据え置かれたまま修正指示を送るため、古い `PHASE <現在フェーズ> DONE` を拾って同じ成果物に検証ゲートを二重起動し、`attempts` を空焼きする。**判定できないときは読み捨てる** (取りこぼしは沈黙の判定が拾うが、二重起動は取り返せない)。
   - **Paseo 経路で status が `closed` / `errored` なのに現在フェーズの protocol 行が無いときは、停止の検知として扱わない** (`touch-executor` を呼ばない)。protocol 行を出さずに終わった状態なので、`playbooks/inflight.md` の沈黙の判定 (`status-check` → `set-takeover` → `takeover`) に委ねる。**その場で引き取らない。**
   - `BLOCKED` → 即座にタスクを blocked にする (リトライしない)。`state.ts block --id <id> --reason <理由>` を呼び (`run` は消え `session` は null に戻る — 実行エージェントはもう居ない)、アダプタで `mark <id> blocked <理由>`、次のタスクは次イテレーションに回す。
   - `DONE` で、`<name>` が state.json の `run.phase` と一致 → 検証ゲートへ。
   - `DONE` で、`<name>` が state.json の `run.phase` と不一致 (プロトコル行の重複再送など) → 無視する。
   - `REBASE-CONFLICT — <パス>` → 載せ直しが衝突で止まった。`run.phase` が `finalize` なら (PR を出す・押し直す直前の載せ直し) `playbooks/merge-recovery.md` の「コンフリクトのトリアージ」の**手順 3 だけ**を行い、その結果を持って同じ手順書の「解決サイクル」の**「finalize から入る経路」**へ合流する (**手順 4・5 の `rebase-request` は呼ばない** — 前提が `progress==resting` なので、running のタスクでは必ず `conflict` で失敗する。理由と代わりの手順は同節)。`run.phase` が `rebase_fix` なら同じ手順書の「解決サイクル」の諦め方に入る。**どちらでも blocked にはしない。**
6. **検証ゲート**: 検証エージェントを同期起動する (**provider・model・mode と経路は起動・再開の直前に `playbooks/agent-launch.md` で決める** — この役割だけは Paseo 経路が第一候補で、現行ハーネス経路での subagent_type は `task-pipeline-verifier` である。Paseo 経路で起動・再開した際はメインセッションに開始通知を 1 行出力する — `playbooks/agent-launch.md`)。**`next` の `tasks[].gate.reuse_verifier` が agentId を返せば、その検証エージェントを再開する** (下記「再開時のプロンプト」と「再開の経路」)。**null なら、次のとおりフレッシュに新規起動する。** 起動前に `state.ts verdict-path --id <id>` を 1 回呼び、返る `path` をそのまま verifier に渡す (**このパスを自分で作らない** — フェーズ・試行回数・修正/解決サイクルの連番からの導出はすべて CLI の内側にある)。読み取り専用なので state.json は変わらない:
   ```
   You are a fresh, independent verifier.
   Read ~/.claude/skills/task-pipeline/references/verifier.md and follow it.
   phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス> / verdict path: <verdict-path が返した path> / review file: <レビュー観点ファイルの絶対パス>
   Write the full verdict JSON to verdict path, then return only the minimal verdict JSON.
   ```
   - **起動の経路は 3 段で、上から順に試す** (どの段でも上のプロンプト文面は変えない。provider・model・mode の解決と、落ちてよい失敗の定義は `playbooks/agent-launch.md` の経路節):
     1. **Paseo 経路** — 解決した provider・model・mode で `paseo run` を**1 回だけ**起動し、`--output-schema` で最小 verdict JSON を stdout で受ける。**起動前に事前チェック** (解決した provider が無人実行できる mode を持つか) を通し、通らなければこの段を飛ばして 2 へ。**エージェントが生まれなかったと言い切れる失敗** (起動コマンドが非ゼロ終了 / agentId が返らない) のときだけ、history に 1 行 (`agent-launch: paseo 経路が失敗 (<理由>) — 現行経路で verifier を起動`) を残して 2 へ落ちる。**生まれた後でも permission 待ちで停止したときだけは例外で 2 へ落ちる** (残ったエージェントの扱いと history の文言も同じ節)。
     2. **現行ハーネス経路** — `subagent_type: task-pipeline-verifier` で Agent tool 起動する。agent type が未インストールなら 3 へ落ちる (下記「未インストール環境のフォールバック」に history の 1 行も含めた規定がある)。
     3. **`general-purpose`** — 同じプロンプトのまま起動する。ここまで落ちても成果物と契約は同じで、変わるのは行動境界の裏打ちだけである。
   - **未インストール環境のフォールバック**: `task-pipeline-verifier` は `agents/task-pipeline-verifier.md` を `~/.claude/agents/` に置いて初めて存在する (このリポジトリの `install.sh` が行う)。Agent tool が unknown agent type のエラーを返したら、**同じプロンプトのまま** `subagent_type: general-purpose` で起動し直し、history に「verifier agent type 未インストール — general-purpose で実行」を 1 行残す。skill 単体でも動く状態を保つためで、フォールバックしたこと自体は失敗ではない。

   - **再開時のプロンプト**: `reuse_verifier` が非 null のとき、この文面を送る (経路は下記「再開の経路」。verdict path は同じく `state.ts verdict-path --id <id>` が返すものをそのまま使う)。**実行エージェントが対応したと宣言する文言 (「addressed」「fixed」等) は入れない** — 直っているかどうかは verifier が現物で確かめることであって、オーケストレーターが宣言することではない:
   ```
   Re-verify the same phase against the updated artifacts.
   Your previous verdict for this phase is at <前回の verdict path>.
   phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir: <runs/<id> の絶対パス> / target project: <worktree の絶対パス> / verdict path: <verdict-path が返した新しい path> / review file: <レビュー観点ファイルの絶対パス>
   Write the full verdict JSON to the new verdict path, then return only the minimal verdict JSON.
   ```
   - **再開の経路も 2 段で、上から順に試す**:
     1. **Paseo 経路** — その verifier を `paseo send` で再開する。`send` には `--output-schema` に相当する指定が無いので、判定は verdict ファイル (無ければ `paseo logs <agentId>`) から読む — **読み方の正は `playbooks/agent-launch.md` の経路節**で、ここには重ねて書かない。落ちたら history に 1 行 (`agent-launch: paseo 経路が失敗 (<理由>) — 現行経路で verifier を再開`) を残して 2 へ。
     2. **現行ハーネス経路** — `SendMessage` で再開する。
   - 再開が 2 段とも通らなかったら、**同じ内容で新規起動 (上記フレッシュ起動プロンプト) にフォールバックし**、history に「verifier 再開失敗 — フレッシュ起動」を1行残す (未インストール環境のフォールバックと同型のパターン)。
   - **再開先で解決される provider・model が前回と同じであることの担保は、`run.verifier_session` の一致である。** `reuse_verifier` が非 null になるのは、その verifier を起動したセッションが自分自身のときだけで (`scripts/state-next.ts` の `reuseVerifierOf`)、**同一セッション内では起動引数 (`impl_provider=` / `verify_provider=`) が変わらない**ので解決結果も変わらない。**prefs (`~/.paseo/orchestration-preferences.json`) をイテレーションの途中で書き換えた場合は保証の外**である — state.json は解決結果を持たない (持たせない: スキーマは変えない)。

   - **PASS** → (判定 JSON は verifier が起動時に渡した verdict path へ既に書いている — オーケストレータは書かない) `state.ts advance --id <id> --from <phase> --to <next>` を呼んで phase を進める。次フェーズがあれば実行エージェントへ「`<phase>` verified PASS. Proceed to phase `<next>`.」と送る (**送信手段は起こした経路で決まる** — 手順 4 と `playbooks/agent-launch.md`。再開は background で走り、次の処理はその経路の停止の検知が駆動する)。`advance` が通せるのは**その run の列の隣接辺だけ**で、飛び越し・逆行・列違いは `conflict` になる (辺の一覧は `docs/state-cli-contract.md` の「フェーズ列と advance の辺」)。列の最後のフェーズ (`report` / `pr_fix` / `rebase_fix`) まで PASS したら:
     - `finish=none` → **`--to finalize` まで `advance` してから**レビュー待ち処理へ (finalize は検証対象外だが、列の最後のノードである)。
     - `finish=commit|pr` → 同じく `state.ts advance --id <id> --from <report|pr_fix|rebase_fix> --to finalize` を呼び、実行エージェントへ「`<phase>` verified PASS. Finalize the task (finish mode: `<mode>`, base: `<タスクの base>`).」を送る (送信手段は手順 4 のとおり経路で決まる) (`<phase>` は直前に PASS したフェーズ。`base` が null なら `base:` は省く。**`next` の `tasks[].finalize.rebase_off` が真のときだけ末尾に `, rebase: off` を足す** [= `rebase=off` 指定のとき] — executor は push の直前にも基点を確かめて載せ直すので、切る指示を渡さないと引数が片側にしか効かない)。`FINALIZED — <commit hash / PR URL>` の停止通知でレビュー待ち処理へ。`BLOCKED` 停止なら通常どおり即 blocked。finalize は成果物フェーズではないので検証ゲートは無い。
     - **レビュー待ち処理は `state.ts ship` 1 回である。** どの `kind` (initial / pr_fix / rebase_fix) の finalize から来ても呼ぶ verb は同じで、**呼び分けも順序の制約も無い**:
       ```
       state.ts ship --id <id> --commits <n> [--ref <ref> --branch task-pipeline/<id> --tip <tip> --base <タスクの base>]
       ```
       - **引数の構成は `next` の `tasks[].finalize.ship` が返す** (`ref_kind` = `--ref` に渡すものの種類、`branch` / `base` = そのまま渡す値、`group_flags` = `--commits` が 1 以上のときにまとめて付けるフラグ)。`<n>` だけは git の観測なので自分で取る: `git -C <プロジェクトルート> rev-list --count <base>..<branch>`。**1 以上なら 4 つのグループフラグを全部付ける** (`ref`: `pr` なら PR URL、`commit` ならコミットハッシュ。`tip` は `git -C <プロジェクトルート> rev-parse <branch>`)。**0 なら 4 つとも省略する** (`finish=none`。契約は「4 つとも指定」か「4 つとも省略」のどちらかのみで、片側だけは `usage` になる)。
       - この 1 回の書き込みが、v1 で 3 verb に分かれていた処理をまとめて行う (効果は `docs/state-cli-contract.md` の `ship` 節)。既存の `follow` は保持されるので、押し直しで `fix_attempts` や `handled` が失われる経路は無い。
       - **後続の指示は応答から読む。** 経路の記憶で分岐しない:
         ```json
         {"ok": true, "id": "...", "notify": "initial|update|none", "mark": true|false, "fix_count": 2}
         ```
         - **`mark` が真のときだけ**アダプタで `mark <id> in_review [ref]` を呼ぶ (ref: `pr` なら PR URL、`commit` ならコミットハッシュ、無ければ省く)。偽なら呼ばない — トラッカーは既に in_review のままで、呼べば重複コメントになるだけである。
         - **`notify` が `initial` なら**「最初の 1 回」の通知、**`update` なら**「更新時の通知」を 1 本送る (下記)。`none` (共有された成果物が無い = `finish=none`) なら送らない。
         - **`fix_count`** はこの ship が消費したレビュー指摘の件数で、更新時の通知に添える。
       - history に ref 付きで追記し、1〜3 行で報告する (worktree があればそのパスとブランチ名も添える)。
       - 最後に、`artifact.ref` が PR URL なら**観測プロセスを起動する** (`playbooks/pr-follow.md`)。`ship` の後のタスクは `attention: auto`・`asks` 両方 null なので、そのまま追従対象の導出式を満たす。**`probe.sig` は `ship` が null にしているので、張る前に catch-up 観測が 1 回入る** — 修正を回している間に届いた指摘はそこで回収される。
       - **`ship` が `conflict` を返す唯一の理由は「その run が finalize に居ない」ことである。** `run.phase` を読み直して、advance の抜けを直してから呼び直す。
       - **レビュー待ちにしたら、ユーザーに通知を 1 本送る** (`PushNotification`, `status: "proactive"`)。**パイプラインが人を待ち始める唯一の地点**で、無人運転では次に人が見に来るまでがそのまま滞留時間になるため (実測: 2026-08-01 の 5 本は PR 作成からマージまで 3.8〜10.2 分だったが、これはユーザーが張り付いていた場合の値である)。文面は 200 字未満・1 行・markdown 無しで、**行動できる情報を先に置く**:
         ```
         <id> レビュー待ち: <PR URL> — <タイトルを 40 字程度で>
         ```
         - 送るのは `notify` が `initial` の回 (**最初の 1 回の文面 [上のテンプレート] は変えない**) と、`update` の回 (下記「更新時の通知」)。
         - **ツールが無い環境では何もしない。** 送れなかったことを失敗として扱わず、フェーズも止めない (通知は成果物ではない)。ユーザーが端末の前にいるときは重複なので送られないことがあるが、それも正常である。
         - 通知に載せるのは id・URL・タイトルだけにする。**CI の状態や検証の結果は書かない** — この時点では CI が回り始めてすらいないことがあり、通知は取り消せない。
         - **更新時の通知** (`notify` が `update`): 最初の 1 回と同じ制約 (`PushNotification`, `status: "proactive"`, 200 字未満・1 行・markdown 無し、**CI の状態や検証の結果は書かない**) を引き継いだうえで、次を満たす:
           - 先頭付近に **更新であって新規作成ではないと判別できる語** を置く (例: `更新`) — レビュアーが「もう見た PR か」を一目で判断できるようにするため。
           - **PR URL を含める**。
           - 何が変わったかを 1 語句で添える — `fix_count` が 1 以上なら対応した指摘の件数、衝突解消からの復帰なら載せ直し先。
           - 例: `<id> 更新 (指摘 <fix_count> 件対応): <PR URL>` / `<id> 更新 (載せ直し → <base>): <PR URL>`
           - **素の force push (`playbooks/merge-recovery.md` の「残った PR を新しい基点へ載せ直す」) では送らない** — 詳細と理由はその節に書いてある。
   - **FAIL** → (判定 JSON は verifier が起動時に渡した verdict path へ既に書いている — オーケストレータは書かない) `state.ts phase-fail --id <id> --phase <phase> --expect-attempts <イテレーション冒頭の `next` が返した `tasks[].gate.attempts`> --verifier <この検証エージェントの agentId> --session <自分の id>` を呼んで `attempts` を +1 する (`--expect-attempts` は「この FAIL がどの判定ラウンドに対するものか」の宣言。**`conflict` なら同じ session id の別インスタンスが同じラウンドを既に落としている**ので、二重加算しないよう自分の判定は捨て、このタスクの続きは次のイテレーションの `next` に従う)。実行エージェントへ「Fix required. Read required_fixes from `<verdict path の絶対パス>` and address them in phase `<phase>`.」を送る (送信手段は手順 4 のとおり経路で決まる) (required_fixes の中身をそのまま転記せず、ファイルのパスだけを渡す)。修正・再停止後の再検証は、**`next` の `tasks[].gate.reuse_verifier` が agentId を返したときだけ、その検証エージェントを再開する** (上記「再開時のプロンプト」と「再開の経路」)。null なら上記のとおり新規に (フレッシュに) 起動する。再開が 2 段とも通らなかったら**同じ内容で新規起動し**、history に「verifier 再開失敗 — フレッシュ起動」を1行残す。

### 検証ゲートの絶対規則

フェーズ成果物は、**このイテレーションでオーケストレーターが起動または再開した検証エージェント**の PASS なしには、**どんな理由があっても** 次フェーズへ進めない。実行エージェントの self-check、過去の PASS、成果物への自分の印象は代替にならない。

**再開してよいのは、直前に同じフェーズで FAIL を出した検証エージェントだけである** (`next` が返す `reuse_verifier`)。フェーズが進んだら再開しない — 別フェーズの判断は別の検証である。再開しても**実行エージェントのコンテキストは一度も入らない**ので独立性は保たれる (`references/verifier.md` が禁じているのは実行エージェントの作業経緯を知ることであって、verifier が自分の前回の判断を覚えていることではない)。

### リトライ上限

1 フェーズにつき検証は最大 3 回 (初回 + リトライ 2 回)。3 回目も FAIL ならタスクを blocked にする: `state.ts block --id <id> --reason <最後の FAIL 理由>` を呼び (`run` は消え `session` は null に戻る)、アダプタで `mark <id> blocked <理由>`、成果物と判定はそのまま残す。**ループは止めず**、次のタスクを次イテレーションで進める。

## ペーシングと枯渇

- タスクをレビュー待ち / blocked にしたら → /loop dynamic 配下なら ScheduleWakeup 60 秒で次イテレーションへ (そこで次の 1 件を決める)。**マージを待たない** — レビュー待ちの上限 (`max_open`) に達していなければ、次のイテレーションはそのまま次のタスクの実行に入る。PR の追従はその裏で 観測プロセスが続ける。
- 飛行中にターンを終えるとき → フォールバック 1800 秒 (上記)。
- ターンの終わりに所有を手放すのは、**ループを止めるときだけ** (上記「セッションの所有権」)。飛行中や追従中にターンを終えるときは何も手放さない — **現行ハーネス経路の実行エージェント/観測プロセスは自分の session id を撫で続けるので、そのセッションが次のイテレーションでも同じ id で生き続ける環境 (対話セッション、Claude Code ハーネスの `/loop` skill 配下) では、所有は維持される。`paseo loop` のようにイテレーションごとにセッション/エージェントが入れ替わる環境では、Paseo 経路の executor は所有セッションの heartbeat を撫でず、オーケストレーター自身の session id もイテレーションごとに変わるため、この前提は成立しない** — この環境での孤児の即時回復は `playbooks/inflight.md` の「孤児の強い証拠」に委ねる (詳細は `docs/loop-session-orphan-2026-08.md`)。
- PR 追従で待つとき (push 直後、`wait`、`clean`) → 変化の検知は 観測プロセスの終了通知が駆動する。ただし /loop dynamic 配下なら、フォールバックの ScheduleWakeup (3600 秒、同じ prompt) を予約してからターンを終える — 観測プロセスと終了通知はセッションと共に失われるため、これが無いとセッション死でパイプライン全体の再開契機が消える (通知が先に来れば wakeup は空振りするだけで害は無い)。ターンを終える前に 観測プロセスが起動されていることも確かめる。**例外は上記 `error` の扱いで、あれは再試行を次のイテレーションに送るために意図して張らずに終える** (張ると catch-up 観測の起点になる張り直し経路に入らなくなるため)。

### 停滞 (新しい着手ができない状態)

パイプラインが新しいタスクを着手できない状態を **停滞** と呼び、state.json の `stalled` (種類) と `stalled_since` (その状態に入った時刻) に記録する。種類は 2 つだけである:

- `"depleted"` — 承認の `list` が `{"tasks": []}` を返した (候補そのものが尽きた。`playbooks/depleted.md`)
- `"max_open"` — レビュー待ちの上限に達していて着手を見送った (上記「毎イテレーションの手順」1)
記録と計時の規則 (回数ではなく時刻で数える理由は `docs/state-machine.md`):

- **毎イテレーション、分岐が決まった時点で `state.ts stalled-set --value <値>` を呼ぶ。渡す値は `next` の `stalled.set_to` が返す**: `"null"` (着手した/承認へ進んだ/自分の飛行中タスクがある) / `"max_open"` (レビュー待ちの上限で見送った) / `"defer"` (`tracker-list` の結果次第 — `list` が `{"tasks": []}` を返したら `stalled.defer.if_empty` の値、候補があれば `stalled.defer.otherwise` の値を渡す) / `"keep"` (停滞の 2 種類のどちらでもないので**呼ばない**)。`null` から非 null に変わるときだけ現在時刻が入り、**停滞が続いている間は `--bump true` を付けない限り進まない** (種類が入れ替わっても同じ)。パイプライン全体の状態であり、どれか 1 セッションが着手できたなら `null` に戻る。
- **PR に何かが起きたら `--bump true` を付けて `stalled-set` を呼ぶ** (現在の `stalled` の値をそのまま `--value` に渡す): 観測プロセスが `changed` で終わった / 観測サブエージェントが `fix`/`merged`/`closed` を返した / `probe.head`/`probe.ci` が変わった、のいずれか。`timeout` 終了と、`wait`/`clean` のまま変化が無い観測、`error` では進めない。**この判定は外部観測なので `next` には出せない** (設計 5.2 の「観測結果」)。
- **追従の打ち切り**: イテレーションの終わりに **`next` の `stalled.cutoff`** を見る。**真なら追従を終えてループを止める** (最終報告を出し、`playbooks/depleted.md` の手順 2 と同じ手順で止める — 観測プロセスを止め `state.ts release --id <id>` を呼んでから、dynamic は ScheduleWakeup `stop: true`、固定間隔は CronDelete)。追従中の PR が 1 本も無いまま停滞し続けた場合も同じく `cutoff` が真になる (枯渇時は同手順書の手順 2 が計時を待たず即座に止める)。止めるときの最終報告は同手順書の手順 1 と同型だが、`stalled.current` が `"max_open"` のときは内訳の代わりに**着手できずに残っている候補を順位付きで並べる**。

## 報告規律

Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.
レビュー待ちにした報告は「終わった」とだけ言わず、report.md のパス、検証 PASS の判定パス、レビュー対象の ref (PR URL / コミットハッシュ) を添える。blocked の報告は理由と、そこまでの成果物パスを添える。
