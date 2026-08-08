#!/bin/sh
# tests/verdict-path-skill-contract.test.sh — task-pipeline/SKILL.md が判定 JSON のパスの
# 組み立てを `verdict-path` verb に移譲したことを grep で固定する (gh-46 の受け入れ条件4)。
#
#   sh tests/verdict-path-skill-contract.test.sh   # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...                    # 失敗調査用にサンドボックスを残す
#
# なぜ prose を grep で固定するのか: SKILL.md はオーケストレーター (モデル) が読む唯一の
# 仕様書であり、そこにパスの組み立て規則が残っていれば CLI の返り値と食い違ったときに
# 二重の真実になる。規則が「消えた」ことと、代わりに `verdict-path` の返り値を使うように
# なったことは、grep でしか機械検査できない (tests/next-skill-contract.test.sh と同じパターン)。
#
# - ケース A: 変更後の SKILL.md が新契約で揃っていることを検証する。
#   A0-A2 は 3 つのファイル名パターンが全域から消えていること (**変更前はそれぞれ 2 / 1 / 2 件
#   ヒットしていた**ので、0 件のままの grep を PASS と読む空振りではない)。
#   A3 は手順 6 の節から「組み立て」の語が消えていること (変更前は 227/231 行の 2 件)。
#   A4 は全域から「組み立てたパス」が消えていること (変更前は 231 行の 1 件)。
#   A5-A8 は 4 箇所 (CLI 節 / フェーズ列の説明 / 手順 6 / 解決サイクル) が `verdict-path` を
#   参照していること。A9 は verifier 起動プロンプト行の verdict path が CLI の返り値を指すこと。
#   A10 は「残す」と決めた記述 (verdict の受け渡し契約) が巻き込まれて消えていないこと。
# - ケース B: 退行検知 — サンドボックスコピーに旧散文を戻すと A0-A4 相当が検知できること。
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。実ファイルは変更しない。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
skill_md=$repo_dir/task-pipeline/SKILL.md

[ -f "$skill_md" ] || { printf 'SKILL.md not found: %s\n' "$skill_md" >&2; exit 1; }

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

printf '# verdict-path-skill-contract checks\n#   skill_md=%s\n' "$skill_md"

# 手順 6 (検証ゲート) の節を切り出す。
gate_section() {
    sed -n '/^6\. \*\*検証ゲート\*\*/,/^### /p' "$1"
}

# $1 = ラベル / $2 = 対象ファイル / $3 = 固定文字列 → 全域で 0 件であること
absent_global() {
    _n=$(grep -cF -- "$3" "$2")
    if [ "$_n" -eq 0 ]; then
        ok "$1"
    else
        ng "$1" "まだ $_n 件残っている: $3"
    fi
}

# $1 = ラベル / $2 = 対象ファイル / $3 = 固定文字列 → 1 件以上あること
present_global() {
    if grep -qF -- "$3" "$2"; then
        ok "$1"
    else
        ng "$1" "見つからない: $3"
    fi
}

# --- A0-A2: ファイル名の組み立て規則が全域から消えている -------------------------------
absent_global "A0 SKILL.md に verdicts/<phase>-<attempt>.json が無い (変更前 2 件)" \
    "$skill_md" 'verdicts/<phase>-<attempt>.json'
absent_global "A1 SKILL.md に pr_fix-<n>-<attempt>.json が無い (変更前 1 件)" \
    "$skill_md" 'pr_fix-<n>-<attempt>.json'
absent_global "A2 SKILL.md に rebase_fix-<n>-<attempt>.json が無い (変更前 2 件)" \
    "$skill_md" 'rebase_fix-<n>-<attempt>.json'

# --- A3: 手順 6 の節に「組み立て」が残っていない (変更前 2 件: 規則本体と起動プロンプト) ---
gate_hits=$(gate_section "$skill_md" | grep -cF '組み立て')
gate_lines=$(gate_section "$skill_md" | wc -l | tr -d ' ')
if [ "$gate_lines" -lt 5 ]; then
    ng "A3 手順 6 の節に「組み立て」が無い" "節が切り出せていない (行数=$gate_lines)"
elif [ "$gate_hits" -eq 0 ]; then
    ok "A3 手順 6 の節に「組み立て」が無い (変更前 2 件)"
else
    ng "A3 手順 6 の節に「組み立て」が無い" "まだ $gate_hits 件残っている"
fi

# --- A4: 「組み立てたパス」が全域から消えている (変更前 1 件: 起動プロンプトの宙吊り参照) ---
# 全域の素の「組み立て」は使わない — 再開コマンドの節に無関係で正当なヒットが 1 件ある。
absent_global "A4 SKILL.md に「組み立てたパス」が無い (変更前 1 件)" \
    "$skill_md" '組み立てたパス'

