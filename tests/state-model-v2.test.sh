#!/bin/sh
# tests/state-model-v2.test.sh — task-pipeline/scripts/state-model-v2.ts (状態モデル v2の
# 語彙・ノード導出・不変条件・到達可能性テストの枠) のテストを走らせるラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-model-v2.test.sh      # deno があれば fmt/lint/check/test を通しで実行
#
# - 依存ゼロ・ネットワーク不要 (state-model-v2.ts/.test.ts は v1 にも他モジュールにも
#   依存しない完全新規ファイルで、Deno API・外部モジュールを一切呼ばない)。
# - deno が無い環境では SKIP を表示して exit 0 (tests/state-schema.test.sh と同じ扱い)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_model_v2_ts=$repo_dir/task-pipeline/scripts/state-model-v2.ts
state_model_v2_test_ts=$repo_dir/task-pipeline/scripts/state-model-v2.test.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-model-v2 tests — deno not found\n'
    exit 0
fi

[ -f "$state_model_v2_ts" ] || { printf 'state-model-v2.ts not found: %s\n' "$state_model_v2_ts" >&2; exit 1; }
[ -f "$state_model_v2_test_ts" ] || { printf 'state-model-v2.test.ts not found: %s\n' "$state_model_v2_test_ts" >&2; exit 1; }

fail=0

run_step() {
    _label=$1
    shift
    printf '\n-- %s --\n' "$_label"
    if "$@"; then
        printf 'PASS  %s\n' "$_label"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s\n' "$_label"
    fi
}

run_step "deno fmt --check" deno fmt --check "$state_model_v2_ts" "$state_model_v2_test_ts"
run_step "deno lint" deno lint "$state_model_v2_ts" "$state_model_v2_test_ts"
run_step "deno check" deno check "$state_model_v2_ts" "$state_model_v2_test_ts"
run_step "deno test" deno test "$state_model_v2_test_ts"

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-model-v2 tests: all steps PASS\n'
else
    printf 'state-model-v2 tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
