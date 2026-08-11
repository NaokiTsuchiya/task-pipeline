# 評価 — gh-22: Be Framework becoming パターンによる状態モデル v2 (7 verb 縮約) の実装評価

対象: `experiments/be-state-v2/` (このディレクトリ)。実装は `src/` (7 verb: claim /
advance / ship / fix-start / restore / merged / attention-set)、反例は
`illegal-examples/`、実証は `tests/`。設計文書は
`task-pipeline/docs/state-model-v2-2026-08.md` (4.1 節、775 行)。

## 0. 実行での裏づけ (受け入れ条件 4・5)

```
$ composer install --no-interaction        # be-framework/be 0.x-dev, ray/di 2.23.0,
                                            # ray/input-query 1.1.0, koriym/semantic-logger 0.8.0
$ vendor/bin/psalm --no-cache
No errors found!
(Psalm was able to infer types for 100% of the codebase)

$ vendor/bin/phpunit --testdox
Tests: 13, Assertions: 74, Notices: 9.
OK, but there were issues!
```

13 テストすべて exit 0 (PHPUnit の `OK, but there were issues!` は失敗ではない —
Notices 9 件は `Be\Framework\SemanticVariable\SemanticValidator` が既定の semantic
namespace `Be\App\Semantic` にこの実験用のプロパティ名 (`Id`/`Branch`/`Tip`/`Base`/
`Started` 等) の定義を見つけられないという通知で、research.md 9-b で機構を確認済み。
抑止しない方針を採った — 実験用の semantic namespace を新設するより、既定のまま
残して notice ごと記録する方が実験の目的 (型システムの検証) に対して素直なため)。
7 verb すべての正常系は `tests/NormalPathChainTest.php::testFullLifecycleChain` が
1 本の連鎖 (claim→advance×5→ship×2→fix-start→attention-set×2→merged) として実行し、
`testRestoreChain` が restore の別チェーンを実行する — 受け入れ条件 5。

## 1. 確認済み欠陥 13 件 — 3 分類・裏づけ・根拠・v2 との比較

3 分類の凡例 (タスク本文「評価の基準」): **表現不能** = 型が受け付けずコードとして
書けない / **構築時に落ちる** = 書けるが構築時に失敗する / **現状と変わらない** =
実行時の前提チェックが必要で TS 実装と同じ位置づけ。

裏づけの種別: **実証** = このディレクトリのコードと型検査/実行のコマンド・出力で示せる
判定 / **推論** = 縮約 7 verb に含まれない verb に関わるなどの理由で実験コードでは
示せず、v2 の宣言と Be の型システムから導いた判定。

v2 判定列は設計文書 4.1 節の表 (584-615 行) および別掲段落 (617-620 行) からの引用。

