# Paseo のサブエージェント経路の実測 (2026-08)

task-pipeline のサブエージェント機構を Claude Code のハーネス固有機能 (Agent tool / SendMessage / PushNotification / ScheduleWakeup / `CLAUDE_CODE_SESSION_ID`) から Paseo のエージェント機構へ移せるか。移行計画の前提になる 6 点 (gh-102 の「現状」1〜6) を実測した記録である。**この記録は実測だけを扱い、SKILL.md / references / playbooks は変更していない。**

以下の節番号は gh-102 の「現状」1〜6 に 1 対 1 で対応する。

## 実測の条件

- **CLI / daemon**: どちらも 0.3.1。`paseo daemon status` の Home `/Users/naoki/.paseo`、Listen `127.0.0.1:6767`、Local Daemon running / Connected Daemon reachable。
- **`paseo` は PATH に無い** (`which -a paseo` → `paseo not found`。`~/.local/bin` に symlink 無し)。実測はすべて実体 `/Applications/Paseo.app/Contents/Resources/bin/paseo` を直接起動して行った。以下 `$P` はこのパス。
- **呼び出し側**: この記録を取ったのは Claude Code のセッション (`PASEO_AGENT_ID` 未設定、`CLAUDE_CODE_SESSION_ID` は設定済み) で、Paseo エージェントの中ではない。そのため「エージェントの中から呼ぶ」観測 (実測 1・5) は、親エージェントを 1 体作ってその中で実行させた。
- **プロバイダの在庫** (`$P provider ls`): claude / omp (Oh My Pi) / junie が available、codex / copilot / opencode / pi は unavailable。
- **作ったエージェント (6 体、すべて `--label gh102=<役割>` 付き)**。`LastUsage` は archive 前に `$P inspect <id> --json` で採った実値:
  - `f0bc937d` (`gh102=smoke`) — claude / `claude-haiku-4-5` / mode `default` (`--mode` 省略) / cwd は scratchpad。CLI の外形確認用。`LastUsage`: InputTokens 10, OutputTokens 47, CachedTokens 18763, CostUsd 0.0275853
  - `06e0fd00` (`gh102=parent`) — claude / `claude-haiku-4-5` / mode `bypassPermissions`。実測 1・4 の親。`LastUsage`: InputTokens 16, OutputTokens 336, CachedTokens 65708, CostUsd 0.09204919999999998
  - `74b7f359` (`gh102=child`) — claude / `claude-haiku-4-5` / mode `bypassPermissions`。親が作った子。`LastUsage`: InputTokens 10, OutputTokens 121, CachedTokens 31539, CostUsd 0.04605890000000001
  - `b5b0a0e6` (`gh102=child`) — 同上。親が同じコマンドを 2 回打ったことで生まれた 2 体目 (実測 1 の副次観測)。`LastUsage`: InputTokens 16, OutputTokens 366, CachedTokens 54514, CostUsd 0.0246934
  - `f7877c62` (`gh102=verifier`) — omp / `anthropic/claude-haiku-4-5` / mode `full`。実測 2・3・6。`LastUsage`: InputTokens 477, OutputTokens 4874, CachedTokens 427009, CostUsd 0.28971189999999997
  - `c5ebf7e5` (`gh102=junie`) — junie / `grok-4.5` / mode `default`。実測 6 の mode 調査用。`LastUsage`: **null** (実行して応答も返したのに usage が付かない)
- **実測 6 の題材**は scratchpad 上の合成タスク (`greet.sh` に `--upper` を足す小さな task.md / run/plan.md / target project 2 ファイル / verdict path)。リポジトリのファイルは実測に一切使っていない。

## 実測 1: エージェントの中から `paseo run` を呼べるか (親子関係・workspace・出力の戻り)

### 実行したコマンド

親を作る (プロンプトは要約せず全文を渡した。以下は骨子):

