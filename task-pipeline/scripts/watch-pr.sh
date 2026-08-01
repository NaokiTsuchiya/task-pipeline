#!/usr/bin/env bash
#
# task-pipeline: PR に変化が起きるまでブロックする。
#
#   usage: watch-pr.sh <pr-url> <task-id> [interval-sec] [max-sec] [prev-signature]
#
# オーケストレーターがバックグラウンドで起動し、終了通知で次のイテレーションが動く。
# 待つ処理をここに押し込むのは、待っている間モデルを起こさないため — ポーリングするのは
# このシェルであって Claude ではない。webhook の受け口を持てない環境で、反応の速さだけを
# webhook と同じにするための仕組みである。
#
# 変化の判定は署名の比較で行う。署名 = PR の状態 | head sha | CI ロールアップ |
# コメント数 | レビュー数 | 未解決スレッド数 | コメントの最終更新時刻。GraphQL 1 回で全部取れる
# ので 1 周 1 リクエスト。最終更新時刻を入れているのは、既存コメントの本文が編集されたときに
# 数がどれも動かないため — これが無いと「指摘を書き直した」変化を取り落とす (実測確認済み)。
#
# 終了コード:
#   0  変化を検知した (stdout に旧→新の署名)
#   2  max-sec に達した (変化なし)
#   3  PR の状態を取得できない (未認証・PR が見えない・GraphQL 連続失敗)
#   4  引数が不正

set -uo pipefail

url=${1:-}
task=${2:-}
interval=${3:-60}
max=${4:-21600}

if [ -z "$url" ] || [ -z "$task" ]; then
  echo "usage: watch-pr.sh <pr-url> <task-id> [interval-sec] [max-sec] [prev-signature]" >&2
  exit 4
fi

if [[ "$url" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
  owner=${BASH_REMATCH[1]}
  repo=${BASH_REMATCH[2]}
  number=${BASH_REMATCH[3]}
else
  echo "PR-WATCH $task error 不正な PR URL: $url" >&2
  exit 4
fi

query='query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    state headRefOid
    comments(last:50){totalCount nodes{updatedAt}}
    reviews(last:50){totalCount nodes{updatedAt}}
    reviewThreads(first:100){nodes{isResolved comments(last:20){nodes{updatedAt}}}}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  }}
}'

# CI がまだ登録されていない (null) 状態と PENDING を同じ扱いにする。
# 分けると push 直後に「null -> PENDING」で 1 回無駄に起きる。
jq_signature='.data.repository.pullRequest | [
  .state,
  .headRefOid,
  (.commits.nodes[0].commit.statusCheckRollup.state // "PENDING"),
  (.comments.totalCount | tostring),
  (.reviews.totalCount | tostring),
  ([.reviewThreads.nodes[] | select(.isResolved | not)] | length | tostring),
  ([.comments.nodes[].updatedAt, .reviews.nodes[].updatedAt,
    .reviewThreads.nodes[].comments.nodes[].updatedAt] | max // "-")
] | join("|")'

signature() {
  gh api graphql \
    -f query="$query" -F owner="$owner" -F repo="$repo" -F number="$number" \
    --jq "$jq_signature" 2>/dev/null
}

# 第 5 引数で前回の署名を渡されたら、それを基準にする。プロセスが死んでいた間に
# 起きた変化を次の比較で「changed」として拾うため (張り直しで取り落とさない)。
base=${5:-}
if [ -z "$base" ]; then
  base=$(signature)
  if [ -z "$base" ]; then
    echo "PR-WATCH $task error PR の状態を取得できません: $url" >&2
    exit 3
  fi
fi

elapsed=0
failures=0
while [ "$elapsed" -lt "$max" ]; do
  sleep "$interval"
  elapsed=$((elapsed + interval))

  current=$(signature)
  if [ -z "$current" ]; then
    # 一時的な失敗は無視して次の周回へ。ただし続くなら諦める
    # (トークン失効などで永久に静かなプロセスが残るのを防ぐ)。
    failures=$((failures + 1))
    if [ "$failures" -ge 5 ]; then
      echo "PR-WATCH $task error 状態の取得に 5 回連続で失敗: $url" >&2
      exit 3
    fi
    continue
  fi
  failures=0

  if [ "$current" != "$base" ]; then
    echo "PR-WATCH $task changed $base -> $current"
    exit 0
  fi
done

echo "PR-WATCH $task timeout $base"
exit 2
