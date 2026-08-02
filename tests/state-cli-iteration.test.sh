#!/bin/sh
# tests/state-cli-iteration.test.sh — 既存の .task-pipeline/state.json を持つプロジェクトを
# 模したフィクスチャに対し、移行後の手順どおりに 1 イテレーション相当の遷移を CLI で流し、
# validate が PASS することを確認する (skill-state-cli-migration の受け入れ条件 8)。
#
#   sh tests/state-cli-iteration.test.sh      # deno があれば PASS/FAIL を表示
#
# タスク本文が言う「claim → phase-pass → in-review」は代表 verb の例示であり、実際の full
# gate (このフィクスチャの queue エントリは gate: full) では
#   claim → phase-pass(research→plan) → phase-pass(plan→implement) →
#   phase-pass(implement→report) → finalize-start(report→finalize) → in-review → validate
# という、各 verb の前提 (state-cli-contract.md) を実際に満たす順序で呼ぶ必要がある。前提を
# 迂回するショートカットは取らない。
#
# - 依存ゼロ・ネットワーク不要。deno が無ければ SKIP + exit 0。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_ts=$repo_dir/task-pipeline/scripts/state.ts
fixture=$tests_dir/fixtures/state-cli/valid-skill-example.json
id=t-1a2b3c4d

[ -f "$state_ts" ] || { printf 'state.ts not found: %s\n' "$state_ts" >&2; exit 1; }
[ -f "$fixture" ] || { printf 'fixture not found: %s\n' "$fixture" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-cli-iteration test — deno not found\n'
    exit 0
fi

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

state_dir=$work/.task-pipeline
mkdir -p "$state_dir"
cp "$fixture" "$state_dir/state.json"

pass=0
fail=0
aborted=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

run_state() {
    out=$(deno run --no-prompt \
        --allow-read="$state_dir" \
        --allow-write="$state_dir" \
        "$state_ts" "$@" --state-dir "$state_dir" 2>&1)
    rc=$?
}

field() {
    # $1 = jq 風の単純フィールド抽出 (grep ベース。deno/jq 追加依存を避けるため python3 を使う)
    python3 -c "import json,sys; d=json.load(open('$state_dir/state.json')); q=[x for x in d['queue'] if x['id']=='$id'][0]; print(q.get('$1'))"
}

step() {
    _label=$1
    shift
    if [ "$aborted" = 1 ]; then
        ng "$_label" "前段が失敗したためスキップ"
        return
    fi
    run_state "$@"
    if [ "$rc" = 0 ]; then
        ok "$_label (exit 0)"
    else
        ng "$_label" "exit=$rc out=$(printf '%s' "$out" | tr '\n' '|')"
        aborted=1
    fi
}

printf '# state-cli-iteration checks — repo=%s id=%s\n' "$repo_dir" "$id"

# --- 前提: フィクスチャの queue エントリが claim 可能な状態 (status: approved) であること ---
initial_status=$(field status)
if [ "$initial_status" = "approved" ]; then
    ok "フィクスチャの初期 status が approved である (claim の前提)"
else
    ng "フィクスチャの初期 status が approved である" "got=$initial_status"
    aborted=1
fi

# --- 1 イテレーション相当の遷移 ---------------------------------------------
step "claim --id $id --session sess-test" claim --id "$id" --session sess-test
if [ "$aborted" != 1 ]; then
    got=$(field phase)
    if [ "$got" = "research" ]; then ok "claim 後 phase=research"; else ng "claim 後 phase=research" "got=$got"; fi
fi

step "phase-pass research->plan" phase-pass --id "$id" --from research --to plan
step "phase-pass plan->implement" phase-pass --id "$id" --from plan --to implement
step "phase-pass implement->report" phase-pass --id "$id" --from implement --to report
step "finalize-start --from report" finalize-start --id "$id" --from report
if [ "$aborted" != 1 ]; then
    got=$(field phase)
    if [ "$got" = "finalize" ]; then ok "finalize-start 後 phase=finalize"; else ng "finalize-start 後 phase=finalize" "got=$got"; fi
fi

# finish=none 相当 (commits 0) で in-review に入る。--commits 0 のときは --tip を付けない。
step "in-review --commits 0" in-review --id "$id" --commits 0 --ref none --branch "task-pipeline/$id" --base main
if [ "$aborted" != 1 ]; then
    got=$(field status)
    if [ "$got" = "in_review" ]; then ok "in-review 後 status=in_review"; else ng "in-review 後 status=in_review" "got=$got"; fi
fi

# --- validate が PASS すること -----------------------------------------------
run_state validate
validate_ok=0
case $out in
    *'"ok":true'*|*'"ok": true'*) validate_ok=1 ;;
esac
if [ "$rc" = 0 ] && [ "$validate_ok" = 1 ]; then
    ok "最終状態で validate が PASS する"
else
    ng "最終状態で validate が PASS する" "rc=$rc out=$(printf '%s' "$out" | tr '\n' '|')"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
