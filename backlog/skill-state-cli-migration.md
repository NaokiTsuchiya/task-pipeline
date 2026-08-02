# SKILL.md の記帳手順を CLI 呼び出しへ置き換え、根拠を docs へ退避する

依存: state-cli-verbs

## 背景 / 現状

`state-cli-foundation` と `state-cli-verbs` が入っても、`task-pipeline/SKILL.md` (679 行、2026-08-02 時点) に散文の手順が残っている限り、**目的は 1 つも達成されない**: 不変条件は依然として警告文で守られ、毎イテレーションこの 679 行が再注入され、CLI と散文の二重管理でズレていく。この 3 件目が実際の移行である。

SKILL.md には現在、次のものが**手順として**書かれている (行番号は 2026-08-02 時点):

- 108-115 行「state.json の書き込み手順 (排他)」— `mkdir` / 10 秒待って 3 回再試行 / 10 分の stale 判定 / `mv` での退避 / 読み直しと再適用 / `state.json.tmp` と `mv`
- 123-131 行 — heartbeat と生存一覧の 1 コマンド (`touch` / `find -mmin +1440 -delete` / `find -mmin -90`)
- 59 行以降のスキーマ節 — フィールドの意味と、それを守るための注意書き
- 各所の遷移手順 (`grep -c 'state.json'` = 32 行)、時刻しきい値 (20 行)、id 集合の操作 (31 行)

**これらのうち「なぜそうするのか」は残す価値があり、「どう書くか」は CLI に移った後は不要である。** 両者が同じ段落に混ざっているので、機械的な削除では根拠まで失う。

## 要求

1. SKILL.md の state 更新の指示を、`state-cli-verbs` で作った verb の呼び出しに置き換える。オーケストレーターが行うのは「どの verb を、どの引数で呼ぶか」の判断だけになる状態にする。
2. **判断の根拠は失わない。** 散文に埋まっている「なぜこの規則があるのか」(実測の記録、過去に壊れた経路、選ばなかった設計とその理由) を `task-pipeline/docs/state-machine.md` (新規) へ移す。SKILL.md からはそこを参照する。**根拠を消す移行にしない** — この規則群は実際の破損から書かれたものであり、理由を失うと次の変更で同じ穴が開く。
3. 排他・原子的書き込み・heartbeat・時刻演算・id 集合操作の**手順**は SKILL.md から削除する (CLI 必須。散文のフォールバックは残さない — 二重管理が生む齟齬の方が、CLI が使えない環境より現実的な危険である)。
4. CLI の解決方法を SKILL.md に 1 箇所だけ書く。`~/.claude/skills/task-pipeline/scripts/state.ts` は `install.sh` の symlink 経由で解決されるので、**symlink 越しでも正しいパスになることを確認したうえで**書くこと。
5. `python3` ではなく `deno` が要ることを README のインストール節に明記する (未導入時にどう失敗するかも 1 行)。
6. README の task-pipeline 節を、state 管理の実態に合わせて更新する。
7. 移行によって壊れやすいのは「CLI が返すエラーをオーケストレーターがどう扱うか」である。**verb がエラーを返したときの扱い** (再試行するか、そのイテレーションを諦めるか、blocked にするか) を SKILL.md 側に明記する — CLI は state を守るだけで、その後の判断はモデルの仕事だからである。

## 受け入れ条件

1. SKILL.md に、排他・原子的書き込み・heartbeat・時刻演算の**手順**が残っていない。次の文字列が SKILL.md から検出されないこと: `mkdir` / `state.json.tmp` / `-mmin` / `lock.stale`。(根拠として `docs/state-machine.md` を参照する記述は可。)
2. `task-pipeline/docs/state-machine.md` が存在し、削除した散文が持っていた根拠を含む。少なくとも次の 5 つの「なぜ」が読み取れる: lock を `mv` で退避してから消す理由、書く前に読み直す理由、`executor_last_event_at` を 3 箇所でしか動かさない理由、コミット 0 件で `tip` を入れてはならない理由、`stalled_since` を空振りで進めない理由。
3. SKILL.md に残る state 更新の指示が、すべて verb の呼び出しの形になっている。`state-cli-verbs` の対応表に載っている更新点それぞれについて、SKILL.md の該当箇所が verb を指していること (表の全行を突き合わせた結果を成果物に載せる)。
4. SKILL.md の行数が移行前より**200 行以上**減っている (移行前後の `wc -l` を成果物に実出力で載せる)。
5. verb がエラーを返したときの扱いが SKILL.md に書かれており、少なくとも「lock 取得失敗」「前提違反」「スキーマ違反」の 3 種別それぞれについて、オーケストレーターが次に何をするかが読み取れる。
6. `install.sh` を一時ディレクトリへ実行した後、symlink 越しのパス (`<skills dir>/task-pipeline/scripts/state.ts`) で CLI が実行でき、`get` が動く。この確認がテストとして `tests/` に入っている。
7. README のインストール節に `deno` が前提であることと、未導入時の失敗の見え方が書かれている。README の task-pipeline 節に、state 管理が CLI 側にあることが反映されている。
8. 既存の `.task-pipeline/state.json` を持つプロジェクト (このリポジトリの実データを模したフィクスチャでよい) に対して、移行後の手順どおりに 1 イテレーション相当の遷移 (`claim` → `phase-pass` → `in-review`) を CLI で流し、`validate` が PASS する。
