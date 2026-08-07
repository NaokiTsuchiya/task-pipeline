#!/bin/sh
# tests/state-ledger-v2.test.sh — task-pipeline/scripts/state-ledger-v2.ts
# (状態モデル v2 の帳簿系 13 verb: init/get/validate/session-touch/sessions-alive/
# history-append/candidates-*/promoted-*/relisted-*/stalled-set) のテストを走らせる
# ラッパー。tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-ledger-v2.test.sh   # deno があれば fmt/lint/check/test を通しで実行
#
# - ネットワーク不要。state-ledger-v2.ts は Deno API を呼ばない純粋関数群なので
#   --allow-* も要らない (スキーマ JSON の静的 import があるので check には読み取りが要る)。
# - deno が無い環境では SKIP を表示して exit 0 (他の v2 スイートと同じ扱い)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
impl_ts=$repo_dir/task-pipeline/scripts/state-ledger-v2.ts
test_ts=$repo_dir/task-pipeline/scripts/state-ledger-v2.test.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-ledger-v2 tests — deno not found\n'
    exit 0
fi

for f in "$impl_ts" "$test_ts"; do
    [ -f "$f" ] || { printf 'not found: %s\n' "$f" >&2; exit 1; }
done

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

run_step "deno fmt --check" deno fmt --check "$impl_ts" "$test_ts"
run_step "deno lint" deno lint "$impl_ts" "$test_ts"
run_step "deno check" deno check "$impl_ts" "$test_ts"
run_step "deno test" deno test "$test_ts"

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-ledger-v2 tests: all steps PASS\n'
else
    printf 'state-ledger-v2 tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
