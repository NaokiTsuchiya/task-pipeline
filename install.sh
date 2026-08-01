#!/bin/sh
# install.sh — SKILL.md を持つトップレベルディレクトリを ~/.claude/skills/ へ、
#              agents/*.md を ~/.claude/agents/ へ symlink する。
#
# 使い方:
#   sh ./install.sh [skill のリンク先ディレクトリ] [agent のリンク先ディレクトリ]
#
# リンク先の優先順:
#   skill: 第 1 引数 > 環境変数 SKILLS_DIR > ~/.claude/skills
#   agent: 第 2 引数 > 環境変数 AGENTS_DIR > ~/.claude/agents
#
# - 冪等: 既に正しい symlink があるものはスキップする。
# - 安全: 同名エントリがこのリポジトリの skill ディレクトリ / agent ファイルを指していない
#   場合 (実ディレクトリ・実ファイル、他所向き symlink など) は変更せず、警告を出して続行する。
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

# --- カスタムサブエージェント定義 (agents/*.md) ---
# skill と同じ冪等・安全ルールでファイル単位に symlink する。
# agents/ が無いリポジトリでも動くよう、無ければ何もしない (警告も出さない)。
if [ -d "$repo_dir/agents" ]; then
    agents_dest=${2:-${AGENTS_DIR:-"$HOME/.claude/agents"}}
    mkdir -p -- "$agents_dest" || exit 1
    agents_dest=$(CDPATH='' cd -P -- "$agents_dest" && pwd) || exit 1

    for src in "$repo_dir"/agents/*.md; do
        [ -f "$src" ] || continue   # マッチ 0 件のときは展開されないパターンが来る
        name=$(basename -- "$src")
        link="$agents_dest/$name"

        if [ -h "$link" ]; then
            # 既存 symlink: readlink は POSIX 外なので ls -l の "<link> -> <target>"
            # 表記からリンク先を取り、ディレクトリ部だけ物理解決してから突き合わせる。
            # リンク先が相対パスのときは **リンクの所在ディレクトリ ($agents_dest)** 基準で
            # 解決する (カレントディレクトリ基準だと実行場所で判定が変わってしまう)。
            # shellcheck disable=SC2012  # POSIX の範囲でリンク先を読む手段は ls -l しかない
            ls_line=$(ls -ld -- "$link" 2>/dev/null)
            link_target=${ls_line#*"$link -> "}   # 既知のリンクパスごと最短一致で落とす
            case $link_target in
                /*) ;;
                *) link_target="$agents_dest/$link_target" ;;
            esac
            link_dir=$(CDPATH='' cd -P -- "$(dirname -- "$link_target")" 2>/dev/null && pwd) || link_dir=
            if [ -n "$link_dir" ] && [ "$link_dir/$(basename -- "$link_target")" = "$src" ]; then
                printf 'skip: agents/%s (already installed)\n' "$name"
            else
                printf 'warning: %s is a symlink not pointing to this repository — left untouched\n' "$link" >&2
                status=1
            fi
        elif [ -e "$link" ]; then
            printf 'warning: %s exists and is not a symlink to this repository — left untouched\n' "$link" >&2
            status=1
        else
            if ln -s -- "$src" "$link"; then
                printf 'install: agents/%s -> %s\n' "$name" "$src"
            else
                printf 'warning: failed to create symlink %s\n' "$link" >&2
                status=1
            fi
        fi
    done
fi

exit "$status"
