# Task 2-2 シャドー運転実機検証レポート (Issue #144, 2026-08)

## 概要

Phase 2 (常駐 Driver による非 LLM ディスパッチ) の Task 2-2 として、`pipeline-driver.ts` の観測モード (`--observe true --replay-next <snapshot>`) を使い、LLM オーケストレーターが実運用セッションで実行した判断と Driver の判定整合性を検証した。

実タスク **gh-150** (「pipeline-driver: takeover の paseo run 起動引数で --new-workspace の既定値を local に変更する (#148 整合)」) を `queued` → `claim` → `research` → `plan` → `implement` → `report` → `ship` (PR #151 作成) までエンドツーエンドで進行させながらスナップショットを採取し、Replay 突合を実施した。

---

## 比較検証結果

### 突合サンプル一覧

| # | スナップショット | 採取タイミング | Driver 判定 (`selected`) | LLM オーケストレーターの実際の行動 | 分類 | 判定 |
|---|---|---|---|---|---|---|
| 1 | `tp-next-claim-gh150.json` | gh-150 承認直後 (`queued`) | `op: "claim"` (`would-claim`, id: gh-150) | `state.ts claim --id gh-150` を呼び出し、タスク専用 worktree 作成・実行エージェント起動へ進行 | **comparable** | **PASS** |
| 2 | `tp-next-wait-gh150.json` | Executor 実行中 (`running`) | `op: "wait"` (`would-touch-executor`, reason: `executor-alive`) | 実行エージェントの完了を待機し、停止検知後に `state.ts touch-executor` を呼び出し | **comparable** | **PASS** |
| 3 | `tp-next2.json` | gh-142 ship 直後 (`resting × open`) | `op: "deferred"` (`skipped-out-of-scope`, kind: `probe-run`) | PR 観測 (CI 状況・マージ可否の確認、`state.ts observe`) へ進行 | **out-of-scope** | — (Driver未対応領域) |
| 4 | `tp-next3.json` | gh-142 回収後 (queue 空) | `op: "none"` (`outcome: "idle"`) | トラッカー候補一覧取得 (`list`) へ進行 | **out-of-scope** | — (Approval は L2 領域) |
| 5 | `tp-next4.json` | gh-148 回収後 (queue 空) | `op: "none"` (`outcome: "idle"`) | トラッカー候補一覧取得 (`list`) へ進行 | **out-of-scope** | — (Approval は L2 領域) |
| 6 | `tp-next.json` | 全タスク消化後 (queue 空) | `op: "none"` (`outcome: "idle"`) | トラッカー候補一覧取得 (`list`) へ進行 | **out-of-scope** | — (Approval は L2 領域) |

### 集計

- **comparable（比較対象サンプル）**: **2 件**
  - PASS: **2 件** (100%)
  - **contradiction（判断不一致）**: **0 件**
- **out-of-scope（スコープ外）**: **4 件** (PR 観測 1 件、空キューでの Approval 遷移 3 件)
- **non-comparable（破損・照合不能）**: **0 件**

---

## 副作用ゼロ契約の検証

Replay 実行前後で以下を確認し、観測モードが完全に副作用ゼロ（書き込みなし）であることを実機で証明した:

1. `git status --porcelain`: 観測モード実行による差分なし (clean)
2. `.task-pipeline/state.json`: mtime 変更なし (書き込みゼロ)
3. `git worktree list`: 意図しない新規 worktree の作成なし (0件)
4. Paseo エージェント: 観測モードによる新規プロセスの起動なし (0件)

---

## Task 2-3（ディスパッチ完全移管）への着手可否の所見

- **判定**: **着手可 (READY)**
- **根拠**:
  1. `claim` および `wait` のコアディスパッチにおいて、Driver の判定論理と LLM オーケストレーターの行動が 100% 一致した。
  2. `pipeline-driver.ts` の `--observe` および `--replay-next` は安全に動作し、副作用ゼロが確認された。
  3. #145 および #150 により、Paseo 経路起動時の `--new-workspace local` 既定化が完了し、Driver 常駐時における Task Cell の workspace 隔離要件が満たされた。
  4. Task 2-3a (4 real kind の実ディスパッチ移管) に向けたブロッカーはすべて解消した。
