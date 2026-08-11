<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Progress;

use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Node;

/**
 * progress=blocked (v2 design 1.1節), the other half of restore's from union.
 * block itself is not one of the 7 reduced verbs (plan.md 7節「範囲外の再確認」
 * 参照) — tests construct Blocked directly as a fixture.
 */
final readonly class Blocked implements Node
{
    public function __construct(
        public string $id,
        public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact,
        public string $blockedReason,
    ) {
    }
}
