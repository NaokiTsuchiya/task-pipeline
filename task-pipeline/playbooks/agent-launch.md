**入る条件**: サブエージェントを起動または再開する直前 (executor / verifier / adapter / triage / survey / retro / pr-watcher / pr-responder / 依存昇格 / 衝突トリアージ のいずれか)。ここで決めるのは provider・model・mode と経路だけであり、プロンプト文面は各起動箇所にある (移したのは起動パラメータの解決だけである)。

## 役割の表

| 役割 | 起動 | provider・model の解決元 | mode | 経路 |
|---|---|---|---|---|
| `executor` | background | `impl` (`impl_provider=` が上書き) | claude: `bypassPermissions` / omp: `full` | 現行のみ (Paseo には停止通知の受け口が無い) |
| `verifier` | 同期 | `audit` (`verify_provider=` が上書き) | **無人実行できる mode** — claude: `bypassPermissions` / omp: `full` | Paseo 優先 → 現行 (`task-pipeline-verifier` → `general-purpose`) |
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
- **verifier が target project を変更しない担保は `references/verifier.md` の行動境界の記述にあり、mode は担保にならない** — 無人で回せる mode (claude `bypassPermissions` / omp `full`) はどれも書き込み自由で、書き込みを禁じる claude の `plan` は verdict の書き出しができないので選べないからである。現行ハーネス経路では、これに加えて agent type の `tools:` が機械的な裏打ちになる (Paseo 経路にはその裏打ちが無い)。
- **現行ハーネス経路では provider を選べない** (Claude 固定)。解決した provider がそれ以外になった役割をこの経路で起動するときは、model も指定せずセッション継承に落とし、その旨を history に 1 行残す。

## 経路の選択とフォールバック

1. **Paseo 経路を第一候補にする** (`paseo run` で起動、`paseo send` で再開)。CLI が PATH に無ければ実体パスで起動する (OS ごとの在処は `~/.claude/skills/paseo/SKILL.md`)。返り値は、初回は `--output-schema` を付けて stdout の最小 JSON で受け、**再開 (`send`) には同等の指定が無い**ので verdict ファイル (verifier) か `paseo logs <agentId>` から読む。
2. **失敗したら現行ハーネス経路 (Agent tool / SendMessage) に落ちる。落ちたら history に 1 行残す** (`agent-launch: paseo 経路が失敗 (<理由>) — 現行経路で <役割> を起動`)。「verifier agent type 未インストール → general-purpose」と同型の作法であり、落ちたこと自体は失敗ではない。
3. **落ちてよいのは「エージェントが生まれなかった」と言い切れる失敗だけである**: 起動コマンドが非ゼロで終了した、または agentId が返らなかったとき。起動した後の失敗 (待ちのタイムアウト、契約外の応答) では落ちない — `paseo run` は冪等ではなく、再試行がそのまま 2 体目の生成になる (`docs/paseo-subagent-2026-08.md` 実測 1 の副次観測)。落ちる前に `paseo ls -a --label` で重複が残っていないかを確かめる。
4. **どちらの経路も使えないときは、その役割をオーケストレーターが自分で代行しない** (「コンテキスト規律」と「検証ゲートの絶対規則」)。扱いは役割で分かれる:
   - **タスクに紐づく役割** (`executor` / `verifier`) → そのタスクを `state.ts block` にして 1 行報告し、`PushNotification` を 1 本送る (SKILL.md「毎イテレーションの手順」2 の規定どおり)。ループは止めない。
   - **アダプタ** (`adapter-list` / `adapter-mark`) → トラッカー不通と同じ扱いにして、`playbooks/depleted.md` の手順 2 でループを止める。
   - **ベストエフォートの役割** (`survey` / `retro` / `pr-watcher` / `pr-responder` / `依存昇格` / `衝突トリアージ`) → その回は飛ばし、history に 1 行残して続行する。
