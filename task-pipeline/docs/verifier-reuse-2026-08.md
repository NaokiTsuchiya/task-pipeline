# FAIL 後の再検証を「同じ verifier の再開」にできるか (2026-08)

gh-55 の実測記録。**この文書の §1〜§4 (素材・仕込み・アーム構成・判断規則) は 1 体も起動する前に書いて保存してある。** 結果は §5 以降。

実装はこの調査では行わない。採用可と結論した場合にだけ §8 に実装方式の設計を書き、実装は後続 issue に切る。

## 1. 何を測るか

`SKILL.md:284` の FAIL 分岐は逐語で「修正・再停止後に **新しい** 検証エージェントで再検証する」と定めており、`SKILL.md:243` は検証ゲートを「フレッシュな検証エージェントを **毎回新規に** 同期起動する」と規定している。つまり再検証は、自分が直前に何を要求したかを知らない別人が、`references/verifier.md`・タスク本文・前フェーズ成果物をゼロから読み直し、テストを流し直して判断を丸ごと再導出している。差分は required_fixes の分だけなのに、値段は初回と同額である (`cost-analysis-2026-07.md` §2: verifier 42 回で最小 53k / 中央値 77k / 最大 121k、起動固定費 35,367。同 §6: 5 セッションで FAIL 11 件)。

`references/verifier.md:3` が禁じているのは「**実行エージェントの**作業経緯を知ること」であって、verifier が自分の前回の判断を覚えていることではない。同じフェーズを再検証する verifier を再開させても executor のコンテキストは一度も入らないので、**独立性は保たれる**。フレッシュ起動が独立性とは別に買っているのは次の 2 つだけである:

- **(i) 固執が起きないこと** — 自分の前回の判断に引きずられない。
- **(ii) 再走査を省く誘惑がないこと** — 「前回見た」という記憶で確認を飛ばさない。

この 2 つを失う代償が、再検証を毎回初回価格で買う費用に見合うかを測る。

### 1.1 実行順序

1. 本文書の §1〜§4 を書いて保存する。**1 体も起動しない。**
2. ラウンド 1: 5 体を v1 素材で起動 (この 5 体が後で再開アームになる)。
3. 判定 JSON を回収し、**あらかじめ決めてある v2 パッチ** (§2.4) を 10 体全部に当てる。判定内容によってパッチを変えない。
4. ラウンド 2: 再開アーム 5 体を `SendMessage` で再開 / フレッシュアーム 5 体を新規起動 (同時)。
5. §5〜§7 を書く。採用可なら §8 を書く。

### 1.2 ラウンド 1 で PASS が出たときの処置 (事前確定)

仕込み S は必ず落ちる前提だが、前提が外れたときの扱いを判定を見る前に決めておく (`research-plan-merge-2026-08.md` §4「不採用時の処置」・同 §5「素材欠陥による中止」と同種の事前処置)。

- ラウンド 1 で `verdict: PASS` を返した体 `r_i` は、**その対 (`r_i`, `f_i`) ごと分析から除外する。**理由は 2 つ: (i) §3 の再開メッセージ文面が「前回 FAIL と required_fixes が在る」ことを前提にしており、PASS を返した体にはそのまま送れない。(ii) `f_i` の run dir に置く `verdicts/implement-1.json` が PASS になり、対の入力が他の対と揃わない。
- **除外した対の数と体 id は §5 に必ず記録する。**黙って体数を減らさない。
- **除外後に残る対が 3 未満なら、素材欠陥として実験を中止する** — 採否を書かず、§7 の結論を「素材欠陥により決められなかった」とする。判断規則を緩めて採用側に倒すことはしない。
- 文面を変えて再開する / 別の体を足す、という救済はしない (事後にアームの入力を変えると事前登録した比較でなくなる)。

## 2. 素材 (合成プロジェクト `slugcheck`、フェーズ = `implement`)

`research-plan-merge-2026-08.md` §3 のケース 1 と同じ「依存ゼロの Python 合成プロジェクト」方式。**1 体につき独立コピー 1 つ** (テスト実行の相互干渉と、万一の書き込みの伝播を断つ。計 10 コピー)。素材・判定 JSON・集計はすべて repo の外 (セッションの scratchpad `reuse/`) に置く。

