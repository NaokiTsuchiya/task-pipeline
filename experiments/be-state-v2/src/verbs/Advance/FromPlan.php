<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Advance;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhasePlan;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;

/**
 * advance plan→implement — see FromResearch's docblock for why each edge is its
 * own thin #[Be]-carrying wrapper rather than an attribute on the phase classes.
 */
#[Be([PhaseImplement::class])]
final readonly class FromPlan
{
    public function __construct(
        public PhasePlan $prev,
    ) {
    }
}
