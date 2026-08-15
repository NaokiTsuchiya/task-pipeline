**入る条件**: サブエージェントを起動または再開する直前 (executor / verifier / adapter / triage / survey / retro / pr-watcher / pr-responder / 依存昇格 / 衝突トリアージ のいずれか)。ここで決めるのは provider・model・mode と経路、および Paseo 経路の起動パラメータと読み取り方だけであり、プロンプト文面は各起動箇所にある (移したのは起動パラメータの解決だけである)。

## 役割の表

| 役割 | 起動 | provider・model の解決元 | mode | 経路 |
|---|---|---|---|---|
| `executor` | **background (同期起動は行わない)** | `impl` (`impl_provider=` が上書き) | claude: `bypassPermissions` / omp: `full` | Paseo 優先 → 現行 (Agent tool の background)。**停止検知はポーリング** — CLI に通知の受け口が無く、MCP の `notifyOnFinish` は届くものの呼び出し側が Paseo エージェントであることを要し、引き取り (takeover) にも追随しない (`docs/paseo-notify-on-finish-2026-08.md` の推奨) |
| `verifier` | 同期 | `audit` (`verify_provider=` が上書き) | **無人実行できる mode** — claude: `bypassPermissions` / omp: `full` / junie: **無し** (Paseo 経路に乗せない) | Paseo 優先 → 現行 (`task-pipeline-verifier` → `general-purpose`) |
| `adapter-list` | 同期 | provider は解決しない。model は**安いモデル固定** (`haiku`) | — | 現行のみ |
| `adapter-mark` | 同期 | **指定しない** (現行どおり) | — | 現行のみ |
| `triage` | 同期 | **指定しない** — 判断が成果物 | — | 現行のみ |
| `survey` | 同期 | **指定しない** — 判断が成果物 | — | 現行のみ |
| `retro` | 同期 | **指定しない** — 判断が成果物 | — | 現行のみ |
| `pr-watcher` | 同期 | **指定しない** (Paseo での実測が無い) | — | 現行のみ |
| `pr-responder` | 同期 | **指定しない** (同上) | — | 現行のみ |
| `依存昇格` | 同期 | **指定しない** (同上) | — | 現行のみ |
| `衝突トリアージ` | 同期 | **指定しない** (同上) | — | 現行のみ |

- **`adapter-list` の安いモデル固定と、`mark` に広げないことの理由**は SKILL.md「アダプタの呼び方」にある (実測は `docs/cost-analysis-2026-07.md` §10 — 下がるのは単価だけで、トークン量はむしろ増える)。
- **判断が成果物の役割 (`triage` / `survey` / `retro`) でモデルを指定しない理由**は SKILL.md「承認」手順 2 にある (`haiku` 指定で issue の重複見落としを実測)。安いモデルで削れるのは手続きであって判断ではない。
- **「指定しない」の役割が現行のみなのは、この規律の帰結である** — Paseo 経路は provider を必須の引数として取るので、そこへ載せること自体が provider の指定になる。
- 表に無い役割 (新しく足す役割) は、既定として「同期 / 指定しない / 現行のみ」に置き、この表に行を足してから使う。

## provider・model・mode の解決手順

provider と model は次の 3 段で決める。上の段が決まればそこで止める。

1. **起動引数**に指定があればそれ (`impl_provider=` = 実装側 = `executor`、`verify_provider=` = 検証側 = `verifier`)。値の形は `<provider>[/<model>]` で、**最初の `/` までが provider、残りが model** である (omp のモデル id は `anthropic/claude-haiku-4-5` のように `/` を含む)。
2. 無ければ `~/.paseo/orchestration-preferences.json` の `providers` の該当カテゴリ (上の表の「解決元」の列)。**実際にファイルを読む** — 既定値の記憶や下記の設定例で代用しない (`~/.claude/skills/paseo/SKILL.md` の規定)。設定例と、このパイプラインが読むカテゴリの一覧は `docs/orchestration-preferences.md`。
3. それも無ければ**既定の組** — **実装 = `claude` 系 / 検証 = `omp`** — に解決する。model は指定せず provider の既定に任せる (`paseo run` の `--model` は任意で、固定のモデル id はここに書き下せない — `docs/orchestration-preferences.md`)。下記の**実在確認**に通らなかったときだけ、その役割を**セッション継承** (provider も `model` も渡さない) で起動する。

