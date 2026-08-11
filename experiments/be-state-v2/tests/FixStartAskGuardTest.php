<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\FixAsk\Taken;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Verbs\FixStart\FixStartInput;
use PHPUnit\Framework\TestCase;

/**
 * fix-start's from-guard is an AND of two independent conditions
 * (attention===auto AND fixAsk===pending, plan.md 2節). FixStartLimitTest
 * exercises the attention half; this exercises the other — attention still
 * auto, but the fix ask already taken (a double fix-start against the same
 * request) — a distinct violation class an implementation could pass by
 * checking only attention.
 */
final class FixStartAskGuardTest extends TestCase
{
    public function testFixStartAgainstTakenFixAskFailsAtConstruction(): void
    {
        $resting = new Resting(
            id: 'task-6',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/6',
                branch: 'task-6',
                tip: 'sha-1',
                base: 'main',
                follow: new Follow(
                    attention: new Auto(),
                    fixAsk: new Taken(),
                    ledger: new Ledger(fixAttempts: 1),
                    probe: new Probe(proc: null),
                ),
            ),
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('fixAsk === pending');
        new FixStartInput($resting);
    }
}
