#!/bin/sh
# tests/driver-start.test.sh — task-pipeline/scripts/driver-start.sh の外部挙動
# (終了コード・引数バリデーション・desired による停止・deno へ渡す argv) を検証する。
#
#   sh tests/driver-start.test.sh         # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...           # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。実 deno は一切呼ばない — DENO_BIN に
#   argv を書き出すだけのモックを渡し、exec 先の argv を観測する。
# - 判定は driver-start.sh の外部から観測できるものだけ: exit status、stdout の文字列、
#   モックが記録した argv。

set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
start_sh=$repo_dir/task-pipeline/scripts/driver-start.sh
[ -f "$start_sh" ] || { printf 'driver-start.sh not found: %s\n' "$start_sh" >&2; exit 1; }

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0
skipped=0

ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng()   { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
flat() { printf '%s' "$1" | tr '\n' '|'; }

# exec 先の argv を記録して非ゼロで抜けるモック。終了コードを 7 にしてあるのは、
# 「driver-start.sh が deno の終了コードをそのまま返す」ことを観測するためである。
deno_mock=$work/deno
cat > "$deno_mock" <<'MOCK'
#!/bin/sh
printf '%s\n' "$@" > "$DENO_ARGV_OUT"
exit 7
MOCK
chmod +x "$deno_mock"

argv_out=$work/argv.txt
export DENO_ARGV_OUT=$argv_out

state_dir=$work/.task-pipeline
mkdir -p "$state_dir" || exit 1

printf '# driver-start.sh checks — repo=%s start_sh=%s\n' "$repo_dir" "$start_sh"

# --- D1: 引数無し → exit 4 (usage) --------------------------------------------
out=$(bash "$start_sh" 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *usage:*driver-start.sh*) ;;
    *) _detail="$_detail output に usage が無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "D1 引数無しは exit 4"; else ng "D1 引数無しは exit 4" "$_detail"; fi

# --- D2: 存在しない state dir → exit 4 ----------------------------------------
out=$(bash "$start_sh" "$work/nope" 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *"state dir not found"*) ;;
    *) _detail="$_detail 理由が出ていない: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "D2 存在しない state dir は exit 4"; else ng "D2 存在しない state dir は exit 4" "$_detail"; fi

# --- D3: interval が非数値 / 0 / 負数 → exit 4 --------------------------------
# 空文字は「省略」と同じ扱い (`${2:-5}` は unset でも空でも既定値を採る。watch-agent.sh の
# `${4:-5}` と同じ) なので、ここでは不正値として数えない — D7 が既定 5 になることを見る。
_detail=
for bad in abc 0 -1 1.5 ' '; do
    bash "$start_sh" "$state_dir" "$bad" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 4 ] || _detail="$_detail interval=[$bad] で exit=$rc (want 4);"
done
if [ -z "$_detail" ]; then ok "D3 不正な interval は exit 4"; else ng "D3 不正な interval は exit 4" "$_detail"; fi

# --- D4: desired=stopped → exit 0 で deno を起動しない ------------------------
# **これが `restart: on-failure` に起こし直させないための要点である** (非ゼロで抜けると
# 停止意思があるあいだ何度でも再起動される)。
mkdir -p "$state_dir/driver" || exit 1
printf 'stopped\n' > "$state_dir/driver/desired"
rm -f "$argv_out"
out=$(DENO_BIN=$deno_mock bash "$start_sh" "$state_dir" 2>&1)
rc=$?
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ -f "$argv_out" ] && _detail="$_detail deno を起動してしまった"
case $out in
    *"DRIVER-START stopped"*) ;;
    *) _detail="$_detail 停止理由が出ていない: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "D4 desired=stopped は deno を起動せず exit 0"; else ng "D4 desired=stopped は deno を起動せず exit 0" "$_detail"; fi

# --- D5: 未知の値・空も stopped 扱い ------------------------------------------
_detail=
for value in '' '   ' 'Stopped' 'paused'; do
    printf '%s' "$value" > "$state_dir/driver/desired"
    rm -f "$argv_out"
    DENO_BIN=$deno_mock bash "$start_sh" "$state_dir" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || _detail="$_detail desired=[$value] で exit=$rc (want 0);"
    [ -f "$argv_out" ] && _detail="$_detail desired=[$value] で deno を起動した;"
done
if [ -z "$_detail" ]; then ok "D5 未知の値・空も停止側に倒れる"; else ng "D5 未知の値・空も停止側に倒れる" "$_detail"; fi

# --- D6: desired=running → deno を exec し、終了コードをそのまま返す ----------
printf ' running \n' > "$state_dir/driver/desired"
rm -f "$argv_out"
DENO_BIN=$deno_mock bash "$start_sh" "$state_dir" 3 >/dev/null 2>&1
rc=$?
_detail=
[ "$rc" = 7 ] || _detail="exit=$rc (want 7 = deno の終了コードの素通し)"
if [ -f "$argv_out" ]; then
    argv=$(tr '\n' ' ' < "$argv_out")
    case $argv in
        *"pipeline-driver.ts"*) ;;
        *) _detail="$_detail pipeline-driver.ts を渡していない: $argv" ;;
    esac
    case $argv in
        *"--state-dir "*) ;;
        *) _detail="$_detail --state-dir が無い: $argv" ;;
    esac
    case $argv in
        *"--loop true"*) ;;
        *) _detail="$_detail --loop true が無い: $argv" ;;
    esac
    case $argv in
        *"--interval-sec 3"*) ;;
        *) _detail="$_detail --interval-sec 3 が無い: $argv" ;;
    esac
    case $argv in
        *"--allow-run"*) ;;
        *) _detail="$_detail deno の権限フラグが無い: $argv" ;;
    esac
else
    _detail="$_detail deno を起動していない"
fi
if [ -z "$_detail" ]; then ok "D6 desired=running は deno を exec して終了コードを素通しする"; else ng "D6 desired=running は deno を exec して終了コードを素通しする" "$_detail"; fi

# --- D7: desired ファイルが無ければ running 扱い ------------------------------
rm -f "$state_dir/driver/desired"
rm -f "$argv_out"
DENO_BIN=$deno_mock bash "$start_sh" "$state_dir" >/dev/null 2>&1
rc=$?
_detail=
[ "$rc" = 7 ] || _detail="exit=$rc (want 7)"
[ -f "$argv_out" ] || _detail="$_detail deno を起動していない (不在を停止に倒すと一度も起動できない)"
if [ -f "$argv_out" ]; then
    argv=$(tr '\n' ' ' < "$argv_out")
    case $argv in
        *"--interval-sec 5"*) ;;
        *) _detail="$_detail interval の既定が 5 でない: $argv" ;;
    esac
fi
if [ -z "$_detail" ]; then ok "D7 desired 不在は running 扱い (interval 既定 5)"; else ng "D7 desired 不在は running 扱い (interval 既定 5)" "$_detail"; fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
