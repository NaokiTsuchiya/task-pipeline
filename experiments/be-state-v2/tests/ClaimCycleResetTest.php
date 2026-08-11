<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Tests\Support\Chain;
use Experiment\BeStateV2\Verbs\Claim\ClaimInput;
use PHPUnit\Framework\TestCase;

/**
 * Defect #3: fix_attempts only ever resets to 0 through claim's cycle-reset —
 * nothing else in the reduced verb set touches it (fix-start only increments).
 * This drives the reset through an actual claim call and inspects the result,
 * rather than resting on the source citation alone (condition 8's 実証 label
 * requirement).
 */
final class ClaimCycleResetTest extends TestCase
{
    public function testClaimResetsFixAttemptsAndLatchedAttention(): void
    {
        $queued = new Queued(
            id: 'task-13',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/13',
                branch: 'task-13',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Human('fix_limit'),
                    fixAsk: new Taken(),
                    ledger: new Ledger(fixAttempts: 4),
                    probe: new Probe(proc: 'pid-789'),
                ),
            ),
        );

        $becoming = Chain::becoming();
        $result = $becoming(new ClaimInput($queued));

        self::assertInstanceOf(PhaseResearch::class, $result);
        self::assertInstanceOf(ArtifactOpen::class, $result->artifact);
        $follow = $result->artifact->follow;
        self::assertNotNull($follow);
        self::assertSame(0, $follow->ledger->fixAttempts, 'claim must reset fixAttempts to 0');
        self::assertInstanceOf(Auto::class, $follow->attention, 'claim must reset a latched Human attention back to auto');
        self::assertNull($follow->fixAsk, 'claim must clear a taken fix ask');
        self::assertSame('pid-789', $follow->probe->proc, 'claim does not touch probe.proc — only restore does (defect#8)');
    }
}
