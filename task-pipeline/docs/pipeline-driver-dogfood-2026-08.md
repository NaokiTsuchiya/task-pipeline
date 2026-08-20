# pipeline-driver.ts 実運用検証 (dogfood, 2026-08-20)

gh-140 の完了記録。`.task-pipeline` を汚さない検証用サンドボックス (`/tmp/dogfood*`, 実行後に削除済み) に対して `pipeline-driver.ts` を手動で複数サイクル実行し、実 `paseo` / 実 `state.ts` に対する4観点を検証した。

## 検証環境
- サンドボックス git リポジトリ (1コミットのみ、`main` ブランチ) を作成し、`.task-pipeline` を**そのリポジトリの内側**に置いて `state.ts init` した (最初、状態ディレクトリをリポジトリの外に置いて実行したところ `resolveProjectRoot` が `git rev-parse --git-common-dir` の失敗で誤フォールバックし `git worktree add` が壊れた — これは本物の運用ではあり得ないセットアップ誤りであり、driver のバグではない。本番の `.task-pipeline` は常にプロジェクトルート直下にあるため影響なし)。
- executor には `omp/anthropic/claude-haiku-4-5` を明示指定 (`--impl-provider`) して実コストを最小化。実際に `paseo run -d --json` で本物のエージェントを複数体起動し、検証後は都度 `paseo stop` → `paseo archive` (owned workspace があれば `paseo workspace archive`) で片付けた。

## 観点1: claim の楽観ロック競合 — PASS
2プロセスが同一 `queued` タスクへ同時に `claim` した実行を複数回再現。**必ず片方だけが成功し**、負けた側は `state.ts claim` の `conflict` (exit 15) をそのまま `{"error": "state.ts claim failed (exit 15): ..."}` として exit 1 で返す — クラッシュせず、二重 claim も state.json の破損も無い。`touch-executor --expect-executor` を意図的に不一致な値で呼んだ場合も同様に `conflict` で綺麗に落ちることを確認した (LLM オーケストレーターと Driver が同一 state.json を並走する際の楽観ロックは、呼び出し元の種別を問わず同じ `state.ts` の仕組みで守られている)。

## 観点2: takeover — 1件のバグを発見し修正、E2E相当のcwd既知リスクを再確認
- worktree 未作成タスクの新規作成・実 paseo エージェント起動・`set-executor` への記録は、競合の無い単独実行では正しく動作した。
- **バグ発見・修正**: 2プロセスが同一タスクへ同時に `takeover` すると、`git worktree add` の「ブランチ既存」再試行ロジック (`/already exists/` 正規表現) が「path (ディレクトリ) 既存」の場合と区別できず、再試行も失敗してそのまま `DriverError` としてクラッシュしていた (`pipeline-driver.ts` 旧 `resolveWorktree`)。さらにこの一次修正 (先勝ちの `state.ts get` を読んで採用) だけでは、先勝ちの `git worktree add` 成功と `state.ts set-worktree` 完了の間の実プロセス遅延に、単発の `get` が間に合わないタイミング競合が実機で再現した。**さらに深刻な二次影響**: この隙間を埋めないまま `paseo ls` の重複検知 (`findActiveDuplicates`) まで進むと、その検知自体にも TOCTOU の隙間があり、**2体の実エージェントが同一 worktree ディレクトリへ同時に起動される**ことを実機で確認した (`caa3980e...` と `ebee9488...` が同じ `cwd` で並走。ファイル破損には至らなかったが、起きても不思議ではない)。
  - 修正: (a) `resolveWorktree` の二重失敗時に `state.ts get` を短い間隔 (100/200/400/800/1500ms) で最大5回ポーリングし、先勝ちの記録が反映されるのを待つ。(b) ポーリングで先勝ちの記録を採用した場合 (`recoveredFromRace: true`) は、`paseo ls` の重複検知や `paseo run` へは一切進まず、即座に `skipped-duplicate` として退く — 「worktree 作成で負けた」という git レベルの確定的な証拠がある以上、後段の TOCTOU のある検知に頼らない。
  - 修正後、5並列レースを実 paseo に対して5回連続実行し、毎回「勝者1体だけが `launched`、敗者は `skipped-duplicate`」になることを確認 (`paseo ls --label task-pipeline-task=<id>` で各タスクにつき実エージェントが1体だけ存在することも確認)。
  - 回帰テストを追加: `pipeline-driver.test.ts`「runCycle/takeover: worktree add が二重に競合したら重複起動せず skipped-duplicate で退く (gh-140 dogfood 実測)」。
