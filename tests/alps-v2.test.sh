#!/bin/sh
# tests/alps-v2.test.sh — task-pipeline/scripts/alps-v2.test.ts (ALPS プロファイル
# 再生成の一致検査 — gh-21 受け入れ条件2) の薄いラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される
# (tests/metrics-reference-alignment.test.sh と同型、こちらも deno に委譲する)。
#
#   sh tests/alps-v2.test.sh   # deno があれば PASS/FAIL を表示
#
# - 依存ゼロ・ネットワーク不要。deno が無ければ SKIP + exit 0
#   (tests/metrics-reference-alignment.test.sh と同じ慣習)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
ts_test=$repo_dir/task-pipeline/scripts/alps-v2.test.ts

[ -f "$ts_test" ] || { printf 'alps-v2.test.ts not found: %s\n' "$ts_test" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  alps-v2 test — deno not found\n'
    exit 0
fi

deno test --allow-read "$ts_test"
exit $?
