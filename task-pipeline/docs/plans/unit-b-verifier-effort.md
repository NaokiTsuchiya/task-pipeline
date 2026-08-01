# ユニット B: 検証系サブエージェントの effort 制御経路 (P10)

このファイルだけで新しいセッションが作業を開始できるように書いてある。前提になった設計レビュー (2026-08-01) の全文はセッション記録にしかないので、疑問点はこのリポジトリの現物 (`task-pipeline/SKILL.md`、`references/`、`docs/cost-analysis-2026-07.md`) を正とすること。

## 目的

task-pipeline の検証ゲート (verifier) に reasoning effort を指定できる経路を作り、**効果を実測してから**採否を決める。動機: verifier の誤りは非対称 (誤 PASS は無人運転で実装欠陥をそのまま通し、pr-watcher の誤判定は無人の修正サイクルを駆動する) なので、ここだけ effort を上げる価値がありうる。ただし品質向上は未実測なので、この作業の成果物は「経路 + 実測記録 + 採否判断」の 3 点セットである。

## 確認済みの事実 (2026-08-01 時点、再確認は下記 URL)

- Agent tool のパラメータは `model` のみで、effort 相当は無い。
- `.claude/agents/*.md` (カスタムサブエージェント定義) の frontmatter には `model` と `effort` がある。`effort: low|medium|high|xhigh|max`、既定はセッションから継承。出典: https://code.claude.com/docs/en/sub-agents.md (Supported frontmatter fields の表)。
- SKILL.md frontmatter にも `model`/`effort` があるが、skill アクティブ中のセッション全体 (= オーケストレーター、そこから継承する triage まで) に効く鈍いレバーなので今回は使わない。出典: https://code.claude.com/docs/en/skills.md。
- コスト前提: verifier は過去 5 タスク実測で 42 回・報告値 21%・wall 時間は executor の 8 割 (`docs/cost-analysis-2026-07.md` §2)。effort を上げればこのコストはさらに増える — だから実測が要る。

## 変更内容の骨子

1. リポジトリに `agents/task-pipeline-verifier.md` を新設する。最小構成:

   ```markdown
   ---
   name: task-pipeline-verifier
   description: task-pipeline の検証ゲート専用。オーケストレーターが明示起動する。自発的な委譲には使わない。
   tools: Read, Grep, Glob, Bash
   effort: high
   ---
   You are a fresh, independent verifier for one phase of a task-pipeline task.
   Read ~/.claude/skills/task-pipeline/references/verifier.md and follow it.
   The launch prompt gives you: phase / task file / run dir / target project.
   Return only the verdict JSON.
   ```

   - 本文は現行の起動プロンプト (SKILL.md「タスク実行」手順 6) と同じ内容に留める。**verifier.md の指示を frontmatter 側に複製しない** (真実は verifier.md の 1 箇所のまま)。
   - `tools` は読み取り + テスト実行に必要な最小 (Read/Grep/Glob/Bash)。書き込み系を外すことは「verifier は target project を変更しない」という行動境界 (ユニット A の P13 で verifier.md に明文化予定) の機械的な裏付けにもなる。ただし Bash がある以上完全な強制ではない点は認識しておく。
2. `install.sh` を拡張し、`agents/` 配下の *.md を `~/.claude/agents/` へ symlink する (skills と同じ冪等ルール: 既存の無関係エントリは上書きせず警告)。
3. `SKILL.md` の検証ゲート起動 (手順 6) を `subagent_type: task-pipeline-verifier` に変更する。**フォールバックを併記する**: Agent tool が unknown agent type エラーを返したら (未インストール環境)、従来どおり general-purpose で起動して history にその旨を残す — skill 単体でも動く状態を保つため。
4. (任意・第 2 段) pr-watcher にも同じパターン (`task-pipeline-watcher`、読み取り + findings 書き出しに必要な最小 tools) を適用してよいが、まず verifier の実測結果を見てから。

## 実測プロトコル (採否の根拠になる部分)

`docs/plan-test-floor-2026-07.md` が使った「実成果物への fresh-context 模擬再判定」方式を流用する。パイプラインを回す必要はなく、副作用も無い。

- 入力: gh-53 の実成果物 (task / research.md / plan.md — plan-test-floor の検証で使ったもの。所在が分からなければ捨てリポジトリ + 模擬タスクで代替し、その旨を記録する)。
- 3 アーム、各 3 回以上:
  1. 現行 = general-purpose、effort 継承 (ベースライン)
  2. task-pipeline-verifier、`effort` 行を削って継承 (**エージェント定義の差だけ**を分離)
  3. task-pipeline-verifier、`effort: high` (effort の効果を積む)
- 判定軸: (a) 既知の正解 (PR #55 との実差分 = 相対パス別表記クラス・受理側境界クラス・CLI 経由確認の欠落) を FAIL として検出するか、(b) required_fixes の具体性 (executor がそのまま着手できるか)、(c) 実費 — `docs/scripts/aggregate-session-usage.py` / `aggregate-orchestrator-usage.py` で集計 (重複排除キーの注意はスクリプト内コメント参照)。
- 判断規則を先に決めておく: アーム 2/3 がベースラインに対して検出・具体性で改善が無ければ**採用しない** (SKILL.md は general-purpose のまま、agents/ とinstall.sh 拡張は残しても害はないが revert してよい)。改善があればコスト増と突き合わせて採否を書く。

## 受け入れ条件

- `agents/task-pipeline-verifier.md` と install.sh の symlink 経路が存在する。
- SKILL.md の検証ゲートが subagent_type を指定し、未インストール環境のフォールバックが明記されている。
- 3 アームの実測記録が `task-pipeline/docs/` に残り (方式・回数・判定軸・数字)、採否の結論が書かれている。効果が無ければ差し戻した状態で終える (それも成果)。

## 制約と作法

- このリポジトリはリモート無し。PR は作れない。main から `task-pipeline/unit-b` 等のブランチを切ってコミットし、ローカルマージはユーザーに委ねる。
- git 署名は 1Password 連携。ハング/失敗したら `-c commit.gpgsign=false` でフォールバック。
- **task-pipeline 自身にこの作業を流さない** (自分を書き換えるブートストラップ + 実測主体でフェーズ分割が合わない)。
- ユニット A (整合性修正、P1〜P9/P12/P13) がマージ済みであることを前提にする。未マージなら SKILL.md の該当行番号がずれている可能性があるので、行番号ではなく節名で位置を特定すること。
- 推奨セッション構成: Opus 5 以上・effort high。編集量は小さく、作業の本体は実測の設計と判定。アームの並列実行には Workflow tool が向く (agent() の `effort` オプションはツールスキーマにあるが公式 docs 未記載 — 2026-08-01 時点)。

## 起動プロンプト例 (新セッションに貼る)

```
task-pipeline/docs/plans/unit-b-verifier-effort.md を読んで、その通りに実装と実測を進めてください。実測の判断規則はファイル記載のものを先に確定してから実行すること。
```
