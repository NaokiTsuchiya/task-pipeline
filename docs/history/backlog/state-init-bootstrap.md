# 新規プロジェクトで state.json を作る手順が無く、初回イテレーションが止まる

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。

`.task-pipeline/state.json` が存在しないプロジェクトに対してパイプラインを起動すると、初回イテレーションが必ず `missing` (exit 13) で止まる。2026-08-03 に空の git リポジトリで SKILL.md の手順どおり CLI を呼んで再現した実出力:

```
$ state.ts session-touch --id sess-aaa   → {"ok":true,"id":"sess-aaa","cleaned":[]}   exit=0
$ state.ts sessions-alive                → {"ok":true,"alive":["sess-aaa"]}           exit=0
$ state.ts get                           → {"error":"missing","message":"state.json not found: <path>"}  exit=13
$ state.ts candidates-set --candidates-json <json>
                                         → {"error":"missing","message":"state dir not found: <path>"}   exit=13
$ state.ts stalled-set --value depleted  → {"error":"missing","message":"state dir not found: <path>"}   exit=13
```

手順 0 の heartbeat 2 verb は state.json 不在でも通るが、手順 1 の `state.json` を読む操作、SKILL.md:104 が「どちらも無い (**state が無い場合を含む**) → 承認へ」と案内する先の `candidates-set` (SKILL.md:145)、枯渇判定の `stalled-set` がすべて落ちる。SKILL.md:56 は `missing` を「再試行せず、実際のエラー出力を添えて報告する」と規定しているので、パイプラインはそこで報告して停止する。

**`init` は唯一 state.json を作れる verb である。** `tracker` と `source` は `task-pipeline/scripts/state.schema.json:132` の `required` に入っており、これを書くのは `cmdInit` (`task-pipeline/scripts/state.ts:766`、`buildFreshState` は :786) だけなので、他の verb では代替できない。契約は `task-pipeline/docs/state-cli-contract.md:61-77`。

ところが **SKILL.md には `init` を呼ぶ手順が無い**。`grep -n 'init' task-pipeline/SKILL.md` のヒットは 78 / 218 / 276 行の 3 件だけで、すべて `watch-init` (`review.watch` の初期化) であり、別物である。

`init` は冪等である (2026-08-03 実測): 2 回目の呼び出しは `{"ok":true,"created":false,...}` を返し、`--tracker`/`--source` に違う値を渡しても既存の state.json を書き換えない (契約 :74 のとおり)。したがって毎イテレーション無条件に呼んでも安全である。

`init` は `<git common dir>/info/exclude` への `/.task-pipeline/` 追記も行う (実測で追記を確認)。SKILL.md:38 はこれを手作業の指示として書いており、CLI がやる仕事と二重になっている。

原因は CLI 移行の取りこぼしである。移行前の SKILL.md にも明示的な作成手順は無かったが、当時はモデルが state.json を直接 Write していたため新規プロジェクトでも動いていた。移行 (commit 527a26c / `skill-state-cli-migration`) が直接書き込みを verb 呼び出しへ置き換えたとき、`init` だけが SKILL.md に配線されなかった。同アイテムの受け入れ条件 8 (`backlog/skill-state-cli-migration.md:37`) が「**既存の** `.task-pipeline/state.json` を持つプロジェクト」しか対象にしていないため、新規プロジェクト経路は一度も踏まれていない。意図的な見送りではない。

なお SKILL.md:53 の呼び出し完全形は `--allow-read=<state dir>[,<git common dir>/info]` と `info` を含んでいる。この権限を要するのは `init` だけなので、権限の形だけが `init` を想定していて呼ぶ手順が無い、という状態になっている。

## 要求

1. SKILL.md の毎イテレーションの手順に `state.ts init` の呼び出しを加える。位置は、state.json を読む/書く最初の操作より前であること。冪等なので無条件に呼ぶ形でよい (state 不在のときだけ呼ぶ条件分岐にしてもよいが、その場合も「不在の判定」が `missing` を踏まない形であること)。
2. 呼び出しには `--tracker` / `--source` / `--git-common-dir` を渡す。前 2 つは skill 引数、`--git-common-dir` は SKILL.md:32 が既に求めている `git rev-parse --path-format=absolute --git-common-dir` の値である。git リポジトリでない場合の扱い (SKILL.md:32 はカレントディレクトリをプロジェクトルートとする) も決めて書くこと。
3. SKILL.md:38 の `info/exclude` への手作業追記の指示を、`init` が行う旨に置き換える (手順の二重管理を残さない)。
4. **`state.ts` は変更しない** — CLI 側は既に正しく、欠けているのは SKILL.md の配線だけである。
5. `watch-init` と混同しない書き方にする (両方が `init` を含むため)。

## 受け入れ条件

1. `grep -n 'state.ts init' task-pipeline/SKILL.md` が 1 件以上ヒットし、その記述が毎イテレーションの手順の一部として読める。
2. SKILL.md 上で、その `init` の呼び出しが、state.json を読む/書く最初の操作 (手順 1 の state.json 読み込み) より前に置かれている。
3. その呼び出しの記述に `--tracker` / `--source` / `--git-common-dir` の 3 フラグがすべて現れる。
4. git リポジトリでないプロジェクトでの `--git-common-dir` の扱いが SKILL.md から読み取れる。
5. SKILL.md に `info/exclude` への手作業追記を指示する記述が残っていない (`init` が行う旨、または `init` の説明としての言及に置き換わっている)。
6. 空の git リポジトリに対し、変更後の SKILL.md の手順どおりに CLI を順に呼ぶと、`missing` (exit 13) で止まらずに承認フローの `candidates-set` の呼び出しまで到達する。実行した実出力が成果物にある。
7. 既存の state.json を持つ state dir に対して同じ手順を流しても、`tracker` / `source` / `schema_version` / `queue` が変化しない。実行した実出力 (init 前後の state.json に差分が無いこと) が成果物にある。
8. `git diff` で `task-pipeline/scripts/state.ts` に変更が無い。
9. `sh tests/run.sh` が全スイート PASS で exit 0。