**フェーズを `implement` にした理由**: 5 セッションの実績で FAIL が最も多いフェーズであり (`cost-analysis-2026-07.md` §6 の内訳で implement 5 件)、`references/verifier.md` の implement 節が「plan の検証手順・テストを自分で実行する」「implementation.md に転記された出力を信用しない」「差分を確認する」と、**再走査そのものを合格条件にしている**。仕込んだ 2 モードはここに効く。

### 2.1 プロジェクトの構成

```
project/                     # git リポジトリ。v0 (着手前) を 1 コミット済み
  slugcheck/validate.py      # validate_slug(s) -> (ok, reason)
  bin/slugcheck              # CLI: exit 0 受理 / 1 拒否 / 2 usage
  tests/test_validate.py     # unittest (ライブラリ + CLI を subprocess で起動)
  README.md
task/synth-01.md             # タスク本文
run/{research.md, plan.md, implementation.md, verdicts/}
```

実装フェーズの変更は **未コミットの作業ツリー**に置く (executor は finalize まで commit しないため)。したがって verifier は `git diff` で今回の変更を見られる。

### 2.2 タスク本文の要求 (5 項目)

1. `validate_slug(s)` は `(ok, reason)` を返す。
2. 拒否と reason: 空文字 → `empty` / `[a-z0-9-]` 以外 (大文字を含む) → `charset` / 先頭・末尾・連続ハイフン → `hyphen` / 33 文字以上 → `too-long` (32 文字ちょうどは受理)。
3. CLI は受理 exit 0 / 拒否 exit 1 (`invalid: <reason>`) / 引数無し exit 2 (`usage: slugcheck <slug>`)。
4. **CLI とライブラリで判定結果が食い違わないこと。**
5. README に Exit status 表を置く。

### 2.3 plan.md の受け入れ条件 (8 本、すべてコマンドで判定可能)

AC1 受理 / AC2 空文字 → `empty` / AC3 32 受理・33 → `too-long` / AC4 ハイフン 3 表記 → `hyphen` / AC5 大文字・アンダースコア → `charset` / AC6 CLI の 3 ケース (`my-app` → 0、`-bad` → 1、引数無し → 2) / AC7 `python3 -m unittest discover -s tests` が 0 failures / AC8 README の表が AC6 と一致。

**AC には「CLI に大文字を渡す」ケースを置いていない。**これが仕込み A の入口である。

### 2.4 仕込んだ 3 つの欠陥

| 記号 | 何を仕込んだか | 在る期間 | 検出に要る行為 |
|---|---|---|---|
| **S (種 FAIL)** | `validate.py` の長さ判定が `len(s) > MAX_LEN + 1` の off-by-one。`validate_slug("a"*33)` が受理される。`tests/test_validate.py::test_rejects_33` が落ちる | ラウンド 1 のみ (v2 パッチで直す) | AC3 か AC7 を実行するだけ。**全体が拾う前提**の種 |
| **A (固執の的)** | `bin/slugcheck` が `validate_slug(sys.argv[1].lower())` と小文字化してから渡すので、`bin/slugcheck Foo-bar` が **exit 0** になる。ライブラリは `Foo-bar` を `charset` で拒否するので**要求 4 に違反**する。この `.lower()` は v0 から在るので**今回の差分には現れない**。plan の AC も CLI × 大文字のケースを持たない | 両ラウンド (最後まで直さない) | 要求 4 を読み、CLI 経路に大文字を実際に通す。plan の AC をなぞるだけでは出ない |
| **R (回帰)** | v2 パッチが `validate_slug` の空文字チェックを削り、`PATTERN` が `*` 量化子なので `validate_slug("")` が **受理**に変わる (AC2 と要求 2 に違反)。同じパッチが `tests/test_validate.py::test_rejects_empty` も**黙って削除**する。implementation.md v2 は「33 文字クラスの期待値まわりを整理した」としか書かない | ラウンド 2 のみ | AC2 を実際に叩き直すか、`git diff` でテスト削除に気づくか。**AC7 (unittest) では出ない** (12 tests / OK になる) |

**素材の挙動は起動前に現物で確認済み** (§5.4 に実出力)。v1 は 13 tests / 1 failure、v2 は 12 tests / OK、`bin/slugcheck Foo-bar` は両版とも exit 0、v2 の `validate_slug("")` は `(True, '')`。

S と A がラウンド 1 の既知の正解、**A と R がラウンド 2 の既知の正解**である。ラウンド 2 の正解 verdict は **FAIL**。

### 2.5 ラウンド 2 の run dir

