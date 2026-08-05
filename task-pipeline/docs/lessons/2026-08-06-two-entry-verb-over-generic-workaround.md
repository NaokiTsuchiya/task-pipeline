入口が 2 つある遷移は、汎用 verb の転用ではなく、その遷移を担う verb の from を 2 つにする。

# 遷移表を「表 + 例外」にしない

rebase_fix への finalize からの入口 (PR #19 時点) は、rebase-start が in_review 前提で
拒否するため、汎用の phase-pass を転用して回避されていた。この形は遷移表を作ると
「phase-pass の辺の例外」として表の外に残り、表を検査するテスト (行列・文書突き合わせ) の
網から漏れる。

採った形: rebase-start の from を [in_review, in_progress/finalize] の 2 つにし、
入口ごとの補助前提 (resolve_pending の要否) を verb 内で分岐する。遷移は「その遷移を
担う verb」に集め、phase-pass は検証フェーズ列の隣接辺専用に絞る。表に例外が無ければ、
表の検査がそのまま全遷移の検査になる。
