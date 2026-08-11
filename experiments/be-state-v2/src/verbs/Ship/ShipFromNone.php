<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Ship;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Progress\Resting;
use Ray\InputQuery\Attribute\Input;

/**
 * ship's ArtifactNone-source candidate — the first PR/branch pushed for a fresh
 * task (no asked/note to discard, unlike ShipFromWithdrawn's otherwise identical
 * "create a fresh open" shape; kept as an independent candidate rather than
 * merged with ShipFromWithdrawn so an implementation mistake that special-cases
 * the withdrawn discard incorrectly on the none path is still caught).
 */
#[Be([Resting::class])]
final readonly class ShipFromNone
{
    public string $id;
    public ArtifactOpen $artifact;

    /** @psalm-suppress UnusedParam $source drives Be's type dispatch (BecomingType::match) and is never read in the body — see ShipInput's docblock. */
    public function __construct(
        #[Input] ArtifactNone $source,
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
            follow: ShipInput::isPullRequestRef($ref) ? ShipInput::freshFollow() : null,
        );
    }
}
