<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Progress\RunningInitialFull;

use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Node;
use Ray\InputQuery\Attribute\Input;

/**
 * run.phase=implement. Requires the exact immediate predecessor type (PhasePlan)
 * — see PhasePlan's docblock. This is the class illegal-examples/SkipPhase.php
 * tries to construct directly from a Queued, to demonstrate defect #1.
 */
final readonly class PhaseImplement implements Node
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact;

    public function __construct(
        #[Input] PhasePlan $prev,
    ) {
        $this->id = $prev->id;
        $this->artifact = $prev->artifact;
    }
}