```
$P run --provider claude --model claude-haiku-4-5 --mode bypassPermissions \
  --label gh102=parent --title "gh-102 parent" --cwd <scratch>/parent \
  --wait-timeout 10m --json "<STEP1: printenv PASEO_AGENT_ID; printenv PASEO_AGENT_CWD;
  printenv PASEO_CLI; pwd / STEP2: \"\$PASEO_CLI\" run --provider claude --model claude-haiku-4-5
  --mode bypassPermissions --label gh102=child --title \"gh-102 child\" --wait-timeout 5m
  '<子への指示: printenv PASEO_AGENT_ID; printenv PASEO_AGENT_CWD; pwd を実行し、その出力と
  CHILD-OK を返す>' / STEP3: STEP1-OUTPUT / STEP2-STDOUT / STEP2-STDERR / STEP2-EXIT /
  CHILD-TEXT-RETURNED を逐語で報告せよ>"
```

観測は次の 4 本で取った:

```
$P logs 06e0fd00
$P inspect 74b7f359 --json
$P logs 74b7f359
$P workspace ls --json
```

### 観測結果

親の報告 (`$P logs 06e0fd00` より、逐語):

```
STEP1-OUTPUT:
06e0fd00-cb4c-4c40-bd4d-90ece9024623
/private/tmp/.../scratchpad/gh-102/parent
/Applications/Paseo.app/Contents/Resources/bin/paseo
/private/tmp/.../scratchpad/gh-102/parent

STEP2-STDOUT:
AGENT ID                              STATUS      PROVIDER    CWD                     TITLE
74b7f359-d44e-49d9-917e-ea736507d665  completed   claude      /private/tmp/.../parent gh-102 child

STEP2-STDERR:
(empty)

STEP2-EXIT:
0
```

- **子は実際に作られた**: `74b7f359`。`$P inspect 74b7f359 --json` は `"ParentAgentId": "06e0fd00-cb4c-4c40-bd4d-90ece9024623"` を返し、**親の id で埋まっている**。`"Cwd"` は親と同じ `<scratch>/gh-102/parent`、`"Mode": "bypassPermissions"` (親が渡した値がそのまま効いている)。
- **workspace は caller のものになった**: 親の `paseo run` の stderr は空で、自分の実行時に出た `Created workspace wks_... - parent` の類が出ていない。`$P workspace ls --json` でも cwd `<scratch>/gh-102/parent` の workspace は 1 件 (`"project": "parent"`) だけで、子のために新しい workspace は作られていない。
- **子の最終出力は呼び出し側に返らない**: STEP2-STDOUT は agentId / status / provider / cwd / title の 1 行表だけで、子の本文 (`CHILD-OK` と env の値) は含まれない。親は `CHILD-TEXT-RETURNED: yes` と答えたが、**その根拠として挙げているのは自分で `"$PASEO_CLI" logs 74b7f359` を打って拾った内容**である (親のログに `[Shell] "$PASEO_CLI" logs 74b7f359-…` が残っている)。子の本文は `$P logs 74b7f359` 側にだけ在る:

  ```
  [Shell] printenv PASEO_AGENT_ID; printenv PASEO_AGENT_CWD; pwd
  74b7f359-d44e-49d9-917e-ea736507d665
  /private/tmp/.../scratchpad/gh-102/parent
  /private/tmp/.../scratchpad/gh-102/parent

  CHILD-OK
  ```

- **副次観測 (重複起動)**: 親は STEP2 のコマンドを 2 回打っており (「stderr も込みで取り直す」という自己判断)、子が 2 体できた (`74b7f359` と `b5b0a0e6`。`$P ls -a -g --label gh102=child --json` で 2 件)。2 体目の `ParentAgentId` も親の id。**`paseo run` は冪等ではなく、呼び出しの再試行がそのままエージェントの重複生成になる。**

### 判定

**条件付きで可。** 子は作られ、`ParentAgentId` は親の id で埋まり、workspace は caller のものが引き継がれる (新規 workspace を作らない)。条件は 2 つ:

