<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Claim;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Attention\Auto;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Ledger;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseResearch;

/**
 * claim: Queued (any artifact) → PhaseResearch. from is Queued only — Be will
 * refuse to construct this with anything else (defect#5/別掲 rely on the same
 * "no field to hold the wrong shape" mechanism; see Queued's docblock).
 *
 * Performs the cycle-reset (design 2.3節, state-transitions-v2.ts
 * cycleResetArtifact 279-295行): only fires when the artifact is open and
 * carries a follow — attention resets to auto, fixAsk clears, and fixAttempts
 * resets to 0 (leaving probe/other fields as ledger currently has no other
 * tracked field, per Ledger's docblock). Any other artifact shape (none/merged/
 * withdrawn, or open-without-follow) passes through unchanged, mirroring the TS
 * early-return. This reset is defect #3's mechanism: fix-start is never able to
 * zero fixAttempts itself (research.md 4節), so a stale fixAttempts can only be
 * carried by an artifact that skipped an actual claim — and this constructor is
 * the only source of PhaseResearch, so it can't be skipped.
 */
#[Be([PhaseResearch::class])]
final readonly class ClaimInput
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact;

    public function __construct(Queued $prev)
    {
        $this->id = $prev->id;
        $this->artifact = self::cycleReset($prev->artifact);
    }

    private static function cycleReset(
        ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn $artifact,
    ): ArtifactNone|ArtifactOpen|ArtifactMerged|ArtifactWithdrawn {
        if (!($artifact instanceof ArtifactOpen) || $artifact->follow === null) {
            return $artifact;
        }

        return new ArtifactOpen(
            ref: $artifact->ref,
            branch: $artifact->branch,
            tip: $artifact->tip,
            base: $artifact->base,
            follow: new Follow(
                attention: new Auto(),
                fixAsk: null,
                ledger: new Ledger(fixAttempts: 0),
                probe: $artifact->follow->probe,
            ),
        );
    }
}
