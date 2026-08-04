#!/bin/sh
# tests/metrics-fail-reasons.test.sh — task-pipeline/docs/scripts/collect-task-metrics.py の
# fail_reasons フィールド (verdicts の FAIL 判定を集約する新ロジック) を固定する薄いラッパー。
# 実体のアサーションは同じディレクトリの metrics-fail-reasons.test.py
# (標準ライブラリのみの Python) に書く。tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/metrics-fail-reasons.test.sh     # 全ケース PASS なら exit 0
#
# tests/metrics-scan-mode.test.sh と同型の構成。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
py_test=$tests_dir/metrics-fail-reasons.test.py

[ -f "$py_test" ] || { printf 'metrics-fail-reasons.test.py not found: %s\n' "$py_test" >&2; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 not found — required to run collect-task-metrics.py itself, so this is a hard failure (not a SKIP)\n' >&2
    exit 1
fi

python3 "$py_test" "$repo_dir"
exit $?
