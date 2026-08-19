#!/usr/bin/env bash
#
# task-pipeline: Paseo エージェントのステータス変化を監視し、停止時に即座に終了する。
#
#   usage: watch-agent.sh <agent-id> <timeout-sec> [baseline-status] [interval-sec]
#   env:   TASK_PIPELINE_HEARTBEAT=<path>  … 1 周ごとに touch するセッション生存印
#
# オーケストレーターがバックグラウンドで起動し、エージェント停止時のプロセス終了通知
# (0秒起床) によって次のイテレーション・フェーズ前進を駆動する。
#
# 終了コード:
#   0  エージェントの停止 (idle / closed / errored / permission / archived 等) を検知した
#   2  timeout-sec に達した (タイムアウト)
#   3  エージェント状態を取得できない (paseo inspect 5 連続失敗など)
#   4  引数が不正
#

set -uo pipefail

agent_id=${1:-}
timeout_sec=${2:-}
baseline_status=${3:-running}
interval_sec=${4:-5}

if [ -z "$agent_id" ] || [ -z "$timeout_sec" ]; then
  echo "usage: watch-agent.sh <agent-id> <timeout-sec> [baseline-status] [interval-sec]" >&2
  exit 4
fi

case "$timeout_sec" in
  ''|*[!0-9]*)
    echo "watch-agent: timeout must be a positive integer: $timeout_sec" >&2
    exit 4
    ;;
esac

if [ "$timeout_sec" -le 0 ]; then
  echo "watch-agent: timeout must be greater than 0: $timeout_sec" >&2
  exit 4
fi

case "$interval_sec" in
  ''|*[!0-9]*)
    echo "watch-agent: interval must be a positive integer: $interval_sec" >&2
    exit 4
    ;;
esac

if [ "$interval_sec" -le 0 ]; then
  echo "watch-agent: interval must be greater than 0: $interval_sec" >&2
  exit 4
fi

heartbeat() {
  if [ -n "${TASK_PIPELINE_HEARTBEAT:-}" ]; then
    mkdir -p "$(dirname "$TASK_PIPELINE_HEARTBEAT")" 2>/dev/null || true
    touch "$TASK_PIPELINE_HEARTBEAT" 2>/dev/null || true
  fi
}

heartbeat

elapsed=0
failures=0
last_status=""

while [ "$elapsed" -lt "$timeout_sec" ]; do
  resp=$(paseo inspect "$agent_id" --json 2>/dev/null) || resp=""

  if [ -n "$resp" ]; then
    status=$(echo "$resp" | jq -r '(.status // .Status // empty) | ascii_downcase' 2>/dev/null) || status=""
  else
    status=""
  fi

  if [ -n "$status" ]; then
    failures=0
    last_status="$status"
    case "$status" in
      idle|closed|errored|permission|archived)
        echo "AGENT-WATCH $agent_id stopped $status"
        exit 0
        ;;
      running|starting|busy)
        # 稼働継続中。ポーリングを続行する
        ;;
      *)
        # 未知のステータスで baseline と異なる場合は停止側として扱う
        if [ "$status" != "$baseline_status" ]; then
          echo "AGENT-WATCH $agent_id stopped $status"
          exit 0
        fi
        ;;
    esac
  else
    failures=$((failures + 1))
    if [ "$failures" -ge 5 ]; then
      echo "AGENT-WATCH $agent_id error failed to inspect agent" >&2
      exit 3
    fi
  fi

  sleep "$interval_sec"
  elapsed=$((elapsed + interval_sec))
  heartbeat
done

echo "AGENT-WATCH $agent_id timeout ${last_status:-unknown}"
exit 2
