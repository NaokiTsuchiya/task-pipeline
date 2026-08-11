<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Ship;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Progress\Resting;
use Ray\InputQuery\Attribute\Input;

/**
 * ship's ArtifactWithdrawn-source candidate: the old PR is closed, so its
 * asked/note are discarded (not carried into the new artifact — $source is
 * accepted only to drive Be's type dispatch, its asked/note are never read) and
 * a brand-new open is created the same way ShipFromNone does
 * (state-transitions-v2.ts applyShip 597-603行: "withdrawn の asked/note は
 * 捨てる — 旧PRは閉じており、新しいPRは新しい追従対象である").
 */
#[Be([Resting::class])]
final readonly class ShipFromWithdrawn
{
    public string $id;
    public ArtifactOpen $artifact;

    /** @psalm-suppress UnusedParam $source drives Be's type dispatch (BecomingType::match) and is never read in the body — see ShipInput's docblock. */
    public function __construct(
        #[Input] ArtifactWithdrawn $source,
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
