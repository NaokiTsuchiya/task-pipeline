#!/bin/sh
# tests/sync-readme-skills.test.sh — scripts/sync-readme-skills.sh の外部挙動を固定する。
#
#   sh tests/sync-readme-skills.test.sh        # 全ケース PASS なら exit 0
#   TEST_SH=/bin/dash sh tests/...             # 起動シェルを切り替えて回す
#   KEEP_SANDBOX=1 sh tests/...                # 失敗調査用にサンドボックスを残す
#
# - 依存ゼロ・ネットワーク不要。tests/install-sh.test.sh と同じスタイル。
# - 判定は sync-readme-skills.sh の外部から観測できるものだけ: exit status、
#   stdout/stderr の行、README.md の中身 (バイト列レベル)。
# - 実 README.md に書き込むのは C9 (既定 root 解決) の直前提として実施済みの
#   生成結果を読むケース 1 つだけで、書き込みはしない (--check のみ)。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
sync_sh=$repo_dir/scripts/sync-readme-skills.sh
[ -f "$sync_sh" ] || { printf 'sync-readme-skills.sh not found: %s\n' "$sync_sh" >&2; exit 1; }

TEST_SH=${TEST_SH:-sh}

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

# sync-readme-skills.sh を実行する。結果は $out (stdout+stderr 分離不要のため個別に取る) と $rc。
run_sync() {
    out=$("$TEST_SH" "$sync_sh" "$@" 2>"$work/.stderr")
    rc=$?
    err=$(cat "$work/.stderr")
}

# バイト列同一判定 (見た目でなく実バイトで比較する)
same_bytes() { [ "$(od -An -tx1 -- "$1")" = "$(od -An -tx1 -- "$2")" ]; }

# 説明セルを 1 行 (grep 一致行) から取り出す。`| [name](name/SKILL.md) | <desc> |`
extract_desc() {
    # $1 = 行, $2 = dir 名
    printf '%s\n' "$1" | sed "s/^| \\[$2\\]($2\\/SKILL\\.md) | //; s/ |\$//"
}

printf '# sync-readme-skills.sh checks — repo=%s TEST_SH=%s\n' "$repo_dir" "$TEST_SH"

# ============================================================================
# A/B グループ: 共有フィクスチャでディレクトリ集合と description 抽出をまとめて確認
# ============================================================================
ab_dir=$work/ab
mkdir -p "$ab_dir"

# A7: 作成順を名前順とわざとずらす (d, c, b, a の順で mkdir)
mkdir -p "$ab_dir/skill-d" "$ab_dir/skill-c" "$ab_dir/skill-b" "$ab_dir/skill-a"
# A2: SKILL.md を持たないディレクトリ
mkdir -p "$ab_dir/backlog"
# A3: ネストした位置にだけ SKILL.md
mkdir -p "$ab_dir/nested/sub"
printf -- '---\nname: nested\ndescription: ネストしたSKILL。\n---\n' > "$ab_dir/nested/sub/SKILL.md"
# A4: ドットディレクトリ
mkdir -p "$ab_dir/.hidden"
printf -- '---\nname: hidden\ndescription: 隠しディレクトリ。\n---\n' > "$ab_dir/.hidden/SKILL.md"

# B1: 複数文
printf -- '---\nname: skill-a\ndescription: 説明その1。二文目は出ない。\n---\n' > "$ab_dir/skill-a/SKILL.md"
# B2: 単文のみ
printf -- '---\nname: skill-b\ndescription: 説明その2。\n---\n' > "$ab_dir/skill-b/SKILL.md"
# B3: 終端記号なし (ASCII 英文)
printf -- '---\nname: skill-c\ndescription: No terminator here\n---\n' > "$ab_dir/skill-c/SKILL.md"
# B4: 値に | を含む
printf -- '---\nname: skill-d\ndescription: パイプ | を含む説明。\n---\n' > "$ab_dir/skill-d/SKILL.md"

cat > "$ab_dir/README.md" <<'EOF'
# repo

intro

## skills 一覧

| skill | 内容 |
|---|---|
| [old](old/SKILL.md) | old desc |

## next section

more text
EOF

run_sync "$ab_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) err=$(flat "$err")"
contains 'updated:' "$out" || _detail="$_detail 'updated:' が出ていない out=$(flat "$out")"
if [ -z "$_detail" ]; then ok "A/B 前提: 生成モードが exit 0 で updated"; else ng "A/B 前提: 生成モードが exit 0 で updated" "$_detail"; fi

