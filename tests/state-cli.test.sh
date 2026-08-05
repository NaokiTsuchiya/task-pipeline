#!/bin/sh
# tests/state-cli.test.sh — task-pipeline/scripts/state.ts (state.json の CLI 化: lock・
# 原子的書き込み・heartbeat・init・checkState 統合) のテストを走らせるラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-cli.test.sh      # deno があれば fmt/lint/check/test を通しで実行
#
# - 依存ゼロ・ネットワーク不要 (state.test.ts はサブプロセスで state.ts 自身を起動して
#   検証するが、いずれもネットワークへは出ない。--allow-net を与えないことでこれを強制する)。
# - deno が無い環境では SKIP を表示して exit 0 (tests/state-schema.test.sh と同じ扱い)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_ts=$repo_dir/task-pipeline/scripts/state.ts
state_test_ts=$repo_dir/task-pipeline/scripts/state.test.ts
# state-cli-verbs で追加: 所有権判定 (classifySessionOwnership/isTouchable) は
# state-schema.ts と同型の別ファイルに切り出してあるので、こちらも fmt/lint/check/test の
# 対象に含める。
state_ownership_ts=$repo_dir/task-pipeline/scripts/state-ownership.ts
state_ownership_test_ts=$repo_dir/task-pipeline/scripts/state-ownership.test.ts
# state.ts から切り出した42 verb の遷移純粋関数群。専用のテストファイルは持たない
# (state.test.ts は state.ts をサブプロセス起動して検証する既存の安全網のまま変更しない)
# ため、fmt/lint/check の対象にだけ加える。
state_transitions_ts=$repo_dir/task-pipeline/scripts/state-transitions.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-cli tests — deno not found\n'
    exit 0
fi

[ -f "$state_ts" ] || { printf 'state.ts not found: %s\n' "$state_ts" >&2; exit 1; }
[ -f "$state_test_ts" ] || { printf 'state.test.ts not found: %s\n' "$state_test_ts" >&2; exit 1; }
[ -f "$state_ownership_ts" ] || { printf 'state-ownership.ts not found: %s\n' "$state_ownership_ts" >&2; exit 1; }
[ -f "$state_ownership_test_ts" ] || { printf 'state-ownership.test.ts not found: %s\n' "$state_ownership_test_ts" >&2; exit 1; }
[ -f "$state_transitions_ts" ] || { printf 'state-transitions.ts not found: %s\n' "$state_transitions_ts" >&2; exit 1; }

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

run_step "deno fmt --check" deno fmt --check "$state_ts" "$state_test_ts" "$state_ownership_ts" "$state_ownership_test_ts" "$state_transitions_ts"
run_step "deno lint" deno lint "$state_ts" "$state_test_ts" "$state_ownership_ts" "$state_ownership_test_ts" "$state_transitions_ts"
run_step "deno check" deno check "$state_ts" "$state_test_ts" "$state_ownership_ts" "$state_ownership_test_ts" "$state_transitions_ts"
run_step "deno test" deno test --allow-read --allow-write --allow-env --allow-run "$state_test_ts" "$state_ownership_test_ts"

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-cli tests: all steps PASS\n'
else
    printf 'state-cli tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
