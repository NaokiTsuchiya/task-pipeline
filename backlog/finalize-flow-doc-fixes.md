# finalize 前後の SKILL.md の記述が CLI の前提と食い違い、pr_fix 復帰で指摘が再浮上する

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。以下 3 点はいずれも 2026-08-03 に実 verb で再現済み (フィクスチャ `tests/fixtures/state-cli/valid-watch-rebase.json` を state.json として置き、CLI だけで遷移させた)。

### (a) `fix-done` の呼び出し順が文面から一意に決まらず、誤った順で指摘が再浮上する

`fix-done` の前提は `status=="in_progress" && phase=="finalize" && review.watch!=null` (`task-pipeline/docs/state-cli-contract.md:393`)。ところが SKILL.md:218 の「レビュー待ち処理」は `state.ts in-review` の呼び出しから書き始まり (これで `status: in_review, phase: null` になる)、その配下の SKILL.md:227 が `fix-done` について課している順序制約は「**上の watch 起動 (とその前に入る catch-up 観測) より前に済ませる**」だけである。watch 起動は SKILL.md:218 の末尾にあるので、**この制約は「in-review の後・watch 起動の前」でも満たせてしまう**。

実測 (`in_progress/finalize + watch` を `fix-pending` → `fix-start` → `finalize-start --from pr_fix` で作ってから、2 通りの順で流した):

```
[A] SKILL.md の文面が許す順            [B] 実際に必要な順
$ state.ts in-review --id t-full        $ state.ts fix-done --id t-full
  {"ok":true,...} exit=0                  {"ok":true,...} exit=0
$ state.ts fix-done --id t-full         $ state.ts in-review --id t-full
  {"error":"conflict","message":          {"ok":true,...} exit=0
   "status must be in_progress, phase
    must be finalize, and review.watch
    must be present"} exit=15
=> pending_ids=["rc-9","rc-8"]          => pending_ids=[]
   handled=["c1","c2"]                     handled=["c1","c2","rc-9","rc-8"]
```

[A] では対応済みの指摘が `pending_ids` に残ったまま `handled` に合流しない。SKILL.md:227 自身が「順序が逆になると、いま対応したばかりの指摘が未対応として再浮上する」と警告している事態が、その同じ行の順序制約が緩いために起きる。必要な制約は「**`in-review` の呼び出しより前**」である。

### (b) `finalize-start --from` の値が SKILL.md だけ 2 値になっている

SKILL.md:217 は `state.ts finalize-start --id <id> --from <report|pr_fix>` と書き、括弧書きも「`<phase>` は直前に PASS したフェーズ = `report` または `pr_fix`」と 2 値に閉じている。実装と契約は 3 値を受ける (`docs/state-cli-contract.md:275-281`、`task-pipeline/scripts/state.ts:1212-1216`)。契約は `rebase_fix` が要る理由まで明記している。

さらに SKILL.md:424 (解決サイクル手順 3) が「`PHASE rebase_fix DONE` の停止通知 → フレッシュな検証ゲート → **PASS なら通常どおり `finalize`**」と、その 3 値目への導線を張っている。実測でも `--from rebase_fix` は成功する:

```
$ state.ts rebase-start --id t-full --session s1
  {"ok":true,"id":"t-full","status":"in_progress","phase":"rebase_fix"} exit=0
$ state.ts finalize-start --id t-full --from rebase_fix
  {"ok":true,"id":"t-full","phase":"finalize"} exit=0
```

なお `state.ts:1209-1211` のコメント自身が、この食い違いを認識したまま残っている。

### (c) `finish=none` のときの `in-review` の呼び出し形が一意に決まらない

SKILL.md:218 は「**コミットが 0 件のとき (`finish=none`) は `--commits 0` のみ (4 フラグは付けるが `--tip` は付けない — 付けると `usage`)。**」と書く。「`--commits 0` のみ」と「4 フラグは付ける」が同じ文の中で矛盾しており、さらに同じ行の後半は「`finish=none` で `ref` を渡さない場合」と 3 つ目の読み方を示す。契約 (`docs/state-cli-contract.md:296-298`) は「`--commits`/`--ref`/`--branch`/`--base` は 4 つとも指定か 4 つとも省略のどちらかのみ」である。

実測 (3 通りの読み方をそれぞれ実行):

