#!/bin/sh
# tests/state-next.test.sh — task-pipeline/scripts/state-next.ts (読み取り専用 verb `next`
# の導出本体: 担当判定・追従の要否・サイクルの分岐・ship 引数構成・生存管理・着手可否・
# 回収の後始末・観測依頼と停滞) のテストを走らせるラッパー。
# tests/run.sh から *.test.sh の glob で自動検出される。
#
#   sh tests/state-next.test.sh      # deno があれば fmt/lint/check/test を通しで実行
#
# - 依存ゼロ・ネットワーク不要 (state-next.ts は Deno API も外部モジュールも呼ばず、
#   テスト側のアサーションも自前。--no-remote で強制する)。
# - deno が無い環境では SKIP を表示して exit 0 (他の deno スイートと同じ扱い)。
# - CLI 経路 (`state.ts next` の exit code・state.json のバイト列不変・lock 非取得) は
#   tests/state-cli.test.sh (state.test.ts) が持つ。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_next_ts=$repo_dir/task-pipeline/scripts/state-next.ts
state_next_test_ts=$repo_dir/task-pipeline/scripts/state-next.test.ts

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-next tests — deno not found\n'
    exit 0
fi

[ -f "$state_next_ts" ] || { printf 'state-next.ts not found: %s\n' "$state_next_ts" >&2; exit 1; }
[ -f "$state_next_test_ts" ] || { printf 'state-next.test.ts not found: %s\n' "$state_next_test_ts" >&2; exit 1; }

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

run_step "deno fmt --check" deno fmt --check "$state_next_ts" "$state_next_test_ts"
run_step "deno lint" deno lint "$state_next_ts" "$state_next_test_ts"
run_step "deno check" deno check --no-remote "$state_next_ts" "$state_next_test_ts"
run_step "deno test" deno test --no-remote "$state_next_test_ts"

# 受け入れ条件2: 設計5.1の導出8分類それぞれに、状態フィクスチャ→期待アクションの
# テストがある。テスト名の `next/<分類キー>` を集計して 8 キーが揃うことを見る
# (キーが1つでも欠ければ、その分類の導出が未検証のまま通ってしまう)。
printf '\n-- next/<分類キー> の網羅 (8 分類) --\n'
keys=$(deno test --no-remote "$state_next_test_ts" 2>&1 \
    | grep -oE 'next/(ownership|follow|cycle|finalize|liveness|start|retire|observation)' \
    | sort -u)
key_count=$(printf '%s\n' "$keys" | grep -c .)
if [ "$key_count" -eq 8 ]; then
    printf 'PASS  8 分類すべてにテストがある\n'
else
    fail=$((fail + 1))
    printf 'FAIL  8 分類のうち %s キーしか無い:\n%s\n' "$key_count" "$keys"
fi

printf '\n%s\n' "----------------------------------------"
if [ "$fail" -eq 0 ]; then
    printf 'state-next tests: all steps PASS\n'
else
    printf 'state-next tests: %s step(s) FAILED\n' "$fail"
fi
[ "$fail" -eq 0 ] || exit 1
exit 0
