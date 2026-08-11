<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Advance;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseReport;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseFinalize;

/**
 * advance report→finalize — see FromResearch's docblock. This is the fourth of
 * the "initial系4辺" (plan.md 2節); the excluded fifth non-linear edge
 * (finalize⇄rebase_fix) is the rebase family (out of scope).
 */
#[Be([PhaseFinalize::class])]
final readonly class FromReport
{
    public function __construct(
        public PhaseReport $prev,
    ) {
    }
}