table_block=$(sed -n '/^## skills 一覧$/,/^## /p' "$ab_dir/README.md")

# A1: 直下に SKILL.md を持つディレクトリは行になる
if contains '[skill-a](skill-a/SKILL.md)' "$table_block"; then
    ok "A1 直下に SKILL.md を持つディレクトリが行になる"
else
    ng "A1 直下に SKILL.md を持つディレクトリが行になる" "table=$(flat "$table_block")"
fi

# A2: SKILL.md を持たないディレクトリは行にならない
if contains 'backlog' "$table_block"; then
    ng "A2 SKILL.md の無いディレクトリは行にならない" "backlog が表に出ている: $(flat "$table_block")"
else
    ok "A2 SKILL.md の無いディレクトリは行にならない"
fi

# A3: ネストした位置にだけ SKILL.md があるディレクトリは行にならない
if contains 'nested' "$table_block"; then
    ng "A3 ネストした SKILL.md は対象外" "nested が表に出ている: $(flat "$table_block")"
else
    ok "A3 ネストした SKILL.md は対象外"
fi

# A4: ドットディレクトリは行にならない
if contains 'hidden' "$table_block"; then
    ng "A4 ドットディレクトリは対象外" ".hidden が表に出ている: $(flat "$table_block")"
else
    ok "A4 ドットディレクトリは対象外"
fi

# A7: 名前昇順に並ぶ (作成順は d,c,b,a だった)
order=$(printf '%s\n' "$table_block" | grep -o '\[skill-[a-d]\]' | tr -d '[]' | tr '\n' ',')
if [ "$order" = "skill-a,skill-b,skill-c,skill-d," ]; then
    ok "A7 作成順に依存せず名前昇順に並ぶ"
else
    ng "A7 作成順に依存せず名前昇順に並ぶ" "order=$order"
fi

# B1: 複数文 → 最初の「。」まで、バイト完全一致
b1_line=$(grep -n '^| \[skill-a\]' "$ab_dir/README.md" | head -1 | cut -d: -f2-)
b1_desc=$(extract_desc "$b1_line" skill-a)
b1_want='説明その1。'
# 見た目の一致だけでなく、od -c 相当 (16進バイト列) でも突き合わせる (プロセス置換は
# POSIX/dash に無いので一時ファイル経由で比較する — same_bytes 参照)。
printf '%s' "$b1_desc" > "$work/.b1_got"
printf '%s' "$b1_want" > "$work/.b1_want"
if [ "$b1_desc" = "$b1_want" ] && same_bytes "$work/.b1_got" "$work/.b1_want"; then
    ok "B1 複数文 → 最初の「。」まで (バイト一致)"
else
    ng "B1 複数文 → 最初の「。」まで (バイト一致)" "got=[$b1_desc] want=[$b1_want] got_hex=$(od -An -tx1 -- "$work/.b1_got" | tr -s ' \n' ' ')"
fi

# B2: 単文のみ → 全体、バイト完全一致
b2_line=$(grep -n '^| \[skill-b\]' "$ab_dir/README.md" | head -1 | cut -d: -f2-)
b2_desc=$(extract_desc "$b2_line" skill-b)
b2_want='説明その2。'
if [ "$b2_desc" = "$b2_want" ]; then
    ok "B2 単文のみ → 全体 (「。」込み)"
else
    ng "B2 単文のみ → 全体 (「。」込み)" "got=[$b2_desc] want=[$b2_want] got_hex=$(printf '%s' "$b2_desc" | od -An -tx1 | tr -s ' \n' ' ')"
fi

# B3: 「。」が無い (ASCII 英文) → 値の全体
b3_line=$(grep -n '^| \[skill-c\]' "$ab_dir/README.md" | head -1 | cut -d: -f2-)
b3_desc=$(extract_desc "$b3_line" skill-c)
if [ "$b3_desc" = 'No terminator here' ]; then
    ok "B3 「。」が無い → 値の全体 (ASCII ピリオドで誤って切らない)"
else
    ng "B3 「。」が無い → 値の全体" "got=[$b3_desc]"
fi

# B4: 値に | を含む → \| にエスケープ
b4_line=$(grep -n '^| \[skill-d\]' "$ab_dir/README.md" | head -1 | cut -d: -f2-)
b4_desc=$(extract_desc "$b4_line" skill-d)
if [ "$b4_desc" = 'パイプ \| を含む説明。' ]; then
    ok "B4 値の | が \\| にエスケープされる"