1. **最終出力は返らない。** `paseo run` の stdout はメタデータの表だけで、エージェントの本文は含まれない。本文が要る役割では `--output-schema` (実測 2) を使うか、呼び出し側が `paseo logs <child>` を読む段取りが要る。
2. **重複生成を呼び出し側で防ぐ必要がある。** エージェントに「このコマンドを打て」と書く形は、エージェントの再試行判断で子が増える。起動は 1 回で足りることをプロンプトで明示するか、起動後に `ls --label` で重複を検出して片付ける手当てが要る。

## 実測 2: `--output-schema` で判定 JSON を構造化して受け取れるか

### 実行したコマンド

```
$P run --provider omp --model anthropic/claude-haiku-4-5 --mode full \
  --label gh102=verifier --title "gh-102 verifier (omp)" --cwd <scratch>/verifier \
  --wait-timeout 10m \
  --output-schema '{"type":"object","properties":{"phase":{"type":"string"},
                    "verdict":{"type":"string"}},"required":["phase","verdict"]}' \
  "<verifier の起動プロンプト: 実測 6 参照>"
$P logs f7877c6            # スキーマがどう効いたかの確認
$P send --help             # 再開時に同じ指定ができるか
```

### 観測結果

- `paseo run` の stdout (`--json` を**付けずに**) が、そのまま最小 JSON になった:

  ```
  {
    "phase": "plan",
    "verdict": "FAIL"
  }
  ```

- `$P logs f7877c6` の `[User]` を見ると、スキーマは**プロンプトに追記される形**で効いている:

  ```
  You must respond with JSON only that matches this JSON Schema:
  { "type": "object", "properties": { "phase": {...}, "verdict": {...} },
    "required": [ "phase", "verdict" ] }
  ```

- `$P send --help` のオプションは `--prompt / --prompt-file / --image / --no-wait / --json / --host` だけで、**`--output-schema` に相当する指定が無い**。

### 判定

**条件付きで可。** 初回の `paseo run` については、返り値を最小 JSON にして stdout で受け取れる (現行の「verifier は最小 JSON だけを返す」契約がそのまま乗る)。条件は 2 つ:

1. **強制はプロンプト注入であって、デコード時の制約ではない。** スキーマ違反が構造的に起きないことは保証されない (実測では 1 回とも違反しなかったが、保証の根拠にはならない)。
2. **再開 (`paseo send`) には同じ指定が無い。** 再検証で最小 JSON を得たいなら、送るプロンプト側に書くか、verdict ファイル (実測 6) を読む方式に寄せる必要がある。

## 実測 3: `paseo send` で同じ子を再開でき、前回の文脈が保たれるか

### 実行したコマンド

実測 2 の verifier (`f7877c62`) に対して:

```
$P send f7877c6 "Answer WITHOUT reading any file again and WITHOUT running any command.
(1) PATH= the absolute path of the instruction file you were told to read at the start
(2) VERDICT= the verdict you wrote to the verdict path, and the number of elements in its required_fixes array
(3) FIRST-FIX= the first element of required_fixes, verbatim
If you cannot answer any line from memory, write NOT-RETAINED on that line."
$P logs f7877c6 --tail 8
```

### 観測結果

`paseo send` の返り値は `{"agentId": "f7877c62-…", "status": "completed", "message": "Agent completed processing the message"}` だけで、応答テキストを含まない。応答は `logs` 側にあり、逐語で:

```
PATH= /Users/naoki/work/github.com/NaokiTsuchiya/skills/.claude/worktrees/task-pipeline/gh-102/task-pipeline/references/verifier.md

VERDICT= FAIL, 4 elements

FIRST-FIX= 検証手順に『sh greet.sh --upper; echo $?』を追加し、--upper に名前がない場合のエラーケースを覆う
```

