<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Verbs\Restore\RestoreInput;
use PHPUnit\Framework\TestCase;

/**
 * restore's artifact-axis guard: a Resting×ArtifactMerged — exactly what
 * merged's own result looks like — must be rejected. Resting can legitimately
 * hold any of the 4 artifact states (it is merged's own destination type), so
 * this exclusion cannot be a parameter type restriction the way the progress
 * axis (Resting|Blocked) is; see RestoreInput's docblock.
 */
final class RestoreRejectsMergedArtifactTest extends TestCase
{
    public function testRestoreAgainstMergedArtifactFailsAtConstruction(): void
    {
        $resting = new Resting(
            id: 'task-10',
            artifact: new ArtifactMerged(
                ref: 'https://github.com/example/repo/pull/10',
                branch: 'task-10',
                tip: 'sha-1',
                base: 'main',
            ),
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('merged');
        new RestoreInput($resting);
    }
}
