#!/bin/sh
# tests/run.sh — 全テストスイートをまとめて実行するハーネス。
#
#   sh tests/run.sh                # 全 *.test.sh を実行し、全 PASS なら exit 0
#
# 新しいテストの追加方法: tests/ 直下に <name>.test.sh (自己完結の POSIX sh スクリプトで、
# 実行して PASS/FAIL を表示し、失敗があれば非ゼロで終わる) を置くだけでよい。
# tests/*.test.sh を glob で自動検出するので、このファイルを書き換える必要は無い。
#
# - 依存ゼロ・ネットワーク不要。ハーネス自体は POSIX sh のみで書く (bash 拡張は使わない)。
# - 各スイートは自分自身で必要な PATH やモックを用意する (例: tests/watch-pr.test.sh は
#   tests/fixtures/mock-gh/gh を PATH の先頭に挿してから実行する)。このファイルは
#   スイートを列挙して実行し、結果を集計するだけ。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1

suite_total=0
suite_fail=0
overall_start=$(date +%s)

for f in "$tests_dir"/*.test.sh; do
    [ -f "$f" ] || continue
    suite_total=$((suite_total + 1))
    printf '\n==== %s ====\n' "$(basename -- "$f")"
    if sh "$f"; then
        :
    else
        suite_fail=$((suite_fail + 1))
        printf 'SUITE FAILED: %s\n' "$(basename -- "$f")"
    fi
done

overall_end=$(date +%s)

printf '\n%s\n' "========================================"
if [ "$suite_total" -eq 0 ]; then
    printf 'no test suites found under %s\n' "$tests_dir"
    exit 1
fi
printf 'suites: %s / failed: %s (elapsed %ss)\n' "$suite_total" "$suite_fail" "$((overall_end - overall_start))"
[ "$suite_fail" -eq 0 ] || exit 1
exit 0
