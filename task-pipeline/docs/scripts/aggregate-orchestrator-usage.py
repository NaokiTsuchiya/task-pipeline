#!/usr/bin/env python3
"""transcript の usage を集計し、処理総量・入力換算・実費を出す。

対象は「1 API コール = assistant エントリの message.usage」で、message.id で重複排除する
(1 つの API コールが複数行に転記されるため、怠ると 2〜5 倍過大になる)。セッション
transcript にも、Agent tool の出力ファイル (tasks/<agentId>.output) にも同じ形で使える。

出力:
  api_calls  API コール数
  processed  Σ (input + cache_creation + cache_read + output)。実際に処理された総量
  weighted   入力換算。cache 作成の係数は TTL で変わる (5 分 = 1.25、1 時間 = 2.0)
             ので、usage.cache_creation の内訳から自動判別する。output は 5.0
             (現行モデルはいずれも出力単価が入力単価の 5 倍)
  cost       実費 (USD)。--model で単価を選ぶ

使い方:
  aggregate-orchestrator-usage.py <path.jsonl> [--model fable|opus|sonnet|sonnet-intro|haiku]
                                               [--until 2026-07-28T17:16]
  --until はその時刻以前の assistant エントリだけを集計する
           (タスク稼働分とその後の会話を切り分ける用)。
"""
import json
import sys

# 2026-07 時点の公開価格 (input, output) USD per Mtok
PRICES = {
    'fable': (10.0, 50.0),
    'opus': (5.0, 25.0),
    'sonnet': (3.0, 15.0),
    'sonnet-intro': (2.0, 10.0),   # 2026-08-31 までの導入価格
    'haiku': (1.0, 5.0),
}
CACHE_WRITE_MULT = {'1h': 2.0, '5m': 1.25}
CACHE_READ_MULT = 0.1


def collect(path, until=None):
    """message.id で重複排除した usage を積み上げる。"""
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
            # 同じ API コールの転記のうち、出力トークンが最大の (最終的な) ものを採る
            if prev is None or usage.get('output_tokens', 0) >= prev.get('output_tokens', 0):
                per[mid] = usage
    tot = {'input': 0, 'create_1h': 0, 'create_5m': 0, 'read': 0, 'output': 0}
    for u in per.values():
        tot['input'] += u.get('input_tokens', 0)
        tot['read'] += u.get('cache_read_input_tokens', 0)
        tot['output'] += u.get('output_tokens', 0)
        cc = u.get('cache_creation') or {}
        h1 = cc.get('ephemeral_1h_input_tokens', 0)
        h5 = cc.get('ephemeral_5m_input_tokens', 0)
        if h1 or h5:
            tot['create_1h'] += h1
            tot['create_5m'] += h5
        else:
            # 内訳が無い古い形式は 5 分 TTL 扱い (安い方に倒す)
            tot['create_5m'] += u.get('cache_creation_input_tokens', 0)
    return len(per), tot


def main() -> None:
    path = sys.argv[1]
    until = sys.argv[sys.argv.index('--until') + 1] if '--until' in sys.argv else None
    model = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else None

    calls, t = collect(path, until)
    processed = t['input'] + t['create_1h'] + t['create_5m'] + t['read'] + t['output']
    weighted = (t['input']
                + t['create_1h'] * CACHE_WRITE_MULT['1h']
                + t['create_5m'] * CACHE_WRITE_MULT['5m']
                + t['read'] * CACHE_READ_MULT
                + t['output'] * 5.0)
    line = (f"api_calls={calls} processed={processed:,} weighted={weighted:,.0f} "
            f"output={t['output']:,} cache_write(1h/5m)={t['create_1h']:,}/{t['create_5m']:,}")
    if model:
        if model not in PRICES:
            sys.exit(f"unknown model: {model} (choose from {', '.join(PRICES)})")
        p_in, p_out = PRICES[model]
        cost = (t['input'] * p_in
                + t['create_1h'] * p_in * CACHE_WRITE_MULT['1h']
                + t['create_5m'] * p_in * CACHE_WRITE_MULT['5m']
                + t['read'] * p_in * CACHE_READ_MULT
                + t['output'] * p_out) / 1_000_000
        line += f" cost=${cost:.4f} ({model})"
    print(line)


if __name__ == '__main__':
    main()
