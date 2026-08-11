#!/usr/bin/env bash
#
# task-pipeline: PR に変化が起きるまでブロックする。
#
#   usage: watch-pr.sh <pr-url> <task-id> [interval-sec] [max-sec] [prev-signature]
#   env:   TASK_PIPELINE_HEARTBEAT=<path>  … 1 周ごとに touch するセッション生存印
#
# オーケストレーターがバックグラウンドで起動し、終了通知で次のイテレーションが動く。
# 待つ処理をここに押し込むのは、待っている間モデルを起こさないため — ポーリングするのは
# このシェルであって Claude ではない。webhook の受け口を持てない環境で、反応の速さだけを
# webhook と同じにするための仕組みである。
#
# 変化の判定は署名の比較で行う。署名 = PR の状態 | head sha | CI ロールアップ | マージ可否 |
# 基点状態 | コメント数 | レビュー数 | スレッド総数 | 未解決スレッド数 (取得窓内) | 直近更新時刻。
# GraphQL 1 回で全部取れるので 1 周 1 リクエスト。
#
# レビュー・レビューコメントのうち **下書き (state=PENDING。UI の "Start a review" 後、Submit
# review の前) は署名から除く**。下書きとそのコメントは、その下書きの作成者本人の認証では
# GraphQL に返る — ソロ開発では gh の認証主体とレビュアーが同一人物なので、素のまま数えると
# レビュアーが書いている途中で追従が起き、まだ送信していない指摘に対して修正と push が走る。
# 除外はコメント/レビュー単位であってスレッド単位ではない (送信済みコメントを含むスレッドに
# 下書きの返信が足されただけでは動かず、そのスレッド自体は署名に残り続ける)。送信された瞬間
# (PENDING -> SUBMITTED) は件数か直近更新時刻のどちらかが必ず動くので、従来どおり検知される。
#
# 署名にフィールドを足すと、既に張られている旧フォーマットの watch.sig との初回比較は必ず
# 不一致になる (フィールド数が違うので当然)。これはアップグレード直後に 1 回だけ catch-up 相当の
# 空観測を招くが、実害は無い (指摘があれば拾えるし、無ければ `clean`/`wait` で終わるだけ) ので
# 許容する。
#
# コメント数・レビュー数・スレッド総数は GraphQL の totalCount (ページング引数と無関係に
# 全体件数を返す) を使っているので、取得窓 (comments(last:50) / reviews(last:50) /
# reviewThreads(last:100) × スレッド内 comments(last:20)) の外で新しく投稿されたコメント・
# レビュー・スレッドも取り落とさない。未解決スレッド数と直近更新時刻は取得窓の中身からしか
# 計算できないため、**取得窓の外側で起きる次の変化は検知できない**:
#   - 直下コメント 51 件目以降・レビュー 51 件目以降 (いずれも古い側) や、スレッド内
#     コメント 21 件目以降の「本文編集」(件数も更新時刻の最大値も動かない編集)。新規投稿は
#     totalCount で拾えるので、これは「編集」に限った残余である (窓内の編集は取り落とさない
#     — 実測確認済み)。
#   - reviewThreads(last:100) は直近に作られた/動きがあった側 100 本を見る。スレッド総数が
#     100 を超えるとき、最も古い側のスレッドの resolve/unresolve は totalCount が動かない
#     ため検知できない (そのスレッド自体の新規投稿は totalCount で拾える — 検知できないのは
#     投稿より後で起きる resolve/unresolve だけ)。
#   - 下書きの除外は totalCount からの引き算 (窓内で見えた下書きの数を引く) で行うため、
#     取得窓の外にある下書きは引けず、送信済みとして数えられたままになる。下書きは常に
#     最新側にあるので実際上は窓内に入る。
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
    state headRefOid mergeable mergeStateStatus
    comments(last:50){totalCount nodes{updatedAt}}
    reviews(last:50){totalCount nodes{updatedAt state}}
    reviewThreads(last:100){totalCount nodes{isResolved comments(last:20){nodes{updatedAt state}}}}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  }}
}'

# CI がまだ登録されていない (null) 状態と PENDING を同じ扱いにする。
# 分けると push 直後に「null -> PENDING」で 1 回無駄に起きる。
#
# mergeable/mergeStateStatus も同じ問題を持つ。GitHub がこの 2 つを非同期に計算するため、
# push 直後や新規 PR では確定するまで一時的に UNKNOWN を返す。素のまま signature に入れると
# push のたびに「(実際の値) -> UNKNOWN -> (実際の値)」の 2 回の遷移として現れ、push 自体で
# 起きる 1 回に加えて余計にもう 1 回起きてしまう。rebase 判定に使う実際の値は pr-watcher.md
# 側が観測のたびに取り直す (このスクリプトは「変化した」ことだけを知らせればよい) ので、
# ここでは「衝突が確定しているか」「基点遅れが確定しているか」の 1 ビットずつが分かれば足り、
# それ以外 (UNKNOWN を含む) は既定値へ折り畳む — 上の CI ロールアップの null -> "PENDING" と
# 同じ「一過性/無関心な値を確定済みの一方の帰結と同じ扱いに畳む」考え方。mergeStateStatus の
# DIRTY (コンテンツ衝突) は mergeable=CONFLICTING 側で既に拾えるので、ここでの関心事
# (基点遅れ = BEHIND) 以外は区別しない。
# 下書きの除外は totalCount からの引き算で行う。窓内のノードから数え直すと、窓の外で
# 起きた新規投稿 (totalCount でしか見えない) を落としてしまう。
# `state` が無い応答 (このクエリより古い形) は送信済み扱いに倒れる。
jq_signature='def has_submitted: [.comments.nodes[] | select(.state != "PENDING")] | length > 0;
.data.repository.pullRequest | [
  .state,
  .headRefOid,
  (.commits.nodes[0].commit.statusCheckRollup.state // "PENDING"),
  (if .mergeable == "CONFLICTING" then "CONFLICTING" else "MERGEABLE" end),
  (if .mergeStateStatus == "BEHIND" then "BEHIND" else "CLEAN" end),
  (.comments.totalCount | tostring),
  ((.reviews.totalCount - ([.reviews.nodes[] | select(.state == "PENDING")] | length)) | tostring),
  ((.reviewThreads.totalCount - ([.reviewThreads.nodes[] | select(has_submitted | not)] | length)) | tostring),
  ([.reviewThreads.nodes[] | select(.isResolved | not) | select(has_submitted)] | length | tostring),
  ([.comments.nodes[].updatedAt,
    (.reviews.nodes[] | select(.state != "PENDING") | .updatedAt),
    (.reviewThreads.nodes[].comments.nodes[] | select(.state != "PENDING") | .updatedAt)] | max // "-")
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

# このプロセスはオーケストレーターのセッションと共に死ぬ揮発資源なので、生きている間は
# セッションの生存印を打ち直す。in_review で待っている間はオーケストレーター自身が
# 回らない (/loop 無しなら停止通知まで一度も起きない) ため、これが無いとセッションが
# 生きているのに死んだと判定され、別セッションが同じ PR に 2 本目の watch を張る。
heartbeat() {
  if [ -n "${TASK_PIPELINE_HEARTBEAT:-}" ]; then
    mkdir -p "$(dirname "$TASK_PIPELINE_HEARTBEAT")" 2>/dev/null
    touch "$TASK_PIPELINE_HEARTBEAT" 2>/dev/null
  fi
  return 0
}

heartbeat

elapsed=0
failures=0
while [ "$elapsed" -lt "$max" ]; do
  sleep "$interval"
  elapsed=$((elapsed + interval))
  heartbeat

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
