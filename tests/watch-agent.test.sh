#!/bin/sh
# tests/watch-agent.test.sh — task-pipeline/scripts/watch-agent.sh の外部挙動 (終了コード・
# stdout 形式・heartbeat・引数バリデーション・状態遷移) を検証する。
#
#   sh tests/watch-agent.test.sh          # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...           # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。実 paseo は一切呼ばない — PATH の先頭に
#   tests/fixtures/mock-paseo/paseo を挿し、呼び出しに応じたフィクスチャ JSON を返させる。
# - 判定は watch-agent.sh の外部から観測できるものだけ: exit status、stdout/stderr の
#   文字列完全一致、TASK_PIPELINE_HEARTBEAT ファイルの mtime。

set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
watch_sh=$repo_dir/task-pipeline/scripts/watch-agent.sh
[ -f "$watch_sh" ] || { printf 'watch-agent.sh not found: %s\n' "$watch_sh" >&2; exit 1; }

mock_paseo_dir=$tests_dir/fixtures/mock-paseo
[ -x "$mock_paseo_dir/paseo" ] || { printf 'mock paseo not found or not executable: %s\n' "$mock_paseo_dir/paseo" >&2; exit 1; }
PATH=$mock_paseo_dir:$PATH
export PATH

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0
skipped=0

ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng()   { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
flat() { printf '%s' "$1" | tr '\n' '|'; }

body() {
    printf '{"id":"%s","status":"%s"}' "$1" "$2"
}

mkresp() {
    dir=$(mktemp -d "$work/resp.XXXXXX") || exit 1
    idx=1
    for content in "$@"; do
        printf '%s\n' "$content" > "$dir/$idx"
        idx=$((idx + 1))
    done
    printf '%s\n' "$dir"
}

printf '# watch-agent.sh checks — repo=%s watch_sh=%s\n' "$repo_dir" "$watch_sh"

# --- W1: 引数無し → exit 4 (usage) --------------------------------------------
out=$(bash "$watch_sh" 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *usage:*watch-agent.sh*) ;;
    *) _detail="$_detail output に usage が無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W1 引数無し → exit 4 (usage)"; else ng "W1 引数無し → exit 4 (usage)" "$_detail"; fi

# --- W2: 第1引数のみ → exit 4 --------------------------------------------------
out=$(bash "$watch_sh" agent-w2 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *usage:*watch-agent.sh*) ;;
    *) _detail="$_detail output に usage が無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W2 第1引数のみ → exit 4"; else ng "W2 第1引数のみ → exit 4" "$_detail"; fi

# --- W3: timeout 非数値 → exit 4 ----------------------------------------------
out=$(bash "$watch_sh" agent-w3 abc 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *positive\ integer*) ;;
    *) _detail="$_detail output に正の整数警告が無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W3 timeout 非数値 → exit 4"; else ng "W3 timeout 非数値 → exit 4" "$_detail"; fi

# --- W4: running -> idle 正常停止 → exit 0 ------------------------------------
resp=$(mkresp "$(body agent-w4 running)" "$(body agent-w4 idle)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w4 10 running 1 2>"$work/.w4err")
rc=$?
want4="AGENT-WATCH agent-w4 stopped idle"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w4err")")"
[ "$out" = "$want4" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want4")]"
if [ -z "$_detail" ]; then ok "W4 running -> idle 正常停止 → exit 0"; else ng "W4 running -> idle 正常停止 → exit 0" "$_detail"; fi

# --- W5: 初回から idle (即時停止) → exit 0 -------------------------------------
resp=$(mkresp "$(body agent-w5 idle)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w5 10 running 1 2>"$work/.w5err")
rc=$?
want5="AGENT-WATCH agent-w5 stopped idle"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want5" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want5")]"
if [ -z "$_detail" ]; then ok "W5 初回から idle (即時停止) → exit 0"; else ng "W5 初回から idle (即時停止) → exit 0" "$_detail"; fi

# --- W6: running -> closed 外部クローズ → exit 0 ------------------------------
resp=$(mkresp "$(body agent-w6 running)" "$(body agent-w6 closed)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w6 10 running 1 2>"$work/.w6err")
rc=$?
want6="AGENT-WATCH agent-w6 stopped closed"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want6" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want6")]"
if [ -z "$_detail" ]; then ok "W6 running -> closed 外部クローズ → exit 0"; else ng "W6 running -> closed 外部クローズ → exit 0" "$_detail"; fi

# --- W7: running -> errored 異常終了 → exit 0 ----------------------------------
resp=$(mkresp "$(body agent-w7 running)" "$(body agent-w7 errored)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w7 10 running 1 2>"$work/.w7err")
rc=$?
want7="AGENT-WATCH agent-w7 stopped errored"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want7" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want7")]"
if [ -z "$_detail" ]; then ok "W7 running -> errored 異常終了 → exit 0"; else ng "W7 running -> errored 異常終了 → exit 0" "$_detail"; fi

