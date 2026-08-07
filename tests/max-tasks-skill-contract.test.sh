#!/bin/sh
# tests/max-tasks-skill-contract.test.sh — task-pipeline/SKILL.md の `max_tasks` 引数
# (loop-safe-stop-max-tasks タスク) の記述を grep で固定する。
#
#   sh tests/max-tasks-skill-contract.test.sh   # 全ケース PASS なら exit 0
#
# 背景: `max_tasks` はこの skill のオーケストレーター (プロンプト駆動、実行系のコードが無い)
# が読む唯一の仕様書である SKILL.md に対する変更で、判定そのものをユニットテストする手段が
# 無い (repo 全体の既存方針 — tests/verifier-verdict-contract-alignment.test.sh /
# tests/sync-readme-skills.test.sh と同じ「prose の契約を grep で固定する」パターンを踏襲する)。
# このテストは、入力クラス A (省略=無制限) / B (未到達=続行) / C (到達=停止) それぞれの扱いが
# SKILL.md に具体的に書かれていること、停止手順が枯渇時フロー手順2を再利用していること、
# カウント方法とコンテキスト非依存性、最終報告の必須項目、既存呼び出し形の非破壊を固定する。
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
skill_md=$repo_dir/task-pipeline/SKILL.md
[ -f "$skill_md" ] || { printf 'required file not found: %s\n' "$skill_md" >&2; exit 1; }

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

has() { grep -qF "$1" "$skill_md"; }

printf '# max-tasks-skill-contract checks\n#   skill_md=%s\n' "$skill_md"

# --- T1: 引数リストに max_tasks=<N> がある --------------------------------------------
if has '[max_tasks=<N>]'; then
    ok "T1 \$ARGUMENTS の行に [max_tasks=<N>] がある"
else
    ng "T1 \$ARGUMENTS の行に [max_tasks=<N>] がある" "見つからない"
fi

# --- T2: トークン内訳の列挙に max_tasks= が finish=/approve=/max_open=/rebase= と並んでいる ---
if has '`rebase=` / `max_tasks=`'; then
    ok "T2 トークン内訳の列挙に max_tasks= が加わっている"
else
    ng "T2 トークン内訳の列挙に max_tasks= が加わっている" "見つからない"
fi

# --- T3 (クラスA): 省略時は無制限・現行挙動不変と明記 --------------------------------
if has '既定: 無制限。省略時は現行の挙動を一切変えない'; then
    ok "T3a 引数説明の箇条書きに「省略時は現行の挙動を一切変えない」がある"
else
    ng "T3a 引数説明の箇条書きに「省略時は現行の挙動を一切変えない」がある" "見つからない"
fi
if has '省略時は無制限で、以下は一切発火せず現行の挙動を変えない'; then
    ok "T3b 安全停止節の冒頭に「省略時は無制限」の明記がある"
else
    ng "T3b 安全停止節の冒頭に「省略時は無制限」の明記がある" "見つからない"
fi

# --- T4 (クラスB/C): 到達 (>=) で停止、未到達 (<) で続行の両方が書かれている -----------
if has '以上なら、新しい着手にも承認にも進まず、この節の手順で止める'; then
    ok "T4a クラスC (到達) — 上限以上なら止める旨がある"
else
    ng "T4a クラスC (到達) — 上限以上なら止める旨がある" "見つからない"
fi
if has '未満なら、この節は何もせず通常どおり以下の判定'; then
    ok "T4b クラスB (未到達) — 上限未満なら通常どおり進む旨がある"
else
    ng "T4b クラスB (未到達) — 上限未満なら通常どおり進む旨がある" "見つからない"
fi

# --- T5: in_progress ゼロでのみ発火 / 仕上げ飛行中は止めない -------------------------
if has 'この判定に到達するのは `running` のタスクが1件も無いときだけ'; then
    ok "T5a 判定は自分の running がゼロの地点でのみ発火する旨がある"
else
    ng "T5a 判定は自分の running がゼロの地点でのみ発火する旨がある" "見つからない"
fi
if has '仕上げ (`pr_fix`/`rebase_fix`) が飛行中のタスクも `progress: running` なので同じく「飛行中の扱い」に分岐し、この判定へは来ない'; then
    ok "T5b 仕上げ (pr_fix/rebase_fix) 飛行中は止めない旨がある"
else
    ng "T5b 仕上げ (pr_fix/rebase_fix) 飛行中は止めない旨がある" "見つからない"
fi

