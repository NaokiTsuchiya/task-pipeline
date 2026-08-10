#!/usr/bin/env python3
"""task-pipeline/references/verifier.md の `carryover` フィールド (gh-63) の遵守状況を、
蓄積された判定ファイルから集計する。

使い方:
  count-carryover.py <repo_root の絶対パス>

<repo_root>/.task-pipeline/runs/*/verdicts/*.json を全走査し、attempt が 0 より大きい FAIL
判定 (= 持ち越しが起こりうる判定) を分母として、`carryover.status` の内訳を stdout に出す。

分母を「attempt > 0 の FAIL」に絞る理由: attempt 0 には直前の判定が無いので持ち越しの概念が
そもそも成立しない。ここを分母に含めると遵守率の分母が全 FAIL に膨らみ、意味を失う。

`carryover` が dict でも文字列でもなく `null` の場合を「キー欠落 (no-field)」と区別して
`malformed` に数える理由: `dict.get('carryover')` は キー欠落でも値が `null` (Python では
None) でも同じ `None` を返すため、区別しないと「フィールドを書かなかった」と「値を
JSON null として書いた」が集計上取り違えられる。値として null を書くのは仕様上の
持ち越し無し (`status: "none"`) の表現ではないので、これは書式違反として malformed に落とす。

phase の束ね方は判定 JSON 本文の "phase" キーを使う (ファイル名の phase 部分は使わない)。
`collect-task-metrics.py` の list_fail_verdicts と同じ理由 — pr_fix/rebase_fix はファイル名が
`<phase>-<seq>-<attempt>.json` の3要素になり、ファイル名 basename の先頭トークンだけでは
phase を正しく取り出せない。

- 外部依存ゼロ・ネットワーク不要 (標準ライブラリのみ)。
- 壊れた JSON・スキーマ違反があっても exit 0 で完走し、件数として stdout に出す
  (collect-task-metrics.py と同じ「黙って落とさない」方針)。
"""
import json
import os
import re
import sys
from collections import defaultdict

ATTEMPT_RE = re.compile(r'-(\d+)\.json$')
KNOWN_STATUSES = ('none', 'explained', 'missed', 'unexplained', 'unknown')


def scan(repo_root):
    """<repo_root>/.task-pipeline/runs/*/verdicts/*.json を走査して集計結果を返す。

    戻り値: {
      'scanned': int, 'unreadable': int, 'not_fail': int, 'unnumbered': int,
      'first_attempt': int, 'denominator': int, 'no_field': int, 'malformed': int,
      'status_counts': {status: int, ...},
      'phase_status_counts': {phase: {status: int, ...}, ...},
    }
    """
    runs_dir = os.path.join(repo_root, '.task-pipeline', 'runs')
    if not os.path.isdir(runs_dir):
        raise FileNotFoundError(runs_dir)

    counts = defaultdict(int)
    status_counts = defaultdict(int)
    phase_status_counts = defaultdict(lambda: defaultdict(int))

    for task in sorted(os.listdir(runs_dir)):
        vdir = os.path.join(runs_dir, task, 'verdicts')
        if not os.path.isdir(vdir):
            continue
        for fn in sorted(os.listdir(vdir)):
            if not fn.endswith('.json'):
                continue
            counts['scanned'] += 1
            path = os.path.join(vdir, fn)
            try:
                with open(path) as fh:
                    data = json.load(fh)
            except Exception:
                counts['unreadable'] += 1
                continue

            if not isinstance(data, dict) or data.get('verdict') != 'FAIL':
                counts['not_fail'] += 1
                continue

            m = ATTEMPT_RE.search(fn)
            if m is None:
                counts['unnumbered'] += 1
                continue
            attempt = int(m.group(1))
            if attempt == 0:
                counts['first_attempt'] += 1
                continue

            counts['denominator'] += 1
            phase = data.get('phase')

            if 'carryover' not in data:
                counts['no_field'] += 1
                continue

            carryover = data['carryover']
            status = carryover.get('status') if isinstance(carryover, dict) else None
            if status not in KNOWN_STATUSES:
                counts['malformed'] += 1
                continue

            status_counts[status] += 1
            phase_status_counts[phase][status] += 1

    return {
        'scanned': counts['scanned'],
        'unreadable': counts['unreadable'],
        'not_fail': counts['not_fail'],
        'unnumbered': counts['unnumbered'],
        'first_attempt': counts['first_attempt'],
        'denominator': counts['denominator'],
        'no_field': counts['no_field'],
        'malformed': counts['malformed'],
        'status_counts': dict(status_counts),
        'phase_status_counts': {p: dict(s) for p, s in phase_status_counts.items()},
    }


def format_report(result):
    lines = []
    lines.append(f"scanned:        {result['scanned']}")
    lines.append(f"unreadable:     {result['unreadable']}")
    lines.append(f"not-FAIL:       {result['not_fail']}")
    lines.append(f"unnumbered:     {result['unnumbered']}")
    lines.append(f"first-attempt:  {result['first_attempt']}")
    lines.append(f"denominator (attempt>0 FAIL): {result['denominator']}")
    lines.append(f"no-carryover-field: {result['no_field']}")
    lines.append(f"malformed:      {result['malformed']}")
    lines.append("")
    lines.append("status counts:")
    for status in KNOWN_STATUSES:
        lines.append(f"  {status}: {result['status_counts'].get(status, 0)}")
    lines.append("")
    sc = result['status_counts']
    carryover_total = sc.get('explained', 0) + sc.get('missed', 0) + sc.get('unexplained', 0)
    unexplained_total = sc.get('unexplained', 0)
    missed_total = sc.get('missed', 0)
    lines.append(f"carryover count (explained + missed + unexplained): {carryover_total}")
    lines.append(f"unexplained carryover count: {unexplained_total}")
    lines.append(f"self-admitted missed count: {missed_total}")
    lines.append("")
    lines.append("by phase:")
    for phase in sorted(result['phase_status_counts'], key=lambda p: (p is None, p)):
        counts = result['phase_status_counts'][phase]
        rendered = ', '.join(f"{s}={counts.get(s, 0)}" for s in KNOWN_STATUSES if counts.get(s))
        lines.append(f"  {phase}: {rendered if rendered else '(none)'}")
    return '\n'.join(lines) + '\n'


def main():
    if len(sys.argv) != 2:
        sys.exit('usage: count-carryover.py <repo_root>')
    repo_root = os.path.abspath(sys.argv[1])
    try:
        result = scan(repo_root)
    except FileNotFoundError as e:
        print(f"count-carryover: runs directory not found: {e}", file=sys.stderr)
        sys.exit(2)
    sys.stdout.write(format_report(result))


if __name__ == '__main__':
    main()
