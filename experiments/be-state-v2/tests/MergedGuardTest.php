<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Tests;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Progress\Resting;
use Experiment\BeStateV2\Verbs\Merged\MergedInput;
use PHPUnit\Framework\TestCase;

/**
 * merged's tip≠null guard: tip=null is perfectly constructible on an
 * ArtifactOpen (tip is string|null), so the exclusion has to be a
 * construction-time value check rather than a type exclusion — MergedInput's
 * docblock.
 */
final class MergedGuardTest extends TestCase
{
    public function testMergedAgainstNullTipFailsAtConstruction(): void
    {
        $resting = new Resting(
            id: 'task-9',
            artifact: new ArtifactOpen(
                ref: 'https://github.com/example/repo/pull/9',
                branch: 'task-9',
                tip: null,
                base: 'main',
                follow: null,
            ),
        );

        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('tip');
        new MergedInput($resting);
    }
}
