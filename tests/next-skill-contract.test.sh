#!/bin/sh
# tests/next-skill-contract.test.sh — task-pipeline/SKILL.md が導出判断を `next` に移譲した
# ことを grep で固定する (gh-39 の受け入れ条件5)。
#
#   sh tests/next-skill-contract.test.sh
#
# なぜ prose を grep で固定するのか: SKILL.md はオーケストレーター (モデル) が読む唯一の
# 仕様書であり、そこに判定式が残っていれば `next` の応答と食い違ったときに二重の真実に
# なる。判定式が「消えた」ことと、代わりに `next` の出力を参照するようになったことは、
# 節スコープの grep でしか機械検査できない (tests/max-tasks-skill-contract.test.ts と
# 同じパターン)。
#
# **全域の否定形は使わない** — 閾値と同じ数字は別 verb の契約説明・ScheduleWakeup の秒数・
# watch スクリプトの引数としても正当に登場するためで、それらは「残すもの」として
# 下の T6 が逆に固定している。
#
# gh-57 の分割で、飛行中の扱い・変化を待つ・修正サイクル・解決サイクルの各節は SKILL.md から
# task-pipeline/playbooks/ の手順書へ移った。節スコープのチェックは節ごとに対象ファイルが違う。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
skill_md=$repo_dir/task-pipeline/SKILL.md
playbooks=$repo_dir/task-pipeline/playbooks
inflight_md=$playbooks/inflight.md
pr_follow_md=$playbooks/pr-follow.md
merge_recovery_md=$playbooks/merge-recovery.md
max_tasks_md=$playbooks/max-tasks.md

for _f in "$skill_md" "$inflight_md" "$pr_follow_md" "$merge_recovery_md" "$max_tasks_md"; do
    [ -f "$_f" ] || { printf 'not found: %s\n' "$_f" >&2; exit 1; }
done

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

printf '# next-skill-contract checks\n#   skill_md=%s\n' "$skill_md"

# 節を切り出す (対象ファイルの開始見出しから次の見出しまで)。
section_of() {
    sed -n "/$2/,/$3/p" "$1"
}

