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
  95 tests / 196 assertions = research.md の記載と一致)。**1 体につき独立したコピー 1 つ**を与える
  (テスト実行の相互干渉と、万一の書き込みの伝播を断つため。最終的に 12 体分)。
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

実行日 2026-08-01。計 12 体 (A/B/C 各 3 + 較正用の D 各 3)。実測ログ:
run `wf_fa31f4a3-57c` (A/B/C 9 体、同時起動、391 秒) と run `wf_7b454ea6-0ae` (D 3 体、140 秒)。

### 追加したアーム D (medium)

A/B/C を回した後、**アーム A (継承) の effort が実際にどこにあるか分からない**ことが問題になった
(A ≈ B なら「high に効果が無い」のか「継承が既に high」なのか区別できない)。そこで
`effort: 'medium'` の較正アーム D を 3 体足した。medium はハーネスの既定値であり、ユーザーが
既定設定でパイプラインを回すときの実質的なベースラインでもある。

### (a) 検出

**12 体すべて FAIL。誤 PASS は 0 件。** G1 / G2 / G3 は **12 体すべてが 3 つとも指摘した** (12/12 × 3)。
つまり検出は effort に関わらず飽和している。旧基準では PASS だった plan (`verdicts/plan-2.json`) が
現行 verifier.md では全員 FAIL になる、という `plan-test-floor-2026-07.md` の結論もそのまま再現した。

G1〜G3 の外側で拾われた**実在の穴** (私の正解セットに入れていなかったもの):

| 追加の指摘 | 拾った体 |
|---|---|
| `bin/ray-di-compile` の新設 `is_dir()` の拒否側に「存在するがディレクトリでないパス」クラスが無い (`file_exists()` 実装を検出できない) | a1 a2 b1 b2 b3 c1 c3 d3 (8/12) |
| CLI 経路の exit code が割れる — 相対かつ実在 (`app`) は `is_dir()` を通過して exit 1、相対かつ非実在は exit 2。plan がどちらに寄せるかを決めていない | c2 |
| 受理側の「`..` を含む絶対パス」クラス (plan の README 改訂文が「`..` は解決しない」と主張するのに固定するケースが無い) | c1 |
| **README.md 104 行の Exit status 表**に `appDir does not exist` が残る。plan §3 は 14-15 行しか対象にしておらず、受け入れ条件の `grep -n realpath README.md` はこの行に `realpath` の語が無いためヒットしない | **d1 (medium)** |

最後の 1 件は現物で確認した (README.md:104 に該当記述が実在する)。**effort が最も低いアームが、
max アームの誰も拾わなかった実在の穴を拾っている** — 尾の部分の検出は effort で順序づけられていない。

なお a1 / a3 / d1 は「plan の検証手順の `cd` 先が target project と違う」も挙げたが、これは
§2 に書いた**測定側の読み替えの産物**なので採点から除外した。

### (b) 具体性

12 体すべてが、G1〜G3 それぞれについて対象ファイル・テストメソッド名・入力値・期待メッセージまで
書いた (具体性の満点 = 2 点)。verifier.md がクラス追加時に課す**誤実装明示義務**も 12 体すべてが満たしており
(`$appDir === '.'` 型、`str_starts_with($appDir, '.')` 型、`file_exists()` 型を名指ししている)、
アーム間の差は無い。

唯一見つかった質の差は CLI 経路の fix の**実行可能性**である:

- c1 / c3 は `tests/Fake/Cli.php` を開いて `proc_open($command, $descriptors, $pipes)` に cwd 引数が
  無いことを確かめ、「相対名を argv に載せるには `.` を渡すか `Cli::run` に cwd を渡せる形にする」
  という制約付きで fix を書いた。**現物を確認した (`Cli.php:36` に cwd 引数は無い)。**
- a3 は「`Cli::run()` の作業ディレクトリを `{$this->baseDir}` にして」と書いており、**そのままでは
  実行できない** (ヘルパの改修が要ることに触れていない)。
- 残り 9 体は `.` を直接渡す形にしたので、この制約に当たらない。

つまり差は「C が体系的に上」ではなく「A の 1 体が滑り、C の 2 体がその落とし穴を明示した」である。
事前登録した「差が 1 体分しかない場合は差が無いと読む」に照らして、**具体性でも有意な改善は無い**。

### (c) 実費と処理量 (3 体平均、Opus 5 単価)

