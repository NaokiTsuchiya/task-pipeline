#!/bin/sh
# tests/run-sh.test.sh — tests/run.sh 自体 (SKIP 集計・opt-in 失敗モード・既存の
# suite_fail 判定) の外部挙動を固定する。tests/run.sh は本体を書き換えず、`dirname "$0"`
# で決まる tests_dir をサンドボックスに差し替えることで検証する。
#
#   sh tests/run-sh.test.sh        # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...    # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。ダミーの *.test.sh をサンドボックスに
#   置いて tests/run.sh のコピーを起動し、stdout の文字列と exit code だけで判定する。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
run_sh=$repo_dir/tests/run.sh
[ -f "$run_sh" ] || { printf 'run.sh not found: %s\n' "$run_sh" >&2; exit 1; }

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

flat() { printf '%s' "$1" | tr '\n' '|'; }
contains() { case $2 in *"$1"*) return 0 ;; *) return 1 ;; esac; }

# 新しい空のサンドボックスを作り、tests/run.sh のコピーを置いてパスを返す。
# 呼び出しは `sb=$(new_sandbox)` の形 (コマンド置換 = サブシェル) になるので、
# 連番カウンタのような親シェルの変数更新に頼る実装にはできない (更新がサブシェルに
# 閉じて親に伝わらない) — mktemp -d 自身の一意性だけでディレクトリ名を決める。
new_sandbox() {
    d=$(mktemp -d "$work/sb.XXXXXX") || exit 1
    cp "$run_sh" "$d/run.sh" || exit 1
    printf '%s' "$d"
}

# $1 = サンドボックスのパス, $2 = ファイル名 (*.test.sh), $3 = スクリプト本体
write_suite() {
    printf '#!/bin/sh\n%s\n' "$3" > "$1/$2"
}

# ---- サンドボックス A: SKIP 無し、全 PASS (ケース A / E の土台) ----
sb_a=$(new_sandbox)
write_suite "$sb_a" ok1.test.sh "printf 'PASS  ok1 case\n'; exit 0"
write_suite "$sb_a" ok2.test.sh "printf 'PASS  ok2 case\n'; exit 0"

# ---- サンドボックス B: SKIP 合計3件 (1スイートから複数SKIP)、全 PASS (ケース B/D/H の土台) ----
sb_b=$(new_sandbox)
write_suite "$sb_b" ok.test.sh "printf 'PASS  ok case\n'; exit 0"
write_suite "$sb_b" multi-skip.test.sh "printf 'SKIP  multi case1 — reason1\n'; printf 'SKIP  multi case2 — reason2\n'; exit 0"
write_suite "$sb_b" one-skip.test.sh "printf 'SKIP  one case — reason\n'; exit 0"

# ---- サンドボックス C: SKIP を含むが行頭ではない行 + 本物のSKIP1件 (境界ケース) ----
sb_c=$(new_sandbox)
write_suite "$sb_c" boundary.test.sh "printf 'SKIPPED something not a real skip line\n'; printf 'xSKIP y\n'; printf 'SKIP  real case — reason\n'; exit 0"

# ---- サンドボックス F: 1スイートが非0で終わる (SKIPの有無に関わらず) ----
sb_f=$(new_sandbox)
write_suite "$sb_f" bad.test.sh "printf 'FAIL  bad case\n'; exit 1"

# ---- サンドボックス G: *.test.sh が1つも無い ----
sb_g=$(new_sandbox)

# 既定モード (未設定) を期待するケースは、このテスト自身が外側の tests/run.sh から
# TESTS_FAIL_ON_SKIP=1 付きで起動されている可能性がある (受け入れ条件2の実行) ため、
# 継承されうる値を明示的に空へ潰してから起動する (POSIX の ${var:-x} は unset と空文字を
# 同じ扱いにするので、空文字を渡せば tests/run.sh 側では「未設定」と同じ分岐を通る)。

# ==== ケース A: SKIPなし・全PASS、既定モード → exit 0、skipped: 0 ====
out=$(TESTS_FAIL_ON_SKIP='' sh "$sb_a/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && contains 'skipped: 0' "$out" && contains 'failed: 0' "$out"; then
    ok "A: SKIPなし・既定モード → exit 0 / skipped: 0"
else
    ng "A: SKIPなし・既定モード → exit 0 / skipped: 0" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース B: 複数スイートからSKIP計3件、既定モード → exit 0、skipped: 3 ====
out=$(TESTS_FAIL_ON_SKIP='' sh "$sb_b/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && contains 'skipped: 3' "$out" && contains 'failed: 0' "$out"; then
    ok "B: SKIP計3件・既定モード → exit 0 / skipped: 3"
else
    ng "B: SKIP計3件・既定モード → exit 0 / skipped: 3" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース C: SKIPを含むが行頭ではない行は集計に含まれない (境界) ====
out=$(TESTS_FAIL_ON_SKIP='' sh "$sb_c/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && contains 'skipped: 1' "$out"; then
    ok "C: 行頭でないSKIP文言は集計に含まれない (skipped: 1)"
else
    ng "C: 行頭でないSKIP文言は集計に含まれない (skipped: 1)" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース D: SKIP計3件 + TESTS_FAIL_ON_SKIP=1 → 非0 ====
out=$(TESTS_FAIL_ON_SKIP=1 sh "$sb_b/run.sh" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && contains 'TESTS_FAIL_ON_SKIP=1' "$out"; then
    ok "D: SKIP計3件 + TESTS_FAIL_ON_SKIP=1 → 非0"
else
    ng "D: SKIP計3件 + TESTS_FAIL_ON_SKIP=1 → 非0" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース E: SKIPなし + TESTS_FAIL_ON_SKIP=1 → exit 0 (opt-inでもSKIPが無ければ通る) ====
out=$(TESTS_FAIL_ON_SKIP=1 sh "$sb_a/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
    ok "E: SKIPなし + TESTS_FAIL_ON_SKIP=1 → exit 0"
else
    ng "E: SKIPなし + TESTS_FAIL_ON_SKIP=1 → exit 0" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース F: 1スイートが非0で終わる + 既定モード → 非0、SUITE FAILED: 行が出る (回帰) ====
out=$(sh "$sb_f/run.sh" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && contains 'SUITE FAILED: bad.test.sh' "$out"; then
    ok "F: スイート失敗 + 既定モード → 非0 (回帰)"
else
    ng "F: スイート失敗 + 既定モード → 非0 (回帰)" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース G: *.test.sh が1つも無い → 既存の早期 exit 1 (回帰) ====
out=$(sh "$sb_g/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && contains 'no test suites found' "$out"; then
    ok "G: スイート無し → exit 1 / no test suites found (回帰)"
else
    ng "G: スイート無し → exit 1 / no test suites found (回帰)" "rc=$rc out=$(flat "$out")"
fi

# ==== ケース H: SKIP計3件 + TESTS_FAIL_ON_SKIP=0 (明示的な0、未設定ではない) → exit 0 ====
# 判定が値ではなく「変数が設定されているか」だけを見る誤実装 ([ -n "${TESTS_FAIL_ON_SKIP:-}" ] 等) を、
# 未設定のケース (A/B) では検出できないため、明示的に 0 を渡すケースを別に置く。
out=$(TESTS_FAIL_ON_SKIP=0 sh "$sb_b/run.sh" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
    ok "H: SKIP計3件 + TESTS_FAIL_ON_SKIP=0(明示) → exit 0"
else
    ng "H: SKIP計3件 + TESTS_FAIL_ON_SKIP=0(明示) → exit 0" "rc=$rc out=$(flat "$out")"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