3 行とも、実測 6 で書かれた verdict ファイルの実内容と一致する (`required_fixes` は 4 要素、先頭要素は上の文字列と同一)。ファイル読み直しもコマンド実行もログに現れていない。

### 判定

**条件付きで可。** 同じエージェントを `paseo send` で再開でき、**指示ファイルを読んだ状態と自分の前回判断の両方が保たれている**。現行の `reuse_verifier` 経路 (`task-pipeline/scripts/state-next.ts` の `reuseVerifierOf`) が当てにしている性質は、Paseo 経路でも成り立つ。条件は 1 つ: **`send` は応答テキストを返さない**ので、再開の結果を読むには `paseo logs <id>` を読む段取りが要る (実測 2 の条件 2 と同じ問題)。

## 実測 4: 別セッション / 別エージェントから `paseo send` が届くか

### 実行したコマンド

外向き (自分 = Paseo エージェントではないセッション → 自分が作っていない子):

```
$P send 74b7f359 --json "Reply with exactly this line: CROSS-CALLER-OK, then state the agent id
you printed in your previous reply."
$P logs 74b7f359 --tail 4
```

内向き (親エージェント → 自分が作っていない verifier):

```
$P send 06e0fd00 "<'\"\$PASEO_CLI\" send f7877c62-… \"Reply with exactly this one line: INBOUND-FROM-AGENT-OK\"'
を実行し、SEND-STDOUT / SEND-STDERR / SEND-EXIT を逐語で報告せよ>"
$P logs 06e0fd00 --tail 6
$P logs f7877c6 --tail 3
```

### 観測結果

- 外向き: 子 `74b7f359` は `CROSS-CALLER-OK` と、前回自分が出力した id `74b7f359-d44e-49d9-917e-ea736507d665` を返した。**この子を作ったのは親エージェントであって自分ではない**が、送信も文脈参照も通った。
- 内向き: 親の報告は `SEND-STDOUT` が `f7877c62-… completed Agent completed processing the message` の 1 行表、`SEND-STDERR` は `(empty)`、`SEND-EXIT` は `0`。verifier 側のログにも `[User] Reply with exactly this one line and nothing else: INBOUND-FROM-AGENT-OK` と応答 `INBOUND-FROM-AGENT-OK` が入っている。**verifier を作ったのは自分であって親ではない**が、届いた。

### 判定

**可 (制約は逆向きに出る)。** Paseo には「作った側だけが再開できる」制約が無い。daemon に届く経路と agentId さえあれば、誰からでも `send` が通る。現行 `reuseVerifierOf` の `run.verifier_session !== session` を無条件で null に落とす条件は、Paseo 経路では**不要になる** (同じ verifier を別セッションが再開できる)。

裏返しの制約: **誰でも他人の verifier を再開できてしまう**ので、二重再開・二重起動を防ぐ排他は Paseo 側には無く、`state.json` (所有権と `run.verifier`) 側で持ち続ける必要がある。

## 実測 5: 子に `PASEO_AGENT_ID` が自分自身の id で渡るか

### 実行したコマンド

実測 1 の子 2 体それぞれのログから、子自身が実行した `printenv` の出力を読む:

```
$P logs 74b7f359
$P logs b5b0a0e6
$P inspect 74b7f359 --json     # ParentAgentId との突き合わせ
```

### 観測結果

- `74b7f359` の `[Shell] printenv PASEO_AGENT_ID; printenv PASEO_AGENT_CWD; pwd` の出力は `74b7f359-d44e-49d9-917e-ea736507d665` — **自分自身の id** (親の `06e0fd00` ではない)。`PASEO_AGENT_CWD` と `pwd` はどちらも親の cwd。
- `b5b0a0e6` でも同じ形で `b5b0a0e6-319a-4003-a038-20307f0b0f9d` が出た。
- 同じ子の `inspect` の `ParentAgentId` は `06e0fd00-…`。つまり**自分の id は env に、親の id は daemon 側の記録に**という分かれ方をしている。
- 親自身の `PASEO_AGENT_ID` も自分の id (`06e0fd00-…`、実測 1 の STEP1-OUTPUT)。

