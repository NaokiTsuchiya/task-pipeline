#!/bin/sh
# tests/state-cli-init-bootstrap.test.sh — task-pipeline/SKILL.md「毎イテレーションの手順」手順 0
# が新たに指示する `state.ts init` の呼び出しを、実際の CLI に対して再現する
# (state-init-bootstrap の受け入れ条件 6・7)。
#
#   sh tests/state-cli-init-bootstrap.test.sh      # deno があれば PASS/FAIL を表示
#
# Case A: state.json が丸ごと無いプロジェクト (git リポジトリ) — SKILL.md の新手順どおりに
#         `state.ts init` → `get` → `candidates-set` → `stalled-set` を順に呼び、どれも
#         `missing` (exit 13) で止まらないことを確認する (issue が示した再現手順の反転)。
# Case B: state.json が丸ごと無いプロジェクト (非 git) — SKILL.md:32 が定める非 git 時の
#         `--git-common-dir` の値 (state dir 自身) で同じ手順が通ることを確認する。
# Case C: schema_version 1 の既存 state.json を持つプロジェクト — 1 回目の init が v2 へ
#         移行し、**2 回目の init が再移行しない** (ファイル全体がバイト単位で無変化) ことを
#         diff で確認する。移行は一度だけという要求 (設計3.2) を、CLI の実起動で固定する
#         検査である。移行後は tracker/source が --tracker/--source では上書きされないこと、
#         schema_version が 2 になること、queue の件数が保たれることも見る。
#
# - 依存ゼロ・ネットワーク不要 (deno と git 以外)。deno が無ければ SKIP + exit 0。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
state_ts=$repo_dir/task-pipeline/scripts/state.ts
fixture=$tests_dir/fixtures/state-cli/valid-watch-rebase.json

[ -f "$state_ts" ] || { printf 'state.ts not found: %s\n' "$state_ts" >&2; exit 1; }
[ -f "$fixture" ] || { printf 'fixture not found: %s\n' "$fixture" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  state-cli-init-bootstrap test — deno not found\n'
    exit 0
fi
if ! command -v git >/dev/null 2>&1; then
    printf 'SKIP  state-cli-init-bootstrap test — git not found\n'
    exit 0
fi

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

cleanup_dirs=""
cleanup() {
    [ "${KEEP_SANDBOX:-0}" = 1 ] && { printf 'sandboxes kept: %s\n' "$cleanup_dirs"; return; }
    for d in $cleanup_dirs; do rm -rf "$d"; done
}
trap cleanup EXIT

# --- Case A: 空の git リポジトリ ---------------------------------------------
printf '# Case A — 空の git リポジトリで state.ts init から候補承認経路まで到達する\n'

workA=$(mktemp -d) || exit 1
cleanup_dirs="$cleanup_dirs $workA"
(cd "$workA" && git init -q) || { ng "Case A: git init" "failed"; workA_bad=1; }

if [ "${workA_bad:-0}" != 1 ]; then
    gcdA=$(cd "$workA" && git rev-parse --path-format=absolute --git-common-dir)
    sdA="$workA/.task-pipeline"

    outA=$(deno run --no-prompt \
        --allow-read="$sdA,$gcdA/info" --allow-write="$sdA,$gcdA/info" \
        "$state_ts" init --state-dir "$sdA" --tracker markdown --source ./TASKS.md --git-common-dir "$gcdA" 2>&1)
    rcA=$?
    case $outA in
        *'"ok":true'*'"created":true'*) ok "Case A: state.ts init (exit 0, created:true)" ;;
        *) ng "Case A: state.ts init (exit 0, created:true)" "rc=$rcA out=$outA" ;;
    esac

    if grep -qxF '/.task-pipeline/' "$gcdA/info/exclude" 2>/dev/null; then
        ok "Case A: <git common dir>/info/exclude に /.task-pipeline/ が追記されている"
    else
        ng "Case A: <git common dir>/info/exclude に /.task-pipeline/ が追記されている" "content=$(cat "$gcdA/info/exclude" 2>&1 | tr '\n' '|')"
    fi

    outA=$(deno run --no-prompt --allow-read="$sdA" --allow-write="$sdA" "$state_ts" get --state-dir "$sdA" 2>&1)
    rcA=$?
    if [ "$rcA" = 13 ]; then
        ng "Case A: get が missing(13) で止まらない" "rc=$rcA out=$outA"
    else
        ok "Case A: get が missing(13) で止まらない (rc=$rcA)"
    fi

    outA=$(deno run --no-prompt --allow-read="$sdA" --allow-write="$sdA" "$state_ts" candidates-set --state-dir "$sdA" --candidates-json '[]' 2>&1)
    rcA=$?
    if [ "$rcA" = 13 ]; then
        ng "Case A: candidates-set が missing(13) で止まらない" "rc=$rcA out=$outA"
    else
        ok "Case A: candidates-set が missing(13) で止まらない (rc=$rcA)"
    fi

    outA=$(deno run --no-prompt --allow-read="$sdA" --allow-write="$sdA" "$state_ts" stalled-set --state-dir "$sdA" --value depleted 2>&1)
    rcA=$?
    if [ "$rcA" = 13 ]; then
        ng "Case A: stalled-set が missing(13) で止まらない" "rc=$rcA out=$outA"
    else
        ok "Case A: stalled-set が missing(13) で止まらない (rc=$rcA)"
    fi
fi

# --- Case B: 非 git プロジェクト (state dir 自身を --git-common-dir に渡す) ---
printf '\n# Case B — 非 git プロジェクトで SKILL.md:32 の fallback (state dir 自身) が通る\n'

