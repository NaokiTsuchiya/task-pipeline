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
    printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"%s","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}' "$1"
}

# body() が生成する JSON に対して watch-pr.sh の jq フィルタが計算する署名文字列。
# body() は mergeable/mergeStateStatus キーを含めないので jq は null を返し、折り畳みで
# 既定値 "MERGEABLE"/"CLEAN" になる (pr-watch-mergeable タスク)。
# $1 = headRefOid
sig() {
    printf 'OPEN|%s|SUCCESS|MERGEABLE|CLEAN|0|0|0|0|-' "$1"
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

# 呼び出し回数 (AC5)。mock gh はフィクスチャディレクトリに .call_count を書く
# (tests/fixtures/mock-gh/gh 参照)。1 周 1 GraphQL 呼び出しのままであることを確認する。
call_count() {
    cat "$1/.call_count" 2>/dev/null || printf '0'
}

# --- W9: 窓外スレッド総数の変化 (新規スレッド投稿) → changed (AC1 スレッド件数版) -----
old9='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w9","comments":{"totalCount":51,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":100,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new9='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w9","comments":{"totalCount":51,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":101,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig9old='OPEN|sha-w9|SUCCESS|MERGEABLE|CLEAN|51|0|100|0|-'
sig9new='OPEN|sha-w9|SUCCESS|MERGEABLE|CLEAN|51|0|101|0|-'
resp=$(mkresp "$old9" "$new9")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task9 1 10 2>"$work/.w9err")
rc=$?
want9="PR-WATCH task9 changed $sig9old -> $sig9new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w9err")")"
[ "$out" = "$want9" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want9")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W9 窓外スレッド総数の変化 → changed (AC1)"; else ng "W9 窓外スレッド総数の変化 → changed (AC1)" "$_detail"; fi

# --- W10: 直近スレッド (旧コードでは窓外・新コードでは窓内) の resolve → changed (AC1) --
old10='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w10","comments":{"totalCount":51,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":101,"nodes":[{"isResolved":false,"comments":{"nodes":[{"updatedAt":"2026-07-01T00:00:00Z"}]}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new10='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w10","comments":{"totalCount":51,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":101,"nodes":[{"isResolved":true,"comments":{"nodes":[{"updatedAt":"2026-07-01T00:00:00Z"}]}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig10old='OPEN|sha-w10|SUCCESS|MERGEABLE|CLEAN|51|0|101|1|2026-07-01T00:00:00Z'
sig10new='OPEN|sha-w10|SUCCESS|MERGEABLE|CLEAN|51|0|101|0|2026-07-01T00:00:00Z'
resp=$(mkresp "$old10" "$new10")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task10 1 10 2>"$work/.w10err")
rc=$?
want10="PR-WATCH task10 changed $sig10old -> $sig10new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w10err")")"
[ "$out" = "$want10" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want10")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W10 窓内スレッドの resolve → changed (AC1)"; else ng "W10 窓内スレッドの resolve → changed (AC1)" "$_detail"; fi

# --- W11: 窓内の新規コメント → changed (AC3 対照 1/3、回帰) --------------------------
old11='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w11","comments":{"totalCount":5,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new11='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w11","comments":{"totalCount":6,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig11old='OPEN|sha-w11|SUCCESS|MERGEABLE|CLEAN|5|0|0|0|-'
sig11new='OPEN|sha-w11|SUCCESS|MERGEABLE|CLEAN|6|0|0|0|-'
resp=$(mkresp "$old11" "$new11")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task11 1 10 2>"$work/.w11err")
rc=$?
want11="PR-WATCH task11 changed $sig11old -> $sig11new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w11err")")"
[ "$out" = "$want11" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want11")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W11 窓内の新規コメント → changed (AC3 対照)"; else ng "W11 窓内の新規コメント → changed (AC3 対照)" "$_detail"; fi

# --- W12: 既存スレッドへの返信 (窓内) → changed (AC3 対照 2/3、回帰) -------------------
old12='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w12","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":1,"nodes":[{"isResolved":false,"comments":{"nodes":[{"updatedAt":"2026-02-01T00:00:00Z"}]}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new12='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w12","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":1,"nodes":[{"isResolved":false,"comments":{"nodes":[{"updatedAt":"2026-02-01T00:00:00Z"},{"updatedAt":"2026-02-02T00:00:00Z"}]}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig12old='OPEN|sha-w12|SUCCESS|MERGEABLE|CLEAN|0|0|1|1|2026-02-01T00:00:00Z'
sig12new='OPEN|sha-w12|SUCCESS|MERGEABLE|CLEAN|0|0|1|1|2026-02-02T00:00:00Z'
resp=$(mkresp "$old12" "$new12")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task12 1 10 2>"$work/.w12err")
rc=$?
want12="PR-WATCH task12 changed $sig12old -> $sig12new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w12err")")"
[ "$out" = "$want12" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want12")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W12 既存スレッドへの返信 (窓内) → changed (AC3 対照)"; else ng "W12 既存スレッドへの返信 (窓内) → changed (AC3 対照)" "$_detail"; fi

# --- W13: 窓内コメントの本文編集 (件数不変・updatedAt だけ変化) → changed (AC3 対照 3/3) --
old13='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w13","comments":{"totalCount":3,"nodes":[{"updatedAt":"2026-03-01T00:00:00Z"}]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new13='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w13","comments":{"totalCount":3,"nodes":[{"updatedAt":"2026-03-05T00:00:00Z"}]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig13old='OPEN|sha-w13|SUCCESS|MERGEABLE|CLEAN|3|0|0|0|2026-03-01T00:00:00Z'
sig13new='OPEN|sha-w13|SUCCESS|MERGEABLE|CLEAN|3|0|0|0|2026-03-05T00:00:00Z'
resp=$(mkresp "$old13" "$new13")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task13 1 10 2>"$work/.w13err")
rc=$?
want13="PR-WATCH task13 changed $sig13old -> $sig13new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w13err")")"
[ "$out" = "$want13" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want13")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W13 窓内コメントの本文編集 → changed (AC3 対照)"; else ng "W13 窓内コメントの本文編集 → changed (AC3 対照)" "$_detail"; fi

# --- W14: 変化無し + 同一入力の決定性 (AC4)。totalCount 追加後も毎回一致することを固定する -
body14='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w14","comments":{"totalCount":7,"nodes":[{"updatedAt":"2026-01-01T00:00:00Z"}]},"reviews":{"totalCount":2,"nodes":[{"updatedAt":"2026-01-02T00:00:00Z"}]},"reviewThreads":{"totalCount":3,"nodes":[{"isResolved":true,"comments":{"nodes":[{"updatedAt":"2026-01-03T00:00:00Z"}]}},{"isResolved":false,"comments":{"nodes":[{"updatedAt":"2026-01-01T00:00:00Z"}]}}]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig14='OPEN|sha-w14|SUCCESS|MERGEABLE|CLEAN|7|2|3|1|2026-01-03T00:00:00Z'
resp=$(mkresp "$body14" "$body14" "$body14")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task14 1 2 2>"$work/.w14err")
rc=$?
want14="PR-WATCH task14 timeout $sig14"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2) err=$(flat "$(cat "$work/.w14err")")"
[ "$out" = "$want14" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want14")]"
[ "$(call_count "$resp")" = 3 ] || _detail="$_detail call_count=$(call_count "$resp") (want 3)"
if [ -z "$_detail" ]; then ok "W14 変化無し・同一入力の決定性 → timeout (AC4)"; else ng "W14 変化無し・同一入力の決定性 → timeout (AC4)" "$_detail"; fi

# --- W15: mergeable が CONFLICTING と MERGEABLE で signature が異なる (要求 AC2) --------
# headRefOid は両方固定 (基点が進んで衝突しても PR 自身の head は動かない、という背景の状況を
# 模す)。mergeStateStatus は両方 CLEAN に固定し、mergeable 単独の効果だけを切り分ける。
old15='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w15","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new15='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w15","mergeable":"CONFLICTING","mergeStateStatus":"CLEAN","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig15old='OPEN|sha-w15|SUCCESS|MERGEABLE|CLEAN|0|0|0|0|-'
sig15new='OPEN|sha-w15|SUCCESS|CONFLICTING|CLEAN|0|0|0|0|-'
resp=$(mkresp "$old15" "$new15")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task15 1 10 2>"$work/.w15err")
rc=$?
want15="PR-WATCH task15 changed $sig15old -> $sig15new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w15err")")"
[ "$out" = "$want15" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want15")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W15 mergeable CONFLICTING/MERGEABLE → changed (AC2)"; else ng "W15 mergeable CONFLICTING/MERGEABLE → changed (AC2)" "$_detail"; fi

# --- W16: mergeStateStatus が BEHIND と CLEAN で signature が異なる (要求 AC3) -----------
old16='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w16","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
new16='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w16","mergeable":"MERGEABLE","mergeStateStatus":"BEHIND","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig16old='OPEN|sha-w16|SUCCESS|MERGEABLE|CLEAN|0|0|0|0|-'
sig16new='OPEN|sha-w16|SUCCESS|MERGEABLE|BEHIND|0|0|0|0|-'
resp=$(mkresp "$old16" "$new16")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task16 1 10 2>"$work/.w16err")
rc=$?
want16="PR-WATCH task16 changed $sig16old -> $sig16new"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$(cat "$work/.w16err")")"
[ "$out" = "$want16" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want16")]"
[ "$(call_count "$resp")" = 2 ] || _detail="$_detail call_count=$(call_count "$resp") (want 2)"
if [ -z "$_detail" ]; then ok "W16 mergeStateStatus BEHIND/CLEAN → changed (AC3)"; else ng "W16 mergeStateStatus BEHIND/CLEAN → changed (AC3)" "$_detail"; fi

# --- W17: push 直後を模した UNKNOWN への一過性の遷移で signature が変わらない (要求 AC4) ---
# headRefOid は固定 (push 自体による head 変化は W5/W6 が別途カバーしており、ここでは
# mergeable/mergeStateStatus 単独の折り畳みだけを切り分ける)。base (call 1) は確定済みの
# MERGEABLE/CLEAN、以降 2 回の取得 (W7/W14 と同じ max=2 interval=1 の 3 回フェッチパターン) は
# 両方 UNKNOWN/UNKNOWN を返す。折り畳みにより base と同じ signature のまま timeout するはず —
# UNKNOWN が別の値として現れて余計な `changed` を誘発しないことの直接証拠になる。
known17='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w17","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
transient17='{"data":{"repository":{"pullRequest":{"state":"OPEN","headRefOid":"sha-w17","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","comments":{"totalCount":0,"nodes":[]},"reviews":{"totalCount":0,"nodes":[]},"reviewThreads":{"totalCount":0,"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}}}}}'
sig17='OPEN|sha-w17|SUCCESS|MERGEABLE|CLEAN|0|0|0|0|-'
resp=$(mkresp "$known17" "$transient17" "$transient17")
out=$(GH_MOCK_RESPONSES=$resp bash "$watch_sh" "$pr_url" task17 1 2 2>"$work/.w17err")
rc=$?
want17="PR-WATCH task17 timeout $sig17"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2) err=$(flat "$(cat "$work/.w17err")")"
[ "$out" = "$want17" ] || _detail="$_detail got=[$(flat "$out")] want=[$(flat "$want17")]"
[ "$(call_count "$resp")" = 3 ] || _detail="$_detail call_count=$(call_count "$resp") (want 3)"
if [ -z "$_detail" ]; then ok "W17 UNKNOWN への一過性の遷移 → signature 不変 (AC4)"; else ng "W17 UNKNOWN への一過性の遷移 → signature 不変 (AC4)" "$_detail"; fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
