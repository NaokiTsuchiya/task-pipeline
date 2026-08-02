#!/usr/bin/env python3
"""tests/aggregate-scripts.test.py — task-pipeline/docs/scripts/aggregate-session-usage.py と
aggregate-orchestrator-usage.py の外部挙動 (CLI 実行結果) を固定する。

tests/aggregate-scripts.test.sh から repo_dir を引数に渡されて実行される
(単体では `python3 tests/aggregate-scripts.test.py <repo_dir>` でも動く)。

- 依存ゼロ・ネットワーク不要。標準ライブラリ (subprocess/json/tempfile) のみ。
- フィクスチャは tests/fixtures/aggregate-scripts/ 配下の .jsonl。実セッションログ・実 API 呼び出し
  には一切依存しない。
- 判定は各スクリプトの外部から観測できるものだけ: 終了コード、stdout の文字列、
  aggregate-session-usage.py については DETAIL_OUT で書き出す JSON の中身
  (summarize() の stdout は category 単位でしか集計しないため、phase 分類そのものを
  確認するには DETAIL_OUT が唯一の観測手段になる)。
"""
import json
import os
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


def main():
    if len(sys.argv) < 2:
        print("usage: aggregate-scripts.test.py <repo_dir>", file=sys.stderr)
        sys.exit(1)
    repo_dir = sys.argv[1]
    scripts_dir = os.path.join(repo_dir, "task-pipeline", "docs", "scripts")
    session_script = os.path.join(scripts_dir, "aggregate-session-usage.py")
    orch_script = os.path.join(scripts_dir, "aggregate-orchestrator-usage.py")
    fixtures_dir = os.path.join(repo_dir, "tests", "fixtures", "aggregate-scripts")
    session_fixture = os.path.join(fixtures_dir, "session-usage.jsonl")
    dedup_fixture = os.path.join(fixtures_dir, "orchestrator-dedup.jsonl")
    cache_fixture = os.path.join(fixtures_dir, "orchestrator-cache.jsonl")

    for p in (session_script, orch_script, session_fixture, dedup_fixture, cache_fixture):
        if not os.path.isfile(p):
            print(f"missing required path: {p}", file=sys.stderr)
            sys.exit(1)

    # --- ケース A/B: aggregate-session-usage.py の phase 分類 (DETAIL_OUT 経由) -----------
    with tempfile.TemporaryDirectory() as tmp:
        detail_out = os.path.join(tmp, "detail.json")
        env = dict(os.environ, DETAIL_OUT=detail_out)
        proc = subprocess.run(
            [sys.executable, session_script, session_fixture],
            capture_output=True, text=True, env=env,
        )
        if proc.returncode != 0:
            ng("session-usage: スクリプト実行", f"exit={proc.returncode} stderr={proc.stderr!r}")
        else:
            ok("session-usage: スクリプト実行 (exit 0)")

        try:
            with open(detail_out) as fh:
                detail = json.load(fh)
        except Exception as e:
            ng("session-usage: DETAIL_OUT の読み込み", str(e))
            detail = {}

        records = []
        for recs in detail.values():
            records.extend(recs)

        sync_phase_by_tu = {r["tu"]: r["phase"] for r in records if r["kind"] == "sync"}
        bg_phase_by_task = {r["task_id"]: r["phase"] for r in records if r["kind"] == "bg"}

        # ケース A (受け入れ条件 1): research+plan が 1 トークンとして分類される
        got = sync_phase_by_tu.get("tu-research-plus-plan")
        if got == "research+plan":
            ok("A1 sync: phase: research+plan の起動プロンプト -> research+plan に分類")
        else:
            ng("A1 sync: phase: research+plan の起動プロンプト -> research+plan に分類",
               f"got phase={got!r} (records={sync_phase_by_tu})")

        got = bg_phase_by_task.get("bg-research-plan")
        if got == "research+plan":
            ok("A2 background: PHASE research+plan DONE -> research+plan に分類")
        else:
            ng("A2 background: PHASE research+plan DONE -> research+plan に分類",
               f"got phase={got!r} (records={bg_phase_by_task})")

        # ケース B (受け入れ条件 3 の回帰): 既存の単純トークンは分類結果不変
        simple_sync_expected = {
            "tu-research": "research",
            "tu-plan": "plan",
            "tu-implement": "implement",
            "tu-report": "report",
            "tu-pr_fix": "pr_fix",
            "tu-rebase_fix": "rebase_fix",
            "tu-finalize": "finalize",
        }
        for tu, expected in simple_sync_expected.items():
            got = sync_phase_by_tu.get(tu)
            label = f"B sync: phase: {expected} の起動プロンプト -> {expected} に分類 (回帰)"
            if got == expected:
                ok(label)
            else:
                ng(label, f"got phase={got!r}")

        got = bg_phase_by_task.get("bg-implement")
        label = "B background: PHASE implement DONE -> implement に分類 (回帰)"
        if got == "implement":
            ok(label)
        else:
            ng(label, f"got phase={got!r}")

    # --- ケース C (受け入れ条件 4): message.id の重複排除 ------------------------------
    proc = subprocess.run(
        [sys.executable, orch_script, dedup_fixture],
        capture_output=True, text=True,
    )
    out = proc.stdout.strip()
    expected_dedup = "api_calls=2 processed=370 weighted=650 output=70 cache_write(1h/5m)=0/0"
    if proc.returncode == 0 and out == expected_dedup:
        ok("C orchestrator: message.id 重複排除 (3行/distinct id 2 -> api_calls=2, 出力最大値を採用)")
    else:
        ng("C orchestrator: message.id 重複排除",
           f"exit={proc.returncode} stdout={out!r} (want {expected_dedup!r})")

    # --- ケース D (受け入れ条件 5): cache_creation 内訳あり/なし混在 ---------------------
    proc = subprocess.run(
        [sys.executable, orch_script, cache_fixture],
        capture_output=True, text=True,
    )
    out = proc.stdout.strip()
    expected_cache = "api_calls=2 processed=2,690 weighted=3,188 output=140 cache_write(1h/5m)=300/350"
    if proc.returncode == 0 and out == expected_cache:
        ok("D orchestrator: cache_creation 内訳あり/なし混在の集計")
    else:
        ng("D orchestrator: cache_creation 内訳あり/なし混在の集計",
           f"exit={proc.returncode} stdout={out!r} (want {expected_cache!r})")

    # --- ケース E: py_compile (受け入れ条件 9 の一部を先取り確認) ------------------------
    proc = subprocess.run(
        [sys.executable, "-m", "py_compile", session_script, orch_script],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        ok("E py_compile: 両スクリプトともコンパイル可能")
    else:
        ng("E py_compile: 両スクリプトともコンパイル可能",
           f"exit={proc.returncode} stderr={proc.stderr!r}")

    print()
    print(f"aggregate-scripts.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