workB=$(mktemp -d) || exit 1
cleanup_dirs="$cleanup_dirs $workB"
sdB="$workB/.task-pipeline"

outB=$(deno run --no-prompt --allow-read="$sdB" --allow-write="$sdB" \
    "$state_ts" init --state-dir "$sdB" --tracker markdown --source ./TASKS.md --git-common-dir "$sdB" 2>&1)
rcB=$?
case $outB in
    *'"ok":true'*'"created":true'*) ok "Case B: state.ts init (追加の Deno 権限ブラケット無しで exit 0)" ;;
    *) ng "Case B: state.ts init (追加の Deno 権限ブラケット無しで exit 0)" "rc=$rcB out=$outB" ;;
esac

outB=$(deno run --no-prompt --allow-read="$sdB" --allow-write="$sdB" "$state_ts" get --state-dir "$sdB" 2>&1)
rcB=$?
if [ "$rcB" = 13 ]; then
    ng "Case B: get が missing(13) で止まらない" "rc=$rcB out=$outB"
else
    ok "Case B: get が missing(13) で止まらない (rc=$rcB)"
fi

# --- Case C: 既存 state.json (schema_version 1) を持つ state dir ---------------
printf '\n# Case C — schema_version 1 の既存 state.json は一度だけ移行され、2 回目は無変化\n'

workC=$(mktemp -d) || exit 1
cleanup_dirs="$cleanup_dirs $workC"
(cd "$workC" && git init -q) || { ng "Case C: git init" "failed"; workC_bad=1; }

if [ "${workC_bad:-0}" != 1 ]; then
    gcdC=$(cd "$workC" && git rev-parse --path-format=absolute --git-common-dir)
    sdC="$workC/.task-pipeline"
    mkdir -p "$sdC"
    cp "$fixture" "$sdC/state.json"
    before=$workC/before.json
    cp "$fixture" "$before"

    outC=$(deno run --no-prompt \
        --allow-read="$sdC,$gcdC/info" --allow-write="$sdC,$gcdC/info" \
        "$state_ts" init --state-dir "$sdC" --tracker OTHER --source OTHER --git-common-dir "$gcdC" 2>&1)
    rcC=$?
    case $outC in
        *'"ok":true'*'"created":false'*'"migrated":true'*) ok "Case C: 1 回目の state.ts init が移行する (created:false, migrated:true)" ;;
        *) ng "Case C: 1 回目の state.ts init が移行する" "rc=$rcC out=$outC" ;;
    esac

    if diff -q "$before" "$sdC/state.json" >/dev/null 2>&1; then
        ng "Case C: 1 回目の init で state.json が書き換わる" "移行したのに無変化"
    else
        ok "Case C: 1 回目の init で state.json が書き換わる (v1 → v2)"
    fi

    got=$(python3 -c "import json; print(json.load(open('$sdC/state.json'))['schema_version'])" 2>&1)
    if [ "$got" = "2" ]; then
        ok "Case C: 移行後の schema_version が 2"
    else
        ng "Case C: 移行後の schema_version が 2" "got=$got"
    fi

    for field in tracker source; do
        got=$(python3 -c "import json; print(json.load(open('$sdC/state.json'))['$field'])" 2>&1)
        want=$(python3 -c "import json; print(json.load(open('$before'))['$field'])" 2>&1)
        if [ "$got" = "$want" ]; then
            ok "Case C: $field が --tracker/--source で上書きされない (got=$got)"
        else
            ng "Case C: $field が --tracker/--source で上書きされない" "got=$got want=$want"
        fi
    done

    got_queue=$(python3 -c "import json; print(len(json.load(open('$sdC/state.json'))['queue']))" 2>&1)
    want_queue=$(python3 -c "import json; print(len(json.load(open('$before'))['queue']))" 2>&1)
    if [ "$got_queue" = "$want_queue" ]; then
        ok "Case C: queue の件数が移行で変化しない (got=$got_queue)"
    else
        ng "Case C: queue の件数が移行で変化しない" "got=$got_queue want=$want_queue"
    fi

    # 2 回目の init は再移行しない (バイト単位で無変化)
    after_first=$workC/after-first.json
    cp "$sdC/state.json" "$after_first"

    outC2=$(deno run --no-prompt \
        --allow-read="$sdC,$gcdC/info" --allow-write="$sdC,$gcdC/info" \
        "$state_ts" init --state-dir "$sdC" --tracker OTHER --source OTHER --git-common-dir "$gcdC" 2>&1)
    rcC2=$?
    case $outC2 in
        *'"ok":true'*'"created":false'*'"migrated":false'*) ok "Case C: 2 回目の state.ts init が no-op を報告する (migrated:false)" ;;
        *) ng "Case C: 2 回目の state.ts init が no-op を報告する" "rc=$rcC2 out=$outC2" ;;
    esac

    if diff -q "$after_first" "$sdC/state.json" >/dev/null 2>&1; then
        ok "Case C: 2 回目の init で state.json がバイト単位で無変化 (再移行しない)"
    else
        ng "Case C: 2 回目の init で state.json がバイト単位で無変化" "$(diff "$after_first" "$sdC/state.json" 2>&1 | tr '\n' '|')"
    fi

    # 移行後の state に対して後続の verb が動く
    outC3=$(deno run --no-prompt --allow-read="$sdC" --allow-write="$sdC" \
        "$state_ts" validate --state-dir "$sdC" 2>&1)
    case $outC3 in
        *'"ok":true'*) ok "Case C: 移行後の state.json が validate を通る" ;;
        *) ng "Case C: 移行後の state.json が validate を通る" "out=$outC3" ;;
    esac
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
