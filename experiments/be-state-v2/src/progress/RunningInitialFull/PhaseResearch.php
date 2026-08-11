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
 * run={kind:initial, gate:full, phase:research} (v2 design 1.2節
 * INITIAL_GATE_PHASE_SEQUENCES.full). Reached only via claim
 * (Verbs\Claim\ClaimInput#[Be]) — no other constructor produces this class, and
 * it carries no #[Be] of its own, so becoming a PhaseResearch always stops the
 * chain here. The next hop (research→plan) is a distinct verb call
 * (Verbs\Advance\FromResearch), not an automatic continuation — see that class's
 * docblock for why advance cannot be modelled as #[Be] chained directly on the
 * phase classes.
 */
final readonly class PhaseResearch implements Node
{
    public function __construct(
        #[Input] public string $id,
        #[Input] public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact,
    ) {
    }
}
