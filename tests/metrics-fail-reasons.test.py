#!/usr/bin/env python3
"""tests/metrics-fail-reasons.test.py — task-pipeline/docs/scripts/collect-task-metrics.py の
fail_reasons フィールド (verdicts の FAIL 判定を metrics.jsonl の行へ集約するロジック) の
外部挙動 (CLI 実行結果) を固定する。

tests/metrics-fail-reasons.test.sh から repo_dir を引数に渡されて実行される
(単体では `python3 tests/metrics-fail-reasons.test.py <repo_dir>` でも動く)。

- 依存ゼロ・ネットワーク不要。標準ライブラリ (subprocess/json/tempfile/re) のみ。
- tests/metrics-scan-mode.test.py と同じ方針で、実行のたびに tempfile で動的にディレクトリ構造
  (repo_root と verdicts フィクスチャ) を作る。fail_reasons の判定は repo_root_of(cwd) に依存する
  ため、REPO_ROOT_RE (`<...>/github.com/<owner>/<repo>`) に一致する repo_root を組み立て、
  セッション jsonl の先頭 assistant 行にその cwd を埋め込む。
- スクリプト本体は import せず、CLI をサブプロセスで実行して stdout / 書き出した jsonl の中身
  だけを見る (外部から観測できるものだけで判定する)。
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


def assistant_cwd_line(cwd, ts="2026-08-04T00:00:00Z"):
    return json.dumps({
        "type": "assistant",
        "timestamp": ts,
        "cwd": cwd,
        "message": {"model": "claude-test-model", "content": []},
    })


def notif_line(task_id, slug, ts="2026-08-04T00:01:00Z"):
    content = (
        f"<task-notification><task-id>{task_id}</task-id><tool-use-id>tu-{task_id}</tool-use-id>"
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


def write_verdict(vdir, filename, phase, verdict, required_fixes=None):
    os.makedirs(vdir, exist_ok=True)
    with open(os.path.join(vdir, filename), "w") as fh:
        json.dump({
            "phase": phase,
            "verdict": verdict,
            "reasons": ["dummy reason"],
            "required_fixes": required_fixes or [],
        }, fh)


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
        print("usage: metrics-fail-reasons.test.py <repo_dir>", file=sys.stderr)
        sys.exit(1)
    repo_dir = sys.argv[1]
    script = os.path.join(repo_dir, "task-pipeline", "docs", "scripts", "collect-task-metrics.py")
    if not os.path.isfile(script):
        print(f"missing required path: {script}", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmp:
        # REPO_ROOT_RE = r'(.*?/github\.com/[^/]+/[^/]+)' に一致する repo_root を作る。
        repo_root = os.path.join(tmp, "github.com", "test-owner", "test-repo")
        os.makedirs(repo_root, exist_ok=True)

        # --- verdicts フィクスチャ ---------------------------------------------------------
        runs_dir = os.path.join(repo_root, ".task-pipeline", "runs")

        # slug-fail: FAIL 2件 (plan-0, research-0) + PASS 2件 (plan-1, research-1)。
        vdir_fail = os.path.join(runs_dir, "slug-fail", "verdicts")
        write_verdict(vdir_fail, "plan-0.json", "plan", "FAIL", ["fix plan issue A", "fix plan issue B"])
        write_verdict(vdir_fail, "plan-1.json", "plan", "PASS")
        write_verdict(vdir_fail, "research-0.json", "research", "FAIL", ["fix research issue A"])
        write_verdict(vdir_fail, "research-1.json", "research", "PASS")

        # slug-allpass: PASS のみ。
        vdir_allpass = os.path.join(runs_dir, "slug-allpass", "verdicts")
        write_verdict(vdir_allpass, "research-0.json", "research", "PASS")
        write_verdict(vdir_allpass, "plan-0.json", "plan", "PASS")

        # slug-nodir: verdicts ディレクトリ自体を作らない (runs/slug-nodir/ も作らない)。

        # slug-broken: 正常な FAIL 1件 + 壊れた JSON 1件。
        vdir_broken = os.path.join(runs_dir, "slug-broken", "verdicts")
        write_verdict(vdir_broken, "research-0.json", "research", "FAIL", ["fix broken issue"])
        os.makedirs(vdir_broken, exist_ok=True)
        with open(os.path.join(vdir_broken, "plan-0.json"), "w") as fh:
            fh.write("not valid json{")

        # --- セッション jsonl ----------------------------------------------------------------
        session_path = os.path.join(tmp, "session-fail-reasons.jsonl")
        with open(session_path, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-fail-1", "slug-fail") + "\n")
            fh.write(notif_line("t-allpass-1", "slug-allpass") + "\n")
            fh.write(notif_line("t-nodir-1", "slug-nodir") + "\n")
            fh.write(notif_line("t-broken-1", "slug-broken") + "\n")

        out = os.path.join(tmp, "metrics.jsonl")
        proc = run(script, [session_path, "--out", out, "--no-diff-stats"])

        if proc.returncode == 0:
            ok("0: collect 実行が exit 0 で完走する (壊れた JSON が混ざっていても)")
        else:
            ng("0: collect 実行が exit 0 で完走する (壊れた JSON が混ざっていても)",
               f"exit={proc.returncode} stderr={proc.stderr!r}")

        rows = {}
        if os.path.exists(out):
            with open(out) as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    r = json.loads(line)
                    rows[r["task"]] = r

        if len(rows) == 4:
            ok("1: 4タスク全ての行が metrics.jsonl に書き出される")
        else:
            ng("1: 4タスク全ての行が metrics.jsonl に書き出される", f"rows={sorted(rows.keys())}")

        # --- 受け入れ条件1: FAIL を含むタスクの fail_reasons -----------------------------------
        expected_fail = [
            {"phase": "plan", "attempt": 0, "required_fixes": ["fix plan issue A", "fix plan issue B"]},
            {"phase": "research", "attempt": 0, "required_fixes": ["fix research issue A"]},
        ]
        got_fail = rows.get("slug-fail", {}).get("fail_reasons")
        if got_fail == expected_fail:
            ok("2: slug-fail の fail_reasons がファイル名昇順 (plan が research より先) で"
               " required_fixes をそのまま運ぶ")
        else:
            ng("2: slug-fail の fail_reasons がファイル名昇順 (plan が research より先) で"
               " required_fixes をそのまま運ぶ", f"got={got_fail!r}")

        # --- 受け入れ条件2: FAIL 無しのタスクは [] --------------------------------------------
        got_allpass = rows.get("slug-allpass", {}).get("fail_reasons")
        if got_allpass == []:
            ok("3: slug-allpass (全PASS) の fail_reasons は []")
        else:
            ng("3: slug-allpass (全PASS) の fail_reasons は []", f"got={got_allpass!r}")

        # --- 受け入れ条件3: verdicts ディレクトリ不在は null (収集自体は成功) ------------------
        if "slug-nodir" in rows and rows["slug-nodir"].get("fail_reasons") is None:
            ok("4: slug-nodir (verdicts ディレクトリ不在) の fail_reasons は null で行自体は収集される")
        else:
            ng("4: slug-nodir (verdicts ディレクトリ不在) の fail_reasons は null で行自体は収集される",
               f"row={rows.get('slug-nodir')!r}")

        # --- 受け入れ条件4: 壊れた JSON が混ざっていても収集は exit 0 で完走し、他タスクに波及しない ---
        if "slug-broken" in rows and rows["slug-broken"].get("fail_reasons") is None:
            ok("5: slug-broken (壊れた JSON 混在) の fail_reasons は null")
        else:
            ng("5: slug-broken (壊れた JSON 混在) の fail_reasons は null",
               f"row={rows.get('slug-broken')!r}")

        if "collect-task-metrics" in proc.stderr and "slug-broken" in proc.stderr:
            ok("6: 壊れた JSON について stderr に警告が1行以上出る")
        else:
            ng("6: 壊れた JSON について stderr に警告が1行以上出る", f"stderr={proc.stderr!r}")

        # slug-broken の失敗が他タスクの行に波及していないことを、再度 slug-fail / slug-allpass で確認する
        if rows.get("slug-fail", {}).get("fail_reasons") == expected_fail and rows.get("slug-allpass", {}).get("fail_reasons") == []:
            ok("7: slug-broken の失敗は他タスク (slug-fail / slug-allpass) の行に波及しない")
        else:
            ng("7: slug-broken の失敗は他タスク (slug-fail / slug-allpass) の行に波及しない",
               f"slug-fail={rows.get('slug-fail', {}).get('fail_reasons')!r} "
               f"slug-allpass={rows.get('slug-allpass', {}).get('fail_reasons')!r}")

        # --- py_compile --------------------------------------------------------------------
        procH = subprocess.run([sys.executable, "-m", "py_compile", script],
                                capture_output=True, text=True)
        if procH.returncode == 0:
            ok("8 py_compile: collect-task-metrics.py はコンパイル可能")
        else:
            ng("8 py_compile: collect-task-metrics.py はコンパイル可能",
               f"exit={procH.returncode} stderr={procH.stderr!r}")

    print()
    print(f"metrics-fail-reasons.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
