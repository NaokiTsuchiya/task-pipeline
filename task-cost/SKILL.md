---
name: task-cost
description: task-pipeline のセッション transcript から、役割 (adapter/triage/verifier/executor/pr-watcher) × フェーズ × attempt (verifier の初回/再検証) 別の課金換算コスト (weighted・実費) を 1 コマンドで出す。報告値 (subagent_tokens) と weighted (課金換算) を混同しない・集計できなかった呼び出し件数を必ず報告に載せる、の 2 規律を担保する。`/task-cost <session.jsonl> [--model M]`。
user-invocable: true
argument-hint: "<session.jsonl> [--model fable|opus|sonnet|sonnet-intro|haiku]  例: gh-53.jsonl --model sonnet"
---

# task-cost — 役割 × フェーズ × attempt 別の課金換算コストを出す

task-pipeline の実運用セッションから「どの役割の・どのフェーズの・初回か再検証かで、いくらかかったか」を出す。既存道具 (`aggregate-orchestrator-usage.py` は課金換算を出せるが役割もフェーズも知らない、`aggregate-session-usage.py` は役割とフェーズを分類できるが報告値 `subagent_tokens` しか出せない) の間を埋める第三の道具 `aggregate-role-phase-cost.py` を呼ぶ。

## 入口

`$ARGUMENTS`: `<session.jsonl> [--model M]`。`session.jsonl` はセッション transcript の絶対パスまたは `~/.claude/projects/` からの相対パス。

```
python3 <task-pipeline skill のインストール先>/docs/scripts/aggregate-role-phase-cost.py <session.jsonl> [--model M]
```

実体は `task-pipeline` skill と同じリポジトリの `docs/scripts/` にある。`task-pipeline/SKILL.md` が既存2スクリプトを呼ぶ場所に合わせパスを解決 (通常は両方とも `~/.claude/skills/task-pipeline/docs/scripts/`)。

## 数字の読み方の規律

この skill の価値はラッパーであることでなく、数字の読み方の規律にある。`task-pipeline/docs/cost-analysis-2026-07.md` §1 の前提を**毎回読み直さずに**守れるようにする:

1. **報告値 (`subagent_tokens`) と weighted (課金換算) を混同しない。** `subagent_tokens` は「そのセグメント最後の API コール分 = 停止時のコンテキストサイズ + 最終出力」で処理総量ではなく課金の代理にならない (`cost-analysis-2026-07.md` §1)。`aggregate-role-phase-cost.py` の `weighted` / `processed` / `cost` は subagent 自身の transcript (`<セッションディレクトリ>/subagents/agent-<agentId>.jsonl`) を `message.id` で重複排除して積み上げた実測値で、報告値の再掲ではない。両者を並べて言及するとき (`state.json` の history の `subagent_tokens` と比較する場合など) はどちらが課金換算でどちらが報告値か明示する。
2. **集計できなかった呼び出しの件数を必ず報告に載せる。** 出力末尾の `uncountable=<n>` (0件でも出る) を黙って落とさない。役割・フェーズ・attempt が起動/再開テキストから解決できなかった、agentId が取れなかった、または `subagents/agent-<agentId>.jsonl` が見つからなかった件数で、省くと「全部数えた」と誤読される。

## 出力の読み方

役割×フェーズ (verifier はさらに attempt バケット `0`=初回 / `1+`=再検証) ごとに1行:

```
role=<role> phase=<phase|-> attempt=<0|1+|-> api_calls=<n> processed=<n> weighted=<n> output=<n>
```

`--model` を渡すと実費 (`cost=$<n> (<model>)`) も出る。

**整合性の確認手順**: 同じ体 (agentId) から複数セグメントに分かれていない行 (attempt が1回だけの verifier、フェーズが1回だけの executor、adapter/triage/pr-watcher の通常呼び出し) は、その体の transcript に `aggregate-orchestrator-usage.py <その transcript>` を直接通して得た `weighted` と一致。体を跨いだ行 (verifier の SendMessage 再検証・executor の複数フェーズ進行や同一フェーズ再実行) は同じ体の行を合算した値が直接実行の値と一致する。数字を疑ったらこの照合で確かめる。

## 境界 (やらないこと)

- **コスト削減そのものはしない。** 測るだけで何も変更しない。
- **集計対象は1セッション分に閉じる。** メインループのオーケストレーター費や複数セッション横断集計は対象外 (`task-pipeline/docs/scripts/collect-task-metrics.py` の `executor_seconds` 等の**時間**軸集計とは軸が違う — こちらは常にトークン・課金額の軸)。
- **verdict path のファイル名が `<phase>[-<seq>]-<attempt>.json` の形でない呼び出しは attempt を推測せず** `uncountable` に計上する。
