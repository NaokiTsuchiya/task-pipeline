# gh issue 本文の読み書きを安全化する (ハングと欠落)

## 背景 / 現状

行番号はコミット 3015e87 時点。GitHub MCP の `issue_read (method: "get")` が issue 本文を HTML エスケープして返し (`>` → `&gt;` 等、コードブロック内も)、`<!-- ... -->` 行と `<...>` 表記を中身ごと落とすことは実測記録済み (task-pipeline/references/adapters/gh.md 133 行、task-pipeline/docs/gate-declaration-2026-08.md §2 に 2026-08-02 の再現記録)。これを前提に 3 つの問題が残っている:

1. **task-prep の深掘りが issue 本文を破損させる。** task-prep/references/trackers/gh.md は既存 issue の取得を `issue_read (method: get)` で行い (25 行)、深掘り結果を `issue_write (method: update, body: ...)` で書き戻す (29 行)。読めていない内容は書き戻しで復元できないため、この read-modify-write は元の本文にあった山括弧表記や HTML コメントを無警告で消す (GitHub の編集履歴には残るが、本文からは消える)。同ファイル 27 行の警告は「task-prep が新たに書く本文に山括弧を使うな」という書き側規則のみで、既存本文の保全は扱っていない。task-pipeline 側は verbatim 経路 (`gh issue view`) に修正済みだが、task-prep は gh CLI を禁じており (5 行「この環境では認証が 1Password シェルプラグイン依存で、非対話実行がハングする」)、代替経路が無い。本セッションの敵対的検証で CONFIRMED。
2. **task-pipeline の本文取得にハング対策が無い。** adapters/gh.md 136 行の `gh issue view <番号> --repo <owner/repo> --json body --jq .body` は、上記と同じ環境理由でハングしうる。フォールバック (139 行) は「gh が使えない環境では」の即時失敗しか扱っておらず、時間上限が無い。また executor.md 101 行と pr-watcher.md 24 行が持つ実体バイナリ回避 (`which -a gh | grep '^/' | head -1` — エイリアスされた gh を避ける) が、gh を叩く 3 ファイル中この adapters/gh.md にだけ無い (`grep -n "timeout\|which -a" task-pipeline/references/adapters/gh.md` は 0 件、本セッションで確認)。gate-declaration-2026-08.md 107-110 行はこれを未解決の宿題として明記している (「無人ループの中で本文取得が固まると、そのタスクは着手時点で止まる」)。
3. **エスケープ無しで本文を読める MCP/REST 経路は未調査。** gate-declaration-2026-08.md 110 行「MCP 側でエスケープを避けて読む口 (REST の raw body 等) があるならそちらへ寄せたい — 未調査」。

## 要求

1. **調査**: GitHub MCP (または MCP から呼べる経路) に、issue 本文を HTML エスケープ無しで返す取得手段があるかを実際に呼んで確かめる。判定規則: あればそれを adapters/gh.md と task-prep/references/trackers/gh.md の両方の取得経路として採用する。無ければ現行の gh CLI 経路を残し、次の 2 と 3 で防御する。
2. **ハング防御** (gh CLI 経路が残る場合): adapters/gh.md の本文取得節に (a) 時間上限付き実行 (例: 30 秒で打ち切り。macOS には timeout コマンドが無い環境もあるため、実際に動く手段を選ぶこと)、(b) executor.md / pr-watcher.md と同じ実体バイナリ回避、(c) タイムアウトを「gh が使えない」と同一視して既存のエスケープ本文フォールバック (139 行) へ進む規則、を明記する。
3. **task-prep の欠落対策**: task-prep/references/trackers/gh.md の深掘り入力 (25 行) に、読み出し欠落を前提にした保全規則を入れる。採用経路が raw ならそれで解決。gh CLI が使えないままなら、書き戻し前に欠落を検出・警告する手順 (例: 書き戻し案の提示時に issue URL を添えて欠落の恐れを明示する、元本文に `<` を含む行があった場合は原文との突き合わせをユーザーに求める等、実際に機能する手段) を明記する。
4. **記録**: 調査の結果 (試した経路と返り値の実例) を gate-declaration-2026-08.md §4 の該当宿題の消し込みとして追記する。

## 受け入れ条件

1. gate-declaration-2026-08.md に調査結果が追記されており、試した取得手段と、エスケープ有無の実例が読める。
2. 採用された取得経路で、`<...>` 表記または `<!-- ... -->` 行を含む issue 本文が欠けずに取得できることの実測記録がある。読み取りだけで確認できる素材の例: RayDiContext の issue #79 / #80 は本文末尾に `<!-- task-pipeline:gate=light -->` を含むことが gate-declaration-2026-08.md §1 に記録されている。実測できない事情があるなら、その旨と理由が明記されている。
3. gh CLI 経路が残る場合: adapters/gh.md の本文取得節に時間上限と実体バイナリ回避の両方の記述があり (`grep -n "timeout\|which -a gh"` 相当でヒットする)、タイムアウト時にエスケープ本文フォールバックへ進む規則が読める。
4. task-prep/references/trackers/gh.md の深掘り入力の節に、issue_read の欠落 (エスケープ・山括弧・HTML コメント) を認識した保全規則が明記されており、「issue_read で読んだ内容をそのまま issue_write の基礎にする」形の記述が残っていない。
