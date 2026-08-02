# research.md を差分レポート化し、gate:light では sha diff による事実主張の引き継ぎを許す

## 背景

`gate: light` タスクの research.md が issue 本文の再掲になっている (RayDiContext #114 の観測、
`task-pipeline/docs/gate-light-research-trust-2026-08.md`)。task-prep の深掘りが証拠付きで本文に
書いた事実主張を、executor が同じコマンドで再調査し、同じ結論を書き写している。同ドキュメントの
「採った方向 (2026-08-03)」のとおり、verifier の基準は緩めず、executor の書き方 (段1) と労力 (段2) を
変える。過去 2 案 (research.md への信頼宣言、sha diff による gate 分岐 + blocked 差し戻し) はレビューで
却下済みで、その欠陥一覧も同ドキュメントにある — 本 issue はそれらの設計を含まない。

## 要求

1. **段1 — 転記禁止 (全タスク共通の書き方規律)**: `task-pipeline/references/executor.md` の research 節
   (research+plan 節にも同じ規律が及ぶことを明示) に追加する: issue 本文 (タスクファイル本文) が
   事実主張を根拠 (コマンドと結果) 付きで既に含むとき、research.md はそれを再掲しない。書くのは
   「本文のどの主張を現 HEAD で確認したか」の参照と、本文に無い新情報 (制約、競合状況、不明点の解消、
   本文執筆後の変化) だけ。
2. **段2 — 引き継ぎ (gate:light + sha 記録があるときだけ)**: 同じく executor.md に追加する: タスクの
   gate が light で、本文に `裏取り時点: <sha>` 行 (書式は `backlog/sha-record-for-gate-light.md` が
   導入するもの) があるとき、`git diff <sha> HEAD -- <パス...>` が**空**なら、そのパス群に閉じた
   事実主張の再実行 (grep のやり直し等) を省略してよい。research.md には実行した diff コマンドと
   結果 (空であること) を書く。制約 3 つを明記する:
   - **スコープは issue 本文が明示的に名指すパスに限る** (grep のスコープ、ファイル名)。本文から
     スコープを決められない主張 (リポジトリ全域に及ぶ否定形の主張等) は引き継げず、通常どおり再検証する。
   - **diff が空でない**場合、変化したパスに依存する主張だけを通常どおり再接地する (全体を full に
     戻す必要は無い)。
   - **sha がローカルで解決できない** (`git cat-file -e <sha>` が失敗する等) 場合は段2 を放棄して
     通常の research を行う。sha 行が無いタスクも同様 (段1 だけが効く)。
3. **verifier 側の追加は 1 点だけ**: `task-pipeline/references/verifier.md` の research 節に追加する:
   参照による記述 (issue 本文の主張を research.md が確認済み・引き継ぎ済みとして参照する形) も判定対象に
   含める。引き継ぎ根拠の diff は **verifier 自身が同じコマンドを実行して**空であることを確かめる
   (research.md の転記を信用しない)。既存の「最低 2 か所は自分で開いて突き合わせる」のサンプルは、
   引き継がれた主張を優先的に選ぶ。
4. verifier.md の既存の判定基準は**弱めない** — 追加のみで、既存の要求文の削除・緩和をしない。
5. **範囲外の明記**: 宣言が覆ったときの blocked 化・task-prep への差し戻し機構は作らない (設計判断と
   理由は上記ドキュメントの「採った方向」に記録済み)。`task-pipeline/SKILL.md`、アダプタ
   (`references/adapters/`)、task-prep 側のファイルは変更しない。
6. 引き継ぎが適用されるのは「事実の再検証」だけで、「今回の変更の分析」(テスト網羅の最低ラインの
   トリガー判定、エントリポイント洗い出し) には適用されないことを executor.md の追記内に明記する
   (executor.md 既存の「宣言に頼らず自分でも行う」の規律を保つ)。

## 受け入れ条件

1. executor.md の research 節に、本文が根拠付きで含む事実主張を再掲しない旨の記述があり、research+plan
   節からもそれが及ぶことが読み取れる。
2. executor.md に段2 の手順があり、次の 3 ケースの扱いをすべて含む: sha 行が無い / diff が空でない /
   sha が解決できない。diff のスコープが「issue 本文が明示的に名指すパスに限る」ことが明記されている。
3. verifier.md の research 節に、引き継ぎ根拠の diff を verifier 自身が実行して確かめる旨と、
   突き合わせのサンプルが引き継がれた主張を優先する旨がある。
4. `git diff -- task-pipeline/references/verifier.md` に既存要求文の削除行が無い (追加のみ)。
5. `git diff --name-only` に `task-pipeline/SKILL.md`・`task-pipeline/references/adapters/`・
   `task-prep/` 配下のファイルが現れない。
6. executor.md の追記内に、引き継ぎが「今回の変更の分析」(網羅トリガー判定・エントリポイント洗い出し)
   には適用されない旨の記述がある。

## 備考

- gate 宣言: verifier の判定基準の文言に触れるため付けない (full)。
- 優先度: 無指定。
- 依存: sha-record-for-gate-light
