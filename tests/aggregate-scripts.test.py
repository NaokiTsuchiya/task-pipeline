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

    # --- ケース SC: スキーマ駆動のフェーズ網羅 ----------------------------------------
    # state.schema.json の run の phase enum 全部について、(1) 集計スクリプトの抽出正規表現
    # \w+(?:\+\w+)* で名前が丸ごと拾える文法に収まっていること、(2) 実際に
    # aggregate-session-usage.py に通すと各フェーズが自分の名前のまま分類されること、
    # を機械検査する。フェーズを 1 つ足すと enum が伸び、この 2 検査が自動で新フェーズを
    # 問う — 過去に research+plan が research に黙って誤分類された事故 (cc16785 で修正)
    # を、フェーズ追加のたびに再発しうる形からテスト失敗で落ちる形に変える。
    # v2 のスキーマでは run が kind/gate ごとの oneOf になり、phase enum は 4 つの
    # サブタイプ (runInitialFull / runInitialLight / runPrFix / runRebaseFix) に分かれて
    # いる。全フェーズ名はその和集合で、件数まで主張して「読み取り先を間違えて一部しか
    # 拾わない」誤りを検出可能にする (空集合なら SC0 で落ちるが、部分集合は落ちないため)。
    schema_path = os.path.join(
        repo_dir, "task-pipeline", "scripts", "state.schema.json")
    with open(schema_path) as fh:
        schema = json.load(fh)
    run_subtypes = ["runInitialFull", "runInitialLight", "runPrFix",
                    "runRebaseFix"]
    phase_set = set()
    for subtype in run_subtypes:
        phase_set.update(
            p for p in schema["$defs"][subtype]["properties"]["phase"]["enum"]
            if p is not None)
    phases = sorted(phase_set)
    if not phases:
        ng("SC0 schema phase enum の読み込み", "enum が空")
    expected_phase_count = 8
    if len(phases) == expected_phase_count:
        ok(f"SC0b フェーズ名を {expected_phase_count} 件拾った")
    else:
        ng(f"SC0b フェーズ名を {expected_phase_count} 件拾った",
           f"{len(phases)} 件しか拾えていない: {phases}")

    token_re = re.compile(r"\w+(?:\+\w+)*", re.ASCII)
    for p in phases:
        label = f"SC1 フェーズ名 {p!r} が集計側の抽出文法に収まる"
        m = token_re.fullmatch(p)
        if m:
            ok(label)
        else:
            ng(label,
               "ハイフン等を含む名前は \\w+(?:\\+\\w+)* で途中までしかマッチせず"
               "黙って誤分類される。aggregate-session-usage.py と "
               "collect-task-metrics.py の抽出正規表現を先に拡張すること")

    with tempfile.TemporaryDirectory() as tmp:
        synth = os.path.join(tmp, "synth.jsonl")
        with open(synth, "w") as fh:
            for i, p in enumerate(phases):
                tu = f"tu-schema-{i}"
                prompt = ("independent verifier subagent\n"
                          f"phase: {p}\n"
                          "task: /x/tasks/dummy.md\nrun dir: /x/runs/dummy")
                fh.write(json.dumps({
                    "type": "assistant",
                    "message": {"content": [{
                        "type": "tool_use", "id": tu, "name": "Task",
                        "input": {"prompt": prompt}}]},
                }) + "\n")
                fh.write(json.dumps({
                    "type": "user",
                    "message": {"content": [{
                        "type": "tool_result", "tool_use_id": tu,
                        "content": [{
                            "type": "text",
                            "text": ("subagent_tokens: 100\ntool_uses: 1\n"
                                     f"duration_ms: 1000\nagentId: e{i:08x}")}],
                    }]},
                }) + "\n")
        detail_out = os.path.join(tmp, "detail.json")
        env = dict(os.environ, DETAIL_OUT=detail_out)
        proc = subprocess.run(
            [sys.executable, session_script, synth],
            capture_output=True, text=True, env=env,
        )
        if proc.returncode != 0:
            ng("SC2 合成フィクスチャの実行",
               f"exit={proc.returncode} stderr={proc.stderr!r}")
        else:
            try:
                with open(detail_out) as fh:
                    detail = json.load(fh)
            except Exception as e:  # noqa: BLE001
                ng("SC2 合成フィクスチャの DETAIL_OUT 読み込み", str(e))
                detail = {}
            records = []
            for recs in detail.values():
                records.extend(recs)
            phase_by_tu = {r["tu"]: r["phase"]
                           for r in records if r["kind"] == "sync"}
            for i, p in enumerate(phases):
                got = phase_by_tu.get(f"tu-schema-{i}")
                label = f"SC2 スキーマ enum の {p!r} が自分の名前のまま分類される"
                if got == p:
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