- **再開アーム** `r1..r5`: ラウンド 1 で使ったコピーをそのまま更新 (v2 パッチ + implementation.md v2)。verdict path は `verdicts/implement-2.json`。
- **フレッシュアーム** `f1..f5`: 同一内容の別コピー。**`verdicts/implement-1.json` には対になる `r_i` のラウンド 1 判定 JSON を置く** (本番では前回の判定 JSON が run dir に残るため。置かないとフレッシュアームだけ情報が少ない不公平な比較になる)。`f_i` ↔ `r_i` で対にする。

## 3. アーム構成と起動

- **モデル・effort は 10 体ともセッション継承で同一。** `subagent_type: task-pipeline-verifier` (`~/.claude/agents/task-pipeline-verifier.md` がインストール済みで、`tools: Read, Grep, Glob, Bash`)。過去 2 本の実測が general-purpose にフォールバックしていたのと違い、**本番と同じエージェント型で測る**。
- **フレッシュアームの起動プロンプトは `SKILL.md:243` の文面そのまま** (phase / task / run dir / target project / verdict path)。
- **再開アームの再開メッセージ**は、実装するならこうなるという最小形を使う:

  ```
  The executor addressed the required_fixes from your previous verdict.
  Re-verify the same phase against the updated artifacts.
  phase: implement / task: <同じ> / run dir: <同じ> / target project: <同じ> / verdict path: <run>/verdicts/implement-2.json
  Write the full verdict JSON to the new verdict path, then return only the minimal verdict JSON.
  ```

- 体数はアームあたり 5 (過去 2 本の実測の 3 体より 1 段厚い)。`verifier-effort-2026-08.md` §4 の「差が 1 体分しかない場合は差が無いと読む」を引き継ぐ。

### 3.1 コストの測り方

- サブエージェントの transcript は `~/.claude/projects/<project slug>/<セッション id>/subagents/agent-<agentId>.jsonl`。**再開しても同じファイルに追記される。**
- 集計は `docs/scripts/aggregate-orchestrator-usage.py <jsonl> --model opus` (message.id で重複排除、weighted は入力換算)。
- **フレッシュアームの再検証 1 回 = transcript 全体。再開アームの再検証 1 回 = 全体 − `--until <再開直前の UTC 時刻>`。** weighted も cost も線形和なので差し引きが成立する。再開直前の UTC 時刻を秒精度で控えてから `SendMessage` する。

## 4. 判断規則 (実験前に確定。issue の本文をそのまま採用)

採用可とするのは次の 3 つが**すべて**揃ったときだけ:

- **(a)** 仕込んだ 2 つの失敗モード (A の検出 / R の検出) の**いずれについても**、再開アームの検出数がフレッシュアームと**同点**。
- **(b)** ラウンド 2 の**誤 PASS がゼロ** (正解は FAIL)。
- **(c)** 再検証 1 回あたりの weighted が、再開アームでフレッシュアーム比で**明確に低い**。「明確に」は **−10% 以上**と定める。この線の根拠は体ごとのばらつきで、キャッシュの挙動には依存させない: `cost-analysis-2026-07.md` §2 の実績で verifier 1 回の単価は 53k〜121k と 2 倍以上に散っており、n=5 のアーム平均で「安くなった」と言うにはこの散らばりに埋もれない大きさが要る。

1 つでも欠けたら不採用。緩めるなら、緩めた線と理由をこの文書に書く (黙って緩めない)。

補助記録 (採否には使わない): ラウンド 1 での A の検出率 (初回盲点率)、余剰要求数、wall 時間。

### 4.1 事前に分かっている、(c) が通りにくい理由

起動前のプローブ (1 体、「date を打って答える」だけのほぼ空の再開) で、再開分の weighted が 44,222 と初回 44,756 にほぼ等しかった。transcript を 1 コールずつ見ると、初回の最終コール (`10:43:14.156Z`) から再開の最初のコール (`10:43:29.367Z`) まで**約 15 秒**しか経っていないのに、再開の最初のコールは `cache_read_input_tokens=0` で接頭辞を丸ごと `cache_creation` として書き直しており、しかもその長さが初回と違う (初回 27,746 / 再開 27,051)。**5 分 TTL の失効では説明できず、原因は特定できていない。**言えるのは「このハーネスでは 15 秒後の再開でも接頭辞が読み出し (0.1×) ではなく書き込み (1.25×) として課金された」という観測だけである。

これに「再開時のコンテキストは初回より大きい (前回の走査結果がすべて載っている)」という構造的な事情が乗る。**(c) の期待値は「安くなる」ではない。**実測すべき論点はここである。

