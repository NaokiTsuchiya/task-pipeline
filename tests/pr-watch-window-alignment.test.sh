#!/bin/sh
# tests/pr-watch-window-alignment.test.sh — task-pipeline/scripts/watch-pr.sh (署名クエリ) と
# task-pipeline/references/pr-watcher.md (観測クエリ) の reviewThreads 等のページング窓が
# 一致していることを固定する。
#
#   sh tests/pr-watch-window-alignment.test.sh   # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...                  # 失敗調査用にサンドボックスを残す
#
# 背景: 署名側 (watch-pr.sh) は reviewThreads(last:100) だが、観測側 (pr-watcher.md) が
# reviewThreads(first:100) のままドリフトしていたことがあった (pr-watch-window-alignment
# タスク)。スレッド総数が 100 を超える PR では、この2つが逆向きだと直近側スレッドの
# resolve/unresolve が署名を動かすのに観測には現れず、指摘が永久に失われる。
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。
# - 判定は両ファイルの実クエリ本文からフィールド名+取得窓のペアを構造的に抽出し、
#   比較するだけ (grep -oE。詳細は extract_windows() のコメント)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
watch_sh=$repo_dir/task-pipeline/scripts/watch-pr.sh
pr_watcher_md=$repo_dir/task-pipeline/references/pr-watcher.md
[ -f "$watch_sh" ] || { printf 'watch-pr.sh not found: %s\n' "$watch_sh" >&2; exit 1; }
[ -f "$pr_watcher_md" ] || { printf 'pr-watcher.md not found: %s\n' "$pr_watcher_md" >&2; exit 1; }

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
flat() { printf '%s' "$1" | tr '\n' '|'; }

# 実クエリ中の「フィールド名(first|last:N){」だけを抜き出す。GraphQL のフィールド選択に
# 入る直前の "{" を伴う出現に限定することで、同じ語を使う地の文 (watch-pr.sh の
# コメント中の "reviewThreads(last:100) は直近に…" 等) を拾わない — その地の文には
# "{" が続かないため。両ファイルとも実クエリはこの形で 1 回ずつしか出現しないことを
# 実装時に grep で確認済み (comments が top-level と reviewThreads 内側の 2 回、
# reviews/reviewThreads がそれぞれ 1 回で計 4 行)。
extract_windows() {
    grep -oE '(comments|reviews|reviewThreads)\((first|last):[0-9]+\)\{' "$1" | sort
}

printf '# pr-watch-window-alignment checks — watch_sh=%s pr_watcher_md=%s\n' "$watch_sh" "$pr_watcher_md"

# --- ケース A: 現状の 2 ファイルが一致していること ---------------------------------
sig_windows=$(extract_windows "$watch_sh")
obs_windows=$(extract_windows "$pr_watcher_md")

if [ -z "$sig_windows" ]; then
    ng "A0 署名側から窓を抽出できる" "抽出結果が空: $watch_sh"
else
    ok "A0 署名側から窓を抽出できる ($(flat "$sig_windows"))"
fi

if [ -z "$obs_windows" ]; then
    ng "A1 観測側から窓を抽出できる" "抽出結果が空: $pr_watcher_md"
else
    ok "A1 観測側から窓を抽出できる ($(flat "$obs_windows"))"
fi

if [ "$sig_windows" = "$obs_windows" ]; then
    ok "A2 署名側と観測側の取得窓が完全一致 (comments/reviews/reviewThreads)"
else
    ng "A2 署名側と観測側の取得窓が完全一致" "sig=$(flat "$sig_windows") obs=$(flat "$obs_windows")"
fi

case $sig_windows in
    *'reviewThreads(last:100){'*) ok "A3 署名側の reviewThreads は last:100" ;;
    *) ng "A3 署名側の reviewThreads は last:100" "got=$(flat "$sig_windows")" ;;
esac

case $obs_windows in
    *'reviewThreads(last:100){'*) ok "A4 観測側の reviewThreads は last:100" ;;
    *) ng "A4 観測側の reviewThreads は last:100" "got=$(flat "$obs_windows")" ;;
esac

# --- ケース B: 退行検知 (観測側を first:100 に戻すと不一致で検知できること) --------
# サンドボックスにコピーして 1 行だけ書き換える。実ファイルは変更しない。
regressed_md=$work/pr-watcher.regressed.md
sed 's/reviewThreads(last:100){nodes{isResolved isOutdated/reviewThreads(first:100){nodes{isResolved isOutdated/' \
    "$pr_watcher_md" > "$regressed_md"

if grep -qF 'reviewThreads(first:100){nodes{isResolved isOutdated' "$regressed_md"; then
    ok "B0 サンドボックスコピーへの回帰注入が効いている (first:100 に戻せた)"
else
    ng "B0 サンドボックスコピーへの回帰注入が効いている" "sed による置換が効いていない"
fi

regressed_windows=$(extract_windows "$regressed_md")

if [ "$sig_windows" != "$regressed_windows" ]; then
    ok "B1 観測側を first:100 に戻すと署名側との不一致を検知できる (このスイート自身の退行ガード)"
else
    ng "B1 観測側を first:100 に戻すと署名側との不一致を検知できる" "退行を入れても一致してしまった: $(flat "$regressed_windows")"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
