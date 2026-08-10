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
  fail_reasons    このタスクの verdicts (<repo_root>/.task-pipeline/runs/<task>/verdicts/) から
                   verdict=="FAIL" の判定を集めた一覧: [{"phase":, "attempt":, "required_fixes":}, ...]
                   (ファイル名昇順)。分類はしない生の required_fixes をそのまま運ぶ。FAIL が無ければ []。
                   verdicts ディレクトリが無い・読めない・JSON が壊れているときは null
                   (stderr に警告して収集は継続する)。
                   同じ (repo, task) に複数のタスク実行 (run) の行がありうるため、verdict ファイルの
                   mtime (verifier が書いた 1 回きりの書き込み時刻) を使い、各行の start_ts を
                   start_ts 昇順に並べた区間 [その行の start_ts, 次の行の start_ts) に verdict を
                   振り分ける (最後の行は上限無し = [start_ts, +inf))。**この収集呼び出しの時点で
                   「時系列で最後」に見える行の値は暫定である** — 後から更に後続の run が収集されると、
                   その行が最後ではなくなり、正しい上限が付く。既存行は増分収集では書き換えないため、
                   確定させるには下記 --recompute-fail-reasons を使う。どの行の区間にも収まらなかった
                   (最も早い行の start_ts より前の mtime を持つ) verdict は黙って落とさず、
                   件数を収集の stdout に出す (0 件でも出す)。
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
  collect-task-metrics.py --scan <プロジェクトルートの絶対パス> [--out PATH] [--dry-run] [--no-diff-stats]
  collect-task-metrics.py --recompute-fail-reasons <repo_root の絶対パス> [--out PATH] [--dry-run]

  相対パスは ~/.claude/projects/ 起点。--out 省略時は ~/.claude/task-pipeline/metrics.jsonl。
  同じ (session, task_id) は既存ファイルにあればスキップする (増分収集・再実行安全)。
  --no-diff-stats を付けると git show / gh pr view を呼ばない (オフライン・高速収集したいとき用)。

  --scan は明示列挙モードと排他 (位置引数と同時に渡すとエラーで終了する)。渡した <プロジェクトルート> を
  ~/.claude/projects/ のディレクトリ名規則 (パス中の `/` と `.` を `-` に置換) で変換し、そのディレクトリ名と
  「完全一致」または「変換名 + '-' で始まる」(worktree 経由のセッションディレクトリを含む) ディレクトリを
  すべて探して、直下 (非再帰) の *.jsonl を明示列挙モードと同じ増分収集にかける。一致するディレクトリが
  無い・~/.claude/projects/ 自体が無い場合も 0 件として正常終了する (usage エラーにしない)。
  走査先のルートは環境変数 COLLECT_TASK_METRICS_PROJECTS_BASE で差し替えられる (テスト用。既定は
  ~/.claude/projects/)。

  --recompute-fail-reasons は明示列挙・--scan と排他。<repo_root> の basename (owner/repo の repo 部分)
  と `repo` フィールドが一致する --out (省略時は既定値) の行だけを対象に、fail_reasons を
  「同じ (repo, task) の行を start_ts 昇順に並べ、次の行の start_ts を上限にする」窓で読み直して
  書き戻す (in-place)。対象外の行・fail_reasons 以外のフィールドは変更しない。同じ task の行が
  1 行しかない場合は値が変わらない。帰属できなかった verdict の件数と、値が変わった行数を stdout に
  出す。--dry-run を付けると書き戻さない。増分収集では自動的に遡及されない過去の行を確定させる手段
  (上記 fail_reasons の項を参照)。
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_OUT = os.path.expanduser('~/.claude/task-pipeline/metrics.jsonl')
PROJECTS_BASE = os.path.expanduser('~/.claude/projects')
SCAN_PROJECTS_BASE_ENV = 'COLLECT_TASK_METRICS_PROJECTS_BASE'

NOTIF_RE = re.compile(
    r'<task-notification>.*?<task-id>([^<]+)</task-id>.*?<tool-use-id>([^<]+)</tool-use-id>'
    r'.*?<result>(.*?)</result>\s*<usage><subagent_tokens>(\d+)</subagent_tokens>'
    r'<tool_uses>(\d+)</tool_uses><duration_ms>(\d+)</duration_ms></usage>', re.S)
USAGE_SYNC_RE = re.compile(r'subagent_tokens:\s*(\d+)\ntool_uses:\s*(\d+)\nduration_ms:\s*(\d+)')
SLUG_RE = re.compile(r'runs/([a-zA-Z0-9_.-]+)/')
FAIL_ATTEMPT_RE = re.compile(r'-(\d+)\.json$')
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