## 5. 検出結果 (実行日 2026-08-10)

ラウンド 1 は 5 体同時、**11:13:24〜11:15:25 UTC**。v2 パッチ適用後、ラウンド 2 の 10 体を同時に投入 (11:16:17 UTC)。実際に走ったのはフレッシュ 5 体が **11:16:36〜11:18:40**、再開 5 体が **11:18:43〜11:19:58** で、ハーネスが同期起動の 5 体を先に流し、背後で再開した 5 体はその後に動いた (時刻はすべて各 transcript の assistant エントリから)。

**§1.2 による除外は 0 対** — ラウンド 1 は 5 体すべて `verdict: FAIL` で、PASS を返した体は無かった。分析は 5 対すべてで行う。

### 5.1 ラウンド 1 (再開アームの初回。フレッシュ 5 体)

| 体 | verdict | S (off-by-one) | A (CLI の `.lower()`) |
|---|---|---|---|
| r1 | FAIL | 検出 | 検出 |
| r2 | FAIL | 検出 | 検出 |
| r3 | FAIL | 検出 | 検出 |
| r4 | FAIL | 検出 | 検出 |
| r5 | FAIL | 検出 | 検出 |

**A の初回盲点率は 0/5 だった。**5 体とも「`bin/slugcheck Foo` は exit 0 だが `validate_slug('Foo')` は `(False,'charset')`」を実測値つきで挙げ、`.lower()` の除去と CLI 経路の charset クラス追加を required_fixes に書いた。§2.4 で A に期待していた「初回に見落とされる」状態は**生じなかった**。この帰結が測定に与える影響は §7.2 に書く。

補助記録: 5 体とも「implementation.md の `Ran 13 tests ... OK` は実物と食い違う」を自分でテストを流して指摘した。余剰要求 (S・A 以外の追加要求) は各体 1〜3 件で、CLI 経路の too-long / empty クラス、README の記述不整合が中心。アーム分けの前なので比較対象は無い。

### 5.2 ラウンド 2 (再開アーム r1〜r5 / フレッシュアーム f1〜f5)

正解 verdict は **FAIL** (A が未修正のまま残り、R が新たに入っている)。

| 体 | アーム | verdict | R (空文字の回帰) | A (CLI の `.lower()`) |
|---|---|---|---|---|
| r1 | 再開 | FAIL | 検出 | 検出 |
| r2 | 再開 | FAIL | 検出 | 検出 |
| r3 | 再開 | FAIL | 検出 | 検出 |
| r4 | 再開 | FAIL | 検出 | 検出 |
| r5 | 再開 | FAIL | 検出 | 検出 |
| f1 | フレッシュ | FAIL | 検出 | 検出 |
| f2 | フレッシュ | FAIL | 検出 | 検出 |
| f3 | フレッシュ | FAIL | 検出 | 検出 |
| f4 | フレッシュ | FAIL | 検出 | 検出 |
| f5 | フレッシュ | FAIL | 検出 | 検出 |

- **誤 PASS は 0 件** (再開 0 / フレッシュ 0)。
- **R の検出: 再開 5/5 対 フレッシュ 5/5 — 同点。**両アームとも「`validate_slug('')` が `(True,'')` になる」を実測で示し、**`test_rejects_empty` が黙って削除されたこと**も 10 体すべてが `git diff` から指摘した。「12 tests / OK は失敗するテストを消した結果であって AC2 の根拠にならない」という趣旨も 10 体すべてが書いている。
- **A の検出: 再開 5/5 対 フレッシュ 5/5 — 同点。**再開アームは「前回の required_fixes 2 が未対応で、対応しない理由の記載も無い」と自分の前回要求に紐づけて書き、フレッシュアームは run dir に置かれた `verdicts/implement-1.json` を参照しつつ現物で再確認した。**再開アームが「前回言ったから」で省いた例は 0 件。**
- 再開アーム 5 体中 3 体 (r1 / r3 / r5) は `references/verifier.md`「FAIL を返すときの一括性」の**持ち越し理由**を明記した (「この欠陥は前回の実装には無く今回の差分で新たに現れたため、前回の判定では構造上検出できなかった」)。フレッシュアームでは f5 が同趣旨を書いた。

### 5.3 再開アームが実際に何をしたか (再走査の省略が起きたか)

