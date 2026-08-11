<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Tests\Support\Chain;
use Experiment\BeStateV2\Verbs\Advance\FromImplement;
use Experiment\BeStateV2\Verbs\Advance\FromPlan;
use Experiment\BeStateV2\Verbs\Advance\FromReport;
use Experiment\BeStateV2\Verbs\Advance\FromResearch;
use Experiment\BeStateV2\Verbs\Claim\ClaimInput;
use Experiment\BeStateV2\Verbs\Ship\ShipInput;
use PHPUnit\Framework\TestCase;

/**
 * ship's ArtifactWithdrawn-source candidate: the old PR was withdrawn, and
 * this ship opens a new one. asked/note must be discarded, not carried into
 * the new artifact — a fresh follow is created the same way ShipFromNoneTest
 * expects, but starting from data that does need discarding (unlike
 * ShipFromNone's empty slate).
 */
final class ShipFromWithdrawnTest extends TestCase
{
    public function testShipFromWithdrawnDiscardsOldDataAndCreatesFreshFollow(): void
    {
        $becoming = Chain::becoming();
        $queued = new Queued(
            id: 'task-8',
            artifact: new ArtifactWithdrawn(
                ref: 'https://github.com/example/repo/pull/800',
                branch: 'task-8-old',
                tip: 'sha-old',
                base: 'main',
                asked: true,
                note: 'no longer needed',
            ),
        );
        $research = $becoming(new ClaimInput($queued));
        $plan = $becoming(new FromResearch($research));
        $implement = $becoming(new FromPlan($plan));
        $report = $becoming(new FromImplement($implement));
        $finalize = $becoming(new FromReport($report));
        self::assertInstanceOf(ArtifactWithdrawn::class, $finalize->artifact);

        $result = $becoming(new ShipInput(
            $finalize,
            commits: 1,
            ref: 'https://github.com/example/repo/pull/801',
            branch: 'task-8',
            tip: 'sha-new',
            base: 'main',
        ));

        self::assertInstanceOf(Resting::class, $result);
        self::assertInstanceOf(ArtifactOpen::class, $result->artifact);
        self::assertSame('https://github.com/example/repo/pull/801', $result->artifact->ref);
        self::assertNotNull($result->artifact->follow, 'a PR-url ref must create a fresh follow, not carry the withdrawn asked/note forward');
        self::assertInstanceOf(Auto::class, $result->artifact->follow->attention);
        self::assertNull($result->artifact->follow->fixAsk);
    }
}
