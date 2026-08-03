#!/bin/sh
# tests/run.sh — 全テストスイートをまとめて実行するハーネス。
#
#   sh tests/run.sh                        # 全 *.test.sh を実行し、全 PASS なら exit 0
#   TESTS_FAIL_ON_SKIP=1 sh tests/run.sh   # 上記に加え、SKIP が1件でもあれば非0で終わる
#                                           # (必須ツール欠落を失敗として扱いたいとき の opt-in)
#
# 新しいテストの追加方法: tests/ 直下に <name>.test.sh (自己完結の POSIX sh スクリプトで、
# 実行して PASS/FAIL を表示し、失敗があれば非ゼロで終わる) を置くだけでよい。
# tests/*.test.sh を glob で自動検出するので、このファイルを書き換える必要は無い。
#
# - 依存ゼロ・ネットワーク不要。ハーネス自体は POSIX sh のみで書く (bash 拡張は使わない)。
# - 各スイートは自分自身で必要な PATH やモックを用意する (例: tests/watch-pr.test.sh は
#   tests/fixtures/mock-gh/gh を PATH の先頭に挿してから実行する)。このファイルは
#   スイートを列挙して実行し、結果を集計するだけ。
# - 各スイートの `SKIP ` で始まる行を集計し、最終行に出す。既定では SKIP は失敗として
#   扱わない (依存ゼロで走る設計を壊さない)。TESTS_FAIL_ON_SKIP=1 のときだけ、SKIP が
#   1件でもあれば非0で終わる。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1

suite_total=0
suite_fail=0
skip_total=0
overall_start=$(date +%s)

tmp_dir=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp_dir"' EXIT

for f in "$tests_dir"/*.test.sh; do
    [ -f "$f" ] || continue
    suite_total=$((suite_total + 1))
    printf '\n==== %s ====\n' "$(basename -- "$f")"
    out_file="$tmp_dir/out.$suite_total"
    rc_file="$tmp_dir/rc.$suite_total"
    # $? はパイプの最後 (tee) のものになってしまうため、実際の終了コードは
    # サブシェル内で一時ファイルに書き出してから読み戻す (POSIX sh には
    # bash 拡張の pipefail が無いための回避策)。stdout は tee で分岐しつつ
    # そのまま端末にも流す (実行中の進行が見えなくならないようにする) — stderr は
    # 従来どおりリダイレクトせず直接端末に流す。
    { sh "$f"; printf '%s' "$?" > "$rc_file"; } | tee "$out_file"
    suite_rc=$(cat "$rc_file")
    if [ "$suite_rc" -eq 0 ]; then
        :
    else
        suite_fail=$((suite_fail + 1))
        printf 'SUITE FAILED: %s\n' "$(basename -- "$f")"
    fi
    suite_skip=$(grep -c '^SKIP ' "$out_file")
    skip_total=$((skip_total + suite_skip))
done

overall_end=$(date +%s)

printf '\n%s\n' "========================================"
if [ "$suite_total" -eq 0 ]; then
    printf 'no test suites found under %s\n' "$tests_dir"
    exit 1
fi
printf 'suites: %s / failed: %s / skipped: %s (elapsed %ss)\n' "$suite_total" "$suite_fail" "$skip_total" "$((overall_end - overall_start))"
[ "$suite_fail" -eq 0 ] || exit 1
if [ "${TESTS_FAIL_ON_SKIP:-0}" = 1 ] && [ "$skip_total" -gt 0 ]; then
    printf 'TESTS_FAIL_ON_SKIP=1: %s SKIP(s) treated as failure\n' "$skip_total"
    exit 1
fi
exit 0
