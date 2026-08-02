# 集計スクリプトが統合フェーズ (research+plan) を分類できないのを直し、テストで固定する

依存: test-harness-foundation

## 背景 / 現状

`task-pipeline/docs/scripts/aggregate-session-usage.py` は、起動プロンプトと結果行からフェーズを取り出して役割別・フェーズ別の内訳を出す。その正規表現が 2 箇所とも `\w+` を使っている (2026-08-02 時点):

```
32:    m = re.search(r'phase:\s*(\w+)', p)
42:    m = re.search(r'PHASE\s+(\w+)\s+DONE', r)
```

`\w` は `+` を含まないため、`task-pipeline/SKILL.md` が規定する**統合フェーズの 1 トークン `research+plan`** を扱えない。実行して確認済み:

- `phase: research+plan` は `research` に誤分類される
- `PHASE research+plan DONE` は不一致になる (フェーズ不明として落ちる)

gate 宣言のある (light な) タスクを含むセッションを集計すると、内訳が静かに狂う。集計結果は `docs/cost-analysis-2026-07.md` のような判断材料に使われるので、狂った内訳は設計判断そのものを誤らせる。

集計スクリプトは 2 本 (`aggregate-session-usage.py` と `aggregate-orchestrator-usage.py`) あり、どちらにもテストが無い。

このアイテムは `scripts-test-harness` を分解した 3 件のうちの 1 つで、**集計スクリプト 2 本のテストと、上記の正規表現バグの修正**だけを扱う。

## 要求

1. `test-harness-foundation` のハーネス (`tests/run.sh`) に、集計スクリプト 2 本のケースを追加する。入力は数行の `.jsonl` フィクスチャで、ネットワーク・実セッションログに依存しない。フィクスチャは最低限、次を含む:
   - `message.id` の重複 (重複排除されることの確認)
   - `cache_creation` の内訳があるレコードと無いレコード
   - `phase: research+plan` を含む起動プロンプトと、`PHASE research+plan DONE` を含む結果行
2. **先に FAIL するケースを書いてから直す。** `research+plan` のフィクスチャに対して現状のスクリプトが誤分類することをケースで示してから、正規表現を修正する。
3. `aggregate-session-usage.py` の 32 行・42 行の正規表現を、**`research+plan` を 1 トークンとして扱える形**に直す。既存のフェーズトークン (`research` / `plan` / `implement` / `report` / `pr_fix` / `rebase_fix` / `finalize`) の分類結果は変えない。
4. `aggregate-orchestrator-usage.py` にも同種の正規表現があるなら同じく直す。無ければ「無い」ことを成果物に記す (推測で直したことにしない)。
5. 出力の形式は変えない。既存の集計結果と比較できなくなるので、列や見出しの変更はこのアイテムでは行わない。

## 受け入れ条件

1. `phase: research+plan` を含む起動プロンプトと `PHASE research+plan DONE` を含む結果行のフィクスチャに対し、`aggregate-session-usage.py` が **`research+plan` という 1 つのフェーズとして**分類する (`research` でも「不明」でもない) ケースがハーネスにあり、PASS する。
2. **修正前のスクリプトでは条件 1 のケースが FAIL する**ことを確認した記録が成果物にある (実出力を含む)。
3. 既存フェーズトークンのフィクスチャ (`research` / `plan` / `implement` / `report` / `pr_fix` / `finalize` を含むもの) に対する分類結果が、修正前後で一致する。
4. `message.id` が重複するフィクスチャで、重複が 1 回だけ数えられることを確認するケースがあり、PASS する。
5. `cache_creation` の内訳がある行と無い行が混ざったフィクスチャで、期待する集計値と一致することを確認するケースがあり、PASS する。
6. `aggregate-orchestrator-usage.py` について、同種の正規表現の有無を実際に確認した結果が成果物に書かれている (あれば修正され、そのケースがハーネスにある)。
7. 出力の形式 (列・見出し) に差分が無い。
8. `sh tests/run.sh` が全ケース PASS で exit 0。
9. `python3 -m py_compile` が両スクリプトで通る。