```
--commits 0 のみ
  → {"error":"usage","message":"--ref/--branch/--base/--commits must all be given together (or all omitted)"} exit=10
--commits 0 --ref null --branch task-pipeline/t-full --base main
  → {"ok":true,...} exit=0 ですが review.ref に文字列 "null" が入る
4 フラグとも省略
  → {"ok":true,...} exit=0、review は変更されない (新規タスクでは null のまま)
```

`finish=none` にはコミットも ref も無いので、`review` に書くべき値が無く、4 フラグとも省略するのが実態に合う。ところが契約の同じ箇所は省略形を「`pr_fix`/`rebase_fix` からの復帰専用」と説明しており、`finish=none` での使用がその説明に含まれていない。

**この曖昧さは既にテストに入り込んでいる。** `tests/state-cli-iteration.test.sh:103` は `in-review --id "$id" --commits 0 --ref none --branch "task-pipeline/$id" --base main` を流しており、`review.ref` に文字列 `"none"` が書かれる。SKILL.md:218 自身の「`ref`: ... `none` なら無し」と食い違う。

## 要求

1. **(a)** SKILL.md の `fix-done` の順序制約を「`in-review` の呼び出しより前」に直す。併せて `fix-done` の前提 3 条件 (`status=="in_progress"` / `phase=="finalize"` / `review.watch!=null`) が SKILL.md から読み取れるようにする — 現在の文面には前提が書かれておらず、順序が要る理由が追えない。
2. **(b)** SKILL.md:217 の `--from` の記法を 3 値にし、括弧書きの「= `report` または `pr_fix`」も直す。SKILL.md:424 から辿った読み手が `rebase_fix` を渡せると分かる状態にする。
3. **(c)** `finish=none` の `in-review` の呼び出し形を SKILL.md 上で一意に書く。契約の「4 つとも指定か 4 つとも省略」と整合し、`review.ref` に `"none"`/`"null"` のような番兵文字列を書かない形にすること。省略形の使途について契約の説明 (`pr_fix`/`rebase_fix` からの復帰専用) と齟齬が出るなら、SKILL.md 側にその旨を 1 行添えて解消する。
4. `tests/state-cli-iteration.test.sh:103` の `in-review` 呼び出しを要求 3 で決めた形に揃える。併せて、pr_fix 復帰の verb 列 (`fix-pending` → `fix-start` → `finalize-start --from pr_fix` → `fix-done` → `in-review`) を同ハーネスに追加し、順序を間違えたときに赤くなるようにする。
5. **`task-pipeline/scripts/state.ts` と `task-pipeline/docs/state-cli-contract.md` は変更しない** — 実装と契約は既に正しく、食い違っているのは SKILL.md とテストである。

## 受け入れ条件

1. SKILL.md の `fix-done` の順序制約が「`in-review` の呼び出しより前」と読める形になっており、「watch 起動より前」だけを条件とする記述が残っていない。
2. SKILL.md に `fix-done` の前提 3 条件 (`status=="in_progress"` / `phase=="finalize"` / `review.watch!=null`) が書かれている。
3. `grep -n 'finalize-start' task-pipeline/SKILL.md` が返す記法に `rebase_fix` が含まれ、「= `report` または `pr_fix`」のような 2 値に閉じた説明が残っていない。
4. `finish=none` のときの `in-review` の呼び出し形が SKILL.md 上で一意である — 同じ箇所に「`--commits 0` のみ」と「4 フラグは付ける」のように両立しない指示が併存していない。
5. 変更後の SKILL.md の手順どおりに CLI を実際に呼んだ実出力が成果物にあり、次の 2 つが示されている: (a) pr_fix 復帰の列で `fix-done` が exit 0 で成功し、直前の `pending_ids` が `handled` に合流して `pending_ids` が空になること、(b) `finish=none` の `in-review` が exit 0 で成功し、その後の `review` が null または `review.ref` が null であること (番兵文字列が入っていないこと)。
6. `tests/state-cli-iteration.test.sh` の `in-review` 呼び出しが受け入れ条件 4 で一意に決まった形と一致しており、`review.ref` に `"none"` が残らない。
7. `tests/state-cli-iteration.test.sh` に pr_fix 復帰の verb 列のケースがあり、PASS する。そのケースで `fix-done` を `in-review` の後に呼ぶよう入れ替えると FAIL することを確認した実出力が成果物にある (入れ替えは確認後に元へ戻すこと)。
8. `git diff` で `task-pipeline/scripts/state.ts` と `task-pipeline/docs/state-cli-contract.md` に変更が無い。
9. `sh tests/run.sh` が全スイート PASS で exit 0。
