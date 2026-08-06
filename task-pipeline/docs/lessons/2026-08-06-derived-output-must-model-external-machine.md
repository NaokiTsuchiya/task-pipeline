state 内部の遷移から後続指示を導出するとき、外部システム側の状態機械を座標に入れないと同期が壊れる。mark の要否は artifact の遷移ではなくトラッカーの status 遷移が決める。

# 導出値の座標には外部システムの状態機械も含める

状態モデル v2 で、`ship` の応答に「トラッカーへ `mark in_review` を呼ぶべきか」を
導出して返す形を入れた。初版は内部状態だけを見て「artifact が none→open した
ときだけ真」と導出した。独立検証が反例を 2 つ出した: restore 後の再走 (artifact は
open のまま) と finish=none (artifact は none のまま) — どちらも artifact は
遷移しないが、トラッカーは claim のたびに in_progress へ落ちているので、
engagement の終端では必ず in_review へ戻す mark が要る。放置するとトラッカーが
in_progress で取り残される (2026-08-05 の実運用障害と同じ「経路記憶の欠落」を、
今度はトラッカー同期側で再生産するところだった)。

正しい導出は `run.kind == initial` — つまり「mark in_progress を打った engagement の
終端か」であり、これは**トラッカー自身の状態機械** (approved → in_progress →
in_review → …) の辺に対応している。内部モデルがどれだけ綺麗でも、導出値の読み手が
外部システムなら、その外部システムの状態遷移を導出の座標に含めなければならない。
「外部システムを最後に動かした操作は何で、いま外部はどのノードに居るか」を
内部 state から復元できるか、が検査の問いになる。
