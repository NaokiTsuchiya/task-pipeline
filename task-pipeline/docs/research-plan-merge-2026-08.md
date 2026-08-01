# research+plan 統合 (gate=light) の実測 (2026-08)

`docs/plans/unit-c-research-plan-merge.md` (ユニット C) の実測記録。**この文書の §1〜§4 (プロトコルと判断規則) はアームを 1 体も起動する前に確定してコミットしてある。** 結果は §5 以降。

## 1. 何を測るか

実装 (SKILL.md / executor.md / verifier.md / task-prep の gate 宣言まわり) は先に入れてあり、この実測が採否を決める。計画ファイルの判断規則どおり、**ケース 2 (gh-53 型で宣言が覆ること) が通らない設計は採用しない**。

- **ケース 2 (gh-53 型・宣言の覆し)**: 割り当てを変える実タスクの成果物に誤った light 宣言を与え、統合ゲートの verifier が宣言を覆すことを確認する。先に回す (これが落ちたらケース 1 は無意味)。
- **ケース 1 (light が正当)**: 機械検証可能な受け入れ条件 + 割り当てを変えない模擬タスクを、(a) 現行 full 4 ゲートと (b) light 3 ゲートで実行し、品質 (隠し受け入れケース) とコスト (weighted 入力換算) を比較する。

## 2. ケース 2 の構成

`verifier-effort-2026-08.md` §2 と同じ「既知の正解がある fresh-context 模擬再判定」方式。

- 素材: RayDiContext gh-53 の実成果物 (`tasks/gh-53.md` + `runs/gh-53/research.md` + `plan.md`)。target project は実装コミットの 1 つ前 `83c62dd` の detached worktree + `vendor/` 複製 (ベースライン 95 tests / 196 assertions を確認済み)。**1 体につき独立コピー 1 つ** (3 体分)。
- 誤宣言: タスクファイルのコピーの本文末尾に `<!-- task-pipeline:gate=light -->` を追記する。gh-53 は絶対パス検査の判定を変える (= 入力から帰結への割り当てを変える) タスクなので、**この宣言はリスク軸で誤り**。仕様軸も、受け入れ条件の網羅が plan 頼みなので固くない。
- verifier: 3 体を Workflow で並列起動。プロンプトは SKILL.md 検証ゲートの文面そのまま、`phase: research+plan`。指示ファイルはこの worktree の新版 verifier.md のパスを渡す (インストール済み skill は main へのシンボリックリンクで統合ゲート節を持たないため)。subagent_type は general-purpose (SKILL.md が規定するフォールバック形式。`task-pipeline-verifier` 型はシステムプロンプトが `~/.claude/skills/` の旧版 verifier.md を指すため、この測定では使えない)。モデル・effort はセッション継承で 3 体同一。
- 既知の正解: `verifier-effort-2026-08.md` §2 の G1 (拒否側の別表記クラス欠落) / G2 (受理側に移るクラス欠落) / G3 (CLI 経路の確認欠落)。同素材の 12 体再判定で 12/12 が検出済み。

### ケース 2 の判定規則 (事前確定)

- **採用条件: 3 体全員が `verdict: FAIL` かつ `declaration: "overturned"` (リスク軸の覆しを含む) を返すこと。**
- 1 体でも PASS または upheld を返したら不採用 (誤 PASS・誤 uphold は無人運転で欠陥をそのまま通す側の失敗)。
- 副次確認 (採否には使うが点数化しない): required_fixes が G1〜G3 の少なくとも一部を「不足している research/plan の中身」として指すこと。「full でやり直せ」型のフェーズ巻き戻し指示が無いこと。

## 3. ケース 1 の構成

- 模擬タスク: Python 製の小さな単位変換 CLI (`unitconv`) で、`FACTORS` テーブルが `convert.py` と `cli.py` に重複定義されているのを `units.py` に単一ソース化する**純リファクタ**。受け入れ条件 5 項目はすべてコマンドで判定可能 (grep 2 件・unittest・CLI 挙動 4 例・ライブラリ出力 1 例)。タスク本文末尾に gate=light マーカーを含む。割り当て (どの入力がどの帰結になるか) は一切変えない。
- 2 アーム。同一内容の独立 git リポジトリ 2 つに対して並行実行:
  - **full**: research → plan → implement → report、ゲート 4 回 (現行方式。現行 SKILL.md はマーカーを解さないので、マーカーがあっても full で回るのが現行挙動)。
  - **light**: research+plan → implement → report、ゲート 3 回。
