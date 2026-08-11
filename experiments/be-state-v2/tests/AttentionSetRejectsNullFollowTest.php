<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Verbs\AttentionSet\AttentionSetInput;
use PHPUnit\Framework\TestCase;

/**
 * attention-set's artifact-axis guard:
 * ArtifactOpen.$follow is nullable by construction (ship only creates one for a
 * PR-url ref — state-transitions-v2.ts isPullRequestRef), so follow=null cannot
 * be excluded by AttentionSetInput's parameter type (Resting can legitimately
 * carry an open artifact without a follow). This is a construction-time value
 * check, unlike the progress-axis guard illegal-examples/AttentionSetOnRunning.php
 * exercises — see AttentionSetInput's docblock.
 */
final class AttentionSetRejectsNullFollowTest extends TestCase
{
    public function testAttentionSetAgainstNullFollowFailsAtConstruction(): void
    {
        $resting = new Resting(
            id: 'task-11',
            artifact: new ArtifactOpen(
                ref: 'not-a-pull-request-url',
                branch: 'task-11',
                tip: 'sha-1',
                base: 'main',
                follow: null,
            ),
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('follow');
        new AttentionSetInput($resting, humanReason: 'manual');
    }
}