def list_fail_verdicts(vdir):
    """vdir (<repo_root>/.task-pipeline/runs/<slug>/verdicts) を走査し、verdict=="FAIL" の判定を
    ファイル名昇順で [{"phase":, "attempt":, "required_fixes":, "mtime":}, ...] に組み立てて返す。

    phase は verdict JSON 本文の "phase" キーをそのまま使う (pr_fix/rebase_fix でもファイル名の
    連番 <n> を含まない実測値と一致させるため — ファイル名だけが `pr_fix-<n>-<attempt>.json` の
    3要素になる)。attempt はファイル名末尾の `-<数字>.json` から取る (JSON 本文には attempt が無い)。
    mtime は `os.path.getmtime` の値 (verifier が verdict ファイルを書いた時刻の代理 — verdict
    ファイルは書かれた後どこからも書き換えられないので、この代理が成り立つ)。

    ディレクトリが無い・読めない・中の JSON が1つでも壊れているときは例外をそのまま投げる
    (呼び出し側が catch して None 化 + stderr 警告を出す。この関数自体は収集対象の slug 等の
    文脈を知らないので、警告メッセージの組み立ては呼び出し側の責務)。
    """
    names = sorted(fn for fn in os.listdir(vdir) if fn.endswith('.json'))
    fail_verdicts = []
    for fn in names:
        path = os.path.join(vdir, fn)
        with open(path) as fh:
            data = json.load(fh)
        if data.get('verdict') != 'FAIL':
            continue
        m = FAIL_ATTEMPT_RE.search(fn)
        fail_verdicts.append({
            'phase': data.get('phase'),
            'attempt': int(m.group(1)) if m else None,
            'required_fixes': data.get('required_fixes') or [],
            'mtime': os.path.getmtime(path),
        })
    return fail_verdicts


def _parse_ts(ts):
    """ISO8601 文字列 (例 '2026-08-04T00:01:00Z') を tz-aware datetime にパースする。
    空/None/パース失敗は None (window の下限/上限として「無制限」に倒す防御的フォールバック)。
    """
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return None


def attribute_fail_reasons(vdir, windows):
    """vdir の FAIL verdict を、windows (呼び出し側が start_ts 昇順に並べた
    [(lower_dt_or_None, upper_dt_or_None), ...]) の該当区間に振り分ける。

    区間は半開区間 [lower, upper) (lower は含む、upper は含まない = 次の区間に属する)。
    upper が None の区間は「最後のレコード」を表し上限無し (+inf) として扱う。lower が None の
    要素は理論上先頭以外に出ないはずだが、防御的に「下限無し」として扱う。

    戻り値 (buckets, unattributed_count)。buckets は windows と同じ長さのリストで、各要素は
    その区間に属す [{"phase":, "attempt":, "required_fixes":}, ...] (ファイル名昇順を保つ)。
    unattributed_count は、最初の区間の lower より前の mtime を持つために、どの区間にも
    収まらなかった FAIL verdict の件数 (黙って落とさず、件数として呼び出し側 = 収集の出力に
    運ばせるためにここで数える)。

    vdir が読めない・中の JSON が壊れているとき (list_fail_verdicts が例外を投げたとき) は
    そのまま伝播させる (呼び出し側で catch する)。
    """
    items = list_fail_verdicts(vdir)
    buckets = [[] for _ in windows]
    unattributed = 0
    for it in items:
        dt = datetime.fromtimestamp(it['mtime'], tz=timezone.utc)
        placed = False
        for idx, (lower, upper) in enumerate(windows):
            if lower is not None and dt < lower:
                continue
            if upper is not None and dt >= upper:
                continue
            buckets[idx].append({
                'phase': it['phase'],
                'attempt': it['attempt'],
                'required_fixes': it['required_fixes'],
            })
            placed = True
            break
        if not placed:
            unattributed += 1
    return buckets, unattributed


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


def _scan_dirname_prefix(root):
    """--scan の絶対パスを ~/.claude/projects/ のディレクトリ名規則 (`/` と `.` を `-` に置換) に変換する。"""
    return re.sub(r'[/.]', '-', os.path.abspath(root))