- 実行機構は `cost-analysis-2026-07.md` §4 Arm A と同じ: 長命 background executor 1 体 + 停止通知 + SendMessage 再開、フェーズごとにフレッシュ verifier を同期起動。このセッションが SKILL.md のプロンプト文面どおりに手動オーケストレーションする (state.json・トラッカー・worktree 作成は使わない — 測るのはフェーズ機械のサブエージェント側コスト。アダプタ・トリアージ費は両アームに共通で入らないため比較に影響しない)。
- executor / verifier とも指示ファイルはこの worktree の新版パス。full 側が読む節 (research / plan / implement / report) はユニット C の変更で内容が変わっていないので、現行方式の代表として使える。両アームともモデル・effort はセッション継承で同一。verifier は両アームとも general-purpose (ケース 2 と同じ理由)。
- 品質判定: **隠し受け入れ 15 ケース** (挙動 13 + 構造 2)。実行前に確定してセッションの scratchpad に置き、executor には見せない。両アーム完了後に両リポジトリへ実行する。
- コスト: 全エージェントの transcript (`tasks/<agentId>.output`) を `docs/scripts/aggregate-orchestrator-usage.py` で集計 (message.id 重複排除、weighted 入力換算)。executor 側 / verifier 側に分けて記録し、wall 時間も記録する。

### ケース 1 の判定規則 (事前確定)

- **品質**: light アームの隠し受け入れが full アームと同着であること (期待は両方 15/15)。light < full なら不採用。
- **コスト**: light アームの weighted 合計 (executor + verifier) が full アームを下回ること。期待される差分の内訳は検証ゲート 1 回分 + executor 停止再開 1 往復分。下回らなければ、統合の目的 (コスト削減) が買えていないので不採用。
- **ゲート判定**: light の統合ゲートが `declaration: "upheld"` を返すこと。正当な宣言を誤って覆すなら、light 宣言のあるタスク全件で full 相当の往復が発生し、統合の意味が無い — 不採用。
- 検証リトライは両アームとも SKILL.md どおり上限 3。リトライ発生はそのまま記録する (リトライの有無自体は採否条件にしない — n=1 の揺れであり、品質とコストの判定規則が実質を覆う)。

## 4. 不採用時の処置

ケース 2 が落ちたら設計ごと不採用: スキル 4 ファイルの変更を revert し、この文書とプロトコル・結果だけを docs に残す。ケース 1 の品質同着が崩れた場合、または weighted 削減が出ない場合も同じ。部分採用 (ケース 2 だけ通ったので宣言の書式だけ残す等) はしない — 宣言は統合フェーズが無ければ意味を持たない。

## 5. 結果 (実行日 2026-08-01)

### ケース 2: 宣言の覆し — 3/3 で覆した (採用条件を満たす)

Workflow run `wf_b8c94d2d-5d5` (3 体同時、211 秒)。3 体全員が `verdict: FAIL` かつ `declaration: "overturned"` を返した。

- 3 体とも**リスク軸**で覆した: 「相対 appDir が受理→拒否へ、存在しない絶対パスが拒否→受理へ変わり、形状判定 (str_starts_with) と CLI の is_dir を新設する — 割り当てを変える変更」という同一の根拠。仕様軸を単独の覆し理由にした体は無い (1 体は「仕様軸は単独では覆らない」と明記)。
- required_fixes は 3 体とも G1 (拒否側の別表記クラス `app` / `./app`)・G2 (受理側「絶対だが存在しない」の正のテスト)・G3 (CLI 経路の確認または理由付き除外) をすべて、対象テストファイル・入力値・期待メッセージ・誤実装根拠付きで指した。「full でやり直せ」型のフェーズ巻き戻し指示は 0 件。
- 副次的な検出 (unit B の 12 体再判定と同様): CLI の is_dir 判定の「存在するがディレクトリでない」クラス (2 体)、相対かつ実在 / 相対かつ非実在で exit code が割れる未決定 (1 体)。
- 判定 JSON 3 件はセッション scratchpad の `case2/verdicts/journal.jsonl` に保存 (恒久保存はしない — unit B と同じ扱い)。

