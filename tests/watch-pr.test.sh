#!/bin/sh
# tests/watch-pr.test.sh — task-pipeline/scripts/watch-pr.sh の外部挙動 (終了コード・
# stdout 形式・heartbeat・第5引数の扱い) を固定する。watch-pr.sh 自体は変更しない。
#
#   sh tests/watch-pr.test.sh          # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...        # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。実 gh は一切呼ばない — PATH の先頭に
#   tests/fixtures/mock-gh/gh を挿し、呼び出し回数に応じたフィクスチャ JSON /
#   失敗を返させる (詳細はそのファイルのコメント参照)。
# - 判定は watch-pr.sh の外部から観測できるものだけ: exit status、stdout/stderr の
#   文字列完全一致、TASK_PIPELINE_HEARTBEAT ファイルの mtime、壁時計の経過時間
#   (5 連続失敗の閾値が変異していないことを検出するための下限アサーションに使う)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
watch_sh=$repo_dir/task-pipeline/scripts/watch-pr.sh
[ -f "$watch_sh" ] || { printf 'watch-pr.sh not found: %s\n' "$watch_sh" >&2; exit 1; }

mock_gh_dir=$tests_dir/fixtures/mock-gh
[ -x "$mock_gh_dir/gh" ] || { printf 'mock gh not found or not executable: %s\n' "$mock_gh_dir/gh" >&2; exit 1; }
PATH=$mock_gh_dir:$PATH
export PATH

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pr_url='https://github.com/acme/demo/pull/42'

pass=0
fail=0
skipped=0

ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng()   { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
flat() { printf '%s' "$1" | tr '\n' '|'; }

# GraphQL レスポンス JSON (署名の材料。comments/reviews/threads はすべて空にして
# 署名を手計算できる形に揃える — sig() 参照)。$1 = headRefOid
body() {
    printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"%s","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}' "$1"
}

# body() が生成する JSON に対して watch-pr.sh の jq フィルタが計算する署名文字列。
# $1 = headRefOid
sig() {
    printf 'OPEN|%s|SUCCESS|0|0|0|-' "$1"
}

# 呼び出し順にフィクスチャを並べたディレクトリを作り、そのパスを返す。
# 引数各要素が 1 回の gh 呼び出しに対応する。中身が "FAIL" ならその呼び出しは失敗を模す。
mkresp() {
    d=$(mktemp -d "$work/resp.XXXXXX") || return 1
    i=1
    for c in "$@"; do
        printf '%s' "$c" > "$d/$i"
        i=$((i + 1))
    done
    printf '%s' "$d"
}

printf '# watch-pr.sh checks — repo=%s watch_sh=%s\n' "$repo_dir" "$watch_sh"

# --- W1: 引数無し → exit 4 (usage) ------------------------------------------
out=$(bash "$watch_sh" 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *"usage: watch-pr.sh"*) ;;
    *) _detail="$_detail usage メッセージが無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W1 引数無し → exit 4 (usage)"; else ng "W1 引数無し → exit 4 (usage)" "$_detail"; fi

# --- W2: URL 形式不正 → exit 4 ------------------------------------------------
out=$(bash "$watch_sh" 'https://example.com/not-a-pr' task1 2>&1)
rc=$?
_detail=
[ "$rc" = 4 ] || _detail="exit=$rc (want 4)"
case $out in
    *"不正な PR URL"*) ;;
    *) _detail="$_detail 不正な PR URL メッセージが無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W2 URL 形式不正 → exit 4"; else ng "W2 URL 形式不正 → exit 4" "$_detail"; fi

# --- W3: 初回フェッチ失敗 (第5引数無し・base 取得そのものが失敗) → exit 3 (ボーナス) ---
resp=$(mkresp FAIL)
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task3 1 10 2>&1)
rc=$?
_detail=
[ "$rc" = 3 ] || _detail="exit=$rc (want 3)"
case $out in
    *"PR の状態を取得できません"*) ;;
    *) _detail="$_detail エラーメッセージが無い: $(flat "$out")" ;;
esac
if [ -z "$_detail" ]; then ok "W3 初回フェッチ失敗 → exit 3 (ボーナス経路)"; else ng "W3 初回フェッチ失敗 → exit 3 (ボーナス経路)" "$_detail"; fi