### 判定

**可。ただし所有権の意味が変わる。** `PASEO_AGENT_ID` は各エージェントに自分自身の id として渡るので、`sessions/<id>` の heartbeat の識別子をこれに載せ替えることは技術的にできる。条件:

- Paseo には `CLAUDE_CODE_SESSION_ID` に相当する「セッション」の層が無い。載せ替えると、所有権の粒度が「セッション」から「オーケストレーター・エージェント 1 体」へ変わる。現行の「同じセッションが持つ複数の揮発資源」は、Paseo では「同じエージェントが持つ子エージェント群」に読み替える必要がある。
- 実測 4 のとおり送信元の制限が無いので、識別子を載せ替えても**排他の効力は生まれない** (heartbeat は生存の印としてだけ働く)。

## 実測 6: omp のエージェントに `verifier.md` がそのまま通るか / 無人実行の mode

### 実行したコマンド

verifier の起動プロンプト (`agents/task-pipeline-verifier.md` の本文に相当する内容を、そのまま初回プロンプトとして渡した):

```
You are a fresh, independent verifier for one phase of a task-pipeline task.
Read <worktree>/task-pipeline/references/verifier.md and follow it.
The launch prompt gives you: phase / task file / run dir / target project / verdict path.
Write the full verdict JSON to verdict path (you have Bash but no Write tool), then return only
the minimal verdict JSON.
phase: plan
task file: <scratch>/verifier/task.md
run dir: <scratch>/verifier/run
target project: <scratch>/verifier/proj
verdict path: <scratch>/verifier/verdicts/plan-0.json
```

起動は実測 2 のコマンド (omp / `anthropic/claude-haiku-4-5` / `--mode full` / `--output-schema`)。観測:

```
$P logs f7877c6                                   # 使ったツールの並び
cat <scratch>/verifier/verdicts/plan-0.json       # 書かれた verdict の中身
find <scratch>/verifier/proj -type f -exec shasum {} \; | sort   # 起動前後で突き合わせ
$P inspect f7877c6 --json                         # AvailableModes
$P inspect f0bc937d --json / $P inspect c5ebf7e5 --json          # claude / junie の mode
```

### 観測結果

- **指示はそのまま通った。** ログの並びは `[Read] …/references/verifier.md` → `[Read] task.md` → `[Read] run/plan.md` → `[Read] proj/greet.sh`, `proj/test.sh` → `[Shell] cat > "<verdict path>" …` → 最小 JSON の返却。**`cat >` で書いており、「Write tool は無いので Bash で書く」の指示に素直に従っている** (omp に Write 相当があるかは未確認だが、この記述で不具合は起きなかった)。
- **verdict ファイルは契約どおりの形**で書かれた (`phase` / `verdict` / `reasons` / `required_fixes`。`required_fixes` は 4 要素、内容も合成タスクの中身に即した具体的なもの)。返り値は最小 JSON のみ (実測 2)。
- **target project は書き換えられていない**: 起動前後の shasum 一覧の diff が空 (`UNCHANGED`)。mode は `full` (書き込み自由) だったが、verifier.md の行動境界が守られた。
- **読み取り専用の縛りは Paseo 側に無い。** `agents/task-pipeline-verifier.md` の `tools: Read, Grep, Glob, Bash` に相当する指定は CLI にも `create_agent` の設定にも無く、代替は provider ごとの mode だけである。`inspect --json` の `AvailableModes` の実値:
  - claude: `plan` / `default` (Always Ask) / `acceptEdits` / `auto` / `bypassPermissions`
  - omp: `full` (Full Access) / `write` (Write Approval) / `ask` (Always Ask)
  - junie: **空配列** (`"AvailableModes": []`、`Mode` は `default`)
