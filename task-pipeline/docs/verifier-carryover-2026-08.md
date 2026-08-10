# 検証の持ち越し (`carryover`) を数える (2026-08)

gh-63 の実装で `references/verifier.md` の判定 JSON に `carryover` フィールドが加わった。フィールドの定義そのものの正は `references/verifier.md` の「持ち越しの記録 (`carryover`)」節にある (ここでは再掲しない)。この文書が書くのは、**蓄積された判定ファイルから遵守状況を数える手順**だけである。

## 数える手順

```
python3 task-pipeline/docs/scripts/count-carryover.py <repo root>
```

`<repo root>/.task-pipeline/runs/*/verdicts/*.json` を全走査し、attempt が 0 より大きい `FAIL` 判定 (= 持ち越しが起こりうる判定) を分母として、`carryover.status` の内訳を stdout に出す。

## 出力の読み方

- **`denominator (attempt>0 FAIL)`** — 分母。attempt 0 (直前の判定が無い) の FAIL は持ち越しの概念が成立しないので分母に含めない。`verdict != "FAIL"` の判定・`carryover` の値が壊れている判定 (`malformed`) は分母には入るが、遵守状況の判定材料にはならない。
- **`no-carryover-field`** — `carryover` フィールドを持たない判定 (この変更より前に書かれた判定、またはフィールドを書き忘れた判定)。
- **`carryover count (explained + missed + unexplained)`** — 実際に持ち越しが起きた件数。
- **`unexplained carryover count`** — このうち理由の無い持ち越し。**一括の原則を破ったものの件数**。
- **`self-admitted missed count`** — 検証者自身が「前回出せたはずだ」と自認した件数。これも一括の原則を破ったものとして扱う (`verifier.md` 参照)。
- **`by phase`** — 上記の内訳をフェーズ別に見たもの。判定 JSON 本文の `phase` キーで束ねる (ファイル名の phase 接頭辞ではない — pr_fix/rebase_fix はファイル名が 3 要素になるため)。

## 2026-08-10 時点の実行結果

```
$ python3 task-pipeline/docs/scripts/count-carryover.py /Users/naoki/work/github.com/NaokiTsuchiya/skills
scanned:        301
unreadable:     0
not-FAIL:       232
unnumbered:     0
first-attempt:  49
denominator (attempt>0 FAIL): 20
no-carryover-field: 20
malformed:      0

status counts:
  none: 0
  explained: 0
  missed: 0
  unexplained: 0
  unknown: 0

carryover count (explained + missed + unexplained): 0
unexplained carryover count: 0
self-admitted missed count: 0

by phase:
```

分母 20 件はすべて `no-carryover-field` — この変更が入る前に書かれた判定であり、`carryover` フィールドをまだ持たない。持ち越し件数・理由の無い持ち越し件数はいずれも 0 件 (新フィールドを持つ判定がまだ 1 件も無いことの確認であり、遵守が測れたわけではない — `docs/history/backlog/verifier-fixes-at-once.md` の「既存の判定ファイルへの遡及記入はしない」の帰結どおり、これから書かれる判定にだけこの値が付く)。
