# tests/run.sh が SKIP を集計せず、何も検証していない実行が緑になる

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。

`tests/run.sh` の集計は各スイートの終了コードだけを見ている (`tests/run.sh:24-31`):

```sh
if sh "$f"; then
    :
else
    suite_fail=$((suite_fail + 1))
    printf 'SUITE FAILED: %s\n' "$(basename -- "$f")"
fi
```

最終行も `printf 'suites: %s / failed: %s (elapsed %ss)\n' ...` (`tests/run.sh:44`) で、SKIP の数はどこにも出ない。

いくつかのスイートは必須ツールが無いと SKIP して `exit 0` する (`tests/state-cli.test.sh:24`、`tests/state-schema.test.sh`、`tests/state-cli-iteration.test.sh:28`、`tests/install-sh-state-cli.test.sh:24` — いずれも deno 不在時)。この設計自体は「依存ゼロで走る」ための意図的なもので、変える必要はない。問題は**それが最終行から見えない**ことである。

2026-08-03 の実測 (deno と shellcheck を PATH から外した実行):

```
$ env PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh tests/run.sh
SKIP  install-sh-state-cli test — deno not found
SKIP  C14c shellcheck -s sh install.sh — shellcheck が無い
SKIP  state-cli-iteration test — deno not found
SKIP  state-cli tests — deno not found
SKIP  state-schema tests — deno not found
SKIP  D3 shellcheck — shellcheck が無い
suites: 8 / failed: 0 (elapsed 19s)
```

8 スイート中 4 スイートが丸ごと消えている — 失われるのは `task-pipeline/scripts/state.ts` (2222 行) と `task-pipeline/scripts/state-schema.ts` の全カバレッジ、および symlink 越し実行の確認である。それでも表示は `failed: 0` で、通常実行 (`suites: 8 / failed: 0 (elapsed 26s)`) と経過秒数以外は区別が付かない。

情報が無いわけではない。`tests/install-sh.test.sh:234` は自分で `printf 'PASS %s / FAIL %s / SKIP %s\n' ...` を出しており、`tests/install-sh.test.sh:45` の `note()` が SKIP を数えている。スイート側にある値を `run.sh` が捨てているだけである。

## 要求

1. `tests/run.sh` が SKIP された件数を集計し、最終行に出す。現在の全スイートが出している SKIP 行 (`SKIP ` で始まる行) を拾えること。
2. 必須ツールの欠落を失敗として扱う opt-in のモードを足す (環境変数でよい)。このモードでは、SKIP が 1 件でもあれば非 0 で終わる。
3. **既定の挙動は変えない** — 何も指定しなければ、deno が無い環境でも従来どおり exit 0 で終わる (「依存ゼロで走る」設計を壊さない)。
4. スイート側の SKIP 出力形式を変える場合は、SKIP を出しうる全スイートで統一すること (片方だけ変えて集計から漏れる状態にしない)。
5. 集計のためにスイートの出力を捕捉する必要があるなら、**実行中の出力が失われないようにする** (現在はスイートの stdout がそのまま端末に流れており、長いスイートの進行が見える)。

## 受け入れ条件

1. deno を PATH から外して `sh tests/run.sh` を実行すると、最終行に SKIP された件数が表示される。実行した実出力が成果物にある。
2. 同じ条件で opt-in モード (実装で決めた環境変数) を付けて実行すると、非 0 の終了コードで終わる。実出力が成果物にある。
3. 通常環境 (deno あり) で `sh tests/run.sh` が exit 0 で終わり、最終行の SKIP 件数が実際の SKIP 数と一致する。実出力が成果物にある。
4. 既定モードでは、deno を外した実行が従来どおり exit 0 で終わる。実出力が成果物にある。
5. `SKIP ` を出すスイート (`state-cli` / `state-schema` / `state-cli-iteration` / `install-sh-state-cli` / `install-sh`) の SKIP が、いずれも条件 1 の集計に含まれている。
6. スイートの出力が実行中も従来どおり見える (要求 5)。確認方法を成果物に書くこと。
7. `sh tests/run.sh` が全スイート PASS で exit 0。
