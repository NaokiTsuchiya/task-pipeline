<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Blocked;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Tests\Support\Chain;
use Experiment\BeStateV2\Verbs\Restore\RestoreInput;
use PHPUnit\Framework\TestCase;

/**
 * restore's progress-axis union: Resting|Blocked. NormalPathChainTest::testRestoreChain
 * only exercises the Resting half; a RestoreInput whose constructor declared
 * `Resting $prev` alone (forgetting the Blocked branch of the union) would still
 * pass that test, so Blocked needs its own, independent exercise here.
 */
final class RestoreFromBlockedTest extends TestCase
{
    public function testRestoreFromBlockedReachesQueued(): void
    {
        $blocked = new Blocked(
            id: 'task-12',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/12',
                branch: 'task-12',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Auto(),
                    fixAsk: null,
                    ledger: new Ledger(fixAttempts: 0),
                    probe: new Probe(proc: 'pid-456'),
                ),
            ),
            blockedReason: 'ci_failed_thrice',
        );

        $becoming = Chain::becoming();
        $queued = $becoming(new RestoreInput($blocked));

        self::assertInstanceOf(Queued::class, $queued);
        self::assertInstanceOf(ArtifactOpen::class, $queued->artifact);
        self::assertNull($queued->artifact->follow?->probe->proc, 'restore drops the follow-process lease from a blocked item too');
    }
}
