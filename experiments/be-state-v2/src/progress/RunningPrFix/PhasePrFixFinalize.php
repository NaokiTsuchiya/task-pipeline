<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Progress\RunningPrFix;

use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Node;
use Ray\InputQuery\Attribute\Input;

/**
 * run.phase=pr_fix_finalize. Requires the exact immediate predecessor type
 * (PhasePrFix) — the pr_fix system's one advance edge (see
 * RunningInitialFull\PhasePlan's docblock for why phase classes require their
 * exact predecessor type). ship (Verbs\Ship\ShipInput) consumes this.
 */
final readonly class PhasePrFixFinalize implements Node
{
    public string $id;
    public ArtifactOpen $artifact;

    public function __construct(
        #[Input] PhasePrFix $prev,
    ) {
        $this->id = $prev->id;
        $this->artifact = $prev->artifact;
    }
}
