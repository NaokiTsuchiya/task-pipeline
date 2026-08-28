#!/usr/bin/env python3
"""tests/carryover-count.test.py — task-pipeline/docs/scripts/count-carryover.py (gh-63 の
carryover 集計) の外部挙動 (CLI 実行結果) を固定する。

tests/carryover-count.test.sh から repo_dir を引数に渡されて実行される
(単体では `python3 tests/carryover-count.test.py <repo_dir>` でも動く)。

- 依存ゼロ・ネットワーク不要。標準ライブラリ (subprocess/json/re/tempfile) のみ。
- tests/metrics-fail-reasons.test.py と同じ方針で、実行のたびに tempfile で動的に
  repo_root と verdicts フィクスチャを作る。スクリプト本体は import せず、CLI をサブプロセスで
  実行して stdout/stderr/exit code だけを見る (外部から観測できるものだけで判定する)。
- グループごとに独立した repo_root (tempfile.TemporaryDirectory) を使う — count-carryover.py は
  単一の集計レポートしか返さないため、シナリオを混在させると期待値の計算が複雑になる。
"""
import json
import os
import re
import subprocess
import sys
import tempfile

pass_count = 0
fail_count = 0


def ok(label):
    global pass_count
    pass_count += 1
    print(f"PASS  {label}")


def ng(label, detail):
    global fail_count
    fail_count += 1
    print(f"FAIL  {label} — {detail}")


def w(vdir, filename, obj):
    os.makedirs(vdir, exist_ok=True)
    with open(os.path.join(vdir, filename), "w") as fh:
        json.dump(obj, fh)


def w_raw(vdir, filename, text):
    os.makedirs(vdir, exist_ok=True)
    with open(os.path.join(vdir, filename), "w") as fh:
        fh.write(text)


def run(script, args):
    return subprocess.run(
        [sys.executable, script] + args,
        capture_output=True, text=True,
    )


FIELD_PATTERNS = {
    "scanned": r"^scanned:\s+(\d+)$",
    "unreadable": r"^unreadable:\s+(\d+)$",
    "not_fail": r"^not-FAIL:\s+(\d+)$",
    "unnumbered": r"^unnumbered:\s+(\d+)$",
    "first_attempt": r"^first-attempt:\s+(\d+)$",
    "shell_check": r"^shell-check:\s+(\d+)$",
    "denominator": r"^denominator \(attempt>0 FAIL\):\s+(\d+)$",
    "no_field": r"^no-carryover-field:\s+(\d+)$",
    "malformed": r"^malformed:\s+(\d+)$",
    "carryover_total": r"^carryover count \(explained \+ missed \+ unexplained\):\s+(\d+)$",
    "unexplained_total": r"^unexplained carryover count:\s+(\d+)$",
    "missed_total": r"^self-admitted missed count:\s+(\d+)$",
}
STATUS_VALUES = ("none", "explained", "missed", "unexplained", "unknown")


def parse_report(stdout):
    """stdout のスカラー行と status counts ブロックを dict に読む。無ければ None。"""
    result = {}
    for key, pattern in FIELD_PATTERNS.items():
        m = re.search(pattern, stdout, re.M)
        result[key] = int(m.group(1)) if m else None
    for status in STATUS_VALUES:
        m = re.search(rf"^\s+{status}:\s+(\d+)$", stdout, re.M)
        result[f"status_{status}"] = int(m.group(1)) if m else None
    return result


def phase_line(stdout, phase):
    """「by phase:」節で指定 phase の行を返す (無ければ None)。"""
    m = re.search(rf"^\s+{re.escape(phase)}:\s+(.*)$", stdout, re.M)
    return m.group(1) if m else None


