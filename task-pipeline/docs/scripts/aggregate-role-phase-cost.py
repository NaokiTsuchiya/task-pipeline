#!/usr/bin/env python3
"""セッション transcript から、役割 (role) × フェーズ (phase) × attempt 別の課金換算コストを出す。

既存の集計スクリプト2本を無改変でモジュールとして読み込み、それぞれの責務をそのまま再利用する:

  - aggregate-session-usage.py:  classify_prompt (役割分類) / verifier_phase (フェーズ抽出) /
                                  executor_phase_from_result (フェーズ抽出) / NOTIF_RE / USAGE_SYNC_RE /
                                  AGENTID_RE
  - aggregate-orchestrator-usage.py: collect(path, until) (体 1 つの transcript を message.id
                                  重複排除して集計する中核関数) / PRICES / CACHE_WRITE_MULT /
                                  CACHE_READ_MULT

新たに解く問題は「同じ体 (agentId) が複数回に分けて何かをする」ケースの按分である:

  - verifier は FAIL 後の再検証を `SendMessage` で**同じ agentId** に対して行うことがある
    (`docs/verifier-reuse-2026-08.md`)。同じ transcript ファイルに全 attempt が追記される。
  - executor は全フェーズ (research+plan → ... → report/pr_fix) を通して**同じ agentId**
    (長命バックグラウンドエージェント) が担当し、同一フェーズの FAIL→再修正でも同じ agentId が
    再度 `PHASE X DONE` を送る。

正しく按分するため、体 (agentId) ごとにイベント (停止レポート) を時系列に並べ、隣接する境界の
timestamp で `collect(path, until=T)` を呼んで差分を取る (`docs/verifier-reuse-2026-08.md` §3.1 の
「フレッシュアームの再検証1回 = transcript全体。再開アームの再検証1回 = 全体 − --until <再開直前の
UTC時刻>」という実測済みの手法をそのまま一般化したもの)。N=1 (体を跨がない単純な呼び出し) では
`collect(path, until=None)` を1回呼ぶだけになり、直接 `aggregate-orchestrator-usage.py <その体の
transcript>` を実行した値と厳密に一致する。

**整合性の確認手順**: 出力の1行のうち、同じ体から複数セグメントに分かれていない行 (attempt が
1回しか出現しない verifier、フェーズが1回しか出現しない executor、adapter/triage/pr-watcher の
通常呼び出し) は、その体の transcript (`<セッションディレクトリ>/subagents/agent-<agentId>.jsonl`)
に `aggregate-orchestrator-usage.py` を直接通して得た `weighted` と一致する。体を跨いだ行は、
同じ体の行をすべて合算した値が直接実行の値と一致する。同じ手順は
`task-pipeline/docs/cost-analysis-2026-07.md` §9 にも書いてある。

使い方:
  aggregate-role-phase-cost.py <session.jsonl> [--model fable|opus|sonnet|sonnet-intro|haiku]
                                                [--paseo-usage-dir DIR]

  --paseo-usage-dir に `.task-pipeline/runs/<id>/usage/paseo/` 相当のディレクトリ (Paseo 経路の
  executor/verifier invocation ごとの usage JSON 群、`playbooks/agent-launch.md` の
  「Paseo invocation の usage 採取」節のスキーマ) を渡すと、Claude Code transcript 側の集計へ
  役割×フェーズ×attempt バケットごとに合算する。渡さない、またはディレクトリが存在しなければ
  Paseo 側の寄与は 0 件になるだけで、transcript 単体の集計は従来どおり。

出力:
  役割×フェーズ [×verifier の attempt バケット (0 / 1+)] ごとに1行:
    role=<role> phase=<phase|-> attempt=<0|1+|-> api_calls=<n> agent_runs=<n> processed=<n>
    weighted=<n> output=<n>
  (--model を渡すと ` cost=$<n.nnnn> (<model>)` を追記する)
  `api_calls` は Claude Code transcript 側の message.id 重複排除済み API コール数のみ、
  `agent_runs` は Paseo 側の invocation (1 usage JSON = 1 run/send) 件数のみ — 粒度が異なるので
  混同しない。`weighted`/`processed`/`output`/`input`/`cache_*` は両ソースの合算値。`cost` は
  Claude 側 (`--model` 換算) と Paseo 側 (`usage.cost_usd`、provider 実額) の合算 —
  Paseo のトークンを `--model` 単価で再換算することはしない。
  最後に必ず `uncountable=<n>` の行を出す (0件でも出す) —
  役割・フェーズ・attempt が解決できなかった、agentId が取れなかった、transcript ファイルが
  見つからなかった呼び出し、および Paseo usage JSON の読み込み・スキーマ検証に失敗した記録の
  件数 (集計から黙って落とさない)。

  環境変数 DETAIL_OUT にパスを渡すと、行の内訳を JSON で書き出す
  (`{"rows": [...], "uncountable": <n>}`。テストが数値を厳密に検証する手段)。
"""
import importlib.util
import json
import os
import re
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_module(name, filename):
    path = os.path.join(_SCRIPT_DIR, filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_session = _load_module('_agg_session_usage', 'aggregate-session-usage.py')
_orch = _load_module('_agg_orchestrator_usage', 'aggregate-orchestrator-usage.py')

classify_prompt = _session.classify_prompt
verifier_phase = _session.verifier_phase
executor_phase_from_result = _session.executor_phase_from_result
NOTIF_RE = _session.NOTIF_RE
USAGE_SYNC_RE = _session.USAGE_SYNC_RE
AGENTID_RE = _session.AGENTID_RE

collect = _orch.collect
PRICES = _orch.PRICES
CACHE_WRITE_MULT = _orch.CACHE_WRITE_MULT
CACHE_READ_MULT = _orch.CACHE_READ_MULT

VERDICT_PATH_RE = re.compile(r'verdict path:\s*(\S+)')
# collect-task-metrics.py の FAIL_ATTEMPT_RE と同じ意味論 (ファイル名末尾の attempt 数字)。
ATTEMPT_RE = re.compile(r'-(\d+)\.json$')
PASEO_ROLES = ('executor', 'verifier')


def _parse_paseo_record(rec):
    """Paseo usage JSON 1件を検証し、有効なら
    {'event_id','role','phase','attempt_bucket','input','read','output','cost_usd'} を返す。
    どこかで失敗したら None (呼び出し側で uncountable を数える)。
    `playbooks/agent-launch.md` の「Paseo invocation の usage 採取」節のスキーマに従う。
    """
    if not isinstance(rec, dict):
        return None
    if rec.get('schema_version') != 1:
        return None
    event_id = rec.get('event_id')
    if not event_id or not isinstance(event_id, str):
        return None
    role = rec.get('role')
    if role not in PASEO_ROLES:
        return None
    if rec.get('usage_available') is not True:
        return None
    usage = rec.get('usage')
    if not isinstance(usage, dict):
        return None
    try:
        input_tokens = int(usage.get('input_tokens', 0) or 0)
        cached_tokens = int(usage.get('cached_input_tokens', 0) or 0)
        output_tokens = int(usage.get('output_tokens', 0) or 0)
        cost_usd = float(usage.get('cost_usd'))
    except (TypeError, ValueError):
        return None

    attempt_bucket = None
    if role == 'verifier':
        attempt = rec.get('attempt')
        if not isinstance(attempt, int) or isinstance(attempt, bool):
            return None
        # Paseo の attempt は tasks[].gate.attempts 起点 (ラウンド開始前の値+1) で
        # 初回検証が 1 になる 1-indexed 規則 — transcript 側 ATTEMPT_RE の 0-indexed
        # (初回 verdict-0.json → attempt=0) とは食い違うため、ここでマッピングし直す。
        attempt_bucket = '0' if attempt == 1 else '1+'

    return {'event_id': event_id, 'role': role, 'phase': rec.get('phase'),
            'attempt_bucket': attempt_bucket, 'input': input_tokens,
            'read': cached_tokens, 'output': output_tokens, 'cost_usd': cost_usd}


def load_paseo_events(paseo_dir):
    """`.task-pipeline/runs/<id>/usage/paseo/` 相当のディレクトリを読み、
    (rows, uncountable) を返す。rows は _parse_paseo_record が返す dict のリスト
    (event_id 重複は除去済み)。ディレクトリが無ければ ([], 0)。
    """
    if not os.path.isdir(paseo_dir):
        return [], 0
    seen_event_ids = set()
    rows = []
    uncountable = 0
    for name in sorted(os.listdir(paseo_dir)):
        path = os.path.join(paseo_dir, name)
        if not (name.endswith('.json') and os.path.isfile(path)):
            continue
        try:
            with open(path) as fh:
                rec = json.load(fh)
        except (ValueError, OSError):
            uncountable += 1
            continue
        row = _parse_paseo_record(rec)
        if row is None:
            uncountable += 1
            continue
        if row['event_id'] in seen_event_ids:
            continue  # 上書き保存の冪等な再読み込み。二重計上しない。
        seen_event_ids.add(row['event_id'])
        rows.append(row)
    return rows, uncountable


def weighted_of(tot):
    return (tot['input']
            + tot['create_1h'] * CACHE_WRITE_MULT['1h']
            + tot['create_5m'] * CACHE_WRITE_MULT['5m']
            + tot['read'] * CACHE_READ_MULT
            + tot['output'] * 5.0)


def cost_of(tot, model):
    p_in, p_out = PRICES[model]
    return (tot['input'] * p_in
            + tot['create_1h'] * p_in * CACHE_WRITE_MULT['1h']
            + tot['create_5m'] * p_in * CACHE_WRITE_MULT['5m']
            + tot['read'] * p_in * CACHE_READ_MULT
            + tot['output'] * p_out) / 1_000_000


def _empty_tot():
    return {'input': 0, 'create_1h': 0, 'create_5m': 0, 'read': 0, 'output': 0}


def _sub_tot(a, b):
    return {k: a[k] - b[k] for k in a}


def _add_tot(a, b):
    for k in a:
        a[k] += b[k]


def collect_launches(lines):
    """type=='assistant' の tool_use から tu_id -> {'text','kind'} を組み立てる。

    'kind' は 'launch' (Agent/Task, フレッシュ起動) または 'resume' (SendMessage, 再開)。
    テキストは切り詰めない (verdict path が長い絶対パスのことがあるため —
    aggregate-session-usage.py の sendmsg dict の200字切り詰めは踏襲しない)。
    """
    launches = {}
    for line in lines:
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get('type') != 'assistant':
            continue
        cont = j.get('message', {}).get('content')
        if not isinstance(cont, list):
            continue
        for c in cont:
            if not (isinstance(c, dict) and c.get('type') == 'tool_use'):
                continue
            name = c.get('name', '')
            inp = c.get('input', {}) or {}
            tu_id = c.get('id')
            if name in ('Agent', 'Task'):
                launches[tu_id] = {'text': inp.get('prompt', '') or '', 'kind': 'launch'}
            elif name == 'SendMessage':
                text = inp.get('message') or inp.get('summary') or ''
                launches[tu_id] = {'text': text, 'kind': 'resume'}
    return launches


def collect_stop_events(lines):
    """背景通知・同期停止レポートを、ファイル出現順 (=時系列順) のイベント列にする。

    各イベント: {'tu_id','agent_id'(無ければ None),'ts'(無ければ None),'result_text'}。

    背景通知は同一内容が複数行型 (queue-operation/enqueue, その再表示等) で重複することがある
    (aggregate-session-usage.py の NOTIF_RE.finditer(line) が「行の json type を問わず」全行を
    生テキスト走査するのと同じ理由)。(task_id, tu_id, tok, ms) を dedup key にし、**最初に出会った
    行の timestamp** を採用する (再表示は enqueue より後に現れる前提)。行が JSON として読めない、
    または timestamp フィールドが無ければ ts=None のまま (このイベントは後段の体グルーピングで
    ts が無いと並べ替えられないため、実質 uncountable に落ちる)。
    """
    events = []
    seen_bg = set()  # 既に処理した dedup key (2回目以降の出現は無視する)
    for line in lines:
        try:
            j = json.loads(line)
        except ValueError:
            j = None
        line_ts = j.get('timestamp') if isinstance(j, dict) else None

        for m in NOTIF_RE.finditer(line):
            task_id, tu_id, tok, tools, ms = (
                m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))
            key = (task_id, tu_id, tok, ms)
            if key in seen_bg:
                continue  # 2回目以降の出現は timestamp を含め無視する (最初の行が勝つ)
            seen_bg.add(key)
            blob = line[m.start():m.end() + 2000]
            rm = re.search(r'<result>(.*?)</result>', blob, re.S)
            result_text = rm.group(1) if rm else ''
            events.append({'tu_id': tu_id, 'agent_id': task_id,
                            'ts': line_ts, 'result_text': result_text})

        if not isinstance(j, dict) or j.get('type') != 'user':
            continue
        cont = j.get('message', {}).get('content')
        if not isinstance(cont, list):
            continue
        for c in cont:
            if not (isinstance(c, dict) and c.get('type') == 'tool_result'):
                continue
            tu_id = c.get('tool_use_id')
            cc = c.get('content')
            if isinstance(cc, list):
                texts = [x.get('text', '') for x in cc if isinstance(x, dict) and x.get('type') == 'text']
            elif isinstance(cc, str):
                texts = [cc]
            else:
                texts = []
            joined = '\n'.join(texts)
            if not USAGE_SYNC_RE.search(joined):
                continue
            am = AGENTID_RE.search(joined)
            events.append({'tu_id': tu_id, 'agent_id': am.group(1) if am else None,
                            'ts': line_ts, 'result_text': joined})
    return events


