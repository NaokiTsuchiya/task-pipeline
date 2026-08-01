# CI で README 一覧のずれを検知する

依存: readme-list-sync
未確定: リモート (GitHub リポジトリ) をいつ作るか — 現状 `git remote -v` は空で、このままでは GitHub Actions は永久に走らない (2026-08-02 確認)

## 背景 / 現状

- リポジトリに CI 設定は無い (`.github/` ディレクトリ自体が存在しない)。
- readme-list-sync が入ってもチェックモードの実行はローカルの手動運用頼みで、実行を忘れればやはりずれる。

## 要求

GitHub Actions のワークフローを追加し、push および pull request で readme-list-sync のチェックモードを実行して、README の一覧がずれているコミットでは CI が fail するようにする。

## 受け入れ条件

1. `.github/workflows/` 配下にワークフローファイルがあり、push と pull_request をトリガーにチェックモードを実行する定義になっている。
2. README がずれた状態 (SKILL.md の説明を変えて README を再生成しない) でチェックモードを実行すると非 0 終了する — ワークフローが実行するのと同一のコマンドで確認する。
3. README が最新の状態では同コマンドが終了コード 0 で通る。
