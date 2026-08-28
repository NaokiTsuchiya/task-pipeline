#!/bin/sh
# tests/shell-check-e2e.test.sh — シェル判定ゲート (task-pipeline/scripts/shell-check.ts) を
# 実 git リポジトリと実 CLI で通しで確かめる。
#
#   sh tests/shell-check-e2e.test.sh      # deno と git があれば PASS/FAIL を表示
#
# Case A: gate: light のタスクの research+plan フェーズ — シェル判定に入らず route:"llm" に
#         昇格し、判定ファイルを書かないこと (散文の成果物は機械判定できない)。続けて
#         `state.ts advance` で implement へ進める。
# Case B: implement フェーズ — base スナップショットのマニフェストで実チェックを走らせて PASS。
#         判定 JSON にコマンド・exit code・所要時間・ログパスが載り、ログの実ファイルがあり、
#         その後 `state.ts advance --from implement --to report` が通ること。
# Case C: 承認済みスコープの外を変更すると FAIL になり、required_fixes に許可外パスが載ること。
# Case D: 作業ブランチに別のマニフェストをコミットしても、実行されるのは base 側のチェックで
#         あること (コマンドインジェクション防止の信頼境界そのもの)。
#
# - 依存ゼロ・ネットワーク不要 (deno と git 以外)。どちらかが無ければ SKIP + exit 0。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
shell_check_ts=$repo_dir/task-pipeline/scripts/shell-check.ts
state_ts=$repo_dir/task-pipeline/scripts/state.ts

[ -f "$shell_check_ts" ] || { printf 'shell-check.ts not found: %s\n' "$shell_check_ts" >&2; exit 1; }
[ -f "$state_ts" ] || { printf 'state.ts not found: %s\n' "$state_ts" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  shell-check-e2e test — deno not found\n'
    exit 0
fi
if ! command -v git >/dev/null 2>&1; then
    printf 'SKIP  shell-check-e2e test — git not found\n'
    exit 0
fi

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

work=$(mktemp -d) || exit 1
cleanup() {
    [ "${KEEP_SANDBOX:-0}" = 1 ] && { printf 'sandbox kept: %s\n' "$work"; return; }
    rm -rf "$work"
}
trap cleanup EXIT

id=gh-1
sd=$work/.task-pipeline
wt=$work/repo
mkdir -p "$sd/tasks" "$sd/runs/$id/verdicts" "$wt/docs" || exit 1

# base (main) に信頼済みマニフェストを置き、タスク専用ブランチへ分岐する
# (実運用の worktree は必ず自分のブランチに居る — playbooks/worktree.md)。
cat > "$wt/TASK_PIPELINE_CHECKS.json" <<'JSON'
{
  "version": 1,
  "scope": { "allow": ["docs/**"] },
  "checks": [
    { "name": "docs-present", "command": "test", "args": ["-f", "docs/seed.md"] }
  ]
}
JSON
printf 'seed\n' > "$wt/docs/seed.md"
(
    cd "$wt" &&
    git init -q -b main &&
    git config user.email t@example.com &&
    git config user.name t &&
    git add -A &&
    git commit -q -m seed &&
    git checkout -q -b "task-pipeline/$id"
) || { ng "setup: git リポジトリの用意" "failed"; exit 1; }

cat > "$sd/tasks/$id.md" <<'MD'
---
id: gh-1
gate: light
---
本文
MD

write_state() {
    cat > "$sd/state.json" <<JSON
{
  "tracker": "markdown",
  "source": "./TASKS.md",
  "updated_at": "2026-08-07T00:00:00Z",
  "stalled": null,
  "stalled_since": null,
  "schema_version": 2,
  "queue": [
    {
      "id": "$id",
      "title": "サンプル",
      "progress": "running",
      "run": {
        "kind": "initial",
        "gate": "light",
        "phase": "$1",
        "attempts": 0,
        "executor": null,
        "executor_last_event_at": null,
        "takeover_at": null,
        "verifier": null,
        "verifier_session": null
      },
      "blocked_reason": null,
      "artifact": { "state": "none" },
      "worktree": "$wt",
      "base": "main",
      "session": null
    }
  ],
  "completed": [],
  "candidates": [],
  "relisted": [],
  "promoted": [],
  "withdrawn_branches": [],
  "history": []
}
JSON
}

state_cli() {
    deno run --no-prompt --allow-read="$sd" --allow-write="$sd" "$state_ts" "$@" 2>&1
}

shell_check() {
    deno run --no-prompt --allow-read="$sd,$wt" --allow-write="$sd" --allow-run \
        "$shell_check_ts" --state-dir "$sd" --id "$id" --verdict-path "$1" 2>&1
}

verdict_path_of() {
    state_cli verdict-path --state-dir "$sd" --id "$id" |
        sed -n 's/.*"path":"\([^"]*\)".*/\1/p'
}

# Case A: research+plan は昇格する
printf '# Case A — research+plan は shell 判定に入らず LLM 経路へ昇格する\n'
write_state "research+plan"
vp_a=$(verdict_path_of)
case $vp_a in
    "$sd/runs/$id/verdicts/research+plan-0.json") ok "Case A: verdict-path が判定ファイルの位置を返す" ;;
    *) ng "Case A: verdict-path" "got=$vp_a" ;;