def find_scan_session_files(root, projects_base=None):
    """root (プロジェクトルート) を変換した名前に「完全一致」または「変換名 + '-' で始まる」ディレクトリを
    projects_base (省略時は COLLECT_TASK_METRICS_PROJECTS_BASE 環境変数、それも無ければ PROJECTS_BASE) 配下
    から探し、それぞれの直下 (非再帰) にある *.jsonl を集めて絶対パスのソート済みリストで返す。

    一致するディレクトリが無い・base 自体が存在しない場合も空リストを返すだけで例外にはしない
    (走査対象プロジェクトにまだセッションが無い初回実行が正常系であるため)。
    """
    base = projects_base or os.environ.get(SCAN_PROJECTS_BASE_ENV) or PROJECTS_BASE
    base = os.path.expanduser(base)
    if not os.path.isdir(base):
        return []
    prefix = _scan_dirname_prefix(root)
    dash_prefix = prefix + '-'
    files = []
    for name in sorted(os.listdir(base)):
        full = os.path.join(base, name)
        if not os.path.isdir(full):
            continue
        if name != prefix and not name.startswith(dash_prefix):
            continue
        for fn in sorted(os.listdir(full)):
            if fn.endswith('.jsonl'):
                files.append(os.path.join(full, fn))
    return files


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

        repo_root = repo_root_of(cwd)

        diff = None
        if fetch_diff_stats:
            if finish_mode == 'pr':
                diff = diff_stats_for_pr(pr_url)
            elif finish_mode == 'commit':
                diff = diff_stats_for_commit(repo_root, commit)

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
            # main() の compute_new_fail_reasons が、同じ (repo, task) の他の行 (既存行含む) と
            # あわせて start_ts 順の window を組んでから埋める (この時点では他の行を知らない)。
            'fail_reasons': None,
            '_repo_root': repo_root,  # 内部専用。main() が使い終わったら JSON へ書き出す前に pop する。
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


def _fail_reasons_group_windows(members):
    """members: [{"start_ts":, ...}, ...] (グループ内の全レコード、既存/新規を問わない)。
    start_ts 昇順に並べ替えた順序と、その順序に対応する window ([(lower, upper), ...]、
    半開区間 [lower, upper)。最後は upper=None で無制限) を返す。

    start_ts が同じ (または両方パース不能) レコードが並ぶ場合の順序は Python の安定ソートにより
    入力順を保つ (グループの構築順 = 既存行を先、新規行を後、のいずれか呼び出し側の並び)。
    """
    ordered = sorted(members, key=lambda m: (_parse_ts(m.get('start_ts')) or datetime.min.replace(tzinfo=timezone.utc)))
    windows = []
    for idx, m in enumerate(ordered):
        lower = _parse_ts(m.get('start_ts'))
        upper = _parse_ts(ordered[idx + 1].get('start_ts')) if idx + 1 < len(ordered) else None
        windows.append((lower, upper))
    return ordered, windows


def compute_new_fail_reasons(existing_rows, new_rows):
    """existing_rows (out ファイルから読み込んだ既存行、変更しない) と new_rows (今回収集した
    新規行、各行に process() が付けた '_repo_root' を持つ) を (repo, task) でグルーピングし、
    start_ts 昇順の window で fail_reasons を計算して new_rows の該当フィールドをその場で埋める。

    既存行の fail_reasons は書き換えない (増分収集は追記のみ — 過去の行を確定させたい場合は
    --recompute-fail-reasons を使う)。window の下限/上限には既存行の start_ts も使う — 新規行が
    グループ内で時系列的に最後でなければ、既存の後続レコードの start_ts が正しい上限になる。

    verdicts が読めない (list_fail_verdicts が例外を投げる) グループは、対象の新規行すべてを
    fail_reasons=None にし、stderr に 1 回警告する (list_fail_verdicts 自体は文脈を知らないため
    ここでメッセージを組み立てる)。

    戻り値: このグループ群全体での unattributed 件数の合計 (帰属先の無かった FAIL verdict を
    黙って落とさず数える — 要求3)。new_rows の全行から '_repo_root' を pop してから返る
    (JSON へ書き出す前に必ずこの関数を通す設計)。
    """
    groups = defaultdict(list)
    for r in existing_rows:
        groups[(r.get('repo'), r.get('task'))].append({'start_ts': r.get('start_ts'), 'new': False})
    for r in new_rows:
        groups[(r.get('repo'), r.get('task'))].append({'start_ts': r.get('start_ts'), 'new': True, 'row': r})

    unattributed_total = 0
    for (repo, task), members in groups.items():
        if task is None or not any(m['new'] for m in members):
            continue
        ordered, windows = _fail_reasons_group_windows(members)
        repo_root = next((m['row']['_repo_root'] for m in ordered if m['new']), None)
        if not repo_root:
            for m in ordered:
                if m['new']:
                    m['row']['fail_reasons'] = None
            continue
        vdir = os.path.join(repo_root, '.task-pipeline', 'runs', task, 'verdicts')
        try:
            buckets, unattributed = attribute_fail_reasons(vdir, windows)
        except Exception as e:
            print(f"collect-task-metrics: fail_reasons unavailable for task {task!r} "
                  f"({vdir}): {e}", file=sys.stderr)
            for m in ordered:
                if m['new']:
                    m['row']['fail_reasons'] = None
            continue
        unattributed_total += unattributed
        for idx, m in enumerate(ordered):
            if m['new']:
                m['row']['fail_reasons'] = buckets[idx]

    for r in new_rows:
        r.pop('_repo_root', None)
    return unattributed_total


