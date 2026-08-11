#!/bin/sh
# tests/metrics-reference-alignment.test.sh — 追跡下 Markdown から docs/metrics/ 配下の
# 日付ファイルへの参照が消えていることを固定する tests/metrics-reference-alignment.test.ts の
# 薄いラッパー。tests/run.sh から *.test.sh の glob で自動検出される
# (tests/aggregate-scripts.test.sh → aggregate-scripts.test.py と同型、こちらは deno に委譲する)。
#
#   sh tests/metrics-reference-alignment.test.sh   # deno があれば PASS/FAIL を表示
#
# - 依存ゼロ・ネットワーク不要。deno が無ければ SKIP + exit 0
#   (tests/state-cli-iteration.test.sh と同じ慣習)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
ts_test=$tests_dir/metrics-reference-alignment.test.ts

[ -f "$ts_test" ] || { printf 'metrics-reference-alignment.test.ts not found: %s\n' "$ts_test" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  metrics-reference-alignment test — deno not found\n'
    exit 0
fi

deno test --allow-read "$ts_test"
exit $?
