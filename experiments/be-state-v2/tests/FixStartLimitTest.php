<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Pending;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Tests\Support\Chain;
use Experiment\BeStateV2\Verbs\FixStart\FixStartInput;
use PHPUnit\Framework\TestCase;

/**
 * Defect #9 / acceptance condition 7: once attention has latched to
 * Human("fix_limit"), a further fix-start is rejected at construction — the
 * from-guard (attention===auto) fails regardless of fixAsk. This is the
 * "already latched, rejected again" half; FixStartLimitReachedTest exercises
 * the other half (the latch actually engaging on the call that crosses the
 * limit).
 */
final class FixStartLimitTest extends TestCase
{
    public function testFixStartAgainstLatchedAttentionFailsAtConstruction(): void
    {
        $resting = new Resting(
            id: 'task-3',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/3',
                branch: 'task-3',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Human('fix_limit'),
                    fixAsk: new Pending(),
                    ledger: new Ledger(fixAttempts: 4),
                    probe: new Probe(proc: null),
                ),
            ),
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('attention === auto');
        new FixStartInput($resting);
    }

    public function testFixStartWithinLimitConstructsAndStarts(): void
    {
        $resting = new Resting(
            id: 'task-4',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/4',
                branch: 'task-4',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Auto(),
                    fixAsk: new Pending(),
                    ledger: new Ledger(fixAttempts: 0),
                    probe: new Probe(proc: null),
                ),
            ),
        );

        $input = new FixStartInput($resting);
        self::assertTrue($input->started);

        $becoming = Chain::becoming();
        $result = $becoming($input);
        self::assertInstanceOf(\Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFix::class, $result);
    }
}
