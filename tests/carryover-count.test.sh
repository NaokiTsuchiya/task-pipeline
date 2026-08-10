#!/bin/sh
# tests/carryover-count.test.sh — task-pipeline/docs/scripts/count-carryover.py (gh-63 の
# carryover 集計) を固定する薄いラッパー。実体のアサーションは同じディレクトリの
# carryover-count.test.py (標準ライブラリのみの Python) に書く。tests/run.sh から
# *.test.sh の glob で自動検出される。
#
#   sh tests/carryover-count.test.sh     # 全ケース PASS なら exit 0
#
# tests/metrics-fail-reasons.test.sh と同型の構成。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
py_test=$tests_dir/carryover-count.test.py

[ -f "$py_test" ] || { printf 'carryover-count.test.py not found: %s\n' "$py_test" >&2; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 not found — required to run count-carryover.py itself, so this is a hard failure (not a SKIP)\n' >&2
    exit 1
fi

python3 "$py_test" "$repo_dir"
exit $?
