#!/usr/bin/env python3
"""task-pipeline セッションログ集計 (重複排除つき)。

- sync Agent 呼び出し: assistant の tool_use (name=Agent/Task) と user の tool_result を突き合わせ
- background: <task-notification> ブロックを正規表現で抽出
- 重複排除キー: (kind, tool_use_id, task_id, tokens, ms)
- 役割分類: 起動プロンプトの先頭行 / task-id -> 起動プロンプト
"""
import json, re, sys, os, glob
from collections import defaultdict

NOTIF_RE = re.compile(
    r'<task-notification>.*?<task-id>([^<]+)</task-id>.*?<tool-use-id>([^<]+)</tool-use-id>'
    r'.*?<usage><subagent_tokens>(\d+)</subagent_tokens><tool_uses>(\d+)</tool_uses>'
    r'<duration_ms>(\d+)</duration_ms></usage>', re.S)
NOTIF_RESULT_RE = re.compile(r'<result>(.*?)</result>', re.S)
USAGE_SYNC_RE = re.compile(r'subagent_tokens:\s*(\d+)\ntool_uses:\s*(\d+)\nduration_ms:\s*(\d+)')
AGENTID_RE = re.compile(r"agentId:\s*([0-9a-f]+)")


def classify_prompt(p):
    head = p.strip().splitlines()[0] if p.strip() else ''
    if 'tracker adapter subagent' in p: return 'adapter'
    if 'triage subagent' in p: return 'triage'
    if 'independent verifier' in p: return 'verifier'
    if 'long-lived executor' in p: return 'executor'
    if 'PR watcher subagent' in p: return 'pr-watcher'
    return 'other:' + head[:60]


def verifier_phase(p):
    m = re.search(r'phase:\s*(\w+)', p)
    return m.group(1) if m else '?'


def task_of_prompt(p):
    m = re.search(r'(?:runs|tasks)/(gh-\d+|t-[0-9a-f]+)', p)
    return m.group(1) if m else None


def executor_phase_from_result(r):
    m = re.search(r'PHASE\s+(\w+)\s+DONE', r)
    if m: return m.group(1)
    if 'FINALIZED' in r: return 'finalize'
    if 'BLOCKED' in r: return 'blocked-stop'
    return '?'


def process(path):
    tooluse = {}           # tool_use_id -> dict(category, phase, task)
    taskid_info = {}       # task-id -> dict(category, task)   (background agents)
    sendmsg = {}           # SendMessage tool_use_id -> summary/to
    records = []           # dicts
    seen = set()
    with open(path) as f:
        lines = f.readlines()
    # pass 1: tool_use blocks
    for line in lines:
        try: j = json.loads(line)
        except Exception: continue
        if j.get('type') == 'assistant':
            msg = j.get('message', {})
            cont = msg.get('content')
            if not isinstance(cont, list): continue
            for c in cont:
                if not (isinstance(c, dict) and c.get('type') == 'tool_use'): continue
                name = c.get('name', '')
                inp = c.get('input', {}) or {}
                if name in ('Agent', 'Task'):
                    p = inp.get('prompt', '') or ''
                    tooluse[c['id']] = {
                        'category': classify_prompt(p),
                        'phase': verifier_phase(p) if 'independent verifier' in p else None,
                        'task': task_of_prompt(p),
                        'bg': bool(inp.get('run_in_background')),
                    }
                elif name == 'SendMessage':
                    sendmsg[c['id']] = {'to': inp.get('to'), 'text': (inp.get('message') or inp.get('summary') or '')[:200]}
    # pass 2: results
    for line in lines:
        # background notifications (raw regex over the line covers queue-operation,
        # attachment, user re-display 等すべて; dedup key で安全)
        for m in NOTIF_RE.finditer(line):
            task_id, tu_id, tok, tools, ms = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5))
            key = ('bg', task_id, tu_id, tok, ms)
            if key in seen: continue
            seen.add(key)
            blob = line[m.start():m.end()+2000]
            rm = NOTIF_RESULT_RE.search(blob)
            result = rm.group(1)[:300] if rm else ''
            launch = tooluse.get(tu_id, {})
            cat = launch.get('category') or taskid_info.get(task_id, {}).get('category') or 'bg-?'
            task = launch.get('task') or taskid_info.get(task_id, {}).get('task')
            if tu_id in tooluse:
                taskid_info[task_id] = {'category': cat, 'task': task}
            records.append({'kind': 'bg', 'task_id': task_id, 'tu': tu_id, 'tokens': tok,
                            'tool_uses': tools, 'ms': ms, 'category': cat, 'task': task,
                            'phase': executor_phase_from_result(result), 'result': result[:120].replace('\n', ' ')})
        try: j = json.loads(line)
        except Exception: continue
        if j.get('type') != 'user': continue
        msg = j.get('message', {})
        cont = msg.get('content')
        if not isinstance(cont, list): continue
        for c in cont:
            if not (isinstance(c, dict) and c.get('type') == 'tool_result'): continue
            tu_id = c.get('tool_use_id')
            texts = []
            cc = c.get('content')
            if isinstance(cc, list):
                texts = [x.get('text', '') for x in cc if isinstance(x, dict) and x.get('type') == 'text']
            elif isinstance(cc, str):
                texts = [cc]
            joined = '\n'.join(texts)
            um = USAGE_SYNC_RE.search(joined)
            if not um: continue
            tok, tools, ms = int(um.group(1)), int(um.group(2)), int(um.group(3))
            key = ('sync', tu_id, '', tok, ms)
            if key in seen: continue
            seen.add(key)
            info = tooluse.get(tu_id, {})
            am = AGENTID_RE.search(joined)
            if am and tu_id in tooluse:
                taskid_info[am.group(1)] = {'category': info.get('category'), 'task': info.get('task')}
            records.append({'kind': 'sync', 'task_id': am.group(1) if am else '', 'tu': tu_id,
                            'tokens': tok, 'tool_uses': tools, 'ms': ms,
                            'category': info.get('category', 'sync-?'),
                            'task': info.get('task'), 'phase': info.get('phase'),
                            'result': joined[:100].replace('\n', ' ')})
    return records


def summarize(name, records):
    tot_t = sum(r['tokens'] for r in records)
    tot_ms = sum(r['ms'] for r in records)
    print(f"\n=== {name} ===")
    print(f"calls={len(records)}  tokens={tot_t:,}  minutes={tot_ms/60000:.1f}")
    bycat = defaultdict(lambda: [0, 0, 0])
    for r in records:
        b = bycat[r['category']]
        b[0] += 1; b[1] += r['tokens']; b[2] += r['ms']
    for cat, (n, t, ms) in sorted(bycat.items(), key=lambda x: -x[1][1]):
        print(f"  {cat:12s} n={n:3d} tokens={t:>10,} min={ms/60000:6.1f}")
    return records


if __name__ == '__main__':
    base = os.path.expanduser('~/.claude/projects')
    files = sys.argv[1:]
    allrec = {}
    for f in files:
        p = f if os.path.isabs(f) else os.path.join(base, f)
        recs = process(p)
        summarize(os.path.basename(p), recs)
        allrec[p] = recs
    # dump detail for further analysis
    out = os.environ.get('DETAIL_OUT')
    if out:
        with open(out, 'w') as fh:
            json.dump({k: v for k, v in allrec.items()}, fh, ensure_ascii=False, indent=1)
