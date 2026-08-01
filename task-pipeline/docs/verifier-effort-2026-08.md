# 検証ゲートの effort 実測 (2026-08)

`docs/plans/unit-b-verifier-effort.md` (ユニット B) の実測記録。経路の実装 (`agents/task-pipeline-verifier.md` /
`install.sh` / `SKILL.md` の subagent_type) は先に入れてあり、**この文書が採否を決める**。

判断規則・判定軸・入力は**実行前に確定**した (この節はアームを 1 体も起動する前に書いてコミットしてある)。

## 1. 何を測るか

verifier の誤りは非対称である — 誤 PASS は無人運転で実装欠陥をそのまま通す。そこで「検証ゲートだけ
reasoning effort を上げる価値があるか」を、**既知の正解がある 1 件の再判定**で測る。

3 アーム。**モデルは 3 アームとも Opus 5 に固定**する (Workflow の `agent()` の `model: 'opus'`)。
ベースラインをユーザーが普段パイプラインを回すモデルに揃えるためで、これを固定しないと
「effort の差」と「セッション既定モデルの差」が混ざる。

| アーム | subagent_type | effort | 意味 |
|---|---|---|---|
| A (ベースライン) | `general-purpose` | セッション継承 (指定なし) | 現行 SKILL.md の検証ゲートそのもの |
| B | `general-purpose` | `high` | 出荷予定の `agents/task-pipeline-verifier.md` と同じ effort |
| C | `general-purpose` | `max` | 用量反応を見る (high で差が出ないとき、knob が効いていないのか効果が無いのかを分ける) |

- 起動プロンプトは 3 アームとも **SKILL.md の検証ゲートの文面そのまま**で同一。定義もモデルも同一で、
  **差は effort だけ**である。
- 各アーム 3 回 (計 9 体)。9 体は同時起動する。

### 当初計画からの逸脱 (frontmatter 経路が測れなかったこと)

`docs/plans/unit-b-verifier-effort.md` は「アーム 2 = `task-pipeline-verifier` を effort 無しで /
アーム 3 = `effort: high`」、つまり **frontmatter 経由**で測る設計だった。これは実行できなかった:

- カスタムサブエージェントのレジストリは**セッション開始時に固定される**。実測用の定義を
  `<project>/.claude/agents/` と `~/.claude/agents/` の両方に置いて `agent({agentType})` を叩いたが、
  どちらも `agent type '...' not found. Available agents: ...` で拒否された (同じセッションの中で
  作ったファイルは載らない。セッション開始前から居た `terraform-reviewer` は載っている)。
  実測ログ: run `wf_d4b496df-64b` (project 配下) / `wf_698aa6ee-227` (`~/.claude/agents/` 配下)。
- そこで effort は `agent()` の `effort` オプションで与えた。**同じ reasoning effort という knob を
  別の入口から与えているだけ**で、モデルも定義もプロンプトも 3 アームで同一なので、
  「effort を上げると検証の質が上がるか」という問い自体は変わらずに測れる。
- 測れなくなったのは 2 つ: (1) frontmatter の `effort:` 行が実際に効くことの直接確認、
  (2) 当初アーム 2 が担っていた「エージェント定義の差 (system prompt + `tools` 制限) だけの効果」。
  (2) は本来 effort とは別の目的 (verifier が target project を書き換えないという行動境界の機械的裏付け)
  のものなので、品質レバーとしての採否判断はこの実測で決められる。(1) は**残る宿題**で、§5 に扱いを書く。

## 2. 入力 (既知の正解がある再判定)

`docs/plan-test-floor-2026-07.md` と同じ「実成果物への fresh-context 模擬再判定」。パイプラインは回さない。

- 素材: RayDiContext gh-53 の実成果物 — `tasks/gh-53.md` / `runs/gh-53/research.md` / `runs/gh-53/plan.md`。
  この plan は**旧基準では PASS 判定を受けている** (`verdicts/plan-2.json` が PASS)。
- target project: gh-53 の実装コミット `ca532a8` の **1 つ前** `83c62dd` を detached worktree で復元したもの
  (plan 時点の現物)。`vendor/` を複製して `vendor/bin/phpunit` が動く状態にした (ベースライン
  95 tests / 196 assertions = research.md の記載と一致)。**9 体それぞれに独立したコピー**を与える
  (テスト実行の相互干渉と、万一の書き込みの伝播を断つため)。