esac

out_a=$(shell_check "$vp_a")
case $out_a in
    *'"route":"llm"'*) ok "Case A: route llm へ昇格した" ;;
    *) ng "Case A: route llm" "out=$out_a" ;;
esac
case $out_a in
    *'phase research+plan is not shell-auditable'*) ok "Case A: 昇格の理由がフェーズ由来と分かる" ;;
    *) ng "Case A: 昇格の理由" "out=$out_a" ;;
esac
if [ -e "$vp_a" ]; then
    ng "Case A: 判定ファイルを書かない" "$vp_a が生成された"
else
    ok "Case A: 判定ファイルを書かない"
fi

out_adv=$(state_cli advance --state-dir "$sd" --id "$id" --from "research+plan" --to implement)
case $out_adv in
    *'"ok":true'*) ok "Case A: advance research+plan → implement" ;;
    *) ng "Case A: advance research+plan → implement" "out=$out_adv" ;;
esac

# Case B: implement は機械判定して PASS し、advance できる
printf '# Case B — implement は base のマニフェストで実チェックを走らせて PASS する\n'
vp_b=$(verdict_path_of)
out_b=$(shell_check "$vp_b")
case $out_b in
    *'"route":"shell"'*'"verdict":"PASS"'*) ok "Case B: route shell で PASS" ;;
    *) ng "Case B: route shell で PASS" "out=$out_b" ;;
esac

if [ -f "$vp_b" ]; then
    ok "Case B: 判定ファイルを runs/<id>/verdicts/ に書いた"
else
    ng "Case B: 判定ファイル" "$vp_b が無い"
fi
body_b=$(cat "$vp_b" 2>/dev/null || printf '')
for needle in '"mode": "shell"' '"command": "test"' '"exit_code": 0' '"duration_ms"' '"ref": "main:TASK_PIPELINE_CHECKS.json"'; do
    case $body_b in
        *"$needle"*) ok "Case B: 判定 JSON に $needle がある" ;;
        *) ng "Case B: 判定 JSON の $needle" "body=$body_b" ;;
    esac
done
log_b=$(printf '%s' "$body_b" | sed -n 's/.*"log": "\([^"]*\)".*/\1/p' | head -1)
if [ -n "$log_b" ] && [ -f "$log_b" ]; then
    ok "Case B: ログパスに実ファイルがある"
else
    ng "Case B: ログの実ファイル" "log=$log_b"
fi

out_adv_b=$(state_cli advance --state-dir "$sd" --id "$id" --from implement --to report)
case $out_adv_b in
    *'"ok":true'*) ok "Case B: PASS の後に advance implement → report が通る" ;;
    *) ng "Case B: advance implement → report" "out=$out_adv_b" ;;
esac

# Case C: スコープ違反は FAIL
printf '# Case C — 承認済みスコープの外を変更すると FAIL になる\n'
write_state implement
printf 'x\n' > "$wt/rogue.ts"
vp_c=$(verdict_path_of)
out_c=$(shell_check "$vp_c")
case $out_c in
    *'"verdict":"FAIL"'*) ok "Case C: スコープ違反で FAIL" ;;
    *) ng "Case C: スコープ違反で FAIL" "out=$out_c" ;;
esac
case $(cat "$vp_c" 2>/dev/null || printf '') in
    *'rogue.ts'*) ok "Case C: 許可外パスが判定 JSON に載る" ;;
    *) ng "Case C: 許可外パスの記録" "body=$(cat "$vp_c" 2>/dev/null)" ;;
esac
rm -f "$wt/rogue.ts"

# Case D: 信頼境界 (base スナップショット)
printf '# Case D — 作業ブランチのマニフェストは読まない\n'
cat > "$wt/TASK_PIPELINE_CHECKS.json" <<'JSON'
{
  "version": 1,
  "scope": { "allow": ["**"] },
  "checks": [ { "name": "hijack", "command": "true" } ]
}
JSON
(cd "$wt" && git add -A && git commit -q -m hijack) ||
    { ng "Case D: 作業ブランチへのコミット" "failed"; exit 1; }

write_state implement
vp_d=$(verdict_path_of)
out_d=$(shell_check "$vp_d")
body_d=$(cat "$vp_d" 2>/dev/null || printf '')
case $body_d in
    *'"name": "hijack"'*) ng "Case D: base のチェックだけを実行する" "作業ブランチ側の checks が走った" ;;
    *'"name": "docs-present"'*) ok "Case D: base のチェックだけを実行する" ;;
    *) ng "Case D: base のチェックだけを実行する" "body=$body_d" ;;
esac
case $out_d in
    *'"verdict":"FAIL"'*) ok "Case D: base の allow が効いてスコープ違反を検出する" ;;
    *) ng "Case D: base の allow が効く" "out=$out_d" ;;
esac

printf '\n----------------------------------------\n'
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
