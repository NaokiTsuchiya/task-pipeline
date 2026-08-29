# `~/.paseo/orchestration-preferences.json` の設定例

`playbooks/agent-launch.md` の解決手順 2 段目が読むファイルの例である。**このリポジトリはこのファイルを作らない** — ホームディレクトリはリポジトリ外の環境設定であり、置くかどうかはユーザーが決める。ここにあるのは中身の形と、このパイプラインが実際に読む部分の説明だけである。

## このパイプラインが読むカテゴリ

Paseo 標準のカテゴリは `impl` / `ui` / `research` / `planning` / `audit` の 5 つだが (`~/.claude/skills/paseo/SKILL.md`)、task-pipeline が引くのは 2 つだけである:

| カテゴリ | 引く役割 | 起動引数による上書き |
|---|---|---|
| `impl` | `executor` (実装) | `impl_provider=<provider>[/<model>]` |
| `audit` | `verifier` (検証) | `verify_provider=<provider>[/<model>]` |

残りの 3 カテゴリ (`ui` / `research` / `planning`) はどの役割にも割り当てていない。**判断そのものが成果物の役割 (`triage` / `survey` / `retro`) はカテゴリを引かない** — 理由は `playbooks/agent-launch.md` の役割の表とその下の参照にある。
**`providers_by_class` を置いた場合も、引くのはこの 2 カテゴリだけである** (キー名も `impl` / `audit` で同じ)。下記「例 (タスクの class で使い分ける)」。

## 例 (実装と検証が別プロバイダ)

```json
{
  "providers": {
    "impl": "claude/claude-sonnet-4-5",
    "ui": "claude/claude-opus-4-1",
    "research": "claude/claude-sonnet-4-5",
    "planning": "claude/claude-sonnet-4-5",
    "audit": "omp/anthropic/claude-haiku-4-5"
  },
  "preferences": [
    "task-pipeline の検証ゲートは実装と別プロバイダで回す。verifier は target project を変更しない。"
  ]
}
```

- `impl` (実装 = `claude`) と `audit` (検証 = `omp`) が**別プロバイダ**になっている。これが「実装と検証を別プロバイダにする」の既定形である。
- `audit` に omp を置く根拠は `paseo-subagent-2026-08.md` の実測 6 — omp のエージェントが `references/verifier.md` の契約 (指示ファイルを読む → verdict path へ書く → 最小 JSON だけを返す → target project を変更しない) を完走し、target project の shasum 一覧が前後で一致した。
- **値は `<provider>/<model>` として読む** (最初の `/` までが provider)。omp のモデル id 自体が `/` を含むため、`omp/anthropic/claude-haiku-4-5` は provider `omp` + model `anthropic/claude-haiku-4-5` になる。
- **provider 名とモデル id は環境ごとに違う。** 実在するものは MCP の `list_providers` / `list_models` で確かめる (この例の値をそのまま信じない)。CLI では `paseo provider ls` が provider の在庫と `status` を返す。
- **`status` が `available` であることと、無人で回せることは別である。** mode の一覧 (`paseo provider ls` の `modes` 列 / `list_providers` の modes) が空の provider — この環境では `junie` (`"modes": ""` / `defaultMode: "default"`) — には**無人実行できる mode が無く**、Paseo 経路に乗せるとツール承認待ちで止まる。乗せる前の事前チェックと、止まったときの扱いは `playbooks/agent-launch.md` の経路節にある。
- `preferences` は自由文の配列で、Paseo 側の規定では「起動時に読み、エージェントのプロンプトへ文脈として織り込む」もの。task-pipeline は各役割の指示ファイル (`references/`) を正としており、`preferences` で指示ファイルの規定を上書きしない。

## 例 (タスクの class で使い分ける)

`providers` に加えて `providers_by_class` を置くと、タスクごとの宣言から導出した **class** (`playbooks/agent-launch.md`「タスクの class」— `trivial` / `standard` / `high`) で provider・model を選べる。**`providers` を置き換えるものではなく、その手前に 1 段挟むだけである** (解決手順の段 2)。該当する行が無ければ従来どおり `providers` が使われるので、**このキーを置かない環境の挙動は 1 文字も変わらない。**

