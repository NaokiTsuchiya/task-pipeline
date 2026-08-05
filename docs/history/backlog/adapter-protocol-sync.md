# adapter-protocol.md が実アダプタの拡張から取り残され、「1 枚書くだけ」が成立しない

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。

`task-pipeline/references/adapter-protocol.md` は新しいトラッカーを足すときの唯一の仕様書で、:32 は「以上。SKILL.md、状態スキーマ、executor/verifier に変更は不要。`/task-pipeline <name> <source>` で使える」と締めている。ところが応答スキーマの規定が実アダプタに追いついていない。

### `list` の応答

- `adapter-protocol.md:12` — 「応答は `{"tasks": [{"id": "...", "title": "..."}]}` の JSON のみ」
- 実際: `adapters/gh.md:87` は `priority` / `labels` / `milestone` / `updated_at` を返す (各キーの意味は同 :88-91 に定義)。`adapters/markdown.md:65` は `updated_at` を返す (同 :66 は `priority` を**返さない**理由を明記)。

この差はオーケストレーターの挙動に直結する。`task-pipeline/SKILL.md:128` は「**まず `list` が返した `priority` で 3 段に分ける** (`high` → 指定なし → `low`)。**この段は人の指示なので、トリアージの判断より常に優先する**」と規定し、同 :129 は順位キャッシュの再利用条件に「各 id の `priority` が控えた値と一致する」「各 id の `updated_at` が控えた値と一致する」を挙げている。したがって、プロトコルどおりに `id`/`title` だけを返す新アダプタでは、**全タスクが中位に落ち、本文を書き換えても順位が付け直されない**。どちらも失敗せず静かに劣化するため、書いた本人が気づけない。

### `mark` の応答

- `adapter-protocol.md:25` — 「応答は `{"ok": true}` または `{"ok": false, "error": "..."}` のみ」
- 実際: `adapters/gh.md:132` は `mark in_progress` の応答に `gate_declared: true|false` を含めることを要求している。`task-pipeline/SKILL.md:188` はこの値を自分の gate 判定と突き合わせる (食い違ったら history に両方書く。経緯は `task-pipeline/docs/gate-declaration-2026-08.md:86-87`)。

**`adapters/markdown.md` は同じファイルの中で自己矛盾している**: :77 が「**応答には `gate_declared: true|false` を含める** — アイテムファイルにマーカー行があったかどうかをそのまま返す (オーケストレーターが自分の gate 判定と突き合わせるため。gh アダプタと同じ)」と要求しているのに、直後の :78 は「応答: `{"ok": true}` または `{"ok": false, "error": "..."}` **のみ**」と書いている。

### frontmatter の `gate: light`

`adapter-protocol.md:10` はタスクファイルの frontmatter について「最低限 `id`、`title`、トラッカー側の参照」としか言わない。実際には両アダプタが gate 宣言を frontmatter の `gate: light` 行に正規化して書き (`adapters/gh.md:131`、`adapters/markdown.md:61`)、`task-pipeline/SKILL.md:76` はその 1 行だけを見て gate を決める (宣言が無い・判定できないタスクは常に `full`)。プロトコルに書かれていないので、新アダプタは gate 宣言を落とし、**その トラッカーでは gate:light が常に効かない**。これも失敗ではなく静かな劣化である。

## 要求

1. `adapter-protocol.md` の `list` 応答の規定を実アダプタに合わせる。少なくとも `priority` / `updated_at` は、返さないとオーケストレーターの機能 (優先度の段・順位キャッシュの再利用判定) が静かに劣化することが読み取れる形にする。トラッカーによって表現できない項目 (markdown の `priority` 等) を省いてよいことと、省いたときに何が起きるかも書く。
2. `mark` 応答の規定に `gate_declared` を加える。`in_progress` のときに要ること、オーケストレーターが何に使うかが読み取れるようにする。
3. frontmatter の規定 (`adapter-protocol.md:10`) に gate 宣言の正規化 (`gate: light`) を加える。新アダプタがこれを書かないと gate:light が常に効かないことを明記する。
4. `adapters/markdown.md:78` の自己矛盾を解消する (:77 の `gate_declared` 要求と揃える)。
5. `adapter-protocol.md:32` の「以上。SKILL.md、状態スキーマ、executor/verifier に変更は不要」が、1〜3 を反映した後の内容で実際に成立していること。成立しない項目が残るなら、その旨を :32 に書く。
6. **アダプタの実挙動 (`adapters/gh.md` / `adapters/markdown.md` が実際に何を返すか) は変更しない** — 食い違っているのはプロトコル側の規定であり、実アダプタが正である。例外は要求 4 (markdown.md:78 の記述の矛盾) だけで、これも挙動ではなく記述の修正である。

## 受け入れ条件

1. `adapter-protocol.md` の `list` 応答の規定に `priority` と `updated_at` が現れ、`adapters/gh.md:87` と `adapters/markdown.md:65` の実際の応答がその規定に反しない。
2. `adapter-protocol.md` に、`priority` を返さない場合に何が起きるか (全タスクが中位に落ちる) が書かれている。
3. `adapter-protocol.md` の `mark` 応答の規定に `gate_declared` が現れ、`adapters/gh.md:132` と `adapters/markdown.md:77` の要求がその規定に反しない。
4. `adapter-protocol.md` の frontmatter の規定に `gate: light` が現れ、書かない場合に gate:light が効かないことが書かれている。
5. `adapters/markdown.md` の `mark` の応答の記述が、同ファイル :77 の `gate_declared` 要求と矛盾していない (「`{"ok": true}` または `{"ok": false, "error": "..."}` のみ」という記述が `gate_declared` を排除する形で残っていない)。
6. `adapter-protocol.md` だけを読んで新しいアダプタを書いた場合に、`task-pipeline/SKILL.md:76`(gate)・:128(優先度の段)・:129(順位キャッシュ)・:188(gate 突き合わせ) が要求する入力がすべて揃うことを、4 箇所それぞれについて対応するプロトコルの記述を挙げて示す (成果物に対応表を載せる)。
7. `git diff` で `adapters/gh.md` に変更が無い。`adapters/markdown.md` の変更が要求 4 の範囲に限られている。
8. `sh tests/run.sh` が全スイート PASS で exit 0。
