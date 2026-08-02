# gate: light タスクの research が issue 本文を再掲するだけになっている件 (2026-08)

まだ設計が固まっていない。ここに観測事実とレビューで見つかった落とし穴を記録し、深く設計するときの
出発点にする。着手可能なところ (sha 記録) だけ `backlog/sha-record-for-gate-light.md` に切り出し済み。

## 観測 (RayDiContext #114, 2026-08-02)

`gate: light` タスクの `research.md` を issue 本文と突き合わせたところ、両者はほぼ同一だった:
`grep -rn "555" tests/` の結果、`skipUnlessEnforced` の4ファイル10箇所の列挙、
`d922fa8`→`6da64ad`→`557b528` のcommit考古学、いずれもissue本文に既に (同じgrepコマンド・同じ結論で)
書かれている。issue本文を超えて research.md が独自に加えた情報は実質2点だけだった:
(a) 現在のworktree HEADでも3箇所の前提が崩れていないかの再確認、
(b) CHANGELOGの競合状況 (どのissueが既にマージ済みか) の最新化。

これは `task-prep` の `gate: light` 宣言条件 (仕様軸: 機械検証可能な受け入れ条件が本文に列挙されている /
リスク軸: 判定の割り当てを変えない) が、issue 執筆時点で既に research 相当の裏取りを終えていることを
前提にしているために起きている。research フェーズが同じ裏取りをやり直しているだけ、という構図。

## 検討した設計と、レビューで見つかった欠陥

### 案1: research.md に「issue の事実主張を信頼してよい」と書かせる

verifier の research 節「関連ファイル・現状挙動の記述が実在のパス・内容と一致する (最低2か所は
自分で開いて突き合わせる)」を、gate:light 時は緩和する案。

**却下理由 (1回目のレビュー):**
- **前提の誤読**: 上記の「最低2か所開いて突き合わせる」は **verifier 自身**の義務であって、executor に
  悉皆再調査を課す文言ではない。削減対象の特定がそもそもずれていた。
- **自己申告への依存**: 「research.md が確認したと書いていること」を合格条件にすると、verifier.md の
  核心原則「成果物の主張を信じず、現物で確かめる」「自己申告はどの判定の材料にもしない」と正面衝突する。
  verifier が独自に裏取りし直せば緩和効果は消え、しなければ判定が形骸化する。

### 案2: issue 本文に裏取り時点の commit sha を記録し、verifier は sha と現在 HEAD の機械的 diff で判定する

自己申告を避けるため、判定を「research.md の主張」ではなく「コード側の変化の有無」という客観的な
事実に置き換える案。宣言が覆ったら (仕様軸・リスク軸の不成立、または sha diff 検出) 同フェーズ内で
パッチせず、blocked にして task-prep に機械的に差し戻す (通常の blocked と区別できるマーカーを付け、
task-prep の棚卸しの除外ルールに例外を追加する) 設計にした。

**却下理由 (2回目のレビュー、さらに深刻):**
- **`declaration: overturned` は `verdict: PASS` と両立する** (現行 verifier.md「覆しても判定基準は
  変わらない」= full相当で判定して通ればPASS)。宣言が覆っただけで即 blocked にする分岐だと、
  **正しく完成した (PASSした) タスクまで blocked に落ちる**。「宣言が覆る」と「検証が落ちる」の混同。
- **差し戻しループが閉じない**: gh の棚卸し除外条件は「状態ラベル・assignee・PR紐付け」の3つ。
  blocked にしても assignee は外れない設計なので、区別用ラベルを足すだけでは task-prep の棚卸しに
  現れず、直しても task-pipeline に再登場しない。
- **sha diff 対象が自己申告に逆戻り**: 「research.md が引用するパス」を diff 対象にすると、
  research.md (executor の生成物) が対象範囲を決めることになり、案1と同じ構造の穴に戻る。
  issue 本文が明示したパスに絞る必要がある。
- **後方互換が無い**: 既存の gate:light issue は全件 sha 未記録なので、導入直後に全部 blocked になる。
- 衝突する既存文言 (verifier.md の「統合で減るのはゲートの回数であって基準ではない」「フェーズの
  やり直しやgateの変更は求めない」、gh アダプタのラベル運用ルール) を改訂対象として明記できていなかった。
- executor.md を対象に含めながら、実際の要求・受け入れ条件のどこにも触れていなかった (スコープの
  不整合)。本来の動機 (research.md が issue 本文の再掲になっている) は executor.md 側の書き方を
  変えない限り解消しない。

## 次にここへ来たら

- sha 記録 (`backlog/sha-record-for-gate-light.md`) が実装されていれば、それを土台に「sha diff で
  判定する」設計を再検討してよい。ただし対象パスは **issue 本文が明示したものに限定**し、
  research.md の引用は使わないこと。
- blocked 化の分岐を作るなら、**`verdict: FAIL` かつ `declaration: overturned` のときだけ**にする
  (PASS したタスクを巻き込まない)。
- 差し戻しループを閉じるなら、gh の assignee 解除・ラベル運用まで含めて設計すること
  (`task-pipeline/references/adapters/gh.md` と `task-prep/references/trackers/gh.md` の両方が対象)。
- 本来の動機に戻るなら、verifier.md だけでなく executor.md の research 節の書き方 (issue 本文を
  引き写さない指示) も対象に含めること。
- 「事実の再検証」と「今回の変更の分析 (テスト網羅の最低ライン・エントリポイント洗い出し)」は別物。
  後者は plan の材料であり、issue 本文があってもなくても research.md が行う — ここを混同しないこと。
