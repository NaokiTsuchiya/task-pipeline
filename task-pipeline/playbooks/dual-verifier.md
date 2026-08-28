**入る条件**: 検証ゲート (SKILL.md「タスク実行」手順 6) のシェル判定が `{"route": "llm", "audit_mode": "dual"}` を返した直後 (= `risk: high` の床、または `audit_mode: dual` の宣言による合議ゲート)。ここで決めるのは検証を**異種モデル 2 体の合議**として回す手順だけで、verifier のプロンプト文面・起動経路・行動境界は変わらない (文面は SKILL.md 手順 6、経路は `playbooks/agent-launch.md`)。

## この手順書が守るもの

- **両 PASS 必須**: 2 体のうち 1 体でも FAIL ならラウンド全体が FAIL である。
- **同一スナップショット**: 2 体は同じ成果物・同じ作業ツリーを判定する。判定のあいだに成果物が動いたラウンドは**破棄**され、判定として採用されない。
- **単一への降格禁止**: 2 体を用意できない設定は不変条件違反であり、1 体で通すことはしない (`agent-launch.md`「合議の不変条件」)。
- **逐次実行**: スロットは**1 体ずつ**起こす。テストキャッシュや一時ファイルの干渉を避けるためで、2 体を同時に走らせてはならない。

**判定を左右する計算 (スロットの割り当て・パス・スナップショット・合成) はすべて `scripts/dual-verifier.ts` にある。** オーケストレーターがやるのは、この CLI を順に呼び、返った JSON の `mode` / `next` / `outcome` で分岐することだけである。値を自分で計算しない。

呼び出しの完全形 (以下は `dual-verifier.ts <verb> ...` と略記する):

```
deno run --no-prompt --allow-read --allow-write --allow-env --allow-run \
  ~/.claude/skills/task-pipeline/scripts/dual-verifier.ts <verb> [フラグ...]
```

## 手順

1. **正典の判定パスを取る** — 通常どおり `state.ts verdict-path --id <id>` を 1 回呼び、返る `path` を以下 `<canonical>` と呼ぶ。
2. **スロットを決める**:

   ```
   dual-verifier.ts slots --canonical <canonical> --task <tasks/<id>.md の絶対パス> \
     --phase <run.phase> --run-dir <runs/<id> の絶対パス> --target <worktree の絶対パス>
   ```

   応答の `audit_mode` はシェル判定が返した値と一致する (同じ `task-policy.ts` の導出を引いているため)。食い違ったらタスクファイルが書き換わっているので、history に 1 行残して**シェル判定の値を採る** (保守側)。

   - `"mode": "single"` → そのタスクは合議の対象ではない (`audit_mode` が `dual` でない)。**この手順書を抜けて SKILL.md 手順 6 の通常の検証ゲートに戻る。**
   - `"mode": "dual"` → 応答の `slots[]` に、スロットごとの `provider` / `model` / `mode` / `verdict_path` が入っている。ラウンドの控え (マニフェスト) は CLI が書いている。
   - `{"error": "invariant", "reason": ...}` (終了コード 15) → 下記「不変条件違反」へ。
3. **スロットを 1 体ずつ回す**。`next-slot` が `null` を返すまで次を繰り返す:

   ```
   dual-verifier.ts next-slot --canonical <canonical>
   ```

   - 応答の `next` が `"a"` / `"b"` なら、そのスロットの verifier を**1 体だけ**起動する。起動は SKILL.md 手順 6 のプロンプト文面そのままで、**`verdict path:` にはそのスロットの `verdict_path` を渡す** (`next-slot` の応答にも入っている)。provider・model・mode は手順 2 の `slots[]` のその行の値を使い、経路は `agent-launch.md` の 3 段をそのまま通す (Paseo → `task-pipeline-verifier` → `general-purpose`)。**`reuse_verifier` は使わない** — 合議は毎ラウンド 2 体ともフレッシュに起こす (High の「フェーズ毎フレッシュ」)。
   - **そのスロットが停止するまで、次のスロットを起こさない。** 停止後、Paseo 経路なら usage の採取と owned workspace の後始末を通常どおり行う (`agent-launch.md`)。
   - 続けてそのスロットのスナップショットを控える:

     ```
     dual-verifier.ts record-slot --canonical <canonical> --slot <a|b> \
       --run-dir <runs/<id> の絶対パス> --target <worktree の絶対パス> --agent <その verifier の agentId>
     ```

     終了コード 15 (`slot ... has no verdict yet`) は、その verifier が判定ファイルを書かずに終わったということである。**その回は合議として成立していない** — 同じスロットをもう一度起こす (`next-slot` は同じスロットを返し続ける)。3 回目も書かれなければ、検証エージェントを起こせないときと同じ扱い (下記「不変条件違反」と同じ終端) にする。