- 各体には run dir として `research.md` + `plan.md` だけを置いたディレクトリを渡す
  (`implementation.md` / `report.md` / `verdicts/` は入れない — plan フェーズの再判定なので)。
- plan.md 中の検証手順は元の worktree パス (`.../worktrees/task-pipeline/gh-53`) を書いているが、
  各体にはプロンプトで別の target project パスが渡る。**この読み替えはアーム間で共通**なので比較には効かない。

### 既知の正解

現行の `references/verifier.md` (テスト網羅の最低ライン入り) を当てれば、この plan は **FAIL** になるはずである。
根拠は PR #55 (同じ issue を通常セッションが処理した実成果物) との実差分で、
`plan-test-floor-2026-07.md` §検証の第 1〜3 ラウンドが再現した 3 つの穴:

- **G1 拒否側の別表記クラス**: plan は相対パス拒否を `.` の 1 表記でしか固定していない。
  `app` / `./app` のような別表記クラスが落ちている (`$appDir === '.'` 型の誤実装を検出できない)。
- **G2 受理側に移るクラス**: realpath 除去で「絶対だが存在しない appDir」は AppMeta では**受理**に変わる。
  plan はこのクラスの代表ケースを持たない (`rejectsEmptyAppDir` へ縮退させただけで、受理側の固定が無い)。
- **G3 経路ごとの確認**: 変更した判定 (絶対パス検査) に CLI 経由で到達する確認が無い。plan の CLI テストは
  「存在しない appDir → exit 2」だけで、相対パスが CLI をどう抜けるかは素通し。

## 3. 判定軸

各体の返す verdict JSON を、次の 3 軸で採点する。採点は同一の基準でアームを伏せずに行うが、
G1〜G3 の照合は文面のマッチングなので判定者の裁量はほとんど入らない。

- **(a) 検出**: `verdict` が FAIL であること (PASS = 誤 PASS、この 1 件では最悪の結果) を前提に、
  G1 / G2 / G3 のそれぞれを `reasons` または `required_fixes` が指しているか。0〜3 点。
- **(b) 具体性**: `required_fixes` の各項目が「executor がそのまま着手できる」か。項目ごとに
  2 = 対象ファイル/テスト名・入力値・期待結果まで書いてある / 1 = 何を足すかは分かるが入力値か期待結果が曖昧 /
  0 = 方針だけ。加えて verifier.md がクラス追加時に課している**誤実装明示義務**
  (「既存の代表では検出できない誤実装」を書く) を満たしているかを別に数える。
- **(c) 実費**: 各体の transcript (`agent-<id>.jsonl`) を `docs/scripts/aggregate-orchestrator-usage.py`
  で集計する (message.id で重複排除。入力換算 weighted と Opus 5 単価での USD)。wall 時間も記録する。

補助指標として**余剰要求数** (G1〜G3 以外に追加を求めたクラス・経路の数) を数える。verifier.md は
余剰クラスを FAIL 理由にしない規則なので減点はしないが、executor の往復を増やすコストなので記録する。

## 4. 判断規則 (実行前に確定)

- アーム B / C が**アーム A に対して (a) 検出でも (b) 具体性でも改善しない**なら、`effort: high` を
  **採用しない** — `agents/task-pipeline-verifier.md` から `effort` 行を落とす。
  エージェント定義そのもの (`tools` 制限 + subagent_type の固定) は effort とは別の目的なので残す。
- 改善があるなら、その改善を (c) のコスト増と突き合わせて採否を書く。C (max) にだけ改善があり
  B (high) に無いなら、`effort` の値を上げるかどうかを別に判断する。
- (a) の点差より **誤 PASS の有無を重く見る**。1 体でも PASS を返すアームは、他の軸で勝っていても
  「無人運転で欠陥を通す確率がある」側として扱う。
- 3 回では偶然が残る。差が 1 体分しかない場合は「差が無い」と読む。
- **knob が効いているかの前提確認**: (c) の処理量 (output / thinking を含む processed) が
  A ≈ B ≈ C なら effort 指定が届いていないということなので、質の差は「効果が無い」ではなく
  「測れていない」と読む。この場合は採否を保留し、§5 にそう書く。

## 5. 結果

(実行後に記入)
