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

## 5. 結果

(実行後に記録する)
