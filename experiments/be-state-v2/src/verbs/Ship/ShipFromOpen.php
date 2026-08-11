<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Ship;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Progress\Resting;
use Ray\InputQuery\Attribute\Input;

/**
 * ship's ArtifactOpen-source candidate: only the ref/branch/tip/base group is
 * rewritten — follow is carried over (narrowed, ShipInput::narrowFollow), never
 * replaced with a new literal. That "no constructor path writes a fresh follow
 * over an existing one" is defect #2's mechanism (v1's in-review replaced the
 * whole review object; state-transitions-v2.ts applyShip 587-589行 makes the same
 * point about v2's TS implementation).
 */
#[Be([Resting::class])]
final readonly class ShipFromOpen
{
    public string $id;
    public ArtifactOpen $artifact;

    public function __construct(
        #[Input] ArtifactOpen $source,
        #[Input] string $id,
        #[Input] string $ref,
        #[Input] string $branch,
        #[Input] string $tip,
        #[Input] string $base,
    ) {
        $this->id = $id;
        $this->artifact = new ArtifactOpen(
            ref: $ref,
            branch: $branch,
            tip: $tip,
            base: $base,
            follow: $source->follow === null ? null : ShipInput::narrowFollow($source->follow),
        );
    }
}