else
    ng "B4 値の | が \\| にエスケープされる" "got=[$b4_desc]"
fi

# A5: 新規ディレクトリを追加して再実行すると行が増える
mkdir -p "$ab_dir/skill-e"
printf -- '---\nname: skill-e\ndescription: 新規skill。\n---\n' > "$ab_dir/skill-e/SKILL.md"
run_sync "$ab_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
grep -q '^| \[skill-e\](skill-e/SKILL.md) |' "$ab_dir/README.md" || _detail="$_detail skill-e の行が無い"
if [ -z "$_detail" ]; then ok "A5 新規ディレクトリ追加 → スクリプト無編集で行が増える"; else ng "A5 新規ディレクトリ追加 → スクリプト無編集で行が増える" "$_detail"; fi

# C10 (この共有フィクスチャで): 表以外の全行が生成前後で一致する
before_nontable=$(grep -v '^|' <<'EOF'
# repo

intro

## skills 一覧

| skill | 内容 |
|---|---|
| [old](old/SKILL.md) | old desc |

## next section

more text
EOF
)
after_nontable=$(grep -v '^|' "$ab_dir/README.md")
if [ "$before_nontable" = "$after_nontable" ]; then
    ok "C10 生成前後で表以外の全行が一致する (AC5)"
else
    ng "C10 生成前後で表以外の全行が一致する (AC5)" "before=$(flat "$before_nontable") after=$(flat "$after_nontable")"
fi

# ============================================================================
# A6: skill ディレクトリ 0 件 → exit 2、README 不変
# ============================================================================
a6_dir=$work/a6
mkdir -p "$a6_dir/backlog"
cat > "$a6_dir/README.md" <<'EOF'
# repo

## skills 一覧

| skill | 内容 |
|---|---|
EOF
a6_before=$(cat "$a6_dir/README.md")
run_sync "$a6_dir"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$(cat "$a6_dir/README.md")" = "$a6_before" ] || _detail="$_detail README が変わった"
if [ -z "$_detail" ]; then ok "A6 skill ディレクトリ 0 件 → exit 2、README 不変"; else ng "A6 skill ディレクトリ 0 件 → exit 2、README 不変" "$_detail out=$(flat "$out") err=$(flat "$err")"; fi

# ============================================================================
# C グループ: モードと終了コード
# ============================================================================
mk_c_base() {
    d=$1
    mkdir -p "$d/skill-a"
    printf -- '---\nname: skill-a\ndescription: 説明です。\n---\n' > "$d/skill-a/SKILL.md"
}

# C1/C2: 生成モード (ずれ → updated、直後の再実行 → 冪等)
c1_dir=$work/c1
mkdir -p "$c1_dir"; mk_c_base "$c1_dir"
cat > "$c1_dir/README.md" <<'EOF'
# repo

## skills 一覧

| skill | 内容 |
|---|---|
| [old](old/SKILL.md) | old |

## next
EOF
run_sync "$c1_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
contains 'updated:' "$out" || _detail="$_detail 'updated:' が出ていない"
if [ -z "$_detail" ]; then ok "C1 生成モード / ずれている → exit 0、updated"; else ng "C1 生成モード / ずれている → exit 0、updated" "$_detail out=$(flat "$out")"; fi

c1_after_first=$(od -An -tx1 -- "$c1_dir/README.md")
run_sync "$c1_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
contains 'up to date:' "$out" || _detail="$_detail 'up to date:' が出ていない out=$(flat "$out")"
[ "$(od -An -tx1 -- "$c1_dir/README.md")" = "$c1_after_first" ] || _detail="$_detail README のバイト列が変わった (冪等でない)"
if [ -z "$_detail" ]; then ok "C2 生成モードを続けて実行 → 冪等 (バイト列不変)"; else ng "C2 生成モードを続けて実行 → 冪等 (バイト列不変)" "$_detail"; fi

# C3/C4/C5: チェックモード
c3_dir=$work/c3
mkdir -p "$c3_dir"; mk_c_base "$c3_dir"
cat > "$c3_dir/README.md" <<'EOF'
# repo

## skills 一覧

| skill | 内容 |
|---|---|
| [old](old/SKILL.md) | old |

