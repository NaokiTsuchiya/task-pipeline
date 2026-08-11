<?php

declare(strict_types=1);

namespace Experiment\BeStateV2\Verbs\Advance;

use Be\Framework\Attribute\Be;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseImplement;
use Experiment\BeStateV2\Progress\RunningInitialFull\PhaseReport;

/**
 * advance implement→report — see FromResearch's docblock.
 */
#[Be([PhaseReport::class])]
final readonly class FromImplement
{
    public function __construct(
        public PhaseImplement $prev,
    ) {
    }
}
