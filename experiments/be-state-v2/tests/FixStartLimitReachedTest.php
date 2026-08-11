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
 * Defect #9's other half: the "上限超" to branch itself must fire through an
 * actual fix-start call, not just be rejected afterwards (FixStartLimitTest
 * only fixture-constructs an already-latched state). fixAttempts=3 is still
 * within the limit (FixStartInput::ATTEMPT_LIMIT); the call that pushes it to
 * 4 is the one that must flip attention to Human("fix_limit") instead of
 * entering PhasePrFix — catching an off-by-one (>=3 vs >3) that
 * FixStartLimitTest cannot.
 */
final class FixStartLimitReachedTest extends TestCase
{
    public function testFixStartLatchesOnceLimitIsReached(): void
    {
        $resting = new Resting(
            id: 'task-5',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/5',
                branch: 'task-5',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Auto(),
                    fixAsk: new Pending(),
                    ledger: new Ledger(fixAttempts: 3),
                    probe: new Probe(proc: null),
                ),
            ),
        );

        $input = new FixStartInput($resting);
        self::assertFalse($input->started, 'the 4th attempt (3+1) exceeds ATTEMPT_LIMIT=3');
        self::assertInstanceOf(Human::class, $input->artifact->follow?->attention);
        self::assertSame('fix_limit', $input->artifact->follow?->attention->reason);

        $becoming = Chain::becoming();
        $result = $becoming($input);
        self::assertInstanceOf(Resting::class, $result, 'over the limit, fix-start stays at resting instead of entering PhasePrFix');
        self::assertInstanceOf(ArtifactOpen::class, $result->artifact);
        self::assertInstanceOf(Human::class, $result->artifact->follow?->attention);
        self::assertInstanceOf(Pending::class, $result->artifact->follow?->fixAsk, 'the fix ask is left pending, not consumed, when the limit latches');
    }
}
