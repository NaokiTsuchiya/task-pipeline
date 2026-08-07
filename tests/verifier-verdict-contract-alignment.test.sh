#!/bin/sh
# tests/verifier-verdict-contract-alignment.test.sh — verifier の判定 JSON を
# ファイル経由で受け渡す契約 (verifier-verdict-via-file タスク) が、次の 4 ファイル間で
# 食い違っていないことを固定する:
#   - task-pipeline/references/verifier.md   (verifier が verdict path に書く/最小 JSON を返す)
#   - agents/task-pipeline-verifier.md        (verifier サブエージェント定義)
#   - task-pipeline/SKILL.md                  (オーケストレータ: verdict path を組み立てて渡す)
#   - task-pipeline/references/executor.md    (実行エージェント: FAIL 時に verdict path を読む)
#
#   sh tests/verifier-verdict-contract-alignment.test.sh   # 全ケース PASS なら exit 0
#   KEEP_SANDBOX=1 sh tests/...                            # 失敗調査用にサンドボックスを残す
#
# 背景: verdict の reasons/required_fixes はオーケストレータのコンテキストを 2 回
# (verifier の戻り値として、オーケストレータがファイルに書くために) 通っていた。
# verifier が自分で verdict path に書き、戻り値を {phase, verdict}(+declaration) に絞ることで
# 1 往復分を削る。4 ファイルのどれか 1 つだけが旧契約に戻ると、往復が復活するか、
# executor が required_fixes を受け取れなくなる — これを構造的に検知する。
#
# - 依存ゼロ・ネットワーク不要・POSIX sh のみ。
# - ケース A: 現状の 4 ファイルが新契約で揃っていることを検証する。
#   A0-A2 は 3 ファイル (verifier.md / agent.md / SKILL.md) が起動時に渡す入力トークンの並び
#   (phase / task / run dir / target project / verdict path) を、行内の出現位置 (index) で
#   揃っている前提で比較する。
#   A3-A6 はファイルごとに旧契約の痕跡が残っていないことを grep する。
#   A7 は SKILL.md と executor.md が FAIL 時のメッセージ文言 (パスを渡す形) で揃っていることを見る。
#   A8 は research+plan 統合ゲートの declaration が、最小化された返り値契約にも残っていることを見る。
# - ケース B: 4 ファイルそれぞれについて、サンドボックスコピー上でそのファイルだけを
#   旧契約の該当行に戻し、スイート全体 (関連チェックのみ) が不一致を検知できることを確認する。
set -u

tests_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
repo_dir=$(CDPATH='' cd -- "$tests_dir/.." && pwd -P) || exit 1
verifier_md=$repo_dir/task-pipeline/references/verifier.md
agent_md=$repo_dir/agents/task-pipeline-verifier.md
skill_md=$repo_dir/task-pipeline/SKILL.md
executor_md=$repo_dir/task-pipeline/references/executor.md
for f in "$verifier_md" "$agent_md" "$skill_md" "$executor_md"; do
    [ -f "$f" ] || { printf 'required file not found: %s\n' "$f" >&2; exit 1; }
done

