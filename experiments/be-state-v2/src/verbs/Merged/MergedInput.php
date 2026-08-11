<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Merged;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Artifact\ArtifactMerged;
use Experiment\BeStateV2\Artifact\ArtifactOpen;
use Experiment\BeStateV2\Progress\Resting;

/**
 * merged: Resting×ArtifactOpen(tip≠null) → Resting×ArtifactMerged
 * (state-transitions-v2.ts applyMerged 659-680行). tip≠null is a construction-
 * time value check (ArtifactOpen.$tip is `string|null` by type, so a null tip is
 * perfectly constructible — the guard has to be a runtime check, not a type
 * exclusion; MergedGuardTest exercises it).
 *
 * ArtifactMerged has no $follow property at all (see its docblock) — the target
 * of this transformation is built from ref/branch/tip/base only, so there is no
 * constructor parameter a stray follow value could even be assigned to. That
 * absence, not a runtime check, is defect #7's "表現不能" mechanism.
 */
#[Be([Resting::class])]
final readonly class MergedInput
{
    public string $id;
    public ArtifactMerged $artifact;

    public function __construct(Resting $prev)
    {
        if (!($prev->artifact instanceof ArtifactOpen)) {
            throw new \DomainException('merged requires an ArtifactOpen artifact');
        }
        $open = $prev->artifact;
        if ($open->tip === null) {
            throw new \DomainException('merged requires artifact.tip to be present');
        }
        $this->id = $prev->id;
        $this->artifact = new ArtifactMerged(
            ref: $open->ref,
            branch: $open->branch,
            tip: $open->tip,
            base: $open->base,
        );
    }
}
