<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Progress;

use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Node;
use Ray\InputQuery\Attribute\Input;

/**
 * progress=queued (v2 design 1.1節). No #[Be] attribute: nothing in the reduced
 * verb set auto-continues a Queued item — claim is a distinct, explicitly invoked
 * verb (Verbs\Claim\ClaimInput), not something Queued becomes on its own.
 *
 * Deliberately has no gate/phase property. That absence — not a runtime check —
 * is what makes the (in_progress/research, gate:light) dead node (design 4.1節
 * 別掲) unwritable: there is no field to hold a stale gate on a queued item.
 *
 * #[Input] is required on both parameters (not just documentation) — Be Framework
 * refuses to construct any class it is asked to become without it
 * (MissingParameterAttribute), even though Queued is also built directly as a
 * fixture in most tests, bypassing Becoming entirely.
 */
final readonly class Queued implements Node
{
    public function __construct(
        #[Input] public string $id,
        #[Input] public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact,
    ) {
    }
}