# --- W4: ループ内 5 連続失敗 → exit 3。壁時計の下限で閾値の変異を検出する -------------
resp=$(mkresp FAIL FAIL FAIL FAIL FAIL)
base4=$(sig sha-base4)
t0=$(date +%s)
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task4 1 60 "$base4" 2>"$work/.w4err")
rc=$?
t1=$(date +%s)
err4=$(cat "$work/.w4err")
elapsed4=$((t1 - t0))
_detail=
[ "$rc" = 3 ] || _detail="exit=$rc (want 3)"
case $err4 in
    *"状態の取得に 5 回連続で失敗"*) ;;
    *) _detail="$_detail 5連続失敗メッセージが無い: $(flat "$err4")" ;;
esac
[ -z "$out" ] || _detail="$_detail stdout が空でない: $(flat "$out")"
[ "$elapsed4" -ge 4 ] || _detail="$_detail elapsed=${elapsed4}s (want >= 4s: 5 回の sleep 1 を経ているはず — 閾値変異の検出に使う下限)"
if [ -z "$_detail" ]; then ok "W4 ループ内 5 連続失敗 → exit 3 (elapsed=${elapsed4}s)"; else ng "W4 ループ内 5 連続失敗 → exit 3" "$_detail"; fi

# --- W5: changed (第5引数無し)、stdout の完全一致 ------------------------------
resp=$(mkresp "$(body sha-base5)" "$(body sha-new5)")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task5 1 10 2>"$work/.w5err")
rc=$?
want5="PR-WATCH task5 changed $(sig sha-base5) -> $(sig sha-new5)"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w5err")")"
[ "$out" = "$want5" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want5")]"
if [ -z "$_detail" ]; then ok "W5 changed → exit 0、stdout 完全一致 (AC4)"; else ng "W5 changed → exit 0、stdout 完全一致 (AC4)" "$_detail"; fi

# --- W6: 第5引数 (前回署名) を渡すと、待たずに changed になる (AC5) ------------------
resp=$(mkresp "$(body sha-new6)")
prevsig6=$(sig sha-old6)
t0=$(date +%s)
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task6 1 30 "$prevsig6" 2>"$work/.w6err")
rc=$?
t1=$(date +%s)
elapsed6=$((t1 - t0))
want6="PR-WATCH task6 changed $prevsig6 -> $(sig sha-new6)"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$out" = "$want6" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want6")]"
[ "$elapsed6" -lt 3 ] || _detail="$_detail elapsed=${elapsed6}s (want < 3s: max=30 を待たず 1 回目の比較で終わるはず)"
if [ -z "$_detail" ]; then ok "W6 第5引数 → 待たずに changed (elapsed=${elapsed6}s)"; else ng "W6 第5引数 → 待たずに changed" "$_detail"; fi

# --- W7: timeout、stdout の完全一致 -------------------------------------------
resp=$(mkresp "$(body sha-same7)" "$(body sha-same7)" "$(body sha-same7)")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task7 1 2 2>"$work/.w7err")
rc=$?
want7="PR-WATCH task7 timeout $(sig sha-same7)"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$out" = "$want7" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want7")]"
if [ -z "$_detail" ]; then ok "W7 timeout → exit 2、stdout 完全一致"; else ng "W7 timeout → exit 2、stdout 完全一致" "$_detail"; fi

# --- W8: TASK_PIPELINE_HEARTBEAT が touch される (AC6) -------------------------
hb_file=$work/heartbeat8
: > "$hb_file"
touch -t 202001010000 "$hb_file"
resp=$(mkresp "$(body sha-new8)")
prevsig8=$(sig sha-old8)
TASK_PIPELINE_HEARTBEAT=$hb_file GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task8 1 30 "$prevsig8" >/dev/null 2>"$work/.w8err"
rc=$?
mtime8=0
[ -f "$hb_file" ] && mtime8=$(date -r "$hb_file" +%s 2>/dev/null || printf '0')
_detail=
[ -f "$hb_file" ] || _detail="heartbeat ファイルが存在しない"
[ "$mtime8" -gt 1700000000 ] || _detail="$_detail mtime=$mtime8 (2023-11-14 相当より新しくない → touch されていない、rc=$rc)"
if [ -z "$_detail" ]; then ok "W8 TASK_PIPELINE_HEARTBEAT が touch される"; else ng "W8 TASK_PIPELINE_HEARTBEAT が touch される" "$_detail"; fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
