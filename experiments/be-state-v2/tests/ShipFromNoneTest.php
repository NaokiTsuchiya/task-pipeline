<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
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
 * ship's ArtifactNone-source candidate: the first ship of a fresh task, PR not
 * created yet. Distinct from ShipFromWithdrawnTest — that one exercises
 * "discard old asked/note before creating a fresh open", this one has no
 * prior data to discard at all, so an implementation that special-cases the
 * withdrawn discard incorrectly on this path is caught here and not there.
 */
final class ShipFromNoneTest extends TestCase
{
    public function testShipFromNoneCreatesFreshFollow(): void
    {
        $becoming = Chain::becoming();
        $queued = new Queued(id: 'task-7', artifact: new ArtifactNone());
        $research = $becoming(new ClaimInput($queued));
        $plan = $becoming(new FromResearch($research));
        $implement = $becoming(new FromPlan($plan));
        $report = $becoming(new FromImplement($implement));
        $finalize = $becoming(new FromReport($report));
        self::assertInstanceOf(ArtifactNone::class, $finalize->artifact, 'fixture precondition: no PR pushed yet');

        $result = $becoming(new ShipInput(
            $finalize,
            commits: 2,
            ref: 'https://github.com/example/repo/pull/7',
            branch: 'task-7',
            tip: 'sha-1',
            base: 'main',
        ));

        self::assertInstanceOf(Resting::class, $result);
        self::assertInstanceOf(ArtifactOpen::class, $result->artifact);
        self::assertNotNull($result->artifact->follow, 'a PR-url ref must create a fresh follow');
        self::assertInstanceOf(Auto::class, $result->artifact->follow->attention);
        self::assertNull($result->artifact->follow->fixAsk);
        self::assertSame(0, $result->artifact->follow->ledger->fixAttempts);
        self::assertNull($result->artifact->follow->probe->proc);
    }
}
