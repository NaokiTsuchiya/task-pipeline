# gate 宣言の経路を本文マーカーからラベルへ移した記録 (2026-08)

`research-plan-merge-2026-08.md` で採用した `gate=light` は、**宣言がパイプラインに届かない**まま最初の実運用を迎えた。
これはその欠陥の観測と、経路を変えた記録である。採否そのもの (統合フェーズの品質とコスト) は
`research-plan-merge-2026-08.md` が正で、この文書はそれを覆さない。

## 1. 観測 (RayDiContext, 2026-08-01)

宣言を本文末尾のマーカー行 (`<!-- task-pipeline:gate=light -->`) で表現し、gh アダプタが本文ごと
タスクファイルへ転記し、オーケストレーターがそのタスクファイルを grep する — という設計だった。
実運用の初日、**マーカー付きで転記された 3 件のうち 2 件で宣言が消えた**。

| issue | 本文のマーカー | issue の編集履歴 | タスクファイルへの転記 | 実際の gate |
|---|---|---|---|---|
| #79 | あり (作成 `10:00:32Z`) | `lastEditedAt: null` | **落ちた** | full |
| #80 | あり (作成 `10:00:45Z`) | `lastEditedAt: null` | **落ちた** | full |
| #85 | あり (作成 `10:03:19Z`) | — | 残った | light |

着手は #79 が `10:12:59Z`、#80 が `11:16:52Z` で、どちらもマーカーが本文に入ってから 12 分以上あとである。
issue は一度も編集されていない (`userContentEdits` 空) ので、**宣言は着手時点で確実に本文にあった**。

### 証拠

`tasks/gh-79.md` の frontmatter を除いた本体と、issue #79 の本文の diff:

```
41,42d40
<
< <!-- task-pipeline:gate=light -->
```

40 行が 1 文字違わず一致し、**末尾の空行とマーカー行の 2 行だけが無い**。#80 も同形 (`30,31d29`)。
転記そのものは高い忠実度で行われていて、落ちたのは「本文の意味に寄与しないように見える末尾行」だけである。

### なぜ気付けなかったか

history に残るのは `gate=full (no light marker)` の一行だけで、これは
**「宣言が無かった」と「宣言が消えた」を区別しない**。判定は安全側 (full) に倒れるので実行は正常に完走し、
どこにもエラーが出ない。5 本を回し終えて所要時間を分析するまで、誰も気付かなかった。

### 実害

#79 と #80 は light で回るはずだった。同日の実測では検証ゲート 1 回が
**2.1〜4.5 分** (成果物 mtime → verdict mtime、22 ゲート) なので、失ったのは
ゲート 1 回 + フェーズ受け渡し 1 往復 × 2 本 = **8〜10 分**。

## 2. 原因

**GitHub MCP の `issue_read (method: "get")` が本文を HTML エスケープし、HTML コメント行を落とす。**
アダプタが本文を読む経路がこれだったので、**転記するサブエージェントはマーカーを一度も見ていない**。

