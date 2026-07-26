#!/bin/sh
# install.sh — SKILL.md を持つトップレベルディレクトリを ~/.claude/skills/ へ symlink する。
#
# 使い方:
#   sh ./install.sh [リンク先ディレクトリ]
#
# リンク先の優先順: 第 1 引数 > 環境変数 SKILLS_DIR > ~/.claude/skills
#
# - 冪等: 既に正しい symlink があるものはスキップする。
# - 安全: 同名エントリがこのリポジトリの skill ディレクトリを指していない場合
#   (実ディレクトリ、他所向き symlink など) は変更せず、警告を出して続行する。
# - POSIX sh + POSIX 標準ユーティリティのみ (readlink 等の拡張は使わない)。
set -u

# このスクリプトのあるディレクトリ = リポジトリルート (物理パス)
repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1

dest_dir=${1:-${SKILLS_DIR:-"$HOME/.claude/skills"}}
mkdir -p -- "$dest_dir" || exit 1
dest_dir=$(CDPATH='' cd -P -- "$dest_dir" && pwd) || exit 1

status=0
found=0

for src in "$repo_dir"/*/; do
    [ -f "${src}SKILL.md" ] || continue
    found=1
    name=$(basename -- "$src")
    src_phys=$(CDPATH='' cd -P -- "$src" && pwd) || { status=1; continue; }
    link="$dest_dir/$name"

    if [ -h "$link" ]; then
        # 既存 symlink: 解決後の物理パスが一致すれば正しいリンクとしてスキップ
        link_phys=$(CDPATH='' cd -P -- "$link" 2>/dev/null && pwd) || link_phys=
        if [ "$link_phys" = "$src_phys" ]; then
            printf 'skip: %s (already installed)\n' "$name"
        else
            printf 'warning: %s is a symlink not pointing to this repository — left untouched\n' "$link" >&2
            status=1
        fi
    elif [ -e "$link" ]; then
        # symlink 以外の既存エントリ (実ディレクトリ・ファイル)
        printf 'warning: %s exists and is not a symlink to this repository — left untouched\n' "$link" >&2
        status=1
    else
        if ln -s -- "$src_phys" "$link"; then
            printf 'install: %s -> %s\n' "$name" "$src_phys"
        else
            printf 'warning: failed to create symlink %s\n' "$link" >&2
            status=1
        fi
    fi
done

if [ "$found" -eq 0 ]; then
    printf 'warning: no skill directories (containing SKILL.md) found under %s\n' "$repo_dir" >&2
    status=1
fi

exit "$status"