4. **合成する** (`next-slot` の `ready` が真になったら):

   ```
   dual-verifier.ts synthesize --canonical <canonical>
   ```

   応答の `outcome` で分岐する。**正典ファイルは CLI が書く** (オーケストレーターも verifier も書かない):
   - `"pass"` → 2 体とも PASS。SKILL.md 手順 6 の **PASS** の処理をそのまま行う (`state.ts advance` 以降)。
   - `"fail"` → 1 体以上が FAIL。SKILL.md 手順 6 の **FAIL** の処理を行うが、**`state.ts phase-fail` に `--verifier` を渡さない** (渡すと次のラウンドで `reuse_verifier` が片方の verifier を指してしまう。省略すれば `run.verifier` は null のままで、次のラウンドは必ず 2 体フレッシュになる)。実行エージェントへ渡すのは `<canonical>` のパスで、その中の `reasons` / `required_fixes` は `[<provider>] ` の出所タグ付きで両スロット分が並んでいる。
   - `"discarded"` (`reason: "snapshot-mismatch"`) → 2 体が**別のスナップショット**を判定していた (判定のあいだに成果物か作業ツリーが動いた)。**判定として採用せず、`attempts` も進めない** (`phase-fail` を呼ばない)。手順 2 からラウンドをやり直す — `slots` を呼び直すと新しいスナップショットで控えが取り直される。history に 1 行残す (`dual-verifier: <id> <phase> ラウンドをスナップショット不整合で破棄 — 再検証`)。
   - `"incomplete"` → スロットの判定が欠けている・壊れている・スナップショットが未記録である。`detail.slots` のスロットを手順 3 からやり直す。
5. history に 1 行残す (`dual-verifier: <id> <phase> 合議 <PASS|FAIL> (a=<provider>:<PASS|FAIL> / b=<provider>:<PASS|FAIL>)`)。

## 不変条件違反 (2 体を用意できないとき)

`slots` が `{"error": "invariant", ...}` を返したら、**そのタスクの検証はこのイテレーションでは成立しない。単一の verifier で代替してはならない** — 誤 PASS は沈黙するので、弱い検証で通すことは「検証しない」より危険である。扱いは検証エージェントをどちらの経路でも起こせないときと同じ (`agent-launch.md` 経路節 項 6 の「タスクに紐づく役割」):

1. `state.ts block --id <id> --reason "risk: high の合議ゲートを構成できない (<reason>)"` を呼ぶ。
2. アダプタで `mark <id> blocked <理由>`。
3. `PushNotification` を 1 本送る。**ループは止めない。**
4. history に 1 行 (`dual-verifier: <id> は合議の不変条件を満たさない (<reason>) — block`)。

`reason` の意味と直し方は `agent-launch.md`「合議の不変条件」と `docs/orchestration-preferences.md` にある (`not-configured` = `providers_by_class.high.audit` が無い / `single-spec` = 1 体しか書かれていない / `too-many-specs` = 3 体以上 / `duplicate-provider` = 同じ provider / `same-family` = 同じモデルファミリー / `unknown-family` = model が省略されていて系統を確かめられない / `malformed-spec` = 値の形が壊れている)。**どれもユーザーの設定 1 箇所で直る**ので、通知の本文に `reason` をそのまま載せる。