再現 (2026-08-02、issue #86 を `issue_read` で取得):

- `>` → `&gt;`、`'` → `&#39;`、`"` → `&#34;` に置換されて返る (コードブロックの中も含む)
- 本文末尾の `<!-- task-pipeline:gate=light -->` は**応答に含まれない**
- 同じ issue を `gh issue view 86 --json body` で取ると、どちらも原文どおり

同種の挙動は task-prep 側に既に記録があった — `<branch>` のような山括弧プレースホルダを本文に書くと
「HTML タグと解釈され中身ごと欠落する」(`task-prep/references/trackers/gh.md`)。HTML コメントはその一般形で、
`<!--` で始まる行が丸ごと消える。

### 当初この文書が書いていた誤った原因 (記録)

初版は原因を「`gh.md` が本文の逐語コピーを要求しておらず、転記するサブエージェントが末尾の HTML コメントを
落とした」と書いた。**これは誤りである。** タスクファイルが issue 本文と 2 行を除いて完全一致していたのは
転記が忠実だったことの証拠であって、転記が原因である証拠ではない (MCP が返した HTML エンティティは
書き出しの時点で元の文字へ戻っており、転記側は素直に写している)。**逐語要求だけではこの欠陥は直らない** —
見えていないものは写せない。

診断を誤った理由も記録しておく: 「末尾 2 行だけが無い」という差分の形が、転記の脱落とも取得の欠落とも
等しく整合するのに、取得経路 (`issue_read` の実挙動) を確かめずに転記側の欠陥と決めた。**アダプタが外部から
何を受け取っているかを見ずに、書き出しの側だけを見て原因を決めない。**

なお #85 (14:19Z 着手) ではマーカーがタスクファイルに残っている。この時点でアダプタは既に verbatim が
取れる経路に切り替わっていたとみられるが、切り替えの時刻は history に残っていない。

## 3. 変更

宣言をトラッカーの構造データに移し、frontmatter を唯一の判定点にした。

- **宣言の正** — gh: ラベル `gate-light` (task-prep が付ける。パイプラインは読むだけで書かない)。
  markdown: アイテムファイル本文のマーカー行 (ラベルが無いトラッカーなので現行どおり。ただしこちらは
  ファイルを直接読むので転記の段数が浅い)。
- **正規化** — アダプタはタスクファイルを書くとき、どちらを見たかに関わらず frontmatter に `gate: light` を出す。
- **判定** — `sed -n '2,/^---$/p' <tasks/<id>.md> | grep -Fxq 'gate: light'`。トラッカー非依存の 1 行のまま。
- **観測** — アダプタの `mark in_progress` 応答に `gate_declared` を含め、オーケストレーターの grep 結果と
  食い違ったら history に両方を書く。今回のような静かな欠落が二度と無言で通らない。
- **本文の取得経路** — gh アダプタは本文を `issue_read` ではなく、原文をそのまま返す経路
  (`gh issue view <n> --json body`) で取る。gate 以外にも、受け入れ条件に書かれた `<...>` 表記や
  コードブロックの引用符が同じ経路で壊れるため、宣言をラベルへ移したあとも直す価値がある。
- **忠実性** — 両アダプタの書き出し節に「本文は逐語。1 文字も加減しない」を明文化した。これは転記側の
  規律であって、**取得側の欠落は直さない** (今回の欠陥の原因ではない)。両方要る。

変更したファイル: `SKILL.md`、`references/adapters/gh.md`、`references/adapters/markdown.md`、
`task-prep/SKILL.md`、`task-prep/references/trackers/gh.md`。統合フェーズ本体
(`references/executor.md` / `references/verifier.md`) には触っていない。

## 4. 残る宿題

- **ラベル経路は実運用で 1 度も走っていない。** 最初の 1 本は、issue のラベルと history の `gate=` が
  一致することを目で確認すること (`gate_declared` の照合が入ったので、食い違えば history に出る)。
- **`gate-light` は全置換で消えうる。** task-prep 側の昇格スキャン (`pending-deps` → `ready`) が
  最も消しやすい経路で、規則としては書いたが実測していない。ラベルが消えても安全側 (full) に倒れるだけなので
  実行は壊れないが、静かに light を失う点は本文マーカーと同じ性質である。
- **markdown アダプタは依然として転記経路にマーカーがある。** ラベルに相当する構造が無いため。
  ただしこちらはファイルを直接読むので、今回の HTML エスケープ経路は通らない。
- ~~**本文取得に `gh` CLI を使うことの副作用。**~~ **消し込み済み (2026-08-02)。§5 を見よ。**
  MCP 側にエスケープを避けて読む口 (`search_issues` の `body`) が**あった**ので、両アダプタの一次経路を
  そちらへ寄せた。`gh` CLI は task-pipeline 側の予備として残り、時間上限と実体バイナリ回避を付けた。

## 5. 本文取得経路の調査 (2026-08-02)

§4 の最後の宿題 (「MCP 側でエスケープを避けて読む口があるならそちらへ寄せたい — 未調査」) の消し込み。
`NaokiTsuchiya/RayDiContext` の実 issue を 4 経路で実際に取得して比較した。**すべて読み取りのみ**
(このリポジトリは読み取り専用の証拠置き場として扱っている。`cost-analysis-2026-07.md` の方針)。

### 試した経路と返り値の実例

**(a) `issue_read (method: "get")` — issue #79**

```
`mago.toml` の `paths = [&#34;src&#34;, &#34;tests&#34;]` / `excludes = [&#34;tests/tmp&#34;, &#34;tests/Fixture&#34;]` により …
```

`"` → `&#34;`、`'` → `&#39;`、`>` → `&gt;`。本文末尾の `<!-- task-pipeline:gate=light -->` は**応答に含まれない**
(body は `…実装時に追記すること。\n\n` で終わる)。§2 の再現と同じ。

**(b) `list_issues(fields: ["number","body"])` — issue #86**

```
$this-&gt;baseDir = __DIR__ . &#39;/tmp/&#39; . uniqid(&#39;guard_&#39;, more_entropy: true);
$appDir = &#34;{$this-&gt;baseDir}/app&#34;;
```

**(a) と同じ欠落**。末尾の `<!-- task-pipeline:gate=light -->` も含まれない。`list_issues` は代替にならない。

**(c) `search_issues(fields: [… "body"])` — issue #79 / #80 / #84 / #85 / #86**

```
`mago.toml` の `paths = ["src", "tests"]` / `excludes = ["tests/tmp", "tests/Fixture"]` により …
```

同じ #86 の該当箇所:

```
$this->baseDir = __DIR__ . '/tmp/' . uniqid('guard_', more_entropy: true);
$appDir = "{$this->baseDir}/app";
```

`<` `>` `'` `"` すべて**原文のまま**。そして **5 件すべてで末尾の `<!-- task-pipeline:gate=light -->` が
`body` に含まれていた**。これが探していた raw 経路である。

**(d) `gh issue view 79 --repo NaokiTsuchiya/RayDiContext --json body --jq .body`** (それまでの例外経路)

```
$ grep -n 'task-pipeline:gate' gh79.txt
42:<!-- task-pipeline:gate=light -->
$ grep -n 'paths = ' gh79.txt
38:`mago.toml` の `paths = ["src", "tests"]` / `excludes = ["tests/tmp", "tests/Fixture"]` により …
$ wc -c gh79.txt
    3338
```

原文どおり。

| 経路 | `"` `'` `>` | `<!-- ... -->` 行 | 判定 |
|---|---|---|---|
| `issue_read (get)` | `&#34;` `&#39;` `&gt;` | **落ちる** | 使えない |
| `list_issues (fields: body)` | `&#34;` `&#39;` `&gt;` | **落ちる** | 使えない |
| **`search_issues (fields: body)`** | **原文** | **残る** | **採用 (一次)** |
| `gh issue view --json body` | 原文 | 残る | 予備 (二次) |

推測 (実測ではない): エスケープするのは GraphQL backed のツール (`list_issues` はカーソル `pageInfo` を、
`issue_read get` は「best-effort hierarchy flags」を返す)、raw なのは REST backed のツール
(`search_issues` は `incomplete_results` / `total_count`、`get_comments` は `id` / `html_url` /
`author_association` を返す) という区分。**`get_comments` が REST 形なのでコメント本文も無傷である可能性が
高いが、山括弧を含むコメントを持つ issue が手元に無く実測できていない。**

### issue 番号 1 件を `search_issues` で狙う方法

GitHub の issue 検索構文に issue 番号の修飾子は無い (`… is:issue 80 in:body,title` は「本文に 80 を含む issue」
= #84 を返し、#80 は返らない。実測)。代わりに**作成時刻で 1 件に絞れる**:

```
search_issues(owner, repo, query: "is:issue created:<created_at>..<created_at>",
              fields: ["number", "body", "updated_at"], perPage: 5)
→ {"total_count": 1, "items": [{"number": 79, "updated_at": "2026-08-01T11:02:49Z", "body": "…"}]}
```

`created_at` は `issue_read (get)` が既に返しているので追加の呼び出しは要らない (gh アダプタの `mark` 手順 2、
task-prep の深掘り入力のどちらも先に `issue_read (get)` を呼んでいる)。同じ秒に作られた issue が複数あっても
`number` で絞れば一意に決まる。

### 鮮度 (検索インデックス遅延) の照合

`search_issues` は検索インデックス越しなので、直前の編集が反映されていないことがある。とくに task-prep の
read-modify-write では、古い本文を書き戻すと**編集を巻き戻す** — エスケープより悪い。照合は実測で成立する:

- issue #79 を `issue_read (get)` → `"updated_at":"2026-08-01T11:02:49Z"`
- 同 issue を `search_issues(fields:["number","updated_at",…])` → `"updated_at":"2026-08-01T11:02:49Z"`

一致すれば「検索が見ている版 = API が見ている版」なので raw 本文を採用してよい。食い違う / 0 件で返る
(未インデックス) なら採用しない。**インデックスが遅れている状態そのものは実測していない** — 再現するには
外部リポジトリの issue を編集する必要があり、読み取り専用の方針に反するため。

### `gh` CLI を残す側のハング防御 (実測)

```
$ command -v timeout gtimeout          → 出力なし (exit 1)。この環境には両方とも無い
$ perl -e 'alarm shift; exec @ARGV' 2 tail -f /dev/null; echo "exit=$?"
exit=142                                ← 128+14 (SIGALRM)。2 秒で確実に打ち切られる
$ which -a gh | grep '^/' | head -1
/opt/homebrew/bin/gh
$ perl -e 'alarm shift; exec @ARGV' 30 "$GH" issue view 79 --repo NaokiTsuchiya/RayDiContext --json body --jq .body
→ exit 0 / 3338 bytes / marker 1 件
```

`timeout` / `gtimeout` が無いので `perl` の `alarm` + `exec` を使う。打ち切りは終了コード **142** で観測でき、
通常の失敗と区別できる。`perl` は macOS に標準で入っている。

### 採用結果

- `references/adapters/gh.md` の「タスク本文の書き出し」を **3 段**にした: 一次 = `search_issues` の raw
  (+ `updated_at` 照合)、二次 = `gh` CLI (実体バイナリ回避 + `alarm` 30 秒、**142 は「`gh` が使えない」と
  同一視して三次へ**)、三次 = エスケープ本文 + タスクファイル冒頭に警告 1 行。`mark` 手順 2 で
  `created_at` / `updated_at` を覚える指示も足した。
- `task-prep/references/trackers/gh.md` の深掘り入力を、`issue_read` の `body` を基礎にしない形に変えた。
  raw が取れないときは**書き戻しの前に人を 1 回挟む** (更新案 + issue URL + 原文突き合わせ依頼)。
  task-prep の `gh` CLI 禁止はそのまま — MCP だけで完結する。
