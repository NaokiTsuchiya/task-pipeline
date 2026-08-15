# イテレーション=セッション境界環境でのセッション所有権と孤児回復 (gh-114, 2026-08)

`paseo loop` のようにイテレーションごとにプロセス (と `CLAUDE_CODE_SESSION_ID`) が変わる環境では、
着手したタスクの `session` フィールドが次のイテレーションから「生きている他セッションが所有する
running タスク」に見え、`excluded` になって誰も引き取れないまま飛行中の枠を占有し続ける
(issue #114 本文の実測)。本ドキュメントは issue 本文の実測に、この issue の research/plan で
新たに得た実測を加え、決めた設計判断をまとめる。

## 実測

### issue 本文の実測 (RayDiContext, 2026-08-13, loop `f0193718`)

| 時刻 (UTC) | 観測 |
|---|---|
| 14:03:33 | iteration 1 (session `7f696802`) が gh-150 を着手。`set-executor` で `ada662c3f` を記録 |
| 14:03:49 | iteration 1 の worker が完了。background の executor は worker プロセスと同時に消滅 |
| 14:09 | iteration 2 (session `efb96547`) が「gh-150 は別セッション (7f696802、heartbeat 生存) 所有の running のため excluded」と記録 |
| 14:11 | 枠が空いていないまま gh-151 を新規着手 |
| 14:18 | worker が独自に「同期起動 (run_in_background:false) で代替」する回避を実施 (SKILL.md 手順3 からの逸脱) |
| 14:32 | `runs/gh-150/` は空 (着手から29分、成果物ゼロ)、`git status` も0 files |
| 14:38 | iteration 3。`executor_last_event_at` (14:03:33) から沈黙35分、`next` はまだ `wait {reason: "executor-alive"}` (沈黙判定の閾値90分に未達) |
| 14:45 | `probe-session-xyz` (何も所有していない新規セッション視点) でも `own_initial` が立ち新規着手が塞がれる。42分間、2分間隔のループが同じ判定を取り直すだけの空転 |

同時刻の `next` の実測 (読み取り専用視点):
```json
"counts": { "running_excluded_initial": 2, "excluded": 2, "queued": 0 }
"start":  { "allowed": false, "blocked_by": ["inflight_limit"] }
```
死んだセッションの heartbeat を手で削除しても `excluded` は外れるだけで、`action` は
`wait {reason: "executor-alive"}` のまま (沈黙90分が支配的)。合計で着手から約120分、
1バイトも進まないまま枠を塞ぐ。

### research/plan フェーズで新たに得た実測

- **#111 (executor の Paseo 経路化) は本 issue の裏取り時点 (`64a48cd`) より後、現 HEAD
  (`bc07ca1`) より前に解決済み** (`git log --oneline --grep="111"` → `bc07ca1 Merge pull request
  #121 ... task-pipeline/gh-111` / `e9ba225 executor を Paseo 経路で起動し、停止検知を通知依存
  から外す`)。これにより executor 単体の停止検知は現 HEAD で既にポーリング (`wait
  {reason:"executor-alive"}`) 化されており、本 issue の主題 (オーケストレーター自身のセッション
  id がイテレーション境界で失効すること) とは独立に解決済みである。
- **`paseo loop` サブコマンドは、この worktree にインストールされている `paseo` CLI (v0.4.0,
  `/Applications/Paseo.app/Contents/Resources/bin/paseo`) の `--help` 一覧に無い**。
  `paseo loop --help` はトップレベル help にフォールバックする (終了コード0)。`schedule`/
  `heartbeat`/`agent` 等は存在するが `loop` は無い。`~/.claude/skills/paseo-loop/SKILL.md` は
  「Loops are a CLI primitive: `paseo loop run`」と明記しており、issue 本文の実測はこの
  (このワークステーションより新しい、あるいは別の) CLI で取られたものである。
- **`app.asar` (Paseo デスクトップアプリの Electron バンドル) に `PASEO_LOOP*` 系の環境変数は
  無い** (`grep -a -o 'PASEO_[A-Z_]*' app.asar | sort -u` で拾える127個の `PASEO_` 環境変数の中に
  loop 関連は0件。`PASEO_AGENT_ID`/`PASEO_AGENT_CWD` 等はある)。つまり `paseo loop` の worker が
  自分の loop id を環境変数から直接読む経路は無い (`docs/paseo-subagent-2026-08.md` 実測5が示す
  「`PASEO_AGENT_ID` は自分自身の id」がここでも唯一の直接手がかりで、親/loop の id は
  `paseo inspect`/`paseo loop inspect` 等の照会が要る)。
- **`paseo` CLI の `loop` 文字列自体は `app.asar` 内に存在する** (`"loop"`/`"loops"` の文字列
  リテラルがヒットする) — デスクトップアプリ側には概念があるが、手元の CLI シム
  (`bin/paseo`) には配線されていない、というバージョン不整合と見られる。

## 決定

### 決定1: セッション id 解決の優先順 (要求1)

1. `CLAUDE_CODE_SESSION_ID` が空でなく、かつイテレーション境界がセッション境界と一致しない環境
   (対話セッション、Claude Code ハーネスの `/loop` skill 配下) → そのまま使う (現状維持)。
2. それ以外 (空、または `paseo loop` 配下のようにイテレーションごとにプロセスが変わる環境) →
   **所有権を主張しない** (`session` は null のまま進める)。

検討した他の候補と、採らなかった理由:

- **ループ id (`paseo loop inspect` の `id`)** — issue 本文はこれがイテレーションを跨いで安定する
  と実測しているが、上記のとおりこの worktree の `paseo` CLI には `loop` サブコマンドが無く、
  応答形も検証できない。未検証の自動判別ロジックを動くかのように書くことはしない。
- **`PASEO_AGENT_ID` の親を辿る** — 実測5 (`docs/paseo-subagent-2026-08.md`) のとおり
  `PASEO_AGENT_ID` は各エージェントの**自分自身の id** であって親/loop の id ではなく、
  親を得るには `paseo inspect` の `ParentAgentId` を読む追加の照会が要る。また
  `PASEO_LOOP_ID` 相当の環境変数が存在しない (上記実測) ため、この経路も loop id 自体の
  自動発見にはならない。
- **state dir に置く永続 id** — 「次のイテレーションが前のイテレーションの後継である」ことを
  証明する外部の相関子が無いと、id を永続化しても「今回が本当に同じループの続きか」を
  判定できない (相関子が要るのは決定1の根本問題であり、永続化はそれを回避しない)。

**この決定だけでは gh-114 の本題 (孤児が90分〜120分回復しない) は解決しない** — 主たる救済は
決定2 (孤児の強い証拠) である。決定1は「主張できるときは主張する / できないときは嘘をつかず
null のままにする」という誠実さの担保に留める。

### 決定2: 孤児判定の強い証拠と即時回復 (要求2)

3種の証拠が**すべて**揃ったときだけ、`next` が沈黙90分・引き継ぎ待ち30分のどちらも待たずに
即座に `takeover{reason:"strong-evidence"}` を返す:

1. `run.executor` が Paseo に存在しない (`paseo inspect <run.executor> --json` の終了コードが
   非ゼロ)。**Paseo 経路の executor だけが対象** — 現行ハーネス経路の executor にはこの照合手段が
   無い。
2. run dir に成果物が1つも無い。
3. worktree に変更が無い (`git status --porcelain` が空、かつ `base..HEAD` のコミットが無い)。

対象範囲は所有権が `self` (自分が今まさに所有している) 以外の全域 (`unowned`/`dead`/
`alive-other`) とする。`alive-other` (生存一覧に heartbeat がまだ残っている) でも対象にするのが
本質— 「生存一覧から落ちているだけでは死の証明にならない」という既存の安全側の規定
(`playbooks/inflight.md`) は保ったまま、それとは別の・より強い証拠だけがこの経路を開く。

実装: `task-pipeline/scripts/state-next.ts` の `NextInput.deadEvidence` (呼び出し側が読み取り専用の
照会で確定させたタスク id の列)。証拠の収集手順は `playbooks/inflight.md` の「孤児の強い証拠」。

### 決定3: 90分しきい値とループ間隔の関係 (要求3) — 据え置き

`EXECUTOR_SILENT_MIN`(90分)/`TAKEOVER_MIN`(30分)/`sessions-alive` の90分は**据え置く**。これらは
「複数セッション協調」全体で共有される安全マージンであり (対話セッションの正当な長考・中断にも
波及する)、`paseo loop` 専用の値ではない。イテレーション間隔 (issue 実測では2分) との桁のミスマッチ
は、間隔に依存しない決定2の即時回復経路で吸収する — 閾値そのものを動かす必要が無くなる、という
のが「据え置き」の理由。

### 決定4: SKILL.md「ペーシングと枯渇」節の書き直し (要求4)

「実行エージェントと観測プロセスが heartbeat を打ち続けるので、生きている限り所有は維持される」
という無条件の書き方をやめ、(a) 現行ハーネス経路の実行エージェント/観測プロセスは自分の
session id を撫で続けるので、そのセッションが次のイテレーションでも同じ id で生き続ける環境
(対話セッション、Claude Code ハーネスの `/loop` skill 配下) では所有が維持されること、
(b) `paseo loop` のようにイテレーションごとにセッション/エージェントが入れ替わる環境では、
Paseo 経路の executor は所有セッションの heartbeat を撫でず (#111 で判明済み)、オーケストレーター
自身の session id もイテレーションごとに変わるため、この前提が成立しないこと、の両方を明記する
形に直した (`task-pipeline/SKILL.md` の「ペーシングと枯渇」節)。

### 決定5: 同期起動の禁止 (要求5)

**禁じる。** #111 (現 HEAD で解決済み) により executor の停止検知はポーリング
(`wait{reason:"executor-alive"}`) に移っており、同一セッション内の停止通知を待つ必要が無い。
`playbooks/agent-launch.md` の役割の表は元々 executor を「background」固定にしており、issue の
worker が行った同期起動はそもそも既存規定への違反だった — 今回は禁止を明文化して解釈の余地を
無くした。加えて、**イテレーション境界=セッション境界の環境では、現行ハーネス経路の background
へのフォールバックも使わない** — 停止通知が届くのはそのセッションが生きている間だけで、次の
イテレーションは別セッションになるため、フォールバックすると気づかれない孤児が生まれる。この
環境で Paseo 経路が使えなければ `block` にして人に委ねる。

### 決定6: state.json スキーマ

`task-pipeline/scripts/state.schema.json` は変更しない。孤児の強い証拠 (`--dead-tasks`) は
`next` verb 呼び出し時の一時入力であり、state.json には永続化しない (受け入れ条件7)。
