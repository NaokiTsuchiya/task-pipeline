<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Advance;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFix;
use Experiment\BeStateV2\Progress\RunningPrFix\PhasePrFixFinalize;

/**
 * advance pr_fix→pr_fix_finalize, the pr_fix system's one edge (plan.md 2節
 * "pr_fix系1辺") — see FromResearch's docblock for the wrapper-per-edge design.
 */
#[Be([PhasePrFixFinalize::class])]
final readonly class FromPrFix
{
    public function __construct(
        public PhasePrFix $prev,
    ) {
    }
}
