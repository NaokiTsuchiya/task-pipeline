#!/usr/bin/env python3
"""~/.claude/task-pipeline/metrics.jsonl (collect-task-metrics.py の出力) をモデル別・repo別に要約する。

使い方: summarize-task-metrics.py [PATH]  (省略時は ~/.claude/task-pipeline/metrics.jsonl)
"""
import json
import os
import sys
from collections import defaultdict

DEFAULT = os.path.expanduser('~/.claude/task-pipeline/metrics.jsonl')


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    rows = []
    with open(path) as fh:
        for line in fh:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue

    print(f"total task-runs: {len(rows)}\n")

    def bucket(keyfn, title):
        g = defaultdict(list)
        for r in rows:
            g[keyfn(r)].append(r)
        print(f"=== {title} ===")
        for k, rs in sorted(g.items(), key=lambda x: str(x[0])):
            n = len(rs)
            finalized = [r for r in rs if r['outcome'] == 'finalized']
            elapsed = [r['elapsed_seconds'] for r in finalized if r.get('elapsed_seconds') is not None]
            avg = sum(elapsed) / len(elapsed) / 60 if elapsed else None
            med = sorted(elapsed)[len(elapsed) // 2] / 60 if elapsed else None
            rate = len(finalized) / n * 100
            avg_s = f"{avg:5.1f}m" if avg is not None else "    -"
            med_s = f"{med:5.1f}m" if med is not None else "    -"
            print(f"  {str(k):30s} n={n:3d}  finalized_rate={rate:5.1f}%  "
                  f"avg_time_to_pr={avg_s}  median={med_s}")
        print()

    def model_key(r):
        actual = r.get('model_actual')
        if actual:
            return ','.join(actual)
        return r.get('model') or '?'

    bucket(model_key, "model 別 (実測優先・無ければ宣言値)")
    bucket(lambda r: r.get('repo') or '?', "repo 別")
    bucket(lambda r: r.get('finish_mode') or '?', "finish_mode 別")


if __name__ == '__main__':
    main()
