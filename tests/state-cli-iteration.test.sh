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

# finish=none 相当 (コミット 0 件) で in-review に入る。契約の 4 フラグ規則 (--commits/--ref/
# --branch/--base は 4 つとも指定か 4 つとも省略のどちらかのみ) により、finish=none では 4
# フラグを渡さない (review に書く値が無いため)。ref が PR URL でないので --clear-session true
# を付ける (SKILL.md のレビュー待ち処理と同じ形)。
step "in-review --clear-session true (finish=none)" in-review --id "$id" --clear-session true
if [ "$aborted" != 1 ]; then
    got=$(field status)
    if [ "$got" = "in_review" ]; then ok "in-review 後 status=in_review"; else ng "in-review 後 status=in_review" "got=$got"; fi

    got=$(field review)
    if [ "$got" = "None" ]; then ok "in-review(4フラグ省略) 後も review は書き換わらない (番兵文字列が入らない)"; else ng "in-review(4フラグ省略) 後も review は書き換わらない" "got=$got"; fi
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

# --- pr_fix 復帰の verb 列 -----------------------------------------------------
# fix-pending → fix-start → finalize-start --from pr_fix → fix-done → in-review。
# fix-done の前提は status=="in_progress" && phase=="finalize" && review.watch!=null で、
# in-review は status を in_review に、phase を null に書き換える。fix-done は in-review より
# 前に呼ぶ必要があり (SKILL.md の順序制約)、逆順で呼ぶと fix-done が conflict で失敗する
# (このシナリオはその回帰を防ぐ)。独立したフィクスチャ・状態ディレクトリを使うため、上の
# シナリオの $id / $state_dir / run_state / field / step は使わず、専用のヘルパーを使う。
fixture2=$tests_dir/fixtures/state-cli/valid-watch-rebase.json
id2=t-full

[ -f "$fixture2" ] || { printf 'fixture not found: %s\n' "$fixture2" >&2; exit 1; }

work2=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s / %s\n" "$work" "$work2"; else rm -rf "$work" "$work2"; fi' EXIT

state_dir2=$work2/.task-pipeline
mkdir -p "$state_dir2"
cp "$fixture2" "$state_dir2/state.json"
findings2=$work2/findings.json

aborted2=0

run_state2() {
    out2=$(deno run --no-prompt \
        --allow-read="$state_dir2" \
        --allow-write="$state_dir2" \
        "$state_ts" "$@" --state-dir "$state_dir2" 2>&1)
    rc2=$?
}

field2() {
    python3 -c "import json,sys; d=json.load(open('$state_dir2/state.json')); q=[x for x in d['queue'] if x['id']=='$id2'][0]; print(q.get('$1'))"
}

watch_field2() {
    python3 -c "import json,sys; d=json.load(open('$state_dir2/state.json')); q=[x for x in d['queue'] if x['id']=='$id2'][0]; print(json.dumps(q['review']['watch'].get('$1')))"
}

step2() {
    _label=$1
    shift
    if [ "$aborted2" = 1 ]; then
        ng "$_label" "前段が失敗したためスキップ"
        return
    fi
    run_state2 "$@"
    if [ "$rc2" = 0 ]; then
        ok "$_label (exit 0)"
    else
        ng "$_label" "exit=$rc2 out=$(printf '%s' "$out2" | tr '\n' '|')"
        aborted2=1
    fi
}

printf '\n# pr_fix 復帰 verb 列 checks — id=%s (fixture=%s)\n' "$id2" "$fixture2"

step2 "fix-pending --id $id2 --pending-ids rc-9,rc-8" fix-pending --id "$id2" --pending-ids "rc-9,rc-8" --findings "$findings2"
step2 "fix-start --id $id2 --session sess-pr-fix" fix-start --id "$id2" --session sess-pr-fix
step2 "finalize-start --id $id2 --from pr_fix" finalize-start --id "$id2" --from pr_fix
if [ "$aborted2" != 1 ]; then
    got=$(field2 phase)
    if [ "$got" = "finalize" ]; then ok "finalize-start(pr_fix) 後 phase=finalize"; else ng "finalize-start(pr_fix) 後 phase=finalize" "got=$got"; fi
fi

# 正しい順序: fix-done を in-review より前に呼ぶ (SKILL.md の順序制約どおり)。
step2 "fix-done --id $id2 (in-review より前)" fix-done --id "$id2"
step2 "in-review --id $id2 (pr_fix 復帰・4フラグ省略)" in-review --id "$id2"

if [ "$aborted2" != 1 ]; then
    got=$(field2 status)
    if [ "$got" = "in_review" ]; then ok "in-review 後 status=in_review"; else ng "in-review 後 status=in_review" "got=$got"; fi

    got=$(watch_field2 pending_ids)
    if [ "$got" = "[]" ]; then ok "fix-done 後 watch.pending_ids が空"; else ng "fix-done 後 watch.pending_ids が空" "got=$got"; fi

    got=$(watch_field2 handled)
    if [ "$got" = '["c1", "c2", "rc-9", "rc-8"]' ]; then
        ok "fix-done 後 watch.handled に対応済み id (rc-9, rc-8) が重複無く合流している"
    else
        ng "fix-done 後 watch.handled に対応済み id が合流している" "got=$got"
    fi
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
