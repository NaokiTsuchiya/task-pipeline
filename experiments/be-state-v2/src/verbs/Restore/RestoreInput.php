<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Restore;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactNone;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Artifact\ArtifactWithdrawn;
use Experiment\BeStateV2\Artifact\Follow;
use Experiment\BeStateV2\Artifact\Probe;
use Experiment\BeStateV2\Progress\Blocked;
use Experiment\BeStateV2\Progress\Queued;
use Experiment\BeStateV2\Progress\Resting;

/**
 * restore: Resting|Blocked (artifact≠merged) → Queued (v2 design 2.6節,
 * state-transitions-v2.ts applyRestore 436-458行). The progress axis (Resting or
 * Blocked) is type-only — RestoreInput has no other constructor, so nothing else
 * can reach Queued this way (defect #8's "表現不能" mechanism, alongside Queued
 * simply having no gate/phase field at all for the design 4.1節 別掲 aside).
 *
 * The artifact axis (≠merged) is *not* type-only: Resting can legitimately carry
 * an ArtifactMerged (that is exactly what merged's own result is —
 * Verbs\Merged\MergedInput → Resting×ArtifactMerged), so RestoreInput cannot
 * simply omit a parameter type for it the way it omits one for running-phase
 * progress values. The exclusion is a construction-time value check instead
 * (DomainException) — the same reasoning Verbs\AttentionSet\AttentionSetInput's
 * docblock gives for why its own artifact/follow guards are runtime, not static.
 *
 * withoutLease (state-transitions-v2.ts 224-235行台): only probe.proc is
 * cleared; attention/fixAsk/ledger are left untouched (restore does not reset
 * the cycle — only claim does, defect #3's point).
 */
#[Be([Queued::class])]
final readonly class RestoreInput
{
    public string $id;
    public ArtifactNone|ArtifactOpen|ArtifactWithdrawn $artifact;

    public function __construct(Resting|Blocked $prev)
    {
        if ($prev->artifact instanceof ArtifactMerged) {
            throw new \DomainException('restore requires artifact.state != merged');
        }
        $this->id = $prev->id;
        $this->artifact = self::withoutLease($prev->artifact);
    }

    private static function withoutLease(
        ArtifactNone|ArtifactOpen|ArtifactWithdrawn $artifact,
    ): ArtifactNone|ArtifactOpen|ArtifactWithdrawn {
        if (!($artifact instanceof ArtifactOpen) || $artifact->follow === null) {
            return $artifact;
        }

        return new ArtifactOpen(
            ref: $artifact->ref,
            branch: $artifact->branch,
            tip: $artifact->tip,
            base: $artifact->base,
            follow: new Follow(
                attention: $artifact->follow->attention,
                fixAsk: $artifact->follow->fixAsk,
                ledger: $artifact->follow->ledger,
                probe: new Probe(proc: null),
            ),
        );
    }
}
