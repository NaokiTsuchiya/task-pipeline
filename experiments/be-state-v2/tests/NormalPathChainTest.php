<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Attention\Human;
use Experiment\BeStateV2\Artifact\FixAsk\Pending;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseFinalize;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhasePlan;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseReport;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFix;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFixFinalize;
use Experiment\BeStateV2\Tests\Support\Chain;
use Experiment\BeStateV2\Verbs\Advance\FromImplement;
use Experiment\BeStateV2\Verbs\Advance\FromPlan;
use Experiment\BeStateV2\Verbs\Advance\FromPrFix;
use Experiment\BeStateV2\Verbs\Advance\FromReport;
use Experiment\BeStateV2\Verbs\Advance\FromResearch;
use Experiment\BeStateV2\Verbs\AttentionSet\AttentionSetInput;
use Experiment\BeStateV2\Verbs\Claim\ClaimInput;
use Experiment\BeStateV2\Verbs\FixStart\FixStartInput;
use Experiment\BeStateV2\Verbs\Merged\MergedInput;
use Experiment\BeStateV2\Verbs\Restore\RestoreInput;
use Experiment\BeStateV2\Verbs\Ship\ShipInput;
use PHPUnit\Framework\TestCase;

/**
 * Acceptance condition 5: claim → advance×5 → ship×2 → fix-start →
 * attention-set×2 → merged, one chain (testFullLifecycleChain), plus restore's
 * separate chain (testRestoreChain, since restore only ever follows resting or
 * blocked — never something already exercised above).
 */
final class NormalPathChainTest extends TestCase
{
    public function testFullLifecycleChain(): void
    {
        $becoming = Chain::becoming();

        $queued = new Queued(id: 'task-1', artifact: new ArtifactNone());
        $research = $becoming(new ClaimInput($queued));
        self::assertInstanceOf(PhaseResearch::class, $research);

        // advance research->plan->implement->report->finalize: 4 of the 5 advance edges.
        $plan = $becoming(new FromResearch($research));
        self::assertInstanceOf(PhasePlan::class, $plan);
        $implement = $becoming(new FromPlan($plan));
        self::assertInstanceOf(PhaseImplement::class, $implement);
        $report = $becoming(new FromImplement($implement));
        self::assertInstanceOf(PhaseReport::class, $report);
        $finalize = $becoming(new FromReport($report));
        self::assertInstanceOf(PhaseFinalize::class, $finalize);

        // ship (1st): ArtifactNone source -> a fresh ArtifactOpen with a fresh follow.
        $restingAfterFirstShip = $becoming(new ShipInput(
            $finalize,
            commits: 3,
            ref: 'https://github.com/example/repo/pull/1',
            branch: 'task-1',
            tip: 'sha-1',
            base: 'main',
        ));
        self::assertInstanceOf(Resting::class, $restingAfterFirstShip);
        $openAfterFirstShip = $restingAfterFirstShip->artifact;
        self::assertInstanceOf(ArtifactOpen::class, $openAfterFirstShip);
        self::assertNotNull($openAfterFirstShip->follow, 'ship on a PR-url ref must create a fresh follow');
        self::assertInstanceOf(Auto::class, $openAfterFirstShip->follow->attention);
        self::assertNull($openAfterFirstShip->follow->fixAsk, 'freshFollow() starts with no fix ask');

        // A fix request lands. fix-request itself is not one of the 7 reduced
        // verbs (plan.md 7節), so it is seeded directly here — no differently
        // than ship's own ref/branch/tip/base/commits, which are also always
        // externally supplied rather than derived from prior state.
        $follow = $openAfterFirstShip->follow;
        $restingWithFixRequest = new Resting(
            id: $restingAfterFirstShip->id,
            artifact: new ArtifactOpen(
                ref: $openAfterFirstShip->ref,
                branch: $openAfterFirstShip->branch,
                tip: $openAfterFirstShip->tip,
                base: $openAfterFirstShip->base,
                follow: new Follow(
                    attention: $follow->attention,
                    fixAsk: new Pending(),
                    ledger: $follow->ledger,
                    probe: $follow->probe,
                ),
            ),
        );

        $prFix = $becoming(new FixStartInput($restingWithFixRequest));
        self::assertInstanceOf(PhasePrFix::class, $prFix);
        self::assertTrue($prFix->started);

        // advance pr_fix->pr_fix_finalize: the 5th advance edge.
        $prFixFinalize = $becoming(new FromPrFix($prFix));
        self::assertInstanceOf(PhasePrFixFinalize::class, $prFixFinalize);

        // ship (2nd): ArtifactOpen source -> group fields rewritten, follow carried over.
        $restingAfterSecondShip = $becoming(new ShipInput(
            $prFixFinalize,
            commits: 1,
            ref: $openAfterFirstShip->ref,
            branch: $openAfterFirstShip->branch,
            tip: 'sha-2',
            base: 'main',
        ));
        self::assertInstanceOf(Resting::class, $restingAfterSecondShip);
        $openAfterSecondShip = $restingAfterSecondShip->artifact;
        self::assertInstanceOf(ArtifactOpen::class, $openAfterSecondShip);
        self::assertSame('sha-2', $openAfterSecondShip->tip, 'ship on an already-open artifact rewrites the group fields');
        self::assertNotNull($openAfterSecondShip->follow, 'ship on an already-open artifact must not replace follow with a fresh one (defect #2)');
        self::assertNull($openAfterSecondShip->follow->fixAsk, 'the taken fix-ask is consumed, not carried forward');

        // attention-set x2: human, then back to auto.
        $latched = $becoming(new AttentionSetInput($restingAfterSecondShip, humanReason: 'manual'));
        self::assertInstanceOf(Resting::class, $latched);
        self::assertInstanceOf(ArtifactOpen::class, $latched->artifact);
        self::assertInstanceOf(Human::class, $latched->artifact->follow?->attention);

        $backToAuto = $becoming(new AttentionSetInput($latched, humanReason: null));
        self::assertInstanceOf(Resting::class, $backToAuto);
        self::assertInstanceOf(ArtifactOpen::class, $backToAuto->artifact);
        self::assertInstanceOf(Auto::class, $backToAuto->artifact->follow?->attention);

        $merged = $becoming(new MergedInput($backToAuto));
        self::assertInstanceOf(Resting::class, $merged);
        self::assertInstanceOf(ArtifactMerged::class, $merged->artifact);
        self::assertSame('sha-2', $merged->artifact->tip);
    }

    public function testRestoreChain(): void
    {
        $becoming = Chain::becoming();

        $resting = new Resting(
            id: 'task-2',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/2',
                branch: 'task-2',
                tip: 'sha-9',
                base: 'main',
                follow: new Follow(
                    attention: new Auto(),
                    fixAsk: null,
                    ledger: new Ledger(fixAttempts: 0),
                    probe: new Probe(proc: 'pid-123'),
                ),
            ),
        );

        $queued = $becoming(new RestoreInput($resting));
        self::assertInstanceOf(Queued::class, $queued);
        self::assertInstanceOf(ArtifactOpen::class, $queued->artifact);
        self::assertNull($queued->artifact->follow?->probe->proc, 'restore drops the follow-process lease (probe.proc)');
    }
}
