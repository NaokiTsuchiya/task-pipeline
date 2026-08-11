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
 * run.phase=report. Requires the exact immediate predecessor type
 * (PhaseImplement) — see PhasePlan's docblock.
 */
final readonly class PhaseReport implements Node
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact;

    public function __construct(
        #[Input] PhaseImplement $prev,
    ) {
        $this->id = $prev->id;
        $this->artifact = $prev->artifact;
    }
}
