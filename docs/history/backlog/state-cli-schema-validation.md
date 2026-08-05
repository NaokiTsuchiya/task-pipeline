# state.json のスキーマ検証を独立モジュールとして実装する (state.schema.json + 再帰的walker)

## 背景 / 現状

`state-cli-foundation` (`.task-pipeline/tasks/state-cli-foundation.md`) は plan フェーズの検証で6回連続 FAIL し blocked になった (`.task-pipeline/runs/state-cli-foundation/verdicts/` 配下)。3ラウンド目までの指摘 (空ファイルクラス・ネストした additionalProperties の fixture 不足・git-common-dir 権限テストケース・lock/heartbeat のしきい値境界) は lock・原子的書き込み・heartbeat・init・権限封じ込めの範囲で、修正後は再指摘が無かった。4ラウンド目以降の指摘はすべて、手書きの `checkState` (state.json のスキーマ検証) がフィールド・階層ごとに個別実装であるために起きた「特定フィールドの検証を書き忘れる」クラス: `phase` の nullable-enum は `status` の非null-enum と別実装が要る / `attempts` の負数レンジが未検証 / `gate` の enum 代表が `status` にはあるのに無い / `promoted` 配列要素の型がスキーマ定義に無い / `review` 関連の除外 (「他と同じ共有ヘルパを使うから個別テスト不要」) が実装方針に書かれておらず根拠不明、というパターンが続いた。

このパターンから、**スキーマ検証はロック・heartbeat・CLI dispatch と完全に独立した純粋関数** (入力: JSオブジェクト、出力: valid/invalid + 違反パス。ファイルI/Oも排他も無い) であり、切り出して単独で開発・検証できると判断した。手書きの per-field チェッカーではなく、**スキーマ文書 (`state.schema.json`) を解釈する汎用の再帰的 walker** にすることで、「フィールドの数だけ書き忘れの可能性がある」という問題の構造そのものを解消する。

state.json の実データ・フィールド定義は `state-cli-foundation` の research.md (`.task-pipeline/runs/state-cli-foundation/research.md`) で裏取り済み: このリポジトリの live state (`<リポジトリルート>/.task-pipeline/state.json`, 365行, queue 11件) と `task-pipeline/SKILL.md` 59-106行のフィールド定義を突き合わせている。要点:

- queue 要素は14キー (`id` / `title` / `status` / `gate` / `phase` / `attempts` / `session` / `executor` / `executor_last_event_at` / `takeover_at` / `blocked_reason` / `worktree` / `base` / `review`)。`status` と `gate` は非nullのenum、`phase` はnull可のenum (8トークン: `research`/`research+plan`/`plan`/`implement`/`report`/`finalize`/`pr_fix`/`rebase_fix`)、`attempts` は整数 ≥ 0。
- top-level は `tracker`/`source`/`updated_at`/`queue`/`candidates`/`relisted`/`promoted`/`history` が必須、`stalled` (null|"depleted"|"max_open")/`stalled_since`/`withdrawn_branches`/`schema_version` が任意。`promoted` は素のid文字列の配列 (実データで確認: `["scripts-test-harness", ...]`)。
- `review` は null か object。必須は `ref`。任意で `branch`/`tip`/`base` (string|null)、`watch`/`rebase` (object)、`withdrawn`/`withdrawn_asked` (boolean)。
- live state には `stalled`/`stalled_since`/`withdrawn_branches`/`schema_version` が無い (後方互換のため任意扱いが必須)。

## 要求

1. `task-pipeline/scripts/state.schema.json` を JSON Schema (draft 2020-12) として置く。**named sub-schemas** (`$defs`) で構成する: top-level スキーマ、queue 要素スキーマ、`review` スキーマ、`review.watch` スキーマ、`review.rebase` スキーマを分離し、top-level から `$ref` で参照する。
2. `task-pipeline/scripts/state-schema.ts` (Deno/TypeScript) に、`state.schema.json` を**解釈する汎用の再帰的関数** `checkState(value: unknown): {ok: true} | {ok: false, path: string, message: string}` を実装する。
   - スキーマは `import schema from "./state.schema.json" with { type: "json" }` の静的JSON importで取り込む (TS側に並行するスキーマ定数を手書きしない)。
   - 実装するJSON Schemaキーワードは次の固定集合に限定する: `type` (配列形 `["string","null"]` を含む) / `required` / `properties` / `additionalProperties: false` / `enum` / `items` / `minimum` (整数専用) / ローカル `$ref` (`#/$defs/...`)。**この集合に無いキーワードがスキーマ中に現れたら `checkState` の初期化時に throw する** (fail-closed)。
   - `oneOf`/`anyOf`/`allOf`/`pattern`/`minLength` 等は使わない。nullable な項目は `type: ["<型>", "null"]` で表現する。
   - 実行時の外部依存はゼロ (`npm:` / `jsr:` の参照を持たない)。