| アーム | API コール | processed | weighted (入力換算) | output | 実費 | medium 比 |
|---|---|---|---|---|---|---|
| D (medium) | 6.3 | 346,688 | 141,103 | 6,174 | $0.706 | — |
| A (継承) | 7.7 | 455,934 | 171,685 | 7,896 | $0.858 | weighted ×1.22 |
| B (high) | 7.7 | 437,438 | 163,986 | 9,108 | $0.820 | weighted ×1.16 / output ×1.48 |
| C (max) | 15.3 | 1,190,250 | 320,972 | 18,488 | $1.605 | weighted ×2.27 / output ×2.99 |

**knob は効いている**: output トークン (thinking を含む) が medium → high で ×1.48、medium → max で
×2.99、API コール数も max で 2.4 倍。§4 の前提確認 (A ≈ B ≈ C なら「測れていない」と読む) は
クリアしており、**質の差が無いのは「effort が届いていないから」ではない**。

継承 (A) は medium と high の間、high 寄りにある (output 7,896 は medium 6,174 と high 9,108 の間)。
n=3 なので断定はしないが、**このセッションの継承 effort は medium より上**である。ここが
ユーザーのセッション設定で動く以上、A を唯一のベースラインにせず D を足したのは正解だった。

## 6. 採否 (§4 の判断規則の適用)

**`effort: high` は採用しない。** `agents/task-pipeline-verifier.md` から `effort` 行を落とす。

- (a) 検出: A / B / C / D で**完全に同点** (12/12 が G1〜G3 を検出、誤 PASS 0)。改善なし。
- (b) 具体性: アーム間で差なし (上記のとおり 1 体分の揺れ)。改善なし。
- したがって §4 の第 1 項「(a) でも (b) でも改善しないなら採用しない」に該当する。
- (c) を持ち出すまでもないが、コスト面でも high は medium 比 weighted +16%、max は +127% で、
  買えているものが無い。`cost-analysis-2026-07.md` §2 のとおり verifier は既に報告値の 21% を
  占めており、そこに理由なく上乗せする根拠が無い。

**残すもの**と理由:

- `agents/task-pipeline-verifier.md` 自体は残す。`tools: Read, Grep, Glob, Bash` は「verifier は
  target project を変更しない」という行動境界の機械的な裏付けで、effort とは別の目的である
  (品質レバーではないので、この実測の結果に採否が従属しない)。
- `install.sh` の `agents/` 対応と `SKILL.md` の `subagent_type` + フォールバックも残す。
  未インストール環境では general-purpose に落ちるので、skill 単体の動作は変わらない。

### この実測が答えていないこと (宿題)

1. **frontmatter の `effort:` 行が実際に効くことは未確認。** §1 のレジストリ制約で測れなかった。
   ただし `effort` 行を落とす判断をしたので、出荷物には効かない不確実性は残らない。
   将来 effort を入れたくなったときは、この確認を先にやること。
2. **`tools` 制限下で verifier が実際に動くことは未確認** (同じレジストリ制約による)。制限しているのは
   Write / Edit だけで、verifier.md はそもそも書き込みを禁じており、一時スクリプトが要る場合も
   Bash のヒアドキュメントで足りる — と机上では言えるが、**インストール後の最初の 1 本は観察すること**。
   検証ゲートが起動できずに落ちるようなら、フォールバック経路 (general-purpose) が受け止める。
3. **1 タスク 1 フェーズしか測っていない。** gh-53 の plan フェーズは「既知の正解がある」という
   条件を満たす唯一の手持ち素材だが、`implement` / `report` / `pr_fix` の検証や、仕様の曖昧な
   タスクでは effort の効き方が違いうる。この結論は「plan フェーズの網羅判定という、基準が
   verifier.md に明文化されている作業では effort を上げても変わらない」と読むのが正確である。
   逆に言えば、**明文化された基準は effort より安く効く** — 今回 12 体すべてを FAIL させたのは
   effort ではなく `plan-test-floor-2026-07.md` が入れた最低ラインの文言である。

### 再現用

- 素材の組み立て: `83c62dd` (gh-53 実装の 1 つ前) の detached worktree + `vendor/` 複製 + run dir に
  `research.md` / `plan.md` のみ。12 体分の独立コピーを作った。
- 判定 JSON 12 件と集計コマンドはセッションの scratchpad に置いた (`measure/verdicts/`)。
  実費集計は `python3 docs/scripts/aggregate-orchestrator-usage.py <agent-*.jsonl> --model opus`。
