#!/bin/sh
# tests/state-transitions-v2.test.sh — task-pipeline/scripts/state-transitions-v2.ts
# (状態モデル v2 の遷移: apply 群と VERB_SPEC) のテストを走らせるラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-transitions-v2.test.sh   # deno があれば fmt/lint/check/test を通しで実行
#
# - 依存ゼロ・ネットワーク不要 (state-transitions-v2*.ts は state-model-v2.ts に
#   しか依存せず、Deno API・外部モジュールを一切呼ばない。--allow-* も不要)。
# - deno が無い環境では SKIP を表示して exit 0 (tests/state-model-v2.test.sh と同じ扱い)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
# 層ごとに分かれた 4 ファイル (層 0-2 types / 層 3-7 nodes / 層 8-9 spec / 層 10 本体) を
# まとめて検査する。層の一覧は state-transitions-v2-types.ts の冒頭。
impl_ts=$repo_dir/task-pipeline/scripts/state-transitions-v2.ts
types_ts=$repo_dir/task-pipeline/scripts/state-transitions-v2-types.ts
nodes_ts=$repo_dir/task-pipeline/scripts/state-transitions-v2-nodes.ts
spec_ts=$repo_dir/task-pipeline/scripts/state-transitions-v2-spec.ts
test_ts=$repo_dir/task-pipeline/scripts/state-transitions-v2.test.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-transitions-v2 tests — deno not found\n'
    exit 0
fi

for f in "$impl_ts" "$types_ts" "$nodes_ts" "$spec_ts" "$test_ts"; do
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

run_step "deno fmt --check" deno fmt --check "$impl_ts" "$types_ts" "$nodes_ts" "$spec_ts" "$test_ts"
run_step "deno lint" deno lint "$impl_ts" "$types_ts" "$nodes_ts" "$spec_ts" "$test_ts"
run_step "deno check" deno check "$impl_ts" "$types_ts" "$nodes_ts" "$spec_ts" "$test_ts"
run_step "deno test" deno test "$test_ts"

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-transitions-v2 tests: all steps PASS\n'
else
    printf 'state-transitions-v2 tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
