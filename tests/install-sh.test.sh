#!/bin/sh
# tests/install-sh.test.sh — install.sh の symlink 検査 (skills 節 / agents 節) の外部挙動を固定する。
#
#   sh tests/install-sh.test.sh        # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...        # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。
# - リンク先は必ず一時ディレクトリを引数か環境変数で渡すので ~/.claude には一切触れない。
# - 判定は install.sh の外部から観測できるものだけ: exit status、stdout/stderr の行、
#   および「触らない」と言っているエントリが実際に変わっていないこと。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
install_sh=$repo_dir/install.sh
[ -f "$install_sh" ] || { printf 'install.sh not found: %s\n' "$install_sh" >&2; exit 1; }

# 検査対象の代表 agent / skill をリポジトリの実体から取る
agent_src=
for f in "$repo_dir"/agents/*.md; do
    [ -f "$f" ] || continue
    agent_src=$f
    break
done
[ -n "$agent_src" ] || { printf 'no agents/*.md under %s\n' "$repo_dir" >&2; exit 1; }
agent_name=$(basename -- "$agent_src")

skill_name=
for d in "$repo_dir"/*/; do
    [ -f "${d}SKILL.md" ] || continue
    skill_name=$(basename -- "$d")
    break
done
[ -n "$skill_name" ] || { printf 'no skill directory under %s\n' "$repo_dir" >&2; exit 1; }

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0
skipped=0

ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng()   { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
note() { skipped=$((skipped + 1)); printf 'SKIP  %s — %s\n' "$1" "$2"; }

contains() { case $2 in *"$1"*) return 0 ;; *) return 1 ;; esac; }
flat()     { printf '%s' "$1" | tr '\n' '|'; }

# ls -ld はリンク先文字列とメタデータを見るために使う (readlink は POSIX 外)。
# shellcheck disable=SC2012
link_state() { ls -ld -- "$1" 2>/dev/null; }

# ケース 1 件分のサンドボックス (skills / agents のリンク先) を作る
mkcase() {
    case_dir=$work/$1
    skills_dest=$case_dir/skills
    agents_dest=$case_dir/agents
    mkdir -p "$skills_dest" "$agents_dest"
}

# install.sh を任意の cwd から実行する。結果は $out (stdout+stderr) と $rc。
run_at() {
    out=$(cd "$1" 2>/dev/null && sh "$install_sh" "$skills_dest" "$agents_dest" 2>&1)
    rc=$?
}

run_at_env() {
    out=$(cd "$1" 2>/dev/null && SKILLS_DIR=$skills_dest AGENTS_DIR=$agents_dest sh "$install_sh" 2>&1)
    rc=$?
}

# agents 節の判定を 1 語に畳む
agent_verdict() {
    if contains "skip: agents/$agent_name" "$out"; then printf 'skip'
    elif contains "install: agents/$agent_name" "$out"; then printf 'install'
    elif contains "/agents/$agent_name is a symlink not pointing" "$out"; then printf 'warn-symlink'
    elif contains "/agents/$agent_name exists and is not a symlink" "$out"; then printf 'warn-other'
    else printf 'none'
    fi
}

# <name> <期待 verdict> <期待 exit> <cwd>...
# 与えられた cwd すべてで同じ結果になること、および agents のエントリが変化しないことを見る。
expect_case() {
    _name=$1
    _want_v=$2
    _want_rc=$3
    shift 3
    _detail=
    _before=$(link_state "$agents_dest/$agent_name")
    for _cwd in "$@"; do
        run_at "$_cwd"
        _got_v=$(agent_verdict)
        if [ "$_got_v" != "$_want_v" ] || [ "$rc" != "$_want_rc" ]; then
            _detail="$_detail [cwd=$_cwd verdict=$_got_v exit=$rc out=$(flat "$out")]"
        fi
    done
    _after=$(link_state "$agents_dest/$agent_name")
    if [ "$_before" != "$_after" ]; then
        _detail="$_detail [entry changed: {$_before} -> {$_after}]"
    fi
    if [ -z "$_detail" ]; then
        ok "$_name (want verdict=$_want_v exit=$_want_rc)"
    else
        ng "$_name (want verdict=$_want_v exit=$_want_rc)" "$_detail"
    fi
}

