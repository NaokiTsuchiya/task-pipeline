# 状態モデル v2 の ALPS プロファイル (gh-21)

状態モデル v2 の宣言 (`P_NODE_KEYS` / `A_NODE_KEYS` / `VERB_SPEC` / `ADVANCE_EDGES`、
いずれも `task-pipeline/scripts/` 配下) から、[ALPS](https://alps.io/) プロファイル
2本を機械生成し、[app-state-diagram](https://www.app-state-diagram.com/) (`asd`) で
状態遷移図として閲覧できるようにしている。

## ファイル

- `task-pipeline/docs/alps/state-v2-progress.alps.json` — 領域 P (進行) の主図。
  `P_NODE_KEYS` の19ノードと、`VERB_SPEC.p` / `ADVANCE_EDGES` から導ける18個の遷移。
- `task-pipeline/docs/alps/state-v2-artifact.alps.json` — 領域 A (成果物) の従図。
  `A_NODE_KEYS` の23ノードと、`VERB_SPEC.a` から導ける3個の遷移。

生成スクリプトは `task-pipeline/scripts/alps-v2.ts` (Deno のみ、npm/jsr 参照なし)。
**この2ファイルは手で編集しない** — 宣言側を変えたら再生成してコミットする。

## 再生成

```sh
deno run --allow-write task-pipeline/scripts/alps-v2.ts
```

## 回帰テスト

`task-pipeline/scripts/alps-v2.test.ts` が、上記2ファイルを再生成した結果とコミット
済みの内容をバイト列で突き合わせる。`P_NODE_KEYS` / `A_NODE_KEYS` / `VERB_SPEC` /
`ADVANCE_EDGES` を変えてプロファイルの再生成を忘れると、このテストが落ちる。

```sh
sh tests/alps-v2.test.sh   # tests/run.sh から自動検出される薄いラッパー
deno task test             # リポジトリ全体の *.test.ts (このテストも含む)
```

## 手元でのレンダリング手順

CI はレンダリングを行わない (Deno 単一ジョブの方針を維持)。手元で図として見るには
`asd` (npm 版) を使う:

```sh
npm install -g @alps-asd/app-state-diagram   # 一度だけ

# 領域 P 主図
asd task-pipeline/docs/alps/state-v2-progress.alps.json
open index.html   # macOS。生成された index.html を開く

# 領域 A 従図
asd task-pipeline/docs/alps/state-v2-artifact.alps.json
open index.html
```

homebrew 版 (`brew install alps-asd/asd/asd`) もあるが、`node@20` に依存する formula
が壊れている環境があるため、上記の npm 版を優先する。

## 領域 A 従図が sub-axis 内の遷移を辺として描かない理由

領域 A の23ノードのうち18ノードは `attention × fix-ask × rebase-ask` のサブ軸
座標を持つが、`fix-request` / `rebase-request` / `fix-start` / `rebase-give-up` /
`rebase-forgo` / `rebase-applied` / `probe-run` / `probe-exit` / `observe` /
`attention-set` / `claim` (cycle-reset) といった、このサブ軸を実際に動かす verb は
従図に辺として現れない。

理由は `VERB_SPEC` の宣言の形にある。これらの verb の効果は `"dynamic"` /
`"cycle-reset"` / `"fix-pending"` / `"rebase-quiet"` / `"rebase-taken"` という
効果キーワードで書かれており、着地する具体的なノードは `apply` 層
(`state-transitions-v2.ts`) の実行時分岐 (現在の attention・taken の有無など) が
決める。`P_NODE_KEYS` / `A_NODE_KEYS` / `VERB_SPEC` / `ADVANCE_EDGES` の4シンボルだけ
を見ても、これらの verb がどのノードからどのノードへ動くかは一意に定まらない
(advance だけは `ADVANCE_EDGES` という展開表を別途持つため、領域 P 主図では辺として
描けている)。

この4シンボルのどれかを変えるとテストが落ちる (受け入れ条件2/3) という性質を保つ
には、宣言に無い知識 (apply 層の実装やプロース) を生成器に埋め込まないことが必須
なので、着地が一意に定まらない効果は意図的に辺を引かずに除外している。個々の verb
がどのノードから発火できるかは各ノードの `doc`/`title` からは分からないので、
挙動の詳細を知りたい場合は `VERB_SPEC` (`task-pipeline/scripts/state-transitions-v2-spec.ts`)
と、それを検査する `state-transitions-v2.test.ts` の `T-V2T-MX-*` 系テストを直接読む。
