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
 * run.phase=plan. Requires the *exact* immediate predecessor type (PhaseResearch)
 * as its constructor parameter — the same mechanism research.md 9-c verified with
 * SkipToPlan.php (RunningPlan requiring a RunningResearch-typed $prev). This is
 * what makes illegal-examples/SkipPhase.php's Queued→PhaseImplement jump a type
 * error rather than a runtime check (defect #1). id/artifact are carried over
 * (Immanent) from $prev, not independently supplied — Verbs\Advance\FromResearch
 * is the only class Be will bind this constructor from (it is the only class
 * exposing a public $prev property of type PhaseResearch).
 */
final readonly class PhasePlan implements Node
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact;

    public function __construct(
        #[Input] PhaseResearch $prev,
    ) {
        $this->id = $prev->id;
        $this->artifact = $prev->artifact;
    }
}