- **無人実行できる mode**: omp は `full`、claude は `bypassPermissions` (実測 1・5 の親子はこれで承認待ちに入らず完走)、junie は `default` のまま完走した (`JUNIE-OK` を返した)。**`--mode` を省略したときの claude は `auto` ではなく `default` (Always Ask) になる** (`f0bc937d` の `inspect`) ので、無人実行では明示が要る。
- **junie は usage を返さない**: 応答は返ったのに `"LastUsage": null` (実測の条件節)。

### 判定

**条件付きで可。** `verifier.md` の指示 (指示ファイルを読む → verdict path へ書く → 最小 JSON のみ返す → target project を変更しない) は、omp のエージェントにそのまま通った。条件:

1. **読み取り専用の縛りは失われる。** Paseo にはツール集合の制限が無く、`--mode` は「書き込みに承認を挟むか」の粒度しかない。無人で回すなら書き込み可能な mode (omp `full` / claude `bypassPermissions`) を選ぶことになるので、**verifier が target project を変更しない保証は指示文だけに依存する**。実測では守られたが、保証ではない。
2. **`--mode` の明示が要る** (省略時の claude は Always Ask に落ちる)。
3. 「Write tool は無いので Bash で書く」の記述は、Claude Code のツール構成を前提にした表現のまま omp でも実害無く機能した。ただし表現としては環境依存なので、移行時に環境非依存の言い方へ直す余地がある (この issue の範囲外)。

## 移行単位ごとの可否表

| 移行単位 | Paseo 経路で可能か | 現行経路のフォールバックが要るか | 未解決の障害 |
| --- | --- | --- | --- |
| 同期役割 (verifier / adapter / triage / survey / retro / pr-watcher / pr-responder / 依存昇格 / 衝突トリアージ) | 可。`paseo run` は既定で完了待ちで、`--output-schema` を付ければ最小 JSON が stdout に返る (実測 2)。verifier.md の契約は omp でも通った (実測 6) | 不要。ただし `paseo` が PATH に無い環境では実体パスでの起動が要る (実測の条件) | 自由文を返す役割 (triage / survey / retro) には `--output-schema` が効きにくく、本文は `paseo logs` を読むしかない — テキスト抽出の契約が現行 (Agent tool の返り値) と揃わない。読み取り専用の縛りが無く、行動境界は指示文頼み (実測 6 判定 1) |
| background executor と停止通知 | 部分的に可。`paseo run -d/--background` で背景化でき、`paseo wait` / `paseo logs -f` で完了を待てる (help 出力) | **要る。** CLI の `run --help` に通知 (PushNotification 相当) を指定するオプションが無く、停止通知の受け口がこの経路には無い | MCP tool 側の `notifyOnFinish` は `docs/paseo-notify-on-finish-2026-08.md` で実測済み — 通知そのものは届くが、**呼び出し側が Paseo エージェントであること**が要り、引き取り (takeover) には追随せず、親を archive すると走行中の子が打ち切られる。同記録の推奨はポーリング経路。CLI だけで組むと完了検知がポーリングになり、現行の「停止通知で起こされる」形とコストの出方が変わる |
| ループ駆動 (ScheduleWakeup / Cron の代替) | **未実測。** `paseo loop run` (`--verify-provider` / `--verify-model` / `--verify-mode` を持つ) / `paseo schedule` / `paseo heartbeat` が存在することだけを help 出力で確認した | 未判定 (実測していないので、要否を根拠付きで言えない) | この issue の範囲外としたため実測していない。特に `loop run` の worker/verifier 分離が task-pipeline のフェーズ機構とどう噛み合うかは未確認 |
| セッション所有権 | 可だが意味が変わる。`PASEO_AGENT_ID` は各エージェントに自分自身の id で渡る (実測 5) ので heartbeat の識別子に使える | 要る (当面)。`CLAUDE_CODE_SESSION_ID` 経路を残さないと、Claude Code ハーネス側で回すときの所有権が失われる | Paseo に「セッション」の層が無く、粒度がエージェント 1 体になる。さらに**誰でも `send` できる** (実測 4) ため、`reuseVerifierOf` の session 一致条件は不要になる一方、二重再開の排他は `state.json` 側で持ち続けるしかない |
| 役割別コスト回収 | 部分的に可。`paseo inspect <id> --json` の `LastUsage` から InputTokens / OutputTokens / CachedTokens / CostUsd が取れ、`--label` で役割ごとに絞れる (実測の条件) | 要る。provider によっては取れない (junie は応答を返しても `LastUsage: null`) | `LastUsage` は **archive すると null になる** ので、回収は archive の前に行うしかない (後始末節)。また名前のとおり「最後の run」の値なのか複数ターンの累積なのかは**未検証** (E0 は 1 ターン後、verifier は 3 ターン後に採取しており、比較していない) |