def main():
    if len(sys.argv) < 2:
        print("usage: carryover-count.test.py <repo_dir>", file=sys.stderr)
        sys.exit(1)
    repo_dir = sys.argv[1]
    script = os.path.join(repo_dir, "task-pipeline", "docs", "scripts", "count-carryover.py")
    if not os.path.isfile(script):
        print(f"missing required path: {script}", file=sys.stderr)
        sys.exit(1)

    # --- P1: 壊れた JSON が混ざっていても exit 0 で完走し、他の集計に波及しない -------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p1", "verdicts")
        w(vdir, "plan-0.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["a"]})
        w_raw(vdir, "plan-1.json", "not valid json{")
        w(vdir, "research-0.json", {"phase": "research", "verdict": "PASS"})

        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if proc.returncode == 0:
            ok("P1a: 壊れた JSON が混ざっていても exit 0 で完走する")
        else:
            ng("P1a: 壊れた JSON が混ざっていても exit 0 で完走する",
               f"exit={proc.returncode} stderr={proc.stderr!r}")
        if r["scanned"] == 3 and r["unreadable"] == 1 and r["first_attempt"] == 1 and r["not_fail"] == 1:
            ok("P1b: 壊れた JSON は unreadable に数えられ、他のファイルの集計に波及しない")
        else:
            ng("P1b: 壊れた JSON は unreadable に数えられ、他のファイルの集計に波及しない",
               f"got={r!r} stdout={proc.stdout!r}")

    # --- P2: dict でない JSON (配列) でもクラッシュせず not-FAIL に数える -------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p2", "verdicts")
        w(vdir, "a-0.json", {"phase": "x", "verdict": "PASS"})
        w_raw(vdir, "b-0.json", "[1, 2, 3]")
        w(vdir, "c-0.json", {"phase": "x"})  # verdict キー無し
        w(vdir, "e-1.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["f"]})

        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if proc.returncode == 0 and r["not_fail"] == 3:
            ok("P2a: dict でない JSON (配列) はクラッシュせず not-FAIL に数えられる")
        else:
            ng("P2a: dict でない JSON (配列) はクラッシュせず not-FAIL に数えられる",
               f"exit={proc.returncode} got={r!r} stdout={proc.stdout!r} stderr={proc.stderr!r}")
        if r["denominator"] == 1 and r["no_field"] == 1:
            ok("P2b: verdict==FAIL かつ attempt>0 で carryover が無いものは no-carryover-field")
        else:
            ng("P2b: verdict==FAIL かつ attempt>0 で carryover が無いものは no-carryover-field",
               f"got={r!r}")

    # --- P3: ファイル名の形 (2要素 / 3要素 / phase に + / 番号無し) --------------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p3", "verdicts")
        w(vdir, "plan-1.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": [],
                                  "carryover": {"status": "none", "items": []}})
        w(vdir, "pr_fix-2-1.json", {"phase": "pr_fix", "verdict": "FAIL", "required_fixes": ["a"],
                                      "carryover": {"status": "explained",
                                                    "items": [{"fix": "a", "class": "new-branch", "why": "w"}]}})
        w(vdir, "research+plan-1.json", {"phase": "research+plan", "verdict": "FAIL", "required_fixes": ["b"],
                                           "carryover": {"status": "missed",
                                                         "items": [{"fix": "b", "class": "missed", "why": "w"}]}})
        w(vdir, "report.json", {"phase": "report", "verdict": "PASS"})
        w(vdir, "broken-name.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["c"]})

        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if r["denominator"] == 3:
            ok("P3a: 2要素名・3要素名 (pr_fix)・phase に + を含む名前はすべて attempt を正しく読み分母に入る")
        else:
            ng("P3a: 2要素名・3要素名 (pr_fix)・phase に + を含む名前はすべて attempt を正しく読み分母に入る",
               f"got={r!r} stdout={proc.stdout!r}")
        if r["status_none"] == 1 and r["status_explained"] == 1 and r["status_missed"] == 1:
            ok("P3b: 3ファイルそれぞれの carryover.status が正しく分類される")
        else:
            ng("P3b: 3ファイルそれぞれの carryover.status が正しく分類される", f"got={r!r}")
        if r["not_fail"] == 1 and r["unnumbered"] == 1:
            ok("P3c: 番号を持たない report.json は not-FAIL (verdict=PASS) に、"
               "番号の無い FAIL ファイルは unnumbered に、それぞれ別バケツに入る")
        else:
            ng("P3c: 番号を持たない report.json は not-FAIL (verdict=PASS) に、"
               "番号の無い FAIL ファイルは unnumbered に、それぞれ別バケツに入る", f"got={r!r}")

    # --- P4: attempt 0 / 1 / 2 -----------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p4", "verdicts")
        w(vdir, "plan-0.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["a"]})
        w(vdir, "plan-1.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["b"],
                                  "carryover": {"status": "none", "items": []}})
        w(vdir, "plan-2.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["c"],
                                  "carryover": {"status": "none", "items": []}})
        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if r["first_attempt"] == 1 and r["denominator"] == 2:
            ok("P4: attempt==0 は first-attempt (分母に入らない)、attempt==1/2 は分母に入る")
        else:
            ng("P4: attempt==0 は first-attempt (分母に入らない)、attempt==1/2 は分母に入る", f"got={r!r}")

    # P12: シェル判定 (audit.mode == "shell") は分母に数えない
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p12", "verdicts")
        # LLM 検証エージェントの FAIL (carryover 無し) は従来どおり no-field に数える。
        w(vdir, "implement-1.json", {"phase": "implement", "verdict": "FAIL",
                                     "required_fixes": ["a"]})
        # シェル判定の FAIL は carryover を持ちえないので、分母にも no-field にも入らない。
        w(vdir, "implement-2.json", {"phase": "implement", "verdict": "FAIL",
                                     "required_fixes": ["b"],
                                     "audit": {"mode": "shell", "checks": []}})
        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if r["shell_check"] == 1 and r["denominator"] == 1 and r["no_field"] == 1:
            ok("P12: シェル判定の FAIL は shell-check に数え、分母と no-field に入れない")
        else:
            ng("P12: シェル判定の FAIL は shell-check に数え、分母と no-field に入れない",
               f"got={r!r}")

    # --- P5/P6/P7: carryover キー有無・値の型・status の妥当性 ------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p567", "verdicts")

        def fail1(fn, carryover_value=None, has_key=True):
            obj = {"phase": "plan", "verdict": "FAIL", "required_fixes": ["x"]}
            if has_key:
                obj["carryover"] = carryover_value
            w(vdir, fn, obj)

        fail1("a-1.json", has_key=False)                          # P5: キー無し → no_field
        fail1("b-1.json", carryover_value=None)                   # P6: null → malformed (no_field と別)
        fail1("c-1.json", carryover_value="oops")                 # P6: 文字列 → malformed
        fail1("d-1.json", carryover_value=[1, 2])                 # P6: 配列 → malformed
        fail1("e-1.json", carryover_value={"status": "maybe"})    # P7: 未知の status → malformed
        fail1("f-1.json", carryover_value={})                     # P7: status キー無し → malformed
        fail1("g-1.json", carryover_value={"status": "none", "items": []})  # 正常

        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        if r["denominator"] == 7:
            ok("P5-7a: 7ファイルすべてが分母 (attempt>0 の FAIL) に入る")
        else:
            ng("P5-7a: 7ファイルすべてが分母 (attempt>0 の FAIL) に入る", f"got={r!r}")
        if r["no_field"] == 1:
            ok("P5: carryover キーが無いものだけが no-carryover-field に数えられる")
        else:
            ng("P5: carryover キーが無いものだけが no-carryover-field に数えられる", f"got={r!r}")
        if r["malformed"] == 5:
            ok("P6-7: carryover が null/文字列/配列、または status が未知/欠落のものはすべて "
               "malformed に数えられ、no-carryover-field とは区別される (5件)")
        else:
            ng("P6-7: carryover が null/文字列/配列、または status が未知/欠落のものはすべて "
               "malformed に数えられ、no-carryover-field とは区別される (5件)", f"got={r!r}")
        if r["status_none"] == 1:
            ok("P7b: 正しい status を持つファイルは status counts に正しく数えられる")
        else:
            ng("P7b: 正しい status を持つファイルは status counts に正しく数えられる", f"got={r!r}")

    # --- P8/P10: 5つの status 値すべてと、3つの独立した集計数 -------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p8", "verdicts")

        def carryover_file(fn, status, n_items, cls):
            items = [{"fix": f"f{i}", "class": cls, "why": "w"} for i in range(n_items)]
            w(vdir, fn, {"phase": "plan", "verdict": "FAIL", "required_fixes": [f"f{i}" for i in range(n_items)],
                          "carryover": {"status": status, "items": items}})

        carryover_file("none-a-1.json", "none", 0, "")
        carryover_file("expl-a-1.json", "explained", 1, "new-branch")
        carryover_file("expl-b-1.json", "explained", 1, "new-branch")
        carryover_file("missed-a-1.json", "missed", 1, "missed")
        carryover_file("missed-b-1.json", "missed", 1, "missed")
        carryover_file("missed-c-1.json", "missed", 1, "missed")
        carryover_file("unexp-a-1.json", "unexplained", 1, "unexplained")
        carryover_file("unexp-b-1.json", "unexplained", 1, "unexplained")
        carryover_file("unexp-c-1.json", "unexplained", 1, "unexplained")
        carryover_file("unexp-d-1.json", "unexplained", 1, "unexplained")
        w(vdir, "unknown-a-1.json", {"phase": "plan", "verdict": "FAIL", "required_fixes": ["x"],
                                       "carryover": {"status": "unknown", "items": [], "why": "no prior file"}})

        proc = run(script, [repo_root])
        r = parse_report(proc.stdout)
        expected_status = {"status_none": 1, "status_explained": 2, "status_missed": 3,
                            "status_unexplained": 4, "status_unknown": 1}
        if all(r.get(k) == v for k, v in expected_status.items()):
            ok("P8: 5つの status 値すべてが個別に数えられる (none=1 explained=2 missed=3 "
               "unexplained=4 unknown=1)")
        else:
            ng("P8: 5つの status 値すべてが個別に数えられる (none=1 explained=2 missed=3 "
               "unexplained=4 unknown=1)", f"got={r!r}")
        # P10: 3つの数 (合計9 / unexplained4 / missed3) が互いに異なり、それぞれ正しく出る
        # (1つの数を他の数で代用する誤実装 — 例えば carryover_total と unexplained_total を
        # 取り違える実装 — を、値が互いに異なることで検出できるようにしてある)。
        if r["carryover_total"] == 9 and r["unexplained_total"] == 4 and r["missed_total"] == 3:
            ok("P10: 持ち越し合計 (9) ・理由なし (4) ・自認 (3) の3数が独立に正しく出る "
               "(3値が互いに異なる配置)")
        else:
            ng("P10: 持ち越し合計 (9) ・理由なし (4) ・自認 (3) の3数が独立に正しく出る "
               "(3値が互いに異なる配置)", f"got={r!r}")

    # --- P9: runs ディレクトリが無い ------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo-without-runs")
        os.makedirs(repo_root, exist_ok=True)
        proc = run(script, [repo_root])
        if proc.returncode == 2 and "runs" in proc.stderr.lower():
            ok("P9: .task-pipeline/runs が無いときは exit 2 で stderr にメッセージが出る "
               "(黙って 0 件と出さない)")
        else:
            ng("P9: .task-pipeline/runs が無いときは exit 2 で stderr にメッセージが出る "
               "(黙って 0 件と出さない)", f"exit={proc.returncode} stderr={proc.stderr!r}")

    # --- P11: phase の束ね方は JSON 本文の "phase" (ファイル名ではない) --------------------
    with tempfile.TemporaryDirectory() as tmp:
        repo_root = os.path.join(tmp, "repo")
        vdir = os.path.join(repo_root, ".task-pipeline", "runs", "slug-p11", "verdicts")
        # ファイル名の接頭辞 (plan / research) と JSON 本文の phase (weird-phase-A) が食い違う。
        w(vdir, "plan-1.json", {"phase": "weird-phase-A", "verdict": "FAIL", "required_fixes": ["a"],
                                  "carryover": {"status": "unexplained",
                                                "items": [{"fix": "a", "class": "unexplained", "why": ""}]}})
        w(vdir, "research-1.json", {"phase": "weird-phase-A", "verdict": "FAIL", "required_fixes": ["b"],
                                      "carryover": {"status": "missed",
                                                    "items": [{"fix": "b", "class": "missed", "why": "w"}]}})
        proc = run(script, [repo_root])
        line = phase_line(proc.stdout, "weird-phase-A")
        if line is not None and "unexplained=1" in line and "missed=1" in line:
            ok("P11: phase の束ねは JSON 本文の phase を使う "
               "(ファイル名の phase 接頭辞が食い違っていても正しく1グループに束ねられる)")
        else:
            ng("P11: phase の束ねは JSON 本文の phase を使う "
               "(ファイル名の phase 接頭辞が食い違っていても正しく1グループに束ねられる)",
               f"line={line!r} stdout={proc.stdout!r}")
        # ファイル名接頭辞 (plan / research) 単独の行が誤って作られていないことも確認する。
        if phase_line(proc.stdout, "plan") is None and phase_line(proc.stdout, "research") is None:
            ok("P11b: ファイル名の phase 接頭辞単独では行が作られない (束ねが JSON 側であることの傍証)")
        else:
            ng("P11b: ファイル名の phase 接頭辞単独では行が作られない (束ねが JSON 側であることの傍証)",
               f"stdout={proc.stdout!r}")

    # --- py_compile -------------------------------------------------------------------
    proc_compile = subprocess.run([sys.executable, "-m", "py_compile", script],
                                   capture_output=True, text=True)
    if proc_compile.returncode == 0:
        ok("Z py_compile: count-carryover.py はコンパイル可能")
    else:
        ng("Z py_compile: count-carryover.py はコンパイル可能",
           f"exit={proc_compile.returncode} stderr={proc_compile.stderr!r}")

    print()
    print(f"carryover-count.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