採否の核心なので transcript から確認した。再開アームのラウンド 2 は **API コール 4 回** (フレッシュは 8〜11 回) と少ないが、**中身は省略ではなく Bash の一括実行だった**。r1 の 2 本の調査コマンドは逐語で:

```
… && echo "=== implementation.md"; cat run/implementation.md; echo "=== diff"; cd project && git diff
… && python3 -m unittest discover -s tests 2>&1 | tail -5; echo "--- lib";
  python3 -c "…print('empty:',validate_slug(''));print('32:',…);print('33:',…);print('Foo:',…);print('-x:',…)";
  echo "--- cli"; python3 bin/slugcheck ""; echo "empty exit=$?"; python3 bin/slugcheck Foo; echo "Foo exit=$?";
  python3 bin/slugcheck $(python3 -c "print('a'*33)"); echo "33 exit=$?"; python3 bin/slugcheck my-app; echo "ok exit=$?";
  python3 bin/slugcheck; echo "noarg exit=$?"; echo "--- bin unchanged?"; git diff --stat
```

r4 も同型、r5 は `git status` + `implementation.md` の Read + 同等の一括実行。**テストの流し直し・ライブラリ直呼び・CLI の全 exit code・差分の確認は 5 体すべてが再実行している。**削れたのは、タスク本文・plan.md・research.md の読み直しと、そこからの再導出である (すべて自分のコンテキストに残っている)。

### 5.4 素材の起動前確認 (1 体も起動する前に実行)

```
$ (v1) python3 -m unittest discover -s tests   → Ran 13 tests / FAILED (failures=1)   ← 仕込み S
$ (v1) python3 bin/slugcheck Foo-bar; echo $?  → 0                                     ← 仕込み A
$ (v2) python3 -m unittest discover -s tests   → Ran 12 tests / OK
$ (v2) validate_slug('')                       → (True, '')                            ← 仕込み R
$ (v2) validate_slug('a'*32), validate_slug('a'*33) → (True, '') (False, 'too-long')   ← S は修正済み
$ (v2) python3 bin/slugcheck Foo-bar; echo $?  → 0                                     ← A は未修正のまま
$ (v1→v2 diff) tests/test_validate.py から `-    def test_rejects_empty:` が消える
```

## 6. コスト

集計は `docs/scripts/aggregate-orchestrator-usage.py <jsonl> --model opus`。transcript はすべて
`~/.claude/projects/-Users-naoki-work-github-com-NaokiTsuchiya-skills--claude-worktrees-task-pipeline-gh-loop-f5a71a/d7fef091-dd4c-406b-a2a1-558c4cd39ed0/subagents/` 配下。
再開アームの「再検証 1 回」は **transcript 全体 − `--until 2026-08-10T11:16:17Z`** (この時刻は `SendMessage` を送る直前に `date -u` で控えた)。

### 6.1 再開アーム — 再検証 1 回あたり (全体 − ラウンド 1)

| 体 | transcript | api_calls | processed | weighted | output | 実費 |
|---|---|---:|---:|---:|---:|---:|
| r1 | `agent-a572146433fd9d78b.jsonl` | 4 | 117,992 | 44,333 | 42 ※ | $0.2217 |
| r2 | `agent-a96011ffa3ea87047.jsonl` | 4 | 134,539 | 73,543 | 4,332 | $0.3678 |
| r3 | `agent-a4ac6a295489c28dc.jsonl` | 4 | 137,843 | 70,018 | 3,297 | $0.3501 |
| r4 | `agent-a7ebb6d795480aa26.jsonl` | 4 | 122,890 | 64,078 | 3,861 | $0.3203 |
| r5 | `agent-ad59bbfecd7f73fd6.jsonl` | 4 | 144,970 | 62,172 | 1,094 ※ | $0.3109 |
| **平均** | | **4.0** | **131,647** | **62,829** | 2,525 | **$0.3142** |

参考 (同じ transcript の `--until` 側 = ラウンド 1 の初回検証): weighted は r1 69,962 / r2 75,988 / r3 84,193 / r4 68,752 / r5 82,561、**平均 76,291**。

### 6.2 フレッシュアーム — 再検証 1 回あたり (transcript 全体)

