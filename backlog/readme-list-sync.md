# README skill 一覧の自動生成とずれ検知

## 背景 / 現状

- README.md の「skills 一覧」表 (5-10 行目) は手書き。skill の追加・説明変更のたびに手動更新が必要で、SKILL.md の実体とずれうる。
- 各 skill の SKILL.md frontmatter には `name` と `description` がある (task-pipeline/SKILL.md 2-3 行目、task-prep/SKILL.md 2-3 行目)。ただし description は複数文の長文で、現在の表の 1 行要約とは粒度が違う (そのまま流し込むと表が崩れる)。
- skill ディレクトリの機械的な見分け方: リポジトリ直下で `SKILL.md` を直接含むディレクトリ。backlog/ と prompts/ には SKILL.md が無い。

## 要求

SKILL.md を持つトップレベルディレクトリを列挙し、README.md の skill 一覧表を SKILL.md から機械生成するスクリプトを追加する。動作モードは 2 つ:

- 生成モード: README.md の一覧表を最新の skill 群から再生成して書き込む。一覧以外の節は変更しない。
- チェックモード: 生成結果と現在の README.md を比較し、ずれがあれば非 0 終了で差分を示す (README は変更しない)。
- 表の各行の説明文は、その skill の frontmatter `description` の冒頭 1 文を機械抽出したものとする (要約フィールドの新設はしない)。
- 形式: 依存ゼロの POSIX sh 単発スクリプト (POSIX sh + POSIX 標準ユーティリティのみ)。

## 受け入れ条件

1. 生成モードを実行すると、README.md の一覧表に SKILL.md を持つ全トップレベルディレクトリ (現時点では task-pipeline, task-prep) の行があり、各行はその skill の SKILL.md への相対リンクと、frontmatter `description` の冒頭 1 文と一致する説明を含む。
2. README が最新の状態でチェックモードを実行すると終了コード 0。
3. いずれかの SKILL.md の説明を変更した直後 (README 未再生成) にチェックモードを実行すると非 0 終了し、ずれの内容が出力される。
4. SKILL.md を置いた新しいトップレベルディレクトリを追加して生成モードを実行すると、スクリプト本文を編集していないのに、その skill の行が表に追加される。
5. 生成モードの前後で、README.md の一覧表以外の節 (インストール、各 skill の使い方、設計メモ) に差分が生じない。
