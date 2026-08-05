実行時不変条件は「その書き込みで触った item」だけに掛ける。全 state に掛けると既存の state.json でパイプラインが詰まる。

# 実行時不変条件のスコープは触った item に限る

到達不能ノードを書かせない実行時アサーション (assertItemInvariants) を、当初は書き込み前の
state 全体に掛けることを検討したが、旧実装が書いた既存の state.json (例: watching のまま
approved に restore されたタスク) を持つプロジェクトでは、無関係な verb (history-append 等)
まで全部 schema エラーで詰まる。マイグレーションを書かずに安全網を足すには、検査対象を
「この書き込みで変更した queue エントリ」だけに絞ればよい — 新しく書く状態は必ず検査され、
過去の残骸は触ったときにだけ問題になる。

より強い性質 (done なら session null、approved/blocked なら watch stopped 等) は実行時では
なくテスト側 (T-MX の出力不変条件) に置いた。テストは全 verb の出力を網羅するので保証は
落ちず、実行時の互換リスクだけが消える。