work=$(mktemp -d) || exit 1
trap 'if [ "${KEEP_SANDBOX:-0}" = 1 ]; then printf "sandbox kept: %s\n" "$work"; else rm -rf "$work"; fi' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
ng() { fail=$((fail + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }

printf '# verifier-verdict-contract-alignment checks\n'
printf '#   verifier_md=%s\n#   agent_md=%s\n#   skill_md=%s\n#   executor_md=%s\n' \
    "$verifier_md" "$agent_md" "$skill_md" "$executor_md"

# 起動時の入力トークン列 (phase / task / run dir / target project / verdict path) を宣言する行を
# 各ファイルから 1 行だけ抜き出す。
verifier_input_line=$(grep -F '入力: phase' "$verifier_md" | head -1)
agent_input_line=$(grep -F 'The launch prompt gives you:' "$agent_md" | head -1)
skill_prompt_line=$(grep -F 'phase: <phase> / task: <tasks/<id>.md の絶対パス> / run dir:' "$skill_md" | head -1)

# 行内で各トークンが最後に "verdict path" を伴って現れる位置を awk index() で取り、
# phase < task < run dir < target project < verdict path の順で単調増加であることを確認する。
# 1 つでもトークンが行から消えていれば index が 0 になり、比較が破綻して FAIL する。
check_token_order() {
    label=$1
    line=$2
    awk -v line="$line" -v label="$label" '
        BEGIN {
            p1 = index(line, "phase")
            p2 = index(line, "task")
            p3 = index(line, "run dir")
            p4 = index(line, "target project")
            p5 = index(line, "verdict path")
            if (p1 > 0 && p1 < p2 && p2 < p3 && p3 < p4 && p4 < p5) {
                print "OK"
            } else {
                printf "NG p1=%d p2=%d p3=%d p4=%d p5=%d\n", p1, p2, p3, p4, p5
            }
        }
    '
}

for pair in "A0 verifier.md の入力トークン列|$verifier_input_line" \
            "A1 agent.md の入力トークン列|$agent_input_line" \
            "A2 SKILL.md の起動プロンプトの入力トークン列|$skill_prompt_line"; do
    label=${pair%%|*}
    line=${pair#*|}
    if [ -z "$line" ]; then
        ng "$label" "対象行が見つからない"
        continue
    fi
    result=$(check_token_order "$label" "$line")
    if [ "$result" = "OK" ]; then
        ok "$label (phase < task < run dir < target project < verdict path)"
    else
        ng "$label" "$result — line=$line"
    fi
done

# --- A3: verifier.md — 返り値が最小 JSON (reasons/required_fixes を含まない) ---------
if grep -qF '"phase": "<phase>", "verdict": "PASS"}' "$verifier_md"; then
    ok "A3 verifier.md に最小返り値リテラル {phase, verdict} がある"
else
    ng "A3 verifier.md に最小返り値リテラル {phase, verdict} がある" "見つからない"
fi
if grep -qF '"phase": "<phase>", "verdict": "PASS", "reasons"' "$verifier_md"; then
    ok "A3b verifier.md にファイル書き込み用の full JSON (reasons/required_fixes 付き) が残っている"
else
    ng "A3b verifier.md にファイル書き込み用の full JSON が残っている" "見つからない"
fi

# --- A4: agent.md — 最小返り値へ言及し、旧来の無条件 'Return only the verdict JSON.' 単独行になっていない
if grep -qF 'Write the full verdict JSON to verdict path' "$agent_md" && grep -qF 'minimal verdict JSON' "$agent_md"; then
    ok "A4 agent.md が verdict path への書き込みと最小返り値への言及を両方持つ"
else
    ng "A4 agent.md が verdict path への書き込みと最小返り値への言及を両方持つ" "見つからない"
fi

# --- A5: SKILL.md — PASS 分岐がもう判定 JSON を書く記述を持たない -------------------
if grep -qF '判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き' "$skill_md"; then
    ng "A5 SKILL.md の PASS 分岐がオーケストレータによる判定 JSON 書き込みを求めていない" "旧文言が残っている"
else
    ok "A5 SKILL.md の PASS 分岐がオーケストレータによる判定 JSON 書き込みを求めていない"
fi

# --- A6: SKILL.md — FAIL 分岐が required_fixes の中身ではなくパスを送る -------------
if grep -qF 'required_fixes をそのまま送り' "$skill_md"; then
    ng "A6 SKILL.md の FAIL 分岐が required_fixes の中身ではなくパスを送る" "旧文言 (中身をそのまま送る) が残っている"
else
    ok "A6 SKILL.md の FAIL 分岐が required_fixes の中身ではなくパスを送る"
fi

# --- A7: SKILL.md と executor.md — FAIL 時のメッセージ文言が揃っている --------------
# バッククォートで囲んだ絶対パスの実値部分だけがファイルごとに違う (SKILL.md は組み立てた
# 絶対パス、executor.md は受け取ったプレースホルダ) ので、それを剥いだ骨格文字列で比較する。
strip_placeholders() {
    sed -E 's/`<[^`]*`/<X>/g; s/<[^>]*>/<X>/g'
}
skill_fail_msg=$(grep -oE 'Fix required\. Read required_fixes from.*and address them in phase[^」"]*' "$skill_md" | head -1 | strip_placeholders)
executor_fail_msg=$(grep -oE 'Fix required\. Read required_fixes from.*and address them in phase[^」`]*' "$executor_md" | head -1 | strip_placeholders)

if [ -z "$skill_fail_msg" ]; then
    ng "A7 SKILL.md に FAIL 時のメッセージ文言がある" "抽出できない"
elif [ -z "$executor_fail_msg" ]; then
    ng "A7 executor.md に FAIL 時のメッセージ文言がある" "抽出できない"
elif [ "$skill_fail_msg" = "$executor_fail_msg" ]; then
    ok "A7 SKILL.md と executor.md の FAIL メッセージ文言が一致 ($skill_fail_msg)"
else
    ng "A7 SKILL.md と executor.md の FAIL メッセージ文言が一致" "skill=$skill_fail_msg executor=$executor_fail_msg"
fi

# --- A8: verifier.md — research+plan の declaration が最小返り値契約にも残っている ---
# 「返り値にも `"declaration"」という語彙は、既存の「判定 JSON (ファイル) には declaration を
# 含める」という記述 (research+plan 節) とは別の文で、返り値契約側の記述として一意に識別できる。
if grep -qF '返り値にも `"declaration"' "$verifier_md"; then
    ok 'A8 verifier.md の最小返り値契約に declaration (research+plan のみ) が明記されている'
else
    ng 'A8 verifier.md の最小返り値契約に declaration (research+plan のみ) が明記されている' "見つからない"
fi

# --- ケース B: 退行検知 — 4 ファイルそれぞれを単独で旧契約に戻すと検知できること -----
# サンドボックスにコピーして 1 ファイルだけ書き換える。実ファイルは変更しない。
# make_regressed は sed した結果のパスを stdout に書くだけ (ok/ng は呼ばない — command
# substitution 経由で呼ぶ関数の中で ok/ng を呼ぶと、PASS/FAIL 表示行までパスとして
# 拾われてしまうため、注入が効いたかどうかの判定と表示は呼び出し側で行う)。
make_regressed() {
    case_id=$1
    src=$2
    sed_expr=$3
    base=$(basename -- "$src")
    regressed=$work/$case_id.$base
    sed -E "$sed_expr" "$src" > "$regressed"
    printf '%s\n' "$regressed"
}

# B0: verifier.md の返り値を旧 full JSON に戻す (最小 JSON リテラルを消す)
b0_regressed=$(make_regressed B0 "$verifier_md" \
    's/\{"phase": "<phase>", "verdict": "PASS"\}/{"phase": "<phase>", "verdict": "PASS", "reasons": ["..."], "required_fixes": []}/')
if cmp -s "$verifier_md" "$b0_regressed"; then
    ng "B0 verifier.md への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B0 verifier.md への回帰注入が効いている"
fi
if grep -qF '"phase": "<phase>", "verdict": "PASS"}' "$b0_regressed"; then
    ng "B1 verifier.md の退行 (最小 JSON 消失) を A3 相当のチェックで検知できる" "退行後も最小 JSON リテラルが残っていた"
else
    ok "B1 verifier.md の退行 (最小 JSON 消失) を A3 相当のチェックで検知できる"
fi

# B2: agent.md を旧契約 (verdict path への言及なし) に戻す
b2_regressed=$(make_regressed B2 "$agent_md" \
    's/^The launch prompt gives you: phase \/ task file \/ run dir \/ target project \/ verdict path\.$/The launch prompt gives you: phase \/ task file \/ run dir \/ target project./; s/^Write the full verdict JSON to verdict path \(you have Bash but no Write tool\), then return only the minimal verdict JSON\.$/Return only the verdict JSON./')
if cmp -s "$agent_md" "$b2_regressed"; then
    ng "B2 agent.md への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B2 agent.md への回帰注入が効いている"
fi
if grep -qF 'Write the full verdict JSON to verdict path' "$b2_regressed" || grep -qF 'minimal verdict JSON' "$b2_regressed"; then
    ng "B3 agent.md の退行 (verdict path 言及の消失) を A4 相当のチェックで検知できる" "退行後も新契約の文言が残っていた"
else
    ok "B3 agent.md の退行 (verdict path 言及の消失) を A4 相当のチェックで検知できる"
fi

# B4: SKILL.md の PASS 分岐を旧文言 (オーケストレータが判定 JSON を書く) に戻す
b4_regressed=$(make_regressed B4 "$skill_md" \
    's/\(判定 JSON は verifier が起動時に渡した verdict path へ既に書いている — オーケストレータは書かない\) `state\.ts advance/判定 JSON を `runs\/<id>\/verdicts\/<phase>-<attempt>.json` に書き、`state.ts advance/')
if cmp -s "$skill_md" "$b4_regressed"; then
    ng "B4 SKILL.md への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B4 SKILL.md への回帰注入が効いている"
fi
if grep -qF '判定 JSON を `runs/<id>/verdicts/<phase>-<attempt>.json` に書き' "$b4_regressed"; then
    ok "B5 SKILL.md の退行 (PASS 分岐が判定 JSON を書く記述に戻る) を A5 相当のチェックで検知できる"
else
    ng "B5 SKILL.md の退行 (PASS 分岐が判定 JSON を書く記述に戻る) を A5 相当のチェックで検知できる" "退行注入後も旧文言が見つからなかった"
fi

# B6: executor.md の修正指示メッセージを旧契約 (パスではなく中身をそのまま扱う) に戻す
b6_regressed=$(make_regressed B6 "$executor_md" \
    's/^  2\. `Fix required\. Read required_fixes from <verdict path> and address them in phase <phase>\.` \(修正指示\) → `<verdict path>` を読み、そこに書かれた判定 JSON の `required_fixes` を、同じフェーズの成果物と \(implement \/ pr_fix なら\) 実装に反映して修正し、同じ形式で停止する。$/  2. 修正指示 (required_fixes) → 同じフェーズの成果物と (implement \/ pr_fix なら) 実装を修正し、同じ形式で停止する。/')
if cmp -s "$executor_md" "$b6_regressed"; then
    ng "B6 executor.md への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B6 executor.md への回帰注入が効いている"
fi
b6_msg=$(grep -oE 'Fix required\. Read required_fixes from.*and address them in phase[^」`]*' "$b6_regressed" | head -1)
if [ -z "$b6_msg" ]; then
    ok "B7 executor.md の退行 (パスから読む手順の消失) を A7 相当のチェックで検知できる"
else
    ng "B7 executor.md の退行 (パスから読む手順の消失) を A7 相当のチェックで検知できる" "退行注入後もメッセージ文言が抽出できてしまった"
fi

# B8: verifier.md の declaration 継承の一文だけを削る
b8_regressed=$(make_regressed B8 "$verifier_md" \
    's/^phase が `research\+plan` のときだけ、返り値にも `"declaration": "upheld" \| "overturned"` を加える \(オーケストレータが history に記録するため\)。$//')
if cmp -s "$verifier_md" "$b8_regressed"; then
    ng "B8a verifier.md (declaration 文) への回帰注入が効いている" "sed による置換が効かず元ファイルと同一になった"
else
    ok "B8a verifier.md (declaration 文) への回帰注入が効いている"
fi
if grep -qF '返り値にも `"declaration"' "$b8_regressed"; then
    ng "B8b verifier.md の退行 (declaration 文の消失) を A8 相当のチェックで検知できる" "退行後も declaration 言及が残っていた"
else
    ok "B8b verifier.md の退行 (declaration 文の消失) を A8 相当のチェックで検知できる"
fi

printf '\n%s\n' "----------------------------------------"
printf 'PASS %s / FAIL %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
