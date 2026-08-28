// task-pipeline/scripts/command-runner.ts
//
// 外部コマンド (state.ts / paseo / git) の実行境界。**この境界を差し替えることが、
// subprocess を起こさないユニットテストの唯一の入口である** (テストは同じ interface の
// スタブを渡す)。
//
// テスト: pipeline-driver.test.ts / dual-verifier.test.ts のスタブ実装。実行は deno task test。

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): Promise<CommandResult>;
}

export class SubprocessRunner implements CommandRunner {
  async run(
    cmd: string,
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): Promise<CommandResult> {
    const command = new Deno.Command(cmd, {
      args: [...args],
      cwd: opts?.cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }
}
