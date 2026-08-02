#!/bin/sh
# tests/install-sh-state-cli.test.sh — install.sh が作る symlink 越しに state.ts の CLI が
# 実際に実行できることを確認する (skill-state-cli-migration の受け入れ条件 6)。
#
#   sh tests/install-sh-state-cli.test.sh      # deno があれば PASS/FAIL を表示
#
# - tests/install-sh.test.sh は symlink の存在 (ls -ld のリンク先文字列) だけを見ており、
#   symlink 越しに中のファイルを実行できるかまでは検査していない。このテストはその観点を補う:
#   install.sh を一時ディレクトリへ実行した後、その symlink 越しのパス
#   (<tmp skills dir>/task-pipeline/scripts/state.ts) を deno run にそのまま渡して `get` を
#   実行し、リポジトリ実体を直接指すのではなく symlink を辿って正しく動くことを確認する。
# - 依存ゼロ・ネットワーク不要。deno が無ければ SKIP + exit 0 (tests/state-cli.test.sh と同じ流儀)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
install_sh=$repo_dir/install.sh
fixture=$tests_dir/fixtures/state-cli/valid-skill-example.json

[ -f "$install_sh" ] || { printf 'install.sh not found: %s\n' "$install_sh" >&2; exit 1; }
[ -f "$fixture" ] || { printf 'fixture not found: %s\n' "$fixture" >&2; exit 1; }

if ! command -v deno >/dev/null 2>&1; then
    printf 'SKIP  install-sh-state-cli test — deno not found\n'
    exit 0
fi

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

skills_dest=$work/skills
agents_dest=$work/agents
state_dir=$work/state
mkdir -p "$skills_dest" "$agents_dest" "$state_dir"

printf '# install-sh-state-cli checks — repo=%s\n' "$repo_dir"

# --- install.sh を一時ディレクトリへ実行 ------------------------------------
out=$(sh "$install_sh" "$skills_dest" "$agents_dest" 2>&1)
rc=$?
if [ "$rc" = 0 ]; then
    ok "install.sh が exit 0 で終わる"
else
    ng "install.sh が exit 0 で終わる" "rc=$rc out=$(printf '%s' "$out" | tr '\n' '|')"
fi

symlinked_state_ts=$skills_dest/task-pipeline/scripts/state.ts

# -f はシンボリックリンクを解決した先の実体で判定するので、symlink 越しの存在確認になる。
if [ -f "$symlinked_state_ts" ]; then
    ok "symlink 越しに state.ts が存在する ($symlinked_state_ts)"
else
    ng "symlink 越しに state.ts が存在する" "not found: $symlinked_state_ts"
fi

# 実体を直接指すパスと symlink 越しのパスが同じ内容に解決されることも確認する (symlink が
# 正しく repo_dir/task-pipeline を指していることの裏取り)。
real_state_ts=$repo_dir/task-pipeline/scripts/state.ts
if [ -f "$real_state_ts" ]; then
    if cmp -s "$symlinked_state_ts" "$real_state_ts" 2>/dev/null; then
        ok "symlink 越しの state.ts がリポジトリ実体とバイト一致する"
    else
        ng "symlink 越しの state.ts がリポジトリ実体とバイト一致する" "differs"
    fi
else
    ng "リポジトリ実体の state.ts が存在する" "not found: $real_state_ts"
fi

# --- symlink 越しのパスで実際に CLI を実行し、get が動くこと ----------------
cp "$fixture" "$state_dir/state.json"

get_out=$(deno run --no-prompt \
    --allow-read="$state_dir" \
    --allow-write="$state_dir" \
    "$symlinked_state_ts" get --state-dir "$state_dir" 2>&1)
get_rc=$?

_detail=
[ "$get_rc" = 0 ] || _detail="exit=$get_rc"
case $get_out in
    *'"tracker"'*) ;;
    *) _detail="$_detail output に tracker キーが無い: $(printf '%s' "$get_out" | tr '\n' '|')" ;;
esac
if [ -z "$_detail" ]; then
    ok "symlink 越しのパスで deno run ... state.ts get --state-dir <dir> が動く (exit 0, JSON に tracker を含む)"
else
    ng "symlink 越しのパスで deno run ... state.ts get --state-dir <dir> が動く" "$_detail"
fi

# --- validate も同じ symlink 越しパスで動くことの追加確認 -------------------
validate_out=$(deno run --no-prompt \
    --allow-read="$state_dir" \
    --allow-write="$state_dir" \
    "$symlinked_state_ts" validate --state-dir "$state_dir" 2>&1)
validate_rc=$?
validate_ok=0
case $validate_out in
    *'"ok":true'*|*'"ok": true'*) validate_ok=1 ;;
esac
if [ "$validate_rc" = 0 ] && [ "$validate_ok" = 1 ]; then
    ok "symlink 越しのパスで validate も PASS する"
else
    ng "symlink 越しのパスで validate も PASS する" "rc=$validate_rc out=$(printf '%s' "$validate_out" | tr '\n' '|')"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
