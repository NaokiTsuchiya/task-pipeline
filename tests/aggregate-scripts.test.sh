#!/bin/sh
# tests/aggregate-scripts.test.sh — task-pipeline/docs/scripts/aggregate-session-usage.py と
# aggregate-orchestrator-usage.py の外部挙動 (フェーズ分類・重複排除・cache_creation 集計) を
# 固定する薄いラッパー。実体のアサーションは同じディレクトリの aggregate-scripts.test.py
# (標準ライブラリのみの Python) に書く。tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/aggregate-scripts.test.sh     # 全ケース PASS なら exit 0
#
# tests/state-schema.test.sh (deno に委譲する薄いラッパー) と同型の構成。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
py_test=$tests_dir/aggregate-scripts.test.py

[ -f "$py_test" ] || { printf 'aggregate-scripts.test.py not found: %s\n' "$py_test" >&2; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 not found — required to run aggregate-session-usage.py / aggregate-orchestrator-usage.py themselves, so this is a hard failure (not a SKIP)\n' >&2
    exit 1
fi

python3 "$py_test" "$repo_dir"
exit $?
