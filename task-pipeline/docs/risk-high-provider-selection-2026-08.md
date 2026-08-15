# タスクごとの事前評価で provider を選ぶ経路を足した記録 (2026-08)

`risk-high` 宣言と prefs の `providers_by_class` を足して、**provider・model の選択をタスクごとの事前評価に従わせた**記録である。
宣言の判定は上流 (task-prep) の裏取り時点で行い、パイプラインはそれを消費するだけになる。
**ワークフロー (フェーズ列とゲートの数) は変えていない** — そこを決めるのは従来どおり `gate` 宣言だけである。

## 1. 出発点

2026-08 時点の形は次の 2 つで、掛け合わせが無かった。

- **ワークフローはタスクごとに 2 値**。`gate: light` があれば research と plan を 1 フェーズに統合し検証ゲートを 1 回減らす、無ければ 4 フェーズ 4 ゲート (`research-plan-merge-2026-08.md`、`gate-declaration-2026-08.md`)。
- **provider・model は役割ごとに静的**。`impl` が executor、`audit` が verifier で、どのタスクでも同じ組が使われる (`playbooks/agent-launch.md` の役割の表)。

取り逃がしているのは「タスクによって間違いの代償が違う」ことである。公開 API の契約変更とテストの整理を同じ組で回すのは、
**高い方に合わせれば安い側で払い過ぎ、安い方に合わせれば高い側で足りない**。しかも task-prep は深掘りの裏取り時点で
どちらなのかを既に知っている — 触る場所も、それが何を壊しうるかも、そこで調べ切っている。**知っている場所と、それを使う場所が繋がっていなかった。**

## 2. 決定

**宣言を 1 つと、宣言→provider の写像を 1 つだけ足す。**

1. **`risk-high` 宣言** (task-prep が付ける) — 6 項目のいずれか 1 つでも当たれば宣言する 1 軸。公開 API・エクスポート契約の変更 /
   スキーマ・データ移行 / セキュリティ経路 (authn/authz・暗号・入力検証) / 並行性・ロック / 複数モジュールにまたがる血流域 / 新規依存の導入。
   トラッカー表現は既存の `gate-light` と**完全に同じ経路** — gh はラベル `risk-high`、markdown は本文末尾マーカー行
   `<!-- task-pipeline:risk=high -->`。gh で本文マーカーを使わないのは、それが**実測で 2/3 落ちた**経路だからである (`gate-declaration-2026-08.md` §1〜§2)。
2. **class の導出 (3 値)** — アダプタが宣言を frontmatter (`gate: light` / `risk: high`) へ転写し、起動の直前に grep 2 本で
   `trivial` / `high` / `standard` を導く (`playbooks/agent-launch.md`「タスクの class」)。
3. **`providers_by_class`** — prefs の `providers` の 1 段手前に class 行を挟む。解決は 3 段から **4 段**になる:
   起動引数 → `providers_by_class[<class>]` → `providers` → 既定の組。

**既存の `gate: light` が「低リスク側の事前評価」として既にあるので、新設したのは高リスク側の宣言と写像の 2 つだけである。**
評価の置き場を上流に取ったのは、判定に要る材料 (何に触るか) が裏取り時点に揃っていて、実装時点には残っていないためである。
**人間承認が宣言の唯一のゲートである** — task-prep の書き込みは承認を経る (`task-prep/SKILL.md`「承認と書き込み」) 一方、
パイプライン側に宣言を再判定する経路は無い。

## 3. 作らなかったもの

いずれも「足せば効きそうに見えるが、足すと戻せなくなる」側である。**却下の理由を残す。**

- **第 3 のワークフロー列 (`direct` 等) を作らない。** ワークフローは binary (full / light) のままにした。列を足すと
  `state.ts` の辺と verifier の再利用判定が列の数だけ増え、**検証ゲートを飛ばす列**を一度作れば、以後それが既定になっていく圧力が掛かる。
  検証ゲートは最高価値の欠陥 (バグがあっても緑になる回帰テスト設計) を実際に捕まえている (`cost-analysis-2026-07.md` §6)。
- **`gate` を N 値に一般化しない。** `gate` はフェーズ列の選択であって、リスクの目盛りではない。同じキーに 2 つの意味を持たせると、
  provider を変えたいだけの宣言がワークフローを動かしてしまう。**軸は別のキー (`risk`) に分けた。**
- **size (規模) の軸を作らない。** 粒度は `task-prep/SKILL.md`「粒度」が「1 サイクルで通せるサイズ」に正規化済みで、
  超えているものの正しい出力は宣言ではなく**分解**である。大きさを申告できるようにすると、分解すべきものが宣言付きで通る。
- **class を state.json に書かない。** frontmatter から必ず導けるので、状態に持たせると転写が二重になり腐りうる。
  `state.schema.json`・`state.ts`・advance の辺・verifier の再利用判定は**一切変更していない**。
- **パイプライン側で宣言を再判定しない。** `gate` 宣言は統合ゲートの verifier が覆せる (覆っても判定基準は変わらない) が、
  `risk-high` は検証を足す方向にしか効かないので、覆す経路を作る価値が無い。

## 4. 安全不変条件

**故障の質が実装側と検証側で非対称である**ことが、この設計のすべての床を決めている。

