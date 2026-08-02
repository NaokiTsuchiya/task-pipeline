#!/bin/sh
# scripts/sync-readme-skills.sh — README.md の「## skills 一覧」表を、
#                                  SKILL.md を持つトップレベルディレクトリから機械生成する。
#
# 使い方:
#   sh scripts/sync-readme-skills.sh [--check] [<repo-root>]
#     (引数なし)   生成モード: README.md の一覧表を再生成して書き込む
#     --check      チェックモード: 生成結果と現 README を比較。ずれていれば diff を出して非 0
#     <repo-root>  対象リポジトリルート。省略時はこのスクリプトの親の親を解決する
#
# 対応する入力 (これで閉じている。詳細は .task-pipeline/tasks/readme-list-sync.md):
#   - skill ディレクトリの見分け方は install.sh と同じ (直下に SKILL.md を持つトップレベルディレクトリ)。
#   - 表の各行の説明文は、その skill の frontmatter description の冒頭 1 文 (最初の
#     「。」まで。無ければ値の全体)。値は引用符なしのプレーンスカラーを前提とし、
#     引用符は剥がさない。値に "|" を含む場合は "\|" にエスケープする。
#   - README は「## skills 一覧」見出しと、その直下の節内に既存の表があることを前提とする。
#     見出しが無い、または節内に表が無いときは書き換えずに非 0 終了する (挿入はしない)。
#   - コマンドラインオプションは生成モードとチェックモードの切り替えのみ (-h/--help は無い)。
#
# 終了コード:
#   0  生成完了 (書き換えあり/なし問わず) / チェックで一致
#   1  チェックでずれを検出 (stdout に diff。README は変更しない)
#   2  エラー (root や README.md が無い、見出しが無い、節内に表が無い、skill ディレクトリが 0 件)
#
# 依存ゼロの POSIX sh。使う外部コマンドは awk / basename / cat / diff / dirname / mv / rm / sed のみ
# (すべて POSIX 標準ユーティリティ)。
set -u
export LC_ALL=C

heading='## skills 一覧'

# --- 引数解釈 ---------------------------------------------------------
mode=generate
if [ "${1:-}" = "--check" ]; then
    mode=check
    shift
fi

if [ -n "${1:-}" ]; then
    root=$1
else
    root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 2
fi

[ -d "$root" ] || { printf 'error: not a directory: %s\n' "$root" >&2; exit 2; }
root=$(CDPATH='' cd -- "$root" && pwd -P) || exit 2

readme="$root/README.md"
[ -f "$readme" ] || { printf 'error: README.md not found: %s\n' "$readme" >&2; exit 2; }

tmp="$readme.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT HUP TERM

# --- skill 列挙 ---------------------------------------------------------
# install.sh:28-29 と同じ判定 (トップレベル */ glob + 直下 SKILL.md の存在)。
found=0
for d in "$root"/*/; do
    [ -f "${d}SKILL.md" ] || continue
    found=1
    break
done
if [ "$found" -eq 0 ]; then
    printf 'error: no skill directories (containing SKILL.md) found under %s\n' "$root" >&2
    exit 2
fi

# --- 表の生成 -------------------------------------------------------------
new_table="$readme.newtable.$$"
trap 'rm -f "$tmp" "$new_table"' EXIT INT HUP TERM

{
    printf '| skill | 内容 |\n'
    printf '|---|---|\n'
    for d in "$root"/*/; do
        [ -f "${d}SKILL.md" ] || continue
        name=$(basename -- "$d")
        desc=$(awk '
            /^description:/ {
                sub(/^description:[ \t]*/, "")
                val = $0
                sep = "。"
                seplen = length(sep)
                idx = index(val, sep)
                if (idx > 0) val = substr(val, 1, idx + seplen - 1)
                gsub(/\|/, "\\|", val)
                # 前後の空白 (行末の \r 等は対象外。research 2 節: LF/UTF-8 のみの前提)
                sub(/^[ \t]+/, "", val)
                sub(/[ \t]+$/, "", val)
                print val
                exit
            }
        ' "${d}SKILL.md")
        printf '| [%s](%s/SKILL.md) | %s |\n' "$name" "$name" "$desc"
    done
} > "$new_table"

# --- README 内の既存表を特定 (awk 1 本、行番号を返す) -----------------------
loc=$(awk -v heading="$heading" '
    { lines[NR] = $0 }
    END {
        total = NR
        h = 0
        for (i = 1; i <= total; i++) {
            if (lines[i] == heading) { h = i; break }
        }
        if (h == 0) { print "ERR_NOHEAD"; exit }

        n = total + 1
        for (i = h + 1; i <= total; i++) {
            if (lines[i] ~ /^#+ /) { n = i; break }
        }

        s = 0; e = 0
        for (i = h + 1; i <= n - 1; i++) {
            if (lines[i] ~ /^\|/) {
                if (s == 0) s = i
                e = i
            } else if (s != 0) {
                break
            }
        }
        if (s == 0) { print "ERR_NOTABLE"; exit }

        print s, e
    }
' "$readme")

case $loc in
    ERR_NOHEAD)
        printf 'error: heading not found: %s (%s)\n' "$heading" "$readme" >&2
        exit 2
        ;;
    ERR_NOTABLE)
        printf 'error: no table found in section: %s (%s)\n' "$heading" "$readme" >&2
        exit 2
        ;;
esac
s=${loc%% *}
e=${loc##* }

# --- 差し替え -----------------------------------------------------------
{
    sed -n "1,$((s - 1))p" "$readme"
    cat "$new_table"
    sed -n "$((e + 1)),\$p" "$readme"
} > "$tmp"

# --- モード分岐 -----------------------------------------------------------
if diff -q "$readme" "$tmp" >/dev/null 2>&1; then
    printf 'up to date: %s\n' "$readme"
    exit 0
fi

if [ "$mode" = check ]; then
    diff -u "$readme" "$tmp"
    exit 1
fi

mv "$tmp" "$readme"
printf 'updated: %s\n' "$readme"
exit 0