- **prefs のファイルが無いときは、既定の組で進めたうえでユーザーに一度だけ伝える** (1 セッションに 1 回。history にも 1 行)。既定の組は**実装 = claude 系 / 検証 = omp** で、これが「実装と検証を別プロバイダにする」の既定である。omp を検証側に置くのは、`references/verifier.md` の契約 (指示ファイルを読む → verdict path へ書く → 最小 JSON だけを返す → target project を変更しない) を omp のエージェントが完走したことが実測されている唯一の組だからである (`docs/paseo-subagent-2026-08.md` の実測 6)。junie は応答を返しても usage が取れずコストを回収できないので既定には選ばない。
- **既定の組は、使う前に provider の実在を確かめる** (以下「実在確認」): MCP の `list_providers` を引き、`claude` と `omp` がその環境で available かを見る (モデル id が要るときだけ `list_models`)。MCP を引けないときは CLI の `paseo provider ls` の `status` 列でも同じ確認が取れる。**実在確認が取れないか、既定の組の provider が available でないときだけ、その役割をセッション継承で起動する** — これが既定の組の唯一の落ち先である。通れば、prefs が無くても provider は解決済みなので、経路 1 (Paseo) にそのまま乗る。
- **prefs 不在で残す history の 1 行は、経路の帰結まで書く**: 既定の組を適用できたときは `agent-launch: prefs 不在 — 既定の組で解決 (実装=<provider> / 検証=<provider>) — verifier は Paseo 経路に乗る`、落ち先に落ちたときは `agent-launch: prefs 不在 — 実在確認に通らず (<理由>) セッション継承 — verifier は Paseo 経路に乗らない (別プロバイダ検証と Paseo 側の可観測性が効かない)`。
- **ユーザーへの一度だけの通知は次の 3 点を伝える**: (a) 既定の組 (実装 = claude 系 / 検証 = omp) で進めていること、(b) `~/.paseo/orchestration-preferences.json` を置けば provider・model を明示指定できること、(c) 落ち先に落ちた回は、別プロバイダ検証と Paseo 側の可観測性が効かないこと。
- **mode は provider ごとに決まる**: claude は `bypassPermissions`、omp は `full`。**省略すると claude は Always Ask に落ちて無人実行が止まる**ので、Paseo 経路では必ず明示する。**現行ハーネス経路に mode の軸は無く**、代わりに agent type の `tools:` 制限が効く (`agents/task-pipeline-verifier.md`)。
- **junie には無人実行できる mode が無い**: `paseo provider ls` の `modes` が空 (`""`) で `defaultMode` は `default`、MCP の `list_providers` でも同じく mode の一覧が空である (`docs/paseo-subagent-2026-08.md` 実測 6 の `AvailableModes` は空配列。#116 の実測では検証ゲートがツール承認待ちで停止した)。**解決した provider が junie になったら Paseo 経路に乗せない** — 扱いは下の経路節の項 1 にある。
- **verifier が target project を変更しない担保は `references/verifier.md` の行動境界の記述にあり、mode は担保にならない** — 無人で回せる mode (claude `bypassPermissions` / omp `full`) はどれも書き込み自由で、書き込みを禁じる claude の `plan` は verdict の書き出しができないので選べないからである。現行ハーネス経路では、これに加えて agent type の `tools:` が機械的な裏打ちになる (Paseo 経路にはその裏打ちが無い)。
- **現行ハーネス経路では provider を選べない** (Claude 固定)。解決した provider がそれ以外になった役割をこの経路で起動するときは、model も指定せずセッション継承に落とし、その旨を history に 1 行残す。

## 経路の選択とフォールバック

1. **Paseo 経路に乗せる前に、解決した provider が無人実行できる mode を持つかを確かめる**: MCP の `list_providers` (CLI なら `paseo provider ls`) が返す mode の一覧に、上の役割の表の mode 列が指す無人実行 mode (claude `bypassPermissions` / omp `full`) があるか。**一覧が空の provider (junie の `"modes": ""`) は Paseo 経路に乗せず、現行ハーネス経路で起動して history に 1 行残す** (`agent-launch: <provider> に無人実行できる mode が無い — 現行経路で <役割> を起動`)。**`status: available` はこの判定の代わりにならない** — 解決手順の節の実在確認は在庫を見るだけで、承認を挟まずに走れるかは見ていない。
2. **Paseo 経路を第一候補にする** (`paseo run` で起動、`paseo send` で再開)。CLI が PATH に無ければ実体パスで起動する (OS ごとの在処は `~/.claude/skills/paseo/SKILL.md`)。**返り値の受け方は役割で分かれる**: **同期役割 (verifier)** は初回に `--output-schema` を付けて stdout の最小 JSON で受け、**再開 (`send`) には同等の指定が無い**ので verdict ファイルか `paseo logs <agentId>` から読む。**background の `executor` には `--output-schema` を付けない** (返り値が protocol 行 1 行で、フェーズごとに複数回停止する) — agentId と protocol 行の取り方は下記「Paseo 経路の起動パラメータと読み取り」にある。
3. **失敗したら現行ハーネス経路 (Agent tool / SendMessage) に落ちる。落ちたら history に 1 行残す** (`agent-launch: paseo 経路が失敗 (<理由>) — 現行経路で <役割> を起動`)。「verifier agent type 未インストール → general-purpose」と同型の作法であり、落ちたこと自体は失敗ではない。**`executor` はこの限りではない** — **イテレーション境界とセッション境界が一致する環境 (`paseo loop` 配下等) では、現行ハーネス経路の background へフォールバックしない**。停止通知が届くのはそのセッションが生きている間だけで、次のイテレーションは別セッションになるため、フォールバックすると気づかれない孤児が生まれる (gh-114。`docs/loop-session-orphan-2026-08.md`)。この環境で Paseo 経路が使えなければ、項 6 の「タスクに紐づく役割」の扱い (`block` + 通知) に進む。
4. **落ちてよいのは「エージェントが生まれなかった」と言い切れる失敗だけである**: 起動コマンドが非ゼロで終了した、または agentId が返らなかったとき。起動した後の失敗 (待ちのタイムアウト、契約外の応答) では落ちない — `paseo run` は冪等ではなく、再試行がそのまま 2 体目の生成になる (`docs/paseo-subagent-2026-08.md` 実測 1 の副次観測)。落ちる前に `paseo ls -a -g --label` で重複が残っていないかを確かめる (**`-g` を落とさない** — 非 global 形は、同じリポジトリの別 worktree を cwd に持つエージェントを一覧から落とすことが実測されている。下記節)。**例外は項 5 の permission 待ちだけで、そのときは項 5 が優先する。**
5. **事前チェック (項 1) を通したのに permission 待ちで停止したら、項 4 の例外として現行ハーネス経路へ落ちる。** 見え方は 3 通りで、どれか 1 つで判定してよい: `--output-schema` を付けた起動の stdout が `{"error":{"code":"OUTPUT_SCHEMA_FAILED","message":"Agent is waiting for permission …"}}`、`paseo wait <id>` が `{"status":"permission", …}`、`paseo permit ls` に承認要求が滞留。扱いは 3 点: (a) **落ちてよい** — `paseo run` を再試行せず別経路へ移るだけなので 2 体目は生まれない (項 4 が禁じているのは再試行である)、(b) **残ったエージェントは掃除を試み、できなければ残置してユーザーに伝える** — `paseo archive <agentId>` (MCP なら `archive_agent`) を 1 回だけ試し、実行できない環境 (Claude Code ハーネス配下では classifier に拒否される) では agentId と掃除のコマンドを報告に添えて渡す。**`paseo permit allow` で勝手に承認はしない** (何を承認するのかを見ていない)、(c) **history に 1 行残す** (`agent-launch: paseo 経路が permission 待ちで停止 (agentId=<id> / 掃除=<archived|残置>) — 現行経路で <役割> を起動`)。
6. **どちらの経路も使えないときは、その役割をオーケストレーターが自分で代行しない** (「コンテキスト規律」と「検証ゲートの絶対規則」)。扱いは役割で分かれる:
   - **タスクに紐づく役割** (`executor` / `verifier`) → そのタスクを `state.ts block` にして 1 行報告し、`PushNotification` を 1 本送る (SKILL.md「毎イテレーションの手順」2 の規定どおり)。ループは止めない。
   - **アダプタ** (`adapter-list` / `adapter-mark`) → トラッカー不通と同じ扱いにして、`playbooks/depleted.md` の手順 2 でループを止める。
   - **ベストエフォートの役割** (`survey` / `retro` / `pr-watcher` / `pr-responder` / `依存昇格` / `衝突トリアージ`) → その回は飛ばし、history に 1 行残して続行する。

## Paseo 経路の起動パラメータと読み取り

Paseo 経路で起こすときの `paseo` 側の引数と、起きたエージェントの読み方・送り方はここが正である (実測は `docs/paseo-notify-on-finish-2026-08.md` と `docs/paseo-subagent-2026-08.md`)。

- **起動パラメータ** — `--title "task-pipeline <役割> <タスク id>"` (`paseo ls` で役割とタスクが読めるようにする)、`--label task-pipeline=<役割>` と `--label task-pipeline-task=<タスク id>` の 2 本 (`--label` は繰り返せる。役割別のコスト回収と、下記の重複確認に効く)、`--cwd <そのタスク専用 worktree の絶対パス>`。**`executor` には `--output-schema` を付けない** (経路節 項 2)。**agentId は `paseo run -d --json` の stdout から取るが、先頭に workspace 作成の通知行が混じるので「最初の `{` から後ろ」を JSON として読む。**
- **読み取り (ポーリング)** — `paseo wait <agentId> --timeout <数秒> --json` が `status` と直近 5 件の活動 (`message`) を 1 回で返す (まだ動いていれば timeout までブロックしてから **`"status": "timeout"`** を返す。エラーではないので、イテレーションを止めない長さにして「idle でなかった」として扱う)。足りなければ `paseo logs <agentId> --tail <小さい n>`。**`--tail` の末尾行が protocol 行とは限らない** (最終応答の後ろに `[Thought]` が出ることがある) ので、末尾行を取るのではなく**直近の活動の中から protocol 行の形** (`PHASE … DONE — ` / `BLOCKED: ` / `REBASE-CONFLICT — ` / `FINALIZED — `) **を探す**。cwd が消えていると `logs` は読めない。
- **読んだ行の鮮度 (消費済みの行を再検知しないための規則)** — 停止として扱ってよいのは次の 3 つが**すべて**成り立つときだけで、1 つでも読めない・判定できないときは**消費済み側に倒して読み捨てる**: (1) **status が `idle` であること** — `running` のあいだは読まない (ログは消費しても消えないので、走行中に読むと前の停止の行をそのまま拾う)、(2) **`paseo inspect <agentId> --json` の `UpdatedAt` が `run.executor_last_event_at` より後であること** — `UpdatedAt` は最後の**活動**時刻であって停止時刻ではない (走行中は活動のたびに進む) が、**idle のあいだは動かない**ので (1) と AND を取ったときだけ「その停止の時刻」として使える、(3) protocol 行が直近の活動の中にあり `run.phase` と一致すること。**`paseo logs --since` は使えない** — 0.3.1 では ISO8601・相対時間・epoch・未来時刻のどれを渡してもフィルタされず全ログが返る。
- **送信** — Paseo 経路は `paseo send <agentId> --no-wait --prompt <本文>` (**既定は完了待ちなので `--no-wait` を落とさない** — 落とすとフェーズ 1 本分ブロックする)、現行ハーネス経路は `SendMessage`。**executor への指示はフェーズ前進・修正・finalize・`status-check`・`pr_fix`・`rebase_fix` のどれもこの規則で送る。**
- **経路の判別** — どちらの経路で起こした executor かは、`paseo inspect <run.executor> --json` の終了コードで決める (0 = Paseo のエージェント、非ゼロ = `Agent not found` なので現行ハーネス経路)。state.json は経路を持たない (スキーマを増やさない)。
- **二重起動の防止** — `paseo run` は冪等ではない (経路節 項 4)。重複確認は `paseo ls -a -g --label task-pipeline-task=<タスク id> --json` で行い、**`-g` を必ず付ける**: 非 global 形は、同じリポジトリの別 worktree を cwd に持つエージェントを落とすことが実測されている (このリポジトリの worktree から引いて 18 体中 11 体しか返らず、落ちた中に別 worktree の verifier 3 体が含まれていた)。
- **`takeover` で差し替えるときの旧エージェント** — 旧 `run.executor` が Paseo のエージェントなら `paseo stop <agentId>` を **1 回だけ**試す (同じ worktree に 2 体が書き込むのを止めるため。idle なら no-op)。**`archive` は使わない** — `LastUsage` が null になって役割別コストを回収できなくなり、子を持つエージェントでは巻き添え archive も起きる。止められなくても続行してよい (`run.executor` と一致しない行を読み捨てる規則が吸収する)。現行ハーネス経路の executor には止める手段が無いので、従来どおり放置する。

## Paseo invocation の usage 採取

Paseo 経路の executor・verifier が 1 回の `run` または `send` を終えて停止したと検知した直後 (上記「Paseo 経路の起動パラメータと読み取り」節のポーリング、または同期起動の応答受信の直後)、および archive を呼ぶ直前に、その invocation の usage を採って `.task-pipeline/runs/<id>/usage/paseo/<event-id>.json` へ保存する。**archive の前に採る** — `LastUsage`/`snapshot.lastUsage` は archive すると null になり、しかも累積ではなく直前の run 単発の値である (`docs/paseo-notify-on-finish-2026-08.md` の「エージェントの後始末」)。

- **採り方** — CLI 経路なら `paseo inspect <agentId> --json` の `.LastUsage`、MCP 経路なら `get_agent_status` の `snapshot.lastUsage`。呼び出し自体が失敗した・応答に usage が無い (junie 等) ときも、下記のとおり `usage_available: false` で記録を残す (黙って除外しない)。
- **`event_id`** — `<task_id>:<role>:<phase>:<invocation>-<n>` (`role` は `executor`/`verifier`、`invocation` は `run`/`send`)。`<n>` は再実行しても同じ値になるよう次のとおり決める: **`verifier`** はその検証ラウンドの `tasks[].gate.attempts` (ラウンド開始前の値 + 1) をそのまま使う — 同じ FAIL ラウンドの再送では同じ `n` になり上書き保存で冪等になる。**`executor`** は `.task-pipeline/runs/<id>/usage/paseo/` 配下で `<task_id>:executor:<phase>:` に前方一致する既存ファイルを数え、件数 + 1 を `n` にする — state.json をまだ進めていない再処理は同じ既存ファイル集合を数え直すので同じ `n` になる。
- **保存する JSON**:
  ```json
  {
    "schema_version": 1,
    "event_id": "<task_id>:<role>:<phase>:<invocation>-<n>",
    "task_id": "<id>",
    "role": "executor",
    "phase": "<phase>",
    "attempt": 1,
    "invocation": "run",
    "agent_id": "<agentId>",
    "workspace_id": "<workspaceId, 無ければ null>",
    "provider": "<provider>",
    "model": "<model>",
    "usage": {
      "input_tokens": 0,
      "cached_input_tokens": 0,
      "output_tokens": 0,
      "cost_usd": "0.0"
    },
    "usage_available": true,
    "source": "cli",
    "recorded_at": "<ISO8601 UTC>"
  }
  ```
  `usage_available: false` のときは `usage.*` を全部 `null` にする。`workspace_id` には下記「所有 workspace の記録と安全な後始末」節が同じ invocation で確定させた値をそのまま入れる (archive 対象かどうかの正はそちら側の記録であり、この usage ファイルは監査目的の写しにすぎない)。
- **CLI / MCP のフィールド名の正規化**:

  | 正規化後のキー | CLI (`paseo inspect --json` の `LastUsage`) | MCP (`get_agent_status` の `snapshot.lastUsage`) |
  | --- | --- | --- |
  | `input_tokens` | `InputTokens` | `inputTokens` |
  | `cached_input_tokens` | `CachedTokens` | `cachedTokens` |
  | `output_tokens` | `OutputTokens` | `outputTokens` |
  | `cost_usd` | `CostUsd` (数値。文字列化して保存する) | `totalCostUsd` (同様に文字列化) |

  CLI 側のフィールド名 (`InputTokens`/`OutputTokens`/`CachedTokens`/`CostUsd`) は `docs/paseo-notify-on-finish-2026-08.md` と `docs/paseo-subagent-2026-08.md` の実測に加え、`paseo inspect <id> --json` で追加確認済み (`runs/gh-122/research.md`)。**MCP 側のフィールド名はこのリポジトリの実行環境では未実測** (`mcp__paseo__*` ツールに到達できるのは Paseo エージェントの中だけで、このオーケストレータのセッションからは呼べない) — 最初に MCP 経路でこの手順を踏むエージェントは `get_agent_status` の応答を 1 度 verbatim で確認し、上表と食い違っていたら実測に合わせて更新すること。

## 所有 workspace の記録と安全な後始末

top-level (オーケストレータ自身) から Paseo 経路で `paseo run -d --cwd <worktree> --json` を呼ぶと、同じ cwd に対してでも呼ぶたびに新しい local workspace を作る (`docs/paseo-notify-on-finish-2026-08.md` の「エージェントの後始末」)。**agent-scoped の呼び出し (Paseo エージェントの中から `create_agent`/`paseo run` を呼ぶ場合) は `workspaceId` を省略すると caller の workspace を継承し、新規 workspace は作らない** (`docs/paseo-subagent-2026-08.md` の実測 1、70–71 行目)。この経路のオーケストレータは top-level のハーネスセッションなので、Paseo 経路で起こす executor/verifier は毎回 owned workspace を新規に持つのが通常経路である。

- **所有の判定** — `paseo run -d --json` の stdout は、新規 workspace を作ったときだけ先頭に `Created workspace <workspaceId> - <name>` の行を出す (agentId の JSON を「最初の `{` から後ろ」として読む規則があるのはこの行のため — 上記「Paseo 経路の起動パラメータと読み取り」節)。**この行があれば owned、無ければ非所有** (caller の workspace を継承)。`paseo inspect --json` の応答には `workspaceId` フィールドが無いので、この行を起動直後に (agentId を取り出すのと同じ処理で) 拾い損なうと後から所有を確定できない。
- **記録先** — `.task-pipeline/runs/<id>/paseo-workspace.json` に、そのタスクで Paseo 経路が確保した workspace を配列で記録する (`state.schema.json` は変更しない — 揮発情報は run dir 配下に置く、既存の `runs/<id>/rebase/` 等と同じ置き場)。起動のたびに追記する (takeover 等で 1 タスクの中に複数の owned workspace が生まれることがあるため、上書きではなく追記する):
  ```json
  {
    "schema_version": 1,
    "workspaces": [
      {
        "workspace_id": "<wks_...>",
        "owned": true,
        "agent_id": "<起動した agentId>",
        "role": "executor",
        "recorded_at": "<ISO8601 UTC>",
        "archived_at": null
      }
    ]
  }
  ```
  非所有 (継承) のエントリも `owned: false` で記録する — archive 対象からは常に除外されるが、どの workspace を使ったかの監査に残す。
- **単発完了・permission 待ち停止時の後始末** — 経路節の項 5 (verifier の PASS 確定、または executor/verifier が permission 待ちで停止して現行ハーネス経路へ落ちるとき) の `paseo archive <agentId>` を呼ぶ手順は、上の usage 採取を終えた**直後**に行う。その invocation が `paseo-workspace.json` に `owned: true` のエントリを残していれば、続けて `paseo workspace archive <workspace_id>` (MCP なら `archive_workspace`) を 1 回試し、成功したら `archived_at` を埋める。**verifier はフレッシュ起動のたびに使い捨てるので、ここで owned workspace を確実に畳む。**
- **安全規則 (曖昧な一括 archive の禁止)** — workspace の archive は**必ず `paseo-workspace.json` に記録された exact な `workspace_id` かつ `owned: true` のエントリだけ**を対象にする。**`cwd` が一致するという理由だけで workspace を archive しない** — 同一 cwd (同じタスク worktree) に対して複数セッション・複数タスクが workspace を持ちうるため、`cwd` 一致による一括 archive は他タスクやメインセッションの workspace を巻き込む重大な危険がある。`paseo workspace ls` に `--cwd`/`--label` に相当する絞り込みは無いので、**記録済みでない workspace_id は archive の対象にしない** (記録漏れがあれば残置してユーザーに伝える — 現行ハーネス経路の permission 待ち掃除と同じ扱い)。
- **executor (長命なバックグラウンドエージェント) の owned workspace** — executor は単発完了しないので、上の「単発完了・permission 待ち」の archive はここでは起きない。executor の owned workspace は `paseo-workspace.json` に記録されたまま残り、`playbooks/merge-recovery.md` の「マージの回収」(`retire`) と `playbooks/pr-follow.md` の `closed` 分岐 (`withdraw`) が、そのタスクの Paseo 経路への関与が終わる時点で読みに行く。