3. `task-pipeline/scripts/state-schema.test.ts` に `deno test` でテストを書く。3層で構成する:
   - **(a) meta-lint テスト**: `state.schema.json` 自体を機械的に検査する。全 object スキーマ (`$defs` 内含む) に `additionalProperties: false` と `properties` があること、`required` に列挙された全キーが `properties` に存在すること、全 `$ref` が `$defs` 内で解決すること、上記2の固定キーワード集合に無いキーワードが使われていないこと。
   - **(b) ミューテーション生成テスト**: `state.schema.json` を走査し、各 object ノードの各プロパティについて「required なら削除」「wrong-type な値に置換」を、各 object ノードについて「未知キーを1つ注入」を機械的に生成し、`checkState` が全て `ok: false` を返すことを確認する。手で個別の fixture ファイルを列挙しない。
   - **(c) walker のキーワード実装そのものを検査する固定ケース群** (フィールド数に依存しない): `typeof null === "object"` が object 型チェックを誤って通過しないこと / `Array.isArray` で配列判定していること / `Number.isInteger` で非整数を `minimum` チェック以前に拒否すること / nullable string (`session`) が null と文字列の両方を受理すること / nullable object (`review`) で値が `null` のとき `properties`/`required` 検査をスキップすること / nullable-enum (`phase`) が非null-enum (`status`, `gate`) と別に、null許容とenum membershipの両方を検査すること / ネストした `additionalProperties: false` (`review.watch` 内) が正しい階層の `properties` 集合を参照すること / 違反時の `path` が正しいネスト位置を指すこと (例: `queue[3].phase`)。
4. **valid アンカーフィクスチャ**を `tests/fixtures/state-cli/valid-*.json` として置く: `valid-legacy-live.json` (schema_version無し・stalled無し・review 4キーのみ — live state を模した形)、`valid-skill-example.json` (`task-pipeline/SKILL.md` 61-91行の例そのまま)、`valid-watch-rebase.json` (`review.watch`/`review.rebase`/`review.withdrawn` 入り)。これらは「スキーマが厳しすぎて正当なファイルを拒否してしまう」誤りを検出する唯一の網であり、(b) のミューテーション生成では代替できない。
5. `npm:ajv` は**このモジュールのテストでのみ**使う (実装では使わない): 取得できた環境限定で、`state.schema.json` を ajv でコンパイルし、valid フィクスチャ全件・(b) のミューテーション生成フィクスチャ全件について ajv の判定と `checkState` の判定が一致することを確認する。取得不能環境ではこのケースのみ SKIP し、他は全て PASS すること。
6. `tests/state-schema.test.sh` (POSIX sh) を新設し、`tests/run.sh` から自動検出される形にする。deno 不在なら `SKIP` を表示して exit 0。

## 受け入れ条件

1. `deno test` (`state-schema.test.ts`) が全ケース PASS し、ネットワークに出ない (ajv 取得を除く。取得不能環境ではそのケースのみ SKIP)。
2. meta-lint テストが実装され、`state.schema.json` に対して実行して PASS する。
3. ミューテーション生成テストが実装され、`state.schema.json` の全プロパティ (top-level・queue要素・review・review.watch・review.rebase) について自動生成された「required削除」「wrong-type」「未知キー注入」ケースを `checkState` が全て拒否する。生成されたケース数がテスト出力に明示される。
4. 要求3(c)の固定ケース群がすべてテストとして存在し PASS する。
5. `valid-legacy-live.json` / `valid-skill-example.json` / `valid-watch-rebase.json` が `checkState` で `ok: true` になる。
6. ajv との差分テストが (取得できる環境で) PASS し、取得不能環境では該当ケースのみ SKIP されて他は PASS する。
7. `state-schema.ts` に `npm:` / `jsr:` の参照が無いことをテストで固定する。
8. 固定キーワード集合に無いキーワード (例: `pattern`) を一時的にスキーマへ注入すると `checkState` の初期化が throw することをテストで固定する。
9. `sh tests/state-schema.test.sh` が `tests/run.sh` 経由で自動実行され、deno 不在環境では SKIP 表示して exit 0 になる。
10. `deno fmt --check` / `deno lint` / `deno check` が `state-schema.ts` / `state-schema.test.ts` に対し警告ゼロ。
