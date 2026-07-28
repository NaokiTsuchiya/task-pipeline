#!/usr/bin/env python3
"""オーケストレーター (メインループ) 側の usage 集計。

セッション transcript (~/.claude/projects/<project>/<session>.jsonl) の assistant エントリから
message.usage を message.id で重複排除して合計する。1 つの API コールが複数行 (content ブロック
ごと) に転記されるため、重複排除しないと 2〜5 倍過大になる。

出力: API コール数 / processed (input+cache_creation+cache_read+output) /
weighted (input×1 + cache_creation×1.25 + cache_read×0.1 + output×5) / 出力トークン。

使い方: aggregate-orchestrator-usage.py <session.jsonl> [--until 2026-07-28T17:16]
  --until を与えると、その時刻以前の assistant エントリだけを集計する
  (タスク稼働分とその後の会話を切り分ける用)。
"""
import json
import sys


def main() -> None:
    path = sys.argv[1]
    until = None
    if '--until' in sys.argv:
        until = sys.argv[sys.argv.index('--until') + 1]
    per = {}
    with open(path) as fh:
        for line in fh:
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if j.get('type') != 'assistant':
                continue
            if until and j.get('timestamp', '') > until:
                continue
            msg = j.get('message', {})
            usage, mid = msg.get('usage'), msg.get('id')
            if not (usage and mid):
                continue
            prev = per.get(mid)
            # 同じ API コールの転記のうち、出力トークンが最大の (最終的な) スナップショットを採る
            if prev is None or usage.get('output_tokens', 0) >= prev.get('output_tokens', 0):
                per[mid] = usage
    tot = {'input_tokens': 0, 'cache_creation_input_tokens': 0,
           'cache_read_input_tokens': 0, 'output_tokens': 0}
    for u in per.values():
        for k in tot:
            tot[k] += u.get(k, 0)
    processed = sum(tot.values())
    weighted = (tot['input_tokens'] + tot['cache_creation_input_tokens'] * 1.25
                + tot['cache_read_input_tokens'] * 0.1 + tot['output_tokens'] * 5.0)
    print(f"api_calls={len(per)} processed={processed:,} weighted={weighted:,.0f} "
          f"output={tot['output_tokens']:,}")


if __name__ == '__main__':
    main()
