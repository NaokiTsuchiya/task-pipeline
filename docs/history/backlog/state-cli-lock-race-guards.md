# state.ts が NotFound を握り潰さず、成功した書き込みが missing として返りうる

## 背景 / 現状

行番号は commit 7907913 時点。ずれていたら引用文言で grep すること。`task-pipeline/scripts/state.ts` に、`Deno.errors.NotFound` を想定していない箇所が 3 つある。いずれも `classifyError` (`state.ts:2048-2049`) が NotFound を `missing` (終了コード 13) に分類するため、**verb が失敗したように見える**。`task-pipeline/SKILL.md:56` は `missing` を「再試行せず、実際のエラー出力を添えて報告する」と規定しているので、失敗はそのままイテレーションの停止・報告になる。

### (1) `releaseLock` が `finally` の中で throw しうる

```ts
async function releaseLock(stateDir: string): Promise<void> {
  await Deno.remove(joinPath(stateDir, "lock"), { recursive: true });
}
```

(`state.ts:247-249`) — try/catch が無い。呼び出しは 2 箇所 (`state.ts:354`、`state.ts:795`) で、**どちらも `finally` の中**である:

```ts
  try {
    return await applyStateChange(stateDir, fn);
  } finally {
    await releaseLock(stateDir);
  }
```

`finally` の中で例外が出ると、正常な戻り値 (または元の例外) がその例外に差し替わる。lock が外部から消えている状況は実際に起こりうる: `tryRecoverStaleLock` (`state.ts:193-213`) が 10 分以上古い lock を回収するとき、`mv` で退避してから消すためである (この `mv` 方式の理由は `task-pipeline/docs/state-machine.md:14-30`)。回収された側が `releaseLock` を呼ぶと NotFound になる。

このとき **state.json への書き込みは既に完了している**ので、`task-pipeline/docs/state-cli-contract.md:28` の「エラー時は state.json を一切書き換えない」という全 verb 共通の契約が破れる。オーケストレーターは書き込みが行われていないものとして分岐するため、状態と判断がずれる。

### (2)(3) sessions ディレクトリ走査の TOCTOU

`cmdSessionTouch` の残骸掃除 (`state.ts:849-859`):

```ts
  for await (const entry of Deno.readDir(sessionsDir)) {
    if (!entry.isFile || entry.name === id) continue;
    const info = await Deno.stat(joinPath(sessionsDir, entry.name));
    ...
      await Deno.remove(joinPath(sessionsDir, entry.name));
```

`readDir` で列挙してから要素ごとに `stat` し、条件を満たせば `remove` する。いずれも NotFound を捕まえていない。

`cmdSessionsAlive` (`state.ts:882-889`) も同じ形だが、**こちらは `readDir` だけ NotFound を捕まえている** (`state.ts:876-881` が `return { ok: true, alive: [] }` を返す)。要素ごとの `Deno.stat` (`state.ts:884`) は無防備のままで、ガードが検討されたが途中で止まっていることが分かる。

この 2 verb は `session-touch` / `sessions-alive` で、`task-pipeline/SKILL.md:91` により**毎イテレーションの冒頭で必ず呼ばれる**。どちらも lock を取らない (契約 `docs/state-cli-contract.md:626-635`) ので、複数セッションが同時に走ると、片方が掃除で消したファイルをもう片方が `stat` して NotFound になる窓がある。

## 要求

1. `releaseLock` が、lock ディレクトリが既に無い場合を正常として扱う (NotFound を握り潰す)。lock の解放は「無くなっていればよい」操作であり、無いことは失敗ではない。
2. `cmdSessionTouch` の掃除ループで、要素ごとの `stat` と `remove` が NotFound を正常として扱う (その要素を飛ばす)。
3. `cmdSessionsAlive` の要素ごとの `stat` が NotFound を正常として扱う (その要素を飛ばす)。
4. **`releaseLock` 以外の例外は握り潰さない** — 権限エラー等は従来どおり `permission` として上がること。NotFound だけを対象にする。
5. **契約 (`docs/state-cli-contract.md`) の記述を変えない** — 契約は既に「エラー時は state.json を一切書き換えない」と正しいことを言っており、実装がそれに追いついていないだけである。挙動を説明する必要が出た場合は `docs/state-machine.md` (根拠側) に足す。

## 受け入れ条件

1. 修正前のコードで、(1)(2)(3) それぞれについて NotFound が verb の失敗 (`{"error":"missing"}` / 終了コード 13) に化けることを再現した実出力が成果物にある。再現の手段は問わない (lock ディレクトリや sessions ファイルを並行して削除するループ等)。決定的に再現できないものがあれば、**その旨と理由を成果物に明記する** (再現できないことを黙って省かない)。
2. 修正後、条件 1 と同じ手順で verb が成功する (終了コード 0) 実出力が成果物にある。
3. `releaseLock` の NotFound 許容により、書き込みが成功したケースで `{"ok": ...}` が返ることが確認できる (条件 2 に含めてよい)。
4. NotFound 以外のエラーが従来どおり分類されることがテストで固定されている (少なくとも `permission` が `permission` のまま上がること)。
5. `tests/` に上記 3 箇所の回帰ケースが追加され、`sh tests/run.sh` から実行されて PASS する。決定的なケースにできない箇所があれば、代わりに何を確かめたかを成果物に書く。
6. `git diff` で `task-pipeline/docs/state-cli-contract.md` に変更が無い。
7. `sh tests/run.sh` が全スイート PASS で exit 0。
