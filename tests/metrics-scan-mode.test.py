#!/usr/bin/env python3
"""tests/metrics-scan-mode.test.py — task-pipeline/docs/scripts/collect-task-metrics.py の
--scan 走査モードの外部挙動 (CLI 実行結果) を固定する。

tests/metrics-scan-mode.test.sh から repo_dir を引数に渡されて実行される
(単体では `python3 tests/metrics-scan-mode.test.py <repo_dir>` でも動く)。

- 依存ゼロ・ネットワーク不要。標準ライブラリ (subprocess/json/tempfile/re) のみ。
- **静的フィクスチャファイルではなく、実行のたびに tempfile で動的にディレクトリ構造を作る**
  (tests/fixtures/<name>/ の慣習から意図的に外れる) — --scan の判定は「渡した絶対パスを
  ~/.claude/projects/ のディレクトリ名規則に変換した文字列」とディレクトリ名が一致するかどうかであり、
  テスト実行環境ごとに変わる一時ディレクトリの絶対パスを起点にしないと判定対象のディレクトリ名を
  固定できないため。
- スクリプト本体の変換関数は import せず、テスト側で独立に同じ規則 (`/` と `.` を `-` に置換) を
  計算する。判定は終了コード・stdout・書き出したファイルの中身という外部から観測できるものだけ。
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


def convert(path):
    """本体の _scan_dirname_prefix と同じ規則 (`/` と `.` を `-` に置換) をテスト側で独立に計算する。"""
    return re.sub(r'[/.]', '-', os.path.abspath(path))


def notif_line(task_id, slug, ts="2026-08-04T00:00:00Z"):
    content = (
        f"<task-notification><task-id>{task_id}</task-id><tool-use-id>tu-1</tool-use-id>"
        f"<result>FINALIZED — abc1234 (runs/{slug}/report.md)</result>"
        f"<usage><subagent_tokens>100</subagent_tokens><tool_uses>1</tool_uses>"
        f"<duration_ms>1000</duration_ms></usage></task-notification>"
    )
    return json.dumps({
        "type": "queue-operation",
        "operation": "enqueue",
        "timestamp": ts,
        "content": content,
    })


def run(script, args, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, script] + args,
        capture_output=True, text=True, env=env,
    )


def main():
    if len(sys.argv) < 2:
        print("usage: metrics-scan-mode.test.py <repo_dir>", file=sys.stderr)
        sys.exit(1)
    repo_dir = sys.argv[1]
    script = os.path.join(repo_dir, "task-pipeline", "docs", "scripts", "collect-task-metrics.py")
    if not os.path.isfile(script):
        print(f"missing required path: {script}", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmp:
        project_root = os.path.join(tmp, "target-project")
        os.makedirs(project_root, exist_ok=True)
        converted = convert(project_root)

        projects_root = os.path.join(tmp, "projects")
        exact_dir = os.path.join(projects_root, converted)
        worktree_dir = os.path.join(projects_root, converted + "-worktree-x")
        unrelated_dir = os.path.join(projects_root, converted + "2")
        plainfile = os.path.join(projects_root, converted + "-plainfile")
        os.makedirs(exact_dir)
        os.makedirs(worktree_dir)
        os.makedirs(unrelated_dir)

        with open(os.path.join(exact_dir, "session-exact.jsonl"), "w") as fh:
            fh.write(notif_line("t-exact-1", "slug-exact") + "\n")
        with open(os.path.join(worktree_dir, "session-worktree.jsonl"), "w") as fh:
            fh.write(notif_line("t-worktree-1", "slug-worktree") + "\n")
        with open(os.path.join(unrelated_dir, "session-unrelated.jsonl"), "w") as fh:
            fh.write(notif_line("t-unrelated-1", "slug-unrelated") + "\n")
        # ディレクトリではない通常ファイル (「変換名 + '-' で始まる」名前)。isdir ガードが効いていれば
        # 中身は一切読まれず、埋め込んだ task-id は出力に現れないはず。
        with open(plainfile, "w") as fh:
            fh.write(notif_line("t-plainfile-entry", "slug-plainfile") + "\n")

        env = {"COLLECT_TASK_METRICS_PROJECTS_BASE": projects_root}

        # --- ケース A (受け入れ条件1): 完全一致・前方一致だけが拾われ、無関係・非ディレクトリは拾われない ---
        out1 = os.path.join(tmp, "metrics.jsonl")
        proc1 = run(script, ["--scan", project_root, "--out", out1, "--no-diff-stats"], env)
        if proc1.returncode == 0:
            ok("A1: --scan 1回目実行 (exit 0、非ディレクトリエントリがあっても例外にならない)")
        else:
            ng("A1: --scan 1回目実行 (exit 0、非ディレクトリエントリがあっても例外にならない)",
               f"exit={proc1.returncode} stderr={proc1.stderr!r}")

        if "from 2 session file(s)" in proc1.stdout:
            ok("A2: 完全一致・前方一致の2ディレクトリだけがスキャンされる (session file(s)=2)")
        else:
            ng("A2: 完全一致・前方一致の2ディレクトリだけがスキャンされる (session file(s)=2)",
               f"stdout={proc1.stdout!r}")

        rows1 = []
        if os.path.exists(out1):
            with open(out1) as fh:
                rows1 = [json.loads(line) for line in fh if line.strip()]
        ids1 = {r["task_id"] for r in rows1}
        if {"t-exact-1", "t-worktree-1"} <= ids1:
            ok("A3: 完全一致・前方一致ディレクトリの task-id が両方含まれる")
        else:
            ng("A3: 完全一致・前方一致ディレクトリの task-id が両方含まれる", f"ids={ids1}")
        if "t-unrelated-1" not in ids1:
            ok("A4: 無関係ディレクトリ (<変換名>2) の task-id は含まれない")
        else:
            ng("A4: 無関係ディレクトリ (<変換名>2) の task-id は含まれない", f"ids={ids1}")
        if "t-plainfile-entry" not in ids1:
            ok("A5: 非ディレクトリエントリ (<変換名>-plainfile というファイル) の中身は読まれない")
        else:
            ng("A5: 非ディレクトリエントリ (<変換名>-plainfile というファイル) の中身は読まれない",
               f"ids={ids1}")

        # --- ケース B (受け入れ条件2): 同じ --scan を2回目実行 → 追記0件 (増分・冪等) --------------
        proc2 = run(script, ["--scan", project_root, "--out", out1, "--no-diff-stats"], env)
        if proc2.returncode == 0 and "0 new task-run(s) collected" in proc2.stdout:
            ok("B1: 2回目の --scan 実行で新規0件 (冪等)")
        else:
            ng("B1: 2回目の --scan 実行で新規0件 (冪等)",
               f"exit={proc2.returncode} stdout={proc2.stdout!r}")
        rows2 = []
        if os.path.exists(out1):
            with open(out1) as fh:
                rows2 = [line for line in fh if line.strip()]
        if len(rows2) == 2:
            ok("B2: metrics.jsonl の行数が2行のまま変わらない")
        else:
            ng("B2: metrics.jsonl の行数が2行のまま変わらない", f"len={len(rows2)}")

        # --- ケース C: --scan と位置引数の同時指定は usage エラー (非0 exit) ----------------------
        procC = run(script, ["--scan", project_root, os.path.join(project_root, "dummy.jsonl"),
                              "--out", os.path.join(tmp, "excl.jsonl"), "--no-diff-stats"], env)
        if procC.returncode != 0:
            ok("C: --scan と位置引数の同時指定は非0 exit (排他)")
        else:
            ng("C: --scan と位置引数の同時指定は非0 exit (排他)",
               f"exit={procC.returncode} stdout={procC.stdout!r}")

        # --- ケース D: 一致するディレクトリが0件でも (base 実在) 正常終了 -------------------------
        empty_projects = os.path.join(tmp, "empty-projects")
        os.makedirs(empty_projects, exist_ok=True)
        procD = run(script, ["--scan", project_root, "--out", os.path.join(tmp, "empty.jsonl"),
                              "--no-diff-stats"], {"COLLECT_TASK_METRICS_PROJECTS_BASE": empty_projects})
        if procD.returncode == 0 and "0 new task-run(s) collected from 0 session file(s)" in procD.stdout:
            ok("D: base は実在するが一致ディレクトリ0件 → exit 0、0 session file(s)")
        else:
            ng("D: base は実在するが一致ディレクトリ0件 → exit 0、0 session file(s)",
               f"exit={procD.returncode} stdout={procD.stdout!r}")

        # --- ケース E: projects base 自体が存在しなくても正常終了 (D とは別コードパス) ------------
        missing_base = os.path.join(tmp, "does-not-exist")
        procE = run(script, ["--scan", project_root, "--out", os.path.join(tmp, "nobase.jsonl"),
                              "--no-diff-stats"], {"COLLECT_TASK_METRICS_PROJECTS_BASE": missing_base})
        if procE.returncode == 0 and "0 new task-run(s) collected from 0 session file(s)" in procE.stdout:
            ok("E: projects base 自体が存在しない → 例外にならず exit 0、0 session file(s)")
        else:
            ng("E: projects base 自体が存在しない → 例外にならず exit 0、0 session file(s)",
               f"exit={procE.returncode} stdout={procE.stdout!r}")

        # --- ケース F (要求2): --scan と --dry-run の組み合わせ → 書き込まれない -------------------
        dry_out = os.path.join(tmp, "dry.jsonl")
        procF = run(script, ["--scan", project_root, "--out", dry_out, "--dry-run", "--no-diff-stats"], env)
        if procF.returncode == 0:
            ok("F1: --scan --dry-run は exit 0")
        else:
            ng("F1: --scan --dry-run は exit 0", f"exit={procF.returncode} stderr={procF.stderr!r}")
        if "dry-run" in procF.stdout and "not writing" in procF.stdout:
            ok("F2: --scan --dry-run は dry-run メッセージを出す")
        else:
            ng("F2: --scan --dry-run は dry-run メッセージを出す", f"stdout={procF.stdout!r}")
        if not os.path.exists(dry_out):
            ok("F3: --scan --dry-run は --out 先に何も書き込まない")
        else:
            ng("F3: --scan --dry-run は --out 先に何も書き込まない", f"{dry_out} が作成された")

        # --- ケース G (受け入れ条件6の回帰): 既存の明示列挙モードは --scan 追加前と同じ挙動 ----------
        explicit_file = os.path.join(exact_dir, "session-exact.jsonl")
        procG = run(script, [explicit_file, "--out", os.path.join(tmp, "explicit-mode.jsonl"),
                              "--dry-run", "--no-diff-stats"])
        if procG.returncode == 0 and "1 new task-run(s) collected" in procG.stdout:
            ok("G: 既存の明示列挙モード (--scan 不使用) は従来どおり動く (回帰)")
        else:
            ng("G: 既存の明示列挙モード (--scan 不使用) は従来どおり動く (回帰)",
               f"exit={procG.returncode} stdout={procG.stdout!r}")

        # --- ケース H: py_compile ------------------------------------------------------------
        procH = subprocess.run([sys.executable, "-m", "py_compile", script],
                                capture_output=True, text=True)
        if procH.returncode == 0:
            ok("H py_compile: collect-task-metrics.py はコンパイル可能")
        else:
            ng("H py_compile: collect-task-metrics.py はコンパイル可能",
               f"exit={procH.returncode} stderr={procH.stderr!r}")

    print()
    print(f"metrics-scan-mode.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