- **verifier を弱めた故障は沈黙する** — 誤 PASS はどこにも現れず、壊れた成果物がそのまま in_review へ進む。
- **executor を弱めた故障はうるさい** — 実装が足りなければ検証ゲートが FAIL を返し、3 回で blocked になって人に届く。

したがって:

1. **`providers_by_class` の `audit` (検証) 行は `high` の class にしか効かない** (上方向専用)。`trivial.audit` / `standard.audit` は
   無視して `providers.audit` へ落とし、history に 1 行残す。**実装側は class で下げてよく、検証側は上げる方向にしか動かさない。**
2. **`gate: light` と `risk: high` の両方が見えたら `high` を採る** (保守側) + history に 1 行。宣言としては背反なので、
   これは task-prep 側の誤りであり、棚卸しの横断チェックで拾う (`task-prep/SKILL.md`「棚卸し」手順 4)。
3. **政策値と不変条件の置き場を分ける。** どの class にどの provider・model を割り当てるか (政策値) は prefs にあり、
   床・方向の制限・段の順序・mode の規則 (不変条件) は `playbooks/agent-launch.md` にある。**prefs に何を書いても不変条件は上書きできない。**
4. **既定は素通り。** `providers_by_class` を置かない環境では段 2 が無いのと同じで、解決は従来の 3 段と一致する。
5. **class 行にも既存の作法がそのまま掛かる** — 無人 mode の事前チェック、実在確認、junie の除外。通らなければその値を捨てて段を下げるだけで、
   **フォールバックの終端 (現行ハーネス経路 / セッション継承 / `block`) は置き換えない。**

## 5. 今回入れた変更の範囲

**`providers_by_class` は空のままである** — このリポジトリは `~/.paseo/orchestration-preferences.json` を作らない
(`orchestration-preferences.md` の冒頭)。今回入れたのは**宣言の経路と、写像の形と例**だけで、**既定の挙動は 1 つも変わっていない。**

変更したファイル: `SKILL.md` (claim 手順 1 に grep 1 本)、`references/adapters/gh.md`、`references/adapters/markdown.md`
(`risk: high` の転写と `risk_declared`)、`playbooks/agent-launch.md` (class の導出・4 段の解決・床)、
`docs/orchestration-preferences.md` (例)、`task-prep/SKILL.md` (`risk-high` 宣言の節と棚卸しの横断チェック)、
`task-prep/references/trackers/gh.md`、`task-prep/references/trackers/markdown.md` (書式)。
`tests/agent-launch-contract.test.ts` (解決手順の契約を 3 段から 4 段へ。既存の A2 / A3b が「3 段目が既定の組」を
固定していたので、段の番号を定数 (`DEFAULT_SET_STEP`) にして、class の 3 値・床・両立時の倒し方に A 群と B 群の回帰注入を足した)。
**`scripts/state.ts`・`scripts/state.schema.json`・`references/executor.md`・`references/verifier.md` には触っていない。**

## 6. ロールアウト

**2 つの tier は解禁の条件が違う。上方向と下方向で、間違えたときに払うものが違うからである。**

- **`high` (上方向) は測定なしで解禁してよい。** 効果は「強いモデルに払う」だけで、失敗の形は費用の増加であり、
  ゲートの判定にも成果物にも劣化方向の影響が無い。効いているかは事後に role/phase 別のコストと FAIL 率で見れば足りる
  (`docs/scripts/aggregate-role-phase-cost.py`)。
- **`trivial` (下方向) は事前登録した A/B の測定が通るまで既定有効化しない。** 安いモデルへ下げる変更は、
  **効果が単価にしか出ず、劣化はゲートの往復として遅れて出る**。実測は既にこの形の落とし穴を 2 つ示している:
  (a) `adapter-list` を `haiku` に固定すると実費は 3.5〜9.4 分の 1 になるが**トークン量はむしろ増える** (ターン数が伸びる。`cost-analysis-2026-07.md` §10)、
  (b) 判断が成果物の役割を `haiku` にすると issue の重複を見落とす (`SKILL.md`「承認」手順 2)。
  **単価が下がったことを効果と読み違えないための事前登録**が要る — 何を指標にするか (検証ゲートの FAIL 率、blocked 率、
  1 タスクあたりの実費と所要時間)、何件で判断するか、どうなったら止めるかを、有効化の**前に**書いておくこと。
  検証ゲート 1 回の所要は実測 2.1〜4.5 分 (`gate-declaration-2026-08.md` §1) なので、往復が 1 回増えれば単価の差はすぐ食い潰される。

## 7. 残る宿題

- **`risk-high` の経路は実運用で 1 度も走っていない。** 最初の 1 本は、トラッカー側の宣言と frontmatter の `risk: high`、
  および `mark in_progress` の `risk_declared` が揃っていることを確認すること (食い違えば history に出る)。
- **`risk-high` ラベルは `gate-light` と同じく全置換で消えうる** (`gate-declaration-2026-08.md` §4 と同じ性質)。
  消えても安全側 (`standard`) に倒れるだけだが、静かに失われる点は同じである。
- **6 項目の判定例は task-prep の判定を実際に発火させられるか未検証。** `gate` 宣言のリスク軸では、基準文だけでは
  適格な 4 件のうち 2 件しか宣言できなかった (`task-prep/SKILL.md`「gate 宣言 (light)」)。同じ轍を避けるため例を初日から置いたが、
  それで足りるかは最初の数件の実測で見る。
