#!/bin/sh
# tests/state-schema-v2.test.sh — task-pipeline/scripts/state-schema-v2.ts (state.json v2 の
# スキーマ検証モジュール) と state-v2.schema.json のテストを走らせるラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-schema-v2.test.sh      # deno があれば fmt/lint/check/test を通しで実行
#
# - 依存ゼロ・ネットワーク不要 (テスト内の S-AJV が npm:ajv を取得しようとする分だけ例外 —
#   取得できない環境ではそのケースのみ早期 return で SKIP 相当になり、他はネットワーク
#   無しで PASS する)。
# - deno が無い環境では SKIP を表示して exit 0 (tests/state-schema.test.sh と同じ扱い)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_schema_v2_ts=$repo_dir/task-pipeline/scripts/state-schema-v2.ts
state_schema_v2_test_ts=$repo_dir/task-pipeline/scripts/state-schema-v2.test.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-schema-v2 tests — deno not found\n'
    exit 0
fi

[ -f "$state_schema_v2_ts" ] || { printf 'state-schema-v2.ts not found: %s\n' "$state_schema_v2_ts" >&2; exit 1; }
[ -f "$state_schema_v2_test_ts" ] || { printf 'state-schema-v2.test.ts not found: %s\n' "$state_schema_v2_test_ts" >&2; exit 1; }

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

run_step "deno fmt --check" deno fmt --check "$state_schema_v2_ts" "$state_schema_v2_test_ts"
run_step "deno lint" deno lint "$state_schema_v2_ts" "$state_schema_v2_test_ts"
run_step "deno check" deno check "$state_schema_v2_ts" "$state_schema_v2_test_ts"
run_step "deno test" deno test --allow-read="$repo_dir" "$state_schema_v2_test_ts"

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-schema-v2 tests: all steps PASS\n'
else
    printf 'state-schema-v2 tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