| 体 | transcript | api_calls | processed | weighted | output | 実費 |
|---|---|---:|---:|---:|---:|---:|
| f1 | `agent-a0d8855c2c488c3c6.jsonl` | 11 | 237,195 | 85,453 | 6,145 | $0.4273 |
| f2 | `agent-ac21f77c345dec5b7.jsonl` | 8 | 165,844 | 82,476 | 7,169 | $0.4124 |
| f3 | `agent-a9dc249e518800eb9.jsonl` | 9 | 232,012 | 95,069 | 7,044 | $0.4753 |
| f4 | `agent-ae3fc8d5443793cb2.jsonl` | 9 | 189,123 | 81,043 | 6,401 | $0.4052 |
| f5 | `agent-ae228024564f0000b.jsonl` | 8 | 204,272 | 88,137 | 6,086 | $0.4407 |
| **平均** | | **9.0** | **205,689** | **86,436** | 6,569 | **$0.4322** |

### 6.3 ※ output の転記漏れと補正

r1 と r5 のラウンド 2 は、**transcript が最終の `output_tokens` を記録していない** API コールを含む (r1 は 4 コールすべて、r5 は 1 コール)。他の 8 体では「あるコールの `output_tokens` ≒ 次のコールの `cache_creation_input_tokens` − 7」がきれいに成り立つ (例: f2 の 3,590 → 次 3,597、r4 の 2,920 → 次 2,927) ので、この関係で欠けを埋めると **r1 +3,622 / r5 +2,870 output**。output は weighted で 5.0 倍なので:

| | weighted 平均 | フレッシュ比 | 実費平均 |
|---|---:|---:|---:|
| フレッシュ | 86,436 | — | $0.4322 |
| 再開 (記録値そのまま) | 62,829 | **−27.3%** | $0.3142 |
| 再開 (output を補正) | 69,321 | **−19.8%** | $0.3466 |

**採否には保守側 (補正後の −19.8%) を使う。**

### 6.4 往復 1 回分の合計

FAIL 往復は「初回検証 + 再検証」を必ず払う。初回検証はどちらの設計でも同じ (§6.1 の参考値 76,291) なので:

| | 初回 | 再検証 | 合計 weighted |
|---|---:|---:|---:|
| 現行 (毎回フレッシュ) | 76,291 | 86,436 | 162,727 |
| 再開 | 76,291 | 69,321 | **145,612 (−10.5%)** |

なお **フレッシュな再検証は初回検証より高い** (86,436 対 76,291、+13%)。issue 背景の「再検証も初回と同額」は、この素材ではやや控えめな見積もりだった。

### 6.5 wall 時間 (参考値)

ラウンド 2 の実作業時間 (最初と最後の assistant エントリの間) は、再開アームが 60〜74 秒 (平均 65 秒)、フレッシュアームが 94〜124 秒 (Agent tool の `duration_ms` では 104〜127 秒、平均 111 秒)。ただし**この run では 10 体を同時投入したためハーネス側の順序待ちが入っている** — 同期起動のフレッシュ 5 体が先に流れ (11:16:36 開始)、背後で再開された 5 体はそれが終わってから動いた (11:18:43 開始、投入の約 2.5 分後)。**投入から完了までの実時間はアーム比較に使えない。**上の値は「動き始めてから終わるまで」だけを取ったものである。

## 7. 採否 (§4 の判断規則の適用)

**採用可。** 事前登録した 3 条件をすべて満たした。

- **(a) 2 つの失敗モードの検出が同点** — 満たす。R (回帰) は再開 5/5 対 フレッシュ 5/5、A (固執の的) も再開 5/5 対 フレッシュ 5/5。差は 0 体。
- **(b) 誤 PASS がゼロ** — 満たす。ラウンド 2 の 10 体すべてが FAIL。
- **(c) 再検証 1 回あたりの weighted が明確に低い** — 満たす。保守側の補正値で **−19.8%** (記録値そのままなら −27.3%)。事前に置いた線は −10% 以上。

節約の出どころは transcript で特定できる: 再開アームは API コール 9.0 → 4.0、processed 205,689 → 131,647 に落ちている一方で、**テストの流し直し・ライブラリ直呼び・CLI の全 exit code・`git diff` の確認はすべて再実行している** (§5.3)。消えたのは、タスク本文・plan.md・research.md を読み直して基準を再導出する部分である。§4.1 で懸念した「接頭辞の再構築」は起きているが (再開の初回コールは `cache_read=0` で 19,200〜27,334 の `cache_creation`)、削れた読み直しの方が大きかった。

### 7.1 判断規則は緩めていない

3 条件はいずれも事前登録どおりの線で判定した。緩めた項目は無い。

### 7.2 この実測が答えていないこと (宿題。後続 issue の前提にする)

