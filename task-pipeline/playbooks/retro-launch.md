**入る条件**: レトロ観測の 3 トリガー (枯渇時フローで最終報告を書く回 / ループを止めるとき / done 回収 10 件ごと) のいずれかに当たったとき。**この手順書はオーケストレーター側の起動手順であり、レトロ観測サブエージェント自身への指示は `references/retro.md` にある** (別物なので取り違えないこと)。

## レトロ観測

メトリクス (`~/.claude/task-pipeline/metrics.jsonl`。1 行 = 1 タスク実行、`fail_reasons` を含む。`playbooks/merge-recovery.md` の「タスクメトリクスの収集」) は蓄積されるだけでは改善アクションに変わらない。**次の 3 トリガーのいずれかで**、read-only のレトロ観測サブエージェント (general-purpose、同期) を 1 体起動し、蓄積分を人が読める要約と構造化された改善候補に変換する。指示は `~/.claude/skills/task-pipeline/references/retro.md` に置き、パスで渡す (SKILL.md の「コンテキスト規律」)。**モデルは指定しない** (改善候補の抽出は判断そのものが成果物のため — トリアージ・枯渇時の内訳調査と同じ扱い。起動パラメータと経路の正は `playbooks/agent-launch.md` の `retro` の行)。

### トリガー

1. **枯渇時フロー**: 最終報告を書く回 (`stalled` が `null` から `"depleted"` に変わる最初の 1 回。`playbooks/depleted.md` の手順 1)。
2. **ループを止めるとき**: 枯渇・停滞打ち切り・アダプタ不通のいずれの停止経路でも。この3つはすべて `playbooks/depleted.md` の手順 2 の停止アクションに合流する (SKILL.md の「停滞」の追従打ち切り、SKILL.md の「アダプタの呼び方」のアダプタ不通は、どちらも「枯渇時フロー手順2と同じ手順で止める」と規定済み) ので、レトロの呼び出しも手順 2 の 1 箇所に置くだけで 3 経路すべてに伝わる。**`max_tasks` による安全停止では行わない** (`playbooks/max-tasks.md` に明記) — ユーザーが指定した頻度でコンテキストをクリアするための意図的な一時停止であり、パイプラインが継続不能になったわけではない。
3. **done 回収 10 件ごと**: この手順書の「基準点」の差分が 10 以上になったとき。判定は `playbooks/merge-recovery.md` の「タスクメトリクスの収集」の直後に行う。

### 基準点 (「前回どこまで見たか」)

基準点は state.json には持たない (schema 変更を避けるため)。**最新のサマリーファイルそのものに「集計済み行数」を記録し、`metrics.jsonl` の現在行数との差で判定する**:

```sh
proj=<プロジェクトルート>
latest=$(find "$proj/docs/metrics" -maxdepth 1 -name '*.md' 2>/dev/null | sort | tail -1)
seen=0
if [ -n "$latest" ]; then
  v=$(grep -o 'retro-metrics-line=[0-9]*' "$latest" | tail -1 | cut -d= -f2)
  [ -n "$v" ] && seen=$v
fi
total=$(wc -l < ~/.claude/task-pipeline/metrics.jsonl 2>/dev/null || echo 0)
```

`docs/metrics/` のファイル名は `YYYY-MM-DD.md` (UTC 日付) なので、`sort | tail -1` が常に最新のものを選ぶ。マーカーは retro.md がそのファイルの中に書く `<!-- task-pipeline:retro-metrics-line=<N> -->` という 1 行。

- **トリガー 3 の判定**: `total - seen >= 10` なら起動する。`metrics.jsonl` は done 回収時の収集呼び出しでしか増えないので、これが実質的な「done 回収 10 件ごと」になる (1 回の収集呼び出しが複数行を足すことがあるため、`done` の回数と `total` の増分は厳密な 1:1 ではない — issue が許容した近似)。
- **トリガー 1・2 では、上記の差分の大小を問わず必ず起動する** (`total - seen` が 10 未満でもよい)。ただし `total == seen` (前回から新規のタスク実行が 1 件も無い) のときは、retro.md 側がサマリーへの書き込みをスキップし、空の候補を返す (下記 retro.md の規定)。

### 起動プロンプト

```
You are a retro observation subagent.
Do not write to the tracker or the repository, except the one summary file path
that ~/.claude/skills/task-pipeline/references/retro.md specifies.
Read ~/.claude/skills/task-pipeline/references/retro.md and follow it.
trigger: depleted | loop_stop | done_10
metrics: ~/.claude/task-pipeline/metrics.jsonl / since_line: <上記 seen>
project root: <プロジェクトルートの絶対パス>
Write the summary yourself as the reference file specifies, then return only
the JSON it specifies.
```

### 結果の扱いと失敗時

返った改善候補は報告に列挙し、`/task-prep <tracker> <source> "<改善候補の要約>"` のような接続コマンドを 1 行添える (実際に流すかは人の判断。トラッカーへは一切書き込まない)。

**ベストエフォート**: `metrics.jsonl` が無い、`docs/metrics/` に書き込めない、サブエージェントがエラーを返す、のいずれでも、`history` に 1 行 (例: `retro スキップ: <理由>`) 残すだけで続行する (`playbooks/merge-recovery.md` の「タスクメトリクスの収集」と同じ扱い。state は変更しない、パイプラインは止めない)。
