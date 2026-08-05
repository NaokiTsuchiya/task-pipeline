# verdict の受け渡しをファイル経由にし、オーケストレータのコンテキスト増加を減らす

## 背景 / 現状

行番号は commit 0498660 時点。ずれていたら引用文言で grep すること。

オーケストレータのコンテキストは長い `/loop` で線形に増え続ける。2026-08-03〜04 に 8 タスクを連続実行したセッション (finish=commit, approve=auto) の実測:

- タスク 1 開始時 139,957 → タスク 8 終了時 371,892 トークン (**+29k / タスク**、8 タスクで +231,935)
- 自動コンパクションは**一度も発生していない** (`grep -c '"isCompactSummary":true'` が 0)。途中の見かけの下降はすべて cache TTL 失効で、prompt 実サイズは単調増加
- オーケストレータ単体の課金換算 $38.07 (sonnet、`aggregate-orchestrator-usage.py --model sonnet` の weighted 12,689,954)

増加分の内訳で最大のものが検証判定 (verdict) の往復である。verdict JSON は 1 タスクあたり約 8.5k 文字 (実測: `runs/finalize-flow-doc-fixes/verdicts/` 4 件で 8,661 文字、`runs/state-cli-lock-race-guards/` 4 件で 8,116 文字、`runs/adapter-protocol-sync/` 5 件で 8,597 文字) で、**その 91% が `reasons`** (`runs/finalize-flow-doc-fixes/verdicts/report-0.json` は全体 1,258 文字中 reasons が 1,146 文字)。

しかもこれはオーケストレータのコンテキストを **2 回**通る:

1. verifier の戻り値として (`task-pipeline/references/verifier.md:11` が `{"phase": ..., "verdict": ..., "reasons": [...], "required_fixes": [...]}` を返す契約、`agents/task-pipeline-verifier.md` の最終行も「Return only the verdict JSON.」)
2. **オーケストレータ自身がそれをファイルに書くため** (`task-pipeline/SKILL.md:215` 「判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き」、FAIL 側は `task-pipeline/SKILL.md:228` 「判定 JSON を PASS と同じ命名規則で保存してから」)

日本語主体のため文字数はおおむねトークン数に近く、往復 2 回で 1 タスクあたり十数 k トークンに達する — 実測増加 29k/タスクのおよそ半分がこの往復である。

`reasons` はオーケストレータが読む必要のない情報である。SKILL.md の分岐は PASS / FAIL だけを見ており、`reasons` は証跡としてファイルに残ればよい。FAIL 時の `required_fixes` も、SKILL.md:228 が「SendMessage で実行エージェントへ required_fixes をそのまま送り」としているだけで、**パスを渡して executor に読ませれば中身がオーケストレータを通る必要はない** (SKILL.md は他の箇所ではこの「指示本文ではなくパスを渡す」規律を一貫して使っている — 例: `task-pipeline/SKILL.md:44`「サブエージェントには指示ファイルの **パスを渡して先方に読ませる**」)。

`task-pipeline-verifier` agent の tools は `Read, Grep, Glob, Bash` (`agents/task-pipeline-verifier.md` の frontmatter) で **Write は無いが Bash があるため、自分でファイルを書ける**。

executor 側は `task-pipeline/references/executor.md:15`「修正指示 (required_fixes) → 同じフェーズの成果物と (implement / pr_fix なら) 実装を修正し」、同 `:82` (統合フェーズ) で required_fixes を受ける前提になっている。

## 要求

1. **verifier が判定 JSON を自分で書く。** 起動プロンプトで verdict ファイルの絶対パスを受け取り、そこへ書く。ファイル名規則 (`<phase>-<attempt>.json`、`pr_fix` は `pr_fix-<n>-<attempt>.json`、`rebase_fix` は `rebase_fix-<n>-<attempt>.json`) を組み立てる責務はオーケストレータのまま (現行どおり `attempts` と findings 連番を知っているのはオーケストレータであるため) で、verifier は渡されたパスに書くだけにする。
2. **verifier の戻り値を最小化する。** 返すのは `{"phase": "<phase>", "verdict": "PASS"|"FAIL"}` のみ。`reasons` と `required_fixes` は返さない (ファイルには従来どおり書く)。research+plan 統合ゲートの `declaration` フィールド (`task-pipeline/references/verifier.md:50`) は**返り値に残す** — オーケストレータが history に記録する必要があるため。
3. **オーケストレータは判定 JSON を書かない。** SKILL.md:215 / :228 から「判定 JSON を書く / 保存する」記述を削り、代わりに起動プロンプトへ verdict パスを渡す記述にする。
4. **FAIL 時は中身ではなくパスを送る。** SKILL.md:228 の「SendMessage で実行エージェントへ required_fixes をそのまま送り」を、verdict ファイルのパスを送る形に変える。`task-pipeline/references/executor.md` 側に、修正指示をそのパスから自分で読む手順を追加する。
5. **4 ファイルの整合を回帰テストで固定する**: `task-pipeline/references/verifier.md`、`agents/task-pipeline-verifier.md`、`task-pipeline/SKILL.md`、`task-pipeline/references/executor.md`。`tests/pr-watch-window-alignment.test.sh` と同型 (複数ファイル間で食い違うと落ちる grep ベースのテスト) で、`tests/run.sh` の glob から自動検出される場所に置く。

## 受け入れ条件

1. `task-pipeline/references/verifier.md` に、判定 JSON を verifier 自身が渡されたパスへ書く手順が記載されている。
2. `task-pipeline/references/verifier.md` と `agents/task-pipeline-verifier.md` の戻り値契約が `{phase, verdict}` (統合ゲートのみ + `declaration`) に絞られており、`reasons` / `required_fixes` を返り値に含める記述が残っていない。
3. `grep -n "判定 JSON を" task-pipeline/SKILL.md` に、オーケストレータがファイルを書く趣旨のヒットが無い (現行の :215 / :228 の 2 件が消えているか、verifier が書く旨に書き換わっている)。
4. SKILL.md の検証ゲート起動プロンプトに verdict ファイルの絶対パスを渡す記述があり、ファイル名規則 (3 形式すべて) がオーケストレータ側の責務として引き続き明記されている。
5. SKILL.md の FAIL 分岐が、required_fixes の中身ではなく verdict ファイルのパスを SendMessage で送る形になっている。
6. `task-pipeline/references/executor.md` に、FAIL の修正指示を渡されたパスから自分で読む手順が記載されている。
7. 追加した回帰テストが、4 ファイルのいずれか 1 つだけを旧契約 (`reasons` を返す等) に戻すと FAIL することを、実際に一時的に書き換えて確認した実行ログが implementation.md にある (確認後に復元し、`git diff` が意図した最終差分に一致することも示す)。
8. `sh tests/run.sh` が全スイート PASS (failed: 0)、追加したテストスイートが一覧に現れる。