```json
{
  "providers": {
    "impl": "claude/claude-sonnet-4-5",
    "audit": "omp/anthropic/claude-haiku-4-5"
  },
  "providers_by_class": {
    "high": {
      "impl": "claude/claude-opus-4-1",
      "audit": ["claude/claude-opus-4-1", "omp/openai/gpt-5"]
    },
    "trivial": {
      "impl": "claude/claude-haiku-4-5"
    }
  }
}
```

- **`audit` (検証側) を書けるのは `high` だけである。** `standard.audit` / `trivial.audit` を書いても task-pipeline は無視して `providers.audit` へ落とす (`playbooks/agent-launch.md`「class 行の床」)。**verifier を弱めた故障は沈黙する** (誤 PASS はどこにも現れない) のに対し、executor を弱めた故障は検証ゲートの FAIL として必ず表に出る — だから検証側は上げる方向にしか動かさない。
- この例で `trivial` に `impl` だけを置き、`standard` の行を省いているのはそのためである (行を省けばその class は `providers` をそのまま使う)。
- **provider 名とモデル id は環境ごとに違う。** 実在するものは MCP の `list_providers` / `list_models` で確かめる (**この例の値もそのまま信じない**)。値の読み方 (`<provider>/<model>`、最初の `/` までが provider) と、`status: available` が無人実行の可否を意味しないことは上の例と同じである。
- **どの class にどのモデルを割り当てるか (政策値) はこのファイルの領分で、床・段の順序・mode の規則 (不変条件) は `playbooks/agent-launch.md` にある。** このファイルに何を書いても不変条件は上書きできない。

## `high` の `audit` は配列 (異種モデル合議)

`risk: high` の検証は**異種モデル 2 体の合議** (`playbooks/dual-verifier.md`) なので、`providers_by_class.high.audit` は
**JSON 配列で 2 件**を書く。上の例がその形である。起動引数から渡すときはカンマ区切り
(`verify_provider=claude/claude-opus-4-1,omp/openai/gpt-5`) で、意味は同じである。
合議に入るかどうかを決めるのは `audit_mode` (`scripts/task-policy.ts`。`risk: high` の床が `dual`) で、
**`audit_mode: dual` を宣言したタスクは class が `high` でなくても同じ `high` の行を引く**。

- **満たすべき条件は 4 つ** (`playbooks/agent-launch.md`「合議の不変条件」): 2 件ちょうど / provider が違う /
  モデルファミリー (系統) が違う / 双方の系統が値から確かめられる。**1 つでも欠けると、そのタスクの検証ゲートは
  成立せず blocked になる** — 単一の verifier で代替はしない (誤 PASS は沈黙するので、弱い合議は合議が無いより危険である)。
- **系統は provider 名では決まらない。** `claude/claude-opus-4-1` と `omp/anthropic/claude-sonnet-4-5` は provider が
  違っても**どちらも anthropic 系**なので合議にならない。系統は ① `omp` のように model id が `<vendor>/<model>` 形なら
  その vendor ② `claude` / `gemini` のように provider で決まるならそれ ③ `grok-4.5` のような既知の model 名の接頭辞、の順で決まる。
  **`"omp"` のように model を省略した spec は系統を確かめられないので違反になる** — 複数系統を載せる provider では model を明示する。
- **配列を書けるのは `providers_by_class.high.audit` だけである。** `providers.audit` や `impl` に配列を書いても
  単一の spec としては読まれず、その段を素通りする (合議が黙って単一検証へ降格しないため)。3 件以上も黙って 2 件に削らない。
- **この例の provider・モデル id もそのまま信じない** — 実在するものは `list_providers` / `list_models` (CLI なら
  `paseo provider ls`) で確かめる。合議に載せる 2 体は、どちらも無人実行できる mode を持つ必要がある
  (`junie` は持たないので合議には使えない)。

ファイルが無いときの扱い (既定の組で進め、ユーザーに一度だけ伝える) は `playbooks/agent-launch.md` の解決手順にある。
