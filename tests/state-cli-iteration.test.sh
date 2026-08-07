#!/bin/sh
# tests/state-cli-iteration.test.sh — 既存の .task-pipeline/state.json を持つプロジェクトを
# 模したフィクスチャに対し、v2 の手順どおりに 1 イテレーション相当の遷移を CLI で流し、
# validate が PASS することを確認する。
#
#   sh tests/state-cli-iteration.test.sh      # deno があれば PASS/FAIL を表示
#
# 各 verb の前提 (task-pipeline/docs/state-cli-contract.md) を実際に満たす順序で呼ぶ。
# 前提を迂回するショートカットは取らない。
#   シナリオ A (初回 engagement): claim → advance ×3 → ship → validate
#   シナリオ B (pr_fix 復帰): fix-request → fix-start → advance → ship
# v1 で 3 verb に分かれていた復帰列 (fix-done → in-review → watch-set) は ship 1 回に
# 畳まれている (設計2.2) ので、「順序を誤ると壊れる」形そのものが無くなっている。
#
# - 依存ゼロ・ネットワーク不要。deno が無ければ SKIP + exit 0。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_ts=$repo_dir/task-pipeline/scripts/state.ts
fixture=$tests_dir/fixtures/state-cli/v2-queued.json
id=t-1a2b3c4d