| # | 欠陥 (v1) | Be の3分類 | 裏づけ | 根拠 | v2 の判定 (4.1節) |
| --- | --- | --- | --- | --- | --- |
| 1 | phase-pass が任意の辺を通した | **表現不能** | 実証 | `PhaseImplement::__construct` は `PhasePlan` 型の `$prev` だけを受ける (`src/progress/RunningInitialFull/PhaseImplement.php:19,25`)。`illegal-examples/SkipPhase.php:22-24` が `Queued` から直接 `PhaseImplement` を構築しようとし、`$ vendor/bin/psalm --no-cache illegal-examples/SkipPhase.php` → `ERROR: InvalidArgument - Argument 1 of …PhaseImplement::__construct expects …PhasePlan, but …Queued provided` | 構築時に落ちる (advance の辺は宣言列の隣接ペアのみ、行列テストが網羅) — **Be の方が強い**: v2 は「行列テストで検出される」実行時寄りの構築時チェックだが、Be は advance の各辺を別クラスにしたことで純粋な静的型検査 (実行すらせず psalm の時点) で弾ける |
| 2 | in-review が review を丸ごと置換した (issue #13) | **表現不能** | 実証 | `ShipFromOpen::__construct` (`src/verbs/Ship/ShipFromOpen.php:20-43`) はグループ欄 (ref/branch/tip/base) だけを受け取り、`follow` は `$source->follow` から narrow して運ぶ (40行) だけで、新規リテラルを受け取るパラメータが無い。`tests/NormalPathChainTest.php` の2回目の ship で follow 保持を assert (122-124行)。`ShipFromNoneTest`/`ShipFromWithdrawnTest` が残り2クラス (none/withdrawn 発) を実演し、3クラスとも「グループ欄と follow が別オブジェクト」という点で一致することを確認した | 表現不能 (グループ欄だけを書く形が存在しない) — **一致**。Be は3つの候補クラス (ShipFromNone/Open/Withdrawn) に分けたことで、v2 の「1関数内の分岐」より分岐点そのものが型レベルで分離される |
| 3 | 復帰のたびに fix_attempts が 0 に戻った (issue #15) | **表現不能** | 実証 | `fixAttempts` をリセットするコードは `ClaimInput::cycleReset` (`src/verbs/Claim/ClaimInput.php:46-65`、61行で `fixAttempts: 0`) だけで、`FixStartInput` は加算のみ (`$nextAttempts = $follow->ledger->fixAttempts + 1`, 64行)。`tests/ClaimCycleResetTest.php` が `fixAttempts=4` の fixture に claim を実行し、結果が 0 になることを assert (実行) | 表現不能 (リセットする verb 自体が無い、claim にしかない) — **一致**。Be・v2 とも「リセット経路が構文的に1つしかない」という同じ理由で表現不能 |
| 4 | block が watch を watching のまま残した | **表現不能** | 推論 | `block` verb は縮約7verbに含まれない (要求どおり)。仮に実装するなら `Blocked` (`src/progress/Blocked.php`) は `Follow`/`Attention` を一切保持しない型なので、v1のように「blocked のまま watching が残る」データは構文として書けないはずだが、`block` の入口 (running→blocked) を作っていないのでこの実験コードでは示せない | 表現不能 (「watching」という主張を保存しない。追従対象は導出式なので blocked は定義から対象外) — **推論による一致見込み**。Be の Blocked も同じ理由 (Follow を持たない型) で表現不能になるはずだが未実装のため実証はできない |
| 5 | 到達不能な (status, phase) の組を書き込めた | **表現不能** | 実証 | `Queued`/`Resting`/`Blocked` は phase に相当するプロパティを一切持たない (`src/progress/Queued.php:28-33` 等)。`illegal-examples/AttachRunDataToQueued.php:18-21` が `Queued` に存在しない named parameter `phase` を渡そうとし、`$ vendor/bin/psalm --no-cache illegal-examples/AttachRunDataToQueued.php` → `ERROR: TooManyArguments … expecting 2 but saw 3` + `ERROR: InvalidNamedArgument - Parameter $phase does not exist` | 構築時に落ちる (`run≠null⇔progress==running` 不変条件+型付きノードコンストラクタ) — **Be の方が強い**: v2 は不変条件チェック (実行時寄り) だが、Be は「phase を保持するプロパティ自体が無い」ため、値を1つも実行せずに psalm の時点で拒否できる |
| 6 | watch-set が **status を見ず**、飛行中タスクの session を落とせた | **表現不能** | 実証 | v1 の欠陥は「status (progress) を見ていなかった」ことそのものなので、この軸で判定する。`AttentionSetInput` の from は `Resting` 型のみ (`src/verbs/AttentionSet/AttentionSetInput.php:40`)。`illegal-examples/AttentionSetOnRunning.php:19-21` が running 中の型 (`PhaseResearch`) を渡そうとし、`$ vendor/bin/psalm --no-cache illegal-examples/AttentionSetOnRunning.php` → `ERROR: InvalidArgument - Argument 1 of …AttentionSetInput::__construct expects …Resting, but …PhaseResearch provided` — 飛行中 (running) の型を渡すこと自体が書けない。**限定**: 別軸 (artifact が open か否か・follow≠null) は `Resting` が4種の artifact 型をすべて保持できる型である以上、型では除外できず `AttentionSetInput.php:42-48` の値検査 (`DomainException`) のまま — `tests/AttentionSetRejectsNullFollowTest.php` が follow=null の拒否を実演。この別軸だけを見れば「現状と変わらない」 | 実行時チェック+構築時 (from 軸が `P==resting` に宣言され、行列テストが網羅) — **Be の方が強い** (v1 の欠陥が実際に問うている progress 軸を、Be は型検査だけで拒否できる。v2 は同じ軸をなお行列テストという実行時寄りの検査に頼る) |
| 7 | recover-done が watch を残した | **表現不能** | 実証 | `ArtifactMerged` (`src/artifact/ArtifactMerged.php:12-20`) は `follow` パラメータを持たない。`MergedInput` (`src/verbs/Merged/MergedInput.php:25-47`) が `ref/branch/tip/base` の4引数だけで構築する。`tests/NormalPathChainTest.php:137-139` で `merged` 適用後 `assertInstanceOf(ArtifactMerged::class, ...)` により follow 相当のデータが型に存在しないことを確認 | 表現不能 (欠陥4と同根、merged に follow の子は無い) — **一致** |
| 8 | restore が前周回の watch を持ち越した | **表現不能** | 実証 | `RestoreInput→Queued` は `withoutLease` (`src/verbs/Restore/RestoreInput.php:52-71`) で `probe` のみ触れ、`attention`/`fixAsk`/`ledger` は保持しない。`tests/NormalPathChainTest.php::testRestoreChain` (Resting発) と `tests/RestoreFromBlockedTest.php` (Blocked発) の両方で、`probe.proc` が外れることを実行して assert | 表現不能 (queued は追従対象の導出式を満たさず、probe.proc は restore が外す。周回リセットは claim のみ) — **一致** |
| 9 | fix-start の上限がラッチしなかった | **構築時に落ちる** | 実証 | `FixStartInput` (`src/verbs/FixStart/FixStartInput.php:38-86`) は `ATTEMPT_LIMIT=3` (40行)。上限超で `attention` が `Human('fix_limit')` に切り替わる (78-82行)。`tests/FixStartLimitReachedTest.php` が `fixAttempts=3` から実際に fix-start を1回実行し、`Human`へ切り替わることを実行して assert (上限が実際に発火する分岐)。`tests/FixStartLimitTest.php` が、ラッチ後の再呼び出しが `DomainException` で拒否されることを実行して assert (別クラスの拒否) | 構築時に落ちる (ラッチが耐久状態になり、from 軸に入る) — **一致**。Be では `PhasePrFix`→`Resting` の2候補と `UnbecomingException` (research.md 6節) による型主導のフォールバックで実装したが、判定としては v2 と同じ「構築時に落ちる」に留まる (上限判定そのものは依然として実行時の値比較) |
| 10 | 飛行中の rebase-done が通った | 実行時チェック+構築時 | 推論 | rebase 一族は範囲外 (タスク本文「範囲外」節)。実装が無いため実証できない | 実行時チェック+構築時 (`rebase-applied` の from が `P==resting`) — 推論のみ、比較できない |
| 11 | rebase-start が2入口の片方で呼べなかった | 構築時に落ちる | 推論 | 同上。範囲外 | 構築時に落ちる (2入口が from 宣言に載る) — 推論のみ |
| 12 | 衝突なし成功で rebase-done が呼べなかった | **表現不能 (ship側のみ実証) + 推論 (rebase-applied側)** | 実証(ship側)+推論(rebase-applied側) | `ship` 経由の tip 更新は `ShipFromOpen` (`src/verbs/Ship/ShipFromOpen.php`) が実証済み (defect#2 と同じソース)。rebase-applied 相当 (run 無しの tip 更新) は範囲外なので推論 | 表現不能 (「1つのverbが2つの形を兼ねる緊張」が ship と rebase-applied に分解される) — **ship 側は一致確認、rebase-applied 側は未検証** |
| 別掲 | (in_progress/research, gate:light) の死にノード | **表現不能** | 実証 | `Queued` に `gate` プロパティが無い (`src/progress/Queued.php`)。`illegal-examples/AttachRunDataToQueued.php:23-26` が存在しない named parameter `gate` を渡そうとし、同じ `vendor/bin/psalm --no-cache illegal-examples/AttachRunDataToQueued.php` の実行で `TooManyArguments`+`InvalidNamedArgument` を得る (#5 と同一コマンドの出力に両方含まれる) | 表現不能 (gate は run の中にしか存在せず、claim が毎回 gate:full で作る) — **一致**。Be も同じ理由 (Queued に gate フィールドが無い) で表現不能。加えて Be は #5 と同じ psalm 実行1回で両方の反証が得られる (v2 は 4.2 節の全ノード到達可能性テストという別のテスト層で検査する) |

**実証行の集計**: 1, 2, 3, 5, 6, 7, 8, 9, 別掲 の **9 行**が実証 (受け入れ条件8の
「最低8行」を1行上回る)。推論は 4, 10, 11, 12(rebase-applied側)。rebase 一族に関わる
#10/#11 と #12 の一部だけが推論に留まった、というタスク本文末尾の見積り (13件から
rebase一族を除く8件) と一致する。

## 2. Be が v2 より強く防げる箇所・弱くなる箇所

**強く防げる箇所 (3件: #1, #5, 別掲)**: v2 が「行列テスト」「不変条件チェック」という
**実行時に何かを実行して初めて検出される**構築時チェックに留まる3件が、Be では
**実行すらせず静的型検査 (psalm) の時点で拒否**できた。理由は共通している —
v2 は「1つの `V2Item` 型が全 progress 値を横断して同じフィールド集合を持つ」設計
(座標を値の組み合わせとして表現し、不正な組み合わせを不変条件関数で事後チェックする)
のに対し、Be は「progress の値ごとに別クラス」なので、存在しないフィールドへの
アクセス自体が型として書けない。#6 の progress 軸 (running から呼べない) も同じ理由で
Be の方が強い。

**変わらない箇所 (6件: #2, #3, #7, #8, #9, #6のartifact軸)**: 表現不能な defect の
多くは v2 でもすでに表現不能で、Be はそれを型システムの言語機能 (readonly class +
コンストラクタ引数の型) で表現し直しただけで新たに防げる範囲は広がっていない。
#9 (fix-start の上限) と #6 のartifact軸 (open・follow≠null) は Be でも実行時の
値検査 (`DomainException`) のままで、性質は変わらない — **上限のような「回数を数える」
判定や「同じ型の中の部分集合を除外する」判定 (Resting が4種の artifact 型を保持できる
以上、そのうち1つだけを型で除外できない) は、型システムの表現力の限界であって、
becoming パターンを使っても構築時チェックより先には進めない**。これは実装を通じて
判明した具体的な限界であり、evaluation の基準が問う「弱くなる箇所」の直接の答えでもある。

**弱くなる箇所**: v2 は TypeScript の網羅 `switch` と `state.schema.json` (346行) の
JSON Schema 層という2重の保護を持つが、この実験は型システムのみで JSON Schema 相当の
層を作っていない (範囲外)。またこの実験のテストは 13 defect のうち rebase 一族
(#10/#11/#12の一部) を推論に留めており、becoming パターンが rebase の「2入口+迂回+
解決サイクル」という込み入った構造にどう振る舞うかは未検証のまま — v2 の設計 2.4 節が
「最も込み入った部分」と明記する箇所を、この実験は最初から範囲外にしている
(タスク本文「範囲外」節)。

## 3. ファイルロック付き CLI との適合

`task-pipeline/scripts/state-store.ts` の `withQueueLock`/`withExistingStateLock` は
verb ごとに `state.json` を排他ロックしたうえで読み込み→検証→書き込みを行う
(`Deno.flock` 相当、`--allow-read --allow-write` の Deno 権限封じ込め下で動作)。
Be の becoming チェーンは**インメモリのオブジェクト変換だけ**を保証する — 今回の実験の
どのクラスも JSON との往復やファイルロックを扱っていない。CLI として使うには、
「JSON をデシリアライズして適切な progress クラスを選ぶ (どの `Queued`/`Resting`/
`Phase*` を構築するかの判定自体が別に要る) → becoming チェーンを駆動 → 結果をシリアライズ
→ ロック解放」という手続きをフレームワークの**外**で別途組む必要がある。この往復コードは
becoming パターンの型安全性の外側にあり、v2 (TS の判別ユニオン + JSON Schema) が
1 つの言語・1 つの実行系で完結しているのに比べ、Be は言語組み込みの型システムでの
検証と JSON 相当層の手作業実装が分離する形になる。

## 4. 依存の重さ

`composer show` の実測 (research.md 9-a、`experiments/be-state-v2/` でも同じ構成):
`be-framework/be * 0.x-dev`、`ray/di * 2.23.0`、`ray/input-query * 1.1.0`、
`koriym/semantic-logger * 0.8.0` が実行時依存として解決される。`du -sh vendor` は
71M (研究時点の scratchpad トライアルでの実測。内訳は `vimeo/psalm` 49M・
`phpunit/phpunit` 6.9M が大半) — **dev 依存 (psalm・phpunit とその周辺) が
実行時依存の 40 倍以上を占める**。加えて `be-framework/be` 自体が Packagist 上に
タグ付き安定版を持たず `0.x-dev` (dev ブランチ) が唯一の配布形態で、
`minimum-stability: dev` を要求する — 本体 (`task-pipeline/`) が `deno.json` の
lock ファイルと安定版パッケージだけで完結しているのに比べ、composer + PHP の依存
解決はより重く、より不安定な入力 (dev-stability パッケージ) に依存する。

## 5. 既存のサブプロセステスト資産との関係

`task-pipeline/tests/*.test.sh` と `state.test.ts` ほか T-MX/T-FRAME/T-ALIGN 系の
テストは `deno run scripts/state.ts <verb> ...` をサブプロセス起動し、stdout (JSON)
と `state.json` の差分を検証する形 (research.md 8節)。この実験は CLI エントリ
ポイント (例: `bin/state`) を一切作っていない — `tests/` 配下の PHPUnit テストは
becoming チェーンをオブジェクトとして直接駆動するだけで、プロセス境界を越えない。
仮に PHP 版を本体へ昇格する場合、同等のサブプロセス起動可能な CLI (JSON の
パース・progress クラスの判別・becoming の実行・結果の再シリアライズをすべて含む)
を新たに組む必要があり、既存のサブプロセステスト資産 (T-MX 等) はそのまま流用できるが、
それを満たす実装コストはこの実験のスコープの外にある。

## 6. 隔離の確認 (受け入れ条件 1・2・3・10)

```
$ TMPD=$(mktemp -d); sh install.sh "$TMPD" "$TMPD/agents"; ls -1 "$TMPD" | grep -v agents | wc -l
4                                          # research.md 10節のベースラインと同じ
$ sh tests/run.sh 2>&1 | tail -3
suites: 14 / failed: 0 / skipped: 0        # ベースラインと同じ
$ deno task test 2>&1 | tail -3
ok | 604 passed (144 steps) | 0 failed     # ベースラインと同じ (ignored 行は現れない)
$ TESTS_FAIL_ON_SKIP=1 sh tests/run.sh; echo "exit=$?"
exit=0                                     # 全スイート PASS のまま
```

いずれも実装前 (research.md 10節) の実測値と一致し、`experiments/be-state-v2/` の
追加が `install.sh` / `tests/run.sh` / `deno task test` のいずれの実行経路にも
影響しないことを確認した。