def resolve_events(events, launches):
    """各イベントの役割・フェーズ・attempt を解決する。ファイル出現順 (events は既にその順) に処理し、
    体 (agent_id) ごとに最初に解決できた役割を agent_role へ記録して以降のイベントへ伝播する
    (SendMessage 再開のテキストは classify_prompt のマーカー文字列を一切含まないため)。

    戻り値: (resolved, uncountable_count)。resolved の各要素は
    {'agent_id','ts','role','phase','attempt_bucket'(verifier のときだけ非None)}。
    """
    agent_role = {}
    resolved = []
    uncountable = 0

    for ev in events:
        launch = launches.get(ev['tu_id'])

        role = None
        if launch and launch['kind'] == 'launch':
            role = classify_prompt(launch['text'])
            if ev['agent_id'] is not None:
                agent_role[ev['agent_id']] = role
        elif ev['agent_id'] is not None:
            role = agent_role.get(ev['agent_id'])

        if ev['agent_id'] is None or ev['ts'] is None or role is None:
            uncountable += 1
            continue

        if role == 'executor':
            phase = executor_phase_from_result(ev['result_text'])
        elif role == 'verifier':
            phase = verifier_phase(launch['text']) if launch else '?'
        else:
            phase = None

        attempt_bucket = None
        if role == 'verifier':
            if not launch:
                uncountable += 1
                continue
            vm = VERDICT_PATH_RE.search(launch['text'])
            if not vm:
                uncountable += 1
                continue
            basename = os.path.basename(vm.group(1))
            am = ATTEMPT_RE.search(basename)
            if not am:
                uncountable += 1
                continue
            attempt = int(am.group(1))
            attempt_bucket = '0' if attempt == 0 else '1+'

        resolved.append({'agent_id': ev['agent_id'], 'ts': ev['ts'], 'role': role,
                          'phase': phase, 'attempt_bucket': attempt_bucket})

    return resolved, uncountable


