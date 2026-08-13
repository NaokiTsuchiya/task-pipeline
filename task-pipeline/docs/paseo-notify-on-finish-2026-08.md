# Paseo の `notifyOnFinish` の実測 (2026-08)

`docs/paseo-subagent-2026-08.md` の可否表が唯一「未実測」と名指していた項目 — MCP tool `create_agent` の `notifyOnFinish` — を実測した記録である。executor を Paseo 経路へ移すときに停止検知を「通知」で組めるか「ポーリング」で組むかを、この記録の観測で決める。**この記録は実測だけを扱い、`SKILL.md` / `references/` / `playbooks/` / `tests/` は変更していない** (書き換えは #111)。

節番号は gh-113 の要求に対応する: 実測 A = 要求 2、実測 B = 要求 1 (a)、実測 C = 要求 1 (b)、実測 D = 要求 1 (c)。

## 実測の条件

- **CLI / daemon**: どちらも 0.3.1 (`paseo --version`)。`paseo daemon status` の Server ID `srv_HRfS2O-kbXEW`、Home `/Users/naoki/.paseo`、Listen `127.0.0.1:6767`、Local Daemon running / Connected Daemon reachable、PID 88777、Started `2026-08-12T13:20:47.631Z`。
- **`paseo` は PATH に在る**: `which -a paseo` → `/Users/naoki/.local/bin/paseo`。**`docs/paseo-subagent-2026-08.md` の条件節 (「PATH に無い」) は #102 当時の状態で、現在は当てはまらない。** 以下 `$P` はこのパス。
- **プロバイダの在庫** (`$P provider ls`): claude / omp / junie が available、codex / copilot / opencode / pi が unavailable (#102 と同じ)。
- **呼び出し側**: この記録を取ったのは Claude Code のセッション (`CLAUDE_CODE_SESSION_ID` 設定済み、**`PASEO_AGENT_ID` 未設定**、pid 67173) で、Paseo エージェントの中ではない。このセッションには Paseo の MCP tools が無い (`ToolSearch "select:list_providers,create_agent,list_agents,send_agent_prompt"` → `No matching deferred tools found`)。**そのため `create_agent` の観測はすべて「Paseo エージェントを 1 体起こし、その中から呼ばせる」形で取っている。**
- **`~/.paseo/orchestration-preferences.json` の `providers.impl` は `omp/anthropic/claude-sonnet-5`** で、`preferences` に「Claude 系のモデルは native の claude プロバイダではなく必ず omp 経由で指定する」がある。要求 2 は `claude` provider を名指すが、この prefs の下で executor を起こす worker は実際には omp になるため、**実測 A では claude と omp の両方を観測した。**
- **作ったエージェント (7 体、すべて `--label gh113=<役割>` 付き)**。`LastUsage` は archive **前**に `$P inspect <id> --json` で採った実値:

  | id | label | provider / model / mode | 役割 | `LastUsage` (InputTokens / OutputTokens / CachedTokens / CostUsd) |
  | --- | --- | --- | --- | --- |
  | `a50cc5b3` | `parent-claude` | claude / `claude-haiku-4-5` / `bypassPermissions` | 実測 A・B・C・D の親 | 16:17 時点 `15 / 660 / 65955 / 0.08237580000000001`、archive 直前 `15 / 580 / 71024 / 0.12355530000000002` |
  | `623197c7` | `child-claude` | claude / `claude-haiku-4-5` / `bypassPermissions` | 実測 A で親が作った子 | `17 / 190 / 45874 / 0.0361424` |
  | `a9981ecf` | `parent-claude2` | claude / `claude-haiku-4-5` / `bypassPermissions` | 実測 A の副次観測 (ToolSearch ループで自走停止せず、`$P stop` で止めた) | 停止後の値は `0 / 0 / 0 / 0` |
  | `8258c796` | `parent-omp` | omp / `anthropic/claude-haiku-4-5` / `full` | 実測 A・B・C の omp 側の親 | `64 / 3068 / 246802 / 0.22499020000000003` |
  | `c4eaba64` | `child-omp2` | claude / `claude-haiku-4-5` / `bypassPermissions` | omp の親が作った子 | `69 / 1136 / 325387 / 0.07131169999999999` |
  | `e000e418` | `child-claude3` | claude / `claude-haiku-4-5` / `bypassPermissions` | 実測 B・C の子 | **採れず** (親を archive した時点で巻き添え archive され、`LastUsage` は null になっていた) |
  | `ab83e786` | `child-orphan` | claude / `claude-haiku-4-5` / `bypassPermissions` | 実測 D-1 の子 | **採れず** (同上。D-1 は親の archive が観測対象そのもの) |

- **`LastUsage` は「最後の run」の値であって累積ではない。** 同じ親 `a50cc5b3` を 2 回採った値で OutputTokens が `660` → `580` と**減っている** (CostUsd は `0.0824` → `0.1236` と増える)。`docs/paseo-subagent-2026-08.md` の可否表が「累積か最後の run かは未検証」と書いていた点は、**最後の run 側**で確定する。役割別コストを回収するなら run ごとに採るしかない。
- **実測に使った cwd はすべて scratchpad** (`<scratch>/gh-113`)。リポジトリのファイルは実測に使っていない。

## 実測 A: `claude` provider の worker から `create_agent` を呼べるか (要求 2)

### 実行したコマンド / ツール呼び出し

```
$P run -d --provider claude --model claude-haiku-4-5 --mode bypassPermissions \
  --label gh113=parent-claude --title "gh-113 parent (claude)" --cwd <scratch>/gh-113 \
  --json "$(cat <scratch>/gh-113/prompt-claude.txt)"
```

プロンプトの骨子 (実測では全文を渡した): STEP1 = 自分が持つ Paseo MCP サーバ由来のツール名を逐語で列挙 (無ければ `NO-PASEO-MCP`)、STEP2 = `create_agent` があれば **1 回だけ** 呼ぶ (`title` / `provider: claude/claude-haiku-4-5` / `notifyOnFinish: true` / `labels: {"gh113":"child-claude"}` / `initialPrompt` は「`sleep 90` の後に `PHASE research DONE — …` の 1 行だけを返す」)、STEP3 = 子を待たずにターンを終える、STEP4 = 後で再開されたら受信本文を逐語で書き出す。

omp 側は同じ骨子で `--provider omp --model anthropic/claude-haiku-4-5 --mode full --label gh113=parent-omp`。

観測は `$P logs <id> --tail <n>` / `$P inspect <id> --json` / `$P ls -a -g --label <k>=<v> --json` で取った。

### 観測結果

**claude worker (`a50cc5b3`)**: `mcp__paseo__*` が **59 個**見えている (件数は `$P logs a50cc5b3 --tail 400 | grep "^STEP1-TOOLS:" | tr ',' '\n' | grep -c "mcp__paseo__[a-z]"` の出力。以下は STEP1 の回答からの抜粋、逐語):

```
STEP1-TOOLS: mcp__paseo__archive_agent, mcp__paseo__archive_workspace, mcp__paseo__browser_back, …
mcp__paseo__create_agent, … mcp__paseo__list_agents, mcp__paseo__list_models,
mcp__paseo__list_providers, … mcp__paseo__send_agent_prompt, … mcp__paseo__update_schedule
```

- **これらは deferred tool として配られている**。ログには `[ToolSearch]` が挟まり、エージェント自身が「I see `mcp__paseo__create_agent` in the list, but it seems to be a deferred tool requiring ToolSearch」と書いている。
- 呼び出しはログに残っている (逐語):

  ```
  [Create Agent] {"title":"gh-113 notify child","provider":"claude/claude-haiku-4-5","initialPrompt":"…","notifyOnFinish":true,"labels":{"gh113":"child-claude"}}
  STEP2-RESULT: {"agentId":"623197c7-34a9-426e-b53e-225d1175a7a6","type":"claude","status":"running",…,
  "guidance":"You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives."}
  ```

- 子は実在する: `$P inspect 623197c7 --json` → `"ParentAgentId": "a50cc5b3-…"`、`"Mode": "bypassPermissions"`。
- **副次観測 (自走停止しない個体)**: 同じ provider / model / mode で立てた 2 体目 `a9981ecf` は `create_agent` に到達しないまま 2 分以上走り続け、`$P stop a9981ecf` で止めた。ログの `[ToolSearch]` の件数は `$P logs <id> --tail 400 | grep -c '^\[ToolSearch\]'` で **`a9981ecf` が 38、`a50cc5b3` が 1** — 同じ条件でも**deferred tool の読み込みが 1 回で抜けるかは個体差がある。**

**omp worker (`8258c796`)**: 同じツール群を `_create_agent` / `_send_agent_prompt` / `_list_agents` … の名前で持っており、`[Create Agent]` の呼び出しがログに残った。ただし 1 回目はサーバ側で弾かれた (逐語):

```
STEP2-RESULT: cannot inherit mode 'full' from caller (provider 'omp') for new agent (provider 'claude').
Pass an explicit mode. Available modes for 'claude': plan, default, acceptEdits, auto, bypassPermissions
```

`settings: {"modeId": "bypassPermissions"}` を明示した 2 回目は成功し (`ROUND2-RESULT: c4eaba64-…`)、`$P inspect c4eaba64 --json` は `"ParentAgentId": "8258c796-…"` を返した。

### 判定

**条件付きで可。** `claude` provider の worker からも `omp` の worker からも `create_agent` は呼べ、子は実際に作られ、`ParentAgentId` は caller の id で埋まる。条件は 3 つ:

1. **claude では paseo の MCP tools が deferred で配られる** (`mcp__paseo__*`)。使う前に `ToolSearch` が要り、**そこで足踏みする個体がある** (`a9981ecf`)。無人で回すなら、起動プロンプト側で「スキーマ取得は 1 回」と明示する等の手当てが要る。
2. **子の mode は caller から継承され、provider が違うと継承に失敗する。** 別 provider の子を作るときは `settings.modeId` の明示が必須 (上のエラー逐語)。
3. **呼べるのは Paseo エージェントの中だけである。** この記録を取った Claude Code セッション (`PASEO_AGENT_ID` 未設定) には `mcp__paseo__*` が無い (実測の条件節)。**現行の task-pipeline のオーケストレータがハーネス側のセッションのままなら、通知経路には乗れない。**

## 実測 B: 通知が実際に親のターンを再開させるか (要求 1 a)

### 実行したコマンド / ツール呼び出し

親が「待っていない」ことを担保するため、**親のターンが終わって idle になった後に子が終わる**構成にした。親 (`a50cc5b3` / `8258c796`) にフォローアップを送り、子を 1 体作って**他のツールを一切呼ばずにターンを終えさせた**:

```
$P send a50cc5b3 --prompt-file <scratch>/gh-113/round2-claude.txt --no-wait --json
$P send 8258c796 --prompt-file <scratch>/gh-113/round2-omp.txt  --no-wait --json
```

プロンプトの骨子: `create_agent` を 1 回だけ呼ぶ (`notifyOnFinish: true`、`settings.modeId: bypassPermissions`、子の仕事は「`date -u +%FT%TZ` を 10 回**別々の**ツール呼び出しで実行してから `PHASE implement DONE — …` の 1 行を返す」) → **待たずに `PARENT-TURN-2-END` でターンを終える** → 後で再開されたら受信本文を逐語で書き出す。

観測 (時刻はコマンドを打った側で `date -u` を採った):

```
$P wait a50cc5b3 --timeout 90 --json     # 親が idle になるまで
$P ls -a -g --label gh113=child-claude3 --json
$P ls -a -g --label gh113=child-omp2 --json
$P inspect <親> --json / $P inspect <子> --json
```

### 観測結果

- 親のターンは `PARENT-TURN-2-END` で終わり、`$P wait` は `"status": "idle"` を返した (claude 親 `UpdatedAt 2026-08-13T16:22:53.236Z` / omp 親 `16:22:53.640Z`)。
- **その直後 `T=16:22:55Z` の時点で、親 2 体が `idle`、子 2 体が `running`** — 親が待たずに手放している状態を直接観測した:

  ```
  --- child-claude3  [('e000e418-…', 'running')]
  --- child-omp2     [('c4eaba64-…', 'running')]
  claude parent: idle 2026-08-13T16:22:53.236Z
  omp parent:    idle 2026-08-13T16:22:53.640Z
  ```

- 子は `16:23:18` に idle になり、**その直後に親が `running` へ戻った** (`$P inspect 8258c796` → `running 2026-08-13T16:23:19.088Z`)。両方の親が再開後のターンで指示どおり受信本文をファイルへ書き出した (`notification-claude3.txt` / `notification-omp2.txt`、内容は実測 C)。
- **副次観測 (走行中のターンは中断される)**: 実測 A の 1 回目は子が 5 秒で終わってしまい (`623197c7` の `CreatedAt 16:17:28.714` → `UpdatedAt 16:17:33.666`)、**親がまだ最初のターンを終える前に通知が届いた**。このとき親のログには指示した `PARENT-TURN-1-END` が現れず、代わりに受信本文の先頭に `[Request interrupted by user]` が付いた (`notification-claude.txt` の 1 行目)。つまり **通知は親の走行中のターンを中断して割り込む**。

### 判定

**可。** `create_agent(notifyOnFinish: true)` の子が停止すると、親が待っていなくても (ターンを終えて idle でも) 親のターンが自動的に再開する。claude / omp の両方で観測した。条件:

- **親が走行中なら、そのターンは中断される。** 通知は「次のターンで処理される」のではなく、その場で割り込む。**他の仕事をしている最中でも割り込まれる**ので、複数タスクを併走させるオーケストレータでは、この割り込みが進行中の処理を切る前提で設計が要る (現行ハーネスの `PushNotification` はターンを切らない)。

## 実測 C: 通知の中身から agentId と停止理由を取り出せるか (要求 1 b)

### 実行したコマンド / ツール呼び出し

実測 B と同じ 1 回の試行の続きで観測した。親には「受信した本文を逐語でファイルへ書き、逐語で答えよ」と指示してある。omp 側は本文が要約されていたので、後追いで 4 問を送って逐語再現させた:

```
$P send 8258c796 --prompt-file <scratch>/gh-113/omp-confirm.txt --json
（Q1: "<paseo-system>" を含んでいたか / Q2: UUID を含んでいたか / Q3: finished・errored・needs permission のどれを含んでいたか / Q4: 逐語再現）
```

### 観測結果

claude 親が書き出したファイル (`notification-claude3.txt`、逐語):

```
<paseo-system>
Agent e000e418-b9d5-45da-915a-d9f0df180277 (gh-113 notify child 3) finished.

<agent-response>
PHASE implement DONE — /tmp/gh-113/child3-artifact.md
</agent-response>
</paseo-system>
```

omp 親の逐語再現 (Q4 の回答):

```
<paseo-system>
Agent c4eaba64-e894-4b58-a378-f0d0714e20e7 (gh-113 notify child omp2) finished.

<agent-response>
PHASE implement DONE — /tmp/gh-113/child-omp2-artifact.md
</agent-response>
</paseo-system>
```

- 取り出せるものは 3 つ: **(i) 子の agentId** (`Agent <uuid>` の行)、**(ii) 停止理由** (同じ行の末尾、ここでは `finished`)、**(iii) 子の最終メッセージ = task-pipeline の protocol 行** (`<agent-response>` の中身、`PHASE implement DONE — …` がそのまま入っている)。
- **受け手が要約してしまうことがある**: omp 親は「逐語で書け」の指示にもかかわらず、最初は `<agent-response>` の中身だけをファイルへ書いた (`notification-omp2.txt` は `PHASE implement DONE — /tmp/gh-113/child-omp2-artifact.md` の 1 行のみ)。後追いの Q1〜Q4 で、**受け取った本文自体は封筒ごと届いていた**ことが確認できた (Q1: YES / Q2: YES + UUID / Q3: finished)。
- 停止理由のうち実際に観測したのは **`finished` だけ**である。`errored` / `needs permission` は今回発生させていない (未実測、下記 D の判定と同じ扱い)。

### 判定

**可 (取り出せる)。** 通知本文は `<paseo-system>` 封筒に包まれた `Agent <agentId> (<title>) <reason>.` + `<agent-response>…</agent-response>` で、agentId・停止理由・protocol 行の 3 つがそのまま取れる。条件:

- **受け手のモデルは本文を要約しうる。** オーケストレータが agentId で振り分ける (現行 SKILL.md の「停止通知は送り元の agentId と各タスクの `executor` を突き合わせて振り分ける」) なら、**封筒を逐語で扱う規律をプロンプト側に書くか、本文を機械的に解析する**必要がある。
- 観測できた `reason` は `finished` のみ。`errored` / `needs permission` の文言は**未実測**。

## 実測 D: 親が別セッション / 別プロセスになったときに何が起きるか (要求 1 c)

### 実行したコマンド / ツール呼び出し

**D-1 (親が居なくなる)**: 親 `a50cc5b3` に 3 回目のフォローアップを送り、`notifyOnFinish: true` の子を 1 体作らせて (仕事は `date` を **20 回**別々に呼ぶ、`--label gh113=child-orphan`) ターンを終えさせた。子が走行中に、**このセッション (Paseo エージェントではない) から**親を archive した:

```
$P send a50cc5b3 --prompt-file <scratch>/gh-113/round3-claude.txt --json   # → ROUND3-RESULT: ab83e786-…
$P inspect a50cc5b3 --json          # archive 前に LastUsage を採る
$P archive a50cc5b3 --json          # 16:24:47
$P inspect ab83e786 --json          # 直後の子の状態
$P logs ab83e786 --tail 6
ls -l <scratch>/gh-113/notification-orphan.txt
```

**D-2 (別プロセスが引き取る)**: 通知を受け取らないプロセス (このセッション。`PASEO_AGENT_ID` 未設定、pid 67173) から、子の停止と停止理由を読めるかを確かめた:

```
$P inspect e000e418 --json
$P wait e000e418 --timeout 5 --json
$P logs e000e418 --tail 2
```

### 観測結果

**D-1**:

```
$ $P archive a50cc5b3 --json
{"agentId":"a50cc5b3-…","status":"archived","archivedAt":"2026-08-13T16:24:47.944Z"}

$ $P inspect ab83e786 --json     # 走行中だった子
{"Status":"closed","Archived":true,"ArchivedAt":"2026-08-13T16:24:49.781Z",
 "UpdatedAt":"2026-08-13T16:24:49.781Z","ParentAgentId":"a50cc5b3-…"}
```

- **親を archive すると、走行中の子が 1.8 秒後に archive される** (#102 の副次観測は完了済みの子で起きたが、ここでは**走行中の子が打ち切られた**)。子のログは 20 回のうち 5 回目の `[Shell] date -u +%FT%TZ` で途切れており、最終メッセージ (`PHASE orphan DONE — …`) は出ていない。
- **通知はどこにも届かなかった**: `notification-orphan.txt` は作られていない (`ls` → `No such file or directory`)。archive 済みの親のログにも再開の形跡は無い。
- 巻き添えは同じ親を持つ**完了済みの子にも及ぶ**: `e000e418` (実測 B・C の子) も `Archived: true` になり、`LastUsage` は null になった (条件節の表)。

**D-2**:

```
$ $P wait e000e418 --timeout 5 --json
status= idle
'Agent is idle.\nLast 5 activity items:\n[Shell] date -u +%FT%TZ\n…\nPHASE implement DONE — /tmp/gh-113/child3-artifact.md'

$ $P logs e000e418 --tail 2
[Shell] date -u +%FT%TZ
PHASE implement DONE — /tmp/gh-113/child3-artifact.md
```

- **通知を受ける資格を持たないプロセスからでも、`wait` / `logs` / `inspect` で「停止したか」と「protocol 行」の両方が読める。** archive 済みのエージェントでも読めた (上の出力は archive 後に採ったもの)。
- ただし `logs` は **cwd が消えていると読めない**: 別の (この実測とは無関係な) エージェントで `$P logs 706dcc5` → `Error: Failed to get logs: Working directory does not exist: …`。worktree を消す運用と併せると、ポーリング側の読み取りも失われうる。

**実測できなかった点** (推定で埋めない):

- **親が `closed` (プロセスだけ終了して archive はされていない) 状態での配送**: `closed` にするための CLI が無い (`$P agent --help` にあるのは `stop` = 中断、`archive`、`delete` で、セッションプロセスだけを終わらせる口は無い)。daemon の再起動なら作れるが、**同じ daemon で無関係のタスクのエージェントが稼働中だったため実行しなかった**。
- **`errored` / `needs permission` の通知**: 今回の子はどちらの状態にもならなかった (実測 C)。
- **通知先の付け替え (別のエージェントが引き取る)**: 通知先は作成時の caller に紐づく。`$P send`・`$P agent --help`・`create_agent` の入力のどれにも「既存の子の通知先を差し替える」口は見当たらなかったが、**付け替えを試みるコマンドを実行してはいない**ので、これは help の読みであって実測ではない。

### 判定

**条件付きで不可。** 親が消えれば通知は届かず、しかも**子ごと道連れになる**。引き取り (takeover) の観点では:

1. **親を archive すると走行中の子が打ち切られる** — オーケストレータ側の後始末が、実行中の executor を殺す。
2. **通知は作成時の caller にしか行かない** — 別のセッションがタスクを引き取っても、そのセッションに通知は来ない。
3. **一方で、通知を受けない立場からでも停止と protocol 行は読める** (D-2)。**引き取り経路は通知ではなくポーリングで組むしかない。**

## 参考: 実装の静的読み (実測ではない)

以下は `/Applications/Paseo.app/Contents/Resources/app.asar` (0.3.1) を読んで得た裏付けである。**実測ではないので、上の判定の根拠には使っていない** (上の観測と一致することの確認としてのみ載せる)。

- 通知の仕込みは `create_agent` のハンドラ内の `if (input.kind === "mcp" && input.notifyOnFinish && input.callerAgentId && initialPromptStarted)` にある。**`kind === "mcp"` が条件なので、CLI (`paseo run`) 経由の作成では通知は仕込まれない** — 可否表 280 行が help 出力から言っていたことと一致する。
- 本文の組み立ては `formatFinishNotificationBody` (`Agent ${childAgentId} (${title}) ${reason}.` + `<agent-response>`)、封筒は `formatSystemNotificationPrompt` (`<paseo-system>…</paseo-system>`)。実測 C の逐語と一致する。
- `reason` は lifecycle から `errored` / `finished` / `needs permission` の 3 種。
- 配送は `sendPromptToAgent(..., { unarchive: false })` → `startAgentRun(..., { replaceRunning: true })`。実測 B の「走行中のターンが中断される」「archive 済みの親には届かない」と一致する。
- `cascadeArchiveChildren` のコメント: "Archiving the parent cascades to those children so subagent fleets don't outlive their orchestrator." 実測 D-1 と一致する。

## 停止検知の推奨 (要求 4)

**推奨: (b) ポーリング経路を基本に据える。(a) 通知経路は、オーケストレータ自身が Paseo エージェントである場合に限って重ねられる任意の高速化として扱う。**

根拠 (すべて上の実測を指す):

1. **通知経路は「オーケストレータが Paseo エージェントであること」を要求する** — 実測 A の判定 3。現行のオーケストレータがハーネス側のセッションのままなら (`PASEO_AGENT_ID` 未設定、`mcp__paseo__*` 無し。実測の条件節)、通知経路は成立しない。ポーリング経路はその立場からでも成立する (実測 D-2)。
2. **引き取り (takeover) に通知は追随しない** — 実測 D の判定 2。`playbooks/inflight.md` の `set-takeover` / `takeover` が想定する「別セッションが引き取る」場面では、通知は元の caller にしか行かない。**ポーリング経路の受け皿はどちらを選んでも必要**であり、通知経路を採ってもこれを削れない。
3. **後始末が実行中の executor を殺す** — 実測 D の判定 1。親を archive すると走行中の子が打ち切られる。通知経路で親子関係を作ると、オーケストレータ側の掃除が実行中のタスクを壊しうる。ポーリング経路 (`paseo run -d` で起こす) なら親子関係を作らずに済む。
4. **通知は走行中のターンを中断する** — 実測 B の副次観測。task-pipeline は 1 セッションで複数タスク (新規 1 + 仕上げ 1) を併走させるので、別タスクの処理中に割り込まれる形になる。現行ハーネスの停止通知にはこの割り込みが無い。
5. **claude worker では MCP tool が deferred で、読み込みに嵌まる個体がある** — 実測 A の判定 1・副次観測。無人運転の入口としては不安定要素が 1 つ増える。
6. **ポーリング側で必要な情報は揃っている** — 実測 D-2。`paseo wait <id> --timeout <n> --json` は idle なら即返って「最後の活動 5 件」に protocol 行を含み、`paseo logs <id> --tail 2` は最終メッセージを逐語で返す。`inspect --json` の `Status` と併せれば、`inflight.md` の `wait` / `status-check` がそのまま受け皿になる。

**通知経路を採る条件** (満たせるなら (a) を重ねてよい): オーケストレータ自身が Paseo エージェントであること (実測 A-3)、通知の封筒を逐語で扱い agentId で振り分けること (実測 C の判定)、割り込みを前提に併走を組むこと (実測 B の判定)、そして**引き取りと後始末はポーリング側に残すこと** (実測 D の判定 1・2)。

**なお、現行のハーネス経路は Paseo の上でも生きている** (副次観測): 別セッションが Paseo 上で走らせている claude エージェント `6006ef53-…` (provider claude / cwd はこのリポジトリ) のログを `$P logs 6006ef5 --tail 400 | grep -oE '^\[[A-Za-z ]+\]' | sort | uniq -c` で数えると、`[Task Notification]` 16 件・`[ScheduleWakeup]` 7 件・`[SendMessage]` 4 件が出ており、**Claude Code の停止通知は Paseo 上の claude エージェントの中で現に機能している**。executor を Paseo エージェントに置き換えなくても、オーケストレータごと Paseo の上へ移すだけなら停止検知は今のまま動く。この観測は他セッションのログを読んだものであり、この実測で作った統制下のものではない。

## エージェントの後始末 (要求 5)

`LastUsage` はすべて archive **前**の `inspect` から採ってある (条件節の表)。archive 後は null になる (`a50cc5b3` を archive 後に `inspect` → `"LastUsage": null`)。

```
$ for a in 8258c796 a9981ecf c4eaba64 623197c7 ab83e786 a50cc5b3; do $P archive $a --json; done
{"agentId": "8258c796-1996-4097-abc8-e8a1d5e5ba7a", "status": "archived", "archivedAt": "2026-08-13T16:26:02.444Z"}
{"agentId": "a9981ecf-a9a3-40c6-bf8c-f56793c6cbc8", "status": "archived", "archivedAt": "2026-08-13T16:26:03.618Z"}
{"error": {"code": "AGENT_ALREADY_ARCHIVED", "message": "Agent c4eaba6 is already archived", "details": "Archived at: 2026-08-13T16:26:02.490Z"}}
{"error": {"code": "AGENT_ALREADY_ARCHIVED", "message": "Agent 623197c is already archived", "details": "Archived at: 2026-08-13T16:24:48.584Z"}}
{"error": {"code": "AGENT_ALREADY_ARCHIVED", "message": "Agent ab83e78 is already archived", "details": "Archived at: 2026-08-13T16:24:49.781Z"}}
{"error": {"code": "AGENT_ALREADY_ARCHIVED", "message": "Agent a50cc5b is already archived", "details": "Archived at: 2026-08-13T16:24:47.944Z"}}
```

`AGENT_ALREADY_ARCHIVED` の 4 件はいずれも子で、`Archived at` は親を archive した時刻の直後である (実測 D-1 の巻き添え archive)。

確認 (`ls` は既定で archived を除外するので、`-a` 付きで見えて `-a` 無しで 0 件なら archived):

```
$ for l in parent-claude parent-claude2 parent-omp child-claude child-claude2 child-claude3 child-omp2 child-orphan; do
    printf "%-16s " "$l"; $P ls -a -g --label gh113=$l --json | …; done
parent-claude    [('a50cc5b', 'idle')]
parent-claude2   [('a9981ec', 'closed')]
parent-omp       [('8258c79', 'closed')]
child-claude     [('623197c', 'closed')]
child-claude2    none
child-claude3    [('e000e41', 'idle')]
child-omp2       [('c4eaba6', 'closed')]
child-orphan     [('ab83e78', 'idle')]

$ for l in parent-claude parent-claude2 parent-omp child-claude child-claude3 child-omp2 child-orphan; do
    printf "%-16s " "$l"; $P ls -g --label gh113=$l --json | …; done
parent-claude    0 active
parent-claude2   0 active
parent-omp       0 active
child-claude     0 active
child-claude3    0 active
child-omp2       0 active
child-orphan     0 active
```

`child-claude2` が `none` なのは、実測 A の副次観測 (`a9981ecf` が ToolSearch から抜けられず) でこのラベルの子が作られなかったためである。**この実測で作った 7 体はすべて archived** で、稼働中のものは残っていない。

**workspace も残る**: `paseo run --cwd <path>` は同じ cwd でも呼ぶたびに新しい local workspace を作った (3 回の `run` で `wks_5e3dbe98…` / `wks_6b61bb2f…` / `wks_e1de0b32…` の 3 件)。エージェントの archive では消えないので、`$P workspace archive <id>` で 3 件とも畳んだ (各 `{"status":"archived"}`)。後始末では**エージェントと workspace の両方**を数える必要がある。