[ -f "$state_ts" ] || { printf 'state.ts not found: %s\n' "$state_ts" >&2; exit 1; }
[ -f "$fixture" ] || { printf 'fixture not found: %s\n' "$fixture" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-cli-iteration test — deno not found\n'
    exit 0
fi

work=$(mktemp -d) || exit 1
work2=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s / %s\n" "$work" "$work2"; else rm -rf "$work" "$work2"; fi' EXIT

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

# $1 = queue エントリ直下のフィールド名 (python3 で読む。jq 追加依存を避ける)
field() {
    python3 -c "import json; d=json.load(open('$state_dir/state.json')); q=[x for x in d['queue'] if x['id']=='$id'][0]; print(q.get('$1'))"
}

# $1 = run の中のフィールド名
run_field() {
    python3 -c "import json; d=json.load(open('$state_dir/state.json')); q=[x for x in d['queue'] if x['id']=='$id'][0]; r=q.get('run') or {}; print(r.get('$1'))"
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

# --- 前提: フィクスチャの queue エントリが claim 可能な状態 (progress: queued) ---
initial_progress=$(field progress)
if [ "$initial_progress" = "queued" ]; then
    ok "フィクスチャの初期 progress が queued である (claim の前提)"
else
    ng "フィクスチャの初期 progress が queued である" "got=$initial_progress"
    aborted=1
fi

# --- シナリオ A: 初回 engagement ---------------------------------------------
step "claim --id $id --session sess-test" claim --id "$id" --session sess-test
if [ "$aborted" != 1 ]; then
    got=$(run_field phase)
    if [ "$got" = "research" ]; then ok "claim 後 phase=research"; else ng "claim 後 phase=research" "got=$got"; fi
    got=$(run_field kind)
    if [ "$got" = "initial" ]; then ok "claim 後 kind=initial"; else ng "claim 後 kind=initial" "got=$got"; fi
fi

step "advance research->plan" advance --id "$id" --from research --to plan
step "advance plan->implement" advance --id "$id" --from plan --to implement
step "advance implement->report" advance --id "$id" --from implement --to report
step "advance report->finalize" advance --id "$id" --from report --to finalize
if [ "$aborted" != 1 ]; then
    got=$(run_field phase)
    if [ "$got" = "finalize" ]; then ok "advance 後 phase=finalize"; else ng "advance 後 phase=finalize" "got=$got"; fi
fi

# finish=none 相当 (コミット 0 件)。契約の 4 フラグ規則により --ref/--branch/--tip/--base は
# 4 つとも省略する (共有された成果物が無いため)。
step "ship --commits 0 (finish=none)" ship --id "$id" --commits 0
if [ "$aborted" != 1 ]; then
    got=$(field progress)
    if [ "$got" = "resting" ]; then ok "ship 後 progress=resting"; else ng "ship 後 progress=resting" "got=$got"; fi

    got=$(python3 -c "import json; d=json.load(open('$state_dir/state.json')); q=[x for x in d['queue'] if x['id']=='$id'][0]; print(json.dumps(q['artifact']))")
    if [ "$got" = '{"state": "none"}' ]; then
        ok "ship(commits 0) 後も artifact は none のまま (グループ欄を書かない)"
    else
        ng "ship(commits 0) 後も artifact は none のまま" "got=$got"
    fi

    got=$(printf '%s' "$out" | python3 -c "import json,sys; print(json.load(sys.stdin)['mark'])")
    if [ "$got" = "True" ]; then
        ok "ship の応答が mark=true (initial の終端なのでトラッカー更新が要る)"
    else
        ng "ship の応答が mark=true" "got=$got"
    fi
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

# --- シナリオ B: pr_fix 復帰の verb 列 ----------------------------------------
# fix-request → fix-start → advance(pr_fix→finalize) → ship。
# v1 では ship に当たる処理が fix-done → in-review → watch-set の 3 verb に分かれており、
# 順序を誤ると指摘が再浮上したり前提違反になったりした。v2 では 1 回の ship が
# handled への合流・ask の消費・sig のリセット・session の扱いをまとめて行う。
fixture2=$tests_dir/fixtures/state-cli/v2-open-follow.json
id2=t-full

[ -f "$fixture2" ] || { printf 'fixture not found: %s\n' "$fixture2" >&2; exit 1; }

state_dir2=$work2/.task-pipeline
mkdir -p "$state_dir2"
cp "$fixture2" "$state_dir2/state.json"
findings2=$work2/findings.md

aborted2=0

run_state2() {
    out2=$(deno run --no-prompt \
        --allow-read="$state_dir2" \
        --allow-write="$state_dir2" \
        "$state_ts" "$@" --state-dir "$state_dir2" 2>&1)
    rc2=$?
}

run_field2() {
    python3 -c "import json; d=json.load(open('$state_dir2/state.json')); q=[x for x in d['queue'] if x['id']=='$id2'][0]; r=q.get('run') or {}; print(r.get('$1'))"
}

# $1 = follow の中のパス (ledger.handled のような 2 段まで)
follow_field2() {
    python3 -c "
import json
d = json.load(open('$state_dir2/state.json'))
q = [x for x in d['queue'] if x['id'] == '$id2'][0]
node = q['artifact']['follow']
for key in '$1'.split('.'):
    node = node[key]
print(json.dumps(node))
"
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

step2 "fix-request --id $id2 --ids rc-9,rc-8" fix-request --id "$id2" --ids "rc-9,rc-8" --findings "$findings2"
step2 "fix-start --id $id2 --session sess-pr-fix" fix-start --id "$id2" --session sess-pr-fix
if [ "$aborted2" != 1 ]; then
    got=$(run_field2 kind)
    if [ "$got" = "pr_fix" ]; then ok "fix-start 後 kind=pr_fix"; else ng "fix-start 後 kind=pr_fix" "got=$got"; fi
fi

step2 "advance pr_fix->finalize" advance --id "$id2" --from pr_fix --to finalize
if [ "$aborted2" != 1 ]; then
    got=$(run_field2 phase)
    if [ "$got" = "finalize" ]; then ok "advance 後 phase=finalize"; else ng "advance 後 phase=finalize" "got=$got"; fi
fi

step2 "ship --id $id2 --commits 1 (pr_fix 復帰)" ship --id "$id2" --commits 1 \
    --ref "https://github.com/o/r/pull/7" --branch "task-pipeline/$id2" --tip sha-tip-2 --base main

if [ "$aborted2" != 1 ]; then
    got=$(printf '%s' "$out2" | python3 -c "import json,sys; o=json.load(sys.stdin); print(o['notify'], o['mark'], o['fix_count'])")
    if [ "$got" = "update False 2" ]; then
        ok "ship の応答が notify=update / mark=false / fix_count=2 (復帰ではトラッカーを更新しない)"
    else
        ng "ship の応答が notify=update / mark=false / fix_count=2" "got=$got"
    fi

    got=$(follow_field2 asks.fix)
    if [ "$got" = "null" ]; then ok "ship 後 asks.fix が消費されている"; else ng "ship 後 asks.fix が消費されている" "got=$got"; fi

    got=$(follow_field2 ledger.handled)
    if [ "$got" = '["c1", "c2", "rc-9", "rc-8"]' ]; then
        ok "ship 後 ledger.handled に対応済み id (rc-9, rc-8) が重複無く合流している"
    else
        ng "ship 後 ledger.handled に対応済み id が合流している" "got=$got"
    fi

    got=$(follow_field2 probe.sig)
    if [ "$got" = "null" ]; then
        ok "ship 後 probe.sig が null (push で head が変わったので次は catch-up 観測)"
    else
        ng "ship 後 probe.sig が null" "got=$got"
    fi

    run_state2 validate
    case $out2 in
        *'"ok":true'*) ok "pr_fix 復帰後も validate が PASS する" ;;
        *) ng "pr_fix 復帰後も validate が PASS する" "rc=$rc2 out=$(printf '%s' "$out2" | tr '\n' '|')" ;;
    esac
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