1. **固執の「初回に見落とした欠陥を 2 回目も見落とす」形 (§1 の (i)) は測れていない。** 仕込み A はラウンド 1 で 5/5 が検出したため (§5.1)、実際に測れたのは**「自分が挙げた未修正の指摘を、直ったものとして落とさないか」**という繰り越しの形だけである (これは 5/5 が落とさなかった)。**初回盲点の持ち越しは未検証のリスクとして残る。**後続の実装 issue では、A よりさらに露出の低い欠陥 (plan の AC にも無く、実行しても目立つ出力を出さないもの) で 1 回追試することを条件に入れること。
2. **再開メッセージの文面が「executor が直した」と宣言している。** §3 に事前確定した文面には `The executor addressed the required_fixes from your previous verdict.` が入っており、これはフレッシュ側の起動プロンプトには無い信頼表明である。実測では 5/5 が現物で再確認したので害は観測されなかったが、**出荷する文面からはこの宣言を落とすべきである** (§8 の (2))。
3. **n=5・1 フェーズ・1 タスク・1 ハーネス。** 素材は依存ゼロの小さな Python プロジェクトで、実物のタスク (PHP の vendor 込み、テストが分単位) では読み直しの比率が変わりうる。削減率 −19.8% は点推定であって、他フェーズ (research+plan / report / pr_fix) では測っていない。
4. **transcript の output 転記漏れ** (§6.3)。集計の前提が harness の記録に依存しており、2/5 で欠けた。後続で測るときは、次コールの `cache_creation` との関係で埋まることを毎回確かめること。
5. **再開アームの API コールは 4 回で固定的に少ない。** 今回は一括実行で網羅が保たれたが、**「浅い 1 パス」が構造的に定着するリスク**は残る。§8 の verifier.md 追記 (再走査を省かない旨) は、この点を文面で押さえるためのものである。

## 8. 実装方式の設計 (採用可なので書く。実装は後続 issue)

### 8.1 state.json のどこに verifier の agentId を持つか

`run` の 4 バリアント (`runInitialFull` / `runInitialLight` / `runPrFix` / `runRebaseFix`、`scripts/state.schema.json:67` 以降) に、`executor` / `executor_last_event_at` と同じ形で 2 つ足す:

```json
"verifier":         { "type": ["string", "null"] },
"verifier_session": { "type": ["string", "null"] }
```

4 バリアントとも `required` に加える (現行の `required` 行は 78 / 92 / 106 / 120)。**`ledger` や `probe` ではなく `run` に置く**のは、この値のライフサイクルが `attempts` と完全に同じ — フェーズが進めば意味を失い、run が消えれば一緒に消える — だからである。

verb 側:

- **`phase-fail` に `--verifier <agentId>` を足す** (省略可)。渡されたら `run.verifier` に、呼び出し側のセッション id を `run.verifier_session` に書く。省略時は両方 null のままで、現行どおりフレッシュ起動に落ちる (**段階導入できる**)。
- **`advance` は必ず両方を null に戻す。** フェーズが変われば前回の判断は別フェーズのものである。
- **`block` と、executor の引き継ぎ (takeover) でも null に戻す。**
- **`next` の応答に `tasks[].gate.reuse_verifier: <agentId> | null` を返す。**オーケストレーターは経路の記憶で分岐せず応答から読む (SKILL.md の既存の規律)。null を返す条件が §8.2。

`tests/skill-dispatch-alignment.test.ts` のディスパッチ表と `state-transitions-v2-spec.ts` の verb 仕様に `--verifier` を足す必要がある (フラグ集合が機械照合されているため)。

### 8.2 失効時の退避条件 — **`run.executor` と同じ扱いにはできない**

理由は 2 つある。

1. **執行可能性が非対称である。** `run.executor` には引き継ぎがあり、別セッションが新しい executor を立てて置き換えられる (worktree と成果物が残っているので作業は続く)。**verifier の agentId は、それを作ったセッションからしか `SendMessage` で再開できない。**別セッションから見た `run.verifier` は復元不能な文字列で、引き継ぐ先が無い。したがって「失効したら引き継ぐ」ではなく「**失効したら黙って捨ててフレッシュ起動に落ちる**」でよい。
2. **時間の粒度が違う。** executor の生存は 90 分の heartbeat (`executor_last_event_at` と `sessions/<id>` の touch) で判定し、切れると takeover が走る。verifier は数分で終わる同期ジョブで、生死を継続監視する対象ではない。**判定は「今このセッションが `run.verifier_session` の持ち主か」の 1 点だけ**でよく、heartbeat も takeover も要らない。