## エージェントの後始末

実測に使った 6 体をすべて archive した。**`LastUsage` は archive 後に null になる**ので、実測の条件節の実値はすべて archive 前の `inspect` から採ってある。

```
$ for a in 06e0fd00 74b7f359 b5b0a0e6 f7877c62 c5ebf7e5; do $P archive $a --json; done
{"agentId":"06e0fd00-cb4c-4c40-bd4d-90ece9024623","status":"archived","archivedAt":"2026-08-13T06:58:17.757Z"}
{"error":{"code":"AGENT_ALREADY_ARCHIVED","message":"Agent 74b7f35 is already archived","details":"Archived at: 2026-08-13T06:58:18.189Z"}}
{"error":{"code":"AGENT_ALREADY_ARCHIVED","message":"Agent b5b0a0e is already archived","details":"Archived at: 2026-08-13T06:58:18.805Z"}}
{"agentId":"f7877c62-4ac4-44d5-9df9-a82678c5a5b5","status":"archived","archivedAt":"2026-08-13T06:58:20.975Z"}
{"agentId":"c5ebf7e5-5f25-443e-9fc0-840f7f9e8875","status":"archived","archivedAt":"2026-08-13T06:58:21.553Z"}
```

`f0bc937d` はこれより前に単独で archive 済み (`{"agentId":"f0bc937d-…","status":"archived","archivedAt":"2026-08-13T06:39:34.999Z"}`)。

**副次観測**: 子 2 体には archive を打っていないのに `AGENT_ALREADY_ARCHIVED` が返り、その `Archived at` は親を archive した直後の時刻だった。**親を archive すると、その子も一緒に archive される。**

確認 (`-a` 無しの一覧が空 = 生きているものが無い / `-a` 付きで全件 / 各 id の `Archived` が true):

```
$ for r in smoke parent child verifier junie; do $P ls -g --label gh102=$r --json; done
[]  []  []  []  []
$ for r in smoke parent child verifier junie; do $P ls -a -g --label gh102=$r -q; done
smoke     f0bc937
parent    06e0fd0
child     b5b0a0e 74b7f35
verifier  f7877c6
junie     c5ebf7e
$ for a in f0bc937d 06e0fd00 74b7f359 b5b0a0e6 f7877c62 c5ebf7e5; do $P inspect $a --json; done | grep Archived
"Archived":true,"ArchivedAt":"2026-08-13T06:39:34.999Z",
"Archived":true,"ArchivedAt":"2026-08-13T06:58:17.757Z",
"Archived":true,"ArchivedAt":"2026-08-13T06:58:18.189Z",
"Archived":true,"ArchivedAt":"2026-08-13T06:58:18.805Z",
"Archived":true,"ArchivedAt":"2026-08-13T06:58:20.975Z",
"Archived":true,"ArchivedAt":"2026-08-13T06:58:21.553Z",
```

`paseo logs <id>` は archive 後も読める (`b5b0a0e6` のログを archive 後に読んで実測 5 の裏を取った)。
