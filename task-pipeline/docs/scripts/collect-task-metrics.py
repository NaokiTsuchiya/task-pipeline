#!/usr/bin/env python3
"""task-pipeline のタスク単位メトリクスをセッション transcript から抽出し、
~/.claude/task-pipeline/metrics.jsonl に追記する (repo 横断・増分収集)。

1 行 = 1 タスク実行 (バックグラウンド executor の 1 agentId)。
  repo            リポジトリ名 (cwd から抽出)
  session         セッション jsonl のファイル名
  task_id         executor の agentId (background task-id)
  task            タスク slug (runs/<slug>/ から抽出)
  model           そのタスクの Agent 起動時に指定されたモデル (省略時はセッションの既定モデル、宣言値)
  model_actual    <session_dir>/subagents/agent-<task_id>.jsonl から読んだ実測モデル一覧
                   (途中でエスカレーションしていれば複数。ファイルが無ければ null)
  effort          同ファイルから読んだ reasoning effort 一覧 (無ければ null)
  finish_mode     'pr' (PR URL を検出) / 'commit' (コミットハッシュのみ) / 'unknown'
  outcome         'finalized' / 'blocked' / 'in_progress'
  start_ts        research (または最初のフェーズ) 起動時刻
  end_ts          最初の FINALIZED (= PR 作成 or コミット) 時刻。無ければ最後のイベント時刻
  elapsed_seconds start_ts -> end_ts の経過秒 (outcome=finalized のときのみ意味を持つ)
  phase_counts    フェーズ名 -> 出現回数 (2以上は手戻り・リトライ)
  tokens          このタスクの全フェーズ合計 subagent_tokens (停止時コンテキストサイズの合計、処理総量ではない)
  tokens_processed subagent transcript を message.id 重複排除して積み上げた実処理量。ファイルが無ければ null
  pr_url          finish_mode=pr のときの PR URL
  blocked_events  BLOCKED / SECURITY WARNING を含むイベントの (phase, timestamp, snippet) 一覧
  executor_seconds    start_ts〜end_ts の間、executor 自身が処理していた秒数の合計 (duration_ms 合計)
  verifier_seconds    同じ区間で "Verify ... <slug> ..." 系の検証サブエージェントが処理していた秒数の合計
  verifier_count      上記の検証呼び出し回数
  orchestrator_overhead_seconds  elapsed_seconds - executor_seconds - verifier_seconds
                       (オーケストレーターが通知を受けて次のサブエージェントを判断・起動するまでの折り返し時間)
  diff_title      finish_mode=pr なら PR タイトル、commit ならコミットの一行目 (無ければ null)
  diff_files_changed / diff_insertions / diff_deletions
                  実際の変更規模。pr は `gh pr view --json`、commit はローカル `git show --stat` から取得
                  (対象コミット/PRが見つからない・オフライン等で失敗したら null のまま)

使い方:
  collect-task-metrics.py <session.jsonl> [<session.jsonl> ...] [--out PATH] [--dry-run] [--no-diff-stats]

  相対パスは ~/.claude/projects/ 起点。--out 省略時は ~/.claude/task-pipeline/metrics.jsonl。
  同じ (session, task_id) は既存ファイルにあればスキップする (増分収集・再実行安全)。
  --no-diff-stats を付けると git show / gh pr view を呼ばない (オフライン・高速収集したいとき用)。
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime

DEFAULT_OUT = os.path.expanduser('~/.claude/task-pipeline/metrics.jsonl')
PROJECTS_BASE = os.path.expanduser('~/.claude/projects')

NOTIF_RE = re.compile(
    r'<task-notification>.*?<task-id>([^<]+)</task-id>.*?<tool-use-id>([^<]+)</tool-use-id>'
    r'.*?<result>(.*?)</result>\s*<usage><subagent_tokens>(\d+)</subagent_tokens>'
    r'<tool_uses>(\d+)</tool_uses><duration_ms>(\d+)</duration_ms></usage>', re.S)
USAGE_SYNC_RE = re.compile(r'subagent_tokens:\s*(\d+)\ntool_uses:\s*(\d+)\nduration_ms:\s*(\d+)')
SLUG_RE = re.compile(r'runs/([a-zA-Z0-9_.-]+)/')
PHASE_RE = re.compile(r'PHASE\s+(\w+(?:\+\w+)*)\s+DONE')
PR_URL_RE = re.compile(r'(https://github\.com/[^\s)"\']+/pull/\d+)')
COMMIT_RE = re.compile(r'FINALIZED\s*—\s*([0-9a-f]{7,40})\b')
REPO_RE = re.compile(r'github\.com/[^/]+/([^/]+)')
SECURITY_RE = re.compile(r'SECURITY WARNING|BLOCKED')


def repo_of(cwd):
    if not cwd:
        return None
    m = REPO_RE.search(cwd)
    return m.group(1) if m else os.path.basename(cwd)


REPO_ROOT_RE = re.compile(r'(.*?/github\.com/[^/]+/[^/]+)')
STAT_LINE_RE = re.compile(
    r'(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?')


def repo_root_of(cwd):
    """cwd (worktree の中の可能性あり) から <...>/github.com/<owner>/<repo> のルートを取り出す。

    task-pipeline は worktree 上で実行されるが、merge 後に worktree 自体は消えていることが多い。
    その場合でもメインチェックアウト (owner/repo 直下) には commit が残っているはずなのでそちらを見る。
    """
    if not cwd:
        return None
    m = REPO_ROOT_RE.match(cwd)
    return m.group(1) if m else None


def diff_stats_for_commit(repo_root, commit):
    if not repo_root or not commit or not os.path.isdir(repo_root):
        return None
    try:
        out = subprocess.run(
            ['git', '-C', repo_root, 'show', '--stat', '--format=%s', commit],
            capture_output=True, text=True, timeout=15, check=True).stdout
    except Exception:
        return None
    lines = [l for l in out.splitlines() if l.strip()]
    if not lines:
        return None
    sm = STAT_LINE_RE.search(lines[-1])
    return {
        'title': lines[0],
        'files_changed': int(sm.group(1)) if sm else None,
        'insertions': int(sm.group(2) or 0) if sm else None,
        'deletions': int(sm.group(3) or 0) if sm else None,
    }


def diff_stats_for_pr(pr_url):
    if not pr_url:
        return None
    try:
        out = subprocess.run(
            ['gh', 'pr', 'view', pr_url, '--json', 'title,additions,deletions,changedFiles'],
            capture_output=True, text=True, timeout=20, check=True).stdout
        d = json.loads(out)
    except Exception:
        return None
    return {
        'title': d.get('title'),
        'files_changed': d.get('changedFiles'),
        'insertions': d.get('additions'),
        'deletions': d.get('deletions'),
    }


def read_subagent_transcript(session_dir, task_id):
    """<session_dir>/subagents/agent-<task_id>.jsonl から実測モデル・effort・処理トークンを読む。

    バックグラウンド executor はここに自分専用の transcript を持つ (long-lived executor が
    SendMessage で再開されても同じ agentId=ファイルに追記される)。無ければ None を返す —
    adapter/triage 等の補助呼び出しや、古い形式のセッションでは存在しないことがある。
    """
    p = os.path.join(session_dir, 'subagents', f'agent-{task_id}.jsonl')
    if not os.path.exists(p):
        return None
    models, efforts = set(), set()
    per_msg = {}  # message.id -> usage (重複排除。1 API コールが複数行に転記されるため)
    with open(p) as fh:
        for line in fh:
            try:
                j = json.loads(line)
            except Exception:
                continue
            if j.get('type') != 'assistant':
                continue
            msg = j.get('message', {})
            if msg.get('model'):
                models.add(msg['model'])
            if j.get('effort'):
                efforts.add(j['effort'])
            usage, mid = msg.get('usage'), msg.get('id')
            if usage and mid:
                prev = per_msg.get(mid)
                if prev is None or usage.get('output_tokens', 0) >= prev.get('output_tokens', 0):
                    per_msg[mid] = usage
    processed = 0
    for u in per_msg.values():
        processed += u.get('input_tokens', 0) + u.get('output_tokens', 0) + u.get('cache_read_input_tokens', 0)
        cc = u.get('cache_creation') or {}
        processed += cc.get('ephemeral_1h_input_tokens', 0) + cc.get('ephemeral_5m_input_tokens', 0)
        processed += 0 if cc else u.get('cache_creation_input_tokens', 0)
    return {
        'models': sorted(models),
        'efforts': sorted(efforts),
        'processed_tokens': processed,
    }


def process(path, fetch_diff_stats=True):
    session_model = None
    launch_ts = {}      # tool_use_id -> timestamp
    launch_model = {}   # tool_use_id -> explicit model override (or None)
    cwd = None
    events = defaultdict(list)  # task_id -> [(ts, tu_id, result, tokens, duration_ms)]
    sync_launches = []   # (tool_use_id, ts, description) for non-background Agent/Task calls
    sync_results = {}    # tool_use_id -> (result_ts, duration_ms)

    raw_chunks = []
    with open(path) as fh:
        for line in fh:
            raw_chunks.append(line)
            try:
                j = json.loads(line)
            except Exception:
                continue
            if j.get('type') == 'assistant':
                if cwd is None:
                    cwd = j.get('cwd')
                msg = j.get('message', {})
                if session_model is None and msg.get('model'):
                    session_model = msg['model']
                cont = msg.get('content')
                if isinstance(cont, list):
                    for c in cont:
                        if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') in ('Agent', 'Task'):
                            inp = c.get('input', {}) or {}
                            # run_in_background は省略/null で背景実行される個体もある (セッションにより
                            # 挙動が違う)。ここではフラグを問わず全 Agent/Task 呼び出しの起動時刻を
                            # 記録しておき、実際に task-notification の tool-use-id と一致したものだけを
                            # 後段で「そのタスクの起動」として使う (誤検出の余地はない: tool_use id は一意)。
                            launch_ts[c['id']] = j.get('timestamp')
                            launch_model[c['id']] = inp.get('model')
                            desc = inp.get('description') or (inp.get('prompt') or '')[:80]
                            sync_launches.append((c['id'], j.get('timestamp'), desc))
            elif j.get('type') == 'queue-operation' and j.get('operation') == 'enqueue':
                m = NOTIF_RE.search(j.get('content', ''))
                if m:
                    task_id, tu_id, result, tok, dur = m.group(1), m.group(2), m.group(3), int(m.group(4)), int(m.group(6))
                    events[task_id].append((j.get('timestamp'), tu_id, result, tok, dur))
            elif j.get('type') == 'user':
                msg = j.get('message', {})
                cont = msg.get('content')
                if isinstance(cont, list):
                    for c in cont:
                        if isinstance(c, dict) and c.get('type') == 'tool_result':
                            cc = c.get('content')
                            texts = ([x.get('text', '') for x in cc if isinstance(x, dict) and x.get('type') == 'text']
                                     if isinstance(cc, list) else ([cc] if isinstance(cc, str) else []))
                            um = USAGE_SYNC_RE.search('\n'.join(texts))
                            if um:
                                sync_results[c.get('tool_use_id')] = (j.get('timestamp'), int(um.group(3)))

    raw_text = ''.join(raw_chunks)

    rows = []
    for task_id, evs in events.items():
        evs.sort(key=lambda e: e[0])
        slug = None
        for _, _, result, _, _ in evs:
            sm = SLUG_RE.search(result)
            if sm:
                slug = sm.group(1)
                break
        if slug is None:
            # 補助サブエージェント (依存昇格スキャン等) — タスク実行そのものではないので除外
            continue
        start_ts = None
        model = None
        for _, tu_id, _, _, _ in evs:
            if tu_id in launch_ts:
                start_ts = launch_ts[tu_id]
                model = launch_model[tu_id]
                break
        if start_ts is None:
            start_ts = evs[0][0]
        model = model or session_model

        phase_counts = defaultdict(int)
        tokens = 0
        executor_ms = 0
        end_ts = evs[-1][0]
        outcome = 'in_progress'
        pr_url = None
        commit = None
        blocked_events = []
        finalized_ts = None
        for ts, _, result, tok, dur in evs:
            if finalized_ts is None:
                # start_ts〜最初の FINALIZED までの区間だけを「PR作成までの実作業時間」として数える
                executor_ms += dur
            tokens += tok
            pm = PHASE_RE.search(result)
            if pm:
                phase_counts[pm.group(1)] += 1
            if SECURITY_RE.search(result):
                blocked_events.append({'ts': ts, 'snippet': result[:200].replace('\n', ' ')})
            if 'FINALIZED' in result and finalized_ts is None:
                finalized_ts = ts
                outcome = 'finalized'
                um = PR_URL_RE.search(result)
                cm = COMMIT_RE.search(result)
                pr_url = um.group(1) if um else None
                commit = cm.group(1) if (cm and not um) else None
        if outcome != 'finalized' and any('BLOCKED' in r for _, _, r, _, _ in evs):
            outcome = 'blocked'
        elif outcome == 'in_progress':
            # executor 自身の notification に BLOCKED が出ない場合でも、tracker adapter が
            # 別のサブエージェント呼び出しでタスクを blocked としてマークしていることがある
            # (例: markdown adapter の状態更新)。slug 近傍の "blocked" 言及で拾う。
            if re.search(re.escape(slug) + r'[^\n]{0,40}blocked', raw_text, re.I):
                outcome = 'blocked (adapter-reported)'

        finish_mode = 'pr' if pr_url else ('commit' if commit else 'unknown')
        stop_ts = finalized_ts or end_ts
        elapsed = None
        try:
            elapsed = (datetime.fromisoformat(stop_ts.replace('Z', '+00:00'))
                       - datetime.fromisoformat(start_ts.replace('Z', '+00:00'))).total_seconds()
        except Exception:
            pass

        # start_ts〜stop_ts の間に、slug を含み "verify" と言及するサブエージェント呼び出しを
        # 検証コストとして拾う (フェーズごとの独立検証。SKILL.md の phase-gate 設計)
        verifier_ms = 0
        verifier_count = 0
        try:
            lo = datetime.fromisoformat(start_ts.replace('Z', '+00:00'))
            hi = datetime.fromisoformat(stop_ts.replace('Z', '+00:00'))
            slug_re = re.compile(re.escape(slug), re.I)
            for tu_id, launch_ts_str, desc in sync_launches:
                if not (slug_re.search(desc) and re.search(r'verif', desc, re.I)):
                    continue
                try:
                    lt = datetime.fromisoformat(launch_ts_str.replace('Z', '+00:00'))
                except Exception:
                    continue
                if not (lo <= lt <= hi):
                    continue
                res = sync_results.get(tu_id)
                if res:
                    verifier_ms += res[1]
                    verifier_count += 1
        except Exception:
            pass

        executor_seconds = executor_ms / 1000
        verifier_seconds = verifier_ms / 1000
        orchestrator_overhead_seconds = (
            elapsed - executor_seconds - verifier_seconds if elapsed is not None else None)

        session_dir = path[:-len('.jsonl')] if path.endswith('.jsonl') else path
        sub = read_subagent_transcript(session_dir, task_id)

        diff = None
        if fetch_diff_stats:
            if finish_mode == 'pr':
                diff = diff_stats_for_pr(pr_url)
            elif finish_mode == 'commit':
                diff = diff_stats_for_commit(repo_root_of(cwd), commit)

        rows.append({
            'repo': repo_of(cwd),
            'session': os.path.basename(path),
            'task_id': task_id,
            'task': slug,
            'model': model,
            'model_actual': sub['models'] if sub else None,
            'effort': sub['efforts'] if sub else None,
            'finish_mode': finish_mode,
            'outcome': outcome,
            'start_ts': start_ts,
            'end_ts': stop_ts,
            'elapsed_seconds': elapsed,
            'executor_seconds': executor_seconds,
            'verifier_seconds': verifier_seconds,
            'verifier_count': verifier_count,
            'orchestrator_overhead_seconds': orchestrator_overhead_seconds,
            'phase_counts': dict(phase_counts),
            'tokens': tokens,
            'tokens_processed': sub['processed_tokens'] if sub else None,
            'pr_url': pr_url,
            'commit': commit,
            'blocked_events': blocked_events,
            'diff_title': diff['title'] if diff else None,
            'diff_files_changed': diff['files_changed'] if diff else None,
            'diff_insertions': diff['insertions'] if diff else None,
            'diff_deletions': diff['deletions'] if diff else None,
        })
    return rows


def main():
    args = sys.argv[1:]
    out = DEFAULT_OUT
    dry_run = False
    fetch_diff_stats = True
    files = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--out':
            i += 1
            out = args[i]
        elif a == '--dry-run':
            dry_run = True
        elif a == '--no-diff-stats':
            fetch_diff_stats = False
        else:
            files.append(a)
        i += 1

    if not files:
        sys.exit('usage: collect-task-metrics.py <session.jsonl> [...] [--out PATH] [--dry-run] [--no-diff-stats]')

    existing_keys = set()
    if os.path.exists(out):
        with open(out) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                existing_keys.add((r.get('session'), r.get('task_id')))

    new_rows = []
    for f in files:
        p = f if os.path.isabs(f) else os.path.join(PROJECTS_BASE, f)
        for row in process(p, fetch_diff_stats=fetch_diff_stats):
            key = (row['session'], row['task_id'])
            if key in existing_keys:
                continue
            existing_keys.add(key)
            new_rows.append(row)

    print(f"{len(new_rows)} new task-run(s) collected from {len(files)} session file(s)")
    for r in new_rows:
        task = r['task'] or '(no-slug)'
        model = ','.join(r['model_actual']) if r.get('model_actual') else (r['model'] or '?')
        elapsed = round(r['elapsed_seconds'] / 60, 1) if r['elapsed_seconds'] is not None else None
        ex = round(r['executor_seconds'] / 60, 1)
        vf = round(r['verifier_seconds'] / 60, 1)
        oh = (round(r['orchestrator_overhead_seconds'] / 60, 1)
              if r.get('orchestrator_overhead_seconds') is not None else None)
        diff = (f" diff={r['diff_files_changed']}f+{r['diff_insertions']}/-{r['diff_deletions']}"
                if r.get('diff_files_changed') is not None else '')
        print(f"  [{r['repo']}] {task:30s} model={model:15s} "
              f"outcome={r['outcome']:10s} elapsed={elapsed}m (exec={ex}m verify={vf}m overhead={oh}m){diff}")

    if dry_run:
        print(f"(dry-run: not writing to {out})")
        return

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'a') as fh:
        for row in new_rows:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
    print(f"appended to {out}")


if __name__ == '__main__':
    main()
