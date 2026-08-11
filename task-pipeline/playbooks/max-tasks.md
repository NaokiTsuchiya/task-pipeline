**入る条件**: `next` の `start.blocked_by` に `max_tasks` が含まれているとき (SKILL.md「毎イテレーションの手順」1 の、他のどの理由より先に見る判定)。

### `max_tasks` による安全停止

`max_tasks` は**このセッションが新しく着手して完了させたタスクの件数**の上限で、コンテキストが単調増加する `/loop` を安全な地点で止め、人が `/clear` してから再開できるようにするためにある。**省略時は無制限で、以下は一切発火せず現行の挙動を変えない。**

**カウント**: `<state dir>/task_counts/<自分のセッション id>` というファイル (無ければ0件) に、SKILL.md「タスク実行」手順 1 で `state.ts claim` が成功する**たび**にその `<id>` を1行追記する (`mkdir -p "<state dir>/task_counts"` の後 `printf '%s\n' "<id>" >> "<state dir>/task_counts/<自分のセッション id>"` するだけでよい。書くのは自分のセッションだけなので CLI 越しの lock は要らない — `sessions/<id>` の heartbeat と同じ「state dir 配下・自分のファイルだけ触る」規律。**`sessions/` の中には置かない** — `session-touch`/`sessions-alive` は `sessions/` 配下の全ファイルを無条件に対象にするため、紛れ込ませると heartbeat の掃除閾値 (`docs/state-cli-contract.md` の「heartbeat の契約」) で消えたり `sessions-alive` の一覧に紛れたりする)。**件数はこのファイルの行数** (`wc -l`、無ければ0)。`claim` は新しいタスクの着手だけが通る verb で、`pr_fix`/`rebase_fix` の仕上げは `fix-start`/`rebase-start` を使う (`claim` を経由しない) ため、この行数に仕上げの回数は混ざらない。`CLAUDE_CODE_SESSION_ID` が空で自分の id を主張できない環境では `claim` 自体にセッション id を渡せないため、この判定ごと発火しない (SKILL.md の「セッションの所有権」と同じ制約)。

**判定**: SKILL.md「毎イテレーションの手順」1 で、新しいタスクの着手または承認へ進もうとする直前に、飛行中の上限・`max_open` の判定より先に行う。**判定そのものは `next` が済ませている** — `start.blocked_by` に `max_tasks` が含まれているかを見るだけでよい (`next` には `--config max_tasks=<N>` と `--session` を渡してあり、CLI が `task_counts/<自分のセッション id>` の行数を数えている。件数は `counts.tasks_started`)。`max_tasks` が指定されていて上記の行数が `max_tasks` 以上なら、次の**明示条件**でこの節の手順に進むかどうかを決める — **`counts.running_mine_finishing` が 1 以上の間 (自分の仕上げ run が飛行中) は、`start.blocked_by` に `max_tasks` が含まれていてもこの節の手順に進まない** (新しい着手だけ見送り、仕上げは `playbooks/inflight.md` どおり進める)。この条件は分岐順の副産物ではなく `counts.running_mine_finishing` を直接見て判定するので、仕上げが飛行中でなくなった (完了して `retire` された、または `blocked` に落ちた) 後のイテレーションで改めて `start.blocked_by` を見て、`max_tasks` がまだ含まれていればそこでこの節の手順に進む。`counts.running_mine_finishing` が 0 で上記の行数が `max_tasks` 以上なら、新しい着手にも承認にも進まず、この節の手順で止める (このとき自分の `initial` run も飛行中でない — 飛行中なら `start.allowed` が `own_initial` で先に塞がれ、手順1 の「新しい着手」箇条書きにも到達していない。要求している「揮発資源ゼロの地点」は、`own_initial` 不在 ∧ `running_mine_finishing == 0` の両方で明示的に確かめられている)。指定が無い、または行数が `max_tasks` 未満なら、この節は何もせず通常どおり以下の判定 (飛行中の上限・`max_open`) に進む。

**止め方**: 枯渇時フロー手順2と**全く同じ手順**を踏む (`playbooks/depleted.md` の手順 2。新しい停止経路は作らない)。「自分の担当」の定義も同じ (**追従対象**のタスクのうち、生きている他セッションが所有しているもの以外すべて)。自分の担当の観測プロセスを止めて `state.ts release --id <id>` を呼んでから、dynamic なら ScheduleWakeup `stop: true`、固定間隔なら CronList で自ジョブを特定して CronDelete する。**ただし、手順2に含まれるレトロ観測 (`playbooks/retro-launch.md`) はここでは行わない** — `max_tasks` はユーザーが指定した頻度でコンテキストをクリアするための意図的な一時停止であり、パイプラインが継続不能になったわけではない (次のイテレーションで通常どおり再開する)。

**最終報告**: 通常の停止報告に加えて次を含める:
- **再開コマンド**: このセッションを起動した引数をそのまま使う `/loop /task-pipeline <tracker> <source> ...` を具体的な文字列で示す (state.json には引数を保存していないので、このセッション自身が起動時に受け取った `$ARGUMENTS` から組み立てる — 今回の起動時点の情報を使うだけであり、コンテキストの記憶を状態として使うことにはあたらない)。
- **その前に `/clear` する案内**: 上記のコマンドを打つ**前に** `/clear` すること (このセッションのコンテキストを手放してから再開する、が `max_tasks` の目的そのものである)。
- **残っている候補の件数**: state.json の `candidates` の件数と `queue` の `progress: "queued"` の件数。
- **レビュー待ち・追従中の PR の一覧**: `queue` の `progress: "resting"` かつ `artifact.ref` が非null のタスクを、id・ref・(あれば) `attention` を添えて列挙する。