# --- T6: 停止手順が枯渇時フロー手順2の再利用であり、独自経路を作っていない -----------
if has '枯渇時フロー手順2と**全く同じ手順**を踏む'; then
    ok "T6a 枯渇時フロー手順2の再利用を明記している"
else
    ng "T6a 枯渇時フロー手順2の再利用を明記している" "見つからない"
fi
section=$(sed -n '/^### `max_tasks` による安全停止$/,/^## /p' "$skill_md")
_detail=
printf '%s' "$section" | grep -qF 'state.ts release --id <id>' || _detail="$_detail release 呼び出しが無い"
printf '%s' "$section" | grep -qF 'ScheduleWakeup `stop: true`' || _detail="$_detail ScheduleWakeup stop:true が無い"
printf '%s' "$section" | grep -qF 'CronList' || _detail="$_detail CronList が無い"
printf '%s' "$section" | grep -qF 'CronDelete' || _detail="$_detail CronDelete が無い"
if [ -z "$_detail" ]; then
    ok "T6b 安全停止節が枯渇時フロー手順2と同じ停止呼び出し列を持つ"
else
    ng "T6b 安全停止節が枯渇時フロー手順2と同じ停止呼び出し列を持つ" "$_detail"
fi

# --- T7: 最終報告の4項目 ---------------------------------------------------------------
_detail=
printf '%s' "$section" | grep -qF '再開コマンド' || _detail="$_detail 再開コマンドが無い"
printf '%s' "$section" | grep -qF 'その前に `/clear` する案内' || _detail="$_detail /clear 案内が無い"
printf '%s' "$section" | grep -qF '残っている候補の件数' || _detail="$_detail 残候補件数が無い"
printf '%s' "$section" | grep -qF 'レビュー待ち・追従中の PR の一覧' || _detail="$_detail レビュー待ち/追従中PR一覧が無い"
if [ -z "$_detail" ]; then
    ok "T7 最終報告の4項目 (再開コマンド/clear案内/残候補件数/PR一覧) が揃っている"
else
    ng "T7 最終報告の4項目 (再開コマンド/clear案内/残候補件数/PR一覧) が揃っている" "$_detail"
fi

# --- T8: カウント方法 (記録先パス・トリガー・数え方) が具体的に書かれている -----------
_detail=
printf '%s' "$section" | grep -qF 'task_counts' || _detail="$_detail task_counts パスが無い"
printf '%s' "$section" | grep -qF 'state.ts claim` が成功する' || _detail="$_detail claim 成功トリガーの記述が無い"
printf '%s' "$section" | grep -qF '件数はこのファイルの行数' || _detail="$_detail 行数で数える旨が無い"
printf '%s' "$section" | grep -qF 'wc -l' || _detail="$_detail wc -l の言及が無い"
printf '%s' "$section" | grep -qF 'sessions/` の中には置かない' || _detail="$_detail sessions/ に置かない旨が無い"
if [ -z "$_detail" ]; then
    ok "T8 カウント方法 (パス・トリガー・数え方) が具体的に書かれている"
else
    ng "T8 カウント方法 (パス・トリガー・数え方) が具体的に書かれている" "$_detail"
fi

# --- T9 (回帰ガード): 既存の呼び出し例が変わっていない ---------------------------------
_detail=
has 'markdown ./TASKS.md finish=commit' || _detail="$_detail 既存例1 (markdown ./TASKS.md finish=commit) が無い"
has 'gh ?label=ready finish=pr approve=auto' || _detail="$_detail 既存例2 (gh ?label=ready finish=pr approve=auto) が無い"
if [ -z "$_detail" ]; then
    ok "T9 既存の呼び出し例がそのまま残っている (呼び出し形の非破壊)"
else
    ng "T9 既存の呼び出し例がそのまま残っている (呼び出し形の非破壊)" "$_detail"
fi

# --- T10: 停止判定の挿入位置が「併走の枠」より前 (毎イテレーションの手順・手順1) ------
gate_line=$(grep -n '`max_tasks` による停止判定' "$skill_md" | head -1 | cut -d: -f1)
concurrency_line=$(grep -n '\*\*併走の枠\*\*:' "$skill_md" | head -1 | cut -d: -f1)
if [ -n "$gate_line" ] && [ -n "$concurrency_line" ] && [ "$gate_line" -lt "$concurrency_line" ]; then
    ok "T10 max_tasks の停止判定が「併走の枠」より前に置かれている"
else
    ng "T10 max_tasks の停止判定が「併走の枠」より前に置かれている" "gate_line=$gate_line concurrency_line=$concurrency_line"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
