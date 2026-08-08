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
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
skill_md=$repo_dir/task-pipeline/SKILL.md

[ -f "$skill_md" ] || { printf 'SKILL.md not found: %s\n' "$skill_md" >&2; exit 1; }

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

printf '# next-skill-contract checks\n#   skill_md=%s\n' "$skill_md"

# 節を切り出す (開始見出しから次の見出しまで)。
section_of() {
    sed -n "/$1/,/$2/p" "$skill_md"
}

# 節スコープの「現れない / 現れる」をまとめて確かめる。
#   check_section <ラベル> <開始パターン> <終了パターン> <absent:...|present:...> ...
check_section() {
    _label=$1
    _start=$2
    _end=$3
    shift 3
    _body=$(section_of "$_start" "$_end")
    if [ -z "$_body" ]; then
        ng "$_label" "節が空 (見出しパターンが一致しない: $_start)"
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
    '^## 毎イテレーションの手順$' '^## ' \
    'absent:以下のすべての判断から除外する' \
    'absent:2 件以上あるなら始めない' \
    'absent:`ref` が PR URL、まだ回収していないもの) を数える' \
    'present:tasks[].excluded' \
    'present:follow_target' \
    'present:start.blocked_by' \
    'present:merge-proof'

# --- N1: 飛行中の扱い -------------------------------------------------------------------
check_section "N1 飛行中の扱いが next の action を参照し閾値が消えている" \
    '^## 飛行中の扱い' '^## ' \
    'absent:90 分' \
    'absent:30 分' \
    'present:next' \
    'present:clear-takeover' \
    'present:takeover' \
    'present:status-check' \
    'present:set-takeover'

# --- N2: 変化を待つ (観測プロセスの張り直し) ---------------------------------------------
check_section "N2 観測プロセスの張り直しが probe-run の action を参照する" \
    '^### 変化を待つ (バックグラウンド)$' '^### ' \
    'absent:7 時間' \
    'present:probe-run' \
    'present:catch_up' \
    'present:drop_foreign_proc'

# --- N3 / N4: 修正サイクル・解決サイクルの手順 0 -----------------------------------------
check_section "N3 修正サイクル手順 0 が release の action を参照する" \
    '^### 修正サイクル$' '^### 外部内容の扱い$' \
    'absent:自分が所有する別の仕上げ' \
    'present:finishing-busy' \
    'present:release'

check_section "N4 解決サイクル手順 0 が release の action を参照する" \
    '^#### 解決サイクル (rebase_fix)$' '^### ' \
    'absent:自分が所有する別の仕上げ' \
    'present:finishing-busy' \
    'present:release'

# --- N5: 停滞 ---------------------------------------------------------------------------
check_section "N5 停滞が stalled.set_to / stalled.cutoff を参照する" \
    '^### 停滞 (新しい着手ができない状態)$' '^### ' \
    'absent:24 時間経っていたら' \
    'present:stalled.cutoff' \
    'present:stalled.set_to'

# --- N6: セッションの所有権 (数値の重複記載を契約文書へ委ねる) ---------------------------
check_section "N6 セッションの所有権が閾値の数値を持たない" \
    '^## セッションの所有権' '^## ' \
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
_detail=
for _needle in \
    'heartbeat の 90 分/1440 分がなぜその値か' \
    '24 時間より古い控えは `retire` のたびに掃除される' \
    'watch-pr.sh <PR URL> <task id> 60 21600' \
    '6 時間何も動かなかった' \
    '24 時間より古い控えを同じ書き込みで掃除する' \
    '件数はこのファイルの行数'
do
    grep -qF -- "$_needle" "$skill_md" || _detail="$_detail [消えている: $_needle]"
done
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