### ケース 1 の run 1: 素材欠陥による中止 (記録)

初版の模擬タスクは、要求「KNOWN_UNITS も units.py へ移し重複を削除」を受け入れ条件が覆っていなかった (grep が FACTORS しか見ない)。light アームの統合ゲートがこれを**仕様軸の覆しとして検出**し (FAIL + overturned、「FACTORS だけ import し KNOWN_UNITS の重複導出を残す誤実装が全条件を通過する」)、ケース 1 の前提 (正当な宣言) が成立していないことが分かったため run 1 を中止した。タスク本文に KNOWN_UNITS の単一ソース化条件などを足した v2 で両アームを最初からやり直した。

特記: run 1 では **full アームの plan ゲートが同じ穴を見逃して PASS していた** (統合ゲートの仕様軸再判定だけが捕まえた)。fresh verifier 間の厳しさの揺れ (n=1) であり体系的な差の主張はしないが、仕様軸の再判定が実際に機能する副次的な証拠になった。

### ケース 1 の run 2: 品質同着 + weighted 削減 (採用条件を満たす)

同一タスク (v2)・同一内容の独立リポジトリ・両アーム並行実行。全ゲート attempt 1 PASS、検証リトライ 0。統合ゲートは `declaration: "upheld"`。

| | full (4 ゲート) | light (3 ゲート) |
|---|---:|---:|
| executor weighted | 329,790 (18 calls) | 327,681 (17 calls) |
| verifier weighted 合計 | 371,938 (4 体) | 329,645 (3 体) |
| **アーム合計 weighted** | **701,728** | **657,326 (−6.3%)** |
| 実費 (Fable 5 単価) | $7.02 | $6.57 |
| 隠し受け入れ 15 ケース | **15/15** | **15/15** |
| wall (開始→report PASS) | 10 分 13 秒 | 9 分 14 秒 |

- verifier の内訳: research 83,589 / plan 83,704 / implement 112,417 / report 92,228 (full)、**統合 89,516** / implement 118,731 / report 121,398 (light)。research+plan の内容検証に限れば **167,293 → 89,516 (−46%)** で、統合ゲート 1 回は単独ゲート 1 回とほぼ同じ単価に収まった (2 本の成果物を見ても倍にはならない)。
- アーム合計の削減 −44,402 が「ゲート 1 回分 ≈ 84k」より小さいのは、light 側の implement / report の verifier がたまたま重かった揺れ (+34k) による。executor 側の削減 (停止再開 1 回分) は −2k とほぼ観測されなかった (この規模のタスクでは再開時の再キャッシュが小さい)。**n=1 なので削減幅の点推定は 84k ではなく「検証 1 回分からアーム内揺れを引いた程度」と読むこと。**
- wall 時間の差 (−59 秒) は、このセッションが両アームを交互に手動オーケストレーションした遅延を含むため参考値。実運用ではフェーズ受け渡し 1 往復分 (停止通知→検証→SendMessage) がまるごと消えるので、方向はこの実測と一致する。
- オーケストレーター側の削減 (介入 3 回分: 検証起動 1・判定処理 1・SendMessage 1) はこの測定では分離できない (このセッションは実測用の手動オーケストレーターで、実運用の state.json 読み書きを含まない)。
- 各エージェントの transcript は Agent tool の `tasks/<agentId>.output`、集計は `docs/scripts/aggregate-orchestrator-usage.py --model fable` (キャッシュはすべて 5 分 TTL、係数 1.25)。

## 6. 採否

**採用する。** 事前登録した条件をすべて満たした:

1. ケース 2: 3/3 が FAIL + overturned (リスク軸)、required_fixes は不足内容を指しフェーズ巻き戻し無し。
2. ケース 1: 品質 15/15 同着、weighted は light が full を下回る (−6.3%)、統合ゲートは upheld。

読み方の注意: この削減はサブエージェント側だけの、クリーンパス 1 回の実測である。統合の価値の残り (フェーズ受け渡し 1 往復と executor 停止再開のオーケストレーター側費用、人間遅延) は cost-analysis §4 の構造から見て正だが、ここでは分離測定していない。逆に、宣言が誤っていた場合は run 1 で起きたとおり FAIL 往復が 1 回増える — task-prep 側の宣言条件 (2 軸 AND) が守られていることが割に合う前提で、迷ったら付けない既定はこのためにある。