def compute_rows(resolved, session_dir):
    """体ごとに時系列でセグメント境界を作り、collect(until=T) の差分で weighted の按分を出す。"""
    by_agent = {}
    for r in resolved:
        by_agent.setdefault(r['agent_id'], []).append(r)

    buckets = {}  # (role, phase, attempt_bucket) -> tot dict (累積)
    calls = {}    # 同じキー -> api_calls 累積
    uncountable = 0

    for agent_id, group in by_agent.items():
        group.sort(key=lambda r: r['ts'])
        subagent_path = os.path.join(session_dir, 'subagents', f'agent-{agent_id}.jsonl')
        if not os.path.exists(subagent_path):
            uncountable += len(group)
            continue

        n = len(group)
        cumulative = []
        for i in range(n):
            until = None if i == n - 1 else group[i]['ts']
            c, t = collect(subagent_path, until)
            cumulative.append((c, t))

        prev_c, prev_t = 0, _empty_tot()
        for i in range(n):
            c, t = cumulative[i]
            seg_c = c - prev_c
            seg_t = _sub_tot(t, prev_t)
            prev_c, prev_t = c, t

            key = (group[i]['role'], group[i]['phase'], group[i]['attempt_bucket'])
            if key not in buckets:
                buckets[key] = _empty_tot()
                calls[key] = 0
            _add_tot(buckets[key], seg_t)
            calls[key] += seg_c

    return buckets, calls, uncountable


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: aggregate-role-phase-cost.py <session.jsonl> '
                  '[--model M] [--paseo-usage-dir DIR]')
    path = sys.argv[1]
    model = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else None
    if model and model not in PRICES:
        sys.exit(f"unknown model: {model} (choose from {', '.join(PRICES)})")
    paseo_dir = (sys.argv[sys.argv.index('--paseo-usage-dir') + 1]
                 if '--paseo-usage-dir' in sys.argv else None)

    with open(path) as fh:
        lines = fh.readlines()

    session_dir = path[:-len('.jsonl')] if path.endswith('.jsonl') else path

    launches = collect_launches(lines)
    events = collect_stop_events(lines)
    resolved, uncountable_resolve = resolve_events(events, launches)
    buckets, calls, uncountable_missing = compute_rows(resolved, session_dir)

    paseo_rows, uncountable_paseo = load_paseo_events(paseo_dir) if paseo_dir else ([], 0)
    paseo_buckets = {}   # (role, phase, attempt_bucket) -> tot dict (Paseo 側のみ)
    paseo_agent_runs = {}
    paseo_cost = {}
    for r in paseo_rows:
        key = (r['role'], r['phase'], r['attempt_bucket'])
        if key not in paseo_buckets:
            paseo_buckets[key] = _empty_tot()
            paseo_agent_runs[key] = 0
            paseo_cost[key] = 0.0
        paseo_buckets[key]['input'] += r['input']
        paseo_buckets[key]['read'] += r['read']
        paseo_buckets[key]['output'] += r['output']
        paseo_agent_runs[key] += 1
        paseo_cost[key] += r['cost_usd']

    uncountable = uncountable_resolve + uncountable_missing + uncountable_paseo

    rows = []
    all_keys = set(buckets) | set(paseo_buckets)
    for key in sorted(all_keys, key=lambda k: (k[0] or '', k[1] or '', k[2] or '')):
        role, phase, attempt_bucket = key
        claude_tot = buckets.get(key, _empty_tot())
        combined_tot = _empty_tot()
        _add_tot(combined_tot, claude_tot)
        _add_tot(combined_tot, paseo_buckets.get(key, _empty_tot()))
        processed = (combined_tot['input'] + combined_tot['create_1h']
                     + combined_tot['create_5m'] + combined_tot['read']
                     + combined_tot['output'])
        weighted = weighted_of(combined_tot)
        paseo_cost_usd = paseo_cost.get(key, 0.0)
        row = {
            'role': role, 'phase': phase, 'attempt_bucket': attempt_bucket,
            'api_calls': calls.get(key, 0), 'agent_runs': paseo_agent_runs.get(key, 0),
            'processed': processed, 'weighted': weighted,
            'output': combined_tot['output'], 'input': combined_tot['input'],
            'cache_write_1h': combined_tot['create_1h'], 'cache_write_5m': combined_tot['create_5m'],
            'cache_read': combined_tot['read'], 'paseo_cost_usd': paseo_cost_usd,
        }
        if model:
            row['cost'] = cost_of(claude_tot, model) + paseo_cost_usd
        rows.append(row)

    for row in rows:
        line = (f"role={row['role']} phase={row['phase'] if row['phase'] is not None else '-'} "
                f"attempt={row['attempt_bucket'] if row['attempt_bucket'] is not None else '-'} "
                f"api_calls={row['api_calls']} agent_runs={row['agent_runs']} "
                f"processed={row['processed']:,} "
                f"weighted={row['weighted']:,.0f} output={row['output']:,}")
        if model:
            line += f" cost=${row['cost']:.4f} ({model})"
        print(line)
    print(f"uncountable={uncountable}")

    detail_out = os.environ.get('DETAIL_OUT')
    if detail_out:
        with open(detail_out, 'w') as fh:
            json.dump({'rows': rows, 'uncountable': uncountable}, fh, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