def recompute_fail_reasons(out, repo_root, dry_run):
    """out (既存の metrics.jsonl) の全行を読み直し、repo_of(repo_root) と 'repo' が一致する行だけを
    対象に fail_reasons を再計算して書き戻す (in-place)。他の repo の行・fail_reasons 以外の
    フィールドは一切変更しない。同じ task の行が1行しかなければ window は上限無し = 元の全件走査と
    同じ値になる (変わらない)。

    dry_run なら書き戻さず、変更内容 (対象タスク数・変更行数・unattributed 件数) だけを stdout に
    出す。verdicts が読めないタスクは fail_reasons=None にし stderr に警告する (通常収集と同じ契約)。
    """
    if not os.path.exists(out):
        sys.exit(f"--recompute-fail-reasons: {out} not found")
    rows = []
    with open(out) as fh:
        for line in fh:
            if not line.strip():
                continue
            rows.append(json.loads(line))

    target_repo = repo_of(repo_root)
    groups = defaultdict(list)
    for idx, r in enumerate(rows):
        if r.get('repo') == target_repo:
            groups[r.get('task')].append(idx)

    changed = 0
    unattributed_total = 0
    for task, idxs in groups.items():
        if task is None:
            continue
        members = [{'start_ts': rows[i].get('start_ts'), 'idx': i} for i in idxs]
        ordered, windows = _fail_reasons_group_windows(members)
        vdir = os.path.join(repo_root, '.task-pipeline', 'runs', task, 'verdicts')
        try:
            buckets, unattributed = attribute_fail_reasons(vdir, windows)
        except Exception as e:
            print(f"collect-task-metrics: fail_reasons unavailable for task {task!r} "
                  f"({vdir}): {e}", file=sys.stderr)
            for m in ordered:
                if rows[m['idx']].get('fail_reasons') is not None:
                    changed += 1
                rows[m['idx']]['fail_reasons'] = None
            continue
        unattributed_total += unattributed
        for idx, m in enumerate(ordered):
            new_val = buckets[idx]
            if rows[m['idx']].get('fail_reasons') != new_val:
                changed += 1
            rows[m['idx']]['fail_reasons'] = new_val

    print(f"recompute-fail-reasons: {len(groups)} task(s) matched repo {target_repo!r}, "
          f"{changed} row(s) changed")
    print(f"fail_reasons: {unattributed_total} verdict(s) could not be attributed to any collected run")

    if dry_run:
        print(f"(dry-run: not writing to {out})")
        return

    with open(out, 'w') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f"rewrote {out}")


def main():
    args = sys.argv[1:]
    out = DEFAULT_OUT
    dry_run = False
    fetch_diff_stats = True
    scan_root = None
    recompute_root = None
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
        elif a == '--scan':
            i += 1
            scan_root = args[i]
        elif a == '--recompute-fail-reasons':
            i += 1
            recompute_root = args[i]
        else:
            files.append(a)
        i += 1

    usage = ('usage: collect-task-metrics.py <session.jsonl> [...] [--out PATH] [--dry-run] [--no-diff-stats]\n'
              '   or: collect-task-metrics.py --scan <project root> [--out PATH] [--dry-run] [--no-diff-stats]\n'
              '   or: collect-task-metrics.py --recompute-fail-reasons <repo root> [--out PATH] [--dry-run]')
    if recompute_root is not None:
        if files or scan_root is not None:
            sys.exit('usage: --recompute-fail-reasons is mutually exclusive with explicit session '
                      'file arguments and --scan\n' + usage)
        recompute_fail_reasons(out, os.path.abspath(recompute_root), dry_run)
        return
    if scan_root is not None:
        if files:
            sys.exit('usage: --scan is mutually exclusive with explicit session file arguments\n' + usage)
        files = find_scan_session_files(scan_root)
    elif not files:
        sys.exit(usage)

    existing_rows = []
    existing_keys = set()
    if os.path.exists(out):
        with open(out) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                existing_rows.append(r)
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

    unattributed_total = compute_new_fail_reasons(existing_rows, new_rows)

    print(f"{len(new_rows)} new task-run(s) collected from {len(files)} session file(s)")
    print(f"fail_reasons: {unattributed_total} verdict(s) could not be attributed to any collected run")
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
