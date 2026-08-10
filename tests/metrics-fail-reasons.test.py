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
from datetime import datetime, timezone

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


def write_verdict(vdir, filename, phase, verdict, required_fixes=None, carryover=None):
    os.makedirs(vdir, exist_ok=True)
    obj = {
        "phase": phase,
        "verdict": verdict,
        "reasons": ["dummy reason"],
        "required_fixes": required_fixes or [],
    }
    if carryover is not None:
        obj["carryover"] = carryover
    with open(os.path.join(vdir, filename), "w") as fh:
        json.dump(obj, fh)


def write_verdict_at(vdir, filename, phase, verdict, mtime_iso, required_fixes=None):
    """write_verdict と同じだが、書き込み後に os.utime で mtime を mtime_iso
    (例 '2026-08-04T04:24:00Z') に固定する。窓の帰属判定は verdict ファイルの mtime を見るため、
    テストでは実行時の壁時計時刻ではなく任意の過去時刻を指定できる必要がある。
    """
    write_verdict(vdir, filename, phase, verdict, required_fixes)
    path = os.path.join(vdir, filename)
    ts = datetime.strptime(mtime_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    os.utime(path, (ts, ts))


def fr(phase, attempt, required_fixes=None):
    """fail_reasons の1要素を組み立てる (アサーション記述の簡略化用)。"""
    return {"phase": phase, "attempt": attempt, "required_fixes": required_fixes or []}


def unattributed_count(stdout):
    m = re.search(r"fail_reasons: (\d+) verdict\(s\)", stdout)
    return int(m.group(1)) if m else None


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

        # 各 slug が単一レコードのみのケースでは unattributed は出ない (受け入れ条件4、0件側)
        if unattributed_count(proc.stdout) == 0:
            ok("0b: 単一レコードの slug のみの収集では fail_reasons の unattributed 件数が 0 と出る")
        else:
            ng("0b: 単一レコードの slug のみの収集では fail_reasons の unattributed 件数が 0 と出る",
               f"stdout={proc.stdout!r}")

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

        # --- ケース「窓分割」(受け入れ条件1・2): 同じ slug に2つの run、境界ちょうどを含む ------------
        # t-win-1 の notif ts (lower) = 04:08:00Z、t-win-2 の notif ts (t-win-1 の upper) = 09:44:00Z。
        # issue 本文 (gh-12 実測) を模した配置に加え、下限/上限ちょうどの境界verdictを追加する。
        vdir_win = os.path.join(runs_dir, "slug-windowed", "verdicts")
        write_verdict_at(vdir_win, "research+plan-0.json", "research+plan", "FAIL",
                          "2026-08-04T04:24:00Z", ["fix A"])
        write_verdict_at(vdir_win, "research+plan-1.json", "research+plan", "FAIL",
                          "2026-08-04T04:36:00Z", ["fix B"])
        write_verdict_at(vdir_win, "research+plan-2.json", "research+plan", "FAIL",
                          "2026-08-04T04:45:00Z", ["fix C"])
        write_verdict_at(vdir_win, "research+plan-9.json", "research+plan", "FAIL",
                          "2026-08-04T04:08:00Z", ["fix at lower boundary"])
        write_verdict_at(vdir_win, "research-0.json", "research", "PASS", "2026-08-04T09:53:00Z")
        write_verdict_at(vdir_win, "plan-0.json", "plan", "FAIL", "2026-08-04T10:09:00Z", ["fix D"])
        write_verdict_at(vdir_win, "plan-1.json", "plan", "FAIL", "2026-08-04T10:22:00Z", ["fix E"])
        write_verdict_at(vdir_win, "plan-2.json", "plan", "PASS", "2026-08-04T10:35:00Z")
        write_verdict_at(vdir_win, "plan-9.json", "plan", "FAIL",
                          "2026-08-04T09:44:00Z", ["fix at upper boundary"])

        session_win = os.path.join(tmp, "session-windowed.jsonl")
        with open(session_win, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-win-1", "slug-windowed", ts="2026-08-04T04:08:00Z") + "\n")
            fh.write(notif_line("t-win-2", "slug-windowed", ts="2026-08-04T09:44:00Z") + "\n")

        out_win = os.path.join(tmp, "metrics-windowed.jsonl")
        proc_win = run(script, [session_win, "--out", out_win, "--no-diff-stats"])

        rows_win = {}
        if os.path.exists(out_win):
            with open(out_win) as fh:
                rows_win = {json.loads(line)["task_id"]: json.loads(line) for line in fh if line.strip()}

        expected_win1 = [fr("research+plan", 0, ["fix A"]), fr("research+plan", 1, ["fix B"]),
                          fr("research+plan", 2, ["fix C"]), fr("research+plan", 9, ["fix at lower boundary"])]
        got_win1 = rows_win.get("t-win-1", {}).get("fail_reasons")
        if got_win1 == expected_win1:
            ok("9: t-win-1 の fail_reasons が自分の run の4件のみ (下限ちょうどの verdict を含み、"
               "end_ts より後・次レコードの start_ts より前の FAIL も含む = 受け入れ条件1・2)")
        else:
            ng("9: t-win-1 の fail_reasons が自分の run の4件のみ (下限ちょうどの verdict を含み、"
               "end_ts より後・次レコードの start_ts より前の FAIL も含む = 受け入れ条件1・2)",
               f"got={got_win1!r}")

        expected_win2 = [fr("plan", 0, ["fix D"]), fr("plan", 1, ["fix E"]),
                          fr("plan", 9, ["fix at upper boundary"])]
        got_win2 = rows_win.get("t-win-2", {}).get("fail_reasons")
        if got_win2 == expected_win2:
            ok("10: t-win-2 の fail_reasons が自分の run の3件のみ (上限ちょうどの verdict は"
               "t-win-1 ではなくこちらに帰属する = 上限は排他・次レコードの下限は包含)")
        else:
            ng("10: t-win-2 の fail_reasons が自分の run の3件のみ (上限ちょうどの verdict は"
               "t-win-1 ではなくこちらに帰属する = 上限は排他・次レコードの下限は包含)",
               f"got={got_win2!r}")

        if unattributed_count(proc_win.stdout) == 0:
            ok("11: 窓分割ケースでは全 verdict がどちらかの窓に収まり unattributed は0")
        else:
            ng("11: 窓分割ケースでは全 verdict がどちらかの窓に収まり unattributed は0",
               f"stdout={proc_win.stdout!r}")

        # --- ケース「unattributed」(受け入れ条件4): レコードの start_ts より前の FAIL は帰属先が無い ---
        vdir_pre = os.path.join(runs_dir, "slug-preexisting", "verdicts")
        write_verdict_at(vdir_pre, "research-0.json", "research", "FAIL",
                          "2026-08-05T09:00:00Z", ["stale fix"])

        session_pre = os.path.join(tmp, "session-preexisting.jsonl")
        with open(session_pre, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-pre-1", "slug-preexisting", ts="2026-08-05T10:00:00Z") + "\n")

        out_pre = os.path.join(tmp, "metrics-preexisting.jsonl")
        proc_pre = run(script, [session_pre, "--out", out_pre, "--no-diff-stats"])

        rows_pre = {}
        if os.path.exists(out_pre):
            with open(out_pre) as fh:
                rows_pre = {json.loads(line)["task_id"]: json.loads(line) for line in fh if line.strip()}

        if rows_pre.get("t-pre-1", {}).get("fail_reasons") == []:
            ok("12: レコードの start_ts より前に書かれた FAIL は、その行の fail_reasons に含まれない")
        else:
            ng("12: レコードの start_ts より前に書かれた FAIL は、その行の fail_reasons に含まれない",
               f"got={rows_pre.get('t-pre-1', {}).get('fail_reasons')!r}")

        if unattributed_count(proc_pre.stdout) == 1:
            ok("13: 帰属先の無かった verdict の件数 (1件) が収集の stdout に現れる (黙って落とさない)")
        else:
            ng("13: 帰属先の無かった verdict の件数 (1件) が収集の stdout に現れる (黙って落とさない)",
               f"stdout={proc_pre.stdout!r}")

        # --- ケース「増分収集をまたぐ merge」(受け入れ条件1・2を existing_rows 経由の経路で再確認) ----
        vdir_inc = os.path.join(runs_dir, "slug-incremental", "verdicts")
        write_verdict_at(vdir_inc, "research+plan-0.json", "research+plan", "FAIL",
                          "2026-08-06T04:24:00Z", ["inc fix A"])
        write_verdict_at(vdir_inc, "research+plan-1.json", "research+plan", "FAIL",
                          "2026-08-06T04:36:00Z", ["inc fix B"])
        write_verdict_at(vdir_inc, "research+plan-2.json", "research+plan", "FAIL",
                          "2026-08-06T04:45:00Z", ["inc fix C"])
        write_verdict_at(vdir_inc, "research-0.json", "research", "PASS", "2026-08-06T09:53:00Z")
        write_verdict_at(vdir_inc, "plan-0.json", "plan", "FAIL", "2026-08-06T10:09:00Z", ["inc fix D"])
        write_verdict_at(vdir_inc, "plan-1.json", "plan", "FAIL", "2026-08-06T10:22:00Z", ["inc fix E"])
        write_verdict_at(vdir_inc, "plan-2.json", "plan", "PASS", "2026-08-06T10:35:00Z")

        session_inc_later = os.path.join(tmp, "session-incremental-later.jsonl")
        with open(session_inc_later, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-inc-2", "slug-incremental", ts="2026-08-06T09:44:00Z") + "\n")

        session_inc_earlier = os.path.join(tmp, "session-incremental-earlier.jsonl")
        with open(session_inc_earlier, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-inc-1", "slug-incremental", ts="2026-08-06T04:08:00Z") + "\n")

        out_inc = os.path.join(tmp, "metrics-incremental.jsonl")

        # 1回目: 時系列で後の run (t-inc-2) だけを新規収集する。この時点でグループのレコードは
        # これ1件だけなので window は [09:44, +inf) — 04:xx台の3件はこの回では帰属先が無い。
        proc_inc1 = run(script, [session_inc_later, "--out", out_inc, "--no-diff-stats"])
        if "1 new task-run(s) collected from 1 session file(s)" in proc_inc1.stdout:
            ok("14: 増分収集1回目 (t-inc-2 のみ) が新規1件として収集される")
        else:
            ng("14: 増分収集1回目 (t-inc-2 のみ) が新規1件として収集される", f"stdout={proc_inc1.stdout!r}")

        if unattributed_count(proc_inc1.stdout) == 3:
            ok("15: 増分収集1回目の時点では、まだ収集されていない前の run の3件の FAIL が"
               " unattributed として数えられる (黙って落とさない)")
        else:
            ng("15: 増分収集1回目の時点では、まだ収集されていない前の run の3件の FAIL が"
               " unattributed として数えられる (黙って落とさない)", f"stdout={proc_inc1.stdout!r}")

        rows_inc = {}
        with open(out_inc) as fh:
            rows_inc = {json.loads(line)["task_id"]: json.loads(line) for line in fh if line.strip()}
        expected_inc2 = [fr("plan", 0, ["inc fix D"]), fr("plan", 1, ["inc fix E"])]
        if rows_inc.get("t-inc-2", {}).get("fail_reasons") == expected_inc2:
            ok("16: 増分収集1回目時点の t-inc-2 の fail_reasons は自分の2件のみ")
        else:
            ng("16: 増分収集1回目時点の t-inc-2 の fail_reasons は自分の2件のみ",
               f"got={rows_inc.get('t-inc-2', {}).get('fail_reasons')!r}")

        # 2回目 (別プロセス起動、同じ --out): 時系列で前の run (t-inc-1) を新規収集する。この時点で
        # main() が読み込む existing_rows に1回目で書かれた t-inc-2 の行 (start_ts=09:44) が
        # 含まれるはずで、existing_rows との merge が効いていれば t-inc-1 の window は
        # [04:08, 09:44) になる (効いていなければ t-inc-1 が「最後のレコード」扱いになり
        # window が open-ended になって t-inc-2 の2件まで巻き込んでしまう)。
        proc_inc2 = run(script, [session_inc_earlier, "--out", out_inc, "--no-diff-stats"])
        if "1 new task-run(s) collected from 1 session file(s)" in proc_inc2.stdout:
            ok("17: 増分収集2回目 (t-inc-1 のみ) が新規1件として収集される")
        else:
            ng("17: 増分収集2回目 (t-inc-1 のみ) が新規1件として収集される", f"stdout={proc_inc2.stdout!r}")

        if unattributed_count(proc_inc2.stdout) == 0:
            ok("18: 増分収集2回目では、残っていた3件がすべて t-inc-1 の窓に収まり unattributed は0")
        else:
            ng("18: 増分収集2回目では、残っていた3件がすべて t-inc-1 の窓に収まり unattributed は0",
               f"stdout={proc_inc2.stdout!r}")

        rows_inc2 = {}
        with open(out_inc) as fh:
            rows_inc2 = {json.loads(line)["task_id"]: json.loads(line) for line in fh if line.strip()}

        expected_inc1 = [fr("research+plan", 0, ["inc fix A"]), fr("research+plan", 1, ["inc fix B"]),
                          fr("research+plan", 2, ["inc fix C"])]
        got_inc1 = rows_inc2.get("t-inc-1", {}).get("fail_reasons")
        if got_inc1 == expected_inc1:
            ok("19: existing_rows との merge が効き、増分収集2回目でも t-inc-1 の fail_reasons が"
               " 自分の3件のみ (existing_rows を無視する誤実装だと t-inc-2 の2件を巻き込んで5件になる)")
        else:
            ng("19: existing_rows との merge が効き、増分収集2回目でも t-inc-1 の fail_reasons が"
               " 自分の3件のみ (existing_rows を無視する誤実装だと t-inc-2 の2件を巻き込んで5件になる)",
               f"got={got_inc1!r}")

        if len(rows_inc2) == 2 and rows_inc2.get("t-inc-2", {}).get("fail_reasons") == expected_inc2:
            ok("20: 増分収集は既存行 (t-inc-2) を書き換えない (1回目に書いた値のまま)")
        else:
            ng("20: 増分収集は既存行 (t-inc-2) を書き換えない (1回目に書いた値のまま)",
               f"len={len(rows_inc2)} t-inc-2={rows_inc2.get('t-inc-2', {}).get('fail_reasons')!r}")

        # --- ケース「再計算」(受け入れ条件5): 既に書かれた行を --recompute-fail-reasons で確定させる ---
        vdir_rc = os.path.join(runs_dir, "slug-recompute", "verdicts")
        write_verdict_at(vdir_rc, "research+plan-0.json", "research+plan", "FAIL",
                          "2026-08-07T04:24:00Z", ["rc fix A"])
        write_verdict_at(vdir_rc, "research+plan-1.json", "research+plan", "FAIL",
                          "2026-08-07T04:36:00Z", ["rc fix B"])
        write_verdict_at(vdir_rc, "research+plan-2.json", "research+plan", "FAIL",
                          "2026-08-07T04:45:00Z", ["rc fix C"])
        write_verdict_at(vdir_rc, "plan-0.json", "plan", "FAIL", "2026-08-07T10:09:00Z", ["rc fix D"])
        write_verdict_at(vdir_rc, "plan-1.json", "plan", "FAIL", "2026-08-07T10:22:00Z", ["rc fix E"])

        vdir_rcs = os.path.join(runs_dir, "slug-recompute-single", "verdicts")
        write_verdict_at(vdir_rcs, "research-0.json", "research", "FAIL",
                          "2026-08-07T12:00:00Z", ["single fix"])

        # 旧バグ挙動 (slug ディレクトリ丸ごと) を模して、両方の行に同じ5件を仮置きしておく —
        # recompute 後にこれが正しく3件/2件へ分かれることを確認する。単一レコードの行
        # (slug-recompute-single) は初期値を「正しい値」にしておき、recompute で変わらないことを見る。
        buggy_all5 = [fr("research+plan", 0, ["rc fix A"]), fr("research+plan", 1, ["rc fix B"]),
                      fr("research+plan", 2, ["rc fix C"]), fr("plan", 0, ["rc fix D"]),
                      fr("plan", 1, ["rc fix E"])]
        correct_single = [fr("research", 0, ["single fix"])]
        other_repo_row = {
            "repo": "other-repo", "session": "other-session.jsonl", "task_id": "t-other-1",
            "task": "slug-recompute", "start_ts": "2026-08-07T00:00:00Z",
            "fail_reasons": ["untouched-dummy-value"],
        }
        recompute_rows = [
            {"repo": "test-repo", "session": "s.jsonl", "task_id": "t-rc-1",
             "task": "slug-recompute", "start_ts": "2026-08-07T04:08:00Z", "fail_reasons": buggy_all5},
            {"repo": "test-repo", "session": "s.jsonl", "task_id": "t-rc-2",
             "task": "slug-recompute", "start_ts": "2026-08-07T09:44:00Z", "fail_reasons": buggy_all5},
            {"repo": "test-repo", "session": "s.jsonl", "task_id": "t-rcs-1",
             "task": "slug-recompute-single", "start_ts": "2026-08-07T11:00:00Z",
             "fail_reasons": correct_single},
            other_repo_row,
        ]
        recompute_out = os.path.join(tmp, "metrics-recompute.jsonl")
        with open(recompute_out, "w") as fh:
            for r in recompute_rows:
                fh.write(json.dumps(r) + "\n")
        before_bytes = open(recompute_out, "rb").read()

        # --dry-run: ファイルは1バイトも変わらない
        proc_rc_dry = run(script, ["--recompute-fail-reasons", repo_root, "--out", recompute_out, "--dry-run"])
        after_dry_bytes = open(recompute_out, "rb").read()
        if proc_rc_dry.returncode == 0 and after_dry_bytes == before_bytes:
            ok("21: --recompute-fail-reasons --dry-run は --out ファイルを1バイトも変えない")
        else:
            ng("21: --recompute-fail-reasons --dry-run は --out ファイルを1バイトも変えない",
               f"exit={proc_rc_dry.returncode} changed={after_dry_bytes != before_bytes}")
        if "dry-run" in proc_rc_dry.stdout and "not writing" in proc_rc_dry.stdout:
            ok("22: --recompute-fail-reasons --dry-run は dry-run メッセージを出す")
        else:
            ng("22: --recompute-fail-reasons --dry-run は dry-run メッセージを出す",
               f"stdout={proc_rc_dry.stdout!r}")

        # 実行 (書き戻す)
        proc_rc = run(script, ["--recompute-fail-reasons", repo_root, "--out", recompute_out])
        rows_rc = {}
        with open(recompute_out) as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                rows_rc[r["task_id"]] = r

        expected_rc1 = [fr("research+plan", 0, ["rc fix A"]), fr("research+plan", 1, ["rc fix B"]),
                         fr("research+plan", 2, ["rc fix C"])]
        expected_rc2 = [fr("plan", 0, ["rc fix D"]), fr("plan", 1, ["rc fix E"])]
        if (rows_rc.get("t-rc-1", {}).get("fail_reasons") == expected_rc1
                and rows_rc.get("t-rc-2", {}).get("fail_reasons") == expected_rc2):
            ok("23: 再計算後、slug-recompute の2行が正しく3件/2件に分かれる (旧バグの5件重複が解消)")
        else:
            ng("23: 再計算後、slug-recompute の2行が正しく3件/2件に分かれる (旧バグの5件重複が解消)",
               f"t-rc-1={rows_rc.get('t-rc-1', {}).get('fail_reasons')!r} "
               f"t-rc-2={rows_rc.get('t-rc-2', {}).get('fail_reasons')!r}")

        if rows_rc.get("t-rcs-1", {}).get("fail_reasons") == correct_single:
            ok("24: 単一レコードの slug (slug-recompute-single) は再計算しても値が変わらない")
        else:
            ng("24: 単一レコードの slug (slug-recompute-single) は再計算しても値が変わらない",
               f"got={rows_rc.get('t-rcs-1', {}).get('fail_reasons')!r}")

        if rows_rc.get("t-other-1") == other_repo_row:
            ok("25: repo_root のフィルタと一致しない repo (other-repo) の行は完全に不変")
        else:
            ng("25: repo_root のフィルタと一致しない repo (other-repo) の行は完全に不変",
               f"got={rows_rc.get('t-other-1')!r}")

        rc_changed_m = re.search(r"(\d+) row\(s\) changed", proc_rc.stdout)
        if rc_changed_m and int(rc_changed_m.group(1)) == 2:
            ok("26: 再計算の変更行数 (2行: t-rc-1, t-rc-2) が stdout に出る")
        else:
            ng("26: 再計算の変更行数 (2行: t-rc-1, t-rc-2) が stdout に出る", f"stdout={proc_rc.stdout!r}")

        if unattributed_count(proc_rc.stdout) == 0:
            ok("27: 再計算ケースでは全 verdict がどちらかの窓に収まり unattributed は0")
        else:
            ng("27: 再計算ケースでは全 verdict がどちらかの窓に収まり unattributed は0",
               f"stdout={proc_rc.stdout!r}")

        # --- ケース「carryover フィールドは fail_reasons を変えない」(gh-63 受け入れ条件7) ------
        # 同じ required_fixes を持つ2つの slug を作り、片方の verdict にだけ carryover を付ける。
        # collect-task-metrics.py は carryover を読まない (list_fail_verdicts が拾うキーは
        # phase/verdict/required_fixes の3つだけ) ので、値の有無で fail_reasons が変わってはならない。
        vdir_co_a = os.path.join(runs_dir, "slug-carryover-a", "verdicts")
        write_verdict(vdir_co_a, "plan-1.json", "plan", "FAIL", ["fix X", "fix Y"])

        vdir_co_b = os.path.join(runs_dir, "slug-carryover-b", "verdicts")
        write_verdict(vdir_co_b, "plan-1.json", "plan", "FAIL", ["fix X", "fix Y"], carryover={
            "status": "explained",
            "items": [{"fix": "fix Y", "class": "new-branch", "why": "newly reachable"}],
        })

        session_co = os.path.join(tmp, "session-carryover.jsonl")
        with open(session_co, "w") as fh:
            fh.write(assistant_cwd_line(repo_root) + "\n")
            fh.write(notif_line("t-co-a-1", "slug-carryover-a") + "\n")
            fh.write(notif_line("t-co-b-1", "slug-carryover-b") + "\n")

        out_co = os.path.join(tmp, "metrics-carryover.jsonl")
        proc_co = run(script, [session_co, "--out", out_co, "--no-diff-stats"])

        rows_co = {}
        if os.path.exists(out_co):
            with open(out_co) as fh:
                rows_co = {json.loads(line)["task_id"]: json.loads(line) for line in fh if line.strip()}

        got_co_a = rows_co.get("t-co-a-1", {}).get("fail_reasons")
        got_co_b = rows_co.get("t-co-b-1", {}).get("fail_reasons")
        expected_co = [fr("plan", 1, ["fix X", "fix Y"])]
        if proc_co.returncode == 0 and got_co_a == expected_co and got_co_b == expected_co:
            ok("29: carryover フィールドの有無は fail_reasons に影響しない (gh-63 受け入れ条件7)")
        else:
            ng("29: carryover フィールドの有無は fail_reasons に影響しない (gh-63 受け入れ条件7)",
               f"exit={proc_co.returncode} a={got_co_a!r} b={got_co_b!r}")

        # --- py_compile --------------------------------------------------------------------
        procH = subprocess.run([sys.executable, "-m", "py_compile", script],
                                capture_output=True, text=True)
        if procH.returncode == 0:
            ok("28 py_compile: collect-task-metrics.py はコンパイル可能")
        else:
            ng("28 py_compile: collect-task-metrics.py はコンパイル可能",
               f"exit={procH.returncode} stderr={procH.stderr!r}")

    print()
    print(f"metrics-fail-reasons.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