# --- W8: running -> permission 承認待ち停止 → exit 0 ---------------------------
resp=$(mkresp "$(body agent-w8 running)" "$(body agent-w8 permission)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w8 10 running 1 2>"$work/.w8err")
rc=$?
want8="AGENT-WATCH agent-w8 stopped permission"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want8" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want8")]"
if [ -z "$_detail" ]; then ok "W8 running -> permission 承認待ち停止 → exit 0"; else ng "W8 running -> permission 承認待ち停止 → exit 0" "$_detail"; fi

# --- W9: running -> archived アーカイブ停止 → exit 0 ---------------------------
resp=$(mkresp "$(body agent-w9 running)" "$(body agent-w9 archived)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w9 10 running 1 2>"$work/.w9err")
rc=$?
want9="AGENT-WATCH agent-w9 stopped archived"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want9" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want9")]"
if [ -z "$_detail" ]; then ok "W9 running -> archived アーカイブ停止 → exit 0"; else ng "W9 running -> archived アーカイブ停止 → exit 0" "$_detail"; fi

# --- W10: running -> busy / starting (非停止稼働継続) → timeout exit 2 ---------
resp=$(mkresp "$(body agent-w10 running)" "$(body agent-w10 starting)" "$(body agent-w10 busy)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w10 3 running 1 2>"$work/.w10err")
rc=$?
want10="AGENT-WATCH agent-w10 timeout busy"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$out" = "$want10" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want10")]"
if [ -z "$_detail" ]; then ok "W10 running -> busy/starting 非停止稼働継続 → timeout exit 2"; else ng "W10 running -> busy/starting 非停止稼働継続 → timeout exit 2" "$_detail"; fi

# --- W11: 変化無し timeout → exit 2 -------------------------------------------
resp=$(mkresp "$(body agent-w11 running)" "$(body agent-w11 running)" "$(body agent-w11 running)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w11 2 running 1 2>"$work/.w11err")
rc=$?
want11="AGENT-WATCH agent-w11 timeout running"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$out" = "$want11" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want11")]"
if [ -z "$_detail" ]; then ok "W11 変化無し timeout → exit 2"; else ng "W11 変化無し timeout → exit 2" "$_detail"; fi

# --- W12: ループ内 5 連続失敗 → exit 3 -----------------------------------------
resp=$(mkresp FAIL FAIL FAIL FAIL FAIL)
t0=$(date +%s)
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w12 60 running 1 2>"$work/.w12err")
rc=$?
t1=$(date +%s)
elapsed12=$((t1 - t0))
err12=$(cat "$work/.w12err")
_detail=
[ "$rc" = 3 ] || _detail="exit=$rc (want 3)"
case $err12 in
    *AGENT-WATCH*agent-w12*error*failed*) ;;
    *) _detail="$_detail stderr に期待エラーが無い: $(flat "$err12")" ;;
esac
[ "$elapsed12" -ge 4 ] || _detail="$_detail elapsed=${elapsed12}s (want >= 4s: 5 回の sleep 1 を経ているはず)"
if [ -z "$_detail" ]; then ok "W12 ループ内 5 連続失敗 → exit 3 (elapsed=${elapsed12}s)"; else ng "W12 ループ内 5 連続失敗 → exit 3" "$_detail"; fi

# --- W13: 途中一時失敗 (1〜2回) 後に復旧 → exit 0 --------------------------------
resp=$(mkresp FAIL FAIL "$(body agent-w13 running)" "$(body agent-w13 idle)")
out=$(PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w13 10 running 1 2>"$work/.w13err")
rc=$?
want13="AGENT-WATCH agent-w13 stopped idle"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want13" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want13")]"
if [ -z "$_detail" ]; then ok "W13 途中一時失敗後に復旧 → exit 0"; else ng "W13 途中一時失敗後に復旧 → exit 0" "$_detail"; fi

# --- W14: TASK_PIPELINE_HEARTBEAT が touch される ------------------------------
hb_file=$work/heartbeat14
: > "$hb_file"
touch -t 202001010000 "$hb_file"
resp=$(mkresp "$(body agent-w14 running)" "$(body agent-w14 idle)")
TASK_PIPELINE_HEARTBEAT=$hb_file PASEO_MOCK_RESPONSES=$resp bash "$watch_sh" agent-w14 10 running 1 >/dev/null 2>"$work/.w14err"
rc=$?
mtime14=0
[ -f "$hb_file" ] && mtime14=$(date -r "$hb_file" +%s 2>/dev/null || printf '0')
_detail=
[ -f "$hb_file" ] || _detail="heartbeat ファイルが存在しない"
[ "$mtime14" -gt 1700000000 ] || _detail="$_detail mtime=$mtime14 (2023-11-14 相当より新しくない → touch されていない, rc=$rc)"
if [ -z "$_detail" ]; then ok "W14 TASK_PIPELINE_HEARTBEAT が touch される"; else ng "W14 TASK_PIPELINE_HEARTBEAT が touch される" "$_detail"; fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
