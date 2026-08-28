#!/usr/bin/env bash
#
# task-pipeline: 常駐 Driver (pipeline-driver.ts の実ディスパッチループ) の起動ラッパー。
#
#   usage: driver-start.sh <state-dir> [interval-sec]
#
# `hub(op: "start", name: "task-pipeline-driver", application: "bash",
#      args: [<このスクリプト>, <state dir>], persist: true, restart: "on-failure")`
# から起動される。手順は SKILL.md の「常駐 Driver (ディスパッチの移管)」節。
#
# 終了コード:
#   0  driver が正常終了した / <state-dir>/driver/desired が stopped だった
#   4  引数が不正
#   *  それ以外は deno の終了コードをそのまま返す (exec するため)
#
# **desired が stopped のとき exit 0 で抜けるのが要点である** — `restart: on-failure` は
# 非ゼロ終了でだけ再起動するので、これによって「意図的に止めているあいだは何度でも
# 起こされない」が成立する。driver 本体も同じ判定を毎サイクル行うが (pipeline-driver.ts の
# readDesired)、ここで先に弾くと state.json にリースを一切触らずに退けられる。

set -uo pipefail

state_dir=${1:-}
interval_sec=${2:-5}

if [ -z "$state_dir" ]; then
  echo "usage: driver-start.sh <state-dir> [interval-sec]" >&2
  exit 4
fi

if [ ! -d "$state_dir" ]; then
  echo "driver-start: state dir not found: $state_dir" >&2
  exit 4
fi

case "$interval_sec" in
  ''|*[!0-9]*)
    echo "driver-start: interval must be a positive integer: $interval_sec" >&2
    exit 4
    ;;
esac

if [ "$interval_sec" -le 0 ]; then
  echo "driver-start: interval must be greater than 0: $interval_sec" >&2
  exit 4
fi

state_dir_abs=$(CDPATH='' cd -- "$state_dir" && pwd -P) || exit 4

desired=running
if [ -f "$state_dir_abs/driver/desired" ]; then
  desired=$(tr -d '[:space:]' < "$state_dir_abs/driver/desired" 2>/dev/null) ||
    desired=stopped
fi

if [ "$desired" != running ]; then
  echo "DRIVER-START stopped desired=${desired:-empty}"
  exit 0
fi

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 4

exec "${DENO_BIN:-deno}" run \
  --allow-read --allow-write --allow-env --allow-run \
  "$script_dir/pipeline-driver.ts" \
  --state-dir "$state_dir_abs" \
  --loop true \
  --interval-sec "$interval_sec"