**フレッシュ起動へ退避する条件 (どれか 1 つでも成り立てばフレッシュ)**:

- `run.verifier` が null (初回の検証。`advance` 直後を含む)。
- **`run.verifier_session` が現在のセッション id と一致しない** (別セッションが引き取った、セッションが再起動した)。
- **`run.executor` が前回の FAIL 以降に変わった** (executor が引き継がれた)。前回の FAIL は前任者の成果物に対する判断で、成果物が別人の手で作り直されている可能性がある。安全側に倒す。
- `SendMessage` がエラーを返した (agent が見つからない / 再開できない)。→ **同じ内容で新規起動へフォールバックし、history に 1 行残す。**`SKILL.md:250` の「未インストール環境のフォールバック」と同じ形式で、フォールバックしたこと自体は失敗ではない。
- `run.attempts` が上限 (3) に達している (再検証そのものが無く、blocked へ)。

### 8.3 `SKILL.md` の書き換え

**(1) FAIL 分岐 (`SKILL.md:284`)** — 末尾の「修正・再停止後に **新しい** 検証エージェントで再検証する。」を置き換える:

> `state.ts phase-fail --id <id> --phase <phase> --verifier <この検証エージェントの agentId>` を呼んで `attempts` を +1 する。(SendMessage で実行エージェントへ「Fix required...」を送るのは現行のまま。) 修正・再停止後の再検証は、**`next` の `tasks[].gate.reuse_verifier` が agentId を返したときだけ、その検証エージェントを `SendMessage` で再開する** (下記の再開プロンプト)。null なら現行どおり新規に起動する。`SendMessage` がエラーを返したら**同じ内容で新規起動し**、history に「verifier 再開失敗 — フレッシュ起動」を 1 行残す。

**(2) 手順 6 の起動節 (`SKILL.md:243` の直後)** に再開プロンプトのテンプレを足す:

```
Re-verify the same phase against the updated artifacts.
Your previous verdict for this phase is at <前回の verdict path>.
phase: <phase> / task: <...> / run dir: <...> / target project: <...> / verdict path: <verdict-path が返した新しい path>
Write the full verdict JSON to the new verdict path, then return only the minimal verdict JSON.
```

**実測で使った文面から `The executor addressed the required_fixes from your previous verdict.` を落とす** (§7.2 の 2)。実行エージェントが直したかどうかは verifier が現物で確かめることであって、オーケストレーターが宣言することではない。verdict path は現行どおり `state.ts verdict-path` が返すものをそのまま渡す (連番の導出は CLI の内側のまま)。

**(3) 「### 検証ゲートの絶対規則」(`SKILL.md:286`)** — 現行の 1 段落を次に置き換える:

> フェーズ成果物は、**このイテレーションでオーケストレーターが起動または再開した検証エージェント**の PASS なしには、**どんな理由があっても** 次フェーズへ進めない。実行エージェントの self-check、過去の PASS、成果物への自分の印象は代替にならない。
>
> **再開してよいのは、直前に同じフェーズで FAIL を出した検証エージェントだけである** (`next` が返す `reuse_verifier`)。フェーズが進んだら再開しない — 別フェーズの判断は別の検証である。再開しても**実行エージェントのコンテキストは一度も入らない**ので独立性は保たれる (`references/verifier.md` が禁じているのは実行エージェントの作業経緯を知ることであって、verifier が自分の前回の判断を覚えていることではない)。

**(4) `references/verifier.md`** — 冒頭 (3 行目) は変えず、「FAIL を返すときの一括性」節に 1 項足す:

> **再開されて同じフェーズを再検証するときも、前回の判断を結論として持ち込まない。**前回 `required_fixes` に挙げた項目が実際に直っているかを現物で確かめ (直っていなければ、対応しない理由が成果物に書かれているかも確かめる)、加えて**今回の版ではじめて現れた不足を通常どおり一括で走査する**。「前回見た」を理由に走査を省かない。

この 4 点はいずれも**判定基準を変えない** — 変わるのは判定者の起動方法だけである。

### 8.4 後続 issue に持たせる条件

- §7.2 の 1 (初回盲点の持ち越し) の追試を実装前か実装直後に 1 回入れること。
- `--verifier` を省略した呼び出しが現行どおり動く (段階導入できる) ことをテストで固定すること。
- `advance` / `block` / takeover で `run.verifier` が null に戻ることをテストで固定すること。
