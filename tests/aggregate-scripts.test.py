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
    role_phase_cost_script = os.path.join(scripts_dir, "aggregate-role-phase-cost.py")
    fixtures_dir = os.path.join(repo_dir, "tests", "fixtures", "aggregate-scripts")
    session_fixture = os.path.join(fixtures_dir, "session-usage.jsonl")
    dedup_fixture = os.path.join(fixtures_dir, "orchestrator-dedup.jsonl")
    cache_fixture = os.path.join(fixtures_dir, "orchestrator-cache.jsonl")
    role_phase_cost_fixture = os.path.join(fixtures_dir, "role-phase-cost-session.jsonl")
    role_phase_cost_clean_fixture = os.path.join(fixtures_dir, "role-phase-cost-clean.jsonl")
    paseo_usage_dir = os.path.join(fixtures_dir, "paseo-usage-mixed")
    paseo_usage_missing_dir = os.path.join(fixtures_dir, "paseo-usage-does-not-exist")

    for p in (session_script, orch_script, role_phase_cost_script, session_fixture,
              dedup_fixture, cache_fixture, role_phase_cost_fixture, role_phase_cost_clean_fixture):
        if not os.path.isfile(p):
            print(f"missing required path: {p}", file=sys.stderr)
            sys.exit(1)
    if not os.path.isdir(paseo_usage_dir):
        print(f"missing required path: {paseo_usage_dir}", file=sys.stderr)
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
        [sys.executable, "-m", "py_compile", session_script, orch_script, role_phase_cost_script],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        ok("E py_compile: 3スクリプトともコンパイル可能")
    else:
        ng("E py_compile: 3スクリプトともコンパイル可能",
           f"exit={proc.returncode} stderr={proc.stderr!r}")

    # --- ケース F: aggregate-role-phase-cost.py (gh-56: 役割×フェーズ×attempt別課金換算) ---
    def run_role_phase_cost(fixture, extra_args=None):
        with tempfile.TemporaryDirectory() as tmp:
            detail_out = os.path.join(tmp, "detail.json")
            env = dict(os.environ, DETAIL_OUT=detail_out)
            args = [sys.executable, role_phase_cost_script, fixture] + (extra_args or [])
            proc = subprocess.run(args, capture_output=True, text=True, env=env)
            try:
                with open(detail_out) as fh:
                    detail = json.load(fh)
            except Exception:
                detail = {"rows": [], "uncountable": None}
            return proc, detail

    def find_row(rows, role, phase, attempt_bucket):
        for r in rows:
            if r["role"] == role and r["phase"] == phase and r["attempt_bucket"] == attempt_bucket:
                return r
        return None

    proc_f, detail_f = run_role_phase_cost(role_phase_cost_fixture)
    if proc_f.returncode == 0:
        ok("F0 role-phase-cost: スクリプト実行 (exit 0)")
    else:
        ng("F0 role-phase-cost: スクリプト実行 (exit 0)",
           f"exit={proc_f.returncode} stderr={proc_f.stderr!r}")

    rows_f = detail_f.get("rows", [])

    # F1 (受け入れ条件1・3): adapter (非verifier、体を跨がない単純ケース)。weighted が直接
    # aggregate-orchestrator-usage.py をその体の transcript に通した値 (160) と一致する。
    row = find_row(rows_f, "adapter", None, None)
    if row and row["api_calls"] == 1 and row["weighted"] == 160:
        ok("F1 adapter: role=adapter phase=- の行が api_calls=1 weighted=160 (直接実行と一致)")
    else:
        ng("F1 adapter: role=adapter phase=- の行が api_calls=1 weighted=160", f"row={row}")

    # F2 (受け入れ条件2・attempt=0)
    row = find_row(rows_f, "verifier", "implement", "0")
    if row and row["api_calls"] == 1 and row["weighted"] == 200:
        ok("F2 verifier implement attempt=0: api_calls=1 weighted=200")
    else:
        ng("F2 verifier implement attempt=0: api_calls=1 weighted=200", f"row={row}")

    # F3 (受け入れ条件2・attempt>=1、同一体を SendMessage で再開)
    row = find_row(rows_f, "verifier", "implement", "1+")
    if row and row["api_calls"] == 1 and row["weighted"] == 100:
        ok("F3 verifier implement attempt=1+ (SendMessage 再開): api_calls=1 weighted=100")
    else:
        ng("F3 verifier implement attempt=1+ (SendMessage 再開): api_calls=1 weighted=100", f"row={row}")

    # F3 reconciliation: 体 V1 の attempt0+attempt1 合算 (300) が直接実行と一致
    row0 = find_row(rows_f, "verifier", "implement", "0")
    row1 = find_row(rows_f, "verifier", "implement", "1+")
    if row0 and row1 and (row0["weighted"] + row1["weighted"]) == 300:
        ok("F3 reconciliation: verifier(V1) の attempt0+attempt1 合算weighted=300 (直接実行と一致)")
    else:
        ng("F3 reconciliation: verifier(V1) の attempt0+attempt1 合算weighted=300",
           f"row0={row0} row1={row1}")

    # F4 (受け入れ条件2・pr_fix の連番入り verdict path): pr_fix-3-2.json -> attempt=2 -> bucket '1+'
    row = find_row(rows_f, "verifier", "pr_fix", "1+")
    if row and row["api_calls"] == 1 and row["weighted"] == 240:
        ok("F4 verifier pr_fix (pr_fix-3-2.json): 3要素ファイル名から attempt=2 (bucket='1+') が取れる")
    else:
        ng("F4 verifier pr_fix (pr_fix-3-2.json): 3要素ファイル名から attempt=2 (bucket='1+') が取れる",
           f"row={row}")

    # F5 (受け入れ条件2・拒否側): verdict path はあるがファイル名が -<数字>.json で終わらない (weird.json)
    # -> どの行にも現れない (weighted の元になった 9999+9999*5=59994 がどこにも漏れない)
    leaked5 = any(r["weighted"] == 9999 + 9999 * 5 for r in rows_f)
    if not leaked5:
        ok("F5 verdict path のファイル名が想定外 (weird.json): どの行にも weighted が漏れない")
    else:
        ng("F5 verdict path のファイル名が想定外 (weird.json): どの行にも weighted が漏れない",
           f"rows={rows_f}")

    # F6 (受け入れ条件2・拒否側): verdict path 行自体が起動テキストに無い -> どの行にも現れない
    leaked6 = any(r["weighted"] == 8888 + 8888 * 5 for r in rows_f)
    if not leaked6:
        ok("F6 verdict path 行自体が無い: どの行にも weighted が漏れない")
    else:
        ng("F6 verdict path 行自体が無い: どの行にも weighted が漏れない", f"rows={rows_f}")

    # F7/F8: agentId が取れない体・transcript が無い体は api_calls の合計に混ざらない
    # (正しい合計 = V1(2) + V2(1) + E3(4) + A4(1) + V8(1) = 9。V5/V6/V7/no-agent は含まれない)
    total_calls = sum(r["api_calls"] for r in rows_f)
    if total_calls == 9:
        ok("F7/F8 uncountable な体 (agentId不明・transcript欠落) は api_calls の合計に混ざらない (合計9)")
    else:
        ng("F7/F8 uncountable な体は api_calls の合計に混ざらない (合計9)",
           f"total_calls={total_calls} rows={rows_f}")

    # F9 (受け入れ条件4): 集計できなかった呼び出し (F5:V5 + F6:V6 + agentId不明 + transcript欠落:V7) = 4
    if detail_f.get("uncountable") == 4:
        ok("F9 uncountable=4 (ファイル名想定外 + verdict path無し + agentId不明 + transcript欠落) が出る")
    else:
        ng("F9 uncountable=4 が DETAIL_OUT に出る", f"uncountable={detail_f.get('uncountable')}")
    if "uncountable=4" in proc_f.stdout:
        ok("F9b stdout に 'uncountable=4' が厳密一致で出る")
    else:
        ng("F9b stdout に 'uncountable=4' が厳密一致で出る", f"stdout={proc_f.stdout!r}")

    # F10 (executor の複数フェーズ・体を跨ぐ分割): research+plan / implement (2セグメント合算)
    row_rp = find_row(rows_f, "executor", "research+plan", None)
    row_impl = find_row(rows_f, "executor", "implement", None)
    if row_rp and row_rp["weighted"] == 600 and row_impl and row_impl["weighted"] == 2300 \
            and row_impl["api_calls"] == 3:
        ok("F10 executor: research+plan(weighted=600) / implement(2セグメント合算, "
           "api_calls=3, weighted=2300)")
    else:
        ng("F10 executor: research+plan(600) / implement(api_calls=3, weighted=2300)",
           f"row_rp={row_rp} row_impl={row_impl}")

    # F10 reconciliation: 体 E3 の全行 (research+plan + implement) 合算weighted=2900 が直接実行と一致
    if row_rp and row_impl and (row_rp["weighted"] + row_impl["weighted"]) == 2900:
        ok("F10 reconciliation: executor(E3) の全行合算weighted=2900 (直接実行と一致)")
    else:
        ng("F10 reconciliation: executor(E3) の全行合算weighted=2900",
           f"row_rp={row_rp} row_impl={row_impl}")

    # F11 (受け入れ条件1・verifier の単純ケース、体を跨がない)
    row = find_row(rows_f, "verifier", "plan", "0")
    if row and row["weighted"] == 400 and row["api_calls"] == 1:
        ok("F11 verifier plan attempt=0 (単純ケース): api_calls=1 weighted=400 (直接実行と一致)")
    else:
        ng("F11 verifier plan attempt=0 (単純ケース): api_calls=1 weighted=400", f"row={row}")

    # F12 (--model 配線): weighted×単価/1e6 と cost が一致する (sonnet: 入力単価 $3/Mtok、キャッシュ無し)
    proc_m, detail_m = run_role_phase_cost(role_phase_cost_fixture, ["--model", "sonnet"])
    row_m = find_row(detail_m.get("rows", []), "verifier", "plan", "0")
    expected_cost = 400 * 3.0 / 1_000_000
    if row_m and row_m.get("cost") is not None and abs(row_m["cost"] - expected_cost) < 1e-9:
        ok("F12 --model sonnet: verifier/plan/attempt0 の cost が weighted*3.0/1e6 と一致")
    else:
        ng("F12 --model sonnet: verifier/plan/attempt0 の cost が weighted*3.0/1e6 と一致",
           f"row_m={row_m} expected={expected_cost}")

    # F14 (bg 通知の重複行 dedup): 同一通知が queue-operation/enqueue と再表示の2行で重複出現しても、
    # 最初に出会った行の timestamp が境界に使われる。誤って後勝ちで上書きしていたら msg_extra
    # (weighted=2000) が research+plan 側に混入し 600 ではなく 2600 になる。
    row_rp14 = find_row(rows_f, "executor", "research+plan", None)
    if row_rp14 and row_rp14["weighted"] == 600:
        ok("F14 bg通知の重複行dedup: 最初に出会った行のtimestampが境界に使われる "
           "(research+plan=600。後勝ちなら2600になるはず)")
    else:
        ng("F14 bg通知の重複行dedup: 最初に出会った行のtimestampが境界に使われる", f"row={row_rp14}")

    # F15 (受け入れ条件4・0件ケース): uncountable な呼び出しが1つも無いセッションでは uncountable=0
    proc_clean, detail_clean = run_role_phase_cost(role_phase_cost_clean_fixture)
    if proc_clean.returncode == 0 and detail_clean.get("uncountable") == 0 \
            and "uncountable=0" in proc_clean.stdout:
        ok("F15 uncountable な呼び出しが無いセッションでは uncountable=0 が出る (0件でも出す)")
    else:
        ng("F15 uncountable な呼び出しが無いセッションでは uncountable=0 が出る",
           f"exit={proc_clean.returncode} uncountable={detail_clean.get('uncountable')} "
           f"stdout={proc_clean.stdout!r}")

    # --- ケース G: aggregate-role-phase-cost.py の Paseo usage ログ取り込み (gh-123) ---
    proc_g, detail_g = run_role_phase_cost(role_phase_cost_fixture, ["--paseo-usage-dir", paseo_usage_dir])
    if proc_g.returncode == 0:
        ok("G0 role-phase-cost --paseo-usage-dir: スクリプト実行 (exit 0)")
    else:
        ng("G0 role-phase-cost --paseo-usage-dir: スクリプト実行 (exit 0)",
           f"exit={proc_g.returncode} stderr={proc_g.stderr!r}")
    rows_g = detail_g.get("rows", [])

    # G1 (受け入れ条件1): Claude 側に既存バケットがある executor/implement/None への Paseo 合算。
    # claude weighted=2300 (F10) + paseo(input=1000,read=200,output=100)=1520 -> 3820。
    # api_calls は Claude 側のみ (3、不変)。agent_runs は Paseo 側のみ (1)。
    row = find_row(rows_g, "executor", "implement", None)
    if row and row["weighted"] == 3820 and row["api_calls"] == 3 and row["agent_runs"] == 1:
        ok("G1 executor/implement: Claude(2300)+Paseo(1520)=3820, api_calls=3(不変), agent_runs=1")
    else:
        ng("G1 executor/implement: Claude(2300)+Paseo(1520)=3820, api_calls=3, agent_runs=1", f"row={row}")

    # G2 (受け入れ条件1・判定点15の前提): 既存 verifier/plan/'0' への Paseo 合算。
    # claude weighted=400 (F11) + paseo(input=100,output=20)=200 -> 600。
    # bad-usage-not-dict.json / bad-attempt-type.json も同じ phase=plan attempt=1 を狙っているが
    # 両方とも拒否されるので agent_runs は 1 のまま (2 や 3 に増えない)。
    row = find_row(rows_g, "verifier", "plan", "0")
    if row and row["weighted"] == 600 and row["api_calls"] == 1 and row["agent_runs"] == 1:
        ok("G2 verifier/plan/'0': Claude(400)+Paseo(200)=600, api_calls=1, agent_runs=1 "
           "(拒否レコード2件が混入していない)")
    else:
        ng("G2 verifier/plan/'0': Claude(400)+Paseo(200)=600, api_calls=1, agent_runs=1", f"row={row}")

    # G3 (受け入れ条件1): Paseo 専用の新規バケット verifier/rebase_fix/'0' (Claude 側に対応バケット無し)。
    # api_calls はキー自体が calls に無いので 0。
    row = find_row(rows_g, "verifier", "rebase_fix", "0")
    if row and row["weighted"] == 455 and row["api_calls"] == 0 and row["agent_runs"] == 1:
        ok("G3 verifier/rebase_fix/'0' (Paseo専用の新規バケット): weighted=455, api_calls=0, agent_runs=1")
    else:
        ng("G3 verifier/rebase_fix/'0': weighted=455, api_calls=0, agent_runs=1", f"row={row}")

    # G4/G5 (判定点12・attempt_bucketマッピングの境界): attempt=2 (g4) と attempt=0 (g5, 境界値) は
    # どちらも '1+' バケットに入る (attempt==1 だけが '0')。g4(600)+g5(700)=1300, agent_runs=2。
    # g5 が誤って '0' 側 (transcript の 0-indexed 規則の取り違え) に漏れていないことも同時に検出する。
    row = find_row(rows_g, "verifier", "rebase_fix", "1+")
    if row and row["weighted"] == 1300 and row["agent_runs"] == 2:
        ok("G4/G5 verifier/rebase_fix/'1+': attempt=2,0 とも '1+' に入り weighted=1300, agent_runs=2 "
           "(attempt==1 だけが '0' になる境界を確認)")
    else:
        ng("G4/G5 verifier/rebase_fix/'1+': weighted=1300, agent_runs=2", f"row={row}")

    # Gdup (受け入れ条件2): 同一 event_id の重複ファイル (g3 の桁違いの値の複製) が二重計上されない。
    # 誤って両方採用されていれば rebase_fix/'0' の weighted が 999999 級に跳ね上がる。
    row = find_row(rows_g, "verifier", "rebase_fix", "0")
    if row and row["weighted"] < 100000:
        ok("Gdup 同一event_idの重複ファイル: 二重計上されない (rebase_fix/'0' の weighted=455 のまま)")
    else:
        ng("Gdup 同一event_idの重複ファイル: 二重計上されない", f"row={row}")

    # Gbad (受け入れ条件2): 拒否側フィクスチャ8件が uncountable に反映され、どのバケットにも漏れない。
    # 既存 F9 の uncountable=4 (Claude側) + 新規8件 (Paseo側) = 12。
    if detail_g.get("uncountable") == 12:
        ok("Gbad uncountable=12 (Claude側4 + Paseo拒否側8) が DETAIL_OUT に出る")
    else:
        ng("Gbad uncountable=12 が DETAIL_OUT に出る", f"uncountable={detail_g.get('uncountable')}")
    if "uncountable=12" in proc_g.stdout:
        ok("Gbad stdout に 'uncountable=12' が厳密一致で出る")
    else:
        ng("Gbad stdout に 'uncountable=12' が厳密一致で出る", f"stdout={proc_g.stdout!r}")

    # Gbad-leak: 拒否側フィクスチャの magic number (5555/4444/8888/222/7777/6666/333) が
    # どの行の weighted にも現れない (F5/F6 と同じ漏れ検査パターン)。
    leaked_bad = {n for n in (5555, 4444, 8888, 222, 7777, 6666, 333)
                  if any(r["weighted"] == n for r in rows_g)}
    if not leaked_bad:
        ok("Gbad-leak 拒否側フィクスチャの magic number がどの行にも漏れない")
    else:
        ng("Gbad-leak 拒否側フィクスチャの magic number がどの行にも漏れない",
           f"leaked={leaked_bad} rows={rows_g}")

    # G-agent-runs: 有効な Paseo レコード5件 (g1〜g5) 分だけ agent_runs が積み上がる (重複・拒否は含まない)。
    total_agent_runs = sum(r["agent_runs"] for r in rows_g)
    if total_agent_runs == 5:
        ok("G-agent-runs 全バケットの agent_runs 合計が5 (g1〜g5のみ、dup・拒否8件は含まない)")
    else:
        ng("G-agent-runs 全バケットの agent_runs 合計が5", f"total_agent_runs={total_agent_runs} rows={rows_g}")

    # G-cost (判定点15・要求2): --model と --paseo-usage-dir を同時指定したときの cost 合算式
    # cost = cost_of(claude_tot, model) + paseo_cost_usd (combined_tot に cost_of を通さない)。
    proc_gc, detail_gc = run_role_phase_cost(
        role_phase_cost_fixture, ["--paseo-usage-dir", paseo_usage_dir, "--model", "sonnet"])
    rows_gc = detail_gc.get("rows", [])
    row_gc1 = find_row(rows_gc, "executor", "implement", None)
    row_gc2 = find_row(rows_gc, "verifier", "plan", "0")
    expected_gc1 = 1150 * 3.0 / 1_000_000 + 230 * 15.0 / 1_000_000 + 0.05  # = 0.0069 + 0.05
    expected_gc2 = 200 * 3.0 / 1_000_000 + 40 * 15.0 / 1_000_000 + 0.01   # = 0.0012 + 0.01
    ok1 = row_gc1 and row_gc1.get("cost") is not None and abs(row_gc1["cost"] - expected_gc1) < 1e-9
    ok2 = row_gc2 and row_gc2.get("cost") is not None and abs(row_gc2["cost"] - expected_gc2) < 1e-9
    if ok1 and ok2:
        ok("G-cost --model sonnet + --paseo-usage-dir: "
           "cost = cost_of(claude_tot, model) + paseo_cost_usd (両バケットで一致)")
    else:
        ng("G-cost --model sonnet + --paseo-usage-dir: cost = cost_of(claude_tot, model) + paseo_cost_usd",
           f"row_gc1={row_gc1} expected_gc1={expected_gc1} row_gc2={row_gc2} expected_gc2={expected_gc2}")

    # 境界1b (判定点2): --paseo-usage-dir に存在しないパスを渡す (--paseo-usage-dir 未指定の短絡経路とは
    # 別コードパス、load_paseo_events 内の isdir ガードを通る)。exit 0、Paseo 側の寄与は0件、
    # 既存 Claude 側の集計 (uncountable=4, executor/implement/None の weighted=2300) は無変更。
    proc_missing, detail_missing = run_role_phase_cost(
        role_phase_cost_fixture, ["--paseo-usage-dir", paseo_usage_missing_dir])
    rows_missing = detail_missing.get("rows", [])
    row_missing = find_row(rows_missing, "executor", "implement", None)
    no_rebase_fix_bucket = not any(r["phase"] == "rebase_fix" for r in rows_missing)
    if (proc_missing.returncode == 0 and detail_missing.get("uncountable") == 4
            and row_missing and row_missing["weighted"] == 2300 and row_missing["agent_runs"] == 0
            and no_rebase_fix_bucket):
        ok("境界1b --paseo-usage-dir に存在しないパス: exit 0, uncountable=4 (無変更), "
           "Paseo由来のバケットが増えない, 既存Claude側の集計が無変更")
    else:
        ng("境界1b --paseo-usage-dir に存在しないパス: exit 0, uncountable=4 (無変更)",
           f"rc={proc_missing.returncode} uncountable={detail_missing.get('uncountable')} "
           f"row_missing={row_missing} no_rebase_fix_bucket={no_rebase_fix_bucket}")

    print()
    print(f"aggregate-scripts.test.py: pass={pass_count} fail={fail_count}")
    sys.exit(1 if fail_count else 0)


if __name__ == "__main__":
    main()