## next
EOF
run_sync "$c3_dir"   # まず同期
c3_before=$(od -An -tx1 -- "$c3_dir/README.md")
run_sync --check "$c3_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$(od -An -tx1 -- "$c3_dir/README.md")" = "$c3_before" ] || _detail="$_detail README が変わった"
if [ -z "$_detail" ]; then ok "C3 チェックモード / 一致 → exit 0、README 不変 (AC2)"; else ng "C3 チェックモード / 一致 → exit 0、README 不変 (AC2)" "$_detail out=$(flat "$out")"; fi

# C4: description を変えてずれさせる
printf -- '---\nname: skill-a\ndescription: 変わった説明。\n---\n' > "$c3_dir/skill-a/SKILL.md"
c4_before=$(od -An -tx1 -- "$c3_dir/README.md")
run_sync --check "$c3_dir"
_detail=
[ "$rc" = 1 ] || _detail="exit=$rc (want 1)"
contains '変わった説明' "$out" || _detail="$_detail diff に変更後の説明が出ていない out=$(flat "$out")"
[ "$(od -An -tx1 -- "$c3_dir/README.md")" = "$c4_before" ] || _detail="$_detail README が変わった"
if [ -z "$_detail" ]; then ok "C4 チェックモード / description 変更でずれ → exit 1、diff、README 不変 (AC3)"; else ng "C4 チェックモード / description 変更でずれ → exit 1、diff、README 不変 (AC3)" "$_detail"; fi
# 元に戻す
printf -- '---\nname: skill-a\ndescription: 説明です。\n---\n' > "$c3_dir/skill-a/SKILL.md"
run_sync "$c3_dir" >/dev/null 2>&1

# C5: skill ディレクトリを増やしてずれさせる
mkdir -p "$c3_dir/skill-b"
printf -- '---\nname: skill-b\ndescription: 追加skill。\n---\n' > "$c3_dir/skill-b/SKILL.md"
c5_before=$(od -An -tx1 -- "$c3_dir/README.md")
run_sync --check "$c3_dir"
_detail=
[ "$rc" = 1 ] || _detail="exit=$rc (want 1)"
[ "$(od -An -tx1 -- "$c3_dir/README.md")" = "$c5_before" ] || _detail="$_detail README が変わった"
if [ -z "$_detail" ]; then ok "C5 チェックモード / skill ディレクトリ増加でずれ → exit 1、README 不変"; else ng "C5 チェックモード / skill ディレクトリ増加でずれ → exit 1、README 不変" "$_detail out=$(flat "$out")"; fi

# C6: root に README.md が無い
c6_dir=$work/c6
mkdir -p "$c6_dir"; mk_c_base "$c6_dir"
run_sync "$c6_dir"
if [ "$rc" = 2 ]; then ok "C6 root に README.md が無い → exit 2"; else ng "C6 root に README.md が無い → exit 2" "rc=$rc out=$(flat "$out") err=$(flat "$err")"; fi

# C7: README に見出しが無い
c7_dir=$work/c7
mkdir -p "$c7_dir"; mk_c_base "$c7_dir"
printf '# repo\n\nno heading here\n' > "$c7_dir/README.md"
c7_before=$(cat "$c7_dir/README.md")
run_sync "$c7_dir"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$(cat "$c7_dir/README.md")" = "$c7_before" ] || _detail="$_detail README が変わった"
if [ -z "$_detail" ]; then ok "C7 見出しが無い → exit 2、README 不変"; else ng "C7 見出しが無い → exit 2、README 不変" "$_detail out=$(flat "$out")"; fi

# C8: 見出しはあるが節内に表が無い (非目標 4 番: 挿入せずエラーに倒す)
c8_dir=$work/c8
mkdir -p "$c8_dir"; mk_c_base "$c8_dir"
printf '# repo\n\n## skills 一覧\n\n本文だけで表が無い\n\n## next\n' > "$c8_dir/README.md"
c8_before=$(cat "$c8_dir/README.md")
run_sync "$c8_dir"
_detail=
[ "$rc" = 2 ] || _detail="exit=$rc (want 2)"
[ "$(cat "$c8_dir/README.md")" = "$c8_before" ] || _detail="$_detail README が変わった (挿入してしまった)"
if [ -z "$_detail" ]; then ok "C8 見出しはあるが表が無い → exit 2、README 不変 (挿入しない)"; else ng "C8 見出しはあるが表が無い → exit 2、README 不変 (挿入しない)" "$_detail out=$(flat "$out")"; fi