# --- A5-A8: 4 箇所が verdict-path を参照している ---------------------------------------
present_global "A5 CLI 節に verdict-path の起動形がある" \
    "$skill_md" 'state.ts verdict-path --state-dir'
present_global "A6 フェーズ列の説明が verdict-path を指している" \
    "$skill_md" '**判定 JSON のパスは `state.ts verdict-path` が返す**'

if gate_section "$skill_md" | grep -qF 'state.ts verdict-path --id'; then
    ok "A7 手順 6 が verdict-path を呼んでいる"
else
    ng "A7 手順 6 が verdict-path を呼んでいる" "見つからない"
fi

resolution_section=$(sed -n '/^#### 解決サイクル (rebase_fix)$/,/^### /p' "$skill_md")
if [ -z "$resolution_section" ]; then
    ng "A8 解決サイクルが verdict-path を指している" "節が切り出せていない"
elif printf '%s' "$resolution_section" | grep -qF 'verdict-path'; then
    ok "A8 解決サイクルが verdict-path を指している"
else
    ng "A8 解決サイクルが verdict-path を指している" "節に verdict-path が無い"
fi

# --- A9: verifier 起動プロンプト行の verdict path が CLI の返り値を指す -----------------
# この行は tests/verifier-verdict-contract-alignment.test.sh の A2 がトークンの出現順
# (phase < task < run dir < target project < verdict path) を見ている行そのものである。
# 順序は同スイートが、パスの出所はここが固定する。
prompt_line=$(grep -F 'verdict path:' "$skill_md" | head -1)
if [ -z "$prompt_line" ]; then
    ng "A9 起動プロンプト行の verdict path が CLI の返り値を指す" "対象行が見つからない"
elif printf '%s' "$prompt_line" | grep -qF 'verdict-path'; then
    ok "A9 起動プロンプト行の verdict path が CLI の返り値を指す"
else
    ng "A9 起動プロンプト行の verdict path が CLI の返り値を指す" "line=$prompt_line"
fi

# --- A10 (回帰ガード): verdict の受け渡し契約は変えていない ----------------------------
_detail=
for _needle in \
    '判定 JSON は verifier が起動時に渡した verdict path へ既に書いている — オーケストレータは書かない' \
    'Write the full verdict JSON to verdict path, then return only the minimal verdict JSON.' \
    'Fix required. Read required_fixes from'
do
    grep -qF -- "$_needle" "$skill_md" || _detail="$_detail [消えている: $_needle]"
done
if [ -z "$_detail" ]; then
    ok "A10 verdict の受け渡し契約 (誰が書くか・FAIL 時にパスを渡すこと) が残っている"
else
    ng "A10 verdict の受け渡し契約が残っている" "$_detail"
fi

# --- ケース B: 退行検知 — 旧散文を戻すと A0-A4 相当が検知できること ---------------------
regressed=$work/SKILL.regressed.md
sed -e 's|起動前に `state.ts verdict-path --id <id>` を 1 回呼び、返る `path` をそのまま verifier に渡す|起動前に、判定 JSON の書き込み先パスを組み立てる: `runs/<id>/verdicts/<phase>-<attempt>.json` (`pr_fix` は `pr_fix-<n>-<attempt>.json`、`rebase_fix` は `rebase_fix-<n>-<attempt>.json`)。verifier には組み立てた絶対パスをそのまま渡す|' \
    -e 's|/ verdict path: <verdict-path が返した path>|/ verdict path: <組み立てたパスの絶対パス>|' \
    "$skill_md" > "$regressed"

if cmp -s "$skill_md" "$regressed"; then
    ng "B0 SKILL.md への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B0 SKILL.md への回帰注入が効いている"
fi

b_detail=
for _needle in 'verdicts/<phase>-<attempt>.json' 'pr_fix-<n>-<attempt>.json' \
    'rebase_fix-<n>-<attempt>.json' '組み立てたパス'
do
    grep -qF -- "$_needle" "$regressed" || b_detail="$b_detail [検知できない: $_needle]"
done
if [ -z "$b_detail" ]; then
    ok "B1 退行 (組み立て規則の復活) を A0-A2/A4 相当のチェックで検知できる"
else
    ng "B1 退行 (組み立て規則の復活) を A0-A2/A4 相当のチェックで検知できる" "$b_detail"
fi

b_gate_hits=$(gate_section "$regressed" | grep -cF '組み立て')
if [ "$b_gate_hits" -gt 0 ]; then
    ok "B2 退行 (手順 6 に組み立ての語が戻る) を A3 相当のチェックで検知できる ($b_gate_hits 件)"
else
    ng "B2 退行 (手順 6 に組み立ての語が戻る) を A3 相当のチェックで検知できる" \
        "退行注入後も 0 件だった"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
