<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use PHPUnit\Framework\TestCase;

/**
 * Drives bin/advance as a real subprocess — the one external entry point this
 * CLI has. ArtifactCodecTest/PhaseCodecTest cover the full input-class matrix
 * at the unit level; this file only needs enough subprocess coverage to
 * confirm bin/advance wires those same classes through correctly.
 */
final class CliAdvanceTest extends TestCase
{
    private string $bin;

    protected function setUp(): void
    {
        $this->bin = dirname(__DIR__) . '/bin/advance';
    }

    /** @return array{stdout: string, stderr: string, exit: int} */
    private function runCli(string $stdin): array
    {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = proc_open(['php', $this->bin], $descriptors, $pipes);
        self::assertIsResource($process, 'failed to start bin/advance subprocess');

        fwrite($pipes[0], $stdin);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($process);

        self::assertIsString($stdout);
        self::assertIsString($stderr);

        return ['stdout' => $stdout, 'stderr' => $stderr, 'exit' => $exit];
    }

    public function testTwoConsecutiveLaunchesChainResearchThroughImplement(): void
    {
        $round1 = $this->runCli('{"phase":"research","id":"task-1","artifact":{"type":"none"}}');
        self::assertSame(0, $round1['exit'], $round1['stderr']);
        $decoded1 = json_decode($round1['stdout'], true);
        self::assertSame(['phase' => 'plan', 'id' => 'task-1', 'artifact' => ['type' => 'none']], $decoded1);

        // the literal stdout bytes of round 1 become round 2's stdin — no reshaping in between
        $round2 = $this->runCli($round1['stdout']);
        self::assertSame(0, $round2['exit'], $round2['stderr']);
        $decoded2 = json_decode($round2['stdout'], true);
        self::assertSame(['phase' => 'implement', 'id' => 'task-1', 'artifact' => ['type' => 'none']], $decoded2);
    }

    public function testStdoutIsPureJsonDespiteBecomingRuntimeNotice(): void
    {
        // becoming emits a PHP Notice on every verb call under this experiment's
        // SemanticValidator config; it must land on stderr, not stdout.
        $result = $this->runCli('{"phase":"research","id":"task-1","artifact":{"type":"none"}}');
        self::assertSame(0, $result['exit']);
        self::assertNotNull(json_decode($result['stdout']), 'stdout was not pure JSON: ' . $result['stdout']);
        self::assertStringContainsString('Semantic variable', $result['stderr']);
    }

    public function testRejectsUnknownPhaseWithNonZeroExitAndJsonError(): void
    {
        $result = $this->runCli('{"phase":"implement","id":"task-1","artifact":{"type":"none"}}');
        self::assertSame(1, $result['exit']);
        self::assertSame('', $result['stdout']);
        $error = json_decode($result['stderr'], true);
        self::assertIsArray($error);
        self::assertArrayHasKey('error', $error);
    }

    public function testRejectsMalformedJsonWithNonZeroExit(): void
    {
        $result = $this->runCli('not json');
        self::assertSame(1, $result['exit']);
        self::assertSame('', $result['stdout']);
    }
}