# C9: 引数なし (既定 root = スクリプトの親の親) で --check。実リポジトリを読む (書き込みなし)。
# 前提: このテストを回す前に生成モードを実リポジトリに対して 1 度実行し、同期済みにしておくこと
# (implementation.md にその実行記録がある。ここでは読み取り専用の --check だけを行う)。
run_sync --check
if [ "$rc" = 0 ]; then
    ok "C9 引数なし (既定 root 解決) で --check → exit 0"
else
    ng "C9 引数なし (既定 root 解決) で --check → exit 0" "rc=$rc out=$(flat "$out") err=$(flat "$err") — 実リポジトリの README が未同期の可能性 (先に生成モードを実行すること)"
fi

# C11: 一覧節より後ろの別の節にも表がある → その表は 1 バイトも変わらない
c11_dir=$work/c11
mkdir -p "$c11_dir"; mk_c_base "$c11_dir"
cat > "$c11_dir/README.md" <<'EOF'
# repo

## skills 一覧

| skill | 内容 |
|---|---|
| [old](old/SKILL.md) | old |

## 別の節

| a | b |
|---|---|
| 1 | 2 |
EOF
before_othertable=$(sed -n '/^## 別の節$/,$p' "$c11_dir/README.md")
run_sync "$c11_dir"
after_othertable=$(sed -n '/^## 別の節$/,$p' "$c11_dir/README.md")
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0)"
[ "$before_othertable" = "$after_othertable" ] || _detail="$_detail 節外の表が変わった: before=$(flat "$before_othertable") after=$(flat "$after_othertable")"
if [ -z "$_detail" ]; then ok "C11 節より後ろの別の表は 1 バイトも変わらない"; else ng "C11 節より後ろの別の表は 1 バイトも変わらない" "$_detail"; fi

# C12: 一覧節が README の最後 (後続見出しが無い、EOF まで続く)
c12_dir=$work/c12
mkdir -p "$c12_dir"; mk_c_base "$c12_dir"
printf '# repo\n\n## skills 一覧\n\n| skill | 内容 |\n|---|---|\n| [old](old/SKILL.md) | old |\n' > "$c12_dir/README.md"
run_sync "$c12_dir"
_detail=
[ "$rc" = 0 ] || _detail="exit=$rc (want 0) out=$(flat "$out") err=$(flat "$err")"
grep -q '^| \[skill-a\](skill-a/SKILL.md) | 説明です。 |$' "$c12_dir/README.md" || _detail="$_detail skill-a の行が正しく無い: $(cat "$c12_dir/README.md" | tr '\n' '|')"
if [ -z "$_detail" ]; then
    ok "C12a 一覧節が EOF まで続く README → 生成モードで exit 0、表が更新される"
else
    ng "C12a 一覧節が EOF まで続く README → 生成モードで exit 0、表が更新される" "$_detail"
fi
run_sync --check "$c12_dir"
if [ "$rc" = 0 ]; then
    ok "C12b 直後の --check → exit 0 (AC7)"
else
    ng "C12b 直後の --check → exit 0 (AC7)" "rc=$rc out=$(flat "$out")"
fi

# ============================================================================
# D2/D3: 構文・移植性・静的検査 (D1 は AC6(a) として実行手順に別立てで記載)
# ============================================================================
if sh -n "$sync_sh" 2>/dev/null; then ok "D2a sh -n sync-readme-skills.sh"; else ng "D2a sh -n sync-readme-skills.sh" "syntax error"; fi
if command -v dash >/dev/null 2>&1; then
    if dash -n "$sync_sh" 2>/dev/null; then ok "D2b dash -n sync-readme-skills.sh"; else ng "D2b dash -n sync-readme-skills.sh" "syntax error"; fi
else
    note "D2b dash -n sync-readme-skills.sh" "dash が無い"
fi
if command -v shellcheck >/dev/null 2>&1; then
    sc_out=$(shellcheck -s sh "$sync_sh" 2>&1)
    if [ -z "$sc_out" ]; then ok "D3a shellcheck -s sh sync-readme-skills.sh"; else ng "D3a shellcheck -s sh sync-readme-skills.sh" "$(flat "$sc_out")"; fi
    sc_out2=$(shellcheck -s sh "$tests_dir/sync-readme-skills.test.sh" 2>&1)
    if [ -z "$sc_out2" ]; then ok "D3b shellcheck -s sh sync-readme-skills.test.sh"; else ng "D3b shellcheck -s sh sync-readme-skills.test.sh" "$(flat "$sc_out2")"; fi
else
    note "D3 shellcheck" "shellcheck が無い"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s / SKIP %s\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ] || exit 1
exit 0