printf '# install.sh symlink checks — repo=%s agent=%s skill=%s\n' "$repo_dir" "$agent_name" "$skill_name"

# --- C1: エントリ不在 → 新規作成 (絶対パスのリンクができる) -----------------
mkcase c1
run_at /
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
contains "install: agents/$agent_name -> $agent_src" "$out" || _detail="$_detail agents install 行が無い"
contains "install: $skill_name -> $repo_dir/$skill_name" "$out" || _detail="$_detail skills install 行が無い"
c1_target=$(link_state "$agents_dest/$agent_name")
case $c1_target in
    *" -> $agent_src") ;;
    *) _detail="$_detail 作られたリンク先が絶対パスの $agent_src でない: {$c1_target}" ;;
esac
[ -h "$agents_dest/$agent_name" ] || _detail="$_detail symlink が作られていない"
if [ -z "$_detail" ]; then ok "C1 エントリ不在 → install + exit 0 (絶対パス)"; else ng "C1 エントリ不在 → install + exit 0" "$_detail out=$(flat "$out")"; fi

# --- C2: 直後の再実行 → 冪等 skip (skills 節も skip) ------------------------
expect_case "C2 再実行 → 冪等 skip" skip 0 / "$repo_dir" "$case_dir"
run_at /
if contains "skip: $skill_name (already installed)" "$out"; then
    ok "C2b skills 節も skip"
else
    ng "C2b skills 節も skip" "out=$(flat "$out")"
fi

# --- C3: 同名の実ファイル → warning + exit 1 (内容不変) ---------------------
mkcase c3
printf 'do not touch me\n' > "$agents_dest/$agent_name"
c3_before=$(cat "$agents_dest/$agent_name")
expect_case "C3 同名の実ファイル → warning + exit 1" warn-other 1 /
if [ "$(cat "$agents_dest/$agent_name")" = "$c3_before" ]; then
    ok "C3b 実ファイルの内容が変わらない"
else
    ng "C3b 実ファイルの内容が変わらない" "内容が変わった"
fi

# --- C4: 同名の実ディレクトリ → warning + exit 1 ----------------------------
mkcase c4
mkdir -p "$agents_dest/$agent_name"
expect_case "C4 同名の実ディレクトリ → warning + exit 1" warn-other 1 /

# --- C5: 絶対 symlink → 他所の実在ファイル ----------------------------------
mkcase c5
ln -s "$repo_dir/README.md" "$agents_dest/$agent_name"
expect_case "C5 絶対 symlink → 他所の実在ファイル" warn-symlink 1 / "$repo_dir"

# --- C6: 絶対 symlink → 存在しない先 (dangling) -----------------------------
mkcase c6
ln -s "$case_dir/nowhere/$agent_name" "$agents_dest/$agent_name"
expect_case "C6 絶対 symlink → dangling" warn-symlink 1 / "$repo_dir"

# --- C7: 相対 symlink、リンク所在から当該ファイルに解決 (cwd 非依存で skip) --
mkcase c7
ln -s "$repo_dir" "$case_dir/repo_link"
ln -s "../repo_link/agents/$agent_name" "$agents_dest/$agent_name"
expect_case "C7 相対 symlink (リンク所在から解決) → skip + exit 0 / cwd 非依存" skip 0 / "$repo_dir" "$case_dir" "$work"

# --- C8: 相対 symlink、リンク所在から解決するが別の実在ファイル --------------
mkcase c8
mkdir -p "$case_dir/other"
printf 'other file\n' > "$case_dir/other/$agent_name"
ln -s "../other/$agent_name" "$agents_dest/$agent_name"
expect_case "C8 相対 symlink → 別の実在ファイル" warn-symlink 1 / "$repo_dir" "$case_dir"

