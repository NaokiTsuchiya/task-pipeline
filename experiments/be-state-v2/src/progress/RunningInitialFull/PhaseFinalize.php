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
 * run.phase=finalize. Requires the exact immediate predecessor type
 * (PhaseReport) — see PhasePlan's docblock. Advance's only non-linear edge in
 * the full model (finalize⇄rebase_fix, design 2.4節) is out of scope (rebase
 * family, plan.md 7節「範囲外の再確認」) so this class branches nowhere further —
 * it is ship (Verbs\Ship\ShipInput) that consumes it.
 */
final readonly class PhaseFinalize implements Node
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact;

    public function __construct(
        #[Input] PhaseReport $prev,
    ) {
        $this->id = $prev->id;
        $this->artifact = $prev->artifact;
    }
}