- **cwd 既知リスクの再確認 (未修正、driver の既知の前提)**: driver プロセス自体が agent-scoped セッション (Paseo エージェントの中) から実行されると、`--paseo-new-workspace` を明示しない限り `--cwd` が無視され、起動したエージェントが意図した worktree ではなく **driver 呼び出し元の workspace** を継承することを実機で確認した (`pipeline-driver.test.ts` の E2E コメントに既に記載されている既知の制約と一致)。`--paseo-new-workspace local` を付けると正しい `Cwd` になることも確認済み。**この検証セッション自体が agent-scoped だったため、この既知リスクに実際に踏んだ** (幸い実害は無かった — 起動されたエージェントは何も書き込まずに idle 終了した)。

## 観点3: status-check / wait の鮮度判定 — PASS
`isExecutorFresh` の3条件判定を実 `paseo wait --json` / `paseo inspect --json` に対して確認: 実エージェントが `idle` になっても `PHASE <phase> DONE —` 等の protocol 行が本文に無ければ `stale` と判定して `touch-executor` を呼ばないことを確認 (誤って鮮度ありと判定する false positive は観測されなかった)。

## 観点4: LLM オーケストレーターとの並走 — PASS (`state.ts` レベルで検証)
`--expect-executor` の楽観ロックを、正しい期待値と誤った期待値の両方で直接実行し、正しい場合は成功、誤った場合 (別プロセスが差し替えた後の古い期待値を渡した場合に相当) は `conflict` で綺麗に落ちることを確認した。LLM オーケストレーター (SKILL.md 手順) と Driver はどちらも同じ `state.ts` CLI 経由でしか state.json を触らないため、この楽観ロックの挙動は呼び出し元がどちらであっても同一に効く。

## Task 2-2 (シャドー運転) 着手可否についての所見
- 今回発見・修正した worktree レースのバグは、**単一の Driver プロセスが単発実行される前提** (元々の #136 の範囲) では顕在化しない。Task 2-2/2-3 で Driver が `hub(op:"start")` により常駐・多重ポーリングする形になると、同一 state dir に対して複数の Driver サイクルやLLM オーケストレーターが時間的に近接して `takeover` を試みる状況が今回より起きやすくなるため、**この修正は Task 2-2 の前提として必須だった**。
- 未修正のまま残っている **cwd 既知リスクは Task 2-2/2-3 にとって重大な未解決課題**: 常駐 Driver 自身が `omp hub(op:"start")` 越しに起動される場合、その実行コンテキストが「top-level セッション」なのか「agent-scoped」なのかは `hub` の実装詳細に依存し、現時点では確認できていない。**agent-scoped であった場合、`--paseo-new-workspace` を常に明示しない限り、Driver が起動するすべての executor が誤った cwd (Driver 自身の workspace) を継承してしまう。** Task 2-2 の着手前に、(a) `hub(op:"start")` で起動されたプロセスから `paseo run --cwd` した際の実際の挙動を確認する、または (b) 保守的に Driver からの `takeover` 呼び出しには常に `--paseo-new-workspace local` を付けることをデフォルトにする、のいずれかを決めるべきである。
- `findActiveDuplicates` (`paseo ls` ベースの重複検知) 単体は TOCTOU を持つことが実機で確認された。今回の修正は worktree レースの経路のみを塞いだものであり、**worktree 未使用の再開経路 (`status-check`/`wait` から `takeover` への降格など、inflight.md の他の経路) で同種の二重起動が起き得るかは、この検証の範囲外** — Task 2-2/2-3 でそれらの経路を実装する際に、同じ「勝敗が git/state.json レベルで確定している場合は `paseo ls` に頼らない」設計原則を踏襲すべきである。

## 修正一覧
- `task-pipeline/scripts/pipeline-driver.ts`: `resolveWorktree` に有限回ポーリングでの先勝ち採用を追加し、`handleTakeover` にレース検出時の即時 `skipped-duplicate` 退避を追加。
- `task-pipeline/scripts/pipeline-driver.test.ts`: 上記の回帰テストを追加。
- `deno task test` (1184 tests) は全て PASS。
