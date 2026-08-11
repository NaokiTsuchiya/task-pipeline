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
 * progress=resting (v2 design 1.1節): the origin and destination of ship/merged/
 * attention-set/fix-start/restore. No #[Be] attribute — Resting is a terminal
 * coordinate the same way Queued is; each of those verbs is a distinct,
 * explicitly invoked wrapper (Verbs\Ship\ShipInput etc.), not something Resting
 * becomes on its own.
 *
 * #[Input] is required on both parameters — see Queued's docblock for why (Be
 * refuses MissingParameterAttribute otherwise), even though most tests build a
 * Resting directly as a fixture rather than through Becoming.
 */
final readonly class Resting implements Node
{
    public function __construct(
        #[Input] public string $id,
        #[Input] public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact,
    ) {
    }
}