# --- C9: 相対 symlink、リンク所在からは dangling / cwd からは当該ファイル ----
mkcase c9
ln -s "agents/$agent_name" "$agents_dest/$agent_name"
expect_case "C9 相対 symlink (リンク所在から dangling) → warning + exit 1 / cwd 非依存" warn-symlink 1 "$repo_dir" / "$case_dir"

# --- C10: 相対 symlink、どこからも解決できない ------------------------------
mkcase c10
ln -s "../nowhere/$agent_name" "$agents_dest/$agent_name"
expect_case "C10 相対 symlink (解決不能)" warn-symlink 1 / "$repo_dir"

# --- C11: リンク先パスに ' -> ' を含み、当該ファイルに解決する ---------------
mkcase c11
mkdir -p "$case_dir/a -> b"
ln -s "$repo_dir" "$case_dir/a -> b/repo"
ln -s "$case_dir/a -> b/repo/agents/$agent_name" "$agents_dest/$agent_name"
expect_case "C11 リンク先に ' -> ' を含む正しいリンク → skip + exit 0" skip 0 / "$repo_dir"

# --- C12: AGENTS_DIR / SKILLS_DIR 経由でも同じ判定 --------------------------
mkcase c12
ln -s "$repo_dir" "$case_dir/repo_link"
ln -s "../repo_link/agents/$agent_name" "$agents_dest/$agent_name"
_before=$(link_state "$agents_dest/$agent_name")
run_at_env /
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$(agent_verdict)" = skip ] || _detail="$_detail verdict=$(agent_verdict) (want skip)"
[ "$_before" = "$(link_state "$agents_dest/$agent_name")" ] || _detail="$_detail entry changed"
if [ -z "$_detail" ]; then ok "C12 環境変数経路でも skip + exit 0"; else ng "C12 環境変数経路でも skip + exit 0" "$_detail out=$(flat "$out")"; fi

# --- C13: skills 節の回帰 (他所を指す絶対 symlink) --------------------------
mkcase c13
mkdir -p "$case_dir/elsewhere"
ln -s "$case_dir/elsewhere" "$skills_dest/$skill_name"
run_at /
_detail=
[ "$rc" = 1 ] || _detail="exit=$rc (want 1)"
contains "/skills/$skill_name is a symlink not pointing" "$out" || _detail="$_detail skills の warning が無い"
[ "$(agent_verdict)" = install ] || _detail="$_detail agents verdict=$(agent_verdict) (want install)"
case $(link_state "$skills_dest/$skill_name") in
    *" -> $case_dir/elsewhere") ;;
    *) _detail="$_detail skills の symlink が書き換わった" ;;
esac
if [ -z "$_detail" ]; then ok "C13 skills 節: 他所向き絶対 symlink → warning + exit 1"; else ng "C13 skills 節: 他所向き絶対 symlink → warning + exit 1" "$_detail out=$(flat "$out")"; fi

# --- C14: 構文・移植性 ------------------------------------------------------
if sh -n "$install_sh" 2>/dev/null; then ok "C14a sh -n install.sh"; else ng "C14a sh -n install.sh" "syntax error"; fi
if command -v dash >/dev/null 2>&1; then
    if dash -n "$install_sh" 2>/dev/null; then ok "C14b dash -n install.sh"; else ng "C14b dash -n install.sh" "syntax error"; fi
else
    note "C14b dash -n install.sh" "dash が無い"
fi
if command -v shellcheck >/dev/null 2>&1; then
    sc_out=$(shellcheck -s sh "$install_sh" 2>&1)
    if [ -z "$sc_out" ]; then ok "C14c shellcheck -s sh install.sh (bash 拡張・指摘なし)"; else ng "C14c shellcheck -s sh install.sh" "$(flat "$sc_out")"; fi
else
    note "C14c shellcheck -s sh install.sh" "shellcheck が無い"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