# 節スコープの「現れない / 現れる」をまとめて確かめる。
#   check_section <ラベル> <対象ファイル> <開始パターン> <終了パターン> <absent:...|present:...> ...
check_section() {
    _label=$1
    _file=$2
    _start=$3
    _end=$4
    shift 4
    _body=$(section_of "$_file" "$_start" "$_end")
    if [ -z "$_body" ]; then
        ng "$_label" "節が空 (見出しパターンが一致しない: $_start in $_file)"
        return
    fi
    _detail=
    for _spec in "$@"; do
        _mode=${_spec%%:*}
        _needle=${_spec#*:}
        if printf '%s' "$_body" | grep -qF -- "$_needle"; then
            [ "$_mode" = absent ] && _detail="$_detail [まだ在る: $_needle]"
        else
            [ "$_mode" = present ] && _detail="$_detail [無い: $_needle]"
        fi
    done
    if [ -z "$_detail" ]; then
        ok "$_label"
    else
        ng "$_label" "$_detail"
    fi
}

# --- N0: 毎イテレーションの手順 ---------------------------------------------------------
check_section "N0 毎イテレーションの手順が next の出力を参照する" \
    "$skill_md" '^## 毎イテレーションの手順$' '^## ' \
    'absent:以下のすべての判断から除外する' \
    'absent:2 件以上あるなら始めない' \
    'absent:`ref` が PR URL、まだ回収していないもの) を数える' \
    'present:tasks[].excluded' \
    'present:follow_target' \
    'present:start.blocked_by' \
    'present:merge-proof'

# --- N1: 飛行中の扱い -------------------------------------------------------------------
check_section "N1 飛行中の扱いが next の action を参照し閾値が消えている" \
    "$inflight_md" '^## 飛行中の扱い' '^#### ' \
    'absent:90 分' \
    'absent:30 分' \
    'present:next' \
    'present:clear-takeover' \
    'present:takeover' \
    'present:status-check' \
    'present:set-takeover'

# --- N2: 変化を待つ (観測プロセスの張り直し) ---------------------------------------------
check_section "N2 観測プロセスの張り直しが probe-run の action を参照する" \
    "$pr_follow_md" '^### 変化を待つ (バックグラウンド)$' '^### ' \
    'absent:7 時間' \
    'present:probe-run' \
    'present:catch_up' \
    'present:drop_foreign_proc'

# --- N3 / N4: 修正サイクル・解決サイクルの手順 0 -----------------------------------------
check_section "N3 修正サイクル手順 0 が release の action を参照する" \
    "$pr_follow_md" '^### 修正サイクル$' '^### 外部内容の扱い$' \
    'absent:自分が所有する別の仕上げ' \
    'present:finishing-busy' \
    'present:release'

check_section "N4 解決サイクル手順 0 が release の action を参照する" \
    "$merge_recovery_md" '^#### 解決サイクル (rebase_fix)$' '^### ' \
    'absent:自分が所有する別の仕上げ' \
    'present:finishing-busy' \
    'present:release'

# --- N5: 停滞 ---------------------------------------------------------------------------
check_section "N5 停滞が stalled.set_to / stalled.cutoff を参照する" \
    "$skill_md" '^### 停滞 (新しい着手ができない状態)$' '^#\\{2,3\\} ' \
    'absent:24 時間経っていたら' \
    'present:stalled.cutoff' \
    'present:stalled.set_to'

# --- N6: セッションの所有権 (数値の重複記載を契約文書へ委ねる) ---------------------------
check_section "N6 セッションの所有権が閾値の数値を持たない" \
    "$skill_md" '^## セッションの所有権' '^## ' \
    'absent:90 分' \
    'absent:1440 分' \
    'absent:90分' \
    'absent:1440分' \
    'present:docs/state-cli-contract.md'

# --- N7: next の呼び方が書かれている ----------------------------------------------------
if grep -qF 'state.ts next --state-dir' "$skill_md"; then
    ok "N7 next の起動形が書かれている"
else
    ng "N7 next の起動形が書かれている" "見つからない"
fi

# --- T6 (回帰ガード): 「残す」と決めた記述が巻き込まれて消えていない ---------------------
# 分割で所在が分かれたので、needle ごとに「どのファイルに在るべきか」を対にして見る
# (全ファイルを cat して探すと、移し先を間違えても気づけない)。
_detail=
check_needle() {
    grep -qF -- "$2" "$1" || _detail="$_detail [消えている: $2 (${1##*/})]"
}
check_needle "$skill_md" 'heartbeat の 90 分/1440 分がなぜその値か'
check_needle "$skill_md" '24 時間より古い控えは `retire` のたびに掃除される'
check_needle "$pr_follow_md" 'watch-pr.sh <PR URL> <task id> 60 21600'
check_needle "$pr_follow_md" '6 時間何も動かなかった'
check_needle "$merge_recovery_md" '24 時間より古い控えを同じ書き込みで掃除する'
check_needle "$max_tasks_md" '件数はこのファイルの行数'
if [ -z "$_detail" ]; then
    ok "T6 「残す」と決めた記述 (別 verb の契約説明・watch 引数・カウント規則) が残っている"
else
    ng "T6 「残す」と決めた記述が残っている" "$_detail"
fi

# --- T10 相当: 手順 1 の順序 (max_tasks の停止判定が併走の枠より前) ----------------------
gate_line=$(grep -n '`max_tasks` による停止判定' "$skill_md" | head -1 | cut -d: -f1)
concurrency_line=$(grep -n '\*\*併走の枠\*\*:' "$skill_md" | head -1 | cut -d: -f1)
if [ -n "$gate_line" ] && [ -n "$concurrency_line" ] && [ "$gate_line" -lt "$concurrency_line" ]; then
    ok "T10 max_tasks の停止判定が「併走の枠」より前に置かれている"
else
    ng "T10 max_tasks の停止判定が「併走の枠」より前に置かれている" \
        "gate_line=$gate_line concurrency_line=$concurrency_line"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
